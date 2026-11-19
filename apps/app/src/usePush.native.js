import { useSyncExternalStore } from 'react'
import { currentClient } from './client'
import * as client from './pushClient'
import { createNativePushStore } from './pushDevice.js'

const store = createNativePushStore({ client, getNode: currentClient })

export function getPush () { return store.getSnapshot() }
export function subscribePush (fn) { return store.subscribe(fn) }
export function readPush (member) { return store.read(member) }
export function activatePush (arg) { return store.activate(arg) }
export function togglePush (arg) { return store.toggle(arg) }
export function turnOffPush (arg) { return store.offHere(arg) }
export function dismissPush () { return store.dismiss() }

export function usePush () {
  const snapshot = useSyncExternalStore(subscribePush, getPush, getPush)
  return { ...snapshot, readPush, activatePush, togglePush, turnOffPush, dismissPush }
}
