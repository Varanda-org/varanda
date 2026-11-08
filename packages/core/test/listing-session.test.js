'use strict'

// The Feira writers of the node session (listing.*, lib/member.js) through a
// real dispatcher + client pair, on a local DHT address only.
const test = require('brittle')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { feira } = require('@varanda/rpc')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure } = require('./helpers/net')
const { initAssociation, issueCertificate } = require('../lib/assoc')
const storeLib = require('../lib/store')
const { listingRecord, listingEditRecord, mediaCoreRecord, deleteRecord } = require('../lib/records')

const BOOTSTRAP = ['127.0.0.1:49737']
const CORE = 'cd'.repeat(32)
const OFFER = '0123456789abcdef'.repeat(2)
const AT = '2026-01-02T03:04:05.000Z'
const PLACE = { uf: 'SP', city: 'São Paulo', bairro: 'Pinheiros' }
const FIELDS = { title: 'Bicicleta', text: 'aro 29', price: 50000, unit: null, cat: 'esporte', place: PLACE }
const NOT_A_LISTING = { code: 'USAGE', message: 'o registro não é um anúncio' }
const MEDIA_WEB_ONLY = { code: 'USAGE', message: 'mídia disponível só na versão web' }

async function member (t) {
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assocDir, { member: publicKey }) })
  return { session, publicKey, dataDir, ...link }
}

// Appends straight to the diary between session calls, as a browser device
// of the same identity would.
async function appendDirect (dataDir, records) {
  const s = await storeLib.openStore(dataDir)
  try {
    return await storeLib.appendRecords(await storeLib.openDiary(s), records)
  } finally {
    await s.close()
  }
}

function descriptor (core, start, blocks = 1) {
  return { core, mime: 'image/webp', start, blocks, bytes: (blocks - 1) * 32768 + 1000, sha256: 'e'.repeat(64), width: 512, height: 512 }
}

function range (d) {
  return { core: d.core, start: d.start, blocks: d.blocks }
}

function tombstones (log) {
  return log.entries.filter((e) => e.record.type === 'delete').map((e) => e.record)
}

test('listing.create, listing.edit and listing.mine: the root ref stays, the old edit is tombstoned', async (t) => {
  const m = await member(t)
  const created = await m.call('listing.create', { kind: 'produto', ...FIELDS })
  t.alike(created, { seq: 1, ref: m.publicKey + ':1' })

  let mine = await m.call('listing.mine', {})
  t.is(mine.items.length, 1)
  t.alike(mine.items[0], { seq: 1, editSeq: null, statusSeq: null, kind: 'produto', status: 'disponivel', ...FIELDS, media: [], at: mine.items[0].at, editedAt: null })
  t.is(mine.next, null)

  // A browser device edits first, with photos in a declared core.
  const photo = descriptor(CORE, 1, 2)
  const browserEdit = await appendDirect(m.dataDir, [
    mediaCoreRecord({ key: CORE, at: AT }),
    listingEditRecord({ seq: 1, ...FIELDS, title: 'Bicicleta azul', media: [photo], at: AT })
  ])
  const before = await m.call('log.read')
  t.alike(await failure(m.call('listing.edit', { to: created.ref, expectedRevision: 0, ...FIELDS, title: 'Nova', media: null })), { code: 'USAGE', message: 'conflito' }, 'stale revision')
  t.alike(await m.call('log.read'), before, 'nothing appended on a conflict')

  const edited = await m.call('listing.edit', { to: created.ref, expectedRevision: browserEdit, ...FIELDS, title: 'Bicicleta vermelha', price: 45000, media: null })
  t.alike(edited, { seq: browserEdit + 1, ref: created.ref })
  const log = await m.call('log.read')
  t.alike(tombstones(log), [{ type: 'delete', seq: browserEdit, at: tombstones(log)[0].at, media: [range(photo)] }], 'the replaced edit is tombstoned with its photo')
  t.is(log.entries[log.entries.length - 1].record.type, 'delete', 'edit and tombstone in one append')

  mine = await m.call('listing.mine', {})
  t.is(mine.items.length, 1)
  t.is(mine.items[0].seq, 1, 'same root')
  t.is(mine.items[0].title, 'Bicicleta vermelha')
  t.is(mine.items[0].price, 45000)
  t.is(mine.items[0].editSeq, edited.seq)
  t.alike(mine.items[0].media, [])

  t.alike(await failure(m.call('listing.edit', { to: created.ref, expectedRevision: browserEdit, ...FIELDS, media: null })), { code: 'USAGE', message: 'conflito' }, 'the tombstoned edit is stale too')
  t.alike(await failure(m.call('listing.edit', { to: created.ref, expectedRevision: edited.seq, ...FIELDS, unit: 'hora', media: null })), { code: 'USAGE', message: 'parâmetro inválido: unit' }, 'unit checked against the root kind')

  const feed = await m.call('feed.read', { limit: 20 })
  t.alike(feed.items.filter((i) => i.author === m.publicKey), [], 'listings are not feed items')
  t.alike(m.session.internal, [], 'no internal error')
})

test('listing.status folds into listing.mine and is refused off a listing', async (t) => {
  const m = await member(t)
  const product = await m.call('listing.create', { kind: 'produto', ...FIELDS })
  const wanted = await m.call('listing.create', { kind: 'procura', ...FIELDS, title: 'Procuro sofá', price: null, cat: 'moveis' })
  const post = await m.call('post.create', { text: 'oi' })

  const st = await m.call('listing.status', { to: product.ref, status: 'vendido' })
  t.alike(st, { seq: post.seq + 1, ref: product.ref })
  const mine = await m.call('listing.mine', {})
  t.alike(mine.items.map((i) => [i.seq, i.status, i.statusSeq]), [[wanted.seq, 'disponivel', null], [product.seq, 'vendido', st.seq]])

  const before = await m.call('log.read')
  t.alike(await failure(m.call('listing.status', { to: post.ref, status: 'vendido' })), NOT_A_LISTING, 'a post')
  t.alike(await failure(m.call('listing.status', { to: wanted.ref, status: 'reservado' })), { code: 'USAGE', message: 'uma procura não fica reservada' })
  t.alike(await failure(m.call('listing.status', { to: 'ab'.repeat(32) + ':1', status: 'vendido' })), { code: 'USAGE', message: 'referência inválida' }, 'another author')
  t.alike(await failure(m.call('listing.edit', { to: post.ref, expectedRevision: 0, ...FIELDS, media: null })), NOT_A_LISTING)
  t.alike(await m.call('log.read'), before, 'nothing appended')
  t.ok((await m.call('listing.status', { to: wanted.ref, status: 'vendido' })).seq > 0, 'a procura can be found')
  t.alike(m.session.internal, [], 'no internal error')
})

test('listing.create stops at the 31st live root; media is refused before anything opens', async (t) => {
  const m = await member(t)
  const roots = []
  for (let i = 0; i < feira.MAX_LISTINGS - 1; i++) roots.push(listingRecord({ kind: 'produto', ...FIELDS, at: AT }))
  // An append takes at most eight records.
  for (let i = 0; i < roots.length; i += 8) await appendDirect(m.dataDir, roots.slice(i, i + 8))
  const last = await m.call('listing.create', { kind: 'produto', ...FIELDS })
  t.is(last.seq, feira.MAX_LISTINGS)
  const before = await m.call('log.read')
  t.alike(await failure(m.call('listing.create', { kind: 'produto', ...FIELDS })), { code: 'USAGE', message: 'limite' })

  t.alike(await failure(m.call('listing.create', { kind: 'produto', ...FIELDS, media: [descriptor(CORE, 1)] })), MEDIA_WEB_ONLY)
  t.alike(await failure(m.call('listing.edit', { to: last.ref, expectedRevision: 0, ...FIELDS, media: [descriptor(CORE, 1)] })), MEDIA_WEB_ONLY)
  t.alike(await m.call('log.read'), before, 'nothing appended')

  // A deleted root frees its slot.
  await m.call('listing.delete', { to: last.ref })
  t.ok((await m.call('listing.create', { kind: 'produto', ...FIELDS })).seq > 0)
  t.alike(m.session.internal, [], 'no internal error')
})

test('listing.delete hides the listing and tombstones the root and its live edit', async (t) => {
  const m = await member(t)
  const rootPhoto = descriptor(CORE, 1)
  const editPhoto = descriptor(CORE, 2)
  const editSeq = await appendDirect(m.dataDir, [
    mediaCoreRecord({ key: CORE, at: AT }),
    listingRecord({ kind: 'servico', ...FIELDS, unit: 'hora', cat: 'reparos', media: [rootPhoto], at: AT }),
    listingEditRecord({ seq: 2, ...FIELDS, unit: 'hora', cat: 'reparos', media: [editPhoto], at: AT })
  ])
  const ref = m.publicKey + ':2'
  const keep = await m.call('listing.create', { kind: 'produto', ...FIELDS })

  const d = await m.call('listing.delete', { to: ref })
  t.alike(d, { seq: keep.seq + 2, ref: m.publicKey + ':' + (keep.seq + 2), changed: true, deleted: [2, editSeq] })
  const log = await m.call('log.read')
  const at = tombstones(log)[0].at
  t.alike(tombstones(log), [
    { type: 'delete', seq: 2, at, media: [range(rootPhoto)] },
    { type: 'delete', seq: editSeq, at, media: [range(editPhoto)] }
  ])
  t.alike((await m.call('listing.mine', {})).items.map((i) => i.seq), [keep.seq], 'only the kept listing')

  t.alike(await m.call('listing.delete', { to: ref }), { seq: keep.seq + 1, ref: m.publicKey + ':' + (keep.seq + 1), changed: false, deleted: [2] }, 'a second call writes nothing')
  t.alike(await m.call('log.read'), log)
  const post = await m.call('post.create', { text: 'oi' })
  t.alike(await failure(m.call('listing.delete', { to: post.ref })), NOT_A_LISTING)
  t.alike(await failure(m.call('post.delete', { to: keep.ref })), { code: 'USAGE', message: 'não é possível apagar este registro' }, 'post.delete still refuses a listing')
  t.alike(m.session.internal, [], 'no internal error')
})

test('listing.rate lands only with the listing author consent', async (t) => {
  const m = await member(t)
  const seller = crypto.keyPair()
  const author = b4a.toString(seller.publicKey, 'hex')
  const to = author + ':3'
  const sign = (rater) => b4a.toString(crypto.sign(b4a.from(feira.dealPayload({ listingAuthor: author, listingSeq: 3, rater, offerId: OFFER })), seller.secretKey), 'hex')
  const before = await m.call('log.read')

  const other = b4a.toString(crypto.keyPair().publicKey, 'hex')
  t.alike(await failure(m.call('listing.rate', { to, offer: OFFER, consent: sign(other), stars: 5, text: '' })), { code: 'USAGE', message: 'consentimento inválido' }, 'consent for another rater')
  t.alike(await failure(m.call('listing.rate', { to: author + ':4', offer: OFFER, consent: sign(m.publicKey), stars: 5, text: '' })), { code: 'USAGE', message: 'consentimento inválido' }, 'consent for another listing')
  t.alike(await m.call('log.read'), before, 'nothing appended')

  const r = await m.call('listing.rate', { to, offer: OFFER, consent: sign(m.publicKey), stars: 4, text: 'ótimo' })
  t.alike(r, { seq: 1, ref: m.publicKey + ':1' })
  const record = (await m.call('log.read')).entries[1].record
  t.alike(record, { type: 'listing-rate', to: { author, seq: 3 }, offer: OFFER, consent: sign(m.publicKey), stars: 4, text: 'ótimo', at: record.at })
  t.alike(m.session.internal, [], 'no internal error')
})

test('listing.rate writes one rating per offer, never rewritten, even after a tombstone', async (t) => {
  const m = await member(t)
  const seller = crypto.keyPair()
  const author = b4a.toString(seller.publicKey, 'hex')
  const to = author + ':3'
  const sign = (offerId) => b4a.toString(crypto.sign(b4a.from(feira.dealPayload({ listingAuthor: author, listingSeq: 3, rater: m.publicKey, offerId })), seller.secretKey), 'hex')
  const SENT = { code: 'USAGE', message: 'avaliação já enviada para esta oferta' }
  const first = await m.call('listing.rate', { to, offer: OFFER, consent: sign(OFFER), stars: 5, text: 'ótimo' })
  const before = await m.call('log.read')
  t.alike(await failure(m.call('listing.rate', { to, offer: OFFER, consent: sign(OFFER), stars: 1, text: 'mudei' })), SENT, 'a second rating of the offer')
  t.alike(await m.call('log.read'), before, 'nothing appended')

  // A tombstone another client wrote: the offer stays spent.
  await appendDirect(m.dataDir, [deleteRecord({ seq: first.seq, at: AT })])
  t.alike(await failure(m.call('listing.rate', { to, offer: OFFER, consent: sign(OFFER), stars: 1, text: 'mudei' })), SENT, 'delete then rate cannot rewrite')
  const other = 'fe'.repeat(16)
  const next = await m.call('listing.rate', { to, offer: other, consent: sign(other), stars: 4, text: 'outra compra' })
  t.ok(next.seq > first.seq, 'another offer is another deal')
})

test('listing.consent and listing.ratings are web only; listing.mine pages with before', async (t) => {
  const m = await member(t)
  t.alike(await failure(m.call('listing.consent', { to: m.publicKey + ':1', rater: 'ab'.repeat(32), offer: OFFER })), { code: 'USAGE', message: 'assinatura disponível só no navegador' })
  t.alike(await failure(m.call('listing.ratings', { author: m.publicKey, seq: 1, refs: [{ rater: 'ab'.repeat(32), seq: 1 }] })), { code: 'USAGE', message: 'leitura sob demanda só na versão web' })

  const a = await m.call('listing.create', { kind: 'produto', ...FIELDS, title: 'A' })
  const b = await m.call('listing.create', { kind: 'produto', ...FIELDS, title: 'B' })
  const c = await m.call('listing.create', { kind: 'produto', ...FIELDS, title: 'C' })
  const first = await m.call('listing.mine', { limit: 2 })
  t.alike(first.items.map((i) => i.title), ['C', 'B'])
  t.is(first.next, b.seq)
  const second = await m.call('listing.mine', { limit: 2, before: first.next })
  t.alike(second.items.map((i) => i.seq), [a.seq])
  t.is(second.next, null)
  t.alike((await m.call('listing.mine', { before: c.seq })).items.map((i) => i.title), ['B', 'A'])
  t.alike(m.session.internal, [], 'no internal error')
})
