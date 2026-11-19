import * as PushDevice from '../modules/push-device/index.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { CLOSE_MAX, validTag } from './noticeTags.js'
import { validKey } from './pushDevice.js'
import { fromBase64Url, toBase64Url } from './passkeyOptions.js'

export function deriveNativeTag (tag, key) {
  if (!validTag(tag) || !validKey(key) || key.length !== 22) return null
  return toBase64Url(blake2b(utf8ToBytes(tag), { key: fromBase64Url(key), dkLen: 32 })).slice(0, 16)
}

export async function closeNotices (tags) {
  const close = Array.isArray(tags) ? [...new Set(tags.filter(validTag))].slice(0, CLOSE_MAX) : []
  if (close.length === 0 || !PushDevice.isAvailable()) return
  try {
    const SecureStore = require('expo-secure-store')
    const key = await SecureStore.getItemAsync('varanda.push-device.key', {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
    })
    const nativeTags = close.map(tag => deriveNativeTag(tag, key))
    if (nativeTags.every(tag => tag !== null)) await PushDevice.clearDelivered(nativeTags)
  } catch {}
}

export function subscribeSeenSync (wake) {
  return PushDevice.onSync(() => wake('remote'))
}
