'use strict'

// Groups: a group G is the key of a single-writer root core whose block 0 is
// a group-header; the root is also the creator's first writer. Every other
// member device writes one writer core whose block 0 is a group-writer
// header. A writer W counts for diary D only when D's diary carries a
// `group-join { group: G, writer: W, on: true }` (lib/records.js) and W's
// header names D: either side alone binds nothing. A later join on:false
// only updates seeder indexes, it never withdraws a writer here: membership
// ends with a group-leave record inside one of D's writers. The leave
// withdraws D's records on that writer from the leave on and every record of
// D on its other writers, so a departed admin's moderation from another
// device stops counting; only the creator's root keeps the records below the
// leave's cut on it (the group's charter). Coming back takes a
// new writer whose header names that leave (`rejoin`): a fresh membership
// that orders after the leave, needs a new admit in approval groups and
// stays under any ban.
//
// Pure: b4a and ./records only, so it runs in Node, Bare and the browser.

const b4a = require('b4a')
const {
  MAX_TEXT, MAX_BLOCK_BYTES, MAX_GROUP_WRITERS, MAX_GROUPS_PER_DIARY,
  MAX_GROUPS_PER_COMMUNITY, MAX_GROUP_CUTS, MAX_COMMUNITY_CUTS, MAX_GROUP_NAME, MAX_GROUP_WRITERS_PER_DIARY,
  nowIso, isHex64, isCanonicalIso, isPlainObject, hasExactKeys, hasControlChars,
  charLength, plainCopy, validRecordCopy
} = require('./records')

// Same rule as lib/feed.js (not imported, to keep this module pure).
const MAX_FUTURE_MS = 86400000

const HEADER_KEYS = ['type', 'v', 'kind', 'diary', 'visibility', 'join', 'name', 'box', 'at']
const WRITER_KEYS = ['type', 'v', 'group', 'diary', 'box', 'rejoin', 'at']
const REF_KEYS = ['writer', 'seq']
const RECORD_KEYS = {
  'group-post': ['type', 'text', 'replyTo', 'seen', 'at'],
  'group-hide': ['type', 'target', 'on', 'seen', 'at'],
  'group-admit': ['type', 'member', 'on', 'cuts', 'seen', 'at'],
  'group-ban': ['type', 'member', 'on', 'cuts', 'lifts', 'seen', 'at'],
  'group-meta': ['type', 'name', 'join', 'seen', 'at'],
  'group-admin': ['type', 'member', 'on', 'cuts', 'seen', 'at'],
  'group-leave': ['type', 'seen', 'cuts', 'at'],
  'group-link': ['type', 'group', 'on', 'cuts', 'at'],
  'community-link': ['type', 'community', 'on', 'cuts', 'at']
}
const GROUP_TYPES = Object.freeze(Object.keys(RECORD_KEYS))
const ROOT_ONLY = new Set(['group-meta', 'group-admin', 'group-link', 'community-link'])
// A community root (header kind `community`) is a set of groups: it carries
// no posts or moderation of its own.
const COMMUNITY_TYPES = new Set(['group-meta', 'group-admin', 'group-link'])

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

// A record reference { writer, seq }: post refs start at 1 (block 0 is the
// header), a cut is an observed length and may be 0.
function validRef (r, min) {
  return isPlainObject(r) && hasExactKeys(r, REF_KEYS) && isHex64(r.writer) &&
    Number.isSafeInteger(r.seq) && r.seq >= min
}

// By index, never every(): a hole in a sparse array is undefined and invalid.
function validCuts (cuts, max = MAX_GROUP_CUTS) {
  if (!Array.isArray(cuts) || cuts.length > max) return false
  const writers = new Set()
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i]
    if (!validRef(c, 0) || writers.has(c.writer)) return false
    writers.add(c.writer)
  }
  return true
}

function nameReason (name) {
  if (typeof name !== 'string' || charLength(name) < 1 || charLength(name) > MAX_GROUP_NAME) return 'name-length'
  return hasControlChars(name, false) ? 'control-chars' : null
}

function tooLarge (record) {
  return b4a.byteLength(JSON.stringify(record)) > MAX_BLOCK_BYTES
}

function checkHeader (h) {
  if (!isPlainObject(h)) return 'malformed'
  if (tooLarge(h)) return 'too-large'
  if (!hasExactKeys(h, HEADER_KEYS) || h.type !== 'group-header' || h.v !== 1) return 'malformed'
  if ((h.kind !== 'group' && h.kind !== 'community') || !isHex64(h.diary)) return 'malformed'
  if (h.join !== 'open' && h.join !== 'approval') return 'malformed'
  if (h.visibility === 'public') {
    if (h.box !== null) return 'malformed'
    if (h.name !== null) {
      const reason = nameReason(h.name)
      if (reason) return reason
    }
  } else if (h.visibility === 'private') {
    // The title of a private group travels sealed; the root must publish a
    // recipient key because it is the creator's first writer.
    if (h.join !== 'approval' || h.name !== null || !isHex64(h.box)) return 'malformed'
  } else {
    return 'malformed'
  }
  return isCanonicalIso(h.at) ? null : 'date-invalid'
}

function checkWriterHeader (h) {
  if (!isPlainObject(h)) return 'malformed'
  if (tooLarge(h)) return 'too-large'
  if (!hasExactKeys(h, WRITER_KEYS) || h.type !== 'group-writer' || h.v !== 1) return 'malformed'
  if (!isHex64(h.group) || !isHex64(h.diary) || h.box !== null) return 'malformed'
  // A rejoin names the group-leave of the same diary it follows (checked by
  // buildGroup, which knows the other writers).
  if (h.rejoin !== null && !validRef(h.rejoin, 1)) return 'malformed'
  return isCanonicalIso(h.at) ? null : 'date-invalid'
}

function checkRecord (record, seq, root, community) {
  if (!Number.isSafeInteger(seq) || seq < 0) return 'malformed'
  if (seq === 0) return root ? checkHeader(record) : checkWriterHeader(record)
  if (!isPlainObject(record)) return 'malformed'
  const type = record.type
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(RECORD_KEYS, type)) return 'malformed'
  if (!hasExactKeys(record, RECORD_KEYS[type])) return 'malformed'
  if (ROOT_ONLY.has(type) && !root) return 'root-only'
  if (community && !COMMUNITY_TYPES.has(type)) return 'group-only'
  if (!community && type === 'group-link') return 'community-only'
  // Every writer record may name the newest node its author had seen (seq 0
  // names a rejoining writer's block 0), so it orders after a rejoin.
  if (Object.prototype.hasOwnProperty.call(record, 'seen') && record.seen !== null && !validRef(record.seen, 0)) return 'seen-invalid'
  if (type === 'group-post') {
    const { text } = record
    if (typeof text !== 'string' || charLength(text) < 1 || charLength(text) > MAX_TEXT) return 'text-length'
    if (hasControlChars(text, true)) return 'control-chars'
    if (record.replyTo !== null && !validRef(record.replyTo, 1)) return 'reply-invalid'
  } else if (type === 'group-leave') {
    // The leaving diary's own writers at their observed lengths.
    if (!validCuts(record.cuts, MAX_GROUP_WRITERS_PER_DIARY)) return 'cuts-invalid'
  } else if (type === 'group-hide') {
    if (!validRef(record.target, 1) || typeof record.on !== 'boolean') return 'malformed'
  } else if (type === 'group-admit' || type === 'group-admin' || type === 'group-ban') {
    if (!isHex64(record.member) || typeof record.on !== 'boolean') return 'malformed'
    // A community admin's writers spread across the linked groups.
    if (!validCuts(record.cuts, community && type === 'group-admin' ? MAX_COMMUNITY_CUTS : MAX_GROUP_CUTS)) return 'cuts-invalid'
    // An unban names the ban it lifts; a ban lifts nothing.
    if (type === 'group-ban' && (record.on ? record.lifts !== null : !validRef(record.lifts, 1))) return 'lifts-invalid'
  } else if (type === 'group-meta') {
    if (record.name !== null) {
      const reason = nameReason(record.name)
      if (reason) return reason
    }
    if (record.join !== 'open' && record.join !== 'approval') return 'malformed'
  } else if (type === 'group-link' || type === 'community-link') {
    if (!isHex64(type === 'group-link' ? record.group : record.community) || typeof record.on !== 'boolean') return 'malformed'
    if (!validCuts(record.cuts)) return 'cuts-invalid'
  }
  return isCanonicalIso(record.at) ? null : 'date-invalid'
}

// Never throw, whatever the input (hostile getters included).
function validateGroupHeader (record) {
  try {
    return checkHeader(record)
  } catch {
    return 'malformed'
  }
}

function validateWriterHeader (record) {
  try {
    return checkWriterHeader(record)
  } catch {
    return 'malformed'
  }
}

// Seq 0 is the header (group-header in the root, group-writer elsewhere).
// `community` marks the root of a community (its header kind).
function validateGroupRecord (record, seq, { root = false, community = false } = {}) {
  try {
    return checkRecord(record, seq, root === true, root === true && community === true)
  } catch {
    return 'malformed'
  }
}

function build (record, seq, root, community = false) {
  const reason = validateGroupRecord(record, seq, { root, community })
  if (reason) throw new TypeError(reason)
  return record
}

// Copies with exactly the reference keys (anything else is passed through
// for validation to reject).
function copyRef (r) {
  return isPlainObject(r) ? { writer: r.writer, seq: r.seq } : r
}

function copyCuts (cuts) {
  return Array.isArray(cuts) ? cuts.map(copyRef) : cuts
}

function groupHeader ({ kind = 'group', diary, visibility = 'public', join = 'open', name = null, box = null, at = nowIso() } = {}) {
  return build({ type: 'group-header', v: 1, kind, diary, visibility, join, name, box, at }, 0, true)
}

function writerHeader ({ group, diary, rejoin = null, at = nowIso() } = {}) {
  return build({ type: 'group-writer', v: 1, group, diary, box: null, rejoin: copyRef(rejoin), at }, 0, false)
}

function groupPost ({ text, replyTo = null, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-post', text, replyTo: copyRef(replyTo), seen: copyRef(seen), at }, 1, false)
}

function groupHide ({ target, on, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-hide', target: copyRef(target), on, seen: copyRef(seen), at }, 1, false)
}

function groupAdmit ({ member, on, cuts = [], seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-admit', member, on, cuts: copyCuts(cuts), seen: copyRef(seen), at }, 1, false)
}

function groupBan ({ member, on, cuts = [], lifts = null, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-ban', member, on, cuts: copyCuts(cuts), lifts: copyRef(lifts), seen: copyRef(seen), at }, 1, false)
}

function groupMeta ({ name, join, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-meta', name, join, seen: copyRef(seen), at }, 1, true)
}

function groupAdmin ({ member, on, cuts = [], seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-admin', member, on, cuts: copyCuts(cuts), seen: copyRef(seen), at }, 1, true)
}

function groupLeave ({ seen = null, cuts = [], at = nowIso() } = {}) {
  return build({ type: 'group-leave', seen: copyRef(seen), cuts: copyCuts(cuts), at }, 1, false)
}

// A group-admin in a community root: cuts up to MAX_COMMUNITY_CUTS.
function communityAdmin ({ member, on, cuts = [], seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-admin', member, on, cuts: copyCuts(cuts), seen: copyRef(seen), at }, 1, true, true)
}

function groupLink ({ group, on, cuts = [], at = nowIso() } = {}) {
  return build({ type: 'group-link', group, on, cuts: copyCuts(cuts), at }, 1, true, true)
}

function communityLink ({ community, on, cuts = [], at = nowIso() } = {}) {
  return build({ type: 'community-link', community, on, cuts: copyCuts(cuts), at }, 1, true)
}

// Stands in for a record too deep (or otherwise unfit) to copy: it is never
// valid, but its seq still counts as held so readLog sees a fork.
const UNREADABLE = Symbol('unreadable')

function eachEntry (entries, fn) {
  if (!Array.isArray(entries)) return
  for (let i = 0; i < entries.length; i++) {
    const e = plainCopy(entries[i])
    if (e === null) {
      const seq = unreadableSeq(entries[i])
      if (seq !== null) fn(seq, UNREADABLE)
      continue
    }
    if (!Number.isSafeInteger(e.seq) || e.seq < 0) continue
    fn(e.seq, e.record)
  }
}

function unreadableSeq (entry) {
  try {
    if (!isPlainObject(entry)) return null
    const seq = entry.seq
    return Number.isSafeInteger(seq) && seq >= 0 ? seq : null
  } catch {
    return null
  }
}

// The live joins of one diary, keyed by writer: per writer the latest
// group-join by seq, kept when on. Seeder indexes use this; buildGroup takes
// the whole history (groupJoinHistory). Never throws.
function groupJoins (entries) {
  const latest = new Map()
  try {
    eachEntry(entries, (seq, record) => {
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-join') return
      const prev = latest.get(copy.writer)
      if (!prev || seq > prev.seq) latest.set(copy.writer, { group: copy.group, writer: copy.writer, on: copy.on, seq, at: copy.at })
    })
  } catch {}
  const out = new Map()
  for (const writer of [...latest.keys()].sort(cmp)) {
    const j = latest.get(writer)
    if (j.on) out.set(writer, { group: j.group, writer, seq: j.seq, at: j.at })
  }
  return out
}

// Every group-join of one diary for group G, in seq order: the `joins`
// value buildGroup expects for that diary. Never throws.
function groupJoinHistory (entries, group) {
  const out = []
  try {
    eachEntry(entries, (seq, record) => {
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-join' || copy.group !== group) return
      out.push({ writer: copy.writer, on: copy.on, seq })
    })
  } catch {}
  return out.sort((a, b) => a.seq - b.seq || cmp(a.writer, b.writer))
}

function orderKey (at, writer, seq) {
  return { t: Date.parse(at), writer, seq }
}

// The deterministic tiebreak of the causal order (lib/feed.js order).
function compareOrder (a, b) {
  return (a.t - b.t) || cmp(a.writer, b.writer) || a.seq - b.seq
}

function isFuture (at, now) {
  return Date.parse(at) - now > MAX_FUTURE_MS
}

class Heap {
  constructor (less) {
    this.less = less
    this.items = []
  }

  push (x) {
    const a = this.items
    a.push(x)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(a[i], a[p])) break
      ;[a[i], a[p]] = [a[p], a[i]]
      i = p
    }
  }

  pop () {
    const a = this.items
    if (a.length === 0) return null
    const top = a[0]
    const last = a.pop()
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.less(a[l], a[m])) m = l
        if (r < a.length && this.less(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

// Valid records of one core: header (seq 0) and the rest by seq. The first
// valid copy of a seq wins. A root's records are checked against its header
// kind (`fallback` stands in for a header the entries lack). `raw` maps every
// seq held, valid or not, to a canonical text of its block (the one chosen,
// else the first), so mergeCopies sees any difference as a fork.
function readLog (entries, root, fallback = null) {
  const copies = new Map()
  const firstRaw = new Map()
  eachEntry(entries, (seq, record) => {
    const copy = record === UNREADABLE ? null : plainCopy(record)
    if (!firstRaw.has(seq)) firstRaw.set(seq, record === UNREADABLE ? '#unreadable' : copy === null ? '#' : safeCanon(copy))
    if (copy !== null) pushTo(copies, seq, copy)
  })
  const first = (seq, opts) => (copies.get(seq) || []).find((c) => validateGroupRecord(c, seq, opts) === null)
  let header = first(0, { root }) || null
  if (header === null && root && fallback !== null) {
    const copy = plainCopy(fallback)
    if (copy !== null && validateGroupHeader(copy) === null) header = copy
  }
  const community = root && header !== null && header.kind === 'community'
  const bySeq = new Map()
  for (const seq of copies.keys()) {
    if (seq === 0) continue
    const copy = first(seq, { root, community })
    if (copy) bySeq.set(seq, copy)
  }
  const records = [...bySeq.keys()].sort((a, b) => a - b).map((seq) => ({ seq, record: bySeq.get(seq) }))
  const raw = new Map(firstRaw)
  for (const r of records) raw.set(r.seq, safeCanon(r.record))
  const h0 = first(0, { root })
  if (h0) raw.set(0, safeCanon(h0))
  return { header, records, raw }
}

// A stable text of a plain value, so copies compare whatever their key order.
// Iterative, so a deeply nested block from a peer cannot overflow the stack;
// a cycle throws.
function canon (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const out = []
  const stack = []
  const open = new Set()
  const emit = (v, inArray) => {
    if (v !== null && typeof v === 'object') {
      if (open.has(v)) throw new TypeError('cycle')
      open.add(v)
      const array = Array.isArray(v)
      out.push(array ? '[' : '{')
      stack.push({ v, keys: array ? null : Object.keys(v).sort(), i: 0 })
      return
    }
    const s = JSON.stringify(v)
    out.push(s !== undefined ? s : inArray ? '' : 'undefined')
  }
  emit(value, false)
  while (stack.length > 0) {
    const f = stack[stack.length - 1]
    const n = f.keys === null ? f.v.length : f.keys.length
    if (f.i === n) {
      out.push(f.keys === null ? ']' : '}')
      open.delete(f.v)
      stack.pop()
      continue
    }
    if (f.i > 0) out.push(',')
    if (f.keys === null) {
      emit(f.v[f.i++], true)
    } else {
      const k = f.keys[f.i++]
      out.push(JSON.stringify(k) + ':')
      emit(f.v[k], false)
    }
  }
  return out.join('')
}

// canon for a block's comparison text in readLog, which must never throw: a
// value canon cannot render (a BigInt, a cycle) still reads as held and
// different from any valid block.
function safeCanon (v) {
  try {
    return canon(v)
  } catch {
    return '#unreadable'
  }
}

// Several copies of one core (each { header, records, raw } from readLog)
// merged by seq, so the result never depends on their order. Copies whose
// blocks differ at any seq, valid or not, or whose headers differ are a fork:
// null, and the caller ignores the core. A copy without a block 0 (and no
// fallback header) brings no header and takes no part in that comparison.
function mergeCopies (logs) {
  const headed = logs.filter((l) => l.header !== null || l.raw.has(0))
  const base = headed.length > 0 ? headed[0] : logs[0]
  const header = canon(base.header)
  for (const log of headed) if (canon(log.header) !== header) return null
  const rawBy = new Map()
  const bySeq = new Map()
  for (const log of logs) {
    for (const [seq, text] of log.raw) {
      const prev = rawBy.get(seq)
      if (prev === undefined) rawBy.set(seq, text)
      else if (prev !== text) return null
    }
    for (const r of log.records) {
      const prev = bySeq.get(r.seq)
      if (prev === undefined) bySeq.set(r.seq, r)
      else if (canon(prev.record) !== canon(r.record)) return null
    }
  }
  return { ...base, records: [...bySeq.values()].sort((a, b) => a.seq - b.seq) }
}

function emptyGroup () {
  return {
    kind: null,
    name: null,
    join: null,
    visibility: null,
    creator: null,
    admins: new Set(),
    community: null,
    members: new Map(),
    posts: [],
    requests: [],
    future: [],
    last: null,
    bans: new Map(),
    leaves: new Map(),
    writers: new Set(),
    incomplete: true
  }
}

function cutsMap (cuts) {
  const m = new Map()
  for (const c of cuts) m.set(c.writer, c.seq)
  return m
}

// A layer is a list of { on, cuts, unlisted } in causal order; each event
// sets the state of every listed writer from its cut on, and of every other
// writer from `unlisted` (0, or Infinity for an event that skips them). The
// state of (writer, seq) is the one of the last event, from index `from`,
// whose cut is at or below seq.
function layerAt (events, writer, seq, from = 0) {
  if (!events) return false
  for (let i = events.length - 1; i >= from; i--) {
    const e = events[i]
    const c = e.cuts.get(writer)
    if ((c === undefined ? e.unlisted : c) <= seq) return e.on
  }
  return false
}

// The state a layer gives a writer's next records: from its cut on when an
// event lists it, otherwise only through an event that covers unlisted
// writers.
function layerNow (events, writer) {
  return layerAt(events, writer, Number.MAX_SAFE_INTEGER)
}

// The first index of a sorted list whose value is above p.
function firstAbove (list, p, value) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (value(list[mid]) > p) hi = mid
    else lo = mid + 1
  }
  return lo
}

function lastOn (events) {
  return !!events && events.length > 0 && events[events.length - 1].on
}

function pushTo (map, k, v) {
  const list = map.get(k)
  if (list) list.push(v)
  else map.set(k, [v])
}

// The references a record observed, as { writer, seq } of the last block
// seen: replyTo, seen, a hide target, each cut (an observed length, so its
// last block is seq - 1) and the ban an unban lifts. A leave's cuts order
// nothing except its cut on the root: the leaving diary could otherwise cut
// its other writer past that writer's end and slip records it writes later
// before the leave.
function referencesOf (record, root) {
  const refs = []
  const t = record.type
  if (record.seen) refs.push(record.seen)
  if (t === 'group-post') {
    if (record.replyTo) refs.push(record.replyTo)
  } else if (t === 'group-rejoin') {
    refs.push(record.rejoin)
  } else if (t === 'group-hide') {
    refs.push(record.target)
  } else if (t === 'group-leave') {
    for (const c of record.cuts) if (c.seq >= 1 && c.writer === root) refs.push({ writer: c.writer, seq: c.seq - 1 })
  } else if (t === 'group-admit' || t === 'group-ban' || t === 'group-admin' || t === 'community-link') {
    for (const c of record.cuts) if (c.seq >= 1) refs.push({ writer: c.writer, seq: c.seq - 1 })
    if (t === 'group-ban' && record.lifts) refs.push(record.lifts)
  }
  return refs
}

// Topological order over observed references (Kahn's algorithm), the
// smallest orderKey first among ready records. A reference beyond the
// referenced writer's known records is ignored, so a missing record never
// blocks the one that cites it. A forged cycle is broken by releasing the
// smallest writer head (the first record not yet emitted of a writer), which
// keeps every writer's own seq order.
function causalOrder (logs, root) {
  const byWriter = new Map()
  const all = []
  for (const log of logs) {
    // A rejoining writer's block 0 is a node too: everything it writes
    // follows the leave it names.
    const records = log.rejoin
      ? [{ seq: 0, record: { type: 'group-rejoin', rejoin: log.rejoin, at: log.at } }, ...log.records]
      : log.records
    const list = records.map(({ seq, record }) => ({
      writer: log.key,
      diary: log.diary,
      seq,
      record,
      key: orderKey(record.at, log.key, seq),
      succ: [],
      indeg: 0,
      done: false
    }))
    byWriter.set(log.key, list)
    for (const n of list) all.push(n)
  }
  const resolve = (ref) => {
    const list = byWriter.get(ref.writer)
    if (!list || list.length === 0 || ref.seq > list[list.length - 1].seq) return null
    let lo = 0
    let hi = list.length - 1
    let found = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].seq <= ref.seq) {
        found = list[mid]
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found
  }
  for (const list of byWriter.values()) {
    for (let i = 0; i < list.length; i++) {
      const n = list[i]
      const preds = new Set()
      if (i > 0) preds.add(list[i - 1])
      for (const ref of referencesOf(n.record, root)) {
        if (ref.writer === n.writer && ref.seq >= n.seq) continue
        const p = resolve(ref)
        if (p !== null && p !== n) preds.add(p)
      }
      for (const p of preds) {
        p.succ.push(n)
        n.indeg++
      }
    }
  }
  const less = (a, b) => compareOrder(a.key, b.key) < 0
  const heap = new Heap(less)
  for (const n of all) if (n.indeg === 0) heap.push(n)
  const heads = [...byWriter.values()].map((list) => ({ list, i: 0 }))
  const order = []
  while (order.length < all.length) {
    let n = heap.pop()
    if (n === null) {
      for (const h of heads) {
        while (h.i < h.list.length && h.list[h.i].done) h.i++
        const head = h.list[h.i]
        if (head && (n === null || less(head, n))) n = head
      }
    }
    if (n.done) continue
    n.done = true
    order.push(n)
    for (const s of n.succ) {
      if (--s.indeg === 0 && !s.done) heap.push(s)
    }
  }
  return order
}

// Writers whose header names a rejoin count only when it names a valid
// group-leave of the same diary, in a writer that counts itself (fixed
// point). One naming a record not known yet stays out without being
// rejected, so the group reads as incomplete.
function checkRejoins (candidates, rootEntry) {
  const valid = new Map()
  const rejected = new Set()
  const pending = []
  for (const c of candidates.values()) {
    if (c.rejoin === null) valid.set(c.key, c)
    else pending.push(c)
  }
  pending.sort((a, b) => cmp(a.key, b.key))
  let changed = true
  while (changed) {
    changed = false
    for (const c of pending) {
      if (valid.has(c.key) || rejected.has(c.key)) continue
      const ref = c.rejoin
      const target = ref.writer === rootEntry.key ? rootEntry : valid.get(ref.writer)
      if (!target) continue
      const last = target.records.length ? target.records[target.records.length - 1].seq : 0
      if (ref.seq > last) continue
      const hit = target.records.find((r) => r.seq === ref.seq)
      if (target.diary === c.diary && hit && hit.record.type === 'group-leave') valid.set(c.key, c)
      else rejected.add(c.key)
      changed = true
    }
  }
  for (const c of pending) {
    if (valid.has(c.key) || rejected.has(c.key)) continue
    // Naming a writer that is present but never counts (a cycle, or one
    // rejected itself) is invalid; naming an unknown writer or record is not
    // known yet.
    if (candidates.has(c.rejoin.writer) && !valid.has(c.rejoin.writer)) rejected.add(c.key)
  }
  return { valid, rejected }
}

// Bound pairs, the writers named, and per pair the seq of its earliest
// on:true join (the per-diary cap keeps the earliest).
function readJoins (joins) {
  const bound = new Set()
  const named = []
  const joinSeq = new Map()
  if (!(joins instanceof Map)) return { bound, named, joinSeq }
  for (const [diary, list] of joins) {
    if (!isHex64(diary) || !Array.isArray(list)) continue
    for (let i = 0; i < list.length; i++) {
      const j = plainCopy(list[i])
      if (j === null || j.on !== true || !isHex64(j.writer)) continue
      const pair = diary + ':' + j.writer
      const seq = Number.isSafeInteger(j.seq) && j.seq >= 0 ? j.seq : Infinity
      bound.add(pair)
      named.push(j.writer)
      if (!joinSeq.has(pair) || seq < joinSeq.get(pair)) joinSeq.set(pair, seq)
    }
  }
  return { bound, named, joinSeq }
}

// At most MAX_GROUP_WRITERS_PER_DIARY writers per diary, those joined first:
// a diary binding hundreds of writers must not push others out of the group
// cap. A bound root is one of its creator's and always stays.
function capPerDiary (valid, joinSeq, rootDiary) {
  const byDiary = new Map()
  for (const c of valid.values()) pushTo(byDiary, c.diary, c)
  const out = []
  for (const [d, list] of byDiary) {
    const seqOf = (c) => joinSeq.has(d + ':' + c.key) ? joinSeq.get(d + ':' + c.key) : Infinity
    list.sort((a, b) => (seqOf(a) - seqOf(b)) || cmp(a.key, b.key))
    const room = MAX_GROUP_WRITERS_PER_DIARY - (d === rootDiary ? 1 : 0)
    for (const c of list.slice(0, room)) out.push(c)
  }
  return out
}

// Which records of a diary a group-leave withdraws: a leave L of D withdraws
// the records of D on L's own writer from L on, and every record of D on any
// other writer of D from seq 0, whatever L's cuts say, wherever `at` puts it
// in causal order, unless the record follows a rejoin of D that follows L.
// Cuts cannot tell records signed offline before the leave from ones signed
// after it, so another writer keeps nothing. The root is the exception: it
// holds the group's charter (name, join policy, admin appointments), so a
// creator leaving keeps the root records below L's cut on the root (all
// withdrawn when unlisted; from L at the latest when L is in the root).
// Leaves and rejoins themselves are never withdrawn.
function leaveWithdrawal (order, logs, root) {
  const byDiary = new Map()
  for (let i = 0; i < order.length; i++) {
    const n = order[i]
    n.pos = i
    const t = n.record.type
    if (t !== 'group-leave' && t !== 'group-rejoin') continue
    let x = byDiary.get(n.diary)
    if (!x) {
      x = { leaves: [], rejoins: [], sufMin: new Map() }
      byDiary.set(n.diary, x)
    }
    if (t === 'group-leave') x.leaves.push(n)
    else x.rejoins.push(n)
  }
  const writersOf = new Map()
  for (const l of logs) pushTo(writersOf, l.diary, l.key)
  for (const [d, x] of byDiary) {
    const cuts = x.leaves.map((L) => cutsMap(L.record.cuts))
    // Per writer of D, the lowest cut of any leave from index i on.
    for (const w of writersOf.get(d) || []) {
      const suf = new Array(x.leaves.length)
      let m = Infinity
      for (let i = x.leaves.length - 1; i >= 0; i--) {
        const L = x.leaves[i]
        let c = 0
        if (w === root) {
          const listed = cuts[i].get(w)
          c = listed === undefined ? 0 : listed
          if (w === L.writer) c = listed === undefined ? L.seq : Math.min(listed, L.seq)
        } else if (w === L.writer) {
          c = L.seq
        }
        m = Math.min(m, c)
        suf[i] = m
      }
      x.sufMin.set(w, suf)
    }
  }
  const pos = (n) => n.pos
  return (n) => {
    const t = n.record.type
    if (t === 'group-leave' || t === 'group-rejoin') return false
    const x = byDiary.get(n.diary)
    if (!x || x.leaves.length === 0) return false
    const k = firstAbove(x.rejoins, n.pos, pos) - 1
    const since = k >= 0 ? x.rejoins[k].pos : -1
    const i = firstAbove(x.leaves, since, pos)
    if (i === x.leaves.length) return false
    // A leave between the last rejoin and the record: withdrawn whatever the
    // cuts say (a forged cycle can break the order the cuts imply).
    if (firstAbove(x.leaves, n.pos, pos) > i) return true
    const suf = x.sufMin.get(n.writer)
    return suf !== undefined && n.seq >= suf[i]
  }
}

// Communities. A community C is the key of a root whose header kind is
// `community`, written by its creator only. A group G and C are linked only
// while both sides are on: G's root carries `community-link { community: C }`
// and C's root `group-link { group: G }`. Links and community admin records
// are layers keyed by G's writers, with PR1's group-admin rule: an `on: true`
// link or grant starts only the writers its cuts list, each from its cut (an
// unlisted writer gets nothing, nothing is retroactive), and an `on: false`
// one cuts every listed writer at its cut and every other writer at 0 (a
// writer the cuts never saw could hold backdated moderation no cut can place).
//
// How they combine, for a writer w of diary d at seq s (owner decision:
// appointing is enough, no group creator has to act for a new admin or a new
// device). A community admin acts when its grant lists w at or below s, no
// later demotion cutting it, and both link sides are on for w at s. A link
// cut only RAISES the start of the writers it lists: start = max(grant
// start, group-side cut if that side lists w, community-side cut if it lists
// w); a writer no link lists is bounded by the grant alone. The community
// creator has no grant: its own side (the group-link it writes in its root,
// holding its own devices) must list w, and the group side raises the start
// when it lists w. So a new admin device needs a grant only, and a new
// creator device a community-side group-link only. Accepted residual: a
// device that existed before the link and that the group side did not list
// counts from its grant start.
//
// An unlink (`on: false`, either side) cuts each listed writer at its cut
// and every other writer at 0. After a side's first unlink, a relink on that
// side counts only for the writers it lists, from their cut: a relink
// without cuts restores nothing, and a writer the relink does not list
// needs a new link on that side.
//
// A community root carries authority only when its creator's diary bound it
// with a join { group: C, writer: C, on: true } (the `joins` of the root, as
// for a group root): anyone can name any diary in a header.

// Accepted community-link records of a root in order: one community at a
// time, so a link to another community while one is on is ignored, and an
// unlink counts only for the community that is on (an unlink of a link that
// was ignored, or is already off, changes nothing).
function oneAtATime (records) {
  const out = []
  let current = null
  for (const r of records) {
    if (r.on) {
      if (current !== null && current !== r.community) continue
      current = r.community
    } else if (current === r.community) {
      current = null
    } else {
      continue
    }
    out.push(r)
  }
  return out
}

// Appends one link record to the two layers of a side: `strict` (only the
// listed writers start) and `open` (an unlisted writer is left to the other
// bounds, until the side's first unlink). The `on: true` links since the
// side's last unlink fold into one event whose start per writer is the cut
// of the first of them that lists it: a repeated link only adds writers and
// never moves a start (nodes list every writer at its current length, so
// raising would void earlier actions); raising a start takes an unlink or a
// demotion. The period's two events share one map that grows in place
// (copying it per record would make repeated links quadratic); an unlink
// ends the period, so a later one gets a fresh map and the earlier events
// never change again.
function pushLink (map, k, r) {
  let side = map.get(k)
  if (!side) {
    side = { strict: [], open: [], closed: false, starts: null }
    map.set(k, side)
  }
  if (!r.on) {
    const cuts = cutsMap(r.cuts)
    side.strict.push({ on: false, cuts, unlisted: 0 })
    side.open.push({ on: false, cuts, unlisted: 0 })
    side.closed = true
    side.starts = null
    return
  }
  if (side.starts === null) {
    side.starts = new Map()
    side.strict.push({ on: true, cuts: side.starts, unlisted: Infinity })
    side.open.push({ on: true, cuts: side.starts, unlisted: side.closed ? Infinity : 0 })
  }
  for (const c of r.cuts) {
    if (!side.starts.has(c.writer)) side.starts.set(c.writer, c.seq)
  }
}

// The group side: `links` are the root's community-link records in order as
// { record, out } (out: withdrawn by a creator's leave). The one-community
// rule runs on the raw order first, so a withdrawn link to A never promotes a
// link to B written while A was on; then again on what survives withdrawal.
// Map community -> { strict, open, closed }.
function groupSideEvents (links) {
  const raw = new Set(oneAtATime(links.map((x) => x.record)))
  const out = new Map()
  for (const r of oneAtATime(links.filter((x) => !x.out && raw.has(x.record)).map((x) => x.record))) pushLink(out, r.community, r)
  return out
}

// The copies of community roots in `list` ({ key, header?, entries, joins? }),
// as key -> { logs, bound }: every copy with a block 0 counts, whatever its
// header kind and even when that block is invalid, so a copy whose block 0
// differs is seen as a fork. `bound` holds the pairs the copies' `joins` bind.
function communityCopies (list) {
  const out = new Map()
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    if (!isPlainObject(c) || !isHex64(c.key)) continue
    const log = readLog(c.entries, true, c.header === undefined ? null : c.header)
    if (log.header === null && !log.raw.has(0)) continue
    let x = out.get(c.key)
    if (!x) {
      x = { logs: [], bound: new Set() }
      out.set(c.key, x)
    }
    x.logs.push(log)
    for (const pair of readJoins(c.joins).bound) x.bound.add(pair)
  }
  return out
}

// One community root from its copies: 'fork' when they disagree, 'invalid'
// when they agree on a block 0 that is no valid header, null when it is not
// a community, else { key, header, records, bound }. An unbound root keeps
// only its header: no admins, no links, no creator.
function mergeCommunity (key, { logs, bound }) {
  const log = mergeCopies(logs)
  if (log === null) return 'fork'
  if (log.header === null) return 'invalid'
  if (log.header.kind !== 'community') return null
  const ok = bound.has(log.header.diary + ':' + key)
  return { key, header: log.header, records: ok ? log.records : [], bound: ok }
}

// The state of one community from its own root: admins (layers per diary,
// the creator excluded), its live group links with at most
// MAX_GROUPS_PER_COMMUNITY on in record order (a link over the cap is
// ignored), and, for group G, the community side events of that link.
function communityState (c, G) {
  const creator = c.bound ? c.header.diary : null
  const admins = new Map()
  const on = new Set()
  const sides = new Map()
  let name = c.header.visibility === 'public' ? c.header.name : null
  for (const { record: r } of c.records) {
    if (r.type === 'group-admin') {
      if (r.member !== creator) pushTo(admins, r.member, { on: r.on, cuts: cutsMap(r.cuts), unlisted: r.on ? Infinity : 0 })
    } else if (r.type === 'group-link') {
      if (r.on) {
        if (!on.has(r.group) && on.size >= MAX_GROUPS_PER_COMMUNITY) continue
        on.add(r.group)
      } else {
        // An unlink of a link that is not on (ignored at the cap, or
        // already off) changes nothing.
        if (!on.has(r.group)) continue
        on.delete(r.group)
      }
      if (r.group === G) pushLink(sides, G, r)
    } else if (r.type === 'group-meta' && c.header.visibility === 'public') {
      name = r.name
    }
  }
  return { key: c.key, creator, name, admins, on, side: sides.get(G) || null }
}

// The communities given to buildGroup, keyed by root, the copies of a root
// merged (mergeCopies) whatever their header kind. A forked root is ignored
// and reads as incomplete. `given` also lists roots that are not
// communities, so naming one does not read as missing, but not an unbound
// community root nor an entry without a block 0: a link to one reads as
// incomplete.
function readCommunities (list, G) {
  const byKey = new Map()
  const given = new Set()
  let forked = false
  if (!Array.isArray(list)) return { byKey, given, forked }
  // Only a root with a block 0 is given: an entry without one is missing.
  for (const [k, copies] of communityCopies(list)) {
    given.add(k)
    if (k === G) continue
    const c = mergeCommunity(k, copies)
    if (c === 'fork') forked = true
    if (c === 'fork' || c === null) continue
    if (c === 'invalid' || !c.bound) given.delete(k)
    else byKey.set(k, communityState(c, G))
  }
  return { byKey, given, forked }
}

// The communities whose two sides both named G at some point; `links` as
// groupSideEvents takes them.
function linkedCommunities (links, byKey) {
  const out = []
  for (const [k, groupSide] of groupSideEvents(links)) {
    const c = byKey.get(k)
    if (c && c.side !== null) out.push({ key: k, creator: c.creator, admins: c.admins, groupSide, side: c.side })
  }
  return out
}

function linkedNow (c) {
  return lastOn(c.groupSide.strict) && lastOn(c.side.strict)
}

// Whether diary d acts through community c at (w, s), by the rule above.
function communityPower (c, d, w, s) {
  if (!layerAt(c.groupSide.open, w, s)) return false
  if (d === c.creator) return layerAt(c.side.strict, w, s)
  return layerAt(c.side.open, w, s) && layerAt(c.admins.get(d), w, s)
}

// The pure fold of a group. Input: the root core, the writer cores
// ({ key, entries, diary }), every diary's group-join history for this group
// (Map diary -> [{ writer, on, seq }], groupJoinHistory) and `now`. The
// result is the same for any delivery order of the same records, never
// throws, and a missing writer only removes its records and sets
// `incomplete`. Authority never depends on `at`: only the root appoints or
// demotes admins (with cuts on the admin's writers), a ban or admit can never
// target the creator or an admin of the final root state, and a ban or an
// unban counts in causal order, an unban only when it lifts the latest ban
// seen for that diary. `communities` lists the community roots held
// ({ key, header, entries }): the creator and admins of a community linked
// from both sides act as group admins (ban, admit, hide), cannot be banned
// and need no admit there, and never appoint group admins.
function buildGroup (input) {
  try {
    return fold(input)
  } catch {
    return emptyGroup()
  }
}

function fold (input) {
  const { root, writers, joins } = input || {}
  const now = Number.isFinite(input && input.now) ? input.now : Date.now()
  if (!isPlainObject(root) || !isHex64(root.key)) return emptyGroup()
  const G = root.key
  const rootLog = readLog(root.entries, true)
  const header = rootLog.header
  if (header === null) return emptyGroup()
  const creator = header.diary
  const { bound, named, joinSeq } = readJoins(joins)
  const rootBound = bound.has(creator + ':' + G)
  let incomplete = !rootBound

  const copies = new Map()
  if (Array.isArray(writers)) {
    for (let i = 0; i < writers.length; i++) {
      const w = writers[i]
      if (!isPlainObject(w)) continue
      const key = w.key
      if (!isHex64(key) || key === G) continue
      const log = readLog(w.entries, false)
      if (log.header === null && !log.raw.has(0)) continue
      pushTo(copies, key, { log, diary: w.diary })
    }
  }
  // Every copy with a block 0 takes part in the merge, whatever its header
  // names and even when that block is invalid, so a copy with another block
  // 0 is seen as a fork; the header is validated only after the merge. A forked writer
  // counts as missing: the named check below marks it. The merged header
  // must name G and a diary that bound the writer, and some copy must be
  // given for that diary.
  const candidates = new Map()
  for (const [key, list] of copies) {
    const log = mergeCopies(list.map((x) => x.log))
    if (log === null || log.header === null) continue
    const h = log.header
    if (h.group !== G || !bound.has(h.diary + ':' + key) || !list.some((x) => x.diary === h.diary)) continue
    candidates.set(key, { key, diary: h.diary, rejoin: h.rejoin, at: h.at, records: log.records })
  }
  // A root its creator's diary never bound carries no authority and no
  // posts: anyone can name any diary in a header. Only the header is read.
  const rootRecords = rootBound ? rootLog.records : []
  const rootEntry = { key: G, diary: creator, rejoin: null, at: header.at, records: rootRecords }
  const { valid, rejected } = checkRejoins(candidates, rootEntry)
  for (const w of named) {
    if (w !== G && !valid.has(w) && !rejected.has(w)) incomplete = true
  }
  const capped = capPerDiary(valid, joinSeq, rootBound ? creator : null)
  // A community root never takes community powers itself (no nesting).
  const { byKey, given, forked } = header.kind === 'group' ? readCommunities(input.communities, G) : { byKey: new Map(), given: new Set(), forked: false }
  if (forked) incomplete = true
  for (const { record: r } of rootRecords) {
    if (r.type === 'community-link' && !given.has(r.community)) incomplete = true
  }
  // Over the group cap the creator's and the admins' writers go first, so
  // moderation is never evicted, and banned diaries last.
  const select = (banned, admins) => {
    const tier = (c) => (rootBound && c.diary === creator) ? 0 : admins.has(c.diary) ? 1 : banned.has(c.diary) ? 3 : 2
    const ranked = capped.slice().sort((a, b) => (tier(a) - tier(b)) || cmp(a.key, b.key))
    const keptKeys = new Set(ranked.slice(0, MAX_GROUP_WRITERS - 1).map((c) => c.key))
    // The cap must not keep a rejoin whose leave it dropped: the fold would
    // never see that leave and would reuse the old admission.
    let dropped = false
    let again = true
    while (again) {
      again = false
      for (const k of keptKeys) {
        const ref = valid.get(k).rejoin
        if (ref !== null && ref.writer !== G && !keptKeys.has(ref.writer)) {
          keptKeys.delete(k)
          dropped = true
          again = true
        }
      }
    }
    return { kept: [...keptKeys].sort(cmp).map((k) => valid.get(k)), dropped }
  }
  const ctx = { G, header, creator, rootBound, rootEntry, now, communities: byKey }
  const over = capped.length > MAX_GROUP_WRITERS - 1
  let sel = select(new Set(), new Set())
  // The final ban layer depends on the writers kept: a first pass ranks
  // without it, the second puts the diaries it bans last. Both rank by the
  // admins a fold of the root and the creator's writers finds: leaves
  // withdraw root records only through the creator's own writers, so a
  // community link or grant a creator leave withdrew gives no priority.
  if (over) {
    const own = capped.filter((c) => rootBound && c.diary === creator)
    const admins = foldLogs(ctx, own).admins
    const first = foldLogs(ctx, select(new Set(), admins).kept)
    sel = select(new Set(first.bans.keys()), first.admins)
  }
  if (over || sel.dropped) incomplete = true
  const result = foldLogs(ctx, sel.kept)
  result.incomplete = incomplete
  return result
}

// The generation an admit of diary D observed: the leaves of D its own cuts
// cover (a cut on writer w above a leave's seq), plus the leave named by a
// rejoining writer of D whose block 0 the admit cuts past. Never the leaves
// that merely sort before it: causal order breaks ties by the author's `at`,
// so a member could otherwise backdate a leave under an earlier admit and
// carry that admission into a rejoin. A covered leave that sorts after the
// admit (a cut beyond the records held, or a forged cycle) does not count
// either, so the admit cannot reach past the generation it was ordered in. A
// lower bound: missing an observed leave only asks for a new admit.
function observedLeaves (order, logs) {
  const seqs = new Map()
  const posOf = new Map()
  for (let i = 0; i < order.length; i++) {
    const n = order[i]
    if (n.record.type !== 'group-leave') continue
    let byWriter = seqs.get(n.diary)
    if (!byWriter) {
      byWriter = new Map()
      seqs.set(n.diary, byWriter)
    }
    pushTo(byWriter, n.writer, { seq: n.seq, pos: i })
    posOf.set(n.diary + ':' + n.writer + ':' + n.seq, i)
  }
  // Causal order keeps each writer's seq order, so a writer's leaves sorted
  // by seq are sorted by position too: both bounds cut a prefix.
  for (const byWriter of seqs.values()) {
    for (const list of byWriter.values()) list.sort((a, b) => a.seq - b.seq)
  }
  const rejoinOf = new Map()
  for (const l of logs) {
    if (l.rejoin) rejoinOf.set(l.key, { diary: l.diary, writer: l.rejoin.writer, seq: l.rejoin.seq })
  }
  const seqOf = (e) => e.seq
  const at = (e) => e.pos
  return (member, cuts, pos) => {
    const byWriter = seqs.get(member)
    if (!byWriter) return 0
    let count = 0
    const extra = new Set()
    for (const [w, c] of cuts) {
      const list = byWriter.get(w)
      if (list) count += Math.min(firstAbove(list, c - 1, seqOf), firstAbove(list, pos - 1, at))
      const rj = c >= 1 ? rejoinOf.get(w) : undefined
      if (rj === undefined || rj.diary !== member) continue
      const ref = member + ':' + rj.writer + ':' + rj.seq
      const p = posOf.get(ref)
      if (p === undefined || p >= pos || extra.has(ref)) continue
      // Already counted above when a cut of the admit covers it.
      const covered = cuts.get(rj.writer)
      if (covered === undefined || covered <= rj.seq) {
        extra.add(ref)
        count++
      }
    }
    return count
  }
}

function foldLogs ({ G, header, creator, rootBound, rootEntry, now, communities }, kept) {
  const logs = [rootEntry, ...kept]
  const writerDiary = new Map(logs.map((l) => [l.key, l.diary]))
  // The header names any diary it likes: creator powers come only from a
  // root that diary bound.
  const owner = rootBound ? creator : null
  const order = causalOrder(logs, G)
  const withdrawn = leaveWithdrawal(order, logs, G)
  const admitGen = observedLeaves(order, logs)

  const rootAdmin = new Map()
  for (const n of order) {
    const r = n.record
    if (n.writer !== G || r.type !== 'group-admin' || r.member === creator || withdrawn(n)) continue
    // A grant gives nothing to a writer missing from its cuts (a hidden or
    // forgotten device would otherwise gain authority over its whole past,
    // which a later demotion could not undo), so an admin's new device needs
    // a new grant. A demotion still covers every writer.
    pushTo(rootAdmin, r.member, { on: r.on, cuts: cutsMap(r.cuts), unlisted: r.on ? Infinity : 0 })
  }
  const bans = new Map()
  const latestBan = new Map()
  const latestLeave = new Map()
  const admits = new Map()
  const left = new Set()
  // Leaves per diary so far, the generation of each post: an admit counts
  // only for posts of a generation its cuts observed, so a rejoin needs a
  // new admit.
  const leaves = new Map()
  const hides = new Map()
  const postNodes = []
  let name = header.name
  let join = header.join

  // The root's community links in causal order: a creator's leave withdraws
  // the links after its cut like any other root record.
  const links = order.filter((n) => n.writer === G && n.record.type === 'community-link').map((n) => ({ record: n.record, out: withdrawn(n) }))
  const linked = linkedCommunities(links, communities)
  const communityAt = (d, w, s) => linked.some((c) => communityPower(c, d, w, s))
  const communityNow = (d) => linked.some((c) => linkedNow(c) && (d === c.creator || lastOn(c.admins.get(d))))
  const isAdmin = (d, w, s) => layerAt(rootAdmin.get(d), w, s) || communityAt(d, w, s)
  const authorized = (n) => !withdrawn(n) && (n.diary === owner ||
    (isAdmin(n.diary, n.writer, n.seq) && !layerAt(bans.get(n.diary), n.writer, n.seq)))
  // From the final root state, never from the causal position: shielding by
  // position would let clock skew decide whether two admins can ban each
  // other. A demoted admin loses the shield entirely.
  const adminNow = (d) => lastOn(rootAdmin.get(d)) || communityNow(d)
  const shielded = (d) => d === owner || adminNow(d)

  // The newest node in causal order, a rejoin's block 0 included: a new post
  // names it as `seen`, so a post sent after a rejoin never sorts before it.
  let last = null
  for (let i = 0; i < order.length; i++) {
    const n = order[i]
    const r = n.record
    if (n.seq >= 1 || r.type === 'group-rejoin') last = { writer: n.writer, seq: n.seq }
    switch (r.type) {
      case 'group-post':
        postNodes.push({ n, withdrawn: withdrawn(n), gen: leaves.get(n.diary) || 0 })
        break
      case 'group-hide': {
        // A leave does not withdraw an author's hide of their own post: it
        // grants nothing over anyone else, and a member who left can still
        // hide what they wrote. The admin layer goes through authorized().
        const ref = r.target.writer + ':' + r.target.seq
        const state = hides.get(ref) || { author: false, admin: false }
        if (writerDiary.get(r.target.writer) === n.diary) state.author = r.on
        else if (authorized(n)) state.admin = r.on
        else break
        hides.set(ref, state)
        break
      }
      case 'group-admit': {
        // Only withdrawing an admission is shielded: a member promoted later
        // keeps the admission that covers the posts before the promotion.
        if ((!r.on && shielded(r.member)) || !authorized(n)) break
        const cuts = cutsMap(r.cuts)
        // A positive admit skips writers its cuts do not list: a backlog
        // writer the admin never saw must not become admitted from seq 0. A
        // withdrawal still covers every writer.
        pushTo(admits, r.member, { on: r.on, cuts, unlisted: r.on ? Infinity : 0, gen: admitGen(r.member, cuts, i) })
        break
      }
      case 'group-ban': {
        if (shielded(r.member) || !authorized(n)) break
        if (r.on) {
          latestBan.set(r.member, n)
        } else {
          const ban = latestBan.get(r.member)
          if (!ban || ban.writer !== r.lifts.writer || ban.seq !== r.lifts.seq) break
        }
        // An unban skips writers its cuts do not list: a writer that posted
        // during the ban must not become visible through an unban that never
        // saw it. A ban still covers every writer.
        pushTo(bans, r.member, { on: r.on, cuts: cutsMap(r.cuts), unlisted: r.on ? 0 : Infinity })
        break
      }
      case 'group-meta':
        if (header.visibility === 'public' && !withdrawn(n)) {
          name = r.name
          join = r.join
        }
        break
      case 'group-leave':
        latestLeave.set(n.diary, { writer: n.writer, seq: n.seq })
        left.add(n.diary)
        leaves.set(n.diary, (leaves.get(n.diary) || 0) + 1)
        break
      case 'group-rejoin':
        left.delete(n.diary)
        break
    }
  }

  // A post of generation gen counts the admits of generation >= gen, in
  // causal order. Observed generations need not increase along that order,
  // so the eligible admits are filtered once per (diary, gen) and reused.
  const eligible = new Map()
  const admitsFrom = (d, gen) => {
    const list = admits.get(d)
    if (!list) return null
    const key = d + ':' + gen
    let out = eligible.get(key)
    if (!out) {
      out = list.filter((e) => e.gen >= gen)
      eligible.set(key, out)
    }
    return out
  }
  const admittedAt = (d, gen, w, s) => layerAt(admitsFrom(d, gen), w, s)
  const admittedNow = (d, gen) => lastOn(admitsFrom(d, gen))

  const posts = []
  const future = []
  for (const { n, withdrawn: out, gen } of postNodes) {
    const r = n.record
    if (isFuture(r.at, now)) {
      future.push({ writer: n.writer, seq: n.seq })
      continue
    }
    const d = n.diary
    const hide = hides.get(n.writer + ':' + n.seq)
    const hidden = out || (hide !== undefined && (hide.author || hide.admin)) ||
      (d !== owner && (layerAt(bans.get(d), n.writer, n.seq) ||
        (join === 'approval' && !admittedAt(d, gen, n.writer, n.seq) && !isAdmin(d, n.writer, n.seq))))
    posts.push({
      writer: n.writer,
      diary: d,
      seq: n.seq,
      at: r.at,
      text: r.text,
      replyTo: r.replyTo === null ? null : { writer: r.replyTo.writer, seq: r.replyTo.seq },
      hidden
    })
  }
  future.sort((a, b) => cmp(a.writer, b.writer) || a.seq - b.seq)

  const writersOf = new Map()
  for (const l of kept) pushTo(writersOf, l.diary, l.key)
  // A counted writer an unban did not list stays banned, and one a positive
  // admit did not list stays unadmitted: both keep the diary in front of the
  // admins until a new record lists that writer.
  const bannedNow = (d) => (writersOf.get(d) || []).some((w) => layerNow(bans.get(d), w))
  const uncovered = (d) => (writersOf.get(d) || []).some((w) => !layerNow(admitsFrom(d, leaves.get(d) || 0), w))

  const members = new Map()
  const requests = []
  // With the root unbound (e.g. the creator diary blocked or not held) the
  // header's diary is an ordinary diary, a member only through writers of
  // its own: listing it otherwise would let a node accept writes the fold
  // then ignores.
  for (const d of [...new Set([...(owner !== null ? [owner] : []), ...kept.map((l) => l.diary)])].sort(cmp)) {
    let status
    if (d === owner) status = left.has(d) ? 'left' : 'member'
    else if (lastOn(bans.get(d))) status = 'banned'
    else if (left.has(d)) status = 'left'
    else if (join === 'approval' && !admittedNow(d, leaves.get(d) || 0) && !adminNow(d)) status = 'requested'
    else status = 'member'
    members.set(d, status)
    if (status === 'requested' || (status === 'member' && d !== owner && join === 'approval' &&
      !adminNow(d) && uncovered(d))) requests.push(d)
  }
  const admins = new Set(owner !== null ? [owner] : [])
  const candidatesNow = [...rootAdmin.keys()]
  let community = null
  for (const c of linked) {
    if (!linkedNow(c)) continue
    community = c.key
    candidatesNow.push(c.creator, ...c.admins.keys())
  }
  for (const d of [...new Set(candidatesNow)].sort(cmp)) {
    if (adminNow(d)) admins.add(d)
  }
  // The leave a rejoining writer must name, for every diary that left.
  const leaveRefs = new Map()
  for (const [d, ref] of [...latestLeave].sort((a, b) => cmp(a[0], b[0]))) {
    if (left.has(d)) leaveRefs.set(d, ref)
  }
  // The ban an unban must name in `lifts`, for every diary banned now.
  const banRefs = new Map()
  for (const [d, n] of [...latestBan].sort((a, b) => cmp(a[0], b[0]))) {
    // From the ban layer, not `members`: a diary banned before it joined, or
    // whose writer is not held here, is still banned and liftable.
    if (lastOn(bans.get(d)) || bannedNow(d)) banRefs.set(d, { writer: n.writer, seq: n.seq })
  }

  return {
    kind: header.kind,
    name,
    join,
    visibility: header.visibility,
    creator,
    admins,
    // The community linked from both sides now, or null.
    community,
    members,
    posts,
    requests,
    future,
    last,
    bans: banRefs,
    leaves: leaveRefs,
    // The writers the fold counted (root included when bound): a record in
    // any other core, even one bound by the diary, is not part of the group.
    writers: new Set(logs.filter((l) => l.key !== G || rootBound).map((l) => l.key)),
    incomplete: false
  }
}

function emptyCommunity () {
  return { name: null, creator: null, admins: new Set(), groups: [], incomplete: true }
}

// The pure fold of a community root: `root` is its key (or { key, entries,
// joins }), `joins` the creator diary's group-join history for the root
// (Map diary -> [{ writer, on, seq }], as buildGroup takes it), `groups` the
// groups held, each { key, entries, writers?, joins? } as buildGroup takes
// them. A root its creator's diary never bound (join { group: C, writer: C,
// on: true }) has no creator, no admins and no groups, and is incomplete.
// With `groups` the result lists a group only when buildGroup, given this
// community, names it as the group's community: the same one-community rule
// and leave withdrawal (a root of kind community is a nesting attempt and
// never counts; a group not held, held in forked copies, or whose fold is
// incomplete sets `incomplete`, and a group is still listed only when
// linked). Leaves on the group creator's other writers are seen only when
// the item carries `writers` and `joins`. When no item carries `joins` the
// group root is read as bound to its header's diary, so that view is
// advisory and buildGroup is the authority inside a group; `joins` given,
// even empty, are used as they are. Without `groups`, the community's own
// live links. Never throws.
function buildCommunity (input) {
  try {
    return foldCommunity(input || {})
  } catch {
    return emptyCommunity()
  }
}

function foldCommunity ({ root, header, entries, joins, groups, now }) {
  const obj = isPlainObject(root)
  const key = obj ? root.key : root
  const self = {
    key,
    header,
    entries: entries === undefined && obj ? root.entries : entries,
    joins: joins === undefined && obj ? root.joins : joins
  }
  const copies = communityCopies([self]).get(key)
  const c = copies ? mergeCommunity(key, copies) : null
  if (c === null || c === 'fork') return emptyCommunity()
  const state = communityState(c, null)
  if (!c.bound) return { ...emptyCommunity(), name: state.name }
  const admins = new Set([state.creator])
  for (const d of [...state.admins.keys()].sort(cmp)) if (lastOn(state.admins.get(d))) admins.add(d)
  let list = [...state.on].sort(cmp)
  let incomplete = false
  if (Array.isArray(groups)) {
    const held = new Map()
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]
      if (isPlainObject(g) && isHex64(g.key)) pushTo(held, g.key, g)
    }
    list = list.filter((g) => {
      const items = held.get(g)
      const log = items ? mergeCopies(items.map((x) => readLog(x.entries, true))) : null
      if (log === null || log.header === null) {
        incomplete = true
        return false
      }
      const writers = []
      const joins = new Map()
      let given = false
      for (const x of items) {
        if (Array.isArray(x.writers)) writers.push(...x.writers)
        if (x.joins === undefined) continue
        given = true
        if (!(x.joins instanceof Map)) continue
        for (const [d, l] of x.joins) if (Array.isArray(l)) joins.set(d, [...(joins.get(d) || []), ...l])
      }
      if (!given) joins.set(log.header.diary, [{ writer: g, on: true, seq: 0 }])
      const rootEntries = [{ seq: 0, record: log.header }, ...log.records]
      const built = buildGroup({ root: { key: g, entries: rootEntries }, writers, joins, communities: [self], now })
      if (built.incomplete) incomplete = true
      return built.community === c.key
    })
  }
  return { name: state.name, creator: state.creator, admins, groups: list, incomplete }
}

module.exports = {
  MAX_FUTURE_MS,
  MAX_GROUP_WRITERS,
  MAX_GROUPS_PER_DIARY,
  MAX_GROUPS_PER_COMMUNITY,
  MAX_GROUP_CUTS,
  MAX_COMMUNITY_CUTS,
  MAX_GROUP_NAME,
  MAX_GROUP_WRITERS_PER_DIARY,
  GROUP_TYPES,
  validateGroupHeader,
  validateWriterHeader,
  validateGroupRecord,
  groupHeader,
  writerHeader,
  groupPost,
  groupHide,
  groupAdmit,
  groupBan,
  groupMeta,
  groupAdmin,
  groupLeave,
  communityAdmin,
  groupLink,
  communityLink,
  groupJoins,
  groupJoinHistory,
  orderKey,
  compareOrder,
  isFuture,
  buildGroup,
  buildCommunity
}
