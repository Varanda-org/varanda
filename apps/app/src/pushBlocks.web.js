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
// sent again on every page load until the open account's own lists were posted.
// Without storage the clear is sent once. Every tab shares the note, so each
// clear writes its own token, and a tab removes only the one it saw when its
// account opened: a later clear from another tab stays owed.

const BLOCKS = 'varanda-blocks'
const MUTES = 'varanda-mutes'
const OWED = 'varanda-push-lists-clear'

let open = false
// Counts the reports of each type: a report still waiting for the worker is
// dropped once a later one (or the clear) was made.
const latest = { [BLOCKS]: 0, [MUTES]: 0 }
// Which lists of the open account went to the worker since the last clear.
const handed = { [BLOCKS]: false, [MUTES]: false }
// Bumped by a clear, made here or seen from another tab, so a report made
// before it never counts after it.
let round = 0
// The owed token as this tab saw it when its account opened.
let seen = null

function sw () {
  try {
    return typeof navigator === 'object' && navigator !== null && navigator.serviceWorker ? navigator.serviceWorker : null
  } catch {
    return null
  }
}

// posted runs only once postMessage returned, which is the most the page can
// know: a report with no worker, or one that never left the queue, is not one.
function report (type, keys, posted) {
  const mine = ++latest[type]
  try {
    const worker = sw()
    if (!worker) return
    const message = { type, keys }
    if (worker.controller) {
      worker.controller.postMessage(message)
      if (posted) posted()
      return
    }
    // First load, before the worker controls the page.
    if (worker.ready) {
      worker.ready.then((reg) => {
        if (latest[type] !== mine) return
        if (reg && reg.active) {
          reg.active.postMessage(message)
          if (posted) posted()
        }
      }).catch(() => {})
    }
  } catch {
    // A closed port: the next change or app start reports the list again.
  }
}

function reportOpen (type, keys) {
  if (!open) return
  const at = round
  report(type, keys, () => {
    if (round !== at) return
    handed[type] = true
    if (handed[BLOCKS] && handed[MUTES]) settle()
  })
}

export function reportBlocks (keys) {
  reportOpen(BLOCKS, keys)
}

export function reportMutes (keys) {
  reportOpen(MUTES, keys)
}

function noteOwed () {
  try {
    const store = globalThis.localStorage
    if (store) store.setItem(OWED, Date.now().toString(36) + '.' + Math.random().toString(36).slice(2))
  } catch {}
}

function readOwed () {
  try {
    const store = globalThis.localStorage
    return (store && store.getItem(OWED)) || null
  } catch {
    return null
  }
}

// Any value is owed, also the '1' an older build wrote.
function owed () {
  return readOwed() !== null
}

function settle () {
  try {
    const store = globalThis.localStorage
    if (store && seen !== null && store.getItem(OWED) === seen) store.removeItem(OWED)
  } catch {}
}

function sendClear () {
  report(BLOCKS, [])
  report(MUTES, [])
}

function restart () {
  round++
  handed[BLOCKS] = false
  handed[MUTES] = false
}

export function clearPushLists () {
  open = false
  restart()
  noteOwed()
  sendClear()
}

// The open account's providers report its own lists from here on. A clear
// another tab made since the last open needs both lists again.
export function openPushLists () {
  open = true
  const now = readOwed()
  if (now !== seen) restart()
  seen = now
}

if (owed()) sendClear()
