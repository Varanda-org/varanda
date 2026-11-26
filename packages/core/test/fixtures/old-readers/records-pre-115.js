'use strict'

// TODO(later): media attachments and moderation lists are out of scope for phase 0.

const b4a = require('b4a')

const MAX_NAME = 80
const MAX_BIO = 280
const MAX_TEXT = 1000
// Storage limits (security audit S3): one raw block, and one whole log.
const MAX_BLOCK_BYTES = 16384
const MAX_LOG_BLOCKS = 100000
const MAX_LOG_BYTES = 64 * 1024 * 1024

const CERT_KEYS = ['v', 'member', 'ageBand', 'method', 'date', 'association', 'signature']
const PROFILE_KEYS = ['type', 'name', 'bio', 'at']
const POST_KEYS = ['type', 'text', 'at', 'replyTo']
// Same field rules as validateCertShape in lib/cert.js (not imported here).
const AGE_BAND_RE = /^[a-z0-9+-]{1,32}$/
const METHOD_RE = /^[a-z0-9-]{1,32}$/

function nowIso () {
  return new Date().toISOString()
}

function isHex64 (s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
}

function isHex128 (s) {
  return typeof s === 'string' && /^[0-9a-f]{128}$/.test(s)
}

function isCanonicalIso (s) {
  try {
    return typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s
  } catch {
    return false
  }
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

// A block over MAX_BLOCK_BYTES is never parsed (security audit S3).
function decodeBlock (buf) {
  if (!b4a.isBuffer(buf) && !(buf instanceof Uint8Array)) return null
  if (buf.byteLength > MAX_BLOCK_BYTES) return null
  try {
    const value = JSON.parse(b4a.toString(buf, 'utf8'))
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

function charLength (s) {
  return Array.from(s).length
}

// Forbidden in name, bio and text (security audit S5): C0 controls (only LF
// when allowLf), DEL, C1 controls, the line/paragraph separators U+2028 and
// U+2029 and the bidi embedding/override/isolate controls U+202A-U+202E and
// U+2066-U+2069, so a record can never forge a terminal line or reorder it.
function isForbiddenChar (cp, allowLf) {
  if (cp < 0x20) return !(allowLf && cp === 0x0a)
  if (cp >= 0x7f && cp <= 0x9f) return true
  if (cp === 0x2028 || cp === 0x2029) return true
  if (cp >= 0x202a && cp <= 0x202e) return true
  return cp >= 0x2066 && cp <= 0x2069
}

function hasControlChars (s, allowLf) {
  for (const ch of s) {
    if (isForbiddenChar(ch.codePointAt(0), allowLf)) return true
  }
  return false
}

function validCertShape (cert) {
  if (!isPlainObject(cert) || !hasExactKeys(cert, CERT_KEYS)) return false
  return cert.v === 1 &&
    isHex64(cert.member) &&
    isHex64(cert.association) &&
    isHex128(cert.signature) &&
    typeof cert.ageBand === 'string' && AGE_BAND_RE.test(cert.ageBand) &&
    typeof cert.method === 'string' && METHOD_RE.test(cert.method) &&
    isCanonicalIso(cert.date)
}

function validReplyTo (r) {
  if (r === null) return true
  if (!isPlainObject(r) || !hasExactKeys(r, ['author', 'seq'])) return false
  return isHex64(r.author) && Number.isSafeInteger(r.seq) && r.seq >= 1
}

function check (record, seq) {
  if (!isPlainObject(record)) return 'malformed'
  const type = record.type
  if (type !== 'member-cert' && type !== 'profile' && type !== 'post') return 'malformed'
  if (seq === 0 && type !== 'member-cert') return 'genesis-required'
  if (type === 'member-cert') {
    if (seq !== 0) return 'cert-not-first'
    return validCertShape(record.cert) ? null : 'malformed'
  }
  if (type === 'profile') {
    if (!hasExactKeys(record, PROFILE_KEYS)) return 'malformed'
    const { name, bio, at } = record
    if (typeof name !== 'string' || charLength(name) < 1 || charLength(name) > MAX_NAME) return 'name-length'
    if (typeof bio !== 'string' || charLength(bio) > MAX_BIO) return 'bio-length'
    if (hasControlChars(name, false) || hasControlChars(bio, true)) return 'control-chars'
    if (!isCanonicalIso(at)) return 'date-invalid'
    return null
  }
  if (!hasExactKeys(record, POST_KEYS)) return 'malformed'
  const { text, at, replyTo } = record
  if (typeof text !== 'string' || charLength(text) < 1 || charLength(text) > MAX_TEXT) return 'text-length'
  if (hasControlChars(text, true)) return 'control-chars'
  if (!isCanonicalIso(at)) return 'date-invalid'
  if (!validReplyTo(replyTo)) return 'reply-invalid'
  return null
}

// Never throws, whatever the input (hostile getters included).
function validateRecord (record, seq) {
  try {
    return check(record, seq)
  } catch {
    return 'malformed'
  }
}

function build (record, seq) {
  const reason = validateRecord(record, seq)
  if (reason) throw new TypeError(reason)
  return record
}

function memberCertRecord (cert) {
  return build({ type: 'member-cert', cert }, 0)
}

function profileRecord ({ name, bio = '', at = nowIso() } = {}) {
  return build({ type: 'profile', name, bio, at }, 1)
}

function postRecord ({ text, replyTo = null, at = nowIso() } = {}) {
  return build({ type: 'post', text, at, replyTo }, 1)
}

function parseRef (str) {
  if (typeof str !== 'string') return null
  // Canonical decimal only: no leading zeros (except '0'), no rounding.
  const m = /^([0-9a-fA-F]{64}):(0|[1-9][0-9]*)$/.exec(str)
  if (!m) return null
  const seq = Number(m[2])
  if (!Number.isSafeInteger(seq) || String(seq) !== m[2]) return null
  return { author: m[1].toLowerCase(), seq }
}

function formatRef ({ author, seq }) {
  return author + ':' + seq
}

// Fallback for a runtime without structuredClone (bare-runtime 1.34.1 has
// it; the Bare embedded by react-native-bare-kit may differ): copies plain
// data only (null, booleans, numbers, strings, arrays, plain objects) and
// throws on anything else (functions, undefined, BigInt, symbols, class
// instances, cycles), which the caller turns into null exactly as a
// structuredClone DataCloneError or a validation failure would.
function plainClone (value, seen) {
  if (value === null) return null
  const type = typeof value
  if (type === 'boolean' || type === 'number' || type === 'string') return value
  if (type !== 'object') throw new TypeError('not plain data')
  if (seen.has(value)) throw new TypeError('cycle')
  seen.add(value)
  let copy
  if (Array.isArray(value)) {
    copy = []
    for (let i = 0; i < value.length; i++) copy.push(plainClone(value[i], seen))
  } else {
    if (!isPlainObject(value)) throw new TypeError('not plain data')
    copy = {}
    // A data property, never an assignment: an own '__proto__' key must be
    // copied as a key (as structuredClone does), not run the prototype setter.
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, { value: plainClone(value[key], seen), enumerable: true, writable: true, configurable: true })
    }
  }
  seen.delete(value)
  return copy
}

function cloneRecord (record) {
  if (typeof structuredClone === 'function') return structuredClone(record)
  return plainClone(record, new Set())
}

// Plain-data copy of a valid record, or null. The record is read once (by
// structuredClone, or by the plain-data walker above where the runtime has
// none) and validated on the copy, so accessors cannot change a field
// between validation and use, and callers never get references into the
// caller's log entries. Never throws.
function validRecordCopy (record, seq) {
  let copy
  try {
    // Inside the try: a revoked Proxy or a throwing getPrototypeOf trap is
    // skipped, never thrown.
    if (!isPlainObject(record)) return null
    copy = cloneRecord(record)
  } catch {
    return null
  }
  return validateRecord(copy, seq) === null ? copy : null
}

function latestProfile (entries) {
  let best = null
  for (const { seq, record } of entries) {
    const copy = validRecordCopy(record, seq)
    if (copy === null || copy.type !== 'profile') continue
    if (best === null || seq > best.seq) best = { seq, name: copy.name, bio: copy.bio }
  }
  return best ? { name: best.name, bio: best.bio } : null
}

function genesisCert (entries) {
  const first = entries[0]
  if (!first || first.seq !== 0) return null
  const copy = validRecordCopy(first.record, 0)
  if (copy === null || copy.type !== 'member-cert') return null
  return copy.cert
}

module.exports = {
  MAX_NAME,
  MAX_BIO,
  MAX_TEXT,
  MAX_BLOCK_BYTES,
  MAX_LOG_BLOCKS,
  MAX_LOG_BYTES,
  nowIso,
  isHex64,
  isCanonicalIso,
  decodeBlock,
  memberCertRecord,
  profileRecord,
  postRecord,
  validateRecord,
  validRecordCopy,
  parseRef,
  formatRef,
  latestProfile,
  genesisCert
}
