// The browser node's `prove` (issue #32) against the real Hypercore 11
// seeder over its WebSocket entry (Seeder#acceptStream), loopback only: the
// seeder offers CAP_PEER_PROOF (the node proves only then), the node's sync
// link proves its own diary, and the seeder records the proof for the diary
// key (a Hypercore 10 diary key is its signing key) with no bad message.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { connectClient } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function startSeeder (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-prove-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-prove-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events }
}

// A WebSocket server whose connections are handed to seeder.acceptStream.
async function wsServer (t, seeder) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const accepted = []
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    accepted.push({ ws, noise: seeder.acceptStream(raw, { address: '127.0.0.1' }) })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', accepted }
}

test('the real seeder records the browser node proof for its diary key', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const { seeder } = await startSeeder(t, bootstrap, assoc)
  const srv = await wsServer(t, seeder)

  const internal = []
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: srv.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 },
    onInternalError: (err) => internal.push(err),
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  const keyPair = crypto.keyPair()
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  t.is(publicKey, hex(keyPair.publicKey), 'the diary key is the signing key')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })

  await web.request('sync.start', { once: false })
  const peer = await until(() => [...seeder._peers].find((p) => p.provenKey === publicKey), { timeoutMs: 60000, name: 'proof recorded' })
  const link = srv.accepted.find((a) => a.noise && a.noise.remotePublicKey && hex(a.noise.remotePublicKey) === peer.peerKey)
  t.ok(link, 'on the WebSocket link of the node')
  t.is(peer.remoteRole, 'member')
  t.is(seeder._proofCounts.get(publicKey), 1, 'one proof for the diary')
  t.ok([...seeder._peers].every((p) => p.badMessages === 0), 'no bad messages')
  t.alike(internal, [])
  await web.request('sync.stop')
})
