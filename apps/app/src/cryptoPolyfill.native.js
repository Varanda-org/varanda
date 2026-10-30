// React Native ships no crypto.getRandomValues (Expo's runtime does not
// install one), and the app needs it for random challenges and record ids.
// It is backed by expo-crypto's native CSPRNG. Imported first by index.js so
// every later module sees it. An existing implementation is never replaced.

import { getRandomValues as fill } from 'expo-crypto'

const MAX_BYTES = 65536
const INTEGER_ARRAYS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'BigInt64Array', 'BigUint64Array']

// Same contract as Web Crypto: integer typed arrays only, at most 65536 bytes,
// filled in place and returned.
export function installGetRandomValues (scope, source) {
  if (scope.crypto && typeof scope.crypto.getRandomValues === 'function') return false
  if (!scope.crypto) scope.crypto = {}
  scope.crypto.getRandomValues = function getRandomValues (array) {
    if (!ArrayBuffer.isView(array) || !INTEGER_ARRAYS.includes(Object.prototype.toString.call(array).slice(8, -1))) {
      throw new TypeError('getRandomValues: an integer typed array is required')
    }
    if (array.byteLength > MAX_BYTES) throw new RangeError('getRandomValues: at most 65536 bytes')
    if (array.byteLength === 0) return array
    // Filled through a byte view so every integer width gets the same source.
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    if (source(bytes) !== bytes) throw new Error('getRandomValues: no random source')
    return array
  }
  return true
}

installGetRandomValues(globalThis, fill)
