// The shared device state (src/devices.js deviceStore) as a hook, and the
// name this device sends. Platform.constants and the user agent are read here
// and handed to the pure deviceName, which decides by what they say.

import { useSyncExternalStore } from 'react'
import { Platform } from 'react-native'
import { deviceName, deviceStore } from './devices'

export function useDeviceState () {
  return useSyncExternalStore(deviceStore.subscribe, deviceStore.get, deviceStore.get)
}

export function currentDeviceName () {
  let userAgent = ''
  try {
    const nav = globalThis.navigator
    if (nav && typeof nav.userAgent === 'string') userAgent = nav.userAgent
  } catch {}
  let constants = {}
  try { constants = Platform.constants || {} } catch {}
  return deviceName({ userAgent, constants })
}
