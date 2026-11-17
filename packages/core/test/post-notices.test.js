'use strict'

// The post notice index (lib/post-notices.js): replies, quotes and mentions
// folded from served diaries and paged with the follow rows. No network.
const test = require('brittle')
const {
  MAX_POST_NOTICES_PER_PAIR,
  MAX_POST_NOTICES_PER_AUTHOR,
  POST_NOTICES_MAX_EDGES,
  MAX_UNRESOLVED_TOKENS_PER_AUTHOR,
  MAX_CUT_PAIRS_PER_AUTHOR,
  PAGE_CACHE_PAIRS,
  ENGAGEMENT_KINDS,
  createPostNoticeIndex
} = require('../lib/post-notices')
const { MAX_FUTURE_MS } = require('../lib/feed')

// Distinct hex64 keys that sort in index order.
function k (i) {
  return i.toString(16).padStart(64, '0')
}

const A = k(0xa)
const B = k(0xb)
const C = k(0xc)
const ISSUER = k(0x155)
const NOW = Date.parse('2026-02-01T00:00:00.000Z')
const D = (day) => '2026-01-' + String(day).padStart(2, '0') + 'T00:00:00.000Z'

function post (text, at, { replyTo = null, quote } = {}) {
  const r = { type: 'post', text, at, replyTo }
  if (quote !== undefined) r.quote = quote
  return r
}

function username (member, name, issuer = ISSUER) {
  return { type: 'username', username: name, member, issuer }
}

const ok = () => true

function index (opts = {}) {
  return createPostNoticeIndex({ verifyUsername: ok, ...opts })
}

function page (idx, opts = {}) {
  return idx.pageV2({ target: A, issuerUsable: ok, now: NOW, ...opts })
}

function page3 (idx, opts = {}) {
  return idx.pageV3({ target: A, issuerUsable: ok, now: NOW, ...opts })
}

function walk (fn, opts) {
  const seen = []
  let after = null
  for (;;) {
    const p = fn({ ...opts, after, limit: 1 })
    seen.push(...p.items)
    if (p.next === null) break
    after = p.next
  }
  return seen
}

// Every key of every object reachable from v.
function allKeys (v, out = []) {
  if (v !== null && typeof v === 'object') {
    for (const key of Object.keys(v)) {
      out.push(key)
      allKeys(v[key], out)
    }
  }
  return out
}

test('constants', (t) => {
  t.is(MAX_POST_NOTICES_PER_PAIR, 32)
  t.is(MAX_POST_NOTICES_PER_AUTHOR, 1024)
  t.is(POST_NOTICES_MAX_EDGES, 262144)
  t.is(MAX_UNRESOLVED_TOKENS_PER_AUTHOR, 64)
  t.is(MAX_CUT_PAIRS_PER_AUTHOR, 64)
})

test('reply and quote rows; reply plus mention is one reply row', (t) => {
  const idx = index()
  idx.foldUsername(A, 1, username(A, 'ana'))
  idx.settle(A)
  idx.foldPost(B, 1, post('oi', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(B, 2, post('olha', D(2), { quote: { author: A, seq: 1 } }))
  idx.foldPost(B, 3, post('@ana sim', D(3), { replyTo: { author: A, seq: 1 } }))
  const p = page(idx)
  t.alike(p.items, [
    { key: B, seq: 3, at: D(3), kind: 'reply' },
    { key: B, seq: 2, at: D(2), kind: 'quote' },
    { key: B, seq: 1, at: D(1), kind: 'reply' }
  ])
  t.is(p.next, null)
  t.is(p.incomplete, false)
})

test('removePost drops every row of a deleted post and it never folds again', (t) => {
  const idx = index()
  idx.foldUsername(A, 1, username(A, 'ana'))
  idx.settle(A)
  idx.foldPost(B, 1, post('oi', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(B, 2, post('@ana olha', D(2), { quote: { author: A, seq: 1 } }))
  idx.removePost(B, 2)
  idx.removePost(B, 9)
  idx.foldPost(B, 2, post('@ana olha', D(2), { quote: { author: A, seq: 1 } }))
  t.alike(page(idx).items, [{ key: B, seq: 1, at: D(1), kind: 'reply' }])
  t.alike(page(idx, { target: C }).items, [])
})

test('a mention folded before the username record resolves after settle; a rename keeps the old name', (t) => {
  const idx = index()
  idx.foldPost(B, 1, post('oi @ana', D(1)))
  t.alike(page(idx).items, [])
  idx.markPending(A)
  idx.foldUsername(A, 1, username(A, 'ana'))
  t.alike(page(idx).items, [], 'no verification before settle')
  t.is(page(idx).incomplete, true)
  idx.settle(A)
  t.alike(page(idx).items, [{ key: B, seq: 1, at: D(1), kind: 'mention' }])
  t.is(page(idx).incomplete, false)

  idx.foldUsername(A, 2, username(A, 'ana_nova'))
  idx.settle(A)
  idx.foldPost(B, 2, post('@ana_nova e @ANA', D(2)))
  t.alike(page(idx).items, [
    { key: B, seq: 2, at: D(2), kind: 'mention' },
    { key: B, seq: 1, at: D(1), kind: 'mention' }
  ])
})

test('names: unverified, copied, revoked or throwing issuers give no mention', (t) => {
  let verifications = 0
  const idx = createPostNoticeIndex({
    verifyUsername: (author, record) => {
      verifications++
      return record.username !== 'falso'
    }
  })
  idx.foldUsername(A, 1, username(A, 'falso'))
  idx.foldUsername(A, 2, username(B, 'copiado'))
  idx.foldUsername(A, 3, username(A, 'ana'))
  idx.settle(A)
  idx.settle(A)
  t.is(verifications, 2, 'each candidate verified once, copies never')
  idx.foldPost(B, 1, post('@falso @copiado', D(1)))
  idx.foldPost(B, 2, post('@ana', D(2)))
  t.alike(page(idx).items, [{ key: B, seq: 2, at: D(2), kind: 'mention' }])
  t.alike(page(idx, { issuerUsable: () => false }).items, [])
  t.alike(page(idx, { issuerUsable: () => { throw new Error('x') } }).items, [])
})

test('self rows never appear', (t) => {
  const idx = index()
  idx.foldUsername(A, 1, username(A, 'ana'))
  idx.settle(A)
  idx.foldPost(A, 2, post('eu @ana', D(1), { replyTo: { author: A, seq: 1 } }))
  t.alike(page(idx).items, [])
  t.alike(page(idx, { followRows: [{ key: A, seq: 3, at: D(1) }] }).items, [])
})

test('blocked and future rows are hidden without stalling the cursor', (t) => {
  const idx = index()
  const future = new Date(NOW + MAX_FUTURE_MS + 1000).toISOString()
  idx.foldPost(B, 1, post('a', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(C, 1, post('b', D(2), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(B, 2, post('c', future, { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(B, 3, post('d', D(3), { replyTo: { author: A, seq: 1 } }))
  const isBlocked = (key) => key === C
  const p1 = page(idx, { isBlocked, limit: 1 })
  t.alike(p1.items, [{ key: B, seq: 3, at: D(3), kind: 'reply' }])
  const p2 = page(idx, { isBlocked, limit: 1, after: p1.next })
  t.alike(p2.items, [{ key: B, seq: 1, at: D(1), kind: 'reply' }])
  t.is(p2.next, null)
  t.alike(page(idx, { isBlocked: () => { throw new Error('x') } }).items, [], 'a throwing isBlocked hides')
  const later = page(idx, { now: NOW + 2 * MAX_FUTURE_MS })
  t.ok(later.items.some((it) => it.seq === 2), 'hidden, not deleted')
})

test('33 posts from one author to one target keep the newest 32 without incomplete', (t) => {
  const idx = index()
  for (let seq = 1; seq <= 33; seq++) idx.foldPost(B, seq, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  const p = page(idx, { limit: 64 })
  t.is(p.items.length, 32)
  t.is(p.items[p.items.length - 1].seq, 2)
  t.is(p.incomplete, false)
})

test('the per-author ceiling evicts the lowest seq without incomplete', (t) => {
  const idx = index({ maxPerAuthor: 4 })
  const targets = [k(1), k(2), k(3), k(4), k(5)]
  targets.forEach((target, i) => idx.foldPost(B, i + 1, post('x', D(1), { replyTo: { author: target, seq: 1 } })))
  t.alike(idx.pageV2({ target: k(1), now: NOW }).items, [], 'lowest seq evicted')
  const p = idx.pageV2({ target: k(5), now: NOW })
  t.alike(p.items, [{ key: B, seq: 5, at: D(1), kind: 'reply' }])
  t.is(p.incomplete, false)
  t.is(idx.pageV2({ target: k(2), now: NOW }).items.length, 1)
})

test('the global cap refuses the row and marks incomplete; removeAuthor frees edges', (t) => {
  const idx = index({ maxEdges: 2 })
  idx.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(B, 2, post('x', D(2), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(C, 1, post('x', D(3), { replyTo: { author: A, seq: 1 } }))
  let p = page(idx)
  t.is(p.items.length, 2, 'never evicts another author')
  t.ok(p.items.every((it) => it.key === B))
  t.is(p.incomplete, true)

  idx.removeAuthor(B)
  idx.removeAuthor(C)
  t.is(page(idx).incomplete, false)
  idx.foldPost(C, 1, post('x', D(3), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(C, 2, post('x', D(4), { replyTo: { author: A, seq: 1 } }))
  p = page(idx)
  t.is(p.items.length, 2)
  t.is(p.incomplete, false)
})

test('the 65th unresolved token is skipped without incomplete', (t) => {
  const idx = index()
  const names = []
  for (let i = 0; i < MAX_UNRESOLVED_TOKENS_PER_AUTHOR + 1; i++) names.push('nome' + String(i).padStart(3, '0'))
  names.forEach((name, i) => idx.foldPost(B, i + 1, post('@' + name, D(1))))
  const last = names[names.length - 1]
  idx.foldUsername(A, 1, username(A, names[0]))
  idx.foldUsername(A, 2, username(A, last))
  idx.settle(A)
  const p = page(idx)
  t.alike(p.items, [{ key: B, seq: 1, at: D(1), kind: 'mention' }], 'only the first stored')
  t.is(p.incomplete, false)

  const strict = index({ isMember: () => false })
  for (let seq = 1; seq <= MAX_UNRESOLVED_TOKENS_PER_AUTHOR + 1; seq++) {
    strict.foldPost(B, seq, post('x', D(1), { replyTo: { author: k(0x1000 + seq), seq: 1 } }))
  }
  t.is(strict.pageV2({ target: k(0x1000 + MAX_UNRESOLVED_TOKENS_PER_AUTHOR + 1), now: NOW }).items.length, 0)
  t.is(strict.pageV2({ target: k(0x1001), now: NOW }).items.length, 1)
  t.is(strict.pageV2({ target: k(0x1001), now: NOW }).incomplete, false)
})

test('re-folding the same seq is a no-op; bad input never throws', (t) => {
  const idx = index()
  idx.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(B, 1, post('x', D(2), { quote: { author: A, seq: 1 } }))
  t.alike(page(idx).items, [{ key: B, seq: 1, at: D(1), kind: 'reply' }])
  const hostile = { get type () { throw new Error('x') } }
  for (const bad of [null, 1, [], hostile, { type: 'post', text: 1, at: D(1) }, { type: 'post', text: 'x', at: 'ontem' }]) {
    idx.foldPost(C, 5, bad)
    idx.foldUsername(C, 5, bad)
  }
  idx.foldPost('nope', 1, post('x', D(1)))
  t.alike(page(idx, { after: { at: 'x' } }).items.length, 1, 'an invalid cursor is null')
})

test('follow rows merge in order with the three-key cursor', (t) => {
  const idx = index()
  idx.foldPost(B, 2, post('x', D(2), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(C, 4, post('x', D(4), { quote: { author: A, seq: 1 } }))
  const followRows = [{ key: C, seq: 1, at: D(3) }, { key: B, seq: 1, at: D(2) }]
  const seen = []
  let after = null
  for (;;) {
    const p = page(idx, { followRows, after, limit: 1 })
    seen.push(...p.items)
    if (p.next === null) break
    after = p.next
  }
  t.alike(seen, [
    { key: C, seq: 4, at: D(4), kind: 'quote' },
    { key: C, seq: 1, at: D(3), kind: 'follow' },
    { key: B, seq: 2, at: D(2), kind: 'reply' },
    { key: B, seq: 1, at: D(2), kind: 'follow' }
  ])
  t.is(page(idx, { followRows, followIncomplete: true }).incomplete, true)
})

test('page size 1 walks three posts with the same at and key', (t) => {
  const idx = index()
  for (let seq = 1; seq <= 3; seq++) idx.foldPost(B, seq, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  const seqs = []
  let after = null
  for (;;) {
    const p = page(idx, { after, limit: 1 })
    seqs.push(...p.items.map((it) => it.seq))
    if (p.next === null) break
    after = p.next
  }
  t.alike(seqs, [3, 2, 1])
})

test('a page carries no count, total, size or length', (t) => {
  const idx = index()
  idx.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(B, 2, post('x', D(2), { replyTo: { author: A, seq: 1 } }))
  const keys = allKeys(page(idx, { limit: 1 }))
  for (const bad of ['count', 'total', 'size', 'length']) t.absent(keys.includes(bad), bad)
  t.alike(Object.keys(idx).sort(), ['foldPost', 'foldUsername', 'holders', 'markPending', 'pageV2', 'pageV3', 'removeAuthor', 'removePost', 'settle'])
})

test('per-pair rotation keeps working for an unresolved name already admitted', (t) => {
  const idx = index()
  for (let seq = 1; seq <= 32; seq++) idx.foldPost(B, seq, post('@ana @bia', D(1)))
  idx.foldPost(B, 33, post('@ana', D(1)))
  idx.foldUsername(A, 1, username(A, 'ana'))
  idx.settle(A)
  const p = page(idx, { limit: 64 })
  t.is(p.items.length, 32)
  t.is(p.items[0].seq, 33)
  t.is(p.items[p.items.length - 1].seq, 2)
  t.is(p.incomplete, false)
})

test('refused authors beyond the record keep pages incomplete', (t) => {
  const idx = index({ maxAuthors: 1 })
  idx.foldPost(A, 1, post('x', D(1)))
  idx.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(C, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  t.is(page(idx).incomplete, true)
  idx.removeAuthor(B)
  t.is(page(idx).incomplete, true, 'C is still missing')
})

test('held names follow the newest record window, however settle is batched', (t) => {
  const run = (eachTime) => {
    const idx = index()
    idx.foldUsername(A, 1, username(A, 'oldname'))
    if (eachTime) idx.settle(A)
    for (let seq = 2; seq <= 65; seq++) {
      idx.foldUsername(A, seq, username(A, 'newname'))
      if (eachTime) idx.settle(A)
    }
    idx.settle(A)
    idx.foldPost(B, 1, post('@oldname', D(1)))
    idx.foldPost(B, 2, post('@newname', D(2)))
    return page(idx).items.map((it) => it.seq)
  }
  t.alike(run(true), [2], 'settled after each record')
  t.alike(run(false), [2], 'settled once')

  const idx = index()
  idx.foldUsername(A, 1, username(A, 'oldname'))
  idx.settle(A)
  idx.foldUsername(A, 2, username(A, 'newname'))
  idx.settle(A)
  idx.foldPost(B, 1, post('@oldname', D(1)))
  t.alike(page(idx).items.map((it) => it.seq), [1], 'a rename inside the window keeps the old name')
})

test('self-mentions take no capacity, before or after the name settles', (t) => {
  const idx = index({ maxPerAuthor: 2 })
  idx.foldUsername(B, 1, username(B, 'bia'))
  idx.settle(B)
  idx.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(B, 2, post('eu @bia', D(2)))
  idx.foldPost(B, 3, post('eu @bia', D(3)))
  t.alike(page(idx).items, [{ key: B, seq: 1, at: D(1), kind: 'reply' }], 'stored names are skipped at fold')

  const late = index({ maxPerAuthor: 2 })
  late.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  late.foldPost(B, 2, post('eu @bia', D(2)))
  late.foldUsername(B, 1, username(B, 'bia'))
  late.settle(B)
  late.foldPost(B, 3, post('x', D(3), { replyTo: { author: C, seq: 1 } }))
  t.alike(page(late).items, [{ key: B, seq: 1, at: D(1), kind: 'reply' }], 'settle drops the rows of a new own name')
})

test('the per-author ceiling evicts the whole lowest-seq post', (t) => {
  const idx = index({ maxPerAuthor: 2 })
  idx.foldUsername(C, 1, username(C, 'carla'))
  idx.settle(C)
  idx.foldPost(B, 1, post('@carla', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(B, 2, post('x', D(2), { replyTo: { author: k(0xd), seq: 1 } }))
  t.alike(page(idx).items, [])
  t.alike(idx.pageV2({ target: C, issuerUsable: ok, now: NOW }).items, [])
  t.is(idx.pageV2({ target: k(0xd), now: NOW }).items.length, 1)
})

test('an author refused once keeps pages incomplete until it is re-served', (t) => {
  const idx = index({ maxAuthors: 1 })
  idx.foldPost(C, 1, post('x', D(1)))
  idx.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.removeAuthor(C)
  idx.foldPost(B, 2, post('x', D(2), { replyTo: { author: A, seq: 1 } }))
  let p = page(idx)
  t.alike(p.items.map((it) => it.seq), [2])
  t.is(p.incomplete, true, 'seq 1 was refused and is missing')
  idx.removeAuthor(B)
  idx.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(B, 2, post('x', D(2), { replyTo: { author: A, seq: 1 } }))
  p = page(idx)
  t.alike(p.items.map((it) => it.seq), [2, 1])
  t.is(p.incomplete, false)
})

test('resolving names releases the unresolved quota', (t) => {
  const idx = index()
  const names = []
  for (let i = 0; i < MAX_UNRESOLVED_TOKENS_PER_AUTHOR; i++) names.push('nome' + String(i).padStart(3, '0'))
  names.forEach((name, i) => idx.foldPost(B, i + 1, post('@' + name, D(1))))
  names.forEach((name, i) => idx.foldUsername(A, i + 1, username(A, name)))
  idx.settle(A)
  idx.foldPost(B, 100, post('@carla', D(2)))
  const E = k(0xe)
  idx.foldUsername(E, 1, username(E, 'carla'))
  idx.settle(E)
  t.alike(idx.pageV2({ target: E, issuerUsable: ok, now: NOW }).items, [{ key: B, seq: 100, at: D(2), kind: 'mention' }])
  t.is(page(idx, { limit: 64 }).items.length, MAX_UNRESOLVED_TOKENS_PER_AUTHOR)
})

test('engagement kinds are like and repost, frozen', (t) => {
  t.alike(ENGAGEMENT_KINDS, ['like', 'repost'])
  t.ok(Object.isFrozen(ENGAGEMENT_KINDS))
})

test('pageV2 never carries like or repost rows', (t) => {
  const idx = index()
  idx.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  const engagementRows = [{ key: C, seq: 5, at: D(2), kind: 'like' }, { key: C, seq: 6, at: D(3), kind: 'repost' }]
  const p = page(idx, { engagementRows, engagementIncomplete: true })
  t.alike(p.items, [{ key: B, seq: 1, at: D(1), kind: 'reply' }])
  t.is(p.incomplete, false)
  t.is(p.next, null)
})

test('pageV3 interleaves likes and reposts with follow and post rows', (t) => {
  const idx = index()
  idx.foldPost(B, 2, post('x', D(2), { replyTo: { author: A, seq: 1 } }))
  idx.foldPost(C, 4, post('x', D(4), { quote: { author: A, seq: 1 } }))
  const followRows = [{ key: C, seq: 1, at: D(3) }]
  const engagementRows = [{ key: B, seq: 7, at: D(5), kind: 'like' }, { key: C, seq: 9, at: D(1), kind: 'repost' }]
  const want = [
    { key: B, seq: 7, at: D(5), kind: 'like' },
    { key: C, seq: 4, at: D(4), kind: 'quote' },
    { key: C, seq: 1, at: D(3), kind: 'follow' },
    { key: B, seq: 2, at: D(2), kind: 'reply' },
    { key: C, seq: 9, at: D(1), kind: 'repost' }
  ]
  const p = page3(idx, { followRows, engagementRows })
  t.alike(p.items, want)
  t.is(p.next, null)
  t.is(p.incomplete, false)
  t.alike(Object.keys(p).sort(), ['incomplete', 'items', 'next'])
  t.alike(walk((o) => page3(idx, o), { followRows, engagementRows }), want, 'cursor across kinds')
})

test('pageV3 limit 1 returns a newer like before an older reply', (t) => {
  const idx = index()
  idx.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  const engagementRows = [{ key: C, seq: 3, at: D(2), kind: 'like' }]
  const p1 = page3(idx, { engagementRows, limit: 1 })
  t.alike(p1.items, [{ key: C, seq: 3, at: D(2), kind: 'like' }])
  t.alike(p1.next, { at: D(2), key: C, seq: 3 })
  const p2 = page3(idx, { engagementRows, limit: 1, after: p1.next })
  t.alike(p2.items, [{ key: B, seq: 1, at: D(1), kind: 'reply' }])
  t.is(p2.next, null)
})

test('pageV3 hides future likes and skips blocked engagers and the target', (t) => {
  const idx = index()
  const future = new Date(NOW + MAX_FUTURE_MS + 1000).toISOString()
  const engagementRows = [
    { key: B, seq: 1, at: future, kind: 'like' },
    { key: C, seq: 2, at: D(3), kind: 'like' },
    { key: A, seq: 3, at: D(2), kind: 'repost' },
    { key: B, seq: 4, at: D(1), kind: 'repost' }
  ]
  const isBlocked = (key) => key === C
  t.alike(page3(idx, { engagementRows, isBlocked }).items, [{ key: B, seq: 4, at: D(1), kind: 'repost' }])
  const later = page3(idx, { engagementRows, isBlocked, now: NOW + 2 * MAX_FUTURE_MS })
  t.ok(later.items.some((it) => it.seq === 1), 'hidden, not deleted')
})

test('pageV3 skips malformed engagement rows', (t) => {
  const idx = index()
  const good = { key: B, seq: 1, at: D(1), kind: 'like' }
  const engagementRows = [
    null,
    [B, 1],
    { key: 'zz', seq: 2, at: D(1), kind: 'like' },
    { key: B, seq: 0, at: D(1), kind: 'like' },
    { key: B, seq: 3, at: '2026-01-01', kind: 'like' },
    { key: B, seq: 4, at: D(1), kind: 'follow' },
    { key: B, seq: 5, at: D(1), kind: 'reply' },
    { key: B, seq: 6, at: D(1) },
    good
  ]
  t.alike(page3(idx, { engagementRows }).items, [good])
  t.alike(page3(idx, { engagementRows: 'x' }).items, [])
})

test('pageV3 incomplete joins the engagement flag with the others', (t) => {
  const idx = index()
  t.is(page3(idx).incomplete, false)
  t.is(page3(idx, { engagementIncomplete: true }).incomplete, true)
  t.is(page3(idx, { engagementIncomplete: 'yes' }).incomplete, false)
  t.is(page3(idx, { followIncomplete: true }).incomplete, true)
  idx.markPending(B)
  t.is(page3(idx).incomplete, true)
})

// Today's order, recomputed from the inputs alone: every candidate, the
// highest priority kind per post, filtered, then one full sort.
function fullSort (rows) {
  return rows.slice().sort((a, b) => (Date.parse(b.at) - Date.parse(a.at)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (b.seq - a.seq))
}

test('pages and cursors are identical to a full sort, at every page size', (t) => {
  const idx = index()
  idx.foldUsername(A, 1, username(A, 'ana'))
  idx.foldUsername(A, 2, username(A, 'aninha'))
  idx.settle(A)
  const future = new Date(NOW + MAX_FUTURE_MS + 1000).toISOString()
  const blocked = new Set([k(0x105)])
  const expected = []
  // 40 authors, 8 posts each, many sharing the same `at` (same day) so the
  // key and seq tie-breaks matter; some posts are on two or three pairs.
  for (let a = 0; a < 40; a++) {
    const author = k(0x100 + a)
    for (let seq = 1; seq <= 8; seq++) {
      const at = (a + seq) % 9 === 0 ? future : D(1 + ((a * 3 + seq) % 5))
      const shape = (a + seq) % 6
      let record
      let kind = null
      if (shape === 0) {
        record = post('oi @ana', at, { replyTo: { author: A, seq: 1 } })
        kind = 'reply'
      } else if (shape === 1) {
        record = post('@aninha veja', at, { quote: { author: A, seq: 1 } })
        kind = 'quote'
      } else if (shape === 2) {
        record = post('@ana e @aninha', at)
        kind = 'mention'
      } else if (shape === 3) {
        record = post('x', at, { replyTo: { author: B, seq: 1 } }) // not for A
      } else if (shape === 4) {
        record = post('x', at, { replyTo: { author: A, seq: 2 }, quote: { author: A, seq: 3 } })
        kind = 'reply'
      } else {
        record = post('@ana', at, { quote: { author: C, seq: 1 } })
        kind = 'mention'
      }
      idx.foldPost(author, seq, record)
      if (kind !== null && at !== future && !blocked.has(author)) expected.push({ key: author, seq, at, kind })
    }
  }
  const followRows = []
  const engagementRows = []
  for (let i = 0; i < 30; i++) {
    const key = k(0x200 + (i % 7))
    const at = D(1 + (i % 5))
    followRows.push({ key, seq: 100 + i, at })
    expected.push({ key, seq: 100 + i, at, kind: 'follow' })
    const ekind = i % 2 ? 'like' : 'repost'
    engagementRows.push({ key, seq: 200 + i, at, kind: ekind })
  }
  followRows.push({ key: k(0x105), seq: 999, at: D(2) }) // blocked
  const isBlocked = (key) => blocked.has(key)
  const want2 = fullSort(expected)
  const want3 = fullSort(expected.concat(engagementRows))
  const run = (fn, limit) => {
    const seen = []
    let after = null
    for (let guard = 0; guard < 10000; guard++) {
      const p = fn({ followRows, engagementRows, isBlocked, after, limit })
      seen.push(...p.items)
      const last = p.items[p.items.length - 1]
      if (p.next !== null) t.alike(p.next, { at: last.at, key: last.key, seq: last.seq }, 'the cursor is the last row')
      if (p.next === null) return seen
      after = p.next
    }
    throw new Error('never ended')
  }
  for (const limit of [1, 2, 7, 30, 64]) {
    t.alike(run((o) => page(idx, o), limit), want2, 'v2 limit ' + limit)
    t.alike(run((o) => page3(idx, o), limit), want3, 'v3 limit ' + limit)
  }
  t.alike(page3(idx, { followRows, engagementRows, isBlocked, limit: 64 }).items, want3.slice(0, 64))
})

test('a page examines the rows it needs, not every candidate', (t) => {
  const idx = index()
  for (let a = 0; a < 200; a++) {
    for (let seq = 1; seq <= 10; seq++) idx.foldPost(k(0x1000 + a), seq, post('x', D(1 + (seq % 9)), { replyTo: { author: A, seq: 1 } }))
  }
  let calls = 0
  const isBlocked = () => {
    calls++
    return false
  }
  const p1 = page(idx, { isBlocked, limit: 5 })
  t.is(p1.items.length, 5)
  t.ok(calls <= 6, 'the first page filtered ' + calls + ' of 2000 candidates')
  calls = 0
  const p2 = page(idx, { isBlocked, limit: 5, after: p1.next })
  t.is(p2.items.length, 5)
  t.ok(calls <= 6, 'the next page filtered ' + calls)
  t.ok(p2.items.every((it) => p1.items.every((x) => x.key !== it.key || x.seq !== it.seq)), 'no row repeated')
  // A write to the pair is seen by the next page.
  idx.foldPost(k(0x9999), 1, post('x', D(28), { replyTo: { author: A, seq: 1 } }))
  t.alike(page(idx, { limit: 1 }).items, [{ key: k(0x9999), seq: 1, at: D(28), kind: 'reply' }])
  idx.removePost(k(0x9999), 1)
  t.alike(page(idx, { limit: 5 }).items, p1.items, 'and a removal too')
})

test('incomplete per target: pending authors and refused rows only mark the targets they touch', (t) => {
  const idx = index()
  idx.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  idx.markPending(C)
  t.is(page(idx).incomplete, true, 'C pending and never settled: every target')
  t.is(idx.pageV2({ target: k(0xd), now: NOW }).incomplete, true)
  idx.settle(C)
  idx.settle(B)
  t.is(page(idx).incomplete, false)
  // B grows and stops mid-download: only the targets it has rows for.
  idx.markPending(B)
  t.is(page(idx).incomplete, true, 'B has a row for A')
  t.is(idx.pageV2({ target: k(0xd), now: NOW }).incomplete, false, 'and none for k(0xd)')
  idx.settle(B)
  // A name A holds counts like its key.
  idx.foldUsername(A, 1, username(A, 'ana'))
  idx.settle(A)
  idx.foldPost(C, 1, post('@ana', D(2)))
  idx.markPending(C)
  t.is(page(idx).incomplete, true, 'C mentions a name A holds')
  t.is(page(idx, { issuerUsable: () => false }).incomplete, false, 'not under a revoked issuer')
  idx.settle(C)

  // The global cap: only the pair whose row was refused.
  const full = index({ maxEdges: 1 })
  full.foldPost(B, 1, post('x', D(1), { replyTo: { author: A, seq: 1 } }))
  full.foldPost(C, 1, post('x', D(1), { replyTo: { author: k(0xd), seq: 1 } }))
  t.is(full.pageV2({ target: k(0xd), now: NOW }).incomplete, true, 'the refused row marks its target')
  t.is(page(full).incomplete, false, 'not another one')
  full.removeAuthor(C)
  t.is(full.pageV2({ target: k(0xd), now: NOW }).incomplete, false)
  // More refused pairs than MAX_CUT_PAIRS_PER_AUTHOR: every page.
  for (let i = 0; i <= MAX_CUT_PAIRS_PER_AUTHOR; i++) full.foldPost(C, i + 1, post('x', D(1), { replyTo: { author: k(0x500 + i), seq: 1 } }))
  t.is(page(full).incomplete, true)
  full.removeAuthor(C)
  t.is(page(full).incomplete, false)
})

test('incomplete while the target itself is pending: its names may sit in an unread block', (t) => {
  const idx = index()
  idx.markPending(A)
  idx.settle(A) // settled once, with no name yet
  idx.foldPost(B, 1, post('oi @ana', D(3)))
  idx.settle(B)
  t.alike(page(idx).items, [], 'no name of A is known, so no pair to read')
  t.is(page(idx).incomplete, false, 'A settled: nothing pending')
  // A grows: its username record is in a block the scan has not reached.
  idx.markPending(A)
  const p = page(idx)
  t.alike(p.items, [])
  t.is(p.incomplete, true, 'the mention of a name A may hold cannot be known yet')
  t.is(idx.pageV2({ target: k(0xd), now: NOW }).incomplete, false, 'not another target')
  idx.foldUsername(A, 2, username(A, 'ana'))
  t.is(page(idx).incomplete, true, 'folded, not settled')
  idx.settle(A)
  const done = page(idx)
  t.alike(done.items, [{ key: B, seq: 1, at: D(3), kind: 'mention' }])
  t.is(done.incomplete, false)
  // Tracked and never settled counts too (a fold before the first settle).
  const fresh = index()
  fresh.foldUsername(A, 1, username(A, 'ana'))
  t.is(page(fresh).incomplete, true)
  fresh.settle(A)
  t.is(page(fresh).incomplete, false)
})

test('arrives late: a settled author pending on unread blocks is not flagged for a target it has no rows for', (t) => {
  const idx = index()
  idx.foldUsername(A, 1, username(A, 'ana'))
  idx.settle(A)
  idx.foldPost(C, 1, post('x', D(1), { replyTo: { author: k(0xd), seq: 1 } }))
  idx.settle(C)
  // C grows; its new post mentioning A sits in a block not read yet. The
  // documented rule: C is known to touch only k(0xd), so A's page says
  // complete and the mention arrives late, never as a false notice.
  idx.markPending(C)
  t.is(page(idx).incomplete, false, 'not flagged for A')
  t.alike(page(idx).items, [])
  t.is(idx.pageV2({ target: k(0xd), now: NOW }).incomplete, true, 'flagged for the target it touches')
  idx.foldPost(C, 2, post('oi @ana', D(4)))
  idx.settle(C)
  const p = page(idx)
  t.alike(p.items, [{ key: C, seq: 2, at: D(4), kind: 'mention' }], 'appears once the block is read')
  t.is(p.incomplete, false)
})

test('the page cache never serves stale rows: rotation, dropped self-mentions and LRU churn', (t) => {
  const idx = index({ maxPerPair: 3 })
  idx.foldUsername(A, 1, username(A, 'ana'))
  idx.settle(A)
  const expected = new Map()
  const add = (author, seq, record, kind) => {
    idx.foldPost(author, seq, record)
    if (kind !== null) expected.set(author + ':' + seq, { key: author, seq, at: record.at, kind })
  }
  for (let a = 0; a < 6; a++) {
    const author = k(0x300 + a)
    add(author, 1, post('x', D(1 + a), { replyTo: { author: A, seq: 1 } }), 'reply')
    add(author, 2, post('@ana', D(2 + a)), 'mention')
  }
  const all = () => walk((o) => page(idx, o))
  t.alike(all(), fullSort([...expected.values()]), 'primed')
  // maxPerPair rotation: the author's lowest seq on that pair leaves.
  const E = k(0x300)
  for (let seq = 3; seq <= 6; seq++) add(E, seq, post('x', D(10 + seq), { replyTo: { author: A, seq: 1 } }), 'reply')
  expected.delete(E + ':1')
  expected.delete(E + ':3')
  t.alike(all(), fullSort([...expected.values()]), 'after rotation on k:A')
  // dropOwnMentions: F mentioned @ana before its own record for that name
  // settled (a copy the index accepts), so its row is a self-mention.
  const F = k(0x301)
  idx.foldUsername(F, 9, username(F, 'ana'))
  idx.settle(F)
  expected.delete(F + ':2')
  t.alike(all(), fullSort([...expected.values()]), 'after the self-mention left n:ana')
  // More pairs than the cache holds evict A's pairs; pages rebuild them.
  for (let i = 0; i < PAGE_CACHE_PAIRS + 2; i++) {
    const target = k(0x4000 + i)
    idx.foldPost(k(0x5000), i + 1, post('x', D(1), { replyTo: { author: target, seq: 1 } }))
    idx.pageV2({ target, now: NOW })
  }
  add(k(0x302), 9, post('@ana', D(27)), 'mention')
  t.alike(all(), fullSort([...expected.values()]), 'after LRU churn and a new row')
})

test('holders: verified holders of a token, filtered by issuer, sorted copy', (t) => {
  const REVOKED = k(0x156)
  const idx = index()
  idx.foldUsername(C, 1, username(C, 'ana'))
  idx.foldUsername(A, 1, username(A, 'ana'))
  idx.foldUsername(B, 1, username(B, 'ana', REVOKED))
  // Settled out of key order, so the sort is what puts them in order.
  for (const m of [C, B, A]) idx.settle(m)
  const usableIssuer = (issuer) => issuer !== REVOKED
  t.alike(idx.holders('ana', ok), [A, B, C], 'sorted')
  t.alike(idx.holders('ana', usableIssuer), [A, C], 'revoked issuer filtered')
  t.alike(idx.holders('nadie', ok), [])
  t.alike(idx.holders('', ok), [])
  t.alike(idx.holders(null, ok), [])
  t.alike(idx.holders('ana', () => { throw new Error('x') }), [])
  t.alike(idx.holders('ana', 'nope'), [])
  const got = idx.holders('ana', ok)
  got.length = 0
  got.push('x')
  t.alike(idx.holders('ana', ok), [A, B, C], 'returned array is a copy')
})

test('holders matches who gets the mention row from the page', (t) => {
  const REVOKED = k(0x156)
  const idx = createPostNoticeIndex({ verifyUsername: (author, record) => record.member !== k(0xd) })
  const members = [A, B, C, k(0xd)]
  idx.foldUsername(A, 1, username(A, 'ana'))
  idx.foldUsername(B, 1, username(B, 'ana', REVOKED))
  idx.foldUsername(C, 1, username(C, 'ana'))
  idx.foldUsername(C, 2, username(C, 'ana_nova'))
  idx.foldUsername(k(0xd), 1, username(k(0xd), 'ana'))
  for (const m of members) idx.settle(m)
  idx.foldPost(k(0xe), 1, post('oi @ana', D(1)))
  const issuerUsable = (issuer) => issuer !== REVOKED
  const fromPage = members.filter((m) =>
    idx.pageV2({ target: m, issuerUsable, now: NOW }).items.some((r) => r.kind === 'mention'))
  t.alike(idx.holders('ana', issuerUsable), fromPage.sort())
  t.alike(fromPage, [A, C], 'former name still held inside the window')
})
