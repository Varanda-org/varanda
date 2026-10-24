'use strict'

// The account-link proof (docs/rpc.md 5.18): the member's diary key signs a
// domain-separated statement that binds one account-service step (phase and
// single-use nonce) to the member, the requested @username, the association
// and, at 'finish', the Google subject. The bytes start with
// 'varanda-account-link-v1', so a signature over them can never be a member
// certificate (varanda-cert-v1), an issuer delegation (varanda-issuer-v1) or
// a Hypercore block signature, and vice versa.
//
// Pure: b4a and hypercore-crypto only (loaded by the browser bundle and the
// account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const PREFIX = 'varanda-account-link-v1'
const PHASES = Object.freeze(['reserve', 'finish', 'rename'])
// A base64url nonce of at least 32 bytes of entropy.
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
// Printable ASCII without space: a subject can never contain the LF that
// separates the fields.
const SUB_RE = /^[\x21-\x7e]{1,255}$/
// Duplicated from cert.js (USERNAME_RE) so this module stays free of '#fs'.
// A 6-hex name is refused: it reads like the app's fallback handle
// '@' + key.slice(0, 6) (apps/app/src/format.js).
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const HEX6 = /^[0-9a-f]{6}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

function isUsername (s) {
  return typeof s === 'string' && USERNAME_RE.test(s) && !HEX6.test(s)
}

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// -> null when the fields are a valid statement, else a short reason.
function checkFields (fields) {
  if (!isPlainObject(fields)) return 'fields'
  const { phase, nonce, member, username, association, sub } = fields
  if (!PHASES.includes(phase)) return 'phase'
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return 'nonce'
  if (typeof member !== 'string' || !HEX64.test(member)) return 'member'
  if (!isUsername(username)) return 'username'
  if (typeof association !== 'string' || !HEX64.test(association)) return 'association'
  if (phase === 'finish') {
    if (typeof sub !== 'string' || !SUB_RE.test(sub)) return 'sub'
  } else if (sub !== '') {
    return 'sub'
  }
  return null
}

// { phase, nonce, member, username, association, sub } -> the UTF-8 bytes of
// PREFIX, phase, nonce, member, username, association, sub joined by LF (no
// trailing LF). `sub` is '' for 'reserve' and 'rename'. Throws TypeError on
// a bad shape.
function accountLinkPayload (fields) {
  const reason = checkFields(fields)
  if (reason !== null) throw new TypeError('invalid account-link ' + reason)
  const { phase, nonce, member, username, association, sub } = fields
  return b4a.from([PREFIX, phase, nonce, member, username, association, sub].join('\n'), 'utf8')
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signAccountLink (fields, keyPair) {
  const payload = accountLinkPayload(fields)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key (the web diary key is
// the signer, packages/web-member/lib/diary-options.js). -> { ok: true } |
// { ok: false, reason: 'malformed' | 'bad-signature' }. Never throws.
function verifyAccountLink (fields, signatureHex) {
  try {
    if (checkFields(fields) !== null) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(accountLinkPayload(fields), b4a.from(signatureHex, 'hex'), b4a.from(fields.member, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

module.exports = {
  PREFIX,
  PHASES,
  NONCE_RE,
  SUB_RE,
  USERNAME_RE,
  isUsername,
  accountLinkPayload,
  signAccountLink,
  verifyAccountLink
}
