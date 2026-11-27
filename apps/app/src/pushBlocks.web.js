/* global navigator */

// Web: a push from someone the member blocked or muted must not show. The
// account service cannot filter it, since it never learns who was blocked or
// muted, so the service worker does (scripts/sw.js), and it needs the lists for
// when no page is open. The lists go only to this page's worker, never to a
// server. navigator is read inside the call, never at import, and nothing here
// may throw.
//
// The worker keeps the last lists until it gets new ones, so when the account
// leaves the device clearPushLists sends empty ones. block.list and mute.list
// also answer while no account is open, so reports wait behind a gate that
// starts closed and opens only for an open account (openPushLists).

const BLOCKS = 'varanda-blocks'
const MUTES = 'varanda-mutes'

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

export function clearPushLists () {
  open = false
  report(BLOCKS, [])
  report(MUTES, [])
}

export function openPushLists () {
  open = true
}
