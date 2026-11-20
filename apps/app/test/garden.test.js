'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')

const NOW = Date.UTC(2026, 10, 16, 15, 0, 0)
const H = 3600000
const iso = (ms) => new Date(ms).toISOString()
const OWNER = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)
const DAVE = 'd'.repeat(64)

const flag = (on = true, at = NOW - 10 * H) => ({ type: 'garden', on, at: iso(at) })
const pot = (plant, atMs, waterMs = atMs, w = 0) => ({ plant, at: iso(atMs), water: iso(waterMs), w })
const state = (pots, at = NOW - H) => ({ type: 'garden-state', pots, n: 1, at: iso(at) })
const help = (to, potIx, at) => ({ type: 'garden-help', to, pot: potIx, at: iso(at) })
const follow = (key, on = true, at = NOW - 20 * H) => ({ type: 'follow', key, on, at: iso(at) })
const peek = (key, entries, extra = {}) => ({ key, length: 99, entries, invalid: [], missing: [], ...extra })
const e = (seq, record) => ({ seq, record })
const nulls = () => new Array(6).fill(null)
const potsWith = (ix, p) => { const a = nulls(); a[ix] = p; return a }

// One manjericao in pot 0, planted 2 h ago: ripe in 6 h without help.
const PLANTED = NOW - 2 * H
const ownerPots = () => potsWith(0, pot('manjericao', PLANTED))
const baseIndex = (extra = {}) => ({ on: 3, state: 4, helps: [], given: [], indexing: false, complete: true, ...extra })
const ownerRead = (extra = []) => [peek(OWNER, [e(1, { type: 'profile' }), e(3, flag()), e(4, state(ownerPots())), ...extra])]
const helperRead = (author, seq, record, followSeq, followRecord, extra = {}) => peek(author, [e(followSeq, followRecord), e(seq, record)].sort((a, b) => a.seq - b.seq), extra)
const helpRow = (author, seq = 12, followSeq = 5) => ({ author, seq, followSeq })

test('planPeeks sorts given newest first and a follow before its help', async (t) => {
  const { planPeeks } = await import('../src/garden.js')
  const plan = planPeeks({
    owner: OWNER,
    index: baseIndex({ given: [30, 20, 10], helps: [helpRow(BOB, 12, 5), helpRow(CAROL, 7, 9)] }),
    isBlocked: () => false
  })
  t.alike(plan.owner, [{ author: OWNER, seqs: [1, 2, 3, 4, 10, 20, 30] }])
  t.alike(plan.helpers.map((h) => [h.author, h.batches[0].seqs]), [[BOB, [5, 12]], [CAROL, [7, 9]]])
  t.alike(plan.helpers[0].rows, [helpRow(BOB, 12, 5)])
  t.alike(plan.helpers[0].batches, [{ author: BOB, seqs: [5, 12] }])
})

test('planPeeks gives one entry per author with every row, and the balcony counts both helps', async (t) => {
  const { planPeeks, assembleBalcony } = await import('../src/garden.js')
  const rows = [helpRow(BOB, 12, 5), helpRow(BOB, 9, 5), helpRow(BOB, 15, 8)]
  const plan = planPeeks({ owner: OWNER, index: baseIndex({ helps: rows }) })
  t.is(plan.helpers.length, 1)
  t.is(plan.helpers[0].author, BOB)
  t.alike(plan.helpers[0].batches, [{ author: BOB, seqs: [5, 8, 9, 12, 15] }])
  t.is(plan.helpers[0].rows.length, 3)
  const follow = (seq) => e(seq, { type: 'follow' })
  const answer = peek(BOB, [follow(5), follow(8), e(9, { type: 'x' }), e(12, { type: 'x' })])
  const one = assembleBalcony({ owner: OWNER, index: baseIndex({ helps: rows }), ownerReads: ownerRead(), helperReads: new Map([[BOB, answer]]), now: NOW })
  const two = assembleBalcony({ owner: OWNER, index: baseIndex({ helps: rows }), ownerReads: ownerRead(), helperReads: new Map([[BOB, [answer, peek(BOB, [])]]]), now: NOW })
  t.alike(two.helpers, one.helpers)
  t.is(one.loading, false)
  t.is(one.incomplete, true, 'seq 15 was not in the answer')
})

test('assembleBalcony reads a bad now as an unfinished read', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  for (const now of [undefined, Number.NaN, new Date(NOW), String(NOW)]) {
    const r = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: ownerRead(), helperReads: new Map(), now })
    t.is(r.incomplete, true)
    t.is(r.on, false)
  }
})

test('assembleBalcony reads a missing or non-boolean complete as incomplete', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  for (const complete of [undefined, 'true', 1, null]) {
    const r = assembleBalcony({ owner: OWNER, index: baseIndex({ complete }), ownerReads: ownerRead(), helperReads: new Map(), now: NOW })
    t.is(r.incomplete, true)
  }
})

test('planPeeks keeps a full owner plan inside one peek, ascending', async (t) => {
  const { planPeeks } = await import('../src/garden.js')
  // At the route caps the owner plan is 1, 2, the flag, the state and 24 given
  // seqs: 28, under the peek limit of 29, so it is one batch.
  const given = Array.from({ length: 24 }, (_, i) => 100 - i)
  const plan = planPeeks({ owner: OWNER, index: baseIndex({ given, on: 50, state: 60 }) })
  t.is(plan.owner.length, 1)
  const all = plan.owner.flatMap((b) => b.seqs)
  t.alike(all, [...all].sort((a, b) => a - b))
  t.is(new Set(all).size, all.length)
  t.is(all.length, 28)
  const over = planPeeks({ owner: OWNER, index: baseIndex({ given: [...given, 70, 71], on: 50, state: 60 }) })
  t.alike(over.owner, [{ author: OWNER, seqs: [1, 2] }])
})

test('planPeeks plans no peek for a blocked helper or a row naming the owner', async (t) => {
  const { planPeeks } = await import('../src/garden.js')
  const plan = planPeeks({
    owner: OWNER,
    index: baseIndex({ helps: [helpRow(BOB), helpRow(OWNER, 8, 6), helpRow(CAROL)] }),
    isBlocked: (k) => k === BOB
  })
  t.alike(plan.helpers.map((h) => h.author), [CAROL])
  const boom = planPeeks({ owner: OWNER, index: baseIndex({ helps: [helpRow(BOB)] }), isBlocked: () => { throw new Error('x') } })
  t.alike(boom.helpers, [], 'a throwing block check drops the helper')
})

test('planPeeks plans only the first two blocks for a malformed index', async (t) => {
  const { planPeeks } = await import('../src/garden.js')
  for (const index of [null, undefined, 'x', 7, [], {}, { on: 'a', state: 1, helps: [], given: [] }, baseIndex({ helps: [{ author: 'nope', seq: 1, followSeq: 2 }] }), baseIndex({ given: [0] })]) {
    t.alike(planPeeks({ owner: OWNER, index }), { owner: [{ author: OWNER, seqs: [1, 2] }], helpers: [] })
  }
  t.alike(planPeeks({ owner: 'bad', index: baseIndex() }), { owner: [], helpers: [] })
  t.alike(planPeeks(), { owner: [], helpers: [] })
})

test('assembleBalcony draws the owner balcony with zero boosts before any helper read', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const r = assembleBalcony({ owner: OWNER, index: baseIndex({ helps: [helpRow(BOB)] }), ownerReads: ownerRead(), helperReads: new Map(), now: NOW })
  t.is(r.on, true)
  t.is(r.loading, true)
  t.is(r.incomplete, false)
  t.is(r.refetch, false)
  t.is(r.isPage, false)
  t.is(r.pots[0].plant, 'manjericao')
  t.is(r.pots[0].ripeAt, PLANTED + 6 * H)
  t.alike(r.pots.slice(1), [null, null, null, null, null])
  t.alike(r.helpers, [])
})

test('assembleBalcony boosts pots after a valid helper read', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const helps = [helpRow(BOB, 12, 5)]
  const reads = new Map([[BOB, helperRead(BOB, 12, help(OWNER, 0, NOW - H), 5, follow(OWNER))]])
  const r = assembleBalcony({ owner: OWNER, index: baseIndex({ helps }), ownerReads: ownerRead(), helperReads: reads, now: NOW })
  t.is(r.loading, false)
  t.is(r.incomplete, false)
  t.is(r.pots[0].ripeAt, PLANTED + 4 * H, 'one neighbour water shortens the wait by 2 h')
  t.alike(r.helpers, [{ author: BOB, seq: 12, pot: 0, at: iso(NOW - H) }])
})

test('assembleBalcony never counts forged helper pointers', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const good = help(OWNER, 0, NOW - H)
  const cases = {
    'wrong type': [help(OWNER, 0, NOW - H), follow(OWNER)].map((r, i) => i === 0 ? { ...r, type: 'like' } : r),
    'help to another owner': [help(CAROL, 0, NOW - H), follow(OWNER)],
    'no follow evidence': [good, undefined],
    'follow of someone else': [good, follow(CAROL)],
    'follow switched off': [good, follow(OWNER, false)],
    'help before the pot was planted': [help(OWNER, 0, PLANTED - H), follow(OWNER)]
  }
  for (const [name, [record, followRecord]] of Object.entries(cases)) {
    const entries = [e(5, followRecord), e(12, record)].filter((x) => x.record !== undefined)
    const reads = new Map([[BOB, peek(BOB, entries)]])
    const r = assembleBalcony({ owner: OWNER, index: baseIndex({ helps: [helpRow(BOB)] }), ownerReads: ownerRead(), helperReads: reads, now: NOW })
    t.is(r.pots[0].ripeAt, PLANTED + 6 * H, name + ': no boost')
    t.alike(r.helpers, [], name + ': not listed')
  }
  // tombstoned (deleted) or missing block: the seq comes back missing
  const missing = new Map([[BOB, peek(BOB, [e(5, follow(OWNER))], { missing: [12] })]])
  const m = assembleBalcony({ owner: OWNER, index: baseIndex({ helps: [helpRow(BOB)] }), ownerReads: ownerRead(), helperReads: missing, now: NOW })
  t.is(m.pots[0].ripeAt, PLANTED + 6 * H)
  t.is(m.incomplete, true)
  const invalid = new Map([[BOB, peek(BOB, [e(5, follow(OWNER)), e(12, good)], { invalid: [12] })]])
  const v = assembleBalcony({ owner: OWNER, index: baseIndex({ helps: [helpRow(BOB)] }), ownerReads: ownerRead(), helperReads: invalid, now: NOW })
  t.alike(v.helpers, [], 'an invalid seq is unread even when an entry came along')
  t.is(v.incomplete, true)
})

test('assembleBalcony counts a duplicate row once and lists a helper once', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const row = helpRow(BOB, 12, 5)
  const reads = new Map([[BOB, helperRead(BOB, 12, help(OWNER, 0, NOW - H), 5, follow(OWNER))]])
  const r = assembleBalcony({ owner: OWNER, index: baseIndex({ helps: [row, { ...row }] }), ownerReads: ownerRead(), helperReads: reads, now: NOW })
  t.is(r.pots[0].ripeAt, PLANTED + 4 * H)
  t.is(r.helpers.length, 1)
  // two blocks of the same helper on the same day: only one counts
  const two = new Map([[BOB, peek(BOB, [e(5, follow(OWNER)), e(12, help(OWNER, 0, NOW - H)), e(13, help(OWNER, 0, NOW - 2 * H))])]])
  const r2 = assembleBalcony({ owner: OWNER, index: baseIndex({ helps: [helpRow(BOB, 12, 5), helpRow(BOB, 13, 5)] }), ownerReads: ownerRead(), helperReads: two, now: NOW })
  t.is(r2.pots[0].ripeAt, PLANTED + 4 * H)
  t.is(r2.helpers.length, 1)
})

test('assembleBalcony does not list a blocked helper', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const index = baseIndex({ helps: [helpRow(BOB, 12, 5), helpRow(CAROL, 12, 5)] })
  const reads = new Map([
    [BOB, helperRead(BOB, 12, help(OWNER, 0, NOW - H), 5, follow(OWNER))],
    [CAROL, helperRead(CAROL, 12, help(OWNER, 0, NOW - H), 5, follow(OWNER))]
  ])
  const r = assembleBalcony({ owner: OWNER, index, ownerReads: ownerRead(), helperReads: reads, now: NOW, isBlocked: (k) => k === BOB })
  t.alike(r.helpers.map((h) => h.author), [CAROL])
  t.is(r.loading, false, 'a blocked helper is never waited for')
  t.is(r.pots[0].ripeAt, PLANTED + 4 * H)
})

test('assembleBalcony shows nothing for a page', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const roster = { type: 'page-roster', page: OWNER }
  for (const seq of [1, 2]) {
    const r = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: [peek(OWNER, [e(seq, roster), e(3, flag()), e(4, state(ownerPots()))])], helperReads: new Map(), now: NOW })
    t.is(r.isPage, true)
    t.is(r.on, false)
    t.alike(r.pots, nulls())
    t.is(r.refetch, false)
  }
})

test('assembleBalcony reads an off flag as off, with no pots', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const reads = [peek(OWNER, [e(1, { type: 'profile' }), e(3, flag(false)), e(4, state(ownerPots()))])]
  const r = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: reads, helperReads: new Map(), now: NOW })
  t.is(r.on, false)
  t.alike(r.pots, nulls())
  t.is(r.refetch, false)
  const none = assembleBalcony({ owner: OWNER, index: baseIndex({ on: null, state: null }), ownerReads: [peek(OWNER, [e(1, { type: 'profile' })])], helperReads: new Map(), now: NOW })
  t.is(none.on, false)
  t.is(none.refetch, false)
})

test('assembleBalcony marks an incomplete answer and a missing given block', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const a = assembleBalcony({ owner: OWNER, index: baseIndex({ complete: false }), ownerReads: ownerRead(), helperReads: new Map(), now: NOW })
  t.is(a.incomplete, true)
  t.is(a.on, true)
  const b = assembleBalcony({ owner: OWNER, index: baseIndex({ given: [9] }), ownerReads: ownerRead(), helperReads: new Map(), now: NOW })
  t.is(b.incomplete, true, 'given block not read')
  const c = assembleBalcony({ owner: OWNER, index: baseIndex({ given: [9] }), ownerReads: ownerRead([e(9, flag())]), helperReads: new Map(), now: NOW })
  t.is(c.incomplete, true, 'given block of another type')
  const d = assembleBalcony({ owner: OWNER, index: baseIndex({ given: [9] }), ownerReads: ownerRead([e(9, help(DAVE, 1, NOW - H))]), helperReads: new Map(), now: NOW })
  t.is(d.incomplete, false)
  const f = assembleBalcony({ owner: OWNER, index: baseIndex({ indexing: true }), ownerReads: ownerRead(), helperReads: new Map(), now: NOW })
  t.is(f.indexing, true)
})

test('assembleBalcony boosts the own pots with the own given helps', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const r = assembleBalcony({ owner: OWNER, index: baseIndex({ given: [9] }), ownerReads: ownerRead([e(9, help(DAVE, 1, NOW - H))]), helperReads: new Map(), now: NOW })
  t.is(r.pots[0].ripeAt, PLANTED + 6 * H - 0.5 * H)
})

test('assembleBalcony asks for a refetch when a pointer is stale', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const missing = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: [peek(OWNER, [e(3, flag())], { missing: [4] })], helperReads: new Map(), now: NOW })
  t.is(missing.refetch, true)
  t.is(missing.on, true)
  t.alike(missing.pots, nulls())
  const wrongType = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: [peek(OWNER, [e(3, flag()), e(4, flag())])], helperReads: new Map(), now: NOW })
  t.is(wrongType.refetch, true)
  const wrongFlag = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: [peek(OWNER, [e(3, state(nulls())), e(4, state(nulls()))])], helperReads: new Map(), now: NOW })
  t.is(wrongFlag.refetch, true)
  t.is(wrongFlag.on, false)
  const invalid = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: [peek(OWNER, [e(3, flag())], { invalid: [4] })], helperReads: new Map(), now: NOW })
  t.is(invalid.refetch, true)
})

test('assembleBalcony merges the owner batches and never throws on hostile input', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const reads = [peek(OWNER, [e(3, flag())]), peek(OWNER, [e(4, state(ownerPots()))])]
  const r = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: reads, helperReads: new Map(), now: NOW })
  t.is(r.on, true)
  t.is(r.refetch, false)
  for (const bad of [undefined, null, 7, 'x', [], {}, { owner: OWNER }, { owner: OWNER, index: {}, ownerReads: 5 }, { owner: OWNER, index: baseIndex(), ownerReads: [null, 3, { key: OWNER, entries: 'x', invalid: 4 }], helperReads: 'x', now: 'later' }]) {
    const out = assembleBalcony(bad)
    t.is(out.on, false)
    t.is(out.pots.length, 6)
  }
  const odd = assembleBalcony({ owner: OWNER, index: baseIndex({ helps: [helpRow(BOB)] }), ownerReads: ownerRead(), helperReads: new Map([[BOB, 'junk']]), now: NOW })
  t.alike(odd.helpers, [])
  t.is(odd.incomplete, true)
})

test('nextLoadStep refetches once, then marks incomplete', async (t) => {
  const { assembleBalcony, nextLoadStep } = await import('../src/garden.js')
  const stale = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: [peek(OWNER, [e(3, flag())], { missing: [4] })], helperReads: new Map(), now: NOW })
  t.is(nextLoadStep({ attempt: 0, result: stale }), 'refetch')
  t.is(nextLoadStep({ attempt: 1, result: stale }), 'incomplete')
  t.is(nextLoadStep({ attempt: 2, result: stale }), 'incomplete')
  const fine = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: ownerRead(), helperReads: new Map(), now: NOW })
  t.is(nextLoadStep({ attempt: 0, result: fine }), 'done')
  t.is(nextLoadStep({}), 'done')
  t.is(nextLoadStep(), 'done')
})

test('flagOn is true only for a live on flag at that seq', async (t) => {
  const { flagOn } = await import('../src/garden.js')
  t.is(flagOn([e(3, flag(true))], 3), true)
  t.is(flagOn([e(3, flag(false))], 3), false)
  t.is(flagOn([], 3), false)
  t.is(flagOn([e(2, flag(true))], 3), false, 'wrong seq')
  t.is(flagOn([e(3, state(nulls()))], 3), false, 'wrong type')
  t.is(flagOn([e(3, { type: 'garden', on: 'yes', at: iso(NOW) })], 3), false)
  for (const bad of [null, undefined, 'x', 5, {}, [null], [{}], [{ seq: 3 }], [{ seq: 3, record: null }]]) t.is(flagOn(bad, 3), false)
  t.is(flagOn([e(3, flag(true))], 'x'), false)
  t.is(flagOn([e(3, flag(true))], null), false)
})

const sweepBase = () => [
  nulls(),
  potsWith(0, pot('manjericao', NOW - 3 * H)),
  potsWith(2, pot('pimenta', NOW - 9 * H, NOW - 4 * H, 2)),
  potsWith(1, pot('manjericao', NOW - 7 * H))
]
const sweepActs = [
  { op: 'plant', pot: 0, plant: 'manjericao' },
  { op: 'plant', pot: 5, plant: 'espada' },
  { op: 'water', pot: 0 },
  { op: 'water', pot: 2 },
  { op: 'harvest', pot: 1 },
  { op: 'clear', pot: 0 },
  { op: 'clear', pot: 3 }
]

test('the pending reducer agrees with applyActs under the same counts', async (t) => {
  const { pendingStart, queue } = await import('../src/garden.js')
  const counts = [undefined, { received: [1, 1, 0, 0, 0, 0], given: [0, 0, 0, 0, 0, 0] }, { received: [0, 0, 3, 0, 0, 0], given: [3, 3, 3, 0, 0, 0] }]
  let checked = 0
  for (const base of sweepBase()) {
    for (const c of counts) {
      for (const act of sweepActs) {
        for (const prior of [[], [{ op: 'clear', pot: 4 }], [{ op: 'plant', pot: 3, plant: 'tomate' }]]) {
          let p = pendingStart(base)
          for (const a of prior) p = queue(p, a, NOW, c)
          const expected = rpc.garden.applyActs({ pots: base }, [...p.acts, act], NOW, c)
          const next = queue(p, act, NOW, c)
          checked++
          if (expected.ok) {
            t.alike(next.acts, [...p.acts, act])
            t.alike(next.pots, expected.state.pots)
            t.is(next.refused, null)
          } else {
            t.alike(next.acts, p.acts, 'a bad act is not kept')
            t.alike(next.pots, p.pots)
            t.is(next.refused, expected.reason)
          }
          t.alike(next.base, base)
        }
      }
    }
  }
  t.ok(checked >= 200)
})

test('the pending reducer handles plant, water at hour 3, harvest and clear', async (t) => {
  const { pendingStart, queue, pendingCount } = await import('../src/garden.js')
  let p = pendingStart(potsWith(0, pot('manjericao', NOW - 3 * H)))
  p = queue(p, { op: 'water', pot: 0 }, NOW)
  t.is(p.refused, null)
  t.is(p.pots[0].w, 1)
  t.is(p.pots[0].water, iso(NOW))
  p = queue(p, { op: 'plant', pot: 1, plant: 'tomate' }, NOW)
  t.is(p.pots[1].plant, 'tomate')
  p = queue(p, { op: 'clear', pot: 1 }, NOW)
  t.is(p.pots[1], null)
  t.is(pendingCount(p), 3)
  // harvest: not ripe alone, ripe with two neighbour waters counted
  const ripe = pendingStart(potsWith(0, pot('manjericao', NOW - 5 * H)))
  t.is(queue(ripe, { op: 'harvest', pot: 0 }, NOW).refused, 'not-ripe')
  const harvested = queue(ripe, { op: 'harvest', pot: 0 }, NOW, { received: [1, 0, 0, 0, 0, 0], given: [0, 0, 0, 0, 0, 0] })
  t.is(harvested.refused, null)
  t.is(harvested.pots[0], null)
})

test('a water queued at t and another at t + 3 h are judged together at the later now', async (t) => {
  const { pendingStart, queue, revalidate } = await import('../src/garden.js')
  const base = potsWith(0, pot('alecrim', NOW - 3 * H))
  const first = queue(pendingStart(base), { op: 'water', pot: 0 }, NOW)
  t.is(first.refused, null)
  const later = NOW + 3 * H
  const second = queue(first, { op: 'water', pot: 0 }, later)
  t.is(second.refused, 'not-dry', 'the node applies both at one instant, so the second is not dry')
  t.is(second.acts.length, 1)
  t.alike(second.pots, first.pots)
  // revalidate at a later now judges the whole list at that now
  const again = revalidate(first, later)
  t.is(again.refused, null)
  t.is(again.pots[0].water, iso(later))
  const stale = revalidate(pendingStart(potsWith(0, pot('alecrim', NOW - 3 * H, NOW - H))), NOW)
  t.is(stale.refused, null, 'an empty list always revalidates')
  const dry = queue(pendingStart(potsWith(0, pot('alecrim', NOW - 3 * H, NOW - H))), { op: 'water', pot: 0 }, NOW)
  t.is(dry.refused, 'not-dry')
  const old = { ...first, base: potsWith(0, pot('alecrim', NOW - 4 * H, NOW - 4 * H)) }
  t.is(revalidate(old, NOW - 2 * H).refused, 'not-dry', 'at an earlier now the pot is no longer dry')
  t.is(revalidate(old, NOW - 2 * H).acts.length, 0)
})

test('revalidate keeps the longest prefix of acts that still applies', async (t) => {
  const { pendingStart, queue, revalidate } = await import('../src/garden.js')
  let p = pendingStart(potsWith(0, pot('alecrim', NOW - 4 * H, NOW - 4 * H)))
  p = queue(p, { op: 'plant', pot: 1, plant: 'tomate' }, NOW)
  p = queue(p, { op: 'plant', pot: 2, plant: 'pimenta' }, NOW)
  p = queue(p, { op: 'water', pot: 0 }, NOW)
  t.is(p.acts.length, 3)
  const r = revalidate(p, NOW - 2 * H)
  t.is(r.refused, 'not-dry')
  t.is(r.acts.length, 2)
  t.is(r.pots[1].plant, 'tomate')
  t.is(r.pots[2].plant, 'pimenta')
  t.is(r.pots[0].water, p.base[0].water, 'the refused water is not in the preview')
})

test('a bad act leaves the pending state unchanged with refused set', async (t) => {
  const { pendingStart, queue } = await import('../src/garden.js')
  const p = pendingStart(nulls())
  for (const [act, reason] of [[{ op: 'water', pot: 0 }, 'empty'], [{ op: 'harvest', pot: 2 }, 'empty'], [{ op: 'plant', pot: 9, plant: 'tomate' }, 'acts'], [{ op: 'plant', pot: 0, plant: 'rosa' }, 'acts'], [null, 'acts']]) {
    const r = queue(p, act, NOW)
    t.is(r.refused, reason)
    t.alike(r.acts, [])
    t.alike(r.pots, nulls())
  }
  const planted = queue(p, { op: 'plant', pot: 0, plant: 'tomate' }, NOW)
  t.is(planted.refused, null)
  const occupied = queue(planted, { op: 'plant', pot: 0, plant: 'tomate' }, NOW)
  t.is(occupied.refused, 'occupied')
  t.is(occupied.acts.length, 1)
  t.is(queue(null, { op: 'clear', pot: 0 }, NOW).refused, 'invalid', 'a hostile pending state never throws')
  t.is(queue(p, { op: 'clear', pot: 0 }, NaN).refused, 'invalid')
})

test('more than 24 acts are refused', async (t) => {
  const { pendingStart, queue, pendingCount } = await import('../src/garden.js')
  let p = pendingStart(nulls())
  for (let i = 0; i < rpc.garden.GARDEN_ACTS_MAX; i++) p = queue(p, i % 2 === 0 ? { op: 'plant', pot: 0, plant: 'tomate' } : { op: 'clear', pot: 0 }, NOW)
  t.is(p.refused, null)
  t.is(pendingCount(p), 24)
  const over = queue(p, { op: 'plant', pot: 0, plant: 'tomate' }, NOW)
  t.is(over.refused, 'acts')
  t.is(pendingCount(over), 24)
})

test('discard returns to the base and a bad base becomes six empty pots', async (t) => {
  const { pendingStart, queue, discard, pendingCount } = await import('../src/garden.js')
  const base = potsWith(0, pot('manjericao', NOW - 3 * H))
  let p = pendingStart(base)
  p = queue(p, { op: 'water', pot: 0 }, NOW)
  t.is(pendingCount(p), 1)
  const d = discard(p)
  t.alike(d, { base, acts: [], pots: base, refused: null })
  t.is(pendingCount(d), 0)
  t.alike(pendingStart(null).pots, nulls())
  t.alike(pendingStart([null]).pots, nulls())
  t.alike(discard(null).pots, nulls())
  t.is(pendingCount(null), 0)
})

test('the Varandinha consent sheet opens off and starts only when on', async (t) => {
  const { initialConsent, openConsent, toggleConsent, startConsent, closeConsent } = await import('../src/garden.js')
  t.is(initialConsent().visible, false)
  t.is(initialConsent().open, false)
  let s = openConsent()
  t.is(s.open, true)
  t.is(s.visible, false)
  t.alike(startConsent(s), s, 'the switch is off: nothing starts')
  s = toggleConsent(s)
  t.is(s.visible, true)
  s = startConsent(s)
  t.is(s.busy, true)
  t.alike(toggleConsent(s), s, 'ignored while busy')
  t.alike(startConsent(s), s)
  t.alike(closeConsent(), initialConsent())
  t.is(toggleConsent(toggleConsent(openConsent())).visible, false)
})

test('an index past the route caps never fans out into peeks', async (t) => {
  const { planPeeks, assembleBalcony } = await import('../src/garden.js')
  const author = (i) => (i + 1).toString(16).padStart(64, '0')
  const helps = Array.from({ length: 25 }, (_, i) => helpRow(author(i), 12, 5))
  const given = Array.from({ length: 25 }, (_, i) => 10 + i)
  for (const index of [baseIndex({ helps }), baseIndex({ given })]) {
    const plan = planPeeks({ owner: OWNER, index })
    t.alike(plan.owner, [{ author: OWNER, seqs: [1, 2] }])
    t.alike(plan.helpers, [])
    const r = assembleBalcony({ owner: OWNER, index, ownerReads: ownerRead(), helperReads: new Map(), now: NOW })
    t.is(r.on, false)
    t.is(r.incomplete, true)
  }
  const atCap = planPeeks({ owner: OWNER, index: baseIndex({ helps: helps.slice(0, 24), given: given.slice(0, 24) }) })
  t.is(atCap.helpers.length, 24)
})

test('assembleBalcony folds nothing while block 1 or 2 is unread', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const body = [e(3, flag()), e(4, state(ownerPots()))]
  for (const extra of [{ missing: [2] }, { invalid: [1] }, { missing: [1, 2] }]) {
    const r = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: [peek(OWNER, body, extra)], helperReads: new Map(), now: NOW })
    t.is(r.on, false)
    t.is(r.isPage, false)
    t.is(r.incomplete, true)
    t.alike(r.pots, nulls())
  }
  const page = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: [peek(OWNER, [e(1, { type: 'page-roster' }), ...body], { missing: [2] })], helperReads: new Map(), now: NOW })
  t.is(page.isPage, true)
})

test('the garden clock is the reader clock outside the Vitrine', async (t) => {
  const { gardenTime } = await import('../src/gardenClock.js')
  t.is(gardenTime(NOW), NOW)
  const before = Date.now()
  const read = gardenTime()
  t.ok(read >= before && read <= Date.now())
})

test('assembleBalcony counts a neighbour watering one pot on two days twice', async (t) => {
  const { assembleBalcony } = await import('../src/garden.js')
  const planted = NOW - 30 * H
  const ownerReads = [peek(OWNER, [e(1, { type: 'profile' }), e(3, flag()), e(4, state(potsWith(0, pot('espada', planted))))])]
  const helps = [helpRow(BOB, 9, 5), helpRow(BOB, 12, 5)]
  const reads = new Map([[BOB, peek(BOB, [e(5, follow(OWNER)), e(9, help(OWNER, 0, NOW - 20 * H)), e(12, help(OWNER, 0, NOW - H))])]])
  const r = assembleBalcony({ owner: OWNER, index: baseIndex({ helps }), ownerReads, helperReads: reads, now: NOW })
  t.is(r.helpers.length, 1, 'one row per neighbour')
  t.is(r.helpers[0].seq, 12)
  t.alike(r.received, [2, 0, 0, 0, 0, 0])
  t.is(r.pots[0].ripeAt, planted + 48 * H - 4 * H, 'both days shorten the wait')
  const off = assembleBalcony({ owner: OWNER, index: baseIndex({ helps }), ownerReads: [peek(OWNER, [e(1, { type: 'profile' }), e(3, flag(false)), e(4, state(potsWith(0, pot('espada', planted))))])], helperReads: reads, now: NOW })
  t.alike(off.received, [0, 0, 0, 0, 0, 0])
  t.alike(assembleBalcony({}).received, [0, 0, 0, 0, 0, 0])
})

test('provenOff is true only for an off balcony read in full', async (t) => {
  const { assembleBalcony, provenOff } = await import('../src/garden.js')
  const offReads = [peek(OWNER, [e(1, { type: 'profile' }), e(3, flag(false)), e(4, state(ownerPots()))])]
  const off = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: offReads, helperReads: new Map(), now: NOW })
  t.is(provenOff(off, false), true)
  t.is(provenOff(off, true), false, 'a second stale pointer proves nothing')
  t.is(provenOff({ ...off, indexing: true }, false), false)
  t.is(provenOff({ ...off, stale: true }, false), false)
  const unread = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: [peek(OWNER, [e(3, flag())], { missing: [1, 2] })], helperReads: new Map(), now: NOW })
  t.is(unread.on, false)
  t.is(provenOff(unread, false), false, 'unread first blocks read as unknown, not off')
  const partial = assembleBalcony({ owner: OWNER, index: baseIndex({ complete: false }), ownerReads: offReads, helperReads: new Map(), now: NOW })
  t.is(provenOff(partial, false), false)
  const on = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: ownerRead(), helperReads: new Map(), now: NOW })
  t.is(provenOff(on, false), false)
  t.is(provenOff(null, false), false)
  t.is(provenOff({ ...off, isPage: true }, false), false)
})

test('reloadDelay: 5 s, 15 s, 30 s, 60 s, then stop', async (t) => {
  const { reloadDelay, RELOAD_DELAYS_MS } = await import('../src/garden.js')
  t.alike(Array.from(RELOAD_DELAYS_MS), [5000, 15000, 30000, 60000])
  t.alike([0, 1, 2, 3].map((n) => reloadDelay(n)), [5000, 15000, 30000, 60000])
  t.is(reloadDelay(4), null, 'stops after four')
  t.is(reloadDelay(-1), null)
  t.is(reloadDelay(1.5), null)
  t.is(reloadDelay('0'), null)
  t.ok(RELOAD_DELAYS_MS.reduce((a, b) => a + b, 0) >= 100000, 'the reloads outlast a seeder restart (about 70 s on the server)')
})

test('wantsReload: failures and an index still building reload, answers do not', async (t) => {
  const { assembleBalcony, wantsReload } = await import('../src/garden.js')
  const playing = { phase: 'ready', error: null, mine: { on: true }, following: null }
  const on = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: ownerRead(), helperReads: new Map(), now: NOW })
  const offReads = [peek(OWNER, [e(1, { type: 'profile' }), e(3, flag(false)), e(4, state(ownerPots()))])]
  const off = assembleBalcony({ owner: OWNER, index: baseIndex(), ownerReads: offReads, helperReads: new Map(), now: NOW })
  const building = assembleBalcony({ owner: OWNER, index: baseIndex({ indexing: true, complete: false }), ownerReads: offReads, helperReads: new Map(), now: NOW })
  const ready = (result, forced = false) => ({ phase: 'ready', result, forced, error: null })

  t.is(wantsReload({ view: { phase: 'error', error: 'x', mine: null }, bal: { phase: 'idle', result: null }, own: true }), true, 'the own state failed to load')
  t.is(wantsReload({ view: playing, bal: { phase: 'error', result: null, error: 'x' }, own: false }), true, 'the balcony read failed')
  t.is(wantsReload({ view: playing, bal: ready(building), own: false }), true, 'a neighbour while the seeder indexes')
  t.is(wantsReload({ view: playing, bal: ready({ ...on, indexing: true }), own: true }), true, 'the own helpers while the seeder indexes')
  t.is(wantsReload({ view: playing, bal: ready(off, true), own: false }), true, 'a neighbour not proven off')

  t.is(wantsReload({ view: playing, bal: ready(on), own: false }), false, 'a neighbour who plays')
  t.is(wantsReload({ view: playing, bal: ready(on), own: true }), false, 'the own balcony read in full')
  t.is(wantsReload({ view: playing, bal: ready(off), own: false }), false, 'a neighbour proven not to play')
  t.is(wantsReload({ view: playing, bal: ready({ ...off, isPage: true }), own: false }), false, 'a page')
  t.is(wantsReload({ view: playing, bal: ready(off, true), own: true }), false, 'the own balcony reads its pots from garden.state')
  t.is(wantsReload({ view: { phase: 'ready', error: null, mine: { on: false } }, bal: { phase: 'idle', result: null }, own: true }), false, 'a viewer who does not play')
  t.is(wantsReload({ view: { phase: 'ready', error: null, mine: { on: false } }, bal: { phase: 'error', result: null }, own: false }), false, 'no balcony read for a viewer who does not play')
  t.is(wantsReload({ view: { phase: 'loading', error: null, mine: null }, bal: { phase: 'idle', result: null }, own: true }), false, 'a load in flight')
  t.is(wantsReload({ view: playing, bal: { phase: 'loading', result: null }, own: false }), false, 'a balcony read in flight')
  t.is(wantsReload(null), false)
  t.is(wantsReload({ view: null, bal: null }), false)
})

test('the Varandinha screen reloads on the ladder, never while a write is in flight', async (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Varandinha.js'), 'utf8')
  t.ok(src.includes('const reloadable = !act.pending && wantsReload({ view, bal, own })'), 'reloads only what a later read may fix, and no write is pending')
  t.ok(src.includes('const delay = reloadDelay(reloads.current)'), 'on the bounded ladder')
  t.is(src.match(/setTimeout\(/g).length, 1, 'one timer: the reload')
})

test('streetKeys offers only followed keys, once each, in the seeder order', async (t) => {
  const { streetKeys } = await import('../src/garden.js')
  const follows = new Set([BOB, CAROL])
  const items = [{ key: DAVE, on: 1 }, { key: CAROL, on: 2 }, { key: BOB.toUpperCase(), on: 3 }, { key: CAROL, on: 4 }]
  t.alike(streetKeys(items, follows), [CAROL, BOB], 'a key the viewer does not follow never shows')
  t.alike(streetKeys([{ key: 'b'.repeat(63) }, { key: 7 }, null, 'x', { key: BOB }], follows), [BOB], 'a malformed row is dropped')
  t.alike(streetKeys(items, null), [], 'without a follow set nothing is offered')
  t.alike(streetKeys(items, [BOB, CAROL]), [], 'a follow array is not a follow set')
  t.alike(streetKeys(null, follows), [])
  t.alike(streetKeys(items, new Set()), [])
})
