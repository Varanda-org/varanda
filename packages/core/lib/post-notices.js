'use strict'

// Post notices ("@b respondeu", "@b citou", "@b mencionou você"): the
// in-memory index the seeder folds from the posts and username records of
// the diaries it serves, paged on the varanda/notices/2 channel together with
// the follow rows of notices.js.
//
// Trust model: a row is only a candidate. The seeder names (key, seq) and the
// browser re-reads that signed block from its own copy of the author's diary
// before showing anything, so a seeder that lies only shows less. Names are
// checked here once per candidate record (verifyUsername) so a mention of a
// name nobody verifiably holds never reaches a page.
//
// Privacy rule: like notices.js, nothing returns a count, total, size or
// length; pages are cursors. Rows are served only for the key the
// connection proved it owns (notices-net.js).
//
// Memory bound: separate from createNoticeIndex on purpose, so a mention
// spammer can neither exhaust the follow index's edges nor mark follow pages
// incomplete. Per author and target key (or name token) the newest
// MAX_POST_NOTICES_PER_PAIR rows survive; per author the newest
// MAX_POST_NOTICES_PER_AUTHOR. Both evict the author's own lowest seq and are
// not incompleteness: they only forget old notices of one noisy author. The
// global cap is different: it refuses the new row and marks that author
// truncated, never evicting another author's rows. Rows whose target is not
// known to be anyone (a key isMember rejects, a name no verified record
// holds yet) are capped per author and skipped silently beyond it, like the
// non-member follow targets of notices.js. Every author map is bounded by
// maxAuthors. Nothing is persisted.
//
// Refusals are sticky: posts folded while an author was refused at
// maxAuthors are gone (lastSeq is not kept for it), so the author stays in
// the refused set, and pages stay incomplete, even if it is tracked later.
// Only removeAuthor clears it: the seeder re-serves a diary by removeAuthor
// and a fresh fold from seq 1. A refusal the bounded set cannot record sets
// a flag that keeps every page incomplete until the index is rebuilt (the
// seeder builds a new one on restart).
//
// Historical names: a name once held is never given to another member by the
// account service (username.js heldUsernames), so a renamed member keeps
// every verified name of its window and still receives mentions of the old
// one. Mention rows are stored by token, not by owner, so a mention folded
// before the owner's username record is seen resolves once it is settled.
//
// Rows are published at fold: a later block never cancels a post, except a
// tombstone (removePost, docs/protocol.md "Deletion"); only an unfollow
// cancels a follow. Pending only governs `incomplete`.
//
// Browser-safe: ./records, ./username, ./feed, ./notices-v2 and @varanda/rpc
// only.
const { mentionTokens, MENTION_MAX } = require('@varanda/rpc')
const { isHex64, isCanonicalIso } = require('./records')
const { MAX_HELD_USERNAMES } = require('./username')
const { MAX_FUTURE_MS } = require('./feed')
const { NOTICES_LIMIT_DEFAULT, NOTICES_LIMIT_MAX } = require('./notices')
const { NOTICE_KINDS } = require('./notices-v2')

const MAX_POST_NOTICES_PER_PAIR = 32
const MAX_POST_NOTICES_PER_AUTHOR = 1024
const POST_NOTICES_MAX_EDGES = 262144
const MAX_UNRESOLVED_TOKENS_PER_AUTHOR = 64
// The seeder's default maxServed (admission.js MAX_INVENTORY).
const POST_NOTICES_MAX_AUTHORS = 4096

const PRIORITY = { reply: 3, quote: 2, mention: 1 }
const [, KIND_REPLY, KIND_QUOTE, KIND_MENTION] = NOTICE_KINDS
const KIND_FOLLOW = NOTICE_KINDS[0]

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

function isSeq (n) {
  return Number.isSafeInteger(n) && n >= 1
}

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

// Newest first by Date.parse, then key ascending, then seq descending (one
// author may have several notices at the same instant).
function compareRows (a, b) {
  return (b.t - a.t) || cmp(a.key, b.key) || (b.seq - a.seq)
}

function clampLimit (limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return NOTICES_LIMIT_DEFAULT
  return Math.min(NOTICES_LIMIT_MAX, Math.max(1, Math.floor(limit)))
}

// -> { t, key, seq } | null for a valid { at, key, seq } cursor.
function readCursor (after) {
  try {
    if (!isPlainObject(after)) return null
    const at = after.at
    const key = after.key
    const seq = after.seq
    if (!isCanonicalIso(at) || !isHex64(key) || !isSeq(seq)) return null
    return { t: Date.parse(at), key, seq }
  } catch {
    return null
  }
}

function keyPair (hex) {
  return 'k:' + hex
}

function namePair (token) {
  return 'n:' + token
}

function createPostNoticeIndex ({
  isMember = () => true,
  verifyUsername = () => false,
  maxAuthors = POST_NOTICES_MAX_AUTHORS,
  maxPerAuthor = MAX_POST_NOTICES_PER_AUTHOR,
  maxPerPair = MAX_POST_NOTICES_PER_PAIR,
  maxEdges = POST_NOTICES_MAX_EDGES
} = {}) {
  if (typeof isMember !== 'function') throw new TypeError('invalid isMember')
  if (typeof verifyUsername !== 'function') throw new TypeError('invalid verifyUsername')
  for (const [name, v] of [['maxAuthors', maxAuthors], ['maxPerAuthor', maxPerAuthor], ['maxPerPair', maxPerPair], ['maxEdges', maxEdges]]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new TypeError('invalid ' + name)
  }

  // Every author holding any state below; bounded by maxAuthors.
  const tracked = new Set()
  // Authors refused at maxAuthors: their notices are missing, so pages are
  // incomplete until removeAuthor. Bounded the same way; a refusal that
  // cannot be recorded sets overflow, which keeps every page incomplete for
  // the life of the index rather than ever claiming a complete page.
  const refused = new Set()
  let overflow = false
  // author -> highest post seq ever passed to foldPost (stored OR refused),
  // the notices.js rule: a record at or below it is ignored, so a row
  // refused at a cap is never resurrected by an older record.
  const lastSeq = new Map()
  // author -> { posts: Map seq -> { at, edges: Map pair -> { kind } }, count,
  //   loose }. posts is in ascending seq (fold order), so its first key is
  // the lowest seq to evict. loose is the Set of distinct unresolved pairs
  // the author has rows for, at most MAX_UNRESOLVED_TOKENS_PER_AUTHOR.
  const authors = new Map()
  // pair -> Map author -> Set seq (ascending): what pages read.
  const byPair = new Map()
  // author -> Map seq -> { record, ok: null | boolean }: the newest
  // MAX_HELD_USERNAMES own username records, verified or not, the window of
  // username.js heldUsernames. ok is null until settle verifies it once.
  const windows = new Map()
  // author -> Map username -> { issuer, seq }: derived from the window only,
  // so it is the same whether settle runs after each record or once.
  const names = new Map()
  // username -> Set of authors holding it verifiably.
  const owners = new Map()
  const pending = new Set()
  const truncated = new Set()
  // Exact number of stored rows over all authors (private: never returned).
  let edges = 0

  return { markPending, settle, removeAuthor, foldPost, foldUsername, removePost, pageV2 }

  function admit (authorHex) {
    if (tracked.has(authorHex)) return true
    if (tracked.size >= maxAuthors) {
      if (refused.has(authorHex)) return false
      if (refused.size < maxAuthors) refused.add(authorHex)
      else overflow = true
      return false
    }
    tracked.add(authorHex)
    return true
  }

  function markPending (authorHex) {
    if (!isHex64(authorHex) || !admit(authorHex)) return
    pending.add(authorHex)
  }

  function foldPost (authorHex, seq, record) {
    let at, text, replyAuthor, quoteAuthor
    try {
      if (!isHex64(authorHex) || !isSeq(seq)) return
      if (!isPlainObject(record) || record.type !== 'post') return
      at = record.at
      text = record.text
      if (!isCanonicalIso(at) || typeof text !== 'string') return
      const replyTo = record.replyTo
      const quote = record.quote
      replyAuthor = isPlainObject(replyTo) ? replyTo.author : null
      quoteAuthor = isPlainObject(quote) ? quote.author : null
    } catch {
      return
    }
    if (!admit(authorHex)) return
    const high = lastSeq.get(authorHex)
    if (high !== undefined && seq <= high) return
    lastSeq.set(authorHex, seq)

    const wanted = []
    if (isHex64(replyAuthor) && replyAuthor !== authorHex) wanted.push({ pair: keyPair(replyAuthor), kind: KIND_REPLY, loose: !member(replyAuthor) })
    if (isHex64(quoteAuthor) && quoteAuthor !== authorHex && quoteAuthor !== replyAuthor) {
      wanted.push({ pair: keyPair(quoteAuthor), kind: KIND_QUOTE, loose: !member(quoteAuthor) })
    }
    let tokens = []
    try {
      tokens = mentionTokens(text, MENTION_MAX)
    } catch {}
    const own = names.get(authorHex)
    for (const token of tokens) {
      // A self-mention is nobody's notice and must not take capacity.
      if (own && own.has(token)) continue
      wanted.push({ pair: namePair(token), kind: KIND_MENTION, loose: !owners.has(token) })
    }
    for (const w of wanted) store(authorHex, seq, at, w)
  }

  // A throwing isMember means not a member.
  function member (hex) {
    try {
      return isMember(hex) === true
    } catch {
      return false
    }
  }

  function store (authorHex, seq, at, { pair, kind, loose }) {
    if (maxPerPair === 0 || maxPerAuthor === 0) return
    let state = authors.get(authorHex)
    if (loose && state && !admitLoose(authorHex, state, pair)) return
    let bucket = byPair.get(pair)
    const seqs = bucket ? bucket.get(authorHex) : undefined
    if (seqs && seqs.size >= maxPerPair) {
      evict(authorHex, seqs.values().next().value, pair)
    } else if (state && state.count >= maxPerAuthor) {
      // A post is evicted whole, so it is never half a notice; one post
      // alone over the ceiling just skips its extra rows.
      if (state.posts.keys().next().value === seq) return
      evictLowest(authorHex)
    } else if (edges >= maxEdges) {
      truncated.add(authorHex)
      return
    }
    state = authors.get(authorHex)
    if (!state) {
      state = { posts: new Map(), count: 0, loose: new Set() }
      authors.set(authorHex, state)
    }
    let post = state.posts.get(seq)
    if (!post) {
      post = { at, edges: new Map() }
      state.posts.set(seq, post)
    }
    post.edges.set(pair, { kind })
    state.count++
    if (loose) state.loose.add(pair)
    edges++
    bucket = byPair.get(pair)
    if (!bucket) {
      bucket = new Map()
      byPair.set(pair, bucket)
    }
    let set = bucket.get(authorHex)
    if (!set) {
      set = new Set()
      bucket.set(authorHex, set)
    }
    set.add(seq)
  }

  // The quota counts distinct targets, not rows, so a pair already admitted
  // keeps rotating through the per-pair cap. Pairs that resolved since, or
  // lost their last row, are pruned lazily to free the quota.
  function admitLoose (authorHex, state, pair) {
    const loose = state.loose
    if (loose.has(pair) || loose.size < MAX_UNRESOLVED_TOKENS_PER_AUTHOR) return true
    for (const p of [...loose]) {
      const bucket = byPair.get(p)
      if (!bucket || !bucket.has(authorHex) || resolved(p)) loose.delete(p)
    }
    return loose.size < MAX_UNRESOLVED_TOKENS_PER_AUTHOR
  }

  function resolved (pair) {
    return pair.startsWith('k:') ? member(pair.slice(2)) : owners.has(pair.slice(2))
  }

  function evictLowest (authorHex) {
    const state = authors.get(authorHex)
    if (!state) return
    const first = state.posts.entries().next().value
    if (!first) return
    const [seq, post] = first
    for (const pair of [...post.edges.keys()]) evict(authorHex, seq, pair)
  }

  // A deleted post (the seeder's tombstone handling) leaves every page.
  // lastSeq stays, so the post is never folded again.
  function removePost (authorHex, seq) {
    const state = authors.get(authorHex)
    const post = state ? state.posts.get(seq) : undefined
    if (!post) return
    for (const pair of [...post.edges.keys()]) evict(authorHex, seq, pair)
  }

  function evict (authorHex, seq, pair) {
    const state = authors.get(authorHex)
    const post = state ? state.posts.get(seq) : undefined
    const edge = post ? post.edges.get(pair) : undefined
    if (!edge) return
    post.edges.delete(pair)
    if (post.edges.size === 0) state.posts.delete(seq)
    state.count--
    edges--
    if (state.count === 0) authors.delete(authorHex)
    const bucket = byPair.get(pair)
    const set = bucket ? bucket.get(authorHex) : undefined
    if (!set) return
    set.delete(seq)
    if (set.size === 0) {
      bucket.delete(authorHex)
      state.loose.delete(pair)
    }
    if (bucket.size === 0) byPair.delete(pair)
  }

  function foldUsername (authorHex, seq, record) {
    let copy
    try {
      if (!isHex64(authorHex) || !isSeq(seq)) return
      if (!isPlainObject(record) || record.type !== 'username') return
      // A copied record naming another member is never a candidate.
      if (record.member !== authorHex || typeof record.username !== 'string') return
      copy = { ...record }
    } catch {
      return
    }
    if (!admit(authorHex)) return
    let win = windows.get(authorHex)
    if (!win) {
      win = new Map()
      windows.set(authorHex, win)
    }
    if (win.has(seq)) return
    if (win.size >= MAX_HELD_USERNAMES) {
      const lowest = Math.min(...win.keys())
      if (seq < lowest) return
      const evicted = win.get(lowest)
      win.delete(lowest)
      if (evicted.ok === true) deriveNames(authorHex)
    }
    win.set(seq, { record: copy, ok: null })
  }

  // Rows of an author mentioning a name it now verifiably holds were stored
  // before the name was known; they are self-mentions, so free their place.
  function dropOwnMentions (authorHex, username) {
    const pair = namePair(username)
    const bucket = byPair.get(pair)
    const seqs = bucket ? bucket.get(authorHex) : undefined
    if (!seqs) return
    for (const seq of [...seqs]) evict(authorHex, seq, pair)
  }

  function settle (authorHex) {
    if (!isHex64(authorHex)) return
    const win = windows.get(authorHex)
    if (win) {
      for (const entry of win.values()) {
        if (entry.ok !== null) continue
        try {
          entry.ok = verifyUsername(authorHex, entry.record) === true && isHex64(entry.record.issuer)
        } catch {
          entry.ok = false
        }
      }
      deriveNames(authorHex)
    }
    pending.delete(authorHex)
  }

  // Rebuilds the author's names from the verified records of its window,
  // newest first so a name held twice maps to its newest issuer, and keeps
  // owners in sync.
  function deriveNames (authorHex) {
    const next = new Map()
    const win = windows.get(authorHex)
    if (win) {
      for (const seq of [...win.keys()].sort((a, b) => b - a)) {
        const { record, ok } = win.get(seq)
        if (ok !== true || next.has(record.username)) continue
        next.set(record.username, { issuer: record.issuer, seq })
      }
    }
    const prev = names.get(authorHex)
    if (prev) {
      for (const username of prev.keys()) {
        if (next.has(username)) continue
        const who = owners.get(username)
        if (!who) continue
        who.delete(authorHex)
        if (who.size === 0) owners.delete(username)
      }
    }
    for (const username of next.keys()) {
      if (!prev || !prev.has(username)) dropOwnMentions(authorHex, username)
      let who = owners.get(username)
      if (!who) {
        who = new Set()
        owners.set(username, who)
      }
      who.add(authorHex)
    }
    if (next.size > 0) names.set(authorHex, next)
    else names.delete(authorHex)
  }

  function removeAuthor (authorHex) {
    if (!isHex64(authorHex)) return
    const state = authors.get(authorHex)
    if (state) {
      for (const [seq, post] of [...state.posts]) {
        for (const pair of [...post.edges.keys()]) evict(authorHex, seq, pair)
      }
    }
    authors.delete(authorHex)
    windows.delete(authorHex)
    deriveNames(authorHex)
    lastSeq.delete(authorHex)
    pending.delete(authorHex)
    truncated.delete(authorHex)
    refused.delete(authorHex)
    tracked.delete(authorHex)
  }

  // -> { items: [{ key, seq, at, kind }], next: null | { at, key, seq },
  //   incomplete }. followRows are the follow index's rows for target
  // (notices.js rowsFor) and followIncomplete its flag.
  function pageV2 ({ target, followRows = [], isBlocked, issuerUsable, after = null, limit, now = Date.now(), followIncomplete = false } = {}) {
    const incomplete = truncated.size > 0 || pending.size > 0 || refused.size > 0 || overflow || followIncomplete === true
    const n = clampLimit(limit)
    if (!isHex64(target)) return { items: [], next: null, incomplete }
    const clock = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
    const cursor = readCursor(after)

    // author -> Map seq -> kind, keeping the highest priority per post.
    const best = new Map()
    const put = (author, seq, kind) => {
      let seqs = best.get(author)
      if (!seqs) {
        seqs = new Map()
        best.set(author, seqs)
      }
      const prev = seqs.get(seq)
      if (prev === undefined || PRIORITY[kind] > PRIORITY[prev]) seqs.set(seq, kind)
    }
    const collect = (pair, kindOf) => {
      const bucket = byPair.get(pair)
      if (!bucket) return
      for (const [author, seqs] of bucket) {
        for (const seq of seqs) {
          const edge = authors.get(author).posts.get(seq).edges.get(pair)
          put(author, seq, kindOf(edge))
        }
      }
    }
    collect(keyPair(target), (edge) => edge.kind)
    const held = names.get(target)
    if (held) {
      for (const [username, { issuer }] of held) {
        if (!usable(issuerUsable, issuer)) continue
        collect(namePair(username), () => KIND_MENTION)
      }
    }

    const rows = []
    const consider = (key, seq, at, kind) => {
      const t = Date.parse(at)
      // Hidden, not deleted: a row too far in the future may show later.
      if (!Number.isFinite(t) || t - clock > MAX_FUTURE_MS) return
      if (skip(key, target, isBlocked)) return
      const row = { t, key, seq, at, kind }
      // Exclusive cursor: keep only rows strictly later in page order.
      if (cursor !== null && compareRows(row, cursor) <= 0) return
      rows.push(row)
    }
    for (const [author, seqs] of best) {
      const posts = authors.get(author).posts
      for (const [seq, kind] of seqs) consider(author, seq, posts.get(seq).at, kind)
    }
    if (Array.isArray(followRows)) {
      for (const r of followRows) {
        try {
          if (!isPlainObject(r) || !isHex64(r.key) || !isSeq(r.seq) || !isCanonicalIso(r.at)) continue
          consider(r.key, r.seq, r.at, KIND_FOLLOW)
        } catch {}
      }
    }
    rows.sort(compareRows)
    const page = rows.slice(0, n)
    const items = page.map((r) => ({ key: r.key, seq: r.seq, at: r.at, kind: r.kind }))
    const last = items[items.length - 1]
    const next = rows.length > n ? { at: last.at, key: last.key, seq: last.seq } : null
    return { items, next, incomplete }
  }
}

// A throwing or non-function predicate means not usable (fail closed).
function usable (issuerUsable, issuer) {
  if (typeof issuerUsable !== 'function') return false
  try {
    return issuerUsable(issuer) === true
  } catch {
    return false
  }
}

// Never a row for the target itself, nor for a blocked key; a throwing
// isBlocked hides the row (fail closed).
function skip (key, target, isBlocked) {
  if (key === target) return true
  if (typeof isBlocked !== 'function') return false
  try {
    return Boolean(isBlocked(key))
  } catch {
    return true
  }
}

module.exports = {
  MAX_POST_NOTICES_PER_PAIR,
  MAX_POST_NOTICES_PER_AUTHOR,
  POST_NOTICES_MAX_EDGES,
  MAX_UNRESOLVED_TOKENS_PER_AUTHOR,
  POST_NOTICES_MAX_AUTHORS,
  createPostNoticeIndex
}
