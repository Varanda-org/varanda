'use strict'

// useVisibleNow (src/visibleNow.js + src/ui/index.js): the interval
// pauses on a hidden screen and refreshes at once on return.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/visibleNow.js')
const read = (rel) => fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8')

function rig (createVisibleNow) {
  const state = { t: 1000, seen: [], timers: new Map(), id: 0 }
  const ticker = createVisibleNow({
    intervalMs: 100,
    clock: () => state.t,
    setTimer: (fn) => { state.timers.set(++state.id, fn); return state.id },
    clearTimer: (id) => state.timers.delete(id),
    onNow: (n) => state.seen.push(n)
  })
  const tick = () => { state.t += 100; for (const fn of [...state.timers.values()]) fn() }
  return { state, ticker, tick }
}

test('ticks while visible, none while hidden, refresh at once on return', async (t) => {
  const { createVisibleNow } = await load()
  const { state, ticker, tick } = rig(createVisibleNow)
  ticker.setVisible(true)
  t.alike(state.seen, [], 'first show: no refresh')
  ticker.setVisible(false)
  t.is(state.timers.size, 0, 'hidden: no timer')
  tick(); tick()
  t.alike(state.seen, [], 'hidden: nothing renders')
  state.t = 5000
  ticker.setVisible(true)
  t.alike(state.seen, [5000], 'visible again: refreshed at once')
  tick()
  t.alike(state.seen, [5000, 5100], 'then ticks')
  ticker.setVisible(true)
  t.is(state.timers.size, 1, 'no second timer')
  ticker.setVisible(false)
  t.is(state.timers.size, 0, 'hiding clears the timer')
  tick()
  t.is(state.seen.length, 2, 'no tick after hiding')
  ticker.setVisible(true)
  ticker.stop()
  t.is(state.timers.size, 0, 'stop clears')
})

test('a screen mounted hidden refreshes on its first show', async (t) => {
  const { createVisibleNow } = await load()
  const { state, ticker, tick } = rig(createVisibleNow)
  ticker.setVisible(false)
  t.is(state.timers.size, 0, 'mounted hidden: no timer')
  state.t = 9000
  ticker.setVisible(true)
  t.alike(state.seen, [9000], 'first show after a hidden mount: refreshed at once')
  tick()
  t.alike(state.seen, [9000, 9100], 'then ticks')
  ticker.stop()
})

test('useNow is untouched and useVisibleNow reads ScreenVisible', (t) => {
  const src = read('ui/index.js')
  const plain = src.slice(src.indexOf('export function useNow'), src.indexOf('// useNow for a screen'))
  t.absent(plain.includes('ScreenVisible') || plain.includes('useContext'), 'useNow does not read ScreenVisible')
  t.ok(plain.includes('const timer = setInterval(() => setNow(Date.now()), intervalMs)'), 'default interval as before')
  const vis = src.slice(src.indexOf('export function useVisibleNow'), src.indexOf('// Bottom space'))
  t.ok(vis.includes('useContext(ScreenVisible)') && vis.includes('createVisibleNow'), 'visible variant gates on ScreenVisible')
})
