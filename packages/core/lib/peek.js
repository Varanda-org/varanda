'use strict'

// Why democratic: the order uses no engagement signal (likes, reposts or
// follower counts; docs/protocol.md section 2). Each diary gets one slot per
// round regardless of volume, for at most three rounds. "Most recent" in a
// diary means the publication with the highest seq (last written): a post,
// a reply, a quote or a repost still in effect (likes are never shown).
// Within a round, only the author's own `at` orders them, as in A Rua. The same
// seeder inventory gives every member the same page except for their follows,
// blocks and their own key: the own diary is left out of its owner's page
// because those publications already live in A Rua, while it stays a candidate
// in everyone else's. Anyone can recompute it from hello inventory and diaries.
// Known limit: `at` is untrusted presentation data; a date up to 24 hours ahead
// sorts first in its round, just as in A Rua.

const { validRecordCopy, latestProfile, isHex64, isCanonicalIso, parseRef } = require('./records')
const { engagementState } = require('./engagement')
const { latestUsername } = require('./username')
const { certForKey } = require('./cert')
const { MAX_FUTURE_MS } = require('./feed')

const PEEK_HEAD_BLOCKS = 3
const PEEK_TAIL_BLOCKS = 8
const PEEK_MAX_BLOCKS_PER_DIARY = 64
const PEEK_MAX_ROUNDS = 3
const PEEK_PARALLEL = 16
const PEEK_FETCH_TIMEOUT_MS = 10000
const PEEK_PAGE_TIMEOUT_MS = 25000
const PEEK_CONNECT_TIMEOUT_MS = 15000
const PEEK_SNAPSHOT_TTL_MS = 300000
const PEEK_PAGE_MAX_BYTES = 16777216
const PEEK_RULE = 'A Espiadinha mostra a publicação mais recente de cada diário que você não segue, da mais nova para a mais antiga; depois a segunda e, por fim, a terceira mais recente de cada um, do mesmo jeito: sem curtidas, sem sugestões e sem pesos escondidos.'

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function peekCandidates ({ inventory, follows, blocked, ownKey }) {
  const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  if (!isHex64(own)) throw new TypeError('ownKey inválido')
  const candidates = []
  const seen = new Set()
  for (const [rawKey, length] of inventory) {
    const key = typeof rawKey === 'string' ? rawKey.toLowerCase() : null
    if (!isHex64(key) || seen.has(key)) continue
    // The first spelling of a key wins, whatever its length.
    seen.add(key)
    if (!Number.isSafeInteger(length) || length < 2) continue
    if (follows.has(key) || blocked.has(key)) continue
    if (key === own) continue
    candidates.push({ key, length })
  }
  return candidates.sort((a, b) => cmp(a.key, b.key))
}

function tailFloor (length, fetched) {
  let floor = length
  while (floor > 0 && fetched.has(floor - 1)) floor--
  return floor
}

function peekWindow (length, fetched) {
  if (!Number.isSafeInteger(length) || length < 1) return []
  const room = PEEK_MAX_BLOCKS_PER_DIARY - fetched.size
  if (room <= 0) return []
  const floor = tailFloor(length, fetched)
  const seqs = []
  for (let seq = 0; seq < Math.min(PEEK_HEAD_BLOCKS, length); seq++) {
    if (!fetched.has(seq)) seqs.push(seq)
  }
  for (let seq = Math.max(PEEK_HEAD_BLOCKS, floor - PEEK_TAIL_BLOCKS); seq < floor; seq++) {
    if (!fetched.has(seq)) seqs.push(seq)
  }
  return seqs.sort((a, b) => b - a).slice(0, room)
}

// Only these copied records survive between pages. Invalid records still
// count as fetched: contiguity must always come from the separate seq set.
// Hostile entries, getters and iterators cannot escape this reader.
function retainRecords (entries) {
  const kept = []
  try {
    for (const entry of entries) {
      try {
        const { seq, record } = entry
        if (!Number.isSafeInteger(seq) || seq < 0) continue
        const copy = validRecordCopy(record, seq)
        if (copy === null) continue
        if (seq === 0 || copy.type === 'profile' || copy.type === 'username' ||
          copy.type === 'post' || copy.type === 'repost') {
          kept.push({ seq, record: copy })
        }
      } catch {}
    }
  } catch {}
  return kept
}

// Never throws on peer data, including hostile getters and proxies.
function diaryPeek (input) {
  const result = { reason: 'not-in-log', name: null, avatar: null, username: null, posts: [], future: 0, scanned: false, capped: false }
  try {
    const { key, length, entries, fetched, association, revokedIssuers, now = Date.now() } = input
    if (!Number.isSafeInteger(length) || length < 1) return result
    const floor = tailFloor(length, fetched)
    // A full scan holds every seq from the top down to block 0: the head
    // blocks count too, so a missing head block never reads as scanned.
    result.scanned = floor === 0
    result.capped = !result.scanned && fetched.size >= PEEK_MAX_BLOCKS_PER_DIARY
    const copies = retainRecords(entries)
    const first = copies.find((entry) => entry.seq === 0)
    if (first) {
      const verdict = certForKey(first.record.cert, key, association, { revokedIssuers })
      result.reason = verdict.ok ? null : verdict.reason
    }
    const profile = latestProfile(copies) || {}
    result.name = profile.name || null
    result.avatar = profile.avatar || null
    result.username = latestUsername(copies, key, association, { revokedIssuers })
    const tail = copies.filter(({ seq }) => seq >= floor && seq < length)
    for (const { seq, record: post } of tail) {
      if (post.type !== 'post') continue
      if (Date.parse(post.at) - now > MAX_FUTURE_MS) {
        result.future++
        continue
      }
      const media = Array.isArray(post.media) ? post.media.map((d) => ({ ...d })) : null
      const replyTo = post.replyTo ? { author: post.replyTo.author, seq: post.replyTo.seq } : null
      const quote = post.quote ? { author: post.quote.author, seq: post.quote.seq } : null
      result.posts.push({ kind: 'post', seq, at: post.at, text: post.text, replyTo, quote, media })
    }
    // Reposts in effect (the last operation per target wins, as in the feed).
    // The tail is contiguous up to the top, so an undo of a repost in it is in
    // it too; repost records below the floor are never used.
    for (const [ref, { seq, at }] of engagementState(tail).reposted) {
      if (Date.parse(at) - now > MAX_FUTURE_MS) {
        result.future++
        continue
      }
      result.posts.push({ kind: 'repost', seq, at, to: parseRef(ref) })
    }
    result.posts.sort((a, b) => b.seq - a.seq)
    result.posts = result.posts.slice(0, PEEK_MAX_ROUNDS)
  } catch {}
  return result
}

// Snapshot fields once: a getter cannot change a cursor after validation.
function peekCursor (v) {
  try {
    if (v === null || typeof v !== 'object') return null
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return null
    const keys = ['round', 'at', 'author', 'seq']
    if (Object.keys(v).length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(v, k))) return null
    const { round, at, author, seq } = v
    if (!Number.isSafeInteger(round) || round < 0 || !Number.isSafeInteger(seq) || seq < 1) return null
    if (typeof at !== 'string' || at.length > 32 || !isCanonicalIso(at) || !isHex64(author)) return null
    return { round, at, author, seq }
  } catch {
    return null
  }
}

function isPeekCursor (v) {
  return peekCursor(v) !== null
}

function pageOrder (a, b) {
  return a.round - b.round || Date.parse(b.at) - Date.parse(a.at) || cmp(a.author, b.author)
}

// `diaries` contains the caller's verified diaryPeek results. Incomplete
// rounds are provisional: fetch `needs` and rebuild before using any cursor.
function buildPeekPage ({ diaries, limit, after = null }) {
  const cursor = after === null ? null : peekCursor(after)
  if (after !== null && cursor === null) throw new TypeError('after inválido')
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit inválido')
  const items = []
  const needs = new Set()
  for (let round = cursor === null ? 0 : cursor.round; round < PEEK_MAX_ROUNDS; round++) {
    const slots = []
    for (const { key, name, avatar = null, username, posts, exhausted } of diaries) {
      const post = posts[round]
      if (!post) {
        if (!exhausted) needs.add(key)
        continue
      }
      const { seq, at } = post
      // A FeedItem (lib/feed.js), plus round and avatar.
      let item
      if (post.kind === 'repost') {
        const to = { author: post.to.author, seq: post.to.seq }
        item = { kind: 'repost', author: key, name, avatar: avatar ? { ...avatar } : null, username, seq, at, to, text: null, replyTo: null, quote: null, media: null, round }
      } else {
        const media = Array.isArray(post.media) ? post.media.map((d) => ({ ...d })) : null
        const replyTo = post.replyTo ? { author: post.replyTo.author, seq: post.replyTo.seq } : null
        const quote = post.quote ? { author: post.quote.author, seq: post.quote.seq } : null
        item = { kind: 'post', author: key, name, avatar: avatar ? { ...avatar } : null, username, seq, at, text: post.text, replyTo, quote, media, round }
      }
      if (cursor === null || pageOrder(item, cursor) > 0) slots.push(item)
    }
    slots.sort(pageOrder)
    const room = limit - items.length
    items.push(...slots.slice(0, room))
    // Stop after the round in which the page becomes full; the needs of every
    // round visited so far are accumulated.
    if (items.length === limit) break
  }
  if (needs.size > 0) return { items, next: null, needs: Array.from(needs).sort(cmp) }
  if (items.length < limit) return { items, next: null, needs: [] }
  // A full page always carries a cursor; the call after the last full page
  // answers { items: [], next: null }.
  const { round, at, author, seq } = items[items.length - 1]
  return { items, next: { round, at, author, seq }, needs: [] }
}

module.exports = {
  PEEK_HEAD_BLOCKS,
  PEEK_TAIL_BLOCKS,
  PEEK_MAX_BLOCKS_PER_DIARY,
  PEEK_MAX_ROUNDS,
  PEEK_PARALLEL,
  PEEK_FETCH_TIMEOUT_MS,
  PEEK_PAGE_TIMEOUT_MS,
  PEEK_CONNECT_TIMEOUT_MS,
  PEEK_SNAPSHOT_TTL_MS,
  PEEK_PAGE_MAX_BYTES,
  PEEK_RULE,
  peekCandidates,
  peekWindow,
  diaryPeek,
  buildPeekPage,
  isPeekCursor,
  retainRecords
}
