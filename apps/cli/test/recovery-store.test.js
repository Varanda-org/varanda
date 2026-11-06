'use strict'

// apps/cli/lib/account/recovery-store.js: the recovery.json sidecar where
// the account service keeps the wrapped roots a member registered for extra
// passkeys and a recovery code. No network; the clock is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  openRecoveryStore,
  isBlob,
  FILE,
  MAX_PASSKEYS,
  TOMBSTONE_MAX_PER_MEMBER,
  TOMBSTONE_TTL_MS,
  STALE_WINDOW_MS
} = require('../lib/account/recovery-store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-11-06T12:00:00.000Z')
const DAY = 24 * 3600 * 1000

function hex32 () {
  return b4a.toString(crypto.randomBytes(32), 'hex')
}

function blob (kind = 'passkey') {
  return {
    v: 1,
    kind,
    nonce: b4a.toString(crypto.randomBytes(24), 'hex'),
    ciphertext: b4a.toString(crypto.randomBytes(82), 'hex')
  }
}

function clock (start = T0) {
  const c = { t: start, now: () => c.t }
  return c
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = clock()
  const open = (more = {}) => openRecoveryStore(dir, { now: c.now, ...opts, ...more })
  return { dir, file: path.join(dir, FILE), c, open, store: open() }
}

function req (member, kind = 'passkey', lookupId = hex32(), b = blob(kind)) {
  return { member, kind, lookupId, blob: b }
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

test('isBlob accepts only the exact wrapped-root shape', (t) => {
  t.ok(isBlob(blob('passkey')))
  t.ok(isBlob(blob('code')))
  const b = blob()
  t.absent(isBlob({ ...b, v: 2 }))
  t.absent(isBlob({ ...b, kind: 'other' }))
  t.absent(isBlob({ ...b, nonce: b.nonce.slice(2) }))
  t.absent(isBlob({ ...b, ciphertext: b.ciphertext.toUpperCase() }))
  t.absent(isBlob({ ...b, extra: 1 }))
  t.absent(isBlob(null))
})

test('an empty data dir writes nothing until the first put; put reloads from disk', async (t) => {
  const { store, file, dir, open } = setup(t)
  t.ok(store.available())
  t.alike(fs.readdirSync(dir), [])
  const m = hex32()
  const r = req(m)
  const out = await store.put(r)
  t.alike(out, { changed: true, createdAt: new Date(T0).toISOString() })
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600')
  const disk = readFile(file)
  t.alike(disk.entries[r.lookupId], { member: m, kind: 'passkey', nonce: r.blob.nonce, ciphertext: r.blob.ciphertext, createdAt: new Date(T0).toISOString(), gen: 1 })
  t.alike(disk.removed, {})
  t.is(disk.seq, 1, 'the store-level counter is persisted')
  const again = open()
  t.alike(again.fetch(r.lookupId), { member: m, kind: 'passkey', blob: r.blob })
  t.alike(again.list(m), [{ lookupId: r.lookupId, kind: 'passkey', createdAt: new Date(T0).toISOString() }])
  t.is(again.fetch(hex32()), null)
})

test('a data dir with only directory.* files opens fine and leaves them alone', async (t) => {
  const { dir, open } = setup(t)
  const names = ['directory.json', 'directory.journal.000001', 'directory.hwm']
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'x')
  const store = open()
  t.ok(store.available())
  await store.put(req(hex32()))
  for (const n of names) t.is(fs.readFileSync(path.join(dir, n), 'utf8'), 'x', n + ' untouched')
  t.alike(fs.readdirSync(dir).sort(), [...names, FILE].sort())
})

test('same member same id is idempotent; another member is refused', async (t) => {
  const { store, file, c } = setup(t)
  const a = hex32()
  const b = hex32()
  const r = req(a)
  await store.put(r)
  const before = fs.readFileSync(file, 'utf8')
  c.t += 1000
  t.alike(await store.put({ ...r, blob: blob() }), { changed: false, createdAt: new Date(T0).toISOString() })
  t.is(fs.readFileSync(file, 'utf8'), before, 'repeat not rewritten')
  await rejects(t, store.put({ ...r, member: b }), 'pedido-invalido', 'put of another member\'s id')
  await rejects(t, store.remove({ member: b, lookupId: r.lookupId }), 'pedido-invalido', 'remove of another member\'s id')
  await rejects(t, store.put({ ...r, kind: 'code', blob: blob('code') }), 'pedido-invalido', 'same id, other kind')
  await rejects(t, store.put({ ...req(a), blob: blob('code') }), 'pedido-invalido', 'blob kind differs from kind')
  t.is(store.fetch(r.lookupId).member, a)
})

test('passkey cap counts live rows only', async (t) => {
  const { store } = setup(t)
  const m = hex32()
  const ids = []
  for (let i = 0; i < MAX_PASSKEYS; i++) {
    const r = req(m)
    ids.push(r.lookupId)
    await store.put(r)
  }
  await rejects(t, store.put(req(m)), 'limite-recuperacao', 'fifth passkey refused')
  t.is((await store.put(req(m, 'code'))).changed, true, 'a code row is still allowed')
  t.is((await store.put(req(hex32()))).changed, true, 'another member unaffected')
  t.alike(await store.remove({ member: m, lookupId: ids[0] }), { changed: true })
  t.is((await store.put(req(m))).changed, true, 'a tombstone does not count')
  t.is(store.list(m).filter((r) => r.kind === 'passkey').length, MAX_PASSKEYS)
})

test('a new code replaces the previous code row', async (t) => {
  const { store, file, c } = setup(t)
  const m = hex32()
  const first = req(m, 'code')
  await store.put(first)
  c.t += 1000
  const second = req(m, 'code')
  await store.put(second)
  t.is(store.fetch(first.lookupId), null, 'old code opens nothing')
  t.is(store.fetch(second.lookupId).kind, 'code')
  t.alike(store.list(m).map((r) => r.lookupId), [second.lookupId])
  const disk = readFile(file)
  t.ok(disk.removed[first.lookupId], 'old id tombstoned')
  t.is(disk.removed[first.lookupId].member, m)
})

test('list hides nonce and ciphertext, oldest first', async (t) => {
  const { store, c } = setup(t)
  const m = hex32()
  const a = req(m)
  const b = req(m, 'code')
  await store.put(a)
  c.t += 1000
  await store.put(b)
  t.alike(store.list(m), [
    { lookupId: a.lookupId, kind: 'passkey', createdAt: new Date(T0).toISOString() },
    { lookupId: b.lookupId, kind: 'code', createdAt: new Date(T0 + 1000).toISOString() }
  ])
  t.alike(store.list(hex32()), [])
})

test('remove is idempotent and survives a heal against a stale file copy', async (t) => {
  const { store, file, c } = setup(t)
  const m = hex32()
  const r = req(m)
  await store.put(r)
  const stale = fs.readFileSync(file, 'utf8')
  c.t += 1000
  t.alike(await store.remove({ member: m, lookupId: r.lookupId }), { changed: true })
  t.alike(await store.remove({ member: m, lookupId: r.lookupId }), { changed: false })
  t.alike(await store.remove({ member: m, lookupId: hex32() }), { changed: false })
  // A stalled writer's rename puts the older copy back.
  fs.writeFileSync(file, stale)
  t.is(await store.heal(), true, 'heal rewrites')
  t.is(store.fetch(r.lookupId), null, 'not resurrected in memory')
  const disk = readFile(file)
  t.absent(disk.entries[r.lookupId], 'not resurrected on disk')
  t.is(disk.removed[r.lookupId].gen, 2)
  t.is(await store.heal(), false, 'nothing more to heal')
})

test('stale writer vs remove vs re-put: the higher generation wins', async (t) => {
  const { store, file, c, open } = setup(t)
  const m = hex32()
  const r = req(m)
  await store.put(r)
  const genOne = fs.readFileSync(file, 'utf8')
  // A second holder that opened before the remove still has the row.
  const other = open()
  c.t += 1000
  await store.remove({ member: m, lookupId: r.lookupId })
  const tomb = fs.readFileSync(file, 'utf8')
  // That holder's put of another row re-reads, sees the tombstone (gen 2)
  // and keeps it over its own gen 1 row.
  await other.put(req(m))
  t.is(other.fetch(r.lookupId), null, 'the stale holder adopts the tombstone')
  t.ok(readFile(file).removed[r.lookupId])
  // A re-put of the same id beats the tombstone. Gens come from one
  // store-wide counter: put 1, remove 2, the other holder's put 3, re-put 4.
  c.t += 1000
  t.is((await store.put(r)).changed, true)
  t.is(readFile(file).entries[r.lookupId].gen, 4)
  // Older copies (the gen 1 row, the gen 2 tombstone) both lose to it.
  fs.writeFileSync(file, tomb)
  await store.heal()
  t.is(readFile(file).entries[r.lookupId].gen, 4, 'tombstone copy loses to the re-put')
  fs.writeFileSync(file, genOne)
  await store.heal()
  t.is(readFile(file).entries[r.lookupId].gen, 4, 'row copy loses to the re-put')
  t.ok(store.fetch(r.lookupId))
})

test('tombstones older than the TTL are pruned; at most the cap per member stay', async (t) => {
  const { store, file, c } = setup(t)
  const m = hex32()
  const r = req(m)
  await store.put(r)
  await store.remove({ member: m, lookupId: r.lookupId })
  t.ok(readFile(file).removed[r.lookupId])
  c.t += TOMBSTONE_TTL_MS + DAY
  await store.put(req(m))
  t.absent(readFile(file).removed[r.lookupId], 'expired tombstone pruned')

  const n = TOMBSTONE_MAX_PER_MEMBER + 3
  const removed = []
  for (let i = 0; i < n; i++) {
    const x = req(m, 'code')
    c.t += STALE_WINDOW_MS + 1000
    await store.put(x)
    removed.push(x.lookupId)
  }
  const disk = readFile(file)
  const tombs = Object.keys(disk.removed).filter((id) => disk.removed[id].member === m)
  t.is(tombs.length, TOMBSTONE_MAX_PER_MEMBER, 'per-member tombstone cap')
  t.absent(disk.removed[removed[0]], 'oldest tombstone dropped')
  t.ok(disk.removed[removed[n - 2]], 'newest tombstone kept')
})

test('a malformed file is never rewritten and every method answers indisponivel', async (t) => {
  const m = hex32()
  const id = hex32()
  const good = { member: m, kind: 'passkey', nonce: '0'.repeat(48), ciphertext: '0'.repeat(164), createdAt: new Date(T0).toISOString(), gen: 1 }
  const tomb = { member: m, removedAt: new Date(T0).toISOString(), gen: 2 }
  const cases = [
    'not json',
    JSON.stringify({ v: 2, seq: 9, entries: {}, removed: {} }),
    JSON.stringify({ v: 1, seq: 9, entries: {} }),
    JSON.stringify({ v: 1, seq: 9, entries: {}, removed: {}, extra: 1 }),
    JSON.stringify({ v: 1, seq: 9, entries: { [id.toUpperCase()]: good }, removed: {} }),
    JSON.stringify({ v: 1, seq: 9, entries: { [id]: { ...good, kind: 'x' } }, removed: {} }),
    JSON.stringify({ v: 1, seq: 9, entries: { [id]: { ...good, gen: 0 } }, removed: {} }),
    JSON.stringify({ v: 1, seq: 9, entries: { [id]: { ...good, nonce: 'ab' } }, removed: {} }),
    JSON.stringify({ v: 1, seq: 9, entries: { [id]: { ...good, email: 'a@b.c' } }, removed: {} }),
    JSON.stringify({ v: 1, seq: 9, entries: {}, removed: { [id]: { ...tomb, removedAt: '2026-11-06' } } }),
    JSON.stringify({ v: 1, seq: 9, entries: { [id]: good }, removed: { [id]: tomb } })
  ]
  for (const bytes of cases) {
    const { dir, file, open } = setup(t)
    fs.writeFileSync(file, bytes)
    const store = open()
    t.absent(store.available(), 'unavailable: ' + bytes.slice(0, 40))
    t.exception(() => store.list(m))
    t.exception(() => store.fetch(id))
    await rejects(t, store.put(req(m)), 'indisponivel', 'put refused')
    await rejects(t, store.remove({ member: m, lookupId: id }), 'indisponivel', 'remove refused')
    t.is(await store.heal(), false)
    t.is(fs.readFileSync(file, 'utf8'), bytes, 'bytes untouched')
    t.alike(fs.readdirSync(dir), [FILE])
  }
})

test('a file replaced by a malformed one after open is never rewritten', async (t) => {
  const { store, file } = setup(t)
  const m = hex32()
  await store.put(req(m))
  fs.writeFileSync(file, '{"v":1}')
  await rejects(t, store.put(req(m)), 'indisponivel', 'put refused')
  t.absent(store.available())
  t.is(fs.readFileSync(file, 'utf8'), '{"v":1}')
})

test('readOnly never writes', async (t) => {
  const { dir, file, open, store } = setup(t)
  const m = hex32()
  const r = req(m)
  await store.put(r)
  const before = fs.readFileSync(file, 'utf8')
  const ro = open({ readOnly: true })
  t.ok(ro.fetch(r.lookupId))
  await rejects(t, ro.put(req(m)), 'indisponivel', 'readOnly refuses put')
  await rejects(t, ro.remove({ member: m, lookupId: r.lookupId }), 'indisponivel', 'readOnly refuses remove')
  t.is(await ro.heal(), false)
  t.is(fs.readFileSync(file, 'utf8'), before)

  const empty = path.join(tmpDir(t), 'empty')
  fs.mkdirSync(empty)
  const ro2 = openRecoveryStore(empty, { readOnly: true })
  await rejects(t, ro2.put(req(m)), 'indisponivel', 'readOnly on an empty dir')
  t.alike(fs.readdirSync(empty), [])
  t.ok(fs.existsSync(dir))
})

test('guard() false refuses that request only', async (t) => {
  let ok = true
  const { store, file } = setup(t, { guard: () => ok })
  const m = hex32()
  await store.put(req(m))
  const before = fs.readFileSync(file, 'utf8')
  ok = false
  await rejects(t, store.put(req(m)), 'indisponivel', 'guard refused')
  t.is(fs.readFileSync(file, 'utf8'), before)
  t.ok(store.available())
  ok = true
  t.is((await store.put(req(m))).changed, true)
})

test('guard() false after the write does not acknowledge and heal rewrites', async (t) => {
  let calls = 0
  let refuseAt = -1
  const { store, file, open } = setup(t, { guard: () => ++calls !== refuseAt })
  const m = hex32()
  const r = req(m)
  refuseAt = 2 // before = 1, after = 2
  await rejects(t, store.put(r), 'indisponivel', 'refused after the write')
  t.ok(store.available())
  t.ok(fs.existsSync(file), 'the file may hold the unacknowledged write')
  t.is(await store.heal(), true, 'dirty store rewrites on heal')
  t.ok(open().fetch(r.lookupId), 'merge kept the row the file held')
})

test('fail() refuses later requests', async (t) => {
  const { store } = setup(t)
  store.fail()
  t.absent(store.available())
  await rejects(t, store.put(req(hex32())), 'indisponivel', 'after fail()')
})

test('bad argument shapes throw TypeError and errors never carry ids', async (t) => {
  const { store, file } = setup(t)
  const m = hex32()
  const bad = [
    req(m.toUpperCase()),
    req('ab'),
    { ...req(m), kind: 'other' },
    { ...req(m), lookupId: 'xy' },
    { ...req(m), blob: { ...blob(), v: 2 } }
  ]
  for (const r of bad) {
    try {
      await store.put(r)
      t.fail('accepted')
    } catch (err) {
      t.ok(err instanceof TypeError)
      t.absent(err.message.includes(m), 'no member in the message')
    }
  }
  t.exception.all(() => store.list('nope'), TypeError)
  t.exception.all(() => store.fetch('nope'), TypeError)
  t.absent(fs.existsSync(file))
  const r = req(m)
  await store.put(r)
  try {
    await store.put({ ...r, member: hex32() })
  } catch (err) {
    t.is(err.message, 'pedido-invalido')
    t.absent(err.message.includes(r.lookupId))
  }
})

test('concurrent puts serialize', async (t) => {
  const { store, open } = setup(t)
  const m = hex32()
  const reqs = Array.from({ length: 6 }, () => req(m))
  const results = await Promise.allSettled(reqs.map((r) => store.put(r)))
  t.is(results.filter((x) => x.status === 'fulfilled').length, MAX_PASSKEYS)
  t.is(results.filter((x) => x.status === 'rejected' && x.reason.code === 'limite-recuperacao').length, 2)
  t.is(open().list(m).length, MAX_PASSKEYS)
})

test('a symlinked data dir is refused', (t) => {
  const root = tmpDir(t)
  const real = path.join(root, 'real')
  fs.mkdirSync(real)
  const link = path.join(root, 'link')
  fs.symlinkSync(real, link)
  t.exception(() => openRecoveryStore(link))
})

test('reads after a write refused past the rename show the file, never stale memory', async (t) => {
  let calls = 0
  let refuseAt = -1
  const { store, file } = setup(t, { guard: () => ++calls !== refuseAt })
  const m = hex32()
  const kept = req(m)
  await store.put(kept)
  const r = req(m)
  refuseAt = calls + 2 // before = +1, after the rename = +2
  await rejects(t, store.put(r), 'indisponivel', 'put refused after the rename')
  t.ok(readFile(file).entries[r.lookupId], 'the file holds the row')
  t.alike(store.fetch(r.lookupId), { member: m, kind: 'passkey', blob: r.blob }, 'fetch shows the file')
  t.alike(store.list(m).map((x) => x.lookupId).sort(), [kept.lookupId, r.lookupId].sort(), 'list shows the file')

  refuseAt = calls + 2
  await rejects(t, store.remove({ member: m, lookupId: kept.lookupId }), 'indisponivel', 'remove refused after the rename')
  t.ok(readFile(file).removed[kept.lookupId], 'the file holds the tombstone')
  t.is(store.fetch(kept.lookupId), null, 'fetch shows the removal')
  t.alike(store.list(m).map((x) => x.lookupId), [r.lookupId], 'list shows the removal')
  t.is(await store.heal(), true, 'a read never clears dirty: heal still rewrites')
  t.is(await store.heal(), false, 'nothing left to heal after the durable rewrite')
})

// Makes the directory fsync inside writeJsonAtomic fail with EIO while
// `on.fail` is true, after the rename already landed. Returns a counter of
// directory fsyncs attempted.
function failDirFsync (t, dir, on) {
  const openSync = fs.openSync
  const fsyncSync = fs.fsyncSync
  const dirFds = new Set()
  const seen = { dirFsyncs: 0 }
  fs.openSync = function (p, ...rest) {
    const fd = openSync.call(fs, p, ...rest)
    if (path.resolve(String(p)) === path.resolve(dir)) dirFds.add(fd)
    return fd
  }
  fs.fsyncSync = function (fd) {
    if (dirFds.has(fd)) {
      dirFds.delete(fd)
      seen.dirFsyncs++
      if (on.fail) throw Object.assign(new Error('EIO'), { code: 'EIO' })
    }
    return fsyncSync.call(fs, fd)
  }
  t.teardown(() => {
    fs.openSync = openSync
    fs.fsyncSync = fsyncSync
  })
  return seen
}

test('a failed directory fsync stays dirty after a read: heal and a repeated put write durably', async (t) => {
  const { store, file, dir } = setup(t)
  const m = hex32()
  const r = req(m)
  const on = { fail: true }
  const seen = failDirFsync(t, dir, on)
  await rejects(t, store.put(r), 'EIO', 'put fails at the directory fsync')
  t.is(seen.dirFsyncs, 1)
  t.ok(readFile(file).entries[r.lookupId], 'the rename landed')
  on.fail = false
  t.alike(store.list(m).map((x) => x.lookupId), [r.lookupId], 'list answers from the file')
  t.is(await store.heal(), true, 'heal rewrites after the read')
  t.is(seen.dirFsyncs, 2, 'heal made a second, durable write')

  on.fail = true
  const r2 = req(m)
  await rejects(t, store.put(r2), 'EIO', 'second put fails at the directory fsync')
  on.fail = false
  t.ok(store.fetch(r2.lookupId), 'fetch answers from the file')
  const before = seen.dirFsyncs
  t.is((await store.put(r2)).changed, false, 'the repeated put finds the row')
  t.is(seen.dirFsyncs, before + 1, 'the repeated put still wrote durably')
  t.is(await store.heal(), false, 'nothing left to heal')
})

test('a read after an uncertain write refuses when the file cannot be read', async (t) => {
  let calls = 0
  let refuseAt = -1
  const { store, file } = setup(t, { guard: () => ++calls !== refuseAt })
  const m = hex32()
  const r = req(m)
  refuseAt = 2
  await rejects(t, store.put(r), 'indisponivel', 'put refused after the rename')
  fs.writeFileSync(file, 'not json')
  t.exception(() => store.fetch(r.lookupId), /indisponivel/)
  t.exception(() => store.list(m), /indisponivel/)
  t.absent(store.available(), 'a malformed file is final')
})

test('gens come from one store-wide counter, so a re-put after a pruned tombstone beats a stale copy', async (t) => {
  const { store, file, c } = setup(t)
  const m = hex32()
  const a = req(m)
  const b = req(hex32())
  await store.put(a)
  await store.put(b)
  t.is(readFile(file).entries[a.lookupId]?.gen, 1)
  t.is(readFile(file).entries[b.lookupId]?.gen, 2, 'another id still takes the next gen')
  await store.remove({ member: m, lookupId: a.lookupId })
  const stale = fs.readFileSync(file, 'utf8')
  t.is(JSON.parse(stale).removed[a.lookupId]?.gen, 3)
  // The tombstone is pruned, then the same id is put again.
  c.t += TOMBSTONE_TTL_MS + DAY
  await store.put(req(hex32()))
  t.absent(readFile(file).removed[a.lookupId], 'tombstone pruned')
  await store.put(a)
  t.ok(readFile(file).entries[a.lookupId]?.gen > 3, 'the re-put outranks the pruned tombstone')
  // A stalled writer renames the copy that still holds the tombstone.
  fs.writeFileSync(file, stale)
  await store.heal()
  t.ok(store.fetch(a.lookupId), 'the re-put survives in memory')
  t.ok(readFile(file).entries[a.lookupId], 'and on disk')
  t.ok(readFile(file).seq >= readFile(file).entries[a.lookupId]?.gen, 'seq never goes back')
})

test('gens do not depend on the clock: a remove after the clock went back still wins', async (t) => {
  const { store, file, c } = setup(t)
  const m = hex32()
  const r = req(m)
  c.t += DAY
  await store.put(r)
  const row = fs.readFileSync(file, 'utf8')
  c.t -= 2 * DAY
  t.alike(await store.remove({ member: m, lookupId: r.lookupId }), { changed: true })
  fs.writeFileSync(file, row)
  await store.heal()
  t.is(store.fetch(r.lookupId), null, 'the stale row stays buried')
  t.absent(readFile(file).entries[r.lookupId])
})

test('two live code rows after a merge: the higher gen stays, whatever createdAt says', async (t) => {
  const { dir, file, open, c } = setup(t)
  const m = hex32()
  const older = hex32()
  const newer = hex32()
  const row = (createdAt, gen) => ({ member: m, kind: 'code', nonce: '0'.repeat(48), ciphertext: '1'.repeat(164), createdAt, gen })
  // `older` was written first (gen 1) by a holder whose clock ran ahead.
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    seq: 2,
    entries: {
      [older]: row(new Date(T0 + DAY).toISOString(), 1),
      [newer]: row(new Date(T0).toISOString(), 2)
    },
    removed: {}
  }))
  const store = open()
  t.ok(store.available())
  c.t += 1000
  t.is(await store.heal(), true, 'the merge buries one code row')
  t.ok(store.fetch(newer), 'the newest write stays')
  t.is(store.fetch(older), null, 'the older write is buried')
  const disk = readFile(file)
  t.ok(disk.removed[older]?.gen > 2, 'buried under a fresh gen')
  t.is(disk.seq, disk.removed[older]?.gen)
  t.alike(fs.readdirSync(dir), [FILE])
})

test('the tombstone cap never drops a fresh tombstone, even after the clock went back', async (t) => {
  const { store, file, c } = setup(t)
  const m = hex32()
  const tombsOf = () => {
    const disk = readFile(file)
    return Object.keys(disk.removed).filter((id) => disk.removed[id].member === m)
  }
  // Tombstones younger than the stale-writer window all stay, past the cap.
  for (let i = 0; i < TOMBSTONE_MAX_PER_MEMBER + 3; i++) {
    c.t += 1000
    await store.put(req(m, 'code'))
  }
  t.is(tombsOf().length, TOMBSTONE_MAX_PER_MEMBER + 2, 'young tombstones are kept over the cap')
  c.t += STALE_WINDOW_MS + 1000
  await store.put(req(m, 'code'))
  t.is(tombsOf().length, TOMBSTONE_MAX_PER_MEMBER, 'once old enough the cap applies')

  // The clock goes back: the next tombstone has the oldest removedAt but
  // the highest gen, and it stays.
  c.t -= DAY
  const last = store.list(m).find((x) => x.kind === 'code').lookupId
  t.alike(await store.remove({ member: m, lookupId: last }), { changed: true })
  t.ok(readFile(file).removed[last], 'the tombstone just written is kept')
})

test('a file without seq, or with a gen above seq, is malformed', async (t) => {
  const m = hex32()
  const id = hex32()
  const good = { member: m, kind: 'passkey', nonce: '0'.repeat(48), ciphertext: '0'.repeat(164), createdAt: new Date(T0).toISOString(), gen: 3 }
  const tomb = { member: m, removedAt: new Date(T0).toISOString(), gen: 3 }
  const cases = [
    JSON.stringify({ v: 1, entries: {}, removed: {} }),
    JSON.stringify({ v: 1, seq: -1, entries: {}, removed: {} }),
    JSON.stringify({ v: 1, seq: 1.5, entries: {}, removed: {} }),
    JSON.stringify({ v: 1, seq: 2, entries: { [id]: good }, removed: {} }),
    JSON.stringify({ v: 1, seq: 2, entries: {}, removed: { [id]: tomb } })
  ]
  for (const bytes of cases) {
    const { file, open } = setup(t)
    fs.writeFileSync(file, bytes)
    const store = open()
    t.absent(store.available(), 'unavailable: ' + bytes.slice(0, 40))
    t.is(await store.heal(), false)
    t.is(fs.readFileSync(file, 'utf8'), bytes, 'bytes untouched')
  }
  const { file, open } = setup(t)
  fs.writeFileSync(file, JSON.stringify({ v: 1, seq: 3, entries: { [id]: good }, removed: {} }))
  t.ok(open().available(), 'seq equal to the highest gen is fine')
})

test('code rows tied on gen after a stale rename both stay: the acknowledged code is never deleted', async (t) => {
  const { file, c, open } = setup(t)
  const m = hex32()
  const old = req(m, 'code')
  const fresh = open()
  await fresh.put(old)
  // Order the ids so a tie broken by lookupId would bury the acknowledged one.
  let ackId = hex32()
  let staleId = hex32()
  if (ackId > staleId) [ackId, staleId] = [staleId, ackId]
  const before = fs.readFileSync(file, 'utf8')
  // The replacement holder writes its code (gen 3) and acknowledges it.
  c.t += 1000
  const ack = req(m, 'code', ackId)
  t.is((await fresh.put(ack)).changed, true)
  // The holder that lost its lock had read the file before that write; its
  // rename lands afterwards with its own code at the same gen.
  const afterAck = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, before)
  let calls = 0
  const stale = open({ guard: () => ++calls < 2 })
  await rejects(t, stale.put(req(m, 'code', staleId)), 'indisponivel', 'the stale holder does not acknowledge')
  const disk = readFile(file)
  t.is(disk.entries[staleId].gen, JSON.parse(afterAck).entries[ackId].gen, 'the two writes tie on gen')
  t.is(await fresh.heal(), true, 'heal merges the stale rename')
  t.ok(fresh.fetch(ackId), 'the acknowledged code still opens')
  t.ok(fresh.fetch(staleId), 'the tied code is kept too')
  t.is(fresh.fetch(old.lookupId), null, 'the older code stays buried')
  const healed = readFile(file)
  t.ok(healed.entries[ackId], 'acknowledged code on disk')
  t.ok(healed.entries[staleId], 'tied code on disk')
  // The next code put buries every older code row.
  c.t += 1000
  const next = req(m, 'code')
  await fresh.put(next)
  t.is(fresh.fetch(ackId), null)
  t.is(fresh.fetch(staleId), null)
  t.alike(fresh.list(m).map((r) => r.lookupId), [next.lookupId])
})

test('put over another member\'s tombstone is refused; the same member may re-put', async (t) => {
  const { store, file } = setup(t)
  const a = hex32()
  const b = hex32()
  const r = req(a)
  await store.put(r)
  await store.remove({ member: a, lookupId: r.lookupId })
  const before = fs.readFileSync(file, 'utf8')
  await rejects(t, store.put({ ...r, member: b }), 'pedido-invalido', 'another member takes a tombstoned id')
  t.is(fs.readFileSync(file, 'utf8'), before, 'nothing written')
  t.is(readFile(file).removed[r.lookupId].member, a, 'the tombstone keeps its member')
  t.alike(store.list(b), [])
  t.is((await store.put(r)).changed, true, 'the same member re-puts')
  t.is(store.fetch(r.lookupId).member, a)
})
