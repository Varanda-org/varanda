'use strict'

const test = require('brittle')
const { readFileSync } = require('fs')
const { join } = require('path')

test('msUntilMidnight counts to the next local midnight', async (t) => {
  const { msUntilMidnight } = await import('../src/dayClock.js')
  t.is(msUntilMidnight(new Date(2026, 9, 10, 23, 59, 0).getTime()), 60 * 1000)
  t.is(msUntilMidnight(new Date(2026, 11, 31, 23, 59, 59, 999).getTime()), 1, 'year end rolls over')
  t.is(msUntilMidnight(new Date(2026, 9, 10, 0, 0, 0, 0).getTime()), new Date(2026, 9, 11).getTime() - new Date(2026, 9, 10).getTime(), 'exactly at midnight aims at the next one')
})

test('startDayWake wakes at each midnight and on a return to the foreground, then stops', async (t) => {
  const { startDayWake } = await import('../src/dayClock.js')
  let now = new Date(2026, 9, 10, 23, 59, 0).getTime()
  const timers = new Map()
  let nextId = 0
  let listener = null
  let woke = 0
  const fire = () => {
    const [[id, { fn }]] = [...timers]
    timers.delete(id)
    fn()
  }
  const delay = () => [...timers.values()][0].ms
  const stop = startDayWake({
    clock: () => now,
    setTimer: (fn, ms) => { timers.set(++nextId, { fn, ms }); return nextId },
    clearTimer: (id) => timers.delete(id),
    subscribe: (fn) => { listener = fn; return () => { listener = null } },
    onWake: () => { woke++ }
  })
  t.is(timers.size, 1)
  t.is(delay(), 60 * 1000, 'aims at the next midnight')

  now += 60 * 1000
  fire()
  t.is(woke, 1, 'midnight wakes')
  t.is(timers.size, 1, 're-armed')
  t.is(delay(), new Date(2026, 9, 12).getTime() - now, 'for the following midnight')

  listener('background')
  t.is(woke, 1, 'going to the background does not wake')
  now += 3 * 60 * 60 * 1000
  listener('active')
  t.is(woke, 2, 'the return to the foreground wakes')
  t.is(timers.size, 1, 'still one timer')
  t.is(delay(), new Date(2026, 9, 12).getTime() - now, 're-armed from the new time')

  stop()
  t.is(timers.size, 0, 'stop clears the timer')
  t.is(listener, null, 'and the subscription')
})

test('both clocks refresh through the day wake', (t) => {
  const src = readFileSync(join(__dirname, '../src/ui/index.js'), 'utf8')
  const plain = src.slice(src.indexOf('export function useNow'), src.indexOf('export function useVisibleNow'))
  const visible = src.slice(src.indexOf('export function useVisibleNow'), src.indexOf('// Bottom space'))
  t.ok(plain.includes('useDayWake(() => setNow(Date.now()))'), 'useNow')
  t.ok(visible.includes('useDayWake(() => { if (visible) setNow(Date.now()) })'), 'useVisibleNow, only while shown')
  t.ok(src.includes('return () => sub.remove()'), 'the AppState subscription is removed')
})
