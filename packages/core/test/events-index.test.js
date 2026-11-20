'use strict'

// The event posts of the seeder's engagement index (events()): a live root
// post with a valid `event` keeps its seq under its author, newest first,
// paged with the seq cursor, deletion removes it, the two-option RSVP is the
// poll's (pollTotals / pollVoters, picks 0 and 1), and nothing of the event
// (title, place, dates) is kept. No network.
const test = require('brittle')
const { createEngagementIndex, EVENT_PAGE } = require('../lib/engagement-index')
const { postRecord, choiceRecord, validRecordCopy } = require('../lib/records')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const at = (i) => new Date(Date.UTC(2026, 2, 1, 12, 0, i)).toISOString()
const EVENT = { title: 'Churrasco', start: '2026-12-20T18:00:00.000Z', end: null, place: 'Praça' }

function add (ix, author, seq, record) {
  return ix.add(author, seq, validRecordCopy(record, seq))
}

const eventPost = (i, event = EVENT) => postRecord({ text: 'Vem', at: at(i), event })
const plain = (i) => postRecord({ text: 'oi', at: at(i) })

test('events: bad input answers null, an unknown author an empty page', (t) => {
  const ix = createEngagementIndex()
  for (const a of [null, undefined, 'x', A.toUpperCase(), 7]) t.is(ix.events(a), null)
  for (const before of [0, -1, 1.5, '1', NaN, Infinity]) t.is(ix.events(A, before), null, 'a bad cursor: ' + before)
  t.alike(ix.events(A), { posts: [], next: null, total: 0 })
  add(ix, A, 1, plain(1))
  t.alike(ix.events(A), { posts: [], next: null, total: 0 }, 'only plain posts')
})

test('events: only valid root event posts are listed, newest first, the cursor is exclusive', (t) => {
  const ix = createEngagementIndex()
  t.ok(add(ix, A, 1, eventPost(1)))
  t.ok(add(ix, A, 2, plain(2)))
  t.ok(add(ix, A, 3, eventPost(3, { ...EVENT, end: '2026-12-20T20:00:00.000Z' })))
  t.ok(add(ix, A, 4, postRecord({ text: 'Qual?', at: at(4), poll: ['sim', 'não'] })))
  t.ok(add(ix, B, 1, eventPost(5)))
  t.alike(ix.events(A), { posts: [3, 1], next: null, total: 2 })
  t.alike(ix.events(A, 3), { posts: [1], next: null, total: 2 }, 'exclusive')
  t.alike(ix.events(A, 1), { posts: [], next: null, total: 2 })
  t.alike(ix.events(A, 99), { posts: [3, 1], next: null, total: 2 })
  t.alike(ix.events(B), { posts: [1], next: null, total: 1 }, 'per author')
  t.alike(ix.events(C), { posts: [], next: null, total: 0 })
})

test('events: out-of-order seqs stay sorted, a repeated seq is a no-op', (t) => {
  const ix = createEngagementIndex()
  t.ok(add(ix, A, 5, eventPost(5)))
  t.ok(add(ix, A, 2, eventPost(2)))
  t.ok(add(ix, A, 9, eventPost(9)))
  t.ok(add(ix, A, 5, eventPost(5)))
  t.alike(ix.events(A).posts, [9, 5, 2])
  t.is(ix.events(A).total, 3)
})

test('events: a record the shared rules refuse is never listed', (t) => {
  const ix = createEngagementIndex()
  const bad = (event) => ({ type: 'post', text: 'x', at: at(1), replyTo: null, event })
  for (const event of [
    { ...EVENT, title: '' },
    { ...EVENT, start: '2026-12-20T18:00:00Z' },
    { ...EVENT, end: '2026-12-19T18:00:00.000Z' },
    { ...EVENT, extra: 1 },
    { title: 'x' },
    'x',
    null
  ]) {
    // The index takes validated copies; a raw one that slips through is
    // still checked by the shared rule before its seq is kept.
    ix.add(A, 1, bad(event))
    t.alike(ix.events(A), { posts: [], next: null, total: 0 }, JSON.stringify(event))
    ix.removeDiary(A)
  }
  // A reply carrying an event key is not a root event post.
  ix.add(A, 1, { type: 'post', text: 'x', at: at(1), replyTo: { author: B, seq: 1 }, event: EVENT })
  t.alike(ix.events(A), { posts: [], next: null, total: 0 }, 'a reply is not an event post')
})

test('events: pages of EVENT_PAGE follow next, newest first, with the exact total', (t) => {
  const ix = createEngagementIndex()
  const n = EVENT_PAGE * 2 + 5
  for (let i = 1; i <= n; i++) add(ix, A, i, eventPost(i % 50))
  const seen = []
  let before = null
  let pages = 0
  for (;;) {
    const page = ix.events(A, before)
    t.ok(page.posts.length <= EVENT_PAGE)
    t.is(page.total, n)
    seen.push(...page.posts)
    pages++
    if (page.next === null) break
    t.is(page.next, page.posts[page.posts.length - 1], 'next is the last seq')
    t.is(page.posts.length, EVENT_PAGE, 'only a full page has a next')
    before = page.next
  }
  t.is(pages, 3)
  t.alike(seen, Array.from({ length: n }, (_, i) => n - i))
  const exact = createEngagementIndex()
  for (let i = 1; i <= EVENT_PAGE; i++) add(exact, A, i, eventPost(i))
  t.is(exact.events(A).next, null, 'a page that ends the list has no next')
})

test('events: a deleted post leaves the list and the removal sticks', (t) => {
  const ix = createEngagementIndex()
  for (let i = 1; i <= 3; i++) add(ix, A, i, eventPost(i))
  t.ok(ix.removePost(A, 2))
  t.alike(ix.events(A), { posts: [3, 1], next: null, total: 2 })
  t.ok(ix.removeRecord(A, 3))
  t.alike(ix.events(A), { posts: [1], next: null, total: 1 })
  t.ok(add(ix, A, 2, eventPost(2)), 'a late block of a deleted seq is skipped, not an error')
  t.alike(ix.events(A).posts, [1], 'it does not come back')
  ix.removePost(A, 1)
  t.alike(ix.events(A), { posts: [], next: null, total: 0 })
  t.is(ix.stats().records, 0, 'the record slots were freed')
})

test('events: removeDiary and clear forget the list', (t) => {
  const ix = createEngagementIndex()
  add(ix, A, 1, eventPost(1))
  add(ix, B, 1, eventPost(2))
  ix.removeDiary(A)
  t.alike(ix.events(A), { posts: [], next: null, total: 0 })
  t.alike(ix.events(B).posts, [1])
  ix.clear()
  t.alike(ix.events(B), { posts: [], next: null, total: 0 })
})

test('events: an event post takes no record slot beyond the post and keeps the caps', (t) => {
  const ix = createEngagementIndex({ perAuthorMax: 2 })
  t.ok(add(ix, A, 1, eventPost(1)))
  t.ok(add(ix, A, 2, eventPost(2)))
  t.absent(add(ix, A, 3, eventPost(3)), 'the per-author cap pauses the cursor')
  t.alike(ix.events(A).posts, [2, 1], 'the refused one is not listed')
  t.is(ix.stats().records, 2)
})

test('events: RSVP totals and voters are the poll routes with picks 0 and 1', (t) => {
  const ix = createEngagementIndex()
  add(ix, A, 1, eventPost(0))
  add(ix, A, 2, plain(1))
  const to = { author: A, seq: 1 }
  add(ix, B, 1, choiceRecord({ to, pick: 0, at: at(2) }))
  add(ix, C, 1, choiceRecord({ to, pick: 1, at: at(3) }))
  add(ix, C, 2, choiceRecord({ to, pick: 2, at: at(4) })) // no third option: ignored
  t.alike(ix.pollTotals(A, 1), { totals: [1, 1] })
  t.alike(ix.pollVoters(A, 1, 0), { items: [{ key: B, seq: 1, at: at(2) }], next: null, total: 1 })
  t.alike(ix.pollVoters(A, 1, 1).items, [{ key: C, seq: 1, at: at(3) }])
  t.is(ix.pollVoters(A, 1, 2), null, 'only two options')
  add(ix, B, 2, choiceRecord({ to, pick: null, at: at(5) }))
  t.alike(ix.pollTotals(A, 1), { totals: [0, 1] }, 'a withdrawn RSVP')
  t.is(ix.pollTotals(A, 2), null, 'a plain post has no RSVP')
  ix.removePost(A, 1)
  t.is(ix.pollTotals(A, 1), null, 'a deleted event has none')
})

test('events: the index keeps seqs only, never the event text', (t) => {
  const ix = createEngagementIndex()
  add(ix, A, 1, eventPost(1, { title: 'Segredo do título', start: '2026-12-20T18:00:00.000Z', end: null, place: 'Segredo do lugar' }))
  const out = JSON.stringify(ix.events(A))
  t.absent(out.includes('Segredo'))
  t.absent(out.includes('2026'))
})
