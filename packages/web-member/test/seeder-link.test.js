// The spike's central measurement: a Hypercore 10 member (memory storage)
// over a WebSocket is gated, admitted and served by the Hypercore 11 seeder
// through Seeder#acceptStream. DIARY_OPTIONS (lib/diary-options.js) is
// tried first; if the seeder never gates that core, the other compat mode
// the installed hypercore 10 documents is tried once with fresh storage and
// key, and the mode that passed must be the one lib/diary-options.js holds.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const RAM = require('random-access-memory')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { PROTOCOL } = require('@varanda/core/lib/admission')
const { createCert, createSeederCert, generateAssociationKeyPair, seederCertForKey } = require('@varanda/core/lib/cert')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
const { DIARY_OPTIONS } = require('../lib/diary-options')

const POST_TEXT = 'poste do navegador (spike)'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// Seeder data dir prepared like apps/cli/test/e2e.test.js: config, key,
// seeder certificate.
function prepareSeederDir (t, assocKp) {
  const dataDir = tmpDir(t, 'varanda-web-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-web-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp), null, 2) + '\n')
  Seeder.addCert(dataDir, certFile, association)
  return { dataDir, publicKey }
}

async function startSeeder (t, bootstrap, dataDir) {
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
  t.teardown(() => new Promise((resolve) => wss.close(() => resolve())), { force: true })
  const accepted = []
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    accepted.push({ ws, raw, noise: seeder.acceptStream(raw) })
  })
  return { port: wss.address().port, accepted }
}

// The alternative compat mode: hypercore 10 defaults to compat (key ===
// signer public key), so the other mode is compat: false.
function otherMode (options) {
  const probe = { compat: true, ...options }
  return probe.compat === false ? { compat: true } : { compat: false }
}

function describe (m) {
  return 'key === publicKey: ' + (m.key === m.publicKey) +
    '; manifest version ' + (m.manifest ? m.manifest.version : null) +
    '; core.compat ' + m.core.core.compat
}

// One full attempt with fresh storage and key under `options`. Resolves with
// the measurements, or rejects with the seeder-side reason (rejected token,
// timeout, decode error).
async function attempt (t, { port, publicKey, assocKp, association, events, options }) {
  const m = await createMember({ storage: memoryStorage(), association, ...options })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assocKp))
  t.is(m.core.length, 1)
  const linkEvents = []
  const ws = new WebSocket('ws://127.0.0.1:' + port)
  const link = connectSeeder({ member: m, socket: ws, association, seederPublicKey: publicKey, onEvent: (e) => linkEvents.push(e), timeoutMs: 20000 })
  t.teardown(() => link.close(), { force: true })
  const admitted = await link.admitted
  t.is(admitted.type, 'admitted')
  t.is(admitted.key, m.key)
  await m.post(POST_TEXT)
  t.is(m.core.length, 2)
  const served = await link.waitServed(2)
  t.ok(served >= 2, 'seeder reports length >= 2')
  // admitted alone precedes the post (seeder.js:630-632): wait for the have.
  await until(() => events.some((e) => e.event === 'have' && e.key === m.key && e.length === 2), { name: 'have 2 no log do semeador', timeoutMs: 20000 })
  return { m, link, linkEvents }
}

function isNoGo (err) {
  return /^(timeout|not-in-log|quota|admission-failed|malformed|tempo esgotado|conexão com o semeador encerrada)/.test(err.message)
}

test('a Hypercore 10 member over WebSocket is gated and served by the Hypercore 11 seeder', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const { dataDir, publicKey } = prepareSeederDir(t, assocKp)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir)
  const { port, accepted } = await wsServer(t, seeder)
  const ctx = { port, publicKey, assocKp, association, events }

  let winner = DIARY_OPTIONS
  let result
  const errors = []
  try {
    result = await attempt(t, { ...ctx, options: DIARY_OPTIONS })
  } catch (err) {
    errors.push({ options: DIARY_OPTIONS, error: err.message })
    t.comment('modo ' + JSON.stringify(DIARY_OPTIONS) + ' falhou: ' + err.message)
    if (!isNoGo(err)) throw err
    winner = otherMode(DIARY_OPTIONS)
    t.comment('tentando o outro modo ' + JSON.stringify(winner))
    try {
      result = await attempt(t, { ...ctx, options: winner })
    } catch (err2) {
      errors.push({ options: winner, error: err2.message })
      t.comment('seeder log: ' + JSON.stringify(events))
      t.comment('errors: ' + JSON.stringify(errors))
      throw err2
    }
  }
  const { m, link, linkEvents } = result
  t.comment('modo que passou: ' + JSON.stringify(winner) + '; ' + describe(m))
  t.alike(winner, DIARY_OPTIONS, 'lib/diary-options.js holds the mode that passed')

  t.ok(link.verified, 'the hello certificate verified')
  t.ok(link.hello && link.hello.role === 'seeder')
  t.is(seederCertForKey(link.hello.cert, hex(link.noise.remotePublicKey), association).ok, true)
  t.is(hex(link.noise.remotePublicKey), publicKey, 'pinned seeder key')
  t.not(hex(link.noise.publicKey), m.key, 'the Noise key is not the diary key')
  t.not(hex(link.noise.remotePublicKey), m.key)
  t.ok(linkEvents.some((e) => e.event === 'peer' && e.role === 'seeder' && e.verified === true))
  t.ok(seeder.admittedKeys().includes(m.key), 'admitted on the seeder')
  t.ok(events.some((e) => e.event === 'admitted' && e.key === m.key), 'admitted logged')
  t.ok(events.some((e) => e.event === 'peer' && e.role === 'member'), 'member peer logged')
  t.is(events.filter((e) => e.event === 'rejected' && e.key === m.key).length, 0, 'never rejected')
  t.is(events.filter((e) => e.event === 'peer-dropped').length, 0, 'no frame-limit or other drop')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
  t.is(accepted.length, 1, 'one external connection')
  t.is(seeder.stats().connections, 1)

  // The seeder really holds the post: it reads it back from its own store.
  const entry = seeder._served.get(m.key)
  t.ok(entry, 'served entry')
  await until(() => entry.core.contiguousLength >= 2, { name: 'blocos baixados' })
  const block1 = await entry.core.get(1)
  t.is(block1.type, 'post')
  t.is(block1.text, POST_TEXT)

  link.close()
  await until(() => seeder.stats().connections === 0, { name: 'conexão externa encerrada' })
  t.is(JSON.stringify(events).includes('127.0.0.1'), false, 'no address logged')
})

// An endpoint that is not the seeder: a Noise responder (fresh key) over a
// WebSocket server that opens the admission channel itself and sends
// whatever the test tells it to, replicating nothing. onConnect receives
// { send(msg) } once the Noise handshake and the channel are up. With
// opts.onNoise, that hook runs right after the handshake, on the shared
// muxer, before the admission channel opens (used to replicate a core).
async function fakeEndpoint (t, onConnect, opts = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => new Promise((resolve) => wss.close(() => resolve())), { force: true })
  const noises = []
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    const noise = new NoiseSecretStream(false, raw, { keyPair: crypto.keyPair() })
    noise.on('error', () => {})
    noises.push(noise)
    t.teardown(() => noise.destroy(), { force: true })
    noise.once('connect', () => {
      // Hypercore 10's own protocol stream setup (index.js:157-187, the
      // stream goes in the first argument as replicate() passes it) puts the
      // Protomux instance in noise.userData, where attachAdmission on the
      // member side expects it; no core is attached here.
      Hypercore.createProtocolStream(noise)
      if (opts.onNoise) opts.onNoise(noise)
      const mux = Hypercore.getProtocolMuxer(noise)
      const channel = mux.createChannel({ protocol: PROTOCOL })
      const message = channel.addMessage({ encoding: c.buffer })
      channel.open()
      onConnect({ send: (msg) => message.send(b4a.from(JSON.stringify(msg), 'utf8')) })
    })
  })
  return { port: wss.address().port, noises }
}

test('a have before any hello never counts as served: the seeder must be verified first', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const m = await createMember({ storage: memoryStorage(), association })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assocKp))

  let endpoint = null
  const { port } = await fakeEndpoint(t, (e) => {
    endpoint = e
    // Before (and without) any hello: claims to hold 99 blocks of our key.
    e.send({ type: 'have', key: m.key, length: 99 })
    e.send({ type: 'admitted', key: m.key, length: 99 })
  })
  const linkEvents = []
  const ws = new WebSocket('ws://127.0.0.1:' + port)
  // No seederPublicKey pin: the hello certificate is the only check left.
  const link = connectSeeder({ member: m, socket: ws, association, onEvent: (e) => linkEvents.push(e), timeoutMs: 1500, admitTimeoutMs: 30000 })
  t.teardown(() => link.close(), { force: true })
  await until(() => endpoint !== null, { name: 'endpoint conectado' })
  await until(() => linkEvents.some((e) => e.event === 'connected'), { name: 'link conectado' })
  // Give the two messages time to arrive and be dispatched before asking.
  await new Promise((resolve) => setTimeout(resolve, 300))

  t.is(link.verified, false, 'nothing verified')
  t.is(link.hello, null, 'no hello')
  await t.exception(link.waitServed(1), /tempo esgotado/, 'waitServed(1) does not resolve on an unverified have')
  t.is(link.verified, false, 'still unverified after the wait')
  t.is(link.hello, null, 'still no hello')
  t.absent(linkEvents.some((e) => e.event === 'have'), 'no have event was reported')
  t.absent(linkEvents.some((e) => e.event === 'admitted'), 'no admitted event was reported')
  t.absent(linkEvents.some((e) => e.event === 'closed'), 'the link is still up (the timeout was ours)')

  // A hello whose certificate does not verify for the endpoint's Noise key
  // fails the link instead of unlocking the earlier have.
  endpoint.send({ type: 'hello', v: 1, role: 'seeder', count: 1, have: [{ key: m.key, length: 99 }], cert: { bogus: true } })
  await t.exception(link.admitted, /semeador não verificado/, 'an unverifiable seeder hello fails the link')
  t.is(link.verified, false)
  t.ok(link.hello && link.hello.role === 'seeder', 'the hello was seen')
  await t.exception(link.waitServed(1), /conexão com o semeador encerrada/, 'nothing is served after the failure')
  t.absent(linkEvents.some((e) => e.event === 'have' || e.event === 'admitted'), 'the inventory never counted')
})

test('a seeder with another key is refused before anything replicates', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const { dataDir } = prepareSeederDir(t, assocKp)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir)
  const { port } = await wsServer(t, seeder)

  const m = await createMember({ storage: memoryStorage(), association })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assocKp))
  const ws = new WebSocket('ws://127.0.0.1:' + port)
  const notTheSeeder = hex(generateAssociationKeyPair().publicKey)
  const link = connectSeeder({ member: m, socket: ws, association, seederPublicKey: notTheSeeder })
  t.teardown(() => link.close(), { force: true })
  await t.exception(link.admitted, /semeador desconhecido/)
  t.is(link.peer, null, 'no admission channel was attached')
  await until(() => seeder.stats().connections === 0, { name: 'conexão encerrada' })
  t.absent(events.some((e) => e.event === 'admitted'), 'nothing admitted')
})

test('a silent endpoint never admits: the link fails at the deadline and closes', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  // A WebSocket server that accepts and then never answers the handshake.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  wss.on('connection', (ws) => { ws.on('error', () => {}) })
  t.teardown(() => new Promise((resolve) => {
    for (const ws of wss.clients) ws.terminate()
    wss.close(() => resolve())
  }), { force: true })
  const m = await createMember({ storage: memoryStorage(), association, ...DIARY_OPTIONS })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assocKp))
  const socket = new WebSocket('ws://127.0.0.1:' + wss.address().port)
  socket.on('error', () => {})
  const started = Date.now()
  const link = connectSeeder({ member: m, socket, association, timeoutMs: 500 })
  await t.exception(link.admitted, /tempo esgotado/, 'admitted rejects at the deadline')
  t.ok(Date.now() - started < 3000, 'within the deadline (' + (Date.now() - started) + ' ms)')
  await until(() => link.noise.destroyed, { name: 'link encerrado', timeoutMs: 3000 })
  t.is(link.verified, false)
})

// An endpoint impersonating a seeder that, right after the Noise handshake,
// opens a Hypercore replication channel for the member's diary (a Hypercore
// 10 instance with the member's key in memory storage) and asks for blocks 0
// and 1. The link must attach the diary only after a verified hello, so the
// impostor never receives a block, whether it sends no hello (the admission
// deadline fails the link) or a hello with a bogus certificate.
async function impostorRun (t, { sendHello }) {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const m = await createMember({ storage: memoryStorage(), association, ...DIARY_OPTIONS })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assocKp))
  await m.post(POST_TEXT)
  t.is(m.core.length, 2, 'the member holds blocks 0 and 1')

  const impostor = new Hypercore(RAM, b4a.from(m.key, 'hex'))
  t.teardown(() => impostor.close(), { force: true })
  await impostor.ready()
  const gets = []
  let endpoint = null
  const { port } = await fakeEndpoint(t, (e) => {
    endpoint = e
    // The bogus hello comes late (still before the admission deadline), so
    // a link that replicated before verifying would already have leaked.
    if (sendHello) setTimeout(() => e.send({ type: 'hello', v: 1, role: 'seeder', count: 0, have: [], cert: { bogus: true } }), 1000)
  }, {
    onNoise (noise) {
      impostor.replicate(noise)
      for (const i of [0, 1]) {
        gets.push(impostor.get(i, { timeout: 2500 }).then(() => 'received', (err) => 'failed: ' + (err.code || err.message)))
      }
    }
  })
  const linkEvents = []
  const ws = new WebSocket('ws://127.0.0.1:' + port)
  // No seederPublicKey pin: the hello certificate is the only check left.
  const link = connectSeeder({ member: m, socket: ws, association, onEvent: (e) => linkEvents.push(e), timeoutMs: 1500, admitTimeoutMs: 2000 })
  t.teardown(() => link.close(), { force: true })

  const expected = sendHello ? /semeador não verificado/ : /tempo esgotado/
  await t.exception(link.admitted, expected, sendHello ? 'a bogus hello fails the link' : 'no hello fails the link at the deadline')
  t.ok(endpoint !== null, 'the impostor completed the handshake')
  t.is(link.verified, false, 'never verified')
  t.ok(gets.length === 2, 'the impostor asked for blocks 0 and 1')
  const outcomes = await Promise.all(gets)
  t.absent(outcomes.includes('received'), 'the impostor received no diary block (' + outcomes.join(', ') + ')')
  t.is(impostor.contiguousLength, 0, 'impostor contiguousLength stays 0')
  t.is(impostor.length, 0, 'impostor length stays 0')
  await until(() => link.noise.destroyed, { name: 'link encerrado', timeoutMs: 3000 })
}

test('an impostor seeder that sends no hello never receives a diary block', async (t) => {
  t.timeout(30000)
  await impostorRun(t, { sendHello: false })
})

test('an impostor seeder with a bogus certificate never receives a diary block', async (t) => {
  t.timeout(30000)
  await impostorRun(t, { sendHello: true })
})
