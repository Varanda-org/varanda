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
// A report of a private message (Conversas) signs 'varanda-dm-report-v1':
// the quote is the plaintext the reporter chose and `target` is the sender's
// diary key, so moderators can block the account. The signature proves that
// the reporter attested this quote about this target; it does NOT prove that
// the target sent it. No sender signature, message id or conversation is
// bound, so the quote is unverifiable and the panel labels it 'não conferida'
// (docs/protocol.md section 11).
//
// A report that carries an anexo (an image the reporter attaches, sent to
// the account service next to the report) adds ONE line to its statement:
// the lowercase hex SHA-256 of the attachment bytes. A private message
// signs 'varanda-dm-report-v2' and a group message 'varanda-report-v3';
// without an anexo the older statement is signed unchanged, so every old
// signature still verifies and a v1 signature can never pass as v2/v3 (or
// back). Under v2 the quote may be empty (a media-only message). The digest
// binds the reporter to the exact bytes, not to the sender: like the quote,
// the image is the reporter's word only ('não conferida').
//
// A report of a Feira listing (docs/rpc.md report.sign, kind 'listing')
// signs 'varanda-listing-report-v1' with the v1 line layout: `target` is the
// seller's diary key and `seq` the listing record, always present (a listing
// is one record, never a whole account). It carries no writer, group or
// anexo: the listing is on the seeder, where the moderator reads it. The
// distinct prefix keeps a diary post report from ever verifying as a listing
// report and back, so the account service can route the two apart.
//
// Pure: b4a, hypercore-crypto, ./safe and ./records only (loaded by the
// browser bundle and the account service alike; no '#fs', no network).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { isUnsafe } = require('./safe')
const { MAX_TEXT, MAX_LOG_BLOCKS } = require('./records')

const PREFIX = 'varanda-report-v1'
const PREFIX_V2 = 'varanda-report-v2'
const PREFIX_V3 = 'varanda-report-v3'
const PREFIX_DM = 'varanda-dm-report-v1'
const PREFIX_DM_V2 = 'varanda-dm-report-v2'
const PREFIX_LISTING = 'varanda-listing-report-v1'
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
// An allow-list, so a field naming a message or conversation (seq, writer,
// group, peer) can never ride along unsigned.
const DM_KEYS = Object.freeze(['nonce', 'member', 'association', 'target', 'reason', 'text', 'quote'])
const DM_KEYS_V2 = Object.freeze([...DM_KEYS, 'anexo'])
const LISTING_KEYS = Object.freeze(['nonce', 'member', 'association', 'target', 'seq', 'reason', 'text', 'quote'])
const LISTING_FORBIDDEN = Object.freeze(['writer', 'group', 'anexo'])

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
  const { writer, group, anexo } = fields
  const hasAnexo = anexo !== undefined && anexo !== null
  if (hasAnexo && (typeof anexo !== 'string' || !HEX64.test(anexo))) return 'anexo'
  if (writer === undefined || writer === null) {
    if (group !== undefined && group !== null) return 'group'
    // A diary post is on the seeder: the moderator reads it there.
    if (hasAnexo) return 'anexo'
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
// digest(quote) instead; with `anexo` too, PREFIX_V3 in place of PREFIX_V2
// and the anexo (hex SHA-256) as one last line. Throws TypeError on a bad
// shape.
function reportPayload (fields) {
  const reason = checkFields(fields)
  if (reason !== null) throw new TypeError('invalid report ' + reason)
  const { nonce, member, association, target, seq, text, quote, anexo } = fields
  const seqField = seq === null ? '' : String(seq)
  let lines
  if (!isGroupReport(fields)) {
    lines = [PREFIX, nonce, member, association, target, seqField, fields.reason, digest(text), digest(quote)]
  } else if (anexo === undefined || anexo === null) {
    lines = [PREFIX_V2, nonce, member, association, target, fields.group, fields.writer, seqField, fields.reason, digest(text), digest(quote)]
  } else {
    lines = [PREFIX_V3, nonce, member, association, target, fields.group, fields.writer, seqField, fields.reason, digest(text), digest(quote), anexo]
  }
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

// Exactly the DM keys (v1, or v1 plus `anexo` for v2) as own data
// properties, copied once (as push-proof.js): no getter runs, nothing is
// inherited, and no hidden extra key rides along, so the values checked are
// the values signed. -> the copy, or null.
function dmSnapshot (fields) {
  if (!isPlainObject(fields)) return null
  const keys = Object.prototype.hasOwnProperty.call(fields, 'anexo') ? DM_KEYS_V2 : DM_KEYS
  if (Reflect.ownKeys(fields).length !== keys.length) return null
  const copy = {}
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(fields, key)
    if (d === undefined || !('value' in d)) return null
    copy[key] = d.value
  }
  return copy
}

function checkDmFields (fields) {
  if (fields === null) return 'fields'
  const { nonce, member, association, target, reason, text, quote } = fields
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return 'nonce'
  if (typeof member !== 'string' || !HEX64.test(member)) return 'member'
  if (typeof association !== 'string' || !HEX64.test(association)) return 'association'
  if (typeof target !== 'string' || !HEX64.test(target)) return 'target'
  if (member === target) return 'target'
  if (typeof reason !== 'string' || !REASONS.includes(reason)) return 'reason'
  if (!validText(text, TEXT_MAX, false)) return 'text'
  const v2 = Object.prototype.hasOwnProperty.call(fields, 'anexo')
  if (v2 && (typeof fields.anexo !== 'string' || !HEX64.test(fields.anexo))) return 'anexo'
  // Only v2 may quote nothing: the image is then the evidence.
  if (!validText(quote, QUOTE_MAX, true) || (quote === '' && !v2)) return 'quote'
  return null
}

// { nonce, member, association, target, reason, text, quote } -> the UTF-8
// bytes of PREFIX_DM, nonce, member, association, target, reason,
// digest(text), digest(quote) joined by LF (no trailing LF). With `anexo`,
// PREFIX_DM_V2 in place of PREFIX_DM and the anexo (hex SHA-256) as a ninth
// line. Throws TypeError on a bad shape or on any other key.
function dmReportPayload (fields) {
  return dmPayloadOf(dmSnapshot(fields))
}

function dmPayloadOf (snap) {
  const bad = checkDmFields(snap)
  if (bad !== null) throw new TypeError('invalid dm report ' + bad)
  const { nonce, member, association, target, reason, text, quote } = snap
  const lines = Object.prototype.hasOwnProperty.call(snap, 'anexo')
    ? [PREFIX_DM_V2, nonce, member, association, target, reason, digest(text), digest(quote), snap.anexo]
    : [PREFIX_DM, nonce, member, association, target, reason, digest(text), digest(quote)]
  return b4a.from(lines.join('\n'), 'utf8')
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signDmReport (fields, keyPair) {
  const payload = dmReportPayload(fields)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// As verifyReport, against `member`. Never throws.
function verifyDmReport (fields, signatureHex) {
  try {
    const snap = dmSnapshot(fields)
    if (checkDmFields(snap) !== null) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(dmPayloadOf(snap), b4a.from(signatureHex, 'hex'), b4a.from(snap.member, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

// The listing keys as own data properties, copied once (as dmSnapshot), so
// no getter can shift a value between the check and the signature. Extra
// keys are ignored, except writer, group and anexo: a listing report that
// names one is refused rather than signed without it. -> the copy, or null.
function listingSnapshot (fields) {
  if (!isPlainObject(fields)) return null
  for (const key of LISTING_FORBIDDEN) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) return null
  }
  const copy = {}
  for (const key of LISTING_KEYS) {
    const d = Object.getOwnPropertyDescriptor(fields, key)
    if (d === undefined || !('value' in d)) return null
    copy[key] = d.value
  }
  return copy
}

// -> null when the fields are a valid listing report, else a short reason.
function checkListingFields (fields) {
  if (isPlainObject(fields)) {
    for (const key of LISTING_FORBIDDEN) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) return key
    }
  }
  const snap = listingSnapshot(fields)
  if (snap === null) return 'fields'
  return checkListingSnap(snap)
}

function checkListingSnap (snap) {
  const { nonce, member, association, target, seq, reason, text, quote } = snap
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return 'nonce'
  if (typeof member !== 'string' || !HEX64.test(member)) return 'member'
  if (typeof association !== 'string' || !HEX64.test(association)) return 'association'
  if (typeof target !== 'string' || !HEX64.test(target)) return 'target'
  if (member === target) return 'target'
  if (!(Number.isSafeInteger(seq) && seq >= 1 && seq <= SEQ_MAX)) return 'seq'
  if (typeof reason !== 'string' || !REASONS.includes(reason)) return 'reason'
  if (!validText(text, TEXT_MAX, false)) return 'text'
  if (!validText(quote, QUOTE_MAX, true)) return 'quote'
  return null
}

// The v1 lines under PREFIX_LISTING. Throws TypeError on a bad shape.
function listingPayloadOf (snap) {
  const bad = snap === null ? 'fields' : checkListingSnap(snap)
  if (bad !== null) throw new TypeError('invalid listing report ' + bad)
  const { nonce, member, association, target, seq, reason, text, quote } = snap
  const lines = [PREFIX_LISTING, nonce, member, association, target, String(seq), reason, digest(text), digest(quote)]
  return b4a.from(lines.join('\n'), 'utf8')
}

// -> lowercase hex128 Ed25519 signature by keyPair.secretKey.
function signListingReport (fields, keyPair) {
  // One snapshot is checked and signed, so no second read can differ.
  const snap = listingSnapshot(fields)
  const bad = snap === null ? checkListingFields(fields) : checkListingSnap(snap)
  if (bad !== null) throw new TypeError('invalid listing report ' + bad)
  const payload = listingPayloadOf(snap)
  if (keyPair === null || typeof keyPair !== 'object' || !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('invalid key pair')
  }
  return b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex')
}

// As verifyReport, against `member`. Never throws.
function verifyListingReport (fields, signatureHex) {
  try {
    const snap = listingSnapshot(fields)
    if (snap === null || checkListingSnap(snap) !== null) return { ok: false, reason: 'malformed' }
    if (typeof signatureHex !== 'string' || !HEX128.test(signatureHex)) return { ok: false, reason: 'malformed' }
    const ok = crypto.verify(listingPayloadOf(snap), b4a.from(signatureHex, 'hex'), b4a.from(snap.member, 'hex'))
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

module.exports = {
  PREFIX,
  PREFIX_V2,
  PREFIX_V3,
  PREFIX_DM,
  PREFIX_DM_V2,
  PREFIX_LISTING,
  REASONS,
  REASON_LABELS,
  TEXT_MAX,
  QUOTE_MAX,
  SEQ_MAX,
  NONCE_RE,
  isCleanText,
  digest,
  isGroupReport,
  reportPayload,
  signReport,
  verifyReport,
  dmReportPayload,
  signDmReport,
  verifyDmReport,
  checkListingFields,
  signListingReport,
  verifyListingReport
}
