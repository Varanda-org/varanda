'use strict'

// src/online.native.js with @react-native-community/netinfo and react-native
// (AppState) replaced by stubs (a module hook), so no native module is
// loaded. The stubs keep their calls and listeners on globalThis for the
// tests to drive. The module keeps state, so the tests run in order.
const { register } = require('node:module')
const test = require('brittle')

const netinfo = `
const box = globalThis.__netinfo = globalThis.__netinfo || { calls: [], listeners: new Set(), state: null, config: null }
export default {
  configure (config) { box.calls.push('configure'); box.config = config; box.listeners.clear() },
  fetch () { box.calls.push('fetch'); return Promise.resolve(box.state) },
  addEventListener (fn) { box.calls.push('listen'); box.listeners.add(fn); return () => box.listeners.delete(fn) }
}
`
const reactNative = `
const box = globalThis.__appState = globalThis.__appState || { listeners: new Set() }
export const AppState = {
  addEventListener (type, fn) {
    if (type !== 'change') throw new Error('type')
    box.listeners.add(fn)
    return { remove: () => box.listeners.delete(fn) }
  }
}
`
const hooks = `
const stubs = {
  '@react-native-community/netinfo': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(netinfo)}),
  'react-native': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(reactNative)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

const load = () => import('../src/online.native.js')
const box = () => globalThis.__netinfo
const appState = () => globalThis.__appState
const emit = (state) => { for (const fn of [...box().listeners]) fn(state) }
const toForeground = (status = 'active') => { for (const fn of [...appState().listeners]) fn(status) }
const settle = () => new Promise((resolve) => setImmediate(resolve))

const UNKNOWN = { type: 'unknown', isConnected: null, isInternetReachable: null }
const REACHABLE = { type: 'wifi', isConnected: true, isInternetReachable: true }
const MEASURING = { type: 'cellular', isConnected: true, isInternetReachable: null }
const UNREACHABLE = { type: 'wifi', isConnected: true, isInternetReachable: false }
const DISCONNECTED = { type: 'none', isConnected: false, isInternetReachable: false }
const DISCONNECTED_UNKNOWN = { type: 'none', isConnected: false, isInternetReachable: null }

test('the reachability probe is disabled before the first fetch', async (t) => {
  const { isOnline } = await load()
  box().state = REACHABLE
  t.is(isOnline(), true)
  t.alike(box().calls, ['configure', 'fetch'], 'configure first, once')
  t.is(typeof box().config.reachabilityShouldRun, 'function')
  t.is(box().config.reachabilityShouldRun(), false, 'never probes an external URL')
  t.absent('reachabilityUrl' in box().config)
  await settle()
  isOnline()
  t.alike(box().calls, ['configure', 'fetch'], 'configured and asked once')
})

test('mapping: only "not connected" is offline, reachability is ignored', async (t) => {
  const { onlineFromState } = await load()
  t.is(onlineFromState(UNKNOWN), true, 'unknown')
  t.is(onlineFromState(null), true, 'no state yet')
  t.is(onlineFromState(undefined), true)
  t.is(onlineFromState({}), true)
  t.is(onlineFromState(REACHABLE), true, 'reachable')
  t.is(onlineFromState(MEASURING), true, 'connected, reachability not measured')
  t.is(onlineFromState(UNREACHABLE), true, 'connected, reachability false: online')
  t.is(onlineFromState(DISCONNECTED), false, 'disconnected')
  t.is(onlineFromState(DISCONNECTED_UNKNOWN), false, 'disconnected, reachability unknown')
})

test('subscribe: notified on changes only, listeners removed with the last subscriber', async (t) => {
  const { isOnline, subscribeOnline } = await load()
  const a = []
  const b = []
  const stopA = subscribeOnline((v) => a.push(v))
  const stopB = subscribeOnline((v) => b.push(v))
  t.is(box().listeners.size, 1, 'one NetInfo listener for all subscribers')
  t.is(appState().listeners.size, 1, 'one AppState listener')
  t.is(box().calls.filter((c) => c === 'configure').length, 1, 'never configured again')

  emit(UNREACHABLE)
  t.is(isOnline(), true)
  emit(DISCONNECTED)
  t.is(isOnline(), false)
  emit(DISCONNECTED_UNKNOWN)
  emit(REACHABLE)
  t.is(isOnline(), true)
  t.alike(a, [false, true])
  t.alike(b, [false, true])

  stopA()
  stopA()
  t.is(box().listeners.size, 1, 'still one subscriber')
  stopB()
  t.is(box().listeners.size, 0, 'NetInfo listener removed')
  t.is(appState().listeners.size, 0, 'AppState listener removed')
  emit(DISCONNECTED)
  t.alike(a, [false, true])
})

test('back to the foreground: asks NetInfo again and notifies a change', async (t) => {
  const { isOnline, subscribeOnline } = await load()
  const seen = []
  const stopSub = subscribeOnline((v) => seen.push(v))
  emit(REACHABLE)
  t.is(isOnline(), true)

  // The network went away while in the background and no event arrived.
  box().state = DISCONNECTED
  const fetches = () => box().calls.filter((c) => c === 'fetch').length
  const before = fetches()
  toForeground('background')
  toForeground('inactive')
  t.is(fetches(), before, 'only a return to active asks again')
  toForeground('active')
  t.is(fetches(), before + 1)
  await settle()
  t.is(isOnline(), false)
  t.alike(seen, [false])

  box().state = DISCONNECTED
  toForeground('active')
  await settle()
  t.alike(seen, [false], 'no change, no notification')

  // An event newer than the fetch wins over the fetch's answer.
  box().state = DISCONNECTED
  toForeground('active')
  emit(REACHABLE)
  await settle()
  t.is(isOnline(), true)
  t.alike(seen, [false, true])

  stopSub()
  t.is(appState().listeners.size, 0)
})

test('same exported API as online.web.js', async (t) => {
  const native = await load()
  const web = await import('../src/online.web.js')
  const names = (m) => Object.keys(m).filter((k) => typeof m[k] === 'function').sort()
  t.alike(names(native).filter((k) => k !== 'onlineFromState'), names(web))
})
