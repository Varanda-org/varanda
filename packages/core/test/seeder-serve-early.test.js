// External streams (acceptStream) are served from the accepting point of
// Seeder#start, once every core is re-gated and prepared and the swarm
// exists, while the DHT join and flush still run. stats().status stays
// 'starting' until start() completes. The flush is held with the test-only
// flushHook option.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('../lib/cert')
const { attachAdmission, generateNoiseKeyPair } = require('../lib/net')
const { createSnapshot } = require('../lib/blocklist')
const { writeBlocklist } = require('../lib/store')
const { memberCertRecord, postRecord } = require('../lib/records')

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

function newSeeder (t, bootstrap, dataDir, opts) {
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), ...opts })
  t.teardown(() => seeder.close(), { force: true })
  return { seeder, events }
}

// A gate the test opens: `reached` resolves when the hook runs, `release`
// lets it return (or throw, with fail = true).
function gate (t, { fail = false } = {}) {
  let release
  let reached
  const opened = new Promise((resolve) => { release = resolve })
  const hit = new Promise((resolve) => { reached = resolve })
  t.teardown(() => release(), { order: -1 })
  return {
    hook: async () => {
      reached()
      await opened
      if (fail) throw new Error('flush falhou (teste)')
    },
    reached: hit,
    release: () => release()
  }
}

async function streamServer (t, seeder) {
  const accepted = []
  const server = net.createServer((socket) => {
    const entry = { raw: socket, noise: null, refusals: [] }
    accepted.push(entry)
    entry.noise = seeder.acceptStream(socket, { onRefuse: (r) => entry.refusals.push(r) })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
  return { port: server.address().port, accepted }
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

async function clientStore (t) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  return store
}

// A diary in `store` with a member certificate and two posts.
async function diary (store, name, assoc) {
  const core = store.get({ name, valueEncoding: 'json' })
  await core.ready()
  const key = hex(core.key)
  await core.append(memberCertRecord(createCert({ member: key }, assoc.kp)))
  await core.append(postRecord({ text: 'um' }))
  await core.append(postRecord({ text: 'dois' }))
  return { core, key }
}

// A member over the external transport: a Noise initiator over TCP whose
// store replicates and which opens the admission channel.
async function streamMember (t, port, store) {
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
      resolve(attachAdmission(noise, { role: 'member', have: [], onmessage: (msg) => messages.push(msg) }))
    })
  })
  const message = (pred, name) => until(() => messages.find(pred), { name, timeoutMs: 30000 })
  return { tcp, noise, peer, messages, message }
}

// Copies blocks of a local core into the (stopped) seeder's main store and
// lists it in admitted.json.
async function preloadAdmitted (dataDir, srcStore, key, length, cert) {
  const store = new Corestore(path.join(dataDir, 'store'))
  await store.ready()
  const replica = store.get({ key: b4a.from(key, 'hex') })
  await replica.ready()
  const s1 = srcStore.replicate(true)
  const s2 = store.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  await replica.download({ start: 0, end: length }).done()
  s1.destroy()
  s2.destroy()
  await store.close()
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({ v: 1, admitted: { [key]: cert } }))
}

test('flush held: accepting, still starting, and an external stream reads an admitted diary', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const src = await clientStore(t)
  const author = await diary(src, 'author', assoc)
  await preloadAdmitted(dataDir, src, author.key, 3, createCert({ member: author.key }, assoc.kp))

  const flush = gate(t)
  const { seeder, events } = newSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, flushHook: flush.hook })
  const started = seeder.start()
  started.catch(() => {})
  await flush.reached

  t.ok(seeder.accepting(), 'accepting() while the flush is held')
  t.is(seeder.stats().status, 'starting', 'the health status is unchanged')
  t.absent(events.some((e) => e.event === 'ready'), 'no ready event yet')

  const { port, accepted } = await streamServer(t, seeder)
  const reader = await clientStore(t)
  const member = await streamMember(t, port, reader)
  t.ok(accepted[0].noise, 'acceptStream took the stream')
  t.is(hex(member.noise.remotePublicKey), publicKey, 'Noise responder keyed with seeder-key.json')
  const hello = await member.peer.hello
  t.is(hello.role, 'seeder', 'seeder hello over the external stream')
  const copy = reader.get({ key: b4a.from(author.key, 'hex'), valueEncoding: 'json' })
  await copy.ready()
  await copy.download({ start: 0, end: 3 }).done()
  t.is(copy.contiguousLength, 3, 'the admitted diary replicated while the flush is held')
  t.is((await copy.get(2)).text, 'dois')
  t.is(seeder.stats().status, 'starting', 'still starting after serving')

  flush.release()
  await started
  t.is(seeder.stats().status, 'ok')
  t.ok(seeder.accepting())
  const ready = events.find((e) => e.event === 'ready')
  t.ok(Number.isInteger(ready.phases.acceptingMs) && ready.phases.acceptingMs >= 0, 'acceptingMs is an integer >= 0')
  t.ok(ready.phases.acceptingMs <= ready.phases.totalMs, 'accepting comes before the flush ends')

  await seeder.close()
  t.absent(seeder.accepting(), 'accepting() is false after close()')
  t.is(seeder.stats().status, 'closing')
})

test('before the accepting point a stream is refused as before', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const store = gate(t)
  const { seeder } = newSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storeHook: store.hook })
  const { port, accepted } = await streamServer(t, seeder)

  const tcp0 = rawConnect(t, port)
  await until(() => accepted.length === 1, { name: 'aceita antes de start', timeoutMs: 30000 })
  t.is(accepted[0].noise, null, 'refused before start()')
  t.ok(accepted[0].raw.destroyed, 'raw socket destroyed')
  t.is(accepted[0].refusals.length, 0, 'no onRefuse handoff')
  await closed(tcp0)

  const started = seeder.start()
  started.catch(() => {})
  await store.reached
  t.absent(seeder.accepting(), 'not accepting while start() is before the swarm')
  const tcp1 = rawConnect(t, port)
  await until(() => accepted.length === 2, { name: 'aceita durante start', timeoutMs: 30000 })
  t.is(accepted[1].noise, null, 'refused before the accepting point')
  t.ok(accepted[1].raw.destroyed, 'raw socket destroyed')
  t.is(accepted[1].refusals.length, 0, 'no onRefuse handoff')
  await closed(tcp1)
  t.is(seeder.stats().connections, 0)

  store.release()
  await started
  t.ok(seeder.accepting())
})

test('flush held: a blocked or non-member diary is refused exactly as after ready', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const other = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const store = await clientStore(t)
  const blocked = await diary(store, 'blocked', assoc)
  const outsider = await diary(store, 'outsider', other)
  const date = '2026-06-01T00:00:00.000Z'
  const mod = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(mod.publicKey), date }, assoc.kp)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [blocked.key], revokedIssuers: [] }, mod, modCert))

  const flush = gate(t)
  const { seeder, events } = newSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, flushHook: flush.hook })
  const started = seeder.start()
  started.catch(() => {})
  await flush.reached
  const { port } = await streamServer(t, seeder)

  const announce = async (member, d, cert) => {
    member.peer.send({ type: 'announce', key: d.key, cert })
    const msg = await member.message((m) => m.key === d.key && (m.type === 'rejected' || m.type === 'admitted'), 'resposta ao anúncio')
    return { type: msg.type, reason: msg.reason }
  }
  const outsiderCert = createCert({ member: outsider.key }, other.kp)
  const blockedCert = createCert({ member: blocked.key }, assoc.kp)

  const early = await streamMember(t, port, store)
  const earlyBlocked = await announce(early, blocked, blockedCert)
  const earlyOutsider = await announce(early, outsider, outsiderCert)
  t.is(seeder.stats().status, 'starting', 'answered before ready')
  t.alike(earlyBlocked, { type: 'rejected', reason: 'blocked' })
  t.is(earlyOutsider.type, 'rejected', 'a certificate from another association is rejected')
  early.noise.destroy()
  await closed(early.noise)

  flush.release()
  await started
  t.is(seeder.stats().status, 'ok')
  const late = await streamMember(t, port, store)
  t.alike(await announce(late, blocked, blockedCert), earlyBlocked, 'blocked: same refusal after ready')
  t.alike(await announce(late, outsider, outsiderCert), earlyOutsider, 'non-member: same refusal after ready')
  t.absent(seeder.admittedKeys().includes(blocked.key))
  t.absent(seeder.admittedKeys().includes(outsider.key))
  t.absent(events.some((e) => e.event === 'have' && (e.key === blocked.key || e.key === outsider.key)), 'nothing was fetched')
})

test('a start that fails after the accepting point closes the external streams', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const flush = gate(t, { fail: true })
  const { seeder } = newSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, flushHook: flush.hook })
  const started = seeder.start()
  started.catch(() => {})
  await flush.reached
  const { port, accepted } = await streamServer(t, seeder)
  const store = await clientStore(t)
  const member = await streamMember(t, port, store)
  await member.peer.hello
  t.ok(accepted[0].noise, 'stream accepted while the flush is held')

  flush.release()
  await t.exception(started, /flush falhou/, 'start() rejects')
  await closed(member.noise)
  await closed(accepted[0].noise)
  t.ok(accepted[0].noise.destroyed, 'the external stream was closed by the failure cleanup')
  t.absent(seeder.accepting(), 'accepting() is false')
  t.is(seeder._accepting, false, 'the flag ended false')
  t.is(seeder.stats().connections, 0)
})
