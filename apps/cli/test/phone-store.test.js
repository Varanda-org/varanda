'use strict'

// apps/cli/lib/account/phone-store.js: the phone.json sidecar where the
// account service keeps each member's verified number, sealed, beside a keyed
// index. No network; keys are generated per test, the clock is injected and
// the linked / burnable / deleted callbacks are plain functions over Sets.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { openPhoneStore, FILE, RETENTION_MS, UNLINKED_TTL_MS } = require('../lib/account/phone-store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-11-11T12:00:00.000Z')
const DAY = 24 * 3600 * 1000
const iso = (ms) => new Date(ms).toISOString()
const PHONE = '+5511987654321'
const PHONE_B = '+5521998765432'
const DIGITS = ['5511987654321', '11987654321', '987654321', '98765-4321']

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = { t: T0, now: () => c.t }
  const key = nodeCrypto.randomBytes(32)
  const open = (more = {}) => openPhoneStore(dir, { key, now: c.now, ...opts, ...more })
  const linked = new Set()
  const burnable = new Set()
  const deleted = new Set()
  const cbs = {
    linked: (m) => linked.has(m),
    burnable: (m) => burnable.has(m),
    deleted: (m) => deleted.has(m)
  }
  return { dir, file: path.join(dir, FILE), c, key, open, store: open(), linked, burnable, deleted, cbs }
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

function throwsCode (t, fn, code, msg) {
  try {
    fn()
    t.fail(msg + ': returned')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

function readFile (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeFile (file, json) {
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', { mode: 0o600 })
}

// Bytes and inode: writeJsonAtomic renames, so any write changes the inode.
function snapshot (file) {
  return { bytes: fs.readFileSync(file), ino: fs.statSync(file).ino }
}

function unchanged (t, file, snap, msg) {
  const now = snapshot(file)
  t.ok(b4a.equals(now.bytes, snap.bytes) && now.ino === snap.ino, msg)
}

function noDigits (t, file) {
  const text = fs.readFileSync(file, 'utf8')
  for (const d of DIGITS) t.absent(text.includes(d), 'the file never holds ' + d.length + ' digits of the number')
}

test('constants', (t) => {
  t.is(FILE, 'phone.json')
  t.is(RETENTION_MS, 180 * DAY)
  t.is(UNLINKED_TTL_MS, 7 * DAY)
})

test('key must be a 32-byte Buffer; the message never carries the value', (t) => {
  const dir = tmpDir(t)
  for (const key of [undefined, 'k'.repeat(32), nodeCrypto.randomBytes(31), nodeCrypto.randomBytes(33), new Uint8Array(32)]) {
    try {
      openPhoneStore(dir, { key })
      t.fail('accepted')
    } catch (err) {
      t.ok(err instanceof TypeError)
      t.is(err.message, 'key must be a 32-byte Buffer')
    }
  }
  t.alike(fs.readdirSync(dir), [], 'nothing created')
})

test('record round trip: exact file shape, mode 0600, since fixed, no digits on disk', async (t) => {
  const { store, file, dir, c, cbs, linked } = setup(t)
  const m = memberKey()
  linked.add(m)
  t.ok(store.available())
  t.is(store.since(), null, 'since is null before the first write')
  t.absent(store.verified(m))
  t.is(store.live(m), null)
  t.alike(store.counts(), { live: 0, ended: 0, burned: 0 })
  t.alike(fs.readdirSync(dir), [], 'opening writes nothing')

  t.alike(await store.record({ member: m, phone: PHONE }, cbs), { changed: true })
  t.ok(store.verified(m))
  const index = store.indexOf(PHONE)
  t.ok(/^[0-9a-f]{64}$/.test(index))
  t.alike(store.live(m), { index, verifiedAt: iso(T0) })
  t.is(store.since(), iso(T0))
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600')
  noDigits(t, file)

  const json = readFile(file)
  t.alike(Object.keys(json), ['v', 'check', 'since', 'rows', 'released'])
  t.is(json.v, 1)
  t.ok(/^[0-9a-f]{64}$/.test(json.check))
  t.is(json.since, iso(T0))
  t.alike(json.released, {})
  t.is(json.rows.length, 1)
  const row = json.rows[0]
  t.alike(Object.keys(row), ['member', 'index', 'sealed', 'verifiedAt', 'endedAt', 'end', 'burnedAt'])
  t.alike({ ...row, sealed: null }, { member: m, index, sealed: null, verifiedAt: iso(T0), endedAt: null, end: null, burnedAt: null })
  t.alike(Object.keys(row.sealed), ['iv', 'tag', 'data'])
  t.is(Buffer.from(row.sealed.iv, 'base64').length, 12)
  t.is(Buffer.from(row.sealed.tag, 'base64').length, 16)

  c.t = T0 + DAY
  const m2 = memberKey()
  linked.add(m2)
  await store.record({ member: m2, phone: PHONE_B }, cbs)
  t.is(readFile(file).since, iso(T0), 'since never changes after the first write')
  t.is(store.since(), iso(T0))
})

test('a repeat of the same number is not a change and does not write', async (t) => {
  const { store, file, c, cbs } = setup(t)
  const m = memberKey()
  await store.record({ member: m, phone: PHONE }, cbs)
  const snap = snapshot(file)
  c.t = T0 + DAY
  t.alike(await store.record({ member: m, phone: PHONE }, cbs), { changed: false })
  unchanged(t, file, snap, 'not rewritten')
  t.is(store.live(m).verifiedAt, iso(T0))
})

test('the same number gives the same index across a reopen with the same key', async (t) => {
  const { store, open, file, cbs } = setup(t)
  const m = memberKey()
  await store.record({ member: m, phone: PHONE }, cbs)
  const again = open()
  t.ok(again.available())
  t.is(again.indexOf(PHONE), store.indexOf(PHONE))
  t.is(readFile(file).rows[0].index, again.indexOf(PHONE))
  t.ok(again.verified(m))
  t.not(again.indexOf(PHONE_B), again.indexOf(PHONE))
})

test('argument shapes throw TypeError without the number', async (t) => {
  const { store, cbs } = setup(t)
  const m = memberKey()
  for (const phone of ['5511987654321', '+551187654321', '+5511087654321', '+15551234567', 42]) {
    try {
      store.indexOf(phone)
      t.fail('accepted')
    } catch (err) {
      t.ok(err instanceof TypeError)
      t.absent(String(err.message).includes('8765'), 'no digits in the message')
    }
    await t.exception.all(store.record({ member: m, phone }, cbs), TypeError)
  }
  await t.exception.all(store.record({ member: 'ab', phone: PHONE }, cbs), TypeError)
  await t.exception.all(store.record({ member: m, phone: PHONE }), TypeError)
  await t.exception.all(store.record({ member: m, phone: PHONE }, { linked: () => true }), TypeError)
  await t.exception.all(store.record({ member: m, phone: PHONE, verifiedAt: '2026-11-11' }, cbs), TypeError)
  await t.exception.all(store.end(m, 'liberado'), TypeError)
  await t.exception.all(store.sweep({}), TypeError)
  t.exception.all(() => store.verified('x'), TypeError)
})

test('a wrong key fails closed and never rewrites the file', async (t) => {
  const { store, dir, file, c, cbs, linked } = setup(t)
  const m = memberKey()
  linked.add(m)
  await store.record({ member: m, phone: PHONE }, cbs)
  const snap = snapshot(file)
  const wrong = openPhoneStore(dir, { key: nodeCrypto.randomBytes(32), now: c.now, disclose: true })
  t.absent(wrong.available())
  throwsCode(t, () => wrong.verified(m), 'indisponivel', 'verified')
  throwsCode(t, () => wrong.live(m), 'indisponivel', 'live')
  throwsCode(t, () => wrong.indexOf(PHONE), 'indisponivel', 'indexOf')
  throwsCode(t, () => wrong.counts(), 'indisponivel', 'counts')
  throwsCode(t, () => wrong.since(), 'indisponivel', 'since')
  throwsCode(t, () => wrong.reveal(m), 'indisponivel', 'reveal')
  await rejects(t, wrong.record({ member: memberKey(), phone: PHONE_B }, cbs), 'indisponivel', 'record')
  await rejects(t, wrong.end(m), 'indisponivel', 'end')
  await rejects(t, wrong.release(m), 'indisponivel', 'release')
  await rejects(t, wrong.sweep(cbs), 'indisponivel', 'sweep')
  t.is(await wrong.heal(), false)
  t.absent(wrong.available())
  unchanged(t, file, snap, 'never rewritten')
})

test('a wrong key fails closed on a file holding only burned rows without a seal', async (t) => {
  const { store, dir, file, c, cbs, burnable } = setup(t)
  const m = memberKey()
  await store.record({ member: m, phone: PHONE }, cbs)
  burnable.add(m)
  await store.sweep(cbs)
  c.t = T0 + RETENTION_MS + DAY
  await store.sweep(cbs)
  const json = readFile(file)
  t.is(json.rows.length, 1)
  t.is(json.rows[0].sealed, null, 'only the index is left')
  t.ok(json.rows[0].burnedAt)
  const snap = snapshot(file)
  const wrong = openPhoneStore(dir, { key: nodeCrypto.randomBytes(32), now: c.now })
  t.absent(wrong.available())
  await rejects(t, wrong.record({ member: memberKey(), phone: PHONE }, cbs), 'indisponivel', 'record refused')
  await rejects(t, wrong.sweep(cbs), 'indisponivel', 'sweep refused')
  t.is(await wrong.heal(), false)
  unchanged(t, file, snap, 'never rewritten')
})

test('a seal moved to another member\'s row does not open; the other rows still reveal', async (t) => {
  const { store, open, file, cbs, linked } = setup(t)
  const a = memberKey()
  const b = memberKey()
  linked.add(a)
  linked.add(b)
  await store.record({ member: a, phone: PHONE }, cbs)
  await store.record({ member: b, phone: PHONE_B }, cbs)
  const json = readFile(file)
  const sealA = json.rows[0].sealed
  json.rows[0].sealed = json.rows[1].sealed
  json.rows[1].sealed = sealA
  writeFile(file, json)
  const court = open({ disclose: true })
  t.ok(court.available(), 'the file is well formed')
  t.alike(court.reveal(a).map((r) => [r.phone, r.sealError]), [[null, true]], 'a moved seal does not open')
  t.alike(court.reveal(b).map((r) => [r.phone, r.sealError]), [[null, true]], 'nor the other one')
  t.ok(court.available(), 'marks nothing')

  // Seal and index copied together, so only the member-bound AAD stops it.
  json.rows[0].sealed = sealA
  json.rows[1].sealed = sealA
  json.rows[1].index = json.rows[0].index
  json.rows[1].end = 'trocado'
  json.rows[1].endedAt = iso(T0)
  writeFile(file, json)
  const copied = open({ disclose: true })
  t.ok(copied.available())
  t.is(copied.reveal(a)[0].phone, PHONE, 'the original row still opens')
  t.alike(copied.reveal(b), [
    { phone: null, verifiedAt: iso(T0), endedAt: iso(T0), end: 'trocado', burned: false, sealError: true }
  ], 'a copied seal and index do not open under another member')

  // One bad row among good ones: the good ones still reveal.
  await store.record({ member: b, phone: PHONE_B }, cbs)
  const mixed = open({ disclose: true }).reveal(b)
  t.alike(mixed.map((r) => [r.phone, r.sealError]), [[null, true], [PHONE_B, false]])
  t.absent(JSON.stringify(mixed[0]).includes('8765'), 'the bad row carries no number')
})

test('a linked holder refuses a second member', async (t) => {
  const { store, file, cbs, linked } = setup(t)
  const a = memberKey()
  const b = memberKey()
  linked.add(a)
  await store.record({ member: a, phone: PHONE }, cbs)
  const snap = snapshot(file)
  await rejects(t, store.record({ member: b, phone: PHONE }, cbs), 'telefone-em-uso', 'refused')
  unchanged(t, file, snap, 'nothing written')
  t.ok(store.verified(a))
  t.absent(store.verified(b))
})

test('an unlinked holder is superseded', async (t) => {
  const { store, open, c, cbs } = setup(t)
  const a = memberKey()
  const b = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  c.t = T0 + 1000
  t.alike(await store.record({ member: b, phone: PHONE }, cbs), { changed: true })
  t.absent(store.verified(a))
  t.ok(store.verified(b))
  t.alike(open({ disclose: true }).reveal(a), [{ phone: PHONE, verifiedAt: iso(T0), endedAt: iso(T0 + 1000), end: 'substituido', burned: false, sealError: false }])
})

test('a deleted holder\'s live row is ended and the number is free', async (t) => {
  const { store, open, c, cbs, linked, deleted } = setup(t)
  const a = memberKey()
  const b = memberKey()
  linked.add(a)
  await store.record({ member: a, phone: PHONE }, cbs)
  deleted.add(a)
  c.t = T0 + 1000
  t.alike(await store.record({ member: b, phone: PHONE }, cbs), { changed: true })
  t.ok(store.verified(b))
  t.is(store.live(a), null)
  t.alike(open({ disclose: true }).reveal(a)[0].end, 'excluida')
})

test('a replaced number is free for another member unless its owner is burnable', async (t) => {
  const { store, c, cbs, linked, burnable } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const d = memberKey()
  linked.add(a)
  linked.add(b)
  await store.record({ member: a, phone: PHONE }, cbs)
  c.t = T0 + 1000
  await store.record({ member: a, phone: PHONE_B }, cbs)
  burnable.add(a)
  await rejects(t, store.record({ member: b, phone: PHONE }, cbs), 'telefone-em-uso', 'a burnable owner holds even an ended row')
  burnable.delete(a)
  t.alike(await store.record({ member: d, phone: PHONE }, cbs), { changed: true }, 'free once the owner is not burnable')
})

test('change history is kept and revealed only with disclose', async (t) => {
  const { store, open, c, cbs, linked } = setup(t)
  const a = memberKey()
  linked.add(a)
  await store.record({ member: a, phone: PHONE }, cbs)
  c.t = T0 + DAY
  await store.record({ member: a, phone: PHONE_B }, cbs)
  t.alike(store.live(a), { index: store.indexOf(PHONE_B), verifiedAt: iso(T0 + DAY) })
  t.alike(store.counts(), { live: 1, ended: 1, burned: 0 })
  throwsCode(t, () => store.reveal(a), 'sem-permissao', 'refused without disclose')
  t.alike(open({ disclose: true }).reveal(a), [
    { phone: PHONE, verifiedAt: iso(T0), endedAt: iso(T0 + DAY), end: 'trocado', burned: false, sealError: false },
    { phone: PHONE_B, verifiedAt: iso(T0 + DAY), endedAt: null, end: null, burned: false, sealError: false }
  ])
  t.alike(open({ disclose: true }).reveal(memberKey()), [])
})

test('end keeps the seal, never burns and is idempotent', async (t) => {
  const { store, open, file, c, cbs } = setup(t)
  const a = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  c.t = T0 + 1000
  t.alike(await store.end(a), { changed: true })
  t.absent(store.verified(a))
  const snap = snapshot(file)
  t.alike(await store.end(a), { changed: false })
  unchanged(t, file, snap, 'a second end does not write')
  const row = readFile(file).rows[0]
  t.ok(row.sealed)
  t.is(row.burnedAt, null)
  t.is(row.end, 'excluida')
  t.is(row.endedAt, iso(T0 + 1000))
  t.alike(open({ disclose: true }).reveal(a).map((r) => r.phone), [PHONE])
})

test('sweep burns live and ended rows; unblock gives the number back', async (t) => {
  const { store, file, c, cbs, linked, burnable } = setup(t)
  const a = memberKey()
  const b = memberKey()
  linked.add(a)
  linked.add(b)
  await store.record({ member: a, phone: PHONE }, cbs)
  c.t = T0 + 1000
  await store.record({ member: a, phone: PHONE_B }, cbs)
  burnable.add(a)
  c.t = T0 + 2000
  const out = await store.sweep(cbs)
  t.is(out.burned, 2)
  t.ok(Object.values(out).every((n) => typeof n === 'number'), 'counts only')
  t.alike(store.counts(), { live: 1, ended: 1, burned: 2 })
  t.ok(readFile(file).rows.every((r) => r.burnedAt === iso(T0 + 2000)))
  const snap = snapshot(file)
  await store.sweep(cbs)
  unchanged(t, file, snap, 'a second sweep has nothing to do')

  burnable.delete(a)
  linked.delete(a)
  await rejects(t, store.record({ member: b, phone: PHONE }, cbs), 'telefone-em-uso', 'burned until the sweep sees the unblock')
  const back = await store.sweep(cbs)
  t.is(back.unburned, 2)
  t.alike(store.counts(), { live: 1, ended: 1, burned: 0 })
  t.alike(await store.record({ member: b, phone: PHONE }, cbs), { changed: true }, 'unblock gives the number back')
  t.alike(await store.record({ member: memberKey(), phone: PHONE_B }, cbs), { changed: true }, 'the live one too, its owner not linked')
})

test('retention: an ended row is deleted 180 days after endedAt', async (t) => {
  const { store, file, c, cbs, linked } = setup(t)
  const a = memberKey()
  linked.add(a)
  await store.record({ member: a, phone: PHONE }, cbs)
  c.t = T0 + DAY
  await store.record({ member: a, phone: PHONE_B }, cbs)
  c.t = T0 + DAY + RETENTION_MS - 1
  await store.sweep(cbs)
  t.is(readFile(file).rows.length, 2, 'kept until the period ends')
  c.t = T0 + DAY + RETENTION_MS
  const out = await store.sweep(cbs)
  t.is(out.removed, 1)
  const rows = readFile(file).rows
  t.is(rows.length, 1)
  t.is(rows[0].end, null, 'the live row stays')
})

test('retention: a burned row loses its seal 180 days after burnedAt and keeps its index', async (t) => {
  const { store, open, file, c, cbs, linked, burnable } = setup(t)
  const a = memberKey()
  linked.add(a)
  await store.record({ member: a, phone: PHONE }, cbs)
  burnable.add(a)
  c.t = T0 + DAY
  await store.sweep(cbs)
  c.t = T0 + DAY + RETENTION_MS
  const out = await store.sweep(cbs)
  t.is(out.unsealed, 1)
  const row = readFile(file).rows[0]
  t.is(row.sealed, null)
  t.is(row.end, null, 'a live burned row stays live')
  t.is(row.burnedAt, iso(T0 + DAY))
  t.absent(store.verified(a), 'no seal, not verified')
  t.alike(open({ disclose: true }).reveal(a), [], 'nothing left to reveal')
  await rejects(t, store.record({ member: memberKey(), phone: PHONE }, cbs), 'telefone-em-uso', 'the index still holds the number')

  burnable.delete(a)
  const back = await store.sweep(cbs)
  t.is(back.removed, 1)
  t.alike(readFile(file).rows, [], 'unburned without a seal: deleted')
})

test('retention runs from the earlier of endedAt and burnedAt', async (t) => {
  const { store, file, c, cbs, burnable } = setup(t)
  const a = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  await store.end(a)
  c.t = T0 + RETENTION_MS - DAY
  burnable.add(a)
  await store.sweep(cbs)
  t.ok(readFile(file).rows[0].sealed)
  c.t = T0 + RETENTION_MS
  await store.sweep(cbs)
  const row = readFile(file).rows[0]
  t.is(row.sealed, null, 'sealed dropped at endedAt + 180 days')
  t.is(row.burnedAt, iso(T0 + RETENTION_MS - DAY))
})

test('unlinked TTL deletes an unlinked live row, but not a deleted or burnable owner\'s', async (t) => {
  const { store, file, c, cbs, linked, burnable, deleted } = setup(t)
  const plain = memberKey()
  const link = memberKey()
  const gone = memberKey()
  const blocked = memberKey()
  linked.add(link)
  await store.record({ member: plain, phone: PHONE }, cbs)
  await store.record({ member: link, phone: PHONE_B }, cbs)
  await store.record({ member: gone, phone: '+5531991234567' }, cbs)
  await store.record({ member: blocked, phone: '+5541991234567' }, cbs)
  deleted.add(gone)
  burnable.add(blocked)
  c.t = T0 + UNLINKED_TTL_MS - 1
  await store.sweep(cbs)
  t.ok(store.verified(plain), 'kept within the TTL')
  c.t = T0 + UNLINKED_TTL_MS
  await store.sweep(cbs)
  t.absent(store.verified(plain))
  t.ok(store.verified(link))
  const rows = readFile(file).rows
  t.absent(rows.some((r) => r.member === plain), 'the unlinked row is gone')
  const goneRow = rows.find((r) => r.member === gone)
  t.is(goneRow.end, 'excluida', 'a deleted owner is ended, not dropped')
  t.ok(goneRow.sealed)
  const blockedRow = rows.find((r) => r.member === blocked)
  t.is(blockedRow.end, null)
  t.ok(blockedRow.burnedAt, 'a burnable owner keeps the row, burned')
})

test('two concurrent records of one number let exactly one through', async (t) => {
  const { store, file, cbs, linked } = setup(t)
  const a = memberKey()
  const b = memberKey()
  linked.add(a)
  linked.add(b)
  const results = await Promise.allSettled([
    store.record({ member: a, phone: PHONE }, cbs),
    store.record({ member: b, phone: PHONE }, cbs)
  ])
  const ok = results.filter((r) => r.status === 'fulfilled')
  const no = results.filter((r) => r.status === 'rejected')
  t.is(ok.length, 1)
  t.is(no.length, 1)
  t.is(no[0].reason.code, 'telefone-em-uso')
  t.is(readFile(file).rows.length, 1)
  t.is([a, b].filter((m) => store.verified(m)).length, 1)
})

test('settled resolves after a record queued before it has committed', async (t) => {
  const { store, open, cbs } = setup(t)
  const a = memberKey()
  const pending = store.record({ member: a, phone: PHONE }, cbs)
  t.absent(store.verified(a), 'not yet committed')
  await store.settled(a)
  t.ok(store.verified(a))
  t.ok(open().verified(a), 'on disk')
  await pending
  await t.exception.all(store.settled('nope'), TypeError)
})

test('readOnly reads and reveals but never writes', async (t) => {
  const { store, open, file, cbs } = setup(t)
  const a = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  const snap = snapshot(file)
  const ro = open({ readOnly: true, disclose: true })
  t.ok(ro.verified(a))
  t.is(ro.reveal(a)[0].phone, PHONE)
  await rejects(t, ro.record({ member: memberKey(), phone: PHONE_B }, cbs), 'indisponivel', 'record')
  await rejects(t, ro.end(a), 'indisponivel', 'end')
  await rejects(t, ro.release(a), 'indisponivel', 'release')
  await rejects(t, ro.sweep(cbs), 'indisponivel', 'sweep')
  t.is(await ro.heal(), false)
  unchanged(t, file, snap, 'never written')

  const { open: openEmpty, dir } = setup(t)
  const empty = openEmpty({ readOnly: true })
  await rejects(t, empty.record({ member: a, phone: PHONE }, cbs), 'indisponivel', 'no file created')
  t.alike(fs.readdirSync(dir), [])
})

test('a corrupt file, a symlink data dir and a refusing guard answer indisponivel', async (t) => {
  const { open, file, dir, cbs, key } = setup(t)
  fs.writeFileSync(file, '{ not json')
  const corrupt = open()
  t.absent(corrupt.available())
  await rejects(t, corrupt.record({ member: memberKey(), phone: PHONE }, cbs), 'indisponivel', 'corrupt file')
  t.is(fs.readFileSync(file, 'utf8'), '{ not json', 'never rewritten')

  const link = path.join(tmpDir(t), 'link')
  fs.symlinkSync(dir, link)
  const viaLink = openPhoneStore(link, { key })
  t.absent(viaLink.available())
  await rejects(t, viaLink.record({ member: memberKey(), phone: PHONE }, cbs), 'indisponivel', 'symlink data dir')

  const fresh = setup(t, { guard: () => false })
  await rejects(t, fresh.store.record({ member: memberKey(), phone: PHONE }, fresh.cbs), 'indisponivel', 'guard false')
  t.alike(fs.readdirSync(fresh.dir), [], 'nothing written')
  t.ok(fresh.store.available(), 'a refusing guard does not fail the store')
})

test('the guard is asked again right before the write', async (t) => {
  let calls = 0
  const { store, dir, cbs } = setup(t, { guard: () => ++calls < 2 })
  const a = memberKey()
  await rejects(t, store.record({ member: a, phone: PHONE }, cbs), 'indisponivel', 'second guard refuses')
  t.is(calls, 2)
  t.alike(fs.readdirSync(dir), [], 'nothing written')
  t.absent(store.verified(a), 'memory unchanged')
  t.ok(store.dirty())
})

test('validation refuses what this module would not write', async (t) => {
  const { store, open, file, cbs, linked } = setup(t)
  const a = memberKey()
  const b = memberKey()
  linked.add(a)
  linked.add(b)
  await store.record({ member: a, phone: PHONE }, cbs)
  await store.record({ member: b, phone: PHONE_B }, cbs)
  const good = readFile(file)
  const variants = {
    'extra top key': (j) => { j.extra = 1 },
    'no released': (j) => { delete j.released },
    'non canonical since': (j) => { j.since = '2026-11-11' },
    'null since': (j) => { j.since = null },
    'bad check': (j) => { j.check = '0'.repeat(64) },
    'two live rows for one member': (j) => { j.rows[1].member = a },
    'two live rows for one index': (j) => { j.rows[1].index = j.rows[0].index },
    'live row with endedAt': (j) => { j.rows[0].endedAt = iso(T0) },
    'ended row without endedAt': (j) => { j.rows[0].end = 'trocado' },
    'unknown end': (j) => { j.rows[0].end = 'x'; j.rows[0].endedAt = iso(T0) },
    'no seal and not burned': (j) => { j.rows[0].sealed = null },
    'short iv': (j) => { j.rows[0].sealed.iv = 'AAAA' },
    'extra row key': (j) => { j.rows[0].phone = 'x' },
    'bad released member': (j) => { j.released = { x: iso(T0) } },
    'bad released time': (j) => { j.released = { [a]: 'soon' } }
  }
  for (const [name, mutate] of Object.entries(variants)) {
    const j = JSON.parse(JSON.stringify(good))
    mutate(j)
    writeFile(file, j)
    const s = open()
    t.absent(s.available(), name)
    await rejects(t, s.sweep(cbs), 'indisponivel', name + ': sweep refused')
    t.alike(readFile(file), j, name + ': never rewritten')
  }
})

test('heal adopts the disk state and never writes', async (t) => {
  const { store, open, file, cbs } = setup(t)
  const other = open()
  const a = memberKey()
  await other.record({ member: a, phone: PHONE }, cbs)
  t.absent(store.verified(a), 'the first holder has not seen it')
  t.is(store.since(), null)
  const snap = snapshot(file)
  t.is(await store.heal(), false)
  unchanged(t, file, snap, 'heal did not write')
  t.ok(store.verified(a), 'adopted')
  t.is(store.since(), iso(T0))

  fs.writeFileSync(file, '[]')
  t.is(await store.heal(), false)
  t.absent(store.available(), 'an invalid file fails the store')
  t.is(fs.readFileSync(file, 'utf8'), '[]')
})

test('a write that throws leaves memory as it was; heal clears dirty', async (t) => {
  const { store, cbs } = setup(t)
  const a = memberKey()
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = () => { throw new Error('disk full') }
  await rejects(t, store.record({ member: a, phone: PHONE }, cbs), 'indisponivel', 'write failed')
  fs.renameSync = renameSync
  t.absent(store.verified(a))
  t.ok(store.dirty())
  t.ok(store.available(), 'the file is still valid')
  t.is(await store.heal(), false)
  t.absent(store.dirty())
  t.alike(await store.record({ member: a, phone: PHONE }, cbs), { changed: true })
})

test('fail() refuses every later call', async (t) => {
  const { store, cbs } = setup(t)
  store.fail()
  t.absent(store.available())
  throwsCode(t, () => store.counts(), 'indisponivel', 'counts')
  await rejects(t, store.record({ member: memberKey(), phone: PHONE }, cbs), 'indisponivel', 'record')
})

test('release ends the live row as liberado and clears every burn', async (t) => {
  const { store, open, file, c, cbs, linked, burnable } = setup(t)
  const a = memberKey()
  linked.add(a)
  await store.record({ member: a, phone: PHONE }, cbs)
  c.t = T0 + 1000
  await store.record({ member: a, phone: PHONE_B }, cbs)
  burnable.add(a)
  c.t = T0 + 2000
  await store.sweep(cbs)
  t.alike(store.counts(), { live: 1, ended: 1, burned: 2 })
  c.t = T0 + 3000
  const out = await store.release(a)
  t.alike(out, { rows: 2 }, 'a count, never a number')
  const json = readFile(file)
  t.alike(json.released, { [a]: iso(T0 + 3000) })
  t.ok(json.rows.every((r) => r.burnedAt === null && r.sealed !== null), 'burns cleared, seals kept')
  t.is(json.rows[1].end, 'liberado')
  t.is(json.rows[1].endedAt, iso(T0 + 3000))
  t.is(store.live(a), null)
  noDigits(t, file)

  c.t = T0 + 4000
  const again = await store.sweep(cbs)
  t.is(again.burned, 0, 'a released owner is not re-burned while still blocked')
  t.alike(store.counts(), { live: 0, ended: 2, burned: 0 })

  const b = memberKey()
  t.alike(await store.record({ member: b, phone: PHONE_B }, cbs), { changed: true }, 'another member can take the number')

  const revealed = open({ disclose: true }).reveal(a)
  t.alike(revealed.map((r) => [r.phone, r.end, r.burned]), [[PHONE, 'trocado', false], [PHONE_B, 'liberado', false]])

  c.t = T0 + 3000 + RETENTION_MS
  await store.sweep(cbs)
  t.alike(open({ disclose: true }).reveal(a), [], 'gone after retention from endedAt')
})

test('release drops burn tombstones and keeps the first release time', async (t) => {
  const { store, file, c, cbs, burnable } = setup(t)
  const a = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  burnable.add(a)
  await store.sweep(cbs)
  c.t = T0 + RETENTION_MS
  await store.sweep(cbs)
  t.is(readFile(file).rows[0].sealed, null)
  c.t = T0 + RETENTION_MS + 1000
  t.alike(await store.release(a), { rows: 0 })
  t.alike(readFile(file).rows, [])
  const snap = snapshot(file)
  c.t += 1000
  t.alike(await store.release(a), { rows: 0 })
  unchanged(t, file, snap, 'a repeat release does not write')
  t.alike(readFile(file).released, { [a]: iso(T0 + RETENTION_MS + 1000) })
})

test('sweep drops a release once the block is lifted; a new block burns again', async (t) => {
  const { store, file, c, cbs, linked, burnable } = setup(t)
  const a = memberKey()
  linked.add(a)
  await store.record({ member: a, phone: PHONE }, cbs)
  burnable.add(a)
  await store.sweep(cbs)
  c.t = T0 + 1000
  await store.release(a)
  c.t = T0 + 2000
  await store.record({ member: a, phone: PHONE_B }, cbs)
  await store.sweep(cbs)
  t.is(store.counts().burned, 0, 'still released')
  burnable.delete(a)
  const out = await store.sweep(cbs)
  t.is(out.released, 1)
  t.alike(readFile(file).released, {}, 'release dropped once not burnable')
  burnable.add(a)
  c.t = T0 + 3000
  const burned = await store.sweep(cbs)
  t.is(burned.burned, 2, 'a new block burns every row again')
  t.is(store.counts().burned, 2)
})

test('a file broken after open fails the store; errors never carry the number', async (t) => {
  const { store, file, cbs } = setup(t)
  const a = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  fs.writeFileSync(file, '{')
  await rejects(t, store.record({ member: a, phone: PHONE }, cbs), 'indisponivel', 'unreadable')
  t.absent(store.available())
  try {
    store.verified(a)
    t.fail('answered')
  } catch (err) {
    t.is(err.code, 'indisponivel')
    t.absent(String(err.message).includes('8765'))
    t.absent(String(err.stack).includes('8765'))
  }
})

// writeJsonAtomic renamed the file into place, then threw (as fsyncDir can).
function landThenThrow (t) {
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = function (from, to) {
    renameSync(from, to)
    throw new Error('fsync failed')
  }
  return () => { fs.renameSync = renameSync }
}

test('a write that lands then throws: memory adopts the disk, for record and end', async (t) => {
  const { store, open, c, cbs } = setup(t)
  const a = memberKey()
  let restore = landThenThrow(t)
  await rejects(t, store.record({ member: a, phone: PHONE }, cbs), 'indisponivel', 'record answered indisponivel')
  restore()
  t.ok(store.available())
  t.ok(store.verified(a), 'the landed row is visible')
  t.alike(store.live(a), { index: store.indexOf(PHONE), verifiedAt: iso(T0) })
  t.is(store.since(), iso(T0))
  t.ok(store.dirty())
  t.ok(open().verified(a), 'it is on disk')

  c.t = T0 + 1000
  restore = landThenThrow(t)
  await rejects(t, store.end(a), 'indisponivel', 'end answered indisponivel')
  restore()
  t.ok(store.available())
  t.absent(store.verified(a), 'the landed end is visible')
  t.is(store.live(a), null)
  t.alike(store.counts(), { live: 0, ended: 1, burned: 0 })
})

test('a write that lands then throws with an unreadable file: unavailable until heal', async (t) => {
  const { store, cbs, file } = setup(t)
  const a = memberKey()
  const { renameSync, openSync } = fs
  let blind = false
  t.teardown(() => { fs.renameSync = renameSync; fs.openSync = openSync }, { force: true })
  fs.openSync = function (p, ...rest) {
    if (blind && p === file) {
      const err = new Error('io')
      err.code = 'EIO'
      throw err
    }
    return openSync.call(fs, p, ...rest)
  }
  fs.renameSync = function (from, to) {
    renameSync(from, to)
    blind = true
    throw new Error('fsync failed')
  }
  await rejects(t, store.record({ member: a, phone: PHONE }, cbs), 'indisponivel', 'record')
  fs.renameSync = renameSync
  t.absent(store.available())
  throwsCode(t, () => store.verified(a), 'indisponivel', 'verified')
  throwsCode(t, () => store.live(a), 'indisponivel', 'live')
  throwsCode(t, () => store.since(), 'indisponivel', 'since')
  await rejects(t, store.end(a), 'indisponivel', 'end')
  t.is(await store.heal(), false)
  t.absent(store.available(), 'still unreadable: still unavailable')
  blind = false
  t.is(await store.heal(), false)
  t.ok(store.available(), 'heal read the file')
  t.ok(store.verified(a))
  t.is(store.since(), iso(T0))
})

test('record refuses a deleted recipient and writes nothing', async (t) => {
  const { store, file, dir, cbs, deleted } = setup(t)
  const a = memberKey()
  const b = memberKey()
  deleted.add(b)
  await rejects(t, store.record({ member: b, phone: PHONE }, cbs), 'conta-excluida', 'no file yet')
  t.alike(fs.readdirSync(dir), [], 'nothing created')
  await store.record({ member: a, phone: PHONE }, cbs)
  const snap = snapshot(file)
  await rejects(t, store.record({ member: b, phone: PHONE }, cbs), 'conta-excluida', 'holder untouched')
  unchanged(t, file, snap, 'nothing written')
  t.ok(store.verified(a), 'the unlinked holder is not superseded')
  t.absent(store.verified(b))
})

test('since is fixed by the first record only; release, end and sweep never start the file', async (t) => {
  const { store, file, dir, c, cbs, burnable } = setup(t)
  const a = memberKey()
  t.alike(await store.release(a), { rows: 0 })
  t.alike(await store.end(a), { changed: false })
  burnable.add(a)
  await store.sweep(cbs)
  t.alike(fs.readdirSync(dir), [], 'no file')
  t.is(store.since(), null)
  c.t = T0 + DAY
  await store.record({ member: a, phone: PHONE }, cbs)
  t.is(store.since(), iso(T0 + DAY))
  const snap = snapshot(file)
  t.alike(await store.release(memberKey()), { rows: 0 }, 'a member with no rows')
  unchanged(t, file, snap, 'release of a member with no rows writes nothing')
})

test('with blocked: a deleted member still blocked keeps its burn; unblock lifts it', async (t) => {
  const { store, file, c, cbs, burnable, deleted } = setup(t)
  const blocked = new Set()
  const withBlocked = { ...cbs, blocked: (m) => blocked.has(m) }
  const a = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  blocked.add(a)
  burnable.add(a)
  await store.sweep(withBlocked)
  t.is(store.counts().burned, 1)
  // Blocked with no report left and the account deleted: no longer burnable.
  burnable.delete(a)
  deleted.add(a)
  c.t = T0 + UNLINKED_TTL_MS + DAY
  const out = await store.sweep(withBlocked)
  t.is(out.unburned, 0)
  const row = readFile(file).rows[0]
  t.ok(row.burnedAt, 'deletion never lifts a burn')
  t.is(row.end, 'excluida')
  await rejects(t, store.record({ member: memberKey(), phone: PHONE }, cbs), 'telefone-em-uso', 'still held')

  blocked.delete(a)
  const back = await store.sweep(withBlocked)
  t.is(back.unburned, 1)
  t.is(store.counts().burned, 0)
  t.alike(await store.record({ member: memberKey(), phone: PHONE }, cbs), { changed: true }, 'unblock gives the number back')
})

test('with blocked: a burned live row outlives the unlinked TTL', async (t) => {
  const { store, file, c, cbs, burnable } = setup(t)
  const blocked = new Set()
  const withBlocked = { ...cbs, blocked: (m) => blocked.has(m) }
  const a = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  blocked.add(a)
  burnable.add(a)
  await store.sweep(withBlocked)
  burnable.delete(a)
  c.t = T0 + UNLINKED_TTL_MS + DAY
  await store.sweep(withBlocked)
  t.is(readFile(file).rows.length, 1, 'kept while burned')
})

test('with blocked: a release is kept while blocked, dropped once unblocked, and a new block burns again', async (t) => {
  const { store, file, c, cbs, burnable, deleted } = setup(t)
  const blocked = new Set()
  const withBlocked = { ...cbs, blocked: (m) => blocked.has(m) }
  const a = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  blocked.add(a)
  burnable.add(a)
  await store.sweep(withBlocked)
  c.t = T0 + 1000
  await store.release(a)
  burnable.delete(a)
  deleted.add(a)
  await store.sweep(withBlocked)
  t.alike(Object.keys(readFile(file).released), [a], 'kept while still blocked, though no longer burnable')
  t.is(store.counts().burned, 0)
  blocked.delete(a)
  const out = await store.sweep(withBlocked)
  t.is(out.released, 1)
  t.alike(readFile(file).released, {})
  blocked.add(a)
  burnable.add(a)
  const again = await store.sweep(withBlocked)
  t.is(again.burned, 1, 'a later block burns again')
})

test('blocked must be a function when given', async (t) => {
  const { store, cbs } = setup(t)
  await t.exception.all(store.sweep({ ...cbs, blocked: true }), TypeError)
})

test('a file that goes missing after this holder saw it fails closed until it is back', async (t) => {
  const { store, open, file, dir, cbs, burnable } = setup(t)
  const a = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  burnable.add(a)
  await store.sweep(cbs)
  const saved = fs.readFileSync(file)
  const opened = open()
  fs.unlinkSync(file)

  await rejects(t, store.record({ member: memberKey(), phone: PHONE_B }, cbs), 'indisponivel', 'record refused')
  t.alike(fs.readdirSync(dir), [], 'no new file started')
  t.absent(store.available())
  throwsCode(t, () => store.verified(a), 'indisponivel', 'no answer from a lost file')
  t.is(await store.heal(), false)
  t.absent(store.available(), 'heal does not adopt a missing file')

  t.is(await opened.heal(), false)
  t.absent(opened.available(), 'a holder that loaded the file at open fails too')
  await rejects(t, opened.sweep(cbs), 'indisponivel', 'sweep refused')
  t.alike(fs.readdirSync(dir), [])

  fs.writeFileSync(file, saved, { mode: 0o600 })
  t.is(await store.heal(), false)
  t.ok(store.available(), 'back once the file is restored')
  t.ok(store.verified(a))
  t.is(store.counts().burned, 1, 'the burn survived')
  t.is(await opened.heal(), false)
  t.ok(opened.available())
})

test('a passing read error recovers on heal; a wrong key or corrupt file fails every time', async (t) => {
  const { store, dir, file, c, cbs } = setup(t)
  const a = memberKey()
  await store.record({ member: a, phone: PHONE }, cbs)
  const { openSync } = fs
  let errno = 'EMFILE'
  t.teardown(() => { fs.openSync = openSync }, { force: true })
  fs.openSync = function (p, ...rest) {
    if (errno !== null && p === file) {
      const err = new Error('io')
      err.code = errno
      throw err
    }
    return openSync.call(fs, p, ...rest)
  }
  await rejects(t, store.end(a), 'indisponivel', 'read error during a mutation')
  t.absent(store.available())
  errno = 'EIO'
  t.is(await store.heal(), false)
  t.absent(store.available(), 'still failing')
  errno = null
  t.is(await store.heal(), false)
  t.ok(store.available(), 'heal cleared the read failure')
  t.ok(store.verified(a), 'the end never landed')

  const good = fs.readFileSync(file)
  fs.writeFileSync(file, '{')
  t.is(await store.heal(), false)
  t.absent(store.available(), 'a corrupt file fails')
  t.is(await store.heal(), false)
  t.absent(store.available(), 'every time')
  t.is(fs.readFileSync(file, 'utf8'), '{', 'never rewritten')
  fs.writeFileSync(file, good)
  await store.heal()
  t.ok(store.available(), 'a repaired file passes the check again')

  const wrong = openPhoneStore(dir, { key: nodeCrypto.randomBytes(32), now: c.now })
  const snap = snapshot(file)
  for (let i = 0; i < 2; i++) {
    t.is(await wrong.heal(), false)
    t.absent(wrong.available(), 'a wrong key fails every heal')
  }
  unchanged(t, file, snap, 'never rewritten')

  store.fail()
  await store.heal()
  t.absent(store.available(), 'fail() is never cleared by heal')
})

test('a refused mutation adopts the disk state it read', async (t) => {
  const { open, cbs, linked, deleted } = setup(t)
  const first = open()
  const second = open()
  const a = memberKey()
  const b = memberKey()
  linked.add(a)
  await first.record({ member: a, phone: PHONE }, cbs)
  t.absent(second.verified(a), 'the second holder has not read it yet')
  t.is(second.since(), null)
  await rejects(t, second.record({ member: b, phone: PHONE }, cbs), 'telefone-em-uso', 'refused')
  t.ok(second.verified(a), 'telefone-em-uso: disk adopted')
  t.alike(second.live(a), first.live(a))
  t.is(second.since(), iso(T0))

  const third = open()
  const d = memberKey()
  await first.record({ member: d, phone: PHONE_B }, cbs)
  deleted.add(b)
  await rejects(t, third.record({ member: b, phone: '+5531991234567' }, cbs), 'conta-excluida', 'refused')
  t.ok(third.verified(d), 'conta-excluida: disk adopted')
})
