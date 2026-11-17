'use strict'

// apps/cli/lib/account/passkey-store.js: the passkeys.json sidecar with each
// member's passkey public keys and a deletion waiting for its date. No
// network; the clock is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { openPasskeyStore, FILE, MAX_KEYS, TOMBSTONE_TTL_MS } = require('../lib/account/passkey-store')
const { MAX_PASSKEYS } = require('../lib/account/recovery-store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-11-06T12:00:00.000Z')
const DAY = 24 * 3600 * 1000

function hex32 () {
  return b4a.toString(crypto.randomBytes(32), 'hex')
}

function credId () {
  return b4a.toString(crypto.randomBytes(16), 'base64url')
}

function key (over = {}) {
  return { credentialId: credId(), alg: -7, spki: 'ab'.repeat(91), signCount: 0, ...over }
}

function clock (start = T0) {
  const c = { t: start, now: () => c.t }
  return c
}

function iso (ms) {
  return new Date(ms).toISOString()
}

test('passkey store: add, read back after reopen, first refuses a second key, same key is a no-op', async (t) => {
  const dir = tmpDir(t)
  const c = clock()
  const s = openPasskeyStore(dir, { now: c.now })
  const m = hex32()
  t.alike(s.keys(m), [])
  t.absent(fs.existsSync(path.join(dir, FILE)), 'opening creates nothing')
  const k = key()
  t.alike(await s.add({ member: m, ...k }), { changed: true })
  t.alike(await s.add({ member: m, ...k }), { changed: false }, 'same credential again')
  await t.exception(s.add({ member: m, ...k, spki: 'cd'.repeat(91) }), /passkey-registrada/, 'same id, another key')
  await t.exception(s.add({ member: m, ...key() }), /passkey-registrada/, 'first: a second key is refused')
  t.is((fs.statSync(path.join(dir, FILE)).mode & 0o777), 0o600)

  const again = openPasskeyStore(dir, { now: c.now })
  t.alike(again.keys(m), [{ ...k, addedAt: iso(T0), lookupId: null, entryAt: null }])
  t.is(again.holds(m), true)

  for (let i = 1; i < MAX_KEYS; i++) await again.add({ member: m, ...key(), first: false, lookupId: hex32(), entryAt: iso(T0), voucher: k.credentialId })
  await t.exception(again.add({ member: m, ...key(), first: false, lookupId: hex32(), entryAt: iso(T0), voucher: k.credentialId }), /limite-recuperacao/, 'at most MAX_KEYS')
  await t.exception.all(s.add({ member: 'zz', ...key() }), /member must be/)
  await t.exception.all(s.add({ member: m, ...key({ alg: -8 }) }), /invalid passkey/)
})

test('passkey store: MAX_KEYS is the sign-up passkey plus every extra passkey recovery entry', (t) => {
  t.is(MAX_KEYS, 1 + MAX_PASSKEYS)
})

test('passkey store: an extra key names its entry and a stored voucher; removeByLookup drops it', async (t) => {
  const dir = tmpDir(t)
  const c = clock()
  const s = openPasskeyStore(dir, { now: c.now })
  const m = hex32()
  const other = hex32()
  const first = key()
  const lookupId = hex32()
  const extra = key()
  await t.exception(s.add({ member: m, ...extra, first: false, lookupId, entryAt: iso(T0), voucher: first.credentialId }), /passkey-invalida/, 'no stored key to vouch')
  await s.add({ member: m, ...first })
  await t.exception(s.add({ member: m, ...extra, first: false, lookupId, entryAt: iso(T0), voucher: credId() }), /passkey-invalida/, 'the voucher is not stored')
  await t.exception.all(s.add({ member: m, ...extra, first: false, voucher: first.credentialId }), /invalid lookupId/, 'an extra key needs its entry')
  await t.exception.all(s.add({ member: m, ...extra, first: false, lookupId }), /invalid lookupId/, 'and its voucher')
  await t.exception.all(s.add({ member: m, ...extra, lookupId }), /invalid lookupId/, 'a first key names no entry')
  await t.exception.all(s.add({ member: m, ...extra, first: false, lookupId, voucher: first.credentialId }), /invalid lookupId/, 'an extra key names its entry\'s createdAt')
  await t.exception.all(s.add({ member: m, ...extra, entryAt: iso(T0) }), /invalid lookupId/, 'a first key has no entry date')
  t.alike(await s.add({ member: m, ...extra, first: false, lookupId, entryAt: iso(T0), voucher: first.credentialId }), { changed: true })
  t.alike(await s.add({ member: m, ...extra, first: false, lookupId, entryAt: iso(T0), voucher: first.credentialId }), { changed: false }, 'same credential again')
  await t.exception(s.add({ member: m, ...key(), first: false, lookupId, entryAt: iso(T0), voucher: first.credentialId }), /pedido-invalido/, 'one key per entry')

  const reopened = openPasskeyStore(dir, { now: c.now })
  t.alike(reopened.keys(m).map((k) => k.lookupId), [null, lookupId], 'the link survives a reopen')
  t.alike(reopened.keys(m).map((k) => k.entryAt), [null, iso(T0)], 'and the entry\'s date')
  const file = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
  t.is(file.v, 2, 'written as version 2')
  t.alike(file.members[m].keys.map((k) => k.lookupId), [null, lookupId])
  t.alike(file.members[m].keys.map((k) => k.entryAt), [null, iso(T0)])

  t.alike(await reopened.removeByLookup({ member: other, lookupId }), { changed: false }, 'another member\'s entry touches nothing')
  t.alike(await reopened.removeByLookup({ member: m, lookupId }), { changed: true })
  t.alike(await reopened.removeByLookup({ member: m, lookupId }), { changed: false })
  t.alike(reopened.keys(m).map((k) => k.credentialId), [first.credentialId], 'the sign-up key stays')
  await t.exception.all(reopened.removeByLookup({ member: m, lookupId: 'zz' }), /invalid lookupId/)
})

test('passkey store: a version 1 file still opens, its keys with lookupId null, and the next write is version 2', async (t) => {
  const dir = tmpDir(t)
  const m = hex32()
  const k = { ...key(), addedAt: iso(T0) }
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ v: 1, seq: 1, members: { [m]: { keys: [k], hold: null, gen: 1 } }, removed: {} }), { mode: 0o600 })
  const s = openPasskeyStore(dir, { now: clock().now })
  t.is(s.available(), true)
  t.alike(s.keys(m), [{ ...k, lookupId: null, entryAt: null }])
  await s.add({ member: m, ...key(), first: false, lookupId: hex32(), entryAt: iso(T0), voucher: k.credentialId })
  const file = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
  t.is(file.v, 2)
  t.is(file.members[m].keys[0].lookupId, null)

  const good = { v: 2, seq: 1, members: { [m]: { keys: [{ ...k, lookupId: null, entryAt: null }, { ...key(), addedAt: iso(T0), lookupId: 'ab'.repeat(32), entryAt: iso(T0) }], hold: null, gen: 1 } }, removed: {} }
  const gd = tmpDir(t)
  fs.writeFileSync(path.join(gd, FILE), JSON.stringify(good), { mode: 0o600 })
  t.alike(openPasskeyStore(gd).keys(m), good.members[m].keys, 'a version 2 file with entryAt opens as written')

  for (const bad of [
    { v: 1, seq: 1, members: { [m]: { keys: [{ ...k, lookupId: null }], hold: null, gen: 1 } }, removed: {} },
    { v: 2, seq: 1, members: { [m]: { keys: [k], hold: null, gen: 1 } }, removed: {} },
    { v: 2, seq: 1, members: { [m]: { keys: [{ ...k, lookupId: null }], hold: null, gen: 1 } }, removed: {} },
    { v: 2, seq: 1, members: { [m]: { keys: [{ ...k, lookupId: 'ab'.repeat(32) }], hold: null, gen: 1 } }, removed: {} },
    { v: 2, seq: 1, members: { [m]: { keys: [{ ...k, lookupId: null, entryAt: iso(T0) }], hold: null, gen: 1 } }, removed: {} },
    { v: 2, seq: 1, members: { [m]: { keys: [{ ...k, lookupId: 'ab'.repeat(32), entryAt: null }], hold: null, gen: 1 } }, removed: {} },
    { v: 2, seq: 1, members: { [m]: { keys: [{ ...k, lookupId: 'ab'.repeat(32), entryAt: '2026-11-06' }], hold: null, gen: 1 } }, removed: {} },
    { v: 2, seq: 1, members: { [m]: { keys: [{ ...k, lookupId: 'AB'.repeat(32), entryAt: iso(T0) }], hold: null, gen: 1 } }, removed: {} },
    { v: 2, seq: 1, members: { [m]: { keys: [{ ...k, lookupId: 'ab'.repeat(32), entryAt: iso(T0) }, { ...key(), addedAt: iso(T0), lookupId: 'ab'.repeat(32), entryAt: iso(T0) }], hold: null, gen: 1 } }, removed: {} },
    { v: 3, seq: 1, members: {}, removed: {} }
  ]) {
    const d = tmpDir(t)
    fs.writeFileSync(path.join(d, FILE), JSON.stringify(bad), { mode: 0o600 })
    t.is(openPasskeyStore(d).available(), false, 'refused: ' + JSON.stringify(bad).slice(0, 60))
  }
})

test('passkey store: only sign-up keys write version 1, the previous build\'s exact shape; a linked key writes version 2', async (t) => {
  const dir = tmpDir(t)
  const c = clock()
  const s = openPasskeyStore(dir, { now: c.now })
  const m = hex32()
  const first = key()
  await s.add({ member: m, ...first })
  await s.touch({ member: m, credentialId: first.credentialId, signCount: 3 })
  await s.schedule({ member: m, runAt: iso(T0 + DAY) })
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
  let file = read()
  t.is(file.v, 1)
  t.alike(Object.keys(file.members[m].keys[0]), ['credentialId', 'alg', 'spki', 'signCount', 'addedAt'], 'no lookupId in version 1')
  const lookupId = hex32()
  await s.add({ member: m, ...key(), first: false, lookupId, entryAt: iso(T0), voucher: first.credentialId })
  file = read()
  t.is(file.v, 2)
  t.alike(file.members[m].keys.map((k) => k.lookupId), [null, lookupId])
  await s.removeByLookup({ member: m, lookupId })
  t.is(read().v, 1, 'back to version 1 once no key is linked')
  t.is(openPasskeyStore(dir, { now: c.now }).keys(m).length, 1)
})

test('passkey store: touch keeps the higher counter only', async (t) => {
  const s = openPasskeyStore(tmpDir(t), { now: clock().now })
  const m = hex32()
  const k = key()
  await s.add({ member: m, ...k })
  t.alike(await s.touch({ member: m, credentialId: k.credentialId, signCount: 0 }), { changed: false })
  t.alike(await s.touch({ member: m, credentialId: k.credentialId, signCount: 7 }), { changed: true })
  t.alike(await s.touch({ member: m, credentialId: k.credentialId, signCount: 3 }), { changed: false })
  t.is(s.keys(m)[0].signCount, 7)
  t.alike(await s.touch({ member: m, credentialId: credId(), signCount: 9 }), { changed: false }, 'unknown credential')
})

test('passkey store: schedule keeps its date, due lists reached holds, cancel clears', async (t) => {
  const c = clock()
  const s = openPasskeyStore(tmpDir(t), { now: c.now })
  const a = hex32()
  const b = hex32()
  t.is(s.hold(a), null)
  t.alike(await s.schedule({ member: a, runAt: iso(T0 + 7 * DAY) }), { changed: true, at: iso(T0), runAt: iso(T0 + 7 * DAY) })
  c.t += DAY
  t.alike(await s.schedule({ member: a, runAt: iso(T0 + 30 * DAY) }), { changed: false, at: iso(T0), runAt: iso(T0 + 7 * DAY) }, 'asking again never moves the date')
  await s.schedule({ member: b, runAt: iso(T0 + 2 * DAY) })
  t.alike(s.due(T0 + DAY), [])
  t.alike(s.due(T0 + 2 * DAY), [b])
  t.alike(s.due(T0 + 8 * DAY), [b, a], 'oldest date first')
  t.alike(await s.cancel(a), { changed: true })
  t.alike(await s.cancel(a), { changed: false })
  t.is(s.hold(a), null)
  t.alike(s.due(T0 + 8 * DAY), [b])
  await t.exception.all(s.schedule({ member: a, runAt: 'amanhã' }), /runAt/)
})

test('passkey store: a stale copy never brings back a cancelled hold or forgotten keys', async (t) => {
  const dir = tmpDir(t)
  const c = clock()
  const s = openPasskeyStore(dir, { now: c.now })
  const m = hex32()
  const gone = hex32()
  await s.add({ member: gone, ...key() })
  await s.schedule({ member: m, runAt: iso(T0 + 7 * DAY) })
  const stale = fs.readFileSync(path.join(dir, FILE))
  await s.cancel(m)
  await s.forget(gone)
  // A holder that lost the lock renames its older copy over the file.
  fs.writeFileSync(path.join(dir, FILE), stale, { mode: 0o600 })
  t.is(await s.heal(), true, 'heal writes the merge back')
  const reopened = openPasskeyStore(dir, { now: c.now })
  t.is(reopened.hold(m), null, 'the cancel wins')
  t.alike(reopened.keys(gone), [], 'the tombstone wins')
  t.is(reopened.holds(gone), false)

  // A write by this holder also merges first.
  fs.writeFileSync(path.join(dir, FILE), stale, { mode: 0o600 })
  await s.add({ member: hex32(), ...key() })
  t.is(openPasskeyStore(dir, { now: c.now }).hold(m), null)
})

test('passkey store: tombstones go after the TTL', async (t) => {
  const dir = tmpDir(t)
  const c = clock()
  const s = openPasskeyStore(dir, { now: c.now })
  const m = hex32()
  await s.add({ member: m, ...key() })
  t.alike(await s.forget(m), { changed: true })
  t.alike(await s.forget(m), { changed: false })
  c.t += TOMBSTONE_TTL_MS + 1
  await s.add({ member: hex32(), ...key() })
  const file = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
  t.alike(file.removed, {})
})

test('passkey store: a file it would not write makes it unavailable; readOnly never writes', async (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ v: 1, seq: 0, members: {}, removed: {}, extra: 1 }))
  const bad = openPasskeyStore(dir)
  t.is(bad.available(), false)
  t.exception(() => bad.keys(hex32()), /indisponivel/)
  await t.exception(bad.add({ member: hex32(), ...key() }), /indisponivel/)

  const dir2 = tmpDir(t)
  const ro = openPasskeyStore(dir2, { readOnly: true })
  await t.exception(ro.schedule({ member: hex32(), runAt: iso(T0) }), /indisponivel/)
  t.absent(fs.existsSync(path.join(dir2, FILE)))

  const dir3 = tmpDir(t)
  const guarded = openPasskeyStore(dir3, { guard: () => false })
  await t.exception(guarded.add({ member: hex32(), ...key() }), /indisponivel/)
  t.is(guarded.available(), true, 'a lost guard refuses that request only')
})
