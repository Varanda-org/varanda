// Native has no Web Push prompt; the in-app Avisos list is unchanged.

const NONE = Object.freeze({ member: null, state: null, pending: false, error: '', note: 'none' })
const PUSH = Object.freeze({ ...NONE, readPush, activatePush, togglePush, turnOffPush, dismissPush })

export function getPush () {
  return NONE
}

export function subscribePush () {
  return () => {}
}

export function readPush () {}

export function activatePush () {
  return false
}

export function togglePush () {
  return false
}

export function turnOffPush () {
  return Promise.resolve()
}

export function dismissPush () {}

export function usePush () {
  return PUSH
}
