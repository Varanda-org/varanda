// diary.peek end to end, loopback only: the browser node session (Hypercore
// 10, memory storage, the RPC client wired in memory) reads, through its
// RUNNING continuous sync, the requested blocks of diaries a real in-process
// Seeder (Hypercore 11) serves over its WebSocket entry: a diary this node
// does not follow (gated on an in-memory core, never stored), a followed
// one (read from the core the run already holds: no second core on the
// link), the own diary, a blocked key, an unknown key; the profile and
// username hints; a peek issued during a feed.read served on the run's
// cores (same run, no preemption); and,
// without any seeder, the timeout and the concurrency cap.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createIssuerCert, createUsernameRecord, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord } = require('@varanda/core/lib/records')
const { createSnapshot, compareSnapshots } = require('@varanda/core/lib/blocklist')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
const { wsStream } = require('../lib/ws-stream')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')

const SEEDER_UNAVAILABLE = 'semeador indisponível'
const DIARY_UNAVAILABLE = 'diário indisponível'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

// The seeder in this process with a WebSocket entry handing streams to
// acceptStream (as test/g1-seeder-ws.test.js).
async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-peek-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-peek-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const client of wss.clients) client.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  return { seeder, events, publicKey, url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// A Hypercore 10 member (memory) with its certificate and `records` (json
// values appended as they are; a function gets the key), announced to the
// seeder and served whole; its link is closed afterwards unless `keepLink`,
// so the seeder alone serves it.
async function servedMember (t, { assoc, seederUrl, seederKey, records, keepLink = false }) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assoc.kp))
  for (const record of records) await m.core.append(typeof record === 'function' ? record(m.key) : record)
  const link = connectSeeder({
    member: m,
    socket: new WebSocket(seederUrl),
    association: assoc.hex,
    seederPublicKey: seederKey,
    timeoutMs: 30000
  })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await link.waitServed(m.core.length)
  if (!keepLink) link.close()
  m.link = link
  return m
}

// A seeder stand-in (as test/blocklist.test.js): role 'seeder' certified by
// the association, replicating and advertising `cores` (`have` may claim a
// length beyond what a core holds yet, so a peek waits for the block), and
// holding `seeder.snapshot` on the blocklist channel, pushed on the open
// links with seeder.push. It admits whatever is announced.
async function fakeSeeder (t, { signer, cores = [], have }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const seeder = {
    url: 'ws://127.0.0.1:' + wss.address().port + '/seeder',
    snapshot: null,
    links: [],
    push (snap) {
      seeder.snapshot = snap
      for (const { handle } of seeder.links) handle.announce()
    }
  }
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      const handle = attachBlocklist(noise, {
        current: () => seeder.snapshot,
        offer: async () => ({ adopted: false, reason: 'same' }),
        compare: compareSnapshots,
        minIntervalMs: 0
      })
      for (const core of cores) core.replicate(noise)
      const peer = attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: have || cores.map((core) => ({ key: hex(core.key), length: core.length })),
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
      const link = { handle, peer }
      seeder.links.push(link)
      noise.once('close', () => { seeder.links = seeder.links.filter((x) => x !== link) })
    })
  })
  return seeder
}

async function browserNode (t, { assoc, seederUrl, storage = memoryNodeStorage(), peekTimeoutMs, syncOptions = {} }) {
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 300, ...syncOptions },
    writeGate: false,
    peekTimeoutMs
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, storage, key: publicKey, internal }
}

// Counts Hypercore#replicate calls per key (hex) for the test's duration:
// a peek of a key the run already replicates must not add one.
function replicateSpy (t) {
  const original = Hypercore.prototype.replicate
  const counts = new Map()
  Hypercore.prototype.replicate = function (...args) {
    const key = this.key ? hex(this.key) : null
    counts.set(key, (counts.get(key) || 0) + 1)
    return original.apply(this, args)
  }
  t.teardown(() => { Hypercore.prototype.replicate = original })
  return (key) => counts.get(key) || 0
}

test('diary.peek reads admitted diaries through the running sync without storing anything', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = association()
  const { url, publicKey: seederKey, events } = await seederStack(t, bootstrap, assoc)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const other = crypto.keyPair()

  // S: not followed. 1 profile, 2 post, 3 verified username, 4 a username
  // record for another member (shape-valid, never verifies for S), 5 junk.
  const S = await servedMember(t, {
    assoc,
    seederUrl: url,
    seederKey,
    records: [
      profileRecord({ name: 'Sofia', bio: 'de passagem' }),
      postRecord({ text: 'poste de quem não sigo' }),
      (key) => createUsernameRecord({ member: key, username: 'sofia' }, issuerKp, issuerCert),
      createUsernameRecord({ member: hex(other.publicKey), username: 'outra' }, issuerKp, issuerCert),
      'lixo'
    ]
  })
  // F: followed by the browser node.
  const F = await servedMember(t, { assoc, seederUrl: url, seederKey, records: [postRecord({ text: 'poste de quem sigo' })] })
  // B: blocked by the association (the snapshot is stored before any run).
  const B = await servedMember(t, { assoc, seederUrl: url, seederKey, records: [postRecord({ text: 'bloqueado' })] })
  t.ok(events.some((e) => e.event === 'have' && e.key === S.key && e.length === 6), 'the seeder holds S whole')

  const storage = memoryNodeStorage()
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, assoc.kp)
  await store.writeBlocklist(storage, createSnapshot({ seq: 1, blocked: [B.key] }, modKp, modCert))
  const replicates = replicateSpy(t)
  const { web, key, internal } = await browserNode(t, { assoc, seederUrl: url, storage, peekTimeoutMs: 6000 })
  await web.request('post.create', { text: 'meu poste' })
  t.alike(await web.request('follow.add', { key: F.key }), { changed: true, followCount: 1 })
  const { runId } = await web.request('sync.start', {})

  // The first peek waits for the run's verified link by itself.
  const peeked = await web.request('diary.peek', { author: S.key, seqs: [1, 2, 3, 4, 5, 9], profileSeq: 1, usernameSeq: 3 })
  t.is(peeked.key, S.key)
  t.is(peeked.length, 6)
  t.alike(peeked.entries.map((e) => e.seq), [1, 2, 3, 4])
  t.is(peeked.entries[1].record.text, 'poste de quem não sigo')
  t.is(peeked.entries[0].record.name, 'Sofia')
  t.is(peeked.entries[2].record.username, 'sofia')
  t.alike(peeked.invalid, [5])
  t.alike(peeked.missing, [9])
  t.alike(peeked.profile, { name: 'Sofia', bio: 'de passagem', avatar: null })
  t.is(peeked.username, 'sofia')
  t.is(replicates(S.key), 1, 'one in-memory core on the link for S')

  // Hints only feed profile / username: a forged username record and a
  // non-profile block give null, and the hint seqs never enter the lists.
  const hinted = await web.request('diary.peek', { author: S.key, seqs: [2], profileSeq: 2, usernameSeq: 4 })
  t.alike(hinted.entries.map((e) => e.seq), [2])
  t.alike(hinted.invalid, [])
  t.alike(hinted.missing, [])
  t.is(hinted.profile, null, 'a post at profileSeq is no profile')
  t.is(hinted.username, null, 'a username record for another member never verifies')
  const sparse = await web.request('diary.peek', { author: S.key, seqs: [2], profileSeq: 7, usernameSeq: 8 })
  t.is(sparse.profile, null)
  t.is(sparse.username, null)
  t.alike(sparse.missing, [], 'absent hint blocks are not reported as missing')
  t.is(replicates(S.key), 3, 'a core per peek, closed afterwards')

  // The own diary: read from the run's own core.
  const own = await web.request('diary.peek', { author: key, seqs: [1, 2, 3] })
  t.is(own.key, key)
  t.alike(own.entries.map((e) => [e.seq, e.record.type]), [[1, 'post'], [2, 'follow']])
  t.alike(own.missing, [3])
  t.is(replicates(key), 1, 'the own diary replicated once, by the run')

  // The followed diary: served from the core the run holds, no second core.
  await until(() => web.events.some((e) => e.name === 'sync.event' && e.data.line === 'downloaded ' + F.key + ' 2'), { name: 'F baixado', timeoutMs: 60000 })
  const before = replicates(F.key)
  const followed = await web.request('diary.peek', { author: F.key, seqs: [1, 2] })
  t.alike(followed.entries.map((e) => [e.seq, e.record.text]), [[1, 'poste de quem sigo']])
  t.alike(followed.missing, [2])
  t.is(followed.length, 2)
  t.is(replicates(F.key), before, 'no new replication channel for a followed key')

  // A blocked key and an unknown key are hidden the same way.
  const blocked = await errorOf(web.request('diary.peek', { author: B.key, seqs: [1] }))
  t.is(blocked.code, 'NOT_FOUND')
  t.is(blocked.message, DIARY_UNAVAILABLE)
  t.is(replicates(B.key), 0, 'a blocked key is refused before any core')
  const unknown = await errorOf(web.request('diary.peek', { author: '12'.repeat(32), seqs: [1] }))
  t.is(unknown.code, 'NOT_FOUND')
  t.is(unknown.message, DIARY_UNAVAILABLE)

  // Nothing was stored: no replica of S, and the replica index holds F only.
  t.absent(await store.replicaExists(storage, S.key), 'no replica of the peeked diary')
  t.absent(await store.replicaExists(storage, B.key))
  t.alike((await storage.readJson('replicas')).keys, [F.key], 'the replica index is unchanged')
  const skipped = (await errorOf(web.request('log.read', { author: S.key })))
  t.is(skipped.message, 'sem dados locais para este diário', 'log.read still has nothing local for S')

  // A peek issued right behind a feed.read is served by the same run: the
  // read borrows the run's cores instead of preempting it. (The run live
  // here may already be a restart of the first: the fold of the drained
  // follow record restarts a continuous run once.)
  const { runId: live } = await web.request('sync.status')
  t.ok(live >= runId)
  const feed = web.request('feed.read', { limit: 5 })
  const during = await web.request('diary.peek', { author: S.key, seqs: [2] })
  t.alike(during.entries.map((e) => e.seq), [2], 'served during the feed read')
  t.ok((await feed).items.some((i) => i.author === F.key), 'the feed read went through too')
  t.absent(web.events.some((e) => e.name === 'sync.stopped' && e.data.runId === live), 'the run was not stopped')
  t.alike(await web.request('sync.status'), { state: 'running', runId: live, once: false }, 'the same run served both')

  const sent = JSON.stringify(web.events)
  t.absent(sent.includes('127.0.0.1') || sent.includes('ws://'), 'no address in events')
  t.alike(internal, [], 'no internal error')
})

test('diary.peek beside a follow being gated, and of a replica catching up', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = association()
  const { url, publicKey: seederKey } = await seederStack(t, bootstrap, assoc)

  // G: followed, its quarantine gate runs when the run's hello arrives.
  const G = await servedMember(t, { assoc, seederUrl: url, seederKey, records: [postRecord({ text: 'gate em andamento' })] })
  // C: followed and stored up to length 2; then it grows at the seeder.
  const C = await servedMember(t, { assoc, seederUrl: url, seederKey, records: [postRecord({ text: 'antigo' })], keepLink: true })
  const replicates = replicateSpy(t)
  const { web, storage, internal } = await browserNode(t, { assoc, seederUrl: url, peekTimeoutMs: 8000 })
  await web.request('follow.add', { key: C.key })
  // C stored whole by a once run; then it grows by two records.
  const { runId: onceId } = await web.request('sync.start', { once: true, timeoutMs: 30000 })
  await until(() => web.events.some((e) => e.name === 'sync.stopped' && e.data.runId === onceId), { name: 'once run', timeoutMs: 60000 })
  t.ok(await store.replicaExists(storage, C.key), 'C stored')
  await C.core.append(postRecord({ text: 'novo 1' }))
  await C.core.append(postRecord({ text: 'novo 2' }))
  await C.link.waitServed(4)

  // The continuous run: G's gate starts on the hello; a peek of G issued
  // at once waits for that gate instead of doubling G's core on the link,
  // and the follow still lands (no retry: GATE_RETRY_MS is 15 s).
  await web.request('follow.add', { key: G.key })
  const cBefore = replicates(C.key)
  await web.request('sync.start', {})
  const [g, c] = await Promise.all([
    web.request('diary.peek', { author: G.key, seqs: [1, 2] }),
    web.request('diary.peek', { author: C.key, seqs: [1, 2, 3, 4] })
  ])
  t.alike(g.entries.map((e) => [e.seq, e.record.text]), [[1, 'gate em andamento']])
  t.alike(g.missing, [2])
  await until(() => web.events.some((e) => e.name === 'sync.event' && e.data.line === 'downloaded ' + G.key + ' 2'), { name: 'G baixado sem repetir o portão', timeoutMs: 10000 })
  t.is(replicates(G.key), 2, 'the quarantine core and the replica: no core for the peek')
  // The catching-up replica: blocks beyond the local length are fetched up
  // to the length the seeder advertises.
  t.alike(c.entries.map((e) => [e.seq, e.record.text]), [[1, 'antigo'], [2, 'novo 1'], [3, 'novo 2']])
  t.alike(c.missing, [4])
  t.is(replicates(C.key), cBefore + 1, 'read from the replica the run holds (its one channel)')
  t.alike(internal, [], 'no internal error')
})

test('diary.peek: a forked diary is hidden, and a block adopted while the blocks download hides the diary', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, assoc.kp)
  // The peeked diary holds 2 blocks; the seeder claims 3, so a peek of seq
  // 2 waits for the block, which arrives only after the snapshot.
  const source = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await source.ready()
  t.teardown(() => source.close(), { force: true })
  const S = hex(source.key)
  await source.append(memberCertRecord(createCert({ member: S }, assoc.kp)))
  await source.append(postRecord({ text: 'antes do bloqueio' }))
  // X: a diary rewritten after its first post (fork 1); a real seeder
  // refuses it, this stand-in serves it as it is.
  const forked = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await forked.ready()
  t.teardown(() => forked.close(), { force: true })
  const X = hex(forked.key)
  await forked.append(memberCertRecord(createCert({ member: X }, assoc.kp)))
  await forked.append(postRecord({ text: 'apagado' }))
  await forked.truncate(1)
  await forked.append(postRecord({ text: 'reescrito' }))
  await forked.append(postRecord({ text: 'de novo' }))
  t.is(forked.fork, 1)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [source, forked], have: [{ key: S, length: 3 }, { key: X, length: 3 }] })
  const { web, storage, internal } = await browserNode(t, { assoc, seederUrl: seeder.url, peekTimeoutMs: 8000, syncOptions: { blocklistMinIntervalMs: 0 } })
  await web.request('sync.start', {})

  // Served while allowed.
  const allowed = await web.request('diary.peek', { author: S, seqs: [1] })
  t.alike(allowed.entries.map((e) => [e.seq, e.record.text]), [[1, 'antes do bloqueio']])

  // The forked diary is hidden, whatever the seeder serves under its refs.
  const fork = await errorOf(web.request('diary.peek', { author: X, seqs: [1, 2] }))
  t.is(fork.code, 'NOT_FOUND')
  t.is(fork.message, DIARY_UNAVAILABLE)
  t.absent(await store.replicaExists(storage, X))

  let settled = false
  const pending = errorOf(web.request('diary.peek', { author: S, seqs: [1, 2] })).then((err) => {
    settled = true
    return err
  })
  // Past its gate (a loopback round trip), the peek waits for seq 2; the
  // key is blocked meanwhile and the block arrives only afterwards.
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.absent(settled, 'the peek is waiting for the block')
  seeder.push(createSnapshot({ seq: 1, blocked: [S] }, modKp, modCert))
  await until(async () => {
    const data = await store.readBlocklist(storage)
    return data !== null && data.snapshot.seq === 1
  }, { name: 'snapshot adopted', timeoutMs: 20000 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.absent(settled, 'the peek is still waiting for the block')
  await source.append(postRecord({ text: 'depois do bloqueio' }))
  const refused = await pending
  t.is(refused.code, 'NOT_FOUND')
  t.is(refused.message, DIARY_UNAVAILABLE, 'nothing of a diary blocked meanwhile is returned')
  const again = await errorOf(web.request('diary.peek', { author: S, seqs: [1] }))
  t.is(again.message, DIARY_UNAVAILABLE, 'and refused outright afterwards')
  t.absent(await store.replicaExists(storage, S))
  t.alike(internal, [], 'no internal error')
})

test('diary.peek without a seeder: timeout, and at most two peeks in flight', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  // A loopback port nothing listens on.
  const net = require('node:net')
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  const { web, key } = await browserNode(t, { assoc, seederUrl: 'ws://127.0.0.1:' + port + '/seeder', peekTimeoutMs: 1500 })

  // No run at all (nothing wanted): the deadline passes, nothing starts.
  const started = Date.now()
  const idle = await errorOf(web.request('diary.peek', { author: key, seqs: [1] }))
  t.is(idle.code, 'NOT_FOUND')
  t.is(idle.message, SEEDER_UNAVAILABLE)
  t.ok(Date.now() - started >= 1400, 'waited for the deadline')
  t.alike(await web.request('sync.status'), { state: 'idle' }, 'no run was started by the peek')

  // A continuous run that never verifies a link: the same answer, and the
  // third concurrent peek is refused at once.
  await web.request('sync.start', {})
  const first = errorOf(web.request('diary.peek', { author: key, seqs: [1] }))
  const second = errorOf(web.request('diary.peek', { author: key, seqs: [2] }))
  const third = await errorOf(web.request('diary.peek', { author: key, seqs: [3] }))
  t.is(third.code, 'USAGE')
  t.is(third.message, 'ocupado')
  t.is((await first).message, SEEDER_UNAVAILABLE)
  t.is((await second).message, SEEDER_UNAVAILABLE)
  t.alike((await web.request('sync.status')).state, 'running', 'the wanted run keeps running')
  const again = await errorOf(web.request('diary.peek', { author: key, seqs: [1] }))
  t.is(again.message, SEEDER_UNAVAILABLE, 'a slot is free again')
})
