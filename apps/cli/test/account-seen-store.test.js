'use strict'

// apps/cli/lib/account/seen-store.js: one raw, fixed-length ciphertext file
// per member under <dataDir>/seen, replaced by compare-and-swap on its hash.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { openSeenStore, DIR, MAX_MEMBERS } = require('../lib/account/seen-store')
const { blobHash, HASH_NONE } = require('@varanda/core/lib/seen-proof')
const { SEEN_BLOB_BYTES } = require('@varanda/core/lib/seen-blob')
const { tmpDir } = require('./helpers/net')

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function blob (fill = 1) {
  return Buffer.alloc(SEEN_BLOB_BYTES, fill)
}

function setup (t, opts = {}) {
  const dataDir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dataDir, { mode: 0o700 })
  const logs = []
  const open = (more = {}) => openSeenStore(dataDir, { log: (e) => logs.push(e), ...opts, ...more })
  return { dataDir, dir: path.join(dataDir, DIR), logs, open, store: open() }
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

test('put creates the file, get reads it back, the dir is 0700 and the file 0600', async (t) => {
  const { store, dir } = setup(t)
  const m = memberKey()
  t.is(store.get(m), null, 'nothing yet')
  t.is(fs.existsSync(dir), false, 'opening creates nothing')
  const b = blob(7)
  t.alike(await store.put({ member: m, blob: b, expectedHash: HASH_NONE }), { ok: true, hash: blobHash(b) })
  t.is(fs.statSync(dir).mode & 0o777, 0o700, 'dir 0700')
  const file = path.join(dir, m)
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'file 0600')
  t.is(fs.statSync(file).size, SEEN_BLOB_BYTES, 'exactly the ciphertext')
  t.alike(fs.readFileSync(file), b, 'raw bytes, nothing else')
  const got = store.get(m)
  t.is(got.hash, blobHash(b))
  t.alike(got.blob, b)
  t.is(store.count(), 1)
  t.alike(fs.readdirSync(dir), [m], 'no temp file left behind')
})

test('a replacement needs the current hash', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const a = blob(1)
  const b = blob(2)
  await store.put({ member: m, blob: a, expectedHash: HASH_NONE })
  t.alike(await store.put({ member: m, blob: b, expectedHash: blobHash(a) }), { ok: true, hash: blobHash(b) })
  t.alike(store.get(m).blob, b)
})

test('a CAS conflict answers the current hash and blob without writing', async (t) => {
  const { store, dir } = setup(t)
  const m = memberKey()
  const a = blob(1)
  await store.put({ member: m, blob: a, expectedHash: HASH_NONE })
  const file = path.join(dir, m)
  const ino = fs.statSync(file).ino
  const res = await store.put({ member: m, blob: blob(3), expectedHash: HASH_NONE })
  t.is(res.ok, false)
  t.is(res.conflict, true)
  t.is(res.hash, blobHash(a))
  t.alike(res.blob, a)
  const stale = await store.put({ member: m, blob: blob(3), expectedHash: blobHash(blob(9)) })
  t.is(stale.conflict, true, 'a wrong hash conflicts too')
  t.is(fs.statSync(file).ino, ino, 'file never replaced')
  t.alike(fs.readFileSync(file), a)

  const other = memberKey()
  const none = await store.put({ member: other, blob: blob(4), expectedHash: blobHash(a) })
  t.alike(none, { ok: false, conflict: true, hash: HASH_NONE, blob: null }, 'absent answers HASH_NONE')
  t.is(fs.existsSync(path.join(dir, other)), false, 'expectedHash other than HASH_NONE never creates')
})

test('two concurrent puts with the same expectedHash: exactly one wins', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const results = await Promise.all([
    store.put({ member: m, blob: blob(1), expectedHash: HASH_NONE }),
    store.put({ member: m, blob: blob(2), expectedHash: HASH_NONE })
  ])
  t.is(results.filter((r) => r.ok).length, 1, 'one wins')
  t.is(results.filter((r) => r.conflict).length, 1, 'one conflicts')
  const winner = results.find((r) => r.ok)
  const loser = results.find((r) => r.conflict)
  t.is(loser.hash, winner.hash, 'the loser learns the winner')
  t.is(store.get(m).hash, winner.hash)
})

test('a wrong-length file makes only that member unavailable and is never replaced', async (t) => {
  const { store, dir, logs } = setup(t)
  const bad = memberKey()
  const good = memberKey()
  fs.mkdirSync(dir, { mode: 0o700 })
  const file = path.join(dir, bad)
  fs.writeFileSync(file, Buffer.alloc(SEEN_BLOB_BYTES + 1, 5), { mode: 0o600 })
  t.exception(() => store.get(bad), /indisponivel/, 'get refused')
  await rejects(t, store.put({ member: bad, blob: blob(1), expectedHash: HASH_NONE }), 'indisponivel', 'put refused')
  await rejects(t, store.forget(bad, HASH_NONE), 'indisponivel', 'forget refused')
  t.is(fs.statSync(file).size, SEEN_BLOB_BYTES + 1, 'left as it was')
  t.alike((await store.put({ member: good, blob: blob(2), expectedHash: HASH_NONE })).ok, true, 'other members work')
  t.is(store.available(), true)
  t.ok(logs.some((e) => e.reason === 'arquivo-invalido'))
})

test('a non-regular member entry is unavailable and untouched', async (t) => {
  const { store, dir } = setup(t)
  const m = memberKey()
  fs.mkdirSync(path.join(dir, m), { recursive: true })
  t.exception(() => store.get(m), /indisponivel/)
  await rejects(t, store.put({ member: m, blob: blob(1), expectedHash: HASH_NONE }), 'indisponivel', 'directory refused')
  t.ok(fs.statSync(path.join(dir, m)).isDirectory())

  const target = path.join(path.dirname(dir), 'target')
  fs.writeFileSync(target, blob(1))
  const linked = memberKey()
  fs.symlinkSync(target, path.join(dir, linked))
  t.exception(() => store.get(linked), /indisponivel/, 'symlinked member refused')
  await rejects(t, store.put({ member: linked, blob: blob(2), expectedHash: blobHash(blob(1)) }), 'indisponivel', 'never written through a symlink')
  t.alike(fs.readFileSync(target), blob(1))
})

test('a symlinked data dir or seen dir is refused', async (t) => {
  const base = tmpDir(t)
  const real = path.join(base, 'real')
  fs.mkdirSync(real)
  const link = path.join(base, 'link')
  fs.symlinkSync(real, link)
  t.exception(() => openSeenStore(link), /link simb/, 'data dir symlink refused')

  const { store, dataDir, dir, logs } = setup(t)
  const elsewhere = path.join(base, 'elsewhere')
  fs.mkdirSync(elsewhere)
  fs.symlinkSync(elsewhere, dir)
  const m = memberKey()
  await rejects(t, store.put({ member: m, blob: blob(1), expectedHash: HASH_NONE }), 'indisponivel', 'seen dir symlink refused')
  t.is(store.available(), false)
  t.alike(fs.readdirSync(elsewhere), [], 'nothing written through it')
  t.is(await store.heal(), false, 'still bad')
  t.is(await store.heal(), false, 'still bad')
  t.is(logs.filter((e) => e.reason === 'diretorio-invalido').length, 1, 'a bad directory is logged once, not on every heal')
  fs.unlinkSync(dir)
  t.is(await store.heal(), true, 'heal re-checks the directory')
  t.is(await store.heal(), false, 'already healthy: nothing repaired, so the heal loop logs nothing')
  t.is((await store.put({ member: m, blob: blob(1), expectedHash: HASH_NONE })).ok, true)
  t.ok(fs.lstatSync(path.join(dataDir, DIR)).isDirectory())

  const late = setup(t)
  fs.symlinkSync(elsewhere, late.dir)
  const reopened = late.open()
  t.is(reopened.available(), false, 'a symlinked seen dir at open marks it unavailable')
})

test('readOnly never writes', async (t) => {
  const { open, dir } = setup(t)
  const m = memberKey()
  const writer = open()
  await writer.put({ member: m, blob: blob(1), expectedHash: HASH_NONE })
  const ro = open({ readOnly: true })
  t.alike(ro.get(m).blob, blob(1), 'reads work')
  await rejects(t, ro.put({ member: m, blob: blob(2), expectedHash: blobHash(blob(1)) }), 'indisponivel', 'put refused')
  await rejects(t, ro.forget(m, blobHash(blob(1))), 'indisponivel', 'forget refused')
  t.alike(fs.readFileSync(path.join(dir, m)), blob(1))

  const fresh = setup(t, { readOnly: true })
  await rejects(t, fresh.store.put({ member: m, blob: blob(1), expectedHash: HASH_NONE }), 'indisponivel', 'no first write')
  t.is(fs.existsSync(fresh.dir), false, 'no directory created')
})

test('guard false refuses that call only', async (t) => {
  let allow = false
  const { store, dir } = setup(t, { guard: () => allow })
  const m = memberKey()
  await rejects(t, store.put({ member: m, blob: blob(1), expectedHash: HASH_NONE }), 'indisponivel', 'refused')
  t.is(fs.existsSync(dir), false, 'nothing written')
  t.is(store.available(), true, 'store still usable')
  allow = true
  t.is((await store.put({ member: m, blob: blob(1), expectedHash: HASH_NONE })).ok, true, 'next call works')

  let calls = 0
  const after = setup(t, { guard: () => ++calls !== 2 })
  await rejects(t, after.store.put({ member: m, blob: blob(2), expectedHash: HASH_NONE }), 'indisponivel', 'guard lost after the rename: not acknowledged')
  t.is(after.store.available(), true)
})

test('fail() makes the store unavailable for good', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  store.fail()
  t.is(store.available(), false)
  t.exception(() => store.get(m), /indisponivel/)
  await rejects(t, store.put({ member: m, blob: blob(1), expectedHash: HASH_NONE }), 'indisponivel', 'put refused')
  t.is(await store.heal(), false)
})

test('forget unlinks the name first, then zeroes the inode through the open fd', async (t) => {
  const { store, dir } = setup(t)
  const m = memberKey()
  const b = blob(9)
  await store.put({ member: m, blob: b, expectedHash: HASH_NONE })
  const file = path.join(dir, m)

  t.alike(await store.forget(m, blobHash(blob(1))), { ok: false, conflict: true, hash: blobHash(b) }, 'CAS on forget')
  t.ok(fs.existsSync(file), 'kept on conflict')

  const events = []
  const writeSync = fs.writeSync
  const unlinkSync = fs.unlinkSync
  fs.writeSync = function (fd, buf, ...rest) {
    events.push(buf.every((x) => x === 0) ? 'zeros:' + buf.length : 'data')
    return writeSync.call(fs, fd, buf, ...rest)
  }
  fs.unlinkSync = function (p) {
    events.push('unlink:' + path.basename(p))
    return unlinkSync.call(fs, p)
  }
  let res
  try {
    res = await store.forget(m, blobHash(b))
  } finally {
    fs.writeSync = writeSync
    fs.unlinkSync = unlinkSync
  }
  t.alike(res, { ok: true, changed: true })
  // A crash after the unlink leaves no file; zeroing first could leave a
  // zeroed blob that is served and blocks both a create and a delete.
  t.alike(events, ['unlink:' + m, 'zeros:' + SEEN_BLOB_BYTES], 'the name goes before the zeros')
  t.is(fs.existsSync(file), false)
  t.is(store.get(m), null)
  t.alike(await store.forget(m, HASH_NONE), { ok: true, changed: false }, 'absent is a no-op')
})

test('a hard-linked member file is never zeroed or replaced', async (t) => {
  const { store, dir } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const bytes = blob(4)
  await store.put({ member: a, blob: bytes, expectedHash: HASH_NONE })
  fs.linkSync(path.join(dir, a), path.join(dir, b))
  await rejects(t, store.forget(b, blobHash(bytes)), 'indisponivel', 'forget through a hard link refused')
  await rejects(t, store.put({ member: b, blob: blob(5), expectedHash: blobHash(bytes) }), 'indisponivel', 'put through a hard link refused')
  t.alike(fs.readFileSync(path.join(dir, a)), b4a.from(bytes), 'the linked inode keeps its bytes')
})

test('the member cap refuses a new member but still replaces an existing one', async (t) => {
  t.is(MAX_MEMBERS, 100000)
  const { store } = setup(t, { maxMembers: 2 })
  const a = memberKey()
  const b = memberKey()
  await store.put({ member: a, blob: blob(1), expectedHash: HASH_NONE })
  await store.put({ member: b, blob: blob(1), expectedHash: HASH_NONE })
  await rejects(t, store.put({ member: memberKey(), blob: blob(1), expectedHash: HASH_NONE }), 'limite', 'new member refused')
  t.is((await store.put({ member: a, blob: blob(2), expectedHash: blobHash(blob(1)) })).ok, true, 'existing replaced')
  t.is(store.count(), 2)
})

test('bad arguments throw TypeError before any path is built', async (t) => {
  const { store } = setup(t)
  t.exception.all(() => store.get('../etc'), TypeError)
  t.exception.all(() => store.get('A'.repeat(64)), TypeError)
  const m = memberKey()
  for (const args of [
    { member: '..', blob: blob(1), expectedHash: HASH_NONE },
    { member: m, blob: Buffer.alloc(10), expectedHash: HASH_NONE },
    { member: m, blob: blob(1), expectedHash: 'x' }
  ]) {
    try {
      await store.put(args)
      t.fail('resolved')
    } catch (err) {
      t.ok(err instanceof TypeError)
    }
  }
})

test('the log carries no member, hash or bytes', async (t) => {
  let allow = true
  const { store, dir, logs } = setup(t, { maxMembers: 1, guard: () => allow })
  const m = memberKey()
  const b = blob(1)
  await store.put({ member: m, blob: b, expectedHash: HASH_NONE })
  await rejects(t, store.put({ member: memberKey(), blob: b, expectedHash: HASH_NONE }), 'limite', 'cap')
  const bad = memberKey()
  fs.writeFileSync(path.join(dir, bad), Buffer.alloc(3))
  t.exception(() => store.get(bad), /indisponivel/)
  allow = false
  await rejects(t, store.forget(m, blobHash(b)), 'indisponivel', 'guard')
  t.ok(logs.length >= 3, 'something was logged')
  const text = JSON.stringify(logs)
  for (const e of logs) {
    t.alike(Object.keys(e).sort(), ['event', 'reason'])
    t.is(e.event, 'seen')
  }
  t.absent(text.includes(m), 'no member')
  t.absent(text.includes(bad), 'no bad member')
  t.absent(text.includes(blobHash(b)), 'no hash')
})
