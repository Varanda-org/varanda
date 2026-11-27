/* global navigator */

// Web: a push from someone the member blocked or muted must not show. The
// account service cannot filter it, since it never learns who was blocked or
// muted, so the service worker does (scripts/sw.js), and it needs the lists for
// when no page is open. The lists go only to this page's worker, never to a
// server. navigator is read inside a call, or at import only while a clear is
// still owed, and nothing here may throw.
//
// The worker keeps the last lists until it gets new ones, so when the account
// leaves the device clearPushLists sends empty ones. block.list and mute.list
// also answer while no account is open, so reports wait behind a gate that
// starts closed and opens only for an open account (openPushLists).
//
// The page cannot tell whether the empty lists reached the worker (none may be
// active yet, or it may be gone), so the clear is noted in localStorage and
// sent again on every page load until an account opens. Without storage the
// clear is sent once.

const BLOCKS = 'varanda-blocks'
const MUTES = 'varanda-mutes'
const OWED = 'varanda-push-lists-clear'

let open = false
// Counts the reports of each type: a report still waiting for the worker is
// dropped once a later one (or the clear) was made.
const latest = { [BLOCKS]: 0, [MUTES]: 0 }

function sw () {
  try {
    return typeof navigator === 'object' && navigator !== null && navigator.serviceWorker ? navigator.serviceWorker : null
  } catch {
    return null
  }
}

function report (type, keys) {
  const mine = ++latest[type]
  try {
    const worker = sw()
    if (!worker) return
    const message = { type, keys }
    if (worker.controller) {
      worker.controller.postMessage(message)
      return
    }
    // First load, before the worker controls the page.
    if (worker.ready) {
      worker.ready.then((reg) => {
        if (latest[type] !== mine) return
        if (reg && reg.active) reg.active.postMessage(message)
      }).catch(() => {})
    }
  } catch {
    // A closed port: the next change or app start reports the list again.
  }
}

export function reportBlocks (keys) {
  if (open) report(BLOCKS, keys)
}

export function reportMutes (keys) {
  if (open) report(MUTES, keys)
}

function noteOwed (on) {
  try {
    const store = globalThis.localStorage
    if (!store) return
    if (on) store.setItem(OWED, '1')
    else store.removeItem(OWED)
  } catch {}
}

function owed () {
  try {
    const store = globalThis.localStorage
    return Boolean(store) && store.getItem(OWED) === '1'
  } catch {
    return false
  }
}

function sendClear () {
  report(BLOCKS, [])
  report(MUTES, [])
}

export function clearPushLists () {
  open = false
  noteOwed(true)
  sendClear()
}

// The open account's providers report its own lists from here on.
export function openPushLists () {
  open = true
  noteOwed(false)
}

if (owed()) sendClear()
