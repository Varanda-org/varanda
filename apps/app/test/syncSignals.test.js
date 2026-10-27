// Sync hints distinguish local growth from baselines and remote inventory.
'use strict'

const test = require('brittle')
const load = () => import('../src/syncSignals.js')
const K = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

function freeze (value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

test('download hints survive preemption without repeating known growth', async (t) => {
  const { EMPTY_SIGNALS, foldSignal, ackFresh, hasFresh, freshKeys } = await load()
  t.ok(Object.isFrozen(EMPTY_SIGNALS))
  let state = freeze(EMPTY_SIGNALS)
  const fold = (name, data, now) => {
    const before = state
    state = foldSignal(freeze(state), name, freeze(data), now)
    t.not(state, before, 'fold returns a new state')
  }
  fold('sync.started', { runId: 1, once: false }, 0)
  t.is(state.startedAt, 0)
  t.is(state.once, false)
  fold('sync.event', { runId: 1, line: 'sync ready' }, 1)
  t.is(state.ready, true)
  t.is(state.peer, false)
  fold('sync.event', { runId: 1, line: 'peer seeder abcdef01' }, 2)
  t.is(state.peer, true)
  fold('sync.event', { runId: 1, line: 'downloaded ' + K + ' 5' }, 3)
  t.alike(state.fresh, { [K]: 5 })
  t.is(state.lastDownloadAt, 3)
  t.is(hasFresh(state), true)
  t.alike(freshKeys(state), [K])
  const unacked = freeze(state)
  state = ackFresh(unacked)
  t.alike(state.fresh, {})
  t.alike(unacked.fresh, { [K]: 5 })
  fold('sync.stopped', { runId: 1, reason: 'preempted', result: { downloaded: { [K]: 5, [OTHER]: 8 } } }, 4)
  t.alike(state.lengths, { [K]: 5, [OTHER]: 8 })
  t.alike(state.fresh, {})
  t.is(state.runId, null)
  t.is(state.once, null)
  t.is(state.ready, false)
  t.is(state.peer, false)
  t.is(state.reconnecting, false)
  fold('sync.started', { runId: 2, once: false }, 5)
  t.is(state.startedAt, 5)
  fold('sync.event', { runId: 2, line: 'downloaded ' + K + ' 5' }, 6)
  fold('sync.event', { runId: 2, line: 'downloaded ' + OTHER + ' 8' }, 7)
  t.alike(state.fresh, {})
  t.is(state.lastDownloadAt, 3)
  fold('sync.event', { runId: 2, line: 'downloaded ' + K + ' 7' }, 8)
  t.alike(state.fresh, { [K]: 7 })
  t.is(state.lastDownloadAt, 8)
  fold('sync.event', { runId: 2, line: 'downloaded ' + K + ' 6' }, 9)
  t.is(state.lengths[K], 7)
  t.is(state.fresh[K], 7)
  t.is(state.lastDownloadAt, 8)
  fold('sync.stopped', { runId: 2, reason: 'done', result: { downloaded: { [K]: 4, [OTHER]: 10 } } }, 10)
  t.alike(state.lengths, { [K]: 7, [OTHER]: 10 })
  t.alike(state.fresh, { [K]: 7 }, 'stop preserves hints without adding any')
  t.alike(EMPTY_SIGNALS.lengths, {})
  t.alike(EMPTY_SIGNALS.fresh, {})
})

test('own diary starts with a baseline and only its later growth is fresh', async (t) => {
  const { EMPTY_SIGNALS, foldSignal, ackFresh, hasFresh, freshKeys } = await load()
  let state = foldSignal(EMPTY_SIGNALS, 'sync.started', { runId: 1, once: true }, 0)
  const own = (n) => {
    state = foldSignal(freeze(state), 'sync.event', freeze({ runId: state.runId, line: 'diário próprio sincronizado (' + n + ')' }), 1)
  }
  own(3)
  own(3)
  t.is(state.ownLength, 3)
  t.alike(state.fresh, {})
  own(4)
  t.is(state.ownLength, 4)
  t.alike(state.fresh, { own: 4 })
  t.is(state.lastDownloadAt, null)
  t.is(hasFresh(state), false)
  t.alike(freshKeys(state), ['own'])
  own(2)
  t.is(state.ownLength, 4)
  state = foldSignal(freeze(state), 'sync.stopped', { runId: 1, reason: 'preempted' }, 2)
  state = foldSignal(freeze(state), 'sync.started', { runId: 2, once: false }, 3)
  t.is(state.ownLength, 4)
  t.alike(state.fresh, { own: 4 })
  state = ackFresh(freeze(state), ['own'])
  own(4)
  t.alike(state.fresh, {})
  own(5)
  t.alike(state.fresh, { own: 5 })
})

test('fresh acknowledgements may select own or replica keys', async (t) => {
  const { EMPTY_SIGNALS, ackFresh, hasFresh, freshKeys } = await load()
  const state = freeze({ ...EMPTY_SIGNALS, fresh: { [K]: 0, [OTHER]: 7, own: 4 } })
  t.is(hasFresh(state, { except: K }), true)
  t.alike(freshKeys(state), [K, OTHER, 'own'])
  const selected = ackFresh(state, [OTHER, 'own', 'missing'])
  t.alike(selected.fresh, { [K]: 0 })
  t.is(hasFresh(selected), true, 'zero is still a fresh first download')
  t.is(hasFresh(selected, { except: K }), false)
  t.alike(ackFresh(state, []).fresh, state.fresh)
  t.alike(ackFresh(state).fresh, {})
  t.alike(state.fresh, { [K]: 0, [OTHER]: 7, own: 4 })
})

test('warnings track reconnection and unverified peers until the next run', async (t) => {
  const { EMPTY_SIGNALS, foldSignal } = await load()
  let state = foldSignal(EMPTY_SIGNALS, 'sync.started', { runId: 1, once: false }, 0)
  const fold = (name, line) => { state = foldSignal(freeze(state), name, freeze({ runId: 1, line }), 1) }
  fold('sync.event', 'peer seeder abcdef01 não verificado')
  t.is(state.unverified, true)
  t.is(state.peer, false)
  fold('sync.event', 'peer member abcdef01')
  t.is(state.peer, true)
  fold('warning', 'aviso: sem conexão com o semeador; nova tentativa em 2 s')
  t.is(state.reconnecting, true)
  t.is(state.peer, false)
  fold('sync.event', 'peer seeder abcdef01')
  t.is(state.reconnecting, false)
  t.is(state.peer, true)
  state = foldSignal(freeze(state), 'sync.started', { runId: 2, once: false }, 2)
  t.is(state.unverified, false)
  t.is(state.peer, false)
  t.is(state.ready, false)
  t.is(state.reconnecting, false)
  state = foldSignal(freeze(state), 'warning', { line: 'aviso: o endereço configurado não respondeu como um semeador verificado (abcdef01)' }, 3)
  t.is(state.unverified, true)
})

test('stale runs, remote lengths and unrelated or malformed lines are ignored', async (t) => {
  const { EMPTY_SIGNALS, foldSignal } = await load()
  const state = freeze(foldSignal(EMPTY_SIGNALS, 'sync.started', { runId: 2, once: false }, 0))
  for (const line of ['sync ready', 'peer member abcdef01', 'downloaded ' + K + ' 9', 'diário próprio sincronizado (9)']) {
    t.alike(foldSignal(state, 'sync.event', { runId: 1, line }, 1), state)
  }
  t.alike(foldSignal(state, 'sync.stopped', { runId: 1, result: { downloaded: { [K]: 9 } } }, 1), state)
  for (const line of [
    'have ' + K + ' 9', 'admitted ' + K + ' 9', 'diário próprio atrasado (3/9)',
    'peer member ABCDEF01', 'peer seeder abcdef01 extra', 'peer stranger abcdef01',
    'downloaded ' + K + ' -1', 'downloaded ' + K + ' 01', 'downloaded ' + K + ' 1.5',
    'downloaded ' + K.toUpperCase() + ' 5', 'downloaded abcd 5',
    'diário próprio sincronizado (01)', 'diário próprio sincronizado (-1)', 'unrelated'
  ]) t.alike(foldSignal(state, 'sync.event', { runId: 2, line }, 1), state)
  t.alike(foldSignal(state, 'warning', { line: 'aviso: diário ignorado' }, 1), state)
  t.alike(foldSignal(state, 'unknown', { runId: 2 }, 1), state)
  const zero = foldSignal(state, 'sync.event', { runId: 2, line: 'downloaded ' + K + ' 0' }, 1)
  t.alike(zero.fresh, { [K]: 0 })
  for (const result of [undefined, {}, { downloaded: null }, { downloaded: 5 }]) {
    const stopped = foldSignal(freeze(zero), 'sync.stopped', freeze({ runId: 2, result }), 2)
    t.is(stopped.runId, null)
    t.alike(stopped.lengths, { [K]: 0 })
  }
})

test('chip labels follow connectivity, recovery, growth and reconnect precedence', async (t) => {
  const { EMPTY_SIGNALS, chipState } = await load()
  const base = { online: true, connected: true, active: { once: false }, wanted: true, signals: EMPTY_SIGNALS, now: 10000 }
  const peer = { ...EMPTY_SIGNALS, peer: true }
  const recent = { ...peer, lastDownloadAt: 9999 }
  const cases = [
    [{ online: false, connected: false, active: { once: true } }, 'sem rede'],
    [{ connected: false, active: { once: true } }, 'sem conexão'],
    [{ active: { once: true }, signals: recent, recovering: true }, 'recuperando…'],
    [{ active: { once: true }, signals: recent }, 'sincronizando…'],
    [{ active: { once: true }, signals: EMPTY_SIGNALS, recovering: false }, 'sincronizando…'],
    [{ signals: recent }, 'sincronizando…'],
    [{ now: 0, signals: { ...peer, lastDownloadAt: 0 } }, 'sincronizando…'],
    [{ signals: { ...peer, lastDownloadAt: 5001 } }, 'sincronizando…'],
    [{ signals: { ...peer, lastDownloadAt: 5000 } }, 'sincronização automática'],
    [{ signals: { ...peer, lastDownloadAt: 10001 } }, 'sincronização automática'],
    [{ signals: { ...peer, reconnecting: true } }, 'sincronização automática'],
    [{ signals: peer }, 'sincronização automática'],
    [{ signals: { ...EMPTY_SIGNALS, reconnecting: true } }, 'reconectando…'],
    [{ active: null }, 'reconectando…'],
    [{ active: null, signals: { ...EMPTY_SIGNALS, idleSince: 0 } }, 'em pausa'],
    [{ active: null, signals: { ...EMPTY_SIGNALS, idleSince: 9000 } }, 'em pausa'],
    [{ active: null, signals: { ...EMPTY_SIGNALS, idleSince: 9000 }, wanted: false }, 'pausado'],
    [{ active: null, signals: { ...EMPTY_SIGNALS, idleSince: 9000 }, online: false }, 'sem rede'],
    [{ active: null, signals: { ...EMPTY_SIGNALS, idleSince: 9000 }, connected: false }, 'sem conexão'],
    [{ signals: { ...EMPTY_SIGNALS, idleSince: 9000 } }, 'conectando…'],
    [{}, 'conectando…'],
    [{ online: undefined }, 'conectando…'],
    [{ signals: { ...EMPTY_SIGNALS, lastDownloadAt: 9999 } }, 'conectando…'],
    [{ wanted: false }, 'conectando…'],
    [{ active: null, wanted: false, signals: recent }, 'pausado']
  ]
  for (const [overrides, expected] of cases) t.is(chipState(freeze({ ...base, ...overrides })), expected)
})

test('idle gap belongs only to the last continuous run and ends at the next start', async (t) => {
  const { EMPTY_SIGNALS, foldSignal } = await load()
  const run = freeze(foldSignal(EMPTY_SIGNALS, 'sync.started', { runId: 1, once: false }, 0))
  const idle = freeze(foldSignal(run, 'sync.stopped', { runId: 1, reason: 'idle' }, 8000))
  t.is(idle.runId, null)
  t.is(idle.idleSince, 8000)
  t.is(foldSignal(run, 'sync.stopped', { runId: 2, reason: 'idle' }, 8000).idleSince, null)
  for (const once of [true, false]) {
    const next = freeze(foldSignal(idle, 'sync.started', { runId: 2, once }, 9000))
    t.is(next.idleSince, null)
    for (const reason of ['idle', 'stopped', 'preempted', 'error']) {
      t.is(foldSignal(next, 'sync.stopped', { runId: 2, reason }, 10000).idleSince, !once && reason === 'idle' ? 10000 : null)
    }
  }
})

test('refresh waits for settled inventory, ignoring early own sync and stale stops', async (t) => {
  const { waitForCatchUp } = await load()
  const wait = waitForCatchUp()
  t.teardown(wait.done)
  let finished = false
  wait.promise.then(() => { finished = true })
  wait.onEvent('sync.started', { runId: 1, once: false })
  wait.onEvent('sync.event', { runId: 1, line: 'sync ready' })
  wait.onEvent('sync.event', { runId: 1, line: 'peer seeder abcdef01' })
  wait.onEvent('sync.event', { runId: 1, line: 'diário próprio sincronizado (5)' })
  await Promise.resolve()
  t.is(finished, false, 'own diary can sync before inventory completes')
  wait.onEvent('sync.stopped', { runId: 1, reason: 'preempted' })
  wait.onEvent('sync.started', { runId: 2, once: true })
  wait.onEvent('sync.stopped', { runId: 2, reason: 'idle' })
  await Promise.resolve()
  t.is(finished, false, 'a once run is not the continuous lease')
  wait.onEvent('sync.started', { runId: 3, once: false })
  wait.onEvent('sync.stopped', { runId: 1, reason: 'idle' })
  await Promise.resolve()
  t.is(finished, false, 'a stale stop cannot complete this run')
  wait.onEvent('sync.stopped', { runId: 3, reason: 'idle' })
  await wait.promise
  t.is(finished, true)
})

test('refresh can await an existing run, time out, or cancel on teardown', async (t) => {
  const { waitForCatchUp } = await load()
  const active = waitForCatchUp({ runId: 7 })
  t.teardown(active.done)
  active.onEvent('sync.stopped', { runId: 7, reason: 'idle' })
  await active.promise
  const cancelled = waitForCatchUp()
  cancelled.done()
  await cancelled.promise
  const timeout = waitForCatchUp({ runId: 8, timeoutMs: 10 })
  t.teardown(timeout.done)
  await timeout.promise
  t.pass('all paths resolve without a request or a rejection')
})

test('refresh on a run whose verified link is already up starts the quiet window at once', async (t) => {
  const { waitForCatchUp } = await load()
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let finished = false
  const up = waitForCatchUp({ runId: 3, quietMs: 40, timeoutMs: 2000, peerUp: true })
  t.teardown(up.done)
  up.promise.then(() => { finished = true })
  await sleep(80)
  t.is(finished, true, 'no new peer line is needed')

  let pending = false
  const noRun = waitForCatchUp({ runId: null, quietMs: 40, timeoutMs: 2000, peerUp: true })
  t.teardown(noRun.done)
  noRun.promise.then(() => { pending = true })
  await sleep(80)
  t.is(pending, false, 'without a tracked run peerUp starts nothing')
})

test('refresh resolves once a verified seeder link goes quiet', async (t) => {
  const { waitForCatchUp } = await load()
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const track = (wait) => {
    const state = { finished: false }
    wait.promise.then(() => { state.finished = true })
    t.teardown(wait.done)
    return state
  }
  const D = 'downloaded ' + K + ' 3'

  const quiet = waitForCatchUp({ runId: 1, quietMs: 40, timeoutMs: 2000 })
  const q = track(quiet)
  quiet.onEvent('sync.event', { runId: 1, line: 'peer seeder abcdef01' })
  await sleep(15)
  t.is(q.finished, false, 'not before the quiet window')
  await sleep(60)
  t.is(q.finished, true, 'resolves about quietMs after the peer line')

  const busy = waitForCatchUp({ runId: 1, quietMs: 40, timeoutMs: 2000 })
  const b = track(busy)
  busy.onEvent('sync.event', { runId: 1, line: 'peer seeder abcdef01' })
  await sleep(25)
  busy.onEvent('sync.event', { runId: 1, line: D })
  await sleep(25)
  t.is(b.finished, false, 'a download pushes the window out')
  await sleep(50)
  t.is(b.finished, true)

  const own = waitForCatchUp({ runId: 1, quietMs: 40, timeoutMs: 2000 })
  const o = track(own)
  own.onEvent('sync.event', { runId: 1, line: 'peer seeder abcdef01' })
  await sleep(25)
  own.onEvent('sync.event', { runId: 1, line: 'diário próprio atrasado (3/9)' })
  await sleep(25)
  t.is(o.finished, false, 'own-diary catch-up from another device pushes the window out')
  await sleep(50)
  t.is(o.finished, true)

  const unverified = waitForCatchUp({ runId: 1, quietMs: 20, timeoutMs: 2000 })
  const u = track(unverified)
  unverified.onEvent('sync.event', { runId: 1, line: 'peer seeder abcdef01 não verificado' })
  unverified.onEvent('sync.event', { runId: 1, line: D })
  await sleep(60)
  t.is(u.finished, false, 'an unverified link never counts')

  const stopped = waitForCatchUp({ runId: 1, quietMs: 2000, timeoutMs: 2000 })
  const s = track(stopped)
  stopped.onEvent('sync.stopped', { runId: 1, reason: 'error' })
  await stopped.promise
  t.is(s.finished, true, 'a stop of the tracked run ends the wait')

  const late = waitForCatchUp({ timeoutMs: 30, quietMs: 2000 })
  track(late)
  late.onEvent('sync.started', { runId: 5, once: false })
  late.onEvent('sync.event', { runId: 5, line: 'peer seeder abcdef01' })
  await late.promise
  t.pass('timeout resolves')

  const cancelled = waitForCatchUp({ runId: 1, quietMs: 20 })
  cancelled.onEvent('sync.event', { runId: 1, line: 'peer seeder abcdef01' })
  cancelled.done()
  await cancelled.promise
  t.pass('done resolves')
})

test('seederVerified follows only the verified seeder link of the current run', async (t) => {
  const { EMPTY_SIGNALS, foldSignal } = await load()
  t.is(EMPTY_SIGNALS.seederVerified, false)
  let state = foldSignal(EMPTY_SIGNALS, 'sync.started', { runId: 1, once: false }, 0)
  const ev = (line) => { state = foldSignal(freeze(state), 'sync.event', freeze({ runId: 1, line }), 1) }
  const warn = (line) => { state = foldSignal(freeze(state), 'warning', freeze({ line }), 1) }
  ev('peer member abcdef01')
  t.is(state.peer, true)
  t.is(state.seederVerified, false, 'a member link is not the seeder')
  ev('peer seeder abcdef01 não verificado')
  t.is(state.seederVerified, false)
  ev('peer seeder abcdef01')
  t.is(state.seederVerified, true)
  ev('peer seeder abcdef01 não verificado')
  t.is(state.seederVerified, false, 'an unverified answer clears it')
  ev('peer seeder abcdef01')
  warn('aviso: sem conexão com o semeador; nova tentativa em 2 s')
  t.is(state.seederVerified, false, 'a reconnecting warning clears it')
  ev('peer seeder abcdef01')
  warn('aviso: o endereço configurado não respondeu como um semeador verificado (abcdef01)')
  t.is(state.seederVerified, false)
  ev('peer seeder abcdef01')
  state = foldSignal(freeze(state), 'sync.event', freeze({ runId: 9, line: 'peer seeder abcdef01 não verificado' }), 1)
  t.is(state.seederVerified, true, 'a stale run changes nothing')
  t.is(foldSignal(freeze(state), 'sync.stopped', { runId: 1, reason: 'idle' }, 2).seederVerified, false)
  t.is(foldSignal(freeze(state), 'sync.started', { runId: 2, once: false }, 2).seederVerified, false)
})

test('endIdle ends the idle gap without a new run', async (t) => {
  const { EMPTY_SIGNALS, chipState, endIdle, foldSignal } = await load()
  const run = freeze(foldSignal(EMPTY_SIGNALS, 'sync.started', { runId: 1, once: false }, 0))
  const idle = freeze(foldSignal(run, 'sync.stopped', { runId: 1, reason: 'idle' }, 8000))
  const chip = (signals) => chipState({ online: true, connected: true, active: null, wanted: true, signals, now: 9000 })
  t.is(chip(idle), 'em pausa')
  const ended = endIdle(idle)
  t.is(ended.idleSince, null)
  t.is(chip(ended), 'reconectando…', 'a failure backoff is not a pause')
  t.is(endIdle(run), run, 'nothing to end')
})

test('refresh: a failed start resolves at once, an adopted run is tracked', async (t) => {
  const { waitForCatchUp } = await load()
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const failed = waitForCatchUp({ timeoutMs: 2000 })
  t.teardown(failed.done)
  const start = Date.now()
  failed.fail()
  await failed.promise
  t.ok(Date.now() - start < 1000, 'no timeout wait')

  const following = waitForCatchUp({ runId: 3, timeoutMs: 2000 })
  t.teardown(following.done)
  let followed = false
  following.promise.then(() => { followed = true })
  following.fail()
  following.track(9)
  await sleep(10)
  t.is(followed, false, 'a wait that follows a run ignores fail and track')
  following.onEvent('sync.stopped', { runId: 3, reason: 'idle' })
  await following.promise

  const adopted = waitForCatchUp({ timeoutMs: 2000 })
  t.teardown(adopted.done)
  adopted.track(5)
  adopted.onEvent('sync.stopped', { runId: 5, reason: 'idle' })
  await adopted.promise
  t.pass('the adopted run counts once handed over')

  const up = waitForCatchUp({ timeoutMs: 2000, quietMs: 20 })
  t.teardown(up.done)
  up.track(6, { peerUp: true })
  await up.promise
  t.pass('an adopted run with its verified link up arms the quiet window')

  const ended = waitForCatchUp({ timeoutMs: 2000 })
  t.teardown(ended.done)
  ended.track(7, { ended: true })
  await ended.promise
  t.pass('a run that already stopped resolves the wait')
})

test('refresh: a dropped seeder link cancels the quiet window until the next verified link', async (t) => {
  const { waitForCatchUp } = await load()
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const D = 'downloaded ' + K + ' 4'
  const wait = waitForCatchUp({ runId: 1, quietMs: 30, timeoutMs: 2000 })
  t.teardown(wait.done)
  let finished = false
  wait.promise.then(() => { finished = true })
  wait.onEvent('sync.event', { runId: 1, line: 'peer seeder abcdef01' })
  await sleep(10)
  wait.onEvent('warning', { line: 'aviso: sem conexão com o semeador; nova tentativa em 2 s' })
  wait.onEvent('sync.event', { runId: 1, line: D })
  await sleep(60)
  t.is(finished, false, 'neither the window nor a download completes the wait without a link')
  wait.onEvent('warning', { line: 'aviso: diário abcdef01 ignorado (x)' })
  wait.onEvent('sync.event', { runId: 1, line: 'peer seeder abcdef01' })
  await sleep(60)
  t.is(finished, true, 'the next verified link re-arms it')

  const peerUp = waitForCatchUp({ runId: 2, quietMs: 30, timeoutMs: 2000, peerUp: true })
  t.teardown(peerUp.done)
  let pf = false
  peerUp.promise.then(() => { pf = true })
  peerUp.onEvent('warning', { line: 'aviso: sem conexão com o semeador' })
  await sleep(60)
  t.is(pf, false, 'a link already up when the wait began is cancelled too')
})
