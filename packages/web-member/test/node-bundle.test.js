// The built browser node (scripts/build.js --node, the varanda-node.js the
// app's web build serves) run as a browser would run it: evaluated as a
// script that defines VarandaWebNode, over IndexedDB (fake-indexeddb) and a
// WebSocket global (ws), against an in-process seeder behind a WebSocket
// entry. Proves the bundle's whole graph (Hypercore 10, the sodium shim, the
// session and the dispatcher) runs, and that its storage survives a restart.
require('fake-indexeddb/auto')
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const ws = require('ws')
const b4a = require('b4a')
const { testnet, tmpDir, localSwarmOptions } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')

const BUILD = path.join(__dirname, '..', 'scripts', 'build.js')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

test('the built node bundle serves the RPC over IndexedDB and syncs with a seeder', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const out = path.join(tmpDir(t, 'varanda-node-bundle-'), 'varanda-node.js')
  const r = spawnSync(process.execPath, [BUILD, '--node', out], { encoding: 'utf8', timeout: 110000 })
  t.is(r.status, 0, 'build exits 0: ' + (r.stderr || '').trim())
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('NODE_BUNDLE '))
  t.ok(line && /^NODE_BUNDLE \d+ GZIP \d+$/.test(line), 'prints NODE_BUNDLE <bytes> GZIP <bytes>')
  t.comment(line)
  const code = fs.readFileSync(out, 'utf8')
  t.ok(code.includes('failed to derive shared secret'), 'carries the sodium shim')
  t.absent(code.includes('sodium-native'), 'no sodium-native')
  t.absent(code.includes('rocksdb'), 'no rocksdb')

  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const seederDir = tmpDir(t, 'varanda-node-bundle-seed-')
  Seeder.ensureConfig(seederDir, association)
  const { publicKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-node-bundle-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp)))
  Seeder.addCert(seederDir, certFile, association)
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (socket) => {
    const raw = ws.createWebSocketStream(socket)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  const seederUrl = 'ws://127.0.0.1:' + wss.address().port + '/seeder'

  // The page's globals: WebSocket (ws) and IndexedDB (fake-indexeddb, above).
  const savedWs = globalThis.WebSocket
  globalThis.WebSocket = ws.WebSocket
  t.teardown(() => {
    globalThis.WebSocket = savedWs
    delete globalThis.VarandaWebNode
  })
  vm.runInThisContext(code, { filename: out })
  const api = globalThis.VarandaWebNode
  t.is(api.version, 1)
  t.ok(Object.isFrozen(api), 'the global is frozen')

  const bad = await api.start({ association: 'xyz', seederUrl }).then(() => null, (err) => err)
  t.is(bad && bad.message, 'chave da associação inválida', 'configuration errors reach the page in pt-BR')

  const handle = await api.start({ association, seederUrl })
  t.alike(Object.keys(handle).sort(), ['close', 'connect'], 'only connect and close are exposed')
  const web = await connectClient(handle, { timeoutMs: 60000 })
  const { publicKey: key } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: key }, assocKp) })
  await web.request('post.create', { text: 'do pacote do nó' })
  const { runId } = await web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped = await stoppedOf(web.events, runId)
  if (stopped.reason !== 'done') t.comment(JSON.stringify(web.events))
  t.is(stopped.reason, 'done')
  t.is(stopped.result.admitted, true)
  t.is(stopped.result.seederConfirmed, true)
  t.ok(seeder.admittedKeys().includes(key), 'the seeder admitted the diary')
  await handle.close()

  // A new start (a page reload) finds the same diary in IndexedDB.
  const again = await api.start({ association, seederUrl })
  t.teardown(() => again.close(), { force: true })
  const web2 = await connectClient(again)
  t.alike(await web2.request('identity.show'), { publicKey: key, association })
  const log = await web2.request('log.read', {})
  t.is(log.entries[1].record.text, 'do pacote do nó')
})
