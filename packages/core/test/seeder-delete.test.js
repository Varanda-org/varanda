'use strict'

// Deletion at the seeder (packages/core/lib/seeder.js, _applyDelete): a
// tombstone found by the uncapped scan takes its target out of the
// engagement, topic and name indexes, out of postBlock and, for the media
// ranges it lists, out of mediaRead. Raw replication is unchanged.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('../lib/net')
const { memberCertRecord, postRecord, profileRecord, likeRecord, deleteRecord, mediaCoreRecord, MEDIA_BLOCK_BYTES, MAX_MEDIA_CORES } = require('../lib/records')
const { mediaHeader } = require('../lib/media')

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

async function startSeeder (t, bootstrap, dataDir, opts) {
  const s = newSeeder(t, bootstrap, dataDir, opts)
  await s.seeder.start()
  return s
}

const BASE_MS = Date.parse('2026-03-01T12:00:00.000Z')
function at (i) {
  return new Date(BASE_MS + i * 1000).toISOString()
}

function ref (key, seq) {
  return key + ':' + seq
}

// A member on the swarm: its diary (certificate + `records(key, mediaKey,
// mediaKeys)`) and, with `media`, `cores` media cores of that many raw
// blocks after their header (mediaKey is the first).
async function member (t, bootstrap, assoc, { records = () => [], media = 0, cores = 1 } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  const mediaKeys = []
  for (let c = 0; c < (media > 0 ? cores : 0); c++) {
    const core = store.get({ name: 'media-' + c })
    await core.ready()
    await core.append(b4a.from(JSON.stringify(mediaHeader({ diary: key }))))
    for (let i = 0; i < media; i++) await core.append(b4a.alloc(MEDIA_BLOCK_BYTES, i + 1))
    mediaKeys.push(hex(core.key))
  }
  const mediaKey = mediaKeys.length > 0 ? mediaKeys[0] : null
  await diary.append(memberCertRecord(validCert(assoc, key)))
  for (const r of records(key, mediaKey, mediaKeys)) await diary.append(r)

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
  return { store, diary, key, mediaKey, mediaKeys, swarm, peers, messages, seederPeer, message }
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

async function append (m, records) {
  for (const r of records) await m.diary.append(r)
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

// Every cursor of m's diary (scan, engagement, search) reached its length.
function settled (seeder, m, { paused = false } = {}) {
  return until(() => {
    const entry = seeder._served.get(m.key)
    const length = m.diary.length
    return entry && entry.scanned >= length && entry.topicIndexed >= length &&
      (paused ? entry.indexPaused : entry.indexed >= length)
  }, { name: 'diário processado até ' + m.diary.length })
}

function descriptor (core, start, blocks) {
  return { core, mime: 'image/jpeg', start, blocks, bytes: blocks * MEDIA_BLOCK_BYTES, sha256: 'ab'.repeat(32), width: 100, height: 100 }
}

test('a tombstone removes the post from counts, timeline, topic search, thread page and postBlock', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    records: () => [postRecord({ text: 'apagavel mundo', at: at(0) }), postRecord({ text: 'fica mundo', at: at(1) })]
  })
  await admit(A, assoc)
  const B = await member(t, bootstrap, assoc, {
    records: () => [likeRecord({ to: { author: A.key, seq: 1 }, on: true, at: at(2) })]
  })
  await admit(B, assoc)
  await settled(seeder, A)
  await settled(seeder, B)
  t.alike(seeder.indexCounts([ref(A.key, 1)]).counts, { [ref(A.key, 1)]: { replies: 0, quotes: 0, likes: 1, reposts: 0 } })
  t.alike(seeder.indexMember(A.key).posts, [2, 1])
  t.alike(seeder.indexTopic('mundo').items, [ref(A.key, 2), ref(A.key, 1)])
  t.ok(await seeder.postBlock(A.key, 1), 'served before the tombstone')

  await append(A, [deleteRecord({ seq: 1, at: at(3) })])
  await settled(seeder, A)
  const counts = seeder.indexCounts([ref(A.key, 1), ref(A.key, 2)])
  t.alike(counts.counts, { [ref(A.key, 2)]: { replies: 0, likes: 0, reposts: 0, quotes: 0 } }, 'the deleted post and its like are not counted')
  t.is(counts.complete, true)
  t.alike(seeder.indexMember(A.key).posts, [2], 'gone from the timeline')
  t.is(seeder.indexMember(A.key).postsTotal, 1)
  t.alike(seeder.indexTopic('mundo').items, [ref(A.key, 2)], 'gone from topic search')
  t.alike(seeder.indexTopic('apagavel').items, [])
  t.is(seeder.indexPost(A.key, 1), null, 'no thread page')
  t.is(await seeder.postBlock(A.key, 1), null, 'postBlock refuses the deleted seq')
  t.ok(await seeder.postBlock(A.key, 2), 'the other post is still served')
  const entryA = seeder._served.get(A.key)
  await until(async () => !(await entryA.core.has(1)), { name: 'bloco apagado' })
  t.absent(await entryA.core.has(1), 'the deleted block is cleared')
  t.ok(await entryA.core.has(3), 'the tombstone is kept')
  t.is(entryA.present, 4, 'the present length skips the deleted hole')

  // An engagement arriving after the tombstone is not indexed either.
  await append(B, [likeRecord({ to: { author: A.key, seq: 1 }, on: false, at: at(4) }), likeRecord({ to: { author: A.key, seq: 1 }, on: true, at: at(5) })])
  await settled(seeder, B)
  t.alike(seeder.indexCounts([ref(A.key, 1)]).counts, {})
})

test('a tombstone arriving while the engagement cursor is paused at the cap is still applied', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, indexPerAuthorMax: 1 })

  const A = await member(t, bootstrap, assoc, {
    records: () => [postRecord({ text: 'primeiro', at: at(0) }), postRecord({ text: 'segundo', at: at(1) })]
  })
  await admit(A, assoc)
  await settled(seeder, A, { paused: true })
  const entry = seeder._served.get(A.key)
  t.is(entry.indexed, 2, 'paused at the second post')
  t.alike(seeder.indexMember(A.key).posts, [1])
  t.is(seeder.indexCounts([]).complete, false)

  await append(A, [deleteRecord({ seq: 1, at: at(2) })])
  await settled(seeder, A)
  t.absent(entry.indexPaused, 'the removal freed room and the cursor resumed')
  t.alike(seeder.indexMember(A.key).posts, [2], 'only the surviving post is listed')
  t.is(seeder.indexPost(A.key, 1), null)
  t.alike(seeder.indexTopic('primeiro').items, [])
  t.is(seeder.indexCounts([]).complete, true)
})

test('deleting the newest profile version restores the previous name in account search', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    records: () => [profileRecord({ name: 'Joaquina', at: at(0) }), profileRecord({ name: 'Beatriz', at: at(1) })]
  })
  await admit(A, assoc)
  await settled(seeder, A)
  t.is(seeder.indexSearch('beatriz').members[0].profileSeq, 2)
  t.alike(seeder.indexSearch('joaquina').members, [])

  await append(A, [deleteRecord({ seq: 2, at: at(2) })])
  await settled(seeder, A)
  t.alike(seeder.indexSearch('beatriz').members, [], 'the deleted name no longer matches')
  t.alike(seeder.indexSearch('joaquina').members, [{ author: A.key, profileSeq: 1, usernameSeq: null }], 'the previous version answers again')
  t.is(seeder.indexMember(A.key).profileSeq, 1, 'the hint points at the surviving version')
})

test('a failed read of the surviving profile is retried before the scan moves past the tombstone', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    records: () => [profileRecord({ name: 'Joaquina', at: at(0) }), profileRecord({ name: 'Beatriz', at: at(1) })]
  })
  await admit(A, assoc)
  await settled(seeder, A)
  const entry = seeder._served.get(A.key)

  // The next read of the surviving profile (seq 1) fails once.
  const core = entry.core
  const get = core.get.bind(core)
  let failed = null
  const failedOnce = new Promise((resolve) => { failed = resolve })
  let armed = true
  core.get = async (i, opts) => {
    if (armed && i === 1) {
      armed = false
      setImmediate(failed)
      throw new Error('transient')
    }
    return get(i, opts)
  }

  await append(A, [deleteRecord({ seq: 2, at: at(2) })])
  await failedOnce
  await new Promise((resolve) => setImmediate(resolve))
  const search = seeder.indexSearch('joaquina')
  if (search.members.length === 0) t.is(search.complete, false, 'not complete while the surviving name is missing')
  t.ok(entry.scanned < A.diary.length, 'the scan has not moved past the tombstone')
  t.is(seeder.indexCounts([]).complete, false, 'answers are not complete')

  await until(() => seeder.indexSearch('joaquina').members.length === 1, { name: 'nome restante', timeoutMs: 20000 })
  t.alike(seeder.indexSearch('joaquina').members, [{ author: A.key, profileSeq: 1, usernameSeq: null }], 'the surviving name answers after the retry')
  t.alike(seeder.indexSearch('beatriz').members, [], 'the deleted name no longer matches')
  await until(() => seeder.indexSearch('joaquina').complete, { name: 'busca completa' })
  t.is(seeder.indexCounts([]).complete, true)
})

test('a surviving profile read that always fails stops retrying after a bounded number of passes', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    records: () => [profileRecord({ name: 'Joaquina', at: at(0) }), profileRecord({ name: 'Beatriz', at: at(1) })]
  })
  await admit(A, assoc)
  await settled(seeder, A)
  const entry = seeder._served.get(A.key)

  const core = entry.core
  const get = core.get.bind(core)
  let failures = 0
  core.get = async (i, opts) => {
    if (i === 1) {
      failures++
      throw new Error('persistent')
    }
    return get(i, opts)
  }

  await append(A, [deleteRecord({ seq: 2, at: at(2) })])
  await until(() => failures > 0, { name: 'primeira falha' })
  // Each scheduled retry is fired at once instead of after SCAN_RETRY_MS.
  let fired = 0
  for (; fired < 30; fired++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (entry.scanRetry === null) break
    clearTimeout(entry.scanRetry)
    entry.scanRetry = null
    seeder._scanDiary(A.key, entry)
  }
  t.ok(fired < 30, 'the retries stop (' + fired + ' fired, ' + failures + ' failed reads)')
  t.is(failures, fired + 1, 'one failed read per pass')
  t.ok(entry.scanned < A.diary.length, 'the scan has not moved past the tombstone')
  t.is(seeder.indexCounts([]).complete, false, 'answers stay incomplete')
  t.is(seeder.indexSearch('joaquina').complete, false, 'search stays incomplete')
})

test('a foreign diary tombstone changes nothing in another diary', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    records: () => [postRecord({ text: 'alheio', at: at(0) }), postRecord({ text: 'outro', at: at(1) })]
  })
  await admit(A, assoc)
  const B = await member(t, bootstrap, assoc, {
    records: () => [likeRecord({ to: { author: A.key, seq: 1 }, on: true, at: at(2) }), postRecord({ text: 'meu', at: at(3) })]
  })
  await admit(B, assoc)
  await settled(seeder, A)
  await settled(seeder, B)
  // B's tombstone names seq 2: B's own post, never A's block 2.
  await append(B, [deleteRecord({ seq: 2, at: at(4) })])
  await settled(seeder, B)
  t.alike(seeder.indexMember(A.key).posts, [2, 1])
  t.alike(seeder.indexCounts([ref(A.key, 1)]).counts, { [ref(A.key, 1)]: { replies: 0, quotes: 0, likes: 1, reposts: 0 } })
  t.alike(seeder.indexTopic('outro').items, [ref(A.key, 2)])
  t.ok(await seeder.postBlock(A.key, 2))
  t.alike(seeder.indexMember(B.key).posts, [], 'B removed only its own post')
  t.is(await seeder.postBlock(B.key, 2), null)
})

test('a restart rebuilds the same state from the stored blocks', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    records: () => [postRecord({ text: 'reinicio some', at: at(0) }), postRecord({ text: 'reinicio fica', at: at(1) }), deleteRecord({ seq: 1, at: at(2) })]
  })
  await admit(A, assoc)
  const B = await member(t, bootstrap, assoc, {
    records: () => [likeRecord({ to: { author: A.key, seq: 1 }, on: true, at: at(3) }), likeRecord({ to: { author: A.key, seq: 2 }, on: true, at: at(4) })]
  })
  await admit(B, assoc)
  await settled(first.seeder, A)
  await settled(first.seeder, B)
  const snapshot = (seeder) => ({
    counts: seeder.indexCounts([ref(A.key, 1), ref(A.key, 2)]).counts,
    member: seeder.indexMember(A.key).posts,
    topic: seeder.indexTopic('reinicio').items
  })
  const before = snapshot(first.seeder)
  t.alike(before, {
    counts: { [ref(A.key, 2)]: { replies: 0, quotes: 0, likes: 1, reposts: 0 } },
    member: [2],
    topic: [ref(A.key, 2)]
  })
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await until(() => {
    const flags = second.seeder.indexCounts([])
    const topic = second.seeder.indexTopic('reinicio')
    return flags.complete && topic.complete
  }, { name: 'índices completos após reinício' })
  t.alike(snapshot(second.seeder), before, 'same answers after the restart')
  t.is(await second.seeder.postBlock(A.key, 1), null)
  t.ok(second.seeder._served.get(A.key).deleted.has(1))
})

test('mediaRead refuses a range listed by a tombstone unless a surviving post shows it', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    media: 4,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'foto', media: [descriptor(K, 1, 2)], at: at(1) }),
      postRecord({ text: 'outra foto', media: [descriptor(K, 3, 1)], at: at(2) }),
      postRecord({ text: 'mais uma', media: [descriptor(K, 4, 1)], at: at(3) })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === 5, { name: 'mídia baixada' })
  t.ok(await seeder.mediaRead(A.key, K, 1, 2), 'served before the tombstone')

  await append(A, [
    deleteRecord({ seq: 2, at: at(4), media: [{ core: K, start: 1, blocks: 2 }] }),
    // Hand-made: block 4 is still shown by post 4, so it stays served. The
    // rule is per block: block 3, which nothing shows any more, is refused.
    deleteRecord({ seq: 3, at: at(5), media: [{ core: K, start: 3, blocks: 2 }] })
  ])
  await settled(seeder, A)
  t.is(await seeder.mediaRead(A.key, K, 1, 2), null, 'the deleted range is refused')
  t.is(await seeder.mediaRead(A.key, K, 2, 1), null, 'any block inside it is refused')
  t.ok(await seeder.mediaRead(A.key, K, 4, 1), 'a block a surviving post shows stays served')
  t.is(await seeder.mediaRead(A.key, K, 3, 1), null, 'a listed block no survivor shows is refused')
  t.is(await seeder.mediaRead(A.key, K, 3, 2), null)
  const mcore = seeder._mediaServed.get(K).core
  await until(async () => !(await mcore.has(1)) && !(await mcore.has(2)) && !(await mcore.has(3)), { name: 'mídia apagada' })
  t.ok(await mcore.has(4), 'a block a survivor shows keeps its bytes')
  t.ok(await mcore.has(0), 'the header is never cleared')
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null, 'a cleared block is not served')
})

test('deleting the block the engagement cursor paused on resumes the cursor past it', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, indexMaxTargets: 1 })

  const elsewhere = 'cd'.repeat(32)
  const A = await member(t, bootstrap, assoc, {
    records: (key) => [
      postRecord({ text: 'raiz', at: at(0) }),
      postRecord({ text: 'resposta', replyTo: { author: key, seq: 1 }, at: at(1) }),
      // A second target does not fit: the cursor pauses here.
      postRecord({ text: 'recusada', replyTo: { author: elsewhere, seq: 1 }, at: at(2) }),
      postRecord({ text: 'depois', at: at(3) })
    ]
  })
  await admit(A, assoc)
  await settled(seeder, A, { paused: true })
  const entry = seeder._served.get(A.key)
  t.is(entry.indexed, 3, 'paused at the refused reply')

  // The refused block was never indexed: removing it frees nothing.
  await append(A, [deleteRecord({ seq: 3, at: at(4) })])
  await settled(seeder, A)
  t.absent(entry.indexPaused, 'the cursor skipped the deleted block')
  t.alike(seeder.indexMember(A.key).posts, [4, 2, 1], 'the later post is indexed')
  t.is(seeder.indexCounts([]).complete, true)
})

test('deleting the block the search cursor paused on resumes the cursor past it', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, topicPerAuthorMax: 1 })

  const A = await member(t, bootstrap, assoc, {
    records: () => [postRecord({ text: 'busca um', at: at(0) }), postRecord({ text: 'busca dois', at: at(1) })]
  })
  await admit(A, assoc)
  await until(() => seeder._served.get(A.key)?.topicPaused, { name: 'busca pausada' })
  const entry = seeder._served.get(A.key)
  t.is(entry.topicIndexed, 2, 'paused at the second post')

  // The refused block was never indexed: removing it frees nothing.
  await append(A, [deleteRecord({ seq: 2, at: at(2) })])
  await settled(seeder, A)
  t.absent(entry.topicPaused, 'the cursor skipped the deleted block')
  t.alike(seeder.indexTopic('busca').items, [ref(A.key, 1)])
  t.is(seeder.indexTopic('busca').complete, true)
})

test('answers are not complete while a scanned tombstone is still being applied', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    records: () => [postRecord({ text: 'lenta', at: at(0) })]
  })
  await admit(A, assoc)
  await settled(seeder, A)
  const entry = seeder._served.get(A.key)

  // Holds the application of the tombstone (its target read) open.
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  let started = false
  const apply = seeder._applyDelete.bind(seeder)
  seeder._applyDelete = async (...args) => {
    started = true
    await gate
    return apply(...args)
  }
  await append(A, [deleteRecord({ seq: 1, at: at(1) })])
  await until(() => started && entry.indexed >= 2 && entry.topicIndexed >= 2, { name: 'cursores no fim' })
  const counts = seeder.indexCounts([ref(A.key, 1)])
  const topic = seeder.indexTopic('lenta')
  t.alike(topic.items, [ref(A.key, 1)], 'not applied yet')
  t.is(counts.complete, false, 'index answers are not complete')
  t.is(topic.complete, false, 'topic answers are not complete')

  release()
  await until(() => seeder.indexTopic('lenta').complete, { name: 'busca completa' })
  t.alike(seeder.indexTopic('lenta').items, [])
  t.is(seeder.indexCounts([]).complete, true)
})

test('mediaRead stops serving a range deleted while its reads are in flight', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    media: 4,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'foto', media: [descriptor(K, 1, 2)], at: at(1) }),
      postRecord({ text: 'outra', media: [descriptor(K, 3, 2)], at: at(2) })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === 5, { name: 'mídia baixada' })

  // The next read of a media block (not the header) waits until released.
  const core = seeder._mediaServed.get(K).core
  const get = core.get.bind(core)
  let hold = null
  core.get = async (i, opts) => {
    if (hold !== null && i >= 1) {
      const h = hold
      hold = null
      h.started()
      await h.gate
    }
    return get(i, opts)
  }
  const holdNext = () => {
    let release = null
    let started = null
    const gate = new Promise((resolve) => { release = resolve })
    const begun = new Promise((resolve) => { started = resolve })
    hold = { gate, started }
    return { release, begun }
  }

  // The tombstone lands while the sizing read of the first block is pending.
  const first = holdNext()
  const pending = seeder.mediaRead(A.key, K, 1, 2)
  await first.begun
  await append(A, [deleteRecord({ seq: 2, at: at(3), media: [{ core: K, start: 1, blocks: 2 }] })])
  await settled(seeder, A)
  first.release()
  t.is(await pending, null, 'no answer for a range deleted mid-read')

  // An answer already handed out stops before a block deleted meanwhile.
  const read = await seeder.mediaRead(A.key, K, 3, 2)
  t.ok(read, 'served before the second tombstone')
  const it = read.blocks[Symbol.asyncIterator]()
  const second = holdNext()
  const next = it.next()
  await second.begun
  await append(A, [deleteRecord({ seq: 3, at: at(4), media: [{ core: K, start: 3, blocks: 2 }] })])
  await settled(seeder, A)
  second.release()
  t.alike(await next, { done: true, value: undefined }, 'the stream ends without the deleted bytes')
})

test('a tombstone deleted by a later tombstone no longer hides its target from postBlock', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  // Hide only (the kill switch): with byte deletion the revived post's bytes
  // are already gone (the next test).
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, noClear: true })

  const A = await member(t, bootstrap, assoc, {
    media: 1,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'denunciada', media: [descriptor(K, 1, 1)], at: at(1) })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === 2, { name: 'mídia baixada' })
  await settled(seeder, A)

  await append(A, [deleteRecord({ seq: 2, at: at(2), media: [{ core: K, start: 1, blocks: 1 }] })])
  await settled(seeder, A)
  t.is(await seeder.postBlock(A.key, 2), null, 'one tombstone hides the post')
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null, 'and its media')

  // Readers fold from the highest seq down: the second tombstone deletes the
  // first, which then has no effect, so the post shows again.
  await append(A, [deleteRecord({ seq: 3, at: at(3) })])
  await settled(seeder, A)
  const answer = await seeder.postBlock(A.key, 2)
  t.ok(answer, 'moderation sees the post readers show')
  t.is(answer && JSON.parse(b4a.toString(answer.block)).text, 'denunciada')
  t.is(await seeder.postBlock(A.key, 3), null, 'the deleted tombstone is not served')
  // The media counters undo one level only, so a tombstone of a tombstone
  // makes the diary irregular and all of its media is refused (fail closed).
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null, 'a tombstone of a tombstone closes the media of the diary')

  // A third tombstone deletes the second, so the first takes effect again.
  await append(A, [deleteRecord({ seq: 4, at: at(4) })])
  await settled(seeder, A)
  t.is(await seeder.postBlock(A.key, 2), null, 'hidden again, as readers fold it')
  t.ok(await seeder.postBlock(A.key, 3), 'the first tombstone is shown again')
  const core = seeder._served.get(A.key).core
  t.ok(await core.has(2), 'the kill switch keeps the bytes of the deleted post')
  t.ok(await seeder._mediaServed.get(K).core.has(1), 'and of its media')
})

test('a post a later tombstone gives back stays absent once cleared and is never fetched again', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, { records: () => [postRecord({ text: 'volta', at: at(0) })] })
  await admit(A, assoc)
  await settled(seeder, A)
  const core = seeder._served.get(A.key).core
  await append(A, [deleteRecord({ seq: 1, at: at(1) })])
  await settled(seeder, A)
  await until(async () => !(await core.has(1)), { name: 'post apagado' })

  // Self-only residual: the fold shows the post again, its bytes are gone.
  await append(A, [deleteRecord({ seq: 2, at: at(2) }), postRecord({ text: 'depois', at: at(3) })])
  await settled(seeder, A)
  await until(() => core.has(4), { name: 'bloco seguinte' })
  t.ok(await core.has(2), 'the deleted tombstone is kept')
  t.absent(await core.has(1), 'the revived post is not downloaded again')
  t.is(await seeder.postBlock(A.key, 1), null, 'nothing to serve for it')
  t.ok(await seeder.postBlock(A.key, 4), 'later blocks are served')
})

test('the clear does not wait for an index pass paused at the cap', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, indexPerAuthorMax: 1 })

  const A = await member(t, bootstrap, assoc, {
    records: () => [postRecord({ text: 'um', at: at(0) }), postRecord({ text: 'dois', at: at(1) }), postRecord({ text: 'tres', at: at(2) })]
  })
  await admit(A, assoc)
  await settled(seeder, A, { paused: true })
  const entry = seeder._served.get(A.key)
  // Hold the index paused even after the tombstone frees room.
  entry.indexPaused = true
  const indexDiary = seeder._indexDiary.bind(seeder)
  seeder._indexDiary = () => {}
  await append(A, [deleteRecord({ seq: 3, at: at(3) })])
  await until(() => entry.scanned >= A.diary.length, { name: 'varredura' })
  await until(async () => !(await entry.core.has(3)), { name: 'bloco apagado' })
  t.ok(entry.indexed <= 2, 'the index cursor is still behind (' + entry.indexed + ')')
  t.absent(await entry.core.has(3), 'the deleted block is cleared anyway')
  seeder._indexDiary = indexDiary
})

test('a restart clears what the stored tombstones delete before anything is fetched and keeps the holes', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  // First run with the kill switch: the bytes stay stored.
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, noClear: true })
  const A = await member(t, bootstrap, assoc, {
    media: 2,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'foto', media: [descriptor(K, 1, 1)], at: at(1) }),
      postRecord({ text: 'fica', media: [descriptor(K, 2, 1)], at: at(2) }),
      deleteRecord({ seq: 2, at: at(3), media: [{ core: K, start: 1, blocks: 1 }] })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => first.events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => first.seeder._mediaServed.get(K)?.core.contiguousLength === 3, { name: 'mídia baixada' })
  await settled(first.seeder, A)
  t.ok(await first.seeder._served.get(A.key).core.has(2), 'kept under the kill switch')
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const entry = second.seeder._served.get(A.key)
  const media = second.seeder._mediaServed.get(K)
  t.absent(await entry.core.has(2), 'the deleted post is cleared when start() resolves')
  t.absent(await media.core.has(1), 'and its media range')
  t.ok(await media.core.has(2), 'a live range keeps its bytes')
  t.is(entry.present, 5, 'the present length skips the hole')

  // The member (a stale peer still holding block 2 and media block 1) keeps
  // writing: later blocks flow, the holes are never fetched back.
  await append(A, [postRecord({ text: 'nova', at: at(4) })])
  await settled(second.seeder, A)
  await until(() => entry.core.has(5), { name: 'bloco novo' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.absent(await entry.core.has(2), 'the deleted post is not fetched again')
  t.absent(await media.core.has(1), 'nor its media')
  t.is(await second.seeder.mediaRead(A.key, K, 1, 1), null)
  t.ok(await second.seeder.mediaRead(A.key, K, 2, 1), 'the live photo is served')
  t.ok(await second.seeder.postBlock(A.key, 5))
})

test('mediaRead of one block stays fast with thousands of tombstones and media posts', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const N = 3000
  const A = await member(t, bootstrap, assoc, {
    media: 2,
    records: (key, K) => [mediaCoreRecord({ key: K, at: at(0) })]
  })
  const K = A.mediaKey
  const batch = []
  // Seqs 2..N+1: plain posts the tombstones target.
  for (let i = 0; i < N; i++) batch.push(postRecord({ text: 'alvo', at: at(1) }))
  // Seqs N+2..2N+1 show block 2; the one post at 2N+2 shows block 1.
  for (let i = 0; i < N; i++) batch.push(postRecord({ text: 'foto', media: [descriptor(K, 2, 1)], at: at(2) }))
  const liveSeq = 2 * N + 2
  batch.push(postRecord({ text: 'viva', media: [descriptor(K, 1, 1)], at: at(3) }))
  // Seqs 2N+3..3N+2: every tombstone lists block 1.
  for (let i = 0; i < N; i++) batch.push(deleteRecord({ seq: 2 + i, at: at(4), media: [{ core: K, start: 1, blocks: 1 }] }))
  await A.diary.append(batch)
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === 3, { name: 'mídia baixada' })
  await until(() => seeder._served.get(A.key)?.scanned >= A.diary.length, { name: 'varredura completa', timeoutMs: 120000 })

  const timed = async (start, blocks) => {
    const began = process.hrtime.bigint()
    const read = await seeder.mediaRead(A.key, K, start, blocks)
    let n = 0
    if (read) for await (const raw of read.blocks) n += raw.byteLength
    return { read, n, ms: Number(process.hrtime.bigint() - began) / 1e6 }
  }
  const live = await timed(1, 1)
  t.ok(live.read, 'a block a surviving post shows stays served')
  t.is(live.n, MEDIA_BLOCK_BYTES)
  t.ok(live.ms < 100, 'one block served in ' + live.ms.toFixed(1) + ' ms')
  t.ok((await timed(2, 1)).read, 'a block no tombstone lists is served')

  await append(A, [deleteRecord({ seq: liveSeq, at: at(5) })])
  await until(() => seeder._served.get(A.key)?.scanned >= A.diary.length, { name: 'varredura completa' })
  const gone = await timed(1, 1)
  t.is(gone.read, null, 'the listed block is refused once nothing shows it')
  t.ok(gone.ms < 100, 'refused in ' + gone.ms.toFixed(1) + ' ms')
  t.is(await seeder.mediaRead(A.key, K, 1, 2), null, 'a range holding it is refused')
  t.ok(await seeder.mediaRead(A.key, K, 2, 1), 'the other block is still served')
})

test('media deletion state is kept for a bounded number of cores per diary, and a re-declared core is recounted', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const cap = 2 * MAX_MEDIA_CORES
  const fakes = 5 * cap
  const A = await member(t, bootstrap, assoc, {
    media: 2,
    records: (key, K) => {
      const out = [
        mediaCoreRecord({ key: K, at: at(0) }),
        postRecord({ text: 'apagada', media: [descriptor(K, 1, 1)], at: at(0) }),
        deleteRecord({ seq: 2, at: at(0), media: [{ core: K, start: 1, blocks: 1 }] })
      ]
      // Many more declared cores than the cap: K's only declaration so far
      // is the oldest, so the scan evicts it.
      for (let i = 0; i < fakes; i++) out.push(mediaCoreRecord({ key: (i + 1).toString(16).padStart(64, '0'), at: at(1) }))
      // Declared again last (as web-member mediaPrepare does), K is in the
      // latest set and gets bound; the recount tracks it again.
      out.push(mediaCoreRecord({ key: K, at: at(2) }))
      out.push(postRecord({ text: 'foto', media: [descriptor(K, 2, 1)], at: at(3) }))
      return out
    }
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(async () => (await seeder._mediaServed.get(K)?.core.has(2)) === true, { name: 'mídia baixada' })
  await settled(seeder, A)
  const entry = seeder._served.get(A.key)
  await until(() => !entry.mediaRecounting, { name: 'recontagem' })
  t.is(entry.mediaRecounts, 1, 'one recount ran')
  t.is(entry.media.size, cap, 'tracked cores stay at the cap')
  t.ok(entry.media.has(K), 'the re-declared bound core is tracked again after the recount')
  t.ok([...entry.media].every(([k, s]) => k === K || (s.live.size === 0 && s.del.size === 0)), 'a core no post or tombstone names holds no per-block entries')
  t.ok(await seeder.mediaRead(A.key, K, 2, 1), 'the new item in the re-declared core is served')
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null, 'a deleted range in it is still refused')
  t.is(await seeder.mediaRead(A.key, K, 1, 2), null)

  // Past the per-serve recount limit an untracked bound core stays refused.
  entry.mediaRecounts = cap
  entry.media.delete(K)
  await append(A, [postRecord({ text: 'mais', at: at(4) })])
  await settled(seeder, A)
  t.absent(entry.media.has(K), 'no recount past the limit')
  t.is(await seeder.mediaRead(A.key, K, 2, 1), null, 'a bound but untracked core is refused')
})

test('a media core used before its declaration closes the media of the diary', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    media: 2,
    records: (key, K) => [
      // Hand-made order: the post and the tombstone name K before K is
      // declared, so the counters never saw them while readers do.
      postRecord({ text: 'cedo', media: [descriptor(K, 1, 1)], at: at(0) }),
      deleteRecord({ seq: 1, at: at(1), media: [{ core: K, start: 1, blocks: 1 }] }),
      mediaCoreRecord({ key: K, at: at(2) }),
      postRecord({ text: 'depois', media: [descriptor(K, 2, 1)], at: at(3) })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(async () => (await seeder._mediaServed.get(K)?.core.has(2)) === true, { name: 'mídia baixada' })
  await settled(seeder, A)
  t.ok(seeder._served.get(A.key).mediaIrregular, 'the diary is irregular for media')
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null, 'the range readers treat as deleted is refused')
  t.is(await seeder.mediaRead(A.key, K, 2, 1), null, 'and every other range of the core')
})

test('nested tombstones close the media of the diary', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    media: 2,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'foto', media: [descriptor(K, 1, 1)], at: at(1) }),
      deleteRecord({ seq: 2, at: at(2), media: [{ core: K, start: 1, blocks: 1 }] }),
      deleteRecord({ seq: 3, at: at(3) }),
      // Readers fold T3 -> T2 -> T1: T1 takes effect again and the post is
      // deleted, while one-level counters would serve its media.
      deleteRecord({ seq: 4, at: at(4) }),
      postRecord({ text: 'viva', media: [descriptor(K, 2, 1)], at: at(5) })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(async () => (await seeder._mediaServed.get(K)?.core.has(2)) === true, { name: 'mídia baixada' })
  await settled(seeder, A)
  t.is(await seeder.postBlock(A.key, 2), null, 'postBlock follows the readers fold')
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null, 'the media of the deleted post is refused')
  t.is(await seeder.mediaRead(A.key, K, 2, 1), null, 'every range of the irregular diary is refused')
  const mcore = seeder._mediaServed.get(K).core
  await until(async () => !(await mcore.has(1)), { name: 'mídia do tombstone efetivo apagada' })
  t.absent(await mcore.has(1), 'the range of the effective tombstone is cleared')
  t.ok(await mcore.has(2), 'a range no effective tombstone lists keeps its bytes')
  t.absent(await seeder._served.get(A.key).core.has(2), 'the post the fold deletes is cleared')
  t.ok(await seeder._served.get(A.key).core.has(4), 'a deleted tombstone is never cleared')
})

test('an irregular diary does not read its tombstones back on a pass that changes nothing', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    media: 3,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'foto', media: [descriptor(K, 1, 1)], at: at(1) }),
      deleteRecord({ seq: 2, at: at(2), media: [{ core: K, start: 1, blocks: 1 }] }),
      deleteRecord({ seq: 3, at: at(3) }),
      deleteRecord({ seq: 4, at: at(4) }),
      postRecord({ text: 'viva', media: [descriptor(K, 2, 1)], at: at(5) })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(async () => (await seeder._mediaServed.get(K)?.core.has(3)) === true, { name: 'mídia baixada' })
  await settled(seeder, A)
  const entry = seeder._served.get(A.key)
  t.ok(entry.mediaIrregular, 'the diary is irregular for media')
  const mcore = seeder._mediaServed.get(K).core
  await until(async () => !(await mcore.has(1)), { name: 'mídia do tombstone efetivo apagada' })
  await until(() => entry.clearing === null, { name: 'limpeza parada' })

  const tombs = new Set([3, 4, 5])
  let tombReads = 0
  const get = entry.core.get.bind(entry.core)
  entry.core.get = (i, opts) => {
    if (tombs.has(i)) tombReads++
    return get(i, opts)
  }
  t.teardown(() => { delete entry.core.get })
  await append(A, [postRecord({ text: 'mais uma', at: at(6) })])
  await settled(seeder, A)
  await until(() => entry.clearing === null, { name: 'limpeza parada' })
  t.is(tombReads, 0, 'no tombstone is read again')
  t.is(await seeder.mediaRead(A.key, K, 2, 1), null, 'the irregular media is still refused')
  t.ok(await mcore.has(2), 'a range no effective tombstone lists keeps its bytes')

  await append(A, [deleteRecord({ seq: 6, at: at(7), media: [{ core: K, start: 2, blocks: 1 }] })])
  await settled(seeder, A)
  await until(async () => !(await mcore.has(2)), { name: 'mídia do novo tombstone apagada' })
  t.absent(await mcore.has(2), 'a new tombstone still clears its range')
  t.ok(await mcore.has(3), 'an unlisted range keeps its bytes')
  t.is(tombReads, 0, 'still without reading the tombstones back')
})

test('an honest diary with two media cores serves live ranges and refuses deleted ones', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    media: 2,
    cores: 2,
    records: (key, K, [, L]) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      mediaCoreRecord({ key: L, at: at(1) }),
      postRecord({ text: 'k', media: [descriptor(K, 1, 2)], at: at(2) }),
      postRecord({ text: 'l1', media: [descriptor(L, 1, 1)], at: at(3) }),
      postRecord({ text: 'l2', media: [descriptor(L, 2, 1)], at: at(4) }),
      deleteRecord({ seq: 4, at: at(5), media: [{ core: L, start: 1, blocks: 1 }] })
    ]
  })
  const [K, L] = A.mediaKeys
  await admit(A, assoc)
  for (const k of [K, L]) {
    await until(() => events.find((e) => e.event === 'media-admitted' && e.key === k), { name: 'mídia admitida', timeoutMs: 30000 })
    await until(async () => { const c = seeder._mediaServed.get(k)?.core; return !!c && await c.has(2) && (k !== K || await c.has(1)) }, { name: 'mídia baixada' })
  }
  await settled(seeder, A)
  t.is(seeder._served.get(A.key).media.size, 2)
  t.absent(seeder._served.get(A.key).mediaIrregular, 'an honest diary is not irregular')
  t.ok(await seeder.mediaRead(A.key, K, 1, 2), 'the first core is served')
  t.ok(await seeder.mediaRead(A.key, L, 2, 1), 'a live range of the second core is served')
  t.is(await seeder.mediaRead(A.key, L, 1, 1), null, 'its deleted range is refused')
})

test('mediaRead and postBlock answer nothing until the scan has caught up', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    media: 2,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'some', media: [descriptor(K, 1, 1)], at: at(1) }),
      postRecord({ text: 'fica', media: [descriptor(K, 2, 1)], at: at(2) })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === 3, { name: 'mídia baixada' })
  await settled(seeder, A)
  t.ok(await seeder.postBlock(A.key, 2))
  t.ok(await seeder.mediaRead(A.key, K, 1, 1))

  // The scan's read of the tombstone block waits until released.
  const entry = seeder._served.get(A.key)
  const tomb = A.diary.length
  const core = entry.core
  const get = core.get.bind(core)
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  let held = false
  core.get = async (i, opts) => {
    if (i === tomb) {
      held = true
      await gate
    }
    return get(i, opts)
  }
  await append(A, [deleteRecord({ seq: 2, at: at(3), media: [{ core: K, start: 1, blocks: 1 }] })])
  await until(() => held && core.contiguousLength > tomb, { name: 'varredura presa no tombstone' })
  t.ok(entry.scanned < core.contiguousLength, 'the scan is behind')
  t.is(await seeder.postBlock(A.key, 2), null, 'the deleted post is not served before its tombstone is scanned')
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null, 'nor its media')
  t.is(await seeder.postBlock(A.key, 3), null, 'nothing is served while behind')
  t.is(await seeder.mediaRead(A.key, K, 2, 1), null)

  release()
  await settled(seeder, A)
  t.is(await seeder.postBlock(A.key, 2), null, 'the deleted post stays refused')
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null)
  t.ok(await seeder.postBlock(A.key, 3), 'the live post is served again')
  t.ok(await seeder.mediaRead(A.key, K, 2, 1), 'and its media')
})

test('mediaRead and postBlock answer nothing while a block below the signed length is missing', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await member(t, bootstrap, assoc, {
    media: 1,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'foto', media: [descriptor(K, 1, 1)], at: at(1) })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === 2, { name: 'mídia baixada' })
  await settled(seeder, A)
  t.ok(await seeder.postBlock(A.key, 2))
  t.ok(await seeder.mediaRead(A.key, K, 1, 1))

  // Block 3 stays "missing" (an unknown hole: no tombstone names it),
  // while the tombstone above it at 4 is stored.
  const entry = seeder._served.get(A.key)
  const core = entry.core
  const gap = core.length
  const has = core.has.bind(core)
  const get = core.get.bind(core)
  let hidden = true
  core.has = async (i) => (hidden && i === gap) ? false : has(i)
  core.get = async (i, opts) => (hidden && i === gap) ? null : get(i, opts)
  await A.diary.append([
    postRecord({ text: 'lacuna', at: at(2) }),
    deleteRecord({ seq: 2, at: at(3), media: [{ core: K, start: 1, blocks: 1 }] })
  ])
  await until(() => core.length === gap + 2, { name: 'comprimento assinado' })
  let stored = false
  await until(() => {
    core.has(gap + 1).then((x) => { stored = x }, () => {})
    return stored
  }, { name: 'tombstone guardado' })
  await until(() => entry.scanned === gap && !entry.scanQueued, { name: 'varredura parada na lacuna' })
  t.is(await seeder.postBlock(A.key, 2), null, 'a post deleted above the gap is not served')
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null, 'nor its media')
  t.is(await seeder.postBlock(A.key, gap + 1), null, 'a block above the scan cursor is not served')
  await until(async () => !(await core.has(2)), { name: 'post apagado acima da lacuna' })
  t.absent(await core.has(2), 'the tombstone above the unknown hole is applied: its target is cleared')
  t.ok(entry.deleted.has(2), 'and it left the indexes')

  hidden = false
  seeder._onGrow(A.key, entry, core.length)
  await settled(seeder, A)
  t.is(await seeder.postBlock(A.key, 2), null, 'still refused once the tombstone is scanned')
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null)
  t.ok(await seeder.postBlock(A.key, gap), 'the block of the filled gap is served')
  await until(async () => !(await seeder._mediaServed.get(K).core.has(1)), { name: 'mídia apagada' })
  t.pass('the media range is cleared once the scan caught up')
})

test('a fresh seeder gets past a deleted block every peer already cleared', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, onPush: () => {} })

  const A = await member(t, bootstrap, assoc, {
    records: () => [
      postRecord({ text: 'um', at: at(1) }),
      postRecord({ text: 'dois', at: at(2) }),
      postRecord({ text: 'tres', at: at(3) }),
      deleteRecord({ seq: 2, at: at(4) }),
      postRecord({ text: 'cinco', at: at(5) })
    ]
  })
  // Cleared before the seeder ever sees the diary: no peer serves block 2.
  await A.diary.clear(2, 3)
  t.absent(await A.diary.has(2))
  await admit(A, assoc)
  const entry = seeder._served.get(A.key)
  t.is(entry.present, 6, 'the present length passes the targeted hole')
  await settled(seeder, A)
  await until(() => entry.pushNext >= 6, { name: 'cursor de push' })
  t.ok(entry.gone.has(2), 'the tombstone above the hole was learned')
  t.ok(entry.deleted.has(2), 'and its target left the indexes')
  t.ok(await seeder.postBlock(A.key, 5), 'the post after the hole is served')
  t.is(await seeder.postBlock(A.key, 2), null, 'the deleted post is not')
})

test('a restart prepares a bounded number of diaries at once, each cleared before its download', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  // First run with the kill switch: every deleted block stays stored.
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, noClear: true })
  const members = []
  for (let n = 0; n < 5; n++) {
    const m = await member(t, bootstrap, assoc, {
      records: () => [
        postRecord({ text: 'apaga', at: at(1) }),
        postRecord({ text: 'fica', at: at(2) }),
        deleteRecord({ seq: 2, at: at(3) })
      ]
    })
    await admit(m, assoc)
    await settled(first.seeder, m)
    t.ok(await first.seeder._served.get(m.key).core.has(2))
    members.push(m)
  }
  await first.seeder.close()

  const second = newSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const s = second.seeder
  let active = 0
  let peak = 0
  const prepare = s._prepareDiary.bind(s)
  s._prepareDiary = async (...args) => {
    active++
    peak = Math.max(peak, active)
    try {
      return await prepare(...args)
    } finally {
      active--
    }
  }
  const atDownload = []
  const downloader = s._downloader.bind(s)
  s._downloader = (core, deleted) => {
    atDownload.push(core.has(2))
    return downloader(core, deleted)
  }
  await s.start()
  t.ok(peak >= 1 && peak <= 2, 'at most 2 diaries prepared at once (peak ' + peak + ')')
  t.is(atDownload.length, members.length, 'every stored diary was prepared')
  t.alike(await Promise.all(atDownload), members.map(() => false), 'each deleted block was cleared before its download began')
  for (const m of members) t.is(s._served.get(m.key).present, 4, 'the present length skips the hole')
})
