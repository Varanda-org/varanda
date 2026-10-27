'use strict'

// Follow notices ("@b começou a seguir você · Seguir de volta"): the building
// blocks the seeder and the browser node share (docs/protocol.md, Notices
// channel (varanda/notices/1)).
//
// Trust model: the seeder holds every diary it serves, so it can answer "who
// follows me" by folding the signed `follow` records it already stores. That
// answer is private to the followed member: the seeder only serves the
// followers of the diary key the connection PROVED it owns (an Ed25519
// signature by the diary key over a fresh nonce and the connection's Noise
// key, so a proof can neither be replayed on another connection nor relayed
// by a man in the middle). The seeder is not trusted for the facts
// themselves: the browser re-verifies each notice against the signed block
// (key, seq) before showing it, and a seeder that lies only shows less.
//
// The index (createNoticeIndex) is in memory and bounded while it is being
// built: each author's fold holds at most maxPerAuthor targets and the whole
// index at most maxEdges fold entries; anything beyond is skipped and marks
// the author truncated, so pages say `incomplete` instead of growing memory.
// A fold is invisible to pages until commit() publishes it, so a half-scanned
// diary never shows a follow its later unfollow would cancel.
//
// Member predicate: a follow of a key that isMember says is not a member is
// nobody's notice, yet it would take index capacity. Each author may store at
// most MAX_NONMEMBER_TARGETS_PER_AUTHOR such targets; further ones are
// skipped WITHOUT marking the author truncated, so a handful of diaries
// following random keys can neither exhaust maxEdges for everyone nor make
// every page incomplete forever.
//
// Privacy rule: nothing here returns a follower count, total, size or length;
// pages are cursors over followers, never tallies.
//
// Browser-safe: b4a, hypercore-crypto and ./records only (no hypercore,
// hyperswarm, corestore, node: builtins or `crypto`, which the web bundle
// stubs to throw).
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { isHex64, isCanonicalIso } = require('./records')

const NOTICES_LIMIT_DEFAULT = 30
const NOTICES_LIMIT_MAX = 64
const MAX_FOLLOW_TARGETS_PER_AUTHOR = 4096
const NOTICES_MAX_EDGES = 262144
const MAX_NONMEMBER_TARGETS_PER_AUTHOR = 64
const MAX_NOTICES_MESSAGE = 16384
const NOTICES_PROTOCOL = 'varanda/notices/1'
const NOTICE_PROOF_PREFIX = 'varanda-notices-v1\n'

const HEX128 = /^[0-9a-f]{128}$/

function isHex128 (s) {
  return typeof s === 'string' && HEX128.test(s)
}

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  if (own.length !== keys.length) return false
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false
  }
  return true
}

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

// Page order: newest first by Date.parse (string order breaks for negative
// or extended-year ISO dates, feed.js), then key ascending.
function compareRows (a, b) {
  return (b.t - a.t) || cmp(a.key, b.key)
}

function clampLimit (limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return NOTICES_LIMIT_DEFAULT
  return Math.min(NOTICES_LIMIT_MAX, Math.max(1, Math.floor(limit)))
}

// -> { t, key } | null for a valid { at, key } cursor.
function readCursor (after) {
  try {
    if (!isPlainObject(after)) return null
    const at = after.at
    const key = after.key
    if (!isCanonicalIso(at) || !isHex64(key)) return null
    return { t: Date.parse(at), key }
  } catch {
    return null
  }
}

function createNoticeIndex ({ maxPerAuthor = MAX_FOLLOW_TARGETS_PER_AUTHOR, maxEdges = NOTICES_MAX_EDGES, isMember = () => true } = {}) {
  if (!Number.isSafeInteger(maxPerAuthor) || maxPerAuthor < 0) throw new TypeError('invalid maxPerAuthor')
  if (!Number.isSafeInteger(maxEdges) || maxEdges < 0) throw new TypeError('invalid maxEdges')
  if (typeof isMember !== 'function') throw new TypeError('invalid isMember')

  // author -> Map target -> { seq, at, on }: the fold being built.
  const folds = new Map()
  // author -> highest seq ever passed to foldFollow (stored OR refused at a
  // cap). Ordering is an API guarantee: the seeder scans a diary in
  // ascending seq, and a re-serve calls removeAuthor first. A record at or
  // below this mark is ignored, so a target refused at the cap cannot be
  // resurrected by an older record once capacity frees up.
  const lastSeq = new Map()
  // target -> Map author -> { seq, at }: what pages read (follows only).
  const published = new Map()
  // author -> Set of targets it has published edges to (for replacement).
  const publishedBy = new Map()
  const pending = new Set()
  const truncated = new Set()
  // author -> number of non-member targets stored in its fold.
  const nonMembers = new Map()
  // Exact number of fold entries over all authors (private: never returned).
  let edges = 0

  return { markPending, foldFollow, commit, removeAuthor, page }

  function markPending (authorHex) {
    if (!isHex64(authorHex)) return
    pending.add(authorHex)
  }

  function foldFollow (authorHex, seq, record) {
    let target, on, at
    try {
      if (!isHex64(authorHex) || !Number.isSafeInteger(seq) || seq < 1) return
      if (!isPlainObject(record) || record.type !== 'follow') return
      target = record.key
      on = record.on
      at = record.at
      if (!isHex64(target) || typeof on !== 'boolean' || !isCanonicalIso(at)) return
    } catch {
      return
    }
    // Last seq wins: anything at or below the author's high-water mark is
    // stale, whether its target was stored, refused or never seen.
    const high = lastSeq.get(authorHex)
    if (high !== undefined && seq <= high) return
    lastSeq.set(authorHex, seq)
    if (target === authorHex) return // a self-follow is never a notice

    let fold = folds.get(authorHex)
    if (fold && fold.has(target)) {
      fold.set(target, { seq, at, on })
      return
    }
    // A non-member target is nobody's notice: at most
    // MAX_NONMEMBER_TARGETS_PER_AUTHOR per author, and skipping one never
    // marks the author truncated. A throwing isMember means not a member.
    let member
    try {
      member = isMember(target) === true
    } catch {
      member = false
    }
    const outsiders = nonMembers.get(authorHex) || 0
    if (!member && outsiders >= MAX_NONMEMBER_TARGETS_PER_AUTHOR) return
    // Bounded during the scan, not only after it: a new target is refused
    // once either cap is reached, and the author's notices are incomplete.
    if ((fold ? fold.size : 0) >= maxPerAuthor || edges >= maxEdges) {
      truncated.add(authorHex)
      return
    }
    if (!member) nonMembers.set(authorHex, outsiders + 1)
    if (!fold) {
      fold = new Map()
      folds.set(authorHex, fold)
    }
    fold.set(target, { seq, at, on })
    edges++
  }

  function unpublish (authorHex) {
    const targets = publishedBy.get(authorHex)
    if (!targets) return
    for (const target of targets) {
      const followers = published.get(target)
      if (!followers) continue
      followers.delete(authorHex)
      if (followers.size === 0) published.delete(target)
    }
    publishedBy.delete(authorHex)
  }

  function commit (authorHex) {
    if (!isHex64(authorHex)) return
    unpublish(authorHex)
    const fold = folds.get(authorHex)
    if (fold) {
      const targets = new Set()
      for (const [target, e] of fold) {
        if (e.on !== true) continue
        let followers = published.get(target)
        if (!followers) {
          followers = new Map()
          published.set(target, followers)
        }
        followers.set(authorHex, { seq: e.seq, at: e.at })
        targets.add(target)
      }
      if (targets.size > 0) publishedBy.set(authorHex, targets)
    }
    pending.delete(authorHex)
  }

  function removeAuthor (authorHex) {
    if (!isHex64(authorHex)) return
    unpublish(authorHex)
    const fold = folds.get(authorHex)
    if (fold) {
      edges -= fold.size
      folds.delete(authorHex)
    }
    lastSeq.delete(authorHex)
    nonMembers.delete(authorHex)
    pending.delete(authorHex)
    truncated.delete(authorHex)
  }

  // -> { items: [{ key, seq, at }], next: null | { at, key }, incomplete }.
  function page ({ target, isBlocked, after = null, limit } = {}) {
    const incomplete = truncated.size > 0 || pending.size > 0
    const n = clampLimit(limit)
    const followers = isHex64(target) ? published.get(target) : undefined
    if (!followers) return { items: [], next: null, incomplete }
    const cursor = readCursor(after)
    const rows = []
    for (const [key, e] of followers) {
      const t = Date.parse(e.at)
      // Exclusive cursor: keep only rows strictly later in page order.
      if (cursor !== null && compareRows({ t, key }, cursor) <= 0) continue
      rows.push({ t, key, seq: e.seq, at: e.at })
    }
    rows.sort(compareRows)
    const items = []
    let more = false
    for (const row of rows) {
      if (skip(row.key, target, isBlocked)) continue // skipped rows never stall the cursor
      if (items.length === n) {
        more = true
        break
      }
      items.push({ key: row.key, seq: row.seq, at: row.at })
    }
    const last = items[items.length - 1]
    const next = more ? { at: last.at, key: last.key } : null
    return { items, next, incomplete }
  }
}

// A row is never shown for the target itself, nor for a blocked key; a
// throwing isBlocked hides the row (fail closed).
function skip (key, target, isBlocked) {
  if (key === target) return true
  if (typeof isBlocked !== 'function') return false
  try {
    return Boolean(isBlocked(key))
  } catch {
    return true
  }
}

// What the member signs: domain prefix, the seeder's nonce, the member's own
// Noise public key as the seeder sees it (binds the proof to this
// connection) and the diary key being proved.
function noticePayload (nonceHex, noiseHex, ownHex) {
  return b4a.from(NOTICE_PROOF_PREFIX + nonceHex + '\n' + noiseHex + '\n' + ownHex, 'utf8')
}

// -> 64-byte Ed25519 signature by keyPair.secretKey.
function signNoticeProof (payload, keyPair) {
  return hcrypto.sign(payload, keyPair.secretKey)
}

// The diary key IS the Ed25519 public key for browser members, so the proof
// verifies against `key` itself. Never throws.
function verifyNoticeProof (fields, sigHex) {
  try {
    if (fields === null || typeof fields !== 'object') return false
    const nonce = fields.nonce
    const noise = fields.noise
    const key = fields.key
    if (!isHex64(nonce) || !isHex64(noise) || !isHex64(key) || !isHex128(sigHex)) return false
    return hcrypto.verify(noticePayload(nonce, noise, key), b4a.from(sigHex, 'hex'), b4a.from(key, 'hex')) === true
  } catch {
    return false
  }
}

function validCursor (c) {
  if (c === null) return true
  return isPlainObject(c) && hasExactKeys(c, ['at', 'key']) && isCanonicalIso(c.at) && isHex64(c.key)
}

function validLimit (n) {
  return Number.isSafeInteger(n) && n >= 1 && n <= NOTICES_LIMIT_MAX
}

function validItem (it) {
  return isPlainObject(it) && hasExactKeys(it, ['key', 'seq', 'at']) &&
    isHex64(it.key) && Number.isSafeInteger(it.seq) && it.seq >= 1 && isCanonicalIso(it.at)
}

// Exact keys and lower-case hex for every message of the channel. Never
// throws on hostile input (getters, proxies, odd prototypes).
function validateNoticesMessage (msg) {
  try {
    if (!isPlainObject(msg)) return false
    switch (msg.type) {
      case 'challenge':
        return hasExactKeys(msg, ['type', 'nonce']) && isHex64(msg.nonce)
      case 'proof':
        return hasExactKeys(msg, ['type', 'key', 'sig']) && isHex64(msg.key) && isHex128(msg.sig)
      case 'page':
        return hasExactKeys(msg, ['type', 'after', 'limit']) && validCursor(msg.after) && validLimit(msg.limit)
      case 'items': {
        if (!hasExactKeys(msg, ['type', 'items', 'next', 'incomplete'])) return false
        const items = msg.items
        if (!Array.isArray(items) || items.length > NOTICES_LIMIT_MAX) return false
        for (let i = 0; i < items.length; i++) {
          if (!validItem(items[i])) return false
        }
        return validCursor(msg.next) && typeof msg.incomplete === 'boolean'
      }
      default:
        return false
    }
  } catch {
    return false
  }
}

module.exports = {
  NOTICES_LIMIT_DEFAULT,
  NOTICES_LIMIT_MAX,
  MAX_FOLLOW_TARGETS_PER_AUTHOR,
  NOTICES_MAX_EDGES,
  MAX_NONMEMBER_TARGETS_PER_AUTHOR,
  MAX_NOTICES_MESSAGE,
  NOTICES_PROTOCOL,
  NOTICE_PROOF_PREFIX,
  createNoticeIndex,
  noticePayload,
  signNoticeProof,
  verifyNoticeProof,
  validateNoticesMessage
}
