'use strict'

// apps/cli/lib/account/invites-pair.js over two invites-store.js files: the
// members' weekly invites and the Feira's 1 h codes (capOn 'use',
// pruneUnused, maxRows 20000). No network; the clock is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { openInvitesStore, FILE, inviteId, newCode } = require('../lib/account/invites-store')
const { pairInvites } = require('../lib/account/invites-pair')
const { tmpDir } = require('./helpers/net')

const FEIRA_FILE = 'feira-invites.json'
// Wednesday 2026-10-28 09:00 Brasília.
const T0 = Date.parse('2026-10-28T12:00:00.000Z')
const HOUR = 3600 * 1000
// Monday 2026-11-02 00:00 Brasília.
const MONDAY = Date.parse('2026-11-02T03:00:00.000Z')

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function setup (t, { start = T0, feiraPerWeek = 2, maxRows = 20000 } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = { t: start, now: () => c.t }
  const held = new Set()
  const isUsed = (id) => held.has(id)
  const openPrimary = () => openInvitesStore(dir, { now: c.now, perWeek: 3, isUsed })
  const openFeira = () => openInvitesStore(dir, {
    now: c.now,
    perWeek: feiraPerWeek,
    isUsed,
    file: FEIRA_FILE,
    ttlMs: HOUR,
    capOn: 'use',
    maxRows,
    pruneUnused: true
  })
  const open = () => {
    const primary = openPrimary()
    const feira = openFeira()
    return { primary, feira, pair: pairInvites(primary, feira) }
  }
  return {
    dir,
    c,
    held,
    open,
    primaryFile: path.join(dir, FILE),
    feiraFile: path.join(dir, FEIRA_FILE)
  }
}

function readFile (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

test('a primary and a feira code each pass check and consume marks the right file', async (t) => {
  const s = setup(t)
  const { primary, feira, pair } = s.open()
  const owner = memberKey()
  const p = await primary.issue(owner)
  const f = await feira.issue(owner)
  const pid = inviteId(p.code)
  const fid = inviteId(f.code)
  t.ok(pair.available(), 'both usable')
  t.is(pair.check(pid), null, 'primary code passes')
  t.is(pair.check(fid), null, 'feira code passes')
  t.is(pair.check(inviteId(newCode())), 'convite-invalido', 'unknown code refused')
  t.is(f.expiresAt, new Date(T0 + HOUR).toISOString(), 'feira code lives 1 h')

  t.alike(await pair.consume(fid), { changed: true }, 'feira consume changes')
  t.ok(readFile(s.primaryFile).invites.every((r) => r.used === false), 'primary file untouched')
  t.ok(readFile(s.feiraFile).invites.every((r) => r.used === true && r.id === null), 'feira row used')

  t.alike(await pair.consume(pid), { changed: true }, 'primary consume changes')
  t.ok(readFile(s.primaryFile).invites.every((r) => r.used === true && r.id === null), 'primary row used')
  t.is(pair.check(pid), 'convite-invalido', 'used primary code refused')
  t.is(pair.check(fid), 'convite-invalido', 'used feira code refused')
})

test('a feira code over the used-or-held cap is refused at check while issue succeeds', async (t) => {
  const s = setup(t)
  const { feira, pair } = s.open()
  const owner = memberKey()
  const a = await feira.issue(owner)
  const b = await feira.issue(owner)
  const c = await feira.issue(owner)
  t.ok(c.code, 'issue never counts the week')
  await pair.consume(inviteId(a.code))
  t.is(pair.check(inviteId(c.code)), null, 'one used of two: still open')
  // A directory link holds b without a consume yet: it counts.
  s.held.add(inviteId(b.code))
  t.is(pair.check(inviteId(c.code)), 'convite-invalido', 'used plus held reach perWeek')
  const d = await feira.issue(owner)
  t.ok(d.code, 'issue still succeeds over the cap')
  t.is(pair.check(inviteId(d.code)), 'convite-invalido', 'new code refused too')
  t.is(feira.summary(owner).used, 2, 'summary counts used and held')

  const other = memberKey()
  const e = await feira.issue(other)
  t.is(pair.check(inviteId(e.code)), null, 'another owner is not capped')
})

test('an expired unused feira code is pruned and then refused; a used row stays', async (t) => {
  const s = setup(t)
  const { feira, pair } = s.open()
  const owner = memberKey()
  const old = await feira.issue(owner)
  const kept = await feira.issue(owner)
  await pair.consume(inviteId(kept.code))
  s.c.t += HOUR
  t.is(pair.check(inviteId(old.code)), 'convite-invalido', 'expired code refused')
  await feira.issue(memberKey())
  const rows = readFile(s.feiraFile).invites
  t.is(rows.length, 2, 'expired unused row pruned mid-week')
  t.ok(rows.some((r) => r.inviter === owner && r.used === true), 'used row kept for the counter')
  t.is(pair.check(inviteId(old.code)), 'convite-invalido', 'pruned code refused')
  t.is(feira.summary(owner).used, 1, 'used row still counted')
})

test('an expired code a directory link holds is not pruned', async (t) => {
  const s = setup(t)
  const { feira } = s.open()
  const owner = memberKey()
  const held = await feira.issue(owner)
  s.held.add(inviteId(held.code))
  s.c.t += 2 * HOUR
  t.is(await feira.heal(), true, 'heal writes the merge')
  const rows = readFile(s.feiraFile).invites
  t.is(rows.length, 1, 'held row kept')
  t.is(rows[0].used, true, 'marked used through isUsed')
})

test('forget clears both files', async (t) => {
  const s = setup(t)
  const { primary, feira, pair } = s.open()
  const owner = memberKey()
  const other = memberKey()
  await primary.issue(owner)
  await feira.issue(owner)
  await feira.issue(other)
  t.ok(pair.holds(owner), 'holds before')
  t.alike(await pair.forget(owner), { changed: true }, 'changed')
  t.absent(pair.holds(owner), 'holds nothing after')
  t.is(readFile(s.primaryFile).invites.length, 0, 'primary cleared')
  t.alike(readFile(s.feiraFile).invites.map((r) => r.inviter), [other], 'feira keeps the other owner')
  t.alike(await pair.forget(owner), { changed: false }, 'second forget changes nothing')
})

test('holds is true when only the feira store has a row', async (t) => {
  const s = setup(t)
  const { feira, pair } = s.open()
  const owner = memberKey()
  await feira.issue(owner)
  t.ok(pair.holds(owner))
})

test('a bad feira file turns only Feira codes off, never ordinary invites, and is not rewritten', async (t) => {
  const s = setup(t)
  fs.writeFileSync(s.feiraFile, '{"v":1,"invites":[{"bad":true}]}', { mode: 0o600 })
  const before = fs.readFileSync(s.feiraFile)
  const { primary, pair } = s.open()
  t.ok(primary.available(), 'primary alone is fine')
  t.ok(pair.available(), 'the pair follows the primary: ordinary invites keep working')
  const owner = memberKey()
  const { code } = await primary.issue(owner)
  t.is(pair.check(inviteId(code)), null, 'an ordinary code still passes')
  t.is(pair.check(inviteId('x'.repeat(43))), 'convite-invalido', 'an unknown or Feira code is refused')
  t.ok(pair.holds(memberKey()), 'holds says maybe while the Feira file is broken, so a deletion retries')
  t.is(await pair.heal(), false, 'heal writes nothing')
  await rejects(t, pair.forget(memberKey()), 'indisponivel', 'forget refused')
  t.alike(fs.readFileSync(s.feiraFile), before, 'file not rewritten')
})

test('fail() on the pair makes both stores unavailable', async (t) => {
  const s = setup(t)
  const { primary, feira, pair } = s.open()
  pair.fail()
  t.absent(primary.available(), 'primary failed')
  t.absent(feira.available(), 'feira failed')
  t.absent(pair.available(), 'pair failed')
})

test('perWeek is the primary value and read only; the policy shape has exact keys', async (t) => {
  const s = setup(t)
  const { pair } = s.open()
  t.is(pair.perWeek, 3, 'primary perWeek')
  try {
    pair.perWeek = 9
  } catch {}
  t.is(pair.perWeek, 3, 'not writable')
  const body = { required: true, perWeek: pair.perWeek }
  t.alike(Object.keys(body).sort(), ['perWeek', 'required'], 'exact keys required and perWeek')
  t.alike(JSON.parse(JSON.stringify(body)), { required: true, perWeek: 3 }, 'serializes with both keys')
})

test('issue, summary and count go to the primary store', async (t) => {
  const s = setup(t)
  const { feira, pair } = s.open()
  const owner = memberKey()
  await pair.issue(owner)
  t.is(readFile(s.primaryFile).invites.length, 1, 'issued in primary')
  t.absent(fs.existsSync(s.feiraFile), 'feira file not created')
  t.is(pair.summary(owner).perWeek, 3, 'primary summary')
  t.alike(pair.count(), { total: 1, used: 0 }, 'primary count')
  await feira.issue(owner)
  t.alike(pair.count(), { total: 1, used: 0 }, 'feira rows not counted')
})

test('a null feira routes everything to the primary', async (t) => {
  const s = setup(t)
  const primary = openInvitesStore(s.dir, { now: s.c.now, perWeek: 3 })
  t.is(pairInvites(primary, null), primary)
  t.is(pairInvites(primary), primary)
})

test('the feira cap resets at the Brasília Monday boundary', async (t) => {
  const s = setup(t, { start: MONDAY - HOUR / 2, feiraPerWeek: 1 })
  const { feira, pair } = s.open()
  const owner = memberKey()
  const a = await feira.issue(owner)
  const b = await feira.issue(owner)
  await pair.consume(inviteId(a.code))
  t.is(pair.check(inviteId(b.code)), 'convite-invalido', 'Sunday 23:30: cap reached')
  s.c.t = MONDAY - 1
  t.is(pair.check(inviteId(b.code)), 'convite-invalido', 'last Sunday millisecond: still capped')
  s.c.t = MONDAY
  t.is(pair.check(inviteId(b.code)), 'convite-invalido', 'Monday 00:00: a code issued last week is refused, so it never escapes both weekly counts')
  t.is(feira.summary(owner).used, 0, 'summary resets too')
  const fresh = await feira.issue(owner)
  t.is(pair.check(inviteId(fresh.code)), null, 'a code issued this week passes: the used row is last week')
})

test('maxRows 20000 refuses the 20001st row', async (t) => {
  const s = setup(t)
  const filler = memberKey()
  const at = new Date(T0 - HOUR / 2).toISOString()
  const invites = []
  for (let i = 0; i < 19999; i++) {
    invites.push({ slot: b4a.toString(crypto.randomBytes(16), 'hex'), id: null, inviter: filler, createdAt: at, used: true })
  }
  fs.writeFileSync(s.feiraFile, JSON.stringify({ v: 1, invites }), { mode: 0o600 })
  const { feira } = s.open()
  const owner = memberKey()
  const last = await feira.issue(owner)
  t.ok(last.code, 'the 20000th row is issued')
  await rejects(t, feira.issue(owner), 'limite', 'the 20001st is refused')
  t.is(readFile(s.feiraFile).invites.length, 20000, 'file holds 20000 rows')
})

test('option validation', async (t) => {
  const s = setup(t)
  t.exception.all(() => openInvitesStore(s.dir, { file: '../x.json' }), /file/)
  t.exception.all(() => openInvitesStore(s.dir, { file: 'x.txt' }), /file/)
  t.exception.all(() => openInvitesStore(s.dir, { ttlMs: 0 }), /ttlMs/)
  t.exception.all(() => openInvitesStore(s.dir, { capOn: 'never' }), /capOn/)
  t.exception.all(() => openInvitesStore(s.dir, { maxRows: 0 }), /maxRows/)
  t.exception.all(() => openInvitesStore(s.dir, { pruneUnused: 1 }), /pruneUnused/)
})

test('feiraOwner names the inviter of a valid Feira code, null otherwise, and fails closed without inviterOf', async (t) => {
  const s = setup(t)
  const { primary, feira } = s.open()
  const pair = pairInvites(primary, feira)
  t.is(pair.feiraPerWeek, 2, 'the Feira weekly cap, read only')
  try {
    pair.feiraPerWeek = 9
  } catch {}
  t.is(pair.feiraPerWeek, 2, 'not writable')

  const owner = memberKey()
  const fc = (await feira.issue(owner)).code
  const pc = (await primary.issue(memberKey())).code
  t.is(pair.feiraOwner(inviteId(fc)), owner, 'a Feira code names its owner')
  t.is(pair.feiraOwner(inviteId(pc)), null, 'an ordinary code has none')
  t.is(pair.feiraOwner(inviteId(newCode())), null, 'an unknown code has none')

  s.c.t += 2 * HOUR
  t.is(pair.feiraOwner(inviteId(fc)), null, 'an expired Feira code has none')

  s.c.t -= 2 * HOUR
  const blind = pairInvites(primary, { ...feira, inviterOf: undefined })
  t.exception(() => blind.feiraOwner(inviteId(fc)), 'a Feira code with no nameable owner throws')
  t.is(blind.feiraOwner(inviteId(pc)), null)
})
