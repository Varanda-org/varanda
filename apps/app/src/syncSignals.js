// Fold sync lines into UI hints, never remote have/admitted lengths into
// local growth. Baselines survive preemption; all state updates are pure.
// `peer` is any peer link (member or seeder); `seederVerified` only the
// verified seeder link of the current run ('peer seeder <8 hex>'), cleared by
// an unverified answer, a reconnecting warning and every run start or stop.

export const EMPTY_SIGNALS = Object.freeze({
  runId: null,
  once: null,
  ready: false,
  peer: false,
  seederVerified: false,
  reconnecting: false,
  unverified: false,
  lengths: {},
  fresh: {},
  ownLength: null,
  lastDownloadAt: null,
  startedAt: null,
  idleSince: null
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
      seederVerified: false,
      reconnecting: false,
      unverified: false,
      startedAt: now,
      idleSince: null
    }
  }
  if (name === 'warning') {
    if (data.line.startsWith('aviso: sem conexão com o semeador')) {
      next.reconnecting = true
      next.peer = false
      next.seederVerified = false
    } else if (data.line.startsWith('aviso: o endereço configurado não respondeu como um semeador verificado')) {
      next.unverified = true
      next.seederVerified = false
    }
    return next
  }
  if (data.runId !== state.runId) return next
  if (name === 'sync.stopped') {
    next.idleSince = data.reason === 'idle' && state.once === false ? now : null
    next.runId = null
    next.once = null
    next.ready = false
    next.peer = false
    next.seederVerified = false
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
  if (/^peer seeder [0-9a-f]{8}$/.test(line)) next.seederVerified = true
  if (/^peer seeder [0-9a-f]{8} não verificado$/.test(line)) {
    next.unverified = true
    next.seederVerified = false
  }
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

// The idle gap is over without a new run (a start failed or gave up, or the
// node's continuous intent was stopped): no 'em pausa', no idle reads.
export function endIdle (state) {
  return state.idleSince === null ? state : { ...state, idleSince: null }
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
  if (!active && wanted && signals.idleSince != null) return 'em pausa'
  if ((active && signals.reconnecting) || (!active && wanted)) return 'reconectando…'
  if (active) return 'conectando…'
  return 'pausado'
}

// The RPC does not expose inventory completion. A verified seeder link that
// stays quiet for quietMs after the last download counts as caught up; the
// lease's idle stop (about 8 s later) or any other stop of the tracked run,
// and the bounded timeout, are the fallbacks. peerUp: the tracked run's
// verified link was already up when the wait began (no new peer line will
// come), so the quiet window starts at once. A dropped seeder link ('aviso:
// sem conexão com o semeador') cancels the window; the next verified
// 'peer seeder' line arms it again.
// track(runId, { peerUp, ended }): a run adopted without a sync.started this
// wait saw (the start's response, a reconcile) is followed from now on;
// ended: it already stopped. fail(): the start failed and no run is followed,
// so the wait resolves at once. Both leave a wait that follows a run alone.
export function waitForCatchUp ({ runId = null, timeoutMs = 10000, quietMs = 1500, peerUp = false } = {}) {
  let finish
  const promise = new Promise((resolve) => { finish = resolve })
  let quiet = null
  let finished = false
  const disarm = () => {
    clearTimeout(quiet)
    quiet = null
  }
  const done = () => {
    finished = true
    clearTimeout(timer)
    disarm()
    finish()
  }
  const timer = setTimeout(done, timeoutMs)
  const arm = () => {
    if (finished) return
    clearTimeout(quiet)
    quiet = setTimeout(done, quietMs)
  }
  if (peerUp && runId !== null) arm()
  return {
    promise,
    done,
    track (id, { peerUp: up = false, ended = false } = {}) {
      if (finished || runId !== null || id === null || id === undefined) return
      if (ended) { done(); return }
      runId = id
      if (up) arm()
    },
    fail () {
      if (runId === null) done()
    },
    onEvent (name, data) {
      if (name === 'sync.started') {
        runId = data.once === false ? data.runId : null
        disarm()
        return
      }
      if (name === 'warning') {
        if (runId !== null && data && typeof data.line === 'string' && data.line.startsWith('aviso: sem conexão com o semeador')) disarm()
        return
      }
      if (runId === null || !data || data.runId !== runId) return
      if (name === 'sync.stopped') {
        // A preempted run restarts and may still deliver; the rest are final.
        if (data.reason === 'preempted') {
          runId = null
          disarm()
        } else done()
      } else if (name === 'sync.event') {
        const line = data.line
        if (/^peer seeder [0-9a-f]{8}$/.test(line) || /^downloaded [0-9a-f]{64} (0|[1-9][0-9]*)$/.test(line)) {
          // Downloads only matter once the verified link is up; they push the window out.
          if (line.startsWith('peer') || quiet !== null) arm()
        }
      }
    }
  }
}
