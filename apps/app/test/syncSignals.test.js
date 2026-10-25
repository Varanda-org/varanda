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
    [{}, 'conectando…'],
    [{ online: undefined }, 'conectando…'],
    [{ signals: { ...EMPTY_SIGNALS, lastDownloadAt: 9999 } }, 'conectando…'],
    [{ wanted: false }, 'conectando…'],
    [{ active: null, wanted: false, signals: recent }, 'pausado']
  ]
  for (const [overrides, expected] of cases) t.is(chipState(freeze({ ...base, ...overrides })), expected)
})
