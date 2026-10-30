'use strict'

// The wallet statement: the member's diary key signs a domain-separated
// statement saying "this linked member asks the account service to run this
// payments-account operation, for this association", bound to a single-use
// account-service nonce so a signature can never be replayed into another
// request. The bytes start with 'varanda-wallet-v1', so a signature over
// them can never be an age request (varanda-age-v1), a push opt-in
// (varanda-push-v1), a terms acceptance (varanda-terms-v1), an account link,
// an invite request, a report, a moderation request, a member certificate or
// a Hypercore block signature, and vice versa.
//
// The operation itself is not signed, only a hash of its canonical form: the
// account service recomputes the hash from the operation it receives, so the
// statement stays short. The operation never carries the wallet PIN, a CPF
// or a symmetric key (those keys throw), so neither does the statement.
//
// Pure: b4a and hypercore-crypto only (loaded by the browser bundle and the
// account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const PREFIX = 'varanda-wallet-v1'
const ACTIONS = Object.freeze([
  'optin',
  'kyc-document',
  'kyc-submit',
  'status',
  'wallet-create',
  'balance',
  'statement',
  'deposit',
  'payout-quote',
  'preview',
  'payout',
  'op-status',
  'transfer',
  'send-crypto',
  'swap-quote',
  'swap'
])
// A base64url nonce of at least 32 bytes of entropy (same rule as terms.js).
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const KEYS = ['action', 'nonce', 'member', 'association', 'opHash']
const OP_KEY_RE = /^[a-z][a-zA-Z0-9]{0,31}$/
const OP_KEYS_MAX = 16
const OP_STRING_MAX = 512
// Secrets and personal data stay out of the signed operation even as a
// hash: a hash of a PIN or a CPF is guessable from its small space. The
// exception is payerCpf (deposit) and beneficiaryCpf (payout): they are
// signed so the service can check them, removed from the op before anything
// is stored or logged, and only an in-memory hash is kept for the quote check.
const OP_FORBIDDEN = Object.freeze(['pin', 'walletPin', 'protectedSymmetricKey', 'taxId', 'taxIdNumber', 'cpf'])

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// No C0 or C1 control character, no DEL and no lone surrogate: UTF-8
// encoding turns a lone surrogate into U+FFFD, so two strings would share
// one hash.
function isOpString (s) {
  if (s.length > OP_STRING_MAX) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

function isOpValue (v) {
  if (typeof v === 'string') return isOpString(v)
  return Number.isSafeInteger(v) && v >= 0
}

// Reads every key exactly once into a fresh object, so a getter or a proxy
// cannot answer one value to the check and another to the hash.
function snapshotOp (op) {
  if (!isPlainObject(op)) throw new TypeError('invalid wallet op')
  const own = Reflect.ownKeys(op)
  if (own.length > OP_KEYS_MAX) throw new TypeError('invalid wallet op')
  const snapshot = {}
  for (const key of own) {
    if (typeof key !== 'string' || !OP_KEY_RE.test(key)) throw new TypeError('invalid wallet op key')
    if (OP_FORBIDDEN.includes(key)) throw new TypeError('forbidden wallet op key')
    const d = Object.getOwnPropertyDescriptor(op, key)
    if (d === undefined || !('value' in d) || !d.enumerable) throw new TypeError('invalid wallet op')
    if (!isOpValue(d.value)) throw new TypeError('invalid wallet op value')
    snapshot[key] = d.value
  }
  return snapshot
}

// -> the canonical JSON of the operation: keys sorted ascending, no
// whitespace. Throws TypeError on a bad shape or a forbidden key.
function canonicalOp (op) {
  const snapshot = snapshotOp(op)
  const sorted = {}
  for (const key of Object.keys(snapshot).sort()) sorted[key] = snapshot[key]
  return JSON.stringify(sorted)
}

// -> lowercase hex64 hash of the UTF-8 bytes of canonicalOp(op).
function opHash (op) {
  return b4a.toString(crypto.hash(b4a.from(canonicalOp(op), 'utf8')), 'hex')
}

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
  const { action, nonce, member, association, opHash } = snapshot
  if (typeof action !== 'string' || !ACTIONS.includes(action)) return { reason: 'action' }
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { reason: 'nonce' }
  if (typeof member !== 'string' || !HEX64.test(member)) return { reason: 'member' }
  if (typeof association !== 'string' || !HEX64.test(association)) return { reason: 'association' }
  if (typeof opHash !== 'string' || !HEX64.test(opHash)) return { reason: 'opHash' }
  return { snapshot }
}

function payloadOf (s) {
  return b4a.from([PREFIX, s.action, s.nonce, s.member, s.association, s.opHash].join('\n'), 'utf8')
}

// { action, nonce, member, association, opHash } -> the UTF-8 bytes of
// PREFIX and the fields in that order joined by LF (no trailing LF). Throws
// TypeError on a bad shape or an extra key.
function walletPayload (fields) {
  const { snapshot, reason } = snapshotFields(fields)
  if (snapshot === undefined) throw new TypeError('invalid wallet ' + reason)
  return payloadOf(snapshot)
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signWallet (fields, keyPair) {
  const payload = walletPayload(fields)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key (the diary key is the
// signer). -> { ok: true } | { ok: false, reason: 'malformed' |
// 'bad-signature' }. Never throws.
function verifyWallet (fields, signatureHex) {
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
  ACTIONS,
  NONCE_RE,
  canonicalOp,
  opHash,
  walletPayload,
  signWallet,
  verifyWallet
}
