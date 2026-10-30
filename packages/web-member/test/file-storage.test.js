// The file-backed node storage (lib/file-storage.js): per-file operations,
// whole cores, the key-value area, the exclusive LOCK, and a browser node
// session whose diary survives a restart on files.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
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
