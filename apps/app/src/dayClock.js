// Milliseconds from `now` to the next local midnight (at least 1, so a timer
// scheduled at exactly 00:00:00.000 aims at the following midnight).
export function msUntilMidnight (now = Date.now()) {
  const d = new Date(now)
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return Math.max(1, next - now)
}
