'use strict'

// The post notice index (lib/post-notices.js): replies, quotes and mentions
// folded from served diaries and paged with the follow rows. No network.
const test = require('brittle')
const {
  MAX_POST_NOTICES_PER_PAIR,
  MAX_POST_NOTICES_PER_AUTHOR,
  POST_NOTICES_MAX_EDGES,
  MAX_UNRESOLVED_TOKENS_PER_AUTHOR,
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
  t.alike(Object.keys(idx).sort(), ['foldPost', 'foldUsername', 'markPending', 'pageV2', 'removeAuthor', 'removePost', 'settle'])
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
