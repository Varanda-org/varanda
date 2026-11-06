'use strict'

// The recovery statement: the member's diary key signs a domain-separated
// request to the account service to store ('put'), delete ('remove') or
// enumerate ('list') the member's recovery entries (an extra passkey or the
// recovery code), bound to a single-use account-service nonce so a signature
// can never be replayed into another request. The bytes start with
// 'varanda-recovery-v1', so a signature over them can never be a terms
// acceptance (varanda-terms-v1), an account link (varanda-account-link-v1),
// a report, a member certificate or a Hypercore block signature, and vice
// versa. The action is signed, so a 'put' can never be presented as a
// 'remove' or a 'list'.
//
// 'put' signs blobHash, never the wrapped blob itself: the statement stays
// small and the account service recomputes the hash from the blob it stores.
//
// Pure: b4a and hypercore-crypto only (loaded by the browser bundle and the
// account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { NONCE_RE } = require('./terms')

const PREFIX = 'varanda-recovery-v1'
const ACTIONS = Object.freeze(['put', 'remove', 'list'])
const KINDS = Object.freeze(['passkey', 'code'])
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const HEX_PART = /^[0-9a-f]+$/

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

function isHex64 (s) {
  return typeof s === 'string' && HEX64.test(s)
}

// Every field is read exactly once into a local, and the check, the payload
// and the public key all use those locals: an object with accessors can not
// pass the check with one value and be signed or verified with another.
// -> { reason: null, values } | { reason, values: null }. May throw only if
// a property read throws.
function readFields (fields) {
  if (!isPlainObject(fields)) return { reason: 'fields', values: null }
  const action = fields.action
  const nonce = fields.nonce
  const member = fields.member
  const association = fields.association
  const kind = fields.kind
  const lookupId = fields.lookupId
  const blobHash = fields.blobHash
  const fail = (reason) => ({ reason, values: null })
  if (typeof action !== 'string' || !ACTIONS.includes(action)) return fail('action')
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return fail('nonce')
  if (!isHex64(member)) return fail('member')
  if (!isHex64(association)) return fail('association')
  if (action === 'list') {
    if (kind !== '') return fail('kind')
    if (lookupId !== '') return fail('lookupId')
    if (blobHash !== '') return fail('blobHash')
  } else {
    if (typeof kind !== 'string' || !KINDS.includes(kind)) return fail('kind')
    if (!isHex64(lookupId)) return fail('lookupId')
    if (action === 'put') {
      if (!isHex64(blobHash)) return fail('blobHash')
    } else if (blobHash !== '') {
      return fail('blobHash')
    }
  }
  return { reason: null, values: { action, nonce, member, association, kind, lookupId, blobHash } }
}

// -> null when the fields are a valid statement, else a short reason.
function checkFields (fields) {
  return readFields(fields).reason
}

function payloadOf ({ action, nonce, member, association, kind, lookupId, blobHash }) {
  return b4a.from([PREFIX, action, nonce, member, association, kind, lookupId, blobHash].join('\n'), 'utf8')
}

function readOrThrow (fields) {
  const { reason, values } = readFields(fields)
  if (reason !== null) throw new TypeError('invalid recovery ' + reason)
  return values
}

// { action, nonce, member, association, kind, lookupId, blobHash } -> the
// UTF-8 bytes of PREFIX, action, nonce, member, association, kind, lookupId,
// blobHash joined by LF (no trailing LF). kind, lookupId and blobHash are ''
// where the action does not carry them. Throws TypeError on a bad shape.
function recoveryPayload (fields) {
  return payloadOf(readOrThrow(fields))
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signRecovery (fields, keyPair) {
  const payload = recoveryPayload(fields)
  const secretKey = keyPair !== null && typeof keyPair === 'object' ? keyPair.secretKey : null
  if (!(secretKey instanceof Uint8Array) || secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key (the diary key is the
// signer). -> { ok: true } | { ok: false, reason: 'malformed' |
// 'bad-signature' }. Never throws.
function verifyRecovery (fields, signatureHex) {
  try {
    const { reason, values } = readFields(fields)
    if (reason !== null) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(payloadOf(values), b4a.from(signatureHex, 'hex'), b4a.from(values.member, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

// The blob parts are lowercase hex, the only form any caller sends (the RPC
// and the account service validate hex), so no LF and no lone surrogate can
// ever reach the hash.
function isBlobPart (s) {
  return typeof s === 'string' && HEX_PART.test(s)
}

// The hash a 'put' signs: BLAKE2b-256 (hypercore-crypto.hash; the module has
// no SHA-256) over the UTF-8 bytes of kind, lookupId, blob.nonce and
// blob.ciphertext joined by LF, as lowercase hex64. The blob parts are
// non-empty lowercase hex, so two different blobs can never join to the same
// bytes. Each part is read once, so the hashed value is the checked one.
// Throws TypeError on a bad shape.
function blobHashOf ({ kind, lookupId, blob } = {}) {
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw new TypeError('invalid recovery kind')
  if (!isHex64(lookupId)) throw new TypeError('invalid recovery lookupId')
  if (!isPlainObject(blob)) throw new TypeError('invalid recovery blob')
  const nonce = blob.nonce
  const ciphertext = blob.ciphertext
  if (!isBlobPart(nonce) || !isBlobPart(ciphertext)) throw new TypeError('invalid recovery blob')
  const bytes = b4a.from([kind, lookupId, nonce, ciphertext].join('\n'), 'utf8')
  return b4a.toString(crypto.hash(bytes), 'hex')
}

module.exports = {
  PREFIX,
  ACTIONS,
  KINDS,
  NONCE_RE,
  checkFields,
  recoveryPayload,
  signRecovery,
  verifyRecovery,
  blobHashOf
}
