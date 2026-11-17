// The shared device state (src/devices.js deviceStore) as a hook, and the
// name this device sends. The environment is read per platform
// (deviceEnv.web.js, deviceEnv.native.js) and handed to the pure deviceName.

import { useSyncExternalStore } from 'react'
import { deviceName, deviceStore } from './devices'
import { deviceEnv } from './deviceEnv'

// The raw store state. A caller that knows its member passes it through
// visibleDevices (src/devices.js) so another member's answer is never shown,
// not even for one frame.
export function useDeviceState () {
  return useSyncExternalStore(deviceStore.subscribe, deviceStore.get, deviceStore.get)
}

export function currentDeviceName () {
  return deviceName(deviceEnv())
}
