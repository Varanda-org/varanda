'use strict'

// The operator's signed request to the moderation panel's API (`mod apply`
// talking to the account service, api/pull and api/ack): the moderator key
// signs a domain-separated statement that binds one request to the
// deployment origin, the association, the moderator, a single-use server
// nonce, the operation and the hash of the exact body bytes. The bytes start
// with 'varanda-mod-request-v1', so a signature over them can never be a
// report (varanda-report-v1), an account-link proof (varanda-account-link-v1),
// a certificate or a blocklist snapshot, and vice versa.
//
// The origin is part of the statement because the account service never sees
// the real Host header (deploy/seeder/Caddyfile rewrites it), so a signature
// for one deployment must not replay against another.
//
// Pure: b4a and hypercore-crypto only. It is a separate module from the
// member-facing report payload so the web session never bundles it.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const PREFIX = 'varanda-mod-request-v1'
const OPS = Object.freeze(['pull', 'ack'])
// Duplicated from blocklist.js (SNAPSHOT_KEYS, exact order) so this module
// does not pull in cert.js.
const SNAPSHOT_KEYS = Object.freeze(['v', 'seq', 'date', 'blocked', 'revokedIssuers', 'moderator', 'moderatorDate', 'moderatorSignature', 'signature'])
// Same rule as account-link.js and the RPC (packages/rpc/lib/methods.js):
// a base64url nonce of at least 32 bytes of entropy.
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/
// Loopback over plain HTTP, for the operator's local tests only.
const LOOPBACK_ORIGIN_RE = /^http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?$/
const CHANGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// Equal to MAX_BLOCKED (blocklist.js): one ack never names more changes than
// one snapshot can hold.
const MAX_CHANGE_IDS = 4096
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const PULL_BODY = '{}'

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

function isOrigin (s) {
  return typeof s === 'string' && (ORIGIN_RE.test(s) || LOOPBACK_ORIGIN_RE.test(s))
}

// -> a plain object with exactly SNAPSHOT_KEYS in that order, copied from
// `snapshot` (the key lists copied as fresh arrays). TypeError when a key is
// missing or extra. It does not verify anything else: blocklist.js
// verifySnapshot does.
function canonicalSnapshot (snapshot) {
  if (!isPlainObject(snapshot)) throw new TypeError('invalid snapshot')
  const keys = Object.keys(snapshot)
  if (keys.length !== SNAPSHOT_KEYS.length) throw new TypeError('invalid snapshot keys')
  for (const k of SNAPSHOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, k)) throw new TypeError('invalid snapshot keys')
  }
  if (!Array.isArray(snapshot.blocked) || !Array.isArray(snapshot.revokedIssuers)) throw new TypeError('invalid snapshot lists')
  const out = {}
  for (const k of SNAPSHOT_KEYS) {
    out[k] = (k === 'blocked' || k === 'revokedIssuers') ? snapshot[k].slice() : snapshot[k]
  }
  return out
}

function checkChangeIds (changeIds) {
  if (!Array.isArray(changeIds) || changeIds.length > MAX_CHANGE_IDS) throw new TypeError('invalid changeIds')
  for (const id of changeIds) {
    if (typeof id !== 'string' || !CHANGE_ID_RE.test(id)) throw new TypeError('invalid changeIds')
  }
}

// -> the exact body bytes a request carries. 'pull': the two bytes '{}'.
// 'ack': compact JSON of { changeIds (sorted), snapshot (canonical key
// order) }, never the pretty-printed bytes store.js writeJsonAtomic writes,
// so the server can rebuild the same bytes from what it parsed.
function canonicalBody (op, data) {
  if (op === 'pull') return b4a.from(PULL_BODY, 'utf8')
  if (op !== 'ack') throw new TypeError('invalid mod-request op')
  if (!isPlainObject(data)) throw new TypeError('invalid ack body')
  const keys = Object.keys(data).sort()
  if (keys.length !== 2 || keys[0] !== 'changeIds' || keys[1] !== 'snapshot') throw new TypeError('invalid ack body')
  checkChangeIds(data.changeIds)
  const changeIds = data.changeIds.slice().sort()
  return b4a.from(JSON.stringify({ changeIds, snapshot: canonicalSnapshot(data.snapshot) }), 'utf8')
}

// -> null when the fields are a valid statement, else a short reason.
function checkFields (fields) {
  if (!isPlainObject(fields)) return 'fields'
  const { origin, association, moderator, nonce, op, body } = fields
  if (!isOrigin(origin)) return 'origin'
  if (typeof association !== 'string' || !HEX64.test(association)) return 'association'
  if (typeof moderator !== 'string' || !HEX64.test(moderator)) return 'moderator'
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return 'nonce'
  if (!OPS.includes(op)) return 'op'
  if (!b4a.isBuffer(body)) return 'body'
  return null
}

// { origin, association, moderator, nonce, op, body } -> the UTF-8 bytes of
// PREFIX, origin, association, moderator, nonce, op and the lowercase hex
// BLAKE2b-256 (hypercore-crypto hash) of `body`, joined by LF (no trailing
// LF). Throws TypeError on a bad shape.
function modRequestPayload (fields) {
  const reason = checkFields(fields)
  if (reason !== null) throw new TypeError('invalid mod-request ' + reason)
  const { origin, association, moderator, nonce, op, body } = fields
  const bodyHash = b4a.toString(crypto.hash(body), 'hex')
  return b4a.from([PREFIX, origin, association, moderator, nonce, op, bodyHash].join('\n'), 'utf8')
}

// -> lowercase hex128 Ed25519 signature by the moderator's secret key.
function signModRequest (fields, moderatorKeyPair) {
  const payload = modRequestPayload(fields)
  if (moderatorKeyPair === null || typeof moderatorKeyPair !== 'object' || !(moderatorKeyPair.secretKey instanceof Uint8Array) || moderatorKeyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, moderatorKeyPair.secretKey), 'hex')
}

// Verifies against `moderator` as the Ed25519 public key. The caller still
// checks that `moderator` is the association's current certified moderator.
// -> { ok: true } | { ok: false, reason: 'malformed' | 'bad-signature' }.
// Never throws.
function verifyModRequest (fields, signatureHex) {
  try {
    if (checkFields(fields) !== null) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(modRequestPayload(fields), b4a.from(signatureHex, 'hex'), b4a.from(fields.moderator, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

module.exports = {
  PREFIX,
  OPS,
  SNAPSHOT_KEYS,
  NONCE_RE,
  ORIGIN_RE,
  LOOPBACK_ORIGIN_RE,
  CHANGE_ID_RE,
  MAX_CHANGE_IDS,
  isOrigin,
  canonicalSnapshot,
  canonicalBody,
  modRequestPayload,
  signModRequest,
  verifyModRequest
}
