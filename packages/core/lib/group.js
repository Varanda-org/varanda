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
// Pure: b4a, ./records and ./group-crypto (sodium-universal, which loads in
// Node, Bare and the browser) only. The fold opens envelopes itself; the
// device's box secret stays with the caller, behind `keys.unseal`.

const b4a = require('b4a')
const {
  MAX_TEXT, MAX_BLOCK_BYTES, MAX_GROUP_WRITERS, MAX_GROUPS_PER_DIARY,
  MAX_GROUPS_PER_COMMUNITY, MAX_GROUP_CUTS, MAX_COMMUNITY_CUTS, MAX_GROUP_NAME, MAX_GROUP_WRITERS_PER_DIARY,
  nowIso, isHex64, isCanonicalIso, isPlainObject, hasExactKeys, hasControlChars,
  charLength, plainCopy, validRecordCopy
} = require('./records')
const { openRecord, wipe, keyTag, keyCommit, MAX_KEY_RECIPIENTS, MAX_SEALED_INNER_BYTES } = require('./group-crypto')

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
  'community-link': ['type', 'community', 'on', 'cuts', 'at'],
  'group-key': ['type', 'kid', 'basis', 'keys', 'at'],
  'group-sealed': ['type', 'kid', 'nonce', 'box', 'at']
}
const GROUP_TYPES = Object.freeze(Object.keys(RECORD_KEYS))
// A first `group-key` block (kid null) also commits to its key.
const FIRST_KEY_KEYS = ['type', 'kid', 'basis', 'keys', 'commit', 'at']
const ROOT_ONLY = new Set(['group-meta', 'group-admin', 'group-link', 'community-link'])
// A community root (header kind `community`) is a set of groups: it carries
// no posts or moderation of its own.
const COMMUNITY_TYPES = new Set(['group-meta', 'group-admin', 'group-link'])
// A private group carries these sealed, and only there.
const SEALED_TYPES = new Set(['group-post', 'group-hide', 'group-meta'])
const PRIVATE_TYPES = new Set(['group-key', 'group-sealed'])
const MAX_KEY_BASIS = 16
const KEY_ENTRY_KEYS = ['writer', 'sealed']
const INNER_BINDING = ['writer', 'group', 'kid']
const HEX_NONCE = /^[0-9a-f]{48}$/
const HEX_KEY_RE = /^[0-9a-f]{64}$/
// crypto_box_seal of key(32) || tag(16): 96 bytes, 128 base64 characters
// without padding, so the pattern alone is canonical.
const SEALED_KEY = /^[A-Za-z0-9+/]{128}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const SECRETBOX_MAC_BYTES = 16

// X25519 points of small order (libsodium's blocklist, compared with the top
// bit of the last byte cleared, as libsodium does): sealing to one throws in
// sodium-native and gives a constant shared secret elsewhere.
const WEAK_BOX_KEYS = new Set([
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
])

function isWeakBoxKey (hex) {
  if (!isHex64(hex)) return false
  const last = (parseInt(hex.slice(62), 16) & 0x7f).toString(16).padStart(2, '0')
  return WEAK_BOX_KEYS.has(hex.slice(0, 62) + last)
}

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

// Canonical base64 (standard alphabet, padded, the exact re-encoding) of
// minBytes..maxBytes.
function canonicalBase64 (s, minBytes, maxBytes) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return false
  if (s.length > Math.ceil(maxBytes / 3) * 4 || !BASE64.test(s)) return false
  const buf = b4a.from(s, 'base64')
  return buf.byteLength >= minBytes && buf.byteLength <= maxBytes && b4a.toString(buf, 'base64') === s
}

function validBasis (basis) {
  if (!Array.isArray(basis) || basis.length > MAX_KEY_BASIS) return false
  const seen = new Set()
  for (let i = 0; i < basis.length; i++) {
    const r = basis[i]
    if (!validRef(r, 1)) return false
    const k = r.writer + ':' + r.seq
    if (seen.has(k)) return false
    seen.add(k)
  }
  return true
}

function validKeyEntries (keys) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_KEY_RECIPIENTS) return false
  const writers = new Set()
  for (let i = 0; i < keys.length; i++) {
    const e = keys[i]
    if (!isPlainObject(e) || !hasExactKeys(e, KEY_ENTRY_KEYS) || !isHex64(e.writer) || writers.has(e.writer)) return false
    if (typeof e.sealed !== 'string' || !SEALED_KEY.test(e.sealed)) return false
    writers.add(e.writer)
  }
  return true
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
    if (h.join !== 'approval' || h.name !== null || !isHex64(h.box) || isWeakBoxKey(h.box)) return 'malformed'
  } else {
    return 'malformed'
  }
  return isCanonicalIso(h.at) ? null : 'date-invalid'
}

function checkWriterHeader (h) {
  if (!isPlainObject(h)) return 'malformed'
  if (tooLarge(h)) return 'too-large'
  if (!hasExactKeys(h, WRITER_KEYS) || h.type !== 'group-writer' || h.v !== 1) return 'malformed'
  // `box` must match the root's visibility, which only the fold and member
  // sync know (header-invalid there).
  if (!isHex64(h.group) || !isHex64(h.diary) || (h.box !== null && (!isHex64(h.box) || isWeakBoxKey(h.box)))) return 'malformed'
  // A rejoin names the group-leave of the same diary it follows (checked by
  // buildGroup, which knows the other writers).
  if (h.rejoin !== null && !validRef(h.rejoin, 1)) return 'malformed'
  return isCanonicalIso(h.at) ? null : 'date-invalid'
}

function checkRecord (record, seq, root, community, priv) {
  if (!Number.isSafeInteger(seq) || seq < 0) return 'malformed'
  if (seq === 0) return root ? checkHeader(record) : checkWriterHeader(record)
  if (!isPlainObject(record)) return 'malformed'
  const type = record.type
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(RECORD_KEYS, type)) return 'malformed'
  if (!hasExactKeys(record, type === 'group-key' && record.kid === null ? FIRST_KEY_KEYS : RECORD_KEYS[type])) return 'malformed'
  if (ROOT_ONLY.has(type) && !root) return 'root-only'
  if (community && !COMMUNITY_TYPES.has(type)) return 'group-only'
  if (!community && type === 'group-link') return 'community-only'
  if (priv && SEALED_TYPES.has(type)) return 'sealed-only'
  if (!priv && PRIVATE_TYPES.has(type)) return 'private-only'
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
  } else if (type === 'group-key') {
    if (record.kid !== null && !validRef(record.kid, 1)) return 'malformed'
    if (record.kid === null && (typeof record.commit !== 'string' || !HEX_KEY_RE.test(record.commit))) return 'malformed'
    if (!validBasis(record.basis)) return 'basis-invalid'
    if (!validKeyEntries(record.keys)) return 'keys-invalid'
    if (tooLarge(record)) return 'too-large'
  } else if (type === 'group-sealed') {
    if (!validRef(record.kid, 1)) return 'malformed'
    if (typeof record.nonce !== 'string' || !HEX_NONCE.test(record.nonce)) return 'malformed'
    if (!canonicalBase64(record.box, SECRETBOX_MAC_BYTES + 2, MAX_SEALED_INNER_BYTES + SECRETBOX_MAC_BYTES)) return 'box-invalid'
    if (tooLarge(record)) return 'too-large'
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
// `community` marks the root of a community (its header kind), `private` a
// private group: posts, hides and meta travel only sealed there, and keys and
// envelopes only there.
function validateGroupRecord (record, seq, { root = false, community = false, private: priv = false } = {}) {
  try {
    return checkRecord(record, seq, root === true, root === true && community === true, priv === true)
  } catch {
    return 'malformed'
  }
}

function build (record, seq, root, community = false, priv = false) {
  const reason = validateGroupRecord(record, seq, { root, community, private: priv })
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

function writerHeader ({ group, diary, box = null, rejoin = null, at = nowIso() } = {}) {
  return build({ type: 'group-writer', v: 1, group, diary, box, rejoin: copyRef(rejoin), at }, 0, false)
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

// `keys`: [{ writer, sealed }], `sealed` the base64 of a sealed epoch key.
// `commit` (first blocks only, kid null): the hex of keyCommit(key, G, kid)
// from group-crypto, kid being the block's own { writer, seq }.
function groupKey ({ kid = null, basis = [], keys, commit, at = nowIso() } = {}) {
  const entries = Array.isArray(keys) ? keys.map((e) => isPlainObject(e) ? { writer: e.writer, sealed: e.sealed } : e) : keys
  const record = kid === null
    ? { type: 'group-key', kid: null, basis: copyCuts(basis), keys: entries, commit, at }
    : { type: 'group-key', kid: copyRef(kid), basis: copyCuts(basis), keys: entries, at }
  return build(record, 1, false, false, true)
}

function groupSealed ({ kid, nonce, box, at = nowIso() } = {}) {
  return build({ type: 'group-sealed', kid: copyRef(kid), nonce, box, at }, 1, false, false, true)
}

// The inner record of an envelope: a group-post, group-hide or group-meta
// (built and validated as such) plus its binding fields.
function sealedInner (record, { writer, group, kid }) {
  return { ...record, writer, group, kid: copyRef(kid) }
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
// A writer's records are checked against the group's visibility (`priv`); a
// root's against its own header.
function readLog (entries, root, fallback = null, priv = false) {
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
  const isPrivate = root ? header !== null && header.kind === 'group' && header.visibility === 'private' : priv === true
  const bySeq = new Map()
  for (const seq of copies.keys()) {
    if (seq === 0) continue
    const copy = first(seq, { root, community, private: isPrivate })
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
    sealed: 0,
    epoch: null,
    rekeyPending: false,
    entitled: [],
    removals: [],
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
  } else if (t === 'group-key') {
    // Plaintext edges only: the removals it answers and the epoch it
    // continues name blocks, not observed lengths.
    for (const b of record.basis) refs.push(b)
    if (record.kid) refs.push(record.kid)
  } else if (t === 'group-sealed') {
    refs.push(record.kid)
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
    const list = records.map(({ seq, record, kid }) => ({
      writer: log.key,
      diary: log.diary,
      seq,
      record,
      kid: kid || null,
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
      // An opened record keeps its envelope's kid edge, so it never sorts
      // before the epoch it was sealed under.
      const refs = referencesOf(n.record, root)
      if (n.kid !== null) refs.push(n.kid)
      for (const ref of refs) {
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
    side = { strict: [], open: [], closed: false, starts: null, records: [] }
    map.set(k, side)
  }
  // Each record also as its own event with only its own cuts: the check
  // that a link saw every leave of the community creator must never borrow
  // a cut another record of the same period added.
  side.records.push({ on: r.on, cuts: cutsMap(r.cuts), unlisted: r.on ? Infinity : 0 })
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
  // Its records that take power in G away (private groups, "Removals"):
  // only while its link to G is on, and a demotion only of a grant on then.
  const removals = []
  let linkedG = false
  let name = c.header.visibility === 'public' ? c.header.name : null
  for (const { seq, record: r } of c.records) {
    if (r.type === 'group-admin') {
      if (r.member === creator) continue
      if (!r.on && linkedG && lastOn(admins.get(r.member))) removals.push({ writer: c.key, seq, subject: r.member })
      pushTo(admins, r.member, { on: r.on, cuts: cutsMap(r.cuts), unlisted: r.on ? Infinity : 0 })
    } else if (r.type === 'group-link') {
      if (r.on) {
        if (!on.has(r.group) && on.size >= MAX_GROUPS_PER_COMMUNITY) continue
        on.add(r.group)
        if (r.group === G) linkedG = true
      } else {
        // An unlink of a link that is not on (ignored at the cap, or
        // already off) changes nothing.
        if (!on.has(r.group)) continue
        on.delete(r.group)
        if (r.group === G) {
          removals.push({ writer: c.key, seq, subject: null })
          linkedG = false
        }
      }
      if (r.group === G) pushLink(sides, G, r)
    } else if (r.type === 'group-meta' && c.header.visibility === 'public') {
      name = r.name
    }
  }
  const last = c.records.length ? c.records[c.records.length - 1].seq : 0
  return { key: c.key, creator, name, admins, on, side: sides.get(G) || null, removals, last }
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
    if (c && c.side !== null) out.push({ key: k, creator: c.creator, admins: c.admins, groupSide, side: c.side, removals: c.removals, last: c.last })
  }
  return out
}

function linkedNow (c) {
  return lastOn(c.groupSide.strict) && lastOn(c.side.strict)
}

// Whether diary d acts through community c at (w, s), by the rule above.
// A layer for reading: an `on: false` event cuts only the writers it lists.
function lenient (events) {
  return events.map((e) => e.on || e.unlisted === Infinity ? e : { ...e, unlisted: Infinity })
}

function lenientCommunity (c) {
  const admins = new Map([...c.admins].map(([d, list]) => [d, lenient(list)]))
  return {
    ...c,
    admins,
    groupSide: { ...c.groupSide, strict: lenient(c.groupSide.strict), open: lenient(c.groupSide.open) },
    side: { ...c.side, strict: lenient(c.side.strict), open: lenient(c.side.open) }
  }
}

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
  const priv = header.kind === 'group' && header.visibility === 'private'
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
      const log = readLog(w.entries, false, null, priv)
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
    // header-invalid: a writer's recipient key must match the visibility.
    if ((h.box !== null) !== priv) continue
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
  const result = priv ? foldPrivate(ctx, sel.kept, input.keys) : { ...foldLogs(ctx, sel.kept), sealed: 0, epoch: null, rekeyPending: false, entitled: [], removals: [] }
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

function foldLogs (ctx, kept) {
  return foldCore(ctx, kept).result
}

// `auth`, in the opened pass of a private group, is the plaintext pass's
// authority: moderation and membership come from it alone, so decrypted
// edges only place content.
function foldCore ({ G, header, creator, rootBound, rootEntry, now, communities }, kept, auth = null) {
  const logs = [rootEntry, ...kept]
  const writerDiary = new Map(logs.map((l) => [l.key, l.diary]))
  // The header names any diary it likes: creator powers come only from a
  // root that diary bound.
  const owner = rootBound ? creator : null
  const order = causalOrder(logs, G)
  const withdrawn = leaveWithdrawal(order, logs, G)
  const admitGen = observedLeaves(order, logs)

  const rootAdmin = auth ? auth.rootAdmin : new Map()
  // The same layers without leave withdrawal: who could distribute keys for
  // reading (a creator's leave never takes handed-out history back).
  const rawAdmin = new Map()
  // Counted records that take reading rights away (private groups), and the
  // group-key blocks with whether their writer could distribute there.
  const removals = []
  const keyNodes = []
  // Leaves with the generation and the rejoins of their diary before them,
  // judged after the loop ("Removals").
  const leaveNodes = []
  const rejoinCount = new Map()
  // Positions of the records that hand a diary power or keys (an applied
  // admit or root grant on, a counted group-key listing one of its writers):
  // a later leave set of that diary counts only past one of them.
  const authPos = new Map()
  // Per envelope (plaintext pass): whether its author acted with authority
  // there and whether a leave withdraws it.
  const sealedAuth = new Map()
  const sealedOut = new Map()
  const sealedGen = new Map()
  // And whether its author acted as an admin there (posting without an
  // admit), from the envelope's plaintext position.
  const sealedAdmin = new Map()
  // The kids that counted envelopes name: a reading-only epoch nothing
  // counted is sealed under has nothing to read, so it is never opened.
  const sealedKids = new Set()
  for (const n of order) {
    const r = n.record
    if (auth || n.writer !== G || r.type !== 'group-admin' || r.member === creator) continue
    // A grant gives nothing to a writer missing from its cuts (a hidden or
    // forgotten device would otherwise gain authority over its whole past,
    // which a later demotion could not undo), so an admin's new device needs
    // a new grant. A demotion still covers every writer.
    const event = { on: r.on, cuts: cutsMap(r.cuts), unlisted: r.on ? Infinity : 0 }
    pushTo(rawAdmin, r.member, { ...event, pos: n.pos })
    if (withdrawn(n)) continue
    if (!r.on) removals.push(n)
    else pushTo(authPos, r.member, n.pos)
    pushTo(rootAdmin, r.member, event)
  }
  const bans = auth ? auth.bans : new Map()
  const latestBan = new Map()
  const latestLeave = new Map()
  const admits = auth ? auth.admits : new Map()
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
  const links = order.filter((n) => n.writer === G && n.record.type === 'community-link').map((n) => ({ record: n.record, out: withdrawn(n), n }))
  const linked = auth ? auth.linked : linkedCommunities(links, communities)
  const rawLinked = auth ? [] : linkedCommunities(links.map((x) => ({ record: x.record, out: false })), communities)
  // Sending uses the authority the fold counts (a grant or link a
  // creator's leave withdrew gives none); the raw and lenient layers below
  // decide only what may be read.
  const distributes = (n) => n.diary === owner || ((layerAt(rootAdmin.get(n.diary), n.writer, n.seq) ||
    linked.some((c) => communityPower(c, n.diary, n.writer, n.seq))) && !layerAt(bans.get(n.diary), n.writer, n.seq))
  // For reading, a demotion or unlink cuts only the writers it lists (a
  // writer it omits, cut at 0 for sending, keeps the epochs it handed out
  // readable), and a root demotion never reaches a block that sorts before
  // it, whatever its cuts. Grants still give nothing to unlisted writers and
  // bans still apply by their cuts.
  const readAdmin = new Map([...rawAdmin].map(([d, list]) => [d, lenient(list)]))
  const readLinked = rawLinked.map(lenientCommunity)
  const adminBefore = (n) => layerAt((rawAdmin.get(n.diary) || []).filter((e) => e.pos < n.pos), n.writer, n.seq)
  const readable = (n) => n.diary === owner || ((layerAt(readAdmin.get(n.diary), n.writer, n.seq) || adminBefore(n) ||
    readLinked.some((c) => communityPower(c, n.diary, n.writer, n.seq))) && !layerAt(bans.get(n.diary), n.writer, n.seq))
  const envelopeId = (n) => n.writer + ':' + n.seq
  // An opened record keeps the withdrawal its envelope had in the plaintext
  // pass.
  const outOf = (n) => auth && auth.sealedOut.has(envelopeId(n)) ? auth.sealedOut.get(envelopeId(n)) : withdrawn(n)
  // And the membership generation of its envelope: the opened position must
  // not move a post into a generation whose admit covers it.
  const adminOf = (n) => auth && auth.sealedAdmin.has(envelopeId(n)) ? auth.sealedAdmin.get(envelopeId(n)) : adminAt(n.diary, n.writer, n.seq, n.pos)
  const genOf = (n) => auth && auth.sealedGen.has(envelopeId(n)) ? auth.sealedGen.get(envelopeId(n)) : leaves.get(n.diary) || 0
  if (!auth) {
    const raw = new Set(oneAtATime(links.map((x) => x.record)))
    const counted = new Set(oneAtATime(links.filter((x) => !x.out && raw.has(x.record)).map((x) => x.record)))
    for (const x of links) if (!x.record.on && counted.has(x.record)) removals.push(x.n)
  }
  const communityAt = (d, w, s) => linked.some((c) => communityPower(c, d, w, s))
  const communityNow = (d) => linked.some((c) => linkedNow(c) && (d === c.creator || lastOn(c.admins.get(d))))
  // Leaving ends the nomination and the admission (owner decision): for a
  // diary with leaves, a grant, community grant or admit counts only when
  // its cuts prove it saw every leave of that diary (the leave's writer cut
  // past it, or a writer whose rejoin names it cut at 1 or more). Cuts are
  // the admin's, so no `at`, `seen`, join order or extra writer the leaver
  // picks makes an earlier event look later.
  // Every leave per diary in causal order; a record's own view is the
  // prefix before its position (leavesBefore).
  const leavesOf = new Map()
  for (const n of order) if (n.record.type === 'group-leave') pushTo(leavesOf, n.diary, n)
  const rejoinRef = new Map()
  const rejoiners = new Map()
  for (const l of logs) {
    if (!l.rejoin) continue
    rejoinRef.set(l.key, l.rejoin)
    pushTo(rejoiners, l.rejoin.writer + ':' + l.rejoin.seq, l.key)
  }
  const names = (w, L) => {
    const r = rejoinRef.get(w)
    return r !== undefined && r.writer === L.writer && r.seq === L.seq
  }
  const sawOne = (cuts, L) => {
    const c = cuts.get(L.writer)
    if (c !== undefined && c > L.seq) return true
    return (rejoiners.get(L.writer + ':' + L.seq) || []).some((w) => (cuts.get(w) || 0) >= 1)
  }
  // Leaves of a diary are kept in causal order, so "saw every leave before
  // position p" is "saw the first m of them": each event's count of leading
  // leaves it saw is computed once per diary and reused, keeping thousands
  // of leaves and key blocks linear.
  const seenCount = new Map()
  const sawPrefix = (e, d) => {
    let byDiary = seenCount.get(e)
    if (!byDiary) {
      byDiary = new Map()
      seenCount.set(e, byDiary)
    }
    // Resumed when the loop has met more leaves since: a count that stopped
    // at an unseen leave never moves.
    const list = leavesOf.get(d) || []
    let x = byDiary.get(d)
    if (!x) {
      x = { i: 0, stopped: false }
      byDiary.set(d, x)
    }
    while (!x.stopped && x.i < list.length) {
      if (sawOne(e.cuts, list[x.i])) x.i++
      else x.stopped = true
    }
    return x.i
  }
  // An event its subject wrote itself never proves anything (`by`, the
  // author's diary, is kept on admits; grants come from the root or a
  // community root, never from their subject). `m`: how many of d's first
  // leaves the event must have seen.
  const sawLayer = (events, d, m, ex) => events ? events.filter((e) => !e.on || (e.by !== ex && sawPrefix(e, d) >= m)) : events
  const communitySaw = (c, d, w, s, m) => {
    if (!layerAt(c.groupSide.open, w, s)) return false
    if (d === c.creator) return layerAt(c.side.strict, w, s) && layerAt(sawLayer(c.side.records, d, m, null), w, s)
    return layerAt(c.side.open, w, s) && layerAt(sawLayer(c.admins.get(d), d, m, d), w, s)
  }
  // In a private group, authority after its holder's leave needs a grant
  // that saw every leave of that diary sorting before the record (the
  // creator: a writer whose rejoin names its latest such leave), as for
  // keys: a departed admin's old grant moderates nothing, whatever `seen`
  // or rejoin it uses.
  const priv = header.visibility === 'private'
  const leavePosOf = (L) => L.pos
  const leavesBefore = (d, pos) => {
    const list = leavesOf.get(d)
    return list ? firstAbove(list, pos - 1, leavePosOf) : 0
  }
  const isAdmin = (d, w, s) => layerAt(rootAdmin.get(d), w, s) || communityAt(d, w, s)
  const adminAt = (d, w, s, pos) => {
    const m = priv ? leavesBefore(d, pos) : 0
    if (m === 0) return isAdmin(d, w, s)
    return layerAt(sawLayer(rootAdmin.get(d), d, m, d), w, s) || linked.some((c) => communitySaw(c, d, w, s, m))
  }
  const ownerAt = (n) => {
    const m = priv ? leavesBefore(n.diary, n.pos) : 0
    return m === 0 || names(n.writer, leavesOf.get(n.diary)[m - 1])
  }
  const authorized = (n) => {
    if (withdrawn(n)) return false
    if (n.diary === owner) return ownerAt(n)
    return adminAt(n.diary, n.writer, n.seq, n.pos) && !layerAt(bans.get(n.diary), n.writer, n.seq)
  }
  // From the final root state, never from the causal position: shielding by
  // position would let clock skew decide whether two admins can ban each
  // other. A demoted admin loses the shield entirely.
  // The final state; in a private group, after a leave only grants that
  // saw every leave of that diary count, as for keys and moderation.
  const adminNow = (d) => {
    const list = priv ? leavesOf.get(d) : null
    if (!list) return lastOn(rootAdmin.get(d)) || communityNow(d)
    const m = list.length
    return lastOn(sawLayer(rootAdmin.get(d), d, m, d)) || linked.some((c) => linkedNow(c) &&
      (d === c.creator ? lastOn(sawLayer(c.side.records, d, m, null)) : lastOn(sawLayer(c.admins.get(d), d, m, d))))
  }
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
        postNodes.push({ n, withdrawn: outOf(n), gen: genOf(n) })
        break
      case 'group-hide': {
        // A leave does not withdraw an author's hide of their own post: it
        // grants nothing over anyone else, and a member who left can still
        // hide what they wrote. The admin layer goes through authorized().
        const ref = r.target.writer + ':' + r.target.seq
        const state = hides.get(ref) || { author: false, admin: false }
        if (writerDiary.get(r.target.writer) === n.diary) state.author = r.on
        else if (auth ? auth.sealedAuth.get(envelopeId(n)) === true : authorized(n)) state.admin = r.on
        else break
        hides.set(ref, state)
        break
      }
      case 'group-admit': {
        // Only withdrawing an admission is shielded: a member promoted later
        // keeps the admission that covers the posts before the promotion.
        // Nobody admits its own diary: a self-admit an admin writes before
        // leaving could otherwise prove it saw that leave after a rejoin.
        if (auth || (r.on && n.diary === r.member) || (!r.on && shielded(r.member)) || !authorized(n)) break
        const cuts = cutsMap(r.cuts)
        // A positive admit skips writers its cuts do not list: a backlog
        // writer the admin never saw must not become admitted from seq 0. A
        // withdrawal still covers every writer.
        pushTo(admits, r.member, { on: r.on, cuts, unlisted: r.on ? Infinity : 0, gen: admitGen(r.member, cuts, i), by: n.diary })
        if (!r.on) removals.push(n)
        else pushTo(authPos, r.member, n.pos)
        break
      }
      case 'group-ban': {
        if (auth || shielded(r.member) || !authorized(n)) break
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
        if (r.on) removals.push(n)
        break
      }
      case 'group-meta':
        if (header.visibility === 'public' && !withdrawn(n)) {
          name = r.name
          join = r.join
        } else if (header.visibility === 'private' && n.writer === G && !outOf(n) && r.join === 'approval') {
          // An opened meta (root only, where causal order is seq order); a
          // private group always asks for approval.
          name = r.name
        }
        break
      case 'group-key':
        // Leave withdrawal does not apply to reading: an admin who later
        // leaves keeps the history it handed out readable.
        keyNodes.push({ n, dist: readable(n), send: distributes(n), out: withdrawn(n) })
        break
      case 'group-sealed':
        sealedAuth.set(envelopeId(n), authorized(n))
        sealedOut.set(envelopeId(n), withdrawn(n))
        sealedGen.set(envelopeId(n), leaves.get(n.diary) || 0)
        sealedAdmin.set(envelopeId(n), adminAt(n.diary, n.writer, n.seq, n.pos))
        if (!withdrawn(n)) sealedKids.add(r.kid.writer + ':' + r.kid.seq)
        break
      case 'group-leave':
        leaveNodes.push({ n, gen: leaves.get(n.diary) || 0, rejoins: rejoinCount.get(n.diary) || 0 })
        latestLeave.set(n.diary, { writer: n.writer, seq: n.seq })
        left.add(n.diary)
        leaves.set(n.diary, (leaves.get(n.diary) || 0) + 1)
        break
      case 'group-rejoin':
        left.delete(n.diary)
        rejoinCount.set(n.diary, (rejoinCount.get(n.diary) || 0) + 1)
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
        (join === 'approval' && !admittedAt(d, gen, n.writer, n.seq) && !adminOf(n))))
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

  const counted = new Set(logs.filter((l) => l.key !== G || rootBound).map((l) => l.key))
  // Writers outside their diary's current generation: a leave was written
  // on them, a leave withdraws their newest record, they wrote nothing since
  // their diary's latest leave (superseded, e.g. by a rejoining writer), or,
  // with no record at all, their diary has left before and no admit of its
  // current generation lists them.
  const retired = new Set()
  const newest = new Map()
  const lastLeave = new Map()
  for (const n of order) {
    if (n.record.type === 'group-leave') {
      retired.add(n.writer)
      lastLeave.set(n.diary, n.pos)
    }
    newest.set(n.writer, n)
  }
  for (const l of logs) {
    const n = newest.get(l.key)
    const gen = leaves.get(l.diary) || 0
    const old = n !== undefined && lastLeave.has(l.diary) && n.pos < lastLeave.get(l.diary)
    if (n !== undefined ? withdrawn(n) || old : gen > 0 && !layerNow(admitsFrom(l.diary, gen), l.key)) retired.add(l.key)
  }
  // "Entitled writers": keys go to writers, never to a diary as a whole, so
  // a pending device of a member diary gets nothing, and a retired device
  // never keeps receiving through an earlier grant. After a leave, only
  // events that saw every leave count, and the creator only on a writer
  // whose rejoin names its latest leave.
  const entitled = (w) => {
    const d = writerDiary.get(w)
    if (d === undefined || !counted.has(w) || retired.has(w) || left.has(d) || layerNow(bans.get(d), w)) return false
    const list = leavesOf.get(d)
    if (!list) {
      if (d === owner) return true
      if (layerNow(rootAdmin.get(d), w) || linked.some((c) => communityPower(c, d, w, Number.MAX_SAFE_INTEGER))) return true
      return layerNow(admitsFrom(d, 0), w)
    }
    if (d === owner) return names(w, list[list.length - 1])
    const m = list.length
    if (layerNow(sawLayer(rootAdmin.get(d), d, m, d), w) || linked.some((c) => communitySaw(c, d, w, Number.MAX_SAFE_INTEGER, m))) return true
    return layerNow(sawLayer(admits.get(d), d, m, d), w)
  }
  // Community removals: only while G's own root keeps the link on (its
  // unlink is a removal of G's root that already forces a fresh epoch
  // without the community's powers), and only the latest per community
  // root: a distributor that saw it saw every earlier record of that
  // single-writer root, so covering it covers them.
  const holdsInG = (d) => {
    if (left.has(d)) return false
    if (d === owner) return true
    const list = leavesOf.get(d)
    return list ? lastOn(sawLayer(rootAdmin.get(d), d, list.length, d)) : lastOn(rootAdmin.get(d))
  }
  const extRemovals = []
  for (const c of linked) {
    if (!lastOn(c.groupSide.strict)) continue
    let latest = null
    for (const r of c.removals) {
      // A demotion of a diary that still holds key power through G itself
      // (its creator, or a root grant that counts now) takes nothing away.
      if (r.subject !== null && holdsInG(r.subject)) continue
      if (latest === null || r.seq > latest.seq) latest = r
    }
    if (latest !== null) extRemovals.push({ ...latest, last: c.last })
  }
  // A removal counts only when it can take keys away: its subject diary was
  // the creator, granted, admitted, empowered by a linked community or a
  // recipient of a counted epoch. Then only the latest per writer matters:
  // the writer chain makes the earlier ones its ancestors, and coverage of a
  // removal of G's cores is ancestry (a basis ref is an edge too).
  // A block valid for sending after leaves of its diary that sort before it
  // needs authority from an event that saw all of them (the creator: a
  // writer whose rejoin names the latest). A block before any leave keeps
  // its authority, so a departed admin's earlier epochs stay history.
  // A withdrawn block is never valid for sending anyway (every use of
  // `send` also requires it not withdrawn), so it is skipped unscanned.
  const leavePos = (L) => L.pos
  for (const kn of keyNodes) {
    if (!kn.send || kn.out) continue
    const n = kn.n
    const all = leavesOf.get(n.diary)
    const m = all ? firstAbove(all, n.pos - 1, leavePos) : 0
    if (m === 0) continue
    if (n.diary === owner) kn.send = names(n.writer, all[m - 1])
    else kn.send = layerAt(sawLayer(rootAdmin.get(n.diary), n.diary, m, n.diary), n.writer, n.seq) || linked.some((c) => communitySaw(c, n.diary, n.writer, n.seq, m))
  }
  const recipientDiaries = new Set()
  // Only blocks valid for sending: a reading-only block (a demoted
  // distributor's) neither makes a diary hold keys nor hands it power.
  for (const { n, send, out } of keyNodes) {
    // A block written after its author's leave (still valid for reading)
    // hands nothing, and a diary never hands power or keys to itself.
    if (!send || out) continue
    for (const k of n.record.keys) {
      const d = writerDiary.get(k.writer)
      if (d === undefined || d === n.diary) continue
      recipientDiaries.add(d)
      pushTo(authPos, d, n.pos)
    }
  }
  const everHeld = (d) => d === owner || recipientDiaries.has(d) ||
    (rootAdmin.get(d) || []).some((e) => e.on) || (admits.get(d) || []).some((e) => e.on) ||
    linked.some((c) => c.creator === d || c.admins.has(d))
  const latestRemoval = new Map()
  for (const n of removals) {
    if (n.record.type !== 'community-link' && !everHeld(n.record.member)) continue
    const prev = latestRemoval.get(n.writer)
    if (prev === undefined || n.seq > prev.seq) latestRemoval.set(n.writer, n)
  }
  // A leave takes keys away only when it ends a generation that could hold
  // them: the creator's, or one neither banned at the leave's writer and seq
  // (by cuts, so no `seen` or `at` the leaver picks can dodge it) nor without
  // power or admission for its generation. The leaves of one diary between
  // two rejoins form one requirement, met by covering any of them: a second
  // leave (repeated, or backdated before the first on another writer) never
  // adds one.
  const byClass = new Map()
  for (const x of leaveNodes) pushTo(byClass, x.n.diary + ':' + x.rejoins, x)
  const leaveClasses = new Map()
  // Per diary, the first leave position of the previous leave set.
  const prevFirst = new Map()
  const classKeys = [...byClass.keys()].sort((a, b) => {
    const [da, ra] = a.split(':')
    const [db, rb] = b.split(':')
    return cmp(da, db) || Number(ra) - Number(rb)
  })
  for (const k of classKeys) {
    const list = byClass.get(k)
    const d = list[0].n.diary
    // The generation the class ends is the one of its first leave in causal
    // order, whichever writer the leaver backdated it on.
    const gen = list.reduce((m, x) => Math.min(m, x.gen), Infinity)
    const first = list.reduce((m, x) => Math.min(m, x.n.pos), Infinity)
    const last = list.reduce((m, x) => Math.max(m, x.n.pos), -1)
    const unbanned = list.some(({ n }) => !layerAt(bans.get(d), n.writer, n.seq))
    let held
    if (d === owner) {
      held = true
    } else if (!prevFirst.has(d)) {
      held = unbanned && (list.some(({ n }) => isAdmin(d, n.writer, n.seq)) || adminNow(d) || lastOn(admitsFrom(d, gen)))
    } else {
      // A later set needs power or keys handed to the diary after the last
      // counted set began (an admit or grant on, or a counted key block for
      // one of its writers): a standing grant, an old admit or a generation
      // count shifted by a backdated rejoin never makes one.
      const from = prevFirst.get(d)
      held = unbanned && (authPos.get(d) || []).some((p) => p > from && p < last)
    }
    if (!held) continue
    prevFirst.set(d, first)
    leaveClasses.set(k, list.map((x) => x.n))
  }
  const state = {
    owner,
    admins,
    left,
    keyNodes,
    removals: [...latestRemoval.values()],
    leaveClasses: [...leaveClasses.values()],
    extRemovals,
    sealedKids,
    // The last seq held per counted core: a basis ref past it names nothing.
    lastSeq: new Map(logs.map((l) => [l.key, l.records.length ? l.records[l.records.length - 1].seq : 0])),
    entitled,
    counted,
    retired,
    withdrawn,
    auth: { rootAdmin, bans, admits, linked, sealedAuth, sealedOut, sealedGen, sealedAdmin }
  }

  const result = {
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
    writers: counted,
    incomplete: false
  }
  return { result, state }
}

// Private groups ("Private groups"). Everything about authority (members,
// requests, admins, bans, leaves) and the epoch machinery (distributors,
// removals, eligibility, entitled writers) comes from a first fold in which
// every envelope stays sealed, so it follows plaintext ordering edges only
// and every reader of the same blocks agrees on it whatever keys it holds.
// A second fold over the opened envelopes, under that same authority, only
// places content: posts, hides and the private name. Epoch keys live in
// `held` only and are wiped before returning.
function foldPrivate (ctx, kept, keys) {
  const plain = foldCore(ctx, kept)
  const held = new Map()
  try {
    const mine = isPlainObject(keys) && keys.writers instanceof Set ? keys.writers : new Set()
    const unseal = isPlainObject(keys) && typeof keys.unseal === 'function' ? keys.unseal : null
    const epochs = readEpochs(ctx.G, plain.state, mine, unseal, held)
    // The keys a node may hand on (history, rotation) are exactly the ones
    // the fold accepted: each epoch once, in causal order of its first
    // block, as a copy the caller owns and must wipe.
    const onKey = isPlainObject(keys) && typeof keys.onKey === 'function' ? keys.onKey : null
    if (onKey !== null) {
      // Only epochs valid for sending: a reading-only epoch (a departed or
      // demoted distributor's) stays readable here but is never handed on,
      // so a flood of them never reaches history hand-off.
      const accepted = [...epochs.entries()].filter(([id, e]) => held.has(id) && e.full).sort((a, b) => a[1].node.pos - b[1].node.pos)
      for (const [id, e] of accepted) {
        const copy = b4a.from(held.get(id))
        try {
          onKey({ writer: e.kid.writer, seq: e.kid.seq }, copy, [...e.recipients].sort(cmp))
        } catch {}
      }
    }
    let sealed = 0
    const open = (log) => {
      let changed = false
      const records = log.records.map((x) => {
        if (x.record.type !== 'group-sealed') return x
        const inner = openEnvelope(x.record, log.key, x.seq, ctx.G, held)
        if (inner === null) {
          sealed++
          return x
        }
        changed = true
        return { seq: x.seq, record: inner, kid: x.record.kid }
      })
      return changed ? { ...log, records } : log
    }
    const rootEntry = open(ctx.rootEntry)
    const content = foldCore({ ...ctx, rootEntry }, kept.map(open), plain.state.auth).result
    const pick = chooseEpoch(plain.state, epochs, held, mine)
    const st = plain.state
    return {
      ...plain.result,
      name: content.name,
      posts: content.posts,
      future: content.future,
      sealed,
      epoch: pick.epoch,
      rekeyPending: pick.rekeyPending,
      entitled: [...st.counted].filter(st.entitled).sort(cmp),
      // The refs a new epoch's basis must cover: the latest counted removal
      // per writer core and the counted community removals.
      removals: [...st.removals, ...st.leaveClasses.map((c) => c[0]), ...st.extRemovals].map((r) => ({ writer: r.writer, seq: r.seq }))
        .sort((a, b) => cmp(a.writer, b.writer) || a.seq - b.seq)
    }
  } finally {
    for (const k of held.values()) wipe(k)
  }
}

const refId = (r) => r.writer + ':' + r.seq
const EPOCH_PLAIN_BYTES = 48
const EPOCH_KEY_BYTES = 32

// The counted epochs by kid id ({ kid, node, recipients }) and, in `held`,
// the key of each epoch the reader opens, from the first counted block in
// causal order that opens for one of its writers.
function readEpochs (G, state, mine, unseal, held) {
  const epochs = new Map()
  for (const { n, dist, send, out } of state.keyNodes) {
    // `full`: valid for sending and not withdrawn, the only epochs onKey
    // reports and anyone may send under.
    if (dist && n.record.kid === null) epochs.set(refId(n), { kid: { writer: n.writer, seq: n.seq }, node: n, send, full: send && !out, recipients: new Set() })
  }
  for (const { n, dist, send, out } of state.keyNodes) {
    if (!dist) continue
    const r = n.record
    const id = r.kid === null ? refId(n) : refId(r.kid)
    const e = epochs.get(id)
    if (!e) continue
    // Only blocks valid for sending (and not withdrawn) decide rule 4 and
    // what onKey reports: a reading-only block decides only which entries
    // this reader tries to open.
    if (send && !out) for (const k of r.keys) e.recipients.add(k.writer)
    if (held.has(id) || unseal === null || (!e.full && !state.sealedKids.has(id))) continue
    for (const k of r.keys) {
      if (!mine.has(k.writer)) continue
      const key = tryUnseal(unseal, k.sealed, G, e.kid, e.node.record.commit)
      if (key !== null) {
        held.set(id, key)
        break
      }
    }
  }
  return epochs
}

// `unseal(sealed)` is the caller's: crypto_box_seal_open with the device's
// box secret, returning the 48-byte plaintext (key || tag) or null. The fold
// checks the context tag itself (protocol "`group-key`"), so a blob copied
// from another group or epoch never yields a key whatever the caller does.
// The key must also match the first block's commitment, so a continuation
// from anyone (a departed admin included) can only hand the epoch's one key.
function tryUnseal (unseal, sealed, G, kid, commit) {
  let out = null
  try {
    out = unseal(sealed)
    if (!(out instanceof Uint8Array) || out.byteLength !== EPOCH_PLAIN_BYTES) return null
    const tag = keyTag(G, kid.writer, kid.seq)
    let diff = 0
    for (let i = 0; i < tag.byteLength; i++) diff |= out[EPOCH_KEY_BYTES + i] ^ tag[i]
    if (diff !== 0) return null
    const key = b4a.from(out.subarray(0, EPOCH_KEY_BYTES))
    const expected = b4a.from(commit, 'hex')
    const got = keyCommit(key, G, kid)
    let c = 0
    for (let i = 0; i < got.byteLength; i++) c |= got[i] ^ expected[i]
    if (c !== 0 || got.byteLength !== expected.byteLength) {
      wipe(key)
      return null
    }
    return key
  } catch {
    return null
  } finally {
    if (out instanceof Uint8Array) {
      try {
        wipe(out)
      } catch {}
    }
  }
}

// An envelope's inner record, or null when it stays sealed: decrypted, copied
// on the safe path, bound to this writer, group, kid and `at`, then validated
// as a group-post, group-hide or (root only) group-meta.
function openEnvelope (env, writer, seq, G, held) {
  const key = held.get(refId(env.kid))
  if (!key) return null
  const value = plainCopy(openRecord({ nonce: env.nonce, box: env.box }, key))
  if (value === null || !SEALED_TYPES.has(value.type)) return null
  const kid = value.kid
  if (value.writer !== writer || value.group !== G || value.at !== env.at) return null
  if (!isPlainObject(kid) || !hasExactKeys(kid, REF_KEYS) || kid.writer !== env.kid.writer || kid.seq !== env.kid.seq) return null
  const record = {}
  for (const k of Object.keys(value)) if (!INNER_BINDING.includes(k)) record[k] = value[k]
  return validateGroupRecord(record, seq, { root: writer === G }) === null ? record : null
}

// How many coverage requirements ("Eligibility" 3) each candidate first
// block meets. A removal of G's cores is covered by its descendants (the
// nodes it is an ancestor of; a basis ref or an ancestor first block's basis
// is an ancestry edge too), a community record only by a counted first block
// whose basis lists it and that block's descendants. One forward walk per
// requirement, its visited set dropped right after, so memory stays linear
// in the nodes whatever the number of removals.
function coverCounts (state, epochs, cands) {
  // Requirements: the latest counted removal per writer core of G, each
  // leave set, the latest counted removal per community root. A ref names
  // one when it is a leave of the set, or a ref at or past the latest
  // removal on that writer or community root (seeing a later block of a
  // single-writer chain is seeing everything before it).
  const reqs = []
  const byWriter = new Map()
  const byLeave = new Map()
  for (const R of state.removals) {
    const t = R.record.type
    const req = { members: [R], subject: t === 'community-link' ? null : R.record.member }
    reqs.push(req)
    byWriter.set(R.writer, { seq: R.seq, req })
  }
  for (const c of state.leaveClasses) {
    const req = { members: c, subject: c[0].diary }
    reqs.push(req)
    for (const L of c) byLeave.set(refId(L), req)
  }
  const byRoot = new Map()
  for (const R of state.extRemovals) {
    const req = { members: [], subject: R.subject === undefined ? null : R.subject }
    reqs.push(req)
    byRoot.set(R.writer, { seq: R.seq, last: R.last, req })
  }
  // A counted first block (valid for sending, not withdrawn) whose basis
  // names a requirement covers it and its descendants, wherever it sorts:
  // naming it proves the distributor saw it, so no forward reference or
  // cycle the subject builds can hide it. A block of the subject's own
  // diary never covers that diary's removal.
  const listers = new Map()
  for (const e of epochs.values()) {
    if (!e.full) continue
    const K = e.node
    for (const b of K.record.basis) {
      const hits = []
      // Only a ref to a real block, never one past the core's end or a
      // forward ref into the lister's own writer: those make no ordering
      // edge and would name removals that do not exist yet.
      const real = !(b.writer === K.writer && b.seq >= K.seq)
      const w = byWriter.get(b.writer)
      if (w !== undefined && real && b.seq >= w.seq && b.seq <= (state.lastSeq.get(b.writer) || 0)) hits.push(w.req)
      const r = byRoot.get(b.writer)
      if (r !== undefined && b.seq >= r.seq && b.seq <= r.last) hits.push(r.req)
      const l = byLeave.get(refId(b))
      if (l !== undefined) hits.push(l)
      for (const req of hits) if (req.subject !== K.diary) pushTo(listers, req, K)
    }
  }
  const counts = new Map()
  for (const F of cands) counts.set(F, 0)
  const walk = (sources) => {
    const seen = new Set()
    const stack = sources.slice()
    while (stack.length > 0) {
      const n = stack.pop()
      if (seen.has(n)) continue
      seen.add(n)
      if (counts.has(n)) counts.set(n, counts.get(n) + 1)
      // Only edges the final order honors: a forged cycle the order broke
      // never makes a block a descendant of what it sorts before.
      for (const s of n.succ) if (!seen.has(s) && s.pos > n.pos) stack.push(s)
    }
  }
  const after = (R) => R.succ.filter((x) => x.pos > R.pos)
  for (const req of reqs) walk([...req.members.flatMap(after), ...(listers.get(req) || [])])
  return { counts, required: reqs.length }
}

// The newest eligible epoch in causal order of its first block
// ("Eligibility"), else rekeyPending when the reader holds a counted epoch.
// Rule 4 exempts only the reader's earlier writers (not counted any more, or
// retired), never a current writer that is not entitled.
function chooseEpoch (state, epochs, held, mine) {
  const cands = [...epochs.entries()].filter(([id]) => held.has(id)).map(([, e]) => e).sort((a, b) => b.node.pos - a.node.pos)
  if (cands.length === 0) return { epoch: null, rekeyPending: false }
  const earlier = (w) => mine.has(w) && (!state.counted.has(w) || state.retired.has(w))
  const passing = cands.filter((e) => {
    const F = e.node
    const d = F.diary
    // Sending keeps the strict distributor layer.
    if (!e.send || state.withdrawn(F) || state.left.has(d) || (d !== state.owner && !state.admins.has(d))) return false
    for (const w of e.recipients) if (!earlier(w) && !state.entitled(w)) return false
    return true
  })
  if (passing.length === 0) return { epoch: null, rekeyPending: true }
  const { counts, required } = coverCounts(state, epochs, new Set(passing.map((e) => e.node)))
  for (const e of passing) {
    if (counts.get(e.node) === required) return { epoch: { writer: e.kid.writer, seq: e.kid.seq }, rekeyPending: false }
  }
  return { epoch: null, rekeyPending: true }
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
  MAX_KEY_RECIPIENTS,
  MAX_KEY_BASIS,
  MAX_SEALED_INNER_BYTES,
  isWeakBoxKey,
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
  groupKey,
  groupSealed,
  sealedInner,
  groupJoins,
  groupJoinHistory,
  orderKey,
  compareOrder,
  isFuture,
  buildGroup,
  buildCommunity
}
