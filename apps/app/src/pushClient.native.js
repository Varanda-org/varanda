// iOS/Android: no Web Push. The native app keeps the in-app Avisos only.

export function pushSupportNow () {
  return 'not-hosted'
}

export async function getPushState () {
  return { support: 'not-hosted' }
}

export async function enablePush () {
  return { ok: false, reason: 'unavailable' }
}

export async function disablePush () {
  return { ok: false, reason: 'unavailable' }
}

export function captureLaunch () {
  return null
}

export function listenLaunch () {
  return () => {}
}
