'use strict'

const test = require('brittle')
const load = () => import('../src/idle.js')

// A manual clock: timers fire only when the test advances time.
function clock () {
  let t = 0
  let id = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++id, { at: t + ms, fn }); return id },
    clearTimer: (k) => { timers.delete(k) },
    advance (ms) {
      const end = t + ms
      for (;;) {
        let next = null
        for (const [k, v] of timers) if (v.at <= end && (next === null || v.at < timers.get(next).at)) next = k
        if (next === null) break
        const { at, fn } = timers.get(next)
        timers.delete(next)
        t = at
        fn()
      }
      t = end
    }
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('whenIdle resolves after the quiet time with nothing in flight', async (t) => {
  const { createIdleTracker } = await load()
  const c = clock()
  const idle = createIdleTracker(c)
  let done = false
  idle.whenIdle(3000).promise.then(() => { done = true })
  c.advance(2999)
  await settle()
  t.is(done, false, 'not before the quiet time')
  c.advance(1)
  await settle()
  t.is(done, true)
})

test('a request in flight holds the wait, and the quiet time restarts after it ends', async (t) => {
  const { createIdleTracker } = await load()
  const c = clock()
  const idle = createIdleTracker(c)
  let done = false
  idle.whenIdle(3000).promise.then(() => { done = true })
  c.advance(1000)
  idle.begin()
  c.advance(10000)
  await settle()
  t.is(done, false, 'never while a request is in flight')
  idle.end()
  c.advance(2999)
  await settle()
  t.is(done, false, 'the quiet time counts from the last end')
  c.advance(1)
  await settle()
  t.is(done, true)
})

test('overlapping requests: idle only after the last one ends', async (t) => {
  const { createIdleTracker } = await load()
  const c = clock()
  const idle = createIdleTracker(c)
  let done = false
  idle.begin()
  idle.begin()
  idle.whenIdle(1000).promise.then(() => { done = true })
  idle.end()
  c.advance(5000)
  await settle()
  t.is(done, false, 'one request still in flight')
  idle.end()
  c.advance(1000)
  await settle()
  t.is(done, true)
})

test('a request that starts and ends during the wait pushes it back', async (t) => {
  const { createIdleTracker } = await load()
  const c = clock()
  const idle = createIdleTracker(c)
  let done = false
  idle.whenIdle(3000).promise.then(() => { done = true })
  c.advance(2000)
  idle.begin()
  idle.end()
  c.advance(2000)
  await settle()
  t.is(done, false)
  c.advance(1000)
  await settle()
  t.is(done, true)
})

test('a cancelled wait never resolves; an extra end never goes below zero', async (t) => {
  const { createIdleTracker } = await load()
  const c = clock()
  const idle = createIdleTracker(c)
  let done = false
  const w = idle.whenIdle(1000)
  w.promise.then(() => { done = true })
  w.cancel()
  c.advance(5000)
  await settle()
  t.is(done, false)
  idle.end()
  let later = false
  idle.whenIdle(1000).promise.then(() => { later = true })
  c.advance(1000)
  await settle()
  t.is(later, true, 'the count did not go negative')
})
