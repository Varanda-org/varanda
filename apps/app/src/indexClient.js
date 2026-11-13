/* global fetch, AbortController, TextDecoder, __DEV__ */

import rpc from '@varanda/rpc'
import { isAppClient } from './appClient.js'
import { resolveUrl } from './installation.js'
import { vitrineEnabled } from './vitrine/enabled.js'

const VITRINE = vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: process.env.EXPO_PUBLIC_VARANDA_VITRINE }, typeof __DEV__ !== 'undefined' && __DEV__)
let vitrineIndex
if (VITRINE) {
  const { vitrineIndex: respond } = require('./vitrine/indexResponder')
  vitrineIndex = (url) => {
    try {
      return respond(url)
    } catch (err) {
      if (err.reason === 'not-found') throw new Failure('not-found')
      throw err
    }
  }
}

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
// Routes: /index/post/<author>/<seq>[/<cursor>], /index/counts/<ref>,...,
// /index/member/<author>[/<before>], /index/topic/<tokens>[/<cursor>],
// /index/likes/<author>/<seq>[/<cursor>] and
// /index/reposts/<author>/<seq>[/<cursor>]. Each likes or reposts item is the
// ref of a like or repost record, which the node still verifies (diary.peek).
// The search tokens are already folded words of [a-z0-9] (2..32 chars, at
// most 8) joined by a literal '+' (apps/app/src/topics.js searchPath): this
// module only checks them against the same strict pattern, never folds and
// never percent-encodes them (encodeURIComponent would turn '+' into '%2B',
// which the seeder's raw-URL match refuses).
//
// Result convention (never throws): `{ ok: true, value }` or
// `{ ok: false, reason }`, reason one of 'invalid-input', 'network',
// 'timeout', 'not-found' (404: not indexed, or author not served; on the
// topic route: a seeder without that route, or a malformed path: an
// unknown word is a 200 with an empty list), 'status', 'too-large',
// 'malformed', or 'rate-limited' (then with a numeric `retryAfterMs`: the
// cooldown still left). The URL builders return null for bad input. Every
// fetch function takes injectable deps
// `{ fetch, timeoutMs, now, setTimeout, clearTimeout, sleep }`; the clock
// ones drive the queue, the cooldown, the cache TTL and the 8 s timeout.
//
// Groups: /index/group/<G>[/<after>], /index/groups/<D>,
// /index/community/<C> and /index/group-search/<segment> (the segment as for
// the account search). Same transport, scheduler and budget; never cached.
//
// Follows (public): /index/follows/<author> (the two counts) and
// /index/follows/<author>/(seguindo|seguidores)[/<atMs>.<key>]. A
// 'seguidores' item points at the follower's follow block (key = follower),
// a 'seguindo' item at the author's own follow block (key = the followed
// target, seq in the author's diary); the node still verifies each one
// (diary.peek). Never cached: a follow can be undone at any time.
//
// Testimonials (public pointers only, never text): /index/testimonials/<owner>.
// A `shown` row names the owner's show block (seq) and the writer's block
// (from, wseq); a `pending` row a writer block not shown yet. The node still
// fetches and verifies every block (diary.peek). Never cached: a writer can
// revoke and the owner can remove at any time.
// Feira (docs/protocol.md section 15, "The seeder's Feira routes"):
// /index/feira/<uf>/<city>/<kind>/<cat>[/<words>][/<cursor>],
// /index/feira/autor/<D>[/<cursor>] and /index/feira/avaliacoes/<D>[/<cursor>].
// The UF is asked upper case and sent lower case (the seeder's route regex);
// the city key arrives already folded (@varanda/rpc feira.cityKey) and is
// only checked. Items are hints { ref, status, statusSeq, editSeq } (ratings:
// { ref }), never cached: a status or an edit can change at any time. A 404
// also means the installation has the Feira off.
//
// Account search, GET /index/search/<segment>: the segment arrives already
// folded by the caller (1..4 tokens [a-z0-9]{1,20} joined by '-', at least 2
// characters in all); it is checked here, never folded, lowercased or
// trimmed.

export const MAX_BODY_BYTES = 65536
export const TIMEOUT_MS = 8000
export const COUNTS_MAX = 31
export const REPLIES_MAX = 50
export const QUOTES_MAX = 50
export const POSTS_MAX = 100
export const SEARCH_MAX = 20
export const TOPIC_MAX = 30
// Must equal ENGAGER_PAGE in packages/core/lib/engagement-index.js.
export const ENGAGERS_MAX = 20
export const FOLLOWS_MAX = 20
export const GROUP_WRITERS_MAX = 64
export const GROUPS_MAX = 64
export const GROUP_SEARCH_MAX = 20
export const COMMUNITY_GROUPS_MAX = 32
export const TESTIMONIALS_MAX = 64
export const GROUP_NAME_MAX = 80
// Must equal PAGE in packages/core/lib/feira-index.js.
export const FEIRA_MAX = 30
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
// 1..8 folded tokens of 2..32 [a-z0-9] chars joined by a literal '+'.
const QUERY = /^[a-z0-9]{2,32}(?:\+[a-z0-9]{2,32}){0,7}$/

const POST_KEYS = ['authors', 'complete', 'indexing', 'likes', 'next', 'parent', 'quotes', 'quotesTotal', 'ref', 'replies', 'repliesTotal', 'reposts']
const COUNTS_KEYS = ['complete', 'counts', 'indexing']
const COUNT_KEYS = ['likes', 'quotes', 'replies', 'reposts']
const MEMBER_KEYS = ['complete', 'indexing', 'length', 'posts', 'postsTotal', 'profileSeq', 'usernameSeq']
const HINT_KEYS = ['profileSeq', 'usernameSeq']
const SEARCH_KEYS = ['complete', 'indexing', 'members', 'more']
const HIT_KEYS = ['author', 'profileSeq', 'usernameSeq']
const TOPIC_KEYS = ['authors', 'complete', 'indexing', 'items', 'next']
const GROUP_KEYS = ['attached', 'community', 'complete', 'creator', 'indexing', 'join', 'kind', 'name', 'next', 'rootServed', 'visibility', 'writers']
const WRITER_KEYS = ['diary', 'key', 'left', 'length', 'seq', 'signed']
// An older seeder sends no `signed`.
const WRITER_KEYS_OLD = ['diary', 'key', 'left', 'length', 'seq']
const GROUPS_KEYS = ['complete', 'groups', 'indexing']
const GROUPS_ROW_KEYS = ['group', 'left', 'seq', 'writer']
const GROUP_SEARCH_KEYS = ['complete', 'groups', 'indexing', 'more']
const GROUP_HIT_KEYS = ['group', 'name', 'writerCount']
const COMMUNITY_KEYS = ['complete', 'creator', 'groups', 'indexing', 'join', 'members', 'name', 'next']
const COMMUNITY_GROUPS_KEYS = ['complete', 'groups', 'indexing', 'next']
const COMMUNITY_ROW_KEYS = ['group', 'join', 'name', 'visibility', 'writerCount']
const ENGAGERS_KEYS = ['authors', 'complete', 'indexing', 'items', 'kind', 'next', 'ref', 'total']
const FOLLOW_COUNTS_KEYS = ['complete', 'indexing', 'seguidores', 'seguindo']
const FOLLOWS_KEYS = ['author', 'authors', 'complete', 'indexing', 'items', 'kind', 'next', 'total']
const FOLLOW_ITEM_KEYS = ['at', 'key', 'seq']
const FOLLOW_CURSOR_KEYS = ['atMs', 'key']
const TESTIMONIALS_KEYS = ['complete', 'indexing', 'pending', 'shown']
const SHOWN_KEYS = ['from', 'seq', 'wseq']
const PENDING_KEYS = ['from', 'seq']
const FEIRA_KEYS = ['authors', 'complete', 'indexing', 'items', 'next']
const FEIRA_ITEM_KEYS = ['editSeq', 'ref', 'status', 'statusSeq']
const FEIRA_RATING_KEYS = ['ref']
// packages/core/lib/feira-index.js CITY, with the 2..48 bound of cityKey.
const CITY_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

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
const isFollowKind = (k) => k === 'seguindo' || k === 'seguidores'

function isCanonicalIso (s) {
  if (typeof s !== 'string') return false
  const d = new Date(s)
  return !Number.isNaN(d.getTime()) && d.toISOString() === s
}

function isFollowCursor (c) {
  return hasExactKeys(c, FOLLOW_CURSOR_KEYS) && isCount(c.atMs) && isHex64(c.key)
}

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

// An older seeder sends no page hint; a newer one sends `page` and, for a
// page, `closed` and `moved`. Only booleans pass. Only a hint: Membro checks
// with page.read.
const PAGE_HINT_KEYS = ['closed', 'moved', 'page']

// -> { page, closed, moved } (absent = false), or null for a bad shape.
function pageHintOf (o, keys) {
  if (!isPlain(o)) return null
  const extra = []
  for (const k of Object.keys(o)) if (!keys.includes(k)) extra.push(k)
  if (extra.some((k) => !PAGE_HINT_KEYS.includes(k))) return null
  if (keys.some((k) => !Object.prototype.hasOwnProperty.call(o, k))) return null
  for (const k of PAGE_HINT_KEYS) if (k in o && typeof o[k] !== 'boolean') return null
  // No keys at all for a person: absent reads as false.
  return o.page === true ? { page: true, closed: o.closed === true, moved: o.moved === true } : {}
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
  return resolveUrl('/index/post/' + author + '/' + seq + (cursor === null ? '' : '/' + cursor))
}

// Duplicates are dropped (first occurrence kept); 1..31 distinct refs.
export function countsUrl (refs) {
  const list = countsInput(refs)
  return list === null ? null : resolveUrl('/index/counts/' + list.join(','))
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
  return resolveUrl('/index/member/' + a + (before === null ? '' : '/' + before))
}

// `path`: tokens already folded and joined by topics.js searchPath. Checked
// as is (no folding, no lowercasing, no encoding): anything outside QUERY is
// refused, so nothing but [a-z0-9+] reaches the URL.
export function topicUrl (path, cursor = null) {
  if (typeof path !== 'string' || !QUERY.test(path)) return null
  if (cursor !== null && !isCursor(cursor)) return null
  return resolveUrl('/index/topic/' + path + (cursor === null ? '' : '/' + cursor))
}

// `kind` is taken as is (never lowercased or trimmed). The seq is capped at
// 15 digits here because isRef alone allows up to MAX_SAFE_INTEGER (16).
export function engagersUrl (kind, ref, cursor = null) {
  if (kind !== 'likes' && kind !== 'reposts') return null
  const r = inputRef(ref)
  if (r === null) return null
  const [author, seq] = r.split(':')
  if (seq.length > 15) return null
  if (cursor !== null && !isCursor(cursor)) return null
  return resolveUrl('/index/' + kind + '/' + author + '/' + seq + (cursor === null ? '' : '/' + cursor))
}

export function followCountsUrl (author) {
  const a = inputAuthor(author)
  return a === null ? null : resolveUrl('/index/follows/' + a)
}

export function testimonialsUrl (owner) {
  const o = inputAuthor(owner)
  return o === null ? null : resolveUrl('/index/testimonials/' + o)
}

// An invalid cursor is null, never dropped: dropping it would silently
// restart the list from the top.
export function followsUrl (author, kind, cursor = null) {
  const a = inputAuthor(author)
  if (a === null || !isFollowKind(kind)) return null
  if (cursor !== null && !isFollowCursor(cursor)) return null
  return resolveUrl('/index/follows/' + a + '/' + kind + (cursor === null ? '' : '/' + cursor.atMs + '.' + cursor.key))
}

// `segment` is already folded by the caller; it is only checked here.
export function searchUrl (segment) {
  if (typeof segment !== 'string' || !SEGMENT.test(segment)) return null
  if (segment.replace(/-/g, '').length < 2) return null
  return resolveUrl('/index/search/' + segment)
}

// /index/group/<G>[/<after>]: both keys lowercased, then checked.
export function groupUrl (group, after = null) {
  const g = inputAuthor(group)
  if (g === null) return null
  let a = null
  if (after !== null) {
    a = inputAuthor(after)
    if (a === null) return null
  }
  return resolveUrl('/index/group/' + g + (a === null ? '' : '/' + a))
}

export function groupsUrl (diary) {
  const d = inputAuthor(diary)
  return d === null ? null : resolveUrl('/index/groups/' + d)
}

export function communityUrl (community) {
  const c = inputAuthor(community)
  return c === null ? null : resolveUrl('/index/community/' + c)
}

export function communityGroupsUrl (community, cursor) {
  const c = inputAuthor(community)
  const after = inputAuthor(cursor)
  return c === null || after === null ? null : resolveUrl('/index/community/' + c + '/groups/' + after)
}

// The segment is built and checked exactly as for the member search.
export function groupSearchUrl (segment) {
  if (typeof segment !== 'string' || !SEGMENT.test(segment)) return null
  if (segment.replace(/-/g, '').length < 2) return null
  return resolveUrl('/index/group-search/' + segment)
}

// Feira search. `uf` one of the 27 UFs as @varanda/rpc feira spells them
// (upper case), `cityKey` already folded, `kind` 'todos' or a kind, `cat`
// 'todas' or a category, `tokens` null or folded words joined by '+' (as
// topicUrl). Anything else is null, never dropped or coerced.
export function feiraUrl ({ uf, cityKey, kind = 'todos', cat = 'todas', tokens = null, cursor = null } = {}) {
  if (!rpc.feira.isUf(uf)) return null
  if (typeof cityKey !== 'string' || cityKey.length < 2 || cityKey.length > rpc.feira.MAX_CITY_KEY || !CITY_KEY.test(cityKey)) return null
  if (kind !== 'todos' && !rpc.feira.isKind(kind)) return null
  if (cat !== 'todas' && !rpc.feira.isCat(cat)) return null
  if (tokens !== null && (typeof tokens !== 'string' || !QUERY.test(tokens))) return null
  if (cursor !== null && !isCursor(cursor)) return null
  return resolveUrl('/index/feira/' + uf.toLowerCase() + '/' + cityKey + '/' + kind + '/' + cat +
    (tokens === null ? '' : '/' + tokens) + (cursor === null ? '' : '/' + cursor))
}

export function feiraAuthorUrl (author, cursor = null) {
  const a = inputAuthor(author)
  if (a === null || (cursor !== null && !isCursor(cursor))) return null
  return resolveUrl('/index/feira/autor/' + a + (cursor === null ? '' : '/' + cursor))
}

export function feiraRatingsUrl (author, cursor = null) {
  const a = inputAuthor(author)
  if (a === null || (cursor !== null && !isCursor(cursor))) return null
  return resolveUrl('/index/feira/avaliacoes/' + a + (cursor === null ? '' : '/' + cursor))
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
      const init = {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: ctrl ? ctrl.signal : undefined
      }
      // React Native's fetch (whatwg-fetch) appends '_=<timestamp>' for
      // 'no-store', and the seeder's /index routes answer 404 to any query.
      if (isAppClient()) delete init.cache
      res = await get(url, init)
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
  if (VITRINE) return vitrineIndex(url)
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
  const hint = pageHintOf(body, MEMBER_KEYS)
  if (hint === null) return null
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
    complete: body.complete,
    ...hint
  }
}

// Items: <= 30 distinct refs (may be empty). Authors: exactly one hint per
// author of the items, no more and no fewer (an unrelated or missing hint
// means a confused or hostile index: refused whole).
export function validTopic (body) {
  if (!hasExactKeys(body, TOPIC_KEYS)) return null
  const items = refList(body.items, TOPIC_MAX)
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

// Feira answers. Items: <= 30 distinct refs; a listing item carries its
// status (null only when stale, then with no statusSeq) and the seqs of its
// current status and edit blocks, each after the root. `ratings`: items are
// { ref } only. `author`: every item must be that author's. Authors: exactly
// one hint per item author (as validTopic), page flags allowed.
export function validFeira (body, { ratings = false, author = null } = {}) {
  if (!hasExactKeys(body, FEIRA_KEYS)) return null
  if (!Array.isArray(body.items) || body.items.length > FEIRA_MAX) return null
  if (body.next !== null && !isCursor(body.next)) return null
  if (typeof body.indexing !== 'boolean' || typeof body.complete !== 'boolean') return null
  const items = []
  const seen = new Set()
  for (const it of body.items) {
    if (!hasExactKeys(it, ratings ? FEIRA_RATING_KEYS : FEIRA_ITEM_KEYS)) return null
    if (!isRef(it.ref) || seen.has(it.ref)) return null
    seen.add(it.ref)
    const [itemAuthor, seqText] = it.ref.split(':')
    if (author !== null && itemAuthor !== author) return null
    if (ratings) {
      items.push({ ref: it.ref })
      continue
    }
    const seq = Number(seqText)
    if (it.status !== null && !rpc.feira.isStatus(it.status)) return null
    if (!isHint(it.statusSeq) || !isHint(it.editSeq)) return null
    if (it.status === null && it.statusSeq !== null) return null
    if ((it.statusSeq !== null && it.statusSeq <= seq) || (it.editSeq !== null && it.editSeq <= seq)) return null
    items.push({ ref: it.ref, status: it.status, statusSeq: it.statusSeq, editSeq: it.editSeq })
  }
  if (!isPlain(body.authors)) return null
  const wanted = new Set(items.map((i) => i.ref.split(':')[0]))
  const got = Object.keys(body.authors)
  if (got.length !== wanted.size || !got.every((k) => wanted.has(k))) return null
  const authors = {}
  for (const k of got) {
    const h = body.authors[k]
    const page = pageHintOf(h, HINT_KEYS)
    if (page === null || !isHint(h.profileSeq) || !isHint(h.usernameSeq)) return null
    authors[k] = { profileSeq: h.profileSeq, usernameSeq: h.usernameSeq, ...page }
  }
  return { items, next: body.next, authors, indexing: body.indexing, complete: body.complete }
}

// Items: <= 20 distinct refs, one per engager. Authors: exactly one hint per
// item author, as in validTopic.
export function validEngagers (body, ref, kind) {
  if (!hasExactKeys(body, ENGAGERS_KEYS)) return null
  if (!isRef(body.ref) || (ref !== undefined && body.ref !== ref)) return null
  if (kind !== undefined && body.kind !== kind) return null
  const items = refList(body.items, ENGAGERS_MAX)
  if (items === null) return null
  const wanted = new Set(items.map((r) => r.split(':')[0]))
  if (wanted.size !== items.length) return null
  if (body.next !== null && !isCursor(body.next)) return null
  if (!isCount(body.total) || body.total < items.length) return null
  if (typeof body.indexing !== 'boolean' || typeof body.complete !== 'boolean') return null
  const authors = validAuthors(body.authors)
  if (authors === null) return null
  const got = Object.keys(authors)
  if (got.length !== wanted.size || !got.every((k) => wanted.has(k))) return null
  return {
    ref: body.ref,
    kind: body.kind,
    items,
    next: body.next,
    total: body.total,
    authors,
    indexing: body.indexing,
    complete: body.complete
  }
}

export function validFollowCounts (body) {
  if (!hasExactKeys(body, FOLLOW_COUNTS_KEYS) || !isFlags(body)) return null
  if (!isCount(body.seguindo) || !isCount(body.seguidores)) return null
  return { seguindo: body.seguindo, seguidores: body.seguidores, indexing: body.indexing, complete: body.complete }
}

// Pointers only: rows with exact keys, lowercase hex64 writers other than
// the owner, positive seqs, <= 64 per list, no repeated show seq or writer
// block, and no writer block both shown and pending.
export function validTestimonials (body, owner = null) {
  if (!hasExactKeys(body, TESTIMONIALS_KEYS) || !isFlags(body)) return null
  if (!Array.isArray(body.shown) || body.shown.length > TESTIMONIALS_MAX) return null
  if (!Array.isArray(body.pending) || body.pending.length > TESTIMONIALS_MAX) return null
  const seqs = new Set()
  const blocks = new Set()
  const shown = []
  for (const row of body.shown) {
    if (!hasExactKeys(row, SHOWN_KEYS) || !isHex64(row.from) || row.from === owner) return null
    if (!isSeq(row.seq) || !isSeq(row.wseq)) return null
    const block = row.from + ':' + row.wseq
    if (seqs.has(row.seq) || blocks.has(block)) return null
    seqs.add(row.seq)
    blocks.add(block)
    shown.push({ seq: row.seq, from: row.from, wseq: row.wseq })
  }
  const pending = []
  for (const row of body.pending) {
    if (!hasExactKeys(row, PENDING_KEYS) || !isHex64(row.from) || row.from === owner) return null
    if (!isSeq(row.seq)) return null
    const block = row.from + ':' + row.seq
    if (blocks.has(block)) return null
    blocks.add(block)
    pending.push({ from: row.from, seq: row.seq })
  }
  return { shown, pending, indexing: body.indexing, complete: body.complete }
}

// The follow index order: the time clamped at 0, newest first, then key.
function followT (at) {
  const t = Date.parse(at)
  return t > 0 ? t : 0
}

// Items: <= 20, one per distinct key, never the author itself, each strictly
// after the previous one (or the request cursor) in the index order. `next`
// must name the last row: a cursor that pointed anywhere else could send the
// reader backwards and page forever. Authors: exactly one hint per item key,
// as in validTopic.
export function validFollows (body, author, kind, cursor = null) {
  if (!hasExactKeys(body, FOLLOWS_KEYS) || !isFlags(body)) return null
  if (!isHex64(body.author) || (author !== undefined && body.author !== author)) return null
  if (!isFollowKind(body.kind) || (kind !== undefined && body.kind !== kind)) return null
  const list = body.items
  if (!Array.isArray(list) || list.length > FOLLOWS_MAX) return null
  const seen = new Set()
  const items = []
  let prev = isFollowCursor(cursor) ? cursor : null
  for (const it of list) {
    if (!hasExactKeys(it, FOLLOW_ITEM_KEYS) || !isHex64(it.key) || it.key === body.author) return null
    if (!isSeq(it.seq) || !isCanonicalIso(it.at) || seen.has(it.key)) return null
    const t = followT(it.at)
    if (prev !== null && !(t < prev.atMs || (t === prev.atMs && it.key > prev.key))) return null
    prev = { atMs: t, key: it.key }
    seen.add(it.key)
    items.push({ key: it.key, seq: it.seq, at: it.at })
  }
  if (body.next !== null) {
    if (!isFollowCursor(body.next) || items.length === 0) return null
    const last = items[items.length - 1]
    if (body.next.key !== last.key || body.next.atMs !== followT(last.at)) return null
  }
  if (!isCount(body.total) || body.total < items.length) return null
  const authors = validAuthors(body.authors)
  if (authors === null) return null
  const got = Object.keys(authors)
  if (got.length !== seen.size || !got.every((k) => seen.has(k))) return null
  return {
    author: body.author,
    kind: body.kind,
    items,
    next: body.next === null ? null : { atMs: body.next.atMs, key: body.next.key },
    total: body.total,
    authors,
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
    const hint = pageHintOf(m, HIT_KEYS)
    if (hint === null || !isHex64(m.author) || seen.has(m.author)) return null
    if (!isHint(m.profileSeq) || !isHint(m.usernameSeq)) return null
    if (m.profileSeq === null && m.usernameSeq === null) return null
    seen.add(m.author)
    members.push({ author: m.author, profileSeq: m.profileSeq, usernameSeq: m.usernameSeq, ...hint })
  }
  return { members, more: body.more, indexing: body.indexing, complete: body.complete }
}

const isName = (n) => n === null || (typeof n === 'string' && n.length >= 1 && n.length <= GROUP_NAME_MAX * 2 && [...n].length <= GROUP_NAME_MAX)
const isFlags = (body) => typeof body.indexing === 'boolean' && typeof body.complete === 'boolean'

// `after`: the cursor asked for; every key must come after it. Writers:
// <= 64, distinct, ascending by key, exact keys. A private group has no name.
export function validGroup (body, after = null) {
  if (!hasExactKeys(body, GROUP_KEYS) || !isFlags(body) || typeof body.rootServed !== 'boolean' || typeof body.attached !== 'boolean') return null
  if (body.kind !== null && body.kind !== 'group' && body.kind !== 'community') return null
  if (body.visibility !== null && body.visibility !== 'public' && body.visibility !== 'private') return null
  if (body.join !== null && body.join !== 'open' && body.join !== 'approval') return null
  if (!isName(body.name) || (body.visibility === 'private' && body.name !== null)) return null
  for (const k of ['creator', 'community', 'next']) if (body[k] !== null && !isHex64(body[k])) return null
  const list = body.writers
  if (!Array.isArray(list) || list.length > GROUP_WRITERS_MAX) return null
  let prev = after
  const writers = []
  for (const w of list) {
    const exact = hasExactKeys(w, WRITER_KEYS)
    if (!exact && !hasExactKeys(w, WRITER_KEYS_OLD)) return null
    if (!isHex64(w.key) || !isHex64(w.diary) || typeof w.left !== 'boolean') return null
    if (!isCount(w.length) || !isSeq(w.seq)) return null
    if (exact && (!isCount(w.signed) || w.signed < w.length)) return null
    if (prev !== null && w.key <= prev) return null
    prev = w.key
    writers.push({ key: w.key, diary: w.diary, length: w.length, signed: exact ? w.signed : w.length, seq: w.seq, left: w.left })
  }
  return {
    kind: body.kind,
    visibility: body.visibility,
    join: body.join,
    name: body.name,
    creator: body.creator,
    rootServed: body.rootServed,
    community: body.community,
    attached: body.attached,
    writers,
    next: body.next,
    indexing: body.indexing,
    complete: body.complete
  }
}

// One row per group of the diary, <= 64, distinct.
export function validGroups (body) {
  if (!hasExactKeys(body, GROUPS_KEYS) || !isFlags(body)) return null
  const list = body.groups
  if (!Array.isArray(list) || list.length > GROUPS_MAX) return null
  const seen = new Set()
  const groups = []
  for (const r of list) {
    if (!hasExactKeys(r, GROUPS_ROW_KEYS) || !isHex64(r.group) || !isHex64(r.writer)) return null
    if (!isSeq(r.seq) || typeof r.left !== 'boolean' || seen.has(r.group)) return null
    seen.add(r.group)
    groups.push({ group: r.group, writer: r.writer, seq: r.seq, left: r.left })
  }
  return { groups, indexing: body.indexing, complete: body.complete }
}

function hitRows (list, max) {
  if (!Array.isArray(list) || list.length > max) return null
  const seen = new Set()
  const out = []
  for (const h of list) {
    if (!hasExactKeys(h, GROUP_HIT_KEYS) || !isHex64(h.group) || !isName(h.name) || !isCount(h.writerCount) || seen.has(h.group)) return null
    seen.add(h.group)
    out.push({ group: h.group, name: h.name, writerCount: h.writerCount })
  }
  return out
}

// <= 20 public groups, distinct.
export function validGroupSearch (body) {
  if (!hasExactKeys(body, GROUP_SEARCH_KEYS) || !isFlags(body) || typeof body.more !== 'boolean') return null
  const groups = hitRows(body.groups, GROUP_SEARCH_MAX)
  return groups === null ? null : { groups, more: body.more, indexing: body.indexing, complete: body.complete }
}

// `next` must name the page's last row: a cursor that pointed anywhere else
// could send the reader backwards and page forever.
function nextOk (next, groups) {
  return next === null || (groups.length > 0 && next === groups[groups.length - 1].group)
}

function communityRows (list, cursor = null) {
  if (!Array.isArray(list) || list.length > COMMUNITY_GROUPS_MAX) return null
  let prev = cursor
  const groups = []
  for (const r of list) {
    if (!hasExactKeys(r, COMMUNITY_ROW_KEYS) || !isHex64(r.group)) return null
    if (prev !== null && r.group <= prev) return null
    if (r.join !== 'open' && r.join !== 'approval') return null
    if (r.visibility === 'private') {
      if (r.name !== null || r.writerCount !== null) return null
    } else if (r.visibility !== 'public' || !isName(r.name) || !isCount(r.writerCount)) return null
    prev = r.group
    groups.push({ group: r.group, join: r.join, name: r.name, visibility: r.visibility, writerCount: r.writerCount })
  }
  return groups
}

export function validCommunity (body) {
  if (!hasExactKeys(body, COMMUNITY_KEYS) || !isFlags(body) || !isName(body.name)) return null
  if (body.join !== null && body.join !== 'open' && body.join !== 'approval') return null
  if (body.creator !== null && !isHex64(body.creator)) return null
  if (!isCount(body.members) || (body.next !== null && !isHex64(body.next))) return null
  const groups = communityRows(body.groups)
  if (groups === null || !nextOk(body.next, groups)) return null
  return { name: body.name, join: body.join, creator: body.creator, members: body.members, groups, next: body.next, indexing: body.indexing, complete: body.complete }
}

export function validCommunityGroups (body, cursor) {
  if (!isHex64(cursor) || !hasExactKeys(body, COMMUNITY_GROUPS_KEYS) || !isFlags(body)) return null
  if (body.next !== null && !isHex64(body.next)) return null
  const groups = communityRows(body.groups, cursor)
  return groups === null || !nextOk(body.next, groups) ? null : { groups, next: body.next, indexing: body.indexing, complete: body.complete }
}

// --- fetchers ---

export function fetchPost (ref, cursor = null, deps = {}) {
  const url = postUrl(ref, cursor)
  const r = url === null ? null : inputRef(ref)
  return run(url, (body) => validPostIndex(body, r), deps)
}

export function fetchCounts (refs, deps = {}) {
  const asked = countsInput(refs)
  const url = asked === null ? null : resolveUrl('/index/counts/' + asked.join(','))
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

// An explicit refresh must reach the index: a cached page can carry seq hints
// (or a visible author) that no longer hold.
export function refetchMember (author, deps = {}) {
  invalidateMember(author)
  return fetchMember(author, null, deps)
}

export function fetchTopic (path, cursor = null, deps = {}) {
  return run(topicUrl(path, cursor), validTopic, deps)
}

export function fetchSearch (segment, deps = {}) {
  return run(searchUrl(segment), validSearch, deps)
}

// Never cached: a like or repost can be undone at any time.
export function fetchEngagers (kind, ref, cursor = null, deps = {}) {
  const url = engagersUrl(kind, ref, cursor)
  const r = url === null ? null : inputRef(ref)
  return run(url, (body) => validEngagers(body, r, kind), deps)
}

export function fetchFollowCounts (author, deps = {}) {
  return run(followCountsUrl(author), validFollowCounts, deps)
}

export function fetchTestimonials (owner, deps = {}) {
  const url = testimonialsUrl(owner)
  const o = url === null ? null : inputAuthor(owner)
  return run(url, (body) => validTestimonials(body, o), deps)
}

export function fetchFollows (author, kind, cursor = null, deps = {}) {
  const url = followsUrl(author, kind, cursor)
  const a = url === null ? null : inputAuthor(author)
  return run(url, (body) => validFollows(body, a, kind, cursor), deps)
}

// Never cached: membership and writers change with every join or leave.
export function fetchGroup (group, after = null, deps = {}) {
  const url = groupUrl(group, after)
  const a = url === null || after === null ? null : inputAuthor(after)
  return run(url, (body) => validGroup(body, a), deps)
}

export function fetchGroups (diary, deps = {}) {
  return run(groupsUrl(diary), validGroups, deps)
}

export function fetchCommunity (community, deps = {}) {
  return run(communityUrl(community), validCommunity, deps)
}

export function fetchCommunityGroups (community, cursor, deps = {}) {
  const url = communityGroupsUrl(community, cursor)
  const after = url === null ? null : inputAuthor(cursor)
  return run(url, (body) => validCommunityGroups(body, after), deps)
}

export function fetchGroupSearch (segment, deps = {}) {
  return run(groupSearchUrl(segment), validGroupSearch, deps)
}

// Never cached: a status or an edit changes what a listing shows.
export function fetchFeira (query, deps = {}) {
  return run(feiraUrl(query), (body) => validFeira(body), deps)
}

export function fetchFeiraAuthor (author, cursor = null, deps = {}) {
  const url = feiraAuthorUrl(author, cursor)
  const a = url === null ? null : inputAuthor(author)
  return run(url, (body) => validFeira(body, { author: a }), deps)
}

export function fetchFeiraRatings (author, cursor = null, deps = {}) {
  return run(feiraRatingsUrl(author, cursor), (body) => validFeira(body, { ratings: true }), deps)
}
