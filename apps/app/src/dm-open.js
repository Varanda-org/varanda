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

// Conversas opens on Mensagens until the person picks another segment.
export const DEFAULT_SEGMENT = 'mensagens'

export function initialSegment (items) {
  const list = Array.isArray(items) ? items : []
  const first = list.find((item) => item && item.id === DEFAULT_SEGMENT)
  return first ? first.id : (list[0] ? list[0].id : DEFAULT_SEGMENT)
}
