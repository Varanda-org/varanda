// Group links (https://<origin>/g/<hex64>) that open a group on the hosted
// web. Pure ES module: no React, no globals, no Node built-ins; the caller
// passes location and history in, so Node's import() tests every branch.
//
// Same strictness as profileLink.js: a regex over the raw path, never
// decodeURIComponent, and lowercase hex only (the canonical key form).

import { isAuthorKey } from './nav.js'

const MAX_PATH = 80
const GROUP_PATH = /^\/g\/([0-9a-f]{64})\/?$/

// Cheap prefix test: any path under /g/ is a group link attempt and gets
// cleaned from the address bar, valid or not.
export function isGroupPath (p) {
  return typeof p === 'string' && p.startsWith('/g/')
}

// The lowercase hex64 group key, or null.
export function parseGroupPath (p) {
  if (typeof p !== 'string' || p.length > MAX_PATH) return null
  const m = GROUP_PATH.exec(p)
  return m && isAuthorKey(m[1]) ? m[1] : null
}

// Runs once at startup. A /g/ path is cleaned to '/' keeping search and hash
// byte for byte (?conta= and #token= are read later by the account flow);
// returns the key to open, or null. Any other path touches nothing.
export function captureGroupLink ({ location, history } = {}) {
  try {
    const pathname = location && location.pathname
    if (!isGroupPath(pathname)) return null
    const key = parseGroupPath(pathname)
    try {
      history.replaceState(history.state, '', '/' + (location.search || '') + (location.hash || ''))
    } catch {}
    return key
  } catch {
    return null
  }
}
