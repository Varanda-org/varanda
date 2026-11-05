'use strict'

// Stack transitions (src/stackMotion.js), a pure ES module; import() loads
// it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/stackMotion.js')

test('pushPlan slides in from the right', async (t) => {
  const { pushPlan, STACK_MS } = await load()
  t.is(STACK_MS, 250)
  t.alike(pushPlan(false), { duration: 250, fromX: 1, toX: 0 })
  t.alike(pushPlan(), { duration: 250, fromX: 1, toX: 0 })
  const plan = pushPlan(false)
  plan.duration = 1
  t.is(pushPlan(false).duration, 250, 'a caller cannot change the next plan')
})

test('popPlan is the reverse slide', async (t) => {
  const { popPlan, pushPlan } = await load()
  const push = pushPlan(false)
  const pop = popPlan(false)
  t.alike(pop, { duration: 250, fromX: 0, toX: 1 })
  t.is(pop.duration, push.duration)
  t.is(pop.fromX, push.toX)
  t.is(pop.toX, push.fromX)
  t.alike(popPlan(), { duration: 250, fromX: 0, toX: 1 })
})

test('reduce motion keeps the direction and drops the duration', async (t) => {
  const { pushPlan, popPlan } = await load()
  const push = pushPlan(true)
  const pop = popPlan(true)
  t.is(push.duration, 0)
  t.is(pop.duration, 0)
  t.alike({ fromX: push.fromX, toX: push.toX }, { fromX: 1, toX: 0 })
  t.alike({ fromX: pop.fromX, toX: pop.toX }, { fromX: 0, toX: 1 })
  t.alike(pushPlan('reduce'), push, 'any requested reduction is instant')
  t.alike(popPlan(1), pop)
})

test('swipeVerdict: distance and velocity thresholds', async (t) => {
  const { swipeVerdict, SWIPE_FRACTION, SWIPE_VX } = await load()
  t.is(SWIPE_FRACTION, 0.35)
  t.is(SWIPE_VX, 0.5)
  const width = 200
  const limit = width * 0.35
  t.is(swipeVerdict({ dx: limit, vx: 0, width }), 'cancel', 'distance on the line stays')
  t.is(swipeVerdict({ dx: limit + 1, vx: 0, width }), 'pop', 'just past the distance')
  t.is(swipeVerdict({ dx: 0, vx: 0.5, width }), 'cancel', 'velocity on the line stays')
  t.is(swipeVerdict({ dx: 0, vx: 0.5 + 1e-10, width }), 'pop', 'just past the velocity')
  t.is(swipeVerdict({ dx: 0, vx: 0, width }), 'cancel')
  t.is(swipeVerdict({ dx: width, vx: -1, width }), 'pop', 'distance alone pops')
  t.is(swipeVerdict({ dx: 0, vx: 1, width }), 'pop', 'velocity alone pops')
  t.is(swipeVerdict({ dx: -width, vx: 0.5, width }), 'cancel', 'a leftward drag on the line stays')
  t.is(swipeVerdict({ dx: -1, vx: 0.6, width }), 'pop', 'a flick the other way still pops')
  t.is(swipeVerdict({}), 'cancel')
  t.is(swipeVerdict(), 'cancel')
  t.is(swipeVerdict(null), 'cancel')
})

test('edgeStart is the left edge, inclusive at 24', async (t) => {
  const { edgeStart, EDGE_PX } = await load()
  t.is(EDGE_PX, 24)
  t.is(edgeStart(0), true)
  t.is(edgeStart(24), true)
  t.is(edgeStart(-1), false, 'left of the layer is not the edge')
  t.is(edgeStart(24.01), false)
  t.is(edgeStart(25), false)
  t.is(edgeStart(100), false)
})

test('claimSwipe only takes a rightward drag that starts on the layer edge', async (t) => {
  const { claimSwipe } = await load()
  const drag = { dx: 30, dy: 2 }
  t.is(claimSwipe({ startX: 10, pageLeft: 0, ...drag }), true, 'starts on the edge')
  t.is(claimSwipe({ startX: 0, pageLeft: 0, ...drag }), true, 'inclusive at 0')
  t.is(claimSwipe({ startX: 24, pageLeft: 0, ...drag }), true, 'inclusive at 24')
  t.is(claimSwipe({ startX: 25, pageLeft: 0, ...drag }), false, 'just past the edge')
  t.is(claimSwipe({ startX: 200, pageLeft: 0, ...drag }), false, 'a drag from mid-screen is not a back swipe')
  t.is(claimSwipe({ startX: 200, pageLeft: 0, dx: 300, dy: 0 }), false, 'however far it goes')
  t.is(claimSwipe({ startX: 400, pageLeft: 390, ...drag }), true, 'edge of a centred column')
  t.is(claimSwipe({ startX: 380, pageLeft: 390, ...drag }), false, 'left of the column is not its edge')
  t.is(claimSwipe({ startX: 10, ...drag }), true, 'unknown page left counts as 0')
  t.is(claimSwipe({ startX: 10, pageLeft: 0, dx: 8, dy: 0 }), false, 'needs more than 8 px')
  t.is(claimSwipe({ startX: 10, pageLeft: 0, dx: -30, dy: 0 }), false, 'leftward drags stay')
  t.is(claimSwipe({ startX: 10, pageLeft: 0, dx: 15, dy: 10 }), false, 'too vertical')
  t.is(claimSwipe({ startX: 10, pageLeft: 0, dx: 16, dy: 10 }), true, 'horizontal enough')
  t.is(claimSwipe({ pageLeft: 0, ...drag }), false, 'no start, no swipe')
  t.is(claimSwipe({ startX: NaN, pageLeft: 0, ...drag }), false)
  t.is(claimSwipe(), false)
  t.is(claimSwipe(null), false)
})

test('stackChange tells a push from a pop', async (t) => {
  const { stackChange } = await load()
  const a = { screen: 'membro', key: 'a' }
  const b = { screen: 'conversa', key: 'b' }
  const c = { screen: 'grupo', key: 'c' }
  t.alike(stackChange([a], [a, b]), { kind: 'push', entry: b })
  t.alike(stackChange([], [a]), { kind: 'push', entry: a })
  t.alike(stackChange(null, [a]), { kind: 'push', entry: a })
  t.alike(stackChange([a, b], [a]), { kind: 'pop', entry: b, index: 1 })
  t.alike(stackChange([a, b, c], [a]), { kind: 'pop', entry: c, index: 2 }, 'popTo: the old top leaves')
  t.alike(stackChange([a], []), { kind: 'pop', entry: a, index: 0 })
  t.alike(stackChange([a, b], [a, b]), { kind: 'none' })
  t.alike(stackChange([a, b], [c]), { kind: 'none' }, 'a different stack is not a slide')
  t.alike(stackChange([a, b], [a, c]), { kind: 'none' }, 'a replaced top that is not a shift')
  t.alike(stackChange([], []), { kind: 'none' })
})

test('stackChange: a push at the depth limit is a push', async (t) => {
  const { stackChange } = await load()
  const { push, MAX_DEPTH } = await import('../src/nav.js')
  const hex = (n) => n.toString(16).padStart(64, '0')
  let full = []
  for (let i = 1; i <= MAX_DEPTH; i++) full = push(full, { screen: 'membro', key: hex(i) })
  t.is(full.length, MAX_DEPTH)
  const next = push(full, { screen: 'membro', key: hex(MAX_DEPTH + 1) })
  t.is(next.length, MAX_DEPTH, 'nav drops the oldest entry')
  t.alike(stackChange(full, next), { kind: 'push', entry: next[next.length - 1] })
  const same = { screen: 'membro', key: full[full.length - 1].key }
  t.alike(stackChange(full, full.slice(1).concat([same])), { kind: 'none' }, 'same top screen is not a push')
})

test('stackMotion stays pure', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/stackMotion.js'), 'utf8')
  for (const bad of ["from 'react", 'require(', 'node:', 'react-native', '@varanda/core', '@varanda/web-member']) {
    t.absent(src.includes(bad), bad)
  }
  t.absent(src.includes('\u2014'), 'no em dash')
})
