'use strict'

// The terms-acceptance proof: the member's diary key signs a domain-separated
// statement saying "this diary key accepted version N of the Termos de Uso
// and the Política de Privacidade for this association", bound to a
// single-use account-service nonce so a signature can never be replayed into
// another acceptance. The bytes start with 'varanda-terms-v1', so a
// signature over them can never be an account link
// (varanda-account-link-v1), a report (varanda-report-v1), a moderation
// request (varanda-mod-request-v1), a member certificate, an issuer
// delegation or a Hypercore block signature, and vice versa.
//
// The statement carries NO date: the account service records its own when it
// accepts the proof.
//
// Pure: b4a and hypercore-crypto only (loaded by the browser bundle and the
// account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const PREFIX = 'varanda-terms-v1'
// Must always equal apps/app/src/legal.js LEGAL_VERSION (pinned by
// apps/app/test/terms-version.test.js). Bumped on every change to the text
// of either document, so members accept the new text again.
const TERMS_VERSION = 8
const VERSION_MAX = 9999
// A base64url nonce of at least 32 bytes of entropy.
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

function isTermsVersion (v) {
  return Number.isSafeInteger(v) && v >= 1 && v <= VERSION_MAX
}

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// -> null when the fields are a valid statement, else a short reason.
function checkFields (fields) {
  if (!isPlainObject(fields)) return 'fields'
  const { nonce, member, association, version } = fields
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return 'nonce'
  if (typeof member !== 'string' || !HEX64.test(member)) return 'member'
  if (typeof association !== 'string' || !HEX64.test(association)) return 'association'
  if (!isTermsVersion(version)) return 'version'
  return null
}

// { nonce, member, association, version } -> the UTF-8 bytes of PREFIX,
// nonce, member, association, String(version) joined by LF (no trailing LF).
// Throws TypeError on a bad shape.
function termsPayload (fields) {
  const reason = checkFields(fields)
  if (reason !== null) throw new TypeError('invalid terms ' + reason)
  const { nonce, member, association, version } = fields
  return b4a.from([PREFIX, nonce, member, association, String(version)].join('\n'), 'utf8')
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signTerms (fields, keyPair) {
  const payload = termsPayload(fields)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key (the diary key is the
// signer). -> { ok: true } | { ok: false, reason: 'malformed' |
// 'bad-signature' }. Never throws.
function verifyTerms (fields, signatureHex) {
  try {
    if (checkFields(fields) !== null) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(termsPayload(fields), b4a.from(signatureHex, 'hex'), b4a.from(fields.member, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

module.exports = {
  PREFIX,
  TERMS_VERSION,
  VERSION_MAX,
  NONCE_RE,
  isTermsVersion,
  termsPayload,
  signTerms,
  verifyTerms
}
