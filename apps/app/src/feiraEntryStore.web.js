/* global location, history, sessionStorage */

// Web: a Feira listing link (/f/<hex>/<seq>, /anuncio/<hex>/<seq>) is read
// and cleaned from the address bar once at load (feiraLink.js), and the
// signup entry from it (feiraEntry.js) lives in sessionStorage, so both
// survive the same-tab navigation to Google and back and die with the tab.
// A Feira signup code is stored where loadSignupInvite() reads it. Globals
// are read inside each call, never at import, and every access is guarded.

import { hostedPage } from './configStore'
import { captureListingLink, clearListingLink } from './feiraLink.js'
import { writeSignupInvite } from './signupInvite.js'

function tabStorage () {
  try { return sessionStorage } catch { return null }
}

export function entryStorage () {
  return tabStorage()
}

// Only a hosted installation honours listing links. -> { author, seq } | null.
export function captureListing () {
  if (hostedPage !== true) return null
  try {
    return captureListingLink(location, history, tabStorage(), Date.now())
  } catch {
    return null
  }
}

export function dropListing () {
  return clearListingLink(tabStorage())
}

// Truthy when the code was stored for the signup flow.
export function holdFeiraCode (code) {
  return writeSignupInvite(tabStorage(), { v: 1, code, at: Date.now() })
}
