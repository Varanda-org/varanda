/* global location, history, sessionStorage */

// Web: the pending profile invite lives in sessionStorage. It survives the
// same-tab navigation to Google and back (Identidade.js starts the account
// link with location.assign) and dies with the tab. localStorage would not do:
// it is unauthenticated and shared by every visit on this origin, which is why
// the outbox refuses to auto-send items left by a previous visit (docs/app.md)
// and why follow.add refuses while the node is locked. Globals are read inside
// each call, never at import, and every access is guarded (private modes and
// sandboxed frames throw).

import { hostedPage } from './configStore'
import { captureInvite as capture, readInvite, writeInvite, clearInvite } from './profileLink'

function tabStorage () {
  try { return sessionStorage } catch { return null }
}

// Only a hosted installation honours profile links.
export function captureInvite () {
  if (hostedPage !== true) return null
  try {
    return capture({ location, history, storage: tabStorage(), now: Date.now() })
  } catch {
    return null
  }
}

export function loadInvite () {
  return readInvite(tabStorage(), Date.now())
}

export function saveInvite (rec) {
  return writeInvite(tabStorage(), rec)
}

export function dropInvite () {
  return clearInvite(tabStorage())
}
