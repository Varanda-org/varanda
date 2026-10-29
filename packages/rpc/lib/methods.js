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

// profile.read: 1..PROFILE_LIMIT_MAX keys; duplicates allowed (the node folds
// them).
function isKeyList (v) {
  return Array.isArray(v) && v.length >= 1 && v.length <= L.PROFILE_LIMIT_MAX && v.every(isKey)
}

function isRefList (v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > L.ENGAGEMENT_LIMIT_MAX) return false
  const seen = new Set()
  for (let i = 0; i < v.length; i++) {
    if (!isRef(v[i], 1) || seen.has(v[i])) return false
    seen.add(v[i])
  }
  return true
}

function isPeekSeqs (v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > L.PEEK_SEQS_MAX) return false
  for (let i = 0; i < v.length; i++) {
    if (!Number.isSafeInteger(v[i]) || v[i] < 1 || (i > 0 && v[i] <= v[i - 1])) return false
  }
  return true
}

// The isCanonicalIso rule of @varanda/core lib/records.js, which this package
// cannot import: a string that round-trips through Date unchanged.
const MAX_ISO = 32

function isCanonicalIso (v) {
  if (typeof v !== 'string' || v.length > MAX_ISO) return false
  try {
    return new Date(v).toISOString() === v
  } catch {
    return false
  }
}

// feed.read `before` (docs/rpc.md 5.13): exactly { at, author, seq }, the
// feed-order position of the oldest item the caller holds.
function isFeedCursor (v) {
  if (!isPlainObject(v) || Object.keys(v).length !== 3) return false
  if (!hasOwn(v, 'at') || !hasOwn(v, 'author') || !hasOwn(v, 'seq')) return false
  return isCanonicalIso(v.at) && isKey(v.author) && Number.isSafeInteger(v.seq) && v.seq >= 1
}

// peek.read `after` (docs/rpc.md 5.22): exactly { round, at, author, seq }, the
// peek-order position of the last item the caller holds.
function isPeekCursor (v) {
  if (!isPlainObject(v) || Object.keys(v).length !== 4) return false
  if (!hasOwn(v, 'round') || !hasOwn(v, 'at') || !hasOwn(v, 'author') || !hasOwn(v, 'seq')) return false
  return Number.isSafeInteger(v.round) && v.round >= 0 && isCanonicalIso(v.at) && isKey(v.author) &&
    Number.isSafeInteger(v.seq) && v.seq >= 1
}

// notices.list `after` (docs/rpc.md 5.28): exactly { at, key }, or exactly
// { at, key, seq } after a reply, quote or mention notice; the notices-order
// position of the last item the caller holds.
function isNoticesCursor (v) {
  if (!isPlainObject(v)) return false
  const count = Object.keys(v).length
  if (!hasOwn(v, 'at') || !hasOwn(v, 'key')) return false
  if (count === 2) return isCanonicalIso(v.at) && isKey(v.key)
  if (count !== 3 || !hasOwn(v, 'seq')) return false
  return isCanonicalIso(v.at) && isKey(v.key) && Number.isSafeInteger(v.seq) && v.seq >= 1
}

// post.create / post.reply / post.quote `media`: 1..MAX_MEDIA_PER_POST descriptors.
// Duplicated from validDescriptor in @varanda/core lib/records.js, which this
// package cannot import (same rules, exact keys).
const DESCRIPTOR_KEYS = ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height']

function isDescriptor (d) {
  if (!isPlainObject(d)) return false
  const own = Object.keys(d)
  if (own.length !== DESCRIPTOR_KEYS.length || !DESCRIPTOR_KEYS.every((k) => hasOwn(d, k))) return false
  const { core, mime, start, blocks, bytes, sha256, width, height } = d
  return isKey(core) &&
    typeof mime === 'string' && L.MEDIA_MIMES.includes(mime) &&
    int(1, L.MAX_MEDIA_BLOCKS - 1)(start) &&
    int(1, L.MAX_MEDIA_ITEM_BLOCKS)(blocks) &&
    start + blocks <= L.MAX_MEDIA_BLOCKS &&
    Number.isSafeInteger(bytes) &&
    bytes > (blocks - 1) * L.MEDIA_BLOCK_BYTES &&
    bytes <= blocks * L.MEDIA_BLOCK_BYTES &&
    isKey(sha256) &&
    int(1, L.MAX_MEDIA_DIMENSION)(width) &&
    int(1, L.MAX_MEDIA_DIMENSION)(height)
}

// profile.set `avatar`: same rules as validAvatar in @varanda/core lib/records.js.
function isAvatar (v) {
  return isDescriptor(v) &&
    L.AVATAR_MIMES.includes(v.mime) &&
    v.width === L.AVATAR_SIDE &&
    v.height === L.AVATAR_SIDE &&
    v.blocks <= L.MAX_AVATAR_BLOCKS &&
    v.bytes <= L.MAX_AVATAR_BYTES
}

// By index, never every(): a hole in a sparse array is undefined and invalid.
function isMediaList (v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > L.MAX_MEDIA_PER_POST) return false
  for (let i = 0; i < v.length; i++) {
    if (!isDescriptor(v[i])) return false
  }
  return true
}

// With media the text may be empty (a photo-only post); without, 1..MAX_TEXT.
function postCross (given, value) {
  if (!hasOwn(value, 'media') && charLength(value.text) < 1) return 'parâmetro inválido: text'
  return null
}

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

// terms.sign (docs/rpc.md 5.29). Duplicated from @varanda/core lib/terms.js
// (VERSION_MAX), which this package cannot import.
const TERMS_VERSION_MAX = 9999

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
  // the whole account (no quote); present = a report of that post, quoting
  // its text (empty for a photo-only post).
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
      return null
    }
  },
  // Signs the terms-acceptance statement with the identity key; the node
  // fills in member and association itself, so a caller never chooses the
  // bytes.
  'terms.sign': {
    fields: {
      nonce: req(isNonce),
      version: req(int(1, TERMS_VERSION_MAX))
    }
  },
  'profile.set': {
    // No fallback: an absent avatar keeps the newest own one (docs/rpc.md 5.6).
    fields: {
      name: req(str(1, L.MAX_NAME)),
      bio: opt(str(0, L.MAX_BIO), ''),
      avatar: opt((v) => v === null || isAvatar(v))
    },
    mutating: true
  },
  'post.create': {
    fields: { text: req(str(0, L.MAX_TEXT)), media: opt(isMediaList) },
    mutating: true,
    cross: postCross
  },
  'post.reply': {
    fields: { to: req((v) => isRef(v, 1)), text: req(str(0, L.MAX_TEXT)), media: opt(isMediaList) },
    mutating: true,
    cross: postCross
  },
  'post.quote': {
    fields: { to: req((v) => isRef(v, 1)), text: req(str(1, L.MAX_TEXT)), media: opt(isMediaList) },
    mutating: true
  },
  'like.set': { fields: { to: req((v) => isRef(v, 1)), on: req(isBool) }, mutating: true },
  'repost.set': { fields: { to: req((v) => isRef(v, 1)), on: req(isBool) }, mutating: true },
  'engagement.read': { fields: { refs: req(isRefList) } },
  'diary.peek': {
    fields: {
      author: req(isKey),
      seqs: req(isPeekSeqs),
      profileSeq: opt(int(1, Number.MAX_SAFE_INTEGER)),
      usernameSeq: opt(int(1, Number.MAX_SAFE_INTEGER))
    }
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
      limit: opt(int(1, L.LOG_LIMIT_MAX), L.LOG_LIMIT_DEFAULT),
      // Exclusive block-seq bound; absent = the newest page.
      before: opt(int(1, Number.MAX_SAFE_INTEGER))
    }
  },
  'feed.read': {
    fields: {
      limit: opt(int(1, L.FEED_LIMIT_MAX), L.FEED_LIMIT_DEFAULT),
      // Exclusive feed-order cursor; absent = the newest page.
      before: opt(isFeedCursor)
    }
  },
  // Names of the given authors from local data only (docs/rpc.md 5.21).
  'profile.read': { fields: { authors: req(isKeyList) } },
  // Espiadinha page: diaries the person does not follow (docs/rpc.md 5.22).
  'peek.read': {
    fields: {
      limit: opt(int(1, L.PEEK_LIMIT_MAX), L.PEEK_LIMIT_DEFAULT),
      // Exclusive peek-order cursor; absent = the first page (rebuilds the snapshot).
      after: opt(isPeekCursor)
    }
  },
  // People who follow the caller and whom the caller does not follow yet, plus
  // the replies, quotes and mentions that name the caller.
  // Success: { notices: [{ kind: 'follow' | 'reply' | 'quote' | 'mention',
  // key: hex64, seq: integer >= 1, at: ISO, name: string|null,
  // username: string|null, seen: hex32, avatar: AvatarDescriptor|null }],
  // next: null | { at, key } | { at, key, seq }, incomplete: boolean,
  // supported: boolean, activity: boolean }.
  // No count or total.
  // kind is absent on a notice of a node that predates it, and means 'follow'.
  // name and avatar come from the author's profile and username is their
  // verified username, for every kind;
  // seq is the block of their signed follow record; for a non-follow kind,
  // key:seq is the author's signed POST block that replied to, quoted or
  // mentioned the caller. seen is an opaque token, stable per identity, keyed
  // by the identity secret and unlinkable to the follower without it (what the
  // app stores as seen); one row per block. next is the next-page cursor; it
  // carries seq whenever the read went over the notices channel v2.
  // incomplete means the seeder's index or the read's budget was not complete;
  // supported is false when the seeder does not speak the notices channel;
  // activity is false only when the rows came over the follows-only channel
  // v1 because the seeder does not speak v2; every other result says true.
  // Hosted web only: the core node answers USAGE 'avisos disponíveis só no navegador'
  // (docs/rpc.md 5.28).
  'notices.list': {
    fields: {
      limit: opt(int(1, L.NOTICES_LIMIT_MAX), L.NOTICES_LIMIT_DEFAULT),
      after: opt(isNoticesCursor)
    }
  },
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
