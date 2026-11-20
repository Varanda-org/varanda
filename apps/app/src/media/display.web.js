/* global Blob, URL */

// Turns verified media bytes into something an Image can show. The browser
// keeps them in memory as a blob: URL, revoked when the cache drops it.

export function urlFromBytes (bytes, mime) {
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

export function revokeUrl (url) {
  try { URL.revokeObjectURL(url) } catch {}
}

// The browser node hands a video as bytes (urlFromBytes makes a blob typed
// video/mp4), never as a file to adopt.
export function adoptVideoFile () {
  return null
}

// Blob URLs die with the page: nothing to sweep.
export function sweepMediaCache () {}
