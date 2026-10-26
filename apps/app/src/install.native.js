// iOS/Android: the native app needs no install UI or browser bindings.

const NONE = Object.freeze({ note: 'none', canPrompt: false })
const INSTALL = Object.freeze({ ...NONE, promptInstall, dismissInstall })

export function getInstall () {
  return NONE
}

export function subscribeInstall () {
  return () => {}
}

export function promptInstall () {
  return Promise.resolve('unavailable')
}

export function dismissInstall () {}

export function useInstall () {
  return INSTALL
}
