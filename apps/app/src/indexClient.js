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
//    fresh copy of only the validated values is returned;
// 5. every request, retries included, goes through one module scheduler:
//    at most 2 in flight and 18 starts per rolling 10 s, under Caddy's
//    `index` zone (20 per 10 s per address) so a busy screen queues instead
//    of tripping 429s; a 429 anyway sets one shared cooldown (Retry-After,
//    honoured in full) during which nothing reaches the network.
//
// Result convention (never throws): `{ ok: true, value }` or
// `{ ok: false, reason }`, reason one of 'invalid-input', 'network',
// 'timeout', 'not-found' (404: not indexed, or author not served),
// 'status', 'too-large', 'malformed', or 'rate-limited' (then with a
// numeric `retryAfterMs`: the cooldown still left). The URL builders return
// null for bad input. Every fetch function takes injectable deps
// `{ fetch, timeoutMs, now, setTimeout, clearTimeout, sleep }`; the clock
// ones drive the queue, the cooldown, the cache TTL and the 8 s timeout.
//
// Routes: GET /index/post/<author>/<seq>[/<cursor>], /index/counts/<refs>,
// /index/member/<author>[/<before>] and /index/search/<segment>. The search
// segment arrives already folded by the caller (1..4 tokens [a-z0-9]{1,20}
// joined by '-', at least 2 characters in all); it is checked here, never
// folded, lowercased or trimmed.

export const MAX_BODY_BYTES = 65536
export const TIMEOUT_MS = 8000
export const COUNTS_MAX = 31
export const REPLIES_MAX = 50
export const QUOTES_MAX = 50
export const POSTS_MAX = 100
export const SEARCH_MAX = 20
export const MAX_IN_FLIGHT = 2
export const WINDOW_MS = 10000
export const MAX_STARTS = 18
export const MAX_RETRIES = 3
export const DEADLINE_MS = 45000
export const DEFAULT_RETRY_AFTER_MS = 10000
export const MAX_COOLDOWN_MS = 600000
export const MEMBER_TTL_MS = 300000
export const MEMBER_CACHE_MAX = 256

const HEX64 = /^[0-9a-f]{64}$/
const REF = /^([0-9a-f]{64}):([1-9][0-9]*)$/
const CURSOR = /^[0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}$/
const SEGMENT = /^[a-z0-9]{1,20}(?:-[a-z0-9]{1,20}){0,3}$/

const POST_KEYS = ['authors', 'complete', 'indexing', 'likes', 'next', 'parent', 'quotes', 'quotesTotal', 'ref', 'replies', 'repliesTotal', 'reposts']
const COUNTS_KEYS = ['complete', 'counts', 'indexing']
const COUNT_KEYS = ['likes', 'quotes', 'replies', 'reposts']
const MEMBER_KEYS = ['complete', 'indexing', 'length', 'posts', 'postsTotal', 'profileSeq', 'usernameSeq']
const HINT_KEYS = ['profileSeq', 'usernameSeq']
const SEARCH_KEYS = ['complete', 'indexing', 'members', 'more']
const HIT_KEYS = ['author', 'profileSeq', 'usernameSeq']

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

// `segment` is already folded by the caller; it is only checked here.
export function searchUrl (segment) {
  if (typeof segment !== 'string' || !SEGMENT.test(segment)) return null
  if (segment.replace(/-/g, '').length < 2) return null
  return '/index/search/' + segment
}

// --- transport ---

function cancelBody (res) {
  try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}) } catch {}
}

class Failure extends Error {
  constructor (reason, retryAfterMs = 0) {
    super(reason)
    this.reason = reason
    this.retryAfterMs = retryAfterMs
  }
}

// Retry-After as delta-seconds or an HTTP date -> ms (>= 0). Missing or
// unparsable: 10 s. A valid value is never shortened; only absurd ones are
// capped (10 min). A date needs letters: Date.parse would take '1.5' as one.
export function parseRetryAfter (value, now = Date.now()) {
  if (typeof value !== 'string') return DEFAULT_RETRY_AFTER_MS
  const v = value.trim()
  let ms
  if (/^[0-9]+$/.test(v)) {
    ms = Number(v) * 1000
  } else if (/[a-z]/i.test(v)) {
    const at = Date.parse(v)
    if (!Number.isFinite(at)) return DEFAULT_RETRY_AFTER_MS
    ms = at - now
  } else {
    return DEFAULT_RETRY_AFTER_MS
  }
  if (!Number.isFinite(ms)) return MAX_COOLDOWN_MS
  return Math.min(Math.max(ms, 0), MAX_COOLDOWN_MS)
}

function header (res, name) {
  try {
    const h = res && res.headers
    const v = h && typeof h.get === 'function' ? h.get(name) : null
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

// --- clock (injectable; the queue, cooldown, TTL and timeout all use it) ---

function makeClock (deps) {
  const now = typeof deps.now === 'function' ? () => deps.now() : () => Date.now()
  if (typeof deps.setTimeout === 'function') {
    const clear = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : () => {}
    return { now, setTimeout: (fn, ms) => deps.setTimeout(fn, ms), clearTimeout: (id) => clear(id) }
  }
  if (typeof deps.sleep === 'function') {
    // sleep has no cancel: a cleared timer just ignores its wake-up.
    return {
      now,
      setTimeout: (fn, ms) => {
        const t = { live: true }
        Promise.resolve(deps.sleep(ms)).then(() => { if (t.live) fn() }, () => {})
        return t
      },
      clearTimeout: (t) => { if (t) t.live = false }
    }
  }
  return { now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) }
}

// --- scheduler: one queue shared by every fetch* call ---
// FIFO waiters; the head starts when no cooldown is running, fewer than
// MAX_IN_FLIGHT requests are out and fewer than MAX_STARTS started in the
// last WINDOW_MS. Waiting here never counts against the 8 s attempt timeout,
// only against the call's 45 s deadline.

let gen = 0
let queue = []
let inFlight = 0
let starts = []
let cooldownUntil = 0
let pumpTimer = null

function prune (now) {
  while (starts.length > 0 && starts[0] <= now - WINDOW_MS) starts.shift()
}

// What a rate-limited result reports: the cooldown left, else the time until
// the window frees a start.
function retryAfter (now) {
  if (cooldownUntil > now) return cooldownUntil - now
  prune(now)
  return starts.length >= MAX_STARTS ? Math.max(0, starts[0] + WINDOW_MS - now) : 0
}

function disarmPump () {
  if (pumpTimer) {
    pumpTimer.clock.clearTimeout(pumpTimer.id)
    pumpTimer = null
  }
}

function armPump (clock, ms) {
  disarmPump()
  const t = { clock, id: null }
  pumpTimer = t
  t.id = clock.setTimeout(() => {
    if (pumpTimer !== t) return
    pumpTimer = null
    pump()
  }, Math.max(0, ms))
}

function drop (w) {
  const i = queue.indexOf(w)
  if (i !== -1) queue.splice(i, 1)
  if (w.timer !== null) {
    w.clock.clearTimeout(w.timer)
    w.timer = null
  }
}

function fail (w, now) {
  drop(w)
  w.reject(new Failure('rate-limited', retryAfter(now)))
}

function pump () {
  while (queue.length > 0) {
    const head = queue[0]
    const now = head.clock.now()
    if (cooldownUntil > now) {
      // A waiter whose deadline falls inside the cooldown fails now instead
      // of sleeping to its deadline for nothing.
      for (const w of queue.slice()) if (cooldownUntil > w.deadline) fail(w, now)
      if (queue[0] !== head) continue
      armPump(head.clock, cooldownUntil - now)
      return
    }
    if (inFlight >= MAX_IN_FLIGHT) return // a release pumps again
    prune(now)
    if (starts.length >= MAX_STARTS) {
      armPump(head.clock, starts[0] + WINDOW_MS - now)
      return
    }
    drop(head)
    inFlight++
    starts.push(now)
    head.resolve(releaser())
  }
  disarmPump()
}

function releaser () {
  const g = gen
  let done = false
  return () => {
    if (done || g !== gen) return
    done = true
    inFlight--
    pump()
  }
}

// -> a release function once the request may start; rejects with a
// rate-limited Failure past `deadline`.
function acquire (clock, deadline) {
  return new Promise((resolve, reject) => {
    const w = { clock, deadline, resolve, reject, timer: null }
    queue.push(w)
    pump()
    if (!queue.includes(w)) return
    w.timer = clock.setTimeout(() => {
      w.timer = null
      if (!queue.includes(w)) return
      fail(w, clock.now())
      pump()
    }, Math.max(0, deadline - clock.now()))
  })
}

// Tests only: forgets the queue, pacer, cooldown and member cache.
export function resetIndexClient () {
  gen++
  disarmPump()
  for (const w of queue) if (w.timer !== null) w.clock.clearTimeout(w.timer)
  queue = []
  inFlight = 0
  starts = []
  cooldownUntil = 0
  memberCache.clear()
  memberInflight.clear()
  memberEpochs.clear()
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

// One network attempt (a scheduler slot already held) -> the parsed JSON
// body; throws Failure. The timeout starts here, never while queued.
async function attempt (url, deps, clock) {
  const get = deps.fetch || ((...args) => fetch(...args))
  const timeoutMs = Number.isSafeInteger(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : TIMEOUT_MS
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = clock.setTimeout(() => {
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
    if (res && res.status === 429 && res.redirected !== true) {
      const delay = parseRetryAfter(header(res, 'Retry-After'), clock.now())
      cancelBody(res)
      throw new Failure('rate-limited', delay)
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
    clock.clearTimeout(timer)
  }
}

// -> the parsed JSON body; throws Failure. A 429 extends the shared cooldown
// (never shortens it) and the attempt is retried up to MAX_RETRIES times
// through the scheduler, all within DEADLINE_MS of the call; a cooldown that
// outlasts the deadline fails at once with the time it still has to run.
async function getJson (url, deps = {}) {
  const clock = makeClock(deps)
  const deadline = clock.now() + DEADLINE_MS
  const g = gen
  for (let retries = 0; ; retries++) {
    const release = await acquire(clock, deadline)
    try {
      return await attempt(url, deps, clock)
    } catch (err) {
      if (!(err instanceof Failure) || err.reason !== 'rate-limited') throw err
      const now = clock.now()
      if (g === gen) cooldownUntil = Math.max(cooldownUntil, now + err.retryAfterMs)
      if (retries >= MAX_RETRIES || cooldownUntil > deadline) throw new Failure('rate-limited', retryAfter(now))
    } finally {
      release()
    }
  }
}

async function run (url, validate, deps) {
  if (url === null) return { ok: false, reason: 'invalid-input' }
  let body
  try {
    body = await getJson(url, deps)
  } catch (err) {
    if (err instanceof Failure && err.reason === 'rate-limited') return { ok: false, reason: 'rate-limited', retryAfterMs: err.retryAfterMs }
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

// Members: <= 20 distinct authors with exact keys, order kept (the seeder's
// ranking), never both hints null.
export function validSearch (body) {
  if (!hasExactKeys(body, SEARCH_KEYS)) return null
  if (typeof body.complete !== 'boolean' || typeof body.indexing !== 'boolean' || typeof body.more !== 'boolean') return null
  const list = body.members
  if (!Array.isArray(list) || list.length > SEARCH_MAX) return null
  const seen = new Set()
  const members = []
  for (const m of list) {
    if (!hasExactKeys(m, HIT_KEYS) || !isHex64(m.author) || seen.has(m.author)) return null
    if (!isHint(m.profileSeq) || !isHint(m.usernameSeq)) return null
    if (m.profileSeq === null && m.usernameSeq === null) return null
    seen.add(m.author)
    members.push({ author: m.author, profileSeq: m.profileSeq, usernameSeq: m.usernameSeq })
  }
  return { members, more: body.more, indexing: body.indexing, complete: body.complete }
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

// --- member cache ---
// Only complete successful member pages are cached (5 min, 256 entries,
// oldest dropped), keyed by lowercase author + before; callers always get
// fresh copies. Concurrent asks for one key share one request. Failures,
// incomplete pages, counts and post pages are never cached. invalidateMember
// bumps the author's epoch so a request already out cannot refill it.

const memberCache = new Map()
const memberInflight = new Map()
const memberEpochs = new Map()

function copyMember (v) {
  return { ...v, posts: v.posts.slice() }
}

function copyResult (res) {
  return res.ok ? { ok: true, value: copyMember(res.value) } : { ...res }
}

function cacheMember (key, value, at) {
  memberCache.delete(key)
  memberCache.set(key, { at, value: copyMember(value) })
  while (memberCache.size > MEMBER_CACHE_MAX) memberCache.delete(memberCache.keys().next().value)
}

// Membro's refresh: the next fetchMember for `author` goes to the index.
// Leaves the pacer and the cooldown alone.
export function invalidateMember (author) {
  const a = inputAuthor(author)
  if (a === null) return
  memberEpochs.set(a, (memberEpochs.get(a) || 0) + 1)
  const prefix = a + '/'
  for (const k of [...memberCache.keys()]) if (k.startsWith(prefix)) memberCache.delete(k)
  for (const k of [...memberInflight.keys()]) if (k.startsWith(prefix)) memberInflight.delete(k)
}

export function fetchMember (author, before = null, deps = {}) {
  const url = memberUrl(author, before)
  const validate = (body) => validMemberIndex(body, before)
  if (url === null) return run(url, validate, deps)
  const a = inputAuthor(author)
  const key = a + '/' + (before === null ? '' : String(before))
  const clock = makeClock(deps)
  const hit = memberCache.get(key)
  if (hit) {
    const age = clock.now() - hit.at
    if (age >= 0 && age < MEMBER_TTL_MS) return Promise.resolve({ ok: true, value: copyMember(hit.value) })
    memberCache.delete(key)
  }
  let p = memberInflight.get(key)
  if (!p) {
    const g = gen
    const epoch = memberEpochs.get(a) || 0
    p = run(url, validate, deps).then((res) => {
      if (memberInflight.get(key) === p) memberInflight.delete(key)
      if (res.ok && res.value.complete === true && g === gen && (memberEpochs.get(a) || 0) === epoch) {
        cacheMember(key, res.value, clock.now())
      }
      return res
    })
    memberInflight.set(key, p)
  }
  return p.then(copyResult)
}

export function fetchSearch (segment, deps = {}) {
  return run(searchUrl(segment), validSearch, deps)
}
