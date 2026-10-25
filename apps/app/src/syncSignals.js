// Fold sync lines into UI hints, never remote have/admitted lengths into
// local growth. Baselines survive preemption; all state updates are pure.

export const EMPTY_SIGNALS = Object.freeze({
  runId: null,
  once: null,
  ready: false,
  peer: false,
  reconnecting: false,
  unverified: false,
  lengths: {},
  fresh: {},
  ownLength: null,
  lastDownloadAt: null,
  startedAt: null
})

export function foldSignal (state, name, data, now) {
  const next = { ...state }
  if (name === 'sync.started') {
    return {
      ...next,
      runId: data.runId,
      once: data.once,
      ready: false,
      peer: false,
      reconnecting: false,
      unverified: false,
      startedAt: now
    }
  }
  if (name === 'warning') {
    if (data.line.startsWith('aviso: sem conexão com o semeador')) {
      next.reconnecting = true
      next.peer = false
    } else if (data.line.startsWith('aviso: o endereço configurado não respondeu como um semeador verificado')) {
      next.unverified = true
    }
    return next
  }
  if (data.runId !== state.runId) return next
  if (name === 'sync.stopped') {
    next.runId = null
    next.once = null
    next.ready = false
    next.peer = false
    next.reconnecting = false
    const downloaded = data.result && data.result.downloaded
    if (downloaded && typeof downloaded === 'object') {
      // A stopped run provides baselines, not evidence of new growth.
      next.lengths = {
        ...state.lengths,
        ...Object.fromEntries(Object.entries(downloaded).map(([key, n]) => [key, Math.max(state.lengths[key] ?? n, n)]))
      }
    }
    return next
  }
  if (name !== 'sync.event') return next
  const line = data.line
  if (line === 'sync ready') next.ready = true
  if (/^peer (member|seeder) [0-9a-f]{8}$/.test(line)) {
    next.peer = true
    next.reconnecting = false
  }
  if (/^peer seeder [0-9a-f]{8} não verificado$/.test(line)) next.unverified = true
  const download = /^downloaded ([0-9a-f]{64}) (0|[1-9][0-9]*)$/.exec(line)
  if (download) {
    const key = download[1]
    const n = Number(download[2])
    const known = state.lengths[key]
    // Activation has no baseline line. A first download is a fresh hint,
    // even when it comes from re-activating a previously gated replica.
    if (known === undefined || n > known) {
      next.fresh = { ...state.fresh, [key]: n }
      next.lastDownloadAt = now
    }
    next.lengths = { ...state.lengths, [key]: Math.max(known ?? n, n) }
  }
  const own = /^diário próprio sincronizado \((0|[1-9][0-9]*)\)$/.exec(line)
  if (own) {
    const n = Number(own[1])
    if (state.ownLength !== null && n > state.ownLength) next.fresh = { ...state.fresh, own: n }
    next.ownLength = Math.max(state.ownLength ?? n, n)
  }
  return next
}

export function ackFresh (state, keys = null) {
  const fresh = keys === null ? {} : { ...state.fresh }
  if (keys !== null) {
    for (const key of keys) delete fresh[key]
  }
  return { ...state, fresh }
}

export function hasFresh (state, { except = null } = {}) {
  return freshKeys(state).some((key) => key !== except && key !== 'own')
}

export function freshKeys (state) {
  return Object.keys(state.fresh)
}

// A once run is the recovery after an unlock only while `recovering`; the
// browser node's write gate also runs once runs around every publish, which
// read as plain syncing.
export function chipState ({ online, connected, active, wanted, signals, now, recovering = false }) {
  if (online === false) return 'sem rede'
  if (!connected) return 'sem conexão'
  if (active && active.once) return recovering ? 'recuperando…' : 'sincronizando…'
  const elapsed = signals.lastDownloadAt === null ? null : now - signals.lastDownloadAt
  if (active && signals.peer && elapsed !== null && elapsed >= 0 && elapsed < 5000) return 'sincronizando…'
  if (active && signals.peer) return 'sincronização automática'
  if ((active && signals.reconnecting) || (!active && wanted)) return 'reconectando…'
  if (active) return 'conectando…'
  return 'pausado'
}
