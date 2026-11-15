// Milliseconds from `now` to the next local midnight (at least 1, so a timer
// scheduled at exactly 00:00:00.000 aims at the following midnight).
export function msUntilMidnight (now = Date.now()) {
  const d = new Date(now)
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return Math.max(1, next - now)
}

// Calls onWake at every local midnight and whenever the app returns to the
// foreground (subscribe hands it the AppState 'change' states), so "hoje" and
// "ontem" never go stale. A return re-arms the midnight timer from the new
// time, since timers may have slept in the background. Clock, timers and the
// subscription are injected so a test can drive it. Returns stop.
export function startDayWake ({ clock, setTimer, clearTimer, subscribe, onWake }) {
  let timer = null
  const arm = () => {
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => { timer = null; onWake(); arm() }, msUntilMidnight(clock()))
  }
  arm()
  const unsubscribe = subscribe((state) => {
    if (state === 'active') { onWake(); arm() }
  })
  return () => {
    if (timer !== null) clearTimer(timer)
    timer = null
    unsubscribe()
  }
}
