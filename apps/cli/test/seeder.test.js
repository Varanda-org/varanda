const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const Corestore = require('corestore')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission, generateNoiseKeyPair } = require('@varanda/core/lib/net')
const { memberCertRecord, MAX_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { openReplica } = require('@varanda/core/lib/store')
const { localDay } = require('@varanda/core/lib/activity')
const { discoveryKey } = require('hypercore-crypto')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function post (text) {
  return { type: 'post', text, at: new Date().toISOString(), replyTo: null }
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function validCert (assoc, key) {
  return createCert({ member: key }, assoc.kp)
}

function validBlocks (assoc) {
  return (key) => [memberCertRecord(validCert(assoc, key)), post('um'), post('dois')]
}

function readAdmitted (dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'admitted.json'), 'utf8')).admitted
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
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

// A raw member client: its own core (blocks(key) as JSON records, or raw
// buffers), an admission channel per connection, and every received message.
async function client (t, bootstrap, assoc, { blocks = null, rawBlocks = null, follow = null, joinPeer = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  let core = null
  let key = null
  if (blocks || rawBlocks) {
    core = rawBlocks ? store.get({ name: 'diary' }) : store.get({ name: 'diary', valueEncoding: 'json' })
    await core.ready()
    key = hex(core.key)
    for (const b of (blocks || rawBlocks)(key)) await core.append(b)
  } else if (follow) {
    core = store.get({ key: b4a.from(follow, 'hex') })
    await core.ready()
  }
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    const have = key ? [{ key, length: core.length }] : []
    peers.push(attachAdmission(socket, { role: 'member', have, onmessage: (msg) => messages.push(msg) }))
  })
  if (joinPeer) swarm.joinPeer(b4a.from(joinPeer, 'hex'))
  else await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const message = (pred, name, timeoutMs = 20000) => until(() => messages.find(pred), { name, timeoutMs })
  return { store, swarm, core, key, messages, peers, seederPeer, message }
}

// Copies blocks of srcCore into the (stopped) seeder's main store directly.
async function preload (dataDir, srcStore, key, length) {
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
  return {
    replica,
    async close () {
      s1.destroy()
      s2.destroy()
      await store.close()
    }
  }
}

async function localStore (t) {
  const store = new Corestore(tmpDir(t, 'varanda-local-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  return store
}

async function localCore (store, name, records) {
  const core = store.get({ name, valueEncoding: 'json' })
  await core.ready()
  for (const r of records(hex(core.key))) await core.append(r)
  return core
}

function nothingWithin (core, ms) {
  return core.get(0, { timeout: ms }).then(() => false, () => true)
}

test('valid announce: admitted once, persisted before serving, then served', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const persistedAt = {}
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    onlog: (e) => {
      if ((e.event === 'admitted' || e.event === 'have') && !(e.event in persistedAt)) {
        persistedAt[e.event] = e.key in readAdmitted(dataDir)
      }
    }
  })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  const cert = validCert(assoc, author.key)
  // Two concurrent announces for the same key.
  peer.send({ type: 'announce', key: author.key, cert })
  peer.send({ type: 'announce', key: author.key, cert })

  await author.message((m) => m.type === 'admitted' && m.key === author.key, 'admitted')
  const have = await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3', 10000)
  t.is(have.length, 3)
  await until(() => author.messages.filter((m) => m.type === 'admitted').length === 2, { name: 'dois admitted' })

  t.is(events.filter((e) => e.event === 'admitted').length, 1, 'exactly one admission')
  t.is(persistedAt.admitted, true, 'admitted.json lists the key before the core is opened')
  t.is(persistedAt.have, true, 'admitted.json lists the key before any block is served')
  t.alike(seeder.admittedKeys(), [author.key])
  t.alike(readAdmitted(dataDir), { [author.key]: cert })
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
  t.alike(config, { v: 1, role: 'seeder', association: assoc.hex })
  t.absent(fs.existsSync(path.join(dataDir, 'pending.json')), 'no pending.json')
  t.ok(events.some((e) => e.event === 'peer' && e.role === 'member'))
})

test('active diaries: a newly admitted diary counts once its signed length arrives, counts only', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.is(seeder.stats().activeDay, 0)
  t.is(seeder.stats().activeWeek, 0)

  const dayBefore = localDay(Date.now())
  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert: validCert(assoc, author.key) })
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3', 10000)
  const first = seeder.stats()
  t.is(first.activeWeek, 1, 'grown this week')
  // The Brasília day may roll over mid-test; only then may activeDay be 0.
  if (localDay(Date.now()) === dayBefore) t.is(first.activeDay, 1, 'grown today')
  else t.ok(first.activeDay === 0 || first.activeDay === 1, 'day rolled over')

  // Growing again the same diary does not count it twice.
  await author.core.append(post('4'))
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 4, 'have 4', 10000)
  const second = seeder.stats()
  t.is(second.activeWeek, first.activeWeek, 'still one diary this week')
  t.is(second.activeDay, first.activeDay, 'still one diary today')
  t.absent(/[0-9a-f]{64}/i.test(JSON.stringify(seeder.stats())), 'no key in stats()')
})

test('announce rejections: bad certificates and bad block 0 are never kept', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const other = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  const rejectedFor = (c, key, reason) => c.message((m) => m.type === 'rejected' && m.key === key && m.reason === reason, reason)

  peer.send({ type: 'announce', key: author.key, cert: validCert(other, author.key) })
  await rejectedFor(author, author.key, 'untrusted-association')

  peer.send({ type: 'announce', key: author.key, cert: validCert(assoc, 'ab'.repeat(32)) })
  await rejectedFor(author, author.key, 'member-mismatch')

  // Block 0 is a post, announced with a valid certificate for the key.
  const poser = await client(t, bootstrap, assoc, { blocks: () => [post('não sou certificado'), post('x')] })
  const poserPeer = await poser.seederPeer()
  poserPeer.send({ type: 'announce', key: poser.key, cert: validCert(assoc, poser.key) })
  await rejectedFor(poser, poser.key, 'not-in-log')

  // Block 0 is raw non-JSON bytes.
  const garbage = await client(t, bootstrap, assoc, { rawBlocks: () => [b4a.from([0xff, 0x00, 0x7b, 0x22])] })
  const garbagePeer = await garbage.seederPeer()
  garbagePeer.send({ type: 'announce', key: garbage.key, cert: validCert(assoc, garbage.key) })
  await rejectedFor(garbage, garbage.key, 'not-in-log')

  t.alike(seeder.admittedKeys(), [])
  t.alike(readAdmitted(dataDir), {})
  t.is(events.filter((e) => e.event === 'admitted').length, 0)
  t.ok(events.some((e) => e.event === 'rejected' && e.key === poser.key && e.reason === 'not-in-log'))
})

test('an admission that fails after the gate is rolled back and re-gated on the next announce', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const gates = []
  let failStep = 'persist'
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    gateHook: async (key) => { gates.push(key) },
    admitHook: async (key, step) => {
      if (step === failStep) throw new Error('falha simulada em ' + step)
    }
  })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  const cert = validCert(assoc, author.key)
  const rejections = () => author.messages.filter((m) => m.type === 'rejected' && m.key === author.key && m.reason === 'admission-failed')

  // 1. persist throws (e.g. ENOSPC) after admitted.set: rolled back.
  peer.send({ type: 'announce', key: author.key, cert })
  await until(() => rejections().length === 1, { name: 'rejected admission-failed (persist)' })
  t.alike(seeder.admittedKeys(), [], 'key left the admitted map')
  t.alike(readAdmitted(dataDir), {}, 'key not persisted')
  t.is(events.filter((e) => e.event === 'rejected' && e.key === author.key && e.reason === 'admission-failed').length, 1)
  t.is(events.filter((e) => e.event === 'admitted').length, 0)
  t.is(gates.length, 1)

  // 2. openReplica throws after persist: rolled back, file rewritten.
  failStep = 'open'
  peer.send({ type: 'announce', key: author.key, cert })
  await until(() => rejections().length === 2, { name: 'rejected admission-failed (open)' })
  t.alike(seeder.admittedKeys(), [])
  t.alike(readAdmitted(dataDir), {}, 'best-effort persist removed the key again')
  t.is(gates.length, 2, 'the second announce ran the full gate again')

  // 3. Nothing fails: the next announce goes through the gate and is admitted.
  failStep = null
  peer.send({ type: 'announce', key: author.key, cert })
  await author.message((m) => m.type === 'admitted' && m.key === author.key, 'admitted')
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3')
  t.is(gates.length, 3)
  t.alike(seeder.admittedKeys(), [author.key])
  t.alike(readAdmitted(dataDir), { [author.key]: cert })
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

// S7: openReplica failing after the core was created in the main store must
// not leave a stored, servable core behind: the rollback purges it.
test('rollback after an open failure purges a core already stored in the main store', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const purged = []
  let failOpen = true
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    // The open step creates the core in the main store and then fails.
    admitHook: async (key, step) => {
      if (step !== 'open' || !failOpen) return
      const core = await openReplica(seeder.store, key)
      t.ok(await seeder.store.storage.hasCore(discoveryKey(core.key)), 'core stored before the failure')
      throw new Error('falha simulada depois de criar a réplica')
    },
    purgeHook: async (core) => {
      purged.push(hex(core.key))
      await core.purge()
    }
  })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  const cert = validCert(assoc, author.key)
  peer.send({ type: 'announce', key: author.key, cert })
  await until(() => purged.includes(author.key), { name: 'rollback purge' })
  await until(() => !(author.key in readAdmitted(dataDir)) && seeder.admittedKeys().length === 0, { name: 'rolled back' })
  t.alike(purged, [author.key], 'purged exactly once')
  t.is(await seeder.store.storage.hasCore(discoveryKey(b4a.from(author.key, 'hex'))), false, 'no stored core after the rollback')
  t.ok(events.some((e) => e.event === 'rejected' && e.key === author.key && e.reason === 'admission-failed'))
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
  t.is(events.filter((e) => e.event === 'admitted').length, 0)

  // A failing open step that never created the core purges nothing.
  failOpen = false
  const second = await startSeederIn(t, bootstrap, prepareSeederDir(t, assoc).dataDir, assoc, purged)
  const author2 = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  // Both seeders share the rendezvous: pick the second one by its Noise key.
  const secondKey = hex(second.seeder.swarm.keyPair.publicKey)
  const peer2 = await until(() => author2.peers.find((p) => p.remoteRole === 'seeder' && p.peerKey === secondKey), { name: 'second seeder' })
  peer2.send({ type: 'announce', key: author2.key, cert: validCert(assoc, author2.key) })
  await author2.message((m) => m.type === 'rejected' && m.key === author2.key && m.reason === 'admission-failed', 'admission-failed')
  t.alike(purged, [author.key], 'no purge for a core that was never stored')
  t.alike(second.seeder.admittedKeys(), [])
})

// A seeder whose admitHook('open') throws without creating the core.
async function startSeederIn (t, bootstrap, dataDir, assoc, purged) {
  return startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    admitHook: async (key, step) => { if (step === 'open') throw new Error('falha simulada') },
    purgeHook: async (core) => { purged.push(hex(core.key)); await core.purge() }
  })
}

test('rollback purge failure after an open failure is fatal and keeps the key listed', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    admitHook: async (key, step) => {
      if (step !== 'open') return
      await openReplica(first.seeder.store, key)
      throw new Error('falha simulada depois de criar a réplica')
    },
    purgeHook: async () => { throw new Error('falha simulada no purge') }
  })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert: validCert(assoc, author.key) })
  await first.seeder.closed
  t.ok(first.events.some((e) => e.event === 'fatal' && e.key === author.key && e.reason === 'purge-failed'))
  t.ok(author.key in readAdmitted(dataDir), 'key stays listed for the next start')
  t.absent(first.events.some((e) => e.event === 'rejected' && e.key === author.key), 'no admission-failed reply: the seeder closed instead')
  await author.swarm.destroy()

  // The next start re-gates the stored (empty) core and purges it.
  const second = await startSeeder(t, bootstrap, dataDir)
  t.ok(second.events.some((e) => e.event === 'rejected' && e.key === author.key && e.reason === 'no-cert'))
  t.alike(second.ready.admitted, [])
  t.alike(readAdmitted(dataDir), {})
})

test('quota (S3): oversized block 0, an over-limit log at the gate and growth past a limit', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxLogBlocks: 4 })
  const rejectedFor = (c, key, reason) => c.message((m) => m.type === 'rejected' && m.key === key && m.reason === reason, reason)

  // 1. Block 0 over MAX_BLOCK_BYTES is never parsed: not-in-log.
  const big = await client(t, bootstrap, assoc, { rawBlocks: () => [b4a.from('{"type":"member-cert","pad":"' + 'x'.repeat(MAX_BLOCK_BYTES) + '"}')] })
  const bigPeer = await big.seederPeer()
  bigPeer.send({ type: 'announce', key: big.key, cert: validCert(assoc, big.key) })
  await rejectedFor(big, big.key, 'not-in-log')

  // 2. A log already over maxLogBlocks is refused at the gate with 'quota'
  // (the signed length comes with block 0), nothing opened in the main store.
  const long = await client(t, bootstrap, assoc, { blocks: (key) => [memberCertRecord(validCert(assoc, key)), post('1'), post('2'), post('3'), post('4')] })
  const longPeer = await long.seederPeer()
  longPeer.send({ type: 'announce', key: long.key, cert: validCert(assoc, long.key) })
  await rejectedFor(long, long.key, 'quota')
  t.ok(events.some((e) => e.event === 'rejected' && e.key === long.key && e.reason === 'quota'))
  t.is(await seeder.store.storage.hasCore(discoveryKey(b4a.from(long.key, 'hex'))), false, 'never opened in the main store')
  t.alike(seeder.admittedKeys(), [])

  // 3. An admitted log (3 blocks) that grows past the limit is dropped with
  // 'quota' through the drop + purge path (admitted.json updated).
  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert: validCert(assoc, author.key) })
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3')
  t.alike(seeder.admittedKeys(), [author.key])
  await author.core.append(post('4'))
  await author.core.append(post('5'))
  await rejectedFor(author, author.key, 'quota')
  t.ok(events.some((e) => e.event === 'rejected' && e.key === author.key && e.reason === 'quota'))
  await until(() => !(author.key in readAdmitted(dataDir)), { name: 'admitted.json sem a chave' })
  t.alike(seeder.admittedKeys(), [])
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
  t.absent(events.some((e) => e.event === 'have' && e.key === author.key && e.length > 4), 'never served past the limit')

  // 4. The byte limit works the same way at the gate.
  const bytes = await startSeeder(t, bootstrap, prepareSeederDir(t, assoc).dataDir, { associationKey: assoc.hex, maxLogBytes: 100 })
  const author2 = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer2 = await until(() => author2.peers.find((p) => p.remoteRole === 'seeder' && p.peerKey === hex(bytes.seeder.swarm.keyPair.publicKey)), { name: 'second seeder' })
  peer2.send({ type: 'announce', key: author2.key, cert: validCert(assoc, author2.key) })
  await rejectedFor(author2, author2.key, 'quota')
  t.alike(bytes.seeder.admittedKeys(), [])
})

test('item 1: announce flood during a slow gate keeps the per-key queue bounded; admitted once', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  let releaseGate
  const gateHeld = new Promise((resolve) => { releaseGate = resolve })
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    gateHook: () => gateHeld,
    maxAnnounces: 3,
    announceBurst: 100000 // this test floods on purpose (rate limit: H3 test)
  })
  // Never leave the gate held: close() waits for the running admission.
  t.teardown(() => releaseGate(), { order: -1, force: true })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  const authorKey = hex(author.swarm.keyPair.publicKey)
  const seen = await until(() => [...seeder._peers].find((p) => p.peerKey === authorKey), { name: 'author peer on the seeder' })
  const cert = validCert(assoc, author.key)
  // 1000 floods the per-key queue and still fits the per-connection message
  // burst on both ends (lib/net.js MESSAGE_BURST, sender pacing).
  for (let i = 0; i < 1000; i++) peer.send({ type: 'announce', key: author.key, cert })
  // A bad certificate is answered synchronously, never queued.
  peer.send({ type: 'announce', key: author.key, cert: validCert(makeAssociation(), author.key) })
  await author.message((m) => m.type === 'rejected' && m.reason === 'untrusted-association', 'sync rejection')
  const other = await client(t, bootstrap, assoc)
  const otherPeer = await other.seederPeer()
  for (let i = 0; i < 5; i++) otherPeer.send({ type: 'announce', key: author.key, cert })
  await until(() => seeder._chains.get(author.key) && seeder._chains.get(author.key).queued && seeder._chains.get(author.key).queued.waiters.size === 1, { name: 'bounded queue' })
  const chain = seeder._chains.get(author.key)
  t.ok(chain.running, 'one admission running')
  t.is(chain.queued.waiters.size, 1, 'one waiter slot per peer')
  t.is(seen.announced.size, 1, 'one outstanding key for the flooding peer')

  releaseGate()
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3')
  await until(() => !seeder._chains.has(author.key), { name: 'queue drained' })
  t.is(events.filter((e) => e.event === 'admitted').length, 1, 'admitted once')
  t.ok(author.messages.filter((m) => m.type === 'admitted').length >= 2, 'running and queued announces answered')
  await other.message((m) => m.type === 'admitted' && m.key === author.key, 'waiter answered')
  t.is(seen.announced.size, 0)

  // Per-peer bound: more than maxAnnounces distinct keys outstanding drops the peer.
  const flood = await client(t, bootstrap, assoc)
  const floodPeer = await flood.seederPeer()
  const keys = []
  for (let i = 0; i < 4; i++) {
    const k = hex(require('node:crypto').randomBytes(32))
    keys.push(k)
    floodPeer.send({ type: 'announce', key: k, cert: validCert(assoc, k) })
  }
  await until(() => events.some((e) => e.event === 'peer-dropped' && e.reason === 'announce-limit'), { name: 'announce-limit' })
})

test('item 4a: a seeder serving maxServed logs refuses the next admission with seeder-full', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxServed: 1 })
  const a1 = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const p1 = await a1.seederPeer()
  p1.send({ type: 'announce', key: a1.key, cert: validCert(assoc, a1.key) })
  await a1.message((m) => m.type === 'admitted' && m.key === a1.key, 'admitted')
  const a2 = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const p2 = await a2.seederPeer()
  p2.send({ type: 'announce', key: a2.key, cert: validCert(assoc, a2.key) })
  await a2.message((m) => m.type === 'rejected' && m.key === a2.key && m.reason === 'seeder-full', 'seeder-full')
  t.alike(seeder.admittedKeys(), [a1.key])
  p1.send({ type: 'announce', key: a1.key, cert: validCert(assoc, a1.key) })
  await until(() => a1.messages.filter((m) => m.type === 'admitted').length === 2, { name: 'idempotent answer still works' })
})

test('H3: an announce flood over the per-peer rate drops the peer before any verify', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, announceRate: 1, announceBurst: 3 })
  const flood = await client(t, bootstrap, assoc)
  const peer = await flood.seederPeer()
  const key = hex(require('node:crypto').randomBytes(32))
  // Random signature, right shape: passes validateMessage, fails certForKey.
  const cert = { ...validCert(assoc, key), sig: 'ab'.repeat(64) }
  for (let i = 0; i < 10; i++) peer.send({ type: 'announce', key, cert })
  await until(() => events.some((e) => e.event === 'peer-dropped' && e.reason === 'announce-rate'), { name: 'announce-rate' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(events.filter((e) => e.event === 'rejected' && e.key === key).length, 3, 'only the burst was verified')
  t.is(events.filter((e) => e.event === 'peer-dropped').length, 1)
})

test('H3: a peer whose certificates keep failing is dropped after maxBadAnnounces', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxBadAnnounces: 4 })
  const bad = await client(t, bootstrap, assoc)
  const peer = await bad.seederPeer()
  const key = hex(require('node:crypto').randomBytes(32))
  const cert = { ...validCert(assoc, key), sig: 'cd'.repeat(64) }
  for (let i = 0; i < 10; i++) peer.send({ type: 'announce', key, cert })
  await until(() => events.some((e) => e.event === 'peer-dropped' && e.reason === 'bad-announces'), { name: 'bad-announces' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(events.filter((e) => e.event === 'rejected' && e.key === key).length, 4, 'no verify after the drop')
  t.ok(Seeder.MAX_BAD_ANNOUNCES === 16 && Seeder.ANNOUNCE_RATE === 10 && Seeder.ANNOUNCE_BURST === 20, 'default limits')
})

test('M1: two concurrent admissions at maxServed - 1 admit exactly one', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  let releaseGate
  const gateHeld = new Promise((resolve) => { releaseGate = resolve })
  t.teardown(() => releaseGate(), { order: -1, force: true })
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    maxServed: 1,
    gateHook: () => gateHeld
  })
  const a1 = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const a2 = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const p1 = await a1.seederPeer()
  const p2 = await a2.seederPeer()
  p1.send({ type: 'announce', key: a1.key, cert: validCert(assoc, a1.key) })
  p2.send({ type: 'announce', key: a2.key, cert: validCert(assoc, a2.key) })
  // The second admission is refused while the first still holds its gate.
  const full = await until(() => events.find((e) => e.event === 'rejected' && e.reason === 'seeder-full'), { name: 'seeder-full' })
  releaseGate()
  const winner = full.key === a1.key ? a2 : a1
  const loser = full.key === a1.key ? a1 : a2
  await winner.message((m) => m.type === 'admitted' && m.key === winner.key, 'admitted')
  await loser.message((m) => m.type === 'rejected' && m.key === loser.key && m.reason === 'seeder-full', 'seeder-full reply')
  t.alike(seeder.admittedKeys(), [winner.key])
  t.alike(Object.keys(readAdmitted(dataDir)), [winner.key])
  t.is(events.filter((e) => e.event === 'admitted').length, 1)
  t.is(seeder._reserved.size, 0, 'reservations released')
})

test('M1: a restart with admitted.json over the cap trims it and accepts connections', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const src = await localStore(t)
  const one = await localCore(src, 'one', validBlocks(assoc))
  const two = await localCore(src, 'two', validBlocks(assoc))
  const oneKey = hex(one.key)
  const twoKey = hex(two.key)
  await (await preload(dataDir, src, oneKey, 3)).close()
  await (await preload(dataDir, src, twoKey, 3)).close()
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({
    v: 1,
    admitted: { [oneKey]: validCert(assoc, oneKey), [twoKey]: validCert(assoc, twoKey) }
  }))
  await src.close()

  const { seeder, events, ready } = await startSeeder(t, bootstrap, dataDir, { maxServed: 1 })
  const readyAt = events.findIndex((e) => e.event === 'ready')
  const w = events.findIndex((e) => e.event === 'warning' && e.key === twoKey && e.reason === 'seeder-full')
  t.ok(w >= 0 && w < readyAt, 'over-cap log purged with a warning before ready')
  t.alike(ready.admitted, [oneKey])
  t.alike(Object.keys(readAdmitted(dataDir)), [oneKey])
  t.is(await seeder.store.storage.hasCore(discoveryKey(b4a.from(twoKey, 'hex'))), false, 'purged')
  const reader = await client(t, bootstrap, assoc, { follow: oneKey, joinPeer: publicKey })
  const peer = await reader.seederPeer()
  t.ok(peer.remoteHave.has(oneKey), 'connection accepted with the trimmed inventory')
  await reader.core.download({ start: 0, end: 3 }).done()
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('M2: an attacker announcer that never serves block 0 cannot keep a member out', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const member = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const memberPeer = await member.seederPeer()
  const attacker = await client(t, bootstrap, assoc)
  const attackerPeer = await attacker.seederPeer()
  // The attacker knows the member's key and public certificate; it holds the
  // running AND the queued admission, so the member can only be a waiter.
  const cert = validCert(assoc, member.key)
  attackerPeer.send({ type: 'announce', key: member.key, cert })
  attackerPeer.send({ type: 'announce', key: member.key, cert })
  await until(() => {
    const chain = seeder._chains.get(member.key)
    return chain && chain.running && chain.queued && chain.fetch
  }, { name: 'attacker running and queued' })
  const announcedAt = Date.now()
  memberPeer.send({ type: 'announce', key: member.key, cert })
  // Well before the gate timeout (and the member's own --once deadline).
  await member.message((m) => m.type === 'admitted' && m.key === member.key, 'member admitted', Seeder.GATE_TIMEOUT_MS - 5000)
  t.ok(Date.now() - announcedAt < Seeder.GATE_TIMEOUT_MS - 5000, 'admitted before the gate timeout')
  t.alike(seeder.admittedKeys(), [member.key])
  t.is(events.filter((e) => e.event === 'admitted').length, 1)
  t.absent(member.messages.some((m) => m.type === 'rejected'), 'never answered with the attacker outcome')
})

test('item 5: a stored log over the quota is purged at startup, never served nor joined', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const src = await localStore(t)
  const long = await localCore(src, 'long', (key) => [memberCertRecord(validCert(assoc, key)), post('1'), post('2'), post('3'), post('4')])
  const longKey = hex(long.key)
  await (await preload(dataDir, src, longKey, 5)).close()
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({ v: 1, admitted: { [longKey]: validCert(assoc, longKey) } }))
  await src.close()

  const { seeder, events, ready } = await startSeeder(t, bootstrap, dataDir, { maxLogBlocks: 4 })
  const readyAt = events.findIndex((e) => e.event === 'ready')
  const i = events.findIndex((e) => e.event === 'rejected' && e.key === longKey && e.reason === 'quota')
  t.ok(i >= 0 && i < readyAt, 'dropped with quota before ready')
  t.alike(ready.admitted, [])
  t.alike(readAdmitted(dataDir), {})
  t.absent(seeder.swarm.status(discoveryKey(b4a.from(longKey, 'hex'))), 'topic never joined')
  t.is(await seeder.store.storage.hasCore(discoveryKey(b4a.from(longKey, 'hex'))), false, 'purged')
  const reader = await client(t, bootstrap, assoc, { follow: longKey, joinPeer: publicKey })
  await reader.seederPeer()
  t.ok(await nothingWithin(reader.core, 2000), 'not served')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('item 6: a resumed main-store core over the quota gets rejected only, no join, no admitted', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  // Right before the open step the author's 3-block log is fetched into the
  // main store (unlisted), so openReplica resumes a core already over the
  // lowered limit. (A core preloaded before the announce cannot be used: the
  // main store would then answer the replication channel the quarantine gate
  // needs for that key.)
  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const s = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    admitHook: async (key, step) => {
      if (step !== 'open') return
      const resumed = s.seeder.store.get({ key: b4a.from(key, 'hex') })
      await resumed.ready()
      await resumed.download({ start: 0, end: 3 }).done()
      await resumed.close()
      s.seeder.maxLogBlocks = 2
    }
  })
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert: validCert(assoc, author.key) })
  await author.message((m) => m.type === 'rejected' && m.key === author.key && m.reason === 'quota', 'quota')
  await until(() => !(author.key in readAdmitted(dataDir)), { name: 'rolled back' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.absent(author.messages.some((m) => m.type === 'admitted'), 'no admitted')
  t.absent(s.events.some((e) => e.event === 'admitted'), 'no admitted event')
  t.absent(s.seeder.swarm.status(discoveryKey(author.core.key)), 'topic not joined')
  t.alike(s.seeder.admittedKeys(), [])
})

test('connection cap (S1): a connection over maxConnections is dropped before replication', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxConnections: 1 })

  const c1 = await client(t, bootstrap, assoc)
  await c1.seederPeer()
  const c2 = await client(t, bootstrap, assoc)
  await until(() => events.some((e) => e.event === 'peer-dropped' && e.reason === 'connection-limit'), { name: 'connection-limit drop' })
  const dropped = events.find((e) => e.event === 'peer-dropped')
  t.ok([hex(c1.swarm.keyPair.publicKey), hex(c2.swarm.keyPair.publicKey)].includes(dropped.peerKey), 'the dropped peer is one of the clients')
  t.ok(seeder.swarm.connections.size <= 1 || events.filter((e) => e.event === 'peer-dropped').length >= 1)
  t.ok(seeder._peers.size <= 1, 'never more than maxConnections admission peers')
})

test('third peer cannot read a log under admission or rejected, only an admitted one', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  let releaseGate
  const gateHeld = new Promise((resolve) => { releaseGate = resolve })
  let holding = null
  const { seeder } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    gateHook: async (key) => {
      if (holding === key) await gateHeld
    }
  })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  holding = author.key
  peer.send({ type: 'announce', key: author.key, cert: validCert(assoc, author.key) })

  const t1 = await client(t, bootstrap, assoc, { follow: author.key, joinPeer: publicKey })
  await t1.seederPeer()
  t.ok(await nothingWithin(t1.core, 1500), 'no block 0 while the verdict is held')
  t.absent(seeder.admittedKeys().includes(author.key))

  const poser = await client(t, bootstrap, assoc, { blocks: () => [post('falso')] })
  const poserPeer = await poser.seederPeer()
  poserPeer.send({ type: 'announce', key: poser.key, cert: validCert(assoc, poser.key) })
  await poser.message((m) => m.type === 'rejected' && m.key === poser.key && m.reason === 'not-in-log', 'not-in-log')
  const t2 = await client(t, bootstrap, assoc, { follow: poser.key, joinPeer: publicKey })
  await t2.seederPeer()
  t.ok(await nothingWithin(t2.core, 1500), 'no block 0 after a not-in-log rejection')

  releaseGate()
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3')
  const t3 = await client(t, bootstrap, assoc, { follow: author.key, joinPeer: publicKey })
  await t3.seederPeer()
  const block0 = await t3.core.get(0, { timeout: 10000 })
  t.ok(block0, 'block 0 served after admission')
})

test('restart: the copy survives and is served without the author', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert: validCert(assoc, author.key) })
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3')
  await first.seeder.close()
  await author.swarm.destroy()

  const second = await startSeeder(t, bootstrap, dataDir)
  t.alike(second.ready.admitted, [author.key])
  t.ok(second.events.some((e) => e.event === 'ready' && e.admitted.includes(author.key)))

  const reader = await client(t, bootstrap, assoc, { follow: author.key, joinPeer: publicKey })
  await reader.core.download({ start: 0, end: 3 }).done()
  t.is(reader.core.contiguousLength, 3)
})

test('start errors: usage, missing key, missing cert, cert for another key', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()

  const fresh = newSeeder(t, bootstrap, tmpDir(t, 'varanda-seed-')).seeder
  await t.exception(() => fresh.start(), /informe --association ou VARANDA_ASSOCIATION/)
  let code = null
  try {
    await new Seeder({ dataDir: tmpDir(t, 'varanda-seed-') }).start()
  } catch (err) {
    code = err.code
  }
  t.is(code, 'USAGE')

  const noKey = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(noKey, assoc.hex)
  await t.exception(() => newSeeder(t, bootstrap, noKey).seeder.start(), /chave do semeador não encontrada \(use seed key\)$/)

  const noCert = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(noCert, assoc.hex)
  Seeder.createKey(noCert)
  await t.exception(() => newSeeder(t, bootstrap, noCert).seeder.start(), /certificado do semeador não encontrado \(use seed cert add\)$/)

  const otherKey = hex(generateNoiseKeyPair().publicKey)
  const wrongCert = createSeederCert({ seeder: otherKey }, assoc.kp)
  fs.writeFileSync(path.join(noCert, 'seeder-cert.json'), JSON.stringify(wrongCert))
  await t.exception(() => newSeeder(t, bootstrap, noCert).seeder.start(), /certificado do semeador inválido \(seeder-mismatch\)$/)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'c.json')
  fs.writeFileSync(certFile, JSON.stringify(wrongCert))
  t.exception(() => Seeder.addCert(noCert, certFile, assoc.hex), /seeder-mismatch/)

  await t.exception(() => newSeeder(t, bootstrap, noCert, { associationKey: makeAssociation().hex }).seeder.start(), /associação diferente da configurada/)
})

test('P2: admitted.json is read only after the data-dir lock is held', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const src = await localStore(t)
  const good = await localCore(src, 'good', validBlocks(assoc))
  const goodKey = hex(good.key)
  await (await preload(dataDir, src, goodKey, 3)).close()
  await src.close()

  // A previous seeder that admitted the key right before releasing the lock:
  // the file is written after construction, once the lock is acquired.
  let hookRan = false
  const { seeder, events, ready } = await startSeeder(t, bootstrap, dataDir, {
    storeHook: async () => {
      hookRan = true
      fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({ v: 1, admitted: { [goodKey]: validCert(assoc, goodKey) } }))
    }
  })
  t.ok(hookRan)
  t.alike(ready.admitted, [goodKey], 'the listed key went through the startup gate')
  t.ok(seeder._served.has(goodKey), 'served with its watchers')
  t.alike(Object.keys(readAdmitted(dataDir)), [goodKey])
  const reader = await client(t, bootstrap, assoc, { follow: goodKey, joinPeer: publicKey })
  await reader.core.download({ start: 0, end: 3 }).done()
  t.is(reader.core.contiguousLength, 3)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('startup drops: missing, not-in-log and forked replicas are purged before the swarm', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const src = await localStore(t)

  const good = await localCore(src, 'good', validBlocks(assoc))
  const bad = await localCore(src, 'bad', () => [post('primeiro'), post('segundo')])
  const forked = await localCore(src, 'forked', validBlocks(assoc))
  const goodKey = hex(good.key)
  const badKey = hex(bad.key)
  const forkedKey = hex(forked.key)
  const missingKey = 'cd'.repeat(32)

  await (await preload(dataDir, src, goodKey, 3)).close()
  await (await preload(dataDir, src, badKey, 1)).close()
  const pf = await preload(dataDir, src, forkedKey, 3)
  await forked.truncate(1)
  await forked.append(post('reescrito'))
  await until(async () => {
    await pf.replica.update({ wait: true }).catch(() => {})
    return pf.replica.fork !== 0
  }, { name: 'réplica bifurcada' })
  await pf.close()

  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({
    v: 1,
    admitted: {
      [goodKey]: validCert(assoc, goodKey),
      [badKey]: validCert(assoc, badKey),
      [forkedKey]: validCert(assoc, forkedKey),
      [missingKey]: validCert(assoc, missingKey)
    }
  }))
  await src.close()

  let fileAtReady = null
  const { seeder, events, ready } = await startSeeder(t, bootstrap, dataDir, {
    onlog: (e) => {
      if (e.event === 'ready') fileAtReady = readAdmitted(dataDir)
    }
  })
  const readyAt = events.findIndex((e) => e.event === 'ready')
  const reasonOf = (key) => {
    const i = events.findIndex((e) => e.event === 'rejected' && e.key === key)
    t.ok(i >= 0 && i < readyAt, 'dropped before ready: ' + key.slice(0, 8))
    return events[i] && events[i].reason
  }
  t.is(reasonOf(missingKey), 'no-cert')
  t.is(reasonOf(badKey), 'not-in-log')
  t.is(reasonOf(forkedKey), 'fork')
  t.alike(ready.admitted, [goodKey])
  t.alike(seeder.admittedKeys(), [goodKey])
  t.alike(Object.keys(fileAtReady), [goodKey])

  const reader = await client(t, bootstrap, assoc, { follow: badKey, joinPeer: publicKey })
  await reader.seederPeer()
  t.ok(await nothingWithin(reader.core, 3000), 'purged replica is not served')
})

test('startup purge failure fails closed and the next start purges', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const missingKey = 'ef'.repeat(32)
  const cert = validCert(assoc, missingKey)
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({ v: 1, admitted: { [missingKey]: cert } }))

  const failing = newSeeder(t, bootstrap, dataDir, {
    purgeHook: async () => { throw new Error('falha simulada') }
  })
  await t.exception(() => failing.seeder.start(), /falha ao limpar diário rejeitado: efefefef$/)
  t.alike(readAdmitted(dataDir), { [missingKey]: cert }, 'key stays listed until purged')

  const { events, ready } = await startSeeder(t, bootstrap, dataDir)
  t.ok(events.some((e) => e.event === 'rejected' && e.key === missingKey && e.reason === 'no-cert'))
  t.alike(ready.admitted, [])
  t.alike(readAdmitted(dataDir), {})
})

test('runtime fork: the seeder drops, withdraws and purges the log', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert: validCert(assoc, author.key) })
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3')

  await author.core.truncate(1)
  await author.core.append(post('reescrito'))

  await author.message((m) => m.type === 'rejected' && m.key === author.key && m.reason === 'fork', 'rejected fork')
  t.ok(events.some((e) => e.event === 'rejected' && e.key === author.key && e.reason === 'fork'))
  t.absent(seeder.admittedKeys().includes(author.key))
  await until(() => !(author.key in readAdmitted(dataDir)), { name: 'admitted.json sem a chave' })
})

test('a drop wins over a queued announce: purge first, then a fresh gate', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const order = []
  let releasePurge
  const purgeHeld = new Promise((resolve) => { releasePurge = resolve })
  let holdPurge = false
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    gateHook: async (key) => { order.push('gate:' + key.slice(0, 8)) },
    purgeHook: async (core) => {
      order.push('purge-start:' + hex(core.key).slice(0, 8))
      if (holdPurge) {
        holdPurge = false
        await purgeHeld
      }
      await core.purge()
      order.push('purge-end:' + hex(core.key).slice(0, 8))
    }
  })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  const cert = validCert(assoc, author.key)
  const k8 = author.key.slice(0, 8)
  peer.send({ type: 'announce', key: author.key, cert })
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3')
  const admittedCount = () => author.messages.filter((m) => m.type === 'admitted' && m.key === author.key).length
  t.is(admittedCount(), 1)

  // The fork triggers a drop whose purge is held; the announce arrives while
  // the drop is in progress.
  holdPurge = true
  await author.core.truncate(1)
  await author.core.append(post('reescrito'))
  await author.message((m) => m.type === 'rejected' && m.key === author.key && m.reason === 'fork', 'rejected fork')
  await until(() => order.includes('purge-start:' + k8), { name: 'purge started' })
  peer.send({ type: 'announce', key: author.key, cert })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  t.is(admittedCount(), 1, 'no admitted reply while the purge is pending')
  t.alike(order, ['gate:' + k8, 'purge-start:' + k8], 'the queued announce has not been gated yet')
  t.absent(seeder.admittedKeys().includes(author.key))
  t.ok(author.key in readAdmitted(dataDir), 'still listed until the purge succeeds')

  releasePurge()
  await author.message((m) => m.type === 'admitted' && m.key === author.key && admittedCount() === 2, 'second admitted', 20000)
  t.alike(order.slice(0, 3), ['gate:' + k8, 'purge-start:' + k8, 'purge-end:' + k8], 'purge completed before the announce was looked at')
  t.is(order.filter((o) => o === 'gate:' + k8).length, 2, 'the re-admission went through a fresh quarantine gate')
  const secondAdmitted = events.filter((e) => e.event === 'admitted' && e.key === author.key)
  t.is(secondAdmitted.length, 2)
  t.is(secondAdmitted[1].length, 0, 'admitted reply for a fresh (empty) replica, never a closed core')

  // The fresh replica downloads the rewritten log, which is itself forked:
  // the seeder drops it again (R5.9) and purges it through the same path.
  await until(() => events.filter((e) => e.event === 'rejected' && e.key === author.key && e.reason === 'fork').length === 2, { name: 'second rejected fork' })
  await until(() => order.filter((o) => o === 'purge-end:' + k8).length === 2, { name: 'second purge' })
  await until(() => !(author.key in readAdmitted(dataDir)), { name: 'admitted.json sem a chave' })
  t.absent(seeder.admittedKeys().includes(author.key))
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
  t.is(events.filter((e) => e.event === 'admitted' && e.key === author.key).length, order.filter((o) => o === 'gate:' + k8).length, 'every admission went through the gate')
})

test('runtime purge failure is fatal and keeps the key listed for the next start', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    purgeHook: async () => { throw new Error('falha simulada') }
  })

  const author = await client(t, bootstrap, assoc, { blocks: validBlocks(assoc) })
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert: validCert(assoc, author.key) })
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3')
  await author.core.truncate(1)
  await author.core.append(post('reescrito'))

  await first.seeder.closed
  t.ok(first.events.some((e) => e.event === 'fatal' && e.key === author.key && e.reason === 'purge-failed'))
  t.ok(author.key in readAdmitted(dataDir), 'dropping key stays in admitted.json')
  await author.swarm.destroy()

  const second = await startSeeder(t, bootstrap, dataDir)
  t.ok(second.events.some((e) => e.event === 'rejected' && e.key === author.key))
  t.alike(second.ready.admitted, [])
  t.alike(readAdmitted(dataDir), {})
})

test('a second seeder on the same data dir fails on the lock and keeps the quarantine', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const marker = path.join(dataDir, 'quarantine', 'marker')
  fs.writeFileSync(marker, 'x')

  const second = newSeeder(t, bootstrap, dataDir).seeder
  let lockError = null
  try {
    await second.start()
  } catch (err) {
    lockError = err
  }
  t.ok(lockError, 'second start rejects: ' + (lockError && lockError.message))
  t.ok(fs.existsSync(marker), 'quarantine untouched')
})

test('close releases the lock last: the next seeder on the data dir keeps its quarantine', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const lock = path.join(dataDir, '.varanda-lock')
  const q = path.join(dataDir, 'quarantine')
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.ok(fs.existsSync(q), 'first quarantine exists')

  // The second seeder starts the instant the lock is released, before the
  // first close() has resolved: its quarantine must survive that close.
  const closing = first.seeder.close()
  await until(() => !fs.existsSync(lock), { name: 'lock released' })
  const second = await startSeeder(t, bootstrap, dataDir)
  await closing
  t.ok(fs.existsSync(q), 'second seeder quarantine intact while it is active')
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.ok(fs.existsSync(q), 'still intact')
  t.alike(second.ready.admitted, [])
  await second.seeder.close()
  t.absent(fs.existsSync(q), 'quarantine removed at close')
  t.absent(fs.existsSync(lock), 'lock released')
})

test('cli: seed key and seed without association', async (t) => {
  t.timeout(90000)
  await testnet(t)
  const assoc = makeAssociation()
  const env = { ...process.env }
  delete env.VARANDA_ASSOCIATION
  delete env.VARANDA_DATA
  delete env.VARANDA_BOOTSTRAP

  const dir = tmpDir(t, 'varanda-cli-')
  const r1 = spawnSync(process.execPath, [BIN, 'seed', 'key', '--data', dir, '--association', assoc.hex], { env, encoding: 'utf8' })
  t.is(r1.status, 0, r1.stderr)
  const match = /chave do semeador: ([0-9a-f]{64})\n$/.exec(r1.stdout)
  t.ok(match, r1.stdout)
  t.is(fs.statSync(path.join(dir, 'seeder-key.json')).mode & 0o777, 0o600)
  const r2 = spawnSync(process.execPath, [BIN, 'seed', 'key', '--data', dir, '--json'], { env, encoding: 'utf8' })
  t.is(r2.status, 0, r2.stderr)
  t.alike(JSON.parse(r2.stdout.trim()), { publicKey: match && match[1] })

  const empty = tmpDir(t, 'varanda-cli-')
  const r3 = spawnSync(process.execPath, [BIN, 'seed', '--data', empty], { env, encoding: 'utf8' })
  t.is(r3.status, 2, r3.stderr)
  t.ok(r3.stderr.includes('informe --association ou VARANDA_ASSOCIATION'))
})
