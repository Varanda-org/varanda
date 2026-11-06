// Web: one module-level store shared by the shell's note and Ajustes, so a tap
// on either already holds the registration read earlier.
/* global localStorage, navigator */

import { useSyncExternalStore } from 'react'
import { pushCheck, pushKey } from './account'
import { disablePush, enablePush, getPushState, pushSupportNow } from './pushClient'
import { createPushStore } from './push-offer'
import { requestDmOpen, requestDmWake } from './dm-open'

const store = createPushStore({ getPushState, pushKey, pushCheck, enablePush, disablePush, pushSupportNow, storage: () => localStorage })

function isDmOpen (d) {
  return d !== null && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 1 && d.type === 'varanda-dm-open'
}

function inFront () {
  try {
    return document.visibilityState === 'visible' && document.hasFocus() === true
  } catch {
    return false
  }
}

function isDmWake (d) {
  if (d === null || typeof d !== 'object') return false
  const proto = Object.getPrototypeOf(d)
  return (proto === Object.prototype || proto === null) && Reflect.ownKeys(d).length === 1 && d.type === 'varanda-dm-wake'
}

// A click on the DM wake notice (scripts/sw.js) opens Conversas. Only this
// origin's worker posts to navigator.serviceWorker.
try {
  const sw = typeof navigator === 'object' && navigator !== null ? navigator.serviceWorker : null
  if (sw) {
    sw.addEventListener('message', (e) => {
      try {
        if (isDmOpen(e && e.data)) requestDmOpen()
        if (isDmWake(e && e.data)) {
          // The worker hides the notice only once the app says it took the
          // wake: not before App.js is listening, and not once the person
          // has left this window (any other answer makes it show at once).
          const taken = requestDmWake()
          const port = e.ports && e.ports[0]
          if (port) port.postMessage({ type: taken && inFront() ? 'varanda-dm-wake-ok' : 'varanda-dm-wake-no' })
        }
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
