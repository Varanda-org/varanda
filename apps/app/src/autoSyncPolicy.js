// When the app starts continuous sync (`sync.start {}`) by itself. The app
// never retries an uncertain mutating request blindly: a lost response may
// still have started the run, so it reconciles through `sync.status` (which
// never preempts) first. A preempted continuous run is restarted by the node
// itself once the queued operations finish; an app `sync.start` sent in that
// gap would queue behind them (sync.start is serial) and become the run
// instead, so the app waits a grace period and then reconciles.
export const FIRST_BACKOFF_MS = 2000
export const MAX_BACKOFF_MS = 60000
export const HEALTHY_RUN_MS = 60000
export const PREEMPT_GRACE_MS = 10000
export const IDLE_GAP_MS = 45000

export function wantsStart ({ wanted, phase, online, visible, active, starting, recovering, reconciling, backoffUntil, awaitingRestartUntil, now }) {
  return Boolean(wanted) &&
    phase === 'ready' &&
    online !== false &&
    visible !== false &&
    active === null &&
    !starting &&
    !recovering &&
    !reconciling &&
    now >= (backoffUntil || 0) &&
    !(awaitingRestartUntil && now < awaitingRestartUntil)
}

// A hidden page releases its continuous run, and also the node's continuous
// intent kept over the lease's idle gap (no run active, the last stop of the
// continuous run was 'idle'): otherwise a later request would restart a run
// while hidden. Never a once run.
export function shouldStopForHidden ({ active, visible, idleIntent = false }) {
  if (visible !== false) return false
  if (active != null) return active.once === false
  return idleIntent === true
}

// A visibility transition starts a new hidden-stop period; showing the page
// also ends the idle gap, so the start gate fires at once (sync.start kicks
// the node's lease).
export function visibilityChange ({ wasVisible, visible }) {
  return { newPeriod: wasVisible !== visible, clearIdle: wasVisible === false && visible === true }
}

// The start backoff has two parts: failureUntil (the failure ladder and the
// reconcile delay) and idleUntil (the lease's idle gap). The gate waits for
// the later one; any sync.started and showing the page clear the idle part.
export function effectiveBackoff ({ failureUntil, idleUntil }) {
  return Math.max(failureUntil || 0, idleUntil || 0)
}

// Reconcile read { state: 'idle' }: the idle deadline stands only while the
// most recent stop of the current run was 'idle'; otherwise FIRST_BACKOFF_MS.
export function reconcileIdle ({ failureUntil, idleUntil, lastStopIdle, now }) {
  if (lastStopIdle) return { failureUntil: failureUntil || 0, idleUntil: Math.max(idleUntil || 0, now + FIRST_BACKOFF_MS) }
  return { failureUntil: Math.max(failureUntil || 0, now + FIRST_BACKOFF_MS), idleUntil: 0 }
}

// What a pull-to-refresh does before reading: 'skip' (read local data at
// once: no connection, offline, hidden, auto-sync not wanted or given up, a
// start, reconcile or recovery in flight, or a once run active), 'wait' for
// the active continuous run (peerUp: its verified seeder link is already up)
// or 'start' the continuous run and wait for it. leased: the node is the
// browser node, the only one with a lease; the core node (native,
// varanda-serve) keeps its run up and never reports a dropped seeder link
// the way the browser node does, so a refresh there just reads.
export function refreshPlan ({ connected, phase, online, visible, wanted, gaveUp, busy, active, seederUp, leased = true }) {
  if (!leased) return { action: 'skip' }
  if (!connected || phase !== 'ready' || online === false || visible === false || !wanted || gaveUp || busy) return { action: 'skip' }
  if (active) return active.once === false ? { action: 'wait', runId: active.runId, peerUp: seederUp === true } : { action: 'skip' }
  return { action: 'start' }
}

export function afterPreempt ({ once, wanted, now }) {
  if (once === false && wanted) return { awaitingRestartUntil: now + PREEMPT_GRACE_MS }
  return null
}

// True when the node never restarted the run: the caller must reconcile
// through sync.status, never start blindly.
export function graceExpired ({ awaitingRestartUntil, active, now }) {
  return Boolean(awaitingRestartUntil) && active === null && now >= awaitingRestartUntil
}

// Delay before the next start after a run ended; null means the node restarts
// the run itself (rpc.md section 6.1).
export function nextBackoff ({ reason, startedAt, stoppedAt, previousMs }) {
  if (reason === 'idle') return IDLE_GAP_MS
  if (reason === 'preempted') return null
  if (reason === 'stopped') return 0
  if (stoppedAt - startedAt >= HEALTHY_RUN_MS) return FIRST_BACKOFF_MS
  return Math.min(MAX_BACKOFF_MS, previousMs ? previousMs * 2 : FIRST_BACKOFF_MS)
}

// Background profile reads: auto-sync not wanted, the idle gap (the last stop
// was 'idle' and no failure backoff is pending: a read then could restart a
// run past the app's failure backoff), or a continuous run quiet for quietMs.
export function namesQuiet ({ wanted, startedAt, idleSince, failureUntil, now, quietMs }) {
  return !wanted ||
    (idleSince != null && !(failureUntil > now)) ||
    (startedAt != null && now - startedAt >= quietMs)
}

export function startFailure ({ code, message, uncertain }) {
  if (code === 'USAGE' && message === 'sincronização já em andamento') return 'ignore'
  if (code === 'NOT_FOUND') return 'give-up'
  if (uncertain === true) return 'reconcile'
  return 'backoff'
}
