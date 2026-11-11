// Discovery over the WebSocket listener (startSeedWs, /seeder): a lean
// member pages the inventory over 'varanda/discovery/1' from a frozen view,
// a member from before discovery still gets the whole inventory,
// `discovery: false` rejects the channel, and a capacity refusal is still
// the 1013 close. The seeder's swarm uses the local testnet only.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { attachAdmission, generateNoiseKeyPair, CAP_NO_INVENTORY, CAP_DISCOVERY } = require('@varanda/core/lib/net')
const { attachDiscovery } = require('@varanda/core/lib/discovery-net')
const { memberCertRecord, postRecord } = require('@varanda/core/lib/records')
const { startSeedWs } = require('../lib/seed-ws')

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function prepareSeederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return { dataDir, publicKey }
}

function within (promise, ms, name) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(name + ' não terminou em ' + ms + ' ms')), ms) })
  ]).finally(() => clearTimeout(timer))
}

async function startWsSeeder (t, opts = {}) {
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: assoc.hex, log: (e) => events.push(e), ...opts })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  return { assoc, seeder, server, events }
}

// One store holding diaries [member cert, one post at T0 + minutes[i]].
async function authorStore (t, assoc, minutes) {
  const store = new Corestore(tmpDir(t, 'varanda-author-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diaries = []
  for (let i = 0; i < minutes.length; i++) {
    const core = store.get({ name: 'diary-' + i, valueEncoding: 'json' })
    await core.ready()
    const key = hex(core.key)
    await core.append(memberCertRecord(createCert({ member: key }, assoc.kp)))
    await core.append(postRecord({ text: 'oi ' + i, at: new Date(T0 + minutes[i] * 60000).toISOString() }))
    diaries.push({ core, key })
  }
  return { store, diaries }
}

// A member over a WebSocket on /seeder: Noise initiator, the store
// replicated, the discovery channel (unless false) and admission with caps.
async function wsMember (t, port, { store = null, caps = 0, discovery = true } = {}) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/seeder')
  ws.on('error', () => {})
  t.teardown(() => ws.terminate(), { force: true })
  await within(new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', () => reject(new Error('upgrade recusado')))
  }), 5000, 'open')
  const duplex = createWebSocketStream(ws)
  duplex.on('error', () => {})
  const noise = new NoiseSecretStream(true, duplex, { keyPair: generateNoiseKeyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  await new Promise((resolve, reject) => {
    noise.once('close', () => reject(new Error('stream fechado antes do handshake')))
    noise.once('connect', resolve)
  })
  let s = store
  if (s === null) {
    s = new Corestore(tmpDir(t, 'varanda-reader-'))
    await s.ready()
    t.teardown(() => s.close(), { force: true })
  }
  s.replicate(noise)
  const disc = discovery ? attachDiscovery(noise, { role: 'member' }) : null
  const messages = []
  const peer = attachAdmission(noise, { role: 'member', have: [], caps, onmessage: (msg) => messages.push(msg) })
  const message = (pred, name) => until(() => messages.find(pred), { name, timeoutMs: 30000 })
  return { ws, noise, peer, disc, messages, message }
}

async function announceAll (assoc, member, diaries) {
  for (const { key } of diaries) member.peer.send({ type: 'announce', key, cert: createCert({ member: key }, assoc.kp) })
  for (const { key } of diaries) await member.message((m) => m.type === 'admitted' && m.key === key, 'admitted')
}

test('seed-ws discovery: a lean member pages every diary once in recentAt order; a legacy member gets the inventory', async (t) => {
  t.timeout(120000)
  // Views rebuilt every 200 ms (the default is far longer): the poster
  // moves to the front within the test's patience.
  const { assoc, seeder, server } = await startWsSeeder(t, { discoveryRebuildMs: 200 })
  const author = await authorStore(t, assoc, [2, 4, 1, 3])
  const k = author.diaries.map((d) => d.key)
  const expected = [k[1], k[3], k[0], k[2]]

  const lean = await wsMember(t, server.port, { store: author.store, caps: CAP_NO_INVENTORY })
  const hello = await lean.peer.hello
  t.is(hello.count, 0, 'a lean member gets count 0 over the WebSocket')
  t.ok(lean.peer.remoteCaps & CAP_DISCOVERY)
  t.ok(await lean.disc.supported)
  await announceAll(assoc, lean, author.diaries)

  await until(async () => {
    const r = await seeder.discoveryPage({ after: null, limit: 64 })
    return r.items && r.items.length === 4 && r.items.every((it, i) => it.key === expected[i])
  }, { name: 'four diaries indexed', timeoutMs: 30000 })

  const page1 = await lean.disc.page({ after: null, limit: 3 })
  t.is(page1.total, 4)
  t.alike(page1.items.map((it) => it.key), expected.slice(0, 3))
  // The oldest diary posts between the pages: the view is frozen.
  await author.diaries[2].core.append(postRecord({ text: 'agora' }))
  await until(() => seeder._served.get(k[2]).recentAt > T0 + 60 * 60000, { name: 'new post indexed', timeoutMs: 30000 })
  const page2 = await lean.disc.page({ after: page1.next, limit: 3, view: page1.view })
  t.is(page2.view, page1.view)
  t.is(page2.next, null)
  t.alike([...page1.items, ...page2.items].map((it) => it.key), expected, 'each diary exactly once')
  await until(async () => (await lean.disc.page({ after: null, limit: 1 })).items[0].key === k[2], { name: 'the poster moves to the front', timeoutMs: 10000 })
  t.absent(lean.messages.some((m) => m.type === 'have'), 'no inventory reaches a lean member')

  const legacy = await wsMember(t, server.port, { discovery: false })
  const legacyHello = await legacy.peer.hello
  t.is(legacyHello.count, 4, 'a legacy member gets the full inventory')
  t.alike(legacyHello.have.map((e) => e.key).sort(), [...k].sort())
})

test('seed-ws discovery: discovery false rejects the channel and offers no capability', async (t) => {
  t.timeout(90000)
  const { server } = await startWsSeeder(t, { discovery: false })
  const member = await wsMember(t, server.port, { caps: CAP_NO_INVENTORY })
  await member.peer.hello
  t.is(member.peer.remoteCaps, 0)
  t.is(await member.disc.supported, false, 'the open is rejected')
  t.is(member.ws.readyState, WebSocket.OPEN, 'the WebSocket stays open')
})

test('seed-ws discovery: a capacity refusal still closes the WebSocket with 1013 lotado', async (t) => {
  t.timeout(60000)
  const { seeder, server, events } = await startWsSeeder(t, { maxExternal: 1 })
  const first = await wsMember(t, server.port, { caps: CAP_NO_INVENTORY })
  await first.peer.hello
  await until(() => seeder.stats().connections === 1, { name: 'primeira conexão contada' })

  const ws = new WebSocket('ws://127.0.0.1:' + server.port + '/seeder')
  ws.on('error', () => {})
  t.teardown(() => ws.terminate(), { force: true })
  const closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  t.alike(await within(closed, 5000, 'close da segunda'), { code: 1013, reason: 'lotado' })
  t.ok(events.some((e) => e.event === 'peer-dropped' && e.reason === 'connection-limit'))
  t.is(seeder.stats().connections, 1)
  t.is(first.ws.readyState, WebSocket.OPEN, 'the admitted socket stays open')
})
