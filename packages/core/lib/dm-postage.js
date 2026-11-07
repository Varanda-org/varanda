'use strict'

// Direct message stamps (docs/protocol.md section 11): a Chaum blind RSA
// signature, RSA-2048 with e = 65537 and a full-domain hash. The seeder
// signs a blinded value, so it cannot link the stamp it issued to the drop
// that spends it. BigInt only: core also runs on Bare, without node:crypto.
//
// BigInt modexp is not constant-time. A timing leak on d lets someone forge
// stamps (spam); it never decrypts a drop.
//
// Blob stamps (the media chunk channel) use the same scheme under their own
// full-domain-hash domain AND their own RSA key pair, kid and rotation list
// on the seeder. The domain alone would not split the budgets: sign() signs
// any blinded integer and the domain is applied by the client before
// blinding, so with one key a request for a blob stamp could mint a DM
// stamp. With two keys a DM token verifies only under a DM key and a blob
// token only under a blob key.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { DM_STAMP_FDH_DOMAIN } = require('./dm')

const MODULUS_BYTES = 256
const TOKEN_BYTES = 32
const KID_BYTES = 8
const E = 65537n
const BLOB_STAMP_FDH_DOMAIN = 'varanda/blob-stamp-fdh/v1'
const BLOB_STAMPS_PER_DAY = 1024
const STAMP_KINDS = Object.freeze(['dm', 'blob'])
const DOMAINS = Object.freeze({
  dm: b4a.from(DM_STAMP_FDH_DOMAIN, 'utf8'),
  blob: b4a.from(BLOB_STAMP_FDH_DOMAIN, 'utf8')
})
const DECIMAL = /^[1-9][0-9]*$/
const HEX16 = /^[0-9a-f]{16}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function isBytes (x, len) {
  return x instanceof Uint8Array && (len === undefined || x.byteLength === len)
}

function isPlainObject (x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function bytesToBig (bytes) {
  let hex = b4a.toString(bytes, 'hex')
  if (hex === '') hex = '0'
  return BigInt('0x' + hex)
}

// Fixed-width big-endian; throws when x does not fit.
function bigToBytes (x, len = MODULUS_BYTES) {
  if (typeof x !== 'bigint' || x < 0n) throw new TypeError('expected a non-negative BigInt')
  const hex = x.toString(16)
  if (hex.length > len * 2) throw new TypeError('integer too large')
  return b4a.from(hex.padStart(len * 2, '0'), 'hex')
}

function modPow (base, exp, mod) {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    e >>= 1n
    b = (b * b) % mod
  }
  return result
}

function gcd (a, b) {
  while (b !== 0n) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

function modInverse (a, m) {
  let [r0, r1] = [a % m, m]
  let [s0, s1] = [1n, 0n]
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1]
  }
  if (r0 !== 1n) return null
  return ((s0 % m) + m) % m
}

function sha256 (bytes) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, bytes)
  return out
}

function domainOf (kind) {
  if (kind !== 'dm' && kind !== 'blob') throw new TypeError('unknown stamp kind')
  return DOMAINS[kind]
}

// MGF1 with SHA-256 over domain || token, MODULUS_BYTES long. kind picks the
// domain: 'dm' (the default, so older callers keep their tokens) or 'blob'.
function representative (token, kind = 'dm') {
  const domain = domainOf(kind)
  if (!isBytes(token, TOKEN_BYTES)) throw new TypeError('token must be ' + TOKEN_BYTES + ' bytes')
  const seed = b4a.concat([domain, token])
  const blocks = []
  const counter = b4a.alloc(4)
  for (let i = 0; i * 32 < MODULUS_BYTES; i++) {
    counter[0] = i >>> 24
    counter[1] = (i >>> 16) & 0xff
    counter[2] = (i >>> 8) & 0xff
    counter[3] = i & 0xff
    blocks.push(sha256(b4a.concat([seed, counter])))
  }
  return bytesToBig(b4a.concat(blocks).subarray(0, MODULUS_BYTES))
}

// A token whose representative is not below n cannot be signed: the client
// draws another.
function isUsableToken (token, n, kind = 'dm') {
  if (!isBytes(token, TOKEN_BYTES) || typeof n !== 'bigint' || !STAMP_KINDS.includes(kind)) return false
  const rep = representative(token, kind)
  return rep > 0n && rep < n && gcd(rep, n) === 1n
}

function randomBelow (n) {
  const buf = b4a.alloc(MODULUS_BYTES)
  for (;;) {
    sodium.randombytes_buf(buf)
    const x = bytesToBig(buf)
    if (x >= 1n && x < n) return x
  }
}

function newToken (n, kind = 'dm') {
  domainOf(kind)
  for (;;) {
    const token = b4a.alloc(TOKEN_BYTES)
    sodium.randombytes_buf(token)
    if (isUsableToken(token, n, kind)) return token
  }
}

function blind (rep, n, e = E) {
  if (typeof rep !== 'bigint' || typeof n !== 'bigint' || typeof e !== 'bigint') throw new TypeError('expected BigInt arguments')
  if (rep < 1n || rep >= n) throw new TypeError('representative out of range')
  for (;;) {
    const r = randomBelow(n)
    if (gcd(r, n) !== 1n) continue
    return { blinded: (rep * modPow(r, e, n)) % n, r }
  }
}

// The seeder side. Refuses (null) a value outside the group of units.
function sign (blinded, n, d) {
  if (typeof blinded !== 'bigint' || typeof n !== 'bigint' || typeof d !== 'bigint') return null
  if (blinded < 1n || blinded >= n || gcd(blinded, n) !== 1n) return null
  return modPow(blinded, d, n)
}

function unblind (sig, r, n) {
  if (typeof sig !== 'bigint' || typeof r !== 'bigint' || typeof n !== 'bigint') throw new TypeError('expected BigInt arguments')
  const inv = modInverse(r, n)
  if (inv === null) throw new TypeError('r is not invertible')
  return (sig * inv) % n
}

function kidOf (n) {
  if (typeof n !== 'bigint' || n < 1n) throw new TypeError('expected a positive BigInt')
  return b4a.toString(hcrypto.hash(b4a.from(n.toString(10), 'utf8')).subarray(0, KID_BYTES), 'hex')
}

function publicKey (n, e = E) {
  return { v: 1, kid: kidOf(n), n: n.toString(10), e: e.toString(10) }
}

// { n, e } as BigInts or null. Never throws.
function parsePublicKey (pub) {
  try {
    if (!isPlainObject(pub) || Object.keys(pub).length !== 4 || pub.v !== 1) return null
    if (typeof pub.kid !== 'string' || !HEX16.test(pub.kid)) return null
    if (typeof pub.n !== 'string' || !DECIMAL.test(pub.n) || pub.e !== '65537') return null
    const n = BigInt(pub.n)
    if ((n & 1n) === 0n || n.toString(16).length !== MODULUS_BYTES * 2) return null
    if (kidOf(n) !== pub.kid) return null
    return { n, e: E }
  } catch {
    return null
  }
}

// sig: MODULUS_BYTES big-endian bytes or a BigInt. kind must match the key's
// kind: the caller passes a DM key with 'dm' and a blob key with 'blob'.
// Never throws.
function verify (token, sig, pub, kind = 'dm') {
  try {
    const key = parsePublicKey(pub)
    if (key === null || !isBytes(token, TOKEN_BYTES) || !STAMP_KINDS.includes(kind)) return false
    let s
    if (typeof sig === 'bigint') s = sig
    else if (isBytes(sig, MODULUS_BYTES)) s = bytesToBig(sig)
    else return false
    if (s < 1n || s >= key.n) return false
    const rep = representative(token, kind)
    if (rep >= key.n) return false
    return modPow(s, key.e, key.n) === rep
  } catch {
    return false
  }
}

// Canonical base64 of a fixed MODULUS_BYTES big-endian integer.
function toBase64 (x) {
  return b4a.toString(bigToBytes(x, MODULUS_BYTES), 'base64')
}

function fromBase64 (s) {
  try {
    if (typeof s !== 'string' || !BASE64.test(s)) return null
    const bytes = b4a.from(s, 'base64')
    if (bytes.byteLength !== MODULUS_BYTES || b4a.toString(bytes, 'base64') !== s) return null
    return bytesToBig(bytes)
  } catch {
    return null
  }
}

module.exports = Object.freeze({
  MODULUS_BYTES,
  TOKEN_BYTES,
  KID_BYTES,
  E,
  BLOB_STAMP_FDH_DOMAIN,
  BLOB_STAMPS_PER_DAY,
  STAMP_KINDS,
  representative,
  isUsableToken,
  newToken,
  blind,
  sign,
  unblind,
  verify,
  kidOf,
  publicKey,
  parsePublicKey,
  bytesToBig,
  bigToBytes,
  toBase64,
  fromBase64,
  modPow,
  gcd
})
