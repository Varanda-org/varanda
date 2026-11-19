'use strict'

// In-memory trends for public posts, storing only dates and folded hashtags
// by author and seq. The topic index folds away '#', and counting plain words
// would rank 'de' and 'que'. Each person counts once per tag even after using
// it in 50 posts. Future posts are kept because the seeder's cursor passes
// them only once, and they count when the caller's clock reaches their date.
// Posts more than a day ahead give way at either cap. Admission rejects text
// over 4,000 UTF-16 units before scanning for hashtags.
// The store defaults to 20,000 posts, 50 per author and 10 tags per post.
// Admission scans a diary or the whole store only at its respective cap.
// A query visits held posts once, then sorts the qualifying tags.

const { BLOCKED_TERMS, termInTokens } = require('@varanda/rpc')
const { foldText } = require('./topic-index')

const DEFAULT_MAX_POSTS = 20000
const DEFAULT_PER_AUTHOR_MAX = 50
const DEFAULT_WINDOW_MS = 86400000
// Same tolerance as MAX_FUTURE_MS in lib/group.js and lib/feed.js.
const FUTURE_MS = 86400000
const TREND_MIN_AUTHORS = 3
const TREND_LIMIT = 10
const MAX_TAGS_PER_POST = 10
const MAX_TEXT_UNITS = 4000
const HEX64 = /^[0-9a-f]{64}$/
const TAG_RE = /^[a-z0-9]{2,32}$/

// A hashtag is one token, so a multi-word blocked term glued into one tag
// passes termInTokens. Such a tag is dropped when it equals the glued term
// exactly, also without edge digits (as word-check.js reads a token); a
// longer word that merely contains it stays. Keep in step with
// apps/app/src/topicTrend.js.
const EDGE_DIGITS = /^[0-9]+|[0-9]+$/g
const GLUED_TERMS = new Set(BLOCKED_TERMS.filter((term) => term.includes(' ')).map((term) => foldText(term).replace(/ /g, '')))

function gluedTerm (tag) {
  return GLUED_TERMS.has(tag) || GLUED_TERMS.has(tag.replace(EDGE_DIGITS, '') || tag)
}

function isWordCp (cp) {
  if (cp < 0x80) return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)
  return (cp >= 0xc0 && cp <= 0x1fff && cp !== 0xd7 && cp !== 0xf7) ||
    (cp >= 0x3040 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3) || cp === 0x212a || cp === 0x212b
}

function isSpaceCp (cp) {
  return (cp >= 0x09 && cp <= 0x0d) || cp === 0x20 || cp === 0xa0 || cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f ||
    cp === 0x205f || cp === 0x3000
}

function wordBefore (text, i) {
  const low = text.charCodeAt(i - 1)
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2)
    if (high >= 0xd800 && high <= 0xdbff) return isWordCp(text.codePointAt(i - 2))
  }
  return isWordCp(low)
}

function inUrl (text, hash) {
  let s = hash
  while (s > 0 && !isSpaceCp(text.charCodeAt(s - 1))) s--
  const head = text.slice(s, hash)
  return head.includes('/') || /(?:^|[^a-z0-9])www\./i.test(head)
}

// Rebuild the short ASCII key so a slice cannot retain a long input string.
function flatKey (key) {
  return String.fromCharCode(...Array.from(key, (c) => c.charCodeAt(0)))
}

// Keep in step with apps/app/src/hashtags.js.
function hashtagsOf (text) {
  try {
    if (typeof text !== 'string') return []
    const tags = new Set()
    let from = 0
    while (tags.size < MAX_TAGS_PER_POST) {
      const at = text.indexOf('#', from)
      if (at === -1) break
      from = at + 1
      if (at > 0 && (wordBefore(text, at) || text[at - 1] === '#')) continue
      let end = at + 1
      while (end < text.length) {
        const cp = text.codePointAt(end)
        if (!isWordCp(cp)) break
        end += cp > 0xffff ? 2 : 1
      }
      if (end === at + 1) continue
      const tag = foldText(text.slice(at + 1, end))
      if (!TAG_RE.test(tag) || inUrl(text, at)) continue
      tags.add(flatKey(tag))
      from = end
    }
    return [...tags]
  } catch {
    return []
  }
}

function positiveOption (options, key, fallback) {
  try {
    const value = options?.[key]
    return Number.isSafeInteger(value) && value >= 1 ? value : fallback
  } catch {
    return fallback
  }
}

function isVisible (visible, author) {
  try {
    return visible(author) === true
  } catch {
    return false
  }
}

function createTopicTrend (options = {}) {
  const maxPosts = positiveOption(options, 'maxPosts', DEFAULT_MAX_POSTS)
  const perAuthorMax = positiveOption(options, 'perAuthorMax', DEFAULT_PER_AUTHOR_MAX)
  const windowMs = positiveOption(options, 'windowMs', DEFAULT_WINDOW_MS)
  const diaries = new Map()
  let posts = 0
  let saturated = false

  function observe (author, seq, record, now) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author)) return false
      if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(now) || now < 0) return false
      if (record === null || typeof record !== 'object') return false
      const { text, at } = record
      if (typeof text !== 'string' || typeof at !== 'string') return false
      // Bound the cost of the hashtag scan without relying on the caller.
      if (text.length > MAX_TEXT_UNITS) return false
      const atMs = Date.parse(at)
      if (!Number.isSafeInteger(atMs) || atMs < 0 || new Date(atMs).toISOString() !== at) return false

      const diary = diaries.get(author) ?? new Map()
      if (diary.has(seq)) return true
      const cutoff = now - windowMs
      if (atMs <= cutoff) return false
      const tags = hashtagsOf(text)
      if (tags.length === 0) return false
      const futureCutoff = now + FUTURE_MS

      if (diary.size === perAuthorMax) {
        pruneDiary(author, diary, cutoff, futureCutoff)
        if (diary.size === perAuthorMax) {
          let lowest = Infinity
          for (const heldSeq of diary.keys()) {
            if (heldSeq < lowest) lowest = heldSeq
          }
          if (seq < lowest) return false
          removePost(author, lowest)
        }
      }

      if (posts === maxPosts) {
        // Reclaim at most one far-future slot while pruning all expired posts.
        for (const [heldAuthor, heldDiary] of diaries) {
          pruneDiary(heldAuthor, heldDiary, cutoff, futureCutoff, maxPosts - 1)
        }
        if (posts === maxPosts) {
          // A refused post is behind the seeder's cursor until a rebuild.
          saturated = true
          return false
        }
      }

      if (diary.size === 0) diaries.set(flatKey(author), diary)
      diary.set(seq, { at: atMs, tags })
      posts++
      return true
    } catch {
      return false
    }
  }

  function pruneDiary (author, diary, cutoff, futureCutoff, keepAtLeast = 0) {
    for (const [seq, post] of diary) {
      if (post.at <= cutoff || (posts > keepAtLeast && post.at > futureCutoff)) removePost(author, seq)
    }
  }

  function removePost (author, seq) {
    try {
      const diary = diaries.get(author)
      if (!diary?.delete(seq)) return false
      posts--
      if (diary.size === 0) diaries.delete(author)
      return true
    } catch {
      return false
    }
  }

  function removeDiary (author) {
    try {
      const diary = diaries.get(author)
      if (diary === undefined) return false
      diaries.delete(author)
      posts -= diary.size
      return true
    } catch {
      return false
    }
  }

  function top (now, visible, options = {}) {
    try {
      if (!Number.isSafeInteger(now) || typeof visible !== 'function') return []
      const { min = TREND_MIN_AUTHORS, limit = TREND_LIMIT } = options
      if (!Number.isSafeInteger(min) || min < 0 || !Number.isSafeInteger(limit) || limit < 1) return []
      const cutoff = now - windowMs
      const counts = new Map()
      // A predicate may change the store. Copy the keys before calling it to
      // keep the number of calls bounded and check each author only once.
      const visibleAuthors = [...diaries.keys()].filter((author) => isVisible(visible, author))
      for (const author of visibleAuthors) {
        const diary = diaries.get(author)
        if (diary === undefined) continue
        const tags = new Set()
        for (const post of diary.values()) {
          if (post.at <= cutoff || post.at > now) continue
          for (const tag of post.tags) tags.add(tag)
        }
        for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }

      const rows = []
      for (const [tag, authors] of counts) {
        if (authors >= min && termInTokens([tag]) === null && !gluedTerm(tag)) rows.push({ tag, authors })
      }
      rows.sort((a, b) => {
        if (a.authors !== b.authors) return b.authors - a.authors
        if (a.tag === b.tag) return 0
        return a.tag < b.tag ? -1 : 1
      })
      return rows.slice(0, limit)
    } catch {
      return []
    }
  }

  function stats () {
    try {
      return { posts, authors: diaries.size, saturated }
    } catch {
      return { posts: 0, authors: 0, saturated: false }
    }
  }

  function clear () {
    try {
      diaries.clear()
      posts = 0
      saturated = false
    } catch {}
  }

  return { observe, removePost, removeDiary, top, stats, clear }
}

module.exports = {
  DEFAULT_MAX_POSTS,
  DEFAULT_PER_AUTHOR_MAX,
  DEFAULT_WINDOW_MS,
  TREND_MIN_AUTHORS,
  TREND_LIMIT,
  MAX_TAGS_PER_POST,
  MAX_TEXT_UNITS,
  hashtagsOf,
  createTopicTrend
}
