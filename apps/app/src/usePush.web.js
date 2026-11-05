// Web: one module-level store shared by the shell's note and Ajustes, so a tap
// on either already holds the registration read earlier.
/* global localStorage, navigator */

import { useSyncExternalStore } from 'react'
import { pushCheck, pushKey } from './account'
import { disablePush, enablePush, getPushState, pushSupportNow } from './pushClient'
import { createPushStore } from './push-offer'
import { requestDmOpen } from './dm-open'
import { vitrineEnabled } from './vitrine/enabled'

/* global __DEV__ */
const VITRINE = vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: process.env.EXPO_PUBLIC_VARANDA_VITRINE }, typeof __DEV__ !== 'undefined' && __DEV__)

const store = createPushStore({ getPushState, pushKey, pushCheck, enablePush, disablePush, pushSupportNow, storage: () => localStorage })

function isDmOpen (d) {
  return d !== null && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 1 && d.type === 'varanda-dm-open'
}

// A click on the DM wake notice (scripts/sw.js) opens Conversas. Only this
// origin's worker posts to navigator.serviceWorker.
try {
  const sw = typeof navigator === 'object' && navigator !== null ? navigator.serviceWorker : null
  if (sw) {
    sw.addEventListener('message', (e) => {
      try {
        if (isDmOpen(e && e.data)) requestDmOpen()
      } catch {}
    })
  }
} catch {}

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
  // Ajustes turns push off before Sair and Recomeçar, which the Vitrine
  // refuses: it must not drop a real subscription this origin already holds.
  if (VITRINE) return Promise.resolve()
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
