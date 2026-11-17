// The environment the device name is built from (src/devices.js deviceName),
// on a phone: the platform constants (Android: Brand and Model; iOS: the
// interface idiom). There is no browser user agent here.

import { Platform } from 'react-native'

export function deviceEnv () {
  let constants = {}
  try { constants = Platform.constants || {} } catch {}
  return { userAgent: '', constants }
}
