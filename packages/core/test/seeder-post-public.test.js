'use strict'

// The seeder's public share gate (packages/core/lib/seeder.js, the
// post-share branch of _runScan and postPublic): a post is shown to people
// without an account only while the highest share the scan recorded for it
// is live, the post itself is a live post of a visible diary (a person's or
// an open page's, seeder-post-page.test.js), and nothing changed while the
// answer was being read (docs/protocol.md section 2, "Public share"). The
// post-cover branch adds the post's cover image, which never withdraws the
// post, and keeps the cover's media range live in the seeder's counters.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const cert = require('../lib/cert')
const { createCert, createSeederCert, generateAssociationKeyPair } = cert
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('../lib/net')
const { memberCertRecord, postRecord, profileRecord, deleteRecord, postShareRecord, postCoverRecord, mediaCoreRecord, MEDIA_BLOCK_BYTES } = require('../lib/records')
const { mediaHeader } = require('../lib/media')
const { POST_SHARES_PER_DIARY } = require('../lib/post-share')

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

const BASE_MS = Date.parse('2026-03-01T12:00:00.000Z')
function at (i) {
  return new Date(BASE_MS + i * 1000).toISOString()
}

function post (text, i) {
  return postRecord({ text, at: at(i) })
}

function share (seq, i) {
  return postShareRecord({ seq, at: at(i) })
}

function del (seq, i, media) {
  return deleteRecord({ seq, at: at(i), media })
}

function descriptor (core, start, blocks) {
  return { core, mime: 'image/jpeg', start, blocks, bytes: blocks * MEDIA_BLOCK_BYTES, sha256: 'ab'.repeat(32), width: 100, height: 100 }
}

function cover (seq, image, i) {
  return postCoverRecord({ seq, image, at: at(i) })
}

// A verified @nome for `key`, signed by an issuer the association delegated.
function usernameFor (assoc, key, username) {
  const issuerKp = crypto.keyPair()
  const issuerCert = cert.createIssuerCert({ issuer: hex(issuerKp.publicKey), date: at(0) }, assoc.kp)
  return cert.createUsernameRecord({ member: key, username, date: at(0) }, issuerKp, issuerCert)
}

// A member on the swarm with its diary. `records(key, mediaKey)` follow
// block 0; with `media`, one media core of that many raw blocks after its
// header (mediaKey, else null).
async function member (t, bootstrap, assoc, { records = () => [], media = 0 } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  let mediaKey = null
  if (media > 0) {
    const core = store.get({ name: 'media' })
    await core.ready()
    await core.append(b4a.from(JSON.stringify(mediaHeader({ diary: key }))))
    for (let i = 0; i < media; i++) await core.append(b4a.alloc(MEDIA_BLOCK_BYTES, i + 1))
    mediaKey = hex(core.key)
  }
  await diary.append(memberCertRecord(validCert(assoc, key)))
  for (const r of records(key, mediaKey)) await diary.append(r)

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
  return { store, diary, key, mediaKey, swarm, peers, messages, seederPeer, message }
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

// The scan and engagement cursors of m's diary reached its length (the
// engagement index gives postPublic the profile and @nome hints).
function settled (seeder, m) {
  return until(() => {
    const entry = seeder._served.get(m.key)
    const length = m.diary.length
    return entry && !entry.scanQueued && entry.scanned >= length && entry.indexed >= length
  }, { name: 'diário processado até ' + m.diary.length })
}

async function setup (t) {
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), associationKey: assoc.hex })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { bootstrap, assoc, seeder, events }
}

// m's media core is bound to m's diary at the seeder.
function bound (seeder, m) {
  return until(() => seeder._media.get(m.mediaKey)?.diary === m.key, { name: 'mídia vinculada', timeoutMs: 30000 })
}

// m's media core is bound, holds block `last` and is re-gated (mediaRead
// serves nothing before _gateMedia), and m's diary is settled.
async function mediaReady (seeder, m, last) {
  await bound(seeder, m)
  await until(async () => (await seeder._mediaServed.get(m.mediaKey)?.core.has(last)) === true, { name: 'mídia baixada' })
  await until(() => seeder._mediaServed.get(m.mediaKey)?.headerOk === true, { name: 'mídia conferida' })
  await settled(seeder, m)
}

// Whether mediaRead comes to serve the range: its blocks may still be
// downloading, and a range counted as deleted is never fetched at all.
async function served (seeder, m, start, blocks) {
  try {
    await until(async () => (await seeder.mediaRead(m.key, m.mediaKey, start, blocks)) !== null, { name: 'mídia servida', timeoutMs: 10000 })
    return true
  } catch {
    return false
  }
}

test('postPublic shows a shared post with its author, and null for every other block, input or diary state', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const future = new Date(Date.now() + 25 * 3600 * 1000).toISOString()
  const A = await member(t, bootstrap, assoc, {
    records: (key) => [
      profileRecord({ name: 'Ana', at: at(1) }), // 1
      usernameFor(assoc, key, 'ana_maria'), // 2
      post('público', 3), // 3
      post('sem share', 4), // 4
      share(3, 5), // 5
      postRecord({ text: 'do futuro', at: future }), // 6
      share(6, 7), // 7
      share(1, 8) // 8: names a profile, not a post
    ]
  })
  await admit(A, assoc)
  await settled(seeder, A)

  const got = await seeder.postPublic(A.key, 3)
  t.ok(got, 'a live share shows the post')
  t.is(got.record.type, 'post')
  t.is(got.record.text, 'público')
  t.is(got.record.at, at(3))
  t.is(got.name, 'Ana')
  t.is(got.username, 'ana_maria')
  t.is(got.shareSeq, 5)
  t.is(got.cover, null, 'no cover')
  t.is(got.coverSeq, null)
  t.alike(Object.keys(got).sort(), ['cover', 'coverSeq', 'name', 'record', 'shareSeq', 'username'])

  t.is(await seeder.postPublic(A.key, 4), null, 'a post with no share')
  t.is(await seeder.postPublic(A.key, 5), null, 'the share block itself')
  t.is(await seeder.postPublic(A.key, 6), null, 'a post dated more than 24 h ahead')
  t.is(await seeder.postPublic(A.key, 1), null, 'a share of a block that is not a post')
  t.is(await seeder.postPublic(A.key, 99), null, 'a seq past the log')

  for (const [h, s] of [[A.key, 0], [A.key, -3], [A.key, 3.5], [A.key, '3'], [A.key, Number.MAX_SAFE_INTEGER + 1], [A.key.toUpperCase(), 3], [A.key.slice(1), 3], [null, 3], ['f'.repeat(64), 3]]) {
    t.is(await seeder.postPublic(h, s), null, 'malformed or unserved: ' + String(h).slice(0, 8) + ' ' + String(s))
  }

  const entry = seeder._served.get(A.key)

  // A hint naming a share whose seq is another post's: the share is read
  // back and must name this very post.
  entry.shares.set(4, 5)
  t.is(await seeder.postPublic(A.key, 4), null, 'a share naming another seq')
  entry.shares.delete(4)

  const hint = seeder._names.hint
  seeder._names.hint = (k) => k === A.key ? { page: true, closed: false, moved: false } : hint(k)
  t.is((await seeder.postPublic(A.key, 3)).shareSeq, 5, 'an open page diary is shown like a person')
  seeder._names.hint = hint

  const endSeq = seeder._names.endSeq
  seeder._names.endSeq = (k) => k === A.key ? 1 : endSeq(k)
  t.is(await seeder.postPublic(A.key, 3), null, 'a closed or moved page')
  seeder._names.endSeq = endSeq

  entry.searchHold = 1
  t.is(await seeder.postPublic(A.key, 3), null, 'a diary held by a pending re-gate')
  entry.searchHold = 0

  const isBlocked = seeder._isBlocked
  seeder._isBlocked = (k) => k === A.key || isBlocked.call(seeder, k)
  t.is(await seeder.postPublic(A.key, 3), null, 'a blocked diary')
  seeder._isBlocked = isBlocked

  const scanned = entry.scanned
  entry.scanned = entry.core.length - 1
  t.is(await seeder.postPublic(A.key, 3), null, 'a scan not caught up')
  entry.scanned = scanned

  // A page's close or move lives in the name index: while it is behind, a
  // closed page reads as open, so a shared post of any diary waits.
  const indexed = entry.indexed
  const liveRecord = seeder._liveRecord
  let reads = 0
  seeder._liveRecord = function (...args) {
    reads++
    return liveRecord.apply(this, args)
  }
  entry.indexed = entry.present - 1
  t.is(await seeder.postPublic(A.key, 3), null, 'a name index not read to the end')
  t.is(reads, 0, 'refused before reading any block')
  seeder._liveRecord = liveRecord
  entry.indexed = indexed
  entry.indexPaused = true
  t.is(await seeder.postPublic(A.key, 3), null, 'a name index paused at its cap')
  entry.indexPaused = false

  // The present length is raised asynchronously and can lag the signed
  // length after the scan reached it: an index at the present length has
  // still not read the last block (a page close, say).
  const present = entry.present
  t.ok(entry.scanned >= entry.core.length, 'the scan is caught up')
  entry.present = entry.core.length - 1
  entry.indexed = entry.core.length - 1
  t.is(await seeder.postPublic(A.key, 3), null, 'a name index at a present length behind the signed length')
  entry.present = present
  entry.indexed = indexed

  t.is((await seeder.postPublic(A.key, 3)).shareSeq, 5, 'shown again once every stub is gone')

  seeder._drop(A.key, 'blocked')
  t.is(await seeder.postPublic(A.key, 3), null, 'a dropped diary')
})

test('postPublic follows shares appended later: unshare, share again, a deleted post and the per-diary cap', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const A = await member(t, bootstrap, assoc, { records: () => [post('um', 1), post('dois', 2)] })
  await admit(A, assoc)
  await settled(seeder, A)
  t.is(await seeder.postPublic(A.key, 1), null, 'no share yet')

  await append(A, [share(1, 3)]) // 3
  await settled(seeder, A)
  t.is((await seeder.postPublic(A.key, 1)).shareSeq, 3, 'a share appended after the first scan is seen by the next')

  await append(A, [del(3, 4)]) // 4
  await settled(seeder, A)
  t.is(await seeder.postPublic(A.key, 1), null, 'the only share tombstoned')

  await append(A, [share(1, 5)]) // 5
  await settled(seeder, A)
  const again = await seeder.postPublic(A.key, 1)
  t.is(again.shareSeq, 5, 'shared again: the new share')
  t.is(again.record.text, 'um')

  await append(A, [share(2, 6)]) // 6
  await settled(seeder, A)
  t.is((await seeder.postPublic(A.key, 2)).shareSeq, 6)
  await append(A, [del(2, 7)]) // 7
  await settled(seeder, A)
  t.is(await seeder.postPublic(A.key, 2), null, 'the post deleted under a live share')
  t.is((await seeder.postPublic(A.key, 1)).shareSeq, 5, 'another post keeps its share')

  // The real cap through the scan: a map already holding POST_SHARES_PER_DIARY
  // posts refuses a share of a new one, which is then never shown.
  const entry = seeder._served.get(A.key)
  t.is(entry.sharesOverflow, false)
  for (let i = 0; entry.shares.size < POST_SHARES_PER_DIARY; i++) entry.shares.set(100000 + i, 100000 + i)
  await append(A, [post('três', 8), share(8, 9)]) // 8, 9
  await settled(seeder, A)
  t.is(entry.sharesOverflow, true, 'the scan flagged the overflow')
  t.absent(entry.shares.has(8), 'the new post was not recorded')
  t.is(await seeder.postPublic(A.key, 8), null, 'a post past the cap is never shown')
  await append(A, [share(1, 10)]) // 10
  await settled(seeder, A)
  t.is((await seeder.postPublic(A.key, 1)).shareSeq, 10, 'a recorded post still takes a newer share at the cap')
})

test('a tombstoned newer share hides the post even under a live older share (fails closed)', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  // Two live shares of one post: only another program writes this
  // (post.share appends one only when none is live).
  const A = await member(t, bootstrap, assoc, { records: () => [post('um', 1), share(1, 2), share(1, 3)] })
  await admit(A, assoc)
  await settled(seeder, A)
  t.is((await seeder.postPublic(A.key, 1)).shareSeq, 3, 'the highest share')

  // The seeder scanned share 3 before its tombstone arrived, so it keeps 3
  // as the highest and hides the post although share 2 is still live. A
  // fresh seeder that meets this diary only after the tombstone never
  // downloads block 3, keeps share 2 and may legitimately show the post:
  // any live share counts (docs/protocol.md section 2, "Public share").
  await append(A, [del(3, 4)])
  await settled(seeder, A)
  t.is(seeder._served.get(A.key).shares.get(1), 3, 'tombstones never touch the hint')
  t.is(await seeder.postPublic(A.key, 1), null, 'hidden while the highest share is tombstoned')
})

test('postPublic answers null when the share, the post or the diary changed while it read', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const A = await member(t, bootstrap, assoc, {
    records: (key) => [
      profileRecord({ name: 'Ana', at: at(1) }), // 1
      usernameFor(assoc, key, 'ana_maria'), // 2
      post('um', 3), // 3
      share(3, 4) // 4
    ]
  })
  await admit(A, assoc)
  await settled(seeder, A)
  const first = await seeder.postPublic(A.key, 3)
  t.is(first.name, 'Ana')
  t.is(first.username, 'ana_maria')
  const entry = seeder._served.get(A.key)
  const live = seeder._liveRecord

  // `meanwhile` runs once block `at` has been read. The @nome read (block
  // 2) is the last await: what changes there only the re-check after the
  // awaits can see.
  const during = (meanwhile, onSeq = 2) => {
    seeder._liveRecord = async function (hex, seq) {
      const r = await live.call(this, hex, seq)
      if (seq === onSeq) meanwhile()
      return r
    }
  }
  const tombstone = (target) => {
    entry.tombstones.set(999, target)
    entry.effective = null
  }
  const untombstone = () => {
    entry.tombstones.delete(999)
    entry.effective = null
  }

  during(() => tombstone(4))
  t.is(await seeder.postPublic(A.key, 3), null, 'the share tombstoned during the name lookup')
  untombstone()

  during(() => tombstone(3))
  t.is(await seeder.postPublic(A.key, 3), null, 'the post tombstoned during the name lookup')
  untombstone()

  during(() => tombstone(1))
  const noName = await seeder.postPublic(A.key, 3)
  t.ok(noName, 'a profile deleted meanwhile does not withdraw the post')
  t.is(noName.name, null, 'but its name is gone')
  t.is(noName.username, 'ana_maria')
  untombstone()

  during(() => tombstone(2))
  const noUsername = await seeder.postPublic(A.key, 3)
  t.ok(noUsername, 'an @nome deleted meanwhile does not withdraw the post')
  t.is(noUsername.username, null, 'but the @nome is gone')
  t.is(noUsername.name, 'Ana')
  untombstone()

  during(() => entry.shares.set(3, 50))
  t.is(await seeder.postPublic(A.key, 3), null, 'a newer share recorded meanwhile')
  entry.shares.set(3, 4)

  const scanned = entry.scanned
  during(() => { entry.scanned = entry.core.length - 1 })
  t.is(await seeder.postPublic(A.key, 3), null, 'the scan fell behind meanwhile')
  entry.scanned = scanned

  const indexed = entry.indexed
  during(() => { entry.indexed = entry.present - 1 })
  t.is(await seeder.postPublic(A.key, 3), null, 'the name index fell behind meanwhile')
  entry.indexed = indexed

  during(() => { entry.searchHold = 1 })
  t.is(await seeder.postPublic(A.key, 3), null, 'a hold started meanwhile')
  entry.searchHold = 0

  const isBlocked = seeder._isBlocked
  during(() => { seeder._isBlocked = (k) => k === A.key || isBlocked.call(seeder, k) })
  t.is(await seeder.postPublic(A.key, 3), null, 'blocked meanwhile')
  seeder._isBlocked = isBlocked

  during(() => { seeder._served.set(A.key, { ...entry }) })
  t.is(await seeder.postPublic(A.key, 3), null, 're-served meanwhile')
  seeder._served.set(A.key, entry)

  const endSeq = seeder._names.endSeq
  during(() => { seeder._names.endSeq = (k) => k === A.key ? 1 : endSeq(k) })
  t.is(await seeder.postPublic(A.key, 3), null, 'known as a closed or moved page meanwhile')
  seeder._names.endSeq = endSeq

  seeder._liveRecord = live
  t.alike(await seeder.postPublic(A.key, 3), first, 'shown again with nothing changing')
})

test('postPublic returns the live cover of a shared post, and a cover in doubt only drops the image', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const A = await member(t, bootstrap, assoc, {
    media: 2,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }), // 1
      postRecord({ text: 'um', at: at(2), media: [descriptor(K, 1, 1)] }), // 2
      share(2, 3), // 3
      cover(2, descriptor(K, 1, 1), 4), // 4
      postRecord({ text: 'dois', at: at(5), media: [descriptor(K, 1, 1)] }), // 5
      share(5, 6), // 6
      cover(5, descriptor(K, 1, 1), 7), // 7: older, still live
      cover(5, descriptor(K, 2, 1), 8), // 8: newer, tombstoned below
      del(8, 9), // 9
      post('três', 10), // 10
      share(10, 11), // 11
      post('quatro', 12), // 12
      share(12, 13), // 13
      del(13, 14), // 14
      cover(12, descriptor(K, 2, 1), 15) // 15: a cover with no live share
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await bound(seeder, A)
  await settled(seeder, A)

  const got = await seeder.postPublic(A.key, 2)
  t.ok(got, 'a shared post with a cover')
  t.is(got.record.text, 'um')
  t.is(got.shareSeq, 3)
  t.alike(got.cover, descriptor(K, 1, 1), 'the cover image')
  t.is(got.coverSeq, 4)

  const hidden = await seeder.postPublic(A.key, 5)
  t.ok(hidden, 'a tombstoned cover never withdraws the post')
  t.is(hidden.record.text, 'dois')
  t.is(hidden.cover, null, 'the highest cover is tombstoned: no cover, the older live one included')
  t.is(hidden.coverSeq, null)

  const bare = await seeder.postPublic(A.key, 10)
  t.is(bare.cover, null, 'a post with no cover')
  t.is(bare.coverSeq, null)

  t.is(await seeder.postPublic(A.key, 12), null, 'a cover with no live share is never public')
  t.is(await seeder.postPublic(A.key, 4), null, 'the cover block itself')
  t.is(await seeder.postPublic(A.key, 15), null)

  const entry = seeder._served.get(A.key)
  t.is(entry.covers.get(5), 8, 'tombstones never touch the cover hint')

  // A hint naming a cover whose seq is another post's: the cover is read
  // back and must name this very post.
  entry.covers.set(10, 4)
  const other = await seeder.postPublic(A.key, 10)
  t.ok(other, 'a cover naming another post keeps the post')
  t.is(other.cover, null, 'and gives no cover')
  entry.covers.delete(10)

  // mediaRead serves only a core bound to this diary.
  const binding = seeder._media.get(K)
  seeder._media.set(K, { ...binding, diary: 'f'.repeat(64) })
  const foreign = await seeder.postPublic(A.key, 2)
  t.ok(foreign, 'a cover in a core bound elsewhere keeps the post')
  t.is(foreign.cover, null, 'and gives no cover')
  t.is(foreign.coverSeq, null)
  seeder._media.set(K, binding)

  // A tombstone of the cover while the answer is read: the re-check after
  // the awaits drops the image and keeps the post.
  const live = seeder._liveRecord
  seeder._liveRecord = async function (hex, seq) {
    const r = await live.call(this, hex, seq)
    if (seq === 4) {
      entry.tombstones.set(999, 4)
      entry.effective = null
    }
    return r
  }
  const meanwhile = await seeder.postPublic(A.key, 2)
  t.ok(meanwhile, 'a cover tombstoned meanwhile keeps the post')
  t.is(meanwhile.cover, null, 'and gives no cover')
  seeder._liveRecord = live
  entry.tombstones.delete(999)
  entry.effective = null

  seeder._liveRecord = async function (hex, seq) {
    const r = await live.call(this, hex, seq)
    if (seq === 4) entry.covers.set(2, 50)
    return r
  }
  const newer = await seeder.postPublic(A.key, 2)
  t.ok(newer, 'a newer cover recorded meanwhile keeps the post')
  t.is(newer.cover, null, 'and gives no cover')
  seeder._liveRecord = live
  entry.covers.set(2, 4)

  t.alike(await seeder.postPublic(A.key, 2), got, 'shown again with nothing changing')

  // Another diary's cover in A's core: undeclared there, bound to A.
  const B = await member(t, bootstrap, assoc, {
    records: () => [postRecord({ text: 'b', at: at(1), media: [descriptor(K, 1, 1)] }), share(1, 2), cover(1, descriptor(K, 1, 1), 3)]
  })
  await admit(B, assoc)
  await settled(seeder, B)
  const fromB = await seeder.postPublic(B.key, 1)
  t.ok(fromB, 'a cover in an undeclared core keeps the post')
  t.is(fromB.cover, null, 'and gives no cover')
  t.is(fromB.coverSeq, null)
})

test('a diary with a post-cover and no post-share shows nothing (fails closed)', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const A = await member(t, bootstrap, assoc, {
    media: 1,
    records: (key, K) => [mediaCoreRecord({ key: K, at: at(0) }), post('privado', 2), cover(2, descriptor(K, 1, 1), 3)]
  })
  await admit(A, assoc)
  await bound(seeder, A)
  await settled(seeder, A)
  t.is(seeder._served.get(A.key).covers.get(2), 3, 'the cover was recorded')
  t.is(await seeder.postPublic(A.key, 2), null, 'a cover is not consent')
})

// The post shares its photo with its cover: the post's tombstone lists the
// range (hand-made, as an old client could write it), and the live cover
// must keep it served until its own tombstone frees it.
async function coverOverDeletedPost (t) {
  const { bootstrap, assoc, seeder } = await setup(t)
  const A = await member(t, bootstrap, assoc, {
    media: 2,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }), // 1
      postRecord({ text: 'foto', media: [descriptor(K, 1, 1)], at: at(2) }), // 2
      share(2, 3), // 3
      cover(2, descriptor(K, 1, 1), 4), // 4
      del(2, 5, [{ core: K, start: 1, blocks: 1 }]) // 5
    ]
  })
  await admit(A, assoc)
  await mediaReady(seeder, A, 2)
  return { seeder, A, K: A.mediaKey }
}

async function coverTombstoneFrees (t, seeder, A, K) {
  await append(A, [del(4, 6, [{ core: K, start: 1, blocks: 1 }])])
  await settled(seeder, A)
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null, 'freed by the cover\'s own tombstone')
  const mcore = seeder._mediaServed.get(K).core
  await until(async () => !(await mcore.has(1)), { name: 'mídia apagada' })
  t.ok(await mcore.has(2), 'a block nothing listed keeps its bytes')
}

test('a tombstone range over a live cover is not served as deleted until the cover\'s own tombstone', async (t) => {
  t.timeout(120000)
  const { seeder, A, K } = await coverOverDeletedPost(t)
  t.ok(await served(seeder, A, 1, 1), 'the live cover keeps the range served')
  t.is(await seeder.postPublic(A.key, 2), null, 'the deleted post is not public')
  await coverTombstoneFrees(t, seeder, A, K)
})

test('a media recount still counts a live cover over a tombstoned range', async (t) => {
  t.timeout(120000)
  const { seeder, A, K } = await coverOverDeletedPost(t)
  t.ok(await served(seeder, A, 1, 1), 'served before the recount')
  const entry = seeder._served.get(A.key)
  const recounts = entry.mediaRecounts
  await seeder._recountMedia(A.key, entry)
  t.is(entry.mediaRecounts, recounts + 1, 'the recount ran')
  t.absent(entry.mediaIrregular, 'the diary stays regular')
  t.ok(await seeder.mediaRead(A.key, K, 1, 1), 'the live cover keeps the range served after the recount')
  await coverTombstoneFrees(t, seeder, A, K)
})

test('D-FIX: public covers require a still in the post itself', async (t) => {
  const key = 'ab'.repeat(32)
  const image = descriptor('cd'.repeat(32), 1, 1)
  const entry = { core: { length: 4 }, scanned: 4, indexed: 4, shares: new Map([[1, 2]]), covers: new Map([[1, 3]]) }
  const records = new Map([[1, post('texto', 1)], [2, share(1, 2)], [3, cover(1, image, 3)]])
  const seeder = Object.assign(Object.create(Seeder.prototype), {
    _served: new Map([[key, entry]]),
    _media: new Map([[image.core, { diary: key }]]),
    _feiraVisible: () => true,
    _searchHeld: () => false,
    _names: { endUnverified: () => false },
    _index: { hints: () => ({ profileSeq: null, usernameSeq: null }) },
    _effectiveDeleted: () => new Set(),
    _liveRecord: async (_, seq) => records.get(seq) || null
  })
  const text = await seeder.postPublic(key, 1)
  t.ok(text, 'the text post remains public')
  t.is(text.cover, null, 'a live cover cannot decorate a text-only post')
  t.is(text.coverSeq, null)
  records.set(1, postRecord({ text: 'foto', media: [image], at: at(1) }))
  t.alike((await seeder.postPublic(key, 1)).cover, image, 'a post with a still keeps its cover')
})
