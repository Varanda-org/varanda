'use strict'

// A blocked member's appeal (docs/rpc.md 5.62): the diary key signs a
// domain-separated statement that binds one account-service step
// (single-use nonce) to the appellant, the association and the appellant's
// own words. The text enters the payload as a digest, so a LF inside it can
// never shift the framing. The bytes start with 'varanda-appeal-v1', so a
// signature over them can never be a report (varanda-report-v1), a terms
// acceptance, an account link, a moderation request, a certificate or a
// Hypercore block signature, and vice versa.
//
// The statement names no target: an appeal is always about the signer's own
// key, and the account service checks that it is blocked.
//
// Pure: b4a, hypercore-crypto and ./report only (loaded by the browser
// bundle and the account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { isCleanText, isWellFormed, digest } = require('./report')
const { MAX_TEXT } = require('./records')

const PREFIX = 'varanda-appeal-v1'
// Code points (Array.from length), as records.js MAX_TEXT.
const TEXT_MAX = MAX_TEXT
// A base64url nonce of at least 32 bytes of entropy (as report.js).
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// Lone surrogates and U+FFFD encode to the same UTF-8 bytes, so a digest
// would not bind a string holding one (as report.js).
function validText (s) {
  return typeof s === 'string' && isWellFormed(s) && Array.from(s).length <= TEXT_MAX && isCleanText(s, true)
}

// -> null when the fields are a valid statement, else a short reason.
function checkFields (fields) {
  if (!isPlainObject(fields)) return 'fields'
  const { nonce, member, association, text } = fields
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return 'nonce'
  if (typeof member !== 'string' || !HEX64.test(member)) return 'member'
  if (typeof association !== 'string' || !HEX64.test(association)) return 'association'
  if (!validText(text)) return 'text'
  return null
}

// { nonce, member, association, text } -> the UTF-8 bytes of PREFIX, nonce,
// member, association, digest(text) joined by LF (no trailing LF). Throws
// TypeError on a bad shape.
function appealPayload (fields) {
  const reason = checkFields(fields)
  if (reason !== null) throw new TypeError('invalid appeal ' + reason)
  const { nonce, member, association, text } = fields
  return b4a.from([PREFIX, nonce, member, association, digest(text)].join('\n'), 'utf8')
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signAppeal (fields, keyPair) {
  const payload = appealPayload(fields)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key. -> { ok: true } |
// { ok: false, reason: 'malformed' | 'bad-signature' }. Never throws.
function verifyAppeal (fields, signatureHex) {
  try {
    if (checkFields(fields) !== null) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(appealPayload(fields), b4a.from(signatureHex, 'hex'), b4a.from(fields.member, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

module.exports = {
  PREFIX,
  TEXT_MAX,
  NONCE_RE,
  appealPayload,
  signAppeal,
  verifyAppeal
}
