// Root resolution and target seek (rodaLoad.js) with fake I/O: request
// counts, the signed-record gate on the seeder's root/top, the climb on a
// seeder without /index/roda, and transient failures.
'use strict'

const test = require('brittle')
const load = () => import('../src/rodaLoad.js')

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const HINTS = { [B]: { profileSeq: 1, usernameSeq: 2 } }

const tgt = (ref) => { const [author, seq] = ref.split(':'); return { author, seq: Number(seq) } }
const post = (ref, parent = null) => ({ kind: 'post', ...tgt(ref), at: '2026-11-15T10:00:00.000Z', text: 'x', replyTo: parent === null ? null : tgt(parent) })

const postIndex = (ref) => ({ ref, parent: null, replies: [], next: null, quotes: [], likes: 0, reposts: 0, repliesTotal: 0, quotesTotal: 0, authors: HINTS, indexing: false, complete: true })

// `posts`: the signed records the node can read (ref -> item). `index`: what
// fetchPost answers per ref (default ok), `roda`: what fetchRoda answers.
function world ({ posts, index = {}, roda = null }) {
  const calls = { fetchPost: [], fetchRoda: [], read: [] }
  const io = {
    fetchPost: async (ref) => {
      calls.fetchPost.push(ref)
      return index[ref] || { ok: true, value: postIndex(ref) }
    },
    fetchRoda: async (ref) => {
      calls.fetchRoda.push(ref)
      return roda || { ok: false, reason: 'not-found' }
    },
    read: async (refs, hints) => {
      calls.read.push({ refs: refs.slice(), hints })
      return new Map(refs.map((r) => [r, posts[r] || null]))
    }
  }
  return { io, calls }
}

const rodaPage = (ref, root, top, extra = {}) => ({ ok: true, value: { ref, root, top, items: [{ ref, to: top }], next: null, total: 1, authors: HINTS, indexing: false, complete: true, ...extra } })

// root R <- comment T <- M1 <- M2 <- K (deep reply).
const R = A + ':1'
const T = B + ':4'
const M1 = C + ':7'
const M2 = B + ':9'
const K = A + ':12'
const chain = () => ({ [R]: post(R), [T]: post(T, R), [M1]: post(M1, T), [M2]: post(M2, M1), [K]: post(K, M2) })

test('a seed root costs zero requests', async (t) => {
  const { resolveRoot } = await load()
  const { io, calls } = world({ posts: chain() })
  const r = await resolveRoot({ key: R, seed: post(R) }, io)
  t.alike(r, { status: 'ok', root: R, top: null, target: null, index: null, page: null, proven: true })
  t.is(calls.fetchPost.length + calls.fetchRoda.length + calls.read.length, 0)
})

test('a seed with replyTo or another ref is not taken as root', async (t) => {
  const { resolveRoot } = await load()
  const { io, calls } = world({ posts: chain() })
  await resolveRoot({ key: R, seed: post(A + ':2') }, io)
  t.is(calls.fetchPost.length, 1, 'seed for another ref: asked')
  const w = world({ posts: chain(), roda: rodaPage(T, R, T) })
  await resolveRoot({ key: T, seed: { ...post(T), replyTo: null, seq: 5 } }, w.io)
  t.is(w.calls.fetchPost.length, 1)
})

test('a seed for key that is itself a reply is not taken as root', async (t) => {
  const { resolveRoot } = await load()
  const { io, calls } = world({ posts: chain(), roda: rodaPage(T, R, T) })
  const r = await resolveRoot({ key: T, seed: post(T, R) }, io)
  t.alike(calls.fetchPost, [T], 'asked despite the seed')
  t.is(r.root, R)
  t.is(r.top, T)
})

test('a root without seed: one fetchPost, its answer returned as index', async (t) => {
  const { resolveRoot } = await load()
  const { io, calls } = world({ posts: chain() })
  const r = await resolveRoot({ key: R }, io)
  t.is(r.status, 'ok')
  t.is(r.root, R)
  t.is(r.target, null)
  t.is(r.proven, true)
  t.alike(r.index, postIndex(R), 'the screen does not ask again')
  t.alike(calls.fetchPost, [R])
  t.is(calls.fetchRoda.length, 0)
  t.alike(calls.read, [{ refs: [R], hints: HINTS }], 'read with the index author hints')
})

test('a deep reply resolves with exactly fetchPost + fetchRoda and returns the page', async (t) => {
  const { resolveRoot } = await load()
  const page = rodaPage(K, R, T)
  const { io, calls } = world({ posts: chain(), roda: page })
  const r = await resolveRoot({ key: K }, io)
  t.alike(r, { status: 'ok', root: R, top: T, target: K, index: null, page: page.value, proven: false })
  t.alike(calls.fetchPost, [K])
  t.alike(calls.fetchRoda, [K])
  t.is(calls.read.length, 2, 'no climb before the screen paints')
  t.alike(calls.read[1], { refs: [R, T], hints: HINTS }, 'root and top read with the roda hints')
})

// Unrelated but genuine conversation R2 <- T2.
const R2 = C + ':20'
const T2 = A + ':21'
const withStranger = () => ({ ...chain(), [R2]: post(R2), [T2]: post(T2, R2) })

test('a seeder pairing key with an unrelated conversation is not proven', async (t) => {
  const { resolveRoot } = await load()
  const { io, calls } = world({ posts: withStranger(), roda: rodaPage(K, R2, T2) })
  const r = await resolveRoot({ key: K }, io)
  t.is(r.status, 'ok')
  t.is(r.root, R2)
  t.is(r.top, T2)
  t.is(r.proven, false, 'the index chose the conversation')
  t.is(calls.fetchPost.length + calls.fetchRoda.length, 2)
})

test('climbOnly skips fetchRoda and resolves through the signed chain', async (t) => {
  const { resolveRoot } = await load()
  const { io, calls } = world({ posts: withStranger(), roda: rodaPage(K, R2, T2) })
  const r = await resolveRoot({ key: K, climbOnly: true }, io)
  t.alike(r, { status: 'ok', root: R, top: T, target: K, index: postIndex(R), page: null, proven: true })
  t.is(calls.fetchRoda.length, 0)
  t.alike(calls.fetchPost, [K, M2, M1, T, R], 'one fetchPost per hop')
})

test('climbOnly still stops at 8 hops', async (t) => {
  const { resolveRoot, MAX_HOPS } = await load()
  const posts = {}
  const refs = []
  for (let i = 1; i <= 12; i++) refs.push(A + ':' + i)
  posts[refs[0]] = post(refs[0])
  for (let i = 1; i < refs.length; i++) posts[refs[i]] = post(refs[i], refs[i - 1])
  const { io, calls } = world({ posts })
  const r = await resolveRoot({ key: refs[11], climbOnly: true }, io)
  t.is(r.status, 'orphan')
  t.is(r.cut, true)
  t.is(calls.fetchRoda.length, 0)
  t.is(calls.fetchPost.length, 1 + MAX_HOPS)
})

test('a key whose signed parent is the top is proven by the roda path', async (t) => {
  const { resolveRoot } = await load()
  const { io, calls } = world({ posts: chain(), roda: rodaPage(M1, R, T) })
  const r = await resolveRoot({ key: M1 }, io)
  t.is(r.top, T)
  t.is(r.proven, true)
  t.is(calls.fetchPost.length + calls.fetchRoda.length, 2)
})

test('a comment key is its own top', async (t) => {
  const { resolveRoot } = await load()
  const { io, calls } = world({ posts: chain(), roda: rodaPage(T, R, T) })
  const r = await resolveRoot({ key: T }, io)
  t.is(r.status, 'ok')
  t.is(r.root, R)
  t.is(r.top, T)
  t.is(r.target, T)
  t.is(r.proven, true, 'key is the top')
  t.alike(calls.read[1].refs, [R], 'only the root read again')
})

test('a forged root (signed replyTo not null) falls to the climb', async (t) => {
  const { resolveRoot } = await load()
  // The seeder names M1 as root and M2 as top.
  const { io, calls } = world({ posts: chain(), roda: rodaPage(K, M1, M2) })
  const r = await resolveRoot({ key: K }, io)
  t.alike(r, { status: 'ok', root: R, top: T, target: K, index: postIndex(R), page: null, proven: true })
  t.alike(calls.fetchPost, [K, M2, M1, T, R], 'one fetchPost per hop')
  t.is(calls.fetchRoda.length, 1, 'never asked again')
})

test('a forged top (signed replyTo not root) falls to the climb', async (t) => {
  const { resolveRoot } = await load()
  // R really is a root, but M1 answers T, not R.
  const { io, calls } = world({ posts: chain(), roda: rodaPage(K, R, M1) })
  const r = await resolveRoot({ key: K }, io)
  t.is(r.status, 'ok')
  t.is(r.root, R)
  t.is(r.top, T, 'top from the signed chain')
  t.is(r.page, null, 'the forged page is not handed on')
  t.is(calls.fetchPost.length, 5)
})

test('a roda answer for another ref or an unreadable root falls to the climb', async (t) => {
  const { resolveRoot } = await load()
  const w1 = world({ posts: chain(), roda: rodaPage(M2, R, T) })
  t.is((await resolveRoot({ key: K }, w1.io)).page, null, 'ref mismatch')
  const w2 = world({ posts: chain(), roda: rodaPage(K, C + ':99', T) })
  const r = await resolveRoot({ key: K }, w2.io)
  t.is(r.root, R)
  t.is(r.page, null)
})

test('not-found climbs by signed replyTo and stops at 8 hops', async (t) => {
  const { resolveRoot, MAX_HOPS } = await load()
  t.is(MAX_HOPS, 8)
  const posts = {}
  const refs = []
  for (let i = 1; i <= 12; i++) refs.push(A + ':' + i)
  posts[refs[0]] = post(refs[0])
  for (let i = 1; i < refs.length; i++) posts[refs[i]] = post(refs[i], refs[i - 1])
  const key = refs[11]
  const { io, calls } = world({ posts })
  const r = await resolveRoot({ key }, io)
  t.is(r.status, 'orphan')
  t.is(r.cut, true)
  t.is(r.root, refs[3], 'the top-most message read')
  t.is(r.target, key)
  t.is(calls.fetchRoda.length, 1, 'not-found answer from the roda route')
  t.is(calls.fetchPost.length, 1 + MAX_HOPS, 'the key, then one per hop')
  t.is(calls.read.length, 1 + MAX_HOPS)
})

test('a chain within 8 hops resolves through the climb', async (t) => {
  const { resolveRoot } = await load()
  const posts = {}
  const refs = []
  for (let i = 1; i <= 9; i++) refs.push(A + ':' + i)
  posts[refs[0]] = post(refs[0])
  for (let i = 1; i < refs.length; i++) posts[refs[i]] = post(refs[i], refs[i - 1])
  const { io } = world({ posts })
  const r = await resolveRoot({ key: refs[8] }, io)
  t.is(r.status, 'ok', 'eight hops reach the root')
  t.is(r.root, refs[0])
  t.is(r.top, refs[1])
})

test('the climb follows signed replyTo, never the index parent', async (t) => {
  const { resolveRoot } = await load()
  const lying = { ok: true, value: { ...postIndex(K), parent: C + ':50' } }
  const { io, calls } = world({ posts: chain(), index: { [K]: lying } })
  const r = await resolveRoot({ key: K }, io)
  t.is(r.root, R)
  t.absent(calls.fetchPost.includes(C + ':50'))
})

test('a key the seeder does not index skips fetchRoda and climbs without hints', async (t) => {
  const { resolveRoot } = await load()
  const { io, calls } = world({ posts: chain(), index: { [K]: { ok: false, reason: 'not-found' } } })
  const r = await resolveRoot({ key: K }, io)
  t.is(r.status, 'ok')
  t.is(r.root, R)
  t.is(calls.fetchRoda.length, 0)
  t.alike(calls.read[0], { refs: [K], hints: {} })
})

test('a non-transient fetchPost failure still asks fetchRoda, without hints', async (t) => {
  const { resolveRoot } = await load()
  for (const reason of ['malformed', 'status', 'too-large']) {
    const page = rodaPage(K, R, T)
    const { io, calls } = world({ posts: chain(), index: { [K]: { ok: false, reason } }, roda: page })
    const r = await resolveRoot({ key: K }, io)
    t.alike(calls.fetchRoda, [K], reason)
    t.alike(calls.read[0], { refs: [K], hints: {} })
    t.is(r.root, R)
    t.is(r.page, page.value)
  }
})

test('an ok answer without an object value is malformed, never a throw', async (t) => {
  const { resolveRoot } = await load()
  const w1 = world({ posts: chain(), index: { [K]: { ok: true } }, roda: rodaPage(K, R, T) })
  const r1 = await resolveRoot({ key: K }, w1.io)
  t.is(r1.root, R, 'fetchPost ok without value: no hints')
  t.alike(w1.calls.read[0], { refs: [K], hints: {} })
  const w2 = world({ posts: chain(), roda: { ok: true, value: 'x' } })
  const r2 = await resolveRoot({ key: K }, w2.io)
  t.is(r2.root, R, 'fetchRoda ok without object value: climbs')
  t.is(r2.proven, true)
})

test('null arguments give an error, never a throw', async (t) => {
  const { resolveRoot, seekTarget } = await load()
  t.is((await resolveRoot(null, null)).reason, 'invalid-input')
  t.is((await resolveRoot({ key: K }, null)).status, 'error')
  t.alike(await seekTarget(null, null), { found: false, next: null, failed: true })
})

test('an unreadable parent gives orphan with the last readable ref', async (t) => {
  const { resolveRoot } = await load()
  const posts = chain()
  delete posts[T]
  const { io } = world({ posts, roda: rodaPage(K, M1, M1) })
  const r = await resolveRoot({ key: K }, io)
  t.alike(r, { status: 'orphan', root: M1, top: null, target: K, index: null, page: null, cut: false })
  t.absent('proven' in r)
})

test('a key whose own parent is unreadable is its own orphan root', async (t) => {
  const { resolveRoot } = await load()
  const { io } = world({ posts: { [K]: post(K, M2) } })
  const r = await resolveRoot({ key: K }, io)
  t.is(r.status, 'orphan')
  t.is(r.root, K)
  t.is(r.target, K)
})

test('rate-limited surfaces with retryAfterMs and no second call', async (t) => {
  const { resolveRoot } = await load()
  const limited = { ok: false, reason: 'rate-limited', retryAfterMs: 4200 }
  const w1 = world({ posts: chain(), index: { [K]: limited } })
  t.alike(await resolveRoot({ key: K }, w1.io), { status: 'error', reason: 'rate-limited', retryAfterMs: 4200 })
  t.alike(w1.calls.fetchPost, [K])
  t.is(w1.calls.fetchRoda.length + w1.calls.read.length, 0)

  const w2 = world({ posts: chain(), roda: limited })
  t.alike(await resolveRoot({ key: K }, w2.io), { status: 'error', reason: 'rate-limited', retryAfterMs: 4200 })
  t.is(w2.calls.fetchRoda.length, 1)
  t.is(w2.calls.fetchPost.length, 1, 'no climb after a transient roda failure')

  const w3 = world({ posts: chain(), index: { [M2]: limited } })
  t.is((await resolveRoot({ key: K }, w3.io)).reason, 'rate-limited', 'during the climb')
  t.alike(w3.calls.fetchPost, [K, M2])
})

test('network and timeout surface without retry', async (t) => {
  const { resolveRoot } = await load()
  for (const reason of ['network', 'timeout']) {
    const { io, calls } = world({ posts: chain(), index: { [K]: { ok: false, reason } } })
    t.alike(await resolveRoot({ key: K }, io), { status: 'error', reason, retryAfterMs: 0 })
    t.is(calls.fetchPost.length, 1)
  }
  const thrown = world({ posts: chain() })
  thrown.io.fetchPost = async () => { throw new Error('boom') }
  t.is((await resolveRoot({ key: K }, thrown.io)).reason, 'network', 'a thrown fetch never escapes')
})

test('an unreadable key or a bad key is an error', async (t) => {
  const { resolveRoot } = await load()
  const { io } = world({ posts: {} })
  t.alike(await resolveRoot({ key: K }, io), { status: 'error', reason: 'unavailable', retryAfterMs: 0 })
  t.is((await resolveRoot({ key: 'nope' }, io)).reason, 'invalid-input')
  const bad = world({ posts: chain() })
  bad.io.read = async () => { throw new Error('gone') }
  t.is((await resolveRoot({ key: K }, bad.io)).status, 'error')
})

test('a read item for a different ref is not trusted', async (t) => {
  const { resolveRoot } = await load()
  const { io } = world({ posts: { ...chain(), [K]: post(M1, T) } })
  t.is((await resolveRoot({ key: K }, io)).reason, 'unavailable')
})

test('seekTarget stops at 4 pages, at next null and when found', async (t) => {
  const { seekTarget } = await load()
  const cursors = []
  let n = 0
  const r1 = await seekTarget({ target: 'x' }, { loadPage: async (c) => { cursors.push(c); return { next: 'c' + (++n) } }, has: () => false })
  t.alike(r1, { found: false, next: 'c4', failed: false })
  t.alike(cursors, [null, 'c1', 'c2', 'c3'])

  let calls = 0
  const r2 = await seekTarget({ target: 'x' }, { loadPage: async () => { calls++; return { next: calls < 2 ? 'a' : null } }, has: () => false })
  t.alike(r2, { found: false, next: null, failed: false })
  t.is(calls, 2)

  const seen = new Set()
  let k = 0
  const r3 = await seekTarget({ target: 'x', cursor: 'start' }, { loadPage: async () => { if (++k === 2) seen.add('x'); return { next: 'p' + k } }, has: (r) => seen.has(r) })
  t.alike(r3, { found: true, next: 'p2', failed: false })

  let none = 0
  const r4 = await seekTarget({ target: 'x' }, { loadPage: async () => { none++ }, has: () => true })
  t.alike(r4, { found: true, next: null, failed: false })
  t.is(none, 0, 'already loaded: no page asked')

  const r5 = await seekTarget({ target: 'x', cursor: 'c9', maxPages: 2 }, { loadPage: async () => null, has: () => false })
  t.alike(r5, { found: false, next: 'c9', failed: true }, 'a failed page keeps its cursor')
})

test('seekTarget treats a throwing or missing has as not found', async (t) => {
  const { seekTarget } = await load()
  let pages = 0
  const r1 = await seekTarget({ target: 'x' }, { loadPage: async () => { pages++; return { next: null } }, has: () => { throw new Error('bad') } })
  t.alike(r1, { found: false, next: null, failed: false })
  t.is(pages, 1)
  const r2 = await seekTarget({ target: 'x' }, { loadPage: async () => ({ next: null }) })
  t.alike(r2, { found: false, next: null, failed: false })
})
