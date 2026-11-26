// Seeders announce the diaries they serve to other verified seeders (issue
// #67, Seeder._relayStart): a diary admitted by seeder A reaches seeder B
// with its author offline, and B keeps applying its own lists, caps and
// storage budget to every announce it receives.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { createSwarm, joinAndFlush, topicFor, attachAdmission, generateNoiseKeyPair } = require('../lib/net')
const { memberCertRecord, postRecord } = require('../lib/records')
const { coreCharge } = require('../lib/storage-budget')
const { writeBlocklist } = require('../lib/store')

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

function validCert (assoc, key) {
  return createCert({ member: key }, assoc.kp)
}

function readAdmitted (dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'admitted.json'), 'utf8')).admitted
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
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

// A started seeder over a fresh data dir, or over `dir` (a result of
// prepareSeederDir) when a test writes files into it first.
async function startSeeder (t, bootstrap, assoc, opts = {}, dir = null) {
  const { dataDir, publicKey } = dir || prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({
    dataDir,
    associationKey: assoc.hex,
    ...localSwarmOptions(bootstrap),
    log: (e) => events.push(e),
    ...opts
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events, dataDir, publicKey }
}

// A member on the swarm: a diary of a certificate and one post, announced to
// every seeder it meets on request.
async function member (t, bootstrap, assoc, text = 'oi') {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(validCert(assoc, key)))
  await diary.append(postRecord({ text }))
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  return { store, diary, key, swarm, messages, seederPeer }
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  await until(() => m.messages.find((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length), { name: 'have ' + m.diary.length, timeoutMs: 30000 })
}

// The diary is served, gated and fully downloaded by `seeder`.
function fullyServed (seeder, key, length) {
  const entry = seeder._served.get(key)
  return !!entry && entry.gated && entry.core.contiguousLength === length
}

// Every diary `seeder` serves is fully downloaded (A before the member leaves).
function untilServed (seeder, key, length, name) {
  return until(() => fullyServed(seeder, key, length), { name: name || 'servido ' + key.slice(0, 8), timeoutMs: 30000 })
}

// A raw node dialing the seeder directly (joinPeer: no topic) that records
// every admission message it receives. role 'seeder' with `cert`, or a
// member.
async function raw (t, bootstrap, seederKey, { role = 'seeder', cert = null, have = [] } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const keyPair = generateNoiseKeyPair()
  const swarm = createSwarm({ ...localSwarmOptions(bootstrap), keyPair })
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role, cert, have, onmessage: (msg) => messages.push(msg) }))
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  const peer = await until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const noiseHex = hex(keyPair.publicKey)
  return {
    peer,
    messages,
    noiseHex,
    announces: () => messages.filter((m) => m.type === 'announce'),
    announced: (key) => messages.find((m) => m.type === 'announce' && m.key === key)
  }
}

function seederCert (assoc, noiseHex) {
  return createSeederCert({ seeder: noiseHex }, assoc.kp)
}

// A raw seeder with a certificate valid for its own Noise key.
async function rawSeeder (t, bootstrap, assoc, seederKey, have = []) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const keyPair = generateNoiseKeyPair()
  const swarm = createSwarm({ ...localSwarmOptions(bootstrap), keyPair })
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'seeder', cert: seederCert(assoc, hex(keyPair.publicKey)), have, onmessage: (msg) => messages.push(msg) }))
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  const peer = await until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  return {
    peer,
    messages,
    noiseHex: hex(keyPair.publicKey),
    announces: () => messages.filter((m) => m.type === 'announce'),
    announced: (key) => messages.find((m) => m.type === 'announce' && m.key === key)
  }
}

// The seeder-side admission peer of a connection, by the client's Noise key.
function seederSide (seeder, noiseHex) {
  return [...seeder._peers].find((p) => p.peerKey === noiseHex) || null
}

function makeModerator (assoc) {
  const kp = signingKeyPair()
  return { kp, cert: createModeratorCert({ moderator: hex(kp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp) }
}

async function stored (seeder, key) {
  return seeder._stored(key)
}

test('relay: a diary admitted by seeder A reaches seeder B at full length with its author offline', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const a = await startSeeder(t, bootstrap, assoc)
  const m = await member(t, bootstrap, assoc)
  await admit(m, assoc)
  await untilServed(a.seeder, m.key, m.diary.length, 'A serve o diário inteiro')
  // The author leaves before B exists.
  await m.swarm.destroy()
  await m.store.close()

  const b = await startSeeder(t, bootstrap, assoc)
  await until(() => fullyServed(b.seeder, m.key, 2), { name: 'B serve o diário inteiro', timeoutMs: 60000 })
  t.is(b.seeder._served.get(m.key).core.contiguousLength, 2, 'B holds the whole diary')
  t.alike(b.seeder.admittedKeys(), [m.key])
  t.ok(readAdmitted(b.dataDir)[m.key], 'B listed it')
  t.absent(b.events.some((e) => e.event === 'peer' && e.role === 'member'), 'no member was ever connected to B')
  t.absent(b.events.some((e) => e.event === 'peer-dropped'), 'no peer dropped on B')
  t.absent(a.events.some((e) => e.event === 'peer-dropped'), 'no peer dropped on A')
})

test('relay: only a verified seeder gets announces, with the certificate of the diary block 0; keys in its hello are skipped, and a rejected key A does not serve is not retired', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const a = await startSeeder(t, bootstrap, assoc)
  const [m1, m2, m3, m4] = [await member(t, bootstrap, assoc), await member(t, bootstrap, assoc), await member(t, bootstrap, assoc), await member(t, bootstrap, assoc)]
  await admit(m1, assoc)
  await admit(m2, assoc)
  for (const m of [m1, m2]) await untilServed(a.seeder, m.key, 2)

  // Clients that must get nothing: a seeder with another Noise key's
  // certificate and a member.
  const bad = await raw(t, bootstrap, a.publicKey, { role: 'seeder', cert: seederCert(assoc, hex(generateNoiseKeyPair().publicKey)) })
  const mem = await raw(t, bootstrap, a.publicKey, { role: 'member' })
  await until(() => seederSide(a.seeder, bad.noiseHex) && seederSide(a.seeder, bad.noiseHex).slotSeederOk === false, { name: 'certificado inválido conferido' })
  await until(() => seederSide(a.seeder, mem.noiseHex) && seederSide(a.seeder, mem.noiseHex).inventoryComplete === true, { name: 'inventário do membro' })

  // The verified one already holds m1 (its hello lists it).
  const good = await rawSeeder(t, bootstrap, assoc, a.publicKey, [{ key: m1.key, length: 2 }])
  await until(() => good.announced(m2.key), { name: 'announce de m2' })
  const sent = good.announced(m2.key)
  const block0 = await m2.diary.get(0)
  t.alike(sent.cert, block0.cert, 'the certificate is the one in block 0')
  t.is(good.announced(m1.key), undefined, 'a key in its hello is not announced')

  // A 'rejected' for a key A does not serve (a seeder sends one to every peer
  // on a drop) neither retires the key nor uses up the cap: m3 is announced
  // once A serves it.
  const goodSide = seederSide(a.seeder, good.noiseHex)
  await until(() => goodSide.announceRelay, { name: 'relay iniciado' })
  good.peer.send({ type: 'rejected', key: m3.key, reason: 'storage-full' })
  await sleep(500)
  t.is(goodSide.announceRelay.has(m3.key), false, 'an unserved rejected key is not retired')
  await admit(m3, assoc)
  await admit(m4, assoc)
  await until(() => good.announced(m3.key) && good.announced(m4.key), { name: 'announce de m3 e m4', timeoutMs: 30000 })
  await sleep(1500)
  t.is(good.announces().length, 3, 'm2, m3 and m4, each once')
  t.is(bad.announces().length, 0, 'an invalid seeder certificate gets none')
  t.is(mem.announces().length, 0, 'a member gets none')
})

test('relay: announceRelay false sends none', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const a = await startSeeder(t, bootstrap, assoc, { announceRelay: false })
  const m = await member(t, bootstrap, assoc)
  await admit(m, assoc)
  await untilServed(a.seeder, m.key, 2)
  const good = await rawSeeder(t, bootstrap, assoc, a.publicKey)
  await until(() => seederSide(a.seeder, good.noiseHex) && seederSide(a.seeder, good.noiseHex).inventoryComplete === true, { name: 'inventário' })
  await sleep(1500)
  t.is(good.announces().length, 0, 'nothing announced')
  t.absent(seederSide(a.seeder, good.noiseHex).announceRelay, 'no relay on the connection')
})

test('relay: B blocklist refuses the diary A serves; nothing is stored', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const a = await startSeeder(t, bootstrap, assoc)
  // Seeders pass the signed list on to each other; A is made to ignore B's,
  // so that A keeps serving the diary B blocks and B's own refusal is what
  // the test sees.
  a.seeder._blocklist.offer = async () => ({ adopted: false, reason: 'same', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() })
  const blockedM = await member(t, bootstrap, assoc)
  const okM = await member(t, bootstrap, assoc)
  await admit(blockedM, assoc)
  await admit(okM, assoc)
  for (const m of [blockedM, okM]) await untilServed(a.seeder, m.key, 2)
  await blockedM.swarm.destroy()
  await okM.swarm.destroy()

  const dirB = prepareSeederDir(t, assoc)
  const mod = makeModerator(assoc)
  writeBlocklist(dirB.dataDir, createSnapshot({ seq: 1, blocked: [blockedM.key], revokedIssuers: [] }, mod.kp, mod.cert))
  const b = await startSeeder(t, bootstrap, assoc, {}, dirB)
  // The other diary proves the relay reached B.
  await until(() => fullyServed(b.seeder, okM.key, 2), { name: 'B serve o outro diário', timeoutMs: 60000 })
  await until(() => b.events.some((e) => e.event === 'rejected' && e.key === blockedM.key && e.reason === 'blocked'), { name: 'B recusa o bloqueado' })
  t.is(await stored(b.seeder, blockedM.key), false, 'nothing of the blocked diary stored on B')
  t.is(b.seeder._served.has(blockedM.key), false)
  t.is(readAdmitted(b.dataDir)[blockedM.key], undefined, 'not listed on B')
  t.alike(b.seeder.admittedKeys(), [okM.key])
  t.ok(a.seeder._served.has(blockedM.key), 'A still serves it')
})

test('relay: B keeps its own seeder cap and storage budget; a repeated announce is idempotent', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const a = await startSeeder(t, bootstrap, assoc)
  const m1 = await member(t, bootstrap, assoc)
  const m2 = await member(t, bootstrap, assoc)
  await admit(m1, assoc)
  await admit(m2, assoc)
  for (const m of [m1, m2]) await untilServed(a.seeder, m.key, 2)
  await m1.swarm.destroy()
  await m2.swarm.destroy()

  // Seeder cap: one of the two diaries, the other seeder-full.
  const capped = await startSeeder(t, bootstrap, assoc, { maxServed: 1 })
  await until(() => capped.seeder.admittedKeys().length === 1 && capped.events.some((e) => e.event === 'rejected' && e.reason === 'seeder-full'), { name: 'um admitido, um seeder-full', timeoutMs: 60000 })
  t.is(capped.seeder._served.size, 1, 'never over the cap')
  const heldKey = capped.seeder.admittedKeys()[0]
  await until(() => fullyServed(capped.seeder, heldKey, 2), { name: 'o admitido chega inteiro' })

  // A repeated announce of the key it serves: admitted again, no new charge.
  const usedBefore = capped.seeder.stats().storage.used
  const adminBefore = JSON.stringify(readAdmitted(capped.dataDir))
  const again = await raw(t, bootstrap, capped.publicKey, { role: 'member' })
  for (let i = 0; i < 2; i++) again.peer.send({ type: 'announce', key: heldKey, cert: validCert(assoc, heldKey) })
  await until(() => again.messages.filter((x) => x.type === 'admitted' && x.key === heldKey).length === 2, { name: 'admitted duas vezes' })
  t.is(capped.seeder.stats().storage.used, usedBefore, 'no extra charge')
  t.is(JSON.stringify(readAdmitted(capped.dataDir)), adminBefore, 'admitted.json unchanged')
  t.is(capped.seeder._served.size, 1)
  await capped.seeder.close()

  // Storage budget: one fits, the second is storage-full.
  const ca = coreCharge(m1.diary)
  const cb = coreCharge(m2.diary)
  const storageBytes = ca + cb
  const storageReserve = cb - Math.floor(cb / 2)
  const small = await startSeeder(t, bootstrap, assoc, { storageBytes, storageReserve })
  await until(() => small.seeder.admittedKeys().length === 1 && small.events.some((e) => e.event === 'rejected' && e.reason === 'storage-full'), { name: 'um admitido, um storage-full', timeoutMs: 60000 })
  const st = small.seeder.stats().storage
  t.ok(st.used <= storageBytes - storageReserve, 'within budget - reserve')
  t.is(small.seeder._served.size, 1)
})

test('relay: 25 diaries reach B under its default limits, no peer dropped', async (t) => {
  t.timeout(240000)
  const N = 25
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  // Only A's announce limits are raised, so one test client can load it fast.
  const a = await startSeeder(t, bootstrap, assoc, { announceBurst: 100, announceRate: 100 })

  // One client carrying N diaries on one connection.
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diaries = []
  for (let i = 0; i < N; i++) {
    const core = store.get({ name: 'd' + i, valueEncoding: 'json' })
    await core.ready()
    const key = hex(core.key)
    await core.append(memberCertRecord(validCert(assoc, key)))
    await core.append(postRecord({ text: 'n' + i }))
    diaries.push({ core, key })
  }
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: diaries.map((d) => ({ key: d.key, length: 2 })) }))
  })
  await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const peer = await until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  for (const d of diaries) peer.send({ type: 'announce', key: d.key, cert: validCert(assoc, d.key) })
  await until(() => diaries.every((d) => fullyServed(a.seeder, d.key, 2)), { name: 'A serve os ' + N, timeoutMs: 120000 })
  await swarm.destroy()
  await store.close()

  const b = await startSeeder(t, bootstrap, assoc)
  await until(() => diaries.every((d) => fullyServed(b.seeder, d.key, 2)), { name: 'B serve os ' + N, timeoutMs: 120000 })
  t.is(b.seeder.admittedKeys().length, N, 'all admitted on B')
  const dropped = (events) => events.filter((e) => e.event === 'peer-dropped')
  t.alike(dropped(b.events), [], 'no peer dropped on B (no announce-rate, no bad-announces)')
  t.alike(dropped(a.events), [], 'no peer dropped on A')
})
