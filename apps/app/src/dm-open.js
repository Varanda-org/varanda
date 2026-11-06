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

// A DM wake: the service worker's push asks the open app to refresh its
// Conversas, separately from the tap that opens them.
const wakeListeners = new Set()

export function onDmWake (fn) {
  wakeListeners.add(fn)
  return () => { wakeListeners.delete(fn) }
}

// True when someone took the wake: before App.js listens (early in a load),
// nobody does, and the page must not tell the worker it was handled.
export function requestDmWake () {
  const list = Array.from(wakeListeners)
  for (const fn of list) fn()
  return list.length > 0
}

// Conversas opens on Mensagens until the person picks another segment.
export const DEFAULT_SEGMENT = 'mensagens'

export function initialSegment (items) {
  const list = Array.isArray(items) ? items : []
  const first = list.find((item) => item && item.id === DEFAULT_SEGMENT)
  return first ? first.id : (list[0] ? list[0].id : DEFAULT_SEGMENT)
}
