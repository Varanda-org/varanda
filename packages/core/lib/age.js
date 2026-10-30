'use strict'

// The age-verification request: the member's diary key signs a
// domain-separated statement saying "this linked member asks the account
// service to start (or read the result of) an age verification for this
// association", bound to a single-use account-service nonce so a signature
// can never be replayed into another request. The bytes start with
// 'varanda-age-v1', so a signature over them can never be an account link
// (varanda-account-link-v1), a terms acceptance (varanda-terms-v1), a signup
// invite request (varanda-invite-v1), a report (varanda-report-v1), a
// moderation request (varanda-mod-request-v1), a member certificate, an
// issuer delegation or a Hypercore block signature, and vice versa.
//
// It proves only that the member asked, never an age: the age band comes
// from the verification provider, and the account service records it with
// its own date. The statement carries NO date and nothing about the person.
//
// Pure: b4a and hypercore-crypto only (loaded by the browser bundle and the
// account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const PREFIX = 'varanda-age-v1'
const ACTIONS = Object.freeze(['session', 'result'])
// A base64url nonce of at least 32 bytes of entropy.
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// -> null when the fields are a valid statement, else a short reason.
function checkFields (fields) {
  if (!isPlainObject(fields)) return 'fields'
  const { action, nonce, member, association } = fields
  if (typeof action !== 'string' || !ACTIONS.includes(action)) return 'action'
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return 'nonce'
  if (typeof member !== 'string' || !HEX64.test(member)) return 'member'
  if (typeof association !== 'string' || !HEX64.test(association)) return 'association'
  return null
}

// { action, nonce, member, association } -> the UTF-8 bytes of PREFIX,
// action, nonce, member, association joined by LF (no trailing LF).
// Throws TypeError on a bad shape.
function agePayload (fields) {
  const reason = checkFields(fields)
  if (reason !== null) throw new TypeError('invalid age ' + reason)
  const { action, nonce, member, association } = fields
  return b4a.from([PREFIX, action, nonce, member, association].join('\n'), 'utf8')
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signAge (fields, keyPair) {
  const payload = agePayload(fields)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key (the diary key is the
// signer). -> { ok: true } | { ok: false, reason: 'malformed' |
// 'bad-signature' }. Never throws.
function verifyAge (fields, signatureHex) {
  try {
    if (checkFields(fields) !== null) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(agePayload(fields), b4a.from(signatureHex, 'hex'), b4a.from(fields.member, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

module.exports = {
  PREFIX,
  ACTIONS,
  NONCE_RE,
  agePayload,
  signAge,
  verifyAge
}
