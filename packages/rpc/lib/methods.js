'use strict'

const { utf8ByteLength, charLength } = require('./text')
const L = require('./limits')

const HEX64 = /^[0-9a-f]{64}$/
const REF = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/

function isPlainObject (v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasOwn (obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function isId (v) {
  return Number.isSafeInteger(v) && v >= 1 && v <= L.MAX_ID
}

function isKey (v) {
  return typeof v === 'string' && HEX64.test(v)
}

// '<hex64>:<seq>' with lowercase hex, canonical decimal and seq >= minSeq.
function isRef (v, minSeq = 1) {
  if (typeof v !== 'string') return false
  const m = REF.exec(v)
  if (!m) return false
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) && String(seq) === m[2] && seq >= minSeq
}

function str (min, max) {
  return (v) => typeof v === 'string' && charLength(v) >= min && charLength(v) <= max
}

function int (min, max) {
  return (v) => Number.isSafeInteger(v) && v >= min && v <= max
}

const isBool = (v) => typeof v === 'boolean'

// account.sign (docs/rpc.md 5.18). Duplicated from
// @varanda/core lib/account-link.js, which this package cannot import.
const ACCOUNT_PHASES = ['reserve', 'finish', 'rename']
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const SUB_RE = /^[\x21-\x7e]{1,255}$/
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const HEX6 = /^[0-9a-f]{6}$/

const isPhase = (v) => typeof v === 'string' && ACCOUNT_PHASES.includes(v)
const isNonce = (v) => typeof v === 'string' && NONCE_RE.test(v)
const isUsername = (v) => typeof v === 'string' && USERNAME_RE.test(v) && !HEX6.test(v)
const isSub = (v) => v === '' || (typeof v === 'string' && SUB_RE.test(v))

// report.sign (docs/rpc.md 5.20). Duplicated from @varanda/core
// lib/report.js (REASONS, TEXT_MAX, SEQ_MAX = MAX_LOG_BLOCKS - 1), which this
// package cannot import.
const REPORT_REASONS = ['spam', 'assedio', 'ilegal', 'outro']
const REPORT_TEXT_MAX = 280
const REPORT_SEQ_MAX = 99999

const isReason = (v) => typeof v === 'string' && REPORT_REASONS.includes(v)

function isCert (v) {
  if (!isPlainObject(v)) return false
  return utf8ByteLength(JSON.stringify(v)) <= L.MAX_CERT_BYTES
}

// username.add (docs/rpc.md 5.19): an issuer-signed username record is far
// smaller than a cert; the node verifies it, this only bounds the size.
const MAX_USERNAME_RECORD_BYTES = 2048

function isUsernameRecord (v) {
  if (!isPlainObject(v)) return false
  return utf8ByteLength(JSON.stringify(v)) <= MAX_USERNAME_RECORD_BYTES
}

// field(check, { optional, fallback }): `fallback` is filled in when the
// field is absent (the handler always sees it).
function req (check) {
  return { check, optional: false }
}

function opt (check, fallback) {
  return { check, optional: true, fallback }
}

const none = {}

// method -> { fields, mutating, cross? }. Every params object has exactly
// a subset of `fields` (all required ones present).
const SPECS = {
  'session.open': { fields: { token: opt(str(1, L.MAX_TOKEN)) } },
  'node.info': { fields: none },
  'identity.create': { fields: none, mutating: true },
  'identity.show': { fields: none },
  'cert.add': { fields: { cert: req(isCert) }, mutating: true },
  // Signs the account-link statement with the identity key; the node fills
  // in member and association itself, so a caller never chooses the bytes.
  'account.sign': {
    fields: {
      phase: req(isPhase),
      nonce: req(isNonce),
      username: req(isUsername),
      sub: req(isSub)
    },
    cross (given, value) {
      // A Google subject only at 'finish', and always there.
      if ((value.phase === 'finish') !== (value.sub !== '')) return 'parâmetro inválido: sub'
      return null
    }
  },
  // Appends an issuer-signed username record to the own diary; the node
  // verifies it against its own key and the association.
  'username.add': { fields: { record: req(isUsernameRecord) }, mutating: true },
  // Signs a report statement with the identity key; the node fills in
  // member and association itself and hashes text and quote into the
  // payload, so a caller never chooses the bytes. `seq` absent = a report of
  // the whole account (no quote); present = a report of that post, quoting it.
  'report.sign': {
    fields: {
      nonce: req(isNonce),
      target: req(isKey),
      seq: opt(int(1, REPORT_SEQ_MAX)),
      reason: req(isReason),
      text: opt(str(0, REPORT_TEXT_MAX), ''),
      quote: opt(str(0, L.MAX_TEXT), '')
    },
    cross (given, value) {
      if (!hasOwn(value, 'seq') && value.quote !== '') return 'quote só com seq'
      if (hasOwn(value, 'seq') && value.quote === '') return 'parâmetro inválido: quote'
      return null
    }
  },
  'profile.set': {
    fields: { name: req(str(1, L.MAX_NAME)), bio: opt(str(0, L.MAX_BIO), '') },
    mutating: true
  },
  'post.create': { fields: { text: req(str(1, L.MAX_TEXT)) }, mutating: true },
  'post.reply': {
    fields: { to: req((v) => isRef(v, 1)), text: req(str(1, L.MAX_TEXT)) },
    mutating: true
  },
  'follow.add': { fields: { key: req(isKey) }, mutating: true },
  'follow.remove': { fields: { key: req(isKey) }, mutating: true },
  'follow.list': {
    fields: {
      offset: opt(int(0, Number.MAX_SAFE_INTEGER), 0),
      limit: opt(int(1, L.FOLLOW_LIMIT_MAX), L.FOLLOW_LIMIT_DEFAULT)
    }
  },
  'log.read': {
    fields: {
      author: opt(isKey),
      limit: opt(int(1, L.LOG_LIMIT_MAX), L.LOG_LIMIT_DEFAULT)
    }
  },
  'feed.read': { fields: { limit: opt(int(1, L.FEED_LIMIT_MAX), L.FEED_LIMIT_DEFAULT) } },
  'sync.start': {
    fields: {
      once: opt(isBool, false),
      timeoutMs: opt(int(L.SYNC_TIMEOUT_MIN, L.SYNC_TIMEOUT_MAX))
    },
    mutating: true,
    cross (given, value) {
      if (hasOwn(given, 'timeoutMs') && value.once !== true) return 'timeoutMs só com once'
      if (value.once === true && !hasOwn(given, 'timeoutMs')) value.timeoutMs = L.SYNC_TIMEOUT_DEFAULT
      return null
    }
  },
  'sync.stop': { fields: none, mutating: true },
  'sync.status': { fields: none },
  // IPC only: offered by the in-app worklet (apps/app/worklet/main.js), not
  // by the node session or varanda-serve (docs/rpc.md 5.17).
  'node.close': { fields: none, mutating: true }
}

const METHODS = Object.freeze(Object.keys(SPECS))
const MUTATING = Object.freeze(METHODS.filter((m) => SPECS[m].mutating === true))

function isMethod (method) {
  return typeof method === 'string' && hasOwn(SPECS, method)
}

function isMutating (method) {
  return MUTATING.includes(method)
}

function fail (message) {
  return { ok: false, code: 'USAGE', message }
}

// Validates the params of a known method and returns a fresh normalized
// copy (defaults filled in). Messages name the field, never echo a value.
// Never throws.
function validateParams (method, params) {
  try {
    if (!isMethod(method)) return fail('método desconhecido')
    if (!isPlainObject(params)) return fail('params inválidos')
    const spec = SPECS[method]
    for (const key of Object.keys(params)) {
      if (!hasOwn(spec.fields, key)) return fail('parâmetro desconhecido')
    }
    const value = {}
    for (const name of Object.keys(spec.fields)) {
      const field = spec.fields[name]
      if (!hasOwn(params, name)) {
        if (!field.optional) return fail('parâmetro obrigatório: ' + name)
        if (field.fallback !== undefined) value[name] = field.fallback
        continue
      }
      const v = params[name]
      if (!field.check(v)) return fail('parâmetro inválido: ' + name)
      value[name] = v
    }
    if (spec.cross) {
      const message = spec.cross(params, value)
      if (message !== null) return fail(message)
    }
    return { ok: true, value }
  } catch {
    return fail('params inválidos')
  }
}

module.exports = {
  METHODS,
  MUTATING,
  isMethod,
  isMutating,
  validateParams,
  isPlainObject,
  hasOwn,
  isId,
  isKey,
  isRef
}
