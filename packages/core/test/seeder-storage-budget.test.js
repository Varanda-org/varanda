// The seeder-wide storage budget (lib/storage-budget.js, docs/protocol.md
// section 5): admissions that would not fit budget - reserve are refused
// with storage-full, growth past the budget drops whole owners (largest
// first, ties to the newer admission) down to budget - reserve, and start()
// runs the same pass before the swarm, so a restart picks the same victims.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { discoveryKey } = require('hypercore-crypto')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('../lib/net')
const { memberCertRecord, postRecord, mediaCoreRecord, MEDIA_BLOCK_BYTES } = require('../lib/records')
const { mediaHeader } = require('../lib/media')
const { coreCharge } = require('../lib/storage-budget')
const groups = require('./helpers/seeder-groups')
const { groupPost } = require('../lib/group')

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

// A dropped root its creator bound keeps only that creator in goneRoots,
// with no issuer, as for any drop of a bound root: not a moderation
// outcome, so the entry refuses nothing while the creator is not blocked.
function creatorOnly (t, seeder, file, root, creator) {
  const gone = file.goneRoots || {}
  t.alike(Object.keys(gone), [root], 'only the bound root is remembered')
  t.is((gone[root] || {}).creator, creator)
  t.absent('issuer' in (gone[root] || {}), 'not a moderation outcome: no issuer')
  t.absent(file.revokedCreators)
  t.is(seeder._goneRootReason(root), null, 'it refuses nothing while the creator is not blocked')
}

function readAdmitted (dataDir) {
  return readFile(dataDir).admitted
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
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    log: (e) => events.push(e),
    ...opts
  })
  t.teardown(() => seeder.close(), { force: true })
  return { seeder, events }
}

async function startSeeder (t, bootstrap, dataDir, opts) {
  const s = newSeeder(t, bootstrap, dataDir, opts)
  s.ready = await s.seeder.start()
  return s
}

// A member on the swarm: its diary (certificate, one post of `text`, one
// media-core record per media core) and `cores` raw media cores, each a
// header naming the diary plus `blocks` blocks.
async function member (t, bootstrap, assoc, { cores = 0, blocks = 1, text = 'oi' } = {}) {
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
    await core.append(b4a.from(JSON.stringify(mediaHeader({ diary: key }))))
    for (let b = 0; b < blocks; b++) await core.append(b4a.alloc(b === blocks - 1 ? 1000 : MEDIA_BLOCK_BYTES, (i * 7 + b) % 251))
    media.push(core)
  }
  await diary.append(memberCertRecord(validCert(assoc, key)))
  await diary.append(postRecord({ text }))
  for (const c of media) await diary.append(mediaCoreRecord({ key: hex(c.key) }))

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
  const message = (pred, name, timeoutMs = 20000) => until(() => messages.find(pred), { name, timeoutMs })
  return { store, diary, key, media, mediaKeys: media.map((c) => hex(c.key)), swarm, messages, seederPeer, message }
}

async function announce (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  return peer
}

async function admit (m, assoc) {
  const peer = await announce(m, assoc)
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
  return peer
}

async function stored (seeder, key) {
  return seeder.store.storage.hasCore(discoveryKey(b4a.from(key, 'hex')))
}

// A local diary of `posts` posts of `size` characters each.
async function localDiary (store, name, assoc, posts, size) {
  const core = store.get({ name, valueEncoding: 'json' })
  await core.ready()
  const key = hex(core.key)
  await core.append(memberCertRecord(validCert(assoc, key)))
  for (let i = 0; i < posts; i++) await core.append(postRecord({ text: String(i % 10).repeat(size) }))
  return core
}

// Copies a local core into the (stopped) seeder's main store.
async function preload (dataDir, srcStore, core) {
  const store = new Corestore(path.join(dataDir, 'store'))
  await store.ready()
  const replica = store.get({ key: core.key })
  await replica.ready()
  const s1 = srcStore.replicate(true)
  const s2 = store.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  await replica.download({ start: 0, end: core.length }).done()
  s1.destroy()
  s2.destroy()
  await store.close()
}

function storageWarnings (events) {
  return events.filter((e) => e.event === 'warning' && (e.reason === 'storage-over-budget' || e.reason === 'storage-full'))
}

test('storage budget: an admission past budget - reserve is refused with storage-full; a served diary is still admitted', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const a = await member(t, bootstrap, assoc)
  const b = await member(t, bootstrap, assoc)
  const ca = coreCharge(a.diary)
  const cb = coreCharge(b.diary)
  // a fits, a + b does not.
  const storageBytes = ca + cb
  const storageReserve = cb - Math.floor(cb / 2)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes, storageReserve })
  // A fresh admission is served before its replica holds the signed sizes:
  // its first charge must still be the reserved one.
  let firstServed = null
  const set = seeder._storage.set
  seeder._storage.set = (key, owner, charge) => {
    set(key, owner, charge)
    if (key === a.key && firstServed === null) firstServed = seeder._storage.stats().served
  }

  const pa = await admit(a, assoc)
  t.is(firstServed, ca, 'charged from the first set, before the replica holds the signed sizes')
  await announce(b, assoc)
  await b.message((m) => m.type === 'rejected' && m.key === b.key && m.reason === 'storage-full', 'storage-full')
  t.ok(events.some((e) => e.event === 'rejected' && e.key === b.key && e.reason === 'storage-full'), 'refusal logged')
  t.is(await stored(seeder, b.key), false, 'never opened in the main store')
  t.alike(seeder.admittedKeys(), [a.key])
  t.alike(Object.keys(readAdmitted(dataDir)), [a.key])
  t.alike(seeder.stats().storage, { used: ca, budget: storageBytes, reserve: storageReserve, dropped: 0 })
  t.ok(seeder.stats().storage.used <= storageBytes)

  // A re-announce of a served diary never meets the budget.
  pa.send({ type: 'announce', key: a.key, cert: validCert(assoc, a.key) })
  await until(() => a.messages.filter((m) => m.type === 'admitted' && m.key === a.key).length === 2, { name: 'admitted again' })
  t.absent(a.messages.some((m) => m.type === 'rejected'), 'never refused')
  t.is(storageWarnings(events).length, 0, 'no drop')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('storage budget: with no room left no block 0 is fetched', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const a = await member(t, bootstrap, assoc)
  const b = await member(t, bootstrap, assoc)
  const ca = coreCharge(a.diary)
  const gated = []
  // budget - reserve is exactly a's charge.
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes: 2 * ca, storageReserve: ca, gateHook: (key) => gated.push(key) })
  await admit(a, assoc)
  await announce(b, assoc)
  await b.message((m) => m.type === 'rejected' && m.key === b.key && m.reason === 'storage-full', 'storage-full')
  t.alike(gated, [a.key], 'the gate never ran for b')
  t.alike(seeder.admittedKeys(), [a.key])
})

test('storage budget: growth past the budget drops the largest owner with its media; a restart at the same budget drops nothing', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const a = await member(t, bootstrap, assoc, { cores: 1, blocks: 1 })
  const b = await member(t, bootstrap, assoc)
  const K = a.mediaKeys[0]
  const ca = coreCharge(a.diary) + coreCharge(a.media[0])
  const cb = coreCharge(b.diary)
  // Both fit; one more media block (MEDIA_BLOCK_BYTES) takes the total past
  // the budget, and dropping a alone brings it back under budget - reserve.
  const storageBytes = ca + cb + 16384
  const storageReserve = 8192
  const opts = { associationKey: assoc.hex, storageBytes, storageReserve }
  const first = await startSeeder(t, bootstrap, dataDir, opts)
  const { seeder, events } = first

  await admit(b, assoc)
  await admit(a, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'media-admitted', timeoutMs: 30000 })
  await until(() => seeder.stats().storage.used === ca + cb, { name: 'a, its media and b charged' })
  t.is(storageWarnings(events).length, 0, 'under the budget: no drop')

  await a.media[0].append(b4a.alloc(MEDIA_BLOCK_BYTES, 9))
  const grown = coreCharge(a.diary) + coreCharge(a.media[0])
  await a.message((m) => m.type === 'rejected' && m.key === a.key && m.reason === 'storage-full', 'rejected storage-full', 30000)
  await b.message((m) => m.type === 'rejected' && m.key === a.key && m.reason === 'storage-full', 'broadcast to every peer')
  const over = events.findIndex((e) => e.event === 'warning' && e.reason === 'storage-over-budget')
  t.ok(over >= 0, 'over-budget warning')
  t.is(events[over].budget, storageBytes)
  t.is(events[over].used, grown + cb, 'used before the drop')
  const victim = events.findIndex((e) => e.event === 'warning' && e.reason === 'storage-full' && e.key === a.key)
  t.ok(victim > over, 'victim warning after the pass warning')
  t.is(events[victim].bytes, grown, 'the owner charge: its diary and its media core')
  t.alike(storageWarnings(events).map((e) => e.key || null), [null, a.key], 'one pass, one victim')
  t.ok(events.some((e) => e.event === 'media-rejected' && e.key === K && e.reason === 'storage-full'), 'its media core went with it')
  t.ok(events.some((e) => e.event === 'rejected' && e.key === a.key && e.reason === 'storage-full'))

  await until(async () => seeder._drops.size === 0 && !(a.key in readAdmitted(dataDir)) && !(await stored(seeder, a.key)) && !(await stored(seeder, K)), { name: 'a purgado' })
  const file = readFile(dataDir)
  t.alike(Object.keys(file.admitted), [b.key])
  t.alike(file.media || {}, {})
  t.absent(file.goneRoots, 'not a moderation outcome')
  t.absent(file.revokedCreators, 'not a moderation outcome')
  t.alike(seeder.admittedKeys(), [b.key])
  t.alike(seeder.stats().storage, { used: cb, budget: storageBytes, reserve: storageReserve, dropped: 1 })
  t.ok(seeder.stats().storage.used <= storageBytes - storageReserve, 'served <= budget - reserve')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)

  // The same budget after the runtime drop: nothing more goes.
  await seeder.close()
  const second = await startSeeder(t, bootstrap, dataDir, opts)
  t.is(storageWarnings(second.events).length, 0, 'no drop at start')
  t.alike(second.ready.admitted, [b.key])
  t.alike(second.seeder.stats().storage, { used: cb, budget: storageBytes, reserve: storageReserve, dropped: 0 })
})

test('storage budget: a restart with a smaller budget drops largest first, ties to the newer admission, before ready', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const src = new Corestore(tmpDir(t, 'varanda-local-'))
  await src.ready()
  t.teardown(() => src.close(), { force: true })
  const big = await localDiary(src, 'big', assoc, 3, 900)
  const x = await localDiary(src, 'x', assoc, 2, 10)
  const y = await localDiary(src, 'y', assoc, 2, 10)
  const bigKey = hex(big.key)
  // The newer of the two equal diaries gets the larger key, so the newer
  // admission and the key order pick different victims.
  const [older, newer] = [hex(x.key), hex(y.key)].sort()
  const cBig = coreCharge(big)
  const cSmall = coreCharge(x)
  t.is(coreCharge(y), cSmall, 'the two small diaries tie')
  for (const core of [big, x, y]) await preload(dataDir, src, core)
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({
    v: 1,
    admitted: { [bigKey]: validCert(assoc, bigKey), [older]: validCert(assoc, older), [newer]: validCert(assoc, newer) }
  }))
  await src.close()

  const roomy = await startSeeder(t, bootstrap, dataDir, {})
  t.is(storageWarnings(roomy.events).length, 0, 'the default budget holds them all')
  t.alike(roomy.ready.admitted, [bigKey, older, newer])
  t.is(roomy.seeder.stats().storage.used, cBig + 2 * cSmall)
  await roomy.seeder.close()

  // Over the budget by one byte; after big goes, the two small ones are
  // still over budget - reserve, so one of them goes too.
  const storageBytes = cBig + 2 * cSmall - 1
  const storageReserve = storageBytes - (cSmall + Math.floor(cSmall / 2))
  const opts = { storageBytes, storageReserve }
  const tight = await startSeeder(t, bootstrap, dataDir, opts)
  const readyAt = tight.events.findIndex((e) => e.event === 'ready')
  const warnings = storageWarnings(tight.events)
  t.alike(warnings.map((e) => [e.reason, e.key || null]), [['storage-over-budget', null], ['storage-full', bigKey], ['storage-full', newer]], 'largest first, then the newer admission')
  t.is(warnings[0].used, cBig + 2 * cSmall)
  t.is(warnings[1].bytes, cBig)
  t.is(warnings[2].bytes, cSmall)
  for (const key of [bigKey, newer]) {
    const i = tight.events.findIndex((e) => e.event === 'rejected' && e.key === key && e.reason === 'storage-full')
    t.ok(i >= 0 && i < readyAt, 'dropped before ready: ' + key.slice(0, 8))
    t.is(await stored(tight.seeder, key), false, 'purged before ready')
    t.absent(tight.seeder.swarm.status(discoveryKey(b4a.from(key, 'hex'))), 'topic never joined')
  }
  t.alike(tight.ready.admitted, [older])
  t.alike(Object.keys(readAdmitted(dataDir)), [older])
  const ready = tight.events[readyAt]
  t.alike(ready.cores.diaries, { kept: 1, dropped: 2 })
  t.alike(tight.seeder.stats().storage, { used: cSmall, budget: storageBytes, reserve: storageReserve, dropped: 2 })
  t.is(tight.events.filter((e) => e.event === 'fatal').length, 0)
  await tight.seeder.close()

  const again = await startSeeder(t, bootstrap, dataDir, opts)
  t.is(storageWarnings(again.events).length, 0, 'a second restart drops nothing more')
  t.alike(again.ready.admitted, [older])
  t.alike(again.events.find((e) => e.event === 'ready').cores.diaries, { kept: 1, dropped: 0 })
})

test('storage budget: a purge failure mid-drop at start fails the start and keeps the victim listed; the next start purges it', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const src = new Corestore(tmpDir(t, 'varanda-local-'))
  await src.ready()
  t.teardown(() => src.close(), { force: true })
  const big = await localDiary(src, 'big', assoc, 3, 900)
  const small = await localDiary(src, 'small', assoc, 1, 10)
  const bigKey = hex(big.key)
  const smallKey = hex(small.key)
  const storageBytes = coreCharge(big) + coreCharge(small) - 1
  for (const core of [big, small]) await preload(dataDir, src, core)
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({
    v: 1,
    admitted: { [smallKey]: validCert(assoc, smallKey), [bigKey]: validCert(assoc, bigKey) }
  }))
  await src.close()

  const failing = newSeeder(t, bootstrap, dataDir, {
    storageBytes,
    purgeHook: async () => { throw new Error('falha simulada') }
  })
  await t.exception(failing.seeder.start(), /falha ao limpar núcleos na partida/, 'start fails')
  t.ok(failing.events.some((e) => e.event === 'warning' && e.reason === 'storage-full' && e.key === bigKey), 'big picked')
  t.ok(failing.events.some((e) => e.event === 'fatal' && e.key === bigKey && e.reason === 'purge-failed'))
  t.absent(failing.events.some((e) => e.event === 'ready'), 'never ready')
  t.alike(Object.keys(readAdmitted(dataDir)).sort(), [bigKey, smallKey].sort(), 'the victim stays listed')

  const next = await startSeeder(t, bootstrap, dataDir, { storageBytes })
  const warnings = storageWarnings(next.events)
  t.alike(warnings.map((e) => e.key || null), [null, bigKey], 'the same victim')
  t.alike(next.ready.admitted, [smallKey])
  t.alike(Object.keys(readAdmitted(dataDir)), [smallKey])
  t.is(await stored(next.seeder, bigKey), false, 'purged')
  t.is(next.events.filter((e) => e.event === 'fatal').length, 0)
})

test('storage budget: a media core that does not fit is refused with storage-full, never stored', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const m = await member(t, bootstrap, assoc, { cores: 1, blocks: 3 })
  const K = m.mediaKeys[0]
  const cd = coreCharge(m.diary)
  const cm = coreCharge(m.media[0])
  // The diary fits; the diary and its media core do not.
  const storageBytes = cd + cm
  const storageReserve = cm - Math.floor(cm / 2)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes, storageReserve })

  await admit(m, assoc)
  await until(() => events.find((e) => e.event === 'media-rejected' && e.key === K && e.reason === 'storage-full'), { name: 'media storage-full', timeoutMs: 30000 })
  await until(() => seeder._inflight.size === 0 && seeder._mediaReserved.size === 0, { name: 'nada em admissão' })
  t.is(await stored(seeder, K), false, 'never stored')
  t.alike(seeder.mediaKeys(), [])
  t.alike(readFile(dataDir).media || {}, {})
  t.alike(seeder.admittedKeys(), [m.key], 'the diary stays')
  t.alike(seeder.stats().storage, { used: cd, budget: storageBytes, reserve: storageReserve, dropped: 0 })
  t.absent(events.some((e) => e.event === 'media-admitted'), 'never admitted')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('storage budget: a group writer that does not fit after its fetch is refused with storage-full, never stored, and keeps the group\'s answers incomplete', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { A, B, R, W } = await groups.creatorAndMember(t, bootstrap, assoc)
  const cA = coreCharge(A.diary)
  const cR = coreCharge(A.cores.root)
  const cB = coreCharge(B.diary)
  const cW = coreCharge(B.cores.w)
  // A, R and B fit and leave room (so the pre-fetch check passes for W);
  // W's signed sizes do not fit, so its reservation after the fetch fails.
  const storageBytes = cA + cR + cB + cW
  const storageReserve = cW - Math.floor(cW / 2)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes, storageReserve })

  await groups.admit(A, assoc)
  await groups.admitted(events, R)
  await groups.downloaded(seeder, R, 2)
  await groups.admit(B, assoc)
  await groups.rejected(events, W, 'storage-full')
  await until(() => groups.scansDone(seeder) && seeder._groupReserved.size === 0 && seeder._inflight.size === 0, { name: 'varreduras' })
  t.is(await stored(seeder, W), false, 'never stored')
  t.ok(await stored(seeder, R), 'the root that fit is stored')
  t.alike(Object.keys(groups.readGroups(dataDir)), [R], 'W never listed in admitted.json groups')
  t.alike(seeder.admittedKeys().sort(), [A.key, B.key].sort(), 'both diaries stay')
  t.alike(seeder.stats().storage, { used: cA + cR + cB, budget: storageBytes, reserve: storageReserve, dropped: 0 })
  t.ok(seeder._storage.room(), 'room left: the refusal came from the post-fetch reservation')
  t.absent(events.some((e) => e.event === 'group-admitted' && e.key === W), 'never admitted')

  // The seeder's own capacity, like group-full: answers about R stay
  // incomplete while the refusal holds.
  t.is(seeder.indexGroup(R).complete, false, 'W is missing for the seeder\'s own capacity')
  t.is(seeder.indexGroups(B.key).complete, false, 'and B\'s group list says so')
  t.is(seeder.indexGroupSearch('cadeiras').complete, false, 'and so does search')
  t.is(storageWarnings(events).length, 0, 'no drop')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('storage budget: a group root is its own owner, so its growth never drops the member whose join admitted it', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { A, B, R, W } = await groups.creatorAndMember(t, bootstrap, assoc)
  const root = A.cores.root
  const grown = []
  for (let i = 0; i < 8; i++) grown.push(groups.encode(groupPost({ text: 'x'.repeat(1000) })))
  const cA = coreCharge(A.diary)
  const cR0 = coreCharge(root)
  const cB = coreCharge(B.diary)
  const cW = coreCharge(B.cores.w)
  const cR1 = coreCharge({ length: root.length + grown.length, byteLength: root.byteLength + grown.reduce((n, b) => n + b.byteLength, 0) })
  t.ok(cR1 > cA + cR0 && cR1 > cB + cW, 'once grown, the root alone outweighs A with its first charge, and B')
  // Everything fits at first; R's growth passes the budget by one byte.
  // Dropping R alone brings what is served under the limit, and R no
  // longer fits there, so it is not admitted again at once.
  const storageBytes = cA + cB + cW + cR1 - 1
  const storageReserve = Math.floor((cR1 - 1 - cR0) / 2)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes, storageReserve })

  await groups.admit(A, assoc)
  await groups.admitted(events, R)
  await groups.downloaded(seeder, R, root.length)
  await groups.admit(B, assoc)
  await groups.admitted(events, W)
  await groups.downloaded(seeder, W, B.cores.w.length)
  t.is(storageWarnings(events).length, 0, 'no drop before the growth')

  await root.append(grown)
  await until(() => events.some((e) => e.event === 'warning' && e.reason === 'storage-full'), { name: 'storage-full' })
  await until(() => !seeder._groupServed.has(R) && !(R in groups.readGroups(dataDir)) && seeder._drops.size === 0, { name: 'R purgado' })
  const drops = events.filter((e) => e.event === 'warning' && e.reason === 'storage-full')
  t.alike(drops.map((e) => e.key), [R], 'only the root is dropped')
  t.is(drops[0].bytes, cR1, 'charged to itself alone')
  t.alike(seeder.admittedKeys().sort(), [A.key, B.key].sort(), 'A, whose join admitted the root, stays')
  t.ok(seeder._storage.stats().served <= seeder._storage.limit, 'what is served fits the limit again')
  t.is(seeder.stats().storage.dropped, 1)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

function shareWarnings (events) {
  return events.filter((e) => e.event === 'warning' && e.reason === 'storage-member-over')
}

const GIB = 1024 * 1024 * 1024

test('storage budget: a media core past its member\'s fair share is refused with storage-full while the budget has room', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const m = await member(t, bootstrap, assoc, { cores: 1, blocks: 3 })
  const K = m.mediaKeys[0]
  const cd = coreCharge(m.diary)
  const cm = coreCharge(m.media[0])
  const storageMemberCap = cd + cm - 1
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes: GIB, storageMemberCap })

  await admit(m, assoc)
  await until(() => events.find((e) => e.event === 'media-rejected' && e.key === K && e.reason === 'storage-full'), { name: 'media storage-full', timeoutMs: 30000 })
  await until(() => seeder._inflight.size === 0 && seeder._mediaReserved.size === 0, { name: 'nada em admissão' })
  t.is(await stored(seeder, K), false, 'never stored')
  t.alike(seeder.mediaKeys(), [])
  t.alike(seeder.admittedKeys(), [m.key], 'the diary stays')
  t.is(seeder.stats().storage.used, cd)
  t.ok(seeder._storage.room(), 'the budget has room: the refusal is the member\'s share')
  t.absent(events.some((e) => e.event === 'media-admitted'), 'never admitted')
  t.is(storageWarnings(events).length + shareWarnings(events).length, 0, 'no drop')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('storage budget: a group root past its member\'s fair share is dropped, never the member', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { A, B, R, W } = await groups.creatorAndMember(t, bootstrap, assoc)
  const root = A.cores.root
  const grown = []
  for (let i = 0; i < 8; i++) grown.push(groups.encode(groupPost({ text: 'x'.repeat(1000) })))
  const cA = coreCharge(A.diary)
  const cR0 = coreCharge(root)
  const cB = coreCharge(B.diary)
  const cW = coreCharge(B.cores.w)
  const cR1 = coreCharge({ length: root.length + grown.length, byteLength: root.byteLength + grown.reduce((n, b) => n + b.byteLength, 0) })
  // Each member fits with the root as it starts; neither A, whose join
  // brought it in, nor B, whose join names it too, fits with the grown
  // root. The budget itself never runs short.
  const storageMemberCap = Math.min(cA, cB + cW) + cR1 - 1
  t.ok(cA + cR0 <= storageMemberCap && cB + cW <= storageMemberCap, 'everything fits at first')
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes: GIB, storageMemberCap })

  await groups.admit(A, assoc)
  await groups.admitted(events, R)
  await groups.downloaded(seeder, R, root.length)
  await groups.admit(B, assoc)
  await groups.admitted(events, W)
  await groups.downloaded(seeder, W, B.cores.w.length)
  t.is(storageWarnings(events).length + shareWarnings(events).length, 0, 'no drop before the growth')

  await root.append(grown)
  await until(() => events.some((e) => e.event === 'warning' && e.reason === 'storage-full'), { name: 'storage-full' })
  await until(() => !seeder._groupServed.has(R) && !(R in groups.readGroups(dataDir)) && seeder._drops.size === 0, { name: 'R purgado' })
  await until(() => groups.scansDone(seeder) && seeder._groupReserved.size === 0 && seeder._inflight.size === 0, { name: 'varreduras' })
  const over = shareWarnings(events)
  t.ok(over.length >= 1, 'the share warning')
  t.is(over[0].key, A.key, 'A, whose join brought the root in')
  t.is(over[0].cap, storageMemberCap)
  t.ok(over[0].bytes > storageMemberCap)
  t.alike(storageWarnings(events).map((e) => e.key), [R], 'only the root is dropped')
  t.absent(events.some((e) => e.event === 'warning' && e.reason === 'storage-over-budget'), 'the budget itself never ran short')
  t.alike(seeder.admittedKeys().sort(), [A.key, B.key].sort(), 'both members stay')
  t.absent(seeder._groupServed.has(R), 'the grown root fits no member\'s share, so it is not admitted again')
  t.is(seeder.stats().storage.dropped, 1)
  const file = readFile(dataDir)
  creatorOnly(t, seeder, file, R, A.key)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('storage budget: a member whose own cores pass its fair share is dropped with its media', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const a = await member(t, bootstrap, assoc, { cores: 1, blocks: 1 })
  const b = await member(t, bootstrap, assoc)
  const K = a.mediaKeys[0]
  const ca = coreCharge(a.diary) + coreCharge(a.media[0])
  const cb = coreCharge(b.diary)
  // a fits its share; one more media block (MEDIA_BLOCK_BYTES) passes it.
  const storageMemberCap = ca + 16384
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes: GIB, storageMemberCap })

  await admit(b, assoc)
  await admit(a, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'media-admitted', timeoutMs: 30000 })
  await until(() => seeder.stats().storage.used === ca + cb, { name: 'a, its media and b charged' })

  await a.media[0].append(b4a.alloc(MEDIA_BLOCK_BYTES, 9))
  const grown = coreCharge(a.diary) + coreCharge(a.media[0])
  await a.message((m) => m.type === 'rejected' && m.key === a.key && m.reason === 'storage-full', 'rejected storage-full', 30000)
  await until(async () => seeder._drops.size === 0 && !(a.key in readAdmitted(dataDir)) && !(await stored(seeder, K)), { name: 'a purgado' })
  t.alike(shareWarnings(events).map((e) => [e.key, e.bytes, e.cap]), [[a.key, grown, storageMemberCap]])
  t.alike(storageWarnings(events).map((e) => [e.key, e.bytes]), [[a.key, grown]], 'a alone, with its own bytes')
  t.ok(events.some((e) => e.event === 'media-rejected' && e.key === K && e.reason === 'storage-full'), 'its media core went with it')
  t.alike(seeder.admittedKeys(), [b.key])
  t.alike(seeder.stats().storage, { used: cb, budget: GIB, reserve: Math.floor(GIB / 10), dropped: 1 })
  const file = readFile(dataDir)
  t.absent(file.goneRoots, 'not a moderation outcome')
  t.absent(file.revokedCreators, 'not a moderation outcome')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('storage budget: over the budget, a group root goes before a larger member', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { A, B, R, W } = await groups.creatorAndMember(t, bootstrap, assoc)
  const c = await member(t, bootstrap, assoc, { cores: 1, blocks: 2 })
  const root = A.cores.root
  const grown = []
  for (let i = 0; i < 8; i++) grown.push(groups.encode(groupPost({ text: 'x'.repeat(1000) })))
  const cA = coreCharge(A.diary)
  const cR0 = coreCharge(root)
  const cB = coreCharge(B.diary)
  const cW = coreCharge(B.cores.w)
  const cC = coreCharge(c.diary) + coreCharge(c.media[0])
  const cR1 = coreCharge({ length: root.length + grown.length, byteLength: root.byteLength + grown.reduce((n, b) => n + b.byteLength, 0) })
  t.ok(cC > cR1 && cC > cA && cC > cB + cW, 'c is the largest owner, the grown root included')
  // Everything fits at first; R's growth passes the budget by one byte,
  // and dropping either R or c alone brings it back under the limit.
  const storageBytes = cA + cB + cW + cC + cR1 - 1
  const storageReserve = Math.floor((cR1 - 1 - cR0) / 2)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes, storageReserve })

  await groups.admit(A, assoc)
  await groups.admitted(events, R)
  await groups.downloaded(seeder, R, root.length)
  await groups.admit(B, assoc)
  await groups.admitted(events, W)
  await groups.downloaded(seeder, W, B.cores.w.length)
  await admit(c, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === c.mediaKeys[0]), { name: 'media-admitted', timeoutMs: 30000 })
  await until(() => seeder.stats().storage.used === cA + cR0 + cB + cW + cC, { name: 'everything charged' })
  t.is(storageWarnings(events).length, 0, 'no drop before the growth')

  await root.append(grown)
  await until(() => events.some((e) => e.event === 'warning' && e.reason === 'storage-full'), { name: 'storage-full' })
  await until(() => !seeder._groupServed.has(R) && seeder._drops.size === 0, { name: 'R purgado' })
  t.alike(storageWarnings(events).map((e) => e.key || null), [null, R], 'one pass: the root, not the larger member')
  t.alike(seeder.admittedKeys().sort(), [A.key, B.key, c.key].sort(), 'every member stays')
  t.ok(seeder._storage.stats().served <= seeder._storage.limit, 'what is served fits the limit again')
  t.is(seeder.stats().storage.dropped, 1)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('storage budget: roots filling a member\'s fair share never keep its own media out; the roots are shed instead', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { A, R } = await groups.creatorAndMember(t, bootstrap, assoc)
  const root = A.cores.root
  const grown = []
  for (let i = 0; i < 8; i++) grown.push(groups.encode(groupPost({ text: 'x'.repeat(1000) })))
  // A media core A announces only once its root fills its share.
  const media = A.store.get({ name: 'media-0' })
  await media.ready()
  await media.append(b4a.from(JSON.stringify(mediaHeader({ diary: A.key }))))
  await media.append(b4a.alloc(1000, 3))
  const K = hex(media.key)
  const record = mediaCoreRecord({ key: K })
  const cA = coreCharge(A.diary)
  const cA1 = cA + b4a.byteLength(JSON.stringify(record)) + 128
  const cR0 = coreCharge(root)
  const cR1 = coreCharge({ length: root.length + grown.length, byteLength: root.byteLength + grown.reduce((n, b) => n + b.byteLength, 0) })
  const cM = coreCharge(media)
  // Once grown, the root fills A's share to the byte (with the record in
  // A's diary), so nothing is shed; the media core fits A's own cores, not
  // the whole share.
  const storageMemberCap = cA1 + cR1
  t.ok(cM <= cR1 && cM > cA1 - cA, 'the media core fits A\'s own cores, never the full share')
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes: GIB, storageMemberCap })

  await groups.admit(A, assoc)
  await groups.admitted(events, R)
  await groups.downloaded(seeder, R, root.length)
  t.is(seeder._storage.memberUse(A.key), cA + cR0)
  await root.append(grown)
  await groups.downloaded(seeder, R, root.length)
  await until(() => seeder._storage.memberUse(A.key) === cA + cR1, { name: 'R cresceu' })
  t.is(storageWarnings(events).length + shareWarnings(events).length, 0, 'the grown root fits the share: nothing shed')

  await A.diary.append(record)
  t.is(coreCharge(A.diary), cA1)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'media-admitted', timeoutMs: 30000 })
  await until(() => !seeder._groupServed.has(R) && !(R in groups.readGroups(dataDir)) && seeder._drops.size === 0, { name: 'R purgado' })
  await until(() => groups.scansDone(seeder) && seeder._groupReserved.size === 0 && seeder._inflight.size === 0 && seeder._mediaReserved.size === 0, { name: 'varreduras' })
  t.absent(events.some((e) => e.event === 'media-rejected' && e.key === K), 'never refused')
  t.alike(shareWarnings(events).map((e) => e.key), [A.key], 'A passed its share')
  t.alike(storageWarnings(events).map((e) => e.key), [R], 'only the root is dropped')
  t.alike(seeder.admittedKeys(), [A.key], 'A stays')
  t.alike(seeder.mediaKeys(), [K], 'with its media core')
  t.is(seeder._storage.memberUse(A.key), cA1 + cM, 'A\'s share holds its own cores')
  t.is(seeder.stats().storage.dropped, 1)
  const file = readFile(dataDir)
  creatorOnly(t, seeder, file, R, A.key)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('storage budget: a group writer past its member\'s fair share backs off without holding the group\'s answers back', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { A, B, R, W } = await groups.creatorAndMember(t, bootstrap, assoc)
  const cA = coreCharge(A.diary)
  const cR = coreCharge(A.cores.root)
  const cB = coreCharge(B.diary)
  const cW = coreCharge(B.cores.w)
  // B's share takes its diary but not its writer: the check before the
  // fetch passes, and the reservation after it fails on the share alone.
  const storageMemberCap = cB + cW - 1
  t.ok(cA + cR <= storageMemberCap, 'A and its root fit')
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, storageBytes: GIB, storageMemberCap })

  await groups.admit(A, assoc)
  await groups.admitted(events, R)
  await groups.downloaded(seeder, R, 2)
  await groups.admit(B, assoc)
  await groups.rejected(events, W, 'storage-full')
  await until(() => groups.scansDone(seeder) && seeder._groupReserved.size === 0 && seeder._inflight.size === 0, { name: 'varreduras' })
  t.is(await stored(seeder, W), false, 'never stored')
  t.ok(seeder._storage.room(), 'the budget has room: the refusal is B\'s share')
  t.ok(seeder._groupBackingOff(B.key, W), 'the join backs off')
  // B's own limit, like the per-diary caps: answers about R stay final.
  t.is(seeder.indexGroup(R).complete, true, 'the share never holds the group back')
  t.is(seeder.indexGroups(B.key).complete, true, 'nor B\'s group list')
  t.is(seeder.indexGroupSearch('cadeiras').complete, true, 'nor search')

  // The same refusal before the fetch, with B's share already full.
  seeder._storage.memberRoom = () => false
  seeder._deleteGroupBackoff(B.key + ':' + W)
  seeder._reconcileDiaries([B.key])
  await until(() => seeder._groupBackingOff(B.key, W), { name: 'nova espera' })
  t.is(seeder._inflight.size, 0, 'refused before any fetch')
  t.is(seeder.indexGroup(R).complete, true, 'still final')
  t.is(seeder.indexGroupSearch('cadeiras').complete, true)
  t.is(storageWarnings(events).length + shareWarnings(events).length, 0, 'no drop')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
