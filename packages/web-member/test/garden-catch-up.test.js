'use strict'

// garden.state on a device whose copy of the own diary is behind another
// device of the same passkey (docs/rpc.md 5.158): the read catches up with
// the seeder first, as a write does, instead of answering an empty balcony
// that invites a replant. A seeder stand-in (as session.test.js) holds the
// diary as the other device left it; loopback only.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const net = require('node:net')
const { WebSocket, WebSocketServer } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, gardenRecord, gardenStateRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')

const NOT_SYNCED = 'sincronize com o semeador antes de publicar'
const GATE_LINE = 'sincronizando antes de publicar'
const HOUR = 3600000

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

function gatedNode (t, { assoc, keyPair, seederUrl, writeGateTimeoutMs }) {
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    writeGate: true,
    writeGateTimeoutMs,
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 }
  })
  t.teardown(() => node.close(), { force: true })
  return node
}

// role 'seeder' with a certificate signed by `signer`, replicating and
// advertising `cores`.
async function fakeSeeder (t, { signer, cores }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      for (const core of cores) core.replicate(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: cores.map((core) => ({ key: hex(core.key), length: core.length })),
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

async function runsSince (web, from) {
  const out = []
  for (const e of web.events.slice(from)) {
    if (e.name !== 'sync.started') continue
    const { runId } = e.data
    const lines = web.events.filter((x) => x.name === 'sync.event' && x.data.runId === runId).map((x) => x.data.line)
    out.push({ runId, lines, stopped: await stoppedOf(web.events, runId) })
  }
  return out
}

test('garden.state on a device behind the seeder reads the balcony another device saved', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const keyPair = crypto.keyPair()
  const keyHex = hex(keyPair.publicKey)

  // The other device joined and planted manjericão in pot 0; the seeder
  // holds its diary. This device has none of it yet.
  const now = Date.now()
  const plantedAt = new Date(now - HOUR).toISOString()
  const pots = [{ plant: 'manjericao', at: plantedAt, water: plantedAt, w: 0 }, null, null, null, null, null]
  const saved = gardenStateRecord({ pots, n: 1, at: new Date(now - HOUR / 2).toISOString() })
  const published = new Hypercore(memoryStorage(), { keyPair, valueEncoding: 'json' })
  await published.ready()
  t.teardown(() => published.close(), { force: true })
  await published.append(memberCertRecord(createCert({ member: keyHex }, kp)))
  await published.append(gardenRecord({ on: true, at: new Date(now - 2 * HOUR).toISOString() }))
  await published.append(saved)
  const holder = await fakeSeeder(t, { signer: kp, cores: [published] })

  const node = gatedNode(t, { assoc, keyPair, seederUrl: holder.url, writeGateTimeoutMs: 15000 })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node)
  t.alike(await web.request('identity.create'), { publicKey: keyHex, association: assoc.hex }, 'the same key on an empty device')
  t.alike((await web.request('log.read', {})).entries, [], 'nothing local before the read')

  let from = web.events.length
  const mine = await web.request('garden.state', {})
  t.is(mine.on, true, 'the flag the other device wrote')
  t.alike(mine.state, { seq: 2, pots: saved.pots, n: 1, at: saved.at }, 'the balcony the other device saved, not an empty one')
  const runs = await runsSince(web, from)
  t.is(runs.length, 1, 'one catch-up run')
  t.is(runs[0].lines[0], GATE_LINE)
  t.ok(runs[0].lines.includes('diário próprio sincronizado (3)'), 'caught up before reading')

  from = web.events.length
  t.alike(await web.request('garden.state', {}), mine, 'the same balcony again')
  t.is((await runsSince(web, from)).length, 0, 'caught up in this unlock: no second run')
})

test('garden.state with the seeder out of reach refuses instead of reading a copy that may be behind', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const keyPair = crypto.keyPair()
  const node = gatedNode(t, { assoc, keyPair, seederUrl: 'ws://127.0.0.1:' + (await deadPort()) + '/seeder', writeGateTimeoutMs: 3000 })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node)
  await web.request('identity.create')
  const err = await errorOf(web.request('garden.state', {}))
  t.alike([err && err.code, err && err.message], ['USAGE', NOT_SYNCED])
})
