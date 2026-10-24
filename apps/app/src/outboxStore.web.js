/* global localStorage, crypto */

// Web. The outbox of the browser node (see ./outbox) is kept in localStorage,
// so a post written without connection survives a reload. With
// varanda-serve there is no outbox: publishing keeps today's behaviour.

import { webMode } from './client/mode'
import { parseOutbox, serializeOutbox, hexId } from './outbox'

const KEY = 'varanda-web-outbox'

export const outboxAvailable = webMode === 'browser'

export function loadOutbox () {
  try {
    return parseOutbox(localStorage.getItem(KEY))
  } catch {
    return []
  }
}

// false means NOT saved (storage full, blocked or unavailable).
export function saveOutbox (items) {
  try {
    localStorage.setItem(KEY, serializeOutbox(items))
    return true
  } catch {
    return false
  }
}

export function randomId () {
  return hexId(crypto.getRandomValues(new Uint8Array(8)))
}
