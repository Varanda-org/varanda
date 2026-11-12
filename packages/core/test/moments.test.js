'use strict'

const test = require('brittle')
const { momentRecord, postRecord, deleteRecord, formatRef } = require('../lib/records')
const { MOMENT_TTL_MS, MOMENT_SKEW_MS, MAX_MOMENT_AUTHORS, MAX_MOMENTS_PER_AUTHOR, MAX_PAST_MOMENTS, foldMoments, ownPast, showingMoment } = require('../lib/moments')
const { MAX_FUTURE_MS } = require('../lib/feed')

const NOW = Date.parse('2026-06-01T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const keyOf = (i) => i.toString(16).padStart(64, '0')
const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)

function media (over = {}) {
  return { id: 'a'.repeat(64), key: 'b'.repeat(64), nonce: 'c'.repeat(48), chunks: 1, bytes: 1000, sha256: 'd'.repeat(64), mime: 'image/webp', w: 640, h: 480, ms: 0, ...over }
}

function moment (agoMs, text = 'oi') {
  return momentRecord({ text, media: media(), at: iso(NOW - agoMs) })
}

// A log of { seq, record } with seq 0 left out, as feed.js receives entries.
function log (key, records) {
  return { key, entries: records.map((record, i) => ({ seq: i + 1, record })) }
}

test('moments: constants', async (t) => {
  t.is(MOMENT_TTL_MS, 86400000)
  t.alike([MAX_MOMENT_AUTHORS, MAX_MOMENTS_PER_AUTHOR, MAX_PAST_MOMENTS], [32, 4, 16])
})

test('foldMoments: shape, order and the record copy', async (t) => {
  const recs = [moment(3000, 'antes'), postRecord({ text: 'post', at: iso(NOW - 2000) }), moment(1000, 'depois')]
  const logs = [log(K1, recs)]
  const out = foldMoments({ logs, now: NOW })
  t.alike(out, {
    authors: [{
      author: K1,
      items: [
        { seq: 3, ref: formatRef({ author: K1, seq: 3 }), text: 'depois', at: iso(NOW - 1000), media: media() },
        { seq: 1, ref: formatRef({ author: K1, seq: 1 }), text: 'antes', at: iso(NOW - 3000), media: media() }
      ]
    }]
  })
  out.authors[0].items[0].media.mime = 'image/png'
  t.is(recs[2].media.mime, 'image/webp', 'the caller record is never shared')
  // Authors by their newest moment.
  const two = foldMoments({ logs: [log(K1, [moment(5000)]), log(K2, [moment(1000)])], now: NOW })
  t.alike(two.authors.map((a) => a.author), [K2, K1])
  t.alike(foldMoments({ logs: [], now: NOW }), { authors: [] })
  t.alike(foldMoments({ logs: [log(K1, [postRecord({ text: 'oi', at: iso(NOW) })])], now: NOW }), { authors: [] }, 'an author with no moment is left out')
})

test('foldMoments: expiry boundary and future moments', async (t) => {
  const just = foldMoments({ logs: [log(K1, [moment(MOMENT_TTL_MS - 1)])], now: NOW })
  t.is(just.authors[0].items.length, 1, 'one millisecond before 24 h still shows')
  t.alike(foldMoments({ logs: [log(K1, [moment(MOMENT_TTL_MS)])], now: NOW }), { authors: [] }, 'exactly at + 24 h hides')
  t.alike(foldMoments({ logs: [log(K1, [moment(MOMENT_TTL_MS + 1)])], now: NOW }), { authors: [] })
  t.is(foldMoments({ logs: [log(K1, [moment(-MOMENT_SKEW_MS)])], now: NOW }).authors.length, 1, 'up to the clock skew allowance shows')
  t.alike(foldMoments({ logs: [log(K1, [moment(-MOMENT_SKEW_MS - 1)])], now: NOW }), { authors: [] }, 'further ahead is hidden')
  t.alike(foldMoments({ logs: [log(K1, [moment(-MAX_FUTURE_MS + 1000)])], now: NOW }), { authors: [] }, 'a date within the feed allowance (24 h) is still hidden')
  // No forward date buys more than 24 h plus the skew on screen.
  const ahead = moment(-60 * 60 * 1000)
  const shownAt = (dt) => foldMoments({ logs: [log(K1, [ahead])], now: NOW + dt }).authors.length
  t.is(shownAt(0), 0, 'dated 1 h ahead: hidden now')
  t.is(shownAt(60 * 60 * 1000), 1, 'shows when its time comes')
  t.is(shownAt(60 * 60 * 1000 + MOMENT_TTL_MS), 0, 'and is gone 24 h after its date')
  t.ok(MOMENT_SKEW_MS <= 10 * 60 * 1000)
})

test('foldMoments: a tombstone hides the moment', async (t) => {
  const recs = [moment(2000, 'um'), moment(1000, 'dois'), deleteRecord({ seq: 2, at: iso(NOW) })]
  const out = foldMoments({ logs: [log(K1, recs)], now: NOW })
  t.alike(out.authors[0].items.map((i) => i.text), ['um'])
  t.alike(foldMoments({ logs: [log(K1, [moment(1000), deleteRecord({ seq: 1, at: iso(NOW) })])], now: NOW }), { authors: [] })
  // A tombstone in another diary targets nothing.
  const other = foldMoments({ logs: [log(K1, [moment(1000)]), log(K2, [moment(9000), deleteRecord({ seq: 1, at: iso(NOW) })])], now: NOW })
  t.alike(other.authors.map((a) => a.author), [K1])
})

test('foldMoments: caps of MAX_MOMENT_AUTHORS authors and MAX_MOMENTS_PER_AUTHOR items', async (t) => {
  const logs = []
  for (let i = 1; i <= MAX_MOMENT_AUTHORS + 1; i++) logs.push(log(keyOf(i), [moment(i * 1000)]))
  const out = foldMoments({ logs, now: NOW })
  t.is(out.authors.length, MAX_MOMENT_AUTHORS)
  t.ok(!out.authors.some((a) => a.author === keyOf(MAX_MOMENT_AUTHORS + 1)), 'the author with the oldest moment is cut')
  const over = []
  for (let i = 1; i <= MAX_MOMENTS_PER_AUTHOR + 1; i++) over.push(moment(i * 1000, 'm' + i))
  const items = foldMoments({ logs: [log(K1, over)], now: NOW }).authors[0].items
  t.is(items.length, MAX_MOMENTS_PER_AUTHOR)
  t.alike(items.map((i) => i.text), Array.from({ length: MAX_MOMENTS_PER_AUTHOR }, (_, i) => 'm' + (i + 1)), 'the oldest one is cut')
})

test('foldMoments: hostile and malformed input', async (t) => {
  const bad = { ...moment(1000), media: media({ mime: 'audio/mp4', w: 0, h: 0, ms: 2000 }) }
  const extra = { ...moment(1000), extra: 1 }
  const hostile = {}
  Object.defineProperty(hostile, 'record', { enumerable: true, get () { throw new Error('boom') } })
  Object.defineProperty(hostile, 'seq', { enumerable: true, value: 4 })
  const throwingLog = {}
  Object.defineProperty(throwingLog, 'key', { enumerable: true, get () { throw new Error('boom') } })
  const logs = [
    { key: K1, entries: [{ seq: 1, record: bad }, { seq: 2, record: extra }, null, { seq: 'x', record: moment(1) }, hostile, { seq: 5, record: moment(500) }] },
    { key: 'not a key', entries: [{ seq: 1, record: moment(1) }] },
    { key: K2, entries: 'nope' },
    throwingLog,
    null,
    log(K1, [moment(1, 'duplicate key is ignored')])
  ]
  const out = foldMoments({ logs, now: NOW })
  t.alike(out.authors.map((a) => [a.author, a.items.map((i) => i.seq)]), [[K1, [5]]])
  t.alike(foldMoments({ logs: null, now: NOW }), { authors: [] })
  await t.exception.all(async () => foldMoments({ logs: [], now: NaN }), /now/)
  await t.exception.all(async () => ownPast(log(K1, []), '1'), /now/)
})

test('ownPast: only the own expired, live moments', async (t) => {
  const recs = [
    moment(MOMENT_TTL_MS + 3000, 'velho'),
    moment(MOMENT_TTL_MS, 'no limite'),
    moment(MOMENT_TTL_MS - 1, 'ainda vale'),
    postRecord({ text: 'post antigo', at: iso(NOW - 2 * MOMENT_TTL_MS) }),
    moment(MOMENT_TTL_MS + 5000, 'apagado'),
    deleteRecord({ seq: 5, at: iso(NOW) })
  ]
  t.alike(ownPast(log(K1, recs), NOW), [
    { seq: 2, ref: formatRef({ author: K1, seq: 2 }), text: 'no limite', at: iso(NOW - MOMENT_TTL_MS) },
    { seq: 1, ref: formatRef({ author: K1, seq: 1 }), text: 'velho', at: iso(NOW - MOMENT_TTL_MS - 3000) }
  ])
  const many = []
  for (let i = 1; i <= MAX_PAST_MOMENTS + 1; i++) many.push(moment(MOMENT_TTL_MS + i * 1000, 'p' + i))
  const past = ownPast(log(K1, many), NOW)
  t.is(past.length, MAX_PAST_MOMENTS)
  t.is(past[0].text, 'p1')
  t.is(past[MAX_PAST_MOMENTS - 1].text, 'p' + MAX_PAST_MOMENTS, 'the oldest one is cut')
  t.alike(ownPast(null, NOW), [])
  t.alike(ownPast({ key: 'x', entries: [] }, NOW), [])
})

test('showingMoment: one moment by seq, without the list caps', async (t) => {
  const recs = []
  for (let i = 1; i <= MAX_MOMENTS_PER_AUTHOR + 2; i++) recs.push(moment(i * 1000, 'm' + i))
  const l = log(K1, recs)
  const oldest = recs.length
  t.absent(foldMoments({ logs: [l], now: NOW }).authors[0].items.some((i) => i.seq === oldest), 'cut from the list')
  t.alike(showingMoment(l, oldest, NOW), recs[oldest - 1].media, 'still has its photo while in its 24 h')
  t.is(showingMoment(log(K1, [moment(MOMENT_TTL_MS)]), 1, NOW), null, 'expired')
  t.is(showingMoment(log(K1, [moment(-MOMENT_SKEW_MS - 1)]), 1, NOW), null, 'too far ahead')
  t.is(showingMoment(log(K1, [moment(1000), deleteRecord({ seq: 1, at: iso(NOW) })]), 1, NOW), null, 'deleted')
  t.is(showingMoment(log(K1, [postRecord({ text: 'oi', at: iso(NOW) })]), 1, NOW), null, 'not a moment')
  t.is(showingMoment(null, 1, NOW), null)
  t.is(showingMoment(l, 0, NOW), null)
})

test('a verified page-close or page-moved ends the moments of a page, as in the feed', async (t) => {
  const crypto = require('hypercore-crypto')
  const b4a = require('b4a')
  const { createCert, createIssuerCert } = require('../lib/cert')
  const { signMoved, signClose, issuerCountersign } = require('../lib/page-lifecycle')
  const hex = (kp) => b4a.toString(kp.publicKey, 'hex')
  const AT = iso(NOW - 3000)
  const assocKp = crypto.keyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp), date: AT }, assocKp)
  const assoc = issuerCert.association
  const ownerKp = crypto.keyPair()
  const P = hex(crypto.keyPair())
  const cfields = { type: 'page-close', page: P, gen: 2, at: AT, nonce: 'c'.repeat(43), actor: hex(ownerKp), association: assoc }
  const closed = issuerCountersign({ ...cfields, signature: signClose(cfields, ownerKp) }, issuerKp, issuerCert)
  const mfields = { type: 'page-moved', page: P, to: 'd'.repeat(64), gen: 2, at: AT, nonce: 'm'.repeat(43), actor: hex(ownerKp), association: assoc }
  const moved = issuerCountersign({ ...mfields, signature: signMoved(mfields, ownerKp) }, issuerKp, issuerCert)
  const pageLog = (end) => ({
    key: P,
    entries: [
      { seq: 0, record: createCert({ member: P }, assocKp) },
      { seq: 1, record: moment(4000, 'antes') },
      { seq: 2, record: end },
      { seq: 3, record: moment(1000, 'depois') }
    ]
  })
  for (const [end, what] of [[closed, 'page-close'], [moved, 'page-moved']]) {
    const out = foldMoments({ logs: [pageLog(end)], now: NOW, association: assoc })
    t.alike(out.authors[0].items.map((i) => i.text), ['antes'], what + ': a moment after the cut is hidden')
    t.is(showingMoment(pageLog(end), 3, NOW, { association: assoc }), null, what + ': and its photo')
    t.ok(showingMoment(pageLog(end), 1, NOW, { association: assoc }), what + ': one before the cut keeps its photo')
    const other = foldMoments({ logs: [pageLog(end)], now: NOW, association: 'f'.repeat(64) })
    t.alike(other.authors[0].items.map((i) => i.text), ['depois', 'antes'], what + ': another association cuts nothing')
  }
})

test('foldMoments and showingMoment carry a video moment with its duration', async (t) => {
  const video = media({ mime: 'video/mp4', w: 1080, h: 1920, ms: 15000, bytes: 4194304 + 16, chunks: 129 })
  const recs = [momentRecord({ text: 'vídeo', media: video, at: iso(NOW - 2000) }), moment(1000)]
  const l = log(K1, recs)
  const out = foldMoments({ logs: [l], now: NOW })
  t.alike(out.authors[0].items.map((i) => i.media), [media(), video], 'newest first, the video keeps ms')
  t.alike(showingMoment(l, 1, NOW), video)
  // A peer's video over the momento bounds is never shown.
  const long = { type: 'moment', text: '', at: iso(NOW - 1000), media: { ...video, ms: 15001 } }
  t.alike(foldMoments({ logs: [log(K1, [long])], now: NOW }), { authors: [] })
  t.is(showingMoment(log(K1, [long]), 1, NOW), null)
})
