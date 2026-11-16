'use strict'

// Testimonial decisions synced between the member's devices
// (lib/testimonial-decision.js).
const test = require('brittle')
const { TESTIMONIAL_KEPT_MAX, TESTIMONIAL_DECLINED_MAX } = require('@varanda/rpc')
const {
  decisionId, normalizeDecisions, applyDecision, mergeDecisions, sameDecisions, readRefs, splitRows
} = require('../lib/testimonial-decision')

const U32_MAX = 4294967295
const key = (i) => i.toString(16).padStart(64, '0')
const A = key(1)
const B = key(2)
const C = key(3)
const flip = (list) => list.map((e) => ({ ...e, state: e.state === 'kept' ? 'declined' : 'kept' }))

test('caps are 64 kept and 64 declined', (t) => {
  t.is(TESTIMONIAL_KEPT_MAX, 64)
  t.is(TESTIMONIAL_DECLINED_MAX, 64)
})

test('the newer decision wins in any order', (t) => {
  const old = { from: A, seq: 1, state: 'kept', t: 100 }
  const late = { from: A, seq: 1, state: 'declined', t: 200 }
  t.alike(normalizeDecisions([old, late]), [late])
  t.alike(normalizeDecisions([late, old]), [late])
  t.alike(mergeDecisions([old], [late]), [late])
  t.alike(mergeDecisions([late], [old]), [late])
})

test('at equal times kept wins, in any order', (t) => {
  const kept = { from: A, seq: 1, state: 'kept', t: 100 }
  const declined = { from: A, seq: 1, state: 'declined', t: 100 }
  t.alike(normalizeDecisions([kept, declined]), [kept])
  t.alike(normalizeDecisions([declined, kept]), [kept])
})

test('stored data: invalid entries dropped, sorted oldest first by t, from, seq', (t) => {
  const out = normalizeDecisions([
    null, 1, 'x', [],
    { from: 'AB'.repeat(32), seq: 1, state: 'kept', t: 1 },
    { from: A, seq: 0, state: 'kept', t: 1 },
    { from: A, seq: U32_MAX + 1, state: 'kept', t: 1 },
    { from: A, seq: 1.5, state: 'kept', t: 1 },
    { from: A, seq: 1, state: 'hidden', t: 1 },
    { from: A, seq: 1, state: 'kept', t: -1 },
    { from: A, seq: 1, state: 'kept', t: U32_MAX + 1 },
    { from: B, seq: 2, state: 'kept', t: 5, extra: true },
    { from: A, seq: 9, state: 'declined', t: 5 },
    { from: A, seq: 3, state: 'kept', t: 5 },
    { from: C, seq: 1, state: 'kept', t: 0 }
  ])
  t.alike(out, [
    { from: C, seq: 1, state: 'kept', t: 0 },
    { from: A, seq: 3, state: 'kept', t: 5 },
    { from: A, seq: 9, state: 'declined', t: 5 },
    { from: B, seq: 2, state: 'kept', t: 5 }
  ])
  t.alike(normalizeDecisions(undefined), [])
  t.alike(normalizeDecisions({}), [])
})

test('merge is idempotent and commutative', (t) => {
  const a = [
    { from: A, seq: 1, state: 'kept', t: 10 },
    { from: B, seq: 1, state: 'declined', t: 20 }
  ]
  const b = [
    { from: A, seq: 1, state: 'declined', t: 15 },
    { from: C, seq: 4, state: 'kept', t: 5 }
  ]
  const ab = mergeDecisions(a, b)
  t.alike(ab, mergeDecisions(b, a))
  t.alike(mergeDecisions(ab, ab), ab)
  t.alike(mergeDecisions(ab, a), ab)
  t.alike(mergeDecisions(ab, b), ab)
  t.alike(ab, [
    { from: C, seq: 4, state: 'kept', t: 5 },
    { from: A, seq: 1, state: 'declined', t: 15 },
    { from: B, seq: 1, state: 'declined', t: 20 }
  ])
  t.alike(mergeDecisions(null, undefined), [])
})

test('caps: 65 kept keep the newest 64; kept and declined are capped apart', (t) => {
  const kept = Array.from({ length: 65 }, (_, i) => ({ from: A, seq: i + 1, state: 'kept', t: 100 + i }))
  const out = normalizeDecisions(kept)
  t.is(out.length, 64)
  t.absent(out.some((e) => e.seq === 1), 'the oldest kept is dropped')
  t.is(out[out.length - 1].seq, 65)

  const declined = Array.from({ length: 70 }, (_, i) => ({ from: B, seq: i + 1, state: 'declined', t: i }))
  const both = normalizeDecisions(kept.concat(declined))
  t.is(both.filter((e) => e.state === 'kept').length, TESTIMONIAL_KEPT_MAX)
  t.is(both.filter((e) => e.state === 'declined').length, TESTIMONIAL_DECLINED_MAX)
  t.absent(both.some((e) => e.from === B && e.seq <= 6), 'the six oldest declined are dropped')
  const few = normalizeDecisions(kept.concat(declined.slice(0, 3)))
  t.is(few.filter((e) => e.state === 'declined').length, 3, 'a full kept list does not push declined out')
})

test('applyDecision: records, same state again unchanged', (t) => {
  const r = applyDecision([], { from: A, seq: 2, state: 'kept' }, 100)
  t.ok(r.changed)
  t.alike(r.entries, [{ from: A, seq: 2, state: 'kept', t: 100 }])
  const again = applyDecision(r.entries, { from: A, seq: 2, state: 'kept' }, 500)
  t.absent(again.changed)
  t.alike(again.entries, r.entries, 'the first time stays')
  const other = applyDecision(r.entries, { from: A, seq: 2, state: 'declined' }, 200)
  t.ok(other.changed)
  t.alike(other.entries, [{ from: A, seq: 2, state: 'declined', t: 200 }])
})

test('applyDecision: a clock behind still wins, clamped to u32', (t) => {
  const kept = applyDecision([], { from: A, seq: 1, state: 'kept' }, 1000)
  const declined = applyDecision(kept.entries, { from: A, seq: 1, state: 'declined' }, 5)
  t.alike(declined.entries, [{ from: A, seq: 1, state: 'declined', t: 1001 }])
  const back = applyDecision(declined.entries, { from: A, seq: 1, state: 'kept' }, 5)
  t.alike(back.entries, [{ from: A, seq: 1, state: 'kept', t: 1002 }])

  const top = [{ from: A, seq: 1, state: 'kept', t: U32_MAX }]
  t.alike(applyDecision(top, { from: A, seq: 1, state: 'declined' }, 5).entries, [{ from: A, seq: 1, state: 'declined', t: U32_MAX }])
  t.alike(applyDecision([], { from: A, seq: 1, state: 'kept' }, U32_MAX + 10).entries, [{ from: A, seq: 1, state: 'kept', t: U32_MAX }])
})

test('applyDecision: ifNew records at t 0 only when nothing is held', (t) => {
  const migrated = applyDecision([], { from: A, seq: 1, state: 'declined' }, 1000, { ifNew: true })
  t.ok(migrated.changed)
  t.alike(migrated.entries, [{ from: A, seq: 1, state: 'declined', t: 0 }])
  const held = [{ from: A, seq: 1, state: 'kept', t: 50 }]
  const r = applyDecision(held, { from: A, seq: 1, state: 'declined' }, 1000, { ifNew: true })
  t.absent(r.changed)
  t.alike(r.entries, held)
  t.absent(applyDecision(migrated.entries, { from: A, seq: 1, state: 'kept' }, 1000, { ifNew: true }).changed)
  t.alike(mergeDecisions(migrated.entries, [{ from: A, seq: 1, state: 'kept', t: 1 }]), [{ from: A, seq: 1, state: 'kept', t: 1 }],
    'any decision made on purpose beats the migrated one')
  const later = applyDecision(migrated.entries, { from: A, seq: 1, state: 'kept' }, 0)
  t.alike(later.entries, [{ from: A, seq: 1, state: 'kept', t: 1 }], 'held t 0 still gets t + 1')
})

test('applyDecision: a clock behind a full list still records the decision', (t) => {
  const full = Array.from({ length: TESTIMONIAL_KEPT_MAX }, (_, i) => ({ from: B, seq: i + 1, state: 'kept', t: 5000 + i }))
  const r = applyDecision(full, { from: A, seq: 1, state: 'kept' }, 4000)
  t.ok(r.changed)
  t.is(r.entries.length, TESTIMONIAL_KEPT_MAX)
  t.alike(r.entries.find((e) => e.from === A), { from: A, seq: 1, state: 'kept', t: 5001 })
  t.absent(r.entries.some((e) => e.from === B && e.seq === 1), 'the oldest kept one drops')
  const flipped = applyDecision([{ from: A, seq: 1, state: 'declined', t: 10 }, ...full], { from: A, seq: 1, state: 'kept' }, 20)
  t.alike(flipped.entries.find((e) => e.from === A), { from: A, seq: 1, state: 'kept', t: 5001 })
})

test('merge at the caps is idempotent and commutative', (t) => {
  const side = (base, n) => Array.from({ length: n }, (_, i) => ({
    from: key(base + i), seq: 1 + (i % 3), state: i % 2 ? 'kept' : 'declined', t: 100 + ((i * 37) % 200)
  }))
  const a = side(10, 150)
  const b = side(90, 150).map((e, i) => (i % 5 === 0 ? { ...e, t: e.t + 1000 } : e))
  const ab = mergeDecisions(a, b)
  t.alike(ab, mergeDecisions(b, a))
  t.alike(mergeDecisions(ab, ab), ab)
  t.alike(mergeDecisions(ab, a), ab)
  t.alike(mergeDecisions(ab, b), ab)
  t.is(ab.filter((e) => e.state === 'kept').length, TESTIMONIAL_KEPT_MAX)
  t.is(ab.filter((e) => e.state === 'declined').length, TESTIMONIAL_DECLINED_MAX)
})

test('applyDecision: ifNew past a full declined list is dropped and reported unchanged', (t) => {
  const full = Array.from({ length: TESTIMONIAL_DECLINED_MAX }, (_, i) => ({ from: B, seq: i + 1, state: 'declined', t: 10 + i }))
  const r = applyDecision(full, { from: A, seq: 1, state: 'declined' }, 1000, { ifNew: true })
  t.absent(r.changed)
  t.alike(r.entries, normalizeDecisions(full))
})

test('applyDecision: invalid input changes nothing', (t) => {
  const list = [{ from: A, seq: 1, state: 'kept', t: 10 }]
  for (const d of [null, {}, { from: 'AB'.repeat(32), seq: 1, state: 'kept' }, { from: A, seq: 0, state: 'kept' },
    { from: A, seq: U32_MAX + 1, state: 'kept' }, { from: A, seq: 2, state: 'hidden' }]) {
    const r = applyDecision(list, d, 100)
    t.absent(r.changed)
    t.alike(r.entries, list)
  }
  for (const now of [-1, 1.5, NaN, '100', undefined]) t.absent(applyDecision(list, { from: B, seq: 1, state: 'kept' }, now).changed)
})

test('sameDecisions ignores time, not state', (t) => {
  const a = [{ from: A, seq: 1, state: 'kept', t: 10 }, { from: B, seq: 2, state: 'declined', t: 20 }]
  t.ok(sameDecisions(a, [{ from: B, seq: 2, state: 'declined', t: 5 }, { from: A, seq: 1, state: 'kept', t: 99 }]))
  t.absent(sameDecisions(a, flip(a)))
  t.absent(sameDecisions(a, a.slice(1)))
  t.ok(sameDecisions([], undefined))
})

test('readRefs: pointers then decided refs, shown excluded, deduped, never by state', (t) => {
  const pointers = [{ from: A, seq: 1 }, { from: A, seq: 2 }, { from: A, seq: 1 }, { from: B, seq: 0 }, null]
  const entries = [
    { from: A, seq: 2, state: 'kept', t: 1 },
    { from: B, seq: 5, state: 'declined', t: 2 },
    { from: C, seq: 7, state: 'kept', t: 3 }
  ]
  const shown = new Set([decisionId(C, 7)])
  const refs = readRefs(pointers, entries, shown)
  t.alike(refs, [{ from: A, seq: 1 }, { from: A, seq: 2 }, { from: B, seq: 5 }])
  t.alike(readRefs(pointers, flip(entries), shown), refs, 'flipping every state reads the same refs')
  t.alike(readRefs(pointers, entries, new Set()).length, 4)
  t.alike(readRefs(undefined, undefined, undefined), [])

  const many = Array.from({ length: 70 }, (_, i) => ({ from: A, seq: i + 1, state: 'kept', t: i }))
  const mixed = many.concat(Array.from({ length: 10 }, (_, i) => ({ from: B, seq: i + 1, state: 'declined', t: i })))
  t.alike(readRefs([], mixed, new Set()), readRefs([], flip(mixed), new Set()), 'no cap that depends on state')
})

test('splitRows: pending, kept newest decision first, declined dropped, maxes', (t) => {
  const row = (from, seq) => ({ from, seq, text: 'oi ' + seq, at: '2026-01-01T00:00:00.000Z' })
  const rows = [row(A, 1), row(A, 2), row(A, 3), row(B, 1), row(B, 2), row(C, 1), row(A, 1)]
  const pointerIds = new Set([decisionId(A, 1), decisionId(A, 2), decisionId(A, 3), decisionId(B, 2)])
  const entries = [
    { from: B, seq: 1, state: 'kept', t: 10 },
    { from: C, seq: 1, state: 'kept', t: 30 },
    { from: B, seq: 2, state: 'declined', t: 40 },
    { from: A, seq: 3, state: 'kept', t: 20 }
  ]
  const out = splitRows(rows, pointerIds, entries, { pendingMax: 64, keptMax: 64 })
  t.alike(out.items, [row(A, 1), row(A, 2)], 'pointed rows without a decision, in input order, once')
  t.alike(out.kept, [row(C, 1), row(A, 3), row(B, 1)], 'kept rows, newest decision first')
  t.absent(out.kept.concat(out.items).some((r) => r.from === B && r.seq === 2), 'declined dropped')

  const small = splitRows(rows, pointerIds, entries, { pendingMax: 1, keptMax: 2 })
  t.alike(small.items, [row(A, 1)])
  t.alike(small.kept, [row(C, 1), row(A, 3)])
  t.alike(splitRows(rows, new Set(), [], {}), { items: [], kept: [] }, 'a row nobody points to and nobody decided is not shown')
  t.alike(splitRows(null, null, null), { items: [], kept: [] })
})
