// iOS/Android: profile links open the hosted web app, not the native one, so
// there is never a pending invite here.

export function captureInvite () {
  return null
}

export function loadInvite () {
  return null
}

export function saveInvite () {
  return false
}

export function dropInvite () {
  return false
}
