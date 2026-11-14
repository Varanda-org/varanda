'use strict'

// The seeder's public share gate (packages/core/lib/seeder.js, the
// post-share branch of _runScan and postPublic): a post is shown to people
// without an account only while the highest share the scan recorded for it
// is live, the post itself is a live post of a visible person's diary, and
// nothing changed while the answer was being read (docs/protocol.md
// section 2, "Public share").
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
const { memberCertRecord, postRecord, profileRecord, deleteRecord, postShareRecord } = require('../lib/records')
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

function del (seq, i) {
  return deleteRecord({ seq, at: at(i) })
}

// A verified @nome for `key`, signed by an issuer the association delegated.
function usernameFor (assoc, key, username) {
  const issuerKp = crypto.keyPair()
  const issuerCert = cert.createIssuerCert({ issuer: hex(issuerKp.publicKey), date: at(0) }, assoc.kp)
  return cert.createUsernameRecord({ member: key, username, date: at(0) }, issuerKp, issuerCert)
}

// A member on the swarm with its diary. `records(key)` follow block 0.
async function member (t, bootstrap, assoc, { records = () => [] } = {}) {
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
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const message = (pred, name, timeoutMs = 20000) => until(() => messages.find(pred), { name, timeoutMs })
  return { store, diary, key, swarm, peers, messages, seederPeer, message }
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
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: () => {}, associationKey: assoc.hex })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { bootstrap, assoc, seeder }
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
  t.alike(Object.keys(got).sort(), ['name', 'record', 'shareSeq', 'username'])

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
  t.is(await seeder.postPublic(A.key, 3), null, 'a page diary')
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

  // The page flag lives in the name index: while it is behind, a page reads
  // as a person, so a shared post of any diary waits.
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
  // still not read the last block (a page roster, say).
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

  const hint = seeder._names.hint
  during(() => { seeder._names.hint = (k) => k === A.key ? { page: true, closed: false, moved: false } : hint(k) })
  t.is(await seeder.postPublic(A.key, 3), null, 'known as a page meanwhile')
  seeder._names.hint = hint

  seeder._liveRecord = live
  t.alike(await seeder.postPublic(A.key, 3), first, 'shown again with nothing changing')
})
