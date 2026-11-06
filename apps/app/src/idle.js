// Counts the node requests in flight so optional work (a hidden tab's warm
// read) waits until the app has been quiet for a while. A fixed delay after
// 'sync ready' is not enough: the boot reads themselves only start then, and
// on a phone the browser node shares the main thread with the screens.

export function createIdleTracker ({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let inflight = 0
  let lastAt = now()
  const waiters = new Set()

  function disarm (w) {
    if (w.timer !== null) {
      clearTimer(w.timer)
      w.timer = null
    }
  }

  function arm (w) {
    disarm(w)
    if (inflight > 0) return
    w.timer = setTimer(() => {
      w.timer = null
      if (inflight > 0) return
      if (now() - lastAt < w.quietMs) {
        arm(w)
        return
      }
      waiters.delete(w)
      w.resolve()
    }, Math.max(0, lastAt + w.quietMs - now()))
  }

  return {
    begin () {
      inflight++
      lastAt = now()
      for (const w of waiters) disarm(w)
    },
    end () {
      inflight = Math.max(0, inflight - 1)
      lastAt = now()
      if (inflight === 0) for (const w of waiters) arm(w)
    },
    // -> { promise, cancel }: resolves once nothing has been in flight for
    // `quietMs`; a cancelled wait never resolves.
    whenIdle (quietMs) {
      let w = null
      const promise = new Promise((resolve) => { w = { quietMs, resolve, timer: null } })
      waiters.add(w)
      arm(w)
      return {
        promise,
        cancel () {
          disarm(w)
          waiters.delete(w)
        }
      }
    }
  }
}
