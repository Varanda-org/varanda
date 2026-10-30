'use strict'

const test = require('brittle')
const { createEngagementIndex } = require('../lib/engagement-index')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const NOW = Date.parse(AT)
const ref = (author, seq = 1) => author + ':' + seq
const post = (extra = {}) => ({ type: 'post', text: 'oi', at: AT, ...extra })
const engage = (type, author = A, seq = 1, on = true) => ({ type, to: { author, seq }, on, at: AT })
const profile = { type: 'profile', name: 'Ana', bio: '', at: AT }
const username = (member) => ({ type: 'username', member })

function snapshot (ix) {
  return {
    stats: ix.stats(),
    post: ix.post(ref(A)),
    counts: ix.counts([ref(A), ref(B), ref(C)]),
    members: [A, B, C].map((author) => ix.member(author)),
    likes: ix.engagers(ref(A), 'likes', null, undefined, NOW),
    reposts: ix.engagers(ref(A), 'reposts', null, undefined, NOW)
  }
}

test('removePost restores parent totals, pages and timelines exactly', (t) => {
  const ix = createEngagementIndex()
  ix.add(A, 1, post())
  ix.add(B, 1, profile)
  ix.add(C, 1, profile)
  ix.add(C, 2, post({ replyTo: { author: A, seq: 1 } }))
  ix.add(C, 3, post({ quote: { author: A, seq: 1 } }))
  const before = snapshot(ix)
  ix.add(B, 2, post({ replyTo: { author: A, seq: 1 }, quote: { author: A, seq: 1 } }))
  t.is(ix.post(ref(A)).repliesTotal, 2)
  t.is(ix.post(ref(A)).quotesTotal, 2)
  t.ok(ix.removePost(B, 2))
  t.alike(snapshot(ix), before)
  t.is(ix.removePost(B, 2), false)
  t.ok(ix.add(B, 2, post({ replyTo: { author: A, seq: 1 } })))
  t.alike(snapshot(ix), before, 'a slower cursor cannot put the post back')
  t.ok(ix.removeDiary(B))
  t.is(ix.post(ref(A)).repliesTotal, 1, 'remaining touched edges stay intact')
})

test('deleting a target clears incoming engagements and survives other diary drops', (t) => {
  const ix = createEngagementIndex()
  ix.add(A, 1, post())
  ix.add(A, 2, post())
  for (const author of [B, C]) {
    ix.add(author, 1, engage('like'))
    ix.add(author, 2, engage('repost'))
    ix.add(author, 3, post({ replyTo: { author: A, seq: 1 } }))
    ix.add(author, 4, post({ quote: { author: A, seq: 1 } }))
    ix.add(author, 5, engage('like', A, 2))
    ix.add(author, 6, engage('repost', A, 2))
  }
  t.ok(ix.removeRecord(A, 1))
  t.is(ix.removeRecord(A, 1), false)
  t.is(ix.post(ref(A)), null)
  t.alike(ix.counts([ref(A)]), {})
  t.is(ix.engagers(ref(A), 'likes', null, undefined, NOW), null)
  t.is(ix.engagers(ref(A), 'reposts', null, undefined, NOW), null)
  t.alike(ix.member(B).posts, [6, 4, 3])
  t.is(ix.post(ref(B, 3)).parent, null)
  t.is(ix.post(ref(A, 2)).likes, 2)
  t.is(ix.post(ref(A, 2)).reposts, 2)
  const before = snapshot(ix)
  for (const record of [engage('like'), engage('repost')]) {
    t.ok(ix.add(B, 7, record))
    t.alike(snapshot(ix), before, 'a deleted target cannot be recreated')
  }
  t.ok(ix.removeDiary(B))
  t.ok(ix.add(B, 1, engage('like')))
  t.alike(ix.counts([ref(A)]), {})
  t.is(ix.stats().targets, 1)
  t.ok(ix.removePost(C, 3), 'outgoing edge already removed with the target')
  t.ok(ix.removeRecord(C, 1), 'engagement record remains removable after its target')
  t.ok(ix.removeDiary(C))
  t.is(ix.stats().targets, 0)
  t.ok(ix.removeDiary(A))
  t.ok(ix.add(A, 1, post()), 'removing the owning diary clears its guard')
  t.ok(ix.add(B, 1, engage('like')))
  t.is(ix.post(ref(A)).likes, 1)
})

test('unread deleted posts and their edges advance cursors even at zero capacity', (t) => {
  const ix = createEngagementIndex({ maxRecords: 0, maxTargets: 0 })
  t.is(ix.removePost(A, 1), false, 'no indexed record was removed')
  t.is(ix.removePost(A, 1), false)
  const before = ix.stats()
  t.ok(ix.add(A, 1, post()))
  for (const record of [engage('like'), engage('repost')]) {
    t.ok(ix.add(B, 1, record))
  }
  t.alike(ix.stats(), before)
  t.alike(ix.counts([ref(A)]), {})
  t.is(ix.member(A), null)
  t.is(ix.member(B), null)
  // A reply or quote is the author's own post, so a full record cap still refuses it.
  t.is(ix.add(B, 2, post({ replyTo: { author: A, seq: 1 } })), false)
  t.is(ix.add(B, 3, post({ quote: { author: A, seq: 1 } })), false)
  t.alike(ix.stats(), before)
  t.ok(ix.removeDiary(A))
  t.is(ix.add(A, 1, post()), false, 'guard removed with the owning diary')
  ix.removePost(A, 1)
  ix.clear()
  t.is(ix.add(A, 1, post()), false, 'clear also discards guards')
})

test('removePost removes engagement on an unread target and frees target capacity', (t) => {
  let freed = 0
  const ix = createEngagementIndex({ maxTargets: 1, onFreed: () => freed++ })
  ix.add(B, 1, engage('like'))
  ix.add(B, 2, engage('repost'))
  t.is(ix.add(C, 1, engage('like', A, 2)), false)
  t.ok(ix.removePost(A, 1))
  t.is(freed, 1)
  t.alike(ix.member(B).posts, [])
  t.is(ix.stats().targets, 0)
  t.ok(ix.add(C, 1, engage('like', A, 2)))
  t.is(ix.removePost(A, 1), false)
  t.is(freed, 1)
})

test('profile and username removals fall back to the highest surviving seq', (t) => {
  const ix = createEngagementIndex()
  for (const seq of [5, 1, 3]) ix.add(A, seq, profile)
  for (const seq of [6, 2, 4]) ix.add(A, seq, username(A))
  t.alike(ix.hints(A), { profileSeq: 5, usernameSeq: 6 })
  t.ok(ix.removeRecord(A, 3))
  t.ok(ix.removeRecord(A, 5))
  t.ok(ix.removeRecord(A, 6))
  t.alike(ix.hints(A), { profileSeq: 1, usernameSeq: 4 })
  t.alike(ix.member(A), { profileSeq: 1, usernameSeq: 4, posts: [], postsTotal: 0 })
  t.ok(ix.add(A, 5, profile))
  t.alike(ix.hints(A), { profileSeq: 1, usernameSeq: 4 })
  t.is(ix.removeRecord(A, 5), false)
  for (const seq of [1, 2, 4]) t.ok(ix.removeRecord(A, seq))
  t.alike(ix.hints(A), { profileSeq: null, usernameSeq: null })
  t.is(ix.stats().records, 0)
  t.is(ix.removeRecord(A, 99), false)
})

test('individual engagements withdraw only their own active operation', (t) => {
  for (const type of ['like', 'repost']) {
    const kind = type === 'like' ? 'likes' : 'reposts'
    const ix = createEngagementIndex()
    ix.add(A, 1, post())
    ix.add(B, 1, profile)
    ix.add(C, 1, engage(type))
    const before = snapshot(ix)
    ix.add(B, 2, engage(type))
    ix.add(B, 3, engage(type))
    t.ok(ix.removeRecord(B, 2), 'old on does not withdraw newer on')
    t.is(ix.post(ref(A))[kind], 2)
    t.alike(ix.engagers(ref(A), kind, null, undefined, NOW).items, [ref(B, 3), ref(C)])
    t.ok(ix.removeRecord(B, 3))
    t.alike(snapshot(ix), before, 'totals and sorted engager pages restored')
    t.ok(ix.add(B, 3, engage(type)))
    t.alike(snapshot(ix), before)
    t.is(ix.removeRecord(B, 3), false)
    ix.add(B, 4, engage(type))
    ix.add(B, 5, engage(type, A, 1, false))
    ix.add(B, 6, engage(type))
    t.ok(ix.removeRecord(B, 5), 'removing an off record preserves newer on')
    t.is(ix.post(ref(A))[kind], 2)
    t.ok(ix.removeRecord(B, 6))
    t.is(ix.post(ref(A))[kind], 1, 'no fallback to older on')
    t.ok(ix.removeRecord(B, 4))
    t.alike(snapshot(ix), before)
    t.ok(ix.removeRecord(C, 1))
    t.is(ix.stats().targets, 0)
    t.is(ix.post(ref(A))[kind], 0)
  }
})

test('replayed records are retained once and removed once', (t) => {
  for (const record of [post(), profile, username(A), engage('like', B), engage('repost', B)]) {
    const ix = createEngagementIndex({ maxRecords: 1 })
    t.ok(ix.add(A, 1, record))
    t.ok(ix.add(A, 1, record))
    t.is(ix.stats().records, 1)
    t.ok(ix.removeRecord(A, 1))
    t.is(ix.removeRecord(A, 1), false)
    t.is(ix.stats().records, 0)
    t.alike(ix.hints(A), { profileSeq: null, usernameSeq: null })
    t.alike(ix.member(A).posts, [])
    t.is(ix.stats().targets, 0)
  }
})

test('record and author capacity are freed by each removal kind', (t) => {
  for (const record of [post(), profile, username(A), engage('like', B), engage('repost', B)]) {
    for (const limits of [{ maxRecords: 1 }, { perAuthorMax: 1 }]) {
      let freed = 0
      const ix = createEngagementIndex({ ...limits, onFreed: () => freed++ })
      t.ok(ix.add(A, 1, record))
      t.is(ix.add(A, 2, post()), false)
      t.ok(ix.stats().saturated)
      t.ok(ix.removeRecord(A, 1))
      t.is(freed, 1)
      t.is(ix.stats().records, 0)
      t.is(ix.stats().saturated, false)
      t.ok(ix.add(A, 2, post()), 'paused cursor can resume')
      const before = ix.stats()
      t.ok(ix.add(A, 1, record), 'deleted seq advances even at the cap')
      t.alike(ix.stats(), before)
      t.is(ix.removeRecord(A, 1), false)
      t.is(freed, 1)
    }
  }
})

test('self references and invalid removals leave consistent counters', (t) => {
  const ix = createEngagementIndex({ onFreed: () => { throw new Error('callback') } })
  ix.add(A, 1, post({ replyTo: { author: A, seq: 1 }, quote: { author: A, seq: 1 } }))
  t.ok(ix.removePost(A, 1))
  t.is(ix.stats().records, 0)
  t.is(ix.stats().targets, 0)
  for (const value of [null, undefined, {}, 0, -1, 1.5, NaN, '1', Infinity]) {
    t.is(ix.removePost(A, value), false)
    t.is(ix.removeRecord(A, value), false)
    t.is(ix.removePost(value, 1), false)
    t.is(ix.removeRecord(value, 1), false)
  }
})

test('removeRecord tombstones a seq the cursor never indexed', (t) => {
  const ix = createEngagementIndex({ maxTargets: 1 })
  t.ok(ix.add(B, 1, engage('like', A, 5)))
  t.ok(ix.add(B, 2, engage('repost', A, 5)))
  t.is(ix.add(C, 1, engage('like', A, 9)), false)
  t.ok(ix.removeRecord(A, 5))
  t.alike(ix.counts([ref(A, 5)]), {})
  t.alike(ix.member(B).posts, [])
  t.is(ix.stats().targets, 0)
  t.ok(ix.add(C, 1, engage('like', A, 9)), 'the engagement-only target freed its slot')
  t.ok(ix.add(B, 3, engage('like', A, 5)))
  t.ok(ix.add(B, 4, post({ replyTo: { author: A, seq: 5 } })))
  t.ok(ix.add(B, 5, post({ quote: { author: A, seq: 5 } })))
  t.alike(ix.counts([ref(A, 5)]), {})
  t.is(ix.post(ref(B, 4)).parent, null)
  t.alike(ix.member(B).posts, [5, 4])
  const before = ix.stats()
  t.ok(ix.add(A, 5, post()))
  t.alike(ix.stats(), before, 'the post itself is not inserted')
  t.is(ix.post(ref(A, 5)), null)

  // The author is indexed, but not this seq.
  const present = createEngagementIndex()
  present.add(A, 1, profile)
  present.add(B, 1, engage('repost', A, 5))
  t.ok(present.removeRecord(A, 5))
  t.alike(present.member(B).posts, [])
  t.alike(present.counts([ref(A, 5)]), {})
  const held = present.stats()
  t.ok(present.add(A, 5, post()))
  t.alike(present.stats(), held)
  t.is(present.post(ref(A, 5)), null)
  t.alike(present.hints(A), { profileSeq: 1, usernameSeq: null })

  // No target yet: a paused cursor still must not index the seq later.
  const paused = createEngagementIndex()
  t.is(paused.removeRecord(A, 7), false, 'nothing indexed was released')
  const snap = paused.stats()
  t.ok(paused.add(A, 7, post()))
  t.alike(paused.stats(), snap)
  t.is(paused.post(ref(A, 7)), null)
  t.is(paused.member(A), null)
  t.ok(paused.add(B, 1, post({ replyTo: { author: A, seq: 7 } })))
  t.ok(paused.add(B, 2, engage('like', A, 7)))
  t.alike(paused.counts([ref(A, 7)]), {})
  t.alike(paused.member(B).posts, [1])
  t.is(paused.post(ref(B, 1)).parent, null)
  t.is(paused.stats().targets, 0)
})

test('a reply or quote stays indexed when its parent is deleted, in either order', (t) => {
  function scene (deleteFirst, record, withLiveQuote) {
    const ix = createEngagementIndex()
    ix.add(A, 1, post())
    if (withLiveQuote) ix.add(A, 2, post())
    if (deleteFirst) ix.removePost(A, 1)
    ix.add(B, 3, record)
    if (!deleteFirst) ix.removePost(A, 1)
    const member = ix.member(B)
    const body = ix.post(ref(B, 3))
    return {
      timeline: member === null ? null : member.posts,
      parent: body === null ? null : body.parent,
      gone: ix.counts([ref(A, 1)]),
      liveQuotes: withLiveQuote ? ix.counts([ref(A, 2)])[ref(A, 2)].quotes : 0
    }
  }
  const reply = post({ replyTo: { author: A, seq: 1 }, quote: { author: A, seq: 2 } })
  const after = scene(false, reply, true)
  const before = scene(true, reply, true)
  t.alike(before, after)
  t.alike(after, { timeline: [3], parent: null, gone: {}, liveQuotes: 1 })

  const quote = post({ quote: { author: A, seq: 1 } })
  const quotedAfter = scene(false, quote, false)
  const quotedBefore = scene(true, quote, false)
  t.alike(quotedBefore, quotedAfter)
  t.alike(quotedAfter, { timeline: [3], parent: null, gone: {}, liveQuotes: 0 })

  const ix = createEngagementIndex({ maxTargets: 0 })
  ix.add(A, 1, post())
  ix.removePost(A, 1)
  t.ok(ix.add(B, 3, post({ replyTo: { author: A, seq: 1 } })))
  t.alike(ix.member(B).posts, [3])
  t.is(ix.post(ref(B, 3)).parent, null)
  t.is(ix.stats().targets, 0)
  t.ok(ix.add(B, 4, engage('like')))
  t.alike(ix.counts([ref(A, 1)]), {})
  t.is(ix.stats().targets, 0)
  t.is(ix.stats().records, 1, 'the like was not stored')
})

test('a copied username is counted once and removeRecord releases its slot', (t) => {
  const copy = username(B)
  const ix = createEngagementIndex()
  t.ok(ix.add(A, 4, copy))
  t.ok(ix.add(A, 4, copy))
  t.is(ix.stats().records, 1, 're-add does not change the count')
  t.alike(ix.hints(A), { profileSeq: null, usernameSeq: null }, 'a copy is not a username hint')

  const tight = createEngagementIndex({ maxRecords: 1 })
  t.ok(tight.add(A, 4, copy))
  t.is(tight.add(A, 5, post()), false)
  t.ok(tight.removeRecord(A, 4))
  t.is(tight.stats().records, 0)
  t.ok(tight.add(A, 5, post()), 'removeRecord released the slot')
  const full = tight.stats()
  t.ok(tight.add(A, 4, copy))
  t.alike(tight.stats(), full, 'the removed seq is not inserted again')

  const own = createEngagementIndex()
  own.add(A, 1, username(A))
  own.add(A, 2, copy)
  t.alike(own.hints(A), { profileSeq: null, usernameSeq: 1 })
  t.ok(own.add(A, 2, copy))
  t.is(own.stats().records, 2)
  t.ok(own.removeRecord(A, 2))
  t.is(own.stats().records, 1)
  t.alike(own.hints(A), { profileSeq: null, usernameSeq: 1 })
})
