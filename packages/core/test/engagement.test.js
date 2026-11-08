'use strict'

// lib/engagement.js: like/repost records replayed in seq order (the last
// operation per type and target wins), self-engagement counted, invalid
// records ignored, and every helper total on hostile input.
const test = require('brittle')
const { engagementState, isLiked, isReposted } = require('../lib/engagement')

const OWN = 'a'.repeat(64)
const K1 = '1'.repeat(64)
const K2 = '2'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const AT2 = '2026-01-02T00:00:00.000Z'
const R1 = K1 + ':3'
const R2 = K2 + ':1'

const lk = (seq, author, tseq, on, at = AT) => ({ seq, record: { type: 'like', to: { author, seq: tseq }, on, at } })
const rp = (seq, author, tseq, on, at = AT) => ({ seq, record: { type: 'repost', to: { author, seq: tseq }, on, at } })

test('likes toggle on, off and on again', (t) => {
  t.ok(isLiked(engagementState([lk(1, K1, 3, true)]), R1))
  t.absent(isLiked(engagementState([lk(1, K1, 3, true), lk(2, K1, 3, false)]), R1))
  const s = engagementState([lk(1, K1, 3, true), lk(2, K1, 3, false), lk(3, K1, 3, true)])
  t.ok(isLiked(s, R1))
  t.alike([...s.liked], [R1])
  t.is(s.reposted.size, 0)
  t.absent(isLiked(engagementState([lk(1, K1, 3, false)]), R1), 'off without on')
})

test('reposts toggle and keep the seq/at of the effective on record', (t) => {
  const s = engagementState([rp(1, K1, 3, true), rp(2, K1, 3, false), rp(5, K1, 3, true, AT2), rp(6, K2, 1, true)])
  t.ok(isReposted(s, R1))
  t.ok(isReposted(s, R2))
  t.alike(s.reposted.get(R1), { seq: 5, at: AT2 })
  t.alike(s.reposted.get(R2), { seq: 6, at: AT })
  t.absent(isReposted(engagementState([rp(1, K1, 3, true), rp(2, K1, 3, false)]), R1))
  // A repeated on moves to the latest record.
  t.alike(engagementState([rp(1, K1, 3, true), rp(2, K1, 3, true, AT2)]).reposted.get(R1), { seq: 2, at: AT2 })
})

test('the last op wins by seq, whatever the input order', (t) => {
  const s = engagementState([lk(4, K1, 3, false), lk(2, K1, 3, true), rp(9, K1, 3, true), rp(3, K1, 3, false)])
  t.absent(isLiked(s, R1))
  t.ok(isReposted(s, R1))
  t.alike(s.reposted.get(R1), { seq: 9, at: AT })
})

test('like and repost are independent per target', (t) => {
  const s = engagementState([lk(1, K1, 3, true), rp(2, K1, 3, true), lk(3, K2, 1, true), rp(4, K1, 3, false)])
  t.ok(isLiked(s, R1))
  t.absent(isReposted(s, R1))
  t.ok(isLiked(s, R2))
  t.absent(isLiked(s, K1 + ':4'), 'another seq of the same author')
})

test('self-engagement is counted', (t) => {
  const s = engagementState([lk(1, OWN, 2, true), rp(3, OWN, 2, true)])
  t.ok(isLiked(s, OWN + ':2'))
  t.ok(isReposted(s, OWN + ':2'))
})

test('invalid records are ignored', (t) => {
  const entries = [
    lk(0, K1, 3, true), // seq 0
    { seq: -1, record: lk(0, K1, 3, true).record },
    { seq: '2', record: lk(0, K1, 3, true).record },
    { seq: 1.5, record: lk(0, K1, 3, true).record },
    lk(3, K1, 0, true), // target seq 0
    lk(4, 'A'.repeat(64), 3, true), // uppercase author
    { seq: 5, record: { type: 'like', to: { author: K1, seq: 3, extra: 1 }, on: true, at: AT } },
    { seq: 6, record: { type: 'like', to: { author: K1, seq: 3 }, on: 1, at: AT } },
    { seq: 7, record: { type: 'like', to: { author: K1, seq: 3 }, on: true, at: AT, extra: 1 } },
    { seq: 8, record: { type: 'repost', to: { author: K1, seq: 3 }, on: true, at: 'x' } },
    { seq: 9, record: { type: 'follow', key: K1, on: true, at: AT } },
    { seq: 10, record: { type: 'post', text: 'oi', at: AT, replyTo: null, quote: { author: K1, seq: 3 } } }
  ]
  const s = engagementState(entries)
  t.is(s.liked.size, 0)
  t.is(s.reposted.size, 0)
  // An invalid off does not undo a valid on.
  t.ok(isLiked(engagementState([lk(1, K1, 3, true), { seq: 2, record: { type: 'like', to: { author: K1, seq: 3 }, on: 'no', at: AT } }]), R1))
})

test('never throws on hostile input', (t) => {
  for (const v of [undefined, null, 1, 'x', {}, new Proxy([], { get () { throw new Error('boom') } })]) {
    const s = engagementState(v)
    t.ok(s.liked instanceof Set && s.liked.size === 0)
    t.ok(s.reposted instanceof Map && s.reposted.size === 0)
  }
  const throwing = {}
  Object.defineProperty(throwing, 'record', { enumerable: true, get () { throw new Error('boom') } })
  Object.defineProperty(throwing, 'seq', { enumerable: true, value: 3 })
  const proxy = new Proxy({}, { get () { throw new Error('boom') }, getPrototypeOf () { throw new Error('boom') } })
  const toGetter = { type: 'like', on: true, at: AT }
  Object.defineProperty(toGetter, 'to', { enumerable: true, get () { throw new Error('boom') } })
  const s = engagementState([null, 1, 'x', [], {}, throwing, proxy, { seq: proxy, record: proxy }, { seq: 4, record: toGetter }, lk(5, K1, 3, true)])
  t.ok(isLiked(s, R1), 'valid entries survive hostile neighbours')
  t.is(s.liked.size, 1)
  for (const st of [null, undefined, 1, {}, { liked: [R1] }, proxy]) {
    t.absent(isLiked(st, R1))
    t.absent(isReposted(st, R1))
  }
})

// lib/engagement-index.js noticeRows: likes and reposts aimed at an author's
// indexed posts, as Avisos rows, newest first and capped.
const {
  createEngagementIndex,
  NOTICE_ROWS_PER_ENGAGER,
  NOTICE_ROWS_MAX,
  NOTICE_CACHE_AUTHORS
} = require('../lib/engagement-index')

const NOW = Date.parse(AT2)
const hexKey = (n) => n.toString(16).padStart(64, '0')
const postRec = (at = AT) => ({ type: 'post', text: 'oi', at, replyTo: null, quote: null })
const likeRec = (tseq, on = true, at = AT) => ({ type: 'like', to: { author: OWN, seq: tseq }, on, at })
const repostRec = (tseq, on = true, at = AT) => ({ type: 'repost', to: { author: OWN, seq: tseq }, on, at })

function indexWithPosts (n = 1) {
  const ix = createEngagementIndex()
  for (let seq = 1; seq <= n; seq++) ix.add(OWN, seq, postRec())
  return ix
}

test('noticeRows: like and repost rows carry the engager seq and at', (t) => {
  const ix = indexWithPosts()
  ix.add(K1, 4, likeRec(1, true, AT))
  ix.add(K2, 7, repostRec(1, true, AT2))
  t.alike(ix.noticeRows(OWN, NOW), [
    { key: K2, seq: 7, at: AT2, kind: 'repost' },
    { key: K1, seq: 4, at: AT, kind: 'like' }
  ])
  t.alike(ix.noticeRows(K1, NOW), [], 'an engager gets no rows for others posts')
})

test('noticeRows: an unlike removes the row and a re-like keeps only the newer seq', (t) => {
  const ix = indexWithPosts()
  ix.add(K1, 1, likeRec(1, true))
  ix.add(K1, 2, likeRec(1, false))
  ix.add(K2, 1, repostRec(1, true))
  ix.add(K2, 2, repostRec(1, false))
  t.alike(ix.noticeRows(OWN, NOW), [], 'on:false edges are not returned')
  ix.add(K1, 3, likeRec(1, true, AT2))
  t.alike(ix.noticeRows(OWN, NOW), [{ key: K1, seq: 3, at: AT2, kind: 'like' }])
})

test('noticeRows: removeRecord and removePost drop rows, deleted posts never appear', (t) => {
  const ix = indexWithPosts(3)
  ix.add(K1, 1, likeRec(1))
  ix.add(K2, 1, likeRec(2))
  t.is(ix.noticeRows(OWN, NOW).length, 2)
  t.ok(ix.removeRecord(K1, 1))
  t.alike(ix.noticeRows(OWN, NOW).map((r) => r.key), [K2], 'removed like is gone')
  t.ok(ix.removePost(OWN, 2))
  t.alike(ix.noticeRows(OWN, NOW), [], 'incoming rows of a removed post are gone')
  t.ok(ix.removePost(OWN, 3))
  ix.add(K1, 2, likeRec(3))
  ix.add(K2, 2, repostRec(3))
  t.alike(ix.noticeRows(OWN, NOW), [], 'a like of a deleted post never appears')
})

test('noticeRows: skips self, hides future edges, skips pre-1970 edges', (t) => {
  const ix = indexWithPosts()
  ix.add(OWN, 2, likeRec(1))
  ix.add(OWN, 3, repostRec(1))
  t.alike(ix.noticeRows(OWN, NOW), [], 'self engagement skipped')
  const future = new Date(NOW + 2 * 86400000).toISOString()
  ix.add(K1, 1, likeRec(1, true, future))
  t.alike(ix.noticeRows(OWN, NOW), [], 'future edge hidden')
  t.is(ix.noticeRows(OWN, NOW + 2 * 86400000).length, 1, 'shown once the clock catches up')
  ix.add(K2, 1, likeRec(1, true, '1969-12-31T00:00:00.000Z'))
  t.absent(ix.noticeRows(OWN, NOW + 2 * 86400000).some((r) => r.key === K2), 'pre-1970 edge skipped')
})

test('noticeRows: a like of an unindexed post is not a row', (t) => {
  const ix = indexWithPosts()
  ix.add(K1, 1, likeRec(9))
  t.alike(ix.noticeRows(OWN, NOW), [])
})

test('noticeRows: per-engager cap keeps the newest rows of that engager', (t) => {
  const n = NOTICE_ROWS_PER_ENGAGER + 6
  const ix = indexWithPosts(n)
  for (let i = 1; i <= n; i++) ix.add(K1, i, likeRec(i, true, new Date(NOW - (n - i) * 1000).toISOString()))
  ix.add(K2, 1, likeRec(1, true, new Date(NOW - 10 * 86400000).toISOString()))
  const rows = ix.noticeRows(OWN, NOW)
  const own = rows.filter((r) => r.key === K1)
  t.is(own.length, NOTICE_ROWS_PER_ENGAGER)
  t.is(own[0].seq, n, 'newest first')
  t.is(own.at(-1).seq, n - NOTICE_ROWS_PER_ENGAGER + 1, 'oldest ones forgotten')
  t.ok(rows.some((r) => r.key === K2), 'an older engager is not crowded out')
})

test('noticeRows: global cap keeps the newest rows overall', (t) => {
  const ix = indexWithPosts()
  const n = NOTICE_ROWS_MAX + 5
  for (let i = 1; i <= n; i++) ix.add(hexKey(i), 1, likeRec(1, true, new Date(NOW - (n - i) * 1000).toISOString()))
  const rows = ix.noticeRows(OWN, NOW)
  t.is(rows.length, NOTICE_ROWS_MAX)
  t.is(rows[0].key, hexKey(n))
  t.is(rows.at(-1).key, hexKey(n - NOTICE_ROWS_MAX + 1))
})

test('noticeRows: ties order by key asc, rows hold no numeric field', (t) => {
  const ix = indexWithPosts(2)
  ix.add(K2, 1, likeRec(1))
  ix.add(K1, 5, likeRec(1))
  ix.add(K1, 6, repostRec(2))
  const rows = ix.noticeRows(OWN, NOW)
  t.alike(rows.map((r) => [r.key, r.seq]), [[K1, 6], [K1, 5], [K2, 1]])
  for (const row of rows) {
    t.alike(Object.keys(row), ['key', 'seq', 'at', 'kind'])
    for (const k of ['key', 'at', 'kind']) t.is(typeof row[k], 'string')
  }
  t.absent(Array.isArray(rows) && Object.keys(rows).some((k) => !/^[0-9]+$/.test(k)), 'no count or total on the result')
})

test('noticeRows: total on bad input and the index surface is unchanged', (t) => {
  const ix = indexWithPosts()
  ix.add(K1, 1, likeRec(1))
  for (const [a, n] of [[null, NOW], ['x', NOW], [OWN.toUpperCase(), NOW], [OWN, NaN], [OWN, '1'], [K2, NOW]]) {
    t.alike(ix.noticeRows(a, n), [])
  }
  t.alike(Object.keys(ix), ['add', 'removePost', 'removeRecord', 'removeDiary', 'post', 'counts', 'engagers', 'member', 'hints', 'noticeRows', 'testimonials', 'stats', 'clear'])
})

test('noticeRows: hidden engagers do not take cap slots', (t) => {
  const old = new Date(NOW - 10 * 86400000).toISOString()
  const recent = (i) => new Date(NOW - i * 1000).toISOString()
  const ix = indexWithPosts(NOTICE_ROWS_PER_ENGAGER + 6)
  ix.add(K1, 1, likeRec(1, true, old))
  for (let i = 1; i <= NOTICE_ROWS_PER_ENGAGER + 6; i++) ix.add(K2, i, likeRec(i, true, recent(i)))
  for (let i = 1; i <= NOTICE_ROWS_MAX + 5; i++) ix.add(hexKey(i), 1, repostRec(1, true, recent(i)))
  const visible = (key) => key === K1
  t.alike(ix.noticeRows(OWN, NOW, visible), [{ key: K1, seq: 1, at: old, kind: 'like' }], 'older visible like survives both caps')
  const rows = ix.noticeRows(OWN, NOW, (key) => key !== K2)
  t.is(rows.length, NOTICE_ROWS_MAX)
  t.absent(rows.some((r) => r.key === K2), 'a hidden engager is never a row')
  t.alike(ix.noticeRows(OWN, NOW, () => { throw new Error('boom') }), [], 'a throwing visible answers []')
  t.is(ix.noticeRows(OWN, NOW, 'x').length, NOTICE_ROWS_MAX, 'a non-function visible means all visible')
})

test('noticeRows: every write is seen on the very next read', (t) => {
  const ix = indexWithPosts(2)
  ix.add(K1, 1, likeRec(1))
  t.alike(ix.noticeRows(OWN, NOW), ix.noticeRows(OWN, NOW), 'two reads with no write agree')
  t.is(ix.noticeRows(OWN, NOW).length, 1)
  ix.add(K2, 1, likeRec(1, true, AT2))
  t.alike(ix.noticeRows(OWN, NOW).map((r) => r.key), [K2, K1], 'new like')
  ix.add(K2, 2, likeRec(1, false))
  t.alike(ix.noticeRows(OWN, NOW).map((r) => r.key), [K1], 'unlike')
  ix.add(K2, 3, repostRec(2))
  t.is(ix.noticeRows(OWN, NOW).length, 2, 'new repost')
  t.ok(ix.removeRecord(K1, 1))
  t.alike(ix.noticeRows(OWN, NOW).map((r) => r.key), [K2], 'tombstone')
  t.ok(ix.removePost(OWN, 2))
  t.alike(ix.noticeRows(OWN, NOW), [], 'removed target')
  ix.add(K1, 2, likeRec(3))
  t.alike(ix.noticeRows(OWN, NOW), [], 'like of a post not yet indexed')
  ix.add(OWN, 3, postRec())
  t.alike(ix.noticeRows(OWN, NOW).map((r) => r.seq), [2], 'post indexed after its like')
  ix.removeDiary(K1)
  t.alike(ix.noticeRows(OWN, NOW), [], 'engager diary removed')
  ix.add(K2, 4, likeRec(3))
  t.is(ix.noticeRows(OWN, NOW).length, 1)
  ix.removeDiary(OWN)
  t.alike(ix.noticeRows(OWN, NOW), [], 'author diary removed')
  ix.add(OWN, 1, postRec())
  ix.add(K1, 5, likeRec(1))
  t.is(ix.noticeRows(OWN, NOW).length, 1)
  ix.clear()
  t.alike(ix.noticeRows(OWN, NOW), [], 'clear')
})

test('noticeRows: more authors than the cache holds still answer right', (t) => {
  const ix = createEngagementIndex()
  const n = NOTICE_CACHE_AUTHORS + 1
  const like = (author) => ({ type: 'like', to: { author, seq: 1 }, on: true, at: AT })
  for (let i = 1; i <= n; i++) ix.add(hexKey(i), 1, postRec())
  for (let round = 0; round < 3; round++) {
    for (let i = 1; i <= n; i++) {
      t.is(ix.noticeRows(hexKey(i), NOW).length, round, 'author ' + i + ' round ' + round)
      ix.add(hexKey(1000 + round), i, like(hexKey(i)))
    }
  }
})
