// Composer length ring: arc fill, tone and the count left once close to the
// limit. Pure, so the thresholds are testable without React.

export const RING_WARN_AT = 0.9

export function ringState (len, max) {
  const n = Number.isFinite(len) && len > 0 ? len : 0
  const progress = max > 0 ? Math.min(1, n / max) : 0
  const near = n >= max * RING_WARN_AT
  return {
    progress,
    tone: n > max ? 'danger' : near ? 'warn' : 'accent',
    remaining: near ? max - n : null
  }
}
