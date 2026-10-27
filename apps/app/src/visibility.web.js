/* global document, window */

export function isVisible () {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

// pagehide can precede the browser updating visibilityState.
export function subscribeVisible (fn) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
  const handler = () => fn(isVisible())
  const hide = () => fn(false)
  window.addEventListener('visibilitychange', handler)
  window.addEventListener('pagehide', hide)
  window.addEventListener('pageshow', handler)
  return () => {
    window.removeEventListener('visibilitychange', handler)
    window.removeEventListener('pagehide', hide)
    window.removeEventListener('pageshow', handler)
  }
}
