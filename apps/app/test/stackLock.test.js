'use strict'

// The stack transition lock (src/stackLock.js), a pure ES module; import()
// loads it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/stackLock.js')

test('a lock is busy until its holder releases it', async (t) => {
  const { createStackLock } = await load()
  const lock = createStackLock()
  t.is(lock.busy(0), false, 'free at first')
  t.is(lock.holder(0), 0)
  const token = lock.acquire(1000, 350)
  t.ok(Number.isInteger(token) && token > 0)
  t.is(lock.busy(1000), true)
  t.is(lock.holder(1100), token)
  t.is(lock.release(token), true)
  t.is(lock.busy(1100), false)
  t.is(lock.holder(1100), 0)
  t.is(lock.release(token), false, 'a second release is a no-op')
})

test('a stale token cannot release a newer lock', async (t) => {
  const { createStackLock } = await load()
  const lock = createStackLock()
  const older = lock.acquire(1000, 350)
  const newer = lock.acquire(1100, 350)
  t.not(older, newer)
  t.is(lock.release(older), false, 'the overtaken slide ends')
  t.is(lock.busy(1200), true, 'the newer slide still holds the stack')
  t.is(lock.holder(1200), newer)
  t.is(lock.release(newer), true)
  t.is(lock.busy(1200), false)
})

test('a stale token stays stale after the lock is free again', async (t) => {
  const { createStackLock } = await load()
  const lock = createStackLock()
  const first = lock.acquire(0, 100)
  t.is(lock.release(first), true)
  const second = lock.acquire(10, 100)
  t.is(lock.release(first), false)
  t.is(lock.holder(20), second)
})

test('the deadline frees a lock nobody released', async (t) => {
  const { createStackLock } = await load()
  const lock = createStackLock()
  const token = lock.acquire(1000, 350)
  t.is(lock.busy(1349), true)
  t.is(lock.busy(1350), false, 'free at the deadline')
  t.is(lock.holder(5000), 0)
  const next = lock.acquire(5000, 350)
  t.is(lock.busy(5000), true, 'a new hold after the deadline is busy again')
  t.is(lock.release(token), false, 'the expired token cannot free it')
  t.is(lock.busy(5100), true)
  t.is(lock.release(next), true)
})

test('a zero hold is never busy but still supersedes the holder', async (t) => {
  const { createStackLock } = await load()
  const lock = createStackLock()
  const slide = lock.acquire(0, 350)
  const instant = lock.acquire(10, 0)
  t.is(lock.busy(10), false)
  t.is(lock.release(slide), false)
  t.is(lock.release(instant), true)
  lock.acquire(0, -5)
  t.is(lock.busy(0), false, 'negative hold')
  lock.acquire(0, NaN)
  t.is(lock.busy(0), false, 'NaN hold')
})

test('odd tokens and clocks never free or hold the lock', async (t) => {
  const { createStackLock } = await load()
  const lock = createStackLock()
  const token = lock.acquire(0, 100)
  for (const bad of [0, -1, null, undefined, '1', 1.5, NaN, {}]) {
    t.is(lock.release(bad), false, String(bad))
  }
  t.is(lock.busy(50), true)
  t.is(lock.busy(NaN), false, 'an unreadable clock is not busy')
  t.is(lock.release(token), true)
  lock.acquire(NaN, 100)
  t.is(lock.busy(0), false, 'a hold from an unreadable clock is not busy')
})

test('separate locks do not share holders', async (t) => {
  const { createStackLock } = await load()
  const a = createStackLock()
  const b = createStackLock()
  const ta = a.acquire(0, 100)
  t.is(b.busy(0), false)
  b.acquire(0, 100)
  t.is(a.holder(0), ta)
})

test('stackLock stays pure', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/stackLock.js'), 'utf8')
  for (const bad of ["from 'react", 'require(', 'node:', 'react-native', 'Date.now', '@varanda/core', '@varanda/web-member']) {
    t.absent(src.includes(bad), bad)
  }
  t.absent(src.includes('\u2014'), 'no em dash')
})
