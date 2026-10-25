// Media cores at the seeder (packages/core/lib/seeder.js header): a core K
// is kept only while an admitted diary D declares it (latest MAX_MEDIA_CORES
// media-core records) AND K's block 0 is a media header naming D. Every
// stored core is listed in admitted.json (`media`), purged like a diary, and
// media keys never travel on the admission channel.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { discoveryKey, keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, mediaCoreRecord, MEDIA_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { mediaHeader } = require('@varanda/core/lib/media')
const { openMediaReplica } = require('@varanda/core/lib/store')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function validCert (assoc, key) {
  return createCert({ member: key }, assoc.kp)
}

function readFile (dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'admitted.json'), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return { v: 1, admitted: {} }
    throw err
  }
}

function readMedia (dataDir) {
  return readFile(dataDir).media || {}
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

function newSeeder (t, bootstrap, dataDir, opts = {}) {
  const events = []
  const { onlog, ...rest } = opts
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    log: (e) => {
      events.push(e)
      if (process.env.VARANDA_TEST_LOG) console.error('# seeder', JSON.stringify(e))
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

// Raw media blocks of `blocks` x MEDIA_BLOCK_BYTES, the last one shorter.
function mediaBlocks (blocks, seed) {
  const out = []
  for (let i = 0; i < blocks; i++) {
    const len = i === blocks - 1 ? 1000 : MEDIA_BLOCK_BYTES
    out.push(b4a.alloc(len, (seed + i) % 251))
  }
  return out
}

// A member on the swarm: its diary (certificate + one post + whatever
// `declare` appends, given the diary key and the media cores) and `cores`
// media cores (raw Hypercores whose block 0 is a header naming `headerFor`,
// default the own diary) plus `blocks` raw blocks each. Its store replicates
// every core to every connection, as a real member's does.
async function member (t, bootstrap, assoc, { cores = 1, blocks = 2, headerFor = null, header = null, declare = null, blocklist = null, joinPeer = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  const media = []
  for (let i = 0; i < cores; i++) {
    const core = store.get({ name: 'media-' + i })
    await core.ready()
    const h = header ? header(key) : mediaHeader({ diary: headerFor || key })
    await core.append(b4a.from(JSON.stringify(h)))
    for (const block of mediaBlocks(blocks, i * 7)) await core.append(block)
    media.push(core)
  }
  await diary.append(memberCertRecord(validCert(assoc, key)))
  await diary.append(postRecord({ text: 'oi' }))
  const records = declare ? declare(key, media.map((c) => hex(c.key))) : media.map((c) => mediaCoreRecord({ key: hex(c.key) }))
  for (const r of records) await diary.append(r)

  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    if (blocklist) {
      attachBlocklist(socket, {
        current: () => blocklist.snapshot,
        offer: async () => ({ adopted: false, reason: 'same', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() })
      })
    }
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  if (joinPeer) swarm.joinPeer(b4a.from(joinPeer, 'hex'))
  else await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const message = (pred, name, timeoutMs = 20000) => until(() => messages.find(pred), { name, timeoutMs })
  return { store, diary, key, media, mediaKeys: media.map((c) => hex(c.key)), swarm, peers, messages, seederPeer, message }
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
  return peer
}

function mediaAdmitted (events, key) {
  return until(() => events.find((e) => e.event === 'media-admitted' && e.key === key), { name: 'media-admitted ' + key.slice(0, 8), timeoutMs: 30000 })
}

function mediaRejected (events, key, reason) {
  return until(() => events.find((e) => e.event === 'media-rejected' && e.key === key && (reason === undefined || e.reason === reason)), { name: 'media-rejected ' + key.slice(0, 8) + ' ' + reason, timeoutMs: 30000 })
}

async function stored (seeder, key) {
  return seeder.store.storage.hasCore(discoveryKey(b4a.from(key, 'hex')))
}

// Settles once the seeder scanned the diary to its current length and no
// media admission is in flight: whatever is bound by then is final.
function scanned (seeder, m) {
  return until(() => {
    const entry = seeder._served.get(m.key)
    return entry && entry.scanned >= m.diary.length && seeder._inflight.size === 0 && seeder._mediaReserved.size === 0
  }, { name: 'diário varrido' })
}

// A node that only HOLDS cores (no diary): `fill(store)` creates them, then
// it dials the seeder (joinPeer) and replicates its store to it.
async function holder (t, bootstrap, publicKey, fill) {
  const store = new Corestore(tmpDir(t, 'varanda-holder-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  await fill(store)
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [] }))
  })
  swarm.joinPeer(b4a.from(publicKey, 'hex'))
  await until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador (holder)' })
  return { store, swarm }
}

async function collect (iterable) {
  const out = []
  for await (const block of iterable) out.push(block)
  return out
}

test('a declared media core with a header naming the diary is admitted, listed, downloaded and readable', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()

  const { dataDir } = prepareSeederDir(t, assoc)
  const listedAt = {}
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    onlog: (e) => {
      if (e.event === 'media-admitted') listedAt.admitted = e.key in readMedia(dataDir)
    }
  })

  const m = await member(t, bootstrap, assoc, { blocks: 3 })
  const K = m.mediaKeys[0]
  await admit(m, assoc)
  const ev = await mediaAdmitted(events, K)
  t.is(ev.diary, m.key)
  t.is(listedAt.admitted, true, 'admitted.json lists K before it is served')
  t.alike(readMedia(dataDir), { [K]: { diary: m.key, seq: 2 } })
  t.alike(seeder.mediaKeys(), [K])
  await until(() => seeder._mediaServed.get(K).core.contiguousLength === 4, { name: 'mídia baixada' })
  t.is(seeder.stats().mediaCores, 1)
  t.is(seeder.stats().mediaBytes, m.media[0].byteLength)
  t.ok(!events.some((e) => e.event === 'have' && e.key === K), 'no have for a media key')
  t.ok(!m.messages.some((x) => x.key === K), 'nothing about K reached the member over the admission channel')

  // mediaRead: equal blocks, exact byte total; refusals.
  const read = await seeder.mediaRead(m.key, K, 1, 3)
  t.ok(read !== null)
  const blocks = await collect(read.blocks)
  t.is(blocks.length, 3)
  for (let i = 0; i < 3; i++) t.ok(b4a.equals(blocks[i], await m.media[0].get(i + 1)), 'block ' + (i + 1))
  t.is(read.bytes, 2 * MEDIA_BLOCK_BYTES + 1000)
  t.is(await seeder.mediaRead(m.key, K, 0, 1), null, 'block 0 is never served as media')
  t.is(await seeder.mediaRead(m.key, K, 1, 4), null, 'range past the length')
  t.is(await seeder.mediaRead(m.key, K, 3, 1) !== null, true)
  t.is(await seeder.mediaRead(K, m.key, 1, 1), null, 'swapped keys')
  t.is(await seeder.mediaRead('ab'.repeat(32), K, 1, 1), null, 'another diary')
  t.is(await seeder.mediaRead(m.key, K, '1', 1), null)

  // A fork of K drops K only; a stream in progress rejects promptly.
  const partial = await seeder.mediaRead(m.key, K, 1, 3)
  const first = await partial.blocks.next()
  t.ok(b4a.equals(first.value, await m.media[0].get(1)))
  await m.media[0].truncate(1)
  await m.media[0].append(b4a.alloc(10, 1))
  await mediaRejected(events, K, 'fork')
  await until(async () => seeder._drops.size === 0 && !(K in readMedia(dataDir)) && !(await stored(seeder, K)), { name: 'K purgada' })
  const before = Date.now()
  await t.exception(() => partial.blocks.next(), 'next() rejects once the core is gone')
  t.ok(Date.now() - before < 5000, 'promptly')
  t.alike(seeder.admittedKeys(), [m.key], 'D kept')
  t.alike(seeder.mediaKeys(), [])
  t.is(await seeder.mediaRead(m.key, K, 1, 1), null)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('refusals: wrong diary in the header, K === D, K a diary, invalid header: never stored', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()

  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // An admitted diary B (its key is about to be declared by A as media).
  const B = await member(t, bootstrap, assoc, { cores: 0 })
  await admit(B, assoc)

  // core 0: header naming another diary; core 1: not a header at all;
  // core 2: a valid header (control, declared below).
  const headers = [mediaHeader({ diary: 'cd'.repeat(32) }), { type: 'post', text: 'x', at: new Date().toISOString(), replyTo: null }, null]
  const A = await member(t, bootstrap, assoc, {
    cores: 3,
    header: (diary) => {
      const h = headers.shift()
      return h === null ? mediaHeader({ diary }) : h
    },
    declare: (diary, keys) => [
      mediaCoreRecord({ key: keys[0] }),
      mediaCoreRecord({ key: keys[1] }),
      mediaCoreRecord({ key: diary }),
      mediaCoreRecord({ key: B.key }),
      mediaCoreRecord({ key: keys[2] })
    ]
  })
  await admit(A, assoc)
  await mediaRejected(events, A.mediaKeys[0], 'wrong-diary')
  await mediaRejected(events, A.mediaKeys[1], 'header-invalid')
  await mediaAdmitted(events, A.mediaKeys[2])
  await scanned(seeder, A)
  t.alike(seeder.mediaKeys(), [A.mediaKeys[2]])
  t.alike(Object.keys(readMedia(dataDir)), [A.mediaKeys[2]])
  t.is(await stored(seeder, A.mediaKeys[0]), false)
  t.is(await stored(seeder, A.mediaKeys[1]), false)
  t.alike(seeder.admittedKeys().sort(), [B.key, A.key].sort(), 'B stays a diary, A is still a diary')
  t.is(seeder._served.get(B.key).dropped, false)
  // A refused header is not fetched again on every growth.
  const fetches = events.filter((e) => e.event === 'media-rejected' && e.key === A.mediaKeys[0]).length
  await A.diary.append(postRecord({ text: 'mais' }))
  await A.message((x) => x.type === 'have' && x.key === A.key && x.length === A.diary.length, 'have após post')
  await scanned(seeder, A)
  t.is(events.filter((e) => e.event === 'media-rejected' && e.key === A.mediaKeys[0]).length, fetches, 'no retry of a refused header')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a blocked diary takes its media core down; Seeder.drop of the diary purges it; seed list shows it', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()

  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const m = await member(t, bootstrap, assoc)
  const K = m.mediaKeys[0]
  await admit(m, assoc)
  await mediaAdmitted(events, K)
  await until(() => seeder._mediaServed.get(K).core.contiguousLength === 3, { name: 'mídia baixada' })

  const modKp = signingKeyPair()
  const mod = { kp: modKp, cert: createModeratorCert({ moderator: hex(modKp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp) }
  const snapshot = createSnapshot({ seq: 1, blocked: [m.key], revokedIssuers: [] }, mod.kp, mod.cert)
  await member(t, bootstrap, assoc, { cores: 0, joinPeer: publicKey, blocklist: { snapshot } })
  await mediaRejected(events, K, 'blocked')
  await until(async () => seeder.stats().dropping === 0 && seeder._drops.size === 0 &&
    !(K in readMedia(dataDir)) && !(m.key in readFile(dataDir).admitted) &&
    !(await stored(seeder, K)) && !(await stored(seeder, m.key)), { name: 'ambos purgados' })
  t.alike(seeder.mediaKeys(), [])
  t.is(seeder.stats().mediaCores, 0)
  t.is(await seeder.mediaRead(m.key, K, 1, 1), null)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)

  // A second seeder dir: Seeder.list and Seeder.drop while stopped.
  const second = prepareSeederDir(t, assoc)
  const s2 = await startSeeder(t, bootstrap, second.dataDir, { associationKey: assoc.hex })
  const m2 = await member(t, bootstrap, assoc)
  const K2 = m2.mediaKeys[0]
  const peer2 = await until(() => m2.peers.find((p) => p.remoteRole === 'seeder' && p.peerKey === second.publicKey), { name: 'segundo semeador' })
  peer2.send({ type: 'announce', key: m2.key, cert: validCert(assoc, m2.key) })
  await mediaAdmitted(s2.events, K2)
  await until(() => s2.seeder._mediaServed.get(K2).core.contiguousLength === 3, { name: 'mídia baixada no segundo' })
  await s2.seeder.close()

  const list = await Seeder.list(second.dataDir, assoc.hex)
  t.is(list.admitted.length, 1)
  t.is(list.admitted[0].key, m2.key)
  t.alike(list.admitted[0].media, [{ key: K2, length: 3, byteLength: m2.media[0].byteLength }])
  t.alike(await Seeder.drop(second.dataDir, assoc.hex, m2.key), { key: m2.key })
  t.alike(readFile(second.dataDir), { v: 1, admitted: {}, media: {} })
  const check = new Corestore(path.join(second.dataDir, 'store'))
  await check.ready()
  t.is(await check.storage.hasCore(discoveryKey(b4a.from(K2, 'hex'))), false, 'media core purged by the drop')
  t.is(await check.storage.hasCore(discoveryKey(b4a.from(m2.key, 'hex'))), false)
  await check.close()
})

test('media quota: over the limit at the gate it is never stored; growth past it drops the core', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()

  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxMediaBlocks: 3 })

  const big = await member(t, bootstrap, assoc, { blocks: 3 }) // length 4 > 3
  await admit(big, assoc)
  await mediaRejected(events, big.mediaKeys[0], 'quota')
  await scanned(seeder, big)
  t.is(await stored(seeder, big.mediaKeys[0]), false)
  t.alike(seeder.mediaKeys(), [])

  const small = await member(t, bootstrap, assoc, { blocks: 1 }) // length 2
  const K = small.mediaKeys[0]
  await admit(small, assoc)
  await mediaAdmitted(events, K)
  await until(() => seeder._mediaServed.get(K).core.contiguousLength === 2, { name: 'mídia baixada' })
  await small.media[0].append(b4a.alloc(5, 2))
  await small.media[0].append(b4a.alloc(5, 3))
  await mediaRejected(events, K, 'quota')
  await until(async () => seeder._drops.size === 0 && !(K in readMedia(dataDir)) && !(await stored(seeder, K)), { name: 'K purgada' })
  t.alike(seeder.admittedKeys().sort(), [big.key, small.key].sort(), 'both diaries kept')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a fifth declaration drops the oldest bound core', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()

  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const m = await member(t, bootstrap, assoc, {
    cores: 5,
    blocks: 1,
    declare: (diary, keys) => keys.slice(0, 4).map((key) => mediaCoreRecord({ key }))
  })
  await admit(m, assoc)
  for (const K of m.mediaKeys.slice(0, 4)) await mediaAdmitted(events, K)
  t.alike(seeder.mediaKeys().sort(), m.mediaKeys.slice(0, 4).sort())

  await m.diary.append(mediaCoreRecord({ key: m.mediaKeys[4] }))
  await mediaAdmitted(events, m.mediaKeys[4])
  await mediaRejected(events, m.mediaKeys[0], 'unbound')
  await until(async () => seeder._drops.size === 0 && !(m.mediaKeys[0] in readMedia(dataDir)) && !(await stored(seeder, m.mediaKeys[0])), { name: 'mais antiga purgada' })
  t.alike(seeder.mediaKeys().sort(), m.mediaKeys.slice(1).sort())
  t.alike(Object.keys(readMedia(dataDir)).sort(), m.mediaKeys.slice(1).sort())
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('restart: a healthy binding is served at ready without a rescan; a binding whose diary is gone is purged', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()

  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const m = await member(t, bootstrap, assoc, { blocks: 2 })
  const K = m.mediaKeys[0]
  await admit(m, assoc)
  await mediaAdmitted(first.events, K)
  await until(() => first.seeder._mediaServed.get(K).core.contiguousLength === 3, { name: 'mídia baixada' })
  await first.seeder.close()
  await m.swarm.destroy()
  await m.store.close()

  let servedAtReady = null
  const second = newSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    onlog: (e) => {
      if (e.event === 'ready') servedAtReady = second.seeder._mediaServed.has(K) && second.seeder._served.get(m.key).scanned === 1
    }
  })
  second.ready = await second.seeder.start()
  t.is(servedAtReady, true, 'K served at ready, before any block of D was scanned')
  t.alike(second.ready.admitted, [m.key])
  t.alike(second.seeder.mediaKeys(), [K])
  const read = await second.seeder.mediaRead(m.key, K, 1, 2)
  t.is(read.bytes, MEDIA_BLOCK_BYTES + 1000)
  t.is((await collect(read.blocks)).length, 2)
  // The background scan confirms the binding (no drop, no re-admission).
  await until(() => second.seeder._served.get(m.key).scanned === 3, { name: 'varredura de fundo' })
  t.alike(second.seeder.mediaKeys(), [K])
  t.is(second.events.filter((e) => e.event === 'media-admitted' || e.event === 'media-rejected').length, 0)
  await second.seeder.close()

  // D removed from the file, K still listed and stored: purged at start.
  const file = readFile(dataDir)
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({ v: 1, admitted: {}, media: file.media }))
  let fileAtReady = null
  const third = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    onlog: (e) => { if (e.event === 'ready') fileAtReady = readFile(dataDir) }
  })
  const readyAt = third.events.findIndex((e) => e.event === 'ready')
  const rejectedAt = third.events.findIndex((e) => e.event === 'media-rejected' && e.key === K && e.reason === 'unbound')
  t.ok(rejectedAt >= 0 && rejectedAt < readyAt, 'purged before ready')
  t.alike(fileAtReady.media, {})
  t.is(await stored(third.seeder, K), false)
  t.alike(third.seeder.mediaKeys(), [])
})

test('failure injection: persist throws -> K not stored; open throws -> the stored core is purged; later retried', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()

  const { dataDir } = prepareSeederDir(t, assoc)
  const purged = []
  let mode = 'persist'
  let K = null
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    admitHook: async (key, step) => {
      if (key !== K || step !== mode) return
      if (mode === 'open') {
        // The open step creates the core in the main store and then fails.
        const core = await openMediaReplica(seeder.store, key)
        t.ok(await seeder.store.storage.hasCore(discoveryKey(core.key)), 'core stored before the failure')
      }
      throw new Error('falha simulada em ' + step)
    },
    purgeHook: async (core) => {
      purged.push(hex(core.key))
      await core.purge()
    }
  })

  const m = await member(t, bootstrap, assoc, { blocks: 1 })
  K = m.mediaKeys[0]
  await admit(m, assoc)
  await mediaRejected(events, K, 'admission-failed')
  await scanned(seeder, m)
  t.is(await stored(seeder, K), false, 'persist failure: nothing stored')
  t.absent(K in readMedia(dataDir))
  t.alike(purged, [])

  // Open failure: retried on the diary's next growth.
  mode = 'open'
  await m.diary.append(postRecord({ text: 'de novo' }))
  await until(() => purged.includes(K), { name: 'rollback purge' })
  await until(() => events.filter((e) => e.event === 'media-rejected' && e.key === K && e.reason === 'admission-failed').length === 2, { name: 'segunda falha' })
  await until(async () => !(K in readMedia(dataDir)) && !(await stored(seeder, K)), { name: 'rolled back' })
  t.alike(purged, [K], 'purged exactly once')
  t.alike(seeder.mediaKeys(), [])

  // Hooks pass: the next growth binds K.
  mode = 'none'
  await m.diary.append(postRecord({ text: 'agora' }))
  await mediaAdmitted(events, K)
  t.alike(seeder.mediaKeys(), [K])
  t.alike(seeder.admittedKeys(), [m.key])
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('equivocation: a block 0 served to the main store that differs from the quarantine one drops K, never readable', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  // Two Hypercores from the same key pair (same manifest, same key K) with
  // different block 0: the core's key is the manifest hash, so K is read
  // from the first core and only then declared by the diary.
  const kp = signingKeyPair()
  let K = null
  let honest = null
  let seeder = null
  let swapped = false
  const s = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    // Between the quarantine fetch and the main-store open the honest holder
    // leaves and the equivocator (same key pair, another block 0) arrives, so
    // the main-store replica only ever sees the second history.
    admitHook: async (key, step) => {
      if (key !== K || step !== 'open' || swapped) return
      swapped = true
      await honest.swarm.destroy()
      await until(() => seeder._peers.size === 1, { name: 'holder honesto saiu' })
      await holder(t, bootstrap, publicKey, async (store) => {
        const core = store.get({ keyPair: kp })
        await core.ready()
        await core.append(b4a.from(JSON.stringify(mediaHeader({ diary: 'ab'.repeat(32) }))))
        await core.append(b4a.alloc(10, 9))
      })
    }
  })
  seeder = s.seeder
  const m = await member(t, bootstrap, assoc, { cores: 0, declare: () => [] })
  honest = await holder(t, bootstrap, publicKey, async (store) => {
    const core = store.get({ keyPair: kp })
    await core.ready()
    K = hex(core.key)
    await core.append(b4a.from(JSON.stringify(mediaHeader({ diary: m.key }))))
    await core.append(b4a.alloc(10, 1))
  })
  await m.diary.append(mediaCoreRecord({ key: K }))
  await admit(m, assoc)
  await mediaAdmitted(s.events, K)
  t.ok(swapped, 'the holders were swapped during the open step')
  await mediaRejected(s.events, K, 'fork')
  await until(async () => seeder._drops.size === 0 && !(K in readMedia(dataDir)) && !(await stored(seeder, K)), { name: 'K purgada' })
  t.is(await seeder.mediaRead(m.key, K, 1, 1), null)
  t.alike(seeder.mediaKeys(), [])
  t.alike(seeder.admittedKeys(), [m.key], 'D kept')
  t.is(s.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a holder that connects during the quarantine fetch supplies block 0: no timeout, K admitted', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  // The holder's core (built offline first, so its key is known) is declared
  // by a diary that does not hold it: the fetch starts with the diary's
  // socket only, and the holder connects while it is in flight.
  const kp = signingKeyPair()
  const offline = new Corestore(tmpDir(t, 'varanda-offline-'))
  await offline.ready()
  const probe = offline.get({ keyPair: kp })
  await probe.ready()
  const K = hex(probe.key)
  await offline.close()
  const m = await member(t, bootstrap, assoc, { cores: 0, declare: () => [mediaCoreRecord({ key: K })] })
  await admit(m, assoc)
  await until(() => seeder._mediaFetches.has(K), { name: 'busca em quarentena em andamento' })
  const h = await holder(t, bootstrap, publicKey, async (store) => {
    const core = store.get({ keyPair: kp })
    await core.ready()
    t.is(hex(core.key), K, 'same key pair, same core key')
    await core.append(b4a.from(JSON.stringify(mediaHeader({ diary: m.key }))))
    for (const block of mediaBlocks(2, 3)) await core.append(block)
  })
  const started = Date.now()
  await mediaAdmitted(events, K)
  t.ok(Date.now() - started < Seeder.GATE_TIMEOUT_MS, 'admitted through the late holder, before the gate deadline')
  t.absent(events.some((e) => e.event === 'media-rejected' && e.key === K), 'no timeout, no rejection')
  await until(() => seeder._mediaServed.get(K).core.contiguousLength === 3, { name: 'mídia baixada' })
  await until(() => seeder._mediaServed.get(K).headerOk, { name: 'cabeçalho local conferido' })
  const read = await seeder.mediaRead(m.key, K, 1, 2)
  t.is(read.bytes, MEDIA_BLOCK_BYTES + 1000)
  t.is((await collect(read.blocks)).length, 2)
  await h.swarm.destroy()
})
