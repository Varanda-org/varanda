'use strict'

// The seen-sync proof: the member's diary key signs a domain-separated
// statement asking the account service to read, write or delete the
// member's encrypted "seen" blob for this association, bound to a
// single-use account-service nonce so a signature can never be replayed.
// The bytes start with 'varanda-seen-v1', so a signature over them can
// never be a terms acceptance (varanda-terms-v1), a push opt-in
// (varanda-push-v1) or any other signed statement, and vice versa.
//
// prevHash and newHash make every write a compare-and-swap on the exact
// ciphertext: a device can only replace the blob it last merged, so two
// devices writing at once cannot silently drop each other's marks.
//   read:   prevHash = the hash the device already holds (or HASH_NONE),
//           newHash = HASH_NONE
//   write:  prevHash = the hash of the blob last merged (HASH_NONE to
//           create), newHash = blobHash(bytes)
//   delete: prevHash = the expected current hash or HASH_NONE,
//           newHash = HASH_NONE
//
// Pure: b4a and hypercore-crypto only (loaded by the browser bundle and the
// account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const PREFIX = 'varanda-seen-v1'
const SEEN_ACTIONS = Object.freeze(['read', 'write', 'delete'])
const HASH_NONE = '0'.repeat(64)
// A base64url nonce of at least 32 bytes of entropy (same rule as terms.js).
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const KEYS = ['nonce', 'member', 'association', 'action', 'prevHash', 'newHash']

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
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
  const { nonce, member, association, action, prevHash, newHash } = snapshot
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { reason: 'nonce' }
  if (typeof member !== 'string' || !HEX64.test(member)) return { reason: 'member' }
  if (typeof association !== 'string' || !HEX64.test(association)) return { reason: 'association' }
  if (!SEEN_ACTIONS.includes(action)) return { reason: 'action' }
  if (typeof prevHash !== 'string' || !HEX64.test(prevHash)) return { reason: 'prevHash' }
  if (typeof newHash !== 'string' || !HEX64.test(newHash)) return { reason: 'newHash' }
  // Only a write carries a new blob; a read or delete naming one would be a
  // statement the service cannot honour as signed.
  if ((action === 'write') === (newHash === HASH_NONE)) return { reason: 'newHash' }
  return { snapshot }
}

function payloadOf (s) {
  return b4a.from([PREFIX, s.nonce, s.member, s.association, s.action, s.prevHash, s.newHash].join('\n'), 'utf8')
}

// { nonce, member, association, action, prevHash, newHash } -> the UTF-8
// bytes of PREFIX and the fields in that order joined by LF (no trailing
// LF). Throws TypeError on a bad shape or an extra key.
function seenPayload (fields) {
  const { snapshot, reason } = snapshotFields(fields)
  if (snapshot === undefined) throw new TypeError('invalid seen ' + reason)
  return payloadOf(snapshot)
}

// -> lowercase hex64 BLAKE2b-256 of the exact ciphertext bytes.
function blobHash (bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('invalid seen blob')
  return b4a.toString(crypto.hash(bytes), 'hex')
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signSeen (fields, keyPair) {
  const payload = seenPayload(fields)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key (the diary key is the
// signer). -> { ok: true } | { ok: false, reason: 'malformed' |
// 'bad-signature' }. Never throws.
function verifySeen (fields, signatureHex) {
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
  SEEN_ACTIONS,
  HASH_NONE,
  NONCE_RE,
  seenPayload,
  blobHash,
  signSeen,
  verifySeen
}
