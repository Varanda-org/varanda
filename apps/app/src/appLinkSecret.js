// The native app's link secret V for the account sign-in (RFC 8252 pattern,
// apps/cli/lib/account/app-return.js). Pure ES module: no React, no
// react-native, no Node built-ins; the random source is injected so the
// tests can compare it with node:crypto.
//
// V stays in the app's memory: start sends only its proof, and every later
// step sends V itself, so another app that claims the varanda:// scheme and
// receives the redeem code still cannot finish the link.

import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'

const SECRET_BYTES = 32
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// base64url without padding, the service's token spelling.
export function base64url (bytes) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63] + ALPHABET[n >> 6 & 63] + ALPHABET[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63] + ALPHABET[n >> 6 & 63]
  }
  return out
}

// -> { secret, proof }: secret = base64url(V), proof = base64url(sha256(V)).
// randomBytes(n) must return n fresh bytes; the raw copies are zeroed once
// encoded, so only the string form outlives this call.
export function newLinkSecret (randomBytes, sha256 = nobleSha256) {
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes is required')
  const bytes = randomBytes(SECRET_BYTES)
  if (!(bytes instanceof Uint8Array) || bytes.length !== SECRET_BYTES) throw new TypeError('randomBytes must return 32 bytes')
  let digest = null
  try {
    digest = sha256(bytes)
    if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new TypeError('sha256 must return 32 bytes')
    return { secret: base64url(bytes), proof: base64url(digest) }
  } finally {
    bytes.fill(0)
    if (digest instanceof Uint8Array) digest.fill(0)
  }
}

// The device CSPRNG of the app (expo-crypto's polyfill, cryptoPolyfill.native.js).
export function deviceRandomBytes (n) {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}
