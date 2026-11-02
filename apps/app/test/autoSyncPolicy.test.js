'use strict'

const { register } = require('node:module')
const test = require('brittle')

const reactNative = `
const box = globalThis.__appState = globalThis.__appState || { listeners: new Set(), currentState: undefined }
export const AppState = {
  get currentState () { return box.currentState },
  set currentState (state) { box.currentState = state },
  addEventListener (type, fn) {
    if (type !== 'change') throw new Error('type')
    box.listeners.add(fn)
    return { remove: () => box.listeners.delete(fn) }
  }
}
`
const hooks = `
const stubs = {
  'react-native': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(reactNative)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

const load = () => import('../src/autoSyncPolicy.js')

const ready = { wanted: true, phase: 'ready', online: true, active: null, starting: false, recovering: false, reconciling: false, backoffUntil: 0, awaitingRestartUntil: 0, now: 1000 }

test('wantsStart: the gate table', async (t) => {
  const { wantsStart } = await load()
  t.is(wantsStart(ready), true)
  t.is(wantsStart({ ...ready, online: undefined }), true)
  t.is(wantsStart({ ...ready, visible: true }), true)
  t.is(wantsStart({ ...ready, visible: undefined }), true)
  t.is(wantsStart({ ...ready, visible: false }), false)
  t.is(wantsStart({ ...ready, backoffUntil: undefined, awaitingRestartUntil: undefined }), true)
  t.is(wantsStart({ ...ready, wanted: false }), false)
  t.is(wantsStart({ ...ready, phase: 'booting' }), false)
  t.is(wantsStart({ ...ready, online: false }), false)
  t.is(wantsStart({ ...ready, active: { once: false } }), false)
  t.is(wantsStart({ ...ready, starting: true }), false)
  t.is(wantsStart({ ...ready, recovering: true }), false)
  t.is(wantsStart({ ...ready, reconciling: true }), false)
  t.is(wantsStart({ ...ready, backoffUntil: 1001 }), false)
  t.is(wantsStart({ ...ready, backoffUntil: 1000 }), true)
})

test('shouldStopForHidden: only a continuous run while hidden', async (t) => {
  const { shouldStopForHidden } = await load()
  for (const [active, hiddenStop] of [[null, false], [{ once: true }, false], [{ once: false }, true], [{}, false]]) {
    t.is(shouldStopForHidden({ active, visible: false }), hiddenStop)
    t.is(shouldStopForHidden({ active, visible: true }), false)
    t.is(shouldStopForHidden({ active }), false)
  }
})

test('visibility: web events and missing browser globals', async (t) => {
  const web = await import('../src/visibility.web.js')
  const saved = ['document', 'window'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  t.teardown(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  delete globalThis.document
  delete globalThis.window
  t.is(web.isVisible(), true)
  web.subscribeVisible(() => t.fail('no browser events'))()
  globalThis.window = {}
  web.subscribeVisible(() => t.fail('no event listener support'))()

  globalThis.document = {}
  t.is(web.isVisible(), true)
  globalThis.document.visibilityState = 'prerender'
  t.is(web.isVisible(), true)
  globalThis.document.visibilityState = 'visible'
  globalThis.window = new EventTarget()
  const changes = []
  const unsubscribe = web.subscribeVisible((visible) => changes.push(visible))
  globalThis.window.dispatchEvent(new Event('pagehide'))
  globalThis.window.dispatchEvent(new Event('pageshow'))
  globalThis.document.visibilityState = 'hidden'
  t.is(web.isVisible(), false)
  globalThis.window.dispatchEvent(new Event('visibilitychange'))
  globalThis.window.dispatchEvent(new Event('pageshow'))
  globalThis.document.visibilityState = 'visible'
  globalThis.window.dispatchEvent(new Event('visibilitychange'))
  t.alike(changes, [false, true, false, false, true])
  unsubscribe()
  for (const name of ['visibilitychange', 'pagehide', 'pageshow']) {
    globalThis.window.dispatchEvent(new Event(name))
  }
  t.alike(changes, [false, true, false, false, true])
})

test('visibility: native AppState changes only, with unknown states visible', async (t) => {
  const native = await import('../src/visibility.native.js')
  const { AppState } = await import('react-native')
  const box = globalThis.__appState
  const emit = (state) => {
    AppState.currentState = state
    for (const fn of [...box.listeners]) fn(state)
  }
  const changes = []
  AppState.currentState = undefined
  t.is(native.isVisible(), true, 'first paint stays visible')
  const unsubscribe = native.subscribeVisible((visible) => changes.push(visible))
  t.teardown(unsubscribe)
  t.is(box.listeners.size, 1, 'subscribes to AppState')
  t.alike(changes, [], 'no call at registration')
  for (const [state, visible, expected] of [
    [undefined, true, []],
    ['active', true, []],
    ['background', false, [false]],
    ['background', false, [false]],
    ['inactive', false, [false]],
    ['unknown', true, [false, true]],
    ['active', true, [false, true]],
    [null, true, [false, true]],
    ['inactive', false, [false, true, false]],
    ['active', true, [false, true, false, true]]
  ]) {
    emit(state)
    t.is(native.isVisible(), visible, String(state))
    t.alike(changes, expected, 'only boolean changes: ' + state)
  }
  unsubscribe()
  t.is(box.listeners.size, 0, 'removes the AppState listener')
  emit('background')
  t.is(native.isVisible(), false)
  t.alike(changes, [false, true, false, true], 'nothing after unsubscribe')

  const hiddenChanges = []
  const unsubscribeHidden = native.subscribeVisible((visible) => hiddenChanges.push(visible))
  t.teardown(unsubscribeHidden)
  t.alike(hiddenChanges, [], 'no call when subscribing while hidden')
  emit('inactive')
  t.alike(hiddenChanges, [], 'compares with the initial hidden state')
  emit('active')
  t.alike(hiddenChanges, [true])
  unsubscribeHidden()
})

test('visibility: the shell pauses on web always, on native only the hosted node', async (t) => {
  const web = await import('../src/visibility.web.js')
  const native = await import('../src/visibility.native.js')
  for (const hosted of [true, false, undefined, null]) {
    t.is(web.pausesWhenHidden(hosted), true, 'web ' + hosted)
    t.is(native.pausesWhenHidden(hosted), hosted === true, 'native ' + hosted)
    for (const visible of [true, false]) {
      t.is(web.effectiveVisible(visible, hosted), visible, 'web ' + visible + ' ' + hosted)
      t.is(native.effectiveVisible(visible, hosted), visible || hosted !== true, 'native ' + visible + ' ' + hosted)
    }
  }
})

test('wantsStart: no start while awaiting the node restart', async (t) => {
  const { wantsStart } = await load()
  t.is(wantsStart({ ...ready, awaitingRestartUntil: 1500 }), false)
  t.is(wantsStart({ ...ready, awaitingRestartUntil: 1000 }), true)
  t.is(wantsStart({ ...ready, awaitingRestartUntil: 900 }), true)
})

test('afterPreempt: continuous runs wait for the node, once runs do not', async (t) => {
  const { afterPreempt, PREEMPT_GRACE_MS } = await load()
  t.alike(afterPreempt({ once: false, wanted: true, now: 5000 }), { awaitingRestartUntil: 5000 + PREEMPT_GRACE_MS })
  t.is(afterPreempt({ once: false, wanted: false, now: 5000 }), null)
  t.is(afterPreempt({ once: true, wanted: true, now: 5000 }), null)
})

test('graceExpired: reconcile once the grace passes with no run', async (t) => {
  const { graceExpired } = await load()
  t.is(graceExpired({ awaitingRestartUntil: 0, active: null, now: 9000 }), false)
  t.is(graceExpired({ awaitingRestartUntil: 5000, active: null, now: 4999 }), false)
  t.is(graceExpired({ awaitingRestartUntil: 5000, active: null, now: 5000 }), true)
  t.is(graceExpired({ awaitingRestartUntil: 5000, active: { once: false }, now: 9000 }), false)
})

test('nextBackoff: the ladder, its cap and its reset after a healthy run', async (t) => {
  const { nextBackoff } = await load()
  t.is(nextBackoff({ reason: 'preempted', startedAt: 0, stoppedAt: 1000, previousMs: 0 }), null)
  t.is(nextBackoff({ reason: 'stopped', startedAt: 0, stoppedAt: 1000, previousMs: 8000 }), 0)
  let ms = 0
  const ladder = []
  for (let i = 0; i < 8; i++) {
    ms = nextBackoff({ reason: 'error', startedAt: 0, stoppedAt: 1000, previousMs: ms })
    ladder.push(ms)
  }
  t.alike(ladder, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
  t.is(nextBackoff({ reason: 'error', startedAt: 0, stoppedAt: 1000, previousMs: 32000 }), 60000)
  t.is(nextBackoff({ reason: 'error', startedAt: 0, stoppedAt: 1000, previousMs: 60000 }), 60000)
  for (const reason of ['done', 'timeout', 'error']) {
    t.is(nextBackoff({ reason, startedAt: 0, stoppedAt: 60000, previousMs: 32000 }), 2000)
    t.is(nextBackoff({ reason, startedAt: 0, stoppedAt: 59999, previousMs: 0 }), 2000)
    t.is(nextBackoff({ reason, startedAt: 0, stoppedAt: 59999, previousMs: 2000 }), 4000)
  }
})

test('startFailure: the failure map', async (t) => {
  const { startFailure } = await load()
  t.is(startFailure({ code: 'USAGE', message: 'sincronização já em andamento' }), 'ignore')
  t.is(startFailure({ code: 'USAGE', message: 'outro erro' }), 'backoff')
  t.is(startFailure({ code: 'NOT_FOUND', message: 'sem identidade' }), 'give-up')
  t.is(startFailure({ code: 'TIMEOUT', uncertain: true }), 'reconcile')
  t.is(startFailure({ code: 'INTERNAL', message: 'x', uncertain: true }), 'reconcile')
  t.is(startFailure({ code: 'TIMEOUT', uncertain: false }), 'backoff')
  t.is(startFailure({ code: 'INTERNAL', message: 'x' }), 'backoff')
})

test('idle lease waits exactly 45 seconds independently of the failure ladder', async (t) => {
  const { IDLE_GAP_MS, nextBackoff, wantsStart } = await load()
  t.is(IDLE_GAP_MS, 45000)
  for (const previousMs of [0, 2000, 8000, 60000]) {
    for (const stoppedAt of [8000, 60000]) {
      const ms = nextBackoff({ reason: 'idle', startedAt: 0, stoppedAt, previousMs })
      t.is(ms, 45000)
      const state = { ...ready, visible: true, backoffUntil: stoppedAt + ms }
      t.is(wantsStart({ ...state, now: stoppedAt + 2000 }), false)
      t.is(wantsStart({ ...state, now: stoppedAt + 44999 }), false)
      t.is(wantsStart({ ...state, now: stoppedAt + 45000 }), true)
    }
  }
})

test('namesQuiet permits the idle gap and preserves the five second quiet window', async (t) => {
  const { namesQuiet } = await load()
  const base = { wanted: true, startedAt: null, idleSince: null, now: 5000, quietMs: 5000 }
  t.is(namesQuiet(base), false)
  t.is(namesQuiet({ ...base, wanted: false }), true)
  t.is(namesQuiet({ ...base, idleSince: 5000 }), true)
  t.is(namesQuiet({ ...base, idleSince: 0 }), true)
  t.is(namesQuiet({ ...base, idleSince: undefined }), false)
  t.is(namesQuiet({ ...base, startedAt: undefined }), false)
  t.is(namesQuiet({ ...base, startedAt: 1 }), false)
  t.is(namesQuiet({ ...base, startedAt: 0 }), true)
  t.is(namesQuiet({ ...base, startedAt: 0, now: 4999 }), false)
})

test('refreshPlan: a pull waits or starts only when auto-sync could run now', async (t) => {
  const { refreshPlan } = await load()
  const base = { connected: true, phase: 'ready', online: true, visible: true, wanted: true, gaveUp: false, busy: false, active: null, seederUp: false }
  t.alike(refreshPlan(base), { action: 'start' })
  t.alike(refreshPlan({ ...base, online: undefined, visible: undefined }), { action: 'start' })
  for (const blocked of [{ online: false }, { wanted: false }, { gaveUp: true }, { connected: false }, { phase: 'connecting' }, { visible: false }, { busy: true }]) {
    t.alike(refreshPlan({ ...base, ...blocked }), { action: 'skip' }, JSON.stringify(blocked))
    t.alike(refreshPlan({ ...base, ...blocked, active: { runId: 4, once: false } }), { action: 'skip' }, 'no wait either: ' + JSON.stringify(blocked))
  }
  t.alike(refreshPlan({ ...base, active: { runId: 4, once: true } }), { action: 'skip' })
  t.alike(refreshPlan({ ...base, active: { runId: 4, once: false } }), { action: 'wait', runId: 4, peerUp: false })
  t.alike(refreshPlan({ ...base, active: { runId: 4, once: false }, seederUp: true }), { action: 'wait', runId: 4, peerUp: true })
  // The core node (native, varanda-serve) has no lease: a refresh just reads.
  t.alike(refreshPlan({ ...base, leased: false }), { action: 'skip' })
  t.alike(refreshPlan({ ...base, leased: false, active: { runId: 4, once: false }, seederUp: true }), { action: 'skip' })
})

test('shouldStopForHidden: the idle gap keeps the node intent, released once hidden', async (t) => {
  const { shouldStopForHidden } = await load()
  t.is(shouldStopForHidden({ active: null, visible: false, idleIntent: true }), true)
  t.is(shouldStopForHidden({ active: null, visible: true, idleIntent: true }), false)
  t.is(shouldStopForHidden({ active: null, visible: false, idleIntent: false }), false)
  t.is(shouldStopForHidden({ active: { once: true }, visible: false, idleIntent: true }), false, 'never a once run')
  t.is(shouldStopForHidden({ active: { once: false }, visible: false, idleIntent: true }), true)
})

test('visibilityChange: new hidden periods, and showing the page ends the idle gap', async (t) => {
  const { visibilityChange } = await load()
  t.alike(visibilityChange({ wasVisible: true, visible: false }), { newPeriod: true, clearIdle: false })
  t.alike(visibilityChange({ wasVisible: false, visible: true }), { newPeriod: true, clearIdle: true })
  t.alike(visibilityChange({ wasVisible: true, visible: true }), { newPeriod: false, clearIdle: false })
  t.alike(visibilityChange({ wasVisible: false, visible: false }), { newPeriod: false, clearIdle: false })
})

test('backoff parts: clearing the idle gap starts at once unless a failure backoff is pending', async (t) => {
  const { effectiveBackoff, wantsStart, IDLE_GAP_MS } = await load()
  const now = 10000
  const idle = { failureUntil: 0, idleUntil: now + IDLE_GAP_MS }
  t.is(effectiveBackoff(idle), now + IDLE_GAP_MS)
  t.is(wantsStart({ ...ready, now, backoffUntil: effectiveBackoff(idle) }), false)
  // A new run or a shown page clears only the idle part.
  t.is(wantsStart({ ...ready, now, backoffUntil: effectiveBackoff({ ...idle, idleUntil: 0 }) }), true)
  t.is(effectiveBackoff({ failureUntil: now + 4000, idleUntil: 0 }), now + 4000)
  t.is(effectiveBackoff({ failureUntil: now + 4000, idleUntil: now + IDLE_GAP_MS }), now + IDLE_GAP_MS)
  t.is(effectiveBackoff({}), 0)
})

test('reconcileIdle: the idle deadline stands only after an idle stop of the current run', async (t) => {
  const { reconcileIdle, FIRST_BACKOFF_MS } = await load()
  const now = 50000
  // A preempted run that was not restarted: an old idle deadline is dropped.
  t.alike(reconcileIdle({ failureUntil: 0, idleUntil: now + 30000, lastStopIdle: false, now }), { failureUntil: now + FIRST_BACKOFF_MS, idleUntil: 0 })
  t.alike(reconcileIdle({ failureUntil: now + 8000, idleUntil: 0, lastStopIdle: false, now }), { failureUntil: now + 8000, idleUntil: 0 })
  t.alike(reconcileIdle({ failureUntil: 0, idleUntil: now + 30000, lastStopIdle: true, now }), { failureUntil: 0, idleUntil: now + 30000 })
  t.alike(reconcileIdle({ failureUntil: 0, idleUntil: 0, lastStopIdle: true, now }), { failureUntil: 0, idleUntil: now + FIRST_BACKOFF_MS })
})

test('namesQuiet: no idle reads while a failure backoff is pending', async (t) => {
  const { namesQuiet } = await load()
  const base = { wanted: true, startedAt: null, idleSince: 1000, now: 5000, quietMs: 5000 }
  t.is(namesQuiet(base), true)
  t.is(namesQuiet({ ...base, failureUntil: 0 }), true)
  t.is(namesQuiet({ ...base, failureUntil: 5000 }), true, 'an expired backoff no longer holds')
  t.is(namesQuiet({ ...base, failureUntil: 5001 }), false)
  t.is(namesQuiet({ ...base, idleSince: null, failureUntil: 0 }), false)
  t.is(namesQuiet({ ...base, wanted: false, failureUntil: 9000 }), true)
  t.is(namesQuiet({ ...base, idleSince: null, startedAt: 0, failureUntil: 9000 }), true, 'a quiet run still reads')
})
