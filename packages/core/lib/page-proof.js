'use strict'

// The page statement: an owner's or admin's OWN diary key signs a
// domain-separated statement saying "this linked member asks the account
// service to run this page operation, on this page, for this association",
// bound to a single-use account-service nonce so a signature can never be
// replayed into another request. The service holds the page key and is the
// only appender of the page diary; this statement is how it knows who asked.
// The bytes start with 'varanda-page-v1', so a signature over them can never
// be a wallet statement (varanda-wallet-v1), an age request, a push opt-in,
// a terms acceptance, an account link, a page record (varanda-page-*-v1 with
// a longer prefix line) or a Hypercore block signature, and vice versa.
//
// Accept, remove, offer, transfer-accept, close and move are not actions:
// they are authenticated by the signatures on their own page records
// (records.js, page-lifecycle), which readers verify too.
//
// The operation itself is not signed, only a hash of its canonical form: the
// account service recomputes the hash from the operation it receives. Unlike
// a wallet op, a page op carries post text and nested media rows, so it
// accepts JSON values, bounded in size and depth.
//
// Pure: b4a and hypercore-crypto only (loaded by the browser bundle and the
// account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const PREFIX = 'varanda-page-v1'
const ACTIONS = Object.freeze([
  'create',
  'list',
  'status',
  'post',
  'reply',
  'quote',
  'delete',
  'like',
  'repost',
  'profile',
  'avatar',
  'rename',
  'invite',
  'dm-list',
  'dm-thread',
  'dm-send',
  'dm-set',
  'dm-seen',
  'follow',
  'follows',
  'media',
  'notices',
  'terms',
  'community-join',
  'community-leave',
  'group-join',
  'group-leave',
  'group-post',
  'group-read'
])
// Actions that are not about one existing page sign page = ''.
const PAGELESS = Object.freeze(['create', 'list', 'terms'])
// A base64url nonce of at least 32 bytes of entropy (same rule as
// account-link.js and wallet-proof.js).
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const KEYS = ['action', 'nonce', 'member', 'page', 'association', 'opHash']
const OP_MAX_BYTES = 16 * 1024
// Deep enough for media rows inside a post, shallow enough that a hostile
// op can never exhaust the stack.
const OP_MAX_DEPTH = 8
// A key pair, a wallet PIN or a seed never enters an op, even as a hash.
const OP_FORBIDDEN = Object.freeze(['secretKey', 'pin', 'seed'])
const INDEX_KEY_RE = /^(0|[1-9][0-9]*)$/

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// No lone surrogate: UTF-8 encoding turns one into U+FFFD, so two strings
// would share one hash. Control characters are fine: JSON escapes them and
// post text has line breaks.
function isOpString (s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
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

// A lower bound of the canonical JSON size (brackets, commas, quotes and a
// colon per key, at least one byte per UTF-16 unit), so the running total
// stops a huge op long before JSON.stringify sees it.
function charge (budget, n) {
  budget.used += n
  if (budget.used > OP_MAX_BYTES) throw new TypeError('page op too large')
}

function ownValue (o, key) {
  const d = Object.getOwnPropertyDescriptor(o, key)
  if (d === undefined || !('value' in d) || !d.enumerable) throw new TypeError('invalid page op')
  return d.value
}

// Reads every key exactly once into fresh plain values, so a getter or a
// proxy cannot answer one value to the check and another to the hash.
function snapshotValue (v, depth, budget) {
  if (v === null || typeof v === 'boolean') {
    charge(budget, 4)
    return v
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Object.is(v, -0)) throw new TypeError('invalid page op number')
    charge(budget, 1)
    return v
  }
  if (typeof v === 'string') {
    charge(budget, v.length + 2)
    if (!isOpString(v)) throw new TypeError('invalid page op string')
    return v
  }
  if (depth >= OP_MAX_DEPTH) throw new TypeError('page op too deep')
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) throw new TypeError('invalid page op array')
    const own = Reflect.ownKeys(v)
    const d = Object.getOwnPropertyDescriptor(v, 'length')
    const length = d === undefined ? -1 : d.value
    if (!Number.isSafeInteger(length) || length < 0 || own.length !== length + 1) throw new TypeError('invalid page op array')
    charge(budget, 1 + Math.max(length, 1))
    // Exactly the indices and 'length': no hole, no extra named property.
    for (const key of own) {
      if (key === 'length') continue
      if (typeof key !== 'string' || !INDEX_KEY_RE.test(key) || Number(key) >= length) throw new TypeError('invalid page op array')
    }
    const out = []
    for (let i = 0; i < length; i++) out.push(snapshotValue(ownValue(v, String(i)), depth + 1, budget))
    return out
  }
  if (!isPlainObject(v)) throw new TypeError('invalid page op value')
  const own = Reflect.ownKeys(v)
  charge(budget, 1 + Math.max(own.length, 1))
  const out = Object.create(null)
  for (const key of own) {
    if (typeof key !== 'string') throw new TypeError('invalid page op key')
    if (OP_FORBIDDEN.includes(key)) throw new TypeError('forbidden page op key')
    // JSON.stringify emits array-index-like keys first in numeric order,
    // which would break the ascending UTF-16 key order the hash promises.
    if (INDEX_KEY_RE.test(key)) throw new TypeError('invalid page op key')
    charge(budget, key.length + 3)
    if (!isOpString(key)) throw new TypeError('invalid page op key')
    out[key] = snapshotValue(ownValue(v, key), depth + 1, budget)
  }
  return out
}

function sortKeys (v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v === null || typeof v !== 'object') return v
  const sorted = Object.create(null)
  for (const key of Object.keys(v).sort()) sorted[key] = sortKeys(v[key])
  return sorted
}

// -> the canonical JSON of the operation: an object at the top, keys sorted
// ascending at every depth, no whitespace, at most 16 KiB of UTF-8. Throws
// TypeError on a bad shape, a forbidden key or a size over the limit.
function canonicalOp (op) {
  let snapshot
  try {
    if (!isPlainObject(op)) throw new TypeError('invalid page op')
    snapshot = snapshotValue(op, 0, { used: 0 })
  } catch (err) {
    if (err instanceof TypeError) throw err
    throw new TypeError('invalid page op')
  }
  const json = JSON.stringify(sortKeys(snapshot))
  if (b4a.byteLength(json, 'utf8') > OP_MAX_BYTES) throw new TypeError('page op too large')
  return json
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
  const { action, nonce, member, page, association, opHash } = snapshot
  if (typeof action !== 'string' || !ACTIONS.includes(action)) return { reason: 'action' }
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { reason: 'nonce' }
  if (typeof member !== 'string' || !HEX64.test(member)) return { reason: 'member' }
  if (typeof page !== 'string' || !(HEX64.test(page) || (page === '' && PAGELESS.includes(action)))) return { reason: 'page' }
  if (typeof association !== 'string' || !HEX64.test(association)) return { reason: 'association' }
  if (typeof opHash !== 'string' || !HEX64.test(opHash)) return { reason: 'opHash' }
  return { snapshot }
}

function payloadOf (s) {
  return b4a.from([PREFIX, s.action, s.nonce, s.member, s.page, s.association, s.opHash].join('\n'), 'utf8')
}

// { action, nonce, member, page, association, opHash } -> the UTF-8 bytes of
// PREFIX and the fields in that order joined by LF (no trailing LF). Throws
// TypeError on a bad shape or an extra key.
function pagePayload (fields) {
  const { snapshot, reason } = snapshotFields(fields)
  if (snapshot === undefined) throw new TypeError('invalid page ' + reason)
  return payloadOf(snapshot)
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signPage (fields, keyPair) {
  const payload = pagePayload(fields)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key (the actor's own
// diary key, never the page key). -> { ok: true } | { ok: false, reason:
// 'malformed' | 'bad-signature' }. Never throws.
function verifyPage (fields, signatureHex) {
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
  pagePayload,
  signPage,
  verifyPage
}
