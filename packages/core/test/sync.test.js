const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { runSync } = require('../lib/sync')
const {
  openStore,
  openDiary,
  openReplica,
  purgeReplica,
  readAll,
  appendRecord,
  writeConfig,
  writeFollows
} = require('../lib/store')
const { memberCertRecord, profileRecord, postRecord, MAX_LOG_BLOCKS } = require('../lib/records')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const { randomBytes } = require('hypercore-crypto')
const { createCert, createSeederCert, certForKey, generateAssociationKeyPair } = require('../lib/cert')
const {
  createSwarm,
  topicFor,
  joinAndFlush,
  attachAdmission,
  watchContiguous,
  generateNoiseKeyPair
} = require('../lib/net')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function randomKey () {
  return hex(require('node:crypto').randomBytes(32))
}

// A member data dir: config.json, block 0 = member cert (signed by certKp,
// default kp), a profile and `posts` posts. The store is closed on return.
async function makeMember (t, kp, { certKp = kp, posts = 2, trustKp = kp } = {}) {
  const dir = tmpDir(t, 'varanda-sync-')
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = hex(diary.key)
    writeConfig(dir, { v: 1, role: 'member', association: hex(trustKp.publicKey) })
    await appendRecord(diary, memberCertRecord(createCert({ member: key }, certKp)))
    await appendRecord(diary, profileRecord({ name: 'Membro', bio: '' }))
    for (let i = 0; i < posts; i++) await appendRecord(diary, postRecord({ text: 'post ' + i }))
    return { dir, key, length: diary.length }
  } finally {
    await store.close()
  }
}

// A raw node: a Corestore and a loopback swarm (optionally with a fixed Noise
// key pair) that attaches an admission channel with the given role/cert/have
// on every connection. onpeer(peer) runs after attach.
async function rawNode (t, bootstrap, { keyPair, role = 'member', cert = null, have = () => [], onmessage = () => {}, onpeer = () => {}, primaryKey = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-raw-'), primaryKey ? { primaryKey, unsafe: true } : undefined)
  await store.ready()
  const swarm = createSwarm({ ...localSwarmOptions(bootstrap), keyPair })
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { force: true })
  const peers = new Set()
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    const peer = attachAdmission(socket, {
      role,
      cert,
      have: have(),
      onmessage: (msg, p) => onmessage(msg, p),
      onclose: (p) => peers.delete(p)
    })
    peers.add(peer)
    onpeer(peer)
  })
  return { store, swarm, peers }
}

// Fake seeder built in-test (lib/seeder.js is not used here): verifies the
// announce against kp, fetches block 0, downloads live, replies admitted and
// advertises growth with have.
// opts.have(heldCores) lists what to advertise to a peer that connects later.
async function fakeSeeder (t, bootstrap, kp, { have } = {}) {
  const held = []
  const noise = generateNoiseKeyPair()
  const cert = createSeederCert({ seeder: hex(noise.publicKey) }, kp)
  const association = hex(kp.publicKey)
  const announces = []
  const node = await rawNode(t, bootstrap, {
    keyPair: noise,
    role: 'seeder',
    cert,
    have: have ? () => have(held) : undefined,
    onmessage: (msg, peer) => {
      if (msg.type !== 'announce') return
      announces.push(msg)
      admit(msg, peer).catch(() => {})
    }
  })
  async function admit (msg, peer) {
    const r = certForKey(msg.cert, msg.key, association)
    if (!r.ok) {
      peer.send({ type: 'rejected', key: msg.key, reason: r.reason })
      return
    }
    const core = node.store.get({ key: b4a.from(msg.key, 'hex') })
    await core.ready()
    held.push(core)
    const range = core.download({ start: 0, end: -1 })
    t.teardown(() => range.destroy(), { force: true })
    await core.get(0, { timeout: 10000 })
    const stop = watchContiguous(core, (length) => {
      for (const p of node.peers) p.send({ type: 'have', key: msg.key, length })
    })
    t.teardown(stop, { force: true })
    peer.send({ type: 'admitted', key: msg.key, length: core.contiguousLength })
  }
  await joinAndFlush(node.swarm, [topicFor(association)])
  return { ...node, announces, noise }
}

function collector () {
  const events = []
  return { events, onEvent: (ev) => events.push(ev) }
}

test('direct sync between two members without a seeder (first-time follower)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const loops = Number(process.env.VARANDA_SYNC_LOOPS) || 1
  for (let i = 0; i < loops; i++) {
    const a = await makeMember(t, kp)
    const b = await makeMember(t, kp, { posts: 0 })
    writeFollows(b.dir, [a.key])
    t.is(a.length, 4)

    const opts = { ...localSwarmOptions(bootstrap), once: true, timeoutMs: 30000 }
    const [ra, rb] = await Promise.all([
      runSync({ ...opts, dataDir: a.dir }),
      runSync({ ...opts, dataDir: b.dir })
    ])
    t.ok(ra.ok, 'A ok ' + JSON.stringify(ra.errors))
    t.ok(rb.ok, 'B ok ' + JSON.stringify(rb.errors))
    t.is(rb.downloaded[a.key], 4)
    t.alike(rb.skipped, [])
    t.is(ra.peers, 1)
    t.is(ra.seederConfirmed, false, 'no seeder: not confirmed')

    const store = await openStore(b.dir)
    try {
      const replica = await openReplica(store, a.key)
      t.is((await readAll(replica)).length, 4)
    } finally {
      await store.close()
    }
    t.absent(fs.existsSync(path.join(b.dir, 'quarantine')), 'quarantine removed')
  }
})

test('no peers: --once ends with sem pares', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const a = await makeMember(t, kp)
  const r = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, once: true, timeoutMs: 3000 })
  t.is(r.ok, false)
  t.ok(r.errors.includes('sem pares'))
  t.alike(r.skipped, [])
  t.alike(r.errorsSoft, [])
})

test('the deadline and an abort interrupt a stalled network startup', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const stalled = () => new Promise(() => {}) // a join that never settles
  let swarmSeen = null

  // --once: the deadline resolves the run with the timeout result.
  const a = await makeMember(t, kp, { posts: 0 })
  const started = Date.now()
  const r = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, once: true, timeoutMs: 20, joinHook: (swarm) => { swarmSeen = swarm; return stalled() } })
  const ms = Date.now() - started
  t.ok(ms < 5000, 'resolved while the join was still stalled (' + ms + ' ms)')
  t.is(r.ok, false)
  t.alike(r.errors, ['sem pares'])
  t.ok(swarmSeen && swarmSeen.destroyed, 'swarm destroyed')
  t.absent(fs.existsSync(path.join(a.dir, 'quarantine')), 'quarantine removed')

  // long-running: an abort during the join resolves ok.
  const b = await makeMember(t, kp, { posts: 0 })
  const controller = new AbortController()
  const p = runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, signal: controller.signal, joinHook: stalled })
  setTimeout(() => controller.abort(), 100)
  const rb = await p
  t.is(rb.ok, true)
  t.is(rb.peers, 0)
})

test('re-discovery resumes after the last peer of a topic leaves', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const topic = topicFor(hex(kp.publicKey))

  const b = await makeMember(t, kp, { posts: 0 })
  const ev = collector()
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  const pb = runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, signal: controller.signal, onEvent: ev.onEvent })
  await until(() => ev.events.some((e) => e.event === 'ready'), { timeoutMs: 20000, name: 'B ready' })

  // A1 meets B on the rendezvous, then leaves.
  const a1 = await rawNode(t, bootstrap)
  await joinAndFlush(a1.swarm, [topic])
  const k1 = hex(a1.swarm.keyPair.publicKey)
  await until(() => ev.events.some((e) => e.event === 'peer' && e.peerKey === k1), { timeoutMs: 20000, name: 'B saw A1' })
  await a1.swarm.destroy()

  // A2 only announces (no lookup of its own), so only B's re-discovery of
  // the rendezvous topic can find it.
  const a2 = await rawNode(t, bootstrap)
  await a2.swarm.join(topic, { server: true, client: false }).flushed()
  const k2 = hex(a2.swarm.keyPair.publicKey)
  await until(() => ev.events.some((e) => e.event === 'peer' && e.peerKey === k2), { timeoutMs: 40000, name: 'B found A2 after A1 left' })

  controller.abort()
  const rb = await pb
  t.is(rb.ok, true)
  t.is(ev.events.filter((e) => e.event === 'peer').length, 2)
})

test('fake seeder: admission, untrusted genesis, raw untrusted announce', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const other = generateAssociationKeyPair()
  const seeder = await fakeSeeder(t, bootstrap, kp)

  // Valid genesis: admitted by the seeder, resolves after it has everything.
  const a = await makeMember(t, kp)
  const ev = collector()
  const ra = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, once: true, timeoutMs: 30000, onEvent: ev.onEvent })
  t.ok(ra.ok, JSON.stringify(ra.errors))
  t.is(ra.admitted, true)
  t.is(ra.seeders, 1)
  t.is(ra.seederConfirmed, true, 'a verified seeder admitted and holds the diary')
  const seederCore = seeder.store.get({ key: b4a.from(a.key, 'hex') })
  await seederCore.ready()
  t.ok(seederCore.contiguousLength >= a.length, 'seeder holds the full diary')
  t.ok(ev.events.some((e) => e.event === 'peer' && e.role === 'seeder' && e.verified === true))
  t.ok(ev.events.some((e) => e.event === 'ready'))

  // Genesis signed by another key pair: never announced, not admitted.
  const before = seeder.announces.length
  const bad = await makeMember(t, kp, { certKp: other })
  const lines = []
  const rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: bad.dir, once: true, timeoutMs: 30000, log: (l) => lines.push(l) })
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.is(rb.admitted, false)
  t.is(rb.seederConfirmed, false)
  t.is(seeder.announces.length, before, 'no announce received')
  t.ok(lines.includes('sem certificado válido no bloco 0: o diário não será anunciado'))

  // A raw client announcing a cert signed by another association.
  const fakeKey = randomKey()
  const replies = []
  const raw = await rawNode(t, bootstrap, {
    onmessage: (msg) => { if (msg.type === 'rejected' || msg.type === 'admitted') replies.push(msg) },
    onpeer: (peer) => peer.send({ type: 'announce', key: fakeKey, cert: createCert({ member: fakeKey }, other) })
  })
  await joinAndFlush(raw.swarm, [topicFor(hex(kp.publicKey))])
  await until(() => replies.length > 0, { timeoutMs: 20000, name: 'rejected reply' })
  t.alike(replies[0], { type: 'rejected', key: fakeKey, reason: 'untrusted-association' })
})

test('a follower downloads a followed diary in block order', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const seeder = await fakeSeeder(t, bootstrap, kp, {
    have: (cores) => cores.map((c) => ({ key: hex(c.key), length: c.contiguousLength }))
  })
  const a = await makeMember(t, kp, { posts: 300 })
  const ra = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, once: true, timeoutMs: 60000 })
  t.ok(ra.ok, JSON.stringify(ra.errors))
  const seederCore = seeder.store.get({ key: b4a.from(a.key, 'hex') })
  await seederCore.ready()
  t.ok(seederCore.contiguousLength >= a.length, 'seeder holds the full diary')

  const uploads = []
  seederCore.on('upload', (index) => uploads.push(index))
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [a.key])

  // Without linear the first requested block is a random offset. The values
  // stay varied (HyperDHT draws stream ids from Math.random and retries on a
  // collision) but within 0.4..0.6, so that offset lands far from block 0.
  const random = Math.random
  let seed = 1
  Math.random = () => {
    seed = (seed * 16807) % 2147483647
    return 0.4 + 0.2 * (seed / 2147483647)
  }
  t.teardown(() => { Math.random = random }, { force: true })
  let rb
  try {
    rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 60000 })
  } finally {
    Math.random = random
  }
  t.ok(rb.ok, JSON.stringify(rb.errors))

  t.ok(uploads.length > 0, 'the follower fetched from the seeder')
  const distinct = [...new Set(uploads)]
  // Requests inside the in-flight window may be served out of order.
  t.ok(Math.max(...distinct.slice(0, 32)) < 64, 'the first blocks served are from the start')

  const store = await openStore(b.dir)
  try {
    const replica = await openReplica(store, a.key)
    t.is(replica.contiguousLength, a.length, 'every block is stored')
    t.is((await readAll(replica)).length, a.length)
  } finally {
    await store.close()
  }
})

test('config errors', async (t) => {
  await testnet(t)
  const kp = generateAssociationKeyPair()
  const empty = tmpDir(t, 'varanda-sync-')
  await t.exception(runSync({ dataDir: empty, once: true }), /identidade não encontrada/)
  t.absent(fs.existsSync(path.join(empty, 'store')), 'nothing opened')
  const a = await makeMember(t, kp, { posts: 0 })
  await t.exception(runSync({ dataDir: a.dir, associationKey: 'ab'.repeat(32), once: true }), /associação diferente da configurada/)
})

test('follow gate: block 0 not a cert and untrusted association are skipped and purged', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const other = generateAssociationKeyPair()

  const author = await rawNode(t, bootstrap, { have: () => cores.map((c) => ({ key: hex(c.key), length: c.length })) })
  const postFirst = author.store.get({ name: 'post-first', valueEncoding: 'json' })
  await postFirst.ready()
  await postFirst.append({ type: 'post', text: 'oi', at: new Date().toISOString(), replyTo: null })
  const foreign = author.store.get({ name: 'foreign', valueEncoding: 'json' })
  await foreign.ready()
  await foreign.append(memberCertRecord(createCert({ member: hex(foreign.key) }, other)))
  await foreign.append(postRecord({ text: 'x' }))
  const cores = [postFirst, foreign]
  await joinAndFlush(author.swarm, [topicFor(hex(kp.publicKey))])

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [hex(postFirst.key), hex(foreign.key)])
  const ev = collector()
  const rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 30000, onEvent: ev.onEvent })
  t.ok(rb.ok, JSON.stringify(rb.errors))
  const reasons = Object.fromEntries(rb.skipped.map((s) => [s.key, s.reason]))
  t.is(reasons[hex(postFirst.key)], 'not-in-log')
  t.is(reasons[hex(foreign.key)], 'untrusted-association')
  t.absent(hex(postFirst.key) in rb.downloaded)
  t.absent(hex(foreign.key) in rb.downloaded)
  t.is(ev.events.filter((e) => e.event === 'skipped').length, 2)

  const store = await openStore(b.dir)
  try {
    for (const c of cores) {
      const replica = await openReplica(store, hex(c.key))
      t.is(replica.contiguousLength, 0)
      t.is(replica.length, 0)
    }
  } finally {
    await store.close()
  }
})

test('withdrawal: a follower with another trust root releases the author', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp1 = generateAssociationKeyPair()
  const kp2 = generateAssociationKeyPair()
  const a = await makeMember(t, kp1)
  // B trusts kp2 but meets A on kp1's rendezvous through A's diary topic.
  const b = await makeMember(t, kp2, { posts: 0 })
  writeFollows(b.dir, [a.key])

  const evA = collector()
  const evB = collector()
  const opts = { ...localSwarmOptions(bootstrap), once: true, timeoutMs: 30000 }
  const started = Date.now()
  const pa = runSync({ ...opts, dataDir: a.dir, onEvent: evA.onEvent }).then((r) => ({ r, ms: Date.now() - started }))
  const pb = runSync({ ...opts, dataDir: b.dir, onEvent: evB.onEvent })
  const [{ r: ra, ms }, rb] = await Promise.all([pa, pb])
  t.ok(ra.ok, JSON.stringify(ra.errors))
  t.ok(ms < 25000, 'A resolved before its timeout (' + ms + ' ms)')
  t.alike(rb.skipped, [{ key: a.key, reason: 'untrusted-association' }])
  t.absent(a.key in rb.downloaded)
  t.ok(evA.events.some((e) => e.event === 'withdrawn' && e.key === a.key && e.reason === 'untrusted-association'))
  t.ok(evB.events.some((e) => e.event === 'skipped' && e.key === a.key))

  const store = await openStore(b.dir)
  try {
    const replica = await openReplica(store, a.key)
    t.is(replica.length, 0, 'nothing for A in B main store')
  } finally {
    await store.close()
  }
})

test('verified and unverified seeders', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const other = generateAssociationKeyPair()
  const topic = topicFor(hex(kp.publicKey))

  // Raw role-seeder peer; reply(msg, peer) answers the member's announce.
  async function seederPeer (certKp, haveOwn, reply) {
    const noise = generateNoiseKeyPair()
    const cert = createSeederCert({ seeder: hex(noise.publicKey) }, certKp)
    let ownKey = null
    const node = await rawNode(t, bootstrap, {
      keyPair: noise,
      role: 'seeder',
      cert,
      have: () => (haveOwn && ownKey ? [{ key: ownKey, length: 0 }] : []),
      onmessage: (msg, peer) => { if (msg.type === 'announce') reply(msg, peer) }
    })
    return {
      node,
      setOwn: (k) => { ownKey = k },
      join: () => joinAndFlush(node.swarm, [topic]),
      leave: async () => { await node.swarm.destroy() }
    }
  }

  // 1. Unverified (cert from another association) sends admitted: ignored.
  const a1 = await makeMember(t, kp)
  const s1 = await seederPeer(other, true, (msg, peer) => peer.send({ type: 'admitted', key: msg.key, length: a1.length }))
  s1.setOwn(a1.key)
  await s1.join()
  const ev1 = collector()
  const r1 = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a1.dir, once: true, timeoutMs: 30000, onEvent: ev1.onEvent })
  t.ok(r1.ok, JSON.stringify(r1.errors))
  t.is(r1.admitted, false)
  t.is(r1.seeders, 0)
  t.is(r1.peers, 1)
  const peerEv = ev1.events.find((e) => e.event === 'peer')
  t.is(peerEv.role, 'seeder')
  t.is(peerEv.verified, false)
  await s1.leave()

  // 2. Unverified peer rejecting with not-in-log: only a withdrawal.
  const a2 = await makeMember(t, kp)
  const s2 = await seederPeer(other, true, (msg, peer) => peer.send({ type: 'rejected', key: msg.key, reason: 'not-in-log' }))
  s2.setOwn(a2.key)
  await s2.join()
  const ev2 = collector()
  const r2 = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a2.dir, once: true, timeoutMs: 30000, onEvent: ev2.onEvent })
  t.ok(r2.ok, JSON.stringify(r2.errors))
  t.is(r2.rejected, null)
  const w = ev2.events.find((e) => e.event === 'withdrawn')
  t.ok(w, 'withdrawn event')
  t.is(w.reason, 'not-in-log')
  await s2.leave()

  // 3. Verified seeder (cert by kp for its own Noise key): counts.
  const a3 = await makeMember(t, kp)
  const s3 = await seederPeer(kp, false, (msg, peer) => peer.send({ type: 'admitted', key: msg.key, length: a3.length }))
  await s3.join()
  const ev3 = collector()
  const r3 = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a3.dir, once: true, timeoutMs: 30000, onEvent: ev3.onEvent })
  t.ok(r3.ok, JSON.stringify(r3.errors))
  t.is(r3.admitted, true)
  t.is(r3.seeders, 1)
  t.ok(ev3.events.some((e) => e.event === 'peer' && e.verified === true))
  t.ok(ev3.events.some((e) => e.event === 'admitted' && e.key === a3.key))
  await s3.leave()

  // 4. Verified seeder rejecting with timeout is soft; another reason fails.
  const a4 = await makeMember(t, kp)
  const s4 = await seederPeer(kp, false, (msg, peer) => peer.send({ type: 'rejected', key: msg.key, reason: 'timeout' }))
  await s4.join()
  const r4 = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a4.dir, once: true, timeoutMs: 4000 })
  t.is(r4.ok, false)
  t.is(r4.rejected, null)
  t.ok(r4.errorsSoft.some((e) => e.startsWith('rejeitado: timeout (')))
  await s4.leave()

  const a5 = await makeMember(t, kp)
  const s5 = await seederPeer(kp, false, (msg, peer) => peer.send({ type: 'rejected', key: msg.key, reason: 'bad-signature' }))
  await s5.join()
  const r5 = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a5.dir, once: true, timeoutMs: 30000 })
  t.is(r5.ok, false)
  t.is(r5.rejected, 'bad-signature')
  t.alike(r5.errors, ['rejeitado: bad-signature'])
})

test('gate timeout: an advertiser without blocks', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const k = randomKey()
  const liar = await rawNode(t, bootstrap, { have: () => [{ key: k, length: 3 }] })
  await joinAndFlush(liar.swarm, [topicFor(hex(kp.publicKey))])

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [k])
  const rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 4000 })
  t.is(rb.ok, false)
  t.alike(rb.errors, ['tempo esgotado: ' + k + ':0/3'])
  t.alike(rb.skipped, [])
  t.ok(rb.errorsSoft.includes('bloco 0 indisponível: ' + k.slice(0, 8)), JSON.stringify(rb.errorsSoft))

  const store = await openStore(b.dir)
  try {
    const replica = await openReplica(store, k)
    t.is(replica.length, 0, 'nothing for K in the main store')
  } finally {
    await store.close()
  }
})

test('fork on a followed log: skipped, purged and withdrawn', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const got = []
  const author = await rawNode(t, bootstrap, {
    have: () => [{ key: hex(diary.key), length: diary.length }],
    onmessage: (msg) => { if (msg.type === 'rejected') got.push(msg) }
  })
  const diary = author.store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(createCert({ member: key }, kp)))
  await diary.append(postRecord({ text: 'um' }))
  await diary.append(postRecord({ text: 'dois' }))
  await joinAndFlush(author.swarm, [topicFor(hex(kp.publicKey)), diary.discoveryKey])

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [key])
  const ev = collector()
  const controller = new AbortController()
  const pb = runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, signal: controller.signal, onEvent: ev.onEvent })
  t.teardown(() => controller.abort(), { force: true })
  await until(() => ev.events.some((e) => e.event === 'downloaded' && e.key === key && e.length === 3), { timeoutMs: 30000, name: 'downloaded 3' })

  await diary.truncate(1, { fork: 1 })
  await diary.append(postRecord({ text: 'reescrito' }))
  await until(() => ev.events.some((e) => e.event === 'skipped' && e.key === key && e.reason === 'fork'), { timeoutMs: 30000, name: 'skipped fork' })
  await until(() => got.some((m) => m.key === key && m.reason === 'fork'), { timeoutMs: 30000, name: 'author sees withdrawal' })

  controller.abort()
  const rb = await pb
  t.is(rb.ok, true)
  t.alike(rb.skipped, [{ key, reason: 'fork' }])
  t.absent(key in rb.downloaded)

  const store = await openStore(b.dir)
  try {
    const replica = await openReplica(store, key)
    t.is(replica.contiguousLength, 0, 'purged')
  } finally {
    await store.close()
  }
})

test('equivocation on a followed log: two writable copies of the key, skipped, purged and withdrawn', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const got = []
  // Same primary key and name: the same core key, writable in both stores.
  const primaryKey = randomBytes(32)
  const author = await rawNode(t, bootstrap, {
    primaryKey,
    have: () => [{ key: hex(diary.key), length: diary.length }],
    onmessage: (msg) => { if (msg.type === 'rejected') got.push(msg) }
  })
  const diary = author.store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(createCert({ member: key }, kp)))
  await diary.append(postRecord({ text: 'um' }))
  await diary.append(postRecord({ text: 'dois' }))
  await joinAndFlush(author.swarm, [topicFor(hex(kp.publicKey)), diary.discoveryKey])

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [key])
  const ev = collector()
  const controller = new AbortController()
  const pb = runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, signal: controller.signal, onEvent: ev.onEvent })
  t.teardown(() => controller.abort(), { force: true })
  await until(() => ev.events.some((e) => e.event === 'downloaded' && e.key === key && e.length === 3), { timeoutMs: 30000, name: 'downloaded 3' })

  // The second copy was never truncated: it just holds another, longer history.
  const twinNode = await rawNode(t, bootstrap, {
    primaryKey,
    have: () => [{ key: hex(twin.key), length: twin.length }]
  })
  const twin = twinNode.store.get({ name: 'diary', valueEncoding: 'json' })
  await twin.ready()
  t.is(hex(twin.key), key, 'the second copy holds the same key')
  await twin.append(memberCertRecord(createCert({ member: key }, kp)))
  await twin.append(postRecord({ text: 'um, de outro jeito' }))
  await twin.append(postRecord({ text: 'dois, de outro jeito' }))
  await twin.append(postRecord({ text: 'tres, de outro jeito' }))
  await joinAndFlush(twinNode.swarm, [topicFor(hex(kp.publicKey)), twin.discoveryKey])

  await until(() => ev.events.some((e) => e.event === 'skipped' && e.key === key && e.reason === 'fork'), { timeoutMs: 30000, name: 'skipped fork' })
  await until(() => got.some((m) => m.key === key && m.reason === 'fork'), { timeoutMs: 30000, name: 'author sees withdrawal' })

  controller.abort()
  const rb = await pb
  t.is(rb.ok, true)
  t.alike(rb.skipped, [{ key, reason: 'fork' }])
  t.absent(key in rb.downloaded)

  const store = await openStore(b.dir)
  try {
    const replica = await openReplica(store, key)
    t.is(replica.contiguousLength, 0, 'purged')
  } finally {
    await store.close()
  }
})

test('R6.2: a second sync on the same data dir fails on the lock', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const a = await makeMember(t, kp)
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  let ready = false
  const p = runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, signal: controller.signal, onEvent: (e) => { if (e.event === 'ready') ready = true } })
  await until(() => ready, { timeoutMs: 20000, name: 'ready' })
  const q = path.join(a.dir, 'quarantine')
  t.ok(fs.existsSync(q), 'quarantine exists')
  await t.exception(runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, once: true, timeoutMs: 2000 }))
  t.ok(fs.existsSync(q), 'first run quarantine intact')
  controller.abort()
  const r = await p
  t.is(r.ok, true)
  t.alike(r.skipped, [])
  t.absent(fs.existsSync(q), 'quarantine removed at close')
})

test('shutdown releases the lock last: the next run on the data dir keeps its quarantine', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const a = await makeMember(t, kp)
  const lock = path.join(a.dir, '.varanda-lock')
  const q = path.join(a.dir, 'quarantine')

  const c1 = new AbortController()
  t.teardown(() => c1.abort(), { force: true })
  let ready1 = false
  const p1 = runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, signal: c1.signal, onEvent: (e) => { if (e.event === 'ready') ready1 = true } })
  await until(() => ready1, { timeoutMs: 20000, name: 'first ready' })
  c1.abort()
  // The second run starts the instant the lock is released, before the
  // first one has resolved: with the lock released last, the first run's
  // quarantine cleanup is already over.
  await until(() => !fs.existsSync(lock), { timeoutMs: 20000, name: 'lock released' })
  const c2 = new AbortController()
  t.teardown(() => c2.abort(), { force: true })
  let ready2 = false
  const p2 = runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, signal: c2.signal, onEvent: (e) => { if (e.event === 'ready') ready2 = true } })
  const r1 = await p1
  t.is(r1.ok, true)
  await until(() => ready2, { timeoutMs: 20000, name: 'second ready' })
  t.ok(fs.existsSync(q), 'second run quarantine intact while it is active')
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.ok(fs.existsSync(q), 'still intact')
  c2.abort()
  const r2 = await p2
  t.is(r2.ok, true)
  t.absent(fs.existsSync(q), 'quarantine removed at close')
  t.absent(fs.existsSync(lock), 'lock released')
})

// A raw author with a valid genesis under kp and `posts` posts, advertising
// its diary on the rendezvous and on the diary topic; got[] collects the
// rejected messages it receives. With { join: false } it goes online only
// when join() is called.
async function rawAuthor (t, bootstrap, kp, posts = 2, { join = true } = {}) {
  const got = []
  const author = await rawNode(t, bootstrap, {
    have: () => [{ key: hex(diary.key), length: diary.length }],
    onmessage: (msg) => { if (msg.type === 'rejected') got.push(msg) }
  })
  const diary = author.store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(createCert({ member: key }, kp)))
  for (let i = 0; i < posts; i++) await diary.append(postRecord({ text: 'post ' + i }))
  const online = () => joinAndFlush(author.swarm, [topicFor(hex(kp.publicKey)), diary.discoveryKey])
  if (join) await online()
  return { ...author, diary, key, got, join: online }
}

test('late advertiser joins the in-flight quarantine fetch', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))

  // The author's diary exists before the run but the author is not on the
  // network yet; a liar advertises the key first and holds no blocks.
  const got = []
  const author = await rawNode(t, bootstrap, {
    have: () => [{ key: hex(diary.key), length: diary.length }],
    onmessage: (msg) => { if (msg.type === 'rejected') got.push(msg) }
  })
  const diary = author.store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(createCert({ member: key }, kp)))
  await diary.append(postRecord({ text: 'post 0' }))
  await diary.append(postRecord({ text: 'post 1' }))
  const liar = await rawNode(t, bootstrap, { have: () => [{ key, length: 3 }] })
  await joinAndFlush(liar.swarm, [rendezvous])

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [key])
  const ev = collector()
  const liarKey = hex(liar.swarm.keyPair.publicKey)
  const pb = runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 5000, onEvent: ev.onEvent })
  // The fetch for key starts on the liar's hello and is attached to the liar
  // only; the author arrives 300 ms later and joins that fetch.
  await until(() => ev.events.some((e) => e.event === 'peer' && e.peerKey === liarKey), { timeoutMs: 20000, name: 'liar peer' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  await joinAndFlush(author.swarm, [rendezvous, diary.discoveryKey])

  const rb = await pb
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.is(rb.peers, 2)
  t.is(rb.downloaded[key], 3)
  t.alike(rb.skipped, [])
  t.alike(rb.errorsSoft, [], 'no gate timeout: the late author supplied block 0')
  t.alike(got, [], 'nothing withdrawn')
  t.ok(ev.events.some((e) => e.event === 'downloaded' && e.key === key && e.length === 3))
})

test('re-gate: a main-store block 0 that fails the local gate is skipped, purged and fails the run', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const author = await rawAuthor(t, bootstrap, kp)

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  const ev = collector()
  const regated = []
  const rb = await runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 30000,
    onEvent: ev.onEvent,
    // The quarantine fetch passed; pretend the main store got another block 0.
    regateHook: (key) => { regated.push(key); return 'not-in-log' }
  })
  t.alike(regated, [author.key], 're-gate ran once for the key')
  t.is(rb.ok, false)
  t.alike(rb.skipped, [{ key: author.key, reason: 'not-in-log' }])
  t.absent(author.key in rb.downloaded)
  t.ok(rb.errors.includes('bloco 0 divergente: ' + author.key.slice(0, 8) + ' (not-in-log)'), JSON.stringify(rb.errors))
  t.ok(ev.events.some((e) => e.event === 'skipped' && e.key === author.key && e.reason === 'not-in-log'))
  t.absent(ev.events.some((e) => e.event === 'downloaded' && e.key === author.key), 'nothing reported downloaded')
  t.ok(author.got.some((m) => m.key === author.key && m.reason === 'not-in-log'), 'author got the withdrawal')

  const store = await openStore(b.dir)
  try {
    const replica = await openReplica(store, author.key)
    t.is(replica.contiguousLength, 0, 'purged')
    t.is(replica.length, 0, 'purged')
  } finally {
    await store.close()
  }
})

test('purges are awaited: a held purge blocks completion and a failed purge fails the run', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const author = await rawAuthor(t, bootstrap, kp)

  // 1. The purge is held: runSync does not resolve until it settles.
  const b1 = await makeMember(t, kp, { posts: 0 })
  writeFollows(b1.dir, [author.key])
  let release
  const held = new Promise((resolve) => { release = resolve })
  let purgeStarted = false
  let purgeDone = false
  let ready1 = false
  const p1 = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b1.dir,
    once: true,
    timeoutMs: 60000,
    onEvent: (e) => { if (e.event === 'ready') ready1 = true },
    regateHook: () => 'not-in-log',
    // The startup purge of the empty core (before ready) passes through;
    // the runtime purge after the failed re-gate is held.
    purgeHook: async (key, store) => {
      if (!ready1) return purgeReplica(store, key)
      purgeStarted = true
      await held
      await purgeReplica(store, key)
      purgeDone = true
    }
  })
  let settled = false
  p1.then(() => { settled = true }, () => { settled = true })
  await until(() => purgeStarted, { timeoutMs: 30000, name: 'purge started' })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  t.absent(settled, 'runSync waits for the purge')
  release()
  const r1 = await p1
  t.ok(purgeDone, 'purge completed before the result')
  t.is(r1.ok, false)
  t.alike(r1.skipped, [{ key: author.key, reason: 'not-in-log' }])
  t.absent(r1.errors.some((e) => e.startsWith('falha ao limpar')), JSON.stringify(r1.errors))
  const store = await openStore(b1.dir)
  try {
    const replica = await openReplica(store, author.key)
    t.is(replica.length, 0, 'purged')
  } finally {
    await store.close()
  }

  // 2. The purge rejects: ok false with the purge error.
  const b2 = await makeMember(t, kp, { posts: 0 })
  writeFollows(b2.dir, [author.key])
  let ready2 = false
  const r2 = await runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b2.dir,
    once: true,
    timeoutMs: 60000,
    onEvent: (e) => { if (e.event === 'ready') ready2 = true },
    regateHook: () => 'not-in-log',
    purgeHook: async (key, store) => {
      if (!ready2) return purgeReplica(store, key)
      throw new Error('boom')
    }
  })
  t.is(r2.ok, false)
  t.alike(r2.errors, ['falha ao limpar diário rejeitado: ' + author.key.slice(0, 8)])
  t.alike(r2.skipped, [{ key: author.key, reason: 'not-in-log' }])
  t.absent(fs.existsSync(path.join(b2.dir, 'quarantine')), 'quarantine removed')
})

// A hostile peer with a raw admission channel: sends whatever JSON it is
// given (validation is bypassed), so it can advertise unsafe lengths.
// A shared `store` (closed by its owner) avoids one Corestore per identity.
async function hostileNode (t, bootstrap, onsocket, { store = null } = {}) {
  if (store === null) {
    store = new Corestore(tmpDir(t, 'varanda-hostile-'))
    await store.ready()
    const own = store
    t.teardown(() => own.close(), { force: true })
  }
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    const mux = Hypercore.getProtocolMuxer(socket)
    const channel = mux.createChannel({ protocol: 'varanda/admission/1', onopen: () => onsocket(send) })
    const message = channel.addMessage({ encoding: c.buffer, onmessage: () => {} })
    channel.open()
    function send (obj) { message.send(b4a.from(JSON.stringify(obj), 'utf8')) }
  })
  return { store, swarm }
}

test('item 2: the last overflow advertisement is not missed by --once', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  // 1. B gets the author's 3 blocks through a normal advertising author.
  const author = await rawNode(t, bootstrap, { have: () => [{ key, length: diary.length }] })
  const diary = author.store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(createCert({ member: key }, kp)))
  await diary.append(postRecord({ text: 'post 0' }))
  await diary.append(postRecord({ text: 'post 1' }))
  await joinAndFlush(author.swarm, [rendezvous, diary.discoveryKey])
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [key])
  const first = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 15000 })
  t.ok(first.ok, JSON.stringify(first.errors))
  t.is(first.downloaded[key], 3)
  await author.swarm.destroy()

  // 2. The author is offline and the ONLY peer B meets advertises 5 for the
  // key: hello count 2 with an empty have, then two haves with the key LAST,
  // so the inventory completes on that very advertisement. Were the claim
  // recorded after the inventory completion, --once would end ok with 3 and
  // never emit that 'have'. Only once B saw it does the author grow to 5 and
  // come back online, so the run must wait for the claim to be served.
  const adv5 = await hostileNode(t, bootstrap, (send) => {
    send({ type: 'hello', v: 1, role: 'member', count: 2, have: [] })
    send({ type: 'have', key: randomKey(), length: 1 })
    send({ type: 'have', key, length: 5 })
  })
  await joinAndFlush(adv5.swarm, [rendezvous])
  let back = null
  const comeBack = async () => {
    await diary.append(postRecord({ text: 'post 2' }))
    await diary.append(postRecord({ text: 'post 3' }))
    const swarm2 = createSwarm(localSwarmOptions(bootstrap))
    t.teardown(() => swarm2.destroy(), { order: -1, force: true })
    swarm2.on('connection', (socket) => {
      socket.on('error', () => {})
      author.store.replicate(socket)
      attachAdmission(socket, { role: 'member', have: [] })
    })
    await joinAndFlush(swarm2, [rendezvous, diary.discoveryKey])
  }
  const r = await runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 20000,
    unverifiedBudgetMs: 60000,
    onEvent: (ev) => {
      if (back === null && ev.event === 'have' && ev.key === key && ev.length === 5) back = comeBack()
    }
  })
  t.ok(back !== null, 'the claim of 5 reached the run')
  if (back) await back
  t.ok(r.ok, JSON.stringify(r.errors))
  t.is(r.downloaded[key], 5, 'the claim of 5 was recorded before the goals were evaluated')
})

test('item 3: an alternating claimer is ignored after the unverified budget', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const author = await rawAuthor(t, bootstrap, kp)
  // One interval per connection of the hostile node: every one is cleared.
  const timers = new Set()
  t.teardown(() => { for (const x of timers) clearInterval(x) }, { order: -1, force: true })
  const hostile = await hostileNode(t, bootstrap, (send) => {
    send({ type: 'hello', v: 1, role: 'member', count: 1, have: [{ key: author.key, length: MAX_LOG_BLOCKS - 1 }] })
    let flip = false
    const timer = setInterval(() => {
      flip = !flip
      try { send({ type: 'have', key: author.key, length: flip ? MAX_LOG_BLOCKS : MAX_LOG_BLOCKS - 1 }) } catch {}
    }, 100)
    timers.add(timer)
  })
  await joinAndFlush(hostile.swarm, [topicFor(hex(kp.publicKey))])
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  const ev = collector()
  const started = Date.now()
  const rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 30000, onEvent: ev.onEvent, unverifiedBudgetMs: 500 })
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.ok(Date.now() - started < 20000, 'resolved before the deadline')
  t.is(rb.downloaded[author.key], 3)
  t.ok(ev.events.some((e) => e.event === 'claim-ignored' && e.key === author.key), 'alternating claim ignored')
})

test('item 4c: a follows.json over the limit uses the first entries and warns', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const b = await makeMember(t, kp, { posts: 0 })
  const keys = [randomKey(), randomKey(), randomKey()].sort()
  writeFollows(b.dir, keys)
  const lines = []
  const r = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 2000, maxFollows: 2, log: (l) => lines.push(l) })
  t.alike(r.errors, ['sem pares'])
  t.ok(lines.some((l) => l.startsWith('aviso: limite de diários seguidos excedido')), lines.join('|'))
  t.alike(r.unadvertised.sort(), keys.slice(0, 2), 'only the first maxFollows are followed')
})

test('item 7: a slow startup does not extend --once beyond timeoutMs', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [randomKey()])
  const started = Date.now()
  // The startup purge of the empty follow core is delayed by 1500 ms.
  const r = await runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 2000,
    purgeHook: async (key, store) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return purgeReplica(store, key)
    }
  })
  const ms = Date.now() - started
  t.alike(r.errors, ['sem pares'])
  t.ok(ms < 3200, 'one deadline: ' + ms + ' ms')
})

test('item 8: ending during the replica open purges the core', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const author = await rawAuthor(t, bootstrap, kp)
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  const purged = []
  const rb = await runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    signal: controller.signal,
    purgeHook: async (key, store) => { purged.push(key); return purgeReplica(store, key) },
    // The run ends while the gate passed and the replica is being opened.
    openHook: async () => { controller.abort() }
  })
  t.is(rb.ok, true)
  t.ok(purged.filter((k) => k === author.key).length >= 2, 'startup purge and the purge on ending')
  const store = await openStore(b.dir)
  try {
    t.is(await store.storage.hasCore(Hypercore.discoveryKey(b4a.from(author.key, 'hex'))), false, 'no core left in the main store')
  } finally {
    await store.close()
  }
})

test('a startup purge pending at abort is awaited and its failure fails the run', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const b = await makeMember(t, kp, { posts: 0 })
  const k = randomKey()
  writeFollows(b.dir, [k]) // an empty replica: purged at startup
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  let purgeStarted = false
  const rb = await runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    signal: controller.signal,
    purgeHook: async () => {
      purgeStarted = true
      controller.abort() // the run ends while this purge is pending
      await new Promise((resolve) => setTimeout(resolve, 300))
      throw new Error('boom')
    }
  })
  t.ok(purgeStarted)
  t.is(rb.ok, false)
  t.alike(rb.errors, ['falha ao limpar diário rejeitado: ' + k.slice(0, 8)])
  t.absent(fs.existsSync(path.join(b.dir, 'quarantine')), 'quarantine removed')
})

test('a replica still in regate at the end of the run is purged', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const author = await rawAuthor(t, bootstrap, kp)
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  const purged = []
  const rb = await runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 4000,
    purgeHook: async (key, store) => { purged.push(key); return purgeReplica(store, key) },
    // Block 0 reached the quarantine; the advertiser leaves before the main
    // store gets it, so the replica stays in regate until the deadline.
    openHook: async () => { await author.swarm.destroy() }
  })
  t.is(rb.ok, false)
  t.alike(rb.skipped, [])
  t.absent(author.key in rb.downloaded)
  t.ok(purged.filter((k) => k === author.key).length >= 2, 'startup purge and the purge of the regate replica')
  const store = await openStore(b.dir)
  try {
    t.is(await store.storage.hasCore(Hypercore.discoveryKey(b4a.from(author.key, 'hex'))), false, 'no core left in the main store')
  } finally {
    await store.close()
  }
})

test('S2 (i): hostile length claims for a followed key do not block --once', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  const author = await rawAuthor(t, bootstrap, kp)
  // First an unsafe length (invalid hello, a bad message), then MAX_LOG_BLOCKS
  // (valid but never served: ignored for G1 once its grace expires).
  const hostile = await hostileNode(t, bootstrap, (send) => {
    send({ type: 'hello', v: 1, role: 'member', count: 1, have: [{ key: author.key, length: 9007199254740991 }] })
    send({ type: 'hello', v: 1, role: 'member', count: 1, have: [{ key: author.key, length: MAX_LOG_BLOCKS }] })
  })
  await joinAndFlush(hostile.swarm, [rendezvous])
  const hostileKey = hex(hostile.swarm.keyPair.publicKey)

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  const ev = collector()
  const rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 30000, onEvent: ev.onEvent, unverifiedBudgetMs: 500 })
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.is(rb.peers, 2)
  t.is(rb.downloaded[author.key], 3)
  t.alike(rb.skipped, [])
  t.ok(ev.events.some((e) => e.event === 'claim-ignored' && e.key === author.key && e.peerKey === hostileKey && e.length === MAX_LOG_BLOCKS), 'stale claim ignored')
  t.absent(ev.events.some((e) => e.event === 'have' && e.length > MAX_LOG_BLOCKS), 'the unsafe length never reached the run')
})

test('S2 (ii): a peer advertising our diary at 0 forever does not block --once with a verified seeder', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const seeder = await fakeSeeder(t, bootstrap, kp)
  const a = await makeMember(t, kp)
  const hostile = await rawNode(t, bootstrap, { have: () => [{ key: a.key, length: 0 }] })
  await joinAndFlush(hostile.swarm, [topicFor(hex(kp.publicKey))])
  const hostileKey = hex(hostile.swarm.keyPair.publicKey)

  const ev = collector()
  const started = Date.now()
  const ra = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, once: true, timeoutMs: 30000, onEvent: ev.onEvent, unverifiedBudgetMs: 500 })
  t.ok(ra.ok, JSON.stringify(ra.errors))
  t.ok(Date.now() - started < 25000, 'resolved before the deadline')
  t.is(ra.admitted, true)
  t.is(ra.seeders, 1)
  t.is(ra.peers, 2)
  t.ok(ev.events.some((e) => e.event === 'peer-ignored' && e.peerKey === hostileKey), 'stalled peer dropped from G3')
  t.is(ra.seederConfirmed, true)
  t.is(seeder.store.get({ key: b4a.from(a.key, 'hex') }).contiguousLength, a.length, 'seeder holds the diary')
})

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A shared Corestore for many hostile identities (each hostileNode has its
// own swarm and Noise key pair).
async function sharedStore (t) {
  const store = new Corestore(tmpDir(t, 'varanda-hostile-'))
  await store.ready()
  t.teardown(() => store.close(), { order: 1, force: true })
  return store
}

test('H1: identity rotation with incomplete inventories does not hold --once past the budget', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  await fakeSeeder(t, bootstrap, kp)
  const a = await makeMember(t, kp)
  const store = await sharedStore(t)

  // A new key pair every ~400 ms: hello count 4096 and no entries, so each
  // fresh identity would hold the run for its whole inventory timer.
  const rot = { stop: false }
  const live = []
  t.teardown(async () => {
    rot.stop = true
    for (const h of live) await h.swarm.destroy().catch(() => {})
  }, { order: -1, force: true })
  const rotation = (async () => {
    while (!rot.stop) {
      const h = await hostileNode(t, bootstrap, (send) => {
        send({ type: 'hello', v: 1, role: 'member', count: 4096, have: [] })
      }, { store })
      live.push(h)
      h.swarm.join(rendezvous)
      if (live.length > 2) await live.shift().swarm.destroy().catch(() => {})
      await sleep(400)
    }
  })()

  const ev = collector()
  const started = Date.now()
  const ra = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, once: true, timeoutMs: 30000, onEvent: ev.onEvent, unverifiedBudgetMs: 1000 })
  const ms = Date.now() - started
  rot.stop = true
  await rotation
  t.ok(ra.ok, JSON.stringify(ra.errors))
  t.ok(ms < 20000, 'resolved while identities kept rotating (' + ms + ' ms)')
  t.is(ra.admitted, true)
  t.is(ra.seederConfirmed, true)
  t.ok(ev.events.some((e) => e.event === 'peer' && e.verified === false), 'rotating identities reached the run')
})

test('H1: claimers alternating L / L+1 from two identities are ignored after the budget', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  // The author goes online only once both claimers reached the run, so their
  // claims are outstanding when the replica opens.
  const author = await rawAuthor(t, bootstrap, kp, 2, { join: false }) // 3 blocks
  // Opposite phases driven by one timer: one identity's claim dips to L (and
  // is dropped) 75 ms after the other raised L+1 again, so a claim above the
  // signed length is always outstanding.
  const claimers = []
  let phase = false
  const timers = new Set()
  const send = (list, length) => {
    for (const c of list) try { c.send({ type: 'have', key: author.key, length }) } catch {}
  }
  timers.add(setInterval(() => {
    phase = !phase
    const down = claimers.filter((c) => c.first !== phase)
    send(claimers.filter((c) => c.first === phase), 4)
    const dip = setTimeout(() => send(down, 3), 75)
    timers.add(dip)
  }, 150))
  t.teardown(() => { for (const x of timers) clearTimeout(x) }, { order: -1, force: true })
  const claimer = (first) => hostileNode(t, bootstrap, (send) => {
    send({ type: 'hello', v: 1, role: 'member', count: 1, have: [{ key: author.key, length: first === phase ? 4 : 3 }] })
    claimers.push({ first, send })
  })
  const h1 = await claimer(true)
  const h2 = await claimer(false)
  await joinAndFlush(h1.swarm, [rendezvous])
  await joinAndFlush(h2.swarm, [rendezvous])

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  const ev = collector()
  const claimerKeys = [h1, h2].map((h) => hex(h.swarm.keyPair.publicKey))
  const started = Date.now()
  const pb = runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 30000, onEvent: ev.onEvent, unverifiedBudgetMs: 1000 })
  await until(() => claimerKeys.every((k) => ev.events.some((e) => e.event === 'peer' && e.peerKey === k)), { timeoutMs: 20000, name: 'claimers connected' })
  await author.join()
  const rb = await pb
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.ok(Date.now() - started < 25000, 'resolved before the deadline')
  t.is(rb.downloaded[author.key], 3)
  t.is(rb.seederConfirmed, false)
  t.ok(ev.events.some((e) => e.event === 'claim-ignored' && e.key === author.key && e.length === 4), 'L+1 claim ignored')
})

test('H1: a peer whose interest grows by +1 is ignored after the budget', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  await fakeSeeder(t, bootstrap, kp)
  const a = await makeMember(t, kp, { posts: 40 }) // 42 blocks
  const timers = new Set()
  t.teardown(() => { for (const x of timers) clearInterval(x) }, { order: -1, force: true })
  // +1 every 400 ms: it would take ~17 s to reach the full length.
  const hostile = await hostileNode(t, bootstrap, (send) => {
    let length = 0
    send({ type: 'hello', v: 1, role: 'member', count: 1, have: [{ key: a.key, length }] })
    const timer = setInterval(() => {
      length++
      try { send({ type: 'have', key: a.key, length }) } catch {}
    }, 400)
    timers.add(timer)
  })
  await joinAndFlush(hostile.swarm, [topicFor(hex(kp.publicKey))])
  const hostileKey = hex(hostile.swarm.keyPair.publicKey)

  const ev = collector()
  const started = Date.now()
  const ra = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, once: true, timeoutMs: 30000, onEvent: ev.onEvent, unverifiedBudgetMs: 1000 })
  const ms = Date.now() - started
  t.ok(ra.ok, JSON.stringify(ra.errors))
  t.ok(ms < 12000, 'resolved before the slow peer could catch up (' + ms + ' ms)')
  t.is(ra.seederConfirmed, true)
  t.ok(ev.events.some((e) => e.event === 'peer-ignored' && e.peerKey === hostileKey), 'slow peer dropped from G3')
})

test('H1 (c): a peer self-reporting the full length without a seeder: ok but not seederConfirmed', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const a = await makeMember(t, kp)
  const liar = await rawNode(t, bootstrap, { have: () => [{ key: a.key, length: a.length }] })
  await joinAndFlush(liar.swarm, [topicFor(hex(kp.publicKey))])
  const ra = await runSync({ ...localSwarmOptions(bootstrap), dataDir: a.dir, once: true, timeoutMs: 20000, unverifiedBudgetMs: 1000 })
  t.ok(ra.ok, JSON.stringify(ra.errors))
  t.is(ra.seeders, 0)
  t.is(ra.seederConfirmed, false, 'nobody verified stored the diary')
})

test('H2: claims of disconnected identities are released, and long-running mode records none', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  const author = await rawAuthor(t, bootstrap, kp, 2, { join: false }) // 3 blocks
  const other = randomKey()
  const store = await sharedStore(t)
  // Every claimer advertises every followed key above the signed length.
  const claim = (send) => send({
    type: 'hello',
    v: 1,
    role: 'member',
    count: 2,
    have: [{ key: author.key, length: MAX_LOG_BLOCKS - 1 }, { key: other, length: MAX_LOG_BLOCKS - 1 }]
  })

  // 1. --once with a long budget: a holder keeps the run open while 200
  // identities connect in batches, claim, and leave.
  const holder = await hostileNode(t, bootstrap, claim, { store })
  await joinAndFlush(holder.swarm, [rendezvous])
  const holderKey = hex(holder.swarm.keyPair.publicKey)
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key, other])
  let inspect = null
  const seen = new Set()
  let downloaded = false
  const pb = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 150000,
    unverifiedBudgetMs: 600000,
    inspectHook: (h) => { inspect = h },
    onEvent: (e) => {
      if (e.event === 'peer') seen.add(e.peerKey)
      if (e.event === 'downloaded' && e.key === author.key && e.length === 3) downloaded = true
    }
  })
  // The author goes online once the holder reached the run.
  await until(() => seen.has(holderKey), { timeoutMs: 20000, name: 'holder connected' })
  await author.join()
  await until(() => downloaded && inspect && inspect.claimCount() === 1, { timeoutMs: 30000, name: 'holder claim recorded' })
  const BATCH = 20
  let peak = 0
  for (let i = 0; i < 200; i += BATCH) {
    const batch = []
    for (let j = 0; j < BATCH; j++) batch.push(await hostileNode(t, bootstrap, claim, { store }))
    for (const h of batch) h.swarm.join(rendezvous)
    const keys = batch.map((h) => hex(h.swarm.keyPair.publicKey))
    await until(() => keys.every((k) => seen.has(k)), { timeoutMs: 30000, name: 'batch ' + i + ' connected' })
    peak = Math.max(peak, inspect.claimCount())
    for (const h of batch) await h.swarm.destroy()
    await until(() => inspect.claimCount() === 1, { timeoutMs: 30000, name: 'batch ' + i + ' released' })
  }
  t.ok(peak > 1, 'the batch claims were recorded (peak ' + peak + ')')
  t.is(inspect.claimCount(), 1, 'only the holder claim is left after 200 identities')
  await holder.swarm.destroy()
  const rb = await pb
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.is(inspect.claimCount(), 0, 'no claims left')

  // 2. long-running: claims are never recorded.
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  let inspect2 = null
  const seen2 = new Set()
  const pc = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    signal: controller.signal,
    inspectHook: (h) => { inspect2 = h },
    onEvent: (e) => { if (e.event === 'peer') seen2.add(e.peerKey) }
  })
  const batch = []
  for (let j = 0; j < 5; j++) batch.push(await hostileNode(t, bootstrap, claim, { store }))
  for (const h of batch) h.swarm.join(rendezvous)
  const keys = batch.map((h) => hex(h.swarm.keyPair.publicKey))
  await until(() => keys.every((k) => seen2.has(k)), { timeoutMs: 30000, name: 'long-running claimers connected' })
  t.is(inspect2.claimCount(), 0, 'long-running mode records no claims')
  controller.abort()
  const rc = await pc
  t.is(rc.ok, true)
})

test('S3: a followed log over the quota is skipped with quota', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const author = await rawAuthor(t, bootstrap, kp, 5) // 6 blocks

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  const ev = collector()
  const rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 30000, onEvent: ev.onEvent, maxLogBlocks: 4 })
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.alike(rb.skipped, [{ key: author.key, reason: 'quota' }])
  t.absent(author.key in rb.downloaded)
  t.ok(ev.events.some((e) => e.event === 'skipped' && e.key === author.key && e.reason === 'quota'))
  t.absent(ev.events.some((e) => e.event === 'downloaded' && e.key === author.key && e.length > 4), 'nothing past the limit reported')
  await until(() => author.got.some((m) => m.key === author.key && m.reason === 'quota'), { name: 'author sees the withdrawal' })

  // D2 (cycle 3): the quarantine's signed length is checked before the main
  // store opens anything, so no core exists for the key.
  const dk = Hypercore.discoveryKey(b4a.from(author.key, 'hex'))
  const store = await openStore(b.dir)
  try {
    t.is(await store.storage.hasCore(dk), false, 'nothing opened in the main store')
  } finally {
    await store.close()
  }
  // The byte limit: same outcome, again at the quarantine gate (nothing was
  // stored by the first run).
  const rb2 = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 10000, maxLogBytes: 10 })
  t.alike(rb2.skipped, [{ key: author.key, reason: 'quota' }])
  const store2 = await openStore(b.dir)
  try {
    t.is(await store2.storage.hasCore(dk), false, 'still nothing in the main store')
  } finally {
    await store2.close()
  }
})

test('H1 (cycle 3): have and rejected floods yield at most one event each and are dropped with message-rate', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  const b = await makeMember(t, kp, { posts: 0 })
  const store = await sharedStore(t)
  const haveFlood = await hostileNode(t, bootstrap, (send) => {
    send({ type: 'hello', v: 1, role: 'member', count: 0, have: [] })
    for (let i = 0; i < 10000; i++) send({ type: 'have', key: b.key, length: 1 })
  }, { store })
  const rejectFlood = await hostileNode(t, bootstrap, (send) => {
    send({ type: 'hello', v: 1, role: 'member', count: 0, have: [] })
    for (let i = 0; i < 10000; i++) send({ type: 'rejected', key: b.key, reason: 'untrusted-association' })
  }, { store })
  await joinAndFlush(haveFlood.swarm, [rendezvous])
  await joinAndFlush(rejectFlood.swarm, [rendezvous])
  const flooders = new Set([hex(haveFlood.swarm.keyPair.publicKey), hex(rejectFlood.swarm.keyPair.publicKey)])

  const ev = collector()
  const dropped = () => ev.events.filter((e) => e.event === 'peer-dropped' && e.reason === 'message-rate' && flooders.has(e.peerKey))
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  const p = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    signal: controller.signal,
    messageBurst: 100,
    messageRate: 10,
    onEvent: ev.onEvent
  })
  await until(() => dropped().length === 2, { timeoutMs: 30000, name: 'both flooders dropped' })
  controller.abort()
  await p
  t.ok(ev.events.filter((e) => e.event === 'have').length <= 1, 'at most one have event')
  t.ok(ev.events.filter((e) => e.event === 'withdrawn').length <= 1, 'at most one withdrawn event')
  t.is(dropped().length, 2)
})

test('H2 (cycle 3): a hostile advertiser that never serves block 0 stops holding --once once its fetch failed', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const k = randomKey()
  const liar = await rawNode(t, bootstrap, { have: () => [{ key: k, length: 1 }] })
  await joinAndFlush(liar.swarm, [topicFor(hex(kp.publicKey))])

  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [k])
  const started = Date.now()
  // A long unverified budget: the failed fetch, not the budget, releases K.
  const rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 30000, gateTimeoutMs: 1000, unverifiedBudgetMs: 60000 })
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.ok(Date.now() - started < 20000, 'resolved well before the deadline')
  t.alike(rb.unadvertised, [k], 'the failed key is reported unadvertised')
  t.alike(rb.skipped, [])
  t.absent(k in rb.downloaded)
  t.ok(rb.errorsSoft.includes('bloco 0 indisponível: ' + k.slice(0, 8)), JSON.stringify(rb.errorsSoft))
})

test('D1/D4 (cycle 3): an active follow advertised only at 0 is unadvertised and does not stop re-discovery', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const author = await rawAuthor(t, bootstrap, kp) // 3 blocks
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  const r1 = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 30000 })
  t.ok(r1.ok, JSON.stringify(r1.errors))
  t.is(r1.downloaded[author.key], 3)
  await author.swarm.destroy()

  // Another follower of the author, with nothing of it: advertises it at 0.
  // It is also on the author's diary topic (retry item 6): a connection
  // discovered there from an empty follower does not count either.
  const follower = await rawNode(t, bootstrap, { have: () => [{ key: author.key, length: 0 }] })
  const topic = Hypercore.discoveryKey(b4a.from(author.key, 'hex'))
  await joinAndFlush(follower.swarm, [topicFor(hex(kp.publicKey)), topic])
  const followerKey = hex(follower.swarm.keyPair.publicKey)
  let inspect = null
  let hasPeer = null
  const r2 = await runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 30000,
    inspectHook: (h) => { inspect = h },
    onEvent: (e) => {
      if (e.event === 'peer' && e.peerKey === followerKey) hasPeer = inspect.topicHasPeer(topic)
    }
  })
  t.is(hasPeer, false, 'a peer at length 0 does not count for the topic')
  t.ok(r2.ok, JSON.stringify(r2.errors))
  t.is(r2.downloaded[author.key], 3)
  t.alike(r2.unadvertised, [author.key], 'advertised only at 0: unadvertised')
})

test('retry item 2: failed-fetch sockets are released when they close', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  const k = randomKey()
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [k])
  // A holder interested in our diary keeps the run open (long budget).
  const holder = await rawNode(t, bootstrap, { have: () => [{ key: b.key, length: 0 }] })
  await joinAndFlush(holder.swarm, [rendezvous])
  let inspect = null
  const seen = new Set()
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  const p = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 100000,
    gateTimeoutMs: 300,
    unverifiedBudgetMs: 600000,
    signal: controller.signal,
    inspectHook: (h) => { inspect = h },
    onEvent: (e) => { if (e.event === 'peer') seen.add(e.peerKey) }
  })
  for (let i = 0; i < 6; i++) {
    const liar = await rawNode(t, bootstrap, { have: () => [{ key: k, length: 1 }] })
    await joinAndFlush(liar.swarm, [rendezvous])
    const liarKey = hex(liar.swarm.keyPair.publicKey)
    await until(() => seen.has(liarKey), { timeoutMs: 30000, name: 'liar ' + i + ' connected' })
    await until(() => inspect.failedSocketCount() === 1, { timeoutMs: 30000, name: 'fetch ' + i + ' failed' })
    await liar.swarm.destroy()
    await until(() => inspect.failedSocketCount() === 0, { timeoutMs: 30000, name: 'liar ' + i + ' released' })
  }
  t.is(inspect.failedSocketCount(), 0, 'no closed socket is kept')
  controller.abort()
  await p
})

test('retry item 4: a pending key whose fetch was cut by the deadline stays unmet after the budget', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const k = randomKey()
  const liar = await rawNode(t, bootstrap, { have: () => [{ key: k, length: 1 }] })
  await joinAndFlush(liar.swarm, [topicFor(hex(kp.publicKey))])
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [k])
  // The budget expires long before the deadline-bound fetch ends.
  const rb = await runSync({ ...localSwarmOptions(bootstrap), dataDir: b.dir, once: true, timeoutMs: 4000, unverifiedBudgetMs: 500 })
  t.is(rb.ok, false)
  t.alike(rb.errors, ['tempo esgotado: ' + k + ':0/1'])
  t.absent(k in rb.downloaded)
})

test('retry item 5: a follow still in regate at the deadline is unmet even after the budget', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  const author = await rawAuthor(t, bootstrap, kp)
  // A bystander keeps a peer in the run after the author left.
  const bystander = await rawNode(t, bootstrap, { have: () => [] })
  await joinAndFlush(bystander.swarm, [rendezvous])
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  const rb = await runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 5000,
    unverifiedBudgetMs: 300,
    // Block 0 reached the quarantine; the advertiser leaves before the main
    // store gets it, so the replica stays in regate until the deadline.
    openHook: async () => { await author.swarm.destroy() }
  })
  t.is(rb.ok, false)
  t.is(rb.errors.length, 1)
  t.ok(rb.errors[0].startsWith('tempo esgotado: ') && rb.errors[0].includes(author.key + ':0/'), JSON.stringify(rb.errors))
  t.absent(author.key in rb.downloaded)
})

test('review item 1: a deadline-bound fetch whose advertisers all left reports the key unadvertised', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  const k = randomKey()
  // A bystander keeps a peer in the run after the only advertiser left.
  const bystander = await rawNode(t, bootstrap, { have: () => [] })
  await joinAndFlush(bystander.swarm, [rendezvous])
  // C advertises K and never serves block 0.
  const c = await rawNode(t, bootstrap, { have: () => [{ key: k, length: 1 }] })
  await joinAndFlush(c.swarm, [rendezvous])
  const cKey = hex(c.swarm.keyPair.publicKey)
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [k])
  let left = null
  // timeoutMs < gateTimeoutMs: the fetch for K is bound by the deadline.
  const rb = await runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 4000,
    unverifiedBudgetMs: 60000,
    onEvent: (e) => {
      if (left === null && e.event === 'peer' && e.peerKey === cKey) left = c.swarm.destroy()
    }
  })
  t.ok(left !== null, 'C joined the run and left before block 0')
  if (left) await left
  t.ok(rb.errorsSoft.includes('bloco 0 indisponível: ' + k.slice(0, 8)), 'the fetch for K ran and failed')
  t.absent(rb.errors.some((e) => e.startsWith('tempo esgotado')), JSON.stringify(rb.errors))
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.alike(rb.unadvertised, [k])
  t.absent(k in rb.downloaded)
})

test('review item 2: closed sockets in a fetch do not lock a later advertiser out of it', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  const author = await rawAuthor(t, bootstrap, kp, 2, { join: false })
  // Two short-lived identities advertise the key, never serve block 0, and
  // fill the fetch (maxConnections 2) before they leave.
  const liars = []
  for (let i = 0; i < 2; i++) {
    const liar = await rawNode(t, bootstrap, { have: () => [{ key: author.key, length: 3 }] })
    await joinAndFlush(liar.swarm, [rendezvous])
    liars.push(liar)
  }
  const liarKeys = liars.map((l) => hex(l.swarm.keyPair.publicKey))
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  let inspect = null
  const seen = new Set()
  // timeoutMs < gateTimeoutMs: the fetch is deadline-bound, so the author
  // can only supply block 0 by joining that same fetch.
  const p = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 12000,
    maxConnections: 2,
    unverifiedBudgetMs: 60000,
    inspectHook: (h) => { inspect = h },
    onEvent: (e) => { if (e.event === 'peer') seen.add(e.peerKey) }
  })
  await until(() => liarKeys.every((k) => seen.has(k)), { timeoutMs: 20000, name: 'both liars joined the fetch' })
  for (const liar of liars) await liar.swarm.destroy()
  await until(() => inspect && !inspect.topicHasPeer(rendezvous), { timeoutMs: 20000, name: 'liars closed' })
  await author.join()
  const rb = await p
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.is(rb.downloaded[author.key], 3, 'the late author joined the fetch and the follow completed')
  t.alike(rb.skipped, [])
})

test('review item 2: an advertiser refused by a full fetch gets the slot a closed socket frees', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  const author = await rawAuthor(t, bootstrap, kp, 2, { join: false })
  const authorKey = hex(author.swarm.keyPair.publicKey)
  // Two liars advertise the key, never serve block 0 and fill the fetch.
  const liars = []
  for (let i = 0; i < 2; i++) {
    const liar = await rawNode(t, bootstrap, { have: () => [{ key: author.key, length: 3 }] })
    await joinAndFlush(liar.swarm, [rendezvous])
    liars.push(liar)
  }
  const liarKeys = liars.map((l) => hex(l.swarm.keyPair.publicKey))
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [author.key])
  const seen = new Set()
  // Two open sockets per fetch (the connection cap stays at its default so
  // the author can connect while the fetch is full). timeoutMs <
  // gateTimeoutMs: the fetch is deadline-bound, no retry fits before it.
  const p = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 12000,
    maxFetchSockets: 2,
    unverifiedBudgetMs: 60000,
    onEvent: (e) => { if (e.event === 'peer') seen.add(e.peerKey) }
  })
  await until(() => liarKeys.every((k) => seen.has(k)), { timeoutMs: 20000, name: 'both liars joined the fetch' })
  // The author advertises while the fetch is full: refused.
  await author.join()
  await until(() => seen.has(authorKey), { timeoutMs: 20000, name: 'author connected' })
  for (const liar of liars) await liar.swarm.destroy()
  const rb = await p
  t.ok(rb.ok, JSON.stringify(rb.errors))
  t.is(rb.downloaded[author.key], 3, 'the refused author took a freed slot and the follow completed')
  t.alike(rb.skipped, [])
})

test('G1: a closed peer releases its per-connection advertisement state', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const rendezvous = topicFor(hex(kp.publicKey))
  const k = randomKey()
  const b = await makeMember(t, kp, { posts: 0 })
  writeFollows(b.dir, [k])
  // A holder interested in our diary keeps the run open (long budget).
  const holder = await rawNode(t, bootstrap, { have: () => [{ key: b.key, length: 0 }] })
  await joinAndFlush(holder.swarm, [rendezvous])
  let inspect = null
  const seen = new Set()
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  const p = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: b.dir,
    once: true,
    timeoutMs: 100000,
    unverifiedBudgetMs: 600000,
    signal: controller.signal,
    inspectHook: (h) => { inspect = h },
    onEvent: (e) => { if (e.event === 'peer') seen.add(e.peerKey) }
  })
  // Advertises our diary and a followed key: both are tracked per peer.
  const other = await rawNode(t, bootstrap, { have: () => [{ key: b.key, length: 1 }, { key: k, length: 1 }] })
  await joinAndFlush(other.swarm, [rendezvous])
  const otherKey = hex(other.swarm.keyPair.publicKey)
  await until(() => seen.has(otherKey), { timeoutMs: 30000, name: 'peer connected' })
  await other.swarm.destroy()
  await until(() => inspect.lastClosedPeer() && inspect.lastClosedPeer().peerKey === otherKey, { timeoutMs: 30000, name: 'peer closed' })
  const closed = inspect.lastClosedPeer()
  t.is(closed.lastAdv.size, 0, 'lastAdv released')
  t.is(closed.emittedHave.size, 0, 'emittedHave released')
  controller.abort()
  await p
})
