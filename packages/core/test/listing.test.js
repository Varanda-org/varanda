'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { feira } = require('@varanda/rpc')
const { validateRecord } = require('../lib/records')
const { deletedRanges } = require('../lib/deletion')
const {
  foldListings, countLive, liveEditOf, displayedMedia, editPlan, deletePlan, verifyConsent, certOldEnough, FUTURE_MS
} = require('../lib/listing')

const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)
const MC = 'c'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const PLACE = { uf: 'PE', city: 'Recife', bairro: 'Boa Vista' }

const desc = (start, blocks = 1) => ({ core: MC, mime: 'image/webp', start, blocks, bytes: blocks * 1000, sha256: 'e'.repeat(64), width: 512, height: 512 })
const range = (d) => ({ core: d.core, start: d.start, blocks: d.blocks })
const genesis = { seq: 0, record: { type: 'member-cert', cert: { v: 1, member: K1, ageBand: '18+', method: 'stub', date: AT, association: K2, signature: 'c'.repeat(128) } } }

function listing (seq, over = {}) {
  return { seq, record: { type: 'listing', kind: 'produto', title: 'Mesa', text: '', price: 100, unit: null, cat: 'moveis', place: PLACE, at: AT, ...over } }
}
function edit (seq, target, over = {}) {
  return { seq, record: { type: 'listing-edit', seq: target, title: 'Mesa ' + seq, text: '', price: 90, unit: null, cat: 'moveis', place: PLACE, at: AT, ...over } }
}
const status = (seq, target, s) => ({ seq, record: { type: 'listing-status', seq: target, status: s, at: AT } })
const del = (seq, target, media) => ({ seq, record: media ? { type: 'delete', seq: target, at: AT, media } : { type: 'delete', seq: target, at: AT } })
const post = (seq, extra = {}) => ({ seq, record: { type: 'post', text: 'oi', at: AT, replyTo: null, ...extra } })
const snapshot = (over = {}) => ({ title: 'Mesa nova', text: '', price: 80, unit: null, cat: 'moveis', place: PLACE, at: AT, ...over })

function fold (entries) {
  return foldListings(entries, NOW)
}

test('fold: a root alone is disponivel with its own content', (t) => {
  const { items, bySeq } = fold([genesis, listing(1)])
  t.is(items.length, 1)
  t.alike(bySeq.get(1), items[0])
  t.is(items[0].status, 'disponivel')
  t.is(items[0].statusSeq, null)
  t.is(items[0].editSeq, null)
  t.is(items[0].record.title, 'Mesa')
  t.is(items[0].future, false)
})

test('fold: the last status wins', (t) => {
  const item = fold([genesis, listing(1), status(2, 1, 'reservado'), status(3, 1, 'vendido')]).items[0]
  t.is(item.status, 'vendido')
  t.is(item.statusSeq, 3)
})

test('fold: vendido then disponivel restores', (t) => {
  const item = fold([genesis, listing(1), status(2, 1, 'vendido'), status(3, 1, 'disponivel')]).items[0]
  t.is(item.status, 'disponivel')
  t.is(item.statusSeq, 3)
})

test('fold: a deleted status falls back to the earlier one', (t) => {
  const item = fold([genesis, listing(1), status(2, 1, 'reservado'), status(3, 1, 'vendido'), del(4, 3)]).items[0]
  t.is(item.status, 'reservado')
})

test('fold: reservado on a procura is ignored', (t) => {
  const item = fold([genesis, listing(1, { kind: 'procura' }), status(2, 1, 'vendido'), status(3, 1, 'reservado')]).items[0]
  t.is(item.status, 'vendido')
  t.is(item.statusSeq, 2)
})

test('fold: the latest live edit wins, a tombstoned edit falls back', (t) => {
  const base = [genesis, listing(1), edit(2, 1), edit(3, 1)]
  let item = fold(base).items[0]
  t.is(item.editSeq, 3)
  t.is(item.record.title, 'Mesa 3')
  t.is(item.record.kind, 'produto', 'kind is the root\'s')
  t.is(item.record.at, AT)
  item = fold([...base, del(4, 3)]).items[0]
  t.is(item.editSeq, 2)
  t.is(item.record.title, 'Mesa 2')
  item = fold([...base, del(4, 3), del(5, 2)]).items[0]
  t.is(item.editSeq, null)
  t.is(item.record.title, 'Mesa')
})

test('fold: an edit or status targeting a post or an edit is ignored', (t) => {
  const { items } = fold([genesis, post(1), edit(2, 1), status(3, 1, 'vendido'), listing(4), edit(5, 4), edit(6, 5), status(7, 5, 'vendido')])
  t.is(items.length, 1)
  t.is(items[0].seq, 4)
  t.is(items[0].editSeq, 5)
  t.is(items[0].status, 'disponivel')
})

test('fold: a deleted root hides its edits and later statuses', (t) => {
  const { items } = fold([genesis, listing(1), edit(2, 1), del(3, 1), status(4, 1, 'vendido'), edit(5, 1)])
  t.is(items.length, 0)
})

test('fold: an edit with a unit illegal for the root kind is ignored', (t) => {
  const entries = [genesis, listing(1), edit(2, 1, { unit: 'hora' })]
  t.is(validateRecord(entries[2].record, 2), null, 'valid alone: an edit is checked as a servico')
  t.is(fold(entries).items[0].editSeq, null)
  t.is(fold([genesis, listing(1, { kind: 'servico' }), edit(2, 1, { unit: 'hora' })]).items[0].editSeq, 2)
})

test('fold: a far future root is flagged, not dropped', (t) => {
  const at = new Date(NOW + FUTURE_MS + 1000).toISOString()
  const item = fold([genesis, listing(1, { at })]).items[0]
  t.ok(item.future)
  t.is(fold([genesis, listing(1, { at: new Date(NOW + FUTURE_MS).toISOString() })]).items[0].future, false)
})

test('fold: hostile and invalid entries never throw', (t) => {
  const hostile = { seq: 1, get record () { throw new Error('boom') } }
  t.alike(fold(null), { items: [], bySeq: new Map() })
  t.is(fold([genesis, hostile, null, 7, listing(2), { seq: 3, record: { type: 'listing' } }]).items.length, 1)
})

test('countLive excludes deleted roots, edits, statuses and rates', (t) => {
  const rate = { seq: 6, record: { type: 'listing-rate', to: { author: K2, seq: 1 }, offer: 'f'.repeat(32), consent: 'c'.repeat(128), stars: 5, text: '', at: AT } }
  t.is(countLive([genesis, listing(1), listing(2), edit(3, 1), status(4, 2, 'vendido'), del(5, 1), rate]), 1)
  t.is(countLive([]), 0)
})

test('liveEditOf and displayedMedia', (t) => {
  const a = desc(1)
  const b = desc(2)
  const entries = [genesis, listing(1, { media: [a] }), edit(2, 1, { media: [b] })]
  t.alike(liveEditOf(entries, 1).seq, 2)
  t.is(liveEditOf(entries, 9), null)
  t.alike(displayedMedia(entries, 1), [b])
  t.alike(displayedMedia([genesis, listing(1, { media: [a] })], 1), [a])
  t.alike(displayedMedia([genesis, listing(1)], 1), [])
  t.alike(displayedMedia(entries, 9), [])
})

test('editPlan: a first edit writes one record', (t) => {
  const { records } = editPlan([genesis, listing(1)], 1, snapshot())
  t.is(records.length, 1)
  t.is(records[0].type, 'listing-edit')
  t.is(records[0].seq, 1)
  t.exception.all(() => editPlan([genesis, listing(1)], 1, snapshot({ unit: 'hora' })), /unit-invalid/)
  t.exception.all(() => editPlan([genesis, post(1)], 1, snapshot()), /not-found/)
  t.exception.all(() => editPlan([genesis, listing(1)], 1, snapshot({ title: '' })), /name-length/)
})

test('editPlan: tombstones the previous edit and protects shared ranges', (t) => {
  const root = desc(1)
  const shared = desc(2)
  const kept = desc(3)
  const own = desc(4)
  const inPost = desc(5)
  const entries = [genesis, listing(1, { media: [root] }), post(2, { text: '', media: [inPost] }), edit(3, 1, { media: [root, shared, own, inPost] })]
  const { records } = editPlan(entries, 1, snapshot({ media: [shared, kept] }))
  t.is(records.length, 2)
  t.is(records[1].type, 'delete')
  t.is(records[1].seq, 3)
  t.alike(records[1].media, [range(own)], 'root, new snapshot and post ranges stay')
  const log = [...entries, { seq: 4, record: records[0] }, { seq: 5, record: records[1] }]
  t.is(validateRecord(records[0], 4), null)
  t.is(validateRecord(records[1], 5), null)
  t.is(fold(log).items[0].editSeq, 4)
  t.alike(deletedRanges(log, [MC]), [range(own)])
})

test('editPlan: no freed range means a plain tombstone', (t) => {
  const a = desc(1)
  const entries = [genesis, listing(1, { media: [a] }), edit(2, 1, { media: [a] })]
  const { records } = editPlan(entries, 1, snapshot())
  t.is(records.length, 2)
  t.absent('media' in records[1])
})

test('deletePlan carries both tombstones with protected ranges', (t) => {
  const a = desc(1)
  const b = desc(2)
  const c = desc(3)
  const entries = [genesis, listing(1, { media: [a, c] }), post(2, { text: '', media: [c] }), edit(3, 1, { media: [a, b] })]
  const plan = deletePlan(entries, 1)
  t.is(plan.length, 2)
  t.is(plan[0].seq, 1)
  t.alike(plan[0].media, [range(a)])
  t.is(plan[1].seq, 3)
  t.alike(plan[1].media, [range(b)])
  const log = [...entries, { seq: 4, record: plan[0] }, { seq: 5, record: plan[1] }]
  t.is(fold(log).items.length, 0)
  t.alike(deletedRanges(log, [MC]), [range(b), range(a)], 'highest tombstone first')
  const lone = deletePlan([genesis, listing(1)], 1)
  t.is(lone.length, 1)
  t.absent('media' in lone[0])
  t.exception.all(() => deletePlan([genesis, post(1)], 1), /not-found/)
})

test('verifyConsent: a real signature, a swapped rater, a wrong offer, a self-rating', (t) => {
  const seller = crypto.keyPair()
  const buyer = crypto.keyPair()
  const listingAuthor = b4a.toString(seller.publicKey, 'hex')
  const rater = b4a.toString(buyer.publicKey, 'hex')
  const offerId = '1'.repeat(32)
  const payload = feira.dealPayload({ listingAuthor, listingSeq: 4, rater, offerId })
  const consent = b4a.toString(crypto.sign(b4a.from(payload), seller.secretKey), 'hex')
  t.ok(verifyConsent({ listingAuthor, listingSeq: 4, rater, offerId, consent }))
  t.absent(verifyConsent({ listingAuthor, listingSeq: 4, rater: K2, offerId, consent }), 'swapped rater')
  t.absent(verifyConsent({ listingAuthor, listingSeq: 4, rater, offerId: '2'.repeat(32), consent }), 'wrong offer id')
  t.absent(verifyConsent({ listingAuthor, listingSeq: 5, rater, offerId, consent }), 'wrong listing')
  const self = b4a.toString(crypto.sign(b4a.from(feira.dealPayload({ listingAuthor, listingSeq: 4, rater: listingAuthor, offerId })), seller.secretKey), 'hex')
  t.absent(verifyConsent({ listingAuthor, listingSeq: 4, rater: listingAuthor, offerId, consent: self }), 'self-rating')
  t.absent(verifyConsent({ listingAuthor: 'x', listingSeq: 4, rater, offerId, consent }))
  t.absent(verifyConsent())
})

test('certOldEnough: seven days boundary', (t) => {
  const date = '2026-05-01T00:00:00.000Z'
  const ms = Date.parse(date)
  t.ok(certOldEnough(date, ms + feira.RATE_MIN_AGE_MS))
  t.absent(certOldEnough(date, ms + feira.RATE_MIN_AGE_MS - 1))
  t.absent(certOldEnough('2026-05-01', ms + 10 * feira.RATE_MIN_AGE_MS))
  t.absent(certOldEnough(date, NaN))
  t.absent(certOldEnough(null, NOW))
})

test('deletePlan tombstones the root and every live edit, newest first', (t) => {
  const a = desc(1)
  const b = desc(2)
  const c = desc(3)
  const entries = [genesis, listing(1, { media: [a] }), edit(2, 1, { media: [b] }), edit(3, 1, { media: [c] })]
  const plan = deletePlan(entries, 1)
  t.alike(plan.map((r) => r.seq), [1, 3, 2])
  const log = entries.concat(plan.map((record, i) => ({ seq: 4 + i, record })))
  for (let i = 0; i < plan.length; i++) t.is(validateRecord(plan[i], 4 + i), null)
  const freed = deletedRanges(log, [MC])
  t.ok(freed.some((r) => r.start === 2), 'the older edit photo is freed too')
  t.is(freed.length, 3)
})

test('deletePlan carries at most the root and the newest 7 edits', (t) => {
  const entries = [genesis, listing(1)]
  for (let s = 2; s <= 11; s++) entries.push(edit(s, 1))
  const plan = deletePlan(entries, 1)
  t.is(plan.length, 8)
  t.alike(plan.map((r) => r.seq), [1, 11, 10, 9, 8, 7, 6, 5])
})

test('editPlan: media null drops the photos, the root keeps its own live', (t) => {
  const a = desc(1)
  const b = desc(2)
  const entries = [genesis, listing(1, { media: [a] }), edit(2, 1, { media: [b] })]
  const { records } = editPlan(entries, 1, snapshot({ media: null }))
  t.absent('media' in records[0])
  t.is(validateRecord(records[0], 3), null)
  t.alike(records[1].media, [range(b)])
  const log = [...entries, { seq: 3, record: records[0] }, { seq: 4, record: records[1] }]
  t.alike(displayedMedia(log, 1), [])
  t.alike(deletedRanges(log, [MC]), [range(b)], 'the root photo stays live')
  const gone = [...log, ...deletePlan(log, 1).map((record, i) => ({ seq: 5 + i, record }))]
  t.ok(deletedRanges(gone, [MC]).some((r) => r.start === 1), 'freed once the root is deleted')
  t.absent('media' in editPlan([genesis, listing(1)], 1, snapshot({ media: [] })).records[0])
})
