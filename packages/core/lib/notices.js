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
// Share of the global quota: maxPerAuthor (4096) is 1/64 of maxEdges
// (262144), so one author holds at most 1/64 of the index. Past its first
// lightTargets (256) entries an author is heavy, and a heavy author takes a
// new target only while more than maxEdges / NOTICES_RESERVE_DIVISOR (1/4)
// of the index is free. Heavy authors together therefore fill at most 3/4
// of it; the last quarter only takes each author's first 256 targets, so a
// group of diaries following thousands of members cannot leave an ordinary
// member's follows out. A refusal at either rule is a truncation like the
// caps above.
//
// Fail closed while pending: markPending unpublishes the author's edges
// until its next commit. A diary that grew past what the seeder holds may
// hide an unfollow behind a block it withholds; its last committed follow
// must not keep a stale "começou a seguir você" alive meanwhile.
//
// Incomplete per target: a page (or a followers list) of target T is
// incomplete when a pending author has never committed since its last
// removeAuthor (nothing is known of whom it follows, so it counts for every
// target), when a pending author that committed before has a fold entry for
// T (on or off, committed or folded so far in the current scan), or when an
// author lost a follow of T at a cap. So a diary stopped mid-download on
// its first scan (a fresh serve, a restart) keeps every page incomplete, as
// before; one stopped on a later scan (it grew past the blocks the seeder
// holds, the common case for an active diary) marks only the targets it is
// known to touch, whose edges it unpublished. A follow of T in blocks such
// a diary has not reached yet arrives late, never as a false notice. Each
// truncated author remembers at most MAX_CUT_TARGETS_PER_AUTHOR
// targets it lost a follow of; one that loses more marks every page
// incomplete until removeAuthor, as before this rule.
// Public follows: by owner decision, follower counts and lists are public.
// followsPage and followCounts serve who follows an account and whom it
// follows, from committed state only. The proof-gated notices channel
// (page, rowsFor, notices-net) is unchanged and still returns no tally.
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
const NOTICES_LIGHT_TARGETS = 256
const NOTICES_RESERVE_DIVISOR = 4
const MAX_CUT_TARGETS_PER_AUTHOR = 64
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

function createNoticeIndex ({ maxPerAuthor = MAX_FOLLOW_TARGETS_PER_AUTHOR, maxEdges = NOTICES_MAX_EDGES, lightTargets = Math.min(NOTICES_LIGHT_TARGETS, maxPerAuthor), isMember = () => true } = {}) {
  if (!Number.isSafeInteger(maxPerAuthor) || maxPerAuthor < 0) throw new TypeError('invalid maxPerAuthor')
  if (!Number.isSafeInteger(maxEdges) || maxEdges < 0) throw new TypeError('invalid maxEdges')
  if (!Number.isSafeInteger(lightTargets) || lightTargets < 0) throw new TypeError('invalid lightTargets')
  if (typeof isMember !== 'function') throw new TypeError('invalid isMember')
  const reserve = Math.floor(maxEdges / NOTICES_RESERVE_DIVISOR)

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
  // Authors committed at least once since their last removeAuthor.
  const committed = new Set()
  const truncated = new Set()
  // author -> number of non-member targets stored in its fold.
  const nonMembers = new Map()
  // Authors whose fold skipped a non-member target at the cap, and the same
  // set as of each author's last commit (what followsPage reads).
  const foldCapped = new Set()
  const capped = new Set()
  // author -> Set of targets it lost an on: true follow of at a cap, at most
  // MAX_CUT_TARGETS_PER_AUTHOR; target -> Set of those authors; authors that
  // lost more (every page is incomplete while one is indexed).
  const cutBy = new Map()
  const cutOf = new Map()
  const cutWide = new Set()
  // Exact number of fold entries over all authors (private: never returned).
  let edges = 0

  return { markPending, foldFollow, commit, removeAuthor, page, rowsFor, followsPage, followCounts, followSeq, followTargets }

  function markPending (authorHex) {
    if (!isHex64(authorHex)) return
    pending.add(authorHex)
    unpublish(authorHex)
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
    if (!member && outsiders >= MAX_NONMEMBER_TARGETS_PER_AUTHOR) {
      // Only a follow lost here can make the author's list miss someone.
      if (on === true) foldCapped.add(authorHex)
      return
    }
    // Bounded during the scan, not only after it: a new target is refused
    // once either cap is reached, and the author's notices are incomplete.
    const size = fold ? fold.size : 0
    if (size >= maxPerAuthor || edges >= maxEdges || (size >= lightTargets && maxEdges - edges <= reserve)) {
      truncated.add(authorHex)
      if (on === true) noteCut(authorHex, target)
      return
    }
    if (!member) nonMembers.set(authorHex, outsiders + 1)
    if (!fold) {
      fold = new Map()
      folds.set(authorHex, fold)
    }
    fold.set(target, { seq, at, on })
    edges++
    // The fold now holds this target's latest record: no longer a loss.
    dropCut(authorHex, target)
  }

  function noteCut (authorHex, target) {
    if (cutWide.has(authorHex)) return
    let targets = cutBy.get(authorHex)
    if (targets && targets.has(target)) return
    if (targets && targets.size >= MAX_CUT_TARGETS_PER_AUTHOR) {
      cutWide.add(authorHex)
      return
    }
    if (!targets) {
      targets = new Set()
      cutBy.set(authorHex, targets)
    }
    targets.add(target)
    let authors = cutOf.get(target)
    if (!authors) {
      authors = new Set()
      cutOf.set(target, authors)
    }
    authors.add(authorHex)
  }

  function dropCut (authorHex, target) {
    const targets = cutBy.get(authorHex)
    if (!targets || !targets.delete(target)) return
    if (targets.size === 0) cutBy.delete(authorHex)
    const authors = cutOf.get(target)
    if (!authors) return
    authors.delete(authorHex)
    if (authors.size === 0) cutOf.delete(target)
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
    if (foldCapped.has(authorHex)) capped.add(authorHex)
    else capped.delete(authorHex)
    pending.delete(authorHex)
    committed.add(authorHex)
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
    foldCapped.delete(authorHex)
    capped.delete(authorHex)
    pending.delete(authorHex)
    committed.delete(authorHex)
    truncated.delete(authorHex)
    for (const target of [...(cutBy.get(authorHex) || [])]) dropCut(authorHex, target)
    cutWide.delete(authorHex)
  }

  // Whether target's followers may be missing a row (see the header): a
  // pending author never committed, a pending author whose fold touches it,
  // or a follow of it lost at a cap. O(pending authors), bounded by the
  // seeder's served-diary limit.
  function targetIncomplete (target) {
    if (cutWide.size > 0 || cutOf.has(target)) return true
    for (const author of pending) {
      if (!committed.has(author)) return true
      const fold = folds.get(author)
      if (fold && fold.has(target)) return true
    }
    return false
  }

  // -> { items: [{ key, seq, at }], next: null | { at, key }, incomplete }.
  function page ({ target, isBlocked, after = null, limit } = {}) {
    const incomplete = isHex64(target) && targetIncomplete(target)
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

  // -> { rows: [{ key, seq, at }], incomplete }: every published follow of
  // target in no particular order. The v2 merge needs the whole set at once
  // because its cursor carries three keys, which compareRows cannot order.
  function rowsFor (target, isBlocked) {
    const incomplete = isHex64(target) && targetIncomplete(target)
    const rows = []
    const followers = isHex64(target) ? published.get(target) : undefined
    if (!followers) return { rows, incomplete }
    for (const [key, e] of followers) {
      if (skip(key, target, isBlocked)) continue
      rows.push({ key, seq: e.seq, at: e.at })
    }
    return { rows, incomplete }
  }

  // Per target, as page(): truncated is not read directly, because commit
  // never clears it and every list would stay incomplete forever; the
  // follows it lost are in cutOf (or cutWide).
  function followersIncomplete (author) {
    return targetIncomplete(author)
  }

  function followingIncomplete (author) {
    return pending.has(author) || truncated.has(author) || capped.has(author)
  }

  // -> [{ key, seq, at }] of committed follows, before the omit rule.
  function followRows (author, kind) {
    const rows = []
    if (kind === 'seguidores') {
      const followers = published.get(author)
      if (!followers) return rows
      for (const [key, e] of followers) rows.push({ key, seq: e.seq, at: e.at })
    } else {
      const targets = publishedBy.get(author)
      if (!targets) return rows
      for (const target of targets) {
        const followers = published.get(target)
        const e = followers && followers.get(author)
        if (e) rows.push({ key: target, seq: e.seq, at: e.at })
      }
    }
    return rows
  }

  // -> { items: [{ key, seq, at }], next: null | { atMs, key }, total,
  // incomplete }. Public: committed state only, never folds.
  function followsPage ({ author, kind, after = null, limit, visible, now } = {}) {
    let incomplete = false
    if (isHex64(author)) {
      if (kind === 'seguidores') incomplete = followersIncomplete(author)
      else if (kind === 'seguindo') incomplete = followingIncomplete(author)
    }
    const empty = { items: [], next: null, total: 0, incomplete }
    if (!isHex64(author) || (kind !== 'seguidores' && kind !== 'seguindo') || typeof visible !== 'function') return empty
    let cursor = null
    if (after !== null) {
      cursor = readFollowsCursor(after)
      if (cursor === null) return empty
    }
    const n = clampLimit(limit)
    const rows = []
    for (const row of followRows(author, kind)) {
      if (!keep(row.key, author, visible)) continue
      // Clamped like the cursor, so a pre-1970 row can never sort after a
      // cursor that points at it and loop the pages forever.
      rows.push({ t: Math.max(0, Date.parse(row.at) || 0), ...row })
    }
    rows.sort(compareRows)
    const items = []
    let more = false
    for (const row of rows) {
      if (cursor !== null && compareRows(row, cursor) <= 0) continue
      if (items.length === n) {
        more = true
        break
      }
      items.push(row)
    }
    const last = items[items.length - 1]
    const next = more ? { atMs: last.t, key: last.key } : null
    return {
      items: items.map((r) => ({ key: r.key, seq: r.seq, at: r.at })),
      next,
      total: rows.length,
      incomplete
    }
  }

  // -> the seq of `author`'s committed live follow of `target`, or null (no
  // follow, an unfollow committed, a self-follow, a removed author, a fold
  // not committed yet). Recados evidence: the node peeks that block itself.
  function followSeq (author, target) {
    if (!isHex64(author) || !isHex64(target) || author === target) return null
    const followers = published.get(target)
    const e = followers && followers.get(author)
    return e ? e.seq : null
  }

  // -> [target] of `author`'s committed live follows (at most maxPerAuthor),
  // a fresh array. Recados walk only these writers under 'following'.
  function followTargets (author) {
    if (!isHex64(author)) return []
    const targets = publishedBy.get(author)
    return targets ? [...targets] : []
  }

  // -> { seguindo, seguidores, incomplete } under followsPage's omit rule.
  function followCounts (author, visible) {
    if (!isHex64(author) || typeof visible !== 'function') return { seguindo: 0, seguidores: 0, incomplete: false }
    let seguindo = 0
    let seguidores = 0
    for (const row of followRows(author, 'seguindo')) if (keep(row.key, author, visible)) seguindo++
    for (const row of followRows(author, 'seguidores')) if (keep(row.key, author, visible)) seguidores++
    return { seguindo, seguidores, incomplete: followersIncomplete(author) || followingIncomplete(author) }
  }
}

// visible is a KEEP predicate (true shows the row), the opposite of skip()'s
// isBlocked. The author is never listed; a throwing visible hides the row.
function keep (key, author, visible) {
  if (key === author) return false
  try {
    return visible(key) === true
  } catch {
    return false
  }
}

// -> { t, key } | null for a valid { t, key } follows cursor.
function readFollowsCursor (after) {
  try {
    if (!isPlainObject(after) || !hasExactKeys(after, ['t', 'key'])) return null
    const t = after.t
    const key = after.key
    if (!Number.isSafeInteger(t) || t < 0 || !isHex64(key)) return null
    return { t, key }
  } catch {
    return null
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
  NOTICES_LIGHT_TARGETS,
  NOTICES_RESERVE_DIVISOR,
  MAX_CUT_TARGETS_PER_AUTHOR,
  MAX_NOTICES_MESSAGE,
  NOTICES_PROTOCOL,
  NOTICE_PROOF_PREFIX,
  createNoticeIndex,
  noticePayload,
  signNoticeProof,
  verifyNoticeProof,
  validateNoticesMessage
}
