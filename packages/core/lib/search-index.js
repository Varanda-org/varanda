'use strict'

// Topic search index of a seeder (issue #81, "pesquisar por assunto" in the
// Espiadinha): which public posts contain which whole words. Like the
// engagement index (lib/engagement-index.js) it lives IN MEMORY only, is
// rebuilt from the served diaries by the seeder's own scan and is trusted by
// nobody. It stores no text, names or bios (docs/design.md: the index only
// says WHERE TO LOOK): a hit is a hint `<author>:<seq>`; the node reads and
// verifies every post with diary.peek and re-checks the words itself, so a
// lying seeder can hide or mislist posts but never forge text.
//
// Matching: whole-token AND. Text is folded (NFD, combining marks stripped,
// lower case) and split on anything outside [a-z0-9]; runs of 2..32 letters
// are tokens. 'Céu', '#Céu' and 'CÉU!' all give 'ceu'; 'Céus' gives 'ceus'
// and does NOT match 'ceu'. Letters outside a-z after folding (non-Latin
// scripts) produce no tokens and are not searchable. Deliberately absent:
// prefix/substring matching, positions, phrase queries, ranking, text
// storage and per-token eviction (a refused add pauses the caller instead).
//
// Cost of a query: it walks only the SHORTEST posting list among the query
// tokens, newest first, testing the other tokens against the entry's own
// sorted token array, and stops after SEARCH_PAGE hits or SEARCH_SCAN (2000)
// candidates examined. The cursor is located by binary search, so a page is
// O(log n + 2000) whatever the corpus size; a short or empty page may carry
// `next`, and only next === null means the end. Entries dated more than
// MAX_FUTURE_MS ahead sort as newest; a second binary search starts the
// walk below them, so they are never examined and never use the budget.
//
// Posting-list order: append-only with a lazy sort. Each list is kept
// ascending by the reverse of compareNewestFirst (oldest at index 0, newest
// at the END, the orientation of engagement-index.js compareEdges). The
// seeder ingests one diary at a time, oldest block first, so a newest-first
// binary-insertion splice would be quadratic; instead `add` appends and
// marks the token dirty when the new entry is older than the list's last.
// The next query that touches a dirty list sorts it once (stable
// Array.prototype.sort, O(n log n); nearly sorted input, the common case,
// is cheap) and clears the mark. removeDiary filters and keeps the order.
//
// Memory: a post costs one entry { atMs, author, seq, tokens } shared by
// every posting list it is in, plus one array slot per (token, post), plus
// the term keys. Measured on Node 24 (retained heap after GC): about 280
// bytes per one-token post, about 320 bytes per term (Map entry, record,
// key, a growing array) and about 20 bytes per posting (a list slot with
// growth slack plus the entry.tokens slot): about 264 MB with every default
// cap full (200,000 posts, 500,000 terms, 4,000,000 postings; the security
// audit's measurement). Not an RSS guarantee. It holds only because no stored string keeps the post's text
// alive: tokensOf returns substrings of the folded text, and V8 keeps a
// substring of 13+ characters as a slice that pins its whole parent (a
// 1000-code-point post folds to ~6,000 UTF-16 units). So every token is
// canonicalized through the term table: the first time a term appears its
// key is rebuilt as a FLAT string (flatKey), and entry.tokens, the term
// keys and the dirty set hold only those canonical keys. Nothing returned
// by split()/slice() outlives add().
//
// Fairness: besides the global caps, each author holds at most a share of
// the posts (perAuthorMax), of the posting budget (perAuthorPostingsMax), each
// 5% of its global cap, and may CREATE at most a share
// of the term budget (perAuthorTermsMax, counted when its accepted post
// introduces a term nobody had; terms it created that others use stay when
// it leaves). Otherwise one diary could fill a global budget and every
// other diary's next post would be refused for good. A refusal pauses only
// the offending diary's cursor (the seeder pauses on any false).
//
// Pure and total: no I/O, no timers, no imports, and no method ever throws
// (a throwing `visible` predicate included). Admission is checked before any
// mutation: a refused add returns false and leaves the index unchanged.

const SEARCH_PAGE = 30
const SEARCH_SCAN = 2000
const MIN_TOKEN = 2
const MAX_TOKEN = 32
const MAX_QUERY_TOKENS = 8
// Same value as lib/feed.js MAX_FUTURE_MS (not imported: this module is
// self-contained). A post dated further ahead is hidden, never removed
// (docs/protocol.md R5.10), and appears once the clock catches up.
const MAX_FUTURE_MS = 86400000
const QUERY_RE = /^[a-z0-9]{2,32}(?:\+[a-z0-9]{2,32}){0,7}$/
const CURSOR_RE = /^([0-9]{1,16})\.([0-9a-f]{64})\.([1-9][0-9]{0,14})$/
// The largest seq a cursor can carry (15 digits, CURSOR_RE and the route's
// regex): add refuses a larger one so every page's `next` stays usable.
// Unreachable in practice (records.js MAX_LOG_BLOCKS).
const MAX_SEQ = 999999999999999
const DEFAULT_MAX_POSTS = 200000
const DEFAULT_PER_AUTHOR_MAX = 10000
const DEFAULT_MAX_TERMS = 500000
const DEFAULT_MAX_POSTINGS = 4000000
// Per-author shares: 5% of DEFAULT_MAX_POSTINGS and of DEFAULT_MAX_TERMS.
const DEFAULT_PER_AUTHOR_POSTINGS_MAX = 200000
const DEFAULT_PER_AUTHOR_TERMS_MAX = 25000
const HEX64 = /^[0-9a-f]{64}$/
const TOKEN_RE = /^[a-z0-9]{2,32}$/

// Normative fold, duplicated byte for byte by apps/app/src/search.js. No
// Unicode property escapes (the app avoids them).
function foldText (s) {
  try {
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  } catch {
    return ''
  }
}

// Distinct whole tokens of `s` in first-seen order.
function tokensOf (s) {
  const out = []
  const seen = new Set()
  for (const run of foldText(s).split(/[^a-z0-9]+/)) {
    if (run.length < MIN_TOKEN || run.length > MAX_TOKEN || seen.has(run)) continue
    seen.add(run)
    out.push(run)
  }
  return out
}

// Same clamp as engagement-index.js atMillis: a pre-1970 or unparsable date
// becomes 0 so that every entry has a cursor the route grammar can carry.
function atMillis (at) {
  const ms = typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

// Newest first: atMs DESC, then author ASC, then seq DESC.
function compareNewestFirst (a, b) {
  if (a.atMs !== b.atMs) return a.atMs > b.atMs ? -1 : 1
  if (a.author !== b.author) return a.author < b.author ? -1 : 1
  return b.seq - a.seq
}

// Storage order of a posting list: oldest at index 0, newest at the end.
function compareStored (a, b) {
  return compareNewestFirst(b, a)
}

function entryCursor (entry) {
  return entry.atMs + '.' + entry.author + '.' + entry.seq
}

// null/undefined -> null (start); a well-formed cursor -> its key; anything
// else -> undefined (malformed).
function parseSearchCursor (cursor) {
  if (cursor === null || cursor === undefined) return null
  if (typeof cursor !== 'string') return undefined
  const m = CURSOR_RE.exec(cursor)
  if (m === null) return undefined
  const atMs = Number(m[1])
  const seq = Number(m[3])
  if (!Number.isSafeInteger(atMs) || !Number.isSafeInteger(seq)) return undefined
  return { atMs, author: m[2], seq }
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// Binary search in an ascending array of strings.
function hasToken (sorted, tok) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] < tok) lo = mid + 1
    else hi = mid
  }
  return lo < sorted.length && sorted[lo] === tok
}

// Length of the low-end prefix of `list` (stored order) whose entries come
// strictly after `key` in newest-first order (i.e. are older than the key).
function olderPrefix (list, key) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareNewestFirst(list[mid], key) > 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

function validQuery (tokens) {
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > MAX_QUERY_TOKENS) return false
  const seen = new Set()
  for (const tok of tokens) {
    if (typeof tok !== 'string' || !TOKEN_RE.test(tok) || seen.has(tok)) return false
    seen.add(tok)
  }
  return true
}

function option (value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

// A flat copy of an ASCII token (header comment, Memory): built from char
// codes, so it shares no storage with the folded text it was cut from.
function flatKey (tok) {
  return String.fromCharCode.apply(null, Array.from(tok, (c) => c.charCodeAt(0)))
}

// Index of the first entry of `list` (stored order) dated more than
// MAX_FUTURE_MS after `at`. atMs is the primary sort key, so the entries at
// or before the limit form a prefix of this length.
function notFuturePrefix (list, at) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid].atMs - at <= MAX_FUTURE_MS) lo = mid + 1
    else hi = mid
  }
  return lo
}

function createSearchIndex ({ maxPosts, perAuthorMax, maxTerms, maxPostings, perAuthorPostingsMax, perAuthorTermsMax, onFreed = null } = {}) {
  const postCap = option(maxPosts, DEFAULT_MAX_POSTS)
  const authorCap = option(perAuthorMax, DEFAULT_PER_AUTHOR_MAX)
  const termCap = option(maxTerms, DEFAULT_MAX_TERMS)
  const postingCap = option(maxPostings, DEFAULT_MAX_POSTINGS)
  const authorPostingCap = option(perAuthorPostingsMax, DEFAULT_PER_AUTHOR_POSTINGS_MAX)
  const authorTermCap = option(perAuthorTermsMax, DEFAULT_PER_AUTHOR_TERMS_MAX)
  // author -> Map<seq, entry>
  const posts = new Map()
  // author -> { postings, created }: the slots its entries hold and the
  // terms its accepted posts introduced (header comment, Fairness). Gone
  // with removeDiary.
  const usage = new Map()
  // canonical key -> { key, list }: `key` is the flat copy (flatKey) used
  // as this Map's key, in entry.tokens and in `dirty`; `list` holds the
  // entries in stored order (see compareStored), unless dirty
  const terms = new Map()
  // canonical keys whose list may be out of order since the last query
  // touching it
  const dirty = new Set()
  let postCount = 0
  let postings = 0
  let fullAuthors = 0
  // Sticky: a capacity refusal happened and nothing has been freed since.
  // Saturation must report every refusal, even one whose cap is not reached
  // (a two-token post refused one slot short of maxPostings).
  let refused = false

  function freed () {
    // A notification cannot turn an already committed mutation into failure.
    try { if (typeof onFreed === 'function') onFreed() } catch {}
  }

  function add (author, seq, record) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author)) return false
      if (!Number.isSafeInteger(seq) || seq < 1) return false
      if (seq > MAX_SEQ) {
        // A capacity-like refusal (the seeder pauses this cursor): reported
        // through stats().saturated like any other.
        refused = true
        return false
      }
      if (!isPlainObject(record) || record.type !== 'post') return true
      const text = record.text
      if (typeof text !== 'string') return true
      const toks = tokensOf(text)
      if (toks.length === 0) return true
      const own = posts.get(author)
      if (own !== undefined && own.has(seq)) return true
      // Every read of the record happens before any mutation (a throwing
      // getter must leave the index untouched).
      const atMs = atMillis(record.at)
      // Admission before any mutation.
      let newTerms = 0
      for (const tok of toks) if (!terms.has(tok)) newTerms++
      const ownCount = own === undefined ? 0 : own.size
      const use = usage.get(author)
      const ownPostings = use === undefined ? 0 : use.postings
      const ownCreated = use === undefined ? 0 : use.created
      if (postCount >= postCap || ownCount >= authorCap ||
          postings + toks.length > postingCap || terms.size + newTerms > termCap ||
          ownPostings + toks.length > authorPostingCap ||
          ownCreated + newTerms > authorTermCap) {
        refused = true
        return false
      }
      // Canonicalize (header comment, Memory): only flat keys are stored.
      const recs = []
      for (const tok of toks) {
        let rec = terms.get(tok)
        if (rec === undefined) {
          const key = flatKey(tok)
          rec = { key, list: [] }
          terms.set(key, rec)
        }
        recs.push(rec)
      }
      const entry = { atMs, author, seq, tokens: recs.map((r) => r.key).sort() }
      for (const rec of recs) {
        const list = rec.list
        if (list.length > 0 && compareStored(list[list.length - 1], entry) > 0) dirty.add(rec.key)
        list.push(entry)
      }
      if (own === undefined) posts.set(author, new Map([[seq, entry]]))
      else own.set(seq, entry)
      if (use === undefined) usage.set(author, { postings: toks.length, created: newTerms })
      else {
        use.postings += toks.length
        use.created += newTerms
      }
      postCount++
      postings += toks.length
      if (ownCount + 1 === authorCap) fullAuthors++
      return true
    } catch {
      return false
    }
  }

  function removeDiary (author) {
    try {
      const own = posts.get(author)
      if (own === undefined) return false
      const used = new Set()
      let slots = 0
      for (const entry of own.values()) {
        slots += entry.tokens.length
        for (const tok of entry.tokens) used.add(tok)
      }
      for (const tok of used) {
        const rec = terms.get(tok)
        if (rec === undefined) continue
        const kept = rec.list.filter((e) => e.author !== author)
        if (kept.length === 0) {
          terms.delete(tok)
          dirty.delete(tok)
        } else {
          rec.list = kept
        }
      }
      if (own.size >= authorCap) fullAuthors--
      posts.delete(author)
      usage.delete(author)
      postCount -= own.size
      postings -= slots
      refused = false
      freed()
      return true
    } catch {
      return false
    }
  }

  function search (tokens, cursor = null, visible = () => true, now = Date.now()) {
    try {
      if (!validQuery(tokens)) return null
      const key = parseSearchCursor(cursor)
      if (key === undefined) return null
      const isVisible = typeof visible === 'function' ? visible : () => true
      const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
      const lists = []
      for (const tok of tokens) {
        const rec = terms.get(tok)
        if (rec === undefined) return { items: [], next: null }
        if (dirty.has(rec.key)) {
          rec.list.sort(compareStored)
          dirty.delete(rec.key)
        }
        lists.push(rec.list)
      }
      // Entries dated beyond the future limit sit at the newest end; skip
      // them by binary search so they never consume the SEARCH_SCAN budget,
      // and pick the list with the fewest entries IN RANGE (hidden future
      // posts must not steer a multi-word query onto a long list).
      const ranges = lists.map((l) => notFuturePrefix(l, at))
      let pick = 0
      for (let i = 1; i < lists.length; i++) if (ranges[i] < ranges[pick]) pick = i
      const list = lists[pick]
      const others = tokens.filter((_, i) => i !== pick)
      const inRange = ranges[pick]
      if (inRange === 0) return { items: [], next: null }
      const start = Math.min(key === null ? list.length - 1 : olderPrefix(list, key) - 1, inRange - 1)
      const items = []
      let examined = 0
      let last = -1
      for (let i = start; i >= 0 && items.length < SEARCH_PAGE && examined < SEARCH_SCAN; i--) {
        const entry = list[i]
        examined++
        last = i
        if (entry.atMs - at > MAX_FUTURE_MS) continue
        let ok = true
        for (const tok of others) {
          if (!hasToken(entry.tokens, tok)) { ok = false; break }
        }
        if (!ok) continue
        let shown = false
        try { shown = isVisible(entry.author) === true } catch { shown = false }
        if (shown) items.push(entry.author + ':' + entry.seq)
      }
      const next = last > 0 ? entryCursor(list[last]) : null
      return { items, next }
    } catch {
      return null
    }
  }

  function stats () {
    return {
      posts: postCount,
      terms: terms.size,
      postings,
      saturated: postCount >= postCap || terms.size >= termCap || postings >= postingCap ||
        authorCap === 0 || fullAuthors > 0 || refused,
      maxPosts: postCap
    }
  }

  function clear () {
    posts.clear()
    usage.clear()
    terms.clear()
    dirty.clear()
    postCount = 0
    postings = 0
    fullAuthors = 0
    refused = false
  }

  return { add, removeDiary, search, stats, clear }
}

module.exports = {
  foldText,
  tokensOf,
  createSearchIndex,
  compareNewestFirst,
  parseSearchCursor,
  SEARCH_PAGE,
  SEARCH_SCAN,
  MIN_TOKEN,
  MAX_TOKEN,
  MAX_QUERY_TOKENS,
  MAX_FUTURE_MS,
  QUERY_RE,
  CURSOR_RE,
  DEFAULT_MAX_POSTS,
  DEFAULT_PER_AUTHOR_MAX,
  DEFAULT_MAX_TERMS,
  DEFAULT_MAX_POSTINGS,
  DEFAULT_PER_AUTHOR_POSTINGS_MAX,
  DEFAULT_PER_AUTHOR_TERMS_MAX
}
