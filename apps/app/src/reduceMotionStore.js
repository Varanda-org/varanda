// One shared reduce-motion value for the whole app. Every photo and every
// reveal reads it, so a per-mount query and listener would scale with the
// feed length; this keeps one query and one listener while anyone subscribes.
// The AccessibilityInfo API is injected so the store needs no react-native.

export function createReduceMotionStore (api) {
  let value = false
  let sub = null
  let epoch = 0
  const subs = new Set()

  function set (next) {
    const v = next === true
    if (v === value) return
    value = v
    for (const fn of Array.from(subs)) fn()
  }

  function start () {
    const mine = ++epoch
    try {
      Promise.resolve(api.isReduceMotionEnabled()).then((v) => {
        if (epoch === mine) set(v)
      }, () => {})
      sub = api.addEventListener('reduceMotionChanged', (v) => {
        if (epoch === mine) set(v)
      })
    } catch {}
  }

  function stop () {
    epoch++
    const s = sub
    sub = null
    try { if (s && typeof s.remove === 'function') s.remove() } catch {}
  }

  return {
    get: () => value,
    subscribe (fn) {
      subs.add(fn)
      if (subs.size === 1) start()
      let on = true
      return () => {
        if (!on) return
        on = false
        subs.delete(fn)
        if (subs.size === 0) stop()
      }
    }
  }
}
