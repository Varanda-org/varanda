'use strict'

// lib/engagement-index.js roda(): from any reply, the thread root, the
// top-level comment under it and that comment's subtree flattened (parents
// before children) and paged, with every walk bounded by RODA_SCAN.
const test = require('brittle')
const { createEngagementIndex, RODA_PAGE, RODA_SCAN } = require('../lib/engagement-index')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const BASE_MS = Date.parse('2026-03-01T12:00:00.000Z')
const at = (i) => new Date(BASE_MS + i * 1000).toISOString()
const ref = (author, seq) => author + ':' + seq
const toRef = (r) => ({ author: r.slice(0, 64), seq: Number(r.slice(65)) })
const post = (i, replyTo = null) => ({ type: 'post', text: 'oi', at: at(i), ...(replyTo ? { replyTo: toRef(replyTo) } : {}) })
const NO_HINTS = { profileSeq: null, usernameSeq: null }

// Appends posts with a per-author seq counter and returns their refs.
function builder () {
  const ix = createEngagementIndex()
  const seqs = new Map()
  function add (author, i, replyTo = null) {
    const seq = (seqs.get(author) || 0) + 1
    seqs.set(author, seq)
    if (!ix.add(author, seq, post(i, replyTo))) throw new Error('add refused')
    return ref(author, seq)
  }
  return { ix, add }
}

// A root by A and a chain of `n` replies under it, alternating B and A.
function chain (n) {
  const { ix, add } = builder()
  const root = add(A, 0)
  const refs = []
  let parent = root
  for (let i = 1; i <= n; i++) {
    parent = add(i % 2 === 1 ? B : A, i, parent)
    refs.push(parent)
  }
  return { ix, add, root, refs }
}

test('roda: a 30-message alternating chain in one page, parents before children', (t) => {
  const { ix, root, refs } = chain(31)
  const [top, ...rest] = refs
  const page = ix.roda(refs.at(-1))
  t.alike(Object.keys(page), ['ref', 'root', 'top', 'items', 'next', 'total', 'truncated', 'authors'], 'exact shape')
  t.is(page.ref, refs.at(-1))
  t.is(page.root, root)
  t.is(page.top, top)
  t.is(rest.length, 30)
  t.alike(page.items, rest.map((r, i) => ({ ref: r, to: i === 0 ? top : rest[i - 1] })), 'chain order, each item names its parent')
  t.is(page.next, null)
  t.is(page.total, 30)
  t.is(page.truncated, false)
  t.alike(page.authors, { [A]: NO_HINTS, [B]: NO_HINTS })
  t.alike(ix.roda(top), { ...page, ref: top }, 'the top itself answers the same roda')
  t.alike(ix.roda(rest[10]).items, page.items, 'any member of the roda answers the same items')
})

test('roda: a 200-level chain still resolves root and top', (t) => {
  const { ix, root, refs } = chain(200)
  const page = ix.roda(refs.at(-1))
  t.is(page.root, root)
  t.is(page.top, refs[0])
  t.is(page.total, 199)
  t.is(page.items.length, RODA_PAGE)
  t.alike(page.items.map((x) => x.ref), refs.slice(1, 1 + RODA_PAGE))
})

test('roda: a child dated before its parent is listed after it', (t) => {
  const { ix, add } = builder()
  const root = add(A, 0)
  const top = add(B, 10, root)
  const c1 = add(A, 100, top)
  const g = add(C, 50, c1) // skewed clock: before its parent and before c2
  const c2 = add(C, 60, top)
  const page = ix.roda(g)
  t.alike(page.items, [{ ref: c2, to: top }, { ref: c1, to: top }, { ref: g, to: c1 }])
  t.alike(Object.keys(page.authors).sort(), [A, B, C], 'hints for the asked, root, top and listed authors')
})

test('roda: 120 descendants in 3 pages without duplicates or gaps, also after the cursor item is deleted', (t) => {
  function build () {
    const { ix, add } = builder()
    const root = add(A, 0)
    const top = add(B, 1, root)
    const order = []
    for (let k = 0; k < 60; k++) {
      const child = add(k % 2 ? A : C, 10 + 3 * k, top)
      const leaf = add(k % 2 ? C : A, 11 + 3 * k, child)
      order.push({ ref: child, to: top }, { ref: leaf, to: child })
    }
    return { ix, top, order }
  }
  const { ix, top, order } = build()
  const p1 = ix.roda(top)
  const p2 = ix.roda(top, p1.next)
  const p3 = ix.roda(top, p2.next)
  t.is(p1.total, 120)
  t.is(p1.items.length, RODA_PAGE)
  t.is(p2.items.length, RODA_PAGE)
  t.is(p3.items.length, 20)
  t.ok(p1.next !== null && p2.next !== null)
  t.is(p3.next, null, 'exhausted')
  const all = [...p1.items, ...p2.items, ...p3.items]
  t.alike(all, order)
  t.is(new Set(all.map((x) => x.ref)).size, 120, 'no duplicate')
  const seen = new Set([top])
  t.ok(all.every((x) => { const ok = seen.has(x.to); seen.add(x.ref); return ok }), 'every parent listed before its children')

  const other = build()
  const q1 = other.ix.roda(other.top)
  t.alike(q1.items, p1.items)
  const cursorItem = q1.items.at(-1)
  t.ok(other.ix.removePost(cursorItem.ref.slice(0, 64), Number(cursorItem.ref.slice(65))))
  const q2 = other.ix.roda(other.top, q1.next)
  const q3 = other.ix.roda(other.top, q2.next)
  t.alike(q2.items, p2.items, 'the page after a deleted cursor item is unchanged')
  t.alike(q3.items, p3.items)
  t.is(q3.next, null)
  t.is(q2.total, 119)
})

test('roda: a two-diary replyTo cycle and a self reply terminate with null', (t) => {
  // Refs are predictable, so A can reply to B's future post and B to A's.
  const ix = createEngagementIndex()
  t.ok(ix.add(A, 1, post(1, ref(B, 1))))
  t.ok(ix.add(B, 1, post(2, ref(A, 1))))
  t.ok(ix.add(C, 1, post(3, ref(A, 1))))
  t.ok(ix.add(C, 2, post(4, ref(C, 2))))
  let calls = 0
  t.is(ix.roda(ref(A, 1), null, () => { calls++; return true }), null)
  t.ok(calls <= 3, 'the cycle is caught by the visited set, not by the hop bound')
  t.is(ix.roda(ref(B, 1)), null)
  t.is(ix.roda(ref(C, 1)), null, 'a reply hanging off a cycle')
  t.is(ix.roda(ref(C, 2)), null, 'a post replying to itself')
  t.is(ix.post(ref(A, 1)).parent, ref(B, 1), 'post() still answers')
})

test('roda: the walk up stops at RODA_SCAN hops', (t) => {
  const { ix, add, root, refs } = chain(RODA_SCAN)
  const deepest = ix.roda(refs.at(-1))
  t.is(deepest.root, root, 'exactly RODA_SCAN hops resolves')
  t.is(deepest.top, refs[0])
  add(B, RODA_SCAN + 1, refs.at(-1))
  t.is(ix.roda(ref(B, (RODA_SCAN + 2) / 2)), null, 'one hop more answers null')
})

test('roda: a deleted intermediate gives null below it and leaves the top list', (t) => {
  const { ix, root, refs } = chain(5)
  const [top, mid, , , leaf] = refs
  t.is(ix.roda(top).total, 4)
  t.ok(ix.removePost(mid.slice(0, 64), Number(mid.slice(65))))
  t.is(ix.roda(leaf), null)
  t.is(ix.roda(refs[2]), null)
  t.is(ix.roda(mid), null)
  const page = ix.roda(top)
  t.is(page.root, root)
  t.alike(page.items, [])
  t.is(page.total, 0)
  t.ok(ix.removePost(root.slice(0, 64), Number(root.slice(65))))
  t.is(ix.roda(top), null, 'a deleted root as well')
})

test('roda: a hidden author is skipped with its subtree, and on the walk up answers null', (t) => {
  const { ix, add } = builder()
  const root = add(A, 0)
  const top = add(A, 1, root)
  const hidden = add(B, 2, top)
  const below = add(A, 3, hidden)
  const shown = add(C, 4, top)
  const visible = (hex) => hex !== B
  const page = ix.roda(top, null, visible)
  t.alike(page.items, [{ ref: shown, to: top }])
  t.is(page.total, 1)
  t.absent(B in page.authors)
  t.is(ix.roda(below, null, visible), null)
  t.is(ix.roda(hidden, null, visible), null)
  t.is(ix.roda(shown, null, (hex) => hex !== A), null, 'a hidden top or root')
  t.is(ix.roda(top).total, 3, 'everyone visible by default')
})

test('roda: more than RODA_SCAN edges below the top answers truncated', (t) => {
  const { ix, add } = builder()
  const root = add(A, 0)
  const top = add(A, 1, root)
  for (let i = 0; i < RODA_SCAN; i++) add(B, 2 + i, top)
  const full = ix.roda(top)
  t.is(full.total, RODA_SCAN)
  t.is(full.truncated, false, 'exactly RODA_SCAN edges are all examined')
  add(C, 5000, top)
  const cut = ix.roda(top)
  t.is(cut.truncated, true)
  t.is(cut.total, RODA_SCAN)
  t.absent(cut.items.some((x) => x.ref.startsWith(C)), 'the unexamined edge is absent')
})

test('roda: null for a root, a non-reply, a malformed ref or cursor', (t) => {
  const { ix, root, refs } = chain(3)
  t.ok(ix.add(C, 1, { type: 'post', text: 'q', at: at(9), quote: toRef(root) }))
  t.is(ix.roda(root), null, 'a root')
  t.is(ix.roda(ref(C, 1)), null, 'a quote is not a reply')
  t.is(ix.roda(ref(A, 99)), null, 'not indexed')
  t.is(ix.roda(ref('d'.repeat(64), 1)), null, 'unknown author')
  for (const bad of [null, undefined, 7, {}, '', 'x', A, A + ':0', A + ':-1', A.toUpperCase() + ':1', A + ':1.5']) {
    t.is(ix.roda(bad), null)
  }
  for (const bad of ['bad', 7, {}, '1.' + A, '1.' + A + '.0', '99999999999999999.' + A + '.1', '1.' + A + '.1.']) {
    t.is(ix.roda(refs[0], bad), null, 'malformed cursor ' + String(bad))
  }
  t.is(ix.roda(refs[0], undefined).total, 2, 'an absent cursor is the first page')
  t.is(ix.roda(refs[0], null, () => { throw new Error('boom') }), null, 'a throwing predicate answers null')
  t.is(ix.roda(refs[0], null, 'nope').total, 2, 'a non-function predicate means every author')
})

test('roda: visible() runs at most 2 * RODA_SCAN + 3 times per call', (t) => {
  const { ix, add, refs } = chain(RODA_SCAN)
  for (let i = 0; i < 500; i++) add(C, RODA_SCAN + 1 + i, refs[0])
  let calls = 0
  const counting = () => { calls++; return true }
  const page = ix.roda(refs.at(-1), null, counting)
  t.ok(page !== null)
  t.is(page.truncated, true)
  t.ok(calls > RODA_SCAN, 'both walks consulted the predicate')
  t.ok(calls <= 2 * RODA_SCAN + 3, calls + ' calls')
  calls = 0
  add(B, 9999, refs.at(-1))
  t.is(ix.roda(ref(B, (RODA_SCAN + 2) / 2), null, counting), null)
  t.ok(calls <= 2 * RODA_SCAN + 3, calls + ' calls on a walk past the bound')
})
