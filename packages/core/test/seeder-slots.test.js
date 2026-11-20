// Connection slots shared by remote address (issue #32) on a real Seeder:
// one address filling the table cannot keep another address out, members
// that prove a diary the seeder serves keep their slot behind one shared
// address, and the rules of the `prove` message.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const b4a = require('b4a')
const c = require('compact-encoding')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const hcrypto = require('hypercore-crypto')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSwarm, attachAdmission, generateNoiseKeyPair, CAP_PEER_PROOF } = require('../lib/net')
const { memberCertRecord, postRecord } = require('../lib/records')
const { signPeerProof, MAX_PROOFS_PER_DIARY } = require('../lib/peer-proof')

const PROBATION_MS = 300

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

// A seeder data dir with config, Noise key pair and seeder certificate.
function prepareSeederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return { dataDir, publicKey }
}

async function startSeeder (t, bootstrap, opts = {}) {
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({
    dataDir,
    associationKey: assoc.hex,
    ...localSwarmOptions(bootstrap),
    log: (e) => events.push(e),
    probationMs: PROBATION_MS,
    ...opts
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events, assoc, publicKey }
}

const displaced = (events) => events.filter((e) => e.event === 'peer-dropped' && e.reason === 'connection-displaced')
const limited = (events) => events.filter((e) => e.event === 'peer-dropped' && e.reason === 'connection-limit')

// The seeder-side admission peer of a connection, by the client's Noise key.
function seederSide (seeder, noisePublicKey) {
  const k = hex(noisePublicKey)
  return [...seeder._peers].find((p) => p.peerKey === k) || null
}

// ---- swarm clients ----

// A member swarm that dials the seeder directly (joinPeer: no topic, so the
// clients never connect to each other). keyPair is known before it dials,
// so the test's addressOf can map it to a simulated address.
async function swarmClient (t, bootstrap, seederKey, { keyPair, role = 'member', cert = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  const swarm = createSwarm({ ...localSwarmOptions(bootstrap), keyPair })
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { force: true })
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role, cert, have: [] }))
  })
  const key = hex(swarm.keyPair.publicKey)
  return {
    swarm,
    key,
    peers,
    dial: () => swarm.joinPeer(b4a.from(seederKey, 'hex')),
    // The first connection that got the seeder's hello.
    first: () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  }
}

test('slots: a swarm socket on the local testnet reports 127.0.0.1, the default address group', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const { seeder, publicKey } = await startSeeder(t, bootstrap)
  const a = await swarmClient(t, bootstrap, publicKey)
  a.dial()
  await a.first()
  const socket = [...seeder.swarm.connections].find((s) => hex(s.remotePublicKey) === a.key)
  t.ok(socket, 'the seeder holds the connection')
  t.is(socket.rawStream.remoteHost, '127.0.0.1', 'UDX remoteHost')
  t.alike([...seeder._swarmSlots.entries()].map((e) => e.group), ['127.0.0.1'], 'grouped by that address')
  t.is(seeder.stats().swarm, 1)
})

test('slots: many swarm connections from one address cannot keep another address out', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const hosts = new Map()
  const addressOf = (s) => hosts.get(hex(s.remotePublicKey))
  const { seeder, events, publicKey } = await startSeeder(t, bootstrap, { maxConnections: 3, addressOf })

  const flood = []
  for (let i = 0; i < 3; i++) {
    const a = await swarmClient(t, bootstrap, publicKey)
    hosts.set(a.key, '198.51.100.1')
    a.dial()
    await a.first()
    flood.push(a)
  }
  t.is(seeder._swarmSlots.size, 3, 'one address fills the table')
  t.is(displaced(events).length, 0)

  const b = await swarmClient(t, bootstrap, publicKey)
  hosts.set(b.key, '198.51.100.2')
  b.dial()
  const bPeer = await b.first()
  await until(() => displaced(events).length >= 1, { name: 'connection-displaced' })
  t.is(displaced(events)[0].peerKey, flood[2].key, 'the newest connection of the flood address made room')
  t.is(seeder._swarmSlots.count('198.51.100.2'), 1, 'the other address holds a slot')

  // A fourth connection of the flood address, past every probation: it may
  // rotate its own address's connections, never the other address's slot.
  // The displaced ones redial on their own and do the same.
  await sleep(PROBATION_MS + 100)
  const a4 = await swarmClient(t, bootstrap, publicKey)
  hosts.set(a4.key, '198.51.100.1')
  a4.dial()
  await until(() => displaced(events).length + limited(events).length >= 2, { name: 'fourth flood connection handled' })
  await sleep(4 * PROBATION_MS)
  t.absent(displaced(events).some((e) => e.peerKey === b.key), 'never displaced the other address')
  t.absent(bPeer.socket.destroyed, 'the other address stays connected')
  t.is(seeder._swarmSlots.count('198.51.100.2'), 1)
  t.ok(seeder._swarmSlots.size <= 3, 'never above maxConnections')
  for (const e of displaced(events)) t.ok(hosts.get(e.peerKey) === '198.51.100.1', 'only flood connections displaced')
})

// ---- external streams ----

// A loopback TCP server whose connections reach acceptStream with `address`,
// one server per simulated client address. Each accepted stream records the
// onRefuse handoff ({ reason }); the test plays the caller and destroys it.
async function addressServer (t, seeder, address) {
  const accepted = []
  const server = net.createServer((raw) => {
    const rec = { raw, refusal: null, noise: null }
    accepted.push(rec)
    rec.noise = seeder.acceptStream(raw, {
      address,
      onRefuse: (r) => {
        rec.refusal = r
        raw.destroy()
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
  return { port: server.address().port, accepted }
}

// A diary in its own store: a member certificate and one post. The key is a
// Hypercore 11 manifest key, so a proof needs the seeder's manifest check.
async function diary (t, assoc) {
  const store = new Corestore(tmpDir(t, 'varanda-diary-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const core = store.get({ name: 'diary', valueEncoding: 'json' })
  await core.ready()
  const key = hex(core.key)
  await core.append(memberCertRecord(createCert({ member: key }, assoc.kp)))
  await core.append(postRecord({ text: 'x' }))
  return { store, core, key }
}

// A client over TCP: Noise initiator, the diary's store replicated (or a
// fresh one) and an admission channel (role member unless `role`). raw: no
// admission channel, only the raw messages of a hand-made one.
async function tcpClient (t, port, { d = null, role = 'member', cert = null, keyPair = generateNoiseKeyPair(), raw = false } = {}) {
  const tcp = net.connect(port, '127.0.0.1')
  tcp.on('error', () => {})
  t.teardown(() => tcp.destroy(), { force: true })
  const noise = new NoiseSecretStream(true, tcp, { keyPair })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  await new Promise((resolve, reject) => {
    noise.once('close', () => reject(new Error('stream fechado antes do handshake')))
    noise.once('connect', resolve)
  })
  let store = d ? d.store : null
  if (!store) {
    store = new Corestore(tmpDir(t, 'varanda-client-'))
    await store.ready()
    t.teardown(() => store.close(), { force: true })
  }
  store.replicate(noise)
  const messages = []
  const client = { tcp, noise, messages, noiseHex: hex(noise.publicKey) }
  if (raw) {
    client.raw = rawChannel(noise)
    return client
  }
  const have = d ? [{ key: d.key, length: d.core.length }] : []
  client.peer = attachAdmission(noise, { role, cert, have, onmessage: (msg) => messages.push(msg) })
  await client.peer.hello
  return client
}

// A raw admission channel on the stream's muxer, to send messages out of
// order (a prove before the hello).
function rawChannel (noise) {
  const mux = Hypercore.getProtocolMuxer(noise)
  const channel = mux.createChannel({ protocol: 'varanda/admission/1' })
  const message = channel.addMessage({ encoding: c.buffer })
  channel.open()
  return { sendJson: (obj) => message.send(b4a.from(JSON.stringify(obj), 'utf8')) }
}

function proveMsg (noiseHex, d) {
  return { type: 'prove', ...signPeerProof({ noiseHex, keyHex: d.key, keyPair: d.core.keyPair }) }
}

// Announces the diary, waits until the seeder serves and gated it, then
// sends a valid proof and waits until the seeder recorded it.
async function admitAndProve (seeder, client, d, assoc) {
  client.peer.send({ type: 'announce', key: d.key, cert: createCert({ member: d.key }, assoc.kp) })
  await until(() => client.messages.find((m) => m.type === 'admitted' && m.key === d.key), { name: 'admitted', timeoutMs: 30000 })
  await until(() => seeder._served.get(d.key) && seeder._served.get(d.key).gated, { name: 'gated' })
  client.peer.send(proveMsg(client.noiseHex, d))
  await until(() => {
    const p = seederSide(seeder, client.noise.publicKey)
    return p && p.provenKey === d.key
  }, { name: 'proof recorded' })
}

test('slots: behind one shared address, members that prove a served diary keep their slots', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const { seeder, events, assoc } = await startSeeder(t, bootstrap, { maxExternal: 3 })
  t.ok(seeder.stats().maxExternal === 3)
  const srv = await addressServer(t, seeder, '100.64.0.1')

  const d1 = await diary(t, assoc)
  const m1 = await tcpClient(t, srv.port, { d: d1 })
  t.ok(m1.peer.remoteCaps & CAP_PEER_PROOF, 'the seeder offers CAP_PEER_PROOF')
  await admitAndProve(seeder, m1, d1, assoc)
  const d2 = await diary(t, assoc)
  const m2 = await tcpClient(t, srv.port, { d: d2 })
  await admitAndProve(seeder, m2, d2, assoc)

  const u1 = await tcpClient(t, srv.port)
  t.is(seeder.stats().external, 3, 'table full')

  // Past probation, a newcomer of the same address rotates out the only
  // unproven connection, never a proven one.
  await sleep(PROBATION_MS + 100)
  const n1 = await tcpClient(t, srv.port)
  await until(() => srv.accepted[2].refusal, { name: 'unproven connection handed back' })
  t.alike(srv.accepted[2].refusal, { reason: 'connection-displaced' })
  t.is(displaced(events).length, 1)
  t.is(displaced(events)[0].peerKey, u1.noiseHex, 'logged with the displaced Noise key')

  await sleep(PROBATION_MS + 100)
  const d3 = await diary(t, assoc)
  const n2 = await tcpClient(t, srv.port, { d: d3 })
  await until(() => srv.accepted[3].refusal, { name: 'second unproven connection handed back' })
  t.alike(srv.accepted[3].refusal, { reason: 'connection-displaced' })
  t.is(displaced(events)[1].peerKey, n1.noiseHex)
  await admitAndProve(seeder, n2, d3, assoc)

  // Only protected connections left: the newcomer is refused.
  await sleep(PROBATION_MS + 100)
  const before = limited(events).length
  const n3 = net.connect(srv.port, '127.0.0.1')
  n3.on('error', () => {})
  t.teardown(() => n3.destroy(), { force: true })
  await until(() => srv.accepted[5] && srv.accepted[5].refusal, { name: 'refused' })
  t.alike(srv.accepted[5].refusal, { reason: 'connection-limit' })
  t.is(limited(events).length, before + 1)
  t.is(srv.accepted[5].noise, null)
  t.is(displaced(events).length, 2, 'no proven connection displaced')
  for (const m of [m1, m2, n2]) t.absent(m.noise.destroyed, 'proven member still connected')
  t.is(seeder.stats().external, 3)

  // A blocked diary no longer protects: its connection can be displaced.
  seeder._blocklist.blocked = ((orig) => () => new Set([...orig(), d1.key]))(seeder._blocklist.blocked.bind(seeder._blocklist))
  await tcpClient(t, srv.port).catch(() => null)
  await until(() => displaced(events).length === 3, { name: 'blocked diary displaced' })
  t.is(displaced(events)[2].peerKey, m1.noiseHex, 'the blocked diary lost its protection')
})

test('slots: a certified seeder keeps its slot only on the swarm; over an external stream, or with an invalid certificate, it does not', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const hosts = new Map()
  const addressOf = (s) => hosts.get(hex(s.remotePublicKey))
  const { seeder, events, assoc, publicKey } = await startSeeder(t, bootstrap, { maxConnections: 2, maxExternal: 2, addressOf })
  const certified = (kp) => createSeederCert({ seeder: hex(kp.publicKey) }, assoc.kp)

  // Swarm: a seeder with a valid certificate and one whose certificate names
  // another Noise key share one address; another address displaces only the
  // second.
  const kp = generateNoiseKeyPair()
  const good = await swarmClient(t, bootstrap, publicKey, { keyPair: kp, role: 'seeder', cert: certified(kp) })
  hosts.set(good.key, '198.51.100.1')
  good.dial()
  const goodPeer = await good.first()
  await until(() => seederSide(seeder, kp.publicKey) && seederSide(seeder, kp.publicKey).slotSeederOk === true, { name: 'seeder certificate checked' })
  const badKp = generateNoiseKeyPair()
  const bad = await swarmClient(t, bootstrap, publicKey, { keyPair: badKp, role: 'seeder', cert: certified(generateNoiseKeyPair()) })
  hosts.set(bad.key, '198.51.100.1')
  bad.dial()
  await bad.first()
  await until(() => seederSide(seeder, badKp.publicKey) && seederSide(seeder, badKp.publicKey).slotSeederOk === false, { name: 'invalid certificate checked' })
  await sleep(PROBATION_MS + 100)
  const n0 = await swarmClient(t, bootstrap, publicKey)
  hosts.set(n0.key, '198.51.100.2')
  n0.dial()
  await until(() => displaced(events).length === 1, { name: 'swarm displaced' })
  t.is(displaced(events)[0].peerKey, bad.key, 'the seeder with an invalid certificate made room')
  await sleep(PROBATION_MS + 100)
  const n1 = await swarmClient(t, bootstrap, publicKey)
  hosts.set(n1.key, '198.51.100.3')
  n1.dial()
  await until(() => displaced(events).length >= 2, { name: 'swarm displaced again' })
  t.absent(displaced(events).some((e) => e.peerKey === good.key), 'the certified swarm seeder was never displaced')
  t.absent(goodPeer.socket.destroyed, 'certified swarm seeder still connected')

  // External streams: the same certificate protects nothing. A local stream
  // holds the other slot, so the certified one is the only candidate.
  const before = displaced(events).length
  const local = net.createServer((raw) => seeder.acceptStream(raw, { address: '127.0.0.1', local: true }))
  t.teardown(() => new Promise((resolve) => local.close(() => resolve())), { force: true })
  const localPort = await new Promise((resolve) => local.listen(0, '127.0.0.1', () => resolve(local.address().port)))
  const l = net.connect(localPort, '127.0.0.1')
  l.on('error', () => {})
  t.teardown(() => l.destroy(), { force: true })
  await until(() => seeder.stats().external === 1, { name: 'local stream' })
  const srv = await addressServer(t, seeder, '192.0.2.10')
  const xkp = generateNoiseKeyPair()
  const ext = await tcpClient(t, srv.port, { role: 'seeder', keyPair: xkp, cert: certified(xkp) })
  await until(() => seederSide(seeder, xkp.publicKey) && seederSide(seeder, xkp.publicKey).slotSeederOk === true, { name: 'external seeder certificate checked' })
  await sleep(PROBATION_MS + 100)
  const srv2 = await addressServer(t, seeder, '192.0.2.11')
  await tcpClient(t, srv2.port)
  await until(() => displaced(events).length === before + 1, { name: 'external displaced' })
  t.is(displaced(events)[before].peerKey, ext.noiseHex, 'a certified seeder over an external stream is displaced like any stream')
})

test('slots: one protected connection per seeder key', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const { seeder } = await startSeeder(t, bootstrap)
  const peer = (key) => ({ remoteRole: 'seeder', slotSeederOk: true, peerKey: key })
  const entry = (p, extra = {}) => ({ data: { socket: { _varandaPeer: p }, ...extra } })
  const first = peer('aa')
  const second = peer('aa')
  const third = peer('bb')
  for (const p of [first, second, third]) seeder._peers.add(p)
  t.absent(seeder._slotProtected(entry(first)), 'not a swarm socket: not protected')
  t.ok(seeder._slotProtected(entry(first, { swarm: true })), 'the first swarm connection of a seeder key')
  t.absent(seeder._slotProtected(entry(second, { swarm: true })), 'a second one of the same key, while the first is live')
  t.ok(seeder._slotProtected(entry(third, { swarm: true })), 'another seeder key')
  t.ok(seeder._slotProtected(entry(first, { swarm: true })), 'the first keeps it')
  seeder._peers.delete(first)
  t.absent(seeder._slotProtected(entry(first, { swarm: true })), 'a closed connection protects nothing')
  t.ok(seeder._slotProtected(entry(second, { swarm: true })), 'the next live connection of that key takes it')
  const local = { socket: null, local: true }
  seeder._localStreams.add(local)
  t.ok(seeder._slotProtected({ data: local }), 'a local external stream within its share, even before its handshake')
  seeder._localStreams.delete(local)
  for (const p of [second, third]) seeder._peers.delete(p)
})

test('slots: the oldest external streams from this host keep their slots, up to a quarter of maxExternal', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  // maxExternal 4: the oldest live local stream is protected, the others
  // are ordinary entries of 127.0.0.1.
  const { seeder, events } = await startSeeder(t, bootstrap, { maxExternal: 4, probationMs: 60000 })
  const listen = (opts) => {
    const server = net.createServer((raw) => seeder.acceptStream(raw, opts))
    t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  }
  const portLocal = await listen({ address: '127.0.0.1', local: true })
  const portB = await listen({ address: '192.0.2.40' })
  const portC = await listen({ address: '192.0.2.41' })
  const portD = await listen({ address: '192.0.2.42' })
  const portG = await listen({ address: '192.0.2.43' })
  const dial = (port) => {
    const s = net.connect(port, '127.0.0.1')
    s.on('error', () => {})
    t.teardown(() => s.destroy(), { force: true })
    return s
  }
  const closed = (s) => s.destroyed ? Promise.resolve() : new Promise((resolve) => s.once('close', resolve))

  const l1 = dial(portLocal)
  await until(() => seeder.stats().external === 1, { name: 'local 1' })
  const l2 = dial(portLocal)
  await until(() => seeder.stats().external === 2, { name: 'local 2' })
  const l3 = dial(portLocal)
  await until(() => seeder.stats().external === 3, { name: 'local 3' })
  dial(portB)
  await until(() => seeder.stats().external === 4, { name: 'B' })
  // 127.0.0.1 holds two unprotected streams, C's address none: the newest
  // local stream makes room, never the first one.
  dial(portC)
  await until(() => displaced(events).length === 1, { name: 'displaced' })
  await closed(l3)
  t.absent(l1.destroyed, 'the protected local stream stays')
  t.absent(l2.destroyed)
  // One unprotected stream per address now, all in probation.
  const d = dial(portD)
  await closed(d)
  t.is(limited(events).length, 1, 'then a newcomer is refused')
  t.absent(l1.destroyed)
  t.is(seeder.stats().external, 4)

  // The protected one closes: l2, now the oldest live local stream, takes
  // its place, so with l4 alone unprotected in 127.0.0.1 nothing is
  // displaced.
  l1.destroy()
  await until(() => seeder.stats().external === 3, { name: 'l1 closed' })
  const l4 = dial(portLocal)
  await until(() => seeder.stats().external === 4, { name: 'local 4' })
  const g = dial(portG)
  await closed(g)
  t.is(displaced(events).length, 1, 'the local stream that became the oldest is protected')
  t.is(limited(events).length, 2)
  t.absent(l2.destroyed)
  t.absent(l4.destroyed)
  t.is(seeder._localStreams.size, 2)
})

test('slots: a displaced local stream leaves the local share at once, not when its socket closes', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  // maxExternal 4: the local share is one stream.
  const { seeder, events } = await startSeeder(t, bootstrap, { maxExternal: 4, probationMs: 60000 })
  const serve = (optsFor) => {
    const server = net.createServer((raw) => seeder.acceptStream(raw, optsFor(raw)))
    t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  }
  // Like seed-ws while it sends 1013, the local caller keeps a displaced
  // stream open, so its socket closes only after DISPLACED_GRACE_MS. The
  // clients never finish a handshake: a long deadline keeps them open on a
  // slow machine.
  const portLocal = await serve((raw) => ({
    address: '127.0.0.1',
    local: true,
    handshakeTimeoutMs: 50000,
    onRefuse: (r) => { if (r.reason !== 'connection-displaced') raw.destroy() }
  }))
  const remote = (address) => serve(() => ({ address }))
  const portB = await remote('192.0.2.50')
  const portC = await remote('192.0.2.51')
  const portG = await remote('192.0.2.52')
  const dial = (port) => {
    const s = net.connect(port, '127.0.0.1')
    s.on('error', () => {})
    t.teardown(() => s.destroy(), { force: true })
    return s
  }
  const closed = (s) => s.destroyed ? Promise.resolve() : new Promise((resolve) => s.once('close', resolve))

  const l1 = dial(portLocal)
  await until(() => seeder.stats().external === 1, { name: 'local 1' })
  const l2 = dial(portLocal)
  await until(() => seeder.stats().external === 2, { name: 'local 2' })
  dial(portLocal)
  await until(() => seeder.stats().external === 3, { name: 'local 3' })
  dial(portB)
  await until(() => seeder.stats().external === 4, { name: 'B' })
  // C displaces the newest unprotected local stream, l3, which stays open
  // for its grace period.
  dial(portC)
  await until(() => displaced(events).length === 1, { name: 'l3 displaced' })
  t.is(seeder._localStreams.size, 2, 'the displaced stream left the local share')

  // The older local streams close while l3 is still open: l4, now the
  // oldest local stream that holds a slot, takes the share, not l3.
  l1.destroy()
  l2.destroy()
  await until(() => seeder.stats().external === 2, { name: 'l1 and l2 closed' })
  const l4 = dial(portLocal)
  await until(() => seeder.stats().external === 3, { name: 'local 4' })
  const l5 = dial(portLocal)
  await until(() => seeder.stats().external === 4, { name: 'local 5' })
  // 127.0.0.1 holds one unprotected stream (l5) and G's address none, all
  // in probation: G is refused and nothing is displaced.
  const g = dial(portG)
  await closed(g)
  t.is(limited(events).length, 1, 'G is refused')
  t.is(displaced(events).length, 1, 'l4 holds the local share, so l5 is not displaced')
  t.absent(l4.destroyed)
  t.absent(l5.destroyed)
})

test('prove: rules on order, role, count, signature and ownership', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const { seeder, assoc } = await startSeeder(t, bootstrap, { maxExternal: 16 })
  const srv = await addressServer(t, seeder, '192.0.2.20')
  const d = await diary(t, assoc)
  const side = (client) => until(() => seederSide(seeder, client.noise.publicKey), { name: 'seeder side' })

  // Before the hello: a bad message. The hello and a valid proof after it
  // are still taken.
  const early = await tcpClient(t, srv.port, { raw: true })
  early.raw.sendJson(proveMsg(early.noiseHex, d))
  const earlySide = await side(early)
  await until(() => earlySide.badMessages === 1, { name: 'early prove counted' })
  t.is(earlySide.provenKey, undefined, 'not recorded')
  early.raw.sendJson({ type: 'hello', v: 1, role: 'member', count: 0, have: [] })
  await until(() => earlySide.remoteRole === 'member', { name: 'hello after' })
  early.raw.sendJson(proveMsg(early.noiseHex, d))
  await until(() => earlySide.provenKey === d.key, { name: 'valid prove after the hello' })
  t.is(earlySide.badMessages, 1)
  t.is(seeder._proofCounts.get(d.key), 1)

  // Twice on one connection: the second is a bad message.
  const twice = await tcpClient(t, srv.port)
  const twiceSide = await side(twice)
  twice.peer.send(proveMsg(twice.noiseHex, d))
  await until(() => twiceSide.provenKey === d.key, { name: 'first prove' })
  twice.peer.send(proveMsg(twice.noiseHex, d))
  await until(() => twiceSide.badMessages === 1, { name: 'second prove counted' })
  t.is(seeder._proofCounts.get(d.key), 2, 'counted once')

  // From a seeder-role peer: a bad message.
  const kp = generateNoiseKeyPair()
  const asSeeder = await tcpClient(t, srv.port, { role: 'seeder', keyPair: kp, cert: createSeederCert({ seeder: hex(kp.publicKey) }, assoc.kp) })
  const seederSideP = await side(asSeeder)
  asSeeder.peer.send(proveMsg(asSeeder.noiseHex, d))
  await until(() => seederSideP.badMessages === 1, { name: 'seeder prove counted' })
  t.is(seederSideP.provenKey, undefined)

  // A broken signature, a signer that does not own the key, and a proof
  // bound to another Noise key: each a bad message, never recorded.
  const cases = {
    'bad signature': (noiseHex) => {
      const m = proveMsg(noiseHex, d)
      m.sig = (m.sig[0] === '0' ? '1' : '0') + m.sig.slice(1)
      return m
    },
    'signer does not own the key': (noiseHex) => ({ type: 'prove', ...signPeerProof({ noiseHex, keyHex: d.key, keyPair: hcrypto.keyPair() }) }),
    'bound to another Noise key': () => proveMsg(hex(generateNoiseKeyPair().publicKey), d)
  }
  for (const [name, make] of Object.entries(cases)) {
    const cl = await tcpClient(t, srv.port)
    const s = await side(cl)
    cl.peer.send(make(cl.noiseHex))
    await until(() => s.badMessages === 1, { name })
    t.is(s.provenKey, undefined, name + ': not recorded')
  }
  t.is(seeder._proofCounts.get(d.key), 2, 'failed proofs never count')

  // A Hypercore 10 / browser diary: the key is the signer itself.
  const browserKp = hcrypto.keyPair()
  const browser = await tcpClient(t, srv.port)
  const browserSide = await side(browser)
  browser.peer.send({ type: 'prove', ...signPeerProof({ noiseHex: browser.noiseHex, keyHex: hex(browserKp.publicKey), keyPair: browserKp }) })
  await until(() => browserSide.provenKey === hex(browserKp.publicKey), { name: 'signer === key proof' })
  t.is(browserSide.badMessages, 0)

  // MAX_PROOFS_PER_DIARY live proofs per diary: the next valid one waits
  // (not a bad message) and takes the place a closed connection frees.
  t.is(MAX_PROOFS_PER_DIARY, 4)
  const more = []
  for (let i = seeder._proofCounts.get(d.key); i < MAX_PROOFS_PER_DIARY; i++) {
    const cl = await tcpClient(t, srv.port)
    const s = await side(cl)
    cl.peer.send(proveMsg(cl.noiseHex, d))
    await until(() => s.provenKey === d.key, { name: 'proof ' + (i + 1) })
    more.push(cl)
  }
  t.is(seeder._proofCounts.get(d.key), MAX_PROOFS_PER_DIARY)
  const fifth = await tcpClient(t, srv.port)
  const fifthSide = await side(fifth)
  fifth.peer.send(proveMsg(fifth.noiseHex, d))
  // A message after the proof: once it is dispatched, the proof was handled.
  fifth.peer.send({ type: 'have', key: d.key, length: 1 })
  await until(() => fifthSide.remoteHave.has(d.key), { name: 'fifth proof handled' })
  t.is(fifthSide.provenKey, undefined, 'fifth proof does not protect yet')
  t.is(fifthSide.badMessages, 0, 'and is not a bad message')
  t.is(seeder._proofCounts.get(d.key), MAX_PROOFS_PER_DIARY)

  twice.noise.destroy()
  await until(() => fifthSide.provenKey === d.key, { name: 'waiting proof takes the freed place' })
  t.is(seeder._proofCounts.get(d.key), MAX_PROOFS_PER_DIARY, 'the count stays at the cap')

  // Two more wait; the first closes before a place frees, so the place
  // goes to the next live one.
  const waitingSide = async () => {
    const cl = await tcpClient(t, srv.port)
    const s = await side(cl)
    cl.peer.send(proveMsg(cl.noiseHex, d))
    cl.peer.send({ type: 'have', key: d.key, length: 1 })
    await until(() => s.remoteHave.has(d.key), { name: 'waiting proof handled' })
    t.is(s.provenKey, undefined)
    return { cl, s }
  }
  const sixth = await waitingSide()
  const seventh = await waitingSide()
  sixth.cl.noise.destroy()
  await until(() => !seeder._peers.has(sixth.s), { name: 'sixth closed' })
  t.is(seeder._proofWaiting.get(d.key).size, 1, 'a closed waiting connection leaves the queue')
  more[0].noise.destroy()
  await until(() => seventh.s.provenKey === d.key, { name: 'next live waiting proof promoted' })
  t.is(sixth.s.provenKey, undefined, 'never the closed one')
  t.is(seeder._proofWaiting.has(d.key), false, 'queue emptied')
  t.is(seeder._proofCounts.get(d.key), MAX_PROOFS_PER_DIARY)

  // With nobody waiting, a closed connection frees its place.
  early.noise.destroy()
  await until(() => seeder._proofCounts.get(d.key) === MAX_PROOFS_PER_DIARY - 1, { name: 'closed connection released its proof' })
  const eighth = await tcpClient(t, srv.port)
  const eighthSide = await side(eighth)
  eighth.peer.send(proveMsg(eighth.noiseHex, d))
  await until(() => eighthSide.provenKey === d.key, { name: 'place taken again' })
  t.is(seeder._proofCounts.get(d.key), MAX_PROOFS_PER_DIARY)
})

test('slots: external streams share maxExternal by address; without onRefuse a displaced stream is destroyed', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const { seeder, events } = await startSeeder(t, bootstrap, { maxExternal: 2, probationMs: 60000 })
  const raws = []
  const plain = (address) => {
    const server = net.createServer((raw) => {
      raws.push({ address, raw })
      seeder.acceptStream(raw, { address })
    })
    t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  }
  const portA = await plain('2001:db8:1:1::5')
  const portB = await plain('2001:db8:2:1::5')
  const dial = (port) => {
    const s = net.connect(port, '127.0.0.1')
    s.on('error', () => {})
    t.teardown(() => s.destroy(), { force: true })
    return s
  }
  const closed = (s) => s.destroyed ? Promise.resolve() : new Promise((resolve) => s.once('close', resolve))

  dial(portA)
  await until(() => seeder.stats().external === 1, { name: 'A1' })
  const a2 = dial(portA)
  await until(() => seeder.stats().external === 2, { name: 'A2' })
  t.is(seeder._externalSlots.count('2001:db8:1:1::/64'), 2, 'IPv6 grouped by /64')

  // Both A streams are in probation (60 s): the fair share still applies.
  dial(portB)
  await until(() => displaced(events).length === 1, { name: 'displaced by the other address' })
  await closed(a2)
  t.ok(raws[1].raw.destroyed, 'the newest A stream was destroyed')
  t.is(displaced(events)[0].peerKey, null, 'no Noise key before the handshake')
  t.is(seeder.stats().external, 2)

  // One slot each, A1 in probation: a third A stream is refused.
  const a3 = dial(portA)
  await closed(a3)
  t.is(limited(events).length, 1, 'refused with connection-limit')
  t.is(seeder._externalSlots.count('2001:db8:1:1::/64'), 1)
  t.is(seeder._externalSlots.count('2001:db8:2:1::/64'), 1)
})

test('slots: a limit set below 1 at run time counts as 1', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const { seeder, events } = await startSeeder(t, bootstrap, { maxExternal: 2, probationMs: 60000 })
  seeder.maxExternal = 0
  const server = net.createServer((raw) => seeder.acceptStream(raw, { address: '192.0.2.30' }))
  t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const dial = () => {
    const s = net.connect(port, '127.0.0.1')
    s.on('error', () => {})
    t.teardown(() => s.destroy(), { force: true })
    return s
  }
  dial()
  await until(() => seeder.stats().external === 1, { name: 'one stream admitted' })
  const second = dial()
  await new Promise((resolve) => second.once('close', resolve))
  t.is(limited(events).length, 1, 'the next one is refused, nothing throws')
  t.is(seeder.stats().external, 1)
})
