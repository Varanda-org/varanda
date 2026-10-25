'use strict'

const test = require('brittle')

const load = () => import('../src/pull.js')

const move = (over) => ({ startX: 100, startY: 100, x: 100, y: 100, atTop: true, refreshing: false, ...over })

test('pullDistance: monotonic, bounded damping', async (t) => {
  const { pullDistance, PULL_MAX } = await load()
  t.is(pullDistance(0), 0)
  t.is(pullDistance(-30), 0)
  const d72 = pullDistance(72)
  t.ok(d72 > 50 && d72 < 60)
  t.ok(pullDistance(1000) < PULL_MAX)
  t.ok(pullDistance(10000) <= PULL_MAX)
  let prev = 0
  for (let dy = 1; dy <= 2000; dy += 7) {
    const d = pullDistance(dy)
    t.ok(d >= prev && d <= PULL_MAX)
    prev = d
  }
})

test('pullState: inactive when not at top, while refreshing, or when horizontal dominates', async (t) => {
  const { pullState } = await load()
  const away = pullState(move({ y: 200, atTop: false }))
  t.is(away.active, false)
  t.is(away.lock, 'rejected')
  const busy = pullState(move({ y: 200, refreshing: true }))
  t.is(busy.active, false)
  t.is(busy.armed, false)
  const side = pullState(move({ x: 300, y: 180 }))
  t.is(side.active, false)
  t.is(side.armed, false)
  t.is(side.lock, 'rejected')
})

test('pullState: a sideways move gives a cancel decision', async (t) => {
  const { pullState, pullDecision } = await load()
  const s = pullState(move({ x: 300, y: 180 }))
  t.is(s.armed, false)
  t.is(pullDecision({ armed: s.armed, refreshing: false }), 'cancel')
})

test('pullState: the lock is sticky, a rejected touch never turns vertical', async (t) => {
  const { pullState } = await load()
  const first = pullState(move({ x: 130, y: 105 }))
  t.is(first.lock, 'rejected')
  const later = pullState(move({ x: 130, y: 300, lock: first.lock }))
  t.is(later.lock, 'rejected')
  t.is(later.active, false)
  t.is(later.armed, false)
  const up = pullState(move({ y: 70 }))
  t.is(up.lock, 'rejected')
  t.is(pullState(move({ y: 300, lock: up.lock })).active, false)
})

test('pullState: below the direction lock nothing is claimed yet', async (t) => {
  const { pullState } = await load()
  const s = pullState(move({ y: 105 }))
  t.is(s.lock, null)
  t.is(s.active, false)
  t.is(s.distance, 0)
})

test('pullState: arms at the threshold only for a vertical lock', async (t) => {
  const { pullState, pullDecision, PULL_THRESHOLD } = await load()
  const short = pullState(move({ y: 100 + PULL_THRESHOLD - 1 }))
  t.is(short.lock, 'vertical')
  t.is(short.active, true)
  t.is(short.armed, false)
  t.ok(short.progress < 1)
  t.is(pullDecision({ armed: short.armed, refreshing: false }), 'cancel')
  const at = pullState(move({ y: 100 + PULL_THRESHOLD, lock: 'vertical' }))
  t.is(at.armed, true)
  t.is(at.progress, 1)
  t.ok(at.distance > 0)
  t.is(pullDecision({ armed: at.armed, refreshing: false }), 'refresh')
  t.is(pullDecision({ armed: at.armed, refreshing: true }), 'cancel')
  const back = pullState(move({ y: 90, lock: 'vertical' }))
  t.is(back.active, false)
  t.is(back.armed, false)
})

test('spinRemaining: keeps the spinner for the minimum time', async (t) => {
  const { spinRemaining, MIN_SPIN_MS } = await load()
  t.is(spinRemaining({ startedAt: 1000, now: 1000 }), MIN_SPIN_MS)
  t.is(spinRemaining({ startedAt: 1000, now: 1200 }), MIN_SPIN_MS - 200)
  t.is(spinRemaining({ startedAt: 1000, now: 1000 + MIN_SPIN_MS }), 0)
  t.is(spinRemaining({ startedAt: 1000, now: 9000 }), 0)
  t.is(spinRemaining({ startedAt: 0, now: 100, min: 150 }), 50)
})

const wheel = (over) => ({ deltaY: -30, atTop: true, refreshing: false, now: 0, ...over })

test('wheelPullState: accumulates upward pixels and arms exactly at the threshold', async (t) => {
  const { EMPTY_WHEEL, WHEEL_THRESHOLD, WHEEL_DECAY_MS, wheelPullState, pullDistance } = await load()
  t.is(WHEEL_THRESHOLD, 120)
  t.is(WHEEL_DECAY_MS, 250)
  t.ok(Object.isFrozen(EMPTY_WHEEL))
  t.alike(EMPTY_WHEEL, { acc: 0, lastAt: null, armed: false, active: false, distance: 0, progress: 0 })
  const first = wheelPullState(EMPTY_WHEEL, wheel())
  t.is(first.acc, 30)
  t.is(first.lastAt, 0)
  t.is(first.active, true)
  t.is(first.armed, false)
  t.is(first.distance, pullDistance(30))
  t.is(first.progress, 0.25)
  const below = wheelPullState(first, wheel({ deltaY: -89, now: 50 }))
  t.is(below.acc, 119)
  t.is(below.armed, false)
  const at = wheelPullState(below, wheel({ deltaY: -1, now: 100 }))
  t.is(at.armed, true)
  t.is(at.progress, 1)
  t.is(at.distance, pullDistance(120))
  t.is(wheelPullState(at, wheel({ now: 150 })).progress, 1)
})

test('wheelPullState: decay restarts only after the idle limit', async (t) => {
  const { EMPTY_WHEEL, WHEEL_DECAY_MS, wheelPullState } = await load()
  const first = wheelPullState(EMPTY_WHEEL, wheel())
  t.is(wheelPullState(first, wheel({ now: WHEEL_DECAY_MS })).acc, 60)
  const expired = wheelPullState(first, wheel({ now: WHEEL_DECAY_MS + 1 }))
  t.is(expired.acc, 30)
  t.is(expired.lastAt, WHEEL_DECAY_MS + 1)
  t.is(expired.armed, false)
  const zero = wheelPullState(first, wheel({ deltaY: 0, now: 100 }))
  t.alike(zero, first)
  t.alike(wheelPullState(zero, wheel({ deltaY: 0, now: WHEEL_DECAY_MS + 1 })), EMPTY_WHEEL)
})

test('wheelPullState: downward motion, leaving the top and refreshing clear the pull', async (t) => {
  const { EMPTY_WHEEL, wheelPullState } = await load()
  const armed = wheelPullState(EMPTY_WHEEL, wheel({ deltaY: -120 }))
  for (const over of [{ deltaY: 1 }, { atTop: false }, { refreshing: true }]) {
    t.alike(wheelPullState(armed, wheel(over)), EMPTY_WHEEL)
    t.alike(wheelPullState(EMPTY_WHEEL, wheel(over)), EMPTY_WHEEL)
  }
})

test('wheelPullState: frozen inputs are never changed and results are new states', async (t) => {
  const { EMPTY_WHEEL, wheelPullState } = await load()
  const event = Object.freeze(wheel())
  const state = Object.freeze(wheelPullState(EMPTY_WHEEL, event))
  const snapshot = { ...state }
  const next = wheelPullState(state, Object.freeze(wheel({ now: 10 })))
  t.is(next.acc, 60)
  t.alike(state, snapshot)
  t.alike(event, wheel())
  t.not(next, state)
  t.not(wheelPullState(state, wheel({ deltaY: 0 })), state)
  t.not(wheelPullState(state, wheel({ deltaY: 1 })), EMPTY_WHEEL)
})
