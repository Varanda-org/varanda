'use strict'

// The browser node's invite card check. The browser sodium
// (./sodium-browser.js) accepts a small-order or non-canonical public key,
// against which a forged signature can verify, so the member key is decoded
// strictly here (RFC 8032: y < p) and refused unless it is a torsion-free
// point of large order before @varanda/core verifies the signature.
const { ed25519 } = require('@noble/curves/ed25519.js')
const { verifyInviteCard } = require('@varanda/core/lib/invite-card')

const Point = ed25519.Point
const HEX64 = /^[0-9a-f]{64}$/

function isStrictMemberKey (hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) return false
  try {
    const p = Point.fromHex(hex, false)
    return !p.isSmallOrder() && p.isTorsionFree()
  } catch {
    return false
  }
}

// Same input and result as verifyInviteCard. Never throws.
function strictVerifyInviteCard (fields, signatureHex) {
  if (fields === null || typeof fields !== 'object') return { ok: false, reason: 'malformed' }
  // One read of the input: the strict key check and the signature check
  // must see the same member, so a getter cannot answer two different keys.
  let snapshot
  try {
    snapshot = { ...fields }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!isStrictMemberKey(snapshot.member)) return { ok: false, reason: 'malformed' }
  return verifyInviteCard(snapshot, signatureHex)
}

module.exports = { strictVerifyInviteCard }
