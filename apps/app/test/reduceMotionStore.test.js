'use strict'

// Shared reduce-motion store (src/reduceMotionStore.js), a pure ES module.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/reduceMotionStore.js')

function fakeApi (answer = true) {
  const api = { queries: 0, listeners: [], removed: 0, resolve: null }
  api.isReduceMotionEnabled = () => {
    api.queries++
    return new Promise((resolve) => { api.resolve = resolve; if (answer !== null) resolve(answer) })
  }
  api.addEventListener = (name, fn) => {
    api.listeners.push(fn)
    return { remove () { api.removed++; api.listeners = api.listeners.filter((l) => l !== fn) } }
  }
  return api
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('many subscribers share one query and one listener', async (t) => {
  const { createReduceMotionStore } = await load()
  const api = fakeApi(true)
  const store = createReduceMotionStore(api)
  const offs = []
  for (let i = 0; i < 50; i++) offs.push(store.subscribe(() => {}))
  await tick()
  t.is(api.queries, 1)
  t.is(api.listeners.length, 1)
  t.is(store.get(), true)
})

test('a change notifies every subscriber, and the last leaving removes the listener', async (t) => {
  const { createReduceMotionStore } = await load()
  const api = fakeApi(false)
  const store = createReduceMotionStore(api)
  let a = 0
  let b = 0
  const offA = store.subscribe(() => a++)
  const offB = store.subscribe(() => b++)
  await tick()
  api.listeners[0](true)
  t.is(store.get(), true)
  t.alike([a, b], [1, 1])
  offA()
  offA()
  t.is(api.removed, 0)
  offB()
  t.is(api.removed, 1)
  t.is(api.listeners.length, 0)
})

test('a throwing or missing API leaves false', async (t) => {
  const { createReduceMotionStore } = await load()
  const bad = createReduceMotionStore({ isReduceMotionEnabled () { throw new Error('x') }, addEventListener () { throw new Error('x') } })
  const off = bad.subscribe(() => {})
  t.is(bad.get(), false)
  off()
  const missing = createReduceMotionStore(undefined)
  missing.subscribe(() => {})()
  t.is(missing.get(), false)
  const rejects = createReduceMotionStore({ isReduceMotionEnabled: () => Promise.reject(new Error('x')), addEventListener: () => null })
  rejects.subscribe(() => {})
  await tick()
  t.is(rejects.get(), false)
})

test('a late answer after cleanup is ignored', async (t) => {
  const { createReduceMotionStore } = await load()
  const api = fakeApi(null)
  const store = createReduceMotionStore(api)
  const off = store.subscribe(() => {})
  off()
  api.resolve(true)
  await tick()
  t.is(store.get(), false)
})

test('StackLayer no longer queries AccessibilityInfo per mount', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/StackLayer.js'), 'utf8')
  t.absent(/AccessibilityInfo\.(isReduceMotionEnabled|addEventListener)/.test(src))
  t.ok(src.includes('useSyncExternalStore'))
})
