'use strict'

// Age attestations (docs/protocol.md section 3, "Age attestations"): two
// statements the account service signs with its issuer key, carrying the
// issuer delegation inline like a v2 member certificate or a username record,
// so a node can check them offline against its association alone. The bytes
// start with 'varanda-age-verified-v1' or 'varanda-age-since-v1', so a
// signature over them can never be a member certificate, a username record,
// the member's 'varanda-age-v1' request or the other attestation, and vice
// versa.
//
// They travel over HTTPS to the member's own client only and carry no age
// band, birth date, method or provider id: an attestation says that a band is
// on record, never which one.
//
// Pure: b4a, hypercore-crypto and ./cert only (no file system access of
// its own, no network), so the browser node can load it.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  isHex,
  isLowerHex,
  isCanonicalIso,
  isPlainObject,
  hasExactKeys,
  normalizeHex,
  checkIssuer,
  verifyIssued,
  validDelegation
} = require('./cert')

const LF = '\n'
const AGE_VERIFIED_PREFIX = 'varanda-age-verified-v1'
const AGE_SINCE_PREFIX = 'varanda-age-since-v1'
// A valid attestation is about 620 bytes; the cap bounds what a node reads
// back from storage before any crypto.
const MAX_AGE_PROOF_BYTES = 1024
const VERIFIED_KEYS = ['type', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']
const SINCE_KEYS = ['type', 'since', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']

// The signed fields only (no exact-key or signature check), shared by the
// payload builders and the full shape checks.
function verifiedFieldsOk (att) {
  return isPlainObject(att) &&
    att.type === 'age-verified' &&
    isLowerHex(att.member, 32) &&
    isCanonicalIso(att.date) &&
    validDelegation(att)
}

function sinceFieldsOk (att) {
  return isPlainObject(att) &&
    att.type === 'age-since' &&
    isCanonicalIso(att.since) &&
    isCanonicalIso(att.date) &&
    validDelegation(att)
}

function bytes (fields) {
  return b4a.from(fields.join(LF), 'utf8')
}

function verifiedBytes (att) {
  return bytes([AGE_VERIFIED_PREFIX, att.member, att.date, att.association, att.issuer, att.issuerDate, att.issuerSignature])
}

function sinceBytes (att) {
  return bytes([AGE_SINCE_PREFIX, att.since, att.date, att.association, att.issuer, att.issuerDate, att.issuerSignature])
}

function safeFieldsOk (check, att) {
  try {
    return check(att)
  } catch {
    return false
  }
}

// -> the UTF-8 bytes of the prefix and the signed fields joined by LF (no
// trailing LF). Throws TypeError on a bad shape.
function ageVerifiedPayload (att) {
  if (!safeFieldsOk(verifiedFieldsOk, att)) throw new TypeError('invalid age-verified attestation')
  return verifiedBytes(att)
}

function ageSincePayload (att) {
  if (!safeFieldsOk(sinceFieldsOk, att)) throw new TypeError('invalid age-since attestation')
  return sinceBytes(att)
}

function sign (payload, issuerKeyPair) {
  return b4a.toString(crypto.sign(payload, issuerKeyPair.secretKey), 'hex')
}

// Same TypeError rules as createIssuedCert, so the issuer never signs an
// attestation a verifier of its own association would reject.
function createAgeVerified ({ member, date } = {}, issuerKeyPair, issuerCert) {
  if (!isHex(member, 32)) throw new TypeError('member must be 64 hex characters')
  if (!isCanonicalIso(date)) throw new TypeError('date must be a canonical ISO-8601 UTC string')
  checkIssuer(issuerKeyPair, issuerCert)
  const att = {
    type: 'age-verified',
    member: member.toLowerCase(),
    date,
    association: issuerCert.association,
    issuer: issuerCert.issuer,
    issuerDate: issuerCert.date,
    issuerSignature: issuerCert.signature,
    signature: ''
  }
  att.signature = sign(verifiedBytes(att), issuerKeyPair)
  return att
}

function createAgeSince ({ since, date = new Date().toISOString() } = {}, issuerKeyPair, issuerCert) {
  if (!isCanonicalIso(since)) throw new TypeError('since must be a canonical ISO-8601 UTC string')
  if (!isCanonicalIso(date)) throw new TypeError('date must be a canonical ISO-8601 UTC string')
  checkIssuer(issuerKeyPair, issuerCert)
  const att = {
    type: 'age-since',
    since,
    date,
    association: issuerCert.association,
    issuer: issuerCert.issuer,
    issuerDate: issuerCert.date,
    issuerSignature: issuerCert.signature,
    signature: ''
  }
  att.signature = sign(sinceBytes(att), issuerKeyPair)
  return att
}

// The cap is checked right after the key set, before the per-field checks,
// so an oversized value costs one serialization and nothing more.
function shapeReason (att, keys, fieldsOk) {
  try {
    if (!isPlainObject(att) || !hasExactKeys(att, keys)) return 'malformed'
    if (b4a.byteLength(JSON.stringify(att), 'utf8') > MAX_AGE_PROOF_BYTES) return 'malformed'
    if (!fieldsOk(att) || !isLowerHex(att.signature, 64)) return 'malformed'
    return null
  } catch {
    return 'malformed'
  }
}

function validateAgeVerifiedShape (att) {
  return shapeReason(att, VERIFIED_KEYS, verifiedFieldsOk)
}

function validateAgeSinceShape (att) {
  return shapeReason(att, SINCE_KEYS, sinceFieldsOk)
}

// -> { ok: true } | { ok: false, reason }, first failing reason in order
// 'malformed', 'member-mismatch', 'untrusted-association',
// 'bad-issuer-signature', 'bad-signature', 'revoked-issuer'. Never throws.
function verifyAgeVerified (att, memberHex, associationHex, opts) {
  try {
    if (validateAgeVerifiedShape(att) !== null) return { ok: false, reason: 'malformed' }
    if (att.member !== normalizeHex(memberHex)) return { ok: false, reason: 'member-mismatch' }
    return verifyIssued(att, verifiedBytes(att), associationHex, opts)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

// Same as verifyAgeVerified without 'member-mismatch'.
function verifyAgeSince (att, associationHex, opts) {
  try {
    if (validateAgeSinceShape(att) !== null) return { ok: false, reason: 'malformed' }
    return verifyIssued(att, sinceBytes(att), associationHex, opts)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

module.exports = {
  AGE_VERIFIED_PREFIX,
  AGE_SINCE_PREFIX,
  MAX_AGE_PROOF_BYTES,
  ageVerifiedPayload,
  ageSincePayload,
  createAgeVerified,
  createAgeSince,
  validateAgeVerifiedShape,
  validateAgeSinceShape,
  verifyAgeVerified,
  verifyAgeSince
}
