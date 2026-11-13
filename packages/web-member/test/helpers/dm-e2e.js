'use strict'

// Shared helpers of the dm end-to-end tests (dm-e2e.test.js and
// dm-moment-e2e.test.js): the real Seeder with the dm option behind a
// WebSocket server, real browser nodes over in-memory storage, a raw dm link.
// Local DHT and tmp dirs only.

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { tmpDir, localSwarmOptions, until } = require('./net')
const { connectClient, stoppedOf } = require('./session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert } = require('@varanda/core/lib/cert')
const { generateNoiseKeyPair, attachAdmission } = require('@varanda/core/lib/net')
const { attachDm } = require('@varanda/core/lib/dm-net')
const dmCore = require('@varanda/core/lib/dm')
const postage = require('@varanda/core/lib/dm-postage')
const { createBrowserNode } = require('../../lib/node')
const { memoryNodeStorage } = require('../../lib/node-storage')
const { dmLocalKeyFromPrf } = require('../../lib/passkey')
const gc = require('@varanda/core/lib/group-crypto')
const { wsStream } = require('../../lib/ws-stream')
const store = require('../../lib/node-store')

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

// The postage key as the operator's file holds it (decimal strings).
function rsaKey () {
  const { privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  const n = fromBase64url(jwk.n)
  return { kid: postage.kidOf(n), n: n.toString(10), e: '65537', d: fromBase64url(jwk.d).toString(10) }
}

// One WebSocket entry whose connections go to the seeder of the moment, so
// the nodes keep their seederUrl across a restart.
// blob: also a blob postage key (the blob pool and channel), and GET
// /blob/<id>/<index> on the same port, answered from Seeder#blobChunk unless
// host.blobGone (the pool swept); host.blobShort cuts every frame body
// short, with no Content-Length (a body that ended early).
async function seederHost (t, bootstrap, assoc, { blob = false } = {}) {
  const dataDir = tmpDir(t, 'varanda-dm-e2e-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-dm-e2e-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const key = rsaKey()
  const blobKey = blob ? rsaKey() : null
  // blobDelayMs > 0 holds every blob answer that long, so blobPeak (the most
  // GETs in flight at once) shows how many opens run together.
  const host = { dataDir, events: [], current: null, blobGone: false, blobShort: false, blobGets: 0, blobDelayMs: 0, blobActive: 0, blobPeak: 0 }
  host.start = async () => {
    const seeder = new Seeder({
      dataDir,
      associationKey: assoc.hex,
      ...localSwarmOptions(bootstrap),
      log: (e) => host.events.push(e),
      dm: { postage: { get: async () => ({ keys: [key] }) }, ...(blob ? { blobPostage: { get: async () => ({ keys: [blobKey] }) } } : {}) }
    })
    t.teardown(() => seeder.close(), { force: true })
    await seeder.start()
    host.current = seeder
    return seeder
  }
  const server = http.createServer(async (req, res) => {
    host.blobGets++
    if (host.blobDelayMs > 0 && req.url.startsWith('/blob/')) {
      host.blobActive++
      host.blobPeak = Math.max(host.blobPeak, host.blobActive)
      await new Promise((resolve) => setTimeout(resolve, host.blobDelayMs))
      host.blobActive--
    }
    const m = /^\/blob\/([0-9a-f]{64})\/(0|[1-9][0-9]{0,2})$/.exec(req.url)
    const frame = m && !host.blobGone && host.current !== null ? host.current.blobChunk(m[1], Number(m[2])) : null
    if (frame === null) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('não encontrado')
      return
    }
    if (host.blobShort) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(frame.subarray(0, frame.byteLength - 100))
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': frame.byteLength })
    res.end(frame)
  })
  const wss = new WebSocketServer({ server })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(async () => {
    for (const s of wss.clients) s.terminate()
    await new Promise((resolve) => wss.close(() => resolve()))
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', noop)
    if (host.current === null) raw.destroy()
    else host.current.acceptStream(raw)
  })
  host.url = 'ws://127.0.0.1:' + server.address().port + '/seeder'
  await host.start()
  return host
}

async function wallet (storage) {
  const w = await storage.readJson('dmStamps')
  return w && Array.isArray(w.items) ? w.items.length : 0
}

// A confirmed push: the seeder admits and serves the diary, which is what
// its stamp channel asks before issuing (an unknown diary gets 'teto').
async function push (t, n, host) {
  let stopped = null
  for (let i = 0; i < 5; i++) {
    const { runId } = await n.web.request('sync.start', { once: true, timeoutMs: 30000 })
    stopped = await stoppedOf(n.web.events, runId)
    if (stopped.reason === 'done' && stopped.result && stopped.result.ok === true && stopped.result.seederConfirmed === true) break
    t.comment('push attempt ' + (i + 1) + ' not confirmed: ' + JSON.stringify(stopped))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  t.is(stopped.result && stopped.result.seederConfirmed, true, 'the seeder holds the diary')
  await until(() => host.current._served.has(n.key) || host.current._admitted.has(n.key), { name: 'served', timeoutMs: 30000 })
}

// offline(): true -> every new socket goes to a closed port.
async function memberNode (t, assoc, host, { keyPair = crypto.keyPair(), prf = crypto.randomBytes(32), enable = true, blob = {}, storage = memoryNodeStorage(), offline = () => false } = {}) {
  const url = host.url
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(offline() ? 'ws://127.0.0.1:1/seeder' : u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, dm: { topUpRetryMs: 100, blob } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  const cert = createCert({ member: publicKey }, assoc.kp)
  await web.request('cert.add', { cert })
  const n = { node, web, storage, key: publicKey, keyPair, prf, cert, enabled: null }
  if (enable) {
    await push(t, n, host)
    n.enabled = await web.request('dm.enable')
    await until(async () => (await wallet(storage)) >= dmCore.DM_STAMP_WALLET, { name: 'wallet', timeoutMs: 60000 })
  }
  return n
}

// An anonymous dm link as a member opens one: fresh Noise key, empty
// inventory, the drop channel.
async function rawDm (t, url) {
  const ws = new WebSocket(url)
  ws.on('error', noop)
  const noise = new NoiseSecretStream(true, wsStream(ws), { keyPair: generateNoiseKeyPair() })
  noise.on('error', noop)
  t.teardown(() => noise.destroy(), { force: true })
  await new Promise((resolve, reject) => {
    noise.once('connect', resolve)
    noise.once('close', () => reject(new Error('link fechado')))
  })
  Hypercore.createProtocolStream(noise)
  const ch = attachDm(noise, { role: 'member' })
  attachAdmission(noise, { role: 'member', have: [] })
  t.is(await ch.supported, true, 'the seeder serves the dm channel')
  return ch
}

// Takes `n` stamps out of a node's wallet (spent here, never by the node).
// The wallet is sealed under the local key of the node's PRF.
async function takeStamps (node, n) {
  const storage = node.storage
  const key = await dmLocalKeyFromPrf(node.prf)
  const w = await store.readDmStamps(storage)
  const taken = w.items.slice(0, n).map((s) => ({ kid: s.kid, ...gc.openRecord({ nonce: s.nonce, box: s.box }, key) }))
  await store.writeDmStamps(storage, { items: w.items.slice(n), kids: w.kids })
  return taken
}

function dropOf (sealed, stamp) {
  return dmCore.encodeDrop({
    dropId: dmCore.newDropId(),
    kid: b4a.from(stamp.kid, 'hex'),
    rsaSig: b4a.from(stamp.sig, 'base64'),
    token: b4a.from(stamp.token, 'hex'),
    sealed
  })
}

// A PNG header the media bounds accept, then `size` random IDAT bytes.
function png (size) {
  const out = b4a.alloc(8 + 25 + 12 + size)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  out.writeUInt32BE(13, 8)
  out.write('IHDR', 12, 'ascii')
  out.writeUInt32BE(64, 16)
  out.writeUInt32BE(48, 20)
  out[24] = 8
  out[25] = 6
  out.writeUInt32BE(size, 33)
  out.write('IDAT', 37, 'ascii')
  nodeCrypto.randomFillSync(out, 41, size)
  return out
}

async function rejection (p) {
  try {
    await p
  } catch (err) {
    return err
  }
  return null
}

module.exports = { noop, hex, fromBase64url, rsaKey, seederHost, wallet, push, memberNode, rawDm, takeStamps, dropOf, png, rejection }
