// The first 'active' app state of this process. A launch in the background
// (the refresh task, a push on a locked phone) must not read the keychain:
// the stored session is readable only while the device is unlocked, and a
// failed read deletes it (src/sessionStore.native.js). The boot (src/node.js)
// and the cold-start preview (App.js) wait here before anything that could
// reach it. A one-way latch: once seen, it stays open for the process.
//
// Pure: no React, react-native or Node imports; the platform module
// (./backgroundTask.native.js) injects AppState.

// state() -> the current app state; subscribe(fn) -> unsubscribe, fn(state)
// on every change. -> { seen(), wait(), waitActive() }: seen() reads the
// state again (a change missed between two reads still opens it); wait()
// resolves once the app was active in this process; waitActive() resolves
// once the app is active NOW (the phone may have locked again since the
// latch opened). Never rejects.
export function createForegroundGate ({ state, subscribe } = {}) {
  let open = false
  let waiters = []
  let unsubscribe = null

  const release = () => {
    if (open) return
    open = true
    if (unsubscribe !== null) {
      const u = unsubscribe
      unsubscribe = null
      try { u() } catch {}
    }
    const list = waiters
    waiters = []
    for (const resolve of list) resolve()
  }
  const seen = () => {
    if (open) return true
    let s = null
    try { s = typeof state === 'function' ? state() : null } catch {}
    if (s === 'active') release()
    return open
  }
  const wait = () => {
    if (seen()) return Promise.resolve()
    return new Promise((resolve) => {
      waiters.push(resolve)
      if (unsubscribe === null && typeof subscribe === 'function') {
        try {
          const u = subscribe((s) => { if (s === 'active') release() })
          // Already released by a synchronous call: the listener goes now.
          if (open) { try { u() } catch {} } else unsubscribe = u
        } catch {}
      }
      // A change between the read above and the subscription fires nothing.
      seen()
    })
  }
  const activeNow = () => {
    try { return typeof state === 'function' && state() === 'active' } catch { return false }
  }
  const waitActive = () => {
    if (activeNow()) {
      seen()
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let u = null
      let done = false
      const finish = () => {
        if (done) return
        done = true
        if (typeof u === 'function') { try { u() } catch {} }
        seen()
        resolve()
      }
      try {
        u = typeof subscribe === 'function' ? subscribe((s) => { if (s === 'active') finish() }) : null
      } catch {}
      if (done && typeof u === 'function') { try { u() } catch {} }
      // A change between the read above and the subscription fires nothing.
      if (activeNow()) finish()
    })
  }
  return { seen, wait, waitActive }
}

// The background refresh renews A Rua's snapshot only for a person who
// still opens the app: past this since the last foreground start, the
// task stops for good (the snapshot keeps its own 14-day limit).
export const LAST_USE_MAX_MS = 14 * 24 * 60 * 60 * 1000
const LAST_USE_SKEW_MS = 24 * 60 * 60 * 1000

// atMs: when the app was last opened (null when unknown). A date further
// in the future than a clock skew is not trusted.
export function lastUseFresh (atMs, nowMs) {
  if (!Number.isSafeInteger(atMs) || atMs < 0 || !Number.isSafeInteger(nowMs)) return false
  if (atMs - nowMs > LAST_USE_SKEW_MS) return false
  return nowMs - atMs <= LAST_USE_MAX_MS
}
