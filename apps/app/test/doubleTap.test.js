'use strict'

// Double tap on a post body (src/doubleTap.js), a pure ES module; import()
// loads it here through Node's module syntax detection.
const test = require('brittle')

const load = () => import('../src/doubleTap.js')

test('tapKind: no previous tap is single', async (t) => {
  const { tapKind } = await load()
  t.is(tapKind(null, 1000), 'single')
  t.is(tapKind(undefined, 1000), 'single')
  t.is(tapKind(NaN, 1000), 'single')
  t.is(tapKind(Infinity, 1000), 'single')
  t.is(tapKind('900', 1000), 'single')
})

test('tapKind: the window edge', async (t) => {
  const { tapKind, DOUBLE_TAP_MS } = await load()
  t.is(DOUBLE_TAP_MS, 280)
  t.is(tapKind(1000, 1000), 'double', 'same instant')
  t.is(tapKind(1000, 1000 + DOUBLE_TAP_MS), 'double', 'on the edge')
  t.is(tapKind(1000, 1000 + DOUBLE_TAP_MS + 1), 'single', 'just past it')
})

test('tapKind: a negative delta is single', async (t) => {
  const { tapKind } = await load()
  t.is(tapKind(1000, 999), 'single')
})

test('tapKind: a custom window', async (t) => {
  const { tapKind } = await load()
  t.is(tapKind(1000, 1500, 500), 'double')
  t.is(tapKind(1000, 1501, 500), 'single')
  t.is(tapKind(1000, 1100, 50), 'single')
})

// Hand-driven timers: run() fires whatever is still scheduled.
function fakeTimers () {
  const live = new Map()
  let next = 1
  return {
    setTimer (cb, ms) {
      const id = next++
      live.set(id, { cb, ms })
      return id
    },
    clearTimer (id) { live.delete(id) },
    size: () => live.size,
    ms: () => [...live.values()].map((t) => t.ms),
    run () {
      const due = [...live.values()]
      live.clear()
      for (const t of due) t.cb()
    }
  }
}

test('pendingOpen: the timer fires once and clears', async (t) => {
  const { createPendingOpen, DOUBLE_TAP_MS } = await load()
  const timers = fakeTimers()
  const pending = createPendingOpen(timers)
  const a = {}
  let opened = 0
  pending.arm(() => { opened++ }, a, 1000)
  t.alike(timers.ms(), [DOUBLE_TAP_MS])
  t.is(pending.armedAt(a), 1000)
  timers.run()
  t.is(opened, 1)
  t.is(pending.armedAt(a), null, 'cleared after firing')
  timers.run()
  t.is(opened, 1, 'never twice')
  pending.cancel()
  t.is(timers.size(), 0)
})

test('pendingOpen: another row cancels it', async (t) => {
  const { createPendingOpen } = await load()
  const timers = fakeTimers()
  const pending = createPendingOpen(timers)
  const a = {}
  const b = {}
  const opened = []
  pending.arm(() => opened.push('a'), a, 1000)
  pending.cancel()
  t.is(timers.size(), 0, 'any row touch or other press cancels')
  pending.arm(() => opened.push('a'), a, 1000)
  pending.arm(() => opened.push('b'), b, 1100)
  t.is(timers.size(), 1, 'arming replaces the earlier row')
  timers.run()
  t.alike(opened, ['b'])
})

test('pendingOpen: cancelOwn only cancels its own row', async (t) => {
  const { createPendingOpen } = await load()
  const timers = fakeTimers()
  const pending = createPendingOpen(timers)
  const a = {}
  const b = {}
  let opened = 0
  pending.arm(() => { opened++ }, a, 1000)
  pending.cancelOwn(b)
  t.is(timers.size(), 1, 'another row unmounting leaves it armed')
  t.is(pending.armedAt(a), 1000)
  pending.cancelOwn(a)
  t.is(timers.size(), 0)
  t.is(pending.armedAt(a), null)
  timers.run()
  t.is(opened, 0)
})

test('pendingOpen: armedAt is per row', async (t) => {
  const { createPendingOpen } = await load()
  const timers = fakeTimers()
  const pending = createPendingOpen(timers)
  const a = {}
  const b = {}
  t.is(pending.armedAt(a), null, 'nothing armed')
  pending.arm(() => {}, a, 1000)
  t.is(pending.armedAt(a), 1000)
  t.is(pending.armedAt(b), null, 'a tap on another row is never a double tap')
  pending.arm(() => {}, b, 1200, 50)
  t.is(pending.armedAt(a), null)
  t.is(pending.armedAt(b), 1200)
  t.alike(timers.ms(), [50], 'a custom window')
})

test('doubleTapPlan: a like or repost on its way owns the post, so no heart without a like', async (t) => {
  const { doubleTapPlan } = await load()
  t.alike(doubleTapPlan({ liked: false, pending: null }), { like: true, burst: true })
  t.alike(doubleTapPlan({ liked: false, pending: undefined }), { like: true, burst: true })
  t.alike(doubleTapPlan({ liked: false, pending: 'repost' }), { like: false, burst: false }, 'repost pending')
  t.alike(doubleTapPlan({ liked: false, pending: 'like' }), { like: false, burst: false }, 'like pending')
  t.alike(doubleTapPlan({ liked: true, pending: null }), { like: false, burst: true }, 'already liked: never unlikes')
  t.alike(doubleTapPlan({ liked: true, pending: 'repost' }), { like: false, burst: true })
})
