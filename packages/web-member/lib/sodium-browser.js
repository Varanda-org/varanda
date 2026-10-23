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
// Contract mirrored from libsodium's _crypto_scalarmult_ed25519 (clamp = 0):
//   q = n * P, P the compressed Edwards point `p`, n the 32-byte little-endian
//   scalar WITHOUT clamping. Fails when `p` is not a canonical encoding
//   (y >= 2^255 - 19, or x = 0 with the sign bit set), is not on the curve,
//   has small order (libsodium's blacklist: the 8-element torsion subgroup,
//   ignoring the sign bit) or fails ge25519_is_on_main_subgroup; when n is
//   all zero; and when the result is the identity encoding.
//   ge25519_is_on_main_subgroup tests only the X coordinate of L * P
//   (fe25519_iszero(pl.X)), so besides the prime-order subgroup it accepts
//   the points P0 + (0, -1) of order 2L (verified against sodium-native
//   5.2.0: it accepts them and returns L * P = (0, -1) for them). Mirrored
//   here: accept when L * P is the identity or (0, -1).
//   libsodium clears bit 255 of the scalar before multiplying (t[31] &= 127)
//   even without clamping, so the effective scalar is t = n mod 2^255, used
//   in full by ge25519_scalarmult. With t = k * L + s this is
//   s * P + (k mod 2) * (L * P), which is what is computed below (L * P is
//   the identity or the order-2 point).
// Failure: sodium-native 5.x throws (Error 'failed to derive shared secret'
// from the binding), so this throws the same Error rather than returning -1;
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
const Fp = Point.Fp
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

  // ge25519_is_on_main_subgroup: X of L * P must be zero, i.e. L * P is the
  // identity (0, 1) or the order-2 point (0, -1). noble rejects the scalar L
  // itself, so L * P = (L - 1) * P + P.
  const LP = P.multiplyUnsafe(L - 1n).add(P)
  if (!Fp.is0(LP.toAffine().x)) throw failed()

  // t = n with bit 255 cleared, as libsodium does before ge25519_scalarmult.
  const scalar = n.subarray(0, crypto_scalarmult_ed25519_SCALARBYTES)
  const t = toBigIntLE(scalar) & ((1n << 255n) - 1n)
  const s = t % L
  const k = t / L
  // Point.multiply (constant-time path for a non-base point, no blinding, so
  // it is exact for an order-2L point too) requires 1 <= s < L.
  let Q = s === 0n ? Point.ZERO : P.multiply(s)
  if ((k & 1n) === 1n) Q = Q.add(LP)

  // _crypto_scalarmult_ed25519_is_inf(q) and sodium_is_zero(n), as libsodium.
  if (Q.is0() || isZero(scalar)) throw failed()
  q.set(Q.toBytes(), 0)
}

module.exports = {
  ...sodium,
  crypto_scalarmult_ed25519_BYTES,
  crypto_scalarmult_ed25519_noclamp
}
