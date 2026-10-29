// iOS/Android: invite links open the hosted web app, not the native one, so
// there is never a pending signup invite here.

export function captureSignupInvite () {
  return null
}

export function loadSignupInvite () {
  return null
}

export function dropSignupInvite () {
  return false
}
