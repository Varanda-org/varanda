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
  NOTICE_CACHE_AUTHORS,
  NOTICE_SCAN_MAX
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
  t.alike(Object.keys(ix), ['add', 'removePost', 'removeRecord', 'removeDiary', 'post', 'roda', 'counts', 'engagers', 'member', 'hints', 'noticeRows', 'noticePage', 'testimonials', 'scraps', 'profileExtra', 'fans', 'fanCount', 'pollTotals', 'pollVoters', 'stats', 'clear'])
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

// Enquetes in the index: the per-voter and per-poll caps, and future-dated
// choices.
const { CHOICE_POLLS_MAX, CHOICE_VOTERS_MAX } = require('../lib/engagement-index')
const { postRecord, choiceRecord } = require('../lib/records')
const POLL_P = { author: OWN, seq: 1 }
const POLL_Q = { author: OWN, seq: 2 }
const vote = (to, pick, at = AT) => choiceRecord({ to, pick, at })

function indexWithPolls () {
  const ix = createEngagementIndex()
  ix.add(OWN, 1, postRecord({ text: 'P?', poll: ['um', 'dois'], at: AT }))
  ix.add(OWN, 2, postRecord({ text: 'Q?', poll: ['um', 'dois'], at: AT }))
  return ix
}

test('engagement-index choice: past CHOICE_POLLS_MAX polls a voter\'s new poll is skipped, a known one still updates', (t) => {
  const ix = indexWithPolls()
  const V = hexKey(1)
  t.ok(ix.add(V, 1, vote(POLL_P, 0)))
  for (let i = 2; i <= CHOICE_POLLS_MAX; i++) ix.add(V, i, vote({ author: hexKey(1000 + i), seq: 1 }, 0))
  const records = ix.stats().records
  t.is(records, 2 + CHOICE_POLLS_MAX)
  t.ok(ix.add(V, CHOICE_POLLS_MAX + 1, vote(POLL_Q, 1)), 'skipped, the cursor moves on')
  t.is(ix.stats().records, records, 'no slot taken')
  t.alike(ix.pollTotals(OWN, 2), { totals: [0, 0] }, 'no pollIn entry for the new pair')
  t.alike(ix.pollVoters(OWN, 2, 1).items, [])
  t.ok(ix.add(V, CHOICE_POLLS_MAX + 2, vote(POLL_P, 1)))
  t.is(ix.stats().records, records + 1, 'a known pair still takes its slot')
  t.alike(ix.pollTotals(OWN, 1), { totals: [0, 1] }, 'and still updates the pick')
})

test('engagement-index choice: past CHOICE_VOTERS_MAX voters a new voter is skipped, a known one still updates', (t) => {
  const ix = indexWithPolls()
  for (let i = 1; i <= CHOICE_VOTERS_MAX; i++) ix.add(hexKey(i), 1, vote(POLL_P, 0))
  const records = ix.stats().records
  t.is(records, 2 + CHOICE_VOTERS_MAX)
  t.alike(ix.pollTotals(OWN, 1), { totals: [CHOICE_VOTERS_MAX, 0] })
  const late = hexKey(CHOICE_VOTERS_MAX + 1)
  t.ok(ix.add(late, 1, vote(POLL_P, 1)), 'skipped, the cursor moves on')
  t.is(ix.stats().records, records, 'no slot taken')
  t.alike(ix.pollTotals(OWN, 1), { totals: [CHOICE_VOTERS_MAX, 0] }, 'no pollIn entry for the new pair')
  t.alike(ix.pollVoters(OWN, 1, 1).items, [])
  t.ok(ix.add(late, 2, vote(POLL_Q, 1)), 'the same voter on another poll is a new pair under its own cap')
  t.alike(ix.pollTotals(OWN, 2), { totals: [0, 1] })
  t.ok(ix.add(hexKey(1), 2, vote(POLL_P, 1)))
  t.is(ix.stats().records, records + 2, 'a known pair still takes its slot')
  t.alike(ix.pollTotals(OWN, 1), { totals: [CHOICE_VOTERS_MAX - 1, 1] }, 'and still updates the pick')
  t.alike(ix.pollVoters(OWN, 1, 1).items, [{ key: hexKey(1), seq: 2, at: AT }])
})

test('engagement-index choice: a choice dated more than a day ahead counts and lists from its date', (t) => {
  const ix = indexWithPolls()
  const ahead = new Date(NOW + 86400001).toISOString()
  const A = hexKey(1)
  const B = hexKey(2)
  ix.add(A, 1, vote(POLL_P, 0))
  ix.add(A, 2, vote(POLL_P, 1, ahead))
  ix.add(B, 1, vote(POLL_P, 1, ahead))
  t.alike(ix.pollTotals(OWN, 1, { now: NOW }), { totals: [1, 0] }, 'the earlier pick stays, a lone future vote is none')
  t.alike(ix.pollVoters(OWN, 1, 0, { now: NOW }), { items: [{ key: A, seq: 1, at: AT }], next: null, total: 1 })
  t.alike(ix.pollVoters(OWN, 1, 1, { now: NOW }), { items: [], next: null, total: 0 }, 'never first in quem votou')
  t.alike(ix.pollTotals(OWN, 1, { now: NOW + 1 }), { totals: [0, 2] }, 'counted once within a day')
  t.alike(ix.pollVoters(OWN, 1, 1, { now: NOW + 1 }).items.map((r) => r.key).sort(), [A, B])
})

test('noticePage: the per-request scan cap marks the rows incomplete only when it cuts', (t) => {
  t.is(NOTICE_SCAN_MAX, 16384)
  // One post liked by NOTICE_SCAN_MAX + 10 engagers, newest = highest i.
  const ix = indexWithPosts()
  const n = NOTICE_SCAN_MAX + 10
  for (let i = 1; i <= n; i++) ix.add(hexKey(i), 1, likeRec(1, true, new Date(NOW - (n - i) * 1000).toISOString()))
  const all = ix.noticePage(OWN, NOW)
  t.is(all.rows.length, NOTICE_ROWS_MAX)
  t.is(all.incomplete, false, 'NOTICE_ROWS_MAX reached: the row cap forgets, it is not incompleteness')
  t.alike(all.rows, ix.noticeRows(OWN, NOW), 'noticeRows is noticePage().rows')
  // Only the 10 oldest engagers are visible: they lie past the scan cap.
  let examined = 0
  const old = (key) => {
    examined++
    return parseInt(key, 16) <= 10
  }
  const hidden = ix.noticePage(OWN, NOW, old)
  t.alike(hidden.rows, [], 'never scanned past NOTICE_SCAN_MAX edges')
  t.is(hidden.incomplete, true, 'the scan cap cut visible rows')
  t.is(examined, NOTICE_SCAN_MAX, 'one visible call per distinct engager scanned, no more')
  // Under the cap nothing is cut, whatever is hidden.
  const small = indexWithPosts()
  for (let i = 1; i <= 100; i++) small.add(hexKey(i), 1, likeRec(1))
  t.alike(small.noticePage(OWN, NOW, () => false), { rows: [], incomplete: false })
  t.alike(small.noticePage('x', NOW), { rows: [], incomplete: false })
  t.alike(small.noticePage(OWN, NOW, () => { throw new Error('boom') }), { rows: [], incomplete: false })
  // The memo is kept after the cap and a write still drops it.
  ix.add(hexKey(n + 1), 1, likeRec(1, true, new Date(NOW + 1000).toISOString()))
  t.is(ix.noticePage(OWN, NOW).rows[0].key, hexKey(n + 1))
})

test('noticePage: far-future edges and one engager past its cap take no scan slot', (t) => {
  // NOTICE_SCAN_MAX + 10 far-future likes, all newer than 10 real ones.
  const ix = indexWithPosts()
  const n = NOTICE_SCAN_MAX + 10
  const far = (i) => new Date(NOW + 2 * 86400000 + i * 1000).toISOString()
  for (let i = 1; i <= n; i++) ix.add(hexKey(i), 1, likeRec(1, true, far(i)))
  for (let i = 1; i <= 10; i++) ix.add(hexKey(n + i), 1, likeRec(1, true, new Date(NOW - i * 1000).toISOString()))
  const p = ix.noticePage(OWN, NOW)
  t.is(p.rows.length, 10, 'every real row is there')
  t.is(p.incomplete, false, 'nothing real was cut')
  t.is(p.rows[0].key, hexKey(n + 1))
  // Hidden, never removed: once the clock catches up they show, newest first.
  const later = ix.noticePage(OWN, NOW + 2 * 86400000 + n * 1000)
  t.is(later.rows.length, NOTICE_ROWS_MAX)
  t.is(later.rows[0].key, hexKey(n))
  t.is(later.incomplete, false, 'NOTICE_ROWS_MAX reached')
  // An earlier clock again hides them (the memo is rebuilt, not reused).
  t.is(ix.noticePage(OWN, NOW).rows.length, 10)

  // One engager liking NOTICE_SCAN_MAX + 10 posts, all newer than a real
  // like: only its newest NOTICE_ROWS_PER_ENGAGER enter the scan.
  const busy = indexWithPosts(NOTICE_SCAN_MAX + 10)
  for (let i = 1; i <= NOTICE_SCAN_MAX + 10; i++) busy.add(K1, i, likeRec(i, true, new Date(NOW - (NOTICE_SCAN_MAX + 10 - i) * 1000).toISOString()))
  const old = new Date(NOW - 10 * 86400000).toISOString()
  busy.add(K2, 1, likeRec(1, true, old))
  const b = busy.noticePage(OWN, NOW)
  t.is(b.rows.length, NOTICE_ROWS_PER_ENGAGER + 1)
  t.alike(b.rows.at(-1), { key: K2, seq: 1, at: old, kind: 'like' }, 'the older real row is still there')
  t.is(b.incomplete, false)
  const hiddenK1 = busy.noticePage(OWN, NOW, (key) => key !== K1)
  t.alike(hiddenK1, { rows: [{ key: K2, seq: 1, at: old, kind: 'like' }], incomplete: false }, 'a hidden busy engager cannot push it out either')
})
