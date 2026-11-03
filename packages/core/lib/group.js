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
const sodium = require('sodium-universal')
const {
  MAX_TEXT, MAX_BLOCK_BYTES, MAX_GROUP_WRITERS, MAX_GROUPS_PER_DIARY,
  MAX_GROUPS_PER_COMMUNITY, MAX_GROUP_CUTS, MAX_GROUP_NAME, MAX_GROUP_WRITERS_PER_DIARY,
  nowIso, isHex64, isCanonicalIso, isPlainObject, hasExactKeys, hasControlChars,
  charLength, plainCopy, validRecordCopy
} = require('./records')
const { openRecord, wipe, keyTag, keyCommit, MAX_KEY_RECIPIENTS, MAX_SEALED_INNER_BYTES } = require('./group-crypto')

// Same rule as lib/feed.js (not imported, to keep this module pure).
const MAX_FUTURE_MS = 86400000

const HEADER_KEYS = ['type', 'v', 'kind', 'diary', 'community', 'member', 'visibility', 'join', 'name', 'box', 'at']
const WRITER_KEYS = ['type', 'v', 'group', 'diary', 'member', 'box', 'rejoin', 'at']
const REF_KEYS = ['writer', 'seq']
const RECORD_KEYS = {
  'group-post': ['type', 'text', 'replyTo', 'seen', 'at'],
  'group-hide': ['type', 'target', 'on', 'seen', 'at'],
  'group-admit': ['type', 'member', 'on', 'cuts', 'seen', 'at'],
  'group-ban': ['type', 'member', 'on', 'cuts', 'lifts', 'seen', 'at'],
  'group-meta': ['type', 'name', 'join', 'seen', 'at'],
  'group-admin': ['type', 'member', 'on', 'cuts', 'seen', 'at'],
  'group-leave': ['type', 'seen', 'cuts', 'at'],
  'group-create': ['type', 'group', 'seen', 'at'],
  'group-drop': ['type', 'group', 'on', 'seen', 'at'],
  'group-key': ['type', 'kid', 'basis', 'keys', 'auth', 'at'],
  'group-sealed': ['type', 'kid', 'nonce', 'box', 'at'],
  'group-invites': ['type', 'on', 'seen', 'at']
}
const GROUP_TYPES = Object.freeze(Object.keys(RECORD_KEYS))
// A first `group-key` block (kid null) also commits to its key.
const FIRST_KEY_KEYS = ['type', 'kid', 'basis', 'keys', 'auth', 'commit', 'at']
const ROOT_ONLY = new Set(['group-meta', 'group-admin'])
// A community core (its root C, header kind `community`, or one of its
// writers) holds membership in C, the catalogue of its groups and community
// authority inside them, never posts or keys. Its moderation records name
// the group they act in (`group: null` acts on C itself).
const COMMUNITY_KEYS = {
  'group-admit': ['type', 'group', 'member', 'on', 'cuts', 'seen', 'at'],
  'group-ban': ['type', 'group', 'member', 'on', 'cuts', 'lifts', 'seen', 'at'],
  'group-hide': ['type', 'group', 'target', 'on', 'seen', 'at'],
  'group-invites': ['type', 'group', 'on', 'seen', 'at']
}
const CW_ADMIN_KEYS = ['type', 'group', 'member', 'on', 'cuts', 'seen', 'at']
// The repairs a returning creator writes on its CW once C's root lost its
// powers: the community's name and join (`group: null`), and dropping a
// group from the catalogue (`group-drop`, CW only).
const CW_META_KEYS = ['type', 'group', 'name', 'join', 'seen', 'at']
const GROUP_ONLY = new Set(['group-post', 'group-key', 'group-sealed'])
const COMMUNITY_ONLY = new Set(['group-create', 'group-drop'])
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
  // Version 1 has other keys, so it is named before the exact-keys check.
  if (h.type === 'group-header' && h.v === 1) return 'legacy'
  if (!hasExactKeys(h, HEADER_KEYS) || h.type !== 'group-header' || h.v !== 2) return 'malformed'
  if ((h.kind !== 'group' && h.kind !== 'community') || !isHex64(h.diary)) return 'malformed'
  if (h.join !== 'open' && h.join !== 'approval') return 'malformed'
  // A group names its immutable community and the creator device's writer
  // there (C itself when that device created C).
  if (h.kind === 'group' && (!isHex64(h.community) || !isHex64(h.member))) return 'malformed'
  if (h.kind === 'community' && (h.community !== null || h.member !== null || h.visibility !== 'public' || h.box !== null)) return 'malformed'
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
  if (h.type === 'group-writer' && h.v === 1) return 'legacy'
  if (!hasExactKeys(h, WRITER_KEYS) || h.type !== 'group-writer' || h.v !== 2) return 'malformed'
  // `box` must match the root's visibility and `member` the core's kind
  // (set in a group writer, null in a community writer), which only the fold
  // and member sync know (header-invalid there).
  if (!isHex64(h.group) || !isHex64(h.diary) || (h.member !== null && !isHex64(h.member))) return 'malformed'
  if (h.box !== null && (!isHex64(h.box) || isWeakBoxKey(h.box))) return 'malformed'
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
  // A creator who returned demotes through its CW: a community core's
  // `group-admin` off a root carries `group` (null: C, else a group of C).
  const cwAdmin = type === 'group-admin' && community && !root
  const cwMeta = type === 'group-meta' && community && !root
  // A root-shaped grant, demotion or meta in a CW stays where it always was.
  if ((cwAdmin || cwMeta) && hasExactKeys(record, RECORD_KEYS[type])) return 'root-only'
  const keys = type === 'group-key' && record.kid === null
    ? FIRST_KEY_KEYS
    : cwAdmin ? CW_ADMIN_KEYS : cwMeta ? CW_META_KEYS : community && Object.prototype.hasOwnProperty.call(COMMUNITY_KEYS, type) ? COMMUNITY_KEYS[type] : RECORD_KEYS[type]
  if (!hasExactKeys(record, keys)) return 'malformed'
  // Off the root only a demotion or a community meta: naming an admin stays
  // the root's.
  if (ROOT_ONLY.has(type) && !root && !(cwAdmin && record.on === false) && !cwMeta) return 'root-only'
  if (cwMeta && record.group !== null) return 'malformed'
  // Only the community's creator creates groups, in C's root.
  if (community && type === 'group-create' && !root) return 'root-only'
  // A drop is a repair of the root's catalogue, never the root's own.
  if (community && type === 'group-drop' && root) return 'malformed'
  if (community && GROUP_ONLY.has(type)) return 'group-only'
  if (!community && COMMUNITY_ONLY.has(type)) return 'community-only'
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
    // C has no posts: a community hide always names the group it acts in.
    if (community && !isHex64(record.group)) return 'malformed'
    if (!validRef(record.target, 1) || typeof record.on !== 'boolean') return 'malformed'
  } else if (type === 'group-create' || type === 'group-drop') {
    if (!isHex64(record.group)) return 'malformed'
    if (type === 'group-drop' && typeof record.on !== 'boolean') return 'malformed'
  } else if (type === 'group-admit' || type === 'group-admin' || type === 'group-ban') {
    if (community && (type !== 'group-admin' || cwAdmin) && record.group !== null && !isHex64(record.group)) return 'malformed'
    if (!isHex64(record.member) || typeof record.on !== 'boolean') return 'malformed'
    if (!validCuts(record.cuts)) return 'cuts-invalid'
    // An unban names the ban it lifts; a ban lifts nothing.
    if (type === 'group-ban' && (record.on ? record.lifts !== null : !validRef(record.lifts, 1))) return 'lifts-invalid'
  } else if (type === 'group-meta') {
    if (record.name !== null) {
      const reason = nameReason(record.name)
      if (reason) return reason
    }
    if (record.join !== 'open' && record.join !== 'approval') return 'malformed'
  } else if (type === 'group-invites') {
    if (community && record.group !== null && !isHex64(record.group)) return 'malformed'
    if (typeof record.on !== 'boolean') return 'malformed'
  } else if (type === 'group-key') {
    if (record.kid !== null && !validRef(record.kid, 1)) return 'malformed'
    // `auth` cites the distributor's CW length (block 0 is its header, so
    // at least 1); what it cites is checked by the fold.
    if (record.auth !== null && !validRef(record.auth, 1)) return 'malformed'
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
// `community` marks a community core (its root, header kind `community`, or
// one of its writers), `private` a private group: posts, hides and meta
// travel only sealed there, and keys and envelopes only there.
function validateGroupRecord (record, seq, { root = false, community = false, private: priv = false } = {}) {
  try {
    return checkRecord(record, seq, root === true, community === true, priv === true)
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

function groupHeader ({ kind = 'group', diary, community = null, member = null, visibility = 'public', join = 'open', name = null, box = null, at = nowIso() } = {}) {
  return build({ type: 'group-header', v: 2, kind, diary, community, member, visibility, join, name, box, at }, 0, true)
}

function writerHeader ({ group, diary, member = null, box = null, rejoin = null, at = nowIso() } = {}) {
  return build({ type: 'group-writer', v: 2, group, diary, member, box, rejoin: copyRef(rejoin), at }, 0, false)
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

// Whether members may invite: written by the group's creator or an admin.
function groupInvites ({ on, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-invites', on, seen: copyRef(seen), at }, 1, false)
}

// Community-core records; `group: null` acts on the community itself.
function groupCreateRecord ({ group, seen = null, at = nowIso() } = {}) {
  // Written in C's root only.
  return build({ type: 'group-create', group, seen: copyRef(seen), at }, 1, true, true)
}

// A returning creator's community name and join, written on its CW.
function communityMetaCw ({ name, join, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-meta', group: null, name, join, seen: copyRef(seen), at }, 1, false, true)
}

// A returning creator's removal of group `group` from C's catalogue (on:
// false puts it back), written on its CW.
function communityDrop ({ group, on = true, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-drop', group, on, seen: copyRef(seen), at }, 1, false, true)
}

function communityAdmit ({ group = null, member, on, cuts = [], seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-admit', group, member, on, cuts: copyCuts(cuts), seen: copyRef(seen), at }, 1, false, true)
}

// A demotion a returning creator writes on its CW: of a C admin (`group:
// null`) or of an admin of group `group`.
function communityDemote ({ group = null, member, cuts = [], seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-admin', group, member, on: false, cuts: copyCuts(cuts), seen: copyRef(seen), at }, 1, false, true)
}

function communityBan ({ group = null, member, on, cuts = [], lifts = null, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-ban', group, member, on, cuts: copyCuts(cuts), lifts: copyRef(lifts), seen: copyRef(seen), at }, 1, false, true)
}

// Whether members may invite into C (`group: null`) or into its group
// `group`, written by community staff.
function communityInvites ({ group = null, on, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-invites', group, on, seen: copyRef(seen), at }, 1, false, true)
}

function communityHide ({ group, target, on, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-hide', group, target: copyRef(target), on, seen: copyRef(seen), at }, 1, false, true)
}

// `keys`: [{ writer, sealed }], `sealed` the base64 of a sealed epoch key.
// `commit` (first blocks only, kid null): the hex of keyCommit(key, G, kid)
// from group-crypto, kid being the block's own { writer, seq }.
function groupKey ({ kid = null, basis = [], keys, auth = null, commit, at = nowIso() } = {}) {
  const entries = Array.isArray(keys) ? keys.map((e) => isPlainObject(e) ? { writer: e.writer, sealed: e.sealed } : e) : keys
  const record = kid === null
    ? { type: 'group-key', kid: null, basis: copyCuts(basis), keys: entries, auth: copyRef(auth), commit, at }
    : { type: 'group-key', kid: copyRef(kid), basis: copyCuts(basis), keys: entries, auth: copyRef(auth), at }
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
// The fingerprint a diary's `group-confirm` names: lowercase hex BLAKE2b-256
// of the validated group-leave record serialized with the validator's key
// order, so it never depends on how the block travelled. null when the
// record is not a valid group-leave.
function leaveDigest (record) {
  try {
    if (!isPlainObject(record) || record.type !== 'group-leave') return null
    if (validateGroupRecord(record, 1, { community: true }) !== null && validateGroupRecord(record, 1) !== null) return null
    const ref = (r) => ({ writer: r.writer, seq: r.seq })
    const copy = { type: 'group-leave', seen: record.seen === null ? null : ref(record.seen), cuts: record.cuts.map(ref), at: record.at }
    const out = b4a.alloc(32)
    sodium.crypto_generichash(out, b4a.from(JSON.stringify(copy)))
    return b4a.toString(out, 'hex')
  } catch {
    return null
  }
}

// A diary's `group-confirm` records for `group` as { writer, seq, digest,
// dseq }: dseq is the confirm's own seq in the diary.
function groupConfirmHistory (entries, group) {
  const out = []
  try {
    eachEntry(entries, (seq, record) => {
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-confirm' || copy.group !== group) return
      out.push({ writer: copy.writer, seq: copy.seq, digest: copy.digest, dseq: seq })
    })
  } catch {}
  return out
}

// A diary's `group-cut` marks for `group` as { writer, cut, seq }, plus
// { gap: true } when the entries skip a seq (a history read with a hole may
// miss a mark).
function groupCutHistory (entries, group) {
  const out = []
  let next = 0
  let gap = false
  try {
    eachEntry(entries, (seq, record) => {
      if (seq !== next) gap = true
      next = seq + 1
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-cut' || copy.group !== group) return
      out.push({ writer: copy.writer, cut: copy.cut, seq })
    })
  } catch {
    gap = true
  }
  if (gap) out.push({ gap: true })
  return out
}

function groupJoinHistory (entries, group) {
  const out = []
  try {
    eachEntry(entries, (seq, record) => {
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-join' || copy.group !== group) return
      out.push({ writer: copy.writer, on: copy.on, seq, rejoin: copy.rejoin === undefined ? null : copy.rejoin })
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
// A writer's records are checked against the group's visibility (`priv`) and
// the kind of core the caller folds (`asCommunity`); a root's against its own
// header.
function readLog (entries, root, fallback = null, priv = false, asCommunity = false) {
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
  const community = root ? header !== null && header.kind === 'community' : asCommunity === true
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
    rootCut: null,
    kind: null,
    name: null,
    join: null,
    visibility: null,
    creator: null,
    admins: new Set(),
    community: null,
    orphan: false,
    members: new Map(),
    posts: [],
    requests: [],
    future: [],
    last: null,
    bans: new Map(),
    leaves: new Map(),
    lastLeave: new Map(),
    liveWriters: new Set(),
    authorityWriters: new Set(),
    writers: new Set(),
    sealed: 0,
    epoch: null,
    rekeyPending: false,
    entitled: [],
    removals: [],
    memberInvite: false,
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
  } else if (t === 'group-admit' || t === 'group-ban' || t === 'group-admin') {
    for (const c of record.cuts) if (c.seq >= 1) refs.push({ writer: c.writer, seq: c.seq - 1 })
    if (t === 'group-ban' && record.lifts) refs.push(record.lifts)
  } else if (t === 'group-key') {
    // Plaintext edges only: the removals it answers and the epoch it
    // continues name blocks, not observed lengths. `auth` cites a block of
    // another core for validity only: as an edge it would let that core pin
    // the block's place in G's order.
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
      // A node of a community virtual log ("Community-authority actions
      // inside G"): never a G writer's record.
      virtual: log.virtual === true,
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
// on:true join (the per-diary cap keeps the earliest) and the rejoin that
// join names (null when none or malformed).
function readJoins (joins) {
  const bound = new Set()
  const named = []
  const joinSeq = new Map()
  const joinRejoin = new Map()
  if (!(joins instanceof Map)) return { bound, named, joinSeq, joinRejoin }
  for (const [diary, list] of joins) {
    if (!isHex64(diary) || !Array.isArray(list)) continue
    for (let i = 0; i < list.length; i++) {
      const j = plainCopy(list[i])
      if (j === null || j.on !== true || !isHex64(j.writer)) continue
      const pair = diary + ':' + j.writer
      const seq = Number.isSafeInteger(j.seq) && j.seq >= 0 ? j.seq : Infinity
      bound.add(pair)
      named.push(j.writer)
      if (!joinSeq.has(pair) || seq < joinSeq.get(pair)) {
        joinSeq.set(pair, seq)
        joinRejoin.set(pair, validRef(j.rejoin, 1) ? copyRef(j.rejoin) : null)
      }
    }
  }
  return { bound, named, joinSeq, joinRejoin }
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
function leaveWithdrawal (order, logs, root, rootOwnOnly = false) {
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
    // A community root is one append-only chain: only a leave written on it
    // bounds it (at its own seq, or the root cut it lists, if lower); a leave
    // on another device, whatever it lists, never reaches the root.
    if (rootOwnOnly && n.writer === root) {
      // A leave written on the root bounds it at its own seq only: a thief
      // holding the retired root can void only what it appends itself.
      return x.leaves.some((L) => L.writer === root && n.seq >= L.seq)
    }
    const k = firstAbove(x.rejoins, n.pos, pos) - 1
    const since = k >= 0 ? x.rejoins[k].pos : -1
    const i = firstAbove(x.leaves, since, pos)
    if (i === x.leaves.length) return false
    // A leave between the last rejoin and the record: withdrawn whatever the
    // cuts say (a forged cycle can break the order the cuts imply).
    if (firstAbove(x.leaves, n.pos, pos) > i) return true
    // A group-create is a catalogue fact: only a leave of its own writer
    // below it (or one cutting the root below it) withdraws it, never a
    // leave on another device, so a second leave never orphans the groups
    // a diary created.
    if (t === 'group-create') {
      for (let j = i; j < x.leaves.length; j++) {
        const L = x.leaves[j]
        if (L.writer === n.writer && L.seq < n.seq) return true
        const c = n.writer === root ? cutsMap(L.record.cuts).get(root) : undefined
        if (c !== undefined && n.seq >= c) return true
      }
      return false
    }
    const suf = x.sufMin.get(n.writer)
    return suf !== undefined && n.seq >= suf[i]
  }
}

// A layer for reading: an `on: false` event cuts only the writers it lists.
function lenient (events) {
  return events.map((e) => e.on || e.unlisted === Infinity ? e : { ...e, unlisted: Infinity })
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
// seen for that diary. `community` is the parent community's input
// (buildCommunity's), or null; a root of kind community is folded by
// buildCommunity only.
function buildGroup (input) {
  try {
    return fold(input)
  } catch {
    return emptyGroup()
  }
}

function fold (input) {
  const bound = bindCores(input, false)
  if (bound === null) return emptyGroup()
  const { ctx, kept, incomplete, priv } = bound
  const result = priv ? foldPrivate(ctx, kept, input.keys) : { ...foldLogs(ctx, kept), sealed: 0, epoch: null, rekeyPending: false, entitled: [], removals: [] }
  result.community = ctx.C === null ? null : ctx.C.result
  result.orphan = ctx.orphan
  result.incomplete = incomplete
  return result
}

// The parent of a group ("Communities contain groups", parent resolution):
// C's fold and state when C folds and its catalogue holds G created by the
// header's diary (the gate is on), else null with `orphan` (C folds without
// G) or `incomplete` (C missing, forked, invalid or unbound).
function resolveParent (input, G, header) {
  const none = { C: null, orphan: false, incomplete: true }
  if (!isPlainObject(input) || !isPlainObject(input.root) || input.root.key !== header.community) return none
  const rootLog = readLog(input.root.entries, true)
  if (rootLog.header === null && !rootLog.raw.has(0)) return none
  const { result, state } = foldCommunityState(input)
  if (state === null) return none
  const made = state.created.get(G)
  // A create C has not synced yet may still list G: only a complete C that
  // lacks G, or one that lists G by another diary, makes it an orphan.
  if (made === undefined && result.incomplete) return none
  if (made === undefined || made.diary !== header.diary) return { C: null, orphan: true, incomplete: false }
  return { C: { result, state }, orphan: false, incomplete: result.incomplete }
}

// The cores that count for a group or, with `asCommunity`, a community
// (same binding rules for both): the root, the writers its diaries bound, at
// most MAX_GROUP_WRITERS_PER_DIARY per diary and MAX_GROUP_WRITERS in all.
// Null when the root has no valid header of the kind asked for.
function bindCores (input, asCommunity) {
  const { root, writers, joins } = input || {}
  const now = Number.isFinite(input && input.now) ? input.now : Date.now()
  if (!isPlainObject(root) || !isHex64(root.key)) return null
  const G = root.key
  const rootLog = readLog(root.entries, true)
  const header = rootLog.header
  if (header === null || (header.kind === 'community') !== asCommunity) return null
  const creator = header.diary
  const priv = header.kind === 'group' && header.visibility === 'private'
  const { bound, named, joinSeq, joinRejoin } = readJoins(joins)
  const rootBound = bound.has(creator + ':' + G)
  const parent = asCommunity ? { C: null, orphan: false, incomplete: false } : resolveParent(input.community, G, header)
  const C = parent.C
  let incomplete = !rootBound || parent.incomplete

  const copies = new Map()
  if (Array.isArray(writers)) {
    for (let i = 0; i < writers.length; i++) {
      const w = writers[i]
      if (!isPlainObject(w)) continue
      const key = w.key
      if (!isHex64(key) || key === G) continue
      const log = readLog(w.entries, false, null, priv, asCommunity)
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
  // Writers whose header is invalid for this core (header-invalid): rejected,
  // never awaited.
  const invalid = new Set()
  for (const [key, list] of copies) {
    const log = mergeCopies(list.map((x) => x.log))
    if (log === null || log.header === null) continue
    const h = log.header
    if (h.group !== G || !bound.has(h.diary + ':' + key) || !list.some((x) => x.diary === h.diary)) continue
    // header-invalid: a writer's recipient key must match the visibility, and
    // a group writer names its device's community writer where a community
    // writer names none.
    if ((h.box !== null) !== priv) continue
    if ((h.member === null) !== asCommunity) {
      invalid.add(key)
      continue
    }
    // The community gate binds a group writer strictly to a counted CW of
    // its own diary; a CW not held while C is incomplete is awaited.
    if (C !== null && (!C.state.counted.has(h.member) || C.state.cwDiary.get(h.member) !== h.diary)) {
      if (C.result.incomplete && !C.state.cwDiary.has(h.member)) incomplete = true
      else invalid.add(key)
      continue
    }
    // A CW's generation counts its header's rejoin only when the diary's
    // earliest on-join of it names the same leave (dropStaleLeaves).
    const c = { key, diary: h.diary, member: h.member, rejoin: h.rejoin, at: h.at, records: log.records }
    if (asCommunity) c.joinRejoin = joinRejoin.get(h.diary + ':' + key) || null
    candidates.set(key, c)
  }
  // A root its creator's diary never bound carries no authority and no
  // posts: anyone can name any diary in a header. Only the header is read.
  const rootRecords = rootBound ? rootLog.records : []
  const rootEntry = { key: G, diary: creator, rejoin: null, at: header.at, records: rootRecords }
  const { valid, rejected } = checkRejoins(candidates, rootEntry)
  for (const w of named) {
    if (w !== G && !valid.has(w) && !rejected.has(w) && !invalid.has(w)) incomplete = true
  }
  const capped = capPerDiary(valid, joinSeq, rootBound ? creator : null)
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
  const ctx = { G, header, creator, rootBound, rootEntry, now, C, orphan: parent.orphan, bound: valid, confirms: input.confirms, marks: input.marks }
  const over = capped.length > MAX_GROUP_WRITERS - 1
  let sel = select(new Set(), new Set())
  // The final ban layer depends on the writers kept: a first pass ranks
  // without it, the second puts the diaries it bans last. Both rank by the
  // admins a fold of the root and the creator's writers finds: leaves
  // withdraw root records only through the creator's own writers, so a
  // grant a creator leave withdrew gives no priority. The tier reads the
  // root grant layer alone (plus the parent community's admins): a status
  // filter would need the very writers the cap is choosing.
  if (over) {
    const own = capped.filter((c) => rootBound && c.diary === creator)
    const admins = foldCore(ctx, own).state.granted
    const first = foldLogs(ctx, select(new Set(), admins).kept)
    // Diaries banned in C rank with G's banned ones (the gate bans them).
    const bannedC = C === null ? [] : [...C.result.members].filter(([, st]) => st === 'banned').map(([d]) => d)
    sel = select(new Set([...first.bans.keys(), ...bannedC]), admins)
  }
  if (over || sel.dropped) incomplete = true
  return { ctx, kept: sel.kept, incomplete, priv }
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
function observedLeaves (order, logs, setOf = null) {
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
    // With `setOf` (a community), the distinct leave sets observed.
    const sets = new Set()
    for (const [w, c] of cuts) {
      const list = byWriter.get(w)
      if (list) {
        const m = Math.min(firstAbove(list, c - 1, seqOf), firstAbove(list, pos - 1, at))
        count += m
        if (setOf) for (let j = 0; j < m; j++) sets.add(setOf.get(w + ':' + list[j].seq))
      }
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
        if (setOf) sets.add(setOf.get(rj.writer + ':' + rj.seq))
      }
    }
    return setOf ? sets.size : count
  }
}

// The virtual logs a parent community adds to G's order: per counted CW of
// C (C's root standing for its creator's), its admit, ban and hide records
// naming G, and an internal `community-leave` node for each of its leaves.
// The internal nodes order only after the previous node of their log. A key
// G already folds as one of its own cores is never added twice.
function communityLogs (cs, G, taken) {
  const out = []
  for (const log of cs.logs) {
    if (!cs.counted.has(log.key) || taken.has(log.key) || log.key === G) continue
    const records = []
    for (const x of log.records) {
      const r = x.record
      if (r.type === 'group-leave') records.push({ seq: x.seq, record: { type: 'community-leave', at: r.at } })
      else if ((r.type === 'group-admit' || r.type === 'group-ban' || r.type === 'group-hide' || r.type === 'group-admin' || r.type === 'group-invites') && r.group === G) records.push(x)
    }
    if (records.length > 0) out.push({ key: log.key, diary: log.diary, rejoin: null, at: null, records, virtual: true })
  }
  return out.sort((a, b) => cmp(a.key, b.key))
}

function foldLogs (ctx, kept) {
  return foldCore(ctx, kept).result
}

// In a community, a leave written on a CW already retired when it sorts (a
// leave was on it or listed it, or its header generation is below the leave
// set the new leave would join) does not count: it opens no leave set,
// retires nothing and is no removal. So a lost or stolen old device can
// never end its owner's current generation. Such leaves are dropped from
// the logs before the fold.
function dropStaleLeaves (G, rootEntry, kept) {
  const logs = [rootEntry, ...kept]
  const order = causalOrder(logs, G)
  const diaryOf = new Map(logs.map((l) => [l.key, l.diary]))
  // Only a rejoin the diary signed in the CW's earliest on-join sets its
  // generation: the header alone is the CW key's word, and an old device
  // key could fork block 0 to claim another generation. Otherwise the CW is
  // generation 0. The rejoin still orders as a node (causal order) whatever
  // the join says.
  const signedRejoin = (l) => l.rejoin && l.joinRejoin && l.joinRejoin.writer === l.rejoin.writer && l.joinRejoin.seq === l.rejoin.seq
  const rejoinOf = new Map(logs.filter(signedRejoin).map((l) => [l.key, l.rejoin]))
  const ranks = new Map()
  const rejoinsSoFar = new Map()
  // Writers that wrote a counted leave of their own: a further leave on
  // them is stale. A sibling's cut never makes a leave stale (a stolen
  // device could otherwise void the leave its owner's rejoin names).
  const leftSoFar = new Set()
  const setOfLeave = new Map()
  // The counted leave written on each core (at most one: a later one on the
  // same core is stale).
  const leaveOf = new Map()
  const stale = new Set()
  const counted = []
  // A core's generation from its header: 0 without a rejoin, k + 1 for a
  // rejoin naming a counted leave of set k, unknown (Infinity) while that
  // leave is not counted yet.
  const genAt = (w) => {
    const r = rejoinOf.get(w)
    if (r === undefined) return 0
    const named = setOfLeave.get(r.writer + ':' + r.seq)
    return named === undefined ? Infinity : named + 1
  }
  for (const n of order) {
    const t = n.record.type
    if (t === 'group-rejoin') {
      rejoinsSoFar.set(n.diary, (rejoinsSoFar.get(n.diary) || 0) + 1)
      continue
    }
    if (t !== 'group-leave') continue
    const d = n.diary
    const v = rejoinsSoFar.get(d) || 0
    let m = ranks.get(d)
    if (!m) {
      m = new Map()
      ranks.set(d, m)
    }
    const k = m.has(v) ? m.get(v) : m.size
    const gen = genAt(n.writer)
    if (leftSoFar.has(n.writer) || gen < k) {
      stale.add(n.writer + ':' + n.seq)
      continue
    }
    m.set(v, k)
    setOfLeave.set(n.writer + ':' + n.seq, k)
    leaveOf.set(n.writer, { writer: n.writer, seq: n.seq })
    counted.push({ n, k })
    leftSoFar.add(n.writer)
  }
  // The partition the fold reuses: each counted leave's set, each core's
  // generation, the number of sets per diary, the retired cores, and for a
  // set a rejoin closed, the leave that rejoin names.
  const genOf = new Map()
  for (const l of logs) {
    const g = genAt(l.key)
    genOf.set(l.key, g === Infinity ? 0 : g)
  }
  const setsOf = new Map()
  for (const [d, m] of ranks) setsOf.set(d, m.size)
  const retired = new Set()
  for (const { n, k } of counted) {
    retired.add(n.writer)
    // A cut retires (for authority and liveness) only a device of this
    // set's generation or an earlier one, never a later device.
    for (const c of n.record.cuts) if (diaryOf.get(c.writer) === n.diary && genOf.get(c.writer) <= k) retired.add(c.writer)
  }
  for (const l of logs) if (genOf.get(l.key) < (setsOf.get(l.diary) || 0)) retired.add(l.key)
  const closedBy = new Map()
  for (const l of logs) {
    const r = rejoinOf.get(l.key)
    const k = r ? setOfLeave.get(r.writer + ':' + r.seq) : undefined
    if (k !== undefined && !closedBy.has(l.diary + ':' + k)) closedBy.set(l.diary + ':' + k, { writer: r.writer, seq: r.seq })
  }
  const part = { setOfLeave, genOf, setsOf, retired, closedBy, leaveOf }
  if (stale.size === 0) return { rootEntry, kept, part }
  const strip = (l) => {
    const records = l.records.filter((x) => !stale.has(l.key + ':' + x.seq))
    return records.length === l.records.length ? l : { ...l, records }
  }
  return { rootEntry: strip(rootEntry), kept: kept.map(strip), part }
}

// `auth`, in the opened pass of a private group, is the plaintext pass's
// authority: moderation and membership come from it alone, so decrypted
// edges only place content.
// A root of kind community folds in community mode: no posts or keys, admit
// and ban only from records with `group: null`, and the catalogue of its
// groups.
function foldCore ({ G, header, creator, rootBound, rootEntry, now, C = null, bound = null, confirms = null, marks = null }, kept, auth = null) {
  const isC = header.kind === 'community'
  // A counted leave is confirmed only by its diary's `group-confirm` naming
  // that exact leave: its writer, seq and record digest (never another
  // leave on the same writer, nor a divergent copy at that seq).
  // Each confirmed leave maps to the lowest diary seq of a confirm naming it
  // (Infinity when the input gives none).
  const confirmIndex = new Map()
  if (confirms instanceof Map) {
    for (const [d, list] of confirms) {
      if (!Array.isArray(list)) continue
      for (const e of list) {
        if (!isPlainObject(e)) continue
        const k = d + ':' + e.writer + ':' + e.seq + ':' + e.digest
        const at = Number.isSafeInteger(e.dseq) && e.dseq >= 0 ? e.dseq : Infinity
        confirmIndex.set(k, Math.min(at, confirmIndex.has(k) ? confirmIndex.get(k) : Infinity))
      }
    }
  }
  const confirmKey = (L) => L.diary + ':' + L.writer + ':' + L.seq + ':' + leaveDigest(L.record)
  const isConfirmed = (L) => confirmIndex.size > 0 && confirmIndex.has(confirmKey(L))
  let part = null
  if (isC) ({ rootEntry, kept, part } = dropStaleLeaves(G, rootEntry, kept))
  const logs = [rootEntry, ...kept]
  const writerDiary = new Map(logs.map((l) => [l.key, l.diary]))
  // The header names any diary it likes: creator powers come only from a
  // root that diary bound.
  const owner = rootBound ? creator : null
  // The community gate ("Communities contain groups"), on when the parent C
  // authorizes G: C's final state decides who is banned or still a member.
  const cs = C === null ? null : C.state
  const inC = (d) => cs === null || C.result.members.get(d) === 'member'
  const bannedC = (d) => cs !== null && C.result.members.get(d) === 'banned'
  const adminC = (d) => cs !== null && C.result.admins.has(d)
  const rootLive = rootBound && inC(creator)
  const cwOf = new Map(kept.map((l) => [l.key, l.member]))
  // Only a CW whose generation C admitted lets a G writer count: a request
  // never posts or acts inside C's groups.
  const admittedCw = (w) => cs === null || cs.admittedCws.has(cwOf.get(w))
  const live = (w) => inC(writerDiary.get(w)) && !cs.retiredC.has(cwOf.get(w)) && admittedCw(w) && !cs.bannedCws.has(cwOf.get(w))
  const virtual = cs === null ? [] : communityLogs(cs, G, writerDiary)
  const order = causalOrder(virtual.length > 0 ? [...logs, ...virtual] : logs, G)
  const withdrawnG = leaveWithdrawal(order, logs, G, isC)
  // Where each counted leave of C sits in G's order.
  const leaveAt = new Map()
  if (cs !== null) for (const n of order) if (n.record.type === 'community-leave') leaveAt.set(n.writer + ':' + n.seq, n.pos)
  const afterLeave = (ref, n) => {
    const p = ref === undefined ? undefined : leaveAt.get(ref.writer + ':' + ref.seq)
    return p === undefined || n.pos > p
  }
  // A community leave withdraws a G writer's records after the leave that
  // retired its CW (all of them when no leave did), and the root's after
  // its creator's latest leave in C while the creator is out of C. Leaves
  // and rejoins themselves are never withdrawn.
  const leftC = (n) => {
    const t = n.record.type
    if (t === 'group-leave' || t === 'group-rejoin') return false
    if (n.writer === G) {
      if (inC(creator)) return false
      // Only a confirmed leave of the creator's current set, or one written
      // on C's root, bounds the root's history; with none, nothing is
      // withdrawn (its authority is void anyway).
      const ref = cs.currentLeaveOf.get(creator)
      return ref !== undefined && afterLeave(ref, n)
    }
    const cw = cwOf.get(n.writer)
    const ref = cs.retiredBy.get(cw)
    return cs.retiredC.has(cw) && ref !== undefined && afterLeave(ref, n)
  }
  // A C ban withdraws every record of the diary in G (unban restores: the
  // final state); a G leave never touches community authority, which
  // virtual nodes take from C alone.
  // A record on a writer bound to a CW C never admitted is withdrawn too
  // (final state: a later admission makes it count).
  const gated = (n) => n.record.type !== 'group-leave' && n.record.type !== 'group-rejoin' &&
    (bannedC(n.diary) || (n.writer === G ? !inC(creator) && !cs.leavesOf.has(creator) : !admittedCw(n.writer) || cs.bannedCws.has(cwOf.get(n.writer))))
  const withdrawn = cs === null
    ? withdrawnG
    : (n) => !n.virtual && (withdrawnG(n) || gated(n) || leftC(n))
  // No authority after leaving (owner decision): a writer whose CW left C,
  // and the root while G's creator is out of C, carry none at all, for any
  // record, earlier ones included. A community leave sorts by its author's
  // clock and nothing a departed device writes can bound what it appends,
  // so any carve-out could be backdated.
  const voidAuth = (n) => cs !== null && !n.virtual && (n.writer === G ? !inC(creator) : cs.retiredC.has(cwOf.get(n.writer)))
  const admitGen = observedLeaves(order, logs, isC ? part.setOfLeave : null)
  // In a community the generation of a CW is fixed by its own header (no
  // rejoin: 0; a rejoin naming a leave of the diary's set k: k + 1), the
  // rejoin counting only when the diary's earliest on-join of the CW names
  // it too (else 0; group writers keep their header's rejoin). A CW is
  // retired when its generation is below the diary's number of leave sets,
  // or a leave is written on it or lists it, and nothing appended later
  // brings it back. A retired CW carries no authority at all, past records
  // included (no authority after leaving).
  const monoRetired = isC ? part.retired : new Set()
  // The creator's powers on C's root end with its leave (owner decision):
  // root records at root seq >= rootCut carry no authority in C, and group
  // creates there do not count (createCut). A leave the creator's diary
  // confirmed bounds it from any leave set (owner decision, cycle 24); an
  // unconfirmed one only when written on the root, which is generation 0.
  let rootCut = Infinity
  let createCut = Infinity
  // Whether a leave the creator's diary confirmed bounds C's root: the
  // diary-backed evidence that the creating device's powers ended.
  let rootConfirmed = false
  // The lowest creator's diary seq among the confirms of the leaves that
  // bound the root: a group root mark the diary writes at or after it never
  // counts.
  let confirmDseq = Infinity
  // Whether a leave written on C's root itself bounds it (the interim rule).
  let onRootBound = false
  // The leave set that ended the root's powers (the lowest of: the earliest
  // set with a confirmed bounding leave, and 0 when a counted set-0 leave
  // sits on the root), -1 while they last. Only a creator CW of a later generation, created by a rejoin
  // after that leave, writes repairs that count: a CW of the root's time
  // could hold repairs written while the root still had its powers.
  let gateSet = -1
  // Per CW of the creator's diary, the lowest bound a confirmed counted
  // leave retiring it gives: the leave's own seq when written on it, else
  // the cut it lists for it. Repairs on that CW at or above it are void.
  const repairBound = new Map()
  if (isC && owner !== null) {
    const leaveAtRef = new Map()
    for (const n of order) if (n.record.type === 'group-leave') leaveAtRef.set(n.writer + ':' + n.seq, n)
    // A leave on the root bounds it at its own seq only (a lower listed cut
    // would let a thief holding the root void what came before); a leave on
    // another device at the root cut it lists.
    const boundOfLeave = (L) => {
      if (!L) return undefined
      if (L.writer === G) return L.seq
      return cutsMap(L.record.cuts).get(G)
    }
    // Stale leaves are gone already: every leave here is counted, in the
    // set the partition gave it.
    const ownLeaves = [...leaveAtRef.values()].filter((n) => n.diary === owner && part.setOfLeave.has(n.writer + ':' + n.seq))
    const set0 = ownLeaves.filter((n) => part.setOfLeave.get(n.writer + ':' + n.seq) === 0)
    // A leave the creator's diary confirmed (its writer turned off) bounds
    // the root at the bound it gives (its own seq on the root, else the root
    // cut it lists). The bound comes from the earliest leave set holding
    // such a leave, the lowest within that set (owner decision, cycle 25):
    // a later set never lowers it, since a creator leaving again from a
    // device whose copy of the root is behind lists a lower cut, which
    // would orphan real groups. A later set bounds only when no earlier
    // one did. A confirmed leave that does not touch the root gives none.
    // Until one arrives, only a leave of the first set written on the root
    // itself bounds it (at its own seq): an unconfirmed leave on another
    // device, whatever it lists and whatever a rejoin names, never bounds
    // the root or the catalogue.
    const touching = ownLeaves.filter((n) => isConfirmed(n) && boundOfLeave(n) !== undefined)
    const setOf = (n) => part.setOfLeave.get(n.writer + ':' + n.seq)
    const firstSet = touching.length > 0 ? Math.min(...touching.map(setOf)) : -1
    const bounding = touching.filter((n) => setOf(n) === firstSet)
    for (const n of ownLeaves) {
      if (!isConfirmed(n)) continue
      const k = setOf(n)
      const lower = (w, b) => repairBound.set(w, Math.min(b, repairBound.has(w) ? repairBound.get(w) : Infinity))
      lower(n.writer, n.seq)
      const listed = new Set()
      for (const c of n.record.cuts) {
        listed.add(c.writer)
        if (c.writer !== n.writer && writerDiary.get(c.writer) === owner && part.genOf.get(c.writer) <= k) lower(c.writer, c.seq)
      }
      // A creator CW of set k's generation or earlier that the leave neither
      // is on nor lists keeps no repair at all, as leave withdrawal reads an
      // unlisted CW at 0. A CW with its own confirmed counted leave is
      // already bounded at that leave's seq, so a sibling's leave that does
      // not list it voids nothing more on it.
      const ownBounded = (w) => {
        const own = part.leaveOf.get(w)
        return own !== undefined && isConfirmed(leaveAtRef.get(own.writer + ':' + own.seq))
      }
      for (const [w, d] of writerDiary) {
        if (d === owner && w !== G && w !== n.writer && !listed.has(w) && part.genOf.get(w) <= k && !ownBounded(w)) lower(w, 0)
      }
    }
    const onRoot = set0.filter((n) => n.writer === G).map((n) => n.seq)
    if (bounding.length > 0) {
      rootConfirmed = true
      gateSet = firstSet
      rootCut = createCut = Math.min(...bounding.map(boundOfLeave))
      confirmDseq = Math.min(...bounding.map((n) => confirmIndex.get(confirmKey(n))))
    } else if (onRoot.length > 0) {
      rootCut = createCut = Math.min(...onRoot)
      // Only the root key writes on the root: a thief holding a secondary
      // CW alone can never produce this.
      onRootBound = true
      gateSet = 0
    }
    // The gate is the lowest set that ended the root's powers by either
    // route: a counted set-0 leave on the root already ended them at set 0,
    // so a later confirmed bounding leave never raises the gate and never
    // voids repairs a generation-1 CW wrote under it.
    if (onRoot.length > 0) gateSet = 0
  }
  // A group's root: the creator's diary marks (`group-cut`, written when it
  // leaves C) end the root's authority at the lowest cut, even after the
  // creator returns. While the creator's diary history has a gap and it has
  // ever left C, a mark may be missing: the root then carries no authority.
  let gRootCut = Infinity
  // A valid mark (not a gap alone): the diary-backed evidence that the G
  // root's powers ended.
  let gMarked = false
  if (!isC) {
    const list = marks instanceof Map && Array.isArray(marks.get(creator)) ? marks.get(creator) : []
    // Only the marks written before the creator's first confirmed leave of
    // C count (owner decision, cycle 23): the honest order is marks, then
    // the confirm, so a later mark never gives power back to a root that
    // leave left unmarked, nor moves a cut.
    const markLimit = cs !== null && creator === C.result.creator && Number.isFinite(cs.creatorConfirmSeq) ? cs.creatorConfirmSeq : Infinity
    for (const m of list) {
      if (!isPlainObject(m)) continue
      if (m.gap === true) {
        if (cs !== null && cs.leavesOf.has(creator)) gRootCut = 0
      } else if (markLimit !== Infinity && !(Number.isSafeInteger(m.seq) && m.seq < markLimit)) {
        continue
      } else if (m.writer === G && Number.isSafeInteger(m.cut) && m.cut >= 0) {
        gRootCut = Math.min(gRootCut, m.cut)
        gMarked = true
      }
    }
    // Every group of C was created on C's root before its cut, so a
    // confirmed leave of the creator ended the creating device's powers in
    // G too: with no mark to bound them, the G root carries none (owner
    // decision, cycle 21).
    if (cs !== null && cs.creatorConfirmedLeave && !gMarked) gRootCut = 0
  }
  const rootVoid = (n, cut = rootCut) => n.writer === G && n.seq >= (isC ? cut : gRootCut)

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
  // A demotion a returning creator writes on its live CW (owner decision,
  // cycle 16): C's creator diary only, on a counted CW not retired and not
  // withdrawn (in G: a virtual node its community authority covers). It
  // demotes on every writer, like a root demotion, and never grants.
  // Only once the creator's diary shows the creating device's powers ended
  // (a confirmed leave bounding C's root, or a leave on the root itself):
  // before that, a stolen current CW could act for the creator. The same
  // gate covers a CW meta and drop in C.
  // A repair outlives its CW's retirement (owner decision, cycle 25): only
  // a confirmed leave's bound on that CW voids it, so an unconfirmed leave
  // (a copy of the CW key) never undoes the creator's repairs. Every other
  // record keeps no authority after leaving.
  const repairVoid = (n) => repairBound.has(n.writer) && n.seq >= repairBound.get(n.writer)
  const postGate = (n) => gateSet >= 0 && part.genOf.has(n.writer) && part.genOf.get(n.writer) > gateSet
  const cwRepair = (n) => isC && n.writer !== G && postGate(n) && owner !== null && n.diary === owner && !repairVoid(n)
  const cwDemotion = (n) => {
    const r = n.record
    if (r.on !== false || r.type !== 'group-admin' || n.writer === G) return false
    if (isC) return r.group === null && cwRepair(n)
    return gMarked && n.virtual === true && cs !== null && r.group === G && n.diary === C.result.creator && cs.repairC(n.writer, n.seq)
  }
  for (const n of order) {
    const r = n.record
    if (auth || r.type !== 'group-admin' || r.member === creator) continue
    if (n.writer !== G) {
      if (!cwDemotion(n)) continue
      removals.push(n)
      pushTo(rootAdmin, r.member, { on: false, cuts: cutsMap(r.cuts), unlisted: 0 })
      continue
    }
    // A grant gives nothing to a writer missing from its cuts (a hidden or
    // forgotten device would otherwise gain authority over its whole past,
    // which a later demotion could not undo), so an admin's new device needs
    // a new grant. A demotion still covers every writer.
    const event = { on: r.on, cuts: cutsMap(r.cuts), unlisted: r.on ? Infinity : 0 }
    pushTo(rawAdmin, r.member, { ...event, pos: n.pos })
    if (withdrawn(n) || voidAuth(n) || rootVoid(n)) continue
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
  // C only: the latest gated CW meta in causal order, and per group the
  // latest gated CW drop's `on` (true: out of the catalogue, false: back).
  let cwMeta = null
  const dropOn = new Map()
  // Whether members may invite: the last counted `group-invites` in causal
  // order (false without one).
  let memberInvite = false

  // Sending uses the authority the fold counts (a grant a creator's leave
  // withdrew gives none); the raw and lenient layers below decide only what
  // may be read.
  const distributes = (n) => !voidAuth(n) && !rootVoid(n) && (n.diary === owner || (layerAt(rootAdmin.get(n.diary), n.writer, n.seq) && !layerAt(bans.get(n.diary), n.writer, n.seq)))
  // For reading, a demotion cuts only the writers it lists (a writer it
  // omits, cut at 0 for sending, keeps the epochs it handed out readable),
  // and a root demotion never reaches a block that sorts before it, whatever
  // its cuts. Grants still give nothing to unlisted writers and bans still
  // apply by their cuts.
  const readAdmin = new Map([...rawAdmin].map(([d, list]) => [d, lenient(list)]))
  const adminBefore = (n) => layerAt((rawAdmin.get(n.diary) || []).filter((e) => e.pos < n.pos), n.writer, n.seq)
  const readable = (n) => n.diary === owner || ((layerAt(readAdmin.get(n.diary), n.writer, n.seq) || adminBefore(n)) && !layerAt(bans.get(n.diary), n.writer, n.seq))
  // "Community distributors": G authority wins, so `auth` counts only on a
  // block of a diary that is not G's creator and whose strict G admin
  // layer is off there: a block at or past a G demotion's cut falls through
  // to the community, one before it stays judged by G.
  const holdsG = (n) => n.diary === owner || layerAt(rootAdmin.get(n.diary), n.writer, n.seq)
  // The block's `auth` checked against C: null when it gives nothing, else
  // whether it is valid for sending. Reading needs only a grant of C that
  // ever listed the cited CW at or below the cited length (or C's creator):
  // no demotion, C ban or leave makes history unreadable. Sending needs C's
  // current layers there, C admin now and a live writer.
  const viaCommunity = (n) => {
    const a = n.record.auth
    if (cs === null || a === null || holdsG(n)) return null
    const d = n.diary
    if (a.writer !== cwOf.get(n.writer) || cs.cwDiary.get(a.writer) !== d || !cs.lastSeq.has(a.writer) || a.seq > cs.lastSeq.get(a.writer) + 1) return null
    const isCreatorC = d === C.result.creator
    if (!isCreatorC && !(cs.rawAdminC.get(d) || []).some((e) => e.on && e.cuts.has(a.writer) && e.cuts.get(a.writer) <= a.seq)) return null
    const layer = isCreatorC || (layerAt(cs.rootAdminC.get(d), a.writer, a.seq) && !layerAt(cs.bansC.get(d), a.writer, a.seq))
    // Sending also needs the cited device to hold authority now: a demoted
    // CW of a diary still admin through another never sends.
    return { send: layer && adminC(d) && live(n.writer) && C.result.authorityWriters.has(a.writer) }
  }
  const envelopeId = (n) => n.writer + ':' + n.seq
  // An opened record keeps the withdrawal its envelope had in the plaintext
  // pass.
  const outOf = (n) => auth && auth.sealedOut.has(envelopeId(n)) ? auth.sealedOut.get(envelopeId(n)) : withdrawn(n)
  // And the membership generation of its envelope: the opened position must
  // not move a post into a generation whose admit covers it.
  const adminOf = (n) => auth && auth.sealedAdmin.has(envelopeId(n)) ? auth.sealedAdmin.get(envelopeId(n)) : adminAt(n.diary, n.writer, n.seq, n.pos)
  const genOf = (n) => auth && auth.sealedGen.has(envelopeId(n)) ? auth.sealedGen.get(envelopeId(n)) : leaves.get(n.diary) || 0
  // Leaving ends the nomination and the admission (owner decision): for a
  // diary with leaves, a grant or admit counts only when
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
  // author's diary, is kept on admits; grants come from the root, never from
  // their subject). `m`: how many of d's first leaves the event must have
  // seen.
  const sawLayer = (events, d, m, ex) => events ? events.filter((e) => !e.on || (e.by !== ex && sawPrefix(e, d) >= m)) : events
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
  const isAdmin = (d, w, s) => layerAt(rootAdmin.get(d), w, s)
  const adminAt = (d, w, s, pos) => {
    const m = priv ? leavesBefore(d, pos) : 0
    if (m === 0) return isAdmin(d, w, s)
    return layerAt(sawLayer(rootAdmin.get(d), d, m, d), w, s)
  }
  const ownerAt = (n) => {
    const m = priv ? leavesBefore(n.diary, n.pos) : 0
    return m === 0 || names(n.writer, leavesOf.get(n.diary)[m - 1])
  }
  const authorized = (n, cut = rootCut) => {
    if (n.virtual) return !bannedC(n.diary) && cs.authorizedC(n.writer, n.seq)
    if (voidAuth(n) || rootVoid(n, cut)) return false
    if (isC && n.writer !== G && monoRetired.has(n.writer)) return false
    if (withdrawn(n)) return false
    if (n.diary === owner) return rootLive && ownerAt(n)
    return adminAt(n.diary, n.writer, n.seq, n.pos) && !layerAt(bans.get(n.diary), n.writer, n.seq)
  }
  // From the final root state, never from the causal position: shielding by
  // position would let clock skew decide whether two admins can ban each
  // other. A demoted admin loses the shield entirely.
  // The final state; in a private group, after a leave only grants that
  // saw every leave of that diary count, as for keys and moderation.
  const grantLayer = (d) => {
    const list = priv ? leavesOf.get(d) : null
    return list ? sawLayer(rootAdmin.get(d), d, list.length, d) : rootAdmin.get(d)
  }
  // The root grant alone (the writer cap's tiers).
  const grantedNow = (d) => lastOn(grantLayer(d))
  // Under the gate a diary is a G admin (shield, title, status) only on a
  // live writer the grant lists: a departed admin, or one back in C on a
  // device the grant never listed, is none.
  // Every bound writer counts here, kept or dropped by the writer cap: the
  // title follows the person, and the cap only decides whose records fold.
  const boundOf = new Map()
  for (const b of bound ? bound.values() : kept) pushTo(boundOf, b.diary, b)
  const keptKeys = new Set(kept.map((l) => l.key))
  const adminNow = (d) => {
    const layer = grantLayer(d)
    // A community: on a counted, not retired CW the grant covers now (the
    // grant layer is what admits it). A group without parent: on a bound
    // writer the grant covers now.
    if (isC) return (boundOf.get(d) || []).some((b) => keptKeys.has(b.key) && !monoRetired.has(b.key) && layerNow(layer, b.key))
    if (cs === null) return (boundOf.get(d) || []).some((b) => layerNow(layer, b.key))
    return (boundOf.get(d) || []).some((b) => inC(d) && !cs.retiredC.has(b.member) && cs.admittedCws.has(b.member) && layerNow(layer, b.key))
  }
  const shielded = (d) => (d === owner && rootLive) || adminNow(d) || adminC(d)
  // In C, admit, ban and hide records naming a group act inside that group
  // (its own fold): here they are only nodes of the order.
  const elsewhere = (r) => isC && r.group !== null

  // The newest node in causal order, a rejoin's block 0 included: a new post
  // names it as `seen`, so a post sent after a rejoin never sorts before it.
  let last = null
  for (let i = 0; i < order.length; i++) {
    const n = order[i]
    const r = n.record
    if ((n.seq >= 1 && r.type !== 'community-leave') || r.type === 'group-rejoin') last = { writer: n.writer, seq: n.seq }
    switch (r.type) {
      case 'group-post':
        postNodes.push({ n, withdrawn: outOf(n), gen: genOf(n) })
        break
      case 'group-hide': {
        if (isC) break
        // A leave does not withdraw an author's hide of their own post: it
        // grants nothing over anyone else, and a member who left can still
        // hide what they wrote. The admin layer goes through authorized().
        const ref = r.target.writer + ':' + r.target.seq
        const state = hides.get(ref) || { author: false, admin: false }
        if (writerDiary.get(r.target.writer) === n.diary) state.author = r.on
        else if (auth && !n.virtual ? auth.sealedAuth.get(envelopeId(n)) === true : authorized(n)) state.admin = r.on
        else break
        hides.set(ref, state)
        break
      }
      case 'group-admit': {
        // Only withdrawing an admission is shielded: a member promoted later
        // keeps the admission that covers the posts before the promotion.
        // Nobody admits its own diary: a self-admit an admin writes before
        // leaving could otherwise prove it saw that leave after a rejoin.
        if (auth || elsewhere(r) || (r.on && n.diary === r.member) || (!r.on && shielded(r.member)) || !authorized(n)) break
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
        if (auth || elsewhere(r) || shielded(r.member) || !authorized(n)) break
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
        if (isC && n.writer !== G) {
          if (cwRepair(n)) cwMeta = r
        } else if (header.visibility === 'public' && !withdrawn(n) && !voidAuth(n) && !rootVoid(n)) {
          name = r.name
          join = r.join
        } else if (header.visibility === 'private' && n.writer === G && !outOf(n) && !voidAuth(n) && !rootVoid(n) && r.join === 'approval') {
          // An opened meta (root only, where causal order is seq order); a
          // private group always asks for approval.
          name = r.name
        }
        break
      case 'group-key':
        // Leave withdrawal does not apply to reading: an admin who later
        // leaves keeps the history it handed out readable.
        {
          const viaC = viaCommunity(n)
          keyNodes.push({ n, dist: viaC !== null || readable(n), send: viaC !== null ? viaC.send : distributes(n), out: withdrawn(n), viaC: viaC !== null })
        }
        break
      case 'group-sealed':
        sealedAuth.set(envelopeId(n), authorized(n))
        sealedOut.set(envelopeId(n), withdrawn(n))
        sealedGen.set(envelopeId(n), leaves.get(n.diary) || 0)
        sealedAdmin.set(envelopeId(n), adminAt(n.diary, n.writer, n.seq, n.pos))
        // A community ban hides the envelope but never takes away the read
        // validity of its epoch (A2): its kid still opens.
        if (!withdrawn(n) || (cs !== null && !withdrawnG(n) && !leftC(n))) sealedKids.add(r.kid.writer + ':' + r.kid.seq)
        break
      case 'group-leave':
        leaveNodes.push({ n, gen: leaves.get(n.diary) || 0, rejoins: isC ? part.setOfLeave.get(n.writer + ':' + n.seq) || 0 : rejoinCount.get(n.diary) || 0 })
        latestLeave.set(n.diary, { writer: n.writer, seq: n.seq })
        left.add(n.diary)
        // In a community, generations count leave SETS: a further leave of
        // a set already counted never moves the diary's generation.
        if (!isC || (part.setOfLeave.get(n.writer + ':' + n.seq) || 0) >= (leaves.get(n.diary) || 0)) leaves.set(n.diary, (leaves.get(n.diary) || 0) + 1)
        break
      case 'group-rejoin':
        left.delete(n.diary)
        rejoinCount.set(n.diary, (rejoinCount.get(n.diary) || 0) + 1)
        break
      case 'group-drop':
        if (cwRepair(n)) dropOn.set(r.group, r.on)
        break
      case 'group-invites':
        // Admin authority at the record's position, as for an admit (a
        // virtual node: community authority inside G); in C a returning
        // creator's repair on its live CW counts too, as for its CW meta.
        if (elsewhere(r)) break
        if (authorized(n) || (isC && cwRepair(n))) memberInvite = r.on
        break
    }
  }
  // A CW meta of the returning creator overrides the root's metas: the root
  // lost its powers, and its counted metas came before them ending.
  if (cwMeta !== null) {
    name = cwMeta.name
    join = cwMeta.join
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
        (join === 'approval' && !admittedAt(d, gen, n.writer, n.seq) && !adminOf(n) && !adminC(d))))
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
  // Under the gate a diary with no live writer (the root counting for the
  // creator while it is in C) is out of G: it must enter C first.
  const hasLive = (d) => (d === owner && rootLive) || (writersOf.get(d) || []).some(live)
  for (const d of [...new Set([...(owner !== null ? [owner] : []), ...kept.map((l) => l.diary)])].sort(cmp)) {
    let status
    if (bannedC(d)) status = 'banned'
    else if (cs !== null && !hasLive(d)) status = 'left'
    else if (d === owner) status = left.has(d) ? 'left' : 'member'
    else if (lastOn(bans.get(d))) status = 'banned'
    else if (left.has(d)) status = 'left'
    else if (join === 'approval' && !admittedNow(d, leaves.get(d) || 0) && !adminNow(d) && !adminC(d)) status = 'requested'
    else status = 'member'
    members.set(d, status)
    if (status === 'requested' || (status === 'member' && d !== owner && join === 'approval' &&
      !adminNow(d) && !adminC(d) && uncovered(d))) requests.push(d)
  }
  // C's creator is an admin of C (and so of every group of C) only while
  // it is a member of C: no authority after leaving.
  const admins = new Set(owner !== null && rootLive && (!isC || members.get(owner) === 'member') ? [owner] : [])
  // The root grant layer alone, for the writer cap's tiers.
  const granted = new Set(owner !== null ? [owner] : [])
  // A community lists only admins that are members of it now: a left or
  // banned one keeps whatever shield the layers give, never the title. So
  // does a group under the gate, which also lists the community's admins.
  for (const d of [...rootAdmin.keys()].sort(cmp)) {
    if (!grantedNow(d)) continue
    granted.add(d)
    if (adminNow(d) && (!isC || members.get(d) === 'member') && inC(d)) admins.add(d)
  }
  if (cs !== null) {
    for (const d of C.result.admins) {
      admins.add(d)
      granted.add(d)
    }
  }
  // The leave a rejoining writer must name, for every diary that left.
  const leaveRefs = new Map()
  // And the causally latest leave of every diary that ever left, rejoined
  // or not: what a new writer of that diary names in `rejoin`, whatever
  // `at` its devices' clocks wrote.
  const leaveRefsAll = new Map()
  for (const [d, ref] of [...latestLeave].sort((a, b) => cmp(a[0], b[0]))) {
    leaveRefsAll.set(d, ref)
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
  if (isC) {
    retired.clear()
    for (const w of monoRetired) retired.add(w)
  }
  // The writers whose NEXT record (at their held length, after every node
  // of the order) would count, and those whose next record would also act
  // with authority, so nodes never approximate liveness or power per
  // device. A community counts only members' writers; a group excludes
  // banned diaries and writers, and, under the gate, writers whose CW is
  // not live in C (the root: rootLive).
  const liveWriters = new Set()
  const authorityWriters = new Set()
  const endPos = order.length
  for (const l of logs) {
    const w = l.key
    const d = l.diary
    if (!counted.has(w) || retired.has(w)) continue
    if (isC
      ? members.get(d) !== 'member' || layerNow(bans.get(d), w)
      : members.get(d) === 'banned' || layerNow(bans.get(d), w) || bannedC(d) || (w === G ? !rootLive : cs !== null && !live(w))) continue
    liveWriters.add(w)
    const next = l.records.length ? l.records[l.records.length - 1].seq + 1 : 1
    const power = d === owner
      ? rootLive && ownerAt({ writer: w, diary: d, pos: endPos }) && !rootVoid({ writer: w, seq: next })
      : adminAt(d, w, next, endPos) && !layerAt(bans.get(d), w, next)
    if (power) authorityWriters.add(w)
  }
  // "Entitled writers": keys go to writers, never to a diary as a whole, so
  // a pending device of a member diary gets nothing, and a retired device
  // never keeps receiving through an earlier grant. After a leave, only
  // events that saw every leave count, and the creator only on a writer
  // whose rejoin names its latest leave.
  // Under the gate a writer must also be live in C (the root: rootLive),
  // and C's creator and admins receive keys on their live writers; after
  // a G leave, community power holds only on a writer whose rejoin names
  // the latest leave, as for G's creator. Without a parent community
  // nobody is entitled.
  const entitled = (w) => {
    const d = writerDiary.get(w)
    if (cs === null || d === undefined || !counted.has(w) || retired.has(w) || left.has(d) || layerNow(bans.get(d), w)) return false
    if (w === G ? !rootLive : !live(w)) return false
    // A root its creator's diary marked never receives keys again (a stolen
    // creating device would read every later post); the creator receives
    // them on its new writer.
    if (w === G && !isC && gRootCut !== Infinity) return false
    if (d === owner && !rootLive) return false
    const list = leavesOf.get(d)
    if (!list) {
      if (d === owner) return true
      if (layerNow(rootAdmin.get(d), w)) return true
      if (adminC(d)) return true
      return layerNow(admitsFrom(d, 0), w)
    }
    if (d === owner) return names(w, list[list.length - 1])
    if (adminC(d) && names(w, list[list.length - 1])) return true
    const m = list.length
    if (layerNow(sawLayer(rootAdmin.get(d), d, m, d), w)) return true
    return layerNow(sawLayer(admits.get(d), d, m, d), w)
  }
  // Removals by records outside G's own cores, as { writer, seq, subject,
  // last } for coverCounts: G's own fold finds none.
  const extRemovals = []
  // A removal counts only when it can take keys away: its subject diary was
  // the creator, granted, admitted or a recipient of a counted epoch. Then only the latest per writer matters:
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
    if (n.diary === owner || kn.viaC) kn.send = names(n.writer, all[m - 1])
    else kn.send = layerAt(sawLayer(rootAdmin.get(n.diary), n.diary, m, n.diary), n.writer, n.seq)
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
  const everHeldG = (d) => d === owner || recipientDiaries.has(d) ||
    (rootAdmin.get(d) || []).some((e) => e.on) || (admits.get(d) || []).some((e) => e.on)
  const everHeld = (d) => everHeldG(d) ||
    (cs !== null && (cs.everOn.get(d) === true || d === C.result.creator))
  // "Removals" in C's cores: applied C bans and admission withdrawals, the
  // first leave of each leave set in C, and C demotions of a diary that
  // held key power in G only through C. Only the latest per C core counts.
  if (cs !== null) {
    const latestC = new Map()
    const take = (core, seq, subject) => {
      const p = latestC.get(core)
      if (p === undefined || seq > p.seq) latestC.set(core, { seq, subject })
    }
    const holdsInG = (d) => (d === owner && rootLive) || adminNow(d)
    for (const n of cs.removalsC) {
      const d = n.record.member
      if (n.record.type === 'group-admin' ? cs.everOn.get(d) !== true || holdsInG(d) : !everHeld(d)) continue
      take(n.writer, n.seq, d)
    }
    // A community leave set counts with the rule of G's own leave sets: it
    // must end a generation that could hold keys (not banned in C at its
    // writer and seq, and the diary held power or keys in G, or C admin
    // power at the leave), and a later set only when the diary was handed
    // power or keys in G after the previous counted set began. So a banned
    // or unadmitted diary appending leaves adds no requirement.
    const prevFirstC = new Map()
    const setRemovals = []
    for (const S of cs.leaveSetsC) {
      const d = S.diary
      const gpos = S.leaves.map((L) => leaveAt.get(L.writer + ':' + L.seq)).filter((p) => p !== undefined)
      if (gpos.length === 0) continue
      const unbanned = S.leaves.some((L) => !layerAt(cs.bansC.get(d), L.writer, L.seq))
      const powerC = d === C.result.creator || S.leaves.some((L) => layerAt(cs.rootAdminC.get(d), L.writer, L.seq))
      let held
      if (!prevFirstC.has(d)) {
        held = unbanned && (powerC || everHeldG(d))
      } else {
        const from = prevFirstC.get(d)
        const last = Math.max(...gpos)
        held = unbanned && (powerC || (authPos.get(d) || []).some((p) => p > from && p < last))
      }
      if (!held) continue
      prevFirstC.set(d, Math.min(...gpos))
      // Covered by a basis ref naming any leave of the set (or a block at
      // or after it on that leave's core), like G's leave sets.
      const first = S.leaves.reduce((m, L) => L.pos < m.pos ? L : m)
      setRemovals.push({ writer: first.writer, seq: first.seq, subject: d, last: cs.lastSeq.get(first.writer), alts: S.leaves.map((L) => ({ writer: L.writer, seq: L.seq, last: cs.lastSeq.get(L.writer) })) })
    }
    for (const [core, x] of [...latestC].sort((a, b) => cmp(a[0], b[0]))) {
      extRemovals.push({ writer: core, seq: x.seq, subject: x.subject, last: cs.lastSeq.get(core) })
    }
    for (const R of setRemovals) extRemovals.push(R)
  }
  const latestRemoval = new Map()
  for (const n of removals) {
    if (!everHeld(n.record.member)) continue
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
      held = unbanned && (list.some(({ n }) => isAdmin(d, n.writer, n.seq)) || adminNow(d) || adminC(d) || lastOn(admitsFrom(d, gen)))
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
    granted,
    left,
    keyNodes,
    removals: [...latestRemoval.values()],
    leaveClasses: [...leaveClasses.values()],
    extRemovals,
    sealedKids,
    // The last seq held per counted core (a community virtual log: its
    // whole CW): a basis ref past it names nothing.
    lastSeq: new Map([
      ...logs.map((l) => [l.key, l.records.length ? l.records[l.records.length - 1].seq : 0]),
      ...virtual.map((l) => [l.key, cs.lastSeq.get(l.key)])
    ]),
    entitled,
    counted,
    retired,
    withdrawn,
    auth: { rootAdmin, bans, admits, sealedAuth, sealedOut, sealedGen, sealedAdmin }
  }

  if (isC) {
    // Community authority at a node of C's order, with C's final layers:
    // the creator (root bound) or an admin grant on there, no C ban there,
    // not withdrawn by a leave in C.
    const nodeAt = new Map(order.map((n) => [n.writer + ':' + n.seq, n]))
    const authorizedC = (w, s) => {
      const n = nodeAt.get(w + ':' + s)
      return n !== undefined && authorized(n)
    }
    // A CW demotion naming a group of C, on a creator's CW no confirmed
    // leave bound below it (retirement alone never voids a repair).
    // It also holds the C gate (postGate), so a G mark alone never opens it.
    const repairC = (w, s) => {
      const n = nodeAt.get(w + ':' + s)
      return n !== undefined && n.writer !== G && postGate(n) && owner !== null && n.diary === owner && !repairVoid(n)
    }
    const withdrawnC = (w, s) => {
      const n = nodeAt.get(w + ':' + s)
      return n !== undefined && withdrawn(n)
    }
    // The catalogue: Geral (the root's first group-create its leave does not
    // withdraw) first, then every authorized create in causal order up to
    // MAX_GROUPS_PER_COMMUNITY; a create past the cap is an orphan. Authority
    // is judged at the record's position, so a demotion cutting below it
    // takes the group out.
    // Only the creator creates groups, in the root: one append-only chain,
    // read in root seq order (Geral first), each group once.
    const creates = order.filter((n) => n.writer === G && n.record.type === 'group-create' && n.record.group !== G).sort((a, b) => a.seq - b.seq)
    const created = new Map()
    const overflow = new Set()
    let general = null
    for (const n of creates) {
      const g = n.record.group
      if (created.has(g) || overflow.has(g) || !authorized(n, createCut)) continue
      if (general === null) general = g
      if (created.size >= MAX_GROUPS_PER_COMMUNITY) overflow.add(g)
      else created.set(g, { writer: n.writer, seq: n.seq, diary: n.diary })
    }
    // A drop never touches Geral and frees no slot: a create past the cap
    // stays an orphan. An undo lists the group again only where its create
    // still counts.
    const dropped = []
    for (const [g, on] of dropOn) {
      if (!on || g === general || !created.has(g)) continue
      created.delete(g)
      dropped.push(g)
    }
    dropped.sort(cmp)
    // For each retired CW, the leave that retired it: the first leave of its
    // diary after the CW's own start (its rejoin) in causal order that is on
    // it or lists it, else the first such leave on any writer of the diary.
    const startOf = new Map()
    for (const n of order) if (n.record.type === 'group-rejoin') startOf.set(n.writer, n.pos)
    // A device's own counted leave bounds its history; a device that wrote
    // none is bounded only by a leave its diary CONFIRMED (turned that
    // leave's writer off) in its generation's set: the rejoin-named one if
    // confirmed, else the first confirmed in causal order. With none, the
    // community leave withdraws none of its records (a stolen device's
    // forged leave hides only that device's own history).
    const retiredBy = new Map()
    for (const w of retired) {
      const own = part.leaveOf.get(w)
      if (own) {
        retiredBy.set(w, own)
        continue
      }
      const d = writerDiary.get(w)
      const gw = part.genOf.get(w) || 0
      const setLeaves = (leavesOf.get(d) || []).filter((L) => part.setOfLeave.get(L.writer + ':' + L.seq) === gw)
      const closed = part.closedBy.get(d + ':' + gw)
      let L = closed ? setLeaves.find((x) => x.writer === closed.writer && x.seq === closed.seq && isConfirmed(x)) : undefined
      if (L === undefined) L = setLeaves.find(isConfirmed)
      if (L !== undefined) retiredBy.set(w, { writer: L.writer, seq: L.seq })
    }
    // The leaves of each leave set (the leaves of a diary between two of
    // its rejoins) in causal order.
    const leaveSets = new Map()
    for (const x of leaveNodes) {
      const k = x.n.diary + ':' + x.rejoins
      let set = leaveSets.get(k)
      if (!set) {
        set = { diary: x.n.diary, rejoins: x.rejoins, leaves: [] }
        leaveSets.set(k, set)
      }
      set.leaves.push(x.n)
    }
    // The CWs C admits now: all of an open community, the creator's, and in
    // an approval community those the diary's admit layer or root grant
    // layer covers at their end (final state: a withdrawal hides the
    // diary's records in C's groups until a new admit; a leave withdraws
    // no admission, so it keeps the A1 rule).
    const admittedCws = new Set()
    for (const w of counted) {
      const d = writerDiary.get(w)
      // The current generation's admits; a retired CW keeps the admission
      // of its own generation (its earlier records follow the A1 rule).
      const layer = retired.has(w) ? admits.get(d) : admitsFrom(d, leaves.get(d) || 0)
      if (join === 'open' || d === owner || layerNow(layer, w) || layerNow(rootAdmin.get(d), w)) admittedCws.add(w)
    }
    // Per diary, the first leave of its latest leave set.
    // Per diary, in its latest leave set: the first confirmed leave
    // (`confirmedLeaveOf`, the leave a new device names on a rejoin), and the
    // first leave that bounds a G root's history (`currentLeaveOf`: confirmed,
    // or written on C's root).
    const currentLeaveOf = new Map()
    const confirmedLeaveOf = new Map()
    const latestSet = new Map()
    for (const set of leaveSets.values()) {
      if (!latestSet.has(set.diary) || set.rejoins > latestSet.get(set.diary).rejoins) latestSet.set(set.diary, set)
    }
    for (const [d, set] of latestSet) {
      const conf = set.leaves.find(isConfirmed)
      if (conf) confirmedLeaveOf.set(d, { writer: conf.writer, seq: conf.seq })
      const bound = set.leaves.find((x) => isConfirmed(x) || x.writer === G)
      if (bound) currentLeaveOf.set(d, { writer: bound.writer, seq: bound.seq })
    }
    // CWs C's ban layer covers now (an unban that did not list them): they
    // stay banned in every group of C.
    const bannedCws = new Set([...counted].filter((w) => layerNow(bans.get(writerDiary.get(w)), w)))
    state.community = {
      bannedCws,
      creatorConfirmedLeave: rootConfirmed,
      creatorConfirmSeq: confirmDseq,
      leaveOf: part.leaveOf,
      currentLeaveOf,
      admittedCws,
      logs,
      authorizedC,
      repairC,
      withdrawnC,
      retiredC: retired,
      retiredBy,
      leavesOf,
      rejoinOf: rejoinRef,
      cwDiary: writerDiary,
      counted,
      lastSeq: state.lastSeq,
      rootAdminC: rootAdmin,
      rawAdminC: rawAdmin,
      bansC: bans,
      removalsC: removals,
      leaveSetsC: [...leaveSets.values()].sort((a, b) => cmp(a.diary, b.diary) || a.rejoins - b.rejoins),
      everOn: new Map([...rootAdmin].map(([d, list]) => [d, list.some((e) => e.on)])),
      created,
      overflow,
      general,
      dropped
    }
    const result = {
      kind: 'community',
      name,
      join,
      creator: owner,
      admins,
      members,
      requests,
      bans: banRefs,
      leaves: leaveRefs,
      lastLeave: leaveRefsAll,
      // Whether a demotion C's creator writes on its CW (`group: null`)
      // counts now: the creating device's powers ended by diary-backed
      // evidence or by a leave on the root itself.
      cwDemote: owner !== null && (rootConfirmed || onRootBound),
      // Whether the creating device still has creator powers on C's root:
      // only the bound decides (owner decision, cycle 21), never the root's
      // held length, which a trailing invalid block would skew. Unlike
      // `authorityWriters`, liveness retirement by generation never ends
      // it.
      rootAuthority: owner !== null && rootCut === Infinity,
      // Finite exactly when a confirmed creator leave bounds C's root: the
      // lowest diary seq among their confirms. A group root mark the
      // creator's diary writes at or after it never counts.
      creatorConfirmSeq: confirmDseq,
      leaveOf: part.leaveOf,
      confirmedLeaveOf,
      // The leave set of each such leave: a rejoin names an own device's
      // leave only when it is of the diary's latest set.
      leaveSetOf: new Map([...part.leaveOf].map(([w, r]) => [w, part.setOfLeave.get(r.writer + ':' + r.seq)])),
      admittedCws,
      liveWriters,
      authorityWriters,
      last,
      writers: counted,
      groups: [...created.keys()].sort(cmp),
      general,
      created,
      // The groups a counted CW drop takes out now, sorted: the ones an
      // undo (`on: false`) would list again.
      dropped: [...dropped],
      memberInvite,
      incomplete: false
    }
    return { result, state }
  }

  const result = {
    kind: header.kind,
    name,
    join,
    visibility: header.visibility,
    creator,
    admins,
    // The parent community when it authorizes G (its gate), else null.
    community: null,
    orphan: false,
    members,
    posts,
    requests,
    future,
    last,
    bans: banRefs,
    leaves: leaveRefs,
    lastLeave: leaveRefsAll,
    liveWriters,
    authorityWriters,
    // The lowest cut the creator's diary marks on the root (`group-cut`),
    // or null: root records at or above it carry no authority.
    rootCut: gRootCut === Infinity ? null : gRootCut,
    // The writers the fold counted (root included when bound): a record in
    // any other core, even one bound by the diary, is not part of the group.
    writers: counted,
    memberInvite,
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
    // Without a parent community (missing, pending or orphan) nothing is
    // eligible: a loss of power with no record ("Eligibility" 4).
    const pick = ctx.C === null ? { epoch: null, rekeyPending: held.size > 0 } : chooseEpoch(plain.state, epochs, held, mine)
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
    const req = { members: [R], subject: R.record.member }
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
    for (const a of R.alts || [R]) pushTo(byRoot, a.writer, { seq: a.seq, last: a.last, req })
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
      for (const r of byRoot.get(b.writer) || []) if (b.seq >= r.seq && b.seq <= r.last) hits.push(r.req)
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
  return {
    kind: 'community',
    name: null,
    join: null,
    creator: null,
    admins: new Set(),
    members: new Map(),
    requests: [],
    bans: new Map(),
    leaves: new Map(),
    lastLeave: new Map(),
    cwDemote: false,
    rootAuthority: false,
    creatorConfirmSeq: Infinity,
    leaveOf: new Map(),
    leaveSetOf: new Map(),
    confirmedLeaveOf: new Map(),
    admittedCws: new Set(),
    liveWriters: new Set(),
    authorityWriters: new Set(),
    last: null,
    writers: new Set(),
    groups: [],
    general: null,
    created: new Map(),
    dropped: [],
    memberInvite: false,
    incomplete: true
  }
}

// Communities. A community C is the key of a root whose header kind is
// `community`; its creator's diary binds it as a group root is bound, and
// each member device writes one community writer (CW) whose header names C
// and no `member`. C folds like a group (binding, caps, rejoins, causal
// order, leave withdrawal, root admin grants with cuts over CWs, admit and
// ban with `group: null`, the shield) with no posts or keys, and keeps the
// catalogue of its groups: Geral, the root's first group-create, then every
// group-create an authorized node writes, at most MAX_GROUPS_PER_COMMUNITY.
// Admit, ban and hide records naming a group G are community authority
// inside G and change nothing in C.
//
// Input: { root: { key, entries }, writers: [{ key, entries, diary }],
// joins: Map diary -> [{ writer, on, seq }], now }, buildGroup's minus
// `community` and `keys`. Never throws.
function buildCommunity (input) {
  try {
    return foldCommunityState(input).result
  } catch {
    return emptyCommunity()
  }
}

// buildCommunity's result plus the fold's internal state for buildGroup
// (null when C is unbound or not a community): authorizedC(cw, seq),
// repairC(cw, seq), withdrawnC(cw, seq), retiredC, leavesOf, rejoinOf,
// cwDiary, counted, lastSeq, rootAdminC, bansC, everOn, created, overflow,
// general, dropped.
function foldCommunityState (input) {
  const bound = bindCores(input, true)
  if (bound === null) return { result: emptyCommunity(), state: null }
  const { ctx, kept, incomplete } = bound
  // An unbound root carries no authority and no catalogue, and its
  // header's diary is no member through it.
  if (!ctx.rootBound) return { result: { ...emptyCommunity(), name: ctx.header.name, join: ctx.header.join }, state: null }
  const { result, state } = foldCore(ctx, kept)
  result.incomplete = incomplete
  return { result, state: state.community }
}

module.exports = {
  MAX_FUTURE_MS,
  MAX_GROUP_WRITERS,
  MAX_GROUPS_PER_DIARY,
  MAX_GROUPS_PER_COMMUNITY,
  MAX_GROUP_CUTS,
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
  groupInvites,
  groupCreateRecord,
  communityAdmit,
  communityBan,
  communityDemote,
  communityMetaCw,
  communityDrop,
  communityHide,
  communityInvites,
  groupKey,
  groupSealed,
  sealedInner,
  groupJoins,
  groupJoinHistory,
  groupCutHistory,
  groupConfirmHistory,
  leaveDigest,
  orderKey,
  compareOrder,
  isFuture,
  buildGroup,
  buildCommunity
}
