/* global navigator */

// Web: a DM this device sends must not buzz this same device with its own
// notification. The service worker reads the marker and skips that push. The
// marker goes only to this page's controlling worker, never to a server, and
// carries no id, so it says nothing about who was messaged. navigator is read
// inside the call, never at import, and nothing here may throw.

function sw () {
  try {
    return typeof navigator === 'object' && navigator !== null && navigator.serviceWorker ? navigator.serviceWorker : null
  } catch {
    return null
  }
}

export function noteOwnDmDrop () {
  try {
    const worker = sw()
    const target = worker && worker.controller
    if (target) target.postMessage({ type: 'varanda-dm-sent' })
  } catch {
    // No controller yet or a closed port: the push then shows, which is harmless.
  }
}
