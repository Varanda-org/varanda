'use strict'

// A member's report (docs/rpc.md 5.20): the reporter's diary key signs a
// domain-separated statement that binds one account-service step (single-use
// nonce) to the reporter, the association, the reported diary, the reported
// post (seq, or '' for the whole account), a reason, the reporter's own text
// and the quoted post text. Text and quote enter the payload as digests, so a
// LF inside a post can never shift the framing. The bytes start with
// 'varanda-report-v1', so a signature over them can never be a certificate,
// an account link (varanda-account-link-v1), a moderation request or a
// Hypercore block signature, and vice versa.
//
// A report of a group message (fields carry `writer` and `group`) signs the
// 'varanda-report-v2' statement instead, which also binds the group root key
// and the writer core that holds the message at `seq`. The two prefixes keep a
// v1 signature from ever verifying as a v2 statement and back.
//
// What the signature proves: that the reporter attested this text and this
// quote to the association's account service. It does NOT prove that the
// reported diary contains the quote; the moderator checks that separately.
//
// Pure: b4a, hypercore-crypto, ./safe and ./records only (loaded by the
// browser bundle and the account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { isUnsafe } = require('./safe')
const { MAX_TEXT, MAX_LOG_BLOCKS } = require('./records')

const PREFIX = 'varanda-report-v1'
const PREFIX_V2 = 'varanda-report-v2'
const REASONS = Object.freeze(['spam', 'assedio', 'ilegal', 'outro'])
const REASON_LABELS = Object.freeze({ spam: 'spam', assedio: 'assédio', ilegal: 'conteúdo ilegal', outro: 'outro' })
// Code points (Array.from length), as packages/rpc text.js charLength.
const TEXT_MAX = 280
const QUOTE_MAX = MAX_TEXT
// records.js MAX_LOG_BLOCKS blocks, and seq 0 is the member certificate
// (records.js genesisCert), so a post is at most at MAX_LOG_BLOCKS - 1.
const SEQ_MAX = MAX_LOG_BLOCKS - 1
// A base64url nonce of at least 32 bytes of entropy (as account-link.js).
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

function isPlainObject (o) {
  if (o === null || typeof o !== 'object') return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// Same rule as records.js isForbiddenChar (not exported there): no code
// point that safe.js isUnsafe flags, except LF when allowLf.
function isCleanText (s, allowLf) {
  if (typeof s !== 'string') return false
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (allowLf && cp === 0x0a) continue
    if (isUnsafe(cp)) return false
  }
  return true
}

// String.prototype.isWellFormed, spelled out so it also holds on runtimes
// without it: lone surrogates and U+FFFD encode to the same UTF-8 bytes, so a
// digest over UTF-8 would not bind a string holding one (B3 D5).
function isWellFormed (s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (d < 0xdc00 || d > 0xdfff) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

// Lowercase hex of the plain BLAKE2b-256 hash (hypercore-crypto hash(), as
// admission.js topicFor) of the UTF-8 bytes of s; '' hashes too.
function digest (s) {
  return b4a.toString(crypto.hash(b4a.from(s, 'utf8')), 'hex')
}

function validText (s, max, allowLf) {
  return typeof s === 'string' &&
    isWellFormed(s) &&
    Array.from(s).length <= max &&
    isCleanText(s, allowLf)
}

// -> null when the fields are a valid statement, else a short reason.
function checkFields (fields) {
  if (!isPlainObject(fields)) return 'fields'
  const { nonce, member, association, target, seq, reason, text, quote } = fields
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return 'nonce'
  if (typeof member !== 'string' || !HEX64.test(member)) return 'member'
  if (typeof association !== 'string' || !HEX64.test(association)) return 'association'
  if (typeof target !== 'string' || !HEX64.test(target)) return 'target'
  if (member === target) return 'target'
  if (seq !== null && !(Number.isSafeInteger(seq) && seq >= 1 && seq <= SEQ_MAX)) return 'seq'
  if (typeof reason !== 'string' || !REASONS.includes(reason)) return 'reason'
  if (!validText(text, TEXT_MAX, false)) return 'text'
  if (!validText(quote, QUOTE_MAX, true)) return 'quote'
  if (seq === null && quote !== '') return 'quote'
  const { writer, group } = fields
  if (writer === undefined || writer === null) {
    if (group !== undefined && group !== null) return 'group'
    return null
  }
  if (typeof writer !== 'string' || !HEX64.test(writer)) return 'writer'
  if (seq === null) return 'seq'
  if (typeof group !== 'string' || !HEX64.test(group)) return 'group'
  return null
}

function isGroupReport (fields) {
  return isPlainObject(fields) && fields.writer !== undefined && fields.writer !== null
}

// { nonce, member, association, target, seq, reason, text, quote } -> the
// UTF-8 bytes of PREFIX, nonce, member, association, target, seq, reason,
// digest(text), digest(quote) joined by LF (no trailing LF). `seq` is the
// canonical decimal for a post report and '' for an account report (null).
// With `writer` (and `group`), the bytes of PREFIX_V2, nonce, member,
// association, target, group, writer, seq, reason, digest(text),
// digest(quote) instead. Throws TypeError on a bad shape.
function reportPayload (fields) {
  const reason = checkFields(fields)
  if (reason !== null) throw new TypeError('invalid report ' + reason)
  const { nonce, member, association, target, seq, text, quote } = fields
  const seqField = seq === null ? '' : String(seq)
  const lines = isGroupReport(fields)
    ? [PREFIX_V2, nonce, member, association, target, fields.group, fields.writer, seqField, fields.reason, digest(text), digest(quote)]
    : [PREFIX, nonce, member, association, target, seqField, fields.reason, digest(text), digest(quote)]
  return b4a.from(lines.join('\n'), 'utf8')
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signReport (fields, keyPair) {
  const payload = reportPayload(fields)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// Verifies against `member` as the Ed25519 public key (the web diary key is
// the signer, packages/web-member/lib/diary-options.js). -> { ok: true } |
// { ok: false, reason: 'malformed' | 'bad-signature' }. Never throws.
function verifyReport (fields, signatureHex) {
  try {
    if (checkFields(fields) !== null) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(reportPayload(fields), b4a.from(signatureHex, 'hex'), b4a.from(fields.member, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

module.exports = {
  PREFIX,
  PREFIX_V2,
  REASONS,
  REASON_LABELS,
  TEXT_MAX,
  QUOTE_MAX,
  SEQ_MAX,
  NONCE_RE,
  isCleanText,
  isWellFormed,
  digest,
  isGroupReport,
  reportPayload,
  signReport,
  verifyReport
}
