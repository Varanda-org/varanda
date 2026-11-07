'use strict'

// The signup-invite card statement: the member's diary key signs a
// domain-separated statement saying "I wrote this greeting, in this design,
// for this signup invite code of this association, until this time". The
// bytes start with 'varanda-invite-card-v1', so a signature over them can
// never be a signup-invite request (varanda-invite-v1), a page statement or
// any other Varanda statement, and vice versa.
//
// The name and the message are signed through their digests, so the
// statement has a fixed line shape whatever the text holds. The digests are
// always computed here from the text: a caller can never pass one in.
//
// Pure: b4a, hypercore-crypto and @varanda/rpc only (no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  isInviteCode,
  isInviteCardExpires,
  canonicalInviteCardText,
  DESIGNS,
  NAME_MAX,
  MESSAGE_MAX_BYTES
} = require('@varanda/rpc')

const PREFIX = 'varanda-invite-card-v1'
// A card stays readable for one day of clock skew past its expiry.
const EXPIRY_SKEW_S = 24 * 60 * 60
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// Lowercase hex of the BLAKE2b-256 hash of the UTF-8 of text.
function digestText (text) {
  return b4a.toString(crypto.hash(b4a.from(text, 'utf8')), 'hex')
}

// { code, design, name, message, expires, member, association } ->
// { reason: null, fields } with nameDigest and messageDigest added, or
// { reason, fields: null } with a short reason. Never throws.
function cardFields (input) {
  if (!isPlainObject(input)) return { reason: 'fields', fields: null }
  const { code, design, name, message, expires, member, association } = input
  if (!isInviteCode(code)) return { reason: 'code', fields: null }
  if (typeof design !== 'string' || !DESIGNS.includes(design)) return { reason: 'design', fields: null }
  // canonicalInviteCardText answers null for a non-string, so null would
  // pass an equality check: the type is checked first.
  if (typeof name !== 'string' || canonicalInviteCardText(name, NAME_MAX) !== name) return { reason: 'name', fields: null }
  if (typeof message !== 'string' || canonicalInviteCardText(message, MESSAGE_MAX_BYTES, { multiline: true }) !== message) return { reason: 'message', fields: null }
  if (b4a.byteLength(message, 'utf8') > MESSAGE_MAX_BYTES) return { reason: 'message', fields: null }
  if (!isInviteCardExpires(expires)) return { reason: 'expires', fields: null }
  if (typeof member !== 'string' || !HEX64.test(member)) return { reason: 'member', fields: null }
  if (typeof association !== 'string' || !HEX64.test(association)) return { reason: 'association', fields: null }
  return {
    reason: null,
    fields: {
      code,
      design,
      name,
      message,
      expires,
      member,
      association,
      nameDigest: digestText(name),
      messageDigest: digestText(message)
    }
  }
}

// The same input as cardFields -> the UTF-8 bytes of PREFIX, code, design,
// expires, nameDigest, messageDigest, member, association joined by LF (no
// trailing LF). Throws TypeError on a bad shape.
function cardPayload (input) {
  const { reason, fields } = cardFields(input)
  if (reason !== null) throw new TypeError('invalid invite card ' + reason)
  return payloadOf(fields)
}

// The checked fields (read once by cardFields) -> the payload bytes.
function payloadOf (fields) {
  return b4a.from([
    PREFIX,
    fields.code,
    fields.design,
    String(fields.expires),
    fields.nameDigest,
    fields.messageDigest,
    fields.member,
    fields.association
  ].join('\n'), 'utf8')
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signInviteCard (input, keyPair) {
  const payload = cardPayload(input)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key. -> { ok: true } |
// { ok: false, reason: 'malformed' | 'bad-signature' }. Never throws.
function verifyInviteCard (input, signatureHex) {
  try {
    // One read of the input: the payload and the key both come from this
    // snapshot, so a getter cannot answer one value here and another there.
    const { reason, fields } = cardFields(input)
    if (reason !== null) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(payloadOf(fields), b4a.from(signatureHex, 'hex'), b4a.from(fields.member, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

// verifyInviteCard is clock-free (pure); the RPC handlers apply this after a
// good signature so no caller has to remember the clock. true when expires
// (unix seconds) lies more than one day of skew before nowSec, or either
// value is not a safe integer.
function isInviteCardExpired (expires, nowSec) {
  if (!Number.isSafeInteger(expires) || !Number.isSafeInteger(nowSec)) return true
  return expires < nowSec - EXPIRY_SKEW_S
}

module.exports = {
  PREFIX,
  EXPIRY_SKEW_S,
  digestText,
  cardFields,
  cardPayload,
  signInviteCard,
  verifyInviteCard,
  isInviteCardExpired
}
