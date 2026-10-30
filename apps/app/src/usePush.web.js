// Web: one module-level store shared by the shell's note and Ajustes, so a tap
// on either already holds the registration read earlier.
/* global localStorage */

import { useSyncExternalStore } from 'react'
import { pushCheck, pushKey } from './account'
import { disablePush, enablePush, getPushState, pushSupportNow } from './pushClient'
import { createPushStore } from './push-offer'

const store = createPushStore({ getPushState, pushKey, pushCheck, enablePush, disablePush, pushSupportNow, storage: () => localStorage })

export function getPush () {
  return store.getSnapshot()
}

export function subscribePush (fn) {
  return store.subscribe(fn)
}

export function readPush (member) {
  return store.read(member)
}

export function activatePush (arg) {
  return store.activate(arg)
}

export function togglePush (arg) {
  return store.toggle(arg)
}

export function turnOffPush (arg) {
  return store.offHere(arg)
}

export function dismissPush () {
  return store.dismiss()
}

// The five functions are stable module references, safe as effect deps.
export function usePush () {
  const { member, state, pending, error, note } = useSyncExternalStore(subscribePush, getPush, getPush)
  return { member, state, pending, error, note, readPush, activatePush, togglePush, turnOffPush, dismissPush }
}
