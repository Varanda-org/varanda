/* global location, sessionStorage */

// Web only (imported by the .web files): which node the web build talks to,
// decided once when the page loads.
// - 'serve': the page was opened at the address varanda-serve printed (a
//   loopback host with #token=... in the fragment). Remembered for this tab
//   in sessionStorage (a flag, never the token), so a reload still says how
//   to reconnect instead of offering the browser node.
// - 'browser': the node runs in this page (packages/web-member, loaded by
//   ./browser.js), with its key in IndexedDB and a seeder as its only peer.

const SERVE_FLAG = 'varanda-serve'

function detect () {
  let local = false
  try {
    local = location.hostname === '127.0.0.1' || location.hostname === 'localhost'
  } catch {}
  if (!local) return 'browser'
  if (/(?:^#|&)token=/.test(location.hash)) {
    try { sessionStorage.setItem(SERVE_FLAG, '1') } catch {}
    return 'serve'
  }
  try {
    if (sessionStorage.getItem(SERVE_FLAG) === '1') return 'serve'
  } catch {}
  return 'browser'
}

export const webMode = detect()
