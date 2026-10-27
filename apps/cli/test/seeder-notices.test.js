// Follow notices at the seeder (packages/core/lib/seeder.js, notices.js,
// notices-net.js): the seeder folds the signed `follow` records it already
// scans into an in-memory follower index and serves it on
// 'varanda/notices/1', only to a connection that proved it owns the diary
// key, only for a served, unblocked diary, and never persists any of it.
// Proving members hold their diary in compat mode with an explicit key pair,
// so the diary key IS the Ed25519 public key (web-member/lib/member.js).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const c = require('compact-encoding')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const { keyPair: signingKeyPair, randomBytes } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, followRecord } = require('@varanda/core/lib/records')
const { NOTICES_PROTOCOL, MAX_NONMEMBER_TARGETS_PER_AUTHOR, noticePayload, signNoticeProof, createNoticeIndex } = require('@varanda/core/lib/notices')
const { attachNotices } = require('@varanda/core/lib/notices-net')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function validCert (assoc, key) {
  return createCert({ member: key }, assoc.kp)
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

// A plain member (Corestore diary, key = manifest hash) on the association
// topic. It speaks admission only: it never opens the notices channel.
async function plainMember (t, bootstrap, assoc) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(validCert(assoc, key)))
  await diary.append(postRecord({ text: 'oi' }))
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  await joinAndFlush(swarm, [topicFor(assoc.hex)])
  return memberApi({ diary, key, swarm, messages, peers })
}

// A proving member: compat diary (key === Ed25519 public key) dialing the
// seeder directly, with the admission channel and the notices member role.
async function provingMember (t, bootstrap, assoc, seederKey) {
  const kp = signingKeyPair()
  const diary = new Hypercore(tmpDir(t, 'varanda-compat-'), { keyPair: kp, compat: true, valueEncoding: 'json' })
  await diary.ready()
  t.teardown(() => diary.close(), { force: true })
  const key = hex(diary.key)
  t.is(key, hex(kp.publicKey), 'compat diary key is the signing public key')
  await diary.append(memberCertRecord(validCert(assoc, key)))
  await diary.append(postRecord({ text: 'oi' }))
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  const sockets = []
  const noticeOpts = { role: 'member', ownKey: key, sign: (payload) => signNoticeProof(payload, kp) }
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    diary.replicate(socket)
    attachNotices(socket, noticeOpts)
    sockets.push(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  const m = memberApi({ diary, key, swarm, messages, peers })
  // The live seeder socket's notices handle (a fresh one if the previous
  // channel finished, notices-net.js lifetime).
  m.notices = () => {
    const socket = [...sockets].reverse().find((s) => !s.destroyed && s.remotePublicKey && hex(s.remotePublicKey) === seederKey)
    if (!socket) throw new Error('no seeder socket')
    return attachNotices(socket, noticeOpts)
  }
  m.page = async (opts = { limit: 64 }) => {
    const h = await until(() => { try { return m.notices() } catch { return null } }, { name: 'canal de avisos' })
    return h.requestPage(opts)
  }
  // Polls this member's page until pred holds (bounded).
  m.pageUntil = (pred, name) => until(async () => {
    let p
    try {
      p = await m.page()
    } catch {
      return null
    }
    return pred(p) ? p : null
  }, { name, intervalMs: 250, timeoutMs: 30000 })
  m.kp = kp
  return m
}

function memberApi ({ diary, key, swarm, messages, peers }) {
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const message = (pred, name, timeoutMs = 20000) => until(() => messages.find(pred), { name, timeoutMs })
  return { diary, key, swarm, messages, peers, seederPeer, message }
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
  return peer
}

async function grown (m, record) {
  await m.diary.append(record)
  const seq = m.diary.length - 1
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
  return seq
}

// A raw node dialing the seeder with its own notices channel, to send
// hand-made messages (the member role would never send them).
async function rawNode (t, bootstrap, seederKey) {
  const store = new Corestore(tmpDir(t, 'varanda-raw-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const conns = []
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    store.replicate(socket)
    const got = []
    const conn = { socket, got, closed: false }
    socket.once('close', () => { conn.closed = true })
    const ch = socket.noiseStream.userData.createChannel({ protocol: NOTICES_PROTOCOL })
    const msg = ch.addMessage({ encoding: c.buffer, onmessage: (buf) => got.push(JSON.parse(b4a.toString(buf, 'utf8'))) })
    ch.open()
    conn.send = (o) => msg.send(b4a.from(JSON.stringify(o), 'utf8'))
    attachAdmission(socket, { role: 'member', have: [] })
    conns.push(conn)
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  const conn = await until(() => conns[0], { name: 'conexão crua' })
  const challenge = await until(() => conn.got.find((x) => x.type === 'challenge'), { name: 'desafio' })
  conn.nonce = challenge.nonce
  return conn
}

function makeModerator (assoc) {
  const kp = signingKeyPair()
  return { kp, cert: createModeratorCert({ moderator: hex(kp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp) }
}

// Pushes a blocklist snapshot to the seeder from a node holding it.
async function pushBlocklist (t, bootstrap, seederKey, snapshot) {
  const store = new Corestore(tmpDir(t, 'varanda-mod-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    store.replicate(socket)
    attachBlocklist(socket, {
      current: () => snapshot,
      offer: async () => ({ adopted: false, reason: 'same', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() })
    })
    attachAdmission(socket, { role: 'member', have: [] })
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  return swarm
}

function keysOf (page) {
  return page.items.map((it) => it.key)
}

test('notices: proved pages list followers, bad proofs get nothing, unfollow and blocks remove them, nothing persisted', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const statsKeys = Object.keys(seeder.stats())
  const filesBefore = fs.readdirSync(dataDir).sort()

  const A = await plainMember(t, bootstrap, assoc)
  const B = await provingMember(t, bootstrap, assoc, publicKey)
  const C = await provingMember(t, bootstrap, assoc, publicKey)
  const D = await provingMember(t, bootstrap, assoc, publicKey) // never admitted
  await admit(A, assoc)
  await admit(B, assoc)
  await admit(C, assoc)
  t.ok(await B.notices().proved, 'B sent its proof')

  // A follows B: B's proved page lists exactly A, with A's signed seq and at.
  const followB = followRecord({ key: B.key, on: true })
  const seqB = await grown(A, followB)
  const pB = await B.pageUntil((p) => p.items.length === 1 && !p.incomplete, 'B vê A')
  t.alike(pB, { items: [{ key: A.key, seq: seqB, at: followB.at }], next: null, incomplete: false })

  // C's proof binds C: A's follow of B is not on C's page.
  t.alike(await C.page(), { items: [], next: null, incomplete: false })
  // A target that is not served gets an empty page, never marked final: it
  // may be in its admission window.
  t.alike(await D.page(), { items: [], next: null, incomplete: true })
  // An owner whose diary is not gated (a re-gate in progress) still gets
  // the followers already committed in the index, marked incomplete.
  const entryB = seeder._served.get(B.key)
  entryB.gated = false
  t.alike(await B.page(), { items: [{ key: A.key, seq: seqB, at: followB.at }], next: null, incomplete: true }, 'not gated: committed followers, incomplete')
  entryB.gated = true
  t.alike(await B.page(), pB, 'gated again: complete')

  // The plain member never opened the channel: still admitted, replicating.
  t.ok(seeder.admittedKeys().includes(A.key))
  t.is(seeder._served.get(A.key).core.contiguousLength, A.diary.length, 'A replicated to its full length')
  t.absent(events.some((e) => e.event === 'peer-dropped'), 'nobody dropped so far')

  // Bad messages: a page before a proof, a proof by another key, then more
  // pages until more than 5 bad messages drop the socket. No items ever.
  const r1 = await rawNode(t, bootstrap, publicKey)
  const noise1 = hex(r1.socket.publicKey)
  r1.send({ type: 'page', after: null, limit: 10 })
  r1.send({ type: 'proof', key: B.key, sig: hex(signNoticeProof(noticePayload(r1.nonce, noise1, B.key), signingKeyPair())) })
  r1.send({ type: 'page', after: null, limit: 10 })
  r1.send({ type: 'page', after: null, limit: 10 })
  r1.send({ type: 'page', after: null, limit: 10 })
  await delay(500)
  t.is(r1.closed, false, 'five bad messages are tolerated')
  r1.send({ type: 'page', after: null, limit: 10 })
  await until(() => r1.closed, { name: 'socket derrubado' })
  t.absent(r1.got.some((x) => x.type === 'items'), 'no items before a valid proof')
  t.ok(events.some((e) => e.event === 'peer-dropped' && e.reason === 'notices'))

  // A proof by the right key over a wrong nonce gets nothing either.
  const r2 = await rawNode(t, bootstrap, publicKey)
  const wrongNonce = hex(randomBytes(32))
  r2.send({ type: 'proof', key: B.key, sig: hex(signNoticeProof(noticePayload(wrongNonce, hex(r2.socket.publicKey), B.key), B.kp)) })
  r2.send({ type: 'page', after: null, limit: 10 })
  await delay(1000)
  t.absent(r2.got.some((x) => x.type === 'items'), 'no items for a wrong-nonce proof')
  t.is(r2.closed, false)

  // A follows C as well; then unfollows B: B's page omits A, C's keeps it.
  const followC = followRecord({ key: C.key, on: true })
  const seqC = await grown(A, followC)
  await C.pageUntil((p) => p.items.length === 1, 'C vê A')
  await grown(A, followRecord({ key: B.key, on: false }))
  t.alike(await B.pageUntil((p) => p.items.length === 0 && !p.incomplete, 'B sem A'), { items: [], next: null, incomplete: false })
  t.alike(await C.page(), { items: [{ key: A.key, seq: seqC, at: followC.at }], next: null, incomplete: false })

  // Following again lists A at the new seq.
  const refollow = followRecord({ key: B.key, on: true })
  const seqR = await grown(A, refollow)
  const pR = await B.pageUntil((p) => p.items.length === 1, 'B vê A de novo')
  t.alike(pR.items, [{ key: A.key, seq: seqR, at: refollow.at }])

  // A blocked target gets an empty page; B is unaffected.
  const mod = makeModerator(assoc)
  await pushBlocklist(t, bootstrap, publicKey, createSnapshot({ seq: 1, blocked: [C.key], revokedIssuers: [] }, mod.kp, mod.cert))
  await until(() => seeder._isBlocked(C.key) && !seeder._served.has(C.key), { name: 'C bloqueado' })
  t.alike(await C.pageUntil((p) => p.items.length === 0, 'C vazio'), { items: [], next: null, incomplete: false })
  t.alike(keysOf(await B.page()), [A.key])

  // Blocking A removes it from B's page.
  await pushBlocklist(t, bootstrap, publicKey, createSnapshot({ seq: 2, blocked: [C.key, A.key], revokedIssuers: [] }, mod.kp, mod.cert))
  await until(() => seeder._isBlocked(A.key), { name: 'A bloqueado' })
  t.alike(await B.pageUntil((p) => p.items.length === 0, 'B sem A bloqueado'), { items: [], next: null, incomplete: false })

  // Nothing persisted, nothing new in stats, no log line with a follower key.
  t.alike(Object.keys(seeder.stats()), statsKeys, 'stats keys unchanged')
  const filesAfter = fs.readdirSync(dataDir).sort().filter((f) => !filesBefore.includes(f))
  t.absent(filesAfter.some((f) => /notice/i.test(f)), 'no notices file: ' + filesAfter.join(','))
  t.absent(events.some((e) => /notice/.test(e.event || '')), 'no notices log events')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('notices: incomplete until every served diary is committed; a restart rebuilds the same page', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await plainMember(t, bootstrap, assoc)
  const B = await provingMember(t, bootstrap, assoc, publicKey)
  await admit(A, assoc)
  await admit(B, assoc)
  const follow = followRecord({ key: B.key, on: true })
  const seq = await grown(A, follow)
  const before = await B.pageUntil((p) => p.items.length === 1 && !p.incomplete, 'B vê A')
  t.alike(before, { items: [{ key: A.key, seq, at: follow.at }], next: null, incomplete: false })
  await first.seeder.close()

  // At ready every served diary is pending (the scan runs after ready).
  let atReady = null
  const second = newSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    onlog: (e) => {
      if (e.event === 'ready') atReady = second.seeder._notices.page({ target: B.key, isBlocked: () => false })
    }
  })
  await second.seeder.start()
  t.alike(atReady, { items: [], next: null, incomplete: true }, 'nothing published before the scan, incomplete')
  const after = await B.pageUntil((p) => p.items.length === 1 && !p.incomplete, 'B vê A após reinício')
  t.alike(after, before, 'same page after restart')
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

// Suspends the seeder's scan at its read of the served diary's next block
// (seq = the diary's current length): the block itself is read right away,
// so once released the scan continues with the real record. `hit` resolves
// when the scan is suspended; release() lets it go on.
function suspendNextRead (seeder, key) {
  const core = seeder._served.get(key).core
  const get = core.get.bind(core)
  const seq = core.length
  const gate = {}
  gate.hit = new Promise((resolve) => { gate._hit = resolve })
  const released = new Promise((resolve) => { gate.release = resolve })
  core.get = (i, opts) => {
    if (i !== seq) return get(i, opts)
    core.get = get
    const read = get(i, opts)
    gate._hit()
    return read.then((raw) => released.then(() => raw))
  }
  return gate
}

// Re-announces an admitted-then-dropped member and waits for a have at its
// full length that is newer than every message received so far.
async function readmit (m, assoc) {
  const peer = await m.seederPeer()
  const n = m.messages.length
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  await until(() => m.messages.slice(n).find((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length), { name: 'have após readmissão', timeoutMs: 30000 })
}

test('notices: a diary dropped while its scan is suspended in a read leaves no orphan fold', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  // Room for one fold entry in the whole index: an orphan fold left by the
  // stale scan would take it, and every later follow would be truncated.
  seeder._notices = createNoticeIndex({ maxEdges: 1 })

  const A = await plainMember(t, bootstrap, assoc)
  const B = await provingMember(t, bootstrap, assoc, publicKey)
  const E = await plainMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admit(E, assoc)

  const gate = suspendNextRead(seeder, A.key)
  await grown(A, followRecord({ key: B.key, on: true }))
  await gate.hit
  seeder._drop(A.key, 'quota')
  t.absent(seeder._served.has(A.key), 'A dropped while its scan is suspended')
  gate.release()
  await A.message((x) => x.type === 'rejected' && x.key === A.key, 'A rejeitado')
  await seeder._drops.get(A.key)

  // E's follow of B takes the only fold entry: B's page lists E, complete.
  const follow = followRecord({ key: B.key, on: true })
  const seq = await grown(E, follow)
  const page = await B.pageUntil((p) => p.items.length === 1 && !p.incomplete, 'B vê E completo')
  t.alike(page, { items: [{ key: E.key, seq, at: follow.at }], next: null, incomplete: false })
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('notices: a diary re-served while its old scan is suspended publishes the full set', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await plainMember(t, bootstrap, assoc)
  const B = await provingMember(t, bootstrap, assoc, publicKey)
  await admit(A, assoc)
  await admit(B, assoc)

  // A's follow of B is scanned and committed; the old scan is then suspended
  // at a later follow, and A is dropped and admitted again (a new entry,
  // scanning from block 1, queued behind the old scan).
  const follow = followRecord({ key: B.key, on: true })
  const seq = await grown(A, follow)
  await B.pageUntil((p) => p.items.length === 1 && !p.incomplete, 'B vê A')
  const gate = suspendNextRead(seeder, A.key)
  await grown(A, followRecord({ key: hex(randomBytes(32)), on: true }))
  await gate.hit
  const old = seeder._served.get(A.key)
  seeder._drop(A.key, 'quota')
  await A.message((x) => x.type === 'rejected' && x.key === A.key, 'A rejeitado')
  await readmit(A, assoc)
  const fresh = seeder._served.get(A.key)
  t.ok(fresh && fresh !== old, 'A served again by a new entry')
  // Only now does the stale scan see its block: it must not set A's seq
  // mark past the follow of B, or the new scan would ignore that follow and
  // commit a partial set.
  gate.release()
  const page = await B.pageUntil((p) => p.items.length === 1 && !p.incomplete, 'B vê A após readmissão')
  t.alike(page, { items: [{ key: A.key, seq, at: follow.at }], next: null, incomplete: false })
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('notices: a failed block read keeps the author pending and is retried until the scan commits', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await plainMember(t, bootstrap, assoc)
  const B = await provingMember(t, bootstrap, assoc, publicKey)
  await admit(A, assoc)
  await admit(B, assoc)

  // The read of A's follow block fails once; nothing else grows afterwards.
  const entry = seeder._served.get(A.key)
  const core = entry.core
  const get = core.get.bind(core)
  const seq = core.length
  let failures = 0
  core.get = (i, opts) => {
    if (i !== seq || failures > 0) return get(i, opts)
    failures++
    return Promise.reject(new Error('leitura falhou'))
  }
  const follow = followRecord({ key: B.key, on: true })
  await grown(A, follow)
  await until(() => failures === 1, { name: 'leitura falhada' })
  t.ok(entry.scanRetry !== null, 'a retry is scheduled')
  t.is(seeder._notices.page({ target: B.key, isBlocked: () => false }).incomplete, true, 'A pending after the failed read')

  const page = await B.pageUntil((p) => p.items.length === 1 && !p.incomplete, 'B vê A após a nova tentativa')
  t.alike(page, { items: [{ key: A.key, seq, at: follow.at }], next: null, incomplete: false })
  t.is(failures, 1, 'the retry read the block')
  t.is(entry.scanRetries, 0, 'a successful read resets the count')
  t.is(entry.scanRetry, null)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('notices: a diary following many non-member keys neither fills the index nor makes pages incomplete', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await plainMember(t, bootstrap, assoc)
  const B = await provingMember(t, bootstrap, assoc, publicKey)
  const E = await plainMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admit(E, assoc)

  // A follows more random non-member keys than the per-author cap in one
  // append, then B (a member).
  const outsiders = []
  for (let i = 0; i < MAX_NONMEMBER_TARGETS_PER_AUTHOR + 16; i++) outsiders.push(hex(randomBytes(32)))
  await A.diary.append(outsiders.map((key) => followRecord({ key, on: true })))
  await grown(A, followRecord({ key: B.key, on: true }))
  const follow = followRecord({ key: B.key, on: true })
  await grown(E, follow)

  const page = await B.pageUntil((p) => p.items.length === 2 && !p.incomplete, 'B vê A e E completo')
  t.alike(keysOf(page).sort(), [A.key, E.key].sort())
  let stored = 0
  for (const key of outsiders) stored += seeder._notices.page({ target: key, isBlocked: () => false }).items.length
  t.is(stored, MAX_NONMEMBER_TARGETS_PER_AUTHOR, 'only the capped number of non-member targets is indexed')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
