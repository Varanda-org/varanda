// The seeder's engagement index (packages/core/lib/engagement-index.js and
// the index scan of packages/core/lib/seeder.js): built in memory from the
// served diaries' own blocks on a cursor separate from the media scan, read
// through indexPost / indexCounts / indexMember with blocked and dropped
// authors filtered out, bounded by record/target/per-diary caps; the cursor pauses
// (never skips) and resumes when a toggle or drop frees room, rebuilt at every start,
// and honest about it through `indexing` and `complete`.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { mock } = require('node:test')
const b4a = require('b4a')
const Corestore = require('corestore')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const certModule = require('@varanda/core/lib/cert')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair, createIssuerCert, createUsernameRecord } = certModule
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createSwarm, joinAndFlush, topicFor, attachAdmission, MAX_INVENTORY } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, profileRecord, likeRecord, repostRecord } = require('@varanda/core/lib/records')
const { metricsText } = require('../lib/health')
const { createEngagementIndex } = require('@varanda/core/lib/engagement-index')
const { createNoticeIndex } = require('@varanda/core/lib/notices')
const { createPostNoticeIndex } = require('@varanda/core/lib/post-notices')
const { startSeedWs } = require('../lib/seed-ws')
const http = require('node:http')

const HEX64_ANYWHERE = /[0-9a-f]{64}/

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

// Deterministic canonical timestamps, one second apart.
const BASE_MS = Date.parse('2026-03-01T12:00:00.000Z')
function at (i) {
  return new Date(BASE_MS + i * 1000).toISOString()
}

function ref (key, seq) {
  return key + ':' + seq
}

// A member on the swarm: a diary with the certificate and `records(key)`,
// replicated to every connection, announcing itself on the admission
// channel. `blocklist` offers a snapshot on every connection; `joinPeer`
// dials the seeder directly instead of the topic.
async function member (t, bootstrap, assoc, { records = () => [], blocklist = null, joinPeer = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(validCert(assoc, key)))
  for (const r of records(key)) await diary.append(r)

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
  return { store, diary, key, swarm, peers, messages, seederPeer, message }
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
  return peer
}

// Settles once the index cursor of m's diary reached `length` (default: the
// diary's current length).
function indexedTo (seeder, m, length = m.diary.length) {
  return until(() => {
    const entry = seeder._served.get(m.key)
    return entry && entry.indexed >= length
  }, { name: 'diário indexado até ' + length })
}

// Appends records and waits until the seeder advertised the new length.
async function append (m, records) {
  for (const r of records) await m.diary.append(r)
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

const REPLIES = 55

const authorKey = (i) => i.toString(16).padStart(64, '0')

// Exercise the real scan, queue, visibility and flags with generated blocks,
// without retaining 100k input records or requiring network replication.
function scanFixture (options = {}) {
  const seeder = Object.create(Seeder.prototype)
  const { maxServed, ...indexOptions } = options
  Object.assign(seeder, {
    _index: createEngagementIndex({ ...indexOptions, onFreed: () => seeder._scheduleIndexResume() }),
    // _drop also leaves the follow and post notices indexes (seeder.js).
    _notices: createNoticeIndex(),
    _postNotices: createPostNoticeIndex(),
    // The topic search scan is stubbed out: a second reader would steal the
    // reads holdIndexRead holds (apps/cli/test/seeder-topic.test.js covers it).
    _topics: { removeDiary () { return false }, stats () { return { posts: 0, saturated: false } } },
    _topicStartup: new Set(),
    _topicDiary () {},
    _scheduleTopicResume () {},
    _indexQueue: Promise.resolve(),
    _indexStartup: new Set(),
    _indexDropped: new Set(),
    _indexRebuildQueued: false,
    _served: new Map(),
    _admitted: new Map(),
    _dropping: new Map(),
    _mediaServed: new Map(),
    _peers: new Set(),
    _inflight: new Map(),
    _drops: new Map(),
    _purge: async () => {},
    _persist: async () => {},
    _scanDiary: () => {},
    log: () => {},
    _ready: true,
    _closing: false,
    _isBlocked: () => false,
    association: null,
    maxServed: maxServed ?? 4096
  })
  // The name index (account search) is fed by the same scan.
  seeder._names = seeder._createNameIndex()
  function diary (key, length, recordAt) {
    const entry = {
      indexed: 1,
      indexPaused: false,
      indexQueued: false,
      indexRetry: null,
      indexReadFailures: 0,
      stopFork: () => {},
      stopGrow: () => {},
      stopQuota: () => {},
      gated: true,
      dropped: false,
      core: { contiguousLength: length + 1, get: async (seq) => Buffer.from(JSON.stringify(recordAt(seq))) }
    }
    seeder._served.set(key, entry)
    seeder._admitted.set(key, true)
    seeder._indexStartup.add(key)
    return entry
  }
  return { seeder, diary }
}

async function settleIndex (seeder) {
  let queue
  do {
    queue = seeder._indexQueue
    await queue
    await new Promise((resolve) => setImmediate(resolve))
  } while (queue !== seeder._indexQueue)
}

function holdIndexRead (entry, seq) {
  const get = entry.core.get
  let release
  let entered
  const held = new Promise((resolve) => { release = resolve })
  const reading = new Promise((resolve) => { entered = resolve })
  entry.core.get = async (i, ...args) => {
    if (i === seq) {
      entry.core.get = get
      entered()
      await held
    }
    return get(i, ...args)
  }
  return { reading, release }
}

test('re-admission rebuild: restores incoming engagements and repost timelines with honest partial answers', async (t) => {
  const { seeder, diary } = scanFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  const to = { author: A, seq: 1 }
  const post = () => postRecord({ text: 'owner', at: at(0) })
  const records = [
    postRecord({ text: 'reply', replyTo: to, at: at(1) }),
    postRecord({ text: 'quote', quote: to, at: at(2) }),
    likeRecord({ to, on: true, at: at(3) }),
    repostRecord({ to, on: true, at: at(4) })
  ]
  const a = diary(A, 2, post)
  const b = diary(B, records.length, (seq) => records[seq - 1])
  let rebuilds = 0
  const clear = seeder._index.clear
  seeder._index.clear = () => { rebuilds++; clear() }
  seeder._onGrow(A, a, a.core.contiguousLength)
  seeder._onGrow(B, b, b.core.contiguousLength)
  await settleIndex(seeder)
  t.is(rebuilds, 0, 'first-time admissions do not rebuild')
  t.alike(seeder.indexMember(B).posts, [4, 2, 1])
  seeder._drop(A, 'blocked')
  await seeder._drops.get(A)
  t.ok(seeder._indexDropped.has(A))
  t.alike(seeder.indexMember(B).posts, [2, 1])
  t.is(b.indexed, 5, 'drop did not rewind the engager')

  const returning = diary(A, 2, post)
  returning.gated = false
  seeder._indexDiary(A, returning)
  t.absent(seeder._indexRebuildQueued, 'a diary still awaiting its gate cannot trigger a rebuild')
  returning.gated = true
  const bRead = holdIndexRead(b, 1)
  const aRead = holdIndexRead(returning, 2)
  seeder._onGrow(A, returning, returning.core.contiguousLength)
  t.alike(seeder._indexFlags(), { indexing: true, complete: false }, 'pending reset is already incomplete')
  await bRead.reading
  t.is(b.indexed, 1, 'the other diary is replayed from the beginning')
  t.is(seeder._index.stats().records, 0, 'old records and quota counters were cleared')
  t.is(seeder._indexDropped.size, 0)
  t.is(seeder.indexCounts([ref(A, 1)]).indexing, true)
  t.is(seeder.indexMember(B).complete, false)
  bRead.release()
  await aRead.reading
  const partial = seeder.indexPost(A, 1)
  t.alike(partial.replies, [ref(B, 1)])
  t.alike(partial.quotes, [ref(B, 2)])
  t.is(partial.likes, 1)
  t.is(partial.reposts, 1)
  for (const answer of [partial, seeder.indexCounts([ref(A, 1)]), seeder.indexMember(B)]) {
    t.is(answer.indexing, true)
    t.is(answer.complete, false, 'answers stay incomplete until every diary finishes')
  }
  aRead.release()
  await settleIndex(seeder)
  t.is(rebuilds, 1)
  t.alike(seeder.indexCounts([ref(A, 1)]), {
    counts: { [ref(A, 1)]: { replies: 1, quotes: 1, likes: 1, reposts: 1 } },
    indexing: false,
    complete: true
  })
  t.is(seeder.indexPost(B, 1).parent, ref(A, 1))
  t.is(seeder.indexPost(A, 1).complete, true)
  t.alike(seeder.indexMember(B).posts, [4, 2, 1], 'the repost is restored to its author timeline')
  t.is(seeder._index.stats().records, 6, 'replay does not double-count operations')
})

test('re-admission rebuild: pending requests coalesce and reads in flight finish before resetting cursors', async (t) => {
  const { seeder, diary } = scanFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  const C = authorKey(3)
  const D = authorKey(4)
  const post = () => postRecord({ text: 'owner', at: at(0) })
  const a = diary(A, 1, post)
  const c = diary(C, 1, post)
  const d = diary(D, 1, post)
  const b = diary(B, 3, (seq) => seq <= 3
    ? repostRecord({ to: { author: [A, C, D][seq - 1], seq: 1 }, on: true, at: at(seq) })
    : post())
  for (const [key, entry] of [[A, a], [C, c], [D, d], [B, b]]) seeder._indexDiary(key, entry)
  await settleIndex(seeder)
  let rebuilds = 0
  const clear = seeder._index.clear
  seeder._index.clear = () => { rebuilds++; clear() }

  b.core.contiguousLength++
  const oldRead = holdIndexRead(b, 4)
  seeder._indexDiary(B, b)
  await oldRead.reading
  for (const key of [A, C]) {
    seeder._drop(key, 'quota')
    await seeder._drops.get(key)
    seeder._indexDiary(key, diary(key, 1, post))
  }
  t.is(rebuilds, 0, 'reset waits for the outstanding read')
  t.ok(seeder._indexRebuildQueued)
  const rebuildingRead = holdIndexRead(b, 4)
  oldRead.release()
  await rebuildingRead.reading
  t.is(rebuilds, 1, 'both pending re-admissions share a reset')
  t.is(b.indexed, 4, 'the old read did not advance the reset cursor')
  t.is(seeder.indexMember(B).indexing, true)

  // Incoming edges have now been replayed. Dropping these targets during
  // the pass and re-admitting them requests just one additional reset.
  for (const key of [C, D]) {
    seeder._drop(key, 'fork')
    await seeder._drops.get(key)
    seeder._indexDiary(key, diary(key, 1, post))
  }
  t.is(rebuilds, 1)
  rebuildingRead.release()
  await settleIndex(seeder)
  t.is(rebuilds, 2, 'requests during a running pass coalesce into one more rebuild')
  t.alike(seeder.indexMember(B).posts, [4, 3, 2, 1])
  for (const key of [A, C, D]) t.is(seeder.indexPost(key, 1).reposts, 1)
  t.is(seeder._index.stats().records, 7)
  t.alike(seeder._indexFlags(), { indexing: false, complete: true })
})

test('re-admission rebuild: clears paused and retry state and preserves cap and retry rules', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.teardown(() => mock.timers.reset())
  const { seeder, diary } = scanFixture({ perAuthorMax: 2 })
  const A = authorKey(1)
  const B = authorKey(2)
  const C = authorKey(3)
  const post = () => postRecord({ text: 'post', at: at(0) })
  const a = diary(A, 1, post)
  const b = diary(B, 3, (seq) => seq === 1
    ? repostRecord({ to: { author: A, seq: 1 }, on: true, at: at(0) })
    : post())
  const c = diary(C, 1, post)
  const get = c.core.get
  c.core.get = async () => null
  for (const [key, entry] of [[A, a], [B, b], [C, c]]) seeder._indexDiary(key, entry)
  await settleIndex(seeder)
  t.ok(b.indexPaused)
  t.ok(c.indexRetry)
  t.is(c.indexReadFailures, 1)
  seeder._drop(A, 'blocked')
  await seeder._drops.get(A)
  const blockedRead = holdIndexRead(b, 1)
  seeder._indexDiary(A, diary(A, 1, post))
  await blockedRead.reading
  t.absent(b.indexPaused)
  t.is(c.indexed, 1)
  t.is(c.indexRetry, null, 'old timer is cancelled')
  t.is(c.indexReadFailures, 0, 'backoff is reset')
  blockedRead.release()
  await settleIndex(seeder)
  t.ok(b.indexPaused, 'same per-author quota still applies')
  t.is(b.indexed, 3, 'the refused seq was not skipped')
  t.is(c.indexReadFailures, 1)
  t.alike(seeder._indexFlags(), { indexing: true, complete: false })
  for (const delay of [2000, 10000, 30000]) {
    mock.timers.tick(delay)
    await settleIndex(seeder)
  }
  t.is(c.indexReadFailures, 4)
  t.alike(seeder._indexFlags(), { indexing: false, complete: false }, 'retry exhaustion ends the pass, not incompleteness')
  c.core.get = get
  mock.timers.tick(60000)
  await settleIndex(seeder)
  t.is(c.indexed, 2, 'retry continues after the rebuild pass')
  t.is(seeder.indexPost(A, 1).reposts, 1)
  t.is(seeder.indexMember(B).complete, false, 'the paused diary still makes answers incomplete')
  seeder._drop(B, 'blocked')
  await settleIndex(seeder)
  t.alike(seeder._indexFlags(), { indexing: false, complete: true })
})

test('re-admission rebuild: drops without incoming edges do not request a rebuild', async (t) => {
  const { seeder, diary } = scanFixture()
  const A = authorKey(1)
  const records = (seq) => seq === 1
    ? postRecord({ text: 'owner', at: at(0) })
    : repostRecord({ to: { author: A, seq: 1 }, on: true, at: at(1) })
  seeder._indexDiary(A, diary(A, 2, records))
  await settleIndex(seeder)
  seeder._drop(A, 'quota')
  await seeder._drops.get(A)
  t.is(seeder._indexDropped.size, 0, 'self-engagement needs no replay of other diaries')
  let rebuilds = 0
  const clear = seeder._index.clear
  seeder._index.clear = () => { rebuilds++; clear() }
  seeder._indexDiary(A, diary(A, 2, records))
  await settleIndex(seeder)
  t.is(rebuilds, 0)
  t.is(seeder.indexPost(A, 1).reposts, 1)
  t.alike(seeder._indexFlags(), { indexing: false, complete: true })
})

test('re-admission rebuild: dropped-author tracking is bounded without forgetting lost engagements', async (t) => {
  const { seeder, diary } = scanFixture()
  const B = authorKey(MAX_INVENTORY + 2)
  const b = diary(B, MAX_INVENTORY + 1, (seq) => likeRecord({ to: { author: authorKey(seq), seq: 1 }, on: true, at: at(0) }))
  seeder._indexDiary(B, b)
  await settleIndex(seeder)
  let rebuilds = 0
  const clear = seeder._index.clear
  seeder._index.clear = () => { rebuilds++; clear() }
  // Keep all drops in one turn, including one after reaching the bound.
  for (let i = 1; i <= MAX_INVENTORY + 1; i++) {
    const key = authorKey(i)
    diary(key, 0, () => null)
    seeder._drop(key, 'quota')
  }
  t.is(seeder._indexDropped.size, MAX_INVENTORY)
  t.is(rebuilds, 0)
  t.alike(seeder._indexFlags(), { indexing: true, complete: false })
  await settleIndex(seeder)
  t.is(rebuilds, 1, 'at the bound a single rebuild replaces eviction of remembered keys')
  t.is(seeder._indexDropped.size, 0)
  for (const i of [1, MAX_INVENTORY, MAX_INVENTORY + 1]) {
    const key = authorKey(i)
    await seeder._drops.get(key)
    seeder._indexDiary(key, diary(key, 1, () => postRecord({ text: 'returned', at: at(0) })))
  }
  await settleIndex(seeder)
  t.is(rebuilds, 1, 'the rebuild already restored targets of absent authors')
  for (const i of [1, MAX_INVENTORY, MAX_INVENTORY + 1]) t.is(seeder.indexPost(authorKey(i), 1).likes, 1)
  t.alike(seeder._indexFlags(), { indexing: false, complete: true })
})

test('capacity freed: unlike and unrepost resume target-paused diaries without a drop, once per tick', async (t) => {
  for (const toggleRecord of [likeRecord, repostRecord]) {
    const { seeder, diary } = scanFixture({ maxTargets: 2 })
    const A = authorKey(1)
    const B = authorKey(2)
    const C = authorKey(3)
    const owner = diary(C, 4, () => postRecord({ text: 'post', at: at(0) }))
    const a = diary(A, 2, (seq) => toggleRecord({ to: { author: C, seq: seq <= 2 ? seq : seq - 2 }, on: seq <= 2, at: at(seq) }))
    const b = diary(B, 2, (seq) => likeRecord({ to: { author: C, seq: seq + 2 }, on: true, at: at(seq) }))
    for (const [key, entry] of [[C, owner], [A, a], [B, b]]) seeder._indexDiary(key, entry)
    await settleIndex(seeder)
    t.ok(b.indexPaused)
    t.is(b.indexed, 1)
    t.is(seeder.indexCounts([]).complete, false)
    let resumes = 0
    const resume = seeder._resumeIndex.bind(seeder)
    seeder._resumeIndex = () => { resumes++; resume() }
    a.core.contiguousLength += 2
    seeder._indexDiary(A, a)
    await settleIndex(seeder)
    t.is(resumes, 1, 'two off toggles schedule only one resume')
    t.is(b.indexed, 3, 'both refused and later blocks are indexed')
    t.absent(b.indexPaused)
    t.is(seeder._served.size, 3, 'no diary was dropped')
    t.is(seeder._index.stats().targets, 2)
    t.is(seeder._index.stats().records, 10, 'off operations retain their quota cost')
    t.alike(seeder._indexFlags(), { indexing: false, complete: true })
  }
})

test('author drop: removes incoming targets and repost timelines, then resumes a paused diary', async (t) => {
  const { seeder, diary } = scanFixture({ maxTargets: 2 })
  const A = authorKey(1)
  const B = authorKey(2)
  const C = authorKey(3)
  const a = diary(A, 2, () => postRecord({ text: 'owner', at: at(0) }))
  const b = diary(B, 4, (seq) => seq <= 2
    ? repostRecord({ to: { author: A, seq }, on: true, at: at(seq) })
    : postRecord({ text: 'reply or quote', ...(seq === 3 ? { replyTo: { author: A, seq: 1 } } : { quote: { author: A, seq: 2 } }), at: at(seq) }))
  const c = diary(C, 1, () => likeRecord({ to: { author: B, seq: 3 }, on: true, at: at(1) }))
  for (const [key, entry] of [[A, a], [B, b], [C, c]]) seeder._indexDiary(key, entry)
  await settleIndex(seeder)
  t.ok(c.indexPaused)
  t.is(seeder._index.stats().targets, 2)
  seeder._drop(A, 'blocked')
  t.is(seeder._index.stats().targets, 0, 'both targets of the dropped author are removed synchronously')
  t.alike(seeder.indexMember(B).posts, [4, 3], 'reposts disappear; reply and quote posts remain')
  t.is(seeder._index.stats().records, 4, 'remaining diaries keep their operation quotas')
  await settleIndex(seeder)
  t.is(c.indexed, 2)
  t.absent(c.indexPaused)
  t.is(seeder._index.stats().targets, 1)
  t.alike(seeder._indexFlags(), { indexing: false, complete: true })
  seeder._drop(B, 'blocked')
  t.is(seeder._index.stats().targets, 0, 'dropping an engager later does not leave stale target bookkeeping')
  await settleIndex(seeder)

  const ix = createEngagementIndex()
  ix.add(B, 1, likeRecord({ to: { author: A, seq: 99 }, on: true, at: at(0) }))
  t.ok(ix.removeDiary(A), 'targets can be removed before any owner record was indexed')
  t.is(ix.stats().targets, 0)
  t.is(ix.stats().records, 1)
  t.ok(ix.removeDiary(B))
  t.is(ix.stats().records, 0)
})

test('read retry: a throw and a null retry without growth, release the queue, and eventually complete', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.teardown(() => mock.timers.reset())
  const { seeder, diary } = scanFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  const a = diary(A, 1, () => postRecord({ text: 'eventually', at: at(0) }))
  const b = diary(B, 1, () => postRecord({ text: 'unblocked', at: at(0) }))
  const get = a.core.get
  let reads = 0
  a.core.get = async (...args) => {
    reads++
    if (reads === 1) throw new Error('temporary read failure')
    if (reads === 2) return null
    return get(...args)
  }
  seeder._indexDiary(A, a)
  seeder._indexDiary(B, b)
  await seeder._indexQueue
  t.is(a.indexed, 1)
  t.is(b.indexed, 2, 'other diary completes while A waits')
  t.alike(seeder._indexFlags(), { indexing: true, complete: false })
  seeder._indexDiary(A, a)
  mock.timers.tick(1999)
  await seeder._indexQueue
  t.is(reads, 1, 'growth cannot bypass retry backoff')
  mock.timers.tick(1)
  await seeder._indexQueue
  t.is(reads, 2)
  t.is(a.indexed, 1, 'null leaves the cursor unchanged')
  mock.timers.tick(10000)
  await seeder._indexQueue
  t.is(reads, 3)
  t.is(a.indexed, 2)
  t.is(a.indexReadFailures, 0)
  t.is(a.indexRetry, null)
  t.alike(seeder._indexFlags(), { indexing: false, complete: true })
  t.alike(seeder.indexMember(A).posts, [1])
})

test('read retry: three failed retries cover startup honestly, backoff caps and progress resets it', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.teardown(() => mock.timers.reset())
  const { seeder, diary } = scanFixture()
  const A = authorKey(1)
  const a = diary(A, 2, () => postRecord({ text: 'post', at: at(0) }))
  const get = a.core.get
  let reads = 0
  let recover = false
  a.core.get = async (...args) => {
    reads++
    return recover && args[0] === 1 ? get(...args) : null
  }
  seeder._indexDiary(A, a)
  await seeder._indexQueue
  for (const delay of [2000, 10000, 30000]) {
    t.is(seeder._indexFlags().indexing, true)
    mock.timers.tick(delay)
    await seeder._indexQueue
  }
  t.is(reads, 4, 'initial attempt plus three retries')
  t.alike(seeder._indexFlags(), { indexing: false, complete: false })
  for (let i = 0; i < 2; i++) {
    mock.timers.tick(59999)
    await seeder._indexQueue
    t.is(reads, 4 + i)
    mock.timers.tick(1)
    await seeder._indexQueue
    t.is(reads, 5 + i, 'retry continues every 60s')
  }
  recover = true
  mock.timers.tick(60000)
  await seeder._indexQueue
  t.is(a.indexed, 2, 'one block advances before the next read fails')
  t.is(a.indexReadFailures, 1, 'progress resets backoff')
  const before = reads
  mock.timers.tick(2000)
  await seeder._indexQueue
  t.is(reads, before + 1)
  seeder._drop(A, 'blocked')
  t.is(a.indexRetry, null, 'drop cancels its pending timer')
  mock.timers.tick(60000)
  await settleIndex(seeder)
  t.is(reads, before + 1, 'dropped diary is never retried')
  t.alike(seeder._indexFlags(), { indexing: false, complete: true })
})

test('lazy targets: 100k distinct nonexistent refs are bounded by the default diary quota and measured heap', async (t) => {
  // A fresh process with explicit GC measures retained heap, not allocations
  // left over by another test or input records held by a fixture.
  const script = `
    const { createEngagementIndex } = require(${JSON.stringify(require.resolve('@varanda/core/lib/engagement-index'))})
    const ix = createEngagementIndex()
    const author = 'a'.repeat(64)
    const target = 'b'.repeat(64)
    global.gc()
    const before = process.memoryUsage().heapUsed
    let accepted = 0
    for (let seq = 1; seq <= 100000; seq++) {
      if (ix.add(author, seq, { type: 'like', to: { author: target, seq }, on: true })) accepted++
    }
    global.gc()
    console.log(JSON.stringify({ ...ix.stats(), accepted, bytes: process.memoryUsage().heapUsed - before }))
  `
  const child = spawnSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8' })
  t.is(child.status, 0, child.stderr)
  if (child.status !== 0) return
  const measured = JSON.parse(child.stdout)
  t.is(measured.accepted, 50000)
  t.is(measured.records, 50000)
  t.is(measured.targets, 50000)
  t.ok(measured.saturated)
  t.ok(measured.bytes < 35 * 1024 * 1024, '50k lazy targets retain less than 35 MiB')
  t.comment('50k distinct like targets: ' + (measured.bytes / 1024 / 1024).toFixed(2) + ' MiB retained (' + Math.round(measured.bytes / measured.targets) + ' bytes/target including records)')

  const { seeder, diary } = scanFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  const noisy = diary(A, 100000, (seq) => likeRecord({ to: { author: B, seq }, on: true, at: at(0) }))
  seeder._indexDiary(A, noisy)
  await seeder._indexQueue
  t.is(noisy.indexed, 50001, 'cursor stays at the first refused record')
  t.ok(noisy.indexPaused)
  t.is(seeder._index.stats().targets, 50000)
  t.alike(seeder._indexFlags(), { indexing: false, complete: false })
  const honest = diary(B, 2, () => postRecord({ text: 'honest', at: at(0) }))
  seeder._indexDiary(B, honest)
  await seeder._indexQueue
  t.is(honest.indexed, 3, 'another diary is fully indexed despite saturation of A')
  t.absent(honest.indexPaused)
  t.alike(seeder.indexMember(B).posts, [2, 1])
  t.is(seeder.indexMember(B).complete, false, 'global completeness still reflects the paused diary')
  t.is(seeder.indexCounts([ref(B, 1)]).complete, false)
})

test('target cap: refusal is atomic, existing targets still accept records, and drops resume paused cursors', async (t) => {
  const { seeder, diary } = scanFixture({ maxTargets: 1, perAuthorMax: 3 })
  const A = authorKey(1)
  const B = authorKey(2)
  const C = authorKey(3)
  const to = { author: C, seq: 1 }
  const a = diary(A, 3, () => likeRecord({ to, on: true, at: at(0) }))
  const b = diary(B, 2, (seq) => postRecord({ text: 'reply', replyTo: { author: C, seq }, at: at(0) }))
  seeder._indexDiary(A, a)
  seeder._indexDiary(B, b)
  await seeder._indexQueue
  t.is(a.indexed, 4)
  t.is(b.indexed, 2, 'first reply fits an existing target; second would exceed maxTargets')
  t.ok(b.indexPaused)
  t.is(seeder._index.stats().records, 4, 'refused record consumes no quota')
  t.is(seeder._index.stats().targets, 1)
  t.alike(seeder.indexMember(B).posts, [1], 'refused post does not leak into the timeline')
  t.is(seeder.indexPost(B, 2), null)
  t.is(seeder.indexMember(B).complete, false)

  // B's first reply still holds the target after A is removed. Replaying B
  // must remain paused; an unrelated quota-full diary must not block retry.
  seeder._index.removeDiary(A)
  seeder._served.delete(A)
  seeder._resumeIndex()
  await seeder._indexQueue
  t.is(b.indexed, 2)
  seeder._index.removeDiary(B)
  seeder._served.delete(B)
  const c = diary(C, 2, () => postRecord({ text: 'c', at: at(0) }))
  seeder._indexDiary(C, c)
  await seeder._indexQueue
  t.is(seeder._index.stats().targets, 0)
  t.absent(seeder._index.stats().saturated)

  // A separate paused cursor resumes precisely at its refused seq when
  // the sole owner of the blocking target is removed.
  const d = diary(A, 1, () => likeRecord({ to, on: true, at: at(0) }))
  const e = diary(B, 1, () => likeRecord({ to: { author: C, seq: 2 }, on: true, at: at(0) }))
  seeder._indexDiary(A, d)
  seeder._indexDiary(B, e)
  await seeder._indexQueue
  t.is(e.indexed, 1)
  t.ok(e.indexPaused)
  c.core.contiguousLength++
  seeder._indexDiary(C, c)
  await seeder._indexQueue
  t.is(c.indexed, 4, 'C now fills its per-author quota')
  seeder._index.removeDiary(A)
  seeder._served.delete(A)
  seeder._resumeIndex()
  await seeder._indexQueue
  t.is(e.indexed, 2, 'C staying saturated does not prevent B resuming')
  t.absent(e.indexPaused)
  t.is(seeder.indexCounts([ref(C, 2)]).counts[ref(C, 2)].likes, 1)
  t.is(seeder.indexCounts([ref(C, 2)]).complete, true)

  const ix = createEngagementIndex({ maxTargets: 0 })
  t.ok(ix.add(A, 1, { type: 'like', to, on: false }), 'an off toggle needs no target')
  t.is(ix.stats().targets, 0)
  t.absent(ix.add(A, 2, { type: 'like', to, on: true }))
  t.ok(ix.add(B, 1, { type: 'post', replyTo: null, at: at(0) }), 'plain posts need no target')
})

// Engager pages: every fixture date is in the past of this clock.
const NOW = BASE_MS + 10 * 86400000

// Newest first, the documented order of an engager page.
function newestFirst (a, b) {
  if (a.at !== b.at) return a.at > b.at ? -1 : 1
  if (a.author !== b.author) return a.author < b.author ? -1 : 1
  return b.seq - a.seq
}

// Every page of a likers / reposters list, concatenated, with the sizes of
// the pages; null when any page is null or the cursors do not end.
function allEngagers (ix, target, kind, visible, now = NOW) {
  const items = []
  const sizes = []
  let cursor = null
  for (let n = 0; n < 10000; n++) {
    const page = ix.engagers(target, kind, cursor, visible, now)
    if (page === null) return null
    items.push(...page.items)
    sizes.push(page.items.length)
    if (page.next === null) return { items, total: page.total, sizes }
    cursor = page.next
  }
  return null
}

test('counters match a seeded reference reducer across additions, toggles, removals and re-admission', (t) => {
  const perAuthorMax = 24
  const ix = createEngagementIndex({ perAuthorMax })
  const owners = [100, 101, 102].map(authorKey)
  const refs = owners.flatMap((owner) => [1, 2, 3].map((seq) => ref(owner, seq)))
  for (const owner of owners) {
    for (let seq = 1; seq <= 3; seq++) ix.add(owner, seq, { type: 'post', replyTo: null, at: at(0) })
  }
  const logs = new Map()
  const seqs = new Map()
  const epochs = new Map(owners.map((owner) => [owner, 0]))
  let ownerDrops = 0
  let seed = 0x12345678
  const random = (n) => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) % n
  }
  for (let step = 0; step < 2000; step++) {
    const author = authorKey(1 + random(12))
    if (random(20) === 0) {
      const owner = owners[random(owners.length)]
      const before = ix.stats().targets
      const owned = Object.values(ix.counts([1, 2, 3].map((seq) => ref(owner, seq))))
        .filter((counts) => Object.values(counts).some((n) => n > 0)).length
      ix.removeDiary(owner)
      t.is(ix.stats().targets, before - owned, 'author drop reclaims only its incoming targets')
      epochs.set(owner, epochs.get(owner) + 1)
      ownerDrops++
      for (let seq = 1; seq <= 3; seq++) ix.add(owner, seq, { type: 'post', replyTo: null, at: at(0) })
    } else if (random(8) === 0) {
      ix.removeDiary(author)
      logs.delete(author)
      seqs.delete(author)
    } else {
      const seq = (seqs.get(author) || 0) + 1
      const to = { author: owners[random(owners.length)], seq: 1 + random(3) }
      const kind = random(4)
      const record = kind < 2
        ? { type: kind === 0 ? 'like' : 'repost', to, on: random(2) === 0, at: at(random(10)) }
        : { type: 'post', replyTo: kind === 2 ? to : null, ...(kind === 3 ? { quote: to } : {}), at: at(random(10)) }
      const log = logs.get(author) || []
      const accepted = ix.add(author, seq, record)
      if (accepted !== (log.length < perAuthorMax)) return t.fail('incorrect per-author quota at step ' + step)
      if (accepted) {
        seqs.set(author, seq)
        logs.set(author, log)
        log.push({ seq, record, epoch: epochs.get(to.author) })
      }
    }
    if (step % 20 !== 0 && step !== 1999) continue
    const expected = Object.fromEntries(refs.map((ref) => [ref, { replies: 0, quotes: 0, likes: 0, reposts: 0 }]))
    const ordered = Object.fromEntries(refs.map((ref) => [ref, { replies: [], quotes: [], likes: [], reposts: [] }]))
    for (const [author, log] of logs) {
      const likes = new Map()
      const reposts = new Map()
      const posts = []
      for (const { seq, record, epoch: addedEpoch } of log) {
        if (record.type === 'post') posts.push(seq)
        const targetAuthor = (record.to || record.replyTo || record.quote).author
        if (addedEpoch !== epochs.get(targetAuthor)) continue
        if (record.type === 'post') {
          const to = record.replyTo || record.quote
          const kind = record.replyTo ? 'replies' : 'quotes'
          expected[ref(to.author, to.seq)][kind]++
          ordered[ref(to.author, to.seq)][kind].push({ at: record.at, author, seq })
        } else {
          const set = record.type === 'like' ? likes : reposts
          const target = ref(record.to.author, record.to.seq)
          if (record.on) set.set(target, { at: record.at, seq })
          else set.delete(target)
        }
      }
      for (const [target, on] of likes) {
        expected[target].likes++
        ordered[target].likes.push({ at: on.at, author, seq: on.seq })
      }
      for (const [target, on] of reposts) {
        expected[target].reposts++
        ordered[target].reposts.push({ at: on.at, author, seq: on.seq })
      }
      const timeline = [...posts, ...[...reposts.values()].map((on) => on.seq)].sort((a, b) => b - a)
      t.alike(ix.member(author).posts, timeline, 'timeline after toggles and author drops')
      t.is(ix.member(author).postsTotal, timeline.length)
    }
    t.alike(ix.counts(refs), expected, 'reference counters at step ' + step)
    t.is(ix.stats().records, refs.length + [...logs.values()].reduce((sum, log) => sum + log.length, 0), 'operation quotas include removed-target operations')
    t.is(ix.stats().targets, Object.values(expected).filter((counts) => Object.values(counts).some((n) => n > 0)).length)
    t.is(ix.stats().saturated, [...logs.values()].some((log) => log.length === perAuthorMax), 'per-author saturation agrees with the reference')
    for (const target of refs) {
      const page = ix.post(target)
      const count = expected[target]
      t.alike([page.repliesTotal, page.quotesTotal, page.likes, page.reposts], [count.replies, count.quotes, count.likes, count.reposts])
      const compare = (a, b) => a.at.localeCompare(b.at) || a.author.localeCompare(b.author) || a.seq - b.seq
      const replies = ordered[target].replies.sort(compare)
      t.alike(page.replies, replies.slice(0, 50).map((e) => ref(e.author, e.seq)))
      t.alike(page.quotes, ordered[target].quotes.sort(compare).reverse().slice(0, 50).map((e) => ref(e.author, e.seq)))
      for (const kind of ['likes', 'reposts']) {
        const listed = allEngagers(ix, target, kind)
        const want = ordered[target][kind].sort(newestFirst).map((e) => ref(e.author, e.seq))
        t.alike(listed && [listed.items, listed.total], [want, count[kind]], kind + ' pages of ' + target.slice(-4) + ' at step ' + step)
      }
    }
  }
  t.ok(ownerDrops > 0, 'random sequence includes target-author drops and re-admission')
  for (const author of logs.keys()) ix.removeDiary(author)
  t.is(ix.stats().targets, 0, 'all empty targets reclaimed')
  t.is(ix.stats().records, refs.length)
})

test('engager pages: 75 likers in pages of 20, newest first, cursors without gaps or duplicates; ties by author', (t) => {
  const ix = createEngagementIndex()
  const owner = authorKey(0)
  const to = { author: owner, seq: 1 }
  const target = ref(owner, 1)
  ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
  // A scrambled insertion order: the page order must come from the index.
  for (let k = 0; k < 75; k++) {
    const i = 1 + ((k * 31) % 75)
    ix.add(authorKey(i), 1, { type: 'like', to, on: true, at: at(i) })
  }
  const pages = []
  let cursor = null
  do {
    const page = ix.engagers(target, 'likes', cursor, undefined, NOW)
    pages.push(page)
    cursor = page.next
  } while (cursor !== null && pages.length < 10)
  t.alike(pages.map((p) => p.items.length), [20, 20, 20, 15])
  t.alike(pages.map((p) => p.next === null), [false, false, false, true], 'next is null only on the last page')
  t.alike(pages.flatMap((p) => p.items), Array.from({ length: 75 }, (_, i) => ref(authorKey(75 - i), 1)))
  t.ok(pages.every((p) => p.ref === target && p.kind === 'likes' && p.total === 75))
  t.is(pages[0].next, (BASE_MS + 56000) + '.' + authorKey(56) + '.1')
  t.alike(Object.keys(pages[0].authors).sort(), Array.from({ length: 20 }, (_, i) => authorKey(56 + i)))
  t.alike(pages[0].authors[authorKey(75)], { profileSeq: null, usernameSeq: null })

  // Equal atMs: the lower engager hex first, across a cursor inside the tie.
  ix.add(owner, 2, { type: 'post', replyTo: null, at: at(0) })
  for (let i = 130; i >= 101; i--) ix.add(authorKey(i), 2, { type: 'like', to: { author: owner, seq: 2 }, on: true, at: at(5) })
  const first = ix.engagers(ref(owner, 2), 'likes', null, undefined, NOW)
  t.alike(first.items, Array.from({ length: 20 }, (_, i) => ref(authorKey(101 + i), 2)))
  t.is(first.next, (BASE_MS + 5000) + '.' + authorKey(120) + '.2')
  const second = ix.engagers(ref(owner, 2), 'likes', first.next, undefined, NOW)
  t.alike(second.items, Array.from({ length: 10 }, (_, i) => ref(authorKey(121 + i), 2)))
  t.is(second.next, null)
})

test('engager pages: an unlike removes, a newer on moves, an older seq never overrides; reposts alike, timelines unchanged', (t) => {
  for (const kind of ['likes', 'reposts']) {
    const type = kind === 'likes' ? 'like' : 'repost'
    const ix = createEngagementIndex()
    const owner = authorKey(0)
    const to = { author: owner, seq: 1 }
    const target = ref(owner, 1)
    ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
    for (let i = 1; i <= 30; i++) ix.add(authorKey(i), 1, { type, to, on: true, at: at(i) })
    const E = authorKey(3)
    const before = allEngagers(ix, target, kind)
    t.alike(before.sizes, [20, 10])
    t.is(before.items[27], ref(E, 1), kind + ': E starts on the second page')

    t.ok(ix.add(E, 2, { type, to, on: true, at: at(100) }))
    const moved = allEngagers(ix, target, kind)
    t.is(moved.items[0], ref(E, 2), kind + ': a newer on with a newer at moves E to the first page')
    t.is(moved.total, 30)
    t.is(moved.items.length, 30)
    t.absent(moved.items.includes(ref(E, 1)))
    t.alike(ix.member(E).posts, kind === 'reposts' ? [2] : [])

    ix.add(E, 1, { type, to, on: false, at: at(200) })
    ix.add(E, 1, { type, to, on: true, at: at(300) })
    t.alike(allEngagers(ix, target, kind), moved, kind + ': an older seq neither removes nor moves the newer record')
    t.alike(ix.member(E).posts, kind === 'reposts' ? [2] : [])

    t.ok(ix.add(E, 3, { type, to, on: false, at: at(101) }))
    const after = allEngagers(ix, target, kind)
    t.is(after.total, 29)
    t.is(after.items.length, 29)
    t.absent(after.items.some((r) => r.startsWith(E)), kind + ': an unlike removes the engager')
    t.is(ix.post(target)[kind], 29)
    t.alike(ix.member(E).posts, [])
    t.alike(ix.member(authorKey(4)).posts, kind === 'reposts' ? [1] : [])
  }
})

test('engager pages: an edge dated more than a day ahead is hidden and never examined; totals count it', (t) => {
  const ix = createEngagementIndex()
  const owner = authorKey(0)
  const to = { author: owner, seq: 1 }
  const target = ref(owner, 1)
  const near = authorKey(1)
  const far = authorKey(2)
  const past = authorKey(3)
  ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
  ix.add(near, 1, { type: 'like', to, on: true, at: new Date(NOW + 86400000).toISOString() })
  ix.add(far, 1, { type: 'like', to, on: true, at: new Date(NOW + 86400001).toISOString() })
  ix.add(past, 1, { type: 'like', to, on: true, at: at(1) })
  const seen = []
  const page = ix.engagers(target, 'likes', null, (a) => { seen.push(a); return true }, NOW)
  t.alike(page.items, [ref(near, 1), ref(past, 1)])
  t.alike(seen, [owner, near, past], 'the future edge is never examined')
  t.is(page.total, 3)
  t.is(page.next, null)
  t.is(ix.post(target).likes, 3)
  t.alike(ix.engagers(target, 'likes', null, undefined, NOW + 1).items, [ref(far, 1), ref(near, 1), ref(past, 1)], 'listed once the clock catches up')
})

test('engager pages: hidden engagers count against the 200-edge budget; a throwing predicate answers null', (t) => {
  const ix = createEngagementIndex()
  const owner = authorKey(0)
  const to = { author: owner, seq: 1 }
  const target = ref(owner, 1)
  ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
  for (let i = 1; i <= 300; i++) ix.add(authorKey(i), 1, { type: 'like', to, on: true, at: at(i) })
  let calls = 0
  const visible = (a) => { calls++; return a === owner || parseInt(a, 16) <= 50 }
  const page = ix.engagers(target, 'likes', null, visible, NOW)
  t.alike(page.items, [], 'the 250 newest are hidden')
  t.is(page.next, null, '200 examined edges with nobody listed end the list')
  t.ok(calls <= 201, 'visibility calls: ' + calls)
  t.is(page.total, 300)
  t.alike(page.authors, {})
  t.is(ix.engagers(target, 'likes', null, () => { throw new Error('hostile predicate') }, NOW), null)
  t.is(ix.engagers(target, 'likes', null, (a) => { if (a !== owner) throw new Error('hostile'); return true }, NOW), null)
})

test('engager pages: next never carries a hidden engager and resumes from the last listed one', (t) => {
  const ix = createEngagementIndex()
  const owner = authorKey(0)
  const to = { author: owner, seq: 1 }
  const target = ref(owner, 1)
  ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
  // 300..298 visible, a run of 197 hidden (297..101), then 100..1 visible:
  // the first page lists 3 and stops on the scan budget at a hidden edge.
  for (let i = 1; i <= 300; i++) ix.add(authorKey(i), 1, { type: 'like', to, on: true, at: at(i) })
  const isHidden = (i) => i >= 101 && i <= 297
  const hidden = []
  for (let i = 101; i <= 297; i++) hidden.push(authorKey(i))
  const visible = (a) => a === owner || !isHidden(parseInt(a, 16))
  const leaks = (page) => {
    const json = JSON.stringify(page)
    return hidden.some((k) => json.includes(k))
  }
  const listedCursor = (page) => {
    const last = page.items[page.items.length - 1]
    const [key, seq] = last.split(':')
    return (BASE_MS + parseInt(key, 16) * 1000) + '.' + key + '.' + seq
  }

  const first = ix.engagers(target, 'likes', null, visible, NOW)
  t.alike(first.items, [300, 299, 298].map((i) => ref(authorKey(i), 1)))
  t.is(first.next, listedCursor(first), 'next is the last listed engager, not the last examined')
  t.absent(leaks(first), 'no hidden key in the first page')

  const seen = []
  let page = first
  let pages = 0
  while (true) {
    t.absent(leaks(page), 'no hidden key in page ' + pages)
    if (page.next !== null) t.is(page.next, listedCursor(page), 'next of page ' + pages + ' is a listed engager')
    seen.push(...page.items)
    pages++
    if (page.next === null || pages > 50) break
    page = ix.engagers(target, 'likes', page.next, visible, NOW)
  }
  const expected = [300, 299, 298]
  for (let i = 100; i >= 1; i--) expected.push(i)
  t.alike(seen, expected.map((i) => ref(authorKey(i), 1)), 'every visible engager once, in order, past the hidden run')

  // Every examined edge hidden: an empty page that ends the list.
  const allHidden = (a) => a === owner || parseInt(a, 16) <= 50
  const empty = ix.engagers(target, 'likes', null, allHidden, NOW)
  t.alike(empty.items, [])
  t.is(empty.next, null)
  const hiddenNewest = []
  for (let i = 51; i <= 300; i++) hiddenNewest.push(authorKey(i))
  const json = JSON.stringify(empty)
  t.absent(hiddenNewest.some((k) => json.includes(k)), 'no hidden key in an all-hidden page')
})

test('engager pages: null for bad input or an unknown post, an exact empty page without engagement', (t) => {
  const ix = createEngagementIndex()
  const owner = authorKey(0)
  const to = { author: owner, seq: 1 }
  const target = ref(owner, 1)
  ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
  ix.add(owner, 2, { type: 'post', replyTo: null, at: at(0) })
  ix.add(authorKey(1), 1, { type: 'like', to, on: true, at: at(1) })
  ix.add(authorKey(1), 2, { type: 'like', to: { author: authorKey(50), seq: 1 }, on: true, at: at(1) })
  t.is(ix.engagers(target, 'likes', null, undefined, NOW).items.length, 1)
  for (const kind of ['replies', 'quotes', 'Likes', 'like', '', null, undefined, 1]) {
    t.is(ix.engagers(target, kind, null, undefined, NOW), null, 'bad kind ' + String(kind))
  }
  for (const cursor of ['x', 5, {}, '1.' + owner + '.0', '1.' + 'A'.repeat(64) + '.1', '99999999999999999.' + owner + '.1']) {
    t.is(ix.engagers(target, 'likes', cursor, undefined, NOW), null, 'malformed cursor')
  }
  for (const bad of ['zz', owner + ':0', owner + ':1x', owner + ':01', null, 5, undefined]) {
    t.is(ix.engagers(bad, 'likes', null, undefined, NOW), null, 'bad ref')
  }
  const lettered = 'ab'.repeat(32)
  ix.add(lettered, 1, { type: 'post', replyTo: null, at: at(0) })
  t.ok(ix.engagers(ref(lettered, 1), 'likes', null, undefined, NOW))
  t.is(ix.engagers(ref(lettered.toUpperCase(), 1), 'likes', null, undefined, NOW), null, 'a non-canonical ref')
  for (const now of [NaN, Infinity, -Infinity, undefined, null, '1']) {
    t.is(ix.engagers(target, 'likes', null, undefined, now), null, 'non-finite now')
  }
  t.is(ix.engagers(ref(owner, 9), 'likes', null, undefined, NOW), null, 'post not indexed')
  t.is(ix.engagers(ref(authorKey(50), 1), 'likes', null, undefined, NOW), null, 'engaged but unindexed post')
  t.is(ix.engagers(target, 'likes', null, (a) => a !== owner, NOW), null, 'invisible target author')
  t.alike(ix.engagers(ref(owner, 2), 'reposts', null, undefined, NOW), { ref: ref(owner, 2), kind: 'reposts', items: [], next: null, total: 0, authors: {} })
  t.alike(ix.engagers(target, 'reposts', null, undefined, NOW), { ref: target, kind: 'reposts', items: [], next: null, total: 0, authors: {} })
  t.is(ix.engagers(target, 'likes', null, 'not a function', NOW).total, 1, 'a non-function visible shows everything')
})

test('engager pages: 0 -> 1 -> 2 -> 1 -> 0 transitions in both orders and removeDiary keep pages and totals exact', (t) => {
  const owner = authorKey(0)
  const to = { author: owner, seq: 1 }
  const target = ref(owner, 1)
  const E1 = authorKey(1)
  const E2 = authorKey(2)
  const E3 = authorKey(3)
  for (const kind of ['likes', 'reposts']) {
    const type = kind === 'likes' ? 'like' : 'repost'
    for (const firstOff of [E1, E2]) {
      const ix = createEngagementIndex()
      const list = () => { const all = allEngagers(ix, target, kind); return all && [all.items, all.total] }
      ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
      t.alike(list(), [[], 0])
      ix.add(E1, 1, { type, to, on: true, at: at(1) })
      t.alike(list(), [[ref(E1, 1)], 1])
      ix.add(E1, 2, { type, to, on: true, at: at(3) })
      t.alike(list(), [[ref(E1, 2)], 1], 'a singleton moves without growing')
      ix.add(E2, 1, { type, to, on: true, at: at(2) })
      t.alike(list(), [[ref(E1, 2), ref(E2, 1)], 2])
      const secondOff = firstOff === E1 ? E2 : E1
      ix.add(firstOff, 5, { type, to, on: false, at: at(4) })
      t.alike(list(), [[secondOff === E1 ? ref(E1, 2) : ref(E2, 1)], 1])
      ix.add(firstOff, 6, { type, to, on: true, at: at(5) })
      t.alike(list(), [[ref(firstOff, 6), secondOff === E1 ? ref(E1, 2) : ref(E2, 1)], 2], 'back to two')
      ix.add(firstOff, 7, { type, to, on: false, at: at(6) })
      ix.add(secondOff, 8, { type, to, on: false, at: at(6) })
      t.alike(list(), [[], 0])
      t.alike(ix.counts([target])[target], { replies: 0, likes: 0, reposts: 0, quotes: 0 })
    }

    const ix = createEngagementIndex()
    const list = () => { const all = allEngagers(ix, target, kind); return all && [all.items, all.total] }
    ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
    for (const [i, E] of [E1, E2, E3].entries()) ix.add(E, 1, { type, to, on: true, at: at(i + 1) })
    t.alike(list(), [[ref(E3, 1), ref(E2, 1), ref(E1, 1)], 3])
    ix.removeDiary(E2)
    t.alike(list(), [[ref(E3, 1), ref(E1, 1)], 2], 'removeDiary(engager) leaves the list and the total')
    ix.removeDiary(E3)
    t.alike(list(), [[ref(E1, 1)], 1])
    ix.add(E3, 1, { type, to, on: true, at: at(9) })
    t.alike(list(), [[ref(E3, 1), ref(E1, 1)], 2], 'a re-admitted engager comes back')
    ix.removeDiary(E1)
    ix.removeDiary(E3)
    t.alike(list(), [[], 0])
    ix.add(E1, 1, { type, to, on: true, at: at(1) })
    ix.removeDiary(owner)
    t.is(ix.engagers(target, kind, null, undefined, NOW), null, 'removeDiary(target author) answers null')
    ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
    t.alike(list(), [[], 0], 'a re-admitted author starts without the old engagers')
  }
})

test('engager pages: 20,000 likers on one target have bounded visibility work', (t) => {
  const ix = createEngagementIndex()
  const owner = authorKey(0)
  const to = { author: owner, seq: 1 }
  const target = ref(owner, 1)
  ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
  for (let i = 1; i <= 20000; i++) ix.add(authorKey(i), 1, { type: 'like', to, on: true, at: at(i % 5000) })
  let calls = 0
  const start = performance.now()
  const page = ix.engagers(target, 'likes', null, () => { calls++; return true }, NOW)
  const pageMs = performance.now() - start
  t.is(page.total, 20000)
  t.is(page.items.length, 20)
  t.ok(calls <= 201, 'first page visibility calls: ' + calls)
  calls = 0
  const deep = ix.engagers(target, 'likes', page.next, (a) => { calls++; return a === owner }, NOW)
  t.alike(deep.items, [])
  t.is(deep.next, null, 'an all-hidden page ends the list')
  t.ok(calls <= 201, 'all-hidden page visibility calls: ' + calls)
  t.comment('20k likers: first page ' + pageMs.toFixed(3) + ' ms')
})

test('indexEngagers: likers and reposters of a served post without blocked, dropped, held or future engagers', async (t) => {
  const { seeder, diary } = scanFixture()
  const A = authorKey(1)
  const to = { author: A, seq: 1 }
  const engagers = [2, 3, 4, 5, 6].map(authorKey)
  const F = authorKey(7)
  const entries = [[A, diary(A, 1, () => postRecord({ text: 'owner', at: at(0) }))]]
  for (const [i, E] of engagers.entries()) {
    entries.push([E, diary(E, 2, (seq) => seq === 1
      ? likeRecord({ to, on: true, at: at(i + 1) })
      : repostRecord({ to, on: true, at: at(i + 1) }))])
  }
  const future = new Date(Date.now() + 2 * 86400000).toISOString()
  entries.push([F, diary(F, 1, () => likeRecord({ to, on: true, at: future }))])
  for (const [key, entry] of entries) seeder._indexDiary(key, entry)
  await settleIndex(seeder)

  const newest = [...engagers].reverse()
  const page = seeder.indexEngagers('likes', A, 1)
  t.alike(Object.keys(page).sort(), ['authors', 'complete', 'indexing', 'items', 'kind', 'next', 'ref', 'total'])
  t.alike(page, {
    ref: ref(A, 1),
    kind: 'likes',
    items: newest.map((E) => ref(E, 1)),
    next: null,
    total: 6,
    authors: Object.fromEntries(newest.map((E) => [E, { profileSeq: null, usernameSeq: null }])),
    indexing: false,
    complete: true
  }, 'the like dated two days ahead is absent but counted')
  t.is(seeder.indexCounts([ref(A, 1)]).counts[ref(A, 1)].likes, 6)
  t.alike(seeder.indexEngagers('reposts', A, 1).items, newest.map((E) => ref(E, 2)))

  const [E2, E3, E4] = engagers
  seeder._isBlocked = (hex) => hex === E2
  t.absent(seeder.indexEngagers('likes', A, 1).items.includes(ref(E2, 1)), 'a blocked engager is absent')
  seeder._isBlocked = () => false
  seeder._drop(E3, 'blocked')
  await seeder._drops.get(E3)
  const dropped = seeder.indexEngagers('likes', A, 1)
  t.absent(dropped.items.includes(ref(E3, 1)), 'a dropped engager is absent')
  t.is(dropped.total, 5)
  seeder._served.get(E4).searchHold = 1
  const held = seeder.indexEngagers('reposts', A, 1)
  t.absent(held.items.includes(ref(E4, 2)), 'an engager held by a pending re-gate is absent')
  t.is(held.complete, false)
  seeder._served.get(E4).searchHold = 0
  t.is(seeder.indexEngagers('reposts', A, 1).complete, true)
  seeder._served.get(A).searchHold = 1
  t.is(seeder.indexEngagers('likes', A, 1), null, 'a held target author answers null')
  seeder._served.get(A).searchHold = 0

  t.is(seeder.indexEngagers('replies', A, 1), null)
  t.is(seeder.indexEngagers('likes', A, 0), null)
  t.is(seeder.indexEngagers('likes', authorKey(99), 1), null)
  t.is(seeder.indexEngagers('likes', A, 1, 'nope'), null)
  t.is(seeder.indexEngagers('likes', A, 2), null, 'a post not indexed')
})

test('200k reply edges: cursor pages and counts have bounded visibility work and latency', (t) => {
  const ix = createEngagementIndex()
  const owner = authorKey(0)
  const target = ref(owner, 1)
  ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
  const timestamp = at(1)
  let accepted = 0
  for (let a = 1; a <= 5; a++) {
    for (let seq = 1; seq <= 40000; seq++) {
      if (ix.add(authorKey(a), seq, { type: 'post', replyTo: { author: owner, seq: 1 }, at: timestamp })) accepted++
    }
  }
  t.is(accepted, 200000)
  for (let seq = 1; seq <= 200; seq++) ix.add(authorKey(6), seq, { type: 'post', replyTo: null, quote: { author: owner, seq: 1 }, at: timestamp })
  let calls = 0
  const visible = () => { calls++; return true }
  const cursor = (BASE_MS + 1000) + '.' + authorKey(5) + '.39000'
  const startPage = performance.now()
  const page = ix.post(target, cursor, visible)
  const pageMs = performance.now() - startPage
  t.is(page.repliesTotal, 200000)
  t.is(page.quotesTotal, 200)
  t.alike(page.replies, Array.from({ length: 50 }, (_, i) => ref(authorKey(5), 39001 + i)))
  t.is(page.next, (BASE_MS + 1000) + '.' + authorKey(5) + '.39050')
  t.ok(calls <= 250, 'page visibility checks: ' + calls)
  t.ok(pageMs < 50, 'page under 50 ms: ' + pageMs.toFixed(3))
  const pageCalls = calls
  calls = 0
  const startCounts = performance.now()
  const counts = ix.counts(Array(31).fill(target), visible)
  const countsMs = performance.now() - startCounts
  t.is(counts[target].replies, 200000)
  t.is(calls, 1, '31 duplicate refs check the target once; no engager checks')
  t.ok(countsMs < 50, 'counts under 50 ms: ' + countsMs.toFixed(3))
  t.comment('200k replies: page ' + pageMs.toFixed(3) + ' ms / ' + pageCalls + ' visibility calls; counts ' + countsMs.toFixed(3) + ' ms / ' + calls + ' call')
  calls = 0
  const hidden = ix.post(target, null, (author) => { calls++; return author === owner })
  t.alike(hidden.replies, [])
  t.alike(hidden.quotes, [])
  t.is(calls, 201, 'at most 200 candidate edges even when all are hidden')
  t.alike(Object.keys(hidden.authors), [owner], 'hidden page authors have no hints')
  t.is(ix.post(target, null, () => { throw new Error('hostile predicate') }), null)
  t.alike(ix.counts([target], () => { throw new Error('hostile predicate') }), {})
})

test('bounded pages fill visibility holes and binary cursors preserve timestamp/author/seq ties', (t) => {
  const ix = createEngagementIndex()
  const owner = authorKey(0)
  const to = { author: owner, seq: 1 }
  const target = ref(owner, 1)
  ix.add(owner, 1, { type: 'post', replyTo: null, at: at(0) })
  // Insert authors backwards to exercise sorted insertion and tie-breaking.
  for (let a = 3; a >= 1; a--) {
    for (let seq = 1; seq <= 80; seq++) ix.add(authorKey(a), seq, { type: 'post', replyTo: to, at: at(1) })
    for (let seq = 81; seq <= 160; seq++) ix.add(authorKey(a), seq, { type: 'post', replyTo: null, quote: to, at: at(1) })
  }
  let calls = 0
  const visible = (author) => { calls++; return author !== authorKey(1) && author !== authorKey(3) }
  const page = ix.post(target, null, visible)
  t.alike(page.replies, Array.from({ length: 50 }, (_, i) => ref(authorKey(2), i + 1)), 'fills replies after skipping 80 hidden edges')
  t.is(page.next, (BASE_MS + 1000) + '.' + authorKey(2) + '.50')
  t.ok(calls <= 201, 'both pages share the 200-edge scan budget')
  t.alike(page.quotes, [], 'quote visibility cannot extend the shared scan budget')
  t.alike(Object.keys(page.authors).sort(), [owner, authorKey(2)])
  const cursor = (BASE_MS + 1000) + '.' + authorKey(2) + '.60'
  const next = ix.post(target, cursor)
  t.alike(next.replies, [
    ...Array.from({ length: 20 }, (_, i) => ref(authorKey(2), i + 61)),
    ...Array.from({ length: 30 }, (_, i) => ref(authorKey(3), i + 1))
  ], 'binary search crosses author ties without gaps or duplicates')
  t.alike(next.quotes, Array.from({ length: 50 }, (_, i) => ref(authorKey(3), 160 - i)))
  t.is(ix.post(target, (BASE_MS + 1000) + '.' + authorKey(3) + '.80').next, null)
})

// Pure: with 200k records over many targets, a counts call for 31 refs
// (duplicates included) reads only counters, and each ref is computed once.
test('engagement index: counts are proportional to the targets asked, duplicates collapse', (t) => {
  const ix = createEngagementIndex()
  const author = (i) => i.toString(16).padStart(64, '0')
  const AT = '2026-03-01T12:00:00.000Z'
  // 1000 authors x 200 records: each author posts (seq 1), then likes and
  // replies to the posts of 100 other authors (seqs 2..200).
  for (let a = 0; a < 1000; a++) {
    t.ok(ix.add(author(a), 1, { type: 'post', text: 'p', at: AT, replyTo: null }) === true)
    for (let k = 0; k < 100; k++) {
      const target = { author: author((a + 1 + k) % 1000), seq: 1 }
      ix.add(author(a), 2 + 2 * k, { type: 'like', to: target, on: true, at: AT })
      ix.add(author(a), 3 + 2 * k, { type: 'post', text: 'r', at: AT, replyTo: target })
    }
  }
  t.is(ix.stats().records, 201000, '1000 posts + 200000 likes and replies')
  let calls = 0
  const visible = () => { calls++; return true }
  const refs = []
  for (let i = 0; i < 31; i++) refs.push(author(i % 7) + ':1') // 7 distinct refs, 31 entries
  const out = ix.counts(refs, visible)
  t.alike(Object.keys(out).length, 7, 'duplicates collapse to the distinct refs')
  for (const ref of Object.keys(out)) t.alike(out[ref], { replies: 100, likes: 100, reposts: 0, quotes: 0 })
  t.is(calls, 7, 'one author check per distinct ref, no edge walks')
  const single = (() => { calls = 0; ix.counts([author(0) + ':1'], visible); return calls })()
  t.is(single, 1, 'one ref costs one author check')
  const unknown = (() => { calls = 0; ix.counts([author(0) + ':5', author(0) + ':5'], visible); return calls })()
  t.is(unknown, 1, 'an unknown ref costs one author check, once')
  calls = 0
  const page = ix.post(author(0) + ':1', null, visible)
  t.is(page.repliesTotal, 100)
  t.is(calls, 51, 'a thread page checks only its 50 replies and target')
})

test('thread: replies paged in order, likes, reposts and quotes counted, hints given; an undo and a blocklist remove them', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // A: profile (1), post (2). B: profile (1), REPLIES replies to A:2 (2..),
  // then like, repost and a quote of A:2.
  const A = await member(t, bootstrap, assoc, {
    records: () => [profileRecord({ name: 'A', at: at(0) }), postRecord({ text: 'oi', at: at(0) })]
  })
  const B = await member(t, bootstrap, assoc, {
    records: () => {
      const out = [profileRecord({ name: 'B', at: at(0) })]
      for (let i = 0; i < REPLIES; i++) out.push(postRecord({ text: 'r' + i, at: at(i + 1), replyTo: { author: A.key, seq: 2 } }))
      out.push(likeRecord({ to: { author: A.key, seq: 2 }, on: true, at: at(100) }))
      out.push(repostRecord({ to: { author: A.key, seq: 2 }, on: true, at: at(101) }))
      out.push(postRecord({ text: 'olha', at: at(102), quote: { author: A.key, seq: 2 } }))
      return out
    }
  })
  const REPOST = REPLIES + 3
  const QUOTE = REPLIES + 4
  t.is(B.diary.length, QUOTE + 1)

  // Nothing is known before anything is served.
  t.is(seeder.indexPost(A.key, 2), null, 'unknown author -> null')
  t.alike(seeder.indexCounts([ref(A.key, 2)]), { counts: {}, indexing: false, complete: true })

  await admit(A, assoc)
  await admit(B, assoc)
  await indexedTo(seeder, A)
  await indexedTo(seeder, B)
  t.is(seeder.stats().indexRecords, 2 + QUOTE, 'every post, like, repost and profile counted once')
  t.is(seeder.stats().indexSaturated, false)

  const page1 = seeder.indexPost(A.key, 2)
  t.is(page1.ref, ref(A.key, 2))
  t.is(page1.parent, null)
  t.alike(Object.keys(page1), ['ref', 'parent', 'replies', 'next', 'quotes', 'likes', 'reposts', 'repliesTotal', 'quotesTotal', 'authors', 'indexing', 'complete'], 'exact shape')
  t.alike(page1.replies, Array.from({ length: 50 }, (_, i) => ref(B.key, i + 2)), 'first 50 replies in (at, author, seq) order')
  t.is(page1.next, (BASE_MS + 50 * 1000) + '.' + B.key + '.51', 'cursor = the last reply of the page')
  t.alike(page1.quotes, [ref(B.key, QUOTE)])
  t.is(page1.likes, 1)
  t.is(page1.reposts, 1)
  t.is(page1.repliesTotal, REPLIES)
  t.is(page1.quotesTotal, 1)
  t.alike(page1.authors, { [A.key]: { profileSeq: 1, usernameSeq: null }, [B.key]: { profileSeq: 1, usernameSeq: null } }, 'hints for the target and every listed author')
  t.is(page1.indexing, false)
  t.is(page1.complete, true)

  const page2 = seeder.indexPost(A.key, 2, page1.next)
  t.alike(page2.replies, Array.from({ length: REPLIES - 50 }, (_, i) => ref(B.key, i + 52)), 'the rest, strictly after the cursor')
  t.is(page2.next, null, 'exhausted')
  t.alike(page2.quotes, page1.quotes, 'quotes are always the first page')
  const seen = new Set([...page1.replies, ...page2.replies])
  t.is(seen.size, REPLIES, 'every reply exactly once across the pages')
  const lastCursor = (BASE_MS + REPLIES * 1000) + '.' + B.key + '.' + (REPLIES + 1)
  t.alike(seeder.indexPost(A.key, 2, lastCursor).replies, [], 'a cursor at the last reply -> empty page')

  const reply = seeder.indexPost(B.key, 2)
  t.is(reply.parent, ref(A.key, 2), 'a reply names its parent')
  t.alike(reply.replies, [])
  t.alike(Object.keys(reply.authors).sort(), [A.key, B.key].sort(), 'hints cover the parent')
  const quote = seeder.indexPost(B.key, QUOTE)
  t.is(quote.parent, null, 'a quote is not a reply')

  const counts = seeder.indexCounts([ref(A.key, 2), ref(B.key, 2), ref(B.key, QUOTE), ref('e'.repeat(64), 1), ref(B.key, 999), ref(A.key, 1)])
  t.alike(counts, {
    counts: {
      [ref(A.key, 2)]: { replies: REPLIES, likes: 1, reposts: 1, quotes: 1 },
      [ref(B.key, 2)]: { replies: 0, likes: 0, reposts: 0, quotes: 0 },
      [ref(B.key, QUOTE)]: { replies: 0, likes: 0, reposts: 0, quotes: 0 }
    },
    indexing: false,
    complete: true
  }, 'unknown refs, an unknown author and a non-post block are omitted')

  const memberB = seeder.indexMember(B.key)
  t.alike(Object.keys(memberB), ['length', 'profileSeq', 'usernameSeq', 'posts', 'postsTotal', 'indexing', 'complete'], 'exact shape')
  t.is(memberB.length, B.diary.length)
  t.is(memberB.profileSeq, 1)
  t.is(memberB.usernameSeq, null)
  t.is(memberB.postsTotal, REPLIES + 2, 'replies, the quote and the repost')
  t.alike(memberB.posts.slice(0, 2), [QUOTE, REPOST], 'descending, the repost among the posts')
  t.alike(memberB.posts, [QUOTE, REPOST, ...Array.from({ length: REPLIES }, (_, i) => REPLIES + 1 - i)])
  t.alike(seeder.indexMember(B.key, 10).posts, [9, 8, 7, 6, 5, 4, 3, 2], 'before is exclusive')
  t.alike(seeder.indexMember(B.key, 2).posts, [])
  t.is(seeder.indexMember(A.key).postsTotal, 1)

  // Refusals of the read API.
  t.is(seeder.indexPost(A.key, 1), null, 'a profile block is not a post')
  t.is(seeder.indexPost(A.key, 0), null)
  t.is(seeder.indexPost(A.key, 2, 'bad'), null, 'malformed cursor')
  t.is(seeder.indexPost(A.key.toUpperCase(), 2), null)
  t.is(seeder.indexPost('e'.repeat(64), 1), null, 'unknown author')
  t.is(seeder.indexMember('e'.repeat(64)), null)
  t.is(seeder.indexMember(A.key, 0), null)
  t.is(seeder.indexCounts('x'), null)

  // Undo: like off and repost off.
  await append(B, [likeRecord({ to: { author: A.key, seq: 2 }, on: false, at: at(200) }), repostRecord({ to: { author: A.key, seq: 2 }, on: false, at: at(201) })])
  await indexedTo(seeder, B)
  const undone = seeder.indexPost(A.key, 2)
  t.is(undone.likes, 0)
  t.is(undone.reposts, 0)
  t.is(undone.repliesTotal, REPLIES, 'replies untouched')
  t.is(seeder.indexMember(B.key).postsTotal, REPLIES + 1, 'the repost left the timeline')
  t.absent(seeder.indexMember(B.key).posts.includes(REPOST))
  t.is(seeder.indexCounts([ref(A.key, 2)]).counts[ref(A.key, 2)].likes, 0)
  const recordsBefore = seeder.stats().indexRecords
  t.is(recordsBefore, 2 + QUOTE + 2)

  // B blocked by an adopted blocklist: dropped, purged, gone from the index.
  const modKp = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp)
  const snapshot = createSnapshot({ seq: 1, blocked: [B.key], revokedIssuers: [] }, modKp, modCert)
  await member(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot } })
  await until(() => events.some((e) => e.event === 'rejected' && e.key === B.key && e.reason === 'blocked'), { name: 'B bloqueado', timeoutMs: 30000 })
  await until(() => seeder.stats().dropping === 0 && seeder._drops.size === 0, { name: 'B purgado', timeoutMs: 30000 })
  const after = seeder.indexPost(A.key, 2)
  t.alike(after.replies, [], "B's replies are gone")
  t.is(after.next, null)
  t.alike(after.quotes, [])
  t.is(after.likes, 0)
  t.is(after.reposts, 0)
  t.is(after.repliesTotal, 0)
  t.is(after.quotesTotal, 0)
  t.alike(after.authors, { [A.key]: { profileSeq: 1, usernameSeq: null } }, 'no hint for B')
  t.is(after.complete, true)
  t.is(seeder.indexMember(B.key), null, 'a blocked author is unknown')
  t.is(seeder.indexPost(B.key, 2), null)
  t.alike(seeder.indexCounts([ref(A.key, 2), ref(B.key, 2)]).counts, { [ref(A.key, 2)]: { replies: 0, likes: 0, reposts: 0, quotes: 0 } })
  t.is(seeder.stats().indexRecords, 2, "only A's records remain")
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('cap: the cursor pauses at the refused record (complete: false) and resumes without skipping once a dropped diary frees room', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, indexMaxRecords: 5 })

  // C: three posts (records 1..3 of the cap of 5).
  const C = await member(t, bootstrap, assoc, { records: () => [postRecord({ text: 'c1', at: at(0) }), postRecord({ text: 'c2', at: at(0) }), postRecord({ text: 'c3', at: at(0) })] })
  await admit(C, assoc)
  await indexedTo(seeder, C)
  t.is(seeder.stats().indexRecords, 3)

  // B: post (1), a reply to B:1 (2), another post (3): 3 would be the 6th record.
  const B = await member(t, bootstrap, assoc, {
    records: (key) => [
      postRecord({ text: 'b1', at: at(1) }),
      postRecord({ text: 'b2', at: at(2), replyTo: { author: key, seq: 1 } }),
      postRecord({ text: 'b3', at: at(3) })
    ]
  })
  await admit(B, assoc)
  await until(() => seeder._served.get(B.key).indexPaused, { name: 'cursor pausado' })
  const entry = seeder._served.get(B.key)
  t.is(entry.indexed, 3, 'the cursor stays AT the refused block')
  t.is(seeder.stats().indexRecords, 5)
  t.is(seeder.stats().indexSaturated, true)
  const partial = seeder.indexPost(B.key, 1)
  t.alike(partial.replies, [ref(B.key, 2)], 'what was indexed before the cap is served')
  t.is(partial.complete, false, 'complete is false while a cursor is paused')
  t.is(partial.indexing, false, 'the startup pass is over (nothing was served at start)')
  t.is(seeder.indexPost(B.key, 3), null, 'the refused post is not indexed yet')
  t.is(seeder.indexMember(B.key).complete, false)
  t.alike(seeder.indexMember(B.key).posts, [2, 1])
  t.is(seeder.indexCounts([ref(B.key, 1)]).complete, false)

  // Growth while paused does not move the cursor.
  await append(B, [postRecord({ text: 'b4', at: at(4) })])
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(entry.indexed, 3, 'still paused')
  t.ok(entry.indexPaused)

  // C forks: dropped, removed from the index (3 records freed), B resumes
  // and indexes the refused post and the one appended while paused.
  await C.diary.truncate(1)
  await C.diary.append(postRecord({ text: 'outro', at: at(9) }))
  await until(() => events.some((e) => e.event === 'rejected' && e.key === C.key && e.reason === 'fork'), { name: 'C descartado', timeoutMs: 30000 })
  await indexedTo(seeder, B)
  t.is(entry.indexPaused, false)
  t.is(seeder.stats().indexRecords, 4, "B's four posts; C gone")
  t.is(seeder.stats().indexSaturated, false)
  const full = seeder.indexPost(B.key, 1)
  t.is(full.complete, true, 'nothing pending any more')
  t.alike(full.replies, [ref(B.key, 2)])
  t.alike(seeder.indexMember(B.key).posts, [4, 3, 2, 1], 'nothing skipped: the refused post and the one appended while paused')
  t.is(seeder.indexPost(B.key, 3).complete, true)
  t.is(seeder.indexPost(C.key, 1), null, 'a dropped author is unknown')
  t.alike(seeder.indexCounts([ref(C.key, 1)]).counts, {})
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('restart rebuilds the index from the stored diaries; indexing is true at ready; health metrics carry counts only', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, { records: () => [postRecord({ text: 'a1', at: at(0) }), postRecord({ text: 'a2', at: at(1) })] })
  await admit(A, assoc)
  const B = await member(t, bootstrap, assoc, {
    records: () => [
      postRecord({ text: 'r', at: at(2), replyTo: { author: A.key, seq: 1 } }),
      likeRecord({ to: { author: A.key, seq: 1 }, on: true, at: at(3) }),
      likeRecord({ to: { author: A.key, seq: 2 }, on: true, at: at(4) })
    ]
  })
  await admit(B, assoc)
  await indexedTo(first.seeder, A)
  await indexedTo(first.seeder, B)
  t.is(first.seeder.stats().indexRecords, 5)
  t.is(first.seeder.indexPost(A.key, 1).likes, 1)

  // stats() and the health metrics: counts only, never a key.
  const stats = first.seeder.stats()
  t.is(typeof stats.indexRecords, 'number')
  t.is(typeof stats.indexSaturated, 'boolean')
  t.is(typeof stats.topicPosts, 'number')
  t.is(typeof stats.topicSaturated, 'boolean')
  const text = metricsText({ ...stats, uptimeSeconds: 1 })
  t.ok(text.includes('varanda_seeder_topic_posts'), 'topic posts gauge')
  t.ok(text.includes('varanda_seeder_topic_saturated'), 'topic saturated gauge')
  t.ok(text.includes('# TYPE varanda_seeder_index_records gauge\nvaranda_seeder_index_records 5\n'), 'index records gauge')
  t.ok(text.includes('# TYPE varanda_seeder_index_saturated gauge\nvaranda_seeder_index_saturated 0\n'), 'index saturated gauge')
  t.absent(HEX64_ANYWHERE.test(text), 'no key in the metrics')
  t.absent(HEX64_ANYWHERE.test(JSON.stringify(stats)), 'no key in stats()')

  await first.seeder.close()
  t.is(first.seeder.indexPost(A.key, 1), null, 'nothing is served after close')

  let atReady = null
  const second = newSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    onlog: (e) => {
      if (e.event !== 'ready') return
      const s = second.seeder
      atReady = {
        indexing: s.indexCounts([ref(A.key, 1)]).indexing,
        complete: s.indexCounts([ref(A.key, 1)]).complete,
        records: s.stats().indexRecords,
        cursors: [s._served.get(A.key).indexed, s._served.get(B.key).indexed]
      }
    }
  })
  await second.seeder.start()
  t.alike(atReady, { indexing: true, complete: false, records: 0, cursors: [1, 1] }, 'at ready: empty index, indexing true, cursors at 1')
  await until(() => second.seeder.indexCounts([ref(A.key, 1)]).indexing === false, { name: 'primeira passada' })
  await indexedTo(second.seeder, A)
  await indexedTo(second.seeder, B)
  const rebuilt = second.seeder.indexPost(A.key, 1)
  t.alike(rebuilt.replies, [ref(B.key, 1)])
  t.is(rebuilt.likes, 1)
  t.is(rebuilt.indexing, false)
  t.is(rebuilt.complete, true)
  t.is(second.seeder.indexPost(A.key, 2).likes, 1)
  t.alike(second.seeder.indexMember(A.key).posts, [2, 1])
  t.is(second.seeder.stats().indexRecords, 5, 'rebuilt from the stored blocks')
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
  await second.seeder.close()

  // A restart whose startup pass hits the cap: the startup set exists before
  // any entry is served (growth during start can queue a pass), and a diary
  // paused at the cap counts as covered, so `indexing` still turns false
  // while `complete` stays false.
  const third = newSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, indexMaxRecords: 3 })
  const serve = third.seeder._serve.bind(third.seeder)
  let startupSetAtServe = true
  third.seeder._serve = (key, core, opts) => {
    if (third.seeder._indexStartup === null) startupSetAtServe = false
    return serve(key, core, opts)
  }
  await third.seeder.start()
  t.ok(startupSetAtServe, 'the startup set exists before the first entry is served')
  await until(() => third.seeder.indexCounts([ref(A.key, 1)]).indexing === false, { name: 'primeira passada com limite' })
  t.is(third.seeder.stats().indexSaturated, true)
  t.is(third.seeder.stats().indexRecords, 3)
  t.ok([...third.seeder._served.values()].some((e) => e.indexPaused), 'one diary is paused at the cap')
  t.is(third.seeder.indexCounts([ref(A.key, 1)]).complete, false, 'complete stays false while paused')
  t.is(third.events.filter((e) => e.event === 'fatal').length, 0)
})

// ---- Name index (account search: packages/core/lib/name-index.js) -------

// scanFixture plus a trusted association, one issuer and helpers to serve a
// diary of records and to search.
function nameFixture (options = {}) {
  const f = scanFixture(options)
  const assoc = makeAssociation()
  f.seeder.association = assoc.hex
  const issuerKp = signingKeyPair()
  const issuer = hex(issuerKp.publicKey)
  const issuerCert = createIssuerCert({ issuer, date: at(0) }, assoc.kp)
  const username = (member, name, date = at(0)) => createUsernameRecord({ member, username: name, date }, issuerKp, issuerCert)
  const profile = (name, i = 1) => profileRecord({ name, at: at(i) })
  // Serves `records` at seqs 1..n (push more, then grow() for a later pass).
  const serve = (key, records) => {
    const entry = f.diary(key, records.length, (seq) => records[seq - 1])
    entry.grow = () => {
      entry.core.contiguousLength = records.length + 1
      f.seeder._indexDiary(key, entry)
    }
    f.seeder._indexDiary(key, entry)
    return entry
  }
  const authors = (segment) => {
    const r = f.seeder.indexSearch(segment)
    return r === null ? null : r.members.map((m) => m.author)
  }
  return { ...f, assoc, issuer, username, profile, serve, authors }
}

function badSignature (record) {
  const c = record.signature[0] === '0' ? '1' : '0'
  return { ...record, signature: c + record.signature.slice(1) }
}

test('name search: folded tokens, prefixes, invisible characters', async (t) => {
  const { seeder, serve, profile, authors } = nameFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  serve(A, [profile('João Silva')])
  serve(B, [profile('Ma​ria')])
  await settleIndex(seeder)
  t.alike(authors('joao'), [A])
  t.alike(authors('silva'), [A])
  t.alike(authors('joao-silva'), [A])
  t.alike(authors('sil'), [A], 'a prefix of a token matches')
  t.alike(authors('ilva'), [], 'an infix does not')
  t.alike(authors('maria'), [B], 'a zero-width space does not split the token')
  t.alike(seeder.indexSearch('joao').members, [{ author: A, profileSeq: 1, usernameSeq: null }])
})

test('name search: a newer profile replaces the name, an older or equal seq does not', async (t) => {
  const { seeder, serve, profile, authors } = nameFixture()
  const A = authorKey(1)
  const records = [profile('Ana'), profile('Beatriz', 2)]
  const entry = serve(A, records)
  await settleIndex(seeder)
  t.alike(authors('ana'), [])
  t.alike(authors('beatriz'), [A])
  t.is(seeder.indexSearch('beatriz').members[0].profileSeq, 2)
  // An older or equal seq noted again (a rebuild replays from seq 1) keeps
  // the newest name.
  seeder._names.note(A, 1, profile('Carla'))
  seeder._names.note(A, 2, profile('Carla'))
  t.alike(authors('carla'), [])
  t.alike(authors('beatriz'), [A])
  records.push(profile('Davi', 3))
  entry.grow()
  await settleIndex(seeder)
  t.alike(authors('beatriz'), [])
  t.alike(authors('davi'), [A])
})

test('name search: exact verified @nome first, then @nome prefix, then name only', async (t) => {
  const { seeder, serve, profile, username, authors } = nameFixture()
  const exact = authorKey(9)
  const prefix = authorKey(5)
  const nameOnly = authorKey(1)
  serve(nameOnly, [profile('Joao Pedro')])
  serve(prefix, [profile('Zé'), username(prefix, 'joaozinho')])
  serve(exact, [profile('Outro'), username(exact, 'joao')])
  await settleIndex(seeder)
  t.alike(authors('joao'), [exact, prefix, nameOnly])
  const m = seeder.indexSearch('joao').members
  t.alike(m[0], { author: exact, profileSeq: 1, usernameSeq: 2 })
  t.alike(m[2], { author: nameOnly, profileSeq: 1, usernameSeq: null })
})

test('name search: a bad signature or a wrong member never matches by @nome; a newer bad record clears the @nome', async (t) => {
  const { seeder, serve, profile, username, authors } = nameFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  const C = authorKey(3)
  serve(A, [profile('Alice'), badSignature(username(A, 'alicinha'))])
  serve(B, [profile('Bruno'), username(C, 'brunao')]) // copied: member is C
  const cRecords = [profile('Carla'), username(C, 'carlota')]
  const c = serve(C, cRecords)
  await settleIndex(seeder)
  t.alike(authors('alicinha'), [], 'bad signature')
  t.alike(authors('alice'), [A], 'the name still matches')
  t.is(seeder.indexSearch('alice').members[0].usernameSeq, null)
  t.alike(authors('brunao'), [], 'wrong member')
  t.alike(authors('bruno'), [B])
  t.alike(authors('carlota'), [C])
  cRecords.push(badSignature(username(C, 'carlota', at(5))))
  c.grow()
  await settleIndex(seeder)
  t.alike(authors('carlota'), [], 'no fallback to the earlier @nome')
  t.alike(seeder.indexSearch('carla').members, [{ author: C, profileSeq: 1, usernameSeq: null }])
})

test('name search: 1000 username records in one diary cost one verification per pass', async (t) => {
  const { seeder, serve, profile, username, authors } = nameFixture()
  const A = authorKey(1)
  const records = [profile('Ana')]
  for (let i = 0; i < 1000; i++) records.push(username(A, 'ana_' + i, at(i)))
  const verify = mock.method(certModule, 'verifyUsernameRecord')
  t.teardown(() => verify.mock.restore())
  serve(A, records)
  await settleIndex(seeder)
  t.is(verify.mock.callCount(), 1)
  t.alike(authors('ana-999'), [A], 'the newest record is the one verified')
  t.is(seeder.indexSearch('ana-999').members[0].usernameSeq, 1001)
})

test('name search: a revoked @nome issuer stops matching at the next query without a rescan', async (t) => {
  const { seeder, serve, profile, username, issuer, authors } = nameFixture()
  const A = authorKey(1)
  serve(A, [profile('Ana'), username(A, 'anasz')])
  await settleIndex(seeder)
  t.alike(authors('anasz'), [A])
  seeder._blocklist = { revokedIssuers: () => new Set([issuer]), blocked: () => new Set() }
  t.alike(authors('anasz'), [], 'revoked issuer')
  t.alike(seeder.indexSearch('ana').members, [{ author: A, profileSeq: 1, usernameSeq: null }], 'the name still matches')
  seeder._blocklist = { revokedIssuers: () => new Set(), blocked: () => new Set() }
  t.alike(authors('anasz'), [A], 'un-revoked again, still verified')
})

test('name search: a pending revocation re-gate, blocked and dropped authors are hidden at once', async (t) => {
  const { seeder, diary, serve, profile, authors } = nameFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  const C = authorKey(3)
  const X = 'ab'.repeat(32)
  serve(A, [profile('Joao A')])
  serve(B, [profile('Joao B')])
  serve(C, [profile('Joao C')])
  await settleIndex(seeder)
  // The announcement's certificate is not the gate's (block 0's): a revoked
  // issuer there alone never hides the diary.
  seeder._admitted.set(A, { v: 2, member: A, issuer: X })
  seeder._blocklist = { revokedIssuers: () => new Set([X]), blocked: () => new Set() }
  t.alike(authors('joao'), [A, B, C], 'announcement certificate ignored')
  // _onBlocklistAdopted holds every re-gated diary until block 0's verdict.
  seeder._served.get(A).searchHold = 1
  t.alike(authors('joao'), [B, C], 'held while the re-gate is pending')
  t.is(seeder.indexSearch('joao').complete, false, 'a held match makes the answer incomplete')
  t.is(seeder.indexSearch('zzz').complete, seeder._indexFlags().complete, 'a query the held author does not match is unaffected')
  seeder._served.get(A).searchHold = 0
  t.alike(authors('joao'), [A, B, C], 'released when the verdict clears it')
  t.is(seeder.indexSearch('joao').complete, seeder._indexFlags().complete)
  seeder._blocklist = null
  seeder._isBlocked = (k) => k === B
  t.alike(authors('joao'), [A, C], 'blocked')
  seeder._isBlocked = () => false
  seeder._drop(C, 'blocked')
  t.alike(authors('joao'), [A, B], 'dropped synchronously')
  t.is(seeder._names.stats().authors, 2)
  await seeder._drops.get(C)
  await settleIndex(seeder)
  diary(C, 1, () => profile('Joao C'))
  seeder._rebuildIndex()
  await settleIndex(seeder)
  t.alike(authors('joao'), [A, B, C], 'a rebuild and rescan restore it')
})

test('name search: the name cap pauses the cursor, never skips, and freed room resumes it', async (t) => {
  {
    const { seeder, serve, profile, authors } = nameFixture({ maxServed: 0 })
    const A = authorKey(1)
    const a = serve(A, [profile('Ana')])
    await settleIndex(seeder)
    t.ok(a.indexPaused)
    t.is(a.indexed, 1, 'the cursor stays at the refused seq')
    t.is(seeder.indexMember(A).profileSeq, null, 'the record did not reach the engagement index')
    t.alike(authors('ana'), [])
    t.is(seeder.indexSearch('ana').complete, false)
  }
  const { seeder, serve, profile, authors } = nameFixture({ maxServed: 1 })
  const A = authorKey(1)
  const B = authorKey(2)
  serve(A, [profile('Ana')])
  const b = serve(B, [profile('Bia'), postRecord({ text: 'oi', at: at(2) })])
  await settleIndex(seeder)
  t.ok(b.indexPaused)
  t.is(b.indexed, 1)
  t.is(seeder.indexMember(B).profileSeq, null)
  seeder._drop(A, 'blocked')
  await settleIndex(seeder)
  t.absent(b.indexPaused)
  t.is(b.indexed, 3)
  t.alike(authors('bia'), [B])
  t.is(seeder.indexMember(B).profileSeq, 1)
  t.alike(seeder._indexFlags(), { indexing: false, complete: true })
})

test('name search: honest flags, malformed segments, the result cap and no logging', async (t) => {
  const { seeder, diary, profile } = nameFixture()
  const lines = []
  seeder.log = (e) => lines.push(e)
  const entries = []
  for (let i = 1; i <= 21; i++) entries.push([authorKey(i), diary(authorKey(i), 1, () => profile('Joao ' + i))])
  const held = holdIndexRead(entries[0][1], 1)
  for (const [key, entry] of entries) seeder._indexDiary(key, entry)
  await held.reading
  const early = seeder.indexSearch('joao')
  t.is(early.indexing, true, 'indexing before the first pass ends')
  t.is(early.complete, false)
  t.alike(early.members, [])
  held.release()
  await settleIndex(seeder)
  const r = seeder.indexSearch('joao')
  t.alike(Object.keys(r), ['members', 'more', 'indexing', 'complete'])
  t.is(r.members.length, 20)
  t.alike(r.members.map((m) => m.author), entries.slice(0, 20).map(([key]) => key), 'the 20 lowest authors')
  t.is(r.more, true)
  t.ok(r.members.every((m) => m.profileSeq !== null || m.usernameSeq !== null), 'no member has both hints null')
  t.alike({ indexing: r.indexing, complete: r.complete }, seeder._indexFlags())
  t.alike(seeder.indexSearch('zz'), { members: [], more: false, ...seeder._indexFlags() }, 'an empty result carries the real flags')
  for (const bad of ['A', 'a', 'ab_cd', 'x'.repeat(21), '', 'a--b', 'a-b-c-d-e', null, 42]) t.is(seeder.indexSearch(bad), null)
  t.alike(lines, [], 'indexSearch never logs')
})

test('name search: GET /index/search over loopback answers members/more/indexing/complete, a bad segment the generic 404', async (t) => {
  const { seeder, serve, profile } = nameFixture()
  const A = authorKey(1)
  serve(A, [profile('João')])
  await settleIndex(seeder)
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close())
  const get = (url) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ws.port, method: 'GET', path: url, headers: { Host: '127.0.0.1:' + ws.port } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
  const ok = await get('/index/search/joao')
  t.is(ok.status, 200)
  t.alike(JSON.parse(ok.body), { members: [{ author: A, profileSeq: 1, usernameSeq: null }], more: false, indexing: false, complete: true })
  const bad = await get('/index/search/JOAO')
  t.is(bad.status, 404)
  t.is(bad.body, 'não encontrado\n')
  t.absent(bad.body.includes('JOAO'))
})
