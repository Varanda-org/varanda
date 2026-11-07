/* global document */

// The web release this page was served with, from the same meta tag
// src/pwa.web.js reads.
export function runningRelease () {
  try {
    const meta = document.querySelector('meta[name="varanda-release"]')
    const v = meta ? meta.getAttribute('content') : null
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}
