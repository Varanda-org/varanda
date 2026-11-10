// The file-backed node storage (lib/file-storage.js): per-file operations,
// whole cores, the key-value area, the exclusive LOCK, and a browser node
// session whose diary survives a restart on files.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fileNodeStorage } = require('../lib/file-storage')
const { createBrowserNode } = require('../lib/node')
const { connectClient } = require('./helpers/session')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')

function tmpDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-fstore-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }), { force: true })
  return dir
}

function call (file, method, ...args) {
  return new Promise((resolve, reject) => {
    file[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
  })
}

test('a file writes, reads, truncates, stats and deletes', async (t) => {
  const storage = fileNodeStorage(tmpDir(t))
  t.teardown(() => storage.close(), { force: true })
  const file = storage.core('diary')('data')
  await call(file, 'write', 0, b4a.from('hello world'))
  t.is(b4a.toString(await call(file, 'read', 6, 5)), 'world')
  t.is((await call(file, 'stat')).size, 11)
  await call(file, 'truncate', 5)
  t.is((await call(file, 'stat')).size, 5)
  t.is(b4a.toString(await call(file, 'read', 0, 5)), 'hello')
  await call(file, 'del', 2, 3)
  t.is(b4a.toString(await call(file, 'read', 0, 2)), 'he', 'bytes before the deleted range stay')
})

// Bare has no global process: there, random-access-file's process.nextTick
// for a zero-byte read throws inside a bare-fs callback and aborts the app.
// Node has process, so the uses coming from random-access-file are counted.
async function rafTicks (fn) {
  const tick = process.nextTick
  let used = 0
  process.nextTick = function (...args) {
    if (/random-access-file/.test(new Error().stack)) used++
    return tick.apply(process, args)
  }
  try {
    await fn()
  } finally {
    process.nextTick = tick
  }
  return used
}

test('zero-byte reads answer an empty buffer without process.nextTick', async (t) => {
  const storage = fileNodeStorage(tmpDir(t))
  t.teardown(() => storage.close(), { force: true })
  const factory = storage.core('diary')
  await call(factory('oplog'), 'write', 0, b4a.alloc(0))
  await call(factory('data'), 'write', 0, b4a.from('abc'))
  const used = await rafTicks(async () => {
    const queued = factory('oplog') // the read waits for the open
    t.is((await call(queued, 'read', 0, 0)).byteLength, 0, 'queued behind the open')
    const open = factory('data')
    t.is(b4a.toString(await call(open, 'read', 0, 3)), 'abc')
    t.is((await call(open, 'read', 3, 0)).byteLength, 0, 'on an open file')
  })
  t.is(used, 0)
})

test('a core with an empty block or an empty oplog opens and reads on files', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  const first = new Hypercore(storage.core('diary'))
  await first.append([b4a.from('x'), b4a.alloc(0)])
  await first.close()
  // An oplog created but never written (the app killed in between).
  const broken = path.join(dir, 'cores', b4a.toString(b4a.from('broken'), 'hex'))
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'oplog'), b4a.alloc(0))
  const used = await rafTicks(async () => {
    const again = new Hypercore(storage.core('diary'))
    t.is((await again.get(1)).byteLength, 0, 'the empty block')
    await again.close()
    const reopened = new Hypercore(storage.core('broken'))
    await reopened.ready()
    t.is(reopened.length, 0, 'the empty oplog opens as a new core')
    await reopened.close()
  })
  t.is(used, 0)
})

test('hasCore and deleteCore', async (t) => {
  const storage = fileNodeStorage(tmpDir(t))
  t.teardown(() => storage.close(), { force: true })
  t.is(await storage.hasCore('diary'), false)
  await call(storage.core('diary')('oplog'), 'write', 0, b4a.from('x'))
  t.is(await storage.hasCore('diary'), true)
  t.is(await storage.hasCore('other'), false)
  await storage.close()
  await storage.deleteCore('diary')
  t.is(await storage.hasCore('diary'), false)
  await storage.deleteCore('diary') // already gone
  t.exception(() => storage.core(''), /non-empty/)
  t.exception(() => storage.core(7), /non-empty/)
})

test('the key-value area round trips and replaces atomically', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.is(await storage.readJson('config'), null)
  await storage.writeJson('config', { v: 1, a: 'ç' })
  t.alike(await storage.readJson('config'), { v: 1, a: 'ç' })
  await storage.writeJson('config', { v: 2 })
  t.alike(await storage.readJson('config'), { v: 2 })
  t.alike(fs.readdirSync(path.join(dir, 'kv')), [b4a.toString(b4a.from('config'), 'hex') + '.json'], 'no temp file left behind')
  await storage.close()
})

test('overlapping writes of one key all succeed and the last one wins', async (t) => {
  const storage = fileNodeStorage(tmpDir(t))
  t.teardown(() => storage.close(), { force: true })
  const writes = []
  for (let i = 0; i < 20; i++) writes.push(storage.writeJson('config', { v: i }))
  await Promise.all(writes)
  t.alike(await storage.readJson('config'), { v: 19 })
})

// lib/file-storage.js reaches node:fs through #fs, the same module object,
// and looks each method up at call time: patching it here records the calls.
function spyFs (t, { fsyncError = null, fsyncResult = null, readResult = null } = {}) {
  const saved = { open: fs.open, fsync: fs.fsync, rename: fs.rename, readFile: fs.readFile }
  const paths = new Map()
  const calls = []
  fs.readFile = (file, encoding, cb) => {
    calls.push(['readFile', file])
    saved.readFile.call(fs, file, encoding, (err, text) => {
      if (readResult) readResult(err, text, cb)
      else cb(err, text)
    })
  }
  fs.open = (file, ...rest) => {
    const cb = rest.pop()
    saved.open.call(fs, file, ...rest, (err, fd) => {
      if (!err) paths.set(fd, file)
      cb(err, fd)
    })
  }
  fs.fsync = (fd, cb) => {
    const file = paths.get(fd)
    calls.push(['fsync', file])
    const err = fsyncError ? fsyncError(file) : null
    if (err) return process.nextTick(cb, err)
    saved.fsync.call(fs, fd, (err) => {
      if (fsyncResult) fsyncResult(file, err, cb)
      else cb(err)
    })
  }
  fs.rename = (from, to, cb) => {
    calls.push(['rename', from, to])
    saved.rename.call(fs, from, to, cb)
  }
  t.teardown(() => Object.assign(fs, saved), { force: true })
  return calls
}

function codeError (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function seedJson (dir, key, value) {
  const kv = path.join(dir, 'kv')
  fs.mkdirSync(kv, { recursive: true })
  fs.writeFileSync(path.join(kv, b4a.toString(b4a.from(key), 'hex') + '.json'), JSON.stringify(value))
}

function pauseRead (t, options = {}) {
  let release
  let ready
  const started = new Promise((resolve) => { ready = resolve })
  const calls = spyFs(t, {
    ...options,
    readResult (err, text, cb) {
      if (release) return cb(err, text)
      release = () => cb(err, text)
      ready()
    }
  })
  return { calls, started, release: () => release() }
}

test('readJson memoizes text and missing keys but returns fresh objects', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  seedJson(dir, 'config', { nested: { v: 1 } })
  const calls = spyFs(t)
  const first = await storage.readJson('config')
  first.nested.v = 2
  t.alike(await storage.readJson('config'), { nested: { v: 1 } })
  t.is(calls.length, 1, 'the second read uses the memo')
  calls.length = 0
  t.is(await storage.readJson('absent'), null)
  t.is(await storage.readJson('absent'), null)
  t.is(calls.length, 1, 'ENOENT is memoized')
  await storage.writeJson('absent', { v: 3 })
  calls.length = 0
  t.alike(await storage.readJson('absent'), { v: 3 })
  t.is(calls.length, 0, 'a durable write replaces the missing entry')
})

test('an equal write with no pending write does no disk I/O', async (t) => {
  const storage = fileNodeStorage(tmpDir(t))
  t.teardown(() => storage.close(), { force: true })
  const value = { v: 1 }
  await storage.writeJson('config', value)
  const calls = spyFs(t)
  await storage.writeJson('config', { v: 1 })
  t.alike(calls, [], 'no rename or fsync for an equal value')
  value.v = 2
  t.alike(await storage.readJson('config'), { v: 1 }, 'the memo does not retain the written object')
  t.alike(calls, [], 'the write populated the memo')
  await storage.readJson('absent')
  calls.length = 0
  await storage.writeJson('absent', null)
  t.is(calls.filter(([op]) => op === 'rename').length, 1, 'JSON null is different from ENOENT')
})

test('an equal write after a read-filled memo still writes and fsyncs', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  seedJson(dir, 'signedOut', true)
  t.is(await storage.readJson('signedOut'), true)
  const calls = spyFs(t)
  await storage.writeJson('signedOut', true)
  t.is(calls.filter(([op]) => op === 'rename').length, 1, 'the bytes read back were never proven durable')
  t.is(calls.filter(([op]) => op === 'fsync').length, 2, 'file and directory are fsynced')
  calls.length = 0
  await storage.writeJson('signedOut', true)
  t.alike(calls, [], 'after this instance made it durable, an equal write is skipped')
})

test('an equal write after this instance completed the same write is skipped', async (t) => {
  const storage = fileNodeStorage(tmpDir(t))
  t.teardown(() => storage.close(), { force: true })
  await storage.writeJson('config', { v: 1 })
  t.is(storage._sizes().durable, 1)
  const calls = spyFs(t)
  await storage.writeJson('config', { v: 1 })
  t.alike(calls, [])
  await storage.close()
  t.is(storage._sizes().durable, 0, 'close forgets durability')
})

test('every memo entry is charged its path and a fixed overhead', async (t) => {
  const storage = fileNodeStorage(tmpDir(t))
  t.teardown(() => storage.close(), { force: true })
  const count = 30000
  for (let i = 0; i < count; i++) await storage.readJson('absent-' + i)
  const size = storage._sizes().memo
  t.ok(size > 0 && size < count, 'missing keys cost bytes, so the memo stopped growing: ' + size)
  const calls = spyFs(t)
  await storage.readJson('absent-0')
  t.is(calls.length, 1, 'the oldest missing key was evicted')
})

test('the write counters do not grow with distinct keys', async (t) => {
  const storage = fileNodeStorage(tmpDir(t))
  t.teardown(() => storage.close(), { force: true })
  for (let i = 0; i < 200; i++) {
    await storage.writeJson('k' + i, i)
    await storage.readJson('k' + i)
    await storage.readJson('other' + i)
  }
  t.is(storage._sizes().writeCounts, 0, 'no write is pending and no read in flight')
})

test('queued A, B, A writes persist A even when A was memoized', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  await storage.writeJson('config', 'A')
  await Promise.all([
    storage.writeJson('config', 'A'),
    storage.writeJson('config', 'B'),
    storage.writeJson('config', 'A')
  ])
  const fresh = fileNodeStorage(dir)
  t.teardown(() => fresh.close(), { force: true })
  t.is(await fresh.readJson('config'), 'A', 'the last queued value reached disk')
})

test('failed writes invalidate the memo before and after rename', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  await storage.writeJson('config', 'old')
  const kv = path.join(dir, 'kv')
  let failDir = false
  let failing = true
  const calls = spyFs(t, {
    fsyncError: (file) => failing && (failDir ? file === kv : file.endsWith('.tmp')) ? codeError('EIO') : null
  })
  await t.exception(storage.writeJson('config', 'new'), /EIO/)
  calls.length = 0
  t.is(await storage.readJson('config'), 'old')
  t.is(calls.length, 1, 'a failed file fsync evicts the old memo')
  failDir = true
  await t.exception(storage.writeJson('config', 'new'), /EIO/)
  calls.length = 0
  t.is(await storage.readJson('config'), 'new', 'the renamed bytes are read from disk')
  t.is(calls.length, 1, 'a failed directory fsync also evicts the memo')
  failing = false
  calls.length = 0
  await storage.writeJson('config', 'new')
  t.is(calls.filter(([op]) => op === 'rename').length, 1, 'reading after a failed sync cannot make an equal write skip durability')
  t.is(await storage.readJson('config'), 'new', 'a rejection does not break the write chain')
})

test('the memo admits at most 64 KiB of UTF-8 text per key', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  const boundary = 'é'.repeat(32767)
  const large = boundary + 'a'
  t.is(b4a.byteLength(JSON.stringify(boundary), 'utf8'), 65536)
  t.is(b4a.byteLength(JSON.stringify(large), 'utf8'), 65537)
  seedJson(dir, 'boundary', boundary)
  seedJson(dir, 'large', large)
  const calls = spyFs(t)
  await storage.readJson('boundary')
  await storage.readJson('boundary')
  t.is(calls.length, 1, 'exactly 64 KiB is memoized')
  calls.length = 0
  await storage.readJson('large')
  await storage.readJson('large')
  t.is(calls.length, 2, 'larger texts are read every time')
  await storage.writeJson('boundary', large)
  calls.length = 0
  t.is((await storage.readJson('boundary')).length, large.length)
  await storage.readJson('boundary')
  t.is(calls.length, 2, 'a large write drops the previous small entry')
  calls.length = 0
  await storage.writeJson('boundary', large)
  t.is(calls.filter(([op]) => op === 'rename').length, 1, 'an equal large write is never skipped')
})

for (const exists of [true, false]) {
  test('an older read cannot replace the memo after a write (exists: ' + exists + ')', async (t) => {
    const dir = tmpDir(t)
    const storage = fileNodeStorage(dir)
    t.teardown(() => storage.close(), { force: true })
    if (exists) seedJson(dir, 'config', 'old')
    const paused = pauseRead(t)
    const old = storage.readJson('config')
    await paused.started
    await storage.writeJson('config', 'new')
    paused.release()
    t.is(await old, exists ? 'old' : null, 'the in-flight read may return its original result')
    paused.calls.length = 0
    t.is(await storage.readJson('config'), 'new', 'the old result cannot replace the new memo')
    t.is(paused.calls.length, 0, 'the durable write remains memoized')
  })
}

test('a read started during a pending write cannot replace its memo', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  seedJson(dir, 'config', 'old')
  let releaseWrite
  let ready
  const syncing = new Promise((resolve) => { ready = resolve })
  const paused = pauseRead(t, {
    fsyncResult (file, err, cb) {
      if (!file.endsWith('.tmp')) return cb(err)
      releaseWrite = () => cb(err)
      ready()
    }
  })
  const writing = storage.writeJson('config', 'new')
  await syncing
  const reading = storage.readJson('config')
  await paused.started
  releaseWrite()
  await writing
  paused.release()
  t.is(await reading, 'old')
  paused.calls.length = 0
  t.is(await storage.readJson('config'), 'new')
  t.is(paused.calls.length, 0, 'a read cannot fill the memo just because the pending write finished')
})

test('a write populates the memo only after the directory sync completes', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  await storage.writeJson('config', 'old')
  let release
  let ready
  const syncing = new Promise((resolve) => { ready = resolve })
  const calls = spyFs(t, {
    fsyncResult (file, err, cb) {
      if (file !== path.join(dir, 'kv')) return cb(err)
      release = () => cb(err)
      ready()
    }
  })
  const writing = storage.writeJson('config', 'new')
  await syncing
  calls.length = 0
  t.is(await storage.readJson('config'), 'new')
  t.is(await storage.readJson('config'), 'new')
  t.is(calls.length, 2, 'reads while the sync is pending neither use nor populate the memo')
  release()
  await writing
  calls.length = 0
  t.is(await storage.readJson('config'), 'new')
  t.is(calls.length, 0, 'the completed write populates the memo')
})

test('the 4 MiB memo evicts the least recently used text', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  // Each entry is charged its path and overhead too, so 64 of them fit and 65 do not.
  const value = 'é'.repeat(32500)
  for (let i = 0; i < 65; i++) seedJson(dir, 'k' + i, value)
  const calls = spyFs(t)
  for (let i = 0; i < 64; i++) await storage.readJson('k' + i)
  t.is(calls.length, 64)
  calls.length = 0
  await storage.readJson('k0')
  t.is(calls.length, 0, 'all 64 entries fit in 4 MiB')
  await storage.readJson('k64')
  calls.length = 0
  await storage.readJson('k0')
  await storage.readJson('k2')
  await storage.readJson('k64')
  t.is(calls.length, 0, 'recently used entries stay')
  await storage.readJson('k1')
  t.is(calls.length, 1, 'the least recently used entry was evicted')
  await storage.writeJson('k0', 'small')
  calls.length = 0
  await storage.readJson('k4')
  await storage.readJson('k5')
  t.is(calls.length, 0, 'replacing an entry subtracts its previous size')
})

test('close clears the JSON memo', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  await storage.writeJson('config', 'old')
  await storage.close()
  seedJson(dir, 'config', 'new')
  const calls = spyFs(t)
  t.is(await storage.readJson('config'), 'new')
  t.is(calls.length, 1, 'the first read after close returns to disk')
})

test('a read started before close cannot repopulate the memo', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  seedJson(dir, 'config', 'old')
  const paused = pauseRead(t)
  const reading = storage.readJson('config')
  await paused.started
  await storage.close()
  seedJson(dir, 'config', 'new')
  paused.release()
  t.is(await reading, 'old')
  paused.calls.length = 0
  t.is(await storage.readJson('config'), 'new')
  t.is(paused.calls.length, 1, 'the late read did not repopulate the cleared memo')
})

test('writeJson fsyncs the temp file before the rename and the directory after', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  const calls = spyFs(t)
  await storage.writeJson('signedOut', true)
  const kv = path.join(dir, 'kv')
  const file = path.join(kv, b4a.toString(b4a.from('signedOut'), 'hex') + '.json')
  t.alike(calls, [
    ['fsync', file + '.tmp'],
    ['rename', file + '.tmp', file],
    ['fsync', kv]
  ])
  t.is(await storage.readJson('signedOut'), true)
})

test('writeJson ignores an unsupported directory fsync but never a failed file fsync', async (t) => {
  const dir = tmpDir(t)
  const storage = fileNodeStorage(dir)
  t.teardown(() => storage.close(), { force: true })
  const kv = path.join(dir, 'kv')
  let failing = kv
  let code = 'EINVAL'
  spyFs(t, { fsyncError: (file) => file === failing ? codeError(code) : null })
  await storage.writeJson('k', 1)
  t.is(await storage.readJson('k'), 1, 'an EINVAL directory fsync is ignored')

  failing = path.join(kv, b4a.toString(b4a.from('k'), 'hex') + '.json.tmp')
  await t.exception(storage.writeJson('k', 2), /EINVAL/, 'a failed file fsync rejects')
  t.is(await storage.readJson('k'), 1, 'and the old value stays in place')

  failing = kv
  code = 'EIO'
  await t.exception(storage.writeJson('k', 3), /EIO/, 'any other directory fsync error rejects')
})

test('bytes survive close and a fresh storage on the same directory', async (t) => {
  const dir = tmpDir(t)
  const first = fileNodeStorage(dir)
  const factory = first.core('diary')
  await call(factory('data'), 'write', 0, b4a.from('persisted'))
  await first.writeJson('k', [1])
  await first.close()
  const again = factory('data') // a closed factory reopens on the same paths
  t.is(b4a.toString(await call(again, 'read', 0, 9)), 'persisted')
  await call(again, 'close')
  const second = fileNodeStorage(dir)
  t.is(b4a.toString(await call(second.core('diary')('data'), 'read', 0, 9)), 'persisted')
  t.alike(await second.readJson('k'), [1])
  await second.close()
})

test('lock is exclusive until the holder closes', async (t) => {
  const dir = tmpDir(t)
  const first = fileNodeStorage(dir)
  const second = fileNodeStorage(dir)
  t.teardown(async () => { await first.close(); await second.close() }, { force: true })
  await first.lock()
  await first.lock() // idempotent for the holder
  try {
    await second.lock()
    t.fail('the second lock must be refused')
  } catch (err) {
    t.is(err.code, 'LOCKED')
    t.is(err.message, 'diretório de dados em uso')
  }
  await first.close()
  await second.lock()
  t.pass('the lock is free after close')
})

test('a browser node session keeps its diary across a restart on files', async (t) => {
  const dir = tmpDir(t)
  const assoc = generateAssociationKeyPair()
  const association = b4a.toString(assoc.publicKey, 'hex')
  const keyPair = crypto.keyPair()

  async function open () {
    const node = createBrowserNode({
      storage: fileNodeStorage(dir),
      association,
      seederUrl: 'ws://127.0.0.1:9/seeder',
      createSocket: () => null,
      writeGate: false
    })
    await node.setKeyPair(keyPair)
    const web = await connectClient(node)
    return { node, web }
  }

  const first = await open()
  const { publicKey } = await first.web.request('identity.create')
  await first.web.request('cert.add', { cert: createCert({ member: publicKey }, assoc) })
  await first.web.request('post.create', { text: 'em arquivo' })
  const before = await first.web.request('log.read', {})
  await first.node.close()

  const second = await open()
  t.teardown(() => second.node.close(), { force: true })
  t.alike(await second.web.request('identity.create'), { publicKey, association })
  const after = await second.web.request('log.read', {})
  t.is(after.entries.length, before.entries.length)
  t.is(after.entries[after.entries.length - 1].record.text, 'em arquivo')
})
