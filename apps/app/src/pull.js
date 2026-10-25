// Pull-to-refresh math for the web shell (native uses RefreshControl). Pure
// functions: the caller feeds touch coordinates and keeps the returned `lock`
// between moves, resetting it to null on touchstart. The lock is sticky for the
// whole touch, so a sideways or upward start, or a start away from the top,
// cancels the gesture even if the finger later travels straight down.
export const PULL_THRESHOLD = 72
export const PULL_MAX = 120
export const DIRECTION_LOCK = 8
export const MIN_SPIN_MS = 500

// Rubber-band damping: monotonic, never above max.
export function pullDistance (dy, max = PULL_MAX) {
  if (!(dy > 0)) return 0
  return max * (1 - Math.exp(-dy / max))
}

export function pullState ({ startX, startY, x, y, atTop, refreshing, lock = null }) {
  const dx = x - startX
  const dy = y - startY
  let next = lock
  if (next === null && Math.max(Math.abs(dx), Math.abs(dy)) >= DIRECTION_LOCK) {
    next = atTop && !refreshing && dy > Math.abs(dx) ? 'vertical' : 'rejected'
  }
  const active = next === 'vertical' && !refreshing && dy > 0
  return {
    dy,
    lock: next,
    distance: active ? pullDistance(dy) : 0,
    progress: active ? Math.min(1, dy / PULL_THRESHOLD) : 0,
    armed: active && dy >= PULL_THRESHOLD,
    active
  }
}

export function pullDecision ({ armed, refreshing }) {
  return armed && !refreshing ? 'refresh' : 'cancel'
}

// Milliseconds the spinner must still show so it never flashes.
export function spinRemaining ({ startedAt, now, min = MIN_SPIN_MS }) {
  return Math.max(0, min - (now - startedAt))
}
