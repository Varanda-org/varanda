'use strict'

// Media attachments: a post may carry up to MAX_MEDIA_PER_POST descriptors
// pointing into a media core (a separate Hypercore whose block 0 is a media
// header, lib/media.js) that the diary declares with a `media-core` record.
// Moderation lists are signed snapshots outside the diary (lib/blocklist.js).
// Engagement: `like` and `repost` records toggle a target post ({ author,
// seq }, seq >= 1) on or off, the last operation per (type, target) wins
// (lib/engagement.js); a quote is a `post` with a `quote` target and no
// `replyTo`. Older readers skip these as invalid; the diary stays valid.

const b4a = require('b4a')

const MAX_NAME = 80
const MAX_BIO = 280
const MAX_TEXT = 1000
// Storage limits (security audit S3): one raw block, and one whole log.
const MAX_BLOCK_BYTES = 16384
const MAX_LOG_BLOCKS = 100000
const MAX_LOG_BYTES = 64 * 1024 * 1024
// Media (lib/media.js): every media core block is MEDIA_BLOCK_BYTES except
// the last block of an item (1..MEDIA_BLOCK_BYTES).
const MEDIA_BLOCK_BYTES = 32768
const MAX_MEDIA_BLOCKS = 8192 // blocks per media core, header included
const MAX_MEDIA_BYTES = 268435456 // 256 MiB per media core
const MAX_MEDIA_CORES = 4 // latest media-core declarations honoured per diary
const MAX_MEDIA_PER_POST = 4
const MAX_MEDIA_ITEM_BLOCKS = 256 // 8 MiB per item
const MEDIA_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_MEDIA_DIMENSION = 16384

const CERT_KEYS = ['v', 'member', 'ageBand', 'method', 'date', 'association', 'signature']
const CERT_KEYS_V2 = ['v', 'member', 'ageBand', 'method', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']
const PROFILE_KEYS = ['type', 'name', 'bio', 'at']
const POST_KEYS = ['type', 'text', 'at', 'replyTo']
const POST_MEDIA_KEYS = ['type', 'text', 'at', 'replyTo', 'media']
const QUOTE_KEYS = ['type', 'text', 'at', 'replyTo', 'quote']
const QUOTE_MEDIA_KEYS = ['type', 'text', 'at', 'replyTo', 'quote', 'media']
const ENGAGEMENT_KEYS = ['type', 'to', 'on', 'at']
const TARGET_KEYS = ['author', 'seq']
const DESCRIPTOR_KEYS = ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height']
const MEDIA_CORE_KEYS = ['type', 'key', 'at']
const FOLLOW_KEYS = ['type', 'key', 'on', 'at']
const USERNAME_KEYS = ['type', 'username', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']
// Same field rules as validateCertShape and validateUsernameRecordShape in
// lib/cert.js (not imported here); apps/cli/test/records.test.js checks parity.
const AGE_BAND_RE = /^[a-z0-9+-]{1,32}$/
const METHOD_RE = /^[a-z0-9-]{1,32}$/
const AGE_BAND_V2 = 'unchecked'
const METHOD_V2 = 'google'
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const FALLBACK_HANDLE_RE = /^[0-9a-f]{6}$/

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

function isUsername (s) {
  return typeof s === 'string' && USERNAME_RE.test(s) && !FALLBACK_HANDLE_RE.test(s)
}

// The issuer fields shared by a v2 certificate and a username record.
function validDelegation (o) {
  return isHex64(o.association) &&
    isHex64(o.issuer) &&
    o.issuer !== o.association &&
    isHex128(o.issuerSignature) &&
    isCanonicalIso(o.issuerDate)
}

function validCertShape (cert) {
  if (!isPlainObject(cert)) return false
  if (hasExactKeys(cert, CERT_KEYS)) {
    return cert.v === 1 &&
      isHex64(cert.member) &&
      isHex64(cert.association) &&
      isHex128(cert.signature) &&
      typeof cert.ageBand === 'string' && AGE_BAND_RE.test(cert.ageBand) &&
      typeof cert.method === 'string' && METHOD_RE.test(cert.method) &&
      isCanonicalIso(cert.date)
  }
  if (hasExactKeys(cert, CERT_KEYS_V2)) {
    return cert.v === 2 &&
      isHex64(cert.member) &&
      validDelegation(cert) &&
      isHex128(cert.signature) &&
      cert.ageBand === AGE_BAND_V2 &&
      cert.method === METHOD_V2 &&
      isCanonicalIso(cert.date)
  }
  return false
}

function validUsernameShape (record) {
  if (!hasExactKeys(record, USERNAME_KEYS)) return false
  return isUsername(record.username) &&
    isHex64(record.member) &&
    validDelegation(record) &&
    isHex128(record.signature) &&
    isCanonicalIso(record.date)
}

// A post reference: exactly { author: lowercase hex64, seq: safe int >= 1 }.
function validTarget (r) {
  if (!isPlainObject(r) || !hasExactKeys(r, TARGET_KEYS)) return false
  return isHex64(r.author) && Number.isSafeInteger(r.seq) && r.seq >= 1
}

function validReplyTo (r) {
  return r === null || validTarget(r)
}

function isIntIn (v, min, max) {
  return Number.isSafeInteger(v) && v >= min && v <= max
}

// A media descriptor (exact keys): where an item lives in a media core and
// what it is. Key-agnostic: "core is not the diary key" is checked by the
// readers and writers (lib/media.js). Never throws.
function validDescriptor (d) {
  try {
    if (!isPlainObject(d) || !hasExactKeys(d, DESCRIPTOR_KEYS)) return false
    const { core, mime, start, blocks, bytes, sha256, width, height } = d
    return isHex64(core) &&
      typeof mime === 'string' && MEDIA_MIMES.includes(mime) &&
      isIntIn(start, 1, MAX_MEDIA_BLOCKS - 1) &&
      isIntIn(blocks, 1, MAX_MEDIA_ITEM_BLOCKS) &&
      start + blocks <= MAX_MEDIA_BLOCKS &&
      Number.isSafeInteger(bytes) &&
      bytes > (blocks - 1) * MEDIA_BLOCK_BYTES &&
      bytes <= blocks * MEDIA_BLOCK_BYTES &&
      isHex64(sha256) &&
      isIntIn(width, 1, MAX_MEDIA_DIMENSION) &&
      isIntIn(height, 1, MAX_MEDIA_DIMENSION)
  } catch {
    return false
  }
}

// By index, never every(): a hole in a sparse array is undefined and invalid.
function validMediaList (media) {
  if (!Array.isArray(media) || media.length < 1 || media.length > MAX_MEDIA_PER_POST) return false
  for (let i = 0; i < media.length; i++) {
    if (!validDescriptor(media[i])) return false
  }
  return true
}

const TYPES = ['member-cert', 'profile', 'post', 'username', 'media-core', 'follow', 'like', 'repost']

function check (record, seq) {
  if (!isPlainObject(record)) return 'malformed'
  const type = record.type
  if (!TYPES.includes(type)) return 'malformed'
  if (seq === 0 && type !== 'member-cert') return 'genesis-required'
  if (type === 'member-cert') {
    if (seq !== 0) return 'cert-not-first'
    return validCertShape(record.cert) ? null : 'malformed'
  }
  // Shape only: the issuer signatures are checked by verifyUsernameRecord
  // (lib/cert.js) where the username is read (lib/username.js).
  if (type === 'username') return validUsernameShape(record) ? null : 'malformed'
  if (type === 'profile') {
    if (!hasExactKeys(record, PROFILE_KEYS)) return 'malformed'
    const { name, bio, at } = record
    if (typeof name !== 'string' || charLength(name) < 1 || charLength(name) > MAX_NAME) return 'name-length'
    if (typeof bio !== 'string' || charLength(bio) > MAX_BIO) return 'bio-length'
    if (hasControlChars(name, false) || hasControlChars(bio, true)) return 'control-chars'
    if (!isCanonicalIso(at)) return 'date-invalid'
    return null
  }
  if (type === 'media-core') {
    if (!hasExactKeys(record, MEDIA_CORE_KEYS) || !isHex64(record.key)) return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  if (type === 'follow') {
    if (!hasExactKeys(record, FOLLOW_KEYS) || !isHex64(record.key) || typeof record.on !== 'boolean') return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  if (type === 'like' || type === 'repost') {
    if (!hasExactKeys(record, ENGAGEMENT_KEYS) || !validTarget(record.to) || typeof record.on !== 'boolean') return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  const isQuote = hasExactKeys(record, QUOTE_KEYS) || hasExactKeys(record, QUOTE_MEDIA_KEYS)
  const withMedia = hasExactKeys(record, POST_MEDIA_KEYS) || hasExactKeys(record, QUOTE_MEDIA_KEYS)
  if (!isQuote && !withMedia && !hasExactKeys(record, POST_KEYS)) return 'malformed'
  if (withMedia && !validMediaList(record.media)) return 'media-invalid'
  const { text, at, replyTo } = record
  // A post with media may have an empty text (a photo-only post); a quote
  // always has text, with or without media.
  const minText = withMedia && !isQuote ? 0 : 1
  if (typeof text !== 'string' || charLength(text) < minText || charLength(text) > MAX_TEXT) return 'text-length'
  if (hasControlChars(text, true)) return 'control-chars'
  if (!isCanonicalIso(at)) return 'date-invalid'
  if (isQuote) {
    if (replyTo !== null) return 'quote-with-reply'
    return validTarget(record.quote) ? null : 'quote-invalid'
  }
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

// A copy with exactly the descriptor keys (anything else is passed through
// for validation to reject).
function copyDescriptor (d) {
  if (!isPlainObject(d)) return d
  const out = {}
  for (const k of DESCRIPTOR_KEYS) out[k] = d[k]
  return out
}

// A copy with exactly the target keys (anything else is passed through for
// validation to reject).
function copyTarget (r) {
  if (!isPlainObject(r)) return r
  return { author: r.author, seq: r.seq }
}

// `quote` and `media` are added only when given.
function postRecord ({ text, replyTo = null, at = nowIso(), media, quote } = {}) {
  const record = { type: 'post', text, at, replyTo }
  if (quote !== undefined) record.quote = copyTarget(quote)
  if (media !== undefined) record.media = Array.isArray(media) ? media.map(copyDescriptor) : media
  return build(record, 1)
}

function likeRecord ({ to, on, at = nowIso() } = {}) {
  return build({ type: 'like', to: copyTarget(to), on, at }, 1)
}

function repostRecord ({ to, on, at = nowIso() } = {}) {
  return build({ type: 'repost', to: copyTarget(to), on, at }, 1)
}

function mediaCoreRecord ({ key, at = nowIso() } = {}) {
  return build({ type: 'media-core', key, at }, 1)
}

function followRecord ({ key, on, at = nowIso() } = {}) {
  return build({ type: 'follow', key, on, at }, 1)
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
  MEDIA_BLOCK_BYTES,
  MAX_MEDIA_BLOCKS,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_CORES,
  MAX_MEDIA_PER_POST,
  MAX_MEDIA_ITEM_BLOCKS,
  MEDIA_MIMES,
  MAX_MEDIA_DIMENSION,
  nowIso,
  isHex64,
  isCanonicalIso,
  decodeBlock,
  memberCertRecord,
  profileRecord,
  postRecord,
  mediaCoreRecord,
  followRecord,
  likeRecord,
  repostRecord,
  validDescriptor,
  validateRecord,
  validRecordCopy,
  parseRef,
  formatRef,
  latestProfile,
  genesisCert
}
