// Fixed-identity callbacks for memoized screens. The shell defines most of
// its handlers inline, so each render makes new functions and a memoized
// screen would render anyway. update(map) is called on every render with the
// current handlers and returns functions that keep their identity while
// always calling the latest implementation. A value that is not a function
// passes through as is, and a handler that comes back after being absent
// gets a new function, so `onX ? a : b` checks in a screen still see the
// change. Pure: no React, so a holder is created once (in a ref) and updated
// during render.

export function createStableHandlers () {
  const latest = new Map()
  let out = {}
  return {
    // Writes `latest` during render. That is safe because the app renders
    // without transitions or StrictMode double renders; a discarded concurrent
    // render would leave its handlers in place until the next committed render.
    update (map) {
      const next = {}
      for (const name of Object.keys(map)) {
        const value = map[name]
        if (typeof value !== 'function') {
          latest.delete(name)
          next[name] = value
          continue
        }
        latest.set(name, value)
        next[name] = typeof out[name] === 'function'
          ? out[name]
          : (...args) => {
              const fn = latest.get(name)
              return typeof fn === 'function' ? fn(...args) : undefined
            }
      }
      for (const name of [...latest.keys()]) if (!Object.prototype.hasOwnProperty.call(next, name)) latest.delete(name)
      out = next
      return out
    }
  }
}

// One holder per key (a stack entry), for handlers bound to that entry.
// sweep() drops the holders no for() call used since the previous sweep.
export function createStableHandlerSets () {
  const sets = new Map()
  const used = new Set()
  return {
    for (key, map) {
      let set = sets.get(key)
      if (set === undefined) {
        set = createStableHandlers()
        sets.set(key, set)
      }
      used.add(key)
      return set.update(map)
    },
    sweep () {
      for (const key of [...sets.keys()]) if (!used.has(key)) sets.delete(key)
      used.clear()
    },
    size () {
      return sets.size
    }
  }
}
