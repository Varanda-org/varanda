'use strict'

// The push-subscription proof: the member's diary key signs a
// domain-separated statement saying "turn Web Push notices on (or off) for
// this browser subscription, for this association", bound to a single-use
// account-service nonce so a signature can never be replayed into another
// opt-in. The bytes start with 'varanda-push-v1', so a signature over them
// can never be a terms acceptance (varanda-terms-v1), an account link
// (varanda-account-link-v1), a report (varanda-report-v1) or any other
// signed statement, and vice versa.
//
// The endpoint URL itself is not signed, only its hash: the account service
// recomputes the hash from the URL it receives, and the statement stays
// short and free of a URL that may change shape across browsers.
//
// Pure: b4a and hypercore-crypto only (loaded by the browser bundle and the
// account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const PREFIX = 'varanda-push-v1'
const PUSH_ACTIONS = Object.freeze(['on', 'off'])
// A base64url nonce of at least 32 bytes of entropy (same rule as terms.js).
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const ENDPOINT_MAX = 2048
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const KEYS = ['nonce', 'member', 'association', 'action', 'endpointHash', 'p256dh', 'auth']
// Unpadded base64url of exactly 65 bytes (an uncompressed P-256 point) and
// of exactly 16 bytes (the RFC 8291 auth secret).
const P256DH_RE = /^[A-Za-z0-9_-]{87}$/
const AUTH_RE = /^[A-Za-z0-9_-]{22}$/

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// -> the decoded bytes, or null unless `s` is the canonical unpadded
// base64url of exactly `len` bytes (non-zero trailing bits would let two
// strings stand for one key).
function decodeB64url (s, re, len) {
  if (typeof s !== 'string' || !re.test(s)) return null
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  const bytes = b4a.from(std + '='.repeat((4 - (std.length % 4)) % 4), 'base64')
  if (bytes.byteLength !== len) return null
  const back = b4a.toString(bytes, 'base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return back === s ? bytes : null
}

// The hashed string must be exactly what fetch would request: the WHATWG
// URL parser strips tab, CR and LF, reads a backslash as '/', and UTF-8 encoding
// turns a lone surrogate into U+FFFD, so any of those would let two strings
// hash differently for one endpoint (or one hash stand for two). Printable
// ASCII only, no backslash, no fragment and no userinfo.
function isEndpoint (url) {
  if (typeof url !== 'string' || url.length < 1 || url.length > ENDPOINT_MAX || !url.startsWith('https://')) return false
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c < 0x21 || c > 0x7e || c === 0x5c || c === 0x23) return false
  }
  const rest = url.slice(8)
  const end = rest.search(/[/?]/)
  return !(end === -1 ? rest : rest.slice(0, end)).includes('@')
}

function endpointHash (url) {
  if (!isEndpoint(url)) throw new TypeError('invalid push endpoint')
  return b4a.toString(crypto.hash(b4a.from(url, 'utf8')), 'hex')
}

// Reads every field exactly once into a fresh object, so a getter or a
// proxy cannot answer one value to the check and another to the signer.
// -> { snapshot } when the fields are a valid statement, else { reason }.
function snapshotFields (fields) {
  if (!isPlainObject(fields)) return { reason: 'fields' }
  const own = Reflect.ownKeys(fields)
  if (own.length !== KEYS.length) return { reason: 'fields' }
  const snapshot = {}
  for (const key of KEYS) {
    const d = Object.getOwnPropertyDescriptor(fields, key)
    if (d === undefined || !('value' in d)) return { reason: 'fields' }
    snapshot[key] = d.value
  }
  const { nonce, member, association, action, endpointHash, p256dh, auth } = snapshot
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { reason: 'nonce' }
  if (typeof member !== 'string' || !HEX64.test(member)) return { reason: 'member' }
  if (typeof association !== 'string' || !HEX64.test(association)) return { reason: 'association' }
  if (!PUSH_ACTIONS.includes(action)) return { reason: 'action' }
  if (typeof endpointHash !== 'string' || !HEX64.test(endpointHash)) return { reason: 'endpointHash' }
  const point = decodeB64url(p256dh, P256DH_RE, 65)
  if (point === null || point[0] !== 0x04) return { reason: 'p256dh' }
  if (decodeB64url(auth, AUTH_RE, 16) === null) return { reason: 'auth' }
  return { snapshot }
}

function payloadOf (s) {
  return b4a.from([PREFIX, s.nonce, s.member, s.association, s.action, s.endpointHash, s.p256dh, s.auth].join('\n'), 'utf8')
}

// { nonce, member, association, action, endpointHash, p256dh, auth } -> the
// UTF-8 bytes of PREFIX and the fields in that order joined by LF (no
// trailing LF). Throws TypeError on a bad shape or an extra key.
function pushPayload (fields) {
  const { snapshot, reason } = snapshotFields(fields)
  if (snapshot === undefined) throw new TypeError('invalid push ' + reason)
  return payloadOf(snapshot)
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signPush (fields, keyPair) {
  const payload = pushPayload(fields)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key (the diary key is the
// signer). -> { ok: true } | { ok: false, reason: 'malformed' |
// 'bad-signature' }. Never throws.
function verifyPush (fields, signatureHex) {
  try {
    const { snapshot } = snapshotFields(fields)
    if (snapshot === undefined) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(payloadOf(snapshot), b4a.from(signatureHex, 'hex'), b4a.from(snapshot.member, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

module.exports = {
  PREFIX,
  PUSH_ACTIONS,
  NONCE_RE,
  ENDPOINT_MAX,
  endpointHash,
  pushPayload,
  signPush,
  verifyPush
}
