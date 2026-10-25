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
