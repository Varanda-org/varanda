/* global fetch, AbortController, TextDecoder */

// Client for the seeder index (hosted web only; same origin, served by the
// seeder under /index/*). The index only says where to look (refs, seq hints)
// and how many (counts): every post, name or bio shown is still fetched and
// verified by the node (diary.peek). Its JSON is untrusted, so:
// 1. refs, authors, cursors and seqs are validated before any URL is built
//    (refs and authors are lowercased first; nothing else reaches the path);
// 2. the request omits credentials, refuses redirects, bypasses the HTTP
//    cache and times out after 8 s (AbortController, plus a race in case the
//    fetch ignores the signal);
// 3. only an exact 200 is accepted, and the body is read with a hard cap of
//    65536 bytes (more stops the read and fails);
// 4. the JSON must match the contract's exact key sets and limits, and a
//    fresh copy of only the validated values is returned.
//
// Routes: /index/post/<author>/<seq>[/<cursor>], /index/counts/<ref>,...,
// /index/member/<author>[/<before>] and /index/search/<tokens>[/<cursor>].
// The search tokens are already folded words of [a-z0-9] (2..32 chars, at
// most 8) joined by a literal '+' (apps/app/src/search.js searchPath): this
// module only checks them against the same strict pattern, never folds and
// never percent-encodes them (encodeURIComponent would turn '+' into '%2B',
// which the seeder's raw-URL match refuses).
//
// Result convention (never throws): `{ ok: true, value }` or
// `{ ok: false, reason }`, reason one of 'invalid-input', 'network',
// 'timeout', 'not-found' (404: not indexed, or author not served; on the
// search route: a seeder without that route, or a malformed path — an
// unknown word is a 200 with an empty list), 'status', 'too-large',
// 'malformed'. The URL builders return null for bad input. Every fetch
// function takes injectable deps `{ fetch, timeoutMs }`.

export const MAX_BODY_BYTES = 65536
export const TIMEOUT_MS = 8000
export const COUNTS_MAX = 31
export const REPLIES_MAX = 50
export const QUOTES_MAX = 50
export const POSTS_MAX = 100
export const SEARCH_MAX = 30

const HEX64 = /^[0-9a-f]{64}$/
const REF = /^([0-9a-f]{64}):([1-9][0-9]*)$/
const CURSOR = /^[0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}$/
// 1..8 folded tokens of 2..32 [a-z0-9] chars joined by a literal '+'.
const QUERY = /^[a-z0-9]{2,32}(?:\+[a-z0-9]{2,32}){0,7}$/

const POST_KEYS = ['authors', 'complete', 'indexing', 'likes', 'next', 'parent', 'quotes', 'quotesTotal', 'ref', 'replies', 'repliesTotal', 'reposts']
const COUNTS_KEYS = ['complete', 'counts', 'indexing']
const COUNT_KEYS = ['likes', 'quotes', 'replies', 'reposts']
const MEMBER_KEYS = ['complete', 'indexing', 'length', 'posts', 'postsTotal', 'profileSeq', 'usernameSeq']
const HINT_KEYS = ['profileSeq', 'usernameSeq']
const SEARCH_KEYS = ['authors', 'complete', 'indexing', 'items', 'next']

// --- strict checks (response values are never lowercased or coerced) ---

export function isRef (s) {
  if (typeof s !== 'string') return false
  const m = REF.exec(s)
  if (!m) return false
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) && String(seq) === m[2]
}

export function isCursor (s) {
  return typeof s === 'string' && CURSOR.test(s)
}

const isHex64 = (s) => typeof s === 'string' && HEX64.test(s)
const isCount = (n) => Number.isSafeInteger(n) && n >= 0
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const isHint = (n) => n === null || isSeq(n)

function isPlain (o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (o, keys) {
  if (!isPlain(o)) return false
  const got = Object.keys(o).sort()
  return got.length === keys.length && got.every((k, i) => k === keys[i])
}

// A list of distinct valid refs within `max`, or null.
function refList (v, max) {
  if (!Array.isArray(v) || v.length > max) return null
  const seen = new Set()
  for (const r of v) {
    if (!isRef(r) || seen.has(r)) return null
    seen.add(r)
  }
  return v.slice()
}

// --- input normalisation (lowercase, then the strict check) ---

function inputRef (ref) {
  if (typeof ref !== 'string') return null
  const lower = ref.toLowerCase()
  return isRef(lower) ? lower : null
}

function inputAuthor (author) {
  if (typeof author !== 'string') return null
  const lower = author.toLowerCase()
  return isHex64(lower) ? lower : null
}

// --- URL builders ---

export function postUrl (ref, cursor = null) {
  const r = inputRef(ref)
  if (r === null) return null
  if (cursor !== null && !isCursor(cursor)) return null
  const [author, seq] = r.split(':')
  return '/index/post/' + author + '/' + seq + (cursor === null ? '' : '/' + cursor)
}

// Duplicates are dropped (first occurrence kept); 1..31 distinct refs.
export function countsUrl (refs) {
  const list = countsInput(refs)
  return list === null ? null : '/index/counts/' + list.join(',')
}

function countsInput (refs) {
  if (!Array.isArray(refs)) return null
  const out = []
  for (const ref of refs) {
    const r = inputRef(ref)
    if (r === null) return null
    if (!out.includes(r)) out.push(r)
  }
  return out.length >= 1 && out.length <= COUNTS_MAX ? out : null
}

export function memberUrl (author, before = null) {
  const a = inputAuthor(author)
  if (a === null) return null
  if (before !== null && !isSeq(before)) return null
  return '/index/member/' + a + (before === null ? '' : '/' + before)
}

// `path`: tokens already folded and joined by search.js searchPath. Checked
// as is (no folding, no lowercasing, no encoding): anything outside QUERY is
// refused, so nothing but [a-z0-9+] reaches the URL.
export function searchUrl (path, cursor = null) {
  if (typeof path !== 'string' || !QUERY.test(path)) return null
  if (cursor !== null && !isCursor(cursor)) return null
  return '/index/search/' + path + (cursor === null ? '' : '/' + cursor)
}

// --- transport ---

function cancelBody (res) {
  try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}) } catch {}
}

class Failure extends Error {
  constructor (reason) {
    super(reason)
    this.reason = reason
  }
}

// Reads at most `cap` bytes; more bytes cancel the read and fail.
export async function readBody (res, cap = MAX_BODY_BYTES) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    if (typeof res.arrayBuffer !== 'function') throw new Failure('malformed')
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > cap) throw new Failure('too-large')
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!(value instanceof Uint8Array)) {
      try { reader.cancel().catch(() => {}) } catch {}
      throw new Failure('malformed')
    }
    total += value.byteLength
    if (total > cap) {
      try { reader.cancel().catch(() => {}) } catch {}
      throw new Failure('too-large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

// -> the parsed JSON body; throws Failure.
async function getJson (url, deps = {}) {
  const get = deps.fetch || ((...args) => fetch(...args))
  const timeoutMs = Number.isSafeInteger(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : TIMEOUT_MS
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (ctrl) ctrl.abort()
      reject(new Failure('timeout'))
    }, timeoutMs)
  })
  timeout.catch(() => {})
  const work = (async () => {
    let res
    try {
      res = await get(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: ctrl ? ctrl.signal : undefined
      })
    } catch {
      throw new Failure('network')
    }
    if (!res || res.status !== 200 || res.redirected === true) {
      cancelBody(res)
      throw new Failure(res && res.status === 404 && res.redirected !== true ? 'not-found' : 'status')
    }
    let bytes
    try {
      bytes = await readBody(res)
    } catch (err) {
      throw err instanceof Failure ? err : new Failure('network')
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new Failure('malformed')
    }
  })()
  work.catch(() => {})
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function run (url, validate, deps) {
  if (url === null) return { ok: false, reason: 'invalid-input' }
  let body
  try {
    body = await getJson(url, deps)
  } catch (err) {
    return { ok: false, reason: err instanceof Failure ? err.reason : 'network' }
  }
  let value = null
  try { value = validate(body) } catch { value = null }
  return value === null ? { ok: false, reason: 'malformed' } : { ok: true, value }
}

// --- response validators (each returns a fresh copy or null) ---

function validAuthors (o) {
  if (!isPlain(o)) return null
  const keys = Object.keys(o)
  if (keys.length > 2 + REPLIES_MAX + QUOTES_MAX) return null
  const out = {}
  for (const k of keys) {
    const h = o[k]
    if (!isHex64(k) || !hasExactKeys(h, HINT_KEYS) || !isHint(h.profileSeq) || !isHint(h.usernameSeq)) return null
    out[k] = { profileSeq: h.profileSeq, usernameSeq: h.usernameSeq }
  }
  return out
}

export function validPostIndex (body, ref) {
  if (!hasExactKeys(body, POST_KEYS)) return null
  if (!isRef(body.ref) || (ref !== undefined && body.ref !== ref)) return null
  if (body.parent !== null && !isRef(body.parent)) return null
  if (body.next !== null && !isCursor(body.next)) return null
  const replies = refList(body.replies, REPLIES_MAX)
  const quotes = refList(body.quotes, QUOTES_MAX)
  if (replies === null || quotes === null) return null
  for (const k of ['likes', 'reposts', 'repliesTotal', 'quotesTotal']) if (!isCount(body[k])) return null
  if (typeof body.indexing !== 'boolean' || typeof body.complete !== 'boolean') return null
  const authors = validAuthors(body.authors)
  if (authors === null) return null
  return {
    ref: body.ref,
    parent: body.parent,
    replies,
    next: body.next,
    quotes,
    likes: body.likes,
    reposts: body.reposts,
    repliesTotal: body.repliesTotal,
    quotesTotal: body.quotesTotal,
    authors,
    indexing: body.indexing,
    complete: body.complete
  }
}

// `asked`: the requested refs; a ref outside them is refused.
export function validCounts (body, asked) {
  if (!hasExactKeys(body, COUNTS_KEYS) || !isPlain(body.counts)) return null
  if (typeof body.indexing !== 'boolean' || typeof body.complete !== 'boolean') return null
  const counts = {}
  for (const ref of Object.keys(body.counts)) {
    const c = body.counts[ref]
    if (!isRef(ref) || (asked && !asked.includes(ref))) return null
    if (!hasExactKeys(c, COUNT_KEYS) || !COUNT_KEYS.every((k) => isCount(c[k]))) return null
    counts[ref] = { replies: c.replies, likes: c.likes, reposts: c.reposts, quotes: c.quotes }
  }
  if (Object.keys(counts).length > COUNTS_MAX) return null
  return { counts, indexing: body.indexing, complete: body.complete }
}

// Posts: <= 100 seqs, strictly descending, each below `length` and below
// `before` when given.
export function validMemberIndex (body, before = null) {
  if (!hasExactKeys(body, MEMBER_KEYS)) return null
  if (!isCount(body.length) || !isCount(body.postsTotal)) return null
  if (!isHint(body.profileSeq) || !isHint(body.usernameSeq)) return null
  if (typeof body.indexing !== 'boolean' || typeof body.complete !== 'boolean') return null
  const posts = body.posts
  if (!Array.isArray(posts) || posts.length > POSTS_MAX) return null
  let prev = before === null ? Infinity : before
  for (const seq of posts) {
    if (!isSeq(seq) || seq >= prev || seq >= body.length) return null
    prev = seq
  }
  return {
    length: body.length,
    profileSeq: body.profileSeq,
    usernameSeq: body.usernameSeq,
    posts: posts.slice(),
    postsTotal: body.postsTotal,
    indexing: body.indexing,
    complete: body.complete
  }
}

// Items: <= 30 distinct refs (may be empty). Authors: exactly one hint per
// author of the items, no more and no fewer (an unrelated or missing hint
// means a confused or hostile index: refused whole).
export function validSearch (body) {
  if (!hasExactKeys(body, SEARCH_KEYS)) return null
  const items = refList(body.items, SEARCH_MAX)
  if (items === null) return null
  if (body.next !== null && !isCursor(body.next)) return null
  if (typeof body.indexing !== 'boolean' || typeof body.complete !== 'boolean') return null
  const authors = validAuthors(body.authors)
  if (authors === null) return null
  const wanted = new Set(items.map((r) => r.split(':')[0]))
  const got = Object.keys(authors)
  if (got.length !== wanted.size || !got.every((k) => wanted.has(k))) return null
  return { items, next: body.next, authors, indexing: body.indexing, complete: body.complete }
}

// --- fetchers ---

export function fetchPost (ref, cursor = null, deps = {}) {
  const url = postUrl(ref, cursor)
  const r = url === null ? null : inputRef(ref)
  return run(url, (body) => validPostIndex(body, r), deps)
}

export function fetchCounts (refs, deps = {}) {
  const asked = countsInput(refs)
  const url = asked === null ? null : '/index/counts/' + asked.join(',')
  return run(url, (body) => validCounts(body, asked), deps)
}

export function fetchMember (author, before = null, deps = {}) {
  return run(memberUrl(author, before), (body) => validMemberIndex(body, before), deps)
}

export function fetchSearch (path, cursor = null, deps = {}) {
  return run(searchUrl(path, cursor), validSearch, deps)
}
