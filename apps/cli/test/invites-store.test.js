'use strict'

// apps/cli/lib/account/invites-store.js: the invites.json sidecar where the
// account service records the signup invites members issued (hash only) and
// the Brasília Monday-week allowance. No network; the clock is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  openInvitesStore, FILE, CODE_RE, WEEK_MS, INVITE_TTL_MS, MAX_ROWS, PER_WEEK_MAX,
  newCode, inviteId, weekStart, weekEnd
} = require('../lib/account/invites-store')
const { tmpDir } = require('./helpers/net')

// Wednesday 2026-10-28 09:00 Brasília.
const T0 = Date.parse('2026-10-28T12:00:00.000Z')
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const MONDAY = Date.parse('2026-11-02T03:00:00.000Z')

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function clock (start = T0) {
  const c = { t: start, now: () => c.t }
  return c
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = clock()
  const open = (more = {}) => openInvitesStore(dir, { now: c.now, perWeek: 3, ...opts, ...more })
  return { dir, file: path.join(dir, FILE), c, open, store: open() }
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

function readFile (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function slot () {
  return b4a.toString(crypto.randomBytes(16), 'hex')
}

function row (inviter, createdAtMs, extra = {}) {
  return { slot: slot(), id: inviteId(newCode()), inviter, createdAt: new Date(createdAtMs).toISOString(), used: false, ...extra }
}

function writeRaw (file, obj) {
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj), { mode: 0o600 })
}

test('weekStart and weekEnd follow the Brasília Monday', (t) => {
  const iso = (ms) => new Date(ms).toISOString()
  t.is(iso(weekStart(Date.parse('2026-10-28T12:00:00.000Z'))), '2026-10-26T03:00:00.000Z')
  t.is(iso(weekStart(Date.parse('2026-11-02T02:59:59.000Z'))), '2026-10-26T03:00:00.000Z', 'Sunday 23:59:59 BRT')
  t.is(iso(weekStart(Date.parse('2026-11-02T03:00:00.000Z'))), '2026-11-02T03:00:00.000Z', 'Monday 00:00 BRT')
  t.is(iso(weekStart(Date.parse('2025-12-29T02:59:59.000Z'))), '2025-12-22T03:00:00.000Z', 'year boundary')
  t.is(iso(weekEnd(Date.parse('2026-10-28T12:00:00.000Z'))), '2026-11-02T03:00:00.000Z')
  t.is(WEEK_MS, 7 * DAY)
  t.is(INVITE_TTL_MS, 7 * DAY)
})

test('newCode and inviteId', (t) => {
  const code = newCode()
  t.ok(CODE_RE.test(code))
  t.ok(/^[0-9a-f]{64}$/.test(inviteId(code)))
  t.is(inviteId(code), inviteId(code))
  t.exception.all(() => inviteId('short'), /code/)
})

test('option and argument shapes', async (t) => {
  const { open, store } = setup(t)
  t.exception.all(() => open({ perWeek: 0 }), TypeError)
  t.exception.all(() => open({ perWeek: PER_WEEK_MAX + 1 }), TypeError)
  t.exception.all(() => open({ perWeek: 1.5 }), TypeError)
  t.is(open({ perWeek: null }).perWeek, null)
  t.is(store.perWeek, 3)
  t.exception.all(() => { store.perWeek = 9 }, TypeError)
  t.is(store.perWeek, 3, 'read-only')
  await t.exception.all(store.issue('nope'), TypeError)
  t.exception.all(() => store.check('nope'), TypeError)
  await t.exception.all(store.consume('ab'), TypeError)
  t.exception.all(() => store.summary('x'), TypeError)
})

test('open never creates the file; the first issue writes it with mode 0600', async (t) => {
  const { store, file, dir, c } = setup(t)
  t.alike(fs.readdirSync(dir), [])
  t.alike(store.count(), { total: 0, used: 0 })
  const m = memberKey()
  t.alike(store.summary(m), { perWeek: 3, used: 0, remaining: 3, resetsAt: '2026-11-02T03:00:00.000Z' })
  const out = await store.issue(m)
  t.ok(CODE_RE.test(out.code))
  t.alike(out, {
    code: out.code,
    expiresAt: new Date(c.t + INVITE_TTL_MS).toISOString(),
    used: 1,
    remaining: 2,
    resetsAt: '2026-11-02T03:00:00.000Z'
  })
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600')
  const disk = readFile(file)
  t.alike(Object.keys(disk), ['v', 'invites'])
  t.is(disk.invites.length, 1)
  const r = disk.invites[0]
  t.alike(Object.keys(r), ['slot', 'id', 'inviter', 'createdAt', 'used'])
  t.ok(/^[0-9a-f]{32}$/.test(r.slot))
  t.is(r.id, inviteId(out.code))
  t.is(r.inviter, m)
  t.is(r.createdAt, new Date(T0).toISOString())
  t.is(r.used, false)
  const raw = fs.readFileSync(file, 'utf8')
  t.absent(raw.includes(out.code), 'code never on disk')
  t.absent(/[A-Za-z0-9_-]{43}/.test(raw.replace(/[0-9a-f]{64}/g, '')), 'no 43-char code-like string')
  t.absent(raw.includes('@'), 'no e-mail-like string')
  t.absent(raw.includes('usedAt'))
})

test('issue N then limite-convites with nothing written; next Monday restores', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  for (let i = 0; i < 3; i++) await store.issue(m)
  const before = fs.readFileSync(file)
  await rejects(t, store.issue(m), 'limite-convites', 'fourth refused')
  t.alike(fs.readFileSync(file), before, 'no row written')
  t.alike(store.summary(m), { perWeek: 3, used: 3, remaining: 0, resetsAt: '2026-11-02T03:00:00.000Z' })
  const other = memberKey()
  t.is((await store.issue(other)).used, 1, 'per member')
  c.t = MONDAY - 1
  await rejects(t, store.issue(m), 'limite-convites', 'Sunday 23:59:59.999 BRT still the old week')
  c.t = MONDAY
  const out = await store.issue(m)
  t.is(out.used, 1)
  t.is(out.remaining, 2)
  t.is(out.resetsAt, '2026-11-09T03:00:00.000Z')
})

test('used invites still count against the week', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const a = await store.issue(m)
  t.alike(await store.consume(inviteId(a.code)), { changed: true })
  t.is(store.summary(m).used, 1)
  await store.issue(m)
  await store.issue(m)
  await rejects(t, store.issue(m), 'limite-convites', 'used row not refunded')
})

test('reopen with a lower perWeek gives remaining 0, a higher one allows more', async (t) => {
  const { store, open } = setup(t)
  const m = memberKey()
  for (let i = 0; i < 3; i++) await store.issue(m)
  const low = open({ perWeek: 1 })
  t.alike(low.summary(m).remaining, 0)
  await rejects(t, low.issue(m), 'limite-convites', 'lower perWeek')
  const high = open({ perWeek: 5 })
  const out = await high.issue(m)
  t.is(out.used, 4)
  t.is(out.remaining, 1)
})

test('perWeek null, readOnly and guard refuse issue', async (t) => {
  const { open, dir } = setup(t)
  const m = memberKey()
  const off = open({ perWeek: null })
  t.is(off.summary(m), null)
  await rejects(t, off.issue(m), 'indisponivel', 'perWeek null')
  await rejects(t, open({ readOnly: true }).issue(m), 'indisponivel', 'readOnly')
  await rejects(t, open({ guard: () => false }).issue(m), 'indisponivel', 'guard false')
  t.alike(fs.readdirSync(dir), [], 'nothing written')
})

test('check and consume: valid, consumed, unknown; consume is idempotent', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  const { code } = await store.issue(m)
  const id = inviteId(code)
  t.is(store.check(id), null)
  t.is(store.check(inviteId(newCode())), 'convite-invalido', 'unknown')
  t.alike(await store.consume(id), { changed: true })
  t.is(store.check(id), 'convite-invalido', 'used')
  const disk = readFile(file)
  t.is(disk.invites[0].id, null, 'hash stripped')
  t.is(disk.invites[0].used, true)
  const before = fs.readFileSync(file)
  t.alike(await store.consume(id), { changed: false }, 'second consume')
  t.alike(await store.consume(inviteId(newCode())), { changed: false }, 'unknown consume')
  t.alike(fs.readFileSync(file), before, 'no write')
  t.alike(store.count(), { total: 1, used: 1 })
  t.absent(fs.readFileSync(file, 'utf8').includes('usedAt'))
})

test('a link is valid until createdAt + 7 days', async (t) => {
  const { store, c } = setup(t)
  const { code } = await store.issue(memberKey())
  const id = inviteId(code)
  c.t = T0 + INVITE_TTL_MS - 1
  t.is(store.check(id), null, '7d - 1ms')
  c.t = T0 + INVITE_TTL_MS
  t.is(store.check(id), 'convite-invalido', '7d')
})

test('a link created Sunday 23:00 BRT is still valid on Wednesday', async (t) => {
  const { store, c } = setup(t)
  c.t = Date.parse('2026-11-02T02:00:00.000Z')
  const m = memberKey()
  const { code } = await store.issue(m)
  c.t = Date.parse('2026-11-04T12:00:00.000Z')
  t.is(store.check(inviteId(code)), null)
  t.is(store.summary(m).used, 0, 'counts in the previous week only')
})

test('isUsed true invalidates the link and the next write converts the row', async (t) => {
  const { open, file } = setup(t)
  const usedIds = new Set()
  const store = open({ isUsed: (id) => usedIds.has(id) })
  const m = memberKey()
  const { code } = await store.issue(m)
  const id = inviteId(code)
  usedIds.add(id)
  t.is(store.check(id), 'convite-invalido')
  t.is(readFile(file).invites[0].id, id, 'not yet converted on disk')
  t.is(await store.heal(), true)
  t.alike(readFile(file).invites[0], { ...readFile(file).invites[0], id: null, used: true })
  t.alike(store.count(), { total: 1, used: 1 })
  const throwing = open({ isUsed: () => { throw new Error('x') } })
  const other = await throwing.issue(m)
  t.is(throwing.check(inviteId(other.code)), null, 'a throwing isUsed counts as unused')
})

test('consume after isUsed already converted the row still writes', async (t) => {
  const { open, file } = setup(t)
  const usedIds = new Set()
  const store = open({ isUsed: (id) => usedIds.has(id) })
  const { code } = await store.issue(memberKey())
  const id = inviteId(code)
  usedIds.add(id)
  t.alike(await store.consume(id), { changed: true })
  t.alike(readFile(file).invites[0].id, null)
  t.alike(await store.consume(id), { changed: false })
})

test('pruning drops only rows outside the current week and expired', async (t) => {
  const { store, file, open, c } = setup(t)
  const m = memberKey()
  const old = row(m, T0 - 3 * WEEK_MS)
  const prevLive = row(m, MONDAY - 2 * WEEK_MS + 6 * DAY + 20 * HOUR)
  const cur = row(m, weekStart(T0) + HOUR, { used: true, id: null })
  writeRaw(file, { v: 1, invites: [old, prevLive, cur] })
  const s = open()
  t.is(s.count().total, 3)
  // prevLive: Sunday 20:00 BRT of the previous week, live until 2026-11-01T23:00Z.
  c.t = T0
  await s.issue(m)
  const slots = readFile(file).invites.map((r) => r.slot)
  t.absent(slots.includes(old.slot), 'old expired row pruned')
  t.ok(slots.includes(prevLive.slot), 'live link kept')
  t.ok(slots.includes(cur.slot), 'current-week row kept')
  t.is(store.available(), true)
})

test('concurrent issue calls never exceed perWeek', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => store.issue(m)))
  t.is(results.filter((r) => r.status === 'fulfilled').length, 3)
  t.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'limite-convites'))
  t.is(readFile(file).invites.length, 3)
})

test('guard false after the write leaves the store dirty; heal writes it back', async (t) => {
  const { open, file } = setup(t)
  let calls = 0
  let ok = true
  const store = open({ guard: () => { calls++; return ok || calls % 2 === 1 } })
  const m = memberKey()
  ok = false
  calls = 0
  await rejects(t, store.issue(m), 'indisponivel', 'refused after the write')
  t.is(readFile(file).invites.length, 1, 'write landed')
  writeRaw(file, { v: 1, invites: [] })
  ok = true
  t.is(await store.heal(), true, 'dirty heal writes')
  t.is(readFile(file).invites.length, 1, 'row written back')
  t.is(await store.heal(), false, 'clean heal does nothing')
})

test('external replacement is merged: used beats unused without double counting', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  const { code } = await store.issue(m)
  const stale = readFile(file)
  await store.consume(inviteId(code))
  writeRaw(file, stale)
  t.is(await store.heal(), true)
  const disk = readFile(file)
  t.is(disk.invites.length, 1)
  t.is(disk.invites[0].used, true)
  t.is(disk.invites[0].id, null)
  t.is(store.summary(m).used, 1)
  const other = row(memberKey(), T0)
  writeRaw(file, { v: 1, invites: [...disk.invites, other] })
  await store.issue(m)
  t.ok(readFile(file).invites.some((r) => r.slot === other.slot), 'external row kept')
})

test('slot conflict on inviter makes the store unavailable and the file untouched', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.issue(m)
  const disk = readFile(file)
  disk.invites[0].inviter = memberKey()
  writeRaw(file, disk)
  const before = fs.readFileSync(file)
  await rejects(t, store.issue(m), 'indisponivel', 'inviter conflict')
  t.alike(fs.readFileSync(file), before, 'byte-identical')
  t.is(await store.heal(), false)
  t.alike(fs.readFileSync(file), before, 'heal never writes it')
  t.is(store.available(), false)
})

test('malformed files make every method throw and are never rewritten', async (t) => {
  const { dir, file, open } = setup(t)
  const m = memberKey()
  const good = row(m, T0)
  const bad = [
    'not json',
    { v: 2, invites: [] },
    { v: 1, invites: [], extra: 1 },
    { v: 1, invites: [{ ...good, usedAt: null }] },
    { v: 1, invites: [{ ...good, id: null }] },
    { v: 1, invites: [good, { ...row(m, T0), slot: good.slot }] },
    { v: 1, invites: [good, { ...row(m, T0), id: good.id }] },
    { v: 1, invites: [{ ...good, inviter: 'AB'.repeat(32) }] },
    { v: 1, invites: [{ ...good, createdAt: '2026-10-28' }] }
  ]
  for (const content of bad) {
    writeRaw(file, content)
    const before = fs.readFileSync(file)
    const s = open()
    t.is(s.available(), false)
    t.exception(() => s.count(), /indisponivel/)
    t.exception(() => s.check(good.id), /indisponivel/)
    t.exception(() => s.summary(m), /indisponivel/)
    await rejects(t, s.issue(m), 'indisponivel', 'issue')
    await rejects(t, s.consume(good.id), 'indisponivel', 'consume')
    t.is(await s.heal(), false)
    t.alike(fs.readFileSync(file), before, 'byte-identical')
  }
  t.alike(fs.readdirSync(dir), [FILE])
})

test('readOnly never writes', async (t) => {
  const { open, dir, file } = setup(t)
  const ro = open({ readOnly: true })
  await rejects(t, ro.consume(inviteId(newCode())), 'indisponivel', 'consume')
  t.is(await ro.heal(), false)
  t.alike(fs.readdirSync(dir), [])
  const store = open()
  const { code } = await store.issue(memberKey())
  const before = fs.readFileSync(file)
  const ro2 = open({ readOnly: true, isUsed: () => true })
  t.is(ro2.check(inviteId(code)), 'convite-invalido')
  t.is(await ro2.heal(), false)
  t.alike(fs.readFileSync(file), before)
})

test('a union past MAX_ROWS opens; issue refuses with limite until pruning frees room', async (t) => {
  const { file, open, c } = setup(t)
  const m = memberKey()
  const invites = []
  const created = new Date(T0 - HOUR).toISOString()
  for (let i = 0; i < MAX_ROWS + 1; i++) {
    invites.push({ slot: i.toString(16).padStart(32, '0'), id: null, inviter: m, createdAt: created, used: true })
  }
  writeRaw(file, { v: 1, invites })
  const s = open({ perWeek: PER_WEEK_MAX })
  t.is(s.available(), true)
  t.is(s.count().total, MAX_ROWS + 1)
  const other = memberKey()
  await rejects(t, s.issue(other), 'limite', 'over the ceiling')
  c.t = T0 + 2 * WEEK_MS
  const out = await s.issue(other)
  t.is(out.used, 1)
  t.is(readFile(file).invites.length, 1, 'expired rows pruned')
})

test('a refused issue writes a merge that stripped a used hash', async (t) => {
  const { open, file } = setup(t)
  const usedIds = new Set()
  const store = open({ isUsed: (id) => usedIds.has(id) })
  const m = memberKey()
  const codes = []
  for (let i = 0; i < 3; i++) codes.push((await store.issue(m)).code)
  const id = inviteId(codes[0])
  usedIds.add(id)
  await rejects(t, store.issue(m), 'limite-convites', 'still at perWeek')
  const r = readFile(file).invites.find((x) => x.id === null)
  t.ok(r && r.used === true, 'row converted on disk')
  t.absent(readFile(file).invites.some((x) => x.id === id), 'used hash gone from disk')
})

test('consume of an unknown id writes a merge that stripped a used hash', async (t) => {
  const { open, file } = setup(t)
  const usedIds = new Set()
  const store = open({ isUsed: (id) => usedIds.has(id) })
  const { code } = await store.issue(memberKey())
  const id = inviteId(code)
  usedIds.add(id)
  t.alike(await store.consume(inviteId(newCode())), { changed: false })
  t.alike(readFile(file).invites[0].id, null)
  t.is(readFile(file).invites[0].used, true)
})

test('a refused issue writes back rows an older snapshot lost', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  await store.issue(m)
  const older = fs.readFileSync(file)
  await store.issue(m)
  await store.issue(m)
  fs.writeFileSync(file, older, { mode: 0o600 })
  await rejects(t, store.issue(m), 'limite-convites', 'at perWeek')
  t.is(readFile(file).invites.length, 3, 'union written back')
})

test('a refused issue whose merge write is refused by guard still answers limite-convites', async (t) => {
  const { open, file } = setup(t)
  const usedIds = new Set()
  let calls = 0
  let ok = true
  const store = open({ isUsed: (id) => usedIds.has(id), guard: () => { calls++; return ok || calls % 2 === 1 } })
  const m = memberKey()
  const codes = []
  for (let i = 0; i < 3; i++) codes.push((await store.issue(m)).code)
  usedIds.add(inviteId(codes[0]))
  ok = false
  calls = 0
  await rejects(t, store.issue(m), 'limite-convites', 'not masked by the guard refusal')
  t.is(store.available(), true)
  t.ok(readFile(file).invites.some((x) => x.id === null), 'write landed')
})
