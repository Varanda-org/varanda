// A tiny emitter: the push task calls requestDmOpen() when a notification
// opens Conversas, and App.js listens. No platform imports.

const listeners = new Set()

export function onDmOpen (fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function requestDmOpen () {
  for (const fn of Array.from(listeners)) fn()
}
