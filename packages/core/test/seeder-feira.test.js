'use strict'

// The seeder's Feira index (packages/core/lib/seeder.js, _runFeira, and
// lib/feira-index.js): listings, edits, statuses and consented ratings
// scanned from served diaries on a cursor of their own, read through
// indexFeira, indexFeiraAuthor, indexFeiraRatings, listingPublic and
// feiraRecent with blocked diaries and closed pages left out, and listing
// photos counted so a tombstone never frees a range a live listing shows.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { feira } = require('@varanda/rpc')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('../lib/net')
const {
  memberCertRecord, postRecord, deleteRecord, mediaCoreRecord, MEDIA_BLOCK_BYTES,
  listingRecord, listingEditRecord, listingStatusRecord, listingRateRecord
} = require('../lib/records')
const { mediaHeader } = require('../lib/media')
const { foldListings } = require('../lib/listing')

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

function ref (key, seq) {
  return key + ':' + seq
}

function refs (answer) {
  return answer.items.map((item) => item.ref)
}

const SP = { uf: 'SP', city: 'São Paulo', bairro: null }
const CAMPINAS = { uf: 'SP', city: 'Campinas', bairro: 'Centro' }

function listing (kind, title, cat, place, i, extra = {}) {
  return listingRecord({ kind, title, text: '', price: null, cat, place, at: at(i), ...extra })
}

function edit (seq, title, cat, place, i, extra = {}) {
  return listingEditRecord({ seq, title, text: '', price: null, cat, place, at: at(i), ...extra })
}

function descriptor (core, start, blocks) {
  return { core, mime: 'image/jpeg', start, blocks, bytes: blocks * MEDIA_BLOCK_BYTES, sha256: 'ab'.repeat(32), width: 100, height: 100 }
}

// A member on the swarm with its diary and, with `media`, one media core of
// that many raw blocks after its header. `records(key, mediaKey)`. With
// `keyPair` the diary key is that public key (a compat core, as the
// browser node's Hypercore 10 diaries), so it can sign a deal consent.
async function member (t, bootstrap, assoc, { records = () => [], media = 0, keyPair = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = keyPair === null
    ? store.get({ name: 'diary', valueEncoding: 'json' })
    : store.get({ key: keyPair.publicKey, keyPair, compat: true, valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  let mediaKey = null
  if (media > 0) {
    const core = store.get({ name: 'media-0' })
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

// The scan, engagement and Feira cursors of m's diary reached its length.
function settled (seeder, m) {
  return until(() => {
    const entry = seeder._served.get(m.key)
    const length = m.diary.length
    return entry && entry.scanned >= length && entry.indexed >= length && entry.feiraIndexed >= length && !entry.feiraQueued
  }, { name: 'diário processado até ' + m.diary.length })
}

// mediaRead serves nothing before the seeder's local re-gate of the media
// core's block 0 (_gateMedia), which runs asynchronously after the download.
function mediaGated (seeder, K) {
  return until(() => seeder._mediaServed.get(K)?.headerOk === true, { name: 'mídia conferida' })
}

async function setup (t, opts) {
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, ...opts })
  return { bootstrap, assoc, seeder, events }
}

test('listings by city and kind, vendido, edit, tombstone, blocked diary and closed page', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const A = await member(t, bootstrap, assoc, {
    records: () => [
      listing('produto', 'Bicicleta aro 29', 'esporte', SP, 1),
      listing('procura', 'Procuro geladeira', 'casa', SP, 2),
      listing('produto', 'Mesa de madeira', 'moveis', CAMPINAS, 3)
    ]
  })
  await admit(A, assoc)
  await settled(seeder, A)
  const B = await member(t, bootstrap, assoc, {
    records: () => [
      listing('servico', 'Aulas de violão', 'aulas', { uf: 'SP', city: 'sao  paulo', bairro: null }, 4, { price: 5000, unit: 'hora' }),
      postRecord({ text: 'oi', at: at(5) })
    ]
  })
  await admit(B, assoc)
  await settled(seeder, B)

  t.alike(refs(seeder.indexFeira('SP', 'sao-paulo')), [ref(B.key, 1), ref(A.key, 1)], 'one city key for both spellings, procura left out')
  t.alike(refs(seeder.indexFeira('SP', 'sao-paulo', 'procura')), [ref(A.key, 2)], 'procura only under its segment')
  t.alike(refs(seeder.indexFeira('SP', 'campinas')), [ref(A.key, 3)])
  t.alike(refs(seeder.indexFeira('SP', null, 'todos', 'todas', 'bicicleta')), [ref(A.key, 1)], 'title words')
  const all = seeder.indexFeira('SP', null)
  t.alike(refs(all), [ref(B.key, 1), ref(A.key, 3), ref(A.key, 1)])
  t.is(all.complete, true)
  t.is(all.indexing, false)
  t.ok(all.authors[A.key] && 'profileSeq' in all.authors[A.key], 'author hints')
  t.is(seeder.indexFeira('SP', 'sao-paulo', 'nada'), null, 'a malformed kind')
  t.is(seeder.feiraStats().feiraListings, 4)

  await append(A, [listingStatusRecord({ seq: 1, status: 'vendido', at: at(6) })])
  await settled(seeder, A)
  t.alike(refs(seeder.indexFeira('SP', 'sao-paulo')), [ref(B.key, 1)], 'vendido leaves the city query')
  const own = seeder.indexFeiraAuthor(A.key)
  t.alike(refs(own), [ref(A.key, 3), ref(A.key, 2), ref(A.key, 1)], 'and stays on the author route')
  t.alike(own.items[2], { ref: ref(A.key, 1), status: 'vendido', statusSeq: 4, editSeq: null })
  t.absent(seeder.feiraRecent(10).includes(ref(A.key, 1)), 'nor in the sitemap')

  await append(A, [edit(3, 'Mesa de jantar', 'casa', CAMPINAS, 7)])
  await settled(seeder, A)
  const card = await seeder.listingPublic(A.key, 3)
  t.is(card.record.title, 'Mesa de jantar', 'the edit content over the root')
  t.is(card.record.kind, 'produto')
  t.is(card.record.at, at(3), 'the root date')
  t.is(card.editSeq, 5)
  t.is(card.status, 'disponivel')
  t.is(card.page, false)
  t.alike(refs(seeder.indexFeira('SP', 'campinas', 'todos', 'moveis')), [], 'the old category is gone')
  t.alike(refs(seeder.indexFeira('SP', 'campinas', 'todos', 'casa')), [ref(A.key, 3)], 'the new one is indexed')
  t.alike(refs(seeder.indexFeira('SP', null, 'todos', 'todas', 'jantar')), [ref(A.key, 3)])
  t.alike(refs(seeder.indexFeira('SP', null)), [ref(B.key, 1), ref(A.key, 3)], 'same position')
  t.is(seeder.indexFeira('SP', null).items[1].editSeq, 5, 'items carry editSeq')

  await append(A, [deleteRecord({ seq: 2, at: at(8) })])
  await settled(seeder, A)
  t.alike(refs(seeder.indexFeira('SP', 'sao-paulo', 'procura')), [], 'a tombstone removes the listing')
  t.is(await seeder.listingPublic(A.key, 2), null)
  t.is(await seeder.listingPublic(B.key, 2), null, 'null for a post seq')
  t.is(await seeder.listingPublic(B.key, 9), null, 'null for an unscanned seq')
  t.ok(await seeder.listingPublic(B.key, 1))
  t.alike(seeder.feiraRecent(10), [ref(B.key, 1), ref(A.key, 3)])

  const isBlocked = seeder._isBlocked
  seeder._isBlocked = (k) => k === B.key || isBlocked.call(seeder, k)
  t.alike(refs(seeder.indexFeira('SP', null)), [ref(A.key, 3)], 'a blocked diary is not in the index')
  t.is(await seeder.listingPublic(B.key, 1), null, 'nor in listingPublic')
  t.is(seeder.indexFeiraAuthor(B.key), null)
  t.alike(seeder.feiraRecent(10), [ref(A.key, 3)], 'nor in feiraRecent')
  seeder._isBlocked = isBlocked

  const endSeq = seeder._names.endSeq
  seeder._names.endSeq = (k) => k === A.key ? 1 : endSeq(k)
  t.alike(refs(seeder.indexFeira('SP', null)), [ref(B.key, 1)], 'a closed page is not in the index')
  t.is(await seeder.listingPublic(A.key, 3), null, 'nor in listingPublic')
  t.alike(seeder.feiraRecent(10), [ref(B.key, 1)], 'nor in feiraRecent')
  seeder._names.endSeq = endSeq

  seeder._drop(B.key, 'blocked')
  t.alike(seeder.indexFeira('SP', null).items.map((i) => i.ref), [ref(A.key, 3)], 'a dropped diary leaves the index')
  t.alike(seeder.feiraRecent(10), [ref(A.key, 3)])
})

test('with perAuthorMax 1 a status after a refused add still applies through STATE', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t, { feiraPerAuthorMax: 1 })
  const A = await member(t, bootstrap, assoc, {
    records: () => [
      listing('produto', 'Sofa velho', 'moveis', SP, 1),
      listing('produto', 'Cadeira azul', 'moveis', SP, 2),
      listingStatusRecord({ seq: 2, status: 'reservado', at: at(3) }),
      listingStatusRecord({ seq: 1, status: 'reservado', at: at(4) })
    ]
  })
  await admit(A, assoc)
  await settled(seeder, A)
  t.alike(refs(seeder.indexFeira('SP', 'sao-paulo')), [ref(A.key, 1)], 'the second add was refused')
  t.is(seeder.indexFeira('SP', 'sao-paulo').items[0].status, 'reservado', 'the cursor moved past the refusal')
  const card = await seeder.listingPublic(A.key, 2)
  t.is(card.status, 'reservado', 'listingPublic answers the refused listing with its status')
  t.is(card.statusSeq, 3)
  t.is(card.record.title, 'Cadeira azul')
  t.alike(refs(seeder.indexFeiraAuthor(A.key)), [ref(A.key, 2), ref(A.key, 1)], 'the author route reads STATE')
})

test('a consented rate appears under the listing author and leaves with its tombstone', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const seller = crypto.keyPair()
  const A = await member(t, bootstrap, assoc, { keyPair: seller, records: () => [listing('produto', 'Bicicleta', 'esporte', SP, 1)] })
  await admit(A, assoc)
  await settled(seeder, A)
  const offer = 'ab'.repeat(16)
  const B = await member(t, bootstrap, assoc, {
    records: (key) => {
      const sign = (secretKey, offerId) => hex(crypto.sign(b4a.from(feira.dealPayload({ listingAuthor: A.key, listingSeq: 1, rater: key, offerId })), secretKey))
      const forged = crypto.keyPair()
      return [
        // Signed by someone other than the listing author: never counted.
        listingRateRecord({ to: { author: A.key, seq: 1 }, offer: 'cd'.repeat(16), consent: sign(forged.secretKey, 'cd'.repeat(16)), stars: 1, at: at(2) }),
        listingRateRecord({ to: { author: A.key, seq: 1 }, offer, consent: sign(seller.secretKey, offer), stars: 5, text: 'ótimo', at: at(3) })
      ]
    }
  })
  await admit(B, assoc)
  await settled(seeder, B)
  const rated = seeder.indexFeiraRatings(A.key)
  t.alike(refs(rated), [ref(B.key, 2)], 'only the consented rate')
  t.ok(rated.authors[B.key], 'rater hints')
  t.alike(refs(seeder.indexFeiraRatings(B.key)), [], 'nothing under the rater')
  t.is(seeder.feiraStats().feiraRatings, 1)

  await append(B, [deleteRecord({ seq: 2, at: at(4) })])
  await settled(seeder, B)
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [], 'gone after its tombstone')
})

test('a deleted status or edit gives back what the fold shows', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const records = [
    listing('produto', 'Abajur', 'casa', SP, 1),
    listingStatusRecord({ seq: 1, status: 'reservado', at: at(2) }),
    listingStatusRecord({ seq: 1, status: 'vendido', at: at(3) }),
    edit(1, 'Abajur dourado', 'casa', SP, 4),
    edit(1, 'Luminaria azul', 'outros', CAMPINAS, 5),
    deleteRecord({ seq: 3, at: at(6) }),
    deleteRecord({ seq: 5, at: at(7) })
  ]
  const A = await member(t, bootstrap, assoc, { records: () => records })
  await admit(A, assoc)
  await settled(seeder, A)
  const folded = foldListings(records.map((record, i) => ({ seq: i + 1, record }))).bySeq.get(1)
  const state = seeder._feira.state(A.key).get(1)
  t.is(state.status, folded.status, 'status as the fold')
  t.is(state.statusSeq, folded.statusSeq)
  t.is(state.editSeq, folded.editSeq, 'current edit as the fold')
  t.is(folded.status, 'reservado')
  t.is(folded.editSeq, 4)
  const card = await seeder.listingPublic(A.key, 1)
  t.alike(card.record, folded.record, 'listingPublic shows the folded record')
  t.alike(refs(seeder.indexFeira('SP', 'sao-paulo', 'todos', 'casa', 'dourado')), [ref(A.key, 1)], 'search keys of the previous edit')
  t.alike(refs(seeder.indexFeira('SP', 'campinas')), [], 'not under the deleted edit city')
})

test('a tombstone never frees a range a live listing or its edit still shows', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder, events } = await setup(t)
  const A = await member(t, bootstrap, assoc, {
    media: 3,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      postRecord({ text: 'foto', media: [descriptor(K, 1, 1)], at: at(1) }),
      listing('produto', 'Bicicleta', 'esporte', SP, 2, { media: [descriptor(K, 1, 1)] }),
      edit(3, 'Bicicleta nova', 'esporte', SP, 3, { media: [descriptor(K, 2, 1)] }),
      postRecord({ text: 'outra', media: [descriptor(K, 2, 1)], at: at(4) }),
      postRecord({ text: 'terceira', media: [descriptor(K, 3, 1)], at: at(5) })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === 4, { name: 'mídia baixada' })
  await mediaGated(seeder, K)
  await settled(seeder, A)

  await append(A, [
    deleteRecord({ seq: 2, at: at(6), media: [{ core: K, start: 1, blocks: 1 }] }),
    deleteRecord({ seq: 5, at: at(7), media: [{ core: K, start: 2, blocks: 1 }] }),
    deleteRecord({ seq: 6, at: at(8), media: [{ core: K, start: 3, blocks: 1 }] })
  ])
  await settled(seeder, A)
  t.is(await seeder.mediaRead(A.key, K, 3, 1), null, 'a range nothing shows any more is refused')
  t.ok(await seeder.mediaRead(A.key, K, 1, 1), 'the root photo of a live listing stays served')
  t.ok(await seeder.mediaRead(A.key, K, 2, 1), 'the edit photo stays served')
})

test('a rating scanned before its listing is kept and appears once the listing is scanned', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const seller = crypto.keyPair()
  const sellerKey = hex(seller.publicKey)
  const offer = 'ef'.repeat(16)
  // The seller is admitted before its listing exists: a rating may wait
  // only for a diary this seeder serves or admitted (H2).
  const A = await member(t, bootstrap, assoc, { keyPair: seller })
  t.is(A.key, sellerKey)
  await admit(A, assoc)
  await settled(seeder, A)
  const B = await member(t, bootstrap, assoc, {
    records: (key) => {
      const sign = (secretKey, offerId) => hex(crypto.sign(b4a.from(feira.dealPayload({ listingAuthor: sellerKey, listingSeq: 1, rater: key, offerId })), secretKey))
      return [
        listingRateRecord({ to: { author: sellerKey, seq: 1 }, offer: 'cd'.repeat(16), consent: sign(crypto.keyPair().secretKey, 'cd'.repeat(16)), stars: 1, at: at(2) }),
        listingRateRecord({ to: { author: sellerKey, seq: 1 }, offer, consent: sign(seller.secretKey, offer), stars: 4, at: at(3) })
      ]
    }
  })
  await admit(B, assoc)
  await settled(seeder, B)
  t.is(seeder._feiraPending.size, 1, 'only the verified rating waits')
  t.is(seeder.feiraStats().feiraRatings, 0)

  await append(A, [listing('produto', 'Bicicleta', 'esporte', SP, 1)])
  await settled(seeder, A)
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [ref(B.key, 2)], 'the pending rating is replayed')
  t.is(seeder._feiraPending.size, 0, 'and cleared')

  // A dropped rater takes its pending rows with it.
  seeder._feiraPend('a'.repeat(64), 1, B.key, 9, 0)
  seeder._drop(B.key, 'blocked')
  t.is(seeder._feiraPending.size, 0)
})

// ---- Review round 2 -------------------------------------------------------

test('listingPublic answers null when the root or its edit changed or vanished meanwhile, and a stale status is null', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const A = await member(t, bootstrap, assoc, {
    records: () => [
      listing('produto', 'Mesa azul', 'moveis', SP, 1),
      edit(1, 'Mesa verde', 'moveis', SP, 2),
      listing('produto', 'Banco', 'moveis', SP, 3)
    ]
  })
  await admit(A, assoc)
  await settled(seeder, A)
  t.is((await seeder.listingPublic(A.key, 1)).record.title, 'Mesa verde')
  const live = seeder._liveRecord

  // (a) a tombstone of the root learned during the reads.
  seeder._liveRecord = async function (hex, seq) {
    const r = await live.call(this, hex, seq)
    const entry = this._served.get(hex)
    entry.tombstones.set(999, 1)
    entry.effective = null
    return r
  }
  t.is(await seeder.listingPublic(A.key, 1), null, 'a root tombstoned meanwhile')
  const entry = seeder._served.get(A.key)
  entry.tombstones.delete(999)
  entry.effective = null

  // (b) the edit STATE holds cannot be read.
  seeder._liveRecord = async function (hex, seq) {
    return seq === 2 ? null : live.call(this, hex, seq)
  }
  t.is(await seeder.listingPublic(A.key, 1), null, 'never the pre-edit root as current')

  // (c) a newer edit entered STATE during the reads.
  seeder._liveRecord = async function (hex, seq) {
    const r = await live.call(this, hex, seq)
    if (seq === 2) this._feira.applyEdit(hex, 1, 50)
    return r
  }
  t.is(await seeder.listingPublic(A.key, 1), null, 'the edit changed meanwhile')
  seeder._liveRecord = live

  // (d) a status window emptied past its overflow: the status is unknown.
  for (let s = 100; s < 117; s++) seeder._feira.setStatus(A.key, 3, 'reservado', s)
  for (let s = 101; s < 117; s++) seeder._feira.markDeleted(A.key, s)
  const card = await seeder.listingPublic(A.key, 3)
  t.is(card.status, null, 'stale status')
  t.is(card.statusSeq, null)
})

test('a refused search update leaves no old match behind', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t, { feiraMaxTerms: 3 })
  const A = await member(t, bootstrap, assoc, {
    records: () => [
      listing('produto', 'Mesa azul', 'moveis', SP, 1),
      edit(1, 'Cadeira verde grande nova', 'casa', SP, 2)
    ]
  })
  await admit(A, assoc)
  await settled(seeder, A)
  t.alike(refs(seeder.indexFeira('SP', null, 'todos', 'todas', 'mesa')), [], 'the old title no longer matches')
  t.alike(refs(seeder.indexFeira('SP', null, 'todos', 'moveis')), [], 'nor the old category')
  t.is((await seeder.listingPublic(A.key, 1)).record.title, 'Cadeira verde grande nova', 'STATE keeps the edit')
  t.alike(refs(seeder.indexFeiraAuthor(A.key)), [ref(A.key, 1)])
})

test('ratings of a dropped listing author wait for its listings to return', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const seller = crypto.keyPair()
  const A = await member(t, bootstrap, assoc, { keyPair: seller, records: () => [listing('produto', 'Bicicleta', 'esporte', SP, 1)] })
  await admit(A, assoc)
  await settled(seeder, A)
  const offer = 'ab'.repeat(16)
  const B = await member(t, bootstrap, assoc, {
    records: (key) => [listingRateRecord({
      to: { author: A.key, seq: 1 },
      offer,
      consent: hex(crypto.sign(b4a.from(feira.dealPayload({ listingAuthor: A.key, listingSeq: 1, rater: key, offerId: offer })), seller.secretKey)),
      stars: 5,
      at: at(2)
    })]
  })
  await admit(B, assoc)
  await settled(seeder, B)
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [ref(B.key, 1)])
  seeder._drop(A.key, 'quota')
  t.is(seeder._feiraPending.size, 1, 'the received rating waits')
  // A re-admission scans the listing again.
  t.ok(seeder._feira.upsertListing(A.key, 1, { atMs: BASE_MS, kind: 'produto' }))
  seeder._feiraReplay(A.key, 1)
  t.alike(refs(seeder._feira.byTarget(A.key, null, undefined, Date.now())), [ref(B.key, 1)], 'replayed')
  t.is(seeder._feiraPending.size, 0)
})

test('the Feira pass itself drops a diary at its page-close, and flags wait for a page scan', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  seeder._feiraPageEnd = () => true
  const A = await member(t, bootstrap, assoc, {
    records: (key) => [
      listing('produto', 'Mesa', 'moveis', SP, 1),
      { type: 'page-close', page: key, gen: 2, at: at(2), nonce: 'c'.repeat(43), actor: 'd'.repeat(64), association: assoc.hex, issuer: 'c'.repeat(64), issuerDate: at(0), issuerSignature: 'e'.repeat(128), signature: 'a'.repeat(128), countersignature: 'b'.repeat(128) },
      listing('produto', 'Banco', 'moveis', SP, 3)
    ]
  })
  await admit(A, assoc)
  await settled(seeder, A)
  t.is(seeder._names.endSeq(A.key), null, 'the name index did not verify the fake close')
  t.alike(refs(seeder.indexFeira('SP', null)), [], 'gone from the Feira')
  t.is(seeder._feira.state(A.key).size, 0, 'nor indexed after the close')

  const B = await member(t, bootstrap, assoc, { records: () => [listing('produto', 'Sofa', 'moveis', SP, 1)] })
  await admit(B, assoc)
  await settled(seeder, B)
  t.is(seeder.indexFeira('SP', null).complete, true)
  const entry = seeder._served.get(B.key)
  const hint = seeder._names.hint
  const indexed = entry.indexed
  seeder._names.hint = (k) => k === B.key ? { page: true, closed: false, moved: false } : hint(k)
  entry.indexed = 1
  t.is(seeder.indexFeira('SP', null).complete, false, 'a page not read to its end')
  entry.indexed = indexed
  seeder._names.hint = hint

  let upserts = 0
  const upsert = seeder._feira.upsertListing
  seeder._feira.upsertListing = (...args) => { upserts++; return upsert(...args) }
  seeder._rebuildIndex()
  await until(() => upserts > 0 && seeder._served.get(B.key).feiraIndexed >= B.diary.length, { name: 'feira refeita' })
  await settled(seeder, B)
  t.alike(refs(seeder.indexFeira('SP', null)), [ref(B.key, 1)], 'a rebuild rescans the Feira and keeps the close')
})

test('deleting a listing root clears its pending ratings', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const seller = crypto.keyPair()
  const sellerKey = hex(seller.publicKey)
  const offer = 'ab'.repeat(16)
  const A = await member(t, bootstrap, assoc, { keyPair: seller })
  await admit(A, assoc)
  await settled(seeder, A)
  const B = await member(t, bootstrap, assoc, {
    records: (key) => [listingRateRecord({
      to: { author: sellerKey, seq: 1 },
      offer,
      consent: hex(crypto.sign(b4a.from(feira.dealPayload({ listingAuthor: sellerKey, listingSeq: 1, rater: key, offerId: offer })), seller.secretKey)),
      stars: 5,
      at: at(2)
    })]
  })
  await admit(B, assoc)
  await settled(seeder, B)
  t.is(seeder._feiraPending.size, 1)
  await append(A, [listing('produto', 'Bicicleta', 'esporte', SP, 1), deleteRecord({ seq: 1, at: at(3) })])
  await settled(seeder, A)
  t.is(seeder._feiraPending.size, 0, 'no pending row for a deleted listing')
  t.alike(refs(seeder._feira.byTarget(A.key, null, undefined, Date.now())), [], 'no rating either')
  // A root the Feira cursor never took into STATE (cleared before it got
  // there): its tombstone still clears the rows waiting for it.
  seeder._feiraPend(A.key, 9, B.key, 7, 0)
  await seeder._feiraDelete(A.key, seeder._served.get(A.key), { seq: 9 })
  t.is(seeder._feiraPending.size, 0, 'cleared without a STATE root')
})

test('an edit photo stops counting once its root listing is tombstoned', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder, events } = await setup(t)
  const A = await member(t, bootstrap, assoc, {
    media: 2,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      listing('produto', 'Bicicleta', 'esporte', SP, 1, { media: [descriptor(K, 1, 1)] }),
      edit(2, 'Bicicleta nova', 'esporte', SP, 2, { media: [descriptor(K, 2, 1)] })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === 3, { name: 'mídia baixada' })
  await mediaGated(seeder, K)
  await settled(seeder, A)
  t.ok(await seeder.mediaRead(A.key, K, 2, 1), 'the edit photo is served while the listing lives')
  await append(A, [deleteRecord({ seq: 2, at: at(3), media: [{ core: K, start: 1, blocks: 2 }] })])
  await settled(seeder, A)
  t.is(await seeder.mediaRead(A.key, K, 1, 1), null, 'the root photo is refused')
  t.is(await seeder.mediaRead(A.key, K, 2, 1), null, 'and so is the photo of its edit')
})

// ---- Security cycle 1 -----------------------------------------------------

function consentFor (secretKey, listingAuthor, listingSeq, rater, offerId) {
  return hex(crypto.sign(b4a.from(feira.dealPayload({ listingAuthor, listingSeq, rater, offerId })), secretKey))
}

test('one rating per offer: a later block of the same offer never counts, not even after the first is tombstoned', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const seller = crypto.keyPair()
  const A = await member(t, bootstrap, assoc, { keyPair: seller, records: () => [listing('produto', 'Bicicleta', 'esporte', SP, 1)] })
  await admit(A, assoc)
  await settled(seeder, A)
  const offer = 'ab'.repeat(16)
  const rate = (key, offerId, stars, i) => listingRateRecord({ to: { author: A.key, seq: 1 }, offer: offerId, consent: consentFor(seller.secretKey, A.key, 1, key, offerId), stars, at: at(i) })
  let raterKey = null
  const B = await member(t, bootstrap, assoc, {
    records: (key) => {
      raterKey = key
      return [rate(key, offer, 5, 2), rate(key, offer, 1, 3)]
    }
  })
  await admit(B, assoc)
  await settled(seeder, B)
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [ref(B.key, 1)], 'the first block of the offer, not the rewrite')

  await append(B, [deleteRecord({ seq: 1, at: at(4) })])
  await settled(seeder, B)
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [], 'a tombstoned first block leaves the offer unrated')

  const other = 'cd'.repeat(16)
  await append(B, [rate(raterKey, other, 4, 5)])
  await settled(seeder, B)
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [ref(B.key, 4)], 'another offer is another deal')
})

function spyRescans (seeder) {
  const asks = []
  const original = seeder._feiraRescanSoon
  seeder._feiraRescanSoon = function (key, entry) {
    asks.push(key)
    return original.call(this, key, entry)
  }
  Object.defineProperty(asks, 'restore', { value: () => { seeder._feiraRescanSoon = original } })
  return asks
}

test('a deleted rating that replaced an older one of the pair brings the older back, by one capped rescan of the rater', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t, { feiraRescanMs: 0 })
  const seller = crypto.keyPair()
  const A = await member(t, bootstrap, assoc, { keyPair: seller, records: () => [listing('produto', 'Bicicleta', 'esporte', SP, 1)] })
  await admit(A, assoc)
  await settled(seeder, A)
  const rate = (key, offerId, stars, i) => listingRateRecord({ to: { author: A.key, seq: 1 }, offer: offerId, consent: consentFor(seller.secretKey, A.key, 1, key, offerId), stars, at: at(i) })
  let raterKey = null
  const B = await member(t, bootstrap, assoc, {
    records: (key) => {
      raterKey = key
      return [rate(key, 'ab'.repeat(16), 5, 2), rate(key, 'cd'.repeat(16), 1, 3)]
    }
  })
  await admit(B, assoc)
  await settled(seeder, B)
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [ref(B.key, 2)], 'the newer rating replaced the older')

  await append(B, [deleteRecord({ seq: 2, at: at(4) })])
  await settled(seeder, B)
  await until(() => refs(seeder.indexFeiraRatings(A.key))[0] === ref(B.key, 1), { name: 'nota antiga de volta' })
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [ref(B.key, 1)], 'the older rating is back without a full rescan')
  const entry = seeder._served.get(B.key)
  await until(() => entry.feiraRescan === null && !entry.feiraQueued, { name: 'rescan terminado' })
  const rescannedAt = entry.feiraRescanAt
  const asks = spyRescans(seeder)
  const since = Date.now()
  await until(() => Date.now() - since >= 300, { name: 'janela sem novo rescan' })
  t.is(asks.length, 0, 'the rescan asked no other rescan')
  t.is(entry.feiraRescanAt, rescannedAt, 'and none ran')
  asks.restore()

  // Inside the cap a request waits, and later requests join it.
  seeder._feiraRescanMs = 1e9
  await append(B, [rate(raterKey, 'ef'.repeat(16), 3, 5), deleteRecord({ seq: 4, at: at(6) })])
  await settled(seeder, B)
  const pending = entry.feiraRescan
  t.ok(pending, 'a rescan waits for the cap')
  seeder._feiraRescanSoon(B.key, entry)
  t.is(entry.feiraRescan, pending, 'a second request joins the waiting one')
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [], 'nothing rescanned before the cap')
  clearTimeout(pending)
  entry.feiraRescan = null
  seeder._feiraRescanMs = 0
  seeder._feiraRescanSoon(B.key, entry)
  await until(() => refs(seeder.indexFeiraRatings(A.key))[0] === ref(B.key, 1), { name: 'nota antiga de volta de novo' })
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [ref(B.key, 1)])
})

test('a deleted rating whose block is already cleared still asks the rescan when it was indexed', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t, { feiraRescanMs: 1e9 })
  const seller = crypto.keyPair()
  const A = await member(t, bootstrap, assoc, { keyPair: seller, records: () => [listing('produto', 'Bicicleta', 'esporte', SP, 1)] })
  await admit(A, assoc)
  await settled(seeder, A)
  const rate = (key, offerId, stars, i) => listingRateRecord({ to: { author: A.key, seq: 1 }, offer: offerId, consent: consentFor(seller.secretKey, A.key, 1, key, offerId), stars, at: at(i) })
  const B = await member(t, bootstrap, assoc, { records: (key) => [rate(key, 'ab'.repeat(16), 5, 2), rate(key, 'cd'.repeat(16), 1, 3)] })
  await admit(B, assoc)
  await settled(seeder, B)
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [ref(B.key, 2)])
  const asks = spyRescans(seeder)
  // The pass reads the tombstone after the target block was cleared.
  const cleared = { core: { get: async () => null } }
  await seeder._feiraDelete(B.key, cleared, { seq: 2 })
  t.alike(asks, [B.key], 'one rescan of the rater')
  t.alike(refs(seeder.indexFeiraRatings(A.key)), [], 'the deleted rating left the index')
  await seeder._feiraDelete(B.key, cleared, { seq: 2 })
  t.alike(asks, [B.key], 'a rating no longer indexed asks nothing')
  asks.restore()
})

test('deleting a listing root asks no rescan', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t, { feiraRescanMs: 0 })
  const A = await member(t, bootstrap, assoc, { records: () => [listing('produto', 'Mesa', 'moveis', SP, 1), listing('produto', 'Cadeira', 'moveis', SP, 2)] })
  await admit(A, assoc)
  await settled(seeder, A)
  const asks = spyRescans(seeder)
  await append(A, [deleteRecord({ seq: 1, at: at(5) })])
  await settled(seeder, A)
  t.is(await seeder.listingPublic(A.key, 1), null, 'the deleted listing is gone')
  t.ok(await seeder.listingPublic(A.key, 2), 'the other listing stays')
  t.alike(asks, [], 'no rescan of the seller')
  asks.restore()
})

test('deleting the newest statuses of a full window brings back the older status by a rescan', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t, { feiraRescanMs: 0 })
  const statuses = [listingStatusRecord({ seq: 1, status: 'vendido', at: at(2) })]
  for (let i = 0; i < 16; i++) statuses.push(listingStatusRecord({ seq: 1, status: 'reservado', at: at(3 + i) }))
  const A = await member(t, bootstrap, assoc, { records: () => [listing('produto', 'Mesa', 'moveis', SP, 1), ...statuses] })
  await admit(A, assoc)
  await settled(seeder, A)
  t.is((await seeder.listingPublic(A.key, 1)).status, 'reservado')
  const deletes = []
  for (let s = 3; s <= 18; s++) deletes.push(deleteRecord({ seq: s, at: at(20 + s) }))
  await append(A, deletes)
  await settled(seeder, A)
  await until(async () => (await seeder.listingPublic(A.key, 1))?.status === 'vendido', { name: 'situação antiga de volta' })
  t.is((await seeder.listingPublic(A.key, 1)).status, 'vendido', 'never an unknown status')
})

test('rescans of one diary back off: the gap doubles up to the cap and resets after a quiet cap', async (t) => {
  t.timeout(120000)
  const { seeder } = await setup(t, { feiraRescanMs: 60000, feiraRescanMaxMs: 3600000 })
  const entry = { feiraRescanAt: null, feiraRescanAsked: null, feiraRescanLevel: 0 }
  let now = 1000000
  t.is(seeder._feiraRescanWait(entry, now), 0, 'the first rescan runs at once')
  seeder._feiraRescanRan(entry, now)
  // Each time a delete asks one second after the last rescan.
  const gaps = []
  for (let i = 0; i < 8; i++) {
    now += 1000
    const wait = seeder._feiraRescanWait(entry, now)
    gaps.push(1000 + wait)
    now += wait
    seeder._feiraRescanRan(entry, now)
  }
  t.alike(gaps, [60000, 120000, 240000, 480000, 960000, 1920000, 3600000, 3600000], 'the gap doubles up to the cap')

  // A request inside the cap keeps it from resetting.
  const ran = now
  now = ran + 1800000
  t.is(seeder._feiraRescanWait(entry, now), 1800000)
  now = ran + 3600000
  t.is(seeder._feiraRescanWait(entry, now), 0)
  seeder._feiraRescanRan(entry, now)
  now += 1000
  t.is(seeder._feiraRescanWait(entry, now), 3599000, 'still the cap')

  // A whole cap with neither a request nor a rescan: back to the start.
  seeder._feiraRescanRan(entry, now + 3599000)
  now += 3599000 + 3600000
  t.is(seeder._feiraRescanWait(entry, now), 0, 'after a quiet cap a request runs at once')
  seeder._feiraRescanRan(entry, now)
  now += 1000
  t.is(seeder._feiraRescanWait(entry, now), 59000, 'and the gap is feiraRescanMs again')
})

test('a rescan never verifies a claimed rating twice and keeps nothing for a junk one', async (t) => {
  t.timeout(120000)
  const listingLib = require('../lib/listing')
  const verify = listingLib.verifyConsent
  let checks = 0
  listingLib.verifyConsent = (...args) => {
    checks++
    return verify(...args)
  }
  t.teardown(() => { listingLib.verifyConsent = verify })
  const { bootstrap, assoc, seeder } = await setup(t, { feiraRescanMs: 0 })
  const seller = crypto.keyPair()
  const A = await member(t, bootstrap, assoc, { keyPair: seller, records: () => [listing('produto', 'Bicicleta', 'esporte', SP, 1), listing('produto', 'Mesa', 'moveis', SP, 2)] })
  await admit(A, assoc)
  await settled(seeder, A)
  const rate = (key, seq, offerId, i) => listingRateRecord({ to: { author: A.key, seq }, offer: offerId, consent: consentFor(seller.secretKey, A.key, seq, key, offerId), stars: 5, at: at(i) })
  const stranger = crypto.keyPair()
  const junk = (key, i) => listingRateRecord({ to: { author: A.key, seq: 1 }, offer: 'ef'.repeat(16), consent: consentFor(stranger.secretKey, A.key, 1, key, 'ef'.repeat(16)), stars: 1, at: at(i) })
  const B = await member(t, bootstrap, assoc, { records: (key) => [rate(key, 1, 'ab'.repeat(16), 3), rate(key, 2, 'cd'.repeat(16), 4), junk(key, 5)] })
  await admit(B, assoc)
  await settled(seeder, B)
  const rated = refs(seeder.indexFeiraRatings(A.key)).sort()
  t.alike(rated, [ref(B.key, 1), ref(B.key, 2)])
  t.is(checks, 3, 'one check per rating block on the first pass')
  const entry = seeder._served.get(B.key)
  t.is(entry.feiraConsent, undefined, 'no per-block consent verdicts on the served entry')
  t.is(entry.feiraOffers.size, 2, 'only the consented blocks claim an offer')
  for (let i = 0; i < 2; i++) {
    const before = entry.feiraRescanAt
    seeder._feiraRescanSoon(B.key, entry)
    await until(() => entry.feiraRescanAt !== before && entry.feiraRescan === null && !entry.feiraQueued && entry.feiraIndexed >= entry.present, { name: 'rescan ' + (i + 1) })
  }
  t.is(checks, 5, 'two rescans verified only the junk block again (nothing kept for it)')
  t.alike(refs(seeder.indexFeiraRatings(A.key)).sort(), rated, 'and both ratings still count')
})

test('a rescan keeps every rating whose listing survives, even with the pending cap of its author full', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t, { feiraRescanMs: 0 })
  const seller = crypto.keyPair()
  const A = await member(t, bootstrap, assoc, { keyPair: seller, records: () => [listing('produto', 'Bicicleta', 'esporte', SP, 1), listing('produto', 'Mesa', 'moveis', SP, 2)] })
  await admit(A, assoc)
  await settled(seeder, A)
  const rate = (key, seq, offerId, i) => listingRateRecord({ to: { author: A.key, seq }, offer: offerId, consent: consentFor(seller.secretKey, A.key, seq, key, offerId), stars: 5, at: at(i) })
  const B = await member(t, bootstrap, assoc, { records: (key) => [rate(key, 1, 'ab'.repeat(16), 3)] })
  const C = await member(t, bootstrap, assoc, { records: (key) => [rate(key, 2, 'cd'.repeat(16), 4)] })
  await admit(B, assoc)
  await admit(C, assoc)
  await settled(seeder, B)
  await settled(seeder, C)
  const rated = refs(seeder.indexFeiraRatings(A.key)).sort()
  t.alike(rated, [ref(B.key, 1), ref(C.key, 1)].sort())
  // Sybil rows of a listing that never comes fill A's pending cap
  // (FEIRA_PENDING_PER_AUTHOR, 300).
  for (let i = 0; i < 300; i++) {
    const rater = (i + 1).toString(16).padStart(64, '0')
    seeder._feiraPending.set(rater + ':1', { target: A.key, targetSeq: 99, rater, seq: 1, atMs: 1 })
  }
  seeder._feiraPend(A.key, 1, 'f'.repeat(64), 7, 1)
  t.absent(seeder._feiraPending.has('f'.repeat(64) + ':7'), 'the cap refuses a new pending row')
  const entry = seeder._served.get(A.key)
  seeder._feiraRescanSoon(A.key, entry)
  await until(() => entry.feiraRescanAt !== null && entry.feiraRescan === null && !entry.feiraQueued && entry.feiraIndexed >= entry.present, { name: 'rescan do vendedor' })
  t.alike(refs(seeder.indexFeiraRatings(A.key)).sort(), rated, 'every rating of a surviving listing is back')
  t.is(seeder._feiraKept.size, 0, 'nothing is left aside')
  t.is(seeder._feiraPending.size, 300, 'and nothing went through pending')
})

test('consents for a key the seeder neither serves nor admitted never pend', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const junk = crypto.keyPair()
  const junkKey = hex(junk.publicKey)
  const B = await member(t, bootstrap, assoc, {
    records: (key) => Array.from({ length: 40 }, (_, i) => {
      const offerId = (i + 16).toString(16).padStart(2, '0').repeat(16)
      return listingRateRecord({ to: { author: junkKey, seq: i + 1 }, offer: offerId, consent: consentFor(junk.secretKey, junkKey, i + 1, key, offerId), stars: 5, at: at(i + 2) })
    })
  })
  await admit(B, assoc)
  await settled(seeder, B)
  t.is(seeder._feiraPending.size, 0, '40 verified consents for an unknown key pend nothing')
})

test('pending ratings: at most 30 per rater, and a flood never evicts another rater', async (t) => {
  t.timeout(120000)
  const { seeder } = await setup(t)
  const key = () => hex(crypto.keyPair().publicKey)
  const rater = key()
  for (let i = 0; i < 40; i++) seeder._feiraPend(key(), 1, rater, i + 1, 0)
  t.is(seeder._feiraPending.size, 30, 'one rater over 30 rows keeps 30')
  const firsts = [...seeder._feiraPending.values()].map((row) => row.seq)
  t.alike(firsts, Array.from({ length: 30 }, (_, i) => i + 1), 'its first 30 rows')

  const author = key()
  for (let i = 0; i < 400; i++) seeder._feiraPend(author, i + 1, key(), 1, 0)
  const toAuthor = [...seeder._feiraPending.values()].filter((row) => row.target === author).length
  t.is(toAuthor, 300, 'at most 300 rows wait for one author')

  seeder._feiraPending.clear()
  const honest = key()
  const honestTargets = Array.from({ length: 5 }, key)
  honestTargets.forEach((target, i) => seeder._feiraPend(target, 1, honest, i + 1, 0))
  for (let r = 0; r < 200; r++) {
    const flooder = key()
    for (let i = 0; i < 30; i++) seeder._feiraPend(key(), 1, flooder, i + 1, 0)
  }
  t.is(seeder._feiraPending.size, 5000, 'the global cap holds')
  const kept = [...seeder._feiraPending.values()].filter((row) => row.rater === honest)
  t.is(kept.length, 5, 'the honest rows survive the flood')
  seeder._feiraPend(key(), 1, honest, 99, 0)
  t.is([...seeder._feiraPending.values()].filter((row) => row.rater === honest).length, 6, 'and the honest rater can still add one at the cap')
  t.is(seeder._feiraPending.size, 5000)
})

test('a pending rating a cap refuses on replay waits on', async (t) => {
  t.timeout(120000)
  const { seeder } = await setup(t, { feiraMaxRatings: 0 })
  const author = hex(crypto.keyPair().publicKey)
  const rater = hex(crypto.keyPair().publicKey)
  seeder._feiraPend(author, 1, rater, 3, 0)
  t.ok(seeder._feira.upsertListing(author, 1, { atMs: BASE_MS, kind: 'produto' }))
  seeder._feiraReplay(author, 1)
  t.is(seeder._feiraPending.size, 1, 'kept: addRating refused it')
})

test('a full offer map refuses new offers instead of evicting a canonical one', (t) => {
  const host = Object.create(Seeder.prototype)
  const first = (...args) => host._feiraFirstOffer(...args)
  const entry = { feiraOffers: new Map() }
  const offer = (i) => i.toString(16).padStart(32, '0')
  t.ok(first(entry, offer(0), 5), 'the first block of an offer is canonical')
  for (let i = 1; i < 4096; i++) first(entry, offer(i), 5 + i)
  t.is(entry.feiraOffers.size, 4096)
  t.absent(first(entry, offer(9999), 99999), 'a new offer is refused once the map is full')
  t.is(entry.feiraOffers.get(offer(0)), 5, 'the oldest canonical offer is kept')
  t.absent(first(entry, offer(0), 99998), 'a rewrite of a kept offer still does not count')
  t.ok(first(entry, offer(0), 5), 'the canonical block still counts')
})

test('a tombstoned rating still holding its bytes keeps its offer claimed on a rescan', (t) => {
  const host = Object.create(Seeder.prototype)
  const seller = crypto.keyPair()
  const rater = hex(crypto.keyPair().publicKey)
  const sellerKey = hex(seller.publicKey)
  const offer = 'ab'.repeat(16)
  const entry = { feiraOffers: new Map() }
  const rate = listingRateRecord({ to: { author: sellerKey, seq: 1 }, offer, consent: consentFor(seller.secretKey, sellerKey, 1, rater, offer), stars: 5, at: new Date(Date.UTC(2026, 10, 7)).toISOString() })
  host._feiraClaimDeleted(rater, entry, 3, b4a.from(JSON.stringify(rate)))
  t.is(entry.feiraOffers.get(offer), 3, 'the deleted first block claims the offer')
  t.absent(host._feiraFirstOffer(entry, offer, 7), 'a later block of the same offer is not canonical')
  const forged = { ...rate, consent: consentFor(crypto.keyPair().secretKey, sellerKey, 1, rater, 'cd'.repeat(16)), offer: 'cd'.repeat(16) }
  host._feiraClaimDeleted(rater, entry, 4, b4a.from(JSON.stringify(forged)))
  t.absent(entry.feiraOffers.has('cd'.repeat(16)), 'a bad consent claims nothing')
  host._feiraClaimDeleted(rater, entry, 5, b4a.from('not json'))
  t.is(entry.feiraOffers.size, 1, 'garbage is ignored')
})

test('a listing a refused edit took out of search comes back with a later edit that fits', (t) => {
  const { createFeiraIndex } = require('../lib/feira-index')
  const host = Object.create(Seeder.prototype)
  host._feira = createFeiraIndex({ maxTerms: 2 })
  host._feiraPending = new Map()
  const key = 'a'.repeat(64)
  const at = (d) => new Date(Date.UTC(2026, 10, d)).toISOString()
  const place = { uf: 'SP', city: 'Campinas', bairro: null }
  const base = { text: '', price: 1000, unit: null, cat: 'moveis', place }
  const query = (tokens) => host._feira.query({ uf: 'SP', cityKey: 'campinas', kind: 'todos', cat: 'todas', tokens, now: Date.UTC(2026, 10, 30) }).items.map((i) => i.ref)
  host._feiraRecord(key, 1, listingRecord({ kind: 'produto', title: 'Mesa', ...base, at: at(1) }))
  t.alike(query(['mesa']), [key + ':1'])
  host._feiraRecord(key, 2, listingEditRecord({ seq: 1, title: 'Mesa verde grande', ...base, at: at(2) }))
  t.alike(query([]), [], 'a refused update takes it out of search')
  host._feiraRecord(key, 3, listingEditRecord({ seq: 1, title: 'Mesa', ...base, at: at(3) }))
  t.alike(query(['mesa']), [key + ':1'], 'a later edit that fits brings it back')
})
