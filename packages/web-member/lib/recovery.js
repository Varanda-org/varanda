'use strict'

// Member recovery (docs/protocol.md, member recovery): the member's root
// secret (the first passkey's PRF output) is wrapped under keys derived from
// a second passkey's PRF output or from a recovery code, so either one can
// bring the same identity back. Everything is browser bundleable: no Node
// built-in, sodium-universal resolved the way @varanda/core/lib/group-crypto
// does (scripts/build.js remaps it).
//
//   lookupId = HKDF-SHA-256(ikm = secret, salt = utf8('varanda/member-recovery/hkdf/v1'),
//                           info = utf8('varanda/member-recovery/lookup/v1') || kindByte, 32)
//   wrapKey  = HKDF-SHA-256(ikm = secret, salt = utf8('varanda/member-recovery/hkdf/v1'),
//                           info = utf8('varanda/member-recovery/wrap/v1') || kindByte, 32)
//   plaintext = 0x01 || kindByte || member public key (32) || root (32)   (66 bytes)
//   blob = { v: 1, kind, nonce: hex(24), ciphertext: hex(crypto_secretbox_easy) }
//
// kindByte: 0x01 'passkey' (secret = 32-byte PRF), 0x02 'code' (secret = the
// 20-byte recovery code secret).
//
// Secrets returned to the caller (wrapKey, the root from openRoot, decoded
// code secrets, hexToBytes32 output) are caller-owned: zero them when done.
// The module zeroes the temporary buffers it allocates; zeroing is best
// effort on Node and Bare and nominal in the browser, where
// sodium-javascript copies inputs internally.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const hypercoreCrypto = require('hypercore-crypto')

const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES
const MAC_BYTES = sodium.crypto_secretbox_MACBYTES

const WRAP_MARK = b4a.from('varanda-wrap-v1\n', 'utf8')
const WRAP_USER_ID_BYTES = 32
const WRAP_RANDOM_BYTES = WRAP_USER_ID_BYTES - WRAP_MARK.byteLength

const RECOVERY_HKDF_SALT = b4a.from('varanda/member-recovery/hkdf/v1', 'utf8')
const LOOKUP_INFO = b4a.from('varanda/member-recovery/lookup/v1', 'utf8')
const WRAP_INFO = b4a.from('varanda/member-recovery/wrap/v1', 'utf8')

const KIND_BYTES = { passkey: 0x01, code: 0x02 }
const SECRET_BYTES = { passkey: 32, code: 20 }

const BLOB_VERSION = 1
const PLAIN_VERSION = 0x01
const ROOT_BYTES = 32
const MEMBER_BYTES = 32
const PLAIN_BYTES = 2 + MEMBER_BYTES + ROOT_BYTES
const CIPHER_BYTES = PLAIN_BYTES + MAC_BYTES
const BLOB_KEYS = ['ciphertext', 'kind', 'nonce', 'v']

const CODE_BYTES = 20
const CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
const CODE_SECRET_SYMBOLS = 32
const CODE_CHECK_SYMBOLS = 4
const CODE_SYMBOLS = CODE_SECRET_SYMBOLS + CODE_CHECK_SYMBOLS
const CODE_GROUP = 4
const CODE_CHECK_DOMAIN = b4a.from('varanda/recovery-code/v1\n', 'utf8')

const HEX64_RE = /^[0-9a-f]{64}$/
const HEX_NONCE_RE = new RegExp('^[0-9a-f]{' + NONCE_BYTES * 2 + '}$')
const HEX_CIPHER_RE = new RegExp('^[0-9a-f]{' + CIPHER_BYTES * 2 + '}$')

function zero (buf) {
  if (buf) {
    try {
      buf.fill(0)
    } catch {}
  }
}

function isBytes (value, length) {
  return value instanceof Uint8Array && value.byteLength === length
}

function kindByteOf (kind) {
  if (!Object.prototype.hasOwnProperty.call(KIND_BYTES, kind)) throw new TypeError('recovery: tipo inválido')
  return KIND_BYTES[kind]
}

function hexOf (bytes) {
  return b4a.toString(b4a.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), 'hex')
}

// Decoded by hand: b4a.from(hex) would leave a copy in the shared buffer pool
// that nothing zeroes. -> a fresh Uint8Array(32), or null on anything that is
// not 64 lowercase hex characters.
function hexToBytes32 (hex) {
  if (typeof hex !== 'string' || !HEX64_RE.test(hex)) return null
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function defaultRandomBytes (n) {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

function randomFrom (randomBytes, n) {
  const fn = typeof randomBytes === 'function' ? randomBytes : defaultRandomBytes
  const raw = fn(n)
  if (!isBytes(raw, n)) throw new TypeError('recovery: randomBytes deve devolver ' + n + ' bytes')
  const out = new Uint8Array(raw)
  zero(raw)
  return out
}

// A WebAuthn user.id that marks the passkey as a recovery wrap: 16 random
// bytes then WRAP_MARK. The random part comes first so code that labels a
// passkey from the leading hex of its user id still shows random hex.
function newWrapUserId (randomBytes) {
  const rand = randomFrom(randomBytes, WRAP_RANDOM_BYTES)
  try {
    const out = new Uint8Array(WRAP_USER_ID_BYTES)
    out.set(rand, 0)
    out.set(WRAP_MARK, WRAP_RANDOM_BYTES)
    return out
  } finally {
    zero(rand)
  }
}

function isWrapUserId (value) {
  let bytes = null
  let owned = false
  if (value instanceof Uint8Array) {
    bytes = value
  } else if (typeof value === 'string') {
    bytes = hexToBytes32(value.toLowerCase())
    owned = true
  }
  try {
    if (!isBytes(bytes, WRAP_USER_ID_BYTES)) return false
    for (let i = 0; i < WRAP_MARK.byteLength; i++) {
      if (bytes[WRAP_RANDOM_BYTES + i] !== WRAP_MARK[i]) return false
    }
    return true
  } finally {
    if (owned) zero(bytes)
  }
}

// HKDF-SHA-256(ikm, salt, info, 32) -> a fresh Uint8Array. `derive`, when
// given, is an async (ikm, salt, info, length) -> bytes used instead of
// WebCrypto (the Bare worklet has no HKDF there, see lib/hkdf.js), as in
// lib/passkey.js. It receives copies, all zeroed before returning.
async function hkdf (secret, salt, info, derive) {
  const ikm = new Uint8Array(secret)
  const saltCopy = new Uint8Array(salt)
  const infoCopy = new Uint8Array(info)
  let out = null
  try {
    if (typeof derive === 'function') {
      out = await derive(ikm, saltCopy, infoCopy, 32)
    } else {
      const subtle = globalThis.crypto.subtle
      const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
      out = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: saltCopy, info: infoCopy }, key, 256))
    }
    if (!isBytes(out, 32)) throw new TypeError('recovery: resultado HKDF inválido')
    return new Uint8Array(out)
  } finally {
    zero(out)
    zero(ikm)
    zero(saltCopy)
    zero(infoCopy)
  }
}

function infoFor (label, kindByte) {
  const info = new Uint8Array(label.byteLength + 1)
  info.set(label, 0)
  info[label.byteLength] = kindByte
  return info
}

// secret: the 32-byte passkey PRF ('passkey') or the 20-byte code secret
// ('code'). -> { lookupId: hex64, wrapKey: Uint8Array(32) }; the caller
// zeroes wrapKey.
async function deriveRecoveryKeys (secret, kind, { hkdf: derive } = {}) {
  const kindByte = kindByteOf(kind)
  if (!isBytes(secret, SECRET_BYTES[kind])) throw new TypeError('recovery: segredo inválido')
  const lookupInfo = infoFor(LOOKUP_INFO, kindByte)
  const wrapInfo = infoFor(WRAP_INFO, kindByte)
  let lookup = null
  let wrapKey = null
  try {
    lookup = await hkdf(secret, RECOVERY_HKDF_SALT, lookupInfo, derive)
    wrapKey = await hkdf(secret, RECOVERY_HKDF_SALT, wrapInfo, derive)
    const result = { lookupId: hexOf(lookup), wrapKey }
    wrapKey = null
    return result
  } finally {
    zero(lookup)
    zero(wrapKey)
    zero(lookupInfo)
    zero(wrapInfo)
  }
}

function memberBytes (member) {
  if (isBytes(member, MEMBER_BYTES)) return new Uint8Array(member)
  if (typeof member === 'string') return hexToBytes32(member)
  return null
}

// -> { v: 1, kind, nonce, ciphertext }. Throws TypeError on a programming
// error (bad sizes, unknown kind); the message never carries a secret.
function wrapRoot ({ root, member, kind, wrapKey, randomBytes } = {}) {
  const kindByte = kindByteOf(kind)
  if (!isBytes(root, ROOT_BYTES)) throw new TypeError('recovery: raiz inválida')
  if (!isBytes(wrapKey, KEY_BYTES)) throw new TypeError('recovery: chave inválida')
  const memberKey = memberBytes(member)
  if (memberKey === null) {
    throw new TypeError('recovery: membro inválido')
  }
  const plain = b4a.alloc(PLAIN_BYTES)
  const key = b4a.alloc(KEY_BYTES)
  let nonce = null
  try {
    nonce = randomFrom(randomBytes, NONCE_BYTES)
    plain[0] = PLAIN_VERSION
    plain[1] = kindByte
    plain.set(memberKey, 2)
    plain.set(root, 2 + MEMBER_BYTES)
    key.set(wrapKey, 0)
    const cipher = b4a.alloc(CIPHER_BYTES)
    sodium.crypto_secretbox_easy(cipher, plain, b4a.from(nonce.buffer, nonce.byteOffset, nonce.byteLength), key)
    return { v: BLOB_VERSION, kind, nonce: hexOf(nonce), ciphertext: hexOf(cipher) }
  } finally {
    zero(plain)
    zero(key)
    zero(memberKey)
    zero(nonce)
  }
}

function isBlob (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== BLOB_KEYS.length || keys.some((k, i) => k !== BLOB_KEYS[i])) return false
  return value.v === BLOB_VERSION &&
    Object.prototype.hasOwnProperty.call(KIND_BYTES, value.kind) &&
    typeof value.nonce === 'string' && HEX_NONCE_RE.test(value.nonce) &&
    typeof value.ciphertext === 'string' && HEX_CIPHER_RE.test(value.ciphertext)
}

function hexToBuffer (hex) {
  const out = b4a.alloc(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// -> { root: Uint8Array(32), member: hex64 } or null. Never throws: the blob
// comes from the account service. opts.member (hex64 or 32 bytes), when
// given, must equal the member key sealed inside.
function openRoot (blob, wrapKey, { member } = {}) {
  let cipher = null
  let nonce = null
  let key = null
  let plain = null
  let expected = null
  try {
    if (!isBlob(blob) || !isBytes(wrapKey, KEY_BYTES)) return null
    if (member !== undefined) {
      expected = memberBytes(member)
      if (expected === null) return null
    }
    cipher = hexToBuffer(blob.ciphertext)
    nonce = hexToBuffer(blob.nonce)
    key = b4a.alloc(KEY_BYTES)
    key.set(wrapKey, 0)
    plain = b4a.alloc(PLAIN_BYTES)
    if (!sodium.crypto_secretbox_open_easy(plain, cipher, nonce, key)) return null
    if (plain[0] !== PLAIN_VERSION || plain[1] !== KIND_BYTES[blob.kind]) return null
    const sealedMember = plain.subarray(2, 2 + MEMBER_BYTES)
    if (expected !== null && !b4a.equals(sealedMember, expected)) return null
    return {
      root: new Uint8Array(plain.subarray(2 + MEMBER_BYTES, PLAIN_BYTES)),
      member: hexOf(sealedMember)
    }
  } catch {
    return null
  } finally {
    zero(cipher)
    zero(nonce)
    zero(key)
    zero(plain)
    zero(expected)
  }
}

// The first 20 bits (MSB first) of BLAKE2b-256(domain || secret).
function codeChecksum (secret) {
  const input = b4a.alloc(CODE_CHECK_DOMAIN.byteLength + CODE_BYTES)
  const digest = b4a.alloc(32)
  try {
    input.set(CODE_CHECK_DOMAIN, 0)
    input.set(secret, CODE_CHECK_DOMAIN.byteLength)
    hypercoreCrypto.hash(input, digest)
    return ((digest[0] << 12) | (digest[1] << 4) | (digest[2] >>> 4)) >>> 0
  } finally {
    zero(input)
    zero(digest)
  }
}

// 20 bytes -> 'xxxx-xxxx-...' (9 groups of 4 lowercase Crockford symbols:
// 32 for the secret, 4 for the checksum). The string is the secret: the
// caller shows it once and never logs it.
function encodeCode (secret) {
  if (!isBytes(secret, CODE_BYTES)) throw new TypeError('recovery: segredo do código inválido')
  const symbols = new Uint8Array(CODE_SYMBOLS)
  try {
    // 160 bits split into 5-bit groups: each 5 bytes give exactly 8 symbols.
    for (let block = 0; block < CODE_BYTES / 5; block++) {
      let acc = 0
      let bits = 0
      let s = block * 8
      for (let i = 0; i < 5; i++) {
        acc = ((acc << 8) | secret[block * 5 + i]) & 0x1fff
        bits += 8
        while (bits >= 5) {
          bits -= 5
          symbols[s++] = (acc >>> bits) & 31
        }
      }
    }
    const check = codeChecksum(secret)
    for (let i = 0; i < CODE_CHECK_SYMBOLS; i++) {
      symbols[CODE_SECRET_SYMBOLS + i] = (check >>> (15 - i * 5)) & 31
    }
    let out = ''
    for (let i = 0; i < CODE_SYMBOLS; i++) {
      if (i > 0 && i % CODE_GROUP === 0) out += '-'
      out += CODE_ALPHABET[symbols[i]]
    }
    return out
  } finally {
    zero(symbols)
  }
}

const DECODE_ALPHABET = CODE_ALPHABET.toUpperCase()

// Typed text -> the 20-byte secret (caller-owned), or null on anything that
// is not a well-formed code with a matching checksum. Case, spaces and
// hyphens are ignored; O reads as 0, I and L as 1. Never throws.
function decodeCode (text) {
  if (typeof text !== 'string') return null
  const symbols = new Uint8Array(CODE_SYMBOLS)
  let out = new Uint8Array(CODE_BYTES)
  try {
    const upper = text.toUpperCase()
    let n = 0
    for (let i = 0; i < upper.length; i++) {
      let c = upper[i]
      if (c === ' ' || c === '-') continue
      if (c === 'O') c = '0'
      else if (c === 'I' || c === 'L') c = '1'
      const v = DECODE_ALPHABET.indexOf(c)
      if (v < 0 || n >= CODE_SYMBOLS) return null
      symbols[n++] = v
    }
    if (n !== CODE_SYMBOLS) return null
    for (let block = 0; block < CODE_BYTES / 5; block++) {
      let acc = 0
      let bits = 0
      let o = block * 5
      for (let i = 0; i < 8; i++) {
        acc = ((acc << 5) | symbols[block * 8 + i]) & 0x1fff
        bits += 5
        if (bits >= 8) {
          bits -= 8
          out[o++] = (acc >>> bits) & 0xff
        }
      }
    }
    let check = 0
    for (let i = 0; i < CODE_CHECK_SYMBOLS; i++) check = (check << 5) | symbols[CODE_SECRET_SYMBOLS + i]
    if (check !== codeChecksum(out)) return null
    const result = out
    out = null
    return result
  } catch {
    return null
  } finally {
    zero(symbols)
    zero(out)
  }
}

module.exports = {
  WRAP_MARK,
  RECOVERY_HKDF_SALT,
  KIND_BYTES,
  CODE_BYTES,
  CODE_ALPHABET,
  newWrapUserId,
  isWrapUserId,
  deriveRecoveryKeys,
  wrapRoot,
  openRoot,
  isBlob,
  encodeCode,
  decodeCode,
  hexToBytes32
}
