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
// Perfil rico: the newest live `profile-about` and `mood` seq of each author
// (profileExtra), like the profile hint: seqs only, a deletion falls back to
// the previous live block, and each block holds a record slot.
// Fas e Melhores amigos (lib/fans.js): every live `fan` block holds a record
// slot under its writer, the last live operation per (writer, key) wins and,
// when it is on, is published under the key (fans(), fanCount()); a deletion
// falls back to the previous live operation. A fan of the writer itself
// takes no slot and is never listed. A writer keeps at most FAN_KEYS_MAX
// distinct keys: past that, a block naming a new key is skipped without a
// slot (the list may then be short; counts are seeder claims). The newest
// live `top-friends` block of an author is profileExtra().top, kept like the
// about pointer with its keys; one that names its writer takes no slot.
// Visitas: the newest live `visits` block of an author is profileExtra().visits,
// a seq only (the node peeks the block and checks on === true); every live
// block holds a record slot and a deletion falls back to the previous one.
// Enquetes (lib/polls.js): every live `choice` block holds a record slot
// under its voter. A poll is a live `post` carrying a valid `poll` key (the
// option count is kept beside the post); votes are kept per (voter, poll)
// and the last in-range operation wins (foldPicks): a pick replaces the
// earlier one, a null pick withdraws it, an out-of-range pick is ignored and
// a deletion falls back to the previous live operation. An operation dated
// more than MAX_FUTURE_MS after `now` is kept but neither counted nor listed
// until its date (lib/polls.js livePick). poll() answers only
// for a live poll post: votes naming a post that is not a valid poll, or a
// deleted one, are never counted nor listed. A voter keeps at most
// CHOICE_POLLS_MAX distinct polls and a poll lists at most CHOICE_VOTERS_MAX
// voters: past either, a block naming a new (voter, poll) pair is skipped
// without a slot (the totals may then be short; they are seeder claims).
// Eventos (docs/protocol.md): a live root `post` carrying a valid `event`
// (the shared isEvent of @varanda/rpc) keeps its seq in a per-author list,
// no extra record slot (the post holds it), nothing of the event itself:
// events() answers pointers only, newest seq first, and a deleted post
// leaves the list. RSVP totals are the poll routes' (picks 0 and 1).
// Collections are lazy. Budget roughly 250 bytes/record (edge, post/timeline,
// engager and touched entries, the engagements map, and the profileSeqs,
// usernameSeqs, copiedSeqs, aboutSeqs and moodSeqs arrays) plus 500
// bytes/target (key, target object, map slots and the first used
// collection): about 500 MB at both defaults, plus small per-diary overhead
// (the five seq arrays start empty on every author entry) bounded by the
// seeder's served-diary limit. The deleted set is held until removeDiary. These are
// conservative retained-heap estimates, not a V8/RSS guarantee; collection
// capacity, string representation and GC headroom vary by runtime. The
// likers and reposters lists add one edge object per like or repost
// currently on, plus one array per target and kind with 2 or more engagers.
//
// Engager pages (engagers): who currently likes or reposts a post, newest
// first. The order key is the engager's OWN `at` claim on its effective on
// record (then author, then seq), so an engager can backdate itself; it is a
// listing hint, not a fact. An edge dated more than MAX_FUTURE_MS ahead of
// `now` is hidden (never examined nor removed) until the clock catches up,
// while totals still count it.
//
// Pure and total: no I/O, no timers, and no method ever throws (a hostile
// `visible` predicate included: a throw inside answers null / empty).
// Records given to `add` must already be plain validated copies
// (validRecordCopy) handed in ascending seq per author; the last operation
// per (engager, target) wins for likes and reposts.
//
// Depoimentos (docs/protocol.md section 5 "Seeder testimonial index"): per
// owner O, `pending` points at the newest live `testimonial` of each writer
// addressed to O, and `shown` at O's newest `testimonial-show` per writer
// while the writer block it names is live, indexed, addressed to O and
// commits to the shown text (the verifyShow rule of lib/testimonials.js, on
// the stored hash and commitment). Only keys, seqs, the writer's hash and
// the show's commitment are kept: never the text, the nonce or the box.
// Removal rule: once O has shown a writer block, that (writer, seq) never
// returns to `pending`, even after O tombstones the show; only a NEW block
// from that writer is pending again. So a tombstoned show keeps its record
// slot (it is the memory of that rule) and the seeder hands over a
// tombstoned show block it still holds (add(..., { removed: true })). A
// show whose content the seeder no longer holds at a rebuild is forgotten,
// and that writer block may be pending again: the app's per-device hide
// still applies.
//
// Recados (docs/protocol.md "Recados"): every live `scrap` is kept as a
// pointer under its page owner (`to`) and its writer, the owner's live
// `scrap-hide` blocks and `scrap-wall` blocks under the owner. The wall
// policy, the hides, the reply exception and the caps are applied at READ
// time (scraps()), with the rules of lib/scraps.js foldWall: 'nobody' shows
// nothing; 'everyone' every writer; 'following' a writer the owner follows
// (the caller's followSeq evidence) and, for any other writer, per live
// scrap of the owner addressed to that writer, the writer's lowest live
// reply to it that is dated no earlier than it and not more than
// MAX_FUTURE_MS ahead (that reply keeps the slot even when hidden). A scrap
// dated more than MAX_FUTURE_MS ahead is never shown and the owner's hides
// never are. The caps count admitted rows only: SCRAP_PER_WRITER per
// writer, then SCRAP_PER_PAGE per page, newest first (at desc, author asc,
// seq desc). Each request examines at most SCRAP_SCAN pointers (writers
// included); past it the answer says truncated.
//
// Varandinha (docs/protocol.md, the rules are @varanda/rpc lib/garden.js):
// every live `garden`, `garden-state` and `garden-help` block holds a record
// slot under its writer and is freed when deleted, so latest-wins flags and
// states never pile up. Only seqs and the help's addressee, date and pot
// index are kept, never the state's pots, plants or acts. The newest live `garden` block (on or
// off) and `garden-state` block are pointers (garden(), profileExtra()); a
// deletion falls back to the previous one. Helps are kept per (writer,
// addressee): GARDEN_PAIR_MAX per pair, GARDEN_WRITER_MAX per writer (past
// either, one row leaves and frees its slot, or the incoming row is skipped
// without a slot when it is the one helpVictim names) and
// GARDEN_WRITERS_PER_OWNER writers per addressee. A place at that last cap
// is held only by rows garden() can still list: with the scan's clock
// (add opts.now), a new writer past it takes the place of a writer none of
// whose rows is listable, and its own row is skipped without a slot when
// it is not listable either. When no place can be taken (or there is no
// clock) the row is skipped, and garden() says hidden until it would have
// left the reader window, since a skipped row is never replayed. A help
// addressed to its own writer takes no slot and is never listed. Help rows
// are kept across a drop of the addressee's diary (they belong to the
// writers' diaries), like `incoming`.
const { formatRef, parseRef, MAX_TOP_FRIENDS, POLL_MIN, POLL_MAX } = require('./records')
const { isEvent, garden: gardenRules } = require('@varanda/rpc')
const { commitment } = require('./testimonials')
const { foldPicks } = require('./polls')

const DEFAULT_MAX_RECORDS = 1000000
const DEFAULT_MAX_TARGETS = 500000
const DEFAULT_PER_AUTHOR_MAX = 50000
const PAGE_SCAN = 200 // shared by replies, quotes and engager pages
const EMPTY_LIST = []
const REPLY_PAGE = 50
const QUOTE_PAGE = 50
const MEMBER_PAGE = 100
const ENGAGER_PAGE = 20
const NOTICE_ROWS_PER_ENGAGER = 64
const NOTICE_ROWS_MAX = 4096
const NOTICE_CACHE_AUTHORS = 16
const NOTICE_SCAN_MAX = 16384
const TESTIMONIAL_ROWS = 64
const RODA_PAGE = 50
// One budget per roda() call, spent twice: on the hops of the walk up and on
// the reply edges examined by the walk down.
const RODA_SCAN = 1000
const SCRAP_PER_WRITER = 20
const SCRAP_PER_PAGE = 500
const SCRAP_ROWS = 50
const SCRAP_HIDES = 1000
const SCRAP_SCAN = 20000
const SCRAP_WALLS = new Set(['following', 'everyone', 'nobody'])
const FAN_PAGE = 20
// Same value as lib/notices.js MAX_FOLLOW_TARGETS_PER_AUTHOR (lib/fans.js
// caps a writer's distinct fan keys with it; not imported, as above).
const FAN_KEYS_MAX = 4096
const CHOICE_PAGE = 20
// Same value as GROUP_EVENTS_LIMIT in @varanda/rpc lib/limits.js: the event
// pointers of one /index/events page.
const EVENT_PAGE = 30
const EVENT_RSVP_OPTIONS = 2
// Distinct polls one voter may hold operations on, and voters one poll lists.
const CHOICE_POLLS_MAX = 4096
const CHOICE_VOTERS_MAX = 20000
// Varandinha help pointers: per (writer, addressee), per writer, writers per
// addressee, and the keys one gardenStreet() call examines. They bound the
// memory a flood of signed helps can take; the eviction rules (header) keep
// a full cap from shutting out a listable help for good.
const GARDEN_PAIR_MAX = 4
const GARDEN_WRITER_MAX = 64
const GARDEN_WRITERS_PER_OWNER = 512
const GARDEN_STREET_SCAN = 2000
// Same value as lib/feed.js MAX_FUTURE_MS (not imported: this module only
// requires ./records and ./testimonials). An engager edge dated further ahead is hidden, never
// removed, and appears once the clock catches up.
const MAX_FUTURE_MS = 86400000
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

// Storage order of an engager list: the exact reverse of newest first
// (atMs desc, author asc, seq desc), so the newest edge is at the end.
function compareEngagerStored (a, b) {
  if (a.atMs !== b.atMs) return a.atMs < b.atMs ? -1 : 1
  if (a.author !== b.author) return a.author > b.author ? -1 : 1
  return a.seq - b.seq
}

function compareNoticeRows (a, b) {
  if (a.atMs !== b.atMs) return a.atMs > b.atMs ? -1 : 1
  if (a.key !== b.key) return a.key < b.key ? -1 : 1
  return b.seq - a.seq
}

function engagerLowerBound (list, key) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareEngagerStored(list[mid], key) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

function engagerUpperBound (list, key) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareEngagerStored(list[mid], key) <= 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

// The first index whose edge is dated more than MAX_FUTURE_MS after `now`.
// Valid because atMs is the primary ascending key of the storage order.
function notFutureTop (list, now) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid].atMs - now > MAX_FUTURE_MS) hi = mid
    else lo = mid + 1
  }
  return lo
}

function removeEngagerEdge (list, edge) {
  const i = engagerLowerBound(list, edge)
  if (list[i] === edge) list.splice(i, 1)
}

function edgesOf (type) {
  return type === 'likes' ? 'likeEdges' : 'repostEdges'
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

function noFollow () {
  return null
}

// Storage order of one (owner, writer) scrap list: ascending (atMs, seq),
// so the newest pointer is at the end and notFutureTop applies.
function compareScrapStored (a, b) {
  if (a.atMs !== b.atMs) return a.atMs < b.atMs ? -1 : 1
  return a.seq - b.seq
}

function scrapLowerBound (list, key) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareScrapStored(list[mid], key) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

// The replies of one writer to one original of a page owner, for the reply
// exception: ts and seqs in parallel, ascending (t, seq), where t is the raw
// Date.parse of the reply's at. `t0` is the original's t (null while the
// original is not indexed) and `from` the first index with ts >= t0
// (ts.length when t0 is null), so the replies dated no earlier than the
// original are the suffix from `from`. best[k] is the lowest seq of
// seqs[from .. from + k]: the not too far ahead ones are a prefix of that
// suffix, so the winner is one binary search away and a backdated or far
// future reply costs a read nothing.
function newReplyList (t0) {
  return { ts: [], seqs: [], best: [], from: 0, t0 }
}

function replyLowerBound (list, t, seq) {
  let lo = 0
  let hi = list.ts.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list.ts[mid] < t || (list.ts[mid] === t && list.seqs[mid] < seq)) lo = mid + 1
    else hi = mid
  }
  return lo
}

function refreshReplyList (list, t0) {
  list.t0 = t0
  let lo = 0
  let hi = list.ts.length
  if (t0 === null) lo = hi
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list.ts[mid] < t0) lo = mid + 1
    else hi = mid
  }
  list.from = lo
  list.best = []
  let low = Infinity
  for (let i = lo; i < list.seqs.length; i++) {
    if (list.seqs[i] < low) low = list.seqs[i]
    list.best.push(low)
  }
}

// best is non-increasing, so each fix-up stops at the first entry the
// change does not reach: a reply added in seq order (the add contract)
// touches one entry past its own.
function replyListInsert (list, t, seq) {
  const p = replyLowerBound(list, t, seq)
  list.ts.splice(p, 0, t)
  list.seqs.splice(p, 0, seq)
  if (list.t0 === null || t < list.t0) {
    list.from++
    return
  }
  const k = p - list.from
  list.best.splice(k, 0, k === 0 ? seq : Math.min(list.best[k - 1], seq))
  for (let j = k + 1; j < list.best.length && list.best[j] > seq; j++) list.best[j] = seq
}

function replyListRemove (list, t, seq) {
  const p = replyLowerBound(list, t, seq)
  if (list.ts[p] !== t || list.seqs[p] !== seq) return
  list.ts.splice(p, 1)
  list.seqs.splice(p, 1)
  if (p < list.from) {
    list.from--
    return
  }
  const k = p - list.from
  list.best.splice(k, 1)
  for (let j = k; j < list.best.length; j++) {
    const low = j === 0 ? list.seqs[list.from] : Math.min(list.best[j - 1], list.seqs[list.from + j])
    if (low === list.best[j]) break
    list.best[j] = low
  }
}

// Answer order of recados rows: at desc, author asc, seq desc. Rows order
// on the clamped atMs (a date before 1970 counts as 0), so pre-1970 rows
// may order differently from foldWall's raw Date.parse; such dates are
// junk and ties still break on author and seq.
function compareScrapRows (a, b) {
  if (a.atMs !== b.atMs) return a.atMs > b.atMs ? -1 : 1
  if (a.author !== b.author) return a.author < b.author ? -1 : 1
  return b.seq - a.seq
}

// A top-friends key list as lib/records.js validates it, minus the writer
// rule (add checks that): at most MAX_TOP_FRIENDS distinct hex keys.
function validTopKeys (keys) {
  if (!Array.isArray(keys) || keys.length > MAX_TOP_FRIENDS) return false
  const seen = new Set()
  for (const k of keys) {
    if (typeof k !== 'string' || !HEX64.test(k) || seen.has(k)) return false
    seen.add(k)
  }
  return true
}

// Index of the first operation of `ops` (ascending seq) at or above `seq`.
function opLowerBound (ops, seq) {
  let lo = 0
  let hi = ops.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ops[mid].seq < seq) lo = mid + 1
    else hi = mid
  }
  return lo
}

// The option count of a poll post record (a root post whose `poll` is a
// dense array of POLL_MIN..POLL_MAX options), else 0. Records here are
// validated copies (lib/records.js); this only keeps the count.
// Whether a post record is a diary event post: a root post whose `event`
// passes the shared rules (@varanda/rpc isEvent). The index keeps only the
// seq of such a post, never its title, place or dates.
function isEventPost (record) {
  return record.replyTo === null && record.event !== undefined && isEvent(record.event)
}

function pollSize (record) {
  const poll = record.poll
  return record.replyTo === null && Array.isArray(poll) && poll.length >= POLL_MIN && poll.length <= POLL_MAX ? poll.length : 0
}

// A `choice` record: a target block and a pick of null or 0..POLL_MAX-1.
function validChoice (record) {
  const to = record.to
  return to !== null && typeof to === 'object' && typeof to.author === 'string' && HEX64.test(to.author) && isSeq(to.seq) &&
    (record.pick === null || (Number.isSafeInteger(record.pick) && record.pick >= 0 && record.pick < POLL_MAX)) && typeof record.at === 'string'
}

// Stored garden-help rows: newest first (atMs desc), a tie by the lowest
// seq, the order in which the reader fold picks a helper's newest row.
function compareHelps (a, b) {
  if (a.atMs !== b.atMs) return a.atMs > b.atMs ? -1 : 1
  return a.seq - b.seq
}

// Whether garden(owner, now) may list a help dated atMs: inside the reader
// window (lib/garden.js inWindow) on a day dayStart accepts. One test for
// garden() and for the caps, so a cap never keeps a row garden() drops.
function gardenListable (atMs, now) {
  return atMs <= now + gardenRules.GARDEN_MAX_FUTURE_MS && atMs >= now - gardenRules.GARDEN_HELP_WINDOW_MS &&
    !Number.isNaN(gardenRules.dayStart(atMs))
}

// The row a full help cap gives up among `rows` ([{ seq, atMs, to }], the
// kept rows and the incoming one). Retention follows the writer's own seq
// order, never the date it claims, so a far-future date cannot hold a slot
// that garden() never lists while every later help is refused. A row the
// reader fold would never count while the others stay goes first, the
// highest seq of those: not the lowest seq of its (addressee, Brasilia day),
// or a day dayStart refuses. Evicting the lowest seq of a day instead would
// let a later duplicate of that day be listed in its place. Otherwise the
// lowest seq leaves. With a clock (`now`, ms), a row garden(now) could not
// list is dead first and the lowest seq of a day is taken among the others
// only, as garden() and the reader fold filter the window before they pick
// the day's row: a day the window edge cuts keeps its listed row.
function helpVictim (rows, now = null) {
  const days = rows.map((r) => gardenRules.dayStart(r.atMs))
  const alive = rows.map((r, i) => !Number.isNaN(days[i]) && (now === null || gardenListable(r.atMs, now)))
  const lowest = new Map()
  rows.forEach((r, i) => {
    if (!alive[i]) return
    const key = r.to + '/' + days[i]
    const prev = lowest.get(key)
    if (prev === undefined || r.seq < prev) lowest.set(key, r.seq)
  })
  let dead = null
  let oldest = null
  rows.forEach((r, i) => {
    if (!alive[i] || lowest.get(r.to + '/' + days[i]) !== r.seq) {
      if (dead === null || r.seq > dead.seq) dead = r
    } else if (oldest === null || r.seq < oldest.seq) {
      oldest = r
    }
  })
  return dead ?? oldest
}

// Rows by date, newest first, then author asc, then seq asc. garden() wraps
// it (gardenRowOrder) so a row dated after its clock never outranks one
// that is not.
function compareHelpRows (a, b) {
  if (a.atMs !== b.atMs) return a.atMs > b.atMs ? -1 : 1
  if (a.author !== b.author) return a.author < b.author ? -1 : 1
  return a.seq - b.seq
}

// garden(now)'s pick and answer order. A writer can date a help up to
// GARDEN_MAX_FUTURE_MS ahead and still be listed, so ranking by the claimed
// date alone would let a few writers dating ahead own every listed row.
// Rows dated after now therefore come after every row at or before now,
// nearest to now first, then author, then seq; the others keep
// compareHelpRows.
function gardenRowOrder (now) {
  return (a, b) => {
    const fa = a.atMs > now
    const fb = b.atMs > now
    if (fa !== fb) return fa ? 1 : -1
    if (!fa) return compareHelpRows(a, b)
    if (a.atMs !== b.atMs) return a.atMs < b.atMs ? -1 : 1
    if (a.author !== b.author) return a.author < b.author ? -1 : 1
    return a.seq - b.seq
  }
}

// Fan rows: atMs desc, then key asc (lib/notices.js compareRows).
function compareFanRows (a, b) {
  if (a.atMs !== b.atMs) return a.atMs > b.atMs ? -1 : 1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

function createEngagementIndex ({ maxRecords = DEFAULT_MAX_RECORDS, maxTargets = DEFAULT_MAX_TARGETS, perAuthorMax = DEFAULT_PER_AUTHOR_MAX, onFreed = null } = {}) {
  const cap = Number.isSafeInteger(maxRecords) && maxRecords >= 0 ? maxRecords : DEFAULT_MAX_RECORDS
  const targetCap = Number.isSafeInteger(maxTargets) && maxTargets >= 0 ? maxTargets : DEFAULT_MAX_TARGETS
  const authorCap = Number.isSafeInteger(perAuthorMax) && perAuthorMax >= 0 ? perAuthorMax : DEFAULT_PER_AUTHOR_MAX
  let records = 0
  let fullAuthors = 0
  // target ref -> { replies: [edge] asc, quotes: [edge] asc, likes:
  // Map<engager, edge>, reposts: Map<engager, edge> (engagers currently on,
  // edge = { atMs, author, seq } of the effective on record), likeEdges and
  // repostEdges: the same edges by compareEngagerStored, kept only while the
  // matching Map has 2 or more entries (null otherwise, to spare an array
  // per single-engager target) }. All collections start null; numeric totals
  // change only on writes.
  const targets = new Map()
  // Target author -> its retained target refs, including nonexistent posts.
  const authorTargets = new Map()
  // author -> { count, timeline: [seq] asc (posts and reposts currently on),
  // posts: Map<seq, { replyTo, quote }>, reposts: Map<ref, seq> (the on
  // record per target), touched: Map<ref, active edge count>,
  // profileSeqs, usernameSeqs, copiedSeqs, aboutSeqs, moodSeqs: [seq] asc,
  // engagements: Map<seq, { type, to }> }
  const authors = new Map()
  // A slower cursor must not resurrect a removed block or its incoming edges.
  const deleted = new Map()
  const deletedRefs = new Set()
  // noticeRows memo: author -> { edges, cut, builtAt, wakeAt }: the newest
  // NOTICE_SCAN_MAX qualifying edges, sorted newest first, after the
  // viewer-independent filters (far future as of builtAt, the per-engager
  // cap) and before `visible`, and whether older ones were left out. wakeAt
  // is when the nearest far-future edge left out stops being future: a read
  // at or after it, or before builtAt, rebuilds the entry. The notices
  // channel admits a burst of 512 page messages then 2/s, so one member
  // rereading Avisos must not rebuild and sort every edge aimed at its posts
  // each time. Kept after the scan cap, so an entry holds at most
  // NOTICE_SCAN_MAX edges. Insertion order is the LRU order. Any write that
  // can change an author's rows drops its entry.
  const noticeCache = new Map()
  // Owner -> Map<writer, edge { atMs, author, seq }>: the newest (highest
  // seq) live `testimonial` of each writer addressed to that owner, kept
  // across a drop of the owner (they belong to the writers' diaries). Folded
  // by writer so an anonymous /index/testimonials request costs the distinct
  // writers, never every block a writer appended.
  const incoming = new Map()
  // Owner -> Map<writer, { edges: [{ atMs, seq }] by compareScrapStored,
  // replies: null | Map<owner scrap seq, reply list (newReplyList)> }>: the live
  // scraps each writer left on the owner's page (a writer's own page is
  // never listed), kept across a drop of the owner like `incoming`.
  // `replies` holds the scraps whose replyTo names a block of the owner.
  const scrapIn = new Map()
  // Key -> Map<writer, { seq, at }>: the writers whose last live `fan`
  // operation on that key is on (seq and at of that block), kept across a
  // drop of the key's own diary like `incoming`.
  const fanIn = new Map()
  // Poll ref -> Map<voter, ops>: the voters holding live `choice` operations
  // on that post (ops is the voter's own list, ascending seq, shared with its
  // author entry), kept across a drop of the poll's own diary like fanIn.
  const pollIn = new Map()
  // Addressee -> Map<writer, [{ seq, atMs, pot }] by compareHelps>: the live
  // `garden-help` blocks each writer addressed to that balcony (at most
  // GARDEN_PAIR_MAX), the same rows as the writer's gardenHelps, kept across
  // a drop of the addressee's diary like `incoming`.
  const helpsByTo = new Map()
  // Addressee -> fullUntil ms: the writers cap refused a help garden() might
  // list, and a refused help is never replayed, so garden() says hidden
  // until that help would have left the reader window. Kept across a drop
  // of the addressee's diary like helpsByTo.
  const gardenFull = new Map()

  function invalidateNotices (author) {
    noticeCache.delete(author)
  }
  function authorEntry (author) {
    let entry = authors.get(author)
    if (entry === undefined) {
      entry = { count: 0, timeline: [], posts: new Map(), reposts: new Map(), touched: new Map(), profileSeqs: [], usernameSeqs: [], copiedSeqs: [], aboutSeqs: [], moodSeqs: [], engagements: new Map(), testimonials: null, shows: null, scraps: null, scrapsByTo: null, scrapHides: null, hideSeqs: null, hiddenRefs: null, walls: null, wallSeqs: null, fanSeqs: null, fanOps: null, tops: null, topSeqs: null, choiceSeqs: null, choiceOps: null, eventSeqs: null, visitSeqs: null, gardenSeqs: null, gardenOn: null, gardenStateSeqs: null, gardenHelps: null }
      authors.set(author, entry)
    }
    return entry
  }

  function targetEntry (ref) {
    let entry = targets.get(ref)
    if (entry === undefined) {
      entry = { replies: null, quotes: null, likes: null, reposts: null, likeEdges: null, repostEdges: null, repliesTotal: 0, quotesTotal: 0, likesTotal: 0, repostsTotal: 0 }
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
  function toggle (target, type, engager, seq, on, ref, entry, atMs) {
    const map = target[type]
    const prev = map === null ? undefined : map.get(engager)
    if (prev !== undefined && prev.seq > seq) return false
    const edgesKey = edgesOf(type)
    if (on) {
      const edge = { atMs, author: engager, seq }
      if (prev !== undefined && target[edgesKey] !== null) removeEngagerEdge(target[edgesKey], prev)
      if (target[type] === null) target[type] = new Map()
      const engaged = target[type]
      engaged.set(engager, edge)
      if (target[edgesKey] !== null) {
        const list = target[edgesKey]
        list.splice(engagerUpperBound(list, edge), 0, edge)
      } else if (engaged.size === 2) {
        const [a, b] = engaged.values()
        target[edgesKey] = compareEngagerStored(a, b) <= 0 ? [a, b] : [b, a]
      }
      if (prev === undefined) {
        target[type + 'Total']++
        touch(entry, ref, 1)
      }
    } else if (prev !== undefined) {
      unengage(target, type, engager, prev)
      target[type + 'Total']--
      touch(entry, ref, -1)
    }
    return true
  }

  // Removes an engager's edge from both collections, keeping the array only
  // while 2 or more engagers remain and the Map only while one does.
  function unengage (target, type, engager, edge) {
    const edgesKey = edgesOf(type)
    target[type].delete(engager)
    const list = target[edgesKey]
    if (list !== null) {
      removeEngagerEdge(list, edge)
      if (list.length < 2) target[edgesKey] = null
    }
    if (target[type].size === 0) target[type] = null
  }

  // opts.removed: a tombstoned `testimonial-show` (the removal rule above);
  // any other tombstoned block is skipped.
  function add (author, seq, record, opts = null) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author) || !isSeq(seq)) return false
      const tombstoned = deleted.get(author)?.has(seq) === true || opts?.removed === true
      if (tombstoned && record?.type !== 'testimonial-show') return true
      if (record === null || typeof record !== 'object') return false
      const type = record.type
      if (type !== 'post' && type !== 'like' && type !== 'repost' && type !== 'profile' && type !== 'username' &&
          type !== 'testimonial' && type !== 'testimonial-show' && type !== 'scrap' && type !== 'scrap-hide' &&
          type !== 'scrap-wall' && type !== 'profile-about' && type !== 'mood' && type !== 'fan' && type !== 'top-friends' && type !== 'choice' && type !== 'visits' &&
          type !== 'garden' && type !== 'garden-state' && type !== 'garden-help') return false
      if (type === 'testimonial' && (!HEX64.test(record.to) || !HEX64.test(record.hash))) return false
      if (type === 'scrap' && (!HEX64.test(record.to) || (record.replyTo !== null &&
          (typeof record.replyTo !== 'object' || !HEX64.test(record.replyTo.author) || !isSeq(record.replyTo.seq))))) return false
      if (type === 'scrap-hide' && (!HEX64.test(record.from) || !isSeq(record.seq))) return false
      if (type === 'scrap-wall' && !SCRAP_WALLS.has(record.who)) return false
      if (type === 'fan' && (typeof record.key !== 'string' || !HEX64.test(record.key) || typeof record.on !== 'boolean' || typeof record.at !== 'string')) return false
      if (type === 'top-friends' && !validTopKeys(record.keys)) return false
      if (type === 'choice' && !validChoice(record)) return false
      if (type === 'visits' && typeof record.on !== 'boolean') return false
      if (type === 'garden' && typeof record.on !== 'boolean') return false
      if (type === 'garden-state' && !Array.isArray(record.pots)) return false
      const helpAtMs = type === 'garden-help' && typeof record.at === 'string' ? Date.parse(record.at) : NaN
      if (type === 'garden-help' && (typeof record.to !== 'string' || !HEX64.test(record.to) ||
          !gardenRules.isPotIndex(record.pot) || !Number.isFinite(helpAtMs))) return false
      // Never self (lib/fans.js): as if never written, no slot.
      if (type === 'fan' && record.key === author) return true
      if (type === 'garden-help' && record.to === author) return true
      if (type === 'top-friends' && record.keys.includes(author)) return true
      if (type === 'testimonial-show' && (!HEX64.test(record.from) || !isSeq(record.seq) ||
          typeof record.text !== 'string' || typeof record.nonce !== 'string')) return false
      const pollRef = type === 'choice' ? record.to.author + ':' + record.to.seq : null
      if (pollRef !== null && deletedRefs.has(pollRef)) return true
      let replyTo = type === 'post' && record.replyTo ? formatRef(record.replyTo) : null
      let quote = type === 'post' && record.quote ? formatRef(record.quote) : null
      const to = type === 'like' || type === 'repost' ? formatRef(record.to) : null
      // A like or repost of a deleted post is not an engagement. A reply or
      // quote is the author's own post: a deleted parent is stored as none,
      // so the post stays on the timeline and touches no target.
      if (to !== null && deletedRefs.has(to)) return true
      if (replyTo !== null && deletedRefs.has(replyTo)) replyTo = null
      if (quote !== null && deletedRefs.has(quote)) quote = null
      const existing = authors.get(author)
      if (existing && (existing.posts.has(seq) || existing.engagements.has(seq) ||
          indexOfSeq(existing.profileSeqs, seq) !== -1 || indexOfSeq(existing.usernameSeqs, seq) !== -1 ||
          indexOfSeq(existing.copiedSeqs, seq) !== -1 || indexOfSeq(existing.aboutSeqs, seq) !== -1 ||
          indexOfSeq(existing.moodSeqs, seq) !== -1 || existing.testimonials?.has(seq) || existing.shows?.has(seq) ||
          existing.scraps?.has(seq) || existing.scrapHides?.has(seq) || existing.walls?.has(seq) ||
          existing.fanSeqs?.has(seq) || existing.tops?.has(seq) || existing.choiceSeqs?.has(seq) ||
          (existing.visitSeqs !== null && indexOfSeq(existing.visitSeqs, seq) !== -1) ||
          (existing.gardenSeqs !== null && indexOfSeq(existing.gardenSeqs, seq) !== -1) ||
          (existing.gardenStateSeqs !== null && indexOfSeq(existing.gardenStateSeqs, seq) !== -1) ||
          existing.gardenHelps?.has(seq))) return true
      if (type === 'fan' && existing?.fanOps?.has(record.key) !== true && (existing?.fanOps?.size ?? 0) >= FAN_KEYS_MAX) return true
      if (type === 'choice' && existing?.choiceOps?.has(pollRef) !== true &&
          ((existing?.choiceOps?.size ?? 0) >= CHOICE_POLLS_MAX || (pollIn.get(pollRef)?.size ?? 0) >= CHOICE_VOTERS_MAX)) return true
      // The help cap skips (no slot) come before admission, like the fan
      // cap; a kept help past a cap evicts the row helpEvict names (the same
      // writer's) or every row of writer ownerEvict to this addressee.
      // Everything is decided here and nothing changes until the checks
      // below pass, so a refusal leaves no trace.
      let helpEvict = null
      let ownerEvict = null
      if (type === 'garden-help') {
        const now = typeof opts?.now === 'number' && Number.isFinite(opts.now) ? opts.now : null
        const row = { seq, atMs: helpAtMs, to: record.to }
        const writers = helpsByTo.get(record.to)
        const list = writers?.get(author)
        let victim = null
        if (list !== undefined && list.length >= GARDEN_PAIR_MAX) {
          victim = helpVictim([...list.map((r) => ({ seq: r.seq, atMs: r.atMs, to: record.to })), row], now)
        } else if ((existing?.gardenHelps?.size ?? 0) >= GARDEN_WRITER_MAX) {
          const kept = [...existing.gardenHelps].map(([s, info]) => ({ seq: s, atMs: info.atMs, to: info.to }))
          victim = helpVictim([...kept, row], now)
        }
        if (victim !== null) {
          if (victim.seq === seq) return true
          helpEvict = victim.seq
        }
        if (list === undefined && (writers?.size ?? 0) >= GARDEN_WRITERS_PER_OWNER) {
          // A row garden(now) cannot list costs no place. Otherwise the
          // place of a writer none of whose rows garden(now) can list is
          // taken, so stale or far-future rows never hold the cap forever.
          if (now !== null && !gardenListable(helpAtMs, now)) return true
          if (now !== null) ownerEvict = evictableWriter(writers, now)
          if (ownerEvict === null) {
            if (!Number.isNaN(gardenRules.dayStart(helpAtMs))) {
              const until = helpAtMs + gardenRules.GARDEN_HELP_WINDOW_MS + 1
              if (!(gardenFull.get(record.to) >= until)) gardenFull.set(record.to, until)
            }
            return true
          }
        }
      }
      // An eviction of the same writer's row makes the add net zero for the
      // global and the author's counts; another writer's frees global slots
      // only.
      if ((records >= cap && helpEvict === null && ownerEvict === null) ||
          ((existing ? existing.count : 0) >= authorCap && helpEvict === null)) return false
      // Off operations need no new target; they may free one at the cap.
      const needed = new Set([replyTo, quote, record.on === true ? to : null])
      needed.delete(null)
      let extra = 0
      for (const ref of needed) if (!targets.has(ref)) extra++
      if (targets.size + extra > targetCap) return false
      const targetsBefore = targets.size
      if (type === 'post') invalidateNotices(author)
      if (to !== null) invalidateNotices(to.slice(0, 64))
      const entry = authorEntry(author)
      if (type === 'post') {
        const eventPost = isEventPost(record)
        // An event post takes RSVPs as a two-option poll (0 'vou', 1 'talvez'),
        // counted by the poll routes.
        entry.posts.set(seq, { replyTo, quote, poll: eventPost ? EVENT_RSVP_OPTIONS : pollSize(record), event: eventPost })
        addTimeline(entry, seq)
        if (eventPost) {
          if (entry.eventSeqs === null) entry.eventSeqs = []
          const at = lowerBoundSeq(entry.eventSeqs, seq)
          if (entry.eventSeqs[at] !== seq) entry.eventSeqs.splice(at, 0, seq)
        }
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
          toggle(target, 'likes', author, seq, record.on === true, to, entry, atMillis(record.at))
          dropTargetIfEmpty(to, target)
        }
      } else if (type === 'repost') {
        const target = targets.get(to) || (record.on === true ? targetEntry(to) : null)
        if (target !== null && toggle(target, 'reposts', author, seq, record.on === true, to, entry, atMillis(record.at))) {
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
        entry.profileSeqs.splice(lowerBoundSeq(entry.profileSeqs, seq), 0, seq)
      } else if (type === 'testimonial') {
        if (entry.testimonials === null) entry.testimonials = new Map()
        const atMs = atMillis(record.at)
        entry.testimonials.set(seq, { to: record.to, hash: record.hash, atMs })
        let owned = incoming.get(record.to)
        if (owned === undefined) {
          owned = new Map()
          incoming.set(record.to, owned)
        }
        const prev = owned.get(author)
        if (prev === undefined || seq > prev.seq) owned.set(author, { atMs, author, seq })
      } else if (type === 'testimonial-show') {
        if (entry.shows === null) entry.shows = new Map()
        entry.shows.set(seq, { from: record.from, wseq: record.seq, commit: tombstoned ? null : commitment(record.from, record.nonce, record.text), removed: tombstoned })
        if (tombstoned) markDeleted(author, seq)
      } else if (type === 'scrap') {
        addScrap(entry, author, seq, record)
      } else if (type === 'scrap-hide') {
        if (entry.scrapHides === null) {
          entry.scrapHides = new Map()
          entry.hideSeqs = []
          entry.hiddenRefs = new Map()
        }
        const hid = record.from + ':' + record.seq
        entry.scrapHides.set(seq, hid)
        entry.hideSeqs.splice(lowerBoundSeq(entry.hideSeqs, seq), 0, seq)
        entry.hiddenRefs.set(hid, (entry.hiddenRefs.get(hid) || 0) + 1)
      } else if (type === 'scrap-wall') {
        if (entry.walls === null) {
          entry.walls = new Map()
          entry.wallSeqs = []
        }
        entry.walls.set(seq, record.who)
        entry.wallSeqs.splice(lowerBoundSeq(entry.wallSeqs, seq), 0, seq)
      } else if (type === 'profile-about') {
        entry.aboutSeqs.splice(lowerBoundSeq(entry.aboutSeqs, seq), 0, seq)
      } else if (type === 'mood') {
        entry.moodSeqs.splice(lowerBoundSeq(entry.moodSeqs, seq), 0, seq)
      } else if (type === 'visits') {
        if (entry.visitSeqs === null) entry.visitSeqs = []
        entry.visitSeqs.splice(lowerBoundSeq(entry.visitSeqs, seq), 0, seq)
      } else if (type === 'garden') {
        if (entry.gardenSeqs === null) {
          entry.gardenSeqs = []
          entry.gardenOn = new Map()
        }
        entry.gardenSeqs.splice(lowerBoundSeq(entry.gardenSeqs, seq), 0, seq)
        entry.gardenOn.set(seq, record.on)
      } else if (type === 'garden-state') {
        if (entry.gardenStateSeqs === null) entry.gardenStateSeqs = []
        entry.gardenStateSeqs.splice(lowerBoundSeq(entry.gardenStateSeqs, seq), 0, seq)
      } else if (type === 'garden-help') {
        if (ownerEvict !== null) dropWriterHelps(ownerEvict, record.to)
        if (helpEvict !== null) {
          dropHelp(entry, author, helpEvict)
          releaseRecord(entry)
        }
        addHelp(entry, author, seq, record.to, helpAtMs, record.pot)
      } else if (type === 'fan') {
        if (entry.fanSeqs === null) {
          entry.fanSeqs = new Map()
          entry.fanOps = new Map()
        }
        entry.fanSeqs.set(seq, record.key)
        let ops = entry.fanOps.get(record.key)
        if (ops === undefined) {
          ops = []
          entry.fanOps.set(record.key, ops)
        }
        ops.splice(opLowerBound(ops, seq), 0, { seq, at: record.at, on: record.on })
        publishFan(author, record.key, ops)
      } else if (type === 'choice') {
        if (entry.choiceSeqs === null) {
          entry.choiceSeqs = new Map()
          entry.choiceOps = new Map()
        }
        entry.choiceSeqs.set(seq, pollRef)
        let ops = entry.choiceOps.get(pollRef)
        if (ops === undefined) {
          ops = []
          entry.choiceOps.set(pollRef, ops)
        }
        ops.splice(opLowerBound(ops, seq), 0, { seq, at: record.at, pick: record.pick })
        publishChoice(author, pollRef, ops)
      } else if (type === 'top-friends') {
        if (entry.tops === null) {
          entry.tops = new Map()
          entry.topSeqs = []
        }
        entry.tops.set(seq, record.keys.slice())
        entry.topSeqs.splice(lowerBoundSeq(entry.topSeqs, seq), 0, seq)
      } else if (record.member === author) {
        entry.usernameSeqs.splice(lowerBoundSeq(entry.usernameSeqs, seq), 0, seq)
      } else {
        // A copy (member !== author) is not a username hint, but it holds a
        // record slot. Track the seq so a re-add cannot double count and
        // removeRecord can release it.
        entry.copiedSeqs.splice(lowerBoundSeq(entry.copiedSeqs, seq), 0, seq)
      }
      if (type === 'like' || type === 'repost') entry.engagements.set(seq, { type, to })
      entry.count++
      if (entry.count === authorCap) fullAuthors++
      records++
      // A writer evicted at the writers cap frees its slots: a paused diary
      // may go on.
      if (targets.size < targetsBefore || ownerEvict !== null) freed()
      return true
    } catch {
      return false
    }
  }

  // A live garden-help of `author` at `seq` for pot index `pot`, under the
  // writer and under the addressee.
  function addHelp (entry, author, seq, to, atMs, pot) {
    if (entry.gardenHelps === null) entry.gardenHelps = new Map()
    entry.gardenHelps.set(seq, { to, atMs, pot })
    let writers = helpsByTo.get(to)
    if (writers === undefined) {
      writers = new Map()
      helpsByTo.set(to, writers)
    }
    let list = writers.get(author)
    if (list === undefined) {
      list = []
      writers.set(author, list)
    }
    const row = { seq, atMs, pot }
    let at = 0
    while (at < list.length && compareHelps(list[at], row) < 0) at++
    list.splice(at, 0, row)
  }

  // The writer of `writers` (helpsByTo of one addressee) whose place at
  // GARDEN_WRITERS_PER_OWNER may be taken at now: none of its rows to that
  // addressee is listable at now. Of those, the one whose newest row is the
  // oldest, a tie by the lower key, or null. At most GARDEN_WRITERS_PER_OWNER
  // writers of GARDEN_PAIR_MAX rows each.
  function evictableWriter (writers, now) {
    let best = null
    let bestAt = 0
    for (const [writer, list] of writers) {
      if (list.some((r) => gardenListable(r.atMs, now))) continue
      const newest = list[0].atMs
      if (best === null || newest < bestAt || (newest === bestAt && writer < best)) {
        best = writer
        bestAt = newest
      }
    }
    return best
  }

  // Every row of `writer` to `to` leaves both places and frees its slot.
  function dropWriterHelps (writer, to) {
    const entry = authors.get(writer)
    for (const row of helpsByTo.get(to).get(writer).slice()) {
      dropHelp(entry, writer, row.seq)
      releaseRecord(entry)
    }
  }

  // The help leaves both places; the caller releases its slot.
  function dropHelp (entry, author, seq) {
    const info = entry.gardenHelps.get(seq)
    entry.gardenHelps.delete(seq)
    if (entry.gardenHelps.size === 0) entry.gardenHelps = null
    const writers = helpsByTo.get(info.to)
    const list = writers?.get(author)
    if (list === undefined) return
    const at = list.findIndex((r) => r.seq === seq)
    if (at !== -1) list.splice(at, 1)
    if (list.length === 0) writers.delete(author)
    if (writers.size === 0) helpsByTo.delete(info.to)
  }

  // The last live operation of `author` on `key` (the end of `ops`, sorted
  // by seq) decides whether `author` is listed under `key`.
  function publishFan (author, key, ops) {
    const last = ops === undefined || ops.length === 0 ? undefined : ops[ops.length - 1]
    let owned = fanIn.get(key)
    if (last !== undefined && last.on === true) {
      if (owned === undefined) {
        owned = new Map()
        fanIn.set(key, owned)
      }
      owned.set(author, { seq: last.seq, at: last.at })
    } else if (owned !== undefined) {
      owned.delete(author)
      if (owned.size === 0) fanIn.delete(key)
    }
  }

  // The voter's operations on `ref` (ascending seq) are listed under the poll
  // while it has any.
  function publishChoice (author, ref, ops) {
    let owned = pollIn.get(ref)
    if (ops.length > 0) {
      if (owned === undefined) {
        owned = new Map()
        pollIn.set(ref, owned)
      }
      owned.set(author, ops)
    } else if (owned !== undefined) {
      owned.delete(author)
      if (owned.size === 0) pollIn.delete(ref)
    }
  }

  // A live scrap of `author` at `seq`: kept under the writer (its own
  // scraps are also the originals a reply on its page answers) and, unless
  // left on its own page, under the page owner.
  function addScrap (entry, author, seq, record) {
    const to = record.to
    const atMs = atMillis(record.at)
    const t = Date.parse(record.at)
    const rt = record.replyTo !== null && record.replyTo.author === to ? record.replyTo.seq : 0
    if (entry.scraps === null) {
      entry.scraps = new Map()
      entry.scrapsByTo = new Map()
    }
    entry.scraps.set(seq, { to, atMs, t, rt })
    let mine = entry.scrapsByTo.get(to)
    if (mine === undefined) {
      mine = new Set()
      entry.scrapsByTo.set(to, mine)
    }
    mine.add(seq)
    // An original indexed after (or again after) its replies: their list
    // learns its date.
    const answers = scrapIn.get(author)?.get(to)?.replies?.get(seq)
    if (answers !== undefined) refreshReplyList(answers, t)
    if (to === author) return
    let owned = scrapIn.get(to)
    if (owned === undefined) {
      owned = new Map()
      scrapIn.set(to, owned)
    }
    let rec = owned.get(author)
    if (rec === undefined) {
      rec = { edges: [], replies: null }
      owned.set(author, rec)
    }
    const edge = { atMs, seq }
    // Quadratic insert, bounded like insertSorted: a writer holds at most
    // perAuthorMax records.
    rec.edges.splice(scrapLowerBound(rec.edges, edge), 0, edge)
    if (rt !== 0) {
      if (rec.replies === null) rec.replies = new Map()
      let list = rec.replies.get(rt)
      if (list === undefined) {
        list = newReplyList(authors.get(to)?.scraps?.get(rt)?.t ?? null)
        rec.replies.set(rt, list)
      }
      replyListInsert(list, t, seq)
    }
  }

  // The scrap leaves both places; the next reply of the same writer to the
  // same original, if any, takes its slot at read time.
  function dropScrap (entry, author, seq, info) {
    entry.scraps.delete(seq)
    const mine = entry.scrapsByTo.get(info.to)
    if (mine !== undefined) {
      mine.delete(seq)
      if (mine.size === 0) entry.scrapsByTo.delete(info.to)
    }
    if (entry.scraps.size === 0) {
      entry.scraps = null
      entry.scrapsByTo = null
    }
    const owned = scrapIn.get(info.to)
    const rec = owned?.get(author)
    if (rec === undefined) return
    const at = scrapLowerBound(rec.edges, { atMs: info.atMs, seq })
    if (rec.edges[at]?.seq === seq) rec.edges.splice(at, 1)
    const list = info.rt !== 0 ? rec.replies?.get(info.rt) : undefined
    if (list !== undefined) {
      replyListRemove(list, info.t, seq)
      if (list.seqs.length === 0) rec.replies.delete(info.rt)
      if (rec.replies.size === 0) rec.replies = null
    }
    if (rec.edges.length === 0) owned.delete(author)
    if (owned.size === 0) scrapIn.delete(info.to)
  }

  function markDeleted (author, seq) {
    if (!deleted.has(author)) deleted.set(author, new Set())
    deleted.get(author).add(seq)
  }

  function releaseRecord (entry) {
    if (entry.count === authorCap) fullAuthors--
    entry.count--
    records--
  }

  function removePost (author, seq) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author) || !isSeq(seq)) return false
      const ref = author + ':' + seq
      invalidateNotices(author)
      markDeleted(author, seq)
      deletedRefs.add(ref)
      const entry = authors.get(author)
      const info = entry?.posts.get(seq)
      if (info === undefined && !targets.has(ref)) return false
      if (info !== undefined) {
        for (const [type, parent] of [['replies', info.replyTo], ['quotes', info.quote]]) {
          const other = targets.get(parent)
          if (other === undefined || other[type] === null) continue
          const at = other[type].findIndex((e) => e.author === author && e.seq === seq)
          if (at === -1) continue
          other[type].splice(at, 1)
          other[type + 'Total']--
          if (other[type].length === 0) other[type] = null
          touch(entry, parent, -1)
          dropTargetIfEmpty(parent, other)
        }
        entry.posts.delete(seq)
        removeTimeline(entry, seq)
        if (info.event === true && entry.eventSeqs !== null) {
          const at = indexOfSeq(entry.eventSeqs, seq)
          if (at !== -1) entry.eventSeqs.splice(at, 1)
          if (entry.eventSeqs.length === 0) entry.eventSeqs = null
        }
        releaseRecord(entry)
      }
      const target = targets.get(ref)
      if (target !== undefined) {
        for (const type of ['replies', 'quotes']) {
          for (const edge of target[type] || EMPTY_LIST) authors.get(edge.author).touched.delete(ref)
        }
        for (const type of ['likes', 'reposts']) {
          if (target[type] === null) continue
          for (const engager of target[type].keys()) {
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
      freed()
      return true
    } catch {
      return false
    }
  }

  function removeRecord (author, seq) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author) || !isSeq(seq)) return false
      const entry = authors.get(author)
      // A tombstone can name a seq this cursor has not indexed yet (paused
      // at the cap, or a target that exists only because someone else
      // engaged it). That still has to guard the ref, same as removePost.
      if (entry === undefined) return removePost(author, seq)
      if (entry.posts.has(seq)) return removePost(author, seq)
      const show = entry.shows === null ? undefined : entry.shows.get(seq)
      if (show !== undefined) {
        // Keeps its record slot: it is the memory of the removal rule.
        show.removed = true
        show.commit = null
        markDeleted(author, seq)
        return true
      }
      let found = false
      const scrap = entry.scraps === null ? undefined : entry.scraps.get(seq)
      if (scrap !== undefined) {
        dropScrap(entry, author, seq, scrap)
        found = true
      }
      const hid = entry.scrapHides === null ? undefined : entry.scrapHides.get(seq)
      if (hid !== undefined) {
        entry.scrapHides.delete(seq)
        entry.hideSeqs.splice(indexOfSeq(entry.hideSeqs, seq), 1)
        const n = entry.hiddenRefs.get(hid) - 1
        if (n > 0) entry.hiddenRefs.set(hid, n)
        else entry.hiddenRefs.delete(hid)
        if (entry.scrapHides.size === 0) {
          entry.scrapHides = null
          entry.hideSeqs = null
          entry.hiddenRefs = null
        }
        found = true
      }
      if (entry.walls !== null && entry.walls.has(seq)) {
        entry.walls.delete(seq)
        entry.wallSeqs.splice(indexOfSeq(entry.wallSeqs, seq), 1)
        if (entry.walls.size === 0) {
          entry.walls = null
          entry.wallSeqs = null
        }
        found = true
      }
      const fanKey = entry.fanSeqs === null ? undefined : entry.fanSeqs.get(seq)
      if (fanKey !== undefined) {
        entry.fanSeqs.delete(seq)
        const ops = entry.fanOps.get(fanKey)
        const at = opLowerBound(ops, seq)
        if (ops[at]?.seq === seq) ops.splice(at, 1)
        if (ops.length === 0) entry.fanOps.delete(fanKey)
        publishFan(author, fanKey, ops)
        if (entry.fanSeqs.size === 0) {
          entry.fanSeqs = null
          entry.fanOps = null
        }
        found = true
      }
      const pollRef = entry.choiceSeqs === null ? undefined : entry.choiceSeqs.get(seq)
      if (pollRef !== undefined) {
        entry.choiceSeqs.delete(seq)
        const ops = entry.choiceOps.get(pollRef)
        const at = opLowerBound(ops, seq)
        if (ops[at]?.seq === seq) ops.splice(at, 1)
        if (ops.length === 0) entry.choiceOps.delete(pollRef)
        publishChoice(author, pollRef, ops)
        if (entry.choiceSeqs.size === 0) {
          entry.choiceSeqs = null
          entry.choiceOps = null
        }
        found = true
      }
      if (entry.tops !== null && entry.tops.has(seq)) {
        entry.tops.delete(seq)
        entry.topSeqs.splice(indexOfSeq(entry.topSeqs, seq), 1)
        if (entry.tops.size === 0) {
          entry.tops = null
          entry.topSeqs = null
        }
        found = true
      }
      const testimonial = entry.testimonials === null ? undefined : entry.testimonials.get(seq)
      if (testimonial !== undefined) {
        dropIncoming(testimonial.to, author, seq)
        entry.testimonials.delete(seq)
        if (entry.testimonials.size === 0) entry.testimonials = null
        found = true
      }
      if (entry.visitSeqs !== null) {
        const at = indexOfSeq(entry.visitSeqs, seq)
        if (at !== -1) {
          entry.visitSeqs.splice(at, 1)
          if (entry.visitSeqs.length === 0) entry.visitSeqs = null
          found = true
        }
      }
      if (entry.gardenSeqs !== null) {
        const at = indexOfSeq(entry.gardenSeqs, seq)
        if (at !== -1) {
          entry.gardenSeqs.splice(at, 1)
          entry.gardenOn.delete(seq)
          if (entry.gardenSeqs.length === 0) {
            entry.gardenSeqs = null
            entry.gardenOn = null
          }
          found = true
        }
      }
      if (entry.gardenStateSeqs !== null) {
        const at = indexOfSeq(entry.gardenStateSeqs, seq)
        if (at !== -1) {
          entry.gardenStateSeqs.splice(at, 1)
          if (entry.gardenStateSeqs.length === 0) entry.gardenStateSeqs = null
          found = true
        }
      }
      if (entry.gardenHelps?.has(seq)) {
        dropHelp(entry, author, seq)
        found = true
      }
      for (const list of [entry.profileSeqs, entry.usernameSeqs, entry.copiedSeqs, entry.aboutSeqs, entry.moodSeqs]) {
        const at = indexOfSeq(list, seq)
        if (at === -1) continue
        list.splice(at, 1)
        found = true
        break
      }
      const engagement = entry.engagements.get(seq)
      if (engagement !== undefined) {
        const { type, to } = engagement
        invalidateNotices(to.slice(0, 64))
        const kind = type === 'like' ? 'likes' : 'reposts'
        const target = targets.get(to)
        const edge = target?.[kind]?.get(author)
        if (edge !== undefined && edge.seq === seq) {
          unengage(target, kind, author, edge)
          target[kind + 'Total']--
          touch(entry, to, -1)
          if (type === 'repost') {
            removeTimeline(entry, seq)
            entry.reposts.delete(to)
          }
          dropTargetIfEmpty(to, target)
        }
        entry.engagements.delete(seq)
        found = true
      }
      if (!found) return removePost(author, seq)
      markDeleted(author, seq)
      releaseRecord(entry)
      freed()
      return true
    } catch {
      return false
    }
  }

  // Block `seq` of `author` to `owner` leaves the index (called before it
  // leaves author's testimonials). When it was that writer's newest, the
  // next newest live block of the same writer to the same owner takes over,
  // read from that writer's own blocks only.
  function dropIncoming (owner, author, seq) {
    const owned = incoming.get(owner)
    if (owned === undefined) return
    const current = owned.get(author)
    if (current === undefined || current.seq !== seq) return
    let best = null
    for (const [s, t] of authors.get(author)?.testimonials || EMPTY_LIST) {
      if (s !== seq && t.to === owner && (best === null || s > best.seq)) best = { atMs: t.atMs, author, seq: s }
    }
    if (best !== null) owned.set(author, best)
    else owned.delete(author)
    if (owned.size === 0) incoming.delete(owner)
  }

  // Every block of `author` leaves the index at once.
  function dropWriter (owner, author) {
    const owned = incoming.get(owner)
    if (owned === undefined) return
    owned.delete(author)
    if (owned.size === 0) incoming.delete(owner)
  }

  // Removes every trace of a diary: its edges on every target it touched,
  // its engager entries, its posts and hints, and targets belonging to it.
  // Quotas still count all accepted operations of every remaining diary.
  function removeDiary (author, onIncomingRemoved = null) {
    try {
      // The diary's own edges sit on other authors' targets too.
      noticeCache.clear()
      const removed = deleted.get(author)
      if (removed !== undefined) {
        for (const seq of removed) deletedRefs.delete(author + ':' + seq)
        deleted.delete(author)
      }
      const entry = authors.get(author)
      const owned = authorTargets.get(author)
      if (entry === undefined && owned === undefined) return removed !== undefined
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
          const edge = target[type].get(author)
          if (edge === undefined) continue
          unengage(target, type, author, edge)
          target[type + 'Total']--
        }
        dropTargetIfEmpty(ref, target)
      }
      for (const t of entry?.testimonials?.values() || EMPTY_LIST) dropWriter(t.to, author)
      for (const to of entry?.scrapsByTo?.keys() || EMPTY_LIST) {
        const owned = scrapIn.get(to)
        if (owned === undefined) continue
        owned.delete(author)
        if (owned.size === 0) scrapIn.delete(to)
      }
      for (const key of entry?.fanOps?.keys() || EMPTY_LIST) {
        const listed = fanIn.get(key)
        if (listed === undefined) continue
        listed.delete(author)
        if (listed.size === 0) fanIn.delete(key)
      }
      for (const ref of entry?.choiceOps?.keys() || EMPTY_LIST) {
        const listed = pollIn.get(ref)
        if (listed === undefined) continue
        listed.delete(author)
        if (listed.size === 0) pollIn.delete(ref)
      }
      for (const info of entry?.gardenHelps?.values() || EMPTY_LIST) {
        const writers = helpsByTo.get(info.to)
        if (writers === undefined) continue
        writers.delete(author)
        if (writers.size === 0) helpsByTo.delete(info.to)
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
    return { profileSeq: entry.profileSeqs.at(-1) ?? null, usernameSeq: entry.usernameSeqs.at(-1) ?? null }
  }

  // Perfil rico pointers of `author`: { about, mood, top, visits, garden }, the seq of
  // its newest live `profile-about` and `mood` block, null when it has none,
  // top { seq, keys } its newest live `top-friends` block (keys a fresh copy)
  // or null, and visits the seq of its newest live `visits` block (Visitas:
  // the pointer says nothing about on or off, the node peeks the block and
  // reads it) or null, and garden the seq of its newest live `garden` block
  // (Varandinha, on or off like visits) or null. The object is OPEN: later
  // features add pointers to it and readers ignore keys they do not know. The
  // node reads and verifies the blocks.
  function profileExtra (author) {
    const entry = typeof author === 'string' ? authors.get(author) : undefined
    const topSeq = entry?.topSeqs?.at(-1)
    const top = topSeq === undefined ? null : { seq: topSeq, keys: entry.tops.get(topSeq).slice() }
    return { about: entry?.aboutSeqs.at(-1) ?? null, mood: entry?.moodSeqs.at(-1) ?? null, top, visits: entry?.visitSeqs?.at(-1) ?? null, garden: entry?.gardenSeqs?.at(-1) ?? null }
  }

  // The writers whose last live `fan` operation on `author` is on, newest
  // first (the at clamped at 0 like lib/notices.js followsPage, then key):
  // { items: [{ key, seq, at }] (at most FAN_PAGE, strictly after `after`
  // { atMs, key }), next: { atMs, key } | null, total } over the writers
  // `visible` keeps (a throw hides one); null for a malformed author or
  // cursor. seq and at point at the writer's own block, which the node
  // peeks and verifies.
  function fans (author, { after = null, visible = allVisible } = {}) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author)) return null
      if (after !== null && (typeof after !== 'object' || !Number.isSafeInteger(after.atMs) || after.atMs < 0 ||
          typeof after.key !== 'string' || !HEX64.test(after.key))) return null
      const rows = fanRows(author, visible)
      rows.sort(compareFanRows)
      const items = []
      let more = false
      for (const row of rows) {
        if (after !== null && compareFanRows(row, after) <= 0) continue
        if (items.length === FAN_PAGE) {
          more = true
          break
        }
        items.push(row)
      }
      const last = items[items.length - 1]
      return {
        items: items.map((r) => ({ key: r.key, seq: r.seq, at: r.at })),
        next: more ? { atMs: last.atMs, key: last.key } : null,
        total: rows.length
      }
    } catch {
      return null
    }
  }

  // The number of rows fans() would list for `author` in all; 0 on bad input.
  function fanCount (author, visible = allVisible) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author)) return 0
      return fanRows(author, visible).length
    } catch {
      return 0
    }
  }

  function fanRows (author, visible) {
    const rows = []
    for (const [key, e] of fanIn.get(author) || EMPTY_LIST) {
      if (key === author) continue
      let shown = false
      try {
        shown = visible(key) === true
      } catch {}
      if (shown) rows.push({ atMs: atMillis(e.at), key, seq: e.seq, at: e.at })
    }
    return rows
  }

  // The live votes of the poll post `author:seq`: { count, totals, rows } with
  // count the poll's option count, totals the votes per option (foldPicks)
  // and rows [{ key, seq, at, pick }] one per voter `visible` keeps (a throw
  // hides one) that has a live pick; null when that post is not an indexed,
  // live poll post (a deleted post, a post without a valid `poll`, or one
  // the index does not hold), or `author` is malformed. seq and at point at
  // the voter's own block, which the node peeks and verifies. Operations
  // dated more than MAX_FUTURE_MS after `now` are skipped.
  function pollRows (author, seq, visible, now) {
    if (typeof author !== 'string' || !HEX64.test(author) || !isSeq(seq)) return null
    const ref = author + ':' + seq
    const count = deletedRefs.has(ref) ? 0 : authors.get(author)?.posts.get(seq)?.poll ?? 0
    if (count === 0) return null
    if (typeof visible !== 'function') visible = allVisible
    const rows = []
    const flat = []
    for (const [voter, ops] of pollIn.get(ref) || EMPTY_LIST) {
      let shown = false
      try {
        shown = visible(voter) === true
      } catch {}
      if (!shown) continue
      const due = ops.filter((o) => !(Date.parse(o.at) - now > MAX_FUTURE_MS))
      const live = foldPicks(due.map((o) => ({ voter, pick: o.pick })), count).picks.get(voter)
      if (live === undefined) continue
      // The block that set it: the newest operation holding an in-range pick.
      let at = due.length - 1
      while (at > 0 && !(due[at].pick === null || due[at].pick < count)) at--
      rows.push({ key: voter, seq: due[at].seq, at: due[at].at, pick: live })
      flat.push({ voter, pick: live })
    }
    return { count, totals: foldPicks(flat, count).totals, rows }
  }

  // The votes of the poll `author:seq` as option totals: { totals } (the
  // `count` integers of foldPicks) over the voters `visible` keeps; null when
  // the post is not a live poll post. Counts are seeder claims. `now` (ms,
  // default Date.now()) as in pollRows.
  function pollTotals (author, seq, { visible = allVisible, now = Date.now() } = {}) {
    try {
      const got = pollRows(author, seq, visible, Number.isFinite(now) ? now : Date.now())
      return got === null ? null : { totals: got.totals }
    } catch {
      return null
    }
  }

  // The voters whose live pick on the poll `author:seq` is `pick`, newest
  // first (the at clamped at 0, then key, as fans()): { items: [{ key, seq,
  // at }] (at most CHOICE_PAGE, strictly after `after` { atMs, key }), next:
  // { atMs, key } | null, total } ; null for a malformed author, seq, pick
  // (an integer in 0..count-1) or cursor, or a post that is not a live poll
  // post. `now` as in pollTotals.
  function pollVoters (author, seq, pick, { after = null, visible = allVisible, now = Date.now() } = {}) {
    try {
      if (after !== null && (typeof after !== 'object' || !Number.isSafeInteger(after.atMs) || after.atMs < 0 ||
          typeof after.key !== 'string' || !HEX64.test(after.key))) return null
      const got = pollRows(author, seq, visible, Number.isFinite(now) ? now : Date.now())
      if (got === null || !Number.isSafeInteger(pick) || pick < 0 || pick >= got.count) return null
      const rows = []
      for (const r of got.rows) if (r.pick === pick) rows.push({ atMs: atMillis(r.at), key: r.key, seq: r.seq, at: r.at })
      rows.sort(compareFanRows)
      const items = []
      let more = false
      for (const row of rows) {
        if (after !== null && compareFanRows(row, after) <= 0) continue
        if (items.length === CHOICE_PAGE) {
          more = true
          break
        }
        items.push(row)
      }
      const last = items[items.length - 1]
      return {
        items: items.map((r) => ({ key: r.key, seq: r.seq, at: r.at })),
        next: more ? { atMs: last.atMs, key: last.key } : null,
        total: rows.length
      }
    } catch {
      return null
    }
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
      if (info.replyTo !== null && !deletedRefs.has(info.replyTo)) {
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

  // The roda (conversation circle) of a reply: the thread root, the
  // top-level comment `top` under it, and every reply of top's subtree as
  // { ref, to } (to = the parent ref), flattened so a parent always comes
  // before its children, at most RODA_PAGE strictly after `cursor`. Nothing
  // is stored for it: each call walks the stored replyTo links up and the
  // reply lists down, at most RODA_SCAN hops up and RODA_SCAN edges down,
  // so a request costs O(min(descendants, RODA_SCAN)) and is recomputed for
  // every page. Null for a malformed ref or cursor, a post not indexed, a
  // post that is not a reply, and a walk up that meets a missing, deleted or
  // hidden post, a cycle (refs are predictable, so two diaries can reply to
  // each other's future posts) or the bound. `truncated` says the walk down
  // stopped at the bound with edges left unexamined.
  function roda (ref, cursor = null, visible = allVisible) {
    try {
      const parsed = validRef(ref)
      if (parsed === null) return null
      const after = parseCursor(cursor)
      if (after === undefined) return null
      if (typeof visible !== 'function') visible = allVisible
      const entry = authors.get(parsed.author)
      if (entry === undefined || !visible(parsed.author)) return null
      const info = entry.posts.get(parsed.seq)
      if (info === undefined || info.replyTo === null) return null
      // `root` is only a claim: add() stores replyTo as null when the parent
      // was already deleted, so an orphaned reply looks like a root here.
      const seenUp = new Set([ref])
      let top = ref
      let parent = info.replyTo
      let root = null
      for (let hops = 0; root === null; hops++) {
        if (hops >= RODA_SCAN || seenUp.has(parent) || deletedRefs.has(parent)) return null
        seenUp.add(parent)
        const p = validRef(parent)
        if (p === null) return null
        const pinfo = authors.get(p.author)?.posts.get(p.seq)
        if (pinfo === undefined || !visible(p.author)) return null
        if (pinfo.replyTo === null) {
          root = parent
        } else {
          top = parent
          parent = pinfo.replyTo
        }
      }
      // Breadth first from top. The listing key of a node is its own atMs
      // raised to one past its parent's, so a child dated before its parent
      // (a skewed or hostile clock) still sorts after it under compareEdges
      // and the reply cursor grammar.
      const kept = []
      const seenDown = new Set([top])
      const queue = [top]
      let examined = 0
      let truncated = false
      const effOf = new Map()
      for (let qi = 0; qi < queue.length && !truncated; qi++) {
        const node = queue[qi]
        const list = targets.get(node)?.replies || EMPTY_LIST
        const base = effOf.get(node)
        for (const edge of list) {
          if (examined >= RODA_SCAN) {
            truncated = true
            break
          }
          examined++
          const child = edgeRef(edge)
          if (seenDown.has(child)) continue
          seenDown.add(child)
          if (!visible(edge.author)) continue
          const atMs = base === undefined ? edge.atMs : Math.max(edge.atMs, base + 1)
          effOf.set(child, atMs)
          kept.push({ atMs, author: edge.author, seq: edge.seq, ref: child, to: node })
          queue.push(child)
        }
      }
      kept.sort(compareEdges)
      const start = after === null ? 0 : upperBound(kept, after)
      const page = kept.slice(start, start + RODA_PAGE)
      const authorHints = {}
      const hint = (author) => { if (!(author in authorHints)) authorHints[author] = hints(author) }
      hint(parsed.author)
      hint(root.slice(0, 64))
      hint(top.slice(0, 64))
      for (const item of page) hint(item.author)
      return {
        ref,
        root,
        top,
        items: page.map((item) => ({ ref: item.ref, to: item.to })),
        next: page.length > 0 && start + page.length < kept.length ? edgeCursor(page[page.length - 1]) : null,
        total: kept.length,
        truncated,
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

  // The engagers ('likes' or 'reposts') of an indexed post, newest first,
  // strictly after `cursor`: at most ENGAGER_PAGE listed and PAGE_SCAN
  // examined, hidden ones included. `next` is built only from the last
  // listed edge, never from a hidden one, since the cursor carries the
  // engager key, seq and time; a page that examined PAGE_SCAN edges and
  // listed nobody ends the list. `total` is every engager currently on, the same
  // number post() gives, not reduced by visibility or the future rule.
  function engagers (ref, kind, cursor = null, visible = allVisible, now) {
    try {
      if (kind !== 'likes' && kind !== 'reposts') return null
      const parsed = validRef(ref)
      if (parsed === null) return null
      const before = parseCursor(cursor)
      if (before === undefined) return null
      if (typeof now !== 'number' || !Number.isFinite(now)) return null
      if (typeof visible !== 'function') visible = allVisible
      const entry = authors.get(parsed.author)
      if (entry === undefined || !visible(parsed.author)) return null
      if (!entry.posts.has(parsed.seq)) return null
      const target = targets.get(ref)
      const engaged = target ? target[kind] : null
      let list = EMPTY_LIST
      if (target && target[edgesOf(kind)] !== null) list = target[edgesOf(kind)]
      else if (engaged !== null && engaged !== undefined && engaged.size === 1) list = [...engaged.values()]
      let top = notFutureTop(list, now)
      if (before !== null) top = Math.min(top, engagerLowerBound(list, before))
      const items = []
      const authorHints = {}
      let last = -1
      let lastListed = -1
      for (let i = top - 1; i >= 0 && top - i <= PAGE_SCAN && items.length < ENGAGER_PAGE; i--) {
        const edge = list[i]
        last = i
        if (!visible(edge.author)) continue
        lastListed = i
        items.push(edgeRef(edge))
        authorHints[edge.author] = hints(edge.author)
      }
      return {
        ref,
        kind,
        items,
        next: lastListed >= 0 && last > 0 ? edgeCursor(list[lastListed]) : null,
        total: target ? target[kind + 'Total'] : 0,
        authors: authorHints
      }
    } catch {
      return null
    }
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
      return { ...hints(author), posts, postsTotal: entry.timeline.length }
    } catch {
      return null
    }
  }

  // The event posts of an author: seqs descending, strictly below `before`
  // (exclusive, null = from the newest), at most EVENT_PAGE, as
  // { posts: [seq], next: seq | null, total }. `next` is the last seq of a
  // full page with older ones left, the `before` of the next request. Seqs
  // only: the node reads each block from the diary and verifies it (event
  // rules, deletion, hiding). Null for a malformed author or cursor; an
  // author with no event post answers an empty page.
  function events (author, before = null) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author)) return null
      if (before !== null && before !== undefined && !isSeq(before)) return null
      const list = authors.get(author)?.eventSeqs ?? EMPTY_LIST
      const end = before === null || before === undefined ? list.length : lowerBoundSeq(list, before)
      const posts = []
      for (let i = end - 1; i >= 0 && posts.length < EVENT_PAGE; i--) posts.push(list[i])
      const more = end - posts.length > 0
      return { posts, next: more ? posts[posts.length - 1] : null, total: list.length }
    } catch {
      return null
    }
  }

  // Likes and reposts aimed at `author`'s indexed posts, as notice rows
  // { key, seq, at, kind } newest first (atMs desc, key asc, seq desc). The
  // first read of an author collects the edges aimed at its indexed posts
  // (bounded by maxRecords), drops the far-future ones and those past
  // NOTICE_ROWS_PER_ENGAGER per engager, and memoizes the newest
  // NOTICE_SCAN_MAX left in noticeCache; every read, the first included,
  // then examines at most those NOTICE_SCAN_MAX edges, until a write touches
  // that author or a far-future edge comes due. The notices channel serves
  // it only to the key that proved itself, at that channel's message rate.
  // A far-future edge takes no slot of any cap: it stays hidden, never
  // removed, as in engagers(), and enters on the first read once the clock
  // catches up. Neither does one engager's edges beyond its newest
  // NOTICE_ROWS_PER_ENGAGER. `visible(engagerHex)` is the seeder's and can
  // change without a write, so it runs on each read, after the scan cap and
  // before the row caps: a hidden engager never takes a row slot, but its
  // edges (at most NOTICE_ROWS_PER_ENGAGER each) do count toward the scan
  // cap. The row caps forget older rows and never count:
  // NOTICE_ROWS_PER_ENGAGER per engager, so one engager cannot crowd out the
  // others, then NOTICE_ROWS_MAX overall. The scan cap is different: when it
  // ends the scan before NOTICE_ROWS_MAX rows and older edges were left out
  // (hidden engagers holding many of the newest slots, say), rows a visible
  // engager holds may be missing, and noticePage says `incomplete`.
  // Residual: an edge whose `at` is pre-1970 was clamped
  // to atMs 0 by atMillis, so its ISO string would not round-trip to the
  // signed record; it is skipped, as a browser would drop it anyway. An
  // `at` of exactly 1970-01-01T00:00:00.000Z is also stored as atMs 0 and
  // skipped the same way.
  function noticeRows (author, now, visible = allVisible) {
    return noticePage(author, now, visible).rows
  }

  // -> { rows, incomplete }: noticeRows plus whether the scan cap cut it.
  function noticePage (author, now, visible = allVisible) {
    try {
      if (typeof author !== 'string' || !HEX64.test(author)) return { rows: [], incomplete: false }
      if (typeof now !== 'number' || !Number.isFinite(now)) return { rows: [], incomplete: false }
      if (typeof visible !== 'function') visible = allVisible
      const { edges, cut } = noticeEdges(author, now)
      const perEngager = new Map()
      const shown = new Map()
      const rows = []
      for (const edge of edges) {
        if (rows.length >= NOTICE_ROWS_MAX) break
        if (edge.atMs - now > MAX_FUTURE_MS) continue
        const seen = perEngager.get(edge.key) || 0
        if (seen >= NOTICE_ROWS_PER_ENGAGER) continue
        let ok = shown.get(edge.key)
        if (ok === undefined) {
          ok = !!visible(edge.key)
          shown.set(edge.key, ok)
        }
        if (!ok) continue
        perEngager.set(edge.key, seen + 1)
        rows.push({ key: edge.key, seq: edge.seq, at: new Date(edge.atMs).toISOString(), kind: edge.kind })
      }
      return { rows, incomplete: cut && rows.length < NOTICE_ROWS_MAX }
    } catch {
      return { rows: [], incomplete: false }
    }
  }

  function noticeEdges (author, now) {
    const cached = noticeCache.get(author)
    noticeCache.delete(author)
    if (cached !== undefined && now >= cached.builtAt && now < cached.wakeAt) {
      noticeCache.set(author, cached)
      return cached
    }
    let edges = []
    let wakeAt = Infinity
    const entry = authors.get(author)
    const refs = authorTargets.get(author)
    if (entry !== undefined && refs !== undefined) {
      for (const ref of refs) {
        if (deletedRefs.has(ref)) continue
        const parsed = validRef(ref)
        if (parsed === null || !entry.posts.has(parsed.seq)) continue
        const target = targets.get(ref)
        if (target === undefined) continue
        for (const [type, kind] of [['likes', 'like'], ['reposts', 'repost']]) {
          if (target[type] === null) continue
          for (const [engager, edge] of target[type]) {
            if (engager === author || edge.atMs === 0) continue
            if (edge.atMs - now > MAX_FUTURE_MS) {
              wakeAt = Math.min(wakeAt, edge.atMs - MAX_FUTURE_MS)
              continue
            }
            edges.push({ key: engager, seq: edge.seq, atMs: edge.atMs, kind })
          }
        }
      }
      edges.sort(compareNoticeRows)
      const perEngager = new Map()
      edges = edges.filter((edge) => {
        const seen = perEngager.get(edge.key) || 0
        perEngager.set(edge.key, seen + 1)
        return seen < NOTICE_ROWS_PER_ENGAGER
      })
    }
    const cut = edges.length > NOTICE_SCAN_MAX
    if (cut) edges.length = NOTICE_SCAN_MAX
    const memo = { edges, cut, builtAt: now, wakeAt }
    noticeCache.set(author, memo)
    if (noticeCache.size > NOTICE_CACHE_AUTHORS) noticeCache.delete(noticeCache.keys().next().value)
    return memo
  }

  // Pointers to the depoimentos of `owner` (see the header): { shown: [{ seq,
  // from, wseq }] by show seq descending, pending: [{ from, seq }] newest
  // first by the writer's own `at` claim (then writer, then seq) }, at most
  // TESTIMONIAL_ROWS each, one row per writer in each list. `visible`
  // filters writers after sorting, so a hidden writer is never examined
  // past the cap; a pending block dated more than MAX_FUTURE_MS after `now`
  // is hidden until the clock catches up. Null for a malformed owner.
  function testimonials (owner, now, visible = allVisible) {
    try {
      if (typeof owner !== 'string' || !HEX64.test(owner)) return null
      if (typeof now !== 'number' || !Number.isFinite(now)) return null
      if (typeof visible !== 'function') visible = allVisible
      const entry = authors.get(owner)
      const everShown = new Set()
      const newestShow = new Map()
      for (const [showSeq, show] of entry?.shows || EMPTY_LIST) {
        everShown.add(show.from + ':' + show.wseq)
        const prev = newestShow.get(show.from)
        if (prev === undefined || showSeq > prev.seq) newestShow.set(show.from, { seq: showSeq, from: show.from, wseq: show.wseq, show })
      }
      const shownRows = []
      for (const row of newestShow.values()) {
        const { show } = row
        if (show.removed || show.from === owner) continue
        const writer = authors.get(show.from)
        const block = writer?.testimonials?.get(show.wseq)
        if (block === undefined || block.to !== owner || block.hash !== show.commit) continue
        shownRows.push(row)
      }
      shownRows.sort((a, b) => b.seq - a.seq)
      const shown = []
      for (const row of shownRows) {
        if (shown.length >= TESTIMONIAL_ROWS) break
        if (visible(row.from)) shown.push({ seq: row.seq, from: row.from, wseq: row.wseq })
      }
      const pendingEdges = []
      for (const edge of incoming.get(owner)?.values() || EMPTY_LIST) {
        if (edge.author === owner) continue
        if (everShown.has(edge.author + ':' + edge.seq)) continue
        if (edge.atMs - now > MAX_FUTURE_MS) continue
        pendingEdges.push(edge)
      }
      pendingEdges.sort((a, b) => compareEdges(b, a))
      const pending = []
      for (const edge of pendingEdges) {
        if (pending.length >= TESTIMONIAL_ROWS) break
        if (visible(edge.author)) pending.push({ from: edge.author, seq: edge.seq })
      }
      return { shown, pending }
    } catch {
      return null
    }
  }

  // The recados of `owner`'s page (see the header): { rows: [{ author, seq,
  // followSeq }] (one page of SCRAP_ROWS, strictly after `cursor`), next:
  // cursor string | null, hides: the owner's live scrap-hide seqs (newest
  // SCRAP_HIDES, descending), wall: the seq of its effective scrap-wall or
  // null, truncated }. `visible(writer)` and `followSeq(writer)` (the seq
  // of the owner's live follow of that writer, or null) run once per writer
  // before its caps; a throw hides the writer or means no follow. followSeq
  // is null on a row admitted by 'everyone' or the reply exception. Null for
  // a malformed owner, clock or cursor. `followed`, when given, is the
  // owner's committed live follow targets: under 'following' only those
  // writers and the ones the owner addressed (reply exception candidates)
  // are walked, not every writer of the page.
  function scraps (owner, now, { visible = allVisible, followSeq = noFollow, followed = null, cursor = null } = {}) {
    try {
      if (typeof owner !== 'string' || !HEX64.test(owner)) return null
      if (typeof now !== 'number' || !Number.isFinite(now)) return null
      const after = parseCursor(cursor)
      if (after === undefined) return null
      const shows = (hex) => {
        try { return visible(hex) === true } catch { return false }
      }
      const follows = (hex) => {
        try {
          const n = followSeq(hex)
          return isSeq(n) ? n : null
        } catch {
          return null
        }
      }
      const entry = authors.get(owner)
      const wall = entry?.wallSeqs?.at(-1) ?? null
      const who = wall === null ? 'following' : entry.walls.get(wall)
      const hides = []
      const hideSeqs = entry?.hideSeqs || EMPTY_LIST
      for (let i = hideSeqs.length - 1; i >= 0 && hides.length < SCRAP_HIDES; i--) hides.push(hideSeqs[i])
      if (who === 'nobody') return { rows: [], next: null, hides, wall, truncated: false }
      const hidden = entry?.hiddenRefs || null
      const isHidden = (writer, seq) => hidden !== null && hidden.has(writer + ':' + seq)
      let budget = SCRAP_SCAN
      let truncated = false
      const spend = () => {
        if (budget > 0) {
          budget--
          return true
        }
        truncated = true
        return false
      }
      // Keep only the best SCRAP_PER_PAGE rows, in answer order.
      const rows = []
      const keep = (row) => {
        if (rows.length >= SCRAP_PER_PAGE && compareScrapRows(row, rows[rows.length - 1]) >= 0) return
        let lo = 0
        let hi = rows.length
        while (lo < hi) {
          const mid = (lo + hi) >>> 1
          if (compareScrapRows(rows[mid], row) < 0) lo = mid + 1
          else hi = mid
        }
        rows.splice(lo, 0, row)
        if (rows.length > SCRAP_PER_PAGE) rows.pop()
      }
      const inbound = scrapIn.get(owner) || null
      for (const [writer, rec] of writersOf(entry, inbound, who === 'following' ? followed : null)) {
        if (!spend()) break
        if (writer === owner || !shows(writer)) continue
        const fseq = who === 'everyone' ? null : follows(writer)
        if (who === 'everyone' || fseq !== null) {
          const list = rec.edges
          let taken = 0
          for (let i = notFutureTop(list, now) - 1; i >= 0 && taken < SCRAP_PER_WRITER; i--) {
            if (!spend()) break
            const e = list[i]
            if (isHidden(writer, e.seq)) continue
            keep({ atMs: e.atMs, author: writer, seq: e.seq, followSeq: fseq })
            taken++
          }
        } else if (rec.replies !== null) {
          const answered = replyRows(entry, writer, rec, now, isHidden, spend)
          answered.sort(compareScrapRows)
          for (let i = 0; i < answered.length && i < SCRAP_PER_WRITER; i++) keep(answered[i])
        }
        if (truncated) break
      }
      let start = 0
      if (after !== null) {
        const key = { atMs: after.atMs, author: after.author, seq: after.seq }
        while (start < rows.length && compareScrapRows(rows[start], key) <= 0) start++
      }
      const page = rows.slice(start, start + SCRAP_ROWS)
      const last = page.at(-1)
      const next = last !== undefined && start + SCRAP_ROWS < rows.length ? edgeCursor(last) : null
      return { rows: page.map((r) => ({ author: r.author, seq: r.seq, followSeq: r.followSeq })), next, hides, wall, truncated }
    } catch {
      return null
    }
  }

  // The [writer, rec] pairs scraps() walks: every writer of the page, or,
  // given `followed`, the followed writers and then the ones the owner
  // addressed, each once, that wrote on the page. The caller spends one
  // unit of its budget per pair.
  function * writersOf (entry, inbound, followed) {
    if (inbound === null) return
    if (followed === null || followed === undefined) {
      yield * inbound
      return
    }
    const seen = new Set()
    for (const writer of followed) {
      if (typeof writer !== 'string' || seen.has(writer)) continue
      seen.add(writer)
      const rec = inbound.get(writer)
      if (rec !== undefined) yield [writer, rec]
    }
    for (const writer of entry?.scrapsByTo?.keys() || EMPTY_LIST) {
      if (seen.has(writer)) continue
      const rec = inbound.get(writer)
      if (rec !== undefined) yield [writer, rec]
    }
  }

  // The reply exception for one writer the owner does not follow: per live
  // scrap of the owner addressed to `writer`, that writer's lowest live
  // reply dated no earlier than it and not too far ahead takes the slot;
  // it is listed unless the owner hid it. Iterates the smaller side and
  // spends one unit per original plus one per original with replies, never
  // per reply: the winner is a binary search (newReplyList), so replies a
  // writer floods before it (backdated or far ahead) cannot exhaust the
  // budget.
  function replyRows (entry, writer, rec, now, isHidden, spend) {
    const out = []
    const mine = entry?.scrapsByTo?.get(writer)
    const own = authors.get(writer)
    if (mine === undefined || own === undefined || own.scraps === null) return out
    const originals = mine.size <= rec.replies.size ? mine : rec.replies.keys()
    for (const s of originals) {
      if (!spend()) break
      const original = entry.scraps.get(s)
      const list = rec.replies.get(s)
      if (original === undefined || original.to !== writer || list === undefined) continue
      if (!spend()) break
      // Never taken while the original is live and indexed: addScrap keeps t0.
      if (list.t0 !== original.t) refreshReplyList(list, original.t)
      let lo = list.from
      let hi = list.ts.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (list.ts[mid] - now > MAX_FUTURE_MS) hi = mid
        else lo = mid + 1
      }
      if (lo === list.from) continue
      const seq = list.best[lo - 1 - list.from]
      const info = own.scraps.get(seq)
      if (info !== undefined && !isHidden(writer, seq)) out.push({ atMs: info.atMs, author: writer, seq, followSeq: null })
    }
    return out
  }

  // The Varandinha pointers of `owner`'s balcony: { on: the seq of its
  // newest live `garden` block (on or off, the node peeks it) or null, state:
  // its newest live `garden-state` seq or null, helps: [{ author, seq,
  // followSeq }], given: [seq], hidden }. A balcony whose newest live
  // `garden` block is off, or that has none, answers no state, helps or
  // given at once: a member who opted out is not one lookup away from the
  // list of who watered them, and no reader shows that balcony anyway.
  // helps are the rows of the writers `visible` keeps whose
  // followSeq(writer) (the seq of that writer's live follow of the owner) is
  // a seq, a throw or null omitting the writer. hidden says a writer with a
  // listable row was omitted by `visible`, or the writers cap refused a help
  // that may still be listable (gardenFull: a refused help is never
  // replayed). A row is listable at now (gardenListable), one per writer
  // per Brasilia day (dayStart, the lowest stored seq of that day). The
  // reader counts a help only for a pot planted on or before it, so the
  // surviving rows are picked per pot (the pot of the day's row): at most
  // GARDEN_HELP_ROWS / GARDEN_POTS rows each, and helps naming one pot, or
  // an empty one, never push out the helps of another. Inside a pot every
  // writer's first row is taken first (the reader keeps one helper row per
  // writer), then that pot's other rows, in gardenRowOrder(now) (rows dated
  // after now last); the answer is the six picks in that order. given is the owner's own live help seqs inside the same window, newest
  // first, at most GARDEN_HELP_ROWS. Null for a malformed owner or clock.
  function garden (owner, now, opts = {}) {
    try {
      const { visible = allVisible, followSeq = noFollow } = opts
      if (typeof owner !== 'string' || !HEX64.test(owner)) return null
      if (typeof now !== 'number' || !Number.isFinite(now)) return null
      const { GARDEN_HELP_ROWS, GARDEN_POTS, dayStart } = gardenRules
      const perPot = Math.floor(GARDEN_HELP_ROWS / GARDEN_POTS)
      const entry = authors.get(owner)
      const on = entry?.gardenSeqs?.at(-1) ?? null
      if (on === null || entry.gardenOn.get(on) !== true) return { on, state: null, helps: [], given: [], hidden: false }
      const order = gardenRowOrder(now)
      let hidden = now < (gardenFull.get(owner) ?? -Infinity)
      const byPot = new Map()
      for (const [writer, list] of helpsByTo.get(owner) || EMPTY_LIST) {
        if (writer === owner) continue
        const byDay = new Map()
        for (const row of list) {
          if (!gardenListable(row.atMs, now)) continue
          const day = dayStart(row.atMs)
          const prev = byDay.get(day)
          if (prev === undefined || row.seq < prev.seq) byDay.set(day, row)
        }
        if (byDay.size === 0) continue
        let shown = false
        try { shown = visible(writer) === true } catch {}
        if (!shown) {
          hidden = true
          continue
        }
        let fseq = null
        try {
          const n = followSeq(writer)
          fseq = isSeq(n) ? n : null
        } catch {}
        if (fseq === null) continue
        const rows = [...byDay.values()].map((r) => ({ atMs: r.atMs, author: writer, seq: r.seq, pot: r.pot, followSeq: fseq }))
        rows.sort(order)
        const firstIn = new Set()
        for (const row of rows) {
          let bucket = byPot.get(row.pot)
          if (bucket === undefined) {
            bucket = { firsts: [], rest: [] }
            byPot.set(row.pot, bucket)
          }
          if (firstIn.has(row.pot)) {
            bucket.rest.push(row)
          } else {
            firstIn.add(row.pot)
            bucket.firsts.push(row)
          }
        }
      }
      const picked = []
      for (const { firsts, rest } of byPot.values()) {
        firsts.sort(order)
        rest.sort(order)
        const take = firsts.slice(0, perPot)
        for (const row of rest) {
          if (take.length >= perPot) break
          take.push(row)
        }
        picked.push(...take)
      }
      picked.sort(order)
      const own = []
      for (const [seq, info] of entry.gardenHelps || EMPTY_LIST) {
        if (info.to !== owner && gardenListable(info.atMs, now)) own.push({ seq, atMs: info.atMs })
      }
      own.sort(compareHelps)
      return {
        on,
        state: entry.gardenStateSeqs?.at(-1) ?? null,
        helps: picked.map((r) => ({ author: r.author, seq: r.seq, followSeq: r.followSeq })),
        given: own.slice(0, GARDEN_HELP_ROWS).map((r) => r.seq),
        hidden
      }
    } catch {
      return null
    }
  }

  // A Rua das varandinhas: { rows: [{ key, on, state }], next }. Walks the
  // keys of `followed` ascending, strictly after `cursor`, and keeps those
  // `visible` keeps (a throw hides one) whose newest live `garden` block is
  // on: on is that block's seq, state the newest live `garden-state` seq or
  // null. visible is asked first for every key examined, and a key it hides
  // is skipped without counting: `next` is a public cursor, and a hidden key
  // there would name a follow the public follows index omits. At most
  // GARDEN_STREET_PAGE rows and GARDEN_STREET_SCAN visible keys per call;
  // next is the last visible key examined while keys remain, else null, so
  // a page of closed balconies is never a dead end. Null for a malformed
  // owner, cursor or `followed`.
  function gardenStreet (owner, followed, opts = {}) {
    try {
      const { visible = allVisible, cursor = null } = opts
      if (typeof owner !== 'string' || !HEX64.test(owner)) return null
      if (cursor !== null && (typeof cursor !== 'string' || !HEX64.test(cursor))) return null
      const { GARDEN_STREET_PAGE } = gardenRules
      const keys = new Set()
      for (const key of followed) {
        if (typeof key === 'string' && HEX64.test(key) && (cursor === null || key > cursor)) keys.add(key)
      }
      const sorted = [...keys].sort()
      const rows = []
      let next = null
      let examined = 0
      for (let i = 0; i < sorted.length; i++) {
        const key = sorted[i]
        let shown = false
        try { shown = visible(key) === true } catch {}
        if (!shown) continue
        examined++
        const entry = authors.get(key)
        const on = entry?.gardenSeqs?.at(-1)
        if (on !== undefined && entry.gardenOn.get(on) === true) {
          rows.push({ key, on, state: entry.gardenStateSeqs?.at(-1) ?? null })
        }
        if ((rows.length >= GARDEN_STREET_PAGE || examined >= GARDEN_STREET_SCAN) && i + 1 < sorted.length) {
          next = key
          break
        }
      }
      return { rows, next }
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
    deleted.clear()
    deletedRefs.clear()
    noticeCache.clear()
    incoming.clear()
    scrapIn.clear()
    fanIn.clear()
    pollIn.clear()
    helpsByTo.clear()
    gardenFull.clear()
    records = 0
    fullAuthors = 0
  }

  return { add, removePost, removeRecord, removeDiary, post, roda, counts, engagers, member, hints, noticeRows, noticePage, testimonials, scraps, profileExtra, fans, fanCount, pollTotals, pollVoters, events, stats, clear, garden, gardenStreet }
}

module.exports = {
  createEngagementIndex,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_TARGETS,
  DEFAULT_PER_AUTHOR_MAX,
  REPLY_PAGE,
  QUOTE_PAGE,
  MEMBER_PAGE,
  ENGAGER_PAGE,
  NOTICE_ROWS_PER_ENGAGER,
  NOTICE_ROWS_MAX,
  NOTICE_CACHE_AUTHORS,
  NOTICE_SCAN_MAX,
  TESTIMONIAL_ROWS,
  RODA_PAGE,
  RODA_SCAN,
  SCRAP_PER_WRITER,
  SCRAP_PER_PAGE,
  SCRAP_ROWS,
  SCRAP_HIDES,
  SCRAP_SCAN,
  FAN_PAGE,
  FAN_KEYS_MAX,
  CHOICE_PAGE,
  CHOICE_POLLS_MAX,
  EVENT_PAGE,
  CHOICE_VOTERS_MAX,
  GARDEN_PAIR_MAX,
  GARDEN_WRITER_MAX,
  GARDEN_WRITERS_PER_OWNER,
  GARDEN_STREET_SCAN,
  CURSOR_RE
}
