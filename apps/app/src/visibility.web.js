/* global document, window */

export function isVisible () {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

// No browser node suspends itself while hidden, so the shell always pauses it.
export function pausesWhenHidden () {
  return true
}

export function effectiveVisible (visible, hosted) {
  return visible || !pausesWhenHidden(hosted)
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
