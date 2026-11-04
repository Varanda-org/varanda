// EIP-55: a mixed-case address carries a checksum in the case of its letters,
// so one mistyped character is caught before an irreversible send. An address
// in all lower or all upper case carries none and is accepted as typed.
// Pure ES module.

import { keccak_256 as keccak256 } from '@noble/hashes/sha3.js'

const HEX40_RE = /^0x[0-9a-fA-F]{40}$/

export function hasValidChecksum (address) {
  if (typeof address !== 'string' || !HEX40_RE.test(address)) return false
  const body = address.slice(2)
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true
  const hash = keccak256(new TextEncoder().encode(body.toLowerCase()))
  for (let i = 0; i < 40; i++) {
    const c = body[i]
    if (c >= '0' && c <= '9') continue
    const nibble = i % 2 === 0 ? hash[i >> 1] >> 4 : hash[i >> 1] & 0x0f
    if ((nibble >= 8) !== (c === c.toUpperCase())) return false
  }
  return true
}
