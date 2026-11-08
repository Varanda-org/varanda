// iOS/Android: no page load and no tab storage. Listing links arrive through
// Linking (linkReturn.parseAppLink kind 'anuncio') into App.js, the signup
// entry stays in the feiraEntry.js holder's memory for the session, and a
// Feira signup code goes through the same holder as a pasted invite link.

import { captureSignupInvite } from './signupInviteStore.native.js'

export function entryStorage () {
  return null
}

export function captureListing () {
  return null
}

export function dropListing () {
  return false
}

// Truthy when the code was stored for the signup flow.
export function holdFeiraCode (code) {
  return captureSignupInvite('varanda:///convite/' + code)
}
