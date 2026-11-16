/* global localStorage, crypto */

// Web. The outbox of the browser node (see ./outbox) is kept in localStorage,
// so a post written without connection survives a reload. With
// varanda-serve there is no outbox: publishing keeps today's behaviour.
// The sealed queue has its own key; what an older build keeps under the old
// one is merged into it on every read (./outboxMigrate).

import { webMode } from './client/mode'
import { serializeOutbox, hexId } from './outbox'
import { OUTBOX_KEY, loadMigrated } from './outboxMigrate'

export const outboxAvailable = webMode === 'browser'

// `seen`: what a storage event says an older build wrote under its key.
export function loadOutbox (seen = null) {
  try {
    return loadMigrated(localStorage, seen)
  } catch {
    return []
  }
}

// false means NOT saved (storage full, blocked or unavailable).
export function saveOutbox (items) {
  try {
    localStorage.setItem(OUTBOX_KEY, serializeOutbox(items))
    return true
  } catch {
    return false
  }
}

export function randomId () {
  return hexId(crypto.getRandomValues(new Uint8Array(8)))
}
