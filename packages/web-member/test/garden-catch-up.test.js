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
const { memberCertRecord, gardenRecord, gardenStateRecord, gardenDecorRecord, gardenGiftRecord, deleteRecord } = require('@varanda/core/lib/records')
const { garden } = require('@varanda/rpc')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const store = require('../lib/node-store')
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

// garden.stall reads the same own diary (docs/rpc.md 5.163), so it catches
// up the same way: a stall behind another device of the same passkey shows
// neither the decor nor the gift that device wrote, and fresh daily budgets.
test('garden.stall on a device behind the seeder reads the decor and the gift another device wrote', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const keyPair = crypto.keyPair()
  const keyHex = hex(keyPair.publicKey)
  const friend = hex(crypto.keyPair().publicKey)

  // The other device joined, hung a rede and gave a tomate today; the seeder
  // holds its diary. This device has none of it yet.
  const now = Date.now()
  const givenAt = new Date(now).toISOString()
  const published = new Hypercore(memoryStorage(), { keyPair, valueEncoding: 'json' })
  await published.ready()
  t.teardown(() => published.close(), { force: true })
  await published.append(memberCertRecord(createCert({ member: keyHex }, kp)))
  await published.append(gardenRecord({ on: true, at: new Date(now - 2 * HOUR).toISOString() }))
  await published.append(gardenDecorRecord({ items: ['rede'], at: new Date(now - HOUR).toISOString() }))
  await published.append(gardenGiftRecord({ to: friend, item: 'tomate', at: givenAt }))
  const holder = await fakeSeeder(t, { signer: kp, cores: [published] })

  const node = gatedNode(t, { assoc, keyPair, seederUrl: holder.url, writeGateTimeoutMs: 15000 })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node)
  t.alike(await web.request('identity.create'), { publicKey: keyHex, association: assoc.hex }, 'the same key on an empty device')
  t.alike((await web.request('log.read', {})).entries, [], 'nothing local before the read')

  let from = web.events.length
  const stall = await web.request('garden.stall', {})
  t.alike(stall.decor, { seq: 2, items: ['rede'] }, 'the decor the other device hung')
  t.is(stall.giftsToday, 1, 'the gift the other device gave spends today\'s budget')
  t.alike(stall.gave, [{ seq: 3, to: friend, item: 'tomate', at: givenAt }], 'and is listed, so garden.drop can take it back')
  const runs = await runsSince(web, from)
  t.is(runs.length, 1, 'one catch-up run')
  t.is(runs[0].lines[0], GATE_LINE)
  t.ok(runs[0].lines.includes('diário próprio sincronizado (4)'), 'caught up before reading')

  from = web.events.length
  t.alike(await web.request('garden.stall', {}), stall, 'the same stall again')
  t.is((await runsSince(web, from)).length, 0, 'caught up in this unlock: no second run')
})

test('garden.stall with the seeder out of reach refuses instead of reading a copy that may be behind', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const keyPair = crypto.keyPair()
  const node = gatedNode(t, { assoc, keyPair, seederUrl: 'ws://127.0.0.1:' + (await deadPort()) + '/seeder', writeGateTimeoutMs: 3000 })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node)
  await web.request('identity.create')
  const err = await errorOf(web.request('garden.stall', {}))
  t.alike([err && err.code, err && err.message], ['USAGE', NOT_SYNCED])
})

// A diary copied whole into `storage` as a held replica the run does not
// track (no follow): every block stored, the tombstoned one too.
async function heldReplica (storage, core) {
  const dst = await store.openReplica(storage, hex(core.key))
  const a = core.replicate(true, { keepAlive: false })
  const b = dst.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await dst.update({ wait: true })
    await dst.download({ start: 0, end: core.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await dst.close()
  }
}

// garden.take (docs/rpc.md 5.165) against a stale seeder that still serves
// the bytes of a gift its giver withdrew: the peek reads a live gift, but
// the giver's diary held here carries the tombstone, so the take is refused
// as gone and writes nothing.
test('garden.take refuses a gift whose tombstone a held copy of the giver carries, though the seeder still serves it', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const keyPair = crypto.keyPair()
  const keyHex = hex(keyPair.publicKey)
  const giverPair = crypto.keyPair()
  const giverHex = hex(giverPair.publicKey)

  // The latest Brasília Saturday: a gift dated at its start is still on
  // offer whatever today is.
  let saturday = garden.dayStart(Date.now())
  while (!garden.stallDay(saturday)) saturday -= 24 * HOUR
  const gift = gardenGiftRecord({ to: keyHex, item: 'tomate', at: new Date(saturday).toISOString() })
  const giver = new Hypercore(memoryStorage(), { keyPair: giverPair, valueEncoding: 'json' })
  await giver.ready()
  t.teardown(() => giver.close(), { force: true })
  await giver.append(memberCertRecord(createCert({ member: giverHex }, kp)))
  await giver.append(gift)
  await giver.append(deleteRecord({ seq: 1 }))
  // The seeder never cleared block 1; this device holds the giver's diary
  // with its tombstone.
  const stale = await fakeSeeder(t, { signer: kp, cores: [giver] })
  const storage = memoryNodeStorage()
  await heldReplica(storage, giver)

  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: stale.url,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    writeGate: false,
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 }
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 30000 })
  await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: keyHex }, kp) })
  t.alike(await web.request('garden.set', { on: true }), { on: true })
  await web.request('sync.start', {})

  const peeked = await web.request('diary.peek', { author: giverHex, seqs: [1] })
  t.alike(peeked.entries, [{ seq: 1, record: gift }], 'the seeder still serves the withdrawn gift')

  const before = (await web.request('log.read', {})).entries.length
  const err = await errorOf(web.request('garden.take', { from: giverHex, seq: 1 }))
  t.alike([err && err.code, err && err.message], ['USAGE', 'este mimo não está mais disponível'])
  t.is((await web.request('log.read', {})).entries.length, before, 'nothing written')
  t.alike((await web.request('garden.stall', {})).takes, [], 'no take on the stall')
})
