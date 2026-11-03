/* global location, history, sessionStorage */

// Web: the tapped group or community link lives in sessionStorage, which
// survives the same-tab navigation to Google and back and dies with the tab.
// localStorage would not do: it outlives the tab and is shared by every tab
// and visit on this origin. The record only names a screen to open, it never
// joins.
// Globals are read inside each call and every access is guarded.

import { hostedPage } from './configStore'
import { captureEntryLink as capture, clearEntry } from './groupLink'

function tabStorage () {
  try { return sessionStorage } catch { return null }
}

// Only a hosted installation honours entry links.
export function captureEntryLink () {
  if (hostedPage !== true) return null
  try {
    return capture({ location, history, storage: tabStorage(), now: Date.now() })
  } catch {
    return null
  }
}

export function dropEntryLink () {
  return clearEntry(tabStorage())
}
