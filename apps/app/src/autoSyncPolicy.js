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

export function wantsStart ({ wanted, phase, online, active, starting, recovering, reconciling, backoffUntil, awaitingRestartUntil, now }) {
  return Boolean(wanted) &&
    phase === 'ready' &&
    online !== false &&
    active === null &&
    !starting &&
    !recovering &&
    !reconciling &&
    now >= (backoffUntil || 0) &&
    !(awaitingRestartUntil && now < awaitingRestartUntil)
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
  if (reason === 'preempted') return null
  if (reason === 'stopped') return 0
  if (stoppedAt - startedAt >= HEALTHY_RUN_MS) return FIRST_BACKOFF_MS
  return Math.min(MAX_BACKOFF_MS, previousMs ? previousMs * 2 : FIRST_BACKOFF_MS)
}

export function startFailure ({ code, message, uncertain }) {
  if (code === 'USAGE' && message === 'sincronização já em andamento') return 'ignore'
  if (code === 'NOT_FOUND') return 'give-up'
  if (uncertain === true) return 'reconcile'
  return 'backoff'
}
