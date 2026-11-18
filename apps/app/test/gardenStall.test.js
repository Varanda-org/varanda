'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')

const load = () => import('../src/gardenStall.js')

// Saturday 2026-11-14 at noon in Brasília; the reader is on the Sunday after.
const SAT = Date.UTC(2026, 10, 14, 15, 0, 0)
const NOW = Date.UTC(2026, 10, 15, 15, 0, 0)
const H = 3600000
const iso = (ms) => new Date(ms).toISOString()
const OWNER = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)
const DAVE = 'd'.repeat(64)
const SINCE = 3

const flag = (on = true) => ({ type: 'garden', on, at: iso(SAT - 48 * H) })
const decorRec = (list, at = SAT) => ({ type: 'garden-decor', items: list, at: iso(at) })
const gift = (to = OWNER, item = 'tomate', at = SAT) => ({ type: 'garden-gift', to, item, at: iso(at) })
const take = (from, seq, at = SAT + H) => ({ type: 'garden-take', from, seq, at: iso(at) })
const follow = (key = OWNER, on = true) => ({ type: 'follow', key, on, at: iso(SAT - 72 * H) })
const peek = (key, entries, extra = {}) => ({ key, length: 99, entries, invalid: [], missing: [], ...extra })
const e = (seq, record) => ({ seq, record })
const flags = { indexing: false, complete: true }
const stallIndex = (over = {}) => ({ decor: null, pending: [], shelf: [], ...flags, ...over })
const pend = (author, seq = 12, followSeq = 5) => ({ author, seq, followSeq })
const shelfRow = (seq, from, gseq) => ({ seq, from, gseq })
const hx = (i) => i.toString(16).padStart(64, '0')

function base (over = {}) {
  return { owner: OWNER, since: SINCE, now: NOW, index: stallIndex(), ownerReads: [peek(OWNER, [e(SINCE, flag())])], giverReads: new Map(), ...over }
}

test('planStallPeeks: owner batch, one entry per giver, blocked left out', async (t) => {
  const { planStallPeeks } = await load()
  const index = stallIndex({ decor: 9, pending: [pend(BOB, 12, 5), pend(BOB, 14, 5), pend(CAROL, 7, 2)], shelf: [shelfRow(10, DAVE, 4), shelfRow(11, BOB, 20)] })
  const plan = planStallPeeks({ owner: OWNER, index })
  t.alike(plan.owner, [{ author: OWNER, seqs: [9, 10, 11] }])
  const bob = plan.givers.find((g) => g.author === BOB)
  t.alike(bob.batches, [{ author: BOB, seqs: [5, 12, 14, 20] }])
  t.is(bob.rows.length, 3)
  t.alike(plan.givers.find((g) => g.author === CAROL).batches, [{ author: CAROL, seqs: [2, 7] }])
  t.alike(plan.givers.find((g) => g.author === DAVE).batches, [{ author: DAVE, seqs: [4] }])
  const blocked = planStallPeeks({ owner: OWNER, index, isBlocked: (k) => k === BOB })
  t.absent(blocked.givers.some((g) => g.author === BOB), 'a blocked giver is not peeked')
  t.alike(blocked.owner, [{ author: OWNER, seqs: [9, 10] }], 'nor its take')
  const throws = planStallPeeks({ owner: OWNER, index, isBlocked: () => { throw new Error('x') } })
  t.alike(throws.givers, [], 'a throwing block check reads as blocked')
})

test('planStallPeeks: a refused index plans nothing', async (t) => {
  const { planStallPeeks } = await load()
  const bads = [
    null,
    stallIndex({ pending: Array.from({ length: 13 }, (_, i) => pend(hx(i + 1))) }),
    stallIndex({ pending: [pend(BOB), pend(BOB)] }),
    stallIndex({ pending: [pend(OWNER)] }),
    stallIndex({ shelf: [shelfRow(1, BOB, 2), shelfRow(1, CAROL, 3)] }),
    stallIndex({ shelf: Array.from({ length: 9 }, (_, i) => shelfRow(i + 1, BOB, 1)) }),
    stallIndex({ decor: 0 }),
    stallIndex({ pending: 'x' })
  ]
  for (const index of bads) t.alike(planStallPeeks({ owner: OWNER, index }), { owner: [], givers: [] })
  t.alike(planStallPeeks({ owner: 'nope', index: stallIndex() }), { owner: [], givers: [] })
  const getter = stallIndex()
  Object.defineProperty(getter, 'decor', { enumerable: true, get () { throw new Error('boom') } })
  t.alike(planStallPeeks({ owner: OWNER, index: getter }), { owner: [], givers: [] }, 'a getter never runs')
})

test('planStallPeeks: no batch exceeds 29 seqs; own takes replace the shelf, capped at 54', async (t) => {
  const { planStallPeeks } = await load()
  const ownTakes = Array.from({ length: 54 }, (_, i) => ({ seq: 100 + i, from: BOB, gseq: 200 + i, at: iso(SAT) }))
  const index = stallIndex({ decor: 9, shelf: [shelfRow(10, CAROL, 4)] })
  const plan = planStallPeeks({ owner: OWNER, index, ownTakes })
  const all = [...plan.owner, ...plan.givers.flatMap((g) => g.batches)]
  t.ok(all.every((b) => b.seqs.length <= 29), 'every batch within PEEK_SEQS_MAX')
  t.is(plan.owner.reduce((n, b) => n + b.seqs.length, 0), 55, 'decor and 54 takes')
  t.absent(plan.givers.some((g) => g.author === CAROL), 'the seeder shelf is not used when own takes are given')
  t.is(plan.givers[0].batches.reduce((n, b) => n + b.seqs.length, 0), 54)
  const over = [...ownTakes, { seq: 999, from: BOB, gseq: 998, at: iso(SAT) }]
  const capped = planStallPeeks({ owner: OWNER, index, ownTakes: over })
  t.alike(capped.owner, [{ author: OWNER, seqs: [9] }], 'a 55-row ownTakes plans nothing for the shelf')
  t.alike(capped.givers, [])
})

test('assembleStall: decor, shelf and pending from verified blocks', async (t) => {
  const { assembleStall } = await load()
  const index = stallIndex({ decor: 9, pending: [pend(BOB, 12, 5)], shelf: [shelfRow(10, CAROL, 7)] })
  const out = assembleStall(base({
    index,
    ownerReads: [peek(OWNER, [e(SINCE, flag()), e(9, decorRec(['rede', 'gato'])), e(10, take(CAROL, 7))])],
    giverReads: new Map([[BOB, peek(BOB, [e(5, follow()), e(12, gift(OWNER, 'tomate'))])], [CAROL, peek(CAROL, [e(7, gift(OWNER, 'alecrim'))])]])
  }))
  t.alike(out.decor, ['rede', 'gato'])
  t.alike(out.shelf, [{ seq: 10, from: CAROL, gseq: 7, item: 'alecrim', at: iso(SAT) }])
  t.alike(out.pending, [{ author: BOB, seq: 12, item: 'tomate', at: iso(SAT) }])
  t.is(out.incomplete, false)
})

test('assembleStall: forged, stale and wrong blocks never reach the output', async (t) => {
  const { assembleStall } = await load()
  const index = stallIndex({ pending: [pend(BOB, 12, 5)], shelf: [shelfRow(10, CAROL, 7)] })
  const run = (bobRecs, carolRecs, ownerExtra = [], over = {}) => assembleStall(base({
    index,
    ownerReads: [peek(OWNER, [e(SINCE, flag()), e(10, take(CAROL, 7)), ...ownerExtra])],
    giverReads: new Map([[BOB, peek(BOB, bobRecs)], [CAROL, peek(CAROL, carolRecs)]]),
    ...over
  }))
  const okBob = [e(5, follow()), e(12, gift())]
  const okCarol = [e(7, gift())]
  t.is(run(okBob, okCarol).shelf.length, 1)
  t.is(run(okBob, okCarol).pending.length, 1)

  t.alike(run(okBob, [e(7, gift(DAVE))]).shelf, [], 'a take naming a gift addressed to someone else')
  t.alike(run(okBob, [e(7, { type: 'garden-help', to: OWNER, pot: 0, at: iso(SAT) })]).shelf, [], 'a gift block of the wrong type')
  t.alike(run([e(5, follow()), e(12, { ...take(OWNER, 1) })], okCarol).pending, [], 'a pending block of the wrong type')
  t.alike(run([e(5, follow(OWNER, false)), e(12, gift())], okCarol).pending, [], 'a follow that is off')
  t.alike(run([e(5, follow(DAVE)), e(12, gift())], okCarol).pending, [], 'a follow of someone else')
  const friday = SAT - 24 * H
  t.alike(run([e(5, follow()), e(12, gift(OWNER, 'tomate', friday))], [e(7, gift(OWNER, 'tomate', friday))]).pending, [], 'a gift dated on a Friday')
  t.alike(run([e(5, follow()), e(12, gift(OWNER, 'tomate', friday))], [e(7, gift(OWNER, 'tomate', friday))]).shelf, [], 'a shelf gift dated on a Friday')
  const late = Date.UTC(2026, 10, 22, 15, 0, 0)
  const expired = run(okBob, okCarol, [], { now: late })
  t.alike([expired.pending, expired.shelf], [[], []], 'an expired gift')

  const stale = assembleStall(base({
    index: stallIndex({ decor: 2, shelf: [shelfRow(2, CAROL, 7)] }),
    ownerReads: [peek(OWNER, [e(2, take(CAROL, 7)), e(SINCE, flag())])],
    giverReads: new Map([[CAROL, peek(CAROL, okCarol)]])
  }))
  t.alike([stale.decor, stale.shelf], [[], []], 'a take or decor below the on flag')
  t.is(stale.incomplete, true)
  const atFlag = assembleStall(base({
    index: stallIndex({ decor: SINCE }),
    ownerReads: [peek(OWNER, [e(SINCE, decorRec(['rede']))])]
  }))
  t.alike(atFlag.decor, [], 'a decor at the on flag')

  const misnamed = run(okBob, [e(7, gift()), e(8, gift())], [], { index: stallIndex({ shelf: [shelfRow(10, CAROL, 8)] }) })
  t.alike(misnamed.shelf, [], 'a take whose gift differs from the pointer')
  t.is(misnamed.incomplete, true)
  const unread = run(okBob, okCarol, [], { ownerReads: [peek(OWNER, [e(SINCE, flag()), e(10, take(CAROL, 7))], { invalid: [10] })] })
  t.alike(unread.shelf, [], 'a take the node named invalid')
  t.is(unread.incomplete, true)
  const missing = run(okBob, [], [])
  t.alike(missing.shelf, [])
  t.is(missing.incomplete, true, 'an unresolved pointer sets incomplete')
  const noGiver = assembleStall(base({ index, ownerReads: [peek(OWNER, [e(SINCE, flag()), e(10, take(CAROL, 7))])] }))
  t.alike([noGiver.pending, noGiver.shelf, noGiver.incomplete], [[], [], true])
})

test('assembleStall: a blocked giver is not shown; bad input answers empty', async (t) => {
  const { assembleStall } = await load()
  const index = stallIndex({ pending: [pend(BOB, 12, 5)], shelf: [shelfRow(10, BOB, 7)] })
  const out = assembleStall(base({
    index,
    ownerReads: [peek(OWNER, [e(SINCE, flag()), e(10, take(BOB, 7))])],
    giverReads: new Map([[BOB, peek(BOB, [e(5, follow()), e(7, gift()), e(12, gift())])]]),
    isBlocked: (k) => k === BOB
  }))
  t.alike([out.pending, out.shelf], [[], []])
  const empty = { decor: [], shelf: [], pending: [], incomplete: true }
  t.alike(assembleStall(null), empty)
  t.alike(assembleStall(base({ since: null })), empty, 'no since, nothing shows')
  t.alike(assembleStall(base({ index: stallIndex({ pending: [pend(BOB), pend(BOB)] }) })), empty, 'a refused index')
  t.alike(assembleStall(base({ owner: 'x' })), empty)
  t.alike(assembleStall(base({ now: NaN })), empty)
})

test('assembleStall: taken comes from verified takes, and on the own balcony from ownTakes', async (t) => {
  const { assembleStall } = await load()
  const bob = peek(BOB, [e(5, follow()), e(12, gift())])
  // The index lags: it still lists the gift as pending, and its shelf names
  // the verified take of it.
  const lagging = assembleStall(base({
    index: stallIndex({ pending: [pend(BOB, 12, 5)], shelf: [shelfRow(10, BOB, 12)] }),
    ownerReads: [peek(OWNER, [e(SINCE, flag()), e(10, take(BOB, 12))])],
    giverReads: new Map([[BOB, bob]])
  }))
  t.alike(lagging.pending, [], 'a verified take hides the pending row')
  t.is(lagging.shelf.length, 1)
  // A forged shelf pointer to a block that is no take hides nothing.
  const forged = assembleStall(base({
    index: stallIndex({ pending: [pend(BOB, 12, 5)], shelf: [shelfRow(10, BOB, 12)] }),
    ownerReads: [peek(OWNER, [e(SINCE, flag()), e(10, decorRec([]))])],
    giverReads: new Map([[BOB, bob]])
  }))
  t.is(forged.pending.length, 1, 'taken is never built from the index alone')
  // Own balcony: the index knows nothing of the take yet.
  const own = assembleStall(base({
    index: stallIndex({ pending: [pend(BOB, 12, 5)] }),
    ownTakes: [{ seq: 10, from: BOB, gseq: 12, at: iso(SAT + H) }],
    ownerReads: [peek(OWNER, [e(SINCE, flag()), e(10, take(BOB, 12))])],
    giverReads: new Map([[BOB, bob]])
  }))
  t.alike(own.pending, [], 'an own index whose pending row names a pair in ownTakes drops it')
  t.alike(own.shelf, [{ seq: 10, from: BOB, gseq: 12, item: 'tomate', at: iso(SAT) }], 'the accepted mimo shows before the index has it')
  const ownUnread = assembleStall(base({
    index: stallIndex({ pending: [pend(BOB, 12, 5)] }),
    ownTakes: [{ seq: 10, from: BOB, gseq: 12, at: iso(SAT + H) }],
    giverReads: new Map([[BOB, bob]])
  }))
  t.alike(ownUnread.pending, [], 'the ownTakes pair hides the row even with the take block unread')
  const tooMany = Array.from({ length: 55 }, (_, i) => ({ seq: 100 + i, from: CAROL, gseq: 200 + i, at: iso(SAT) }))
  const capped = assembleStall(base({ ownTakes: tooMany }))
  t.alike(capped.shelf, [])
  t.is(capped.incomplete, true)
})

test('assembleStall: followed givers rank first on the own balcony only', async (t) => {
  const { assembleStall } = await load()
  const reads = new Map([
    [BOB, peek(BOB, [e(5, follow()), e(12, gift(OWNER, 'tomate', SAT + 2 * H))])],
    [CAROL, peek(CAROL, [e(5, follow()), e(12, gift(OWNER, 'tomate', SAT))])]
  ])
  const index = stallIndex({ pending: [pend(BOB, 12, 5), pend(CAROL, 12, 5)] })
  const plain = assembleStall(base({ index, giverReads: reads, ownTakes: [] }))
  t.alike(plain.pending.map((r) => r.author), [BOB, CAROL], 'newest first without a follow set')
  const own = assembleStall(base({ index, giverReads: reads, ownTakes: [], followed: new Set([CAROL]) }))
  t.alike(own.pending.map((r) => r.author), [CAROL, BOB], 'a followed giver comes first')
  const visitor = assembleStall(base({ index, giverReads: reads, followed: new Set([CAROL]) }))
  t.alike(visitor.pending.map((r) => r.author), [BOB, CAROL], 'a visitor passes no follow set')
})

test('previewPlan: the owner diary only', async (t) => {
  const { previewPlan } = await load()
  const plan = previewPlan({ owner: OWNER, index: { on: 3, state: 4 }, stallIndex: stallIndex({ decor: 9, pending: [pend(BOB)], shelf: [shelfRow(10, CAROL, 7)] }) })
  t.alike(plan, [{ author: OWNER, seqs: [1, 2, 3, 4, 9] }])
  t.ok(plan.every((b) => b.author === OWNER), 'never another diary')
  t.alike(previewPlan({ owner: OWNER, index: null, stallIndex: null }), [{ author: OWNER, seqs: [1, 2] }])
  t.alike(previewPlan({ owner: 'x' }), [])
})

test('previewDecor: through foldDecor above a verified on flag', async (t) => {
  const { previewDecor } = await load()
  const args = (reads, over = {}) => ({ owner: OWNER, index: { on: 3, state: 4 }, stallIndex: stallIndex({ decor: 9 }), ownerReads: [peek(OWNER, reads)], now: NOW, ...over })
  t.alike(previewDecor(args([e(3, flag()), e(9, decorRec(['varal', 'pisca']))])), ['varal', 'pisca'])
  t.alike(previewDecor(args([e(3, flag(false)), e(9, decorRec(['varal']))])), [], 'an off flag')
  t.alike(previewDecor(args([e(3, flag()), e(9, decorRec(['pisca', 'varal']))])), [], 'a non-canonical decor')
  t.alike(previewDecor(args([e(3, flag()), e(9, gift())])), [], 'a block of the wrong type')
  t.alike(previewDecor(args([e(1, { type: 'page-roster' }), e(3, flag()), e(9, decorRec(['varal']))])), [], 'a page')
  t.alike(previewDecor(args([e(3, flag()), e(9, decorRec(['varal']))], { stallIndex: stallIndex({ decor: 2 }) })), [], 'a decor below the flag')
  t.alike(previewDecor(null), [])
})

test('toggleDecor keeps canonical order', async (t) => {
  const { toggleDecor } = await load()
  t.alike(toggleDecor([], 'pisca'), ['pisca'])
  t.alike(toggleDecor(['pisca'], 'rede'), ['rede', 'pisca'])
  t.alike(toggleDecor(['pisca', 'rede', 'gato'], 'varal'), rpc.garden.GARDEN_DECOR_IDS.slice())
  t.alike(toggleDecor(['rede', 'gato'], 'rede'), ['gato'])
  t.alike(toggleDecor(['rede', 'x', 'rede'], 'nope'), ['rede'])
  t.alike(toggleDecor(null, 'gato'), ['gato'])
  t.ok(rpc.garden.isDecor(toggleDecor(['pisca', 'gato'], 'varal')))
})

test('giveChoice covers each answer; stallCount', async (t) => {
  const { giveChoice, stallCount } = await load()
  const ripe = { ripe: true }
  const open = { open: true, giftsToday: 0 }
  t.is(giveChoice({ view: ripe, unsaved: 0, stall: open }), 'give')
  t.is(giveChoice({ view: ripe, unsaved: 0, stall: { open: true, giftsToday: 2 } }), 'give')
  t.is(giveChoice({ view: ripe, unsaved: 0, stall: { open: false, giftsToday: 0 } }), 'closed')
  t.is(giveChoice({ view: ripe, unsaved: 0, stall: null }), 'closed')
  t.is(giveChoice({ view: ripe, unsaved: 0, stall: { open: true, giftsToday: 3 } }), 'spent')
  t.is(giveChoice({ view: ripe, unsaved: 0, stall: { open: true, giftsToday: 'x' } }), 'spent')
  t.is(giveChoice({ view: ripe, unsaved: 2, stall: open }), 'unsaved')
  t.is(giveChoice({ view: ripe, unsaved: true, stall: open }), 'unsaved')
  t.is(giveChoice({ view: { ripe: false }, unsaved: 0, stall: open }), null)
  t.is(giveChoice({ view: null, unsaved: 0, stall: open }), null)
  t.is(giveChoice(null), null)
  t.is(stallCount([{}, {}]), 2)
  t.is(stallCount(null), 0)
})
