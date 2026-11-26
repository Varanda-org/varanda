'use strict'

// Protocol versioning at the block-0 gate: a certificate from a newer format
// answers 'unsupported-cert-version' (never 'not-in-log') in the seeder, the
// follower and the feed, and nothing is kept or served because of it. The
// rest of a log that a newer writer extended still replicates and reads, with
// the blocks this reader cannot parse listed as invalid.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { testnet, until, localSwarmOptions, newSession, connect } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const { runSync } = require('../lib/sync')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('../lib/net')
const { memberCertRecord, profileRecord, postRecord, deleteRecord } = require('../lib/records')
const { initAssociation, issueCertificate, issueSeederCertificate } = require('../lib/assoc')
const { openStore, openReplica, writeConfig, writeFollows, openDiary, appendRecord } = require('../lib/store')

const UNSUPPORTED = 'unsupported-cert-version'

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

function futureCert (assoc, key) {
  return { ...createCert({ member: key }, assoc.kp), v: 3 }
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

async function startSeeder (t, bootstrap, assoc) {
  const { dataDir } = prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: assoc.hex, log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events }
}

// A raw member client with its own diary of JSON blocks, talking to a seeder.
async function client (t, bootstrap, assoc, blocks) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  const core = store.get({ name: 'diary', valueEncoding: 'json' })
  await core.ready()
  const key = hex(core.key)
  for (const b of blocks(key)) await core.append(b)
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: core.length }], onmessage: (msg) => messages.push(msg) }))
  })
  await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const message = (pred, name) => until(() => messages.find(pred), { name, timeoutMs: 20000 })
  return { core, key, messages, seederPeer, message }
}

function nothingWithin (core, ms) {
  return core.get(0, { timeout: ms }).then(() => false, () => true)
}

test('seeder: a v3 announce and a v3 block 0 are rejected as unsupported-cert-version and never served', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { seeder, events } = await startSeeder(t, bootstrap, assoc)
  const reasonFor = (c, key, reason) => c.message((m) => m.type === 'rejected' && m.key === key && m.reason === reason, reason)

  // (a) the announced certificate is from a newer format.
  const a = await client(t, bootstrap, assoc, (key) => [memberCertRecord(createCert({ member: key }, assoc.kp)), post('um')])
  const aPeer = await a.seederPeer()
  aPeer.send({ type: 'announce', key: a.key, cert: futureCert(assoc, a.key) })
  await reasonFor(a, a.key, UNSUPPORTED)

  // (b) the announce is a valid v2 certificate but block 0 holds a v3 one.
  const b = await client(t, bootstrap, assoc, (key) => [{ type: 'member-cert', cert: futureCert(assoc, key) }, post('um')])
  const bPeer = await b.seederPeer()
  bPeer.send({ type: 'announce', key: b.key, cert: createCert({ member: b.key }, assoc.kp) })
  await reasonFor(b, b.key, UNSUPPORTED)

  t.alike(seeder.admittedKeys(), [], 'nothing admitted')
  t.is(events.filter((e) => e.event === 'admitted').length, 0)
  t.ok(events.some((e) => e.event === 'rejected' && e.key === b.key && e.reason === UNSUPPORTED))

  // The key was never served: a reader finds no block 0 through the seeder.
  const reader = new Corestore(tmpDir(t, 'varanda-reader-'))
  await reader.ready()
  t.teardown(() => reader.close(), { force: true })
  const probe = reader.get({ key: b4a.from(b.key, 'hex') })
  await probe.ready()
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  swarm.on('connection', (socket) => { socket.on('error', () => {}); reader.replicate(socket) })
  swarm.join(probe.discoveryKey)
  t.ok(await nothingWithin(probe, 1500), 'no block 0 served for the v3 diary')
})

test('seeder: a forged v3 announce for an already served key leaves it served', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { seeder } = await startSeeder(t, bootstrap, assoc)
  const author = await client(t, bootstrap, assoc, (key) => [memberCertRecord(createCert({ member: key }, assoc.kp)), post('um'), post('dois')])
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert: createCert({ member: author.key }, assoc.kp) })
  await author.message((m) => m.type === 'admitted' && m.key === author.key, 'admitted')
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3')

  peer.send({ type: 'announce', key: author.key, cert: futureCert(assoc, author.key) })
  await author.message((m) => m.type === 'rejected' && m.key === author.key && m.reason === UNSUPPORTED, 'rejected')
  t.alike(seeder.admittedKeys(), [author.key], 'still admitted')
  const held = seeder.stats()
  t.ok(held, 'stats still readable')
  await author.core.append(post('tres'))
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 4, 'still served, grows to 4')
})

async function rawNode (t, bootstrap, have) {
  const store = new Corestore(tmpDir(t, 'varanda-raw-'))
  await store.ready()
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { force: true })
  const peers = new Set()
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    const peer = attachAdmission(socket, { role: 'member', have: have(), onmessage: () => {}, onclose: (p) => peers.delete(p) })
    peers.add(peer)
  })
  return { store, swarm, peers }
}

async function makeMember (t, kp) {
  const dir = tmpDir(t, 'varanda-sync-')
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = hex(diary.key)
    writeConfig(dir, { v: 1, role: 'member', association: hex(kp.publicKey) })
    await appendRecord(diary, memberCertRecord(createCert({ member: key }, kp)))
    await appendRecord(diary, profileRecord({ name: 'Membro', bio: '' }))
    return { dir, key }
  } finally {
    await store.close()
  }
}

test('follower: a followed v3 block 0 is skipped as unsupported-cert-version and the replica purged', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const author = await rawNode(t, bootstrap, () => [{ key: hex(core.key), length: core.length }])
  const core = author.store.get({ name: 'future', valueEncoding: 'json' })
  await core.ready()
  await core.append({ type: 'member-cert', cert: { ...createCert({ member: hex(core.key) }, kp), v: 3 } })
  await core.append(postRecord({ text: 'x' }))
  await joinAndFlush(author.swarm, [topicFor(hex(kp.publicKey)), core.discoveryKey])

  const b = await makeMember(t, kp)
  writeFollows(b.dir, [hex(core.key)])
  const events = []
  const rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 30000, onEvent: (e) => events.push(e) })
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.alike(rb.skipped, [{ key: hex(core.key), reason: UNSUPPORTED }])
  t.absent(hex(core.key) in rb.downloaded)
  t.ok(events.some((e) => e.event === 'skipped' && e.key === hex(core.key) && e.reason === UNSUPPORTED))
  const store = await openStore(b.dir)
  try {
    const replica = await openReplica(store, hex(core.key))
    t.is(replica.contiguousLength, 0, 'purged')
  } finally {
    await store.close()
  }
})

test('follower: a rejected message from a non-seeder peer does not drop or purge a followed replica', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const author = await rawNode(t, bootstrap, () => [{ key: hex(core.key), length: core.length }])
  const core = author.store.get({ name: 'ok', valueEncoding: 'json' })
  await core.ready()
  await core.append(memberCertRecord(createCert({ member: hex(core.key) }, kp)))
  await core.append(postRecord({ text: 'x' }))
  await joinAndFlush(author.swarm, [topicFor(hex(kp.publicKey)), core.discoveryKey])
  // A second member that refuses the key on every connection.
  const noisy = await rawNode(t, bootstrap, () => [])
  noisy.swarm.on('connection', () => {
    setTimeout(() => { for (const p of noisy.peers) p.send({ type: 'rejected', key: hex(core.key), reason: UNSUPPORTED }) }, 200)
  })
  await joinAndFlush(noisy.swarm, [topicFor(hex(kp.publicKey))])

  const b = await makeMember(t, kp)
  writeFollows(b.dir, [hex(core.key)])
  const rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 30000 })
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.alike(rb.skipped, [])
  t.is(rb.downloaded[hex(core.key)], 2)
  const store = await openStore(b.dir)
  try {
    const replica = await openReplica(store, hex(core.key))
    t.is(replica.contiguousLength, 2, 'replica kept')
  } finally {
    await store.close()
  }
})

function association (t) {
  const dir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey } = initAssociation(dir)
  return { dir, hex: publicKey }
}

async function sessionMember (t, bootstrap, assoc) {
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assoc.hex, bootstrap })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assoc.dir, { member: publicKey }) })
  return { dataDir, session, publicKey, ...link }
}

async function syncOnce (t, m, label) {
  const { runId } = await m.call('sync.start', { once: true, timeoutMs: 30000 })
  const stopped = await until(() => m.events.find((e) => e.event === 'sync.stopped' && e.data.runId === runId), { timeoutMs: 60000, name: label })
  t.is(stopped.data.result.ok, true, label + ' ok')
  return stopped.data.result
}

test('a log extended by a newer writer replicates whole; unknown blocks read as malformed, known posts keep their seqs', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const sdir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(sdir, assoc.hex)
  const { publicKey: seederKey } = Seeder.createKey(sdir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(issueSeederCertificate(assoc.dir, { seeder: seederKey })))
  Seeder.addCert(sdir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir: sdir, ...localSwarmOptions(bootstrap) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()

  // Author diary: cert, profile, post, edit (unknown type), post with an
  // extra key, delete with an extra key, post.
  const author = await sessionMember(t, bootstrap, assoc)
  await author.call('profile.set', { name: 'Ana' })
  await author.call('post.create', { text: 'um' })
  const s = await openStore(author.dataDir)
  try {
    const diary = await openDiary(s)
    await diary.append({ type: 'edit', seq: 2, text: 'novo', at: new Date().toISOString() })
    await diary.append({ ...postRecord({ text: 'com alt' }), alt: 'descrição' })
    await diary.append({ ...deleteRecord({ seq: 2 }), why: 'x' })
  } finally {
    await s.close()
  }
  const last = await author.call('post.create', { text: 'fim' })
  t.is(last.seq, 6)
  await syncOnce(t, author, 'author sync')

  const f = await sessionMember(t, bootstrap, assoc)
  await f.call('follow.add', { key: author.publicKey })
  let log = null
  for (let i = 0; i < 3; i++) {
    const r = await syncOnce(t, f, 'follower sync #' + (i + 1))
    log = await f.call('log.read', { author: author.publicKey })
    if (log.entries.length + log.invalid.length >= 7) {
      t.is(r.downloaded[author.publicKey], 7, 'the follower downloaded the full length')
      break
    }
  }
  t.is(log.entries.length + log.invalid.length, 7, 'every block replicated')
  const bySeq = (list) => list.slice().sort((x, y) => x.seq - y.seq)
  t.alike(bySeq(log.invalid), [3, 4, 5].map((seq) => ({ seq, reason: 'malformed' })), 'the three future blocks are invalid at their seqs')
  t.alike(log.entries.map((e) => e.seq), [0, 1, 2, 6], 'known records keep their seqs')
  const feed = await f.call('feed.read')
  const posts = feed.items.filter((i) => i.kind === 'post' && i.author === author.publicKey).map((i) => [i.seq, i.text]).sort((x, y) => x[0] - y[0])
  t.alike(posts, [[2, 'um'], [6, 'fim']], 'the feed shows exactly the known posts')
  for (const m of [author, f]) t.alike(m.session.internal, [], 'no internal error')
})

test('feed.read: a stored replica whose block 0 is a v3 certificate is skipped as unsupported-cert-version', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const src = new Corestore(tmpDir(t, 'varanda-src-'))
  await src.ready()
  t.teardown(() => src.close(), { force: true })
  const core = src.get({ name: 'future', valueEncoding: 'json' })
  await core.ready()
  const key = hex(core.key)
  const cert = { ...createCert({ member: key }, generateAssociationKeyPair()), v: 3 }
  await core.append({ type: 'member-cert', cert })
  await core.append(postRecord({ text: 'x' }))

  const f = await sessionMember(t, bootstrap, assoc)
  await f.call('follow.add', { key })
  const s = await openStore(f.dataDir)
  try {
    const replica = await openReplica(s, key)
    const s1 = src.replicate(true)
    const s2 = s.replicate(false)
    s1.on('error', () => {})
    s2.on('error', () => {})
    s1.pipe(s2).pipe(s1)
    await replica.download({ start: 0, end: 2 }).done()
    s1.destroy()
    s2.destroy()
  } finally {
    await s.close()
  }
  const feed = await f.call('feed.read')
  t.alike(feed.skipped, [{ key, reason: UNSUPPORTED }])
  t.is(feed.items.filter((i) => i.author === key).length, 0)
})
