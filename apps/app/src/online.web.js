/* global navigator, window */

// Web: what the browser says about the network. navigator.onLine false is
// reliable (no network at all); true only means a network may exist.
export function isOnline () {
  return !(typeof navigator === 'object' && navigator !== null && navigator.onLine === false)
}

// fn(isOnline()) on every change. -> unsubscribe.
export function subscribeOnline (fn) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
  const handler = () => fn(isOnline())
  window.addEventListener('online', handler)
  window.addEventListener('offline', handler)
  return () => {
    window.removeEventListener('online', handler)
    window.removeEventListener('offline', handler)
  }
}
