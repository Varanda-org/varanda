'use strict'

// #225 media: the photos, previews (post-thumbs) and covers (post-cover) of
// a post the association hid are refused by the seeder's mediaRead and
// leave its media cores, at runtime and after a restart, while a block a
// surviving record shows stays served. An unhide brings them back on the
// next serve.
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
const { createHiddenList } = require('../lib/blocklist')
const { attachBlocklist, PROTOCOL_HIDDEN } = require('../lib/blocklist-net')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('../lib/net')
const { memberCertRecord, postRecord, postThumbsRecord, postCoverRecord, mediaCoreRecord, MEDIA_BLOCK_BYTES } = require('../lib/records')
const { mediaHeader } = require('../lib/media')
const { writeHiddenList } = require('../lib/store')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function makeModerator (assoc) {
  const kp = signingKeyPair()
  return { kp, cert: createModeratorCert({ moderator: hex(kp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp) }
}

function hideList (mod, seq, author, seqs) {
  return createHiddenList({ seq, hiddenPosts: seqs.map((s) => ({ author, seq: s })) }, mod.kp, mod.cert)
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

async function startSeeder (t, bootstrap, dataDir, opts = {}) {
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), ...opts })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events }
}

const BASE_MS = Date.parse('2026-03-01T12:00:00.000Z')
function at (i) {
  return new Date(BASE_MS + i * 1000).toISOString()
}

function photo (core, start) {
  return { core, mime: 'image/jpeg', start, blocks: 1, bytes: MEDIA_BLOCK_BYTES, sha256: 'ab'.repeat(32), width: 100, height: 100 }
}

function thumb (core, start) {
  return { core, mime: 'image/jpeg', start, blocks: 1, bytes: 1000, sha256: 'cd'.repeat(32), width: 64, height: 64 }
}

function cover (core, start) {
  return { core, mime: 'image/jpeg', start, blocks: 1, bytes: 2000, sha256: 'ef'.repeat(32), width: 600, height: 315 }
}

// A member on the association topic: its diary (certificate, then
// `records(K)`) and one media core K of `media` raw blocks after its header.
async function member (t, bootstrap, assoc, { media, records }) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  const mcore = store.get({ name: 'media-0' })
  await mcore.ready()
  await mcore.append(b4a.from(JSON.stringify(mediaHeader({ diary: key }))))
  for (let i = 0; i < media; i++) await mcore.append(b4a.alloc(MEDIA_BLOCK_BYTES, i + 1))
  const K = hex(mcore.key)
  await diary.append(memberCertRecord(createCert({ member: key }, assoc.kp)))
  for (const r of records(K)) await diary.append(r)
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
  const message = (pred, name) => until(() => messages.find(pred), { name, timeoutMs: 20000 })
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  return { store, diary, key, K, mcore, swarm, messages, message, seederPeer }
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: createCert({ member: m.key }, assoc.kp) })
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

async function append (m, records) {
  for (const r of records) await m.diary.append(r)
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

// A node that hands the seeder a hidden-posts list (varanda/blocklist/2).
async function pushList (t, bootstrap, seederKey, list) {
  const store = new Corestore(tmpDir(t, 'varanda-mod-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    attachBlocklist(socket, {
      protocol: PROTOCOL_HIDDEN,
      current: () => list,
      offer: async () => ({ adopted: false, reason: 'same', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set(), hiddenAdded: new Set(), hiddenRemoved: new Set() })
    })
    attachAdmission(socket, { role: 'member', have: [] })
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  return swarm
}

// The diary scan reached the member's length and the media core holds
// `blocks` (header included) and passed its local re-gate.
async function ready (seeder, m, blocks) {
  await until(() => seeder._mediaServed.get(m.K)?.core.contiguousLength >= blocks, { name: 'mídia baixada', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(m.K)?.headerOk === true, { name: 'mídia conferida' })
  await settled(seeder, m)
}

function settled (seeder, m) {
  return until(() => {
    const entry = seeder._served.get(m.key)
    return entry && entry.scanned >= m.diary.length
  }, { name: 'diário lido até ' + m.diary.length })
}

async function served (seeder, m, start) {
  return (await seeder.mediaRead(m.key, m.K, start, 1)) !== null
}

test('the photos, previews and covers of a hidden post are refused and cleared; a block a surviving post shows stays served', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  // Post 2 shows photos 1 and 4, its previews are 2 and 5, its cover 3;
  // post 5 shows photo 4 too.
  const A = await member(t, bootstrap, assoc, {
    media: 5,
    records: (K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'oculto', media: [photo(K, 1), photo(K, 4)], at: at(1) }),
      postThumbsRecord({ seq: 2, thumbs: [thumb(K, 2), thumb(K, 5)], at: at(1) }),
      postCoverRecord({ seq: 2, image: cover(K, 3), at: at(2) }),
      postRecord({ text: 'fica', media: [photo(K, 4)], at: at(3) })
    ]
  })
  await admit(A, assoc)
  await ready(seeder, A, 6)
  for (let b = 1; b <= 5; b++) t.ok(await served(seeder, A, b), 'block ' + b + ' served before the hide')

  await pushList(t, bootstrap, publicKey, hideList(makeModerator(assoc), 1, A.key, [2]))
  const entry = seeder._served.get(A.key)
  await until(() => entry.hiddenSeqs.has(2), { name: 'post 2 oculto' })
  t.absent(await served(seeder, A, 1), 'the photo is refused')
  t.absent(await served(seeder, A, 2), 'its preview is refused')
  t.absent(await served(seeder, A, 5), 'and the other preview')
  t.absent(await served(seeder, A, 3), 'its cover is refused')
  t.ok(await served(seeder, A, 4), 'the photo another post shows stays served')
  t.absent(await seeder.mediaRead(A.key, A.K, 1, 2), 'a span over a hidden block is refused')
  const mcore = seeder._mediaServed.get(A.K).core
  await until(async () => !(await mcore.has(1)) && !(await mcore.has(2)) && !(await mcore.has(3)) && !(await mcore.has(5)), { name: 'mídia oculta apagada' })
  t.ok(await mcore.has(4), 'the shared block keeps its bytes')
  t.ok(await mcore.has(0), 'the header is never cleared')
  t.ok(seeder._mediaServed.get(A.K).excluded.has(1), 'left out of the media download')
})

test('a preview and a cover written after the hide are refused as they arrive', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const A = await member(t, bootstrap, assoc, {
    media: 4,
    records: (K) => [mediaCoreRecord({ key: K, at: at(0) }), postRecord({ text: 'oculto', media: [photo(K, 1)], at: at(1) })]
  })
  await admit(A, assoc)
  await ready(seeder, A, 5)
  t.ok(await served(seeder, A, 1), 'served before the hide')

  await pushList(t, bootstrap, publicKey, hideList(makeModerator(assoc), 1, A.key, [2]))
  const entry = seeder._served.get(A.key)
  await until(() => entry.hiddenSeqs.has(2), { name: 'post 2 oculto' })
  t.absent(await served(seeder, A, 1), 'the photo is refused')

  await append(A, [
    postThumbsRecord({ seq: 2, thumbs: [thumb(A.K, 2)], at: at(2) }),
    postCoverRecord({ seq: 2, image: cover(A.K, 3), at: at(3) }),
    postRecord({ text: 'fica', media: [photo(A.K, 4)], at: at(4) })
  ])
  await settled(seeder, A)
  t.absent(await served(seeder, A, 2), 'the preview written after the hide is refused')
  t.absent(await served(seeder, A, 3), 'the cover written after the hide is refused')
  t.ok(await served(seeder, A, 4), 'a later post keeps its photo')
  const mcore = seeder._mediaServed.get(A.K).core
  await until(async () => !(await mcore.has(2)) && !(await mcore.has(3)), { name: 'prévia e capa apagadas' })
  t.ok(await mcore.has(4))
})

test('a list adopted before the diary arrives refuses the preview and cover of a post the seeder never held', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const A = await member(t, bootstrap, assoc, {
    media: 4,
    records: (K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'oculto', media: [photo(K, 1)], at: at(1) }),
      postThumbsRecord({ seq: 2, thumbs: [thumb(K, 2)], at: at(1) }),
      postCoverRecord({ seq: 2, image: cover(K, 3), at: at(2) }),
      postRecord({ text: 'fica', media: [photo(K, 4)], at: at(3) })
    ]
  })
  writeHiddenList(dataDir, hideList(makeModerator(assoc), 1, A.key, [2]))
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await admit(A, assoc)
  await until(() => seeder._mediaServed.get(A.K)?.headerOk === true, { name: 'mídia conferida', timeoutMs: 30000 })
  await settled(seeder, A)
  const entry = seeder._served.get(A.key)
  t.ok(entry.hiddenSeqs.has(2), 'hidden from the serve on')
  t.absent(await entry.core.has(2), 'the hidden post is never fetched')
  t.absent(await served(seeder, A, 2), 'its preview is refused')
  t.absent(await served(seeder, A, 3), 'its cover is refused')
  t.ok(await served(seeder, A, 4), 'the other post keeps its photo')
})

test('after a restart the media of a hidden post stay refused and are never fetched back', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const A = await member(t, bootstrap, assoc, {
    media: 4,
    records: (K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'oculto', media: [photo(K, 1)], at: at(1) }),
      postThumbsRecord({ seq: 2, thumbs: [thumb(K, 2)], at: at(1) }),
      postCoverRecord({ seq: 2, image: cover(K, 3), at: at(2) }),
      postRecord({ text: 'fica', media: [photo(K, 4)], at: at(3) })
    ]
  })
  await admit(A, assoc)
  await ready(first.seeder, A, 5)
  const mod = await pushList(t, bootstrap, publicKey, hideList(makeModerator(assoc), 1, A.key, [2]))
  const one = first.seeder._served.get(A.key)
  const mcore1 = first.seeder._mediaServed.get(A.K).core
  await until(async () => !(await one.core.has(2)) && !(await mcore1.has(1)) && !(await mcore1.has(2)) && !(await mcore1.has(3)), { name: 'post e mídia apagados' })
  await first.seeder.close()
  await mod.destroy()

  // The author stays online with every block: only the seeder's own
  // bookkeeping keeps the hidden media out.
  const second = await startSeeder(t, bootstrap, dataDir)
  const media = second.seeder._mediaServed.get(A.K)
  for (const b of [1, 2, 3]) t.ok(media.excluded.has(b), 'block ' + b + ' left out of the download from the start')
  t.absent(media.excluded.has(4), 'the live photo is not')
  // The serve itself must know them: the scan may not have caught up when
  // the download opens (a long diary, a block still missing).
  const known = second.seeder._served.get(A.key).mediaStart.get(A.K) || new Set()
  for (const b of [1, 2, 3]) t.ok(known.has(b), 'block ' + b + ' known hidden at serve')
  t.absent(known.has(4), 'the live photo is not known hidden')
  // New media prove the download runs while the hidden blocks stay out.
  await A.mcore.append(b4a.alloc(MEDIA_BLOCK_BYTES, 9))
  await append(A, [postRecord({ text: 'nova', media: [photo(A.K, 5)], at: at(4) })])
  await until(async () => await media.core.has(5), { name: 'mídia nova baixada', timeoutMs: 30000 })
  await settled(second.seeder, A)
  for (const b of [1, 2, 3]) t.absent(await media.core.has(b), 'block ' + b + ' not fetched back')
  t.absent(await served(second.seeder, A, 1), 'the photo stays refused')
  t.absent(await served(second.seeder, A, 2), 'the preview stays refused')
  t.absent(await served(second.seeder, A, 3), 'the cover stays refused')
  t.ok(await served(second.seeder, A, 4), 'the live photo is served')
  t.ok(await served(second.seeder, A, 5), 'and the new one')
  t.absent(await second.seeder._served.get(A.key).core.has(2), 'the hidden post stays cleared')
})

test('with noClear the media of a hidden post keep their bytes and stay refused, after a restart too', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, noClear: true })
  const A = await member(t, bootstrap, assoc, {
    media: 4,
    records: (K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'oculto', media: [photo(K, 1)], at: at(1) }),
      postThumbsRecord({ seq: 2, thumbs: [thumb(K, 2)], at: at(1) }),
      postCoverRecord({ seq: 2, image: cover(K, 3), at: at(2) }),
      postRecord({ text: 'fica', media: [photo(K, 4)], at: at(3) })
    ]
  })
  await admit(A, assoc)
  await ready(first.seeder, A, 5)
  const mod = await pushList(t, bootstrap, publicKey, hideList(makeModerator(assoc), 1, A.key, [2]))
  const check = async (seeder, when) => {
    const entry = seeder._served.get(A.key)
    await until(() => entry.hiddenSeqs.has(2), { name: 'post 2 oculto ' + when })
    await settled(seeder, A)
    for (const b of [1, 2, 3]) t.absent(await served(seeder, A, b), 'block ' + b + ' refused ' + when)
    t.ok(await served(seeder, A, 4), 'the live photo is served ' + when)
    const mcore = seeder._mediaServed.get(A.K).core
    for (const b of [1, 2, 3, 4]) t.ok(await mcore.has(b), 'block ' + b + ' keeps its bytes ' + when)
    t.ok(await entry.core.has(2), 'the post keeps its bytes ' + when)
  }
  await check(first.seeder, 'at runtime')
  await first.seeder.close()
  await mod.destroy()
  const second = await startSeeder(t, bootstrap, dataDir, { noClear: true })
  await check(second.seeder, 'after the restart')
})

test('an unhide serves the media again on the next serve, once the post and its media are back', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const A = await member(t, bootstrap, assoc, {
    media: 2,
    records: (K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'oculto', media: [photo(K, 1)], at: at(1) }),
      postRecord({ text: 'fica', media: [photo(K, 2)], at: at(2) })
    ]
  })
  await admit(A, assoc)
  await ready(first.seeder, A, 3)
  const mod = makeModerator(assoc)
  const hider = await pushList(t, bootstrap, publicKey, hideList(mod, 1, A.key, [2]))
  const one = first.seeder._served.get(A.key)
  const mcore1 = first.seeder._mediaServed.get(A.K).core
  await until(async () => !(await one.core.has(2)) && !(await mcore1.has(1)), { name: 'post e foto apagados' })
  await hider.destroy()
  // A newer list without the post: this serve keeps refusing it.
  await pushList(t, bootstrap, publicKey, createHiddenList({ seq: 2 }, mod.kp, mod.cert))
  await until(() => first.seeder._blocklist.currentHidden().seq === 2, { name: 'lista nova adotada' })
  t.absent(await served(first.seeder, A, 1), 'still refused until the next serve')
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir)
  const entry = second.seeder._served.get(A.key)
  t.absent(entry.hiddenSeqs.has(2), 'no longer hidden')
  const media = second.seeder._mediaServed.get(A.K)
  t.absent(media.excluded.has(1), 'the photo is back in the download')
  await until(async () => await entry.core.has(2) && await media.core.has(1), { name: 'post e foto de volta', timeoutMs: 30000 })
  await settled(second.seeder, A)
  t.ok(await served(second.seeder, A, 1), 'the photo is served again')
  t.ok(await served(second.seeder, A, 2))
})

test('seeder recount counts a hidden post, its preview and its cover as deleted, for a hide made while it runs too', async (t) => {
  const key = 'aa'.repeat(32)
  const K = 'bb'.repeat(32)
  const json = (r) => r === null ? null : b4a.from(JSON.stringify(r))
  const blocks = [
    null,
    mediaCoreRecord({ key: K }),
    postRecord({ text: 'oculto', media: [photo(K, 1)] }),
    postThumbsRecord({ seq: 2, thumbs: [thumb(K, 2)] }),
    postCoverRecord({ seq: 2, image: cover(K, 3) }),
    postRecord({ text: 'fica', media: [photo(K, 4)] })
  ]
  let hideAt = 4
  const entry = {
    dropped: false,
    scanned: blocks.length,
    latest: [{ key: K }],
    mediaRecounts: 0,
    gone: new Set(),
    tombstones: new Map(),
    mediaIrregular: false,
    hiddenSeqs: new Set(),
    hiddenRanges: new Map(),
    core: {
      get: async (i) => {
        // The list hides post 2 once the recount has read it and its preview.
        if (i === hideAt) {
          entry.hiddenSeqs.add(2)
          entry.hiddenRanges.set(2, [{ core: K, start: 1, blocks: 1 }])
        }
        return json(blocks[i])
      }
    }
  }
  const seeder = Object.create(Seeder.prototype)
  seeder._served = new Map([[key, entry]])
  seeder._closing = false
  const check = (when) => {
    const state = entry.media.get(K)
    for (const b of [1, 2, 3]) {
      t.absent(state.live.has(b), 'block ' + b + ' not live ' + when)
      t.is(state.del.get(b), 1, 'block ' + b + ' deleted once ' + when)
    }
    t.is(state.live.get(4), 1, 'the other post stays live ' + when)
    t.is(state.dead, 3)
    t.absent(entry.mediaRefs.has(2) || entry.mediaRefs.has(3) || entry.mediaRefs.has(4))
  }
  await seeder._recountMedia(key, entry)
  check('for a hide during the recount')
  hideAt = -1
  await seeder._recountMedia(key, entry)
  check('for a hide before the recount')
  // Cleared since: the kept ranges stand in for the block.
  blocks[2] = null
  entry.gone.add(2)
  await seeder._recountMedia(key, entry)
  check('for a cleared hidden post')
  t.alike([...entry.coversOf.get(2).keys()], [4])
})
