// The seeder's topic search index (packages/core/lib/topic-index.js and the
// search scan of packages/core/lib/seeder.js, issue #81): built in memory
// from the served diaries' own post blocks on a cursor and queue of its own
// (never the engagement index's), read through indexTopic with blocked and
// dropped authors filtered out, removed synchronously in _drop before the
// purge, bounded by caps where the search cursor pauses (never skips) and
// resumes when a drop frees room, independently of the engagement cursor.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, likeRecord } = require('@varanda/core/lib/records')
const { startHealth } = require('../lib/health')
const { createEngagementIndex } = require('@varanda/core/lib/engagement-index')
const { createTopicIndex } = require('@varanda/core/lib/topic-index')
const { createNoticeIndex } = require('@varanda/core/lib/notices')

const HEX64_ANYWHERE = /[0-9a-f]{64}/

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// Deterministic canonical timestamps, one second apart.
const BASE_MS = Date.parse('2026-03-01T12:00:00.000Z')
function at (i) {
  return new Date(BASE_MS + i * 1000).toISOString()
}

function ref (key, seq) {
  return key + ':' + seq
}

const authorKey = (i) => i.toString(16).padStart(64, '0')
const NO_HINTS = { profileSeq: null, usernameSeq: null }
const MEDIA = { core: 'c'.repeat(64), mime: 'image/jpeg', start: 1, blocks: 2, bytes: 32769, sha256: 'd'.repeat(64), width: 640, height: 480 }

// ---- Scan fixture (copied from seeder-index.test.js, not exported) -------

// The real scans, queues, visibility, flags, _onGrow and _drop over
// generated blocks, without network replication. `index` options go to the
// engagement index, `search` options to the search index.
function scanFixture ({ index = {}, search = {} } = {}) {
  const seeder = Object.create(Seeder.prototype)
  Object.assign(seeder, {
    _index: createEngagementIndex({ ...index, onFreed: () => seeder._scheduleIndexResume() }),
    _notices: createNoticeIndex(),
    _indexQueue: Promise.resolve(),
    _indexStartup: new Set(),
    _indexDropped: new Set(),
    _indexRebuildQueued: false,
    _indexResumeQueued: false,
    _topics: createTopicIndex({ ...search, onFreed: () => seeder._scheduleTopicResume() }),
    _topicQueue: Promise.resolve(),
    _topicStartup: new Set(),
    _topicResumeQueued: false,
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
    maxServed: 4096
  })
  // The name index (account search) is fed by the same engagement scan.
  seeder._names = seeder._createNameIndex()
  function diary (key, records) {
    const entry = {
      indexed: 1,
      indexPaused: false,
      indexQueued: false,
      indexRetry: null,
      indexReadFailures: 0,
      topicIndexed: 1,
      topicQueued: false,
      topicPaused: false,
      topicRetry: null,
      topicReadFailures: 0,
      stopFork: () => {},
      stopGrow: () => {},
      stopQuota: () => {},
      gated: true,
      dropped: false,
      core: { contiguousLength: records.length + 1, get: async (seq) => Buffer.from(JSON.stringify(records[seq - 1])) }
    }
    seeder._served.set(key, entry)
    seeder._admitted.set(key, true)
    seeder._indexStartup.add(key)
    seeder._topicStartup.add(key)
    return entry
  }
  // Serves a diary and runs the real growth path (both scans).
  function serve (key, records) {
    const entry = diary(key, records)
    seeder._onGrow(key, entry, entry.core.contiguousLength)
    return entry
  }
  return { seeder, diary, serve }
}

// Both scan queues and any resume scheduled on setImmediate.
async function settle (seeder) {
  let a
  let b
  do {
    a = seeder._indexQueue
    b = seeder._topicQueue
    await a
    await b
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  } while (a !== seeder._indexQueue || b !== seeder._topicQueue)
}

const post = (text, i, extra = {}) => postRecord({ text, at: at(i), ...extra })

// ---- Fixture cases --------------------------------------------------------

test('word query: deep history, whole-token match, AND, hints, flags, no follow filtering', async (t) => {
  const { seeder, serve } = scanFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  serve(A, [
    post('Céu azul hoje', 1),
    post('Céus nublados', 2),
    post('o mar azul', 3),
    likeRecord({ to: { author: A, seq: 1 }, on: true, at: at(4) }),
    post('boa tarde', 5),
    postRecord({ text: '', at: at(6), media: [MEDIA] }),
    post('boa noite', 7),
    post('até amanhã', 8)
  ])
  await settle(seeder)
  t.is(seeder._served.get(A).topicIndexed, 9, 'the search cursor reached the end')
  t.is(seeder._topics.stats().posts, 6, 'the like and the media-only post are not indexed')

  const ceu = seeder.indexTopic('ceu')
  t.alike(ceu, { items: [ref(A, 1)], next: null, authors: { [A]: NO_HINTS }, indexing: false, complete: true }, 'the oldest post, beyond the three newest, with hint and flags')
  t.alike(seeder.indexTopic('ceus').items, [ref(A, 2)], "'Céus' is its own token")
  t.alike(seeder.indexTopic('azul').items, [ref(A, 3), ref(A, 1)], 'newest first')
  t.alike(seeder.indexTopic('ceu+azul').items, [ref(A, 1)], 'AND')
  t.alike(seeder.indexTopic('azul+ceu+azul').items, [ref(A, 1)], 'repeated tokens are folded')

  // A second diary nobody follows: no follow filtering exists here.
  serve(B, [post('Olha o #Céu!', 10)])
  await settle(seeder)
  const both = seeder.indexTopic('ceu')
  t.alike(both.items, [ref(B, 1), ref(A, 1)], "'#Céu' matches too")
  t.alike(Object.keys(both.authors).sort(), [A, B].sort(), 'one hint per listed author')
  t.alike(seeder.indexTopic('ceu+azul').items, [ref(A, 1)])
})

test('malformed queries and cursors -> null; an unknown word -> an empty page', async (t) => {
  const { seeder, serve } = scanFixture()
  const A = authorKey(1)
  serve(A, [post('céu', 1)])
  await settle(seeder)
  t.is(seeder.indexTopic(''), null)
  t.is(seeder.indexTopic('CEU'), null, 'the query is folded by the client')
  t.is(seeder.indexTopic('Céu'), null)
  t.is(seeder.indexTopic('a'), null, 'a one-letter token')
  t.is(seeder.indexTopic(Array.from({ length: 9 }, (_, i) => 'ab' + i).join('+')), null, 'nine tokens')
  t.is(seeder.indexTopic('ceu', 'bad'), null, 'a malformed cursor')
  t.is(seeder.indexTopic(null), null)
  t.is(seeder.indexTopic(42), null)
  t.alike(seeder.indexTopic('desconhecida'), { items: [], next: null, authors: {}, indexing: false, complete: true })
})

test('a blocked author is hidden at read time', async (t) => {
  const { seeder, serve } = scanFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  serve(A, [post('céu', 1)])
  serve(B, [post('céu', 2)])
  await settle(seeder)
  t.alike(seeder.indexTopic('ceu').items, [ref(B, 1), ref(A, 1)])
  seeder._isBlocked = (k) => k === A
  const page = seeder.indexTopic('ceu')
  t.alike(page.items, [ref(B, 1)])
  t.alike(Object.keys(page.authors), [B], 'no hint for the blocked author')
})

test('a diary held by a pending revocation re-gate is left out and the answer is incomplete', async (t) => {
  const { seeder, serve } = scanFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  serve(A, [post('céu', 1)])
  serve(B, [post('céu azul', 2)])
  await settle(seeder)
  t.is(seeder.indexTopic('ceu').complete, true)
  // _onBlocklistAdopted holds every re-gated diary until block 0's verdict.
  seeder._served.get(A).searchHold = 1
  const held = seeder.indexTopic('ceu')
  t.alike(held.items, [ref(B, 1)], 'held while the re-gate is pending')
  t.alike(Object.keys(held.authors), [B], 'no hint for the held author')
  t.is(held.complete, false, 'a held match makes the answer incomplete')
  const other = seeder.indexTopic('azul')
  t.alike(other.items, [ref(B, 1)])
  t.is(other.complete, true, 'a query the held diary does not match is unaffected')
  seeder._served.get(A).searchHold = 0
  const cleared = seeder.indexTopic('ceu')
  t.alike(cleared.items, [ref(B, 1), ref(A, 1)], 'back once the verdict cleared it')
  t.is(cleared.complete, true)
})

test('_drop removes the diary from the search index before the purge resolves', async (t) => {
  const { seeder, serve } = scanFixture()
  const A = authorKey(1)
  const B = authorKey(2)
  serve(A, [post('céu', 1), post('céu de novo', 2)])
  serve(B, [post('céu', 3)])
  await settle(seeder)
  t.is(seeder._topics.stats().posts, 3)
  let release
  let purging = false
  seeder._purge = () => {
    purging = true
    return new Promise((resolve) => { release = resolve })
  }
  seeder._drop(A, 'blocked')
  t.is(seeder._topics.stats().posts, 1, 'removed synchronously')
  t.alike(seeder.indexTopic('ceu').items, [ref(B, 1)])
  t.absent(seeder._topicStartup.has(A))
  await until(() => purging, { name: 'purga iniciada' })
  t.alike(seeder.indexTopic('ceu').items, [ref(B, 1)], 'still gone while the purge is stalled')
  release()
  await seeder._drops.get(A)
})

test('caps: search and engagement cursors pause independently; a drop resumes the search cursor without double counting', async (t) => {
  // topicMaxPosts 2: B's post and A:1 fit, A:2 (the third post) is refused.
  const { seeder, serve } = scanFixture({ search: { maxPosts: 2 } })
  const A = authorKey(1)
  const B = authorKey(2)
  serve(B, [post('outra coisa', 0)])
  await settle(seeder)
  const a = serve(A, [
    post('primeira palavra', 1),
    likeRecord({ to: { author: B, seq: 1 }, on: true, at: at(2) }),
    post('segunda palavra', 3),
    likeRecord({ to: { author: B, seq: 1 }, on: false, at: at(4) })
  ])
  await settle(seeder)
  t.ok(a.topicPaused, 'the search cursor paused')
  t.is(a.topicIndexed, 3, 'AT the refused block')
  t.absent(a.indexPaused, 'never pauses the engagement cursor')
  t.is(a.indexed, 5, 'engagement reached the end')
  t.is(seeder._topicFlags().complete, false)
  t.is(seeder._indexFlags().complete, true, 'the engagement flags are untouched')
  t.is(seeder.indexTopic('palavra').complete, false)
  t.is(seeder.indexMember(A).complete, true)
  t.is(seeder._topics.stats().saturated, true)
  t.alike(seeder.indexTopic('palavra').items, [ref(A, 1)])

  // Dropping B frees room: A's search cursor resumes at block 3.
  seeder._drop(B, 'fork')
  await seeder._drops.get(B)
  await settle(seeder)
  t.absent(a.topicPaused)
  t.is(a.topicIndexed, 5)
  t.is(seeder._topics.stats().posts, 2, 'A:1 and A:3, each counted once')
  t.alike(seeder.indexTopic('palavra').items, [ref(A, 3), ref(A, 1)])
  t.is(seeder.indexTopic('palavra').complete, true)
  t.is(seeder._topics.stats().saturated, true, 'at the cap again (2 of 2), nothing refused')
})

test('caps: a paused engagement cursor does not stop the search scan', async (t) => {
  const { seeder, serve } = scanFixture({ index: { maxRecords: 1 } })
  const A = authorKey(1)
  const a = serve(A, [post('um', 1), post('dois', 2), post('tres palavra', 3)])
  await settle(seeder)
  t.ok(a.indexPaused, 'engagement paused at the cap')
  t.is(a.indexed, 2)
  t.is(a.topicIndexed, 4, 'search reached the end')
  t.is(seeder._indexFlags().complete, false)
  const page = seeder.indexTopic('palavra')
  t.alike(page.items, [ref(A, 3)], 'a post past the engagement pause is found')
  t.is(page.complete, true)
})

test('a post dated two days ahead is hidden', async (t) => {
  const { seeder, serve } = scanFixture()
  const A = authorKey(1)
  const future = new Date(Date.now() + 2 * 86400000).toISOString()
  serve(A, [post('céu agora', 1), postRecord({ text: 'céu amanhã', at: future })])
  await settle(seeder)
  t.alike(seeder.indexTopic('ceu').items, [ref(A, 1)])
  t.alike(seeder.indexTopic('amanha').items, [])
})

test('paging over 70 matching posts: 30, 30, 10, then next null', async (t) => {
  const { seeder, serve } = scanFixture()
  const A = authorKey(1)
  serve(A, Array.from({ length: 70 }, (_, i) => post('palavra ' + i, i)))
  await settle(seeder)
  const p1 = seeder.indexTopic('palavra')
  t.is(p1.items.length, 30)
  t.is(p1.items[0], ref(A, 70), 'newest first')
  t.ok(p1.next)
  const p2 = seeder.indexTopic('palavra', p1.next)
  t.is(p2.items.length, 30)
  t.ok(p2.next)
  const p3 = seeder.indexTopic('palavra', p2.next)
  t.is(p3.items.length, 10)
  t.is(p3.next, null)
  const seen = new Set([...p1.items, ...p2.items, ...p3.items])
  t.is(seen.size, 70, 'every post exactly once')
  t.is(p3.items[9], ref(A, 1))
})

// ---- End to end -----------------------------------------------------------

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
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    log: (e) => {
      events.push(e)
      if (process.env.VARANDA_TEST_LOG) console.error('# seeder', JSON.stringify(e))
    },
    ...opts
  })
  t.teardown(() => seeder.close(), { force: true })
  return { seeder, events }
}

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

function searchedTo (seeder, m, length = m.diary.length) {
  return until(() => {
    const entry = seeder._served.get(m.key)
    return entry && entry.topicIndexed >= length
  }, { name: 'diário pesquisável até ' + length })
}

test('end to end: indexed after ready, rebuilt on restart, removed by a blocklist; health exposes counts only', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = newSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await first.seeder.start()

  const A = await member(t, bootstrap, assoc, {
    records: () => [postRecord({ text: 'Olá mundo bonito', at: at(0) }), postRecord({ text: 'outra coisa', at: at(1) })]
  })
  await admit(A, assoc)
  await searchedTo(first.seeder, A)
  const found = first.seeder.indexTopic('mundo')
  t.alike(found, { items: [ref(A.key, 1)], next: null, authors: { [A.key]: NO_HINTS }, indexing: false, complete: true })
  t.is(first.seeder.stats().topicPosts, 2)
  await first.seeder.close()
  t.is(first.seeder.indexTopic('mundo').items.length, 0, 'nothing is visible after close')

  const second = newSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await second.seeder.start()
  await until(() => second.seeder.indexTopic('mundo').indexing === false, { name: 'primeira passada da busca' })
  t.alike(second.seeder.indexTopic('mundo').items, [ref(A.key, 1)], 'rebuilt from the stored diary')
  t.is(second.seeder.stats().topicPosts, 2)

  // /health and /metrics: the new fields at the end, counts only.
  const server = await startHealth({ port: 0, stats: () => second.seeder.stats() })
  t.teardown(() => server.close(), { force: true })
  const base = 'http://127.0.0.1:' + server.port
  const htext = await (await fetch(base + '/health')).text()
  const body = JSON.parse(htext)
  t.alike(Object.keys(body).slice(-3), ['indexSaturated', 'topicPosts', 'topicSaturated'])
  t.is(body.topicPosts, 2)
  t.is(body.topicSaturated, false)
  t.absent(HEX64_ANYWHERE.test(htext), 'no key in /health')
  const mtext = await (await fetch(base + '/metrics')).text()
  t.ok(mtext.includes('# TYPE varanda_seeder_topic_posts gauge\nvaranda_seeder_topic_posts 2\n'))
  t.ok(mtext.includes('# TYPE varanda_seeder_topic_saturated gauge\nvaranda_seeder_topic_saturated 0\n'))
  t.absent(HEX64_ANYWHERE.test(mtext), 'no key in /metrics')
  await server.close()

  // A blocked by an adopted blocklist: gone from the search index.
  const modKp = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp)
  const snapshot = createSnapshot({ seq: 1, blocked: [A.key], revokedIssuers: [] }, modKp, modCert)
  // The second seeder has the same key (same data dir), so joinPeer reaches it.
  await member(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot } })
  await until(() => second.events.some((e) => e.event === 'rejected' && e.key === A.key && e.reason === 'blocked'), { name: 'A bloqueado', timeoutMs: 30000 })
  t.alike(second.seeder.indexTopic('mundo').items, [], 'removed from the index')
  t.is(second.seeder.stats().topicPosts, 0)
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})
