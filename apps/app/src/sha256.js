// Lowercase hex SHA-256 of a string's UTF-8 bytes, the same on the web and
// on the phone: React Native has no crypto.subtle. Pure ES module.

import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'

export async function sha256Hex (text) {
  if (typeof text !== 'string') return null
  const digest = nobleSha256(new TextEncoder().encode(text))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}
