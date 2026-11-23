// Browser-only completion of sodium-javascript 0.8.0.
//
// sodium-universal's `browser` field maps sodium-native to sodium-javascript,
// and sodium-javascript 0.8.0 lacks the two symbols noise-curve-ed 2.1.0 (the
// curve every Noise XX handshake of @hyperswarm/secret-stream uses) needs:
// crypto_scalarmult_ed25519_BYTES (read at load) and
// crypto_scalarmult_ed25519_noclamp (called in dh()). Without them every
// handshake in the browser fails inside Handshake.send(). Measured over both
// bundles (scripts/build.js metafiles), these are the only sodium symbols a
// bundled module uses that sodium-javascript does not export.
//
// This module re-exports everything sodium-javascript exports plus those two,
// implemented with @noble/curves' Ed25519 point arithmetic. scripts/build.js
// maps sodium-javascript to this file in the browser bundles only (the real
// package is still what this file itself loads); Node keeps sodium-native.
//
// Contract mirrored from libsodium's _crypto_scalarmult_ed25519 (clamp = 0)
// as sodium-native 5.2.0 ships it, the version every peer runs (Node, the
// worklet and packages/core):
//   q = n * P, P the compressed Edwards point `p`, n the 32-byte little-endian
//   scalar WITHOUT clamping. Fails when `p` is not a canonical encoding
//   (y >= 2^255 - 19, or x = 0 with the sign bit set), is not on the curve,
//   has small order (libsodium's blacklist: the 8-element torsion subgroup,
//   ignoring the sign bit) or is not in the prime-order subgroup; when n is
//   all zero; and when the result is the identity encoding.
//   The subgroup check of sodium-native 5.2.0 requires L * P to be the
//   identity, so it also rejects the points P0 + (0, -1) of order 2L
//   (verified against sodium-native 5.2.0; the X-only check of older
//   libsodium, as in sodium-native 4.3.3, accepted them). Mirrored here.
//   libsodium clears bit 255 of the scalar before multiplying (t[31] &= 127)
//   even without clamping, so the effective scalar is t = n mod 2^255. P has
//   order L, so t * P = (t mod L) * P, which is what is computed below.
// Failure: sodium-native 5.2.0 throws (Error 'status: -1' from the binding),
// so this throws an Error too (its own message) rather than returning -1;
// a return value would let noise-curve-ed, which ignores it, carry on with an
// all-zero shared secret. Argument checks throw the way sodium-javascript's
// check() does ('Argument must be a buffer of length N').
// Timing: the noble path is not constant-time. Point.multiply() uses a
// constant-time wNAF with precomputed tables, but the decoding
// (fromBytes, sqrt), the subgroup check (isTorsionFree) and the BigInt
// arithmetic underneath are variable-time in JavaScript, and libsodium's own
// ge25519_scalarmult is constant-time in C only. Acceptable for the spike;
// noted here so it is not mistaken for a hardened implementation.
/* eslint-disable camelcase */
const sodium = require('sodium-javascript')
const { ed25519 } = require('@noble/curves/ed25519.js')

const Point = ed25519.Point
// Group order L = 2^252 + 27742317777372353535851937790883648493.
const L = Point.Fn.ORDER

const crypto_scalarmult_ed25519_BYTES = 32
const crypto_scalarmult_ed25519_SCALARBYTES = 32

function check (buf, len) {
  if (!buf || (len && buf.length < len)) throw new Error('Argument must be a buffer' + (len ? ' of length ' + len : ''))
}

function failed () {
  return new Error('failed to derive shared secret')
}

function isZero (bytes) {
  let d = 0
  for (let i = 0; i < bytes.length; i++) d |= bytes[i]
  return d === 0
}

// Little-endian bytes -> BigInt.
function toBigIntLE (bytes) {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

function crypto_scalarmult_ed25519_noclamp (q, n, p) {
  check(q, crypto_scalarmult_ed25519_BYTES)
  check(n, crypto_scalarmult_ed25519_SCALARBYTES)
  check(p, crypto_scalarmult_ed25519_BYTES)

  // ge25519_is_canonical + ge25519_frombytes (zip215 = false: y < p, and
  // x = 0 needs a clear sign bit), then ge25519_has_small_order.
  let P
  try {
    P = Point.fromBytes(p.subarray(0, crypto_scalarmult_ed25519_BYTES), false)
  } catch {
    throw failed()
  }
  if (P.isSmallOrder()) throw failed()

  // Prime-order subgroup: L * P must be the identity. noble rejects the
  // scalar L itself, so L * P = (L - 1) * P + P.
  const LP = P.multiplyUnsafe(L - 1n).add(P)
  if (!LP.is0()) throw failed()

  // t = n with bit 255 cleared, as libsodium does before ge25519_scalarmult.
  const scalar = n.subarray(0, crypto_scalarmult_ed25519_SCALARBYTES)
  const t = toBigIntLE(scalar) & ((1n << 255n) - 1n)
  const s = t % L
  // Point.multiply (constant-time path for a non-base point) requires
  // 1 <= s < L.
  const Q = s === 0n ? Point.ZERO : P.multiply(s)

  // _crypto_scalarmult_ed25519_is_inf(q) and sodium_is_zero(n), as libsodium.
  if (Q.is0() || isZero(scalar)) throw failed()
  q.set(Q.toBytes(), 0)
}

module.exports = {
  ...sodium,
  crypto_scalarmult_ed25519_BYTES,
  crypto_scalarmult_ed25519_noclamp
}
