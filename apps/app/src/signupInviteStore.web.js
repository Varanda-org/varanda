/* global location, history, sessionStorage */

// Web: the pending signup invite lives in sessionStorage, like the profile
// invite (profileLinkStore.web.js): it survives the same-tab navigation to
// Google and back and dies with the tab. When the tab refuses writes, the
// holder keeps the captured record in memory for this load. Globals are read
// inside each call, never at import, and every access is guarded.

import { hostedPage } from './configStore'
import { createSignupInviteHolder } from './signupInvite'

function tabStorage () {
  try { return sessionStorage } catch { return null }
}

const holder = createSignupInviteHolder({ getStorage: tabStorage })

// Only a hosted installation honours invite links.
export function captureSignupInvite () {
  if (hostedPage !== true) return null
  try {
    return holder.capture({ location, history })
  } catch {
    return null
  }
}

export function loadSignupInvite () {
  try { return holder.load() } catch { return null }
}

export function dropSignupInvite () {
  try { return holder.drop() } catch { return false }
}
