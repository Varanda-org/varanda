// Web: the padded seen list of Avisos in localStorage. The key and the bytes
// are the ones the screen always wrote, so nothing migrates. Never throws.

import { SEEN_STORAGE_KEY } from './notices.js'

export function loadSeenText () {
  try {
    return globalThis.localStorage.getItem(SEEN_STORAGE_KEY)
  } catch {
    return null
  }
}

export function saveSeenText (text) {
  try {
    globalThis.localStorage.setItem(SEEN_STORAGE_KEY, text)
  } catch {}
}

export function clearSeenText () {
  try {
    globalThis.localStorage.removeItem(SEEN_STORAGE_KEY)
  } catch {}
}
