'use strict'

// The flags of a WebAuthn authenticator data, read from the bytes a ceremony
// returns (getAuthenticatorData(), or the 'authData' entry of the
// attestationObject). New passkeys must be backup eligible (BE): a passkey
// bound to one device would lock the member out of the identity on every
// other device. With attestation 'none' the flag is self-reported, so this is
// a steer, not a guarantee, and 'unknown' (nothing parses) is accepted.
//
// apps/app/src/authenticatorData.js is the same code as ESM: Metro never
// bundles packages/web-member, so the app keeps its own copy, and
// apps/app/test/passkeyOptions.test.js feeds both one fixture table.
//
// No Node built-in and no dependency: this runs in browsers too.

const MAX_BYTES = 64 * 1024
const MAX_DEPTH = 16
const MIN_AUTH_DATA = 37
const FLAGS_INDEX = 32

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40
const ED = 0x80

// utf8('authData')
const AUTH_DATA_KEY = [0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61]

// A fresh Uint8Array copy of an ArrayBuffer or any view, or null. WebAuthn
// hands out ArrayBuffers; copying keeps the parser on memory it owns.
function copyBytes (value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
  return null
}

// -> { flags: { up, uv, be, bs, at, ed } } or null when shorter than the
// fixed 37-byte prefix (rpIdHash 32, flags 1, signCount 4).
function parseAuthData (value) {
  const bytes = copyBytes(value)
  if (bytes === null || bytes.byteLength < MIN_AUTH_DATA) return null
  const f = bytes[FLAGS_INDEX]
  return {
    flags: {
      up: (f & UP) !== 0,
      uv: (f & UV) !== 0,
      be: (f & BE) !== 0,
      bs: (f & BS) !== 0,
      at: (f & AT) !== 0,
      ed: (f & ED) !== 0
    }
  }
}

// One CBOR item head at pos -> { major, info, arg, end } or null. Indefinite
// lengths and reserved additional info are refused.
function head (bytes, pos) {
  if (pos >= bytes.length) return null
  const first = bytes[pos]
  const major = first >> 5
  const info = first & 0x1f
  let size = 0
  if (info < 24) return { major, info, arg: info, end: pos + 1 }
  if (info === 24) size = 1
  else if (info === 25) size = 2
  else if (info === 26) size = 4
  else if (info === 27) size = 8
  else return null
  if (pos + 1 + size > bytes.length) return null
  let arg = 0
  for (let i = 0; i < size; i++) arg = arg * 256 + bytes[pos + 1 + i]
  return { major, info, arg, end: pos + 1 + size }
}

// The position after one well-formed definite-length item, or -1.
function skip (bytes, pos, depth) {
  if (depth > MAX_DEPTH) return -1
  const h = head(bytes, pos)
  if (h === null) return -1
  switch (h.major) {
    case 0:
    case 1:
      return h.end
    case 2:
    case 3:
      return h.arg <= bytes.length - h.end ? h.end + h.arg : -1
    case 4:
    case 5: {
      const count = h.major === 5 ? h.arg * 2 : h.arg
      let p = h.end
      // Every item takes at least one byte, so a huge count fails fast.
      if (count > bytes.length - p) return -1
      for (let i = 0; i < count; i++) {
        p = skip(bytes, p, depth + 1)
        if (p < 0) return -1
      }
      return p
    }
    case 6:
      return skip(bytes, h.end, depth + 1)
    default:
      // Major 7: simple values and floats. A one-byte simple value below 32
      // is not well formed (RFC 8949 section 3.3).
      if (h.info === 24 && h.arg < 32) return -1
      return h.end
  }
}

function isAuthDataKey (bytes, start, length) {
  if (length !== AUTH_DATA_KEY.length) return false
  for (let i = 0; i < length; i++) {
    if (bytes[start + i] !== AUTH_DATA_KEY[i]) return false
  }
  return true
}

// The 'authData' byte string of an attestationObject (a CBOR map with text
// keys), copied, or null on anything unexpected: not a map, a non-text key,
// a duplicate or non-bytes authData, trailing bytes, over 64 KiB.
function authDataFromAttestationObject (value) {
  const bytes = copyBytes(value)
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null
  const top = head(bytes, 0)
  if (top === null || top.major !== 5) return null
  if (top.arg * 2 > bytes.length - top.end) return null
  let pos = top.end
  let found = null
  for (let i = 0; i < top.arg; i++) {
    const key = head(bytes, pos)
    if (key === null || key.major !== 3 || key.arg > bytes.length - key.end) return null
    const isAuthData = isAuthDataKey(bytes, key.end, key.arg)
    pos = key.end + key.arg
    if (isAuthData) {
      if (found !== null) return null
      const val = head(bytes, pos)
      if (val === null || val.major !== 2 || val.arg > bytes.length - val.end) return null
      found = bytes.slice(val.end, val.end + val.arg)
      pos = val.end + val.arg
    } else {
      pos = skip(bytes, pos, 1)
      if (pos < 0) return null
    }
  }
  if (pos !== bytes.length) return null
  return found
}

// 'synced' (BE set), 'bound' (BE clear) or 'unknown' (nothing parses). The
// authenticator data wins over the attestationObject when both parse. BS
// (backed up right now) is not an input: a fresh synced passkey may not have
// reached the cloud yet.
function syncState ({ authenticatorData = null, attestationObject = null } = {}) {
  let parsed = authenticatorData === null ? null : parseAuthData(authenticatorData)
  if (parsed === null && attestationObject !== null) {
    const fromObject = authDataFromAttestationObject(attestationObject)
    if (fromObject !== null) parsed = parseAuthData(fromObject)
  }
  if (parsed === null) return 'unknown'
  return parsed.flags.be ? 'synced' : 'bound'
}

module.exports = {
  parseAuthData,
  authDataFromAttestationObject,
  syncState
}
