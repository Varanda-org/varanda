'use strict'

// Server-side WebAuthn for Excluir conta (docs/protocol.md "Account
// deletion"): the public key of a passkey, read from the attestation object
// of its creation, and the check of a fresh assertion against that key.
// Node's own crypto only, for the two algorithms the app's creation options
// ask for (packages/web-member/lib/passkey.js createOptions): ES256 (ECDSA
// P-256 with SHA-256, DER signature) and RS256 (RSASSA-PKCS1-v1_5 with
// SHA-256).
//
// The attestation statement is never checked: creations use attestation
// 'none', so a key is trusted only through when and by whom it was enrolled
// (./passkey-routes.js), never through the authenticator's own word.
//
// Every parser returns null on bytes it would not accept and never throws on
// peer input. The CBOR reader takes definite lengths only, no tags and no
// floats, which is all a COSE key and an attestation object need.

const nodeCrypto = require('node:crypto')

const ES256 = -7
const RS256 = -257
const ALGS = Object.freeze([ES256, RS256])
const MIN_AUTH_DATA = 37
const MAX_CREDENTIAL_ID = 1023
const MAX_DEPTH = 8
// Raw byte caps of what a request may carry (base64url grows them by 4/3).
const MAX_ATTESTATION_BYTES = 2048
const MAX_CLIENT_DATA_BYTES = 1024
const MAX_AUTH_DATA_BYTES = 1024
const MAX_SIGNATURE_BYTES = 512
const MIN_RSA_BYTES = 256
const MAX_RSA_BYTES = 512

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40
const ED = 0x80

const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/
const HEX_RE = /^[0-9a-f]+$/
const ANDROID_CERT_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/

// A canonical base64url string (trailing '=' tolerated: some platforms pad)
// -> Buffer, or null. At most maxBytes once decoded.
function fromB64url (value, maxBytes) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxBytes * 4 / 3) + 2 || !B64URL_RE.test(value)) return null
  const bare = value.replace(/=+$/, '')
  if (bare.length % 4 === 1) return null
  const buf = Buffer.from(bare, 'base64url')
  if (buf.length === 0 || buf.length > maxBytes || buf.toString('base64url') !== bare) return null
  return buf
}

function sha256 (bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest()
}

// One CBOR item at pos -> { value, end } or null. Maps become Map (keys are
// integers or strings, no duplicates), byte strings Buffers.
function readItem (buf, pos, depth) {
  if (depth > MAX_DEPTH || pos >= buf.length) return null
  const first = buf[pos]
  const major = first >> 5
  const info = first & 0x1f
  let arg
  let p = pos + 1
  if (info < 24) {
    arg = info
  } else if (info === 24) {
    if (p + 1 > buf.length) return null
    arg = buf[p]
    p += 1
  } else if (info === 25) {
    if (p + 2 > buf.length) return null
    arg = buf.readUInt16BE(p)
    p += 2
  } else if (info === 26) {
    if (p + 4 > buf.length) return null
    arg = buf.readUInt32BE(p)
    p += 4
  } else {
    // 64-bit arguments, reserved values and indefinite lengths: never needed here.
    return null
  }
  switch (major) {
    case 0:
      return { value: arg, end: p }
    case 1:
      return { value: -1 - arg, end: p }
    case 2:
    case 3: {
      if (p + arg > buf.length) return null
      const bytes = buf.subarray(p, p + arg)
      if (major === 2) return { value: Buffer.from(bytes), end: p + arg }
      let text
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return null
      }
      return { value: text, end: p + arg }
    }
    case 4: {
      const out = []
      for (let i = 0; i < arg; i++) {
        const item = readItem(buf, p, depth + 1)
        if (item === null) return null
        out.push(item.value)
        p = item.end
      }
      return { value: out, end: p }
    }
    case 5: {
      const out = new Map()
      for (let i = 0; i < arg; i++) {
        const k = readItem(buf, p, depth + 1)
        if (k === null || (typeof k.value !== 'number' && typeof k.value !== 'string') || out.has(k.value)) return null
        const v = readItem(buf, k.end, depth + 1)
        if (v === null) return null
        out.set(k.value, v.value)
        p = v.end
      }
      return { value: out, end: p }
    }
    case 7:
      if (info === 20) return { value: false, end: p }
      if (info === 21) return { value: true, end: p }
      if (info === 22) return { value: null, end: p }
      return null
    default:
      return null
  }
}

// Authenticator data -> { rpIdHash, flags, signCount, attested } or null.
// attested is { credentialId, coseKey } when the AT flag is set. Extension
// data (ED) must be one CBOR map; nothing may follow it.
function parseAuthData (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_AUTH_DATA) return null
  const f = buf[32]
  const flags = { up: (f & UP) !== 0, uv: (f & UV) !== 0, be: (f & BE) !== 0, bs: (f & BS) !== 0, at: (f & AT) !== 0, ed: (f & ED) !== 0 }
  let pos = MIN_AUTH_DATA
  let attested = null
  if (flags.at) {
    if (pos + 18 > buf.length) return null
    pos += 16
    const idLen = buf.readUInt16BE(pos)
    pos += 2
    if (idLen < 1 || idLen > MAX_CREDENTIAL_ID || pos + idLen > buf.length) return null
    const credentialId = Buffer.from(buf.subarray(pos, pos + idLen))
    pos += idLen
    const key = readItem(buf, pos, 0)
    if (key === null || !(key.value instanceof Map)) return null
    attested = { credentialId, coseKey: key.value }
    pos = key.end
  }
  if (flags.ed) {
    const ext = readItem(buf, pos, 0)
    if (ext === null || !(ext.value instanceof Map)) return null
    pos = ext.end
  }
  if (pos !== buf.length) return null
  return { rpIdHash: Buffer.from(buf.subarray(0, 32)), flags, signCount: buf.readUInt32BE(33), attested }
}

function bytesOf (map, label, len) {
  const v = map.get(label)
  if (!Buffer.isBuffer(v)) return null
  if (len !== undefined && v.length !== len) return null
  return v
}

// A COSE_Key map -> { alg, spki: Buffer } or null. EC2 P-256 with ES256, or
// RSA (2048 to 4096 bits) with RS256; the point and the modulus are checked
// by node:crypto as it imports them.
function keyFromCose (map) {
  if (!(map instanceof Map)) return null
  const kty = map.get(1)
  const alg = map.get(3)
  let jwk
  if (kty === 2 && alg === ES256) {
    const x = bytesOf(map, -2, 32)
    const y = bytesOf(map, -3, 32)
    if (map.get(-1) !== 1 || x === null || y === null) return null
    jwk = { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') }
  } else if (kty === 3 && alg === RS256) {
    const n = bytesOf(map, -1)
    const e = bytesOf(map, -2)
    if (n === null || e === null || n.length < MIN_RSA_BYTES || n.length > MAX_RSA_BYTES || n[0] === 0 || e.length < 1 || e.length > 4) return null
    jwk = { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') }
  } else {
    return null
  }
  try {
    const key = nodeCrypto.createPublicKey({ key: jwk, format: 'jwk' })
    return { alg, spki: key.export({ type: 'spki', format: 'der' }) }
  } catch {
    return null
  }
}

// The key a creation carries. -> { alg, spki (hex), signCount } or null.
// attestationObject is base64url; credentialId (base64url) must be the one
// its authenticator data names, for this rpId, with user presence.
function keyFromAttestation ({ attestationObject, credentialId, rpId } = {}) {
  const raw = fromB64url(attestationObject, MAX_ATTESTATION_BYTES)
  const id = fromB64url(credentialId, MAX_CREDENTIAL_ID)
  if (raw === null || id === null || typeof rpId !== 'string' || rpId === '') return null
  const top = readItem(raw, 0, 0)
  if (top === null || top.end !== raw.length || !(top.value instanceof Map) || top.value.size !== 3) return null
  const fmt = top.value.get('fmt')
  const attStmt = top.value.get('attStmt')
  const authData = top.value.get('authData')
  if (typeof fmt !== 'string' || !(attStmt instanceof Map) || !Buffer.isBuffer(authData)) return null
  const parsed = parseAuthData(authData)
  if (parsed === null || parsed.attested === null || !parsed.flags.up) return null
  if (!parsed.rpIdHash.equals(sha256(Buffer.from(rpId, 'utf8')))) return null
  if (!parsed.attested.credentialId.equals(id)) return null
  const key = keyFromCose(parsed.attested.coseKey)
  if (key === null) return null
  return { alg: key.alg, spki: key.spki.toString('hex'), signCount: parsed.signCount }
}

// The hex SHA-256 of an attestation object's bytes (what the diary key signs
// at account-link phase 'passkey'), or null when it does not decode.
function attestationHash (attestationObject) {
  const raw = fromB64url(attestationObject, MAX_ATTESTATION_BYTES)
  return raw === null ? null : sha256(raw).toString('hex')
}

function plainObject (o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype
}

// A fresh assertion against a stored key. assertion = { credentialId,
// clientDataJSON, authenticatorData, signature } (base64url); key = { alg,
// spki (hex), signCount }; challenge = the Buffer the ceremony had to sign;
// origins = the allowed clientData origins.
// -> { ok: true, signCount } or { ok: false, reason }, reason one of
// 'forma', 'tipo', 'desafio', 'origem', 'rp', 'verificacao', 'assinatura',
// 'contador'. The credential id is the caller's to match.
function verifyAssertion ({ assertion, key, challenge, rpId, origins } = {}) {
  if (!plainObject(assertion) || !plainObject(key) || !Buffer.isBuffer(challenge) || typeof rpId !== 'string' || !Array.isArray(origins)) return { ok: false, reason: 'forma' }
  const clientData = fromB64url(assertion.clientDataJSON, MAX_CLIENT_DATA_BYTES)
  const authData = fromB64url(assertion.authenticatorData, MAX_AUTH_DATA_BYTES)
  const signature = fromB64url(assertion.signature, MAX_SIGNATURE_BYTES)
  if (clientData === null || authData === null || signature === null) return { ok: false, reason: 'forma' }
  if (!ALGS.includes(key.alg) || typeof key.spki !== 'string' || !HEX_RE.test(key.spki) || !Number.isSafeInteger(key.signCount) || key.signCount < 0) return { ok: false, reason: 'forma' }
  let cd
  try {
    cd = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientData))
  } catch {
    return { ok: false, reason: 'forma' }
  }
  if (!plainObject(cd)) return { ok: false, reason: 'forma' }
  if (cd.type !== 'webauthn.get') return { ok: false, reason: 'tipo' }
  if (typeof cd.challenge !== 'string' || cd.challenge.replace(/=+$/, '') !== challenge.toString('base64url')) return { ok: false, reason: 'desafio' }
  if (typeof cd.origin !== 'string' || !origins.includes(cd.origin)) return { ok: false, reason: 'origem' }
  if (cd.crossOrigin !== undefined && cd.crossOrigin !== false) return { ok: false, reason: 'origem' }
  if (cd.topOrigin !== undefined) return { ok: false, reason: 'origem' }
  const parsed = parseAuthData(authData)
  if (parsed === null || parsed.attested !== null) return { ok: false, reason: 'forma' }
  if (!parsed.rpIdHash.equals(sha256(Buffer.from(rpId, 'utf8')))) return { ok: false, reason: 'rp' }
  if (!parsed.flags.up || !parsed.flags.uv) return { ok: false, reason: 'verificacao' }
  let verified = false
  try {
    const pub = nodeCrypto.createPublicKey({ key: Buffer.from(key.spki, 'hex'), format: 'der', type: 'spki' })
    const data = Buffer.concat([authData, sha256(clientData)])
    verified = key.alg === ES256
      ? nodeCrypto.verify('sha256', data, { key: pub, dsaEncoding: 'der' }, signature)
      : nodeCrypto.verify('sha256', data, { key: pub, padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, signature)
  } catch {
    verified = false
  }
  if (!verified) return { ok: false, reason: 'assinatura' }
  // Synced passkeys report 0 every time; a counter that ever moved must keep
  // moving, or the credential may have been cloned.
  if ((key.signCount !== 0 || parsed.signCount !== 0) && parsed.signCount <= key.signCount) return { ok: false, reason: 'contador' }
  return { ok: true, signCount: parsed.signCount }
}

// The rpId and the clientData origins a passkey of this installation may
// report: the public origin (the web, the PWA and the iOS app, which reports
// https://<rpId>), and the Android app's 'android:apk-key-hash:' origin when
// the signing certificate's SHA-256 is configured (the same
// VARANDA_ANDROID_CERT_SHA256 deploy/seeder/well-known.sh publishes in
// assetlinks.json). -> { rpId, origins }; throws TypeError on a bad value.
function passkeyOrigins ({ origin, androidCertSha256 = '' } = {}) {
  let url
  try {
    url = new URL(origin)
  } catch {
    throw new TypeError('invalid origin')
  }
  const origins = [url.origin]
  if (androidCertSha256 !== '' && androidCertSha256 !== undefined && androidCertSha256 !== null) {
    if (typeof androidCertSha256 !== 'string' || !ANDROID_CERT_RE.test(androidCertSha256)) throw new TypeError('invalid android certificate fingerprint')
    origins.push('android:apk-key-hash:' + Buffer.from(androidCertSha256.replace(/:/g, ''), 'hex').toString('base64url'))
  }
  return { rpId: url.hostname, origins }
}

module.exports = {
  ES256,
  RS256,
  MAX_CREDENTIAL_ID,
  MAX_ATTESTATION_BYTES,
  MAX_CLIENT_DATA_BYTES,
  MAX_AUTH_DATA_BYTES,
  MAX_SIGNATURE_BYTES,
  fromB64url,
  parseAuthData,
  keyFromCose,
  keyFromAttestation,
  attestationHash,
  verifyAssertion,
  passkeyOrigins
}
