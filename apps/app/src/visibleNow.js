// Timer core of useVisibleNow (src/ui/index.js). The interval runs only
// while the screen is visible. Showing again after being hidden, including a
// screen mounted hidden (a tab first opened minutes after boot), refreshes at
// once, since the shown time may be a whole pause old; a screen mounted
// visible does not, as its mount just read the clock. Clock and timers are
// injected so a test can drive it.
export function createVisibleNow ({ intervalMs, clock, setTimer, clearTimer, onNow }) {
  let timer = null
  let paused = false
  const run = () => onNow(clock())
  return {
    setVisible (visible) {
      if (visible && timer === null) {
        if (paused) run()
        paused = false
        timer = setTimer(run, intervalMs)
      } else if (!visible) {
        if (timer !== null) clearTimer(timer)
        timer = null
        paused = true
      }
    },
    stop () {
      if (timer !== null) clearTimer(timer)
      timer = null
    }
  }
}
