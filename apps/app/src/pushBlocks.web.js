/* global navigator */

// Web: a push from someone the member blocked must not show. The account
// service cannot filter it, since it never learns who was blocked, so the
// service worker does (scripts/sw.js), and it needs the list for when no page
// is open. The list goes only to this page's worker, never to a server.
// navigator is read inside the call, never at import, and nothing here may throw.

function sw () {
  try {
    return typeof navigator === 'object' && navigator !== null && navigator.serviceWorker ? navigator.serviceWorker : null
  } catch {
    return null
  }
}

export function reportBlocks (keys) {
  try {
    const worker = sw()
    if (!worker) return
    const message = { type: 'varanda-blocks', keys }
    if (worker.controller) {
      worker.controller.postMessage(message)
      return
    }
    // First load, before the worker controls the page.
    if (worker.ready) {
      worker.ready.then((reg) => {
        if (reg && reg.active) reg.active.postMessage(message)
      }).catch(() => {})
    }
  } catch {
    // A closed port: the next change or app start reports the list again.
  }
}
