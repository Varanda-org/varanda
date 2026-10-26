'use strict'

// Engagement index of a seeder (docs/protocol.md section 7 "Seeder index
// route"): who replied to, quoted, liked and reposted which post, plus the
// post list and the latest profile/username seq of every author. It lives IN
// MEMORY only and is rebuilt from the served diaries at every start by the
// seeder's index scan (lib/seeder.js); nothing here is persisted or trusted
// by anyone: the index only says WHERE TO LOOK (refs, seq hints and counts),
// and every post, name or bio a node shows is fetched from the diary itself
// and verified there. Counts and completeness are claims made by the seeder.
//
// Bounds and honesty: maxRecords (1,000,000), maxTargets (500,000) and
// perAuthorMax (50,000) bound retained records, distinct targets and records
// per diary. Admission checks precede mutation: a refused add pauses the
// caller at that seq, never skipping; complete stays false until it resumes.
// Quotas count all indexed operations, including off toggles and hints.
// Collections are lazy. Budget roughly 250 bytes/record (edge, post/timeline,
// engager and touched entries) plus 500 bytes/target (key, target object,
// map slots and the first used collection): about 500 MB at both defaults,
// plus small per-diary overhead bounded by the seeder's served-diary limit.
// These are conservative retained-heap estimates, not a V8/RSS guarantee;
// collection capacity, string representation and GC headroom vary by runtime.
//
// Pure and total: no I/O, no timers, and no method ever throws (a hostile
// `visible` predicate included: a throw inside answers null / empty).
// Records given to `add` must already be plain validated copies
// (validRecordCopy) handed in ascending seq per author; the last operation
// per (engager, target) wins for likes and reposts.
const { formatRef, parseRef } = require('./records')

const DEFAULT_MAX_RECORDS = 1000000
const DEFAULT_MAX_TARGETS = 500000
const DEFAULT_PER_AUTHOR_MAX = 50000
const PAGE_SCAN = 200 // shared by replies and quotes
const EMPTY_LIST = []
const REPLY_PAGE = 50
const QUOTE_PAGE = 50
const MEMBER_PAGE = 100
const HEX64 = /^[0-9a-f]{64}$/
const CURSOR_RE = /^([0-9]{1,16})\.([0-9a-f]{64})\.([1-9][0-9]{0,14})$/

// Ordering key of a reply or quote edge: (Date.parse(at), author, seq). A
// canonical ISO date always parses; a pre-1970 one (a negative value) is
// clamped to 0 so that every edge has a cursor the route grammar can carry.
function atMillis (at) {
  const ms = Date.parse(at)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

function compareEdges (a, b) {
  if (a.atMs !== b.atMs) return a.atMs < b.atMs ? -1 : 1
  if (a.author !== b.author) return a.author < b.author ? -1 : 1
  return a.seq - b.seq
}

// Index of the first edge of `list` (sorted ascending) that is strictly after
// `edge`, by compareEdges.
function upperBound (list, edge) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareEdges(list[mid], edge) <= 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

function insertSorted (list, edge) {
  list.splice(upperBound(list, edge), 0, edge)
}

function edgeRef (edge) {
  return edge.author + ':' + edge.seq
}

function edgeCursor (edge) {
  return edge.atMs + '.' + edge.author + '.' + edge.seq
}

// The cursor of the route (`<atMs>.<authorHex>.<seq>`) as an edge key, or
// null when malformed or out of the safe integer range.
function parseCursor (cursor) {
  if (cursor === null || cursor === undefined) return null
  if (typeof cursor !== 'string') return undefined
  const m = CURSOR_RE.exec(cursor)
  if (m === null) return undefined
  const atMs = Number(m[1])
  const seq = Number(m[3])
  if (!Number.isSafeInteger(atMs) || !Number.isSafeInteger(seq)) return undefined
  return { atMs, author: m[2], seq }
}

function validRef (ref) {
  const parsed = parseRef(ref)
  if (parsed === null || parsed.seq < 1 || parsed.author !== ref.slice(0, 64)) return null
  return parsed
}

function isSeq (seq) {
  return Number.isSafeInteger(seq) && seq >= 1
}

// Binary search in an ascending array of integers.
function indexOfSeq (list, seq) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid] < seq) lo = mid + 1
    else hi = mid
  }
  return lo < list.length && list[lo] === seq ? lo : -1
}

function lowerBoundSeq (list, seq) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid] < seq) lo = mid + 1
    else hi = mid
  }
  return lo
}

function allVisible () {
  return true
}

function createEngagementIndex ({ maxRecords = DEFAULT_MAX_RECORDS, maxTargets = DEFAULT_MAX_TARGETS, perAuthorMax = DEFAULT_PER_AUTHOR_MAX, onFreed = null } = {}) {
  const cap = Number.isSafeInteger(maxRecords) && maxRecords >= 0 ? maxRecords : DEFAULT_MAX_RECORDS
  const targetCap = Number.isSafeInteger(maxTargets) && maxTargets >= 0 ? maxTargets : DEFAULT_MAX_TARGETS
  const authorCap = Number.isSafeInteger(perAuthorMax) && perAuthorMax >= 0 ? perAuthorMax : DEFAULT_PER_AUTHOR_MAX
  let records = 0
  let fullAuthors = 0
  // target ref -> { replies: [edge] asc, quotes: [edge] asc, likes:
  // Map<engager, seq>, reposts: Map<engager, seq> } (engagers currently on).
  // All four collections start null; numeric totals change only on writes.
  const targets = new Map()
  // Target author -> its retained target refs, including nonexistent posts.
  const authorTargets = new Map()
  // author -> { count, timeline: [seq] asc (posts and reposts currently on),
  // posts: Map<seq, { replyTo, quote }>, reposts: Map<ref, seq> (the on
  // record per target), touched: Map<ref, active edge count>,
  // profileSeq, usernameSeq }
  const authors = new Map()

  function authorEntry (author) {
    let entry = authors.get(author)
    if (entry === undefined) {
      entry = { count: 0, timeline: [], posts: new Map(), reposts: new Map(), touched: new Map(), profileSeq: null, usernameSeq: null }
      authors.set(author, entry)
    }
    return entry
  }

  function targetEntry (ref) {
    let entry = targets.get(ref)
    if (entry === undefined) {
      entry = { replies: null, quotes: null, likes: null, reposts: null, repliesTotal: 0, quotesTotal: 0, likesTotal: 0, repostsTotal: 0 }
      targets.set(ref, entry)
      const author = ref.slice(0, 64)
      if (!authorTargets.has(author)) authorTargets.set(author, new Set())
      authorTargets.get(author).add(ref)
    }
    return entry
  }

  function dropTargetIfEmpty (ref, entry) {
    if (entry.repliesTotal === 0 && entry.quotesTotal === 0 && entry.likesTotal === 0 && entry.repostsTotal === 0) {
      deleteTarget(ref)
    }
  }

  function deleteTarget (ref) {
    targets.delete(ref)
    const author = ref.slice(0, 64)
    const refs = authorTargets.get(author)
    refs.delete(ref)
    if (refs.size === 0) authorTargets.delete(author)
  }

  function touch (entry, ref, delta) {
    const count = (entry.touched.get(ref) || 0) + delta
    if (count === 0) entry.touched.delete(ref)
    else entry.touched.set(ref, count)
  }

  function freed () {
    // A notification cannot turn an already committed mutation into failure.
    try { if (typeof onFreed === 'function') onFreed() } catch {}
  }

  function addTimeline (entry, seq) {
    const at = lowerBoundSeq(entry.timeline, seq)
    if (entry.timeline[at] === seq) return
    entry.timeline.splice(at, 0, seq)
  }

  function removeTimeline (entry, seq) {
    const at = indexOfSeq(entry.timeline, seq)
    if (at !== -1) entry.timeline.splice(at, 1)
  }

  // Last operation per (type, engager, target) wins: records arrive in
  // ascending seq per author, and an older seq never overrides a newer one.
  function toggle (target, type, engager, seq, on, ref, entry) {
    const map = target[type]
    const prev = map === null ? undefined : map.get(engager)
    if (prev !== undefined && prev > seq) return false
    if (on) {
      if (target[type] === null) target[type] = new Map()
      target[type].set(engager, seq)
      if (prev === undefined) {
        target[type + 'Total']++
        touch(entry, ref, 1)
      }
    } else if (prev !== undefined) {
      map.delete(engager)
      target[type + 'Total']--
      touch(entry, ref, -1)
      if (map.size === 0) target[type] = null
    }
    return true
  }

  function add (author, seq, record) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author) || !isSeq(seq)) return false
      if (record === null || typeof record !== 'object') return false
      const type = record.type
      if (type !== 'post' && type !== 'like' && type !== 'repost' && type !== 'profile' && type !== 'username') return false
      const existing = authors.get(author)
      if (records >= cap || (existing ? existing.count : 0) >= authorCap) return false
      const replyTo = type === 'post' && record.replyTo ? formatRef(record.replyTo) : null
      const quote = type === 'post' && record.quote ? formatRef(record.quote) : null
      const to = type === 'like' || type === 'repost' ? formatRef(record.to) : null
      // Off operations need no new target; they may free one at the cap.
      const needed = new Set([replyTo, quote, record.on === true ? to : null])
      needed.delete(null)
      let extra = 0
      for (const ref of needed) if (!targets.has(ref)) extra++
      if (targets.size + extra > targetCap) return false
      const targetsBefore = targets.size
      const entry = authorEntry(author)
      if (type === 'post') {
        entry.posts.set(seq, { replyTo, quote })
        addTimeline(entry, seq)
        const edge = { atMs: atMillis(record.at), author, seq }
        if (replyTo !== null) {
          const target = targetEntry(replyTo)
          if (target.replies === null) target.replies = []
          insertSorted(target.replies, edge)
          target.repliesTotal++
          touch(entry, replyTo, 1)
        }
        if (quote !== null) {
          const target = targetEntry(quote)
          if (target.quotes === null) target.quotes = []
          insertSorted(target.quotes, edge)
          target.quotesTotal++
          touch(entry, quote, 1)
        }
      } else if (type === 'like') {
        const target = targets.get(to) || (record.on === true ? targetEntry(to) : null)
        if (target !== null) {
          toggle(target, 'likes', author, seq, record.on === true, to, entry)
          dropTargetIfEmpty(to, target)
        }
      } else if (type === 'repost') {
        const target = targets.get(to) || (record.on === true ? targetEntry(to) : null)
        if (target !== null && toggle(target, 'reposts', author, seq, record.on === true, to, entry)) {
          const prev = entry.reposts.get(to)
          if (prev !== undefined) removeTimeline(entry, prev)
          if (record.on === true) {
            entry.reposts.set(to, seq)
            addTimeline(entry, seq)
          } else {
            entry.reposts.delete(to)
          }
        }
        if (target !== null) {
          dropTargetIfEmpty(to, target)
        }
      } else if (type === 'profile') {
        if (entry.profileSeq === null || seq > entry.profileSeq) entry.profileSeq = seq
      } else if (record.member === author) {
        if (entry.usernameSeq === null || seq > entry.usernameSeq) entry.usernameSeq = seq
      }
      entry.count++
      if (entry.count === authorCap) fullAuthors++
      records++
      if (targets.size < targetsBefore) freed()
      return true
    } catch {
      return false
    }
  }

  // Removes every trace of a diary: its edges on every target it touched,
  // its engager entries, its posts and hints, and targets belonging to it.
  // Quotas still count all accepted operations of every remaining diary.
  function removeDiary (author, onIncomingRemoved = null) {
    try {
      const entry = authors.get(author)
      const owned = authorTargets.get(author)
      if (entry === undefined && owned === undefined) return false
      const targetsBefore = targets.size
      const recordsBefore = records
      let incomingRemoved = false
      // Only this author's targets and their engagers are visited. A target
      // may exist even when none of its author's records was indexed yet.
      if (owned !== undefined) {
        for (const ref of owned) {
          const target = targets.get(ref)
          for (const type of ['replies', 'quotes']) {
            for (const edge of target[type] || EMPTY_LIST) {
              if (edge.author !== author) incomingRemoved = true
              authors.get(edge.author).touched.delete(ref)
            }
          }
          for (const type of ['likes', 'reposts']) {
            if (target[type] === null) continue
            for (const engager of target[type].keys()) {
              if (engager !== author) incomingRemoved = true
              const other = authors.get(engager)
              other.touched.delete(ref)
              if (type === 'reposts') {
                removeTimeline(other, other.reposts.get(ref))
                other.reposts.delete(ref)
              }
            }
          }
          deleteTarget(ref)
        }
      }
      for (const ref of entry ? entry.touched.keys() : EMPTY_LIST) {
        const target = targets.get(ref)
        if (target === undefined) continue
        for (const type of ['replies', 'quotes']) {
          if (target[type] === null) continue
          target[type] = target[type].filter((e) => e.author !== author)
          target[type + 'Total'] = target[type].length
          if (target[type].length === 0) target[type] = null
        }
        for (const type of ['likes', 'reposts']) {
          if (target[type] === null) continue
          if (target[type].delete(author)) target[type + 'Total']--
          if (target[type].size === 0) target[type] = null
        }
        dropTargetIfEmpty(ref, target)
      }
      authors.delete(author)
      if (entry !== undefined) {
        if (entry.count === authorCap) fullAuthors--
        records -= entry.count
      }
      // Preserve the boolean result; this optional notification lets the
      // seeder remember that other diaries must be replayed on re-admission.
      try { if (incomingRemoved && typeof onIncomingRemoved === 'function') onIncomingRemoved() } catch {}
      if (records < recordsBefore || targets.size < targetsBefore) freed()
      return true
    } catch {
      return false
    }
  }

  function hints (author) {
    const entry = authors.get(author)
    if (entry === undefined) return { profileSeq: null, usernameSeq: null }
    return { profileSeq: entry.profileSeq, usernameSeq: entry.usernameSeq }
  }

  // Totals exclude dropped diaries by construction: removeDiary runs
  // synchronously before a drop yields. Visibility checks here protect only
  // the target, parent and bounded page items. Replies use a binary cursor
  // search; quotes are newest first. Under the served-diary invariant every
  // edge is visible. If that invariant is broken, scan at most PAGE_SCAN
  // candidates in total, skipping hidden items and keeping the cursor format.
  function post (ref, cursor = null, visible = allVisible) {
    try {
      const parsed = validRef(ref)
      if (parsed === null) return null
      const after = parseCursor(cursor)
      if (after === undefined) return null
      if (typeof visible !== 'function') visible = allVisible
      const entry = authors.get(parsed.author)
      if (entry === undefined || !visible(parsed.author)) return null
      const info = entry.posts.get(parsed.seq)
      if (info === undefined) return null
      const target = targets.get(ref)
      const replyEdges = (target && target.replies) || EMPTY_LIST
      const quoteEdges = (target && target.quotes) || EMPTY_LIST
      const authorHints = {}
      const hint = (author) => { if (!(author in authorHints)) authorHints[author] = hints(author) }
      hint(parsed.author)
      let parent = null
      if (info.replyTo !== null) {
        const p = parseRef(info.replyTo)
        if (p !== null && visible(p.author)) {
          parent = info.replyTo
          hint(p.author)
        }
      }
      const replies = []
      let next = null
      let last = null
      const start = after === null ? 0 : upperBound(replyEdges, after)
      // Reserve a normal quote page; unused reply budget can fill holes in
      // the quote page too. No edge outside this budget is visibility-tested.
      const replyBudget = PAGE_SCAN - Math.min(QUOTE_PAGE, quoteEdges.length)
      let i = start
      for (; i < replyEdges.length && i < start + replyBudget && replies.length < REPLY_PAGE; i++) {
        const edge = replyEdges[i]
        if (!visible(edge.author)) continue
        replies.push(edgeRef(edge))
        hint(edge.author)
        last = edge
      }
      if (last !== null && i < replyEdges.length) next = edgeCursor(last)
      const quotes = []
      const end = Math.max(0, quoteEdges.length - (PAGE_SCAN - (i - start)))
      for (let i = quoteEdges.length - 1; i >= end && quotes.length < QUOTE_PAGE; i--) {
        const edge = quoteEdges[i]
        if (!visible(edge.author)) continue
        quotes.push(edgeRef(edge))
        hint(edge.author)
      }
      return {
        ref,
        parent,
        replies,
        next,
        quotes,
        likes: target ? target.likesTotal : 0,
        reposts: target ? target.repostsTotal : 0,
        repliesTotal: target ? target.repliesTotal : 0,
        quotesTotal: target ? target.quotesTotal : 0,
        authors: authorHints
      }
    } catch {
      return null
    }
  }

  // { [ref]: { replies, likes, reposts, quotes } } for every ref of `refs`
  // whose post is indexed or that has engagement, filtered by `visible`.
  // Every ref is computed ONCE (duplicates collapse) and each computation
  // reads four counters, independent of that target's edge/engager count.
  function counts (refs, visible = allVisible) {
    const out = {}
    try {
      if (!Array.isArray(refs)) return out
      if (typeof visible !== 'function') visible = allVisible
      const seen = new Set()
      for (const ref of refs) {
        if (typeof ref !== 'string' || seen.has(ref)) continue
        seen.add(ref)
        const parsed = validRef(ref)
        if (parsed === null || !visible(parsed.author)) continue
        const entry = authors.get(parsed.author)
        const target = targets.get(ref)
        if (target === undefined && (entry === undefined || !entry.posts.has(parsed.seq))) continue
        if (target === undefined) {
          out[ref] = { replies: 0, likes: 0, reposts: 0, quotes: 0 }
          continue
        }
        out[ref] = { replies: target.repliesTotal, likes: target.likesTotal, reposts: target.repostsTotal, quotes: target.quotesTotal }
      }
    } catch {
      return {}
    }
    return out
  }

  // The timeline page of an author: posts (replies and quotes included) and
  // reposts currently on, as seqs descending, strictly below `before`
  // (exclusive, null = from the newest), at most MEMBER_PAGE. Null for an
  // author with nothing indexed.
  function member (author, before = null) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author)) return null
      if (before !== null && before !== undefined && !isSeq(before)) return null
      const entry = authors.get(author)
      if (entry === undefined) return null
      const end = before === null || before === undefined ? entry.timeline.length : lowerBoundSeq(entry.timeline, before)
      const posts = []
      for (let i = end - 1; i >= 0 && posts.length < MEMBER_PAGE; i--) posts.push(entry.timeline[i])
      return { profileSeq: entry.profileSeq, usernameSeq: entry.usernameSeq, posts, postsTotal: entry.timeline.length }
    } catch {
      return null
    }
  }

  function stats () {
    return { records, targets: targets.size, saturated: records >= cap || targets.size >= targetCap || authorCap === 0 || fullAuthors > 0, maxRecords: cap }
  }

  function clear () {
    targets.clear()
    authorTargets.clear()
    authors.clear()
    records = 0
    fullAuthors = 0
  }

  return { add, removeDiary, post, counts, member, hints, stats, clear }
}

module.exports = {
  createEngagementIndex,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_TARGETS,
  DEFAULT_PER_AUTHOR_MAX,
  REPLY_PAGE,
  QUOTE_PAGE,
  MEMBER_PAGE,
  CURSOR_RE
}
