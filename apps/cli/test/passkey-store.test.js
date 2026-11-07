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
  t.alike(again.keys(m), [{ ...k, addedAt: iso(T0) }])
  t.is(again.holds(m), true)

  for (let i = 1; i < MAX_KEYS; i++) await again.add({ member: m, ...key(), first: false })
  await t.exception(again.add({ member: m, ...key(), first: false }), /passkey-registrada/, 'at most MAX_KEYS')
  await t.exception.all(s.add({ member: 'zz', ...key() }), /member must be/)
  await t.exception.all(s.add({ member: m, ...key({ alg: -8 }) }), /invalid passkey/)
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
