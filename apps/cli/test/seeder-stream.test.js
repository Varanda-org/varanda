const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const crypto = require('node:crypto')
const b4a = require('b4a')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { Duplex } = require('node:stream')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder, MAX_HANDSHAKE_FRAME, MAX_HANDSHAKE_BYTES, MAX_EXTERNAL_FRAME } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair, seederCertForKey } = require('@varanda/core/lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission, generateNoiseKeyPair } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord } = require('@varanda/core/lib/records')

function hex (buf) {
  return b4a.toString(buf, 'hex')
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

function newSeeder (t, bootstrap, dataDir, opts = {}) {
  const events = []
  const { onlog, ...rest } = opts
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    log: (e) => {
      events.push(e)
      if (onlog) onlog(e)
    },
    ...rest
  })
  t.teardown(() => seeder.close(), { force: true })
  return { seeder, events }
}

async function startSeeder (t, bootstrap, dataDir, opts) {
  const s = newSeeder(t, bootstrap, dataDir, opts)
  s.ready = await s.seeder.start()
  return s
}

// A loopback TCP server whose connections are handed to seeder.acceptStream.
async function streamServer (t, seeder, opts) {
  const accepted = []
  const server = net.createServer((socket) => {
    accepted.push({ raw: socket, noise: seeder.acceptStream(socket, opts) })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
  return { server, port: server.address().port, accepted }
}

function rawConnect (t, port) {
  const tcp = net.connect(port, '127.0.0.1')
  tcp.on('error', () => {})
  t.teardown(() => tcp.destroy(), { force: true })
  return tcp
}

function closed (stream) {
  if (stream.destroyed) return Promise.resolve()
  return new Promise((resolve) => stream.once('close', resolve))
}

// A near-16 KiB block (the records cap is MAX_BLOCK_BYTES = 16384; only
// block 0 is validated by the seeder, so the post may exceed MAX_TEXT).
function bigPost () {
  return { type: 'post', text: 'x'.repeat(16200), at: new Date().toISOString() }
}

// A secret-stream frame header: 3-byte little-endian length.
function frameHeader (len) {
  return b4a.from([len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff])
}

// A member over the external transport: its own diary (member certificate,
// one post and one near-16 KiB post), a Noise initiator over TCP and an
// admission channel.
async function streamMember (t, port, assoc) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const core = store.get({ name: 'diary', valueEncoding: 'json' })
  await core.ready()
  const key = hex(core.key)
  await core.append(memberCertRecord(createCert({ member: key }, assoc.kp)))
  await core.append(postRecord({ text: 'x' }))
  await core.append(bigPost())

  const tcp = rawConnect(t, port)
  const noise = new NoiseSecretStream(true, tcp, { keyPair: generateNoiseKeyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  const messages = []
  const peer = await new Promise((resolve, reject) => {
    const onclose = () => reject(new Error('stream fechado antes do handshake'))
    noise.once('close', onclose)
    noise.once('connect', () => {
      noise.off('close', onclose)
      store.replicate(noise)
      resolve(attachAdmission(noise, {
        role: 'member',
        have: [{ key, length: core.length }],
        onmessage: (msg) => messages.push(msg)
      }))
    })
  })
  const message = (pred, name, timeoutMs = 20000) => until(() => messages.find(pred), { name, timeoutMs })
  return { store, core, key, tcp, noise, peer, messages, message }
}

// A swarm member client (as in seeder.test.js) that follows a key.
async function swarmClient (t, bootstrap, assoc, { follow = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  let core = null
  if (follow) {
    core = store.get({ key: b4a.from(follow, 'hex') })
    await core.ready()
  }
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { force: true })
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [] }))
  })
  await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  return { store, swarm, core, peers, seederPeer }
}

test('acceptStream: a member over a raw stream is admitted and served to swarm members', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const { port } = await streamServer(t, seeder)

  // Case 1: the seeder proves itself exactly as over the swarm.
  const member = await streamMember(t, port, assoc)
  const hello = await member.peer.hello
  t.ok(hello, 'hello received')
  t.is(hello.role, 'seeder')
  t.is(hex(member.noise.remotePublicKey), publicKey, 'Noise responder keyed with seeder-key.json')
  t.is(seederCertForKey(hello.cert, hex(member.noise.remotePublicKey), assoc.hex).ok, true)

  member.peer.send({ type: 'announce', key: member.key, cert: createCert({ member: member.key }, assoc.kp) })
  await member.message((m) => m.type === 'admitted' && m.key === member.key, 'admitted')
  await until(() => events.some((e) => e.event === 'have' && e.key === member.key && e.length === 3), { name: 'have 3' })
  t.ok(seeder.admittedKeys().includes(member.key), 'admitted key')
  t.ok(events.some((e) => e.event === 'peer' && e.role === 'member'), 'peer logged')

  // Case 2: the external member leaves; a swarm member reads through the seeder.
  member.noise.destroy()
  await closed(member.noise)
  await member.store.close()
  await until(() => seeder.stats().connections === 0, { name: 'externa encerrada' })

  const reader = await swarmClient(t, bootstrap, assoc, { follow: member.key })
  await reader.seederPeer()
  await reader.core.download({ start: 0, end: 3 }).done()
  t.is(reader.core.contiguousLength, 3, 'three blocks downloaded through the seeder')
  t.is(b4a.byteLength(JSON.stringify(await reader.core.get(2))) > 16000, true, 'the near-16 KiB block arrived')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('acceptStream: the connection cap counts swarm and external sockets', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)

  // Case 3a: maxConnections 1 with one swarm client connected.
  {
    const assoc = makeAssociation()
    const { dataDir } = prepareSeederDir(t, assoc)
    const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxConnections: 1 })
    const c = await swarmClient(t, bootstrap, assoc)
    await c.seederPeer()
    t.is(seeder.swarm.connections.size, 1)
    const { port, accepted } = await streamServer(t, seeder)
    const tcp = rawConnect(t, port)
    await until(() => accepted.length === 1, { name: 'aceita' })
    t.is(accepted[0].noise, null, 'acceptStream returned null')
    await closed(accepted[0].raw)
    t.ok(accepted[0].raw.destroyed, 'raw socket destroyed')
    await closed(tcp)
    t.ok(events.some((e) => e.event === 'peer-dropped' && e.peerKey === null && e.reason === 'connection-limit'), 'connection-limit logged')
    t.is(seeder.stats().connections, 1)
    await seeder.close()
  }

  // Case 3b: maxConnections 2: one swarm and one external socket both count
  // (its own association, so the case 3a client never joins this seeder).
  {
    const assoc = makeAssociation()
    const { dataDir } = prepareSeederDir(t, assoc)
    const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxConnections: 2 })
    const c = await swarmClient(t, bootstrap, assoc)
    await c.seederPeer()
    const { port } = await streamServer(t, seeder)
    const member = await streamMember(t, port, assoc)
    await member.peer.hello
    t.is(seeder.swarm.connections.size, 1)
    t.is(seeder.stats().connections, 2, 'swarm + external')
  }
})

test('acceptStream: external sockets are capped at half the connection limit', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxConnections: 4 })
  t.is(seeder.maxExternal, 2, 'maxExternal = floor(maxConnections / 2)')
  const { port, accepted } = await streamServer(t, seeder)

  // Two external streams (in-flight handshakes) take the whole sub-cap.
  rawConnect(t, port)
  rawConnect(t, port)
  await until(() => accepted.length === 2, { name: 'duas aceitas' })
  t.ok(accepted[0].noise && accepted[1].noise, 'two external streams accepted')
  t.is(seeder.stats().connections, 2)

  const third = rawConnect(t, port)
  await until(() => accepted.length === 3, { name: 'terceira' })
  t.is(accepted[2].noise, null, 'the third external stream is refused')
  await closed(accepted[2].raw)
  await closed(third)
  t.ok(events.some((e) => e.event === 'peer-dropped' && e.peerKey === null && e.reason === 'connection-limit'), 'connection-limit logged')
  t.is(seeder.stats().connections, 2, 'still two connections')

  // The remaining slots stay available to swarm peers.
  const c = await swarmClient(t, bootstrap, assoc)
  const peer = await c.seederPeer()
  t.ok(peer, 'a swarm client still connects')
  t.is(seeder.swarm.connections.size, 1)
  t.is(seeder.stats().connections, 3, 'two external + one swarm')
})

// A loopback TCP server whose connections are handed to seeder.acceptStream
// with the onRefuse handoff; each refusal records whether the raw socket was
// still alive when the hook ran and once acceptStream returned. The test then
// owns the refused socket and destroys it itself.
async function handoffServer (t, seeder) {
  const accepted = []
  const server = net.createServer((socket) => {
    const entry = { raw: socket, refusal: null, aliveAfterReturn: null }
    accepted.push(entry)
    entry.noise = seeder.acceptStream(socket, {
      onRefuse: (info) => { entry.refusal = { ...info, aliveAtCall: !socket.destroyed } }
    })
    if (entry.refusal) entry.aliveAfterReturn = !socket.destroyed
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
  return { port: server.address().port, accepted }
}

test('acceptStream onRefuse: at the external cap the handoff fires and the raw stream is left to the caller', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxConnections: 4 })
  t.is(seeder.maxExternal, 2)
  const { port, accepted } = await handoffServer(t, seeder)

  // One admitted member and one in-flight handshake take the sub-cap.
  const member = await streamMember(t, port, assoc)
  await member.peer.hello
  rawConnect(t, port)
  await until(() => accepted.length === 2, { name: 'duas aceitas' })
  t.ok(accepted[0].noise && accepted[1].noise, 'two external streams accepted')
  t.is(accepted[0].refusal, null, 'no handoff for admitted streams')

  const third = rawConnect(t, port)
  await until(() => accepted.length === 3, { name: 'terceira' })
  const refused = accepted[2]
  t.is(refused.noise, null, 'the third external stream is refused')
  t.alike(refused.refusal, { reason: 'connection-limit', aliveAtCall: true }, 'handoff called with the raw stream alive')
  t.is(refused.aliveAfterReturn, true, 'acceptStream did not destroy the raw stream')
  t.ok(events.some((e) => e.event === 'peer-dropped' && e.peerKey === null && e.reason === 'connection-limit'), 'connection-limit logged')
  t.is(seeder.stats().connections, 2, 'the refused stream takes no slot')

  refused.raw.destroy()
  await closed(third)
  t.is(seeder.stats().connections, 2, 'still two connections after the caller closed it')
  t.absent(member.noise.destroyed, 'the admitted member stays connected')
  member.peer.send({ type: 'announce', key: member.key, cert: createCert({ member: member.key }, assoc.kp) })
  await member.message((m) => m.type === 'admitted' && m.key === member.key, 'admitted')
})

test('acceptStream onRefuse: at the total cap the handoff fires; swarm and external peers stay connected', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxConnections: 2, maxExternal: 2 })
  const c = await swarmClient(t, bootstrap, assoc)
  await c.seederPeer()
  const { port, accepted } = await handoffServer(t, seeder)
  const member = await streamMember(t, port, assoc)
  await member.peer.hello
  t.is(seeder.stats().connections, 2, 'swarm + external fill the total cap')

  const extra = rawConnect(t, port)
  await until(() => accepted.length === 2, { name: 'segunda' })
  const refused = accepted[1]
  t.is(refused.noise, null, 'refused below maxExternal because the total cap is full')
  t.alike(refused.refusal, { reason: 'connection-limit', aliveAtCall: true })
  t.is(refused.aliveAfterReturn, true, 'acceptStream did not destroy the raw stream')
  refused.raw.destroy()
  await closed(extra)
  t.is(seeder.stats().connections, 2)
  t.is(seeder.swarm.connections.size, 1, 'the swarm peer stays connected')
  t.absent(member.noise.destroyed, 'the external member stays connected')
})

test('acceptStream onRefuse: not-ready refusals still destroy the raw stream without the handoff', async (t) => {
  t.timeout(30000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = newSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const { port, accepted } = await handoffServer(t, seeder)
  const tcp = rawConnect(t, port)
  await until(() => accepted.length === 1, { name: 'aceita' })
  t.is(accepted[0].noise, null)
  t.is(accepted[0].refusal, null, 'no handoff when the seeder is not ready')
  t.ok(accepted[0].raw.destroyed, 'raw socket destroyed')
  await closed(tcp)
})

test('acceptStream: a stream that never completes the handshake is destroyed at the deadline', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const { port, accepted } = await streamServer(t, seeder, { handshakeTimeoutMs: 500 })

  // Case 4: 64 random bytes, then silence.
  const tcp = rawConnect(t, port)
  await new Promise((resolve) => tcp.once('connect', resolve))
  const started = Date.now()
  tcp.write(crypto.randomBytes(64))
  await until(() => accepted.length === 1, { name: 'aceita' })
  t.ok(accepted[0].noise, 'wrapped')
  await until(() => accepted[0].raw.destroyed && accepted[0].noise.destroyed, { name: 'destruída', timeoutMs: 5000 })
  const elapsed = Date.now() - started
  t.ok(elapsed < 3000, 'destroyed near the deadline (' + elapsed + ' ms)')
  await closed(tcp)
  await until(() => seeder.stats().connections === 0, { name: 'contagem zerada' })
})

test('acceptStream before start() refuses the stream', async (t) => {
  t.timeout(30000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = newSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // Case 5: not started.
  const accepted = []
  const server = net.createServer((socket) => {
    accepted.push({ raw: socket, noise: seeder.acceptStream(socket) })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
  const tcp = rawConnect(t, server.address().port)
  await until(() => accepted.length === 1, { name: 'aceita' })
  t.is(accepted[0].noise, null)
  t.ok(accepted[0].raw.destroyed, 'raw socket destroyed')
  await closed(tcp)
  t.is(seeder.stats().connections, 0)
})

test('acceptStream: the frame guard drops oversized or excessive frames', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const { port, accepted } = await streamServer(t, seeder)
  const frameLimits = () => events.filter((e) => e.event === 'peer-dropped' && e.reason === 'frame-limit')

  // (i) `ff ff ff 00` before the handshake: a 16 MiB frame declared by an
  // anonymous client is dropped at once, well before handshakeTimeoutMs.
  {
    const tcp = rawConnect(t, port)
    await new Promise((resolve) => tcp.once('connect', resolve))
    await until(() => accepted.length === 1, { name: 'aceita' })
    const started = Date.now()
    tcp.write(b4a.from([0xff, 0xff, 0xff, 0x00]))
    await until(() => accepted[0].raw.destroyed && accepted[0].noise.destroyed, { name: 'destruída', timeoutMs: 5000 })
    t.ok(Date.now() - started < 2000, 'dropped promptly, not at the handshake deadline')
    await closed(tcp)
    t.is(frameLimits().length, 1, 'frame-limit logged')
    t.is(frameLimits()[0].peerKey, null, 'no peer key before the handshake')
    await until(() => seeder.stats().connections === 0, { name: 'contagem zerada' })
  }

  // (ii-a) an oversized second handshake frame: a well-formed msg1 followed
  // by a frame declaring MAX_HANDSHAKE_FRAME + 1 bytes, in one write, so the
  // chunk is refused before any of it (msg1 included) is forwarded.
  {
    t.is(MAX_HANDSHAKE_BYTES, 2 * (3 + MAX_HANDSHAKE_FRAME), 'handshake bytes derive from the per-frame limit')
    const tcp = rawConnect(t, port)
    await new Promise((resolve) => tcp.once('connect', resolve))
    await until(() => accepted.length === 2, { name: 'aceita' })
    const started = Date.now()
    tcp.write(b4a.concat([
      frameHeader(32), crypto.randomBytes(32),
      frameHeader(MAX_HANDSHAKE_FRAME + 1), crypto.randomBytes(1)
    ]))
    await until(() => accepted[1].raw.destroyed && accepted[1].noise.destroyed, { name: 'destruída', timeoutMs: 5000 })
    t.ok(Date.now() - started < 2000, 'dropped promptly')
    await closed(tcp)
    t.is(frameLimits().length, 2, 'frame-limit logged for the oversized handshake frame')
    t.is(frameLimits()[1].peerKey, null)
    await until(() => seeder.stats().connections === 0, { name: 'contagem zerada' })
  }

  // (ii-b) a third frame over MAX_EXTERNAL_FRAME right behind two
  // handshake-sized frames, in one write: post-handshake frames are judged
  // by the post-handshake limit at once, and the whole chunk is refused
  // (the random msg3 never reaches the secret stream, so the drop is
  // 'frame-limit', not a failed handshake).
  {
    const tcp = rawConnect(t, port)
    await new Promise((resolve) => tcp.once('connect', resolve))
    await until(() => accepted.length === 3, { name: 'aceita' })
    const started = Date.now()
    tcp.write(b4a.concat([
      frameHeader(32), crypto.randomBytes(32),
      frameHeader(64), crypto.randomBytes(64),
      frameHeader(MAX_EXTERNAL_FRAME + 1), crypto.randomBytes(1)
    ]))
    await until(() => accepted[2].raw.destroyed && accepted[2].noise.destroyed, { name: 'destruída', timeoutMs: 5000 })
    t.ok(Date.now() - started < 2000, 'dropped promptly')
    await closed(tcp)
    t.is(frameLimits().length, 3, 'frame-limit logged for the oversized third frame')
    t.is(frameLimits()[2].peerKey, null, 'no peer key: the handshake never completed')
    await until(() => seeder.stats().connections === 0, { name: 'contagem zerada' })
  }

  // (iii) after a completed handshake a frame over MAX_EXTERNAL_FRAME is
  // dropped and the drop names the peer (never an address).
  {
    const member = await streamMember(t, port, assoc)
    const hello = await member.peer.hello
    t.is(hello.role, 'seeder', 'handshake and hello completed')
    t.is(frameLimits().length, 3, 'legitimate frames pass')
    member.tcp.write(b4a.concat([frameHeader(MAX_EXTERNAL_FRAME + 1), crypto.randomBytes(1)]))
    await until(() => accepted[3].raw.destroyed && accepted[3].noise.destroyed, { name: 'destruída', timeoutMs: 5000 })
    await closed(member.noise)
    t.is(frameLimits().length, 4, 'frame-limit logged after the handshake')
    t.is(frameLimits()[3].peerKey, hex(member.noise.publicKey), 'peer key of the handshaken member')
    t.is(JSON.stringify(frameLimits()).includes('127.0.0.1'), false, 'no address logged')
    await until(() => seeder.stats().connections === 0, { name: 'contagem zerada' })
    t.is(events.filter((e) => e.event === 'fatal').length, 0)
  }
})

// The initiator side of a TCP socket that makes coalescing deterministic:
// its first write (msg1) passes through, every later write (msg3 onward) is
// queued until at least `threshold` bytes beyond msg3 are waiting, and then
// everything queued goes out as ONE socket write (kept in `flushed`); later
// writes pass through again. Incoming bytes pass through unchanged. A Node
// Duplex, as net.Socket is.
class CoalescingSocket extends Duplex {
  constructor (tcp, threshold) {
    super()
    this._tcp = tcp
    this._threshold = threshold
    this._writes = 0
    this._queue = []
    this._queued = 0
    this.flushed = null
    tcp.on('data', (chunk) => { if (this.push(chunk) === false) tcp.pause() })
    tcp.on('end', () => this.push(null))
    tcp.on('error', (err) => this.destroy(err))
    tcp.on('close', () => this.destroy())
  }

  _write (data, encoding, cb) {
    if (this._writes++ === 0 || this.flushed !== null) {
      this._tcp.write(data)
      return cb(null)
    }
    this._queue.push(b4a.from(data))
    this._queued += data.byteLength
    if (this._queued >= this._threshold) {
      this.flushed = b4a.concat(this._queue)
      this._queue = null
      this._tcp.write(this.flushed)
    }
    cb(null)
  }

  _read () {
    this._tcp.resume()
  }

  _final (cb) {
    this._tcp.end()
    cb(null)
  }

  _destroy (err, cb) {
    this._tcp.destroy()
    cb(err)
  }
}

test('acceptStream: post-handshake bytes coalesced with msg3 are accepted (regression)', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const { port, accepted } = await streamServer(t, seeder)
  const frameLimits = () => events.filter((e) => e.event === 'peer-dropped' && e.reason === 'frame-limit')

  // A member replicating its diary plus FILLER cores: corestore opens one
  // protomux channel per core right after 'connect' (the opens are ~86
  // bytes each), so its first post-handshake traffic is well over 16 KiB.
  const FILLER = 520
  const MSG3_FRAME = 3 + 64 // measured: msg3 (`s, se`) is 64 bytes
  const POST_HANDSHAKE_MIN = 40 * 1024
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const core = store.get({ name: 'diary', valueEncoding: 'json' })
  await core.ready()
  const key = hex(core.key)
  await core.append(memberCertRecord(createCert({ member: key }, assoc.kp)))
  await core.append(postRecord({ text: 'x' }))
  await core.append(bigPost())
  const fillers = []
  for (let i = 0; i < FILLER; i++) fillers.push(store.get({ name: 'filler-' + i }))
  await Promise.all(fillers.map((c) => c.ready()))

  const tcp = rawConnect(t, port)
  await new Promise((resolve) => tcp.once('connect', resolve))
  await until(() => accepted.length === 1, { name: 'aceita' })
  const chunks = []
  accepted[0].raw.on('data', (chunk) => chunks.push(chunk.byteLength))

  const raw = new CoalescingSocket(tcp, MSG3_FRAME + POST_HANDSHAKE_MIN)
  raw.on('error', () => {})
  const noise = new NoiseSecretStream(true, raw, { keyPair: generateNoiseKeyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  const messages = []
  const peer = await new Promise((resolve, reject) => {
    const onclose = () => reject(new Error('stream fechado antes do handshake'))
    noise.once('close', onclose)
    noise.once('connect', () => {
      noise.off('close', onclose)
      store.replicate(noise)
      resolve(attachAdmission(noise, {
        role: 'member',
        have: [{ key, length: core.length }],
        onmessage: (msg) => messages.push(msg)
      }))
    })
  })

  await until(() => raw.flushed !== null, { name: 'escrita única' })
  t.ok(b4a.equals(raw.flushed.subarray(0, 3), frameHeader(64)), 'the single write starts with msg3')
  t.ok(raw.flushed.byteLength - MSG3_FRAME >= POST_HANDSHAKE_MIN, 'over 40 KiB of post-handshake bytes behind msg3 (' + raw.flushed.byteLength + ')')

  const hello = await peer.hello
  t.is(frameLimits().length, 0, 'no frame-limit drop')
  t.ok(hello, 'hello received')
  t.is(hello.role, 'seeder')
  // The former 16 KiB pre-'connect' budget would have refused this chunk.
  t.ok(chunks[1] > 16 * 1024, 'msg3 reached the seeder in one chunk with its post-handshake bytes (' + chunks.slice(0, 3).join(', ') + ')')

  peer.send({ type: 'announce', key, cert: createCert({ member: key }, assoc.kp) })
  await until(() => messages.find((m) => m.type === 'admitted' && m.key === key), { name: 'admitted', timeoutMs: 20000 })
  await until(() => events.some((e) => e.event === 'have' && e.key === key && e.length === 3), { name: 'have 3' })
  t.ok(seeder.admittedKeys().includes(key), 'admitted key')
  t.is(frameLimits().length, 0, 'still no frame-limit drop')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('acceptStream: a stream that ends before the handshake releases its slot at once', async (t) => {
  t.timeout(30000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // A half-open raw duplex (like ws's createWebSocketStream after the
  // WebSocket closed): its readable side ends, it never emits 'close' itself.
  const raw = new Duplex({ allowHalfOpen: true, read () {}, write (chunk, enc, cb) { cb() } })
  raw.on('error', () => {})
  t.teardown(() => raw.destroy(), { force: true })
  const noise = seeder.acceptStream(raw) // default 10 s handshake deadline
  t.ok(noise, 'accepted')
  t.is(seeder.stats().connections, 1, 'counted while open')
  const started = Date.now()
  raw.push(null)
  await until(() => noise.destroyed && seeder.stats().connections === 0, { name: 'vaga liberada', timeoutMs: 5000 })
  const elapsed = Date.now() - started
  t.ok(elapsed < 2000, 'slot released well before the handshake deadline (' + elapsed + ' ms)')
})

test('acceptStream: a peer that goes silent after the handshake is dropped at the idle deadline', async (t) => {
  t.timeout(30000)
  const Hypercore = require('hypercore')
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, externalIdleMs: 500 })
  const { port, accepted } = await streamServer(t, seeder)

  // A client with no Hypercore keep-alive: one admission hello, then silence.
  const tcp = rawConnect(t, port)
  const noise = new NoiseSecretStream(true, tcp, { keyPair: generateNoiseKeyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  let helloSeen = false
  noise.once('connect', () => {
    Hypercore.createProtocolStream(noise, { keepAlive: false })
    attachAdmission(noise, { role: 'member', have: [], onmessage: (msg) => { if (msg.type === 'hello') helloSeen = true } })
  })
  await until(() => helloSeen, { name: 'hello do semeador' })
  t.is(seeder.stats().connections, 1, 'the silent peer holds a slot for now')
  const started = Date.now()
  await until(() => accepted[0].noise.destroyed && seeder.stats().connections === 0, { name: 'vaga liberada', timeoutMs: 5000 })
  const elapsed = Date.now() - started
  t.ok(elapsed < 3000, 'dropped near the 500 ms idle deadline (' + elapsed + ' ms)')
})
