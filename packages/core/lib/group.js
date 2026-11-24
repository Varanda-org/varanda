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
// leave's cut on it (the group's charter). The charter the creator's other
// devices write (the sibling charter) is withdrawn like any record of a
// non-root writer, so it never outlives the leave. Coming back takes a
// new writer whose header names that leave (`rejoin`): a fresh membership
// that orders after the leave, needs a new admit in approval groups and
// stays under any ban.
//
// Pure: b4a, ./records, ./group-crypto and ./group-media (sodium-universal,
// which loads in Node, Bare and the browser) only. The fold opens envelopes itself; the
// device's box secret stays with the caller, behind `keys.unseal`.

const b4a = require('b4a')
const sodium = require('sodium-universal')
const {
  MAX_TEXT, MAX_BLOCK_BYTES, MAX_GROUP_WRITERS, MAX_GROUPS_PER_DIARY,
  MAX_GROUPS_PER_COMMUNITY, MAX_GROUP_CUTS, MAX_GROUP_NAME, MAX_GROUP_ABOUT, MAX_GROUP_WRITERS_PER_DIARY,
  MAX_FROZEN_WRITERS_PER_DIARY, MAX_WRITER_RELEASES_PER_DIARY, MEDIA_BLOCK_BYTES,
  nowIso, isHex64, isCanonicalIso, isPlainObject, hasExactKeys, hasControlChars,
  charLength, plainCopy, validRecordCopyOfType, validDescriptor
} = require('./records')
const { openRecord, wipe, keyTag, keyCommit, MAX_KEY_RECIPIENTS, MAX_SEALED_INNER_BYTES } = require('./group-crypto')
const { validGroupMedia, copyGroupMedia, copyGroupItem, validPrivateItem } = require('./group-media')
const { validLinkCard, validCardImageBytes, copyLinkCard, CARD_IMAGE_MIME } = require('./link-card')
const { isReaction, GROUP_REACTIONS_MAX, isPoll, isPick, isEvent, event: eventRules } = require('@varanda/rpc')

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
  'group-image': ['type', 'image', 'seen', 'at'],
  'group-about': ['type', 'about', 'seen', 'at'],
  'group-admin': ['type', 'member', 'on', 'cuts', 'seen', 'at'],
  'group-leave': ['type', 'seen', 'cuts', 'at'],
  'group-create': ['type', 'group', 'seen', 'at'],
  'group-drop': ['type', 'group', 'on', 'seen', 'at'],
  'group-key': ['type', 'kid', 'basis', 'keys', 'auth', 'at'],
  'group-sealed': ['type', 'kid', 'nonce', 'box', 'at'],
  'group-invites': ['type', 'on', 'seen', 'at'],
  'group-react': ['type', 'target', 'emoji', 'seen', 'at'],
  'group-topic': ['type', 'target', 'seen', 'at'],
  'group-poll': ['type', 'target', 'options', 'seen', 'at'],
  'group-choice': ['type', 'target', 'pick', 'seen', 'at'],
  'group-event': ['type', 'target', 'title', 'start', 'end', 'place', 'seen', 'at']
}
// A post with media, a link card or a forward (docs/protocol.md section 10):
// the one other key set of group-post. A card goes with text only (media
// null). `fwd` is only 0 or 1, so a plain text post stays the v1 bytes and
// every post has one encoding; readers from before v2 skip the whole post.
const GROUP_POST_V2_KEYS = ['type', 'text', 'replyTo', 'media', 'card', 'fwd', 'seen', 'at']
const GROUP_TYPES = Object.freeze(Object.keys(RECORD_KEYS))
// A first `group-key` block (kid null) also commits to its key.
const FIRST_KEY_KEYS = ['type', 'kid', 'basis', 'keys', 'auth', 'commit', 'at']
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
// powers: the community's name, join, image and description (`group: null`),
// and dropping a group from the catalogue (`group-drop`, CW only).
const CW_META_KEYS = ['type', 'group', 'name', 'join', 'seen', 'at']
const CW_IMAGE_KEYS = ['type', 'group', 'image', 'seen', 'at']
const CW_ABOUT_KEYS = ['type', 'group', 'about', 'seen', 'at']
const GROUP_ONLY = new Set(['group-post', 'group-key', 'group-sealed', 'group-react', 'group-topic', 'group-poll', 'group-choice', 'group-event'])
const COMMUNITY_ONLY = new Set(['group-create', 'group-drop'])
// A private group carries these sealed, and only there.
const SEALED_TYPES = new Set(['group-post', 'group-hide', 'group-meta', 'group-react', 'group-image', 'group-about'])
const PRIVATE_TYPES = new Set(['group-key', 'group-sealed'])
// The charter a group's root writes, and since the sibling charter also the
// creator's other devices.
const CHARTER_TYPES = new Set(['group-meta', 'group-admin', 'group-image', 'group-about'])
// Foruns e enquetes and Eventos: side records of public groups only, never
// sealed, so a private group (plain or inside an envelope) refuses them.
const FORUM_TYPES = new Set(['group-topic', 'group-poll', 'group-choice', 'group-event'])
// Records that travel beside a core's records, never nodes of the causal
// order (splitReacts).
const SIDE_TYPES = new Set(['group-react', ...FORUM_TYPES])
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
// A full-size JPEG needs a ninth block for the MAC and pad mark (group-media).
const MAX_GROUP_IMAGE_SEALED_BLOCKS = Math.ceil((262144 + SECRETBOX_MAC_BYTES + 1) / MEDIA_BLOCK_BYTES)

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

// A description is one line: no line break (hasControlChars without LF) and
// no edge whitespace, so one text has one encoding.
function aboutReason (about) {
  if (typeof about !== 'string' || charLength(about) < 1 || charLength(about) > MAX_GROUP_ABOUT) return 'about-length'
  if (hasControlChars(about, false)) return 'control-chars'
  return about.trim() === about ? null : 'malformed'
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
  // there (C itself when that device created C), or neither when it stands
  // alone: one without the other is no shape a creator writes.
  if (h.kind === 'group' && !(isHex64(h.community) && isHex64(h.member)) && !(h.community === null && h.member === null)) return 'malformed'
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

// A link card's thumbnail in a group post: a still JPEG of one media block,
// a public descriptor in a plain post and a private item inside a sealed
// inner, never mixed and never an address on the web. Never throws.
function validGroupCardImage (d, sealed) {
  try {
    if (sealed === true) return validPrivateItem(d) && d.plainMime === CARD_IMAGE_MIME && validCardImageBytes(d.bytes)
    return validDescriptor(d) && d.mime === CARD_IMAGE_MIME && validCardImageBytes(d.bytes)
  } catch {
    return false
  }
}

function validGroupCard (card, sealed) {
  return validLinkCard(card, (d) => validGroupCardImage(d, sealed))
}

function checkRecord (record, seq, root, community, priv, sealed) {
  if (!Number.isSafeInteger(seq) || seq < 0) return 'malformed'
  if (seq === 0) return root ? checkHeader(record) : checkWriterHeader(record)
  if (!isPlainObject(record)) return 'malformed'
  const type = record.type
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(RECORD_KEYS, type)) return 'malformed'
  // A creator who returned demotes through its CW: a community core's
  // `group-admin` off a root carries `group` (null: C, else a group of C).
  const cwAdmin = type === 'group-admin' && community && !root
  const cwMeta = type === 'group-meta' && community && !root
  const cwImage = type === 'group-image' && community && !root
  const cwAbout = type === 'group-about' && community && !root
  // Root-shaped records in a CW stay root-only.
  if ((cwAdmin || cwMeta || cwImage || cwAbout) && hasExactKeys(record, RECORD_KEYS[type])) return 'root-only'
  const keys = type === 'group-key' && record.kid === null
    ? FIRST_KEY_KEYS
    : type === 'group-post' && hasExactKeys(record, GROUP_POST_V2_KEYS)
      ? GROUP_POST_V2_KEYS
      : cwAdmin ? CW_ADMIN_KEYS : cwMeta ? CW_META_KEYS : cwImage ? CW_IMAGE_KEYS : cwAbout ? CW_ABOUT_KEYS : community && Object.prototype.hasOwnProperty.call(COMMUNITY_KEYS, type) ? COMMUNITY_KEYS[type] : RECORD_KEYS[type]
  if (!hasExactKeys(record, keys)) return 'malformed'
  // Off the root the creator's other devices write the charter too (the fold
  // counts only theirs); on a CW, appointing an admin of a group stays the
  // root's.
  if (cwAdmin && record.on === true && record.group !== null) return 'root-only'
  if ((cwMeta || cwImage || cwAbout) && record.group !== null) return 'malformed'
  // A drop is a repair of the root's catalogue, never the root's own.
  if (community && type === 'group-drop' && root) return 'malformed'
  if (community && GROUP_ONLY.has(type)) return 'group-only'
  if (!community && COMMUNITY_ONLY.has(type)) return 'community-only'
  if ((priv || sealed) && FORUM_TYPES.has(type)) return 'public-only'
  if (priv && SEALED_TYPES.has(type)) return 'sealed-only'
  if (!priv && PRIVATE_TYPES.has(type)) return 'private-only'
  // Every writer record may name the newest node its author had seen (seq 0
  // names a rejoining writer's block 0), so it orders after a rejoin.
  if (Object.prototype.hasOwnProperty.call(record, 'seen') && record.seen !== null && !validRef(record.seen, 0)) return 'seen-invalid'
  if (type === 'group-post') {
    const { text } = record
    // Media items are private (secretbox ciphertext, key included) inside a
    // sealed inner and public everywhere else, never mixed.
    const v2 = keys === GROUP_POST_V2_KEYS
    // A boolean is another JSON type, so it must not count as forwarded.
    if (v2 && record.fwd !== 0 && record.fwd !== 1) return 'malformed'
    if (v2 && record.card !== null && (record.media !== null || !validGroupCard(record.card, sealed))) return 'card-invalid'
    // Null media is a card or the text forward. With neither it is a second encoding of v1.
    if (v2 && !(record.media === null && (record.fwd === 1 || record.card !== null)) && !validGroupMedia(record.media, sealed)) return 'media-invalid'
    // Empty text is a photo with no caption, not a text-only forward.
    const minText = v2 && record.media !== null ? 0 : 1
    if (typeof text !== 'string' || charLength(text) < minText || charLength(text) > MAX_TEXT) return 'text-length'
    if (hasControlChars(text, true)) return 'control-chars'
    if (record.replyTo !== null && !validRef(record.replyTo, 1)) return 'reply-invalid'
  } else if (type === 'group-react') {
    // One emoji, or the empty string that takes the reaction back.
    if (!validRef(record.target, 1)) return 'malformed'
    if (record.emoji !== '' && !isReaction(record.emoji)) return 'emoji-invalid'
  } else if (type === 'group-topic') {
    // Marks the target as a topic root; the fold decides whether it counts.
    if (!validRef(record.target, 1)) return 'malformed'
  } else if (type === 'group-poll') {
    if (!validRef(record.target, 1)) return 'malformed'
    if (!isPoll(record.options)) return 'poll-invalid'
  } else if (type === 'group-choice') {
    // One option index, or null that takes the vote back.
    if (!validRef(record.target, 1)) return 'malformed'
    if (!isPick(record.pick)) return 'pick-invalid'
  } else if (type === 'group-event') {
    // The event of the root post `target`: the rules of @varanda/rpc lib/event.js.
    if (!validRef(record.target, 1)) return 'malformed'
    if (!isEvent({ title: record.title, start: record.start, end: record.end, place: record.place })) return 'event-invalid'
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
  } else if (type === 'group-image') {
    const d = record.image
    if (d !== null) {
      const valid = sealed === true
        ? validPrivateItem(d) && d.plainMime === 'image/jpeg' && d.w === 512 && d.h === 512 && d.blocks <= MAX_GROUP_IMAGE_SEALED_BLOCKS
        : validDescriptor(d) && d.mime === 'image/jpeg' && d.width === 512 && d.height === 512 && d.blocks <= 8 && d.bytes <= 262144
      if (!valid) return 'image-invalid'
    }
  } else if (type === 'group-about') {
    if (record.about !== null) {
      const reason = aboutReason(record.about)
      if (reason) return reason
    }
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

// The only standalone predicate: a valid root of kind group that names no
// community. A group whose parent is missing or unresolved is never one.
function isStandaloneHeader (header) {
  try {
    return checkHeader(header) === null && header.kind === 'group' && header.community === null && header.member === null
  } catch {
    return false
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
// travel only sealed there, and keys and envelopes only there. `sealed`
// marks the inner record of an envelope: only there a post's media is
// private.
function validateGroupRecord (record, seq, { root = false, community = false, private: priv = false, sealed = false } = {}) {
  try {
    return checkRecord(record, seq, root === true, community === true, priv === true, sealed === true)
  } catch {
    return 'malformed'
  }
}

function build (record, seq, root, community = false, priv = false, sealed = false) {
  const reason = validateGroupRecord(record, seq, { root, community, private: priv, sealed })
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

// No media, no card and no forward mark: the v1 record, byte for byte, so
// older readers still open a plain text post. `fwd` defaults to 0. `sealed`
// builds the inner record of an envelope, whose media items and card image
// are private.
function groupPost ({ text, replyTo = null, media = null, card = null, fwd = 0, seen = null, at = nowIso(), sealed = false } = {}) {
  if ((media === null || media === undefined) && (card === null || card === undefined) && fwd === 0) {
    return build({ type: 'group-post', text, replyTo: copyRef(replyTo), seen: copyRef(seen), at }, 1, false)
  }
  const record = {
    type: 'group-post',
    text,
    replyTo: copyRef(replyTo),
    media: media === undefined ? null : copyGroupMedia(media, sealed),
    card: card === undefined || card === null ? null : copyLinkCard(card, (d) => copyGroupItem(d, sealed)),
    fwd,
    seen: copyRef(seen),
    at
  }
  return build(record, 1, false, false, false, sealed === true)
}

function groupHide ({ target, on, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-hide', target: copyRef(target), on, seen: copyRef(seen), at }, 1, false)
}

// A reaction to the group-post `target`; emoji '' removes it.
function groupReact ({ target, emoji, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-react', target: copyRef(target), emoji, seen: copyRef(seen), at }, 1, false)
}

// Marks the own root post `target` as a forum topic (public groups only).
function groupTopic ({ target, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-topic', target: copyRef(target), seen: copyRef(seen), at }, 1, false)
}

// The poll of the topic root `target`: POLL_MIN..POLL_MAX option texts.
function groupPoll ({ target, options, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-poll', target: copyRef(target), options: Array.isArray(options) ? options.slice() : options, seen: copyRef(seen), at }, 1, false)
}

// A vote on the poll of the topic root `target`; pick null withdraws it.
function groupChoice ({ target, pick, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-choice', target: copyRef(target), pick, seen: copyRef(seen), at }, 1, false)
}

// The event of the root post `target` (a title, a start, an end or null and a
// place); RSVPs are group-choice votes on it: 0 going, 1 maybe.
function groupEvent ({ target, title, start, end = null, place = '', seen = null, at = nowIso() } = {}) {
  const e = eventRules.copyEvent({ title, start, end, place })
  return build({ type: 'group-event', target: copyRef(target), title: e.title, start: e.start, end: e.end, place: e.place, seen: copyRef(seen), at }, 1, false)
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

// `sealed: true` builds the inner of a private group's envelope, which takes
// a private item instead of the public descriptor.
function groupImage ({ image, seen = null, at = nowIso(), sealed = false } = {}) {
  return build({ type: 'group-image', image: image === null ? null : { ...image }, seen: copyRef(seen), at }, 1, true, false, false, sealed === true)
}

// `sealed: true` builds the inner of a private group's envelope.
function groupAbout ({ about, seen = null, at = nowIso(), sealed = false } = {}) {
  return build({ type: 'group-about', about, seen: copyRef(seen), at }, 1, true, false, false, sealed === true)
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
  // The same shape in C's root and on the creator's CWs.
  return build({ type: 'group-create', group, seen: copyRef(seen), at }, 1, true, true)
}

// A returning creator's community name and join, written on its CW.
function communityMetaCw ({ name, join, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-meta', group: null, name, join, seen: copyRef(seen), at }, 1, false, true)
}

function communityImageCw ({ image, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-image', group: null, image: image === null ? null : { ...image }, seen: copyRef(seen), at }, 1, false, true)
}

function communityAboutCw ({ about, seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-about', group: null, about, seen: copyRef(seen), at }, 1, false, true)
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

// An appointment of a C admin the creator writes on one of its CWs.
function communityGrant ({ member, cuts = [], seen = null, at = nowIso() } = {}) {
  return build({ type: 'group-admin', group: null, member, on: true, cuts: copyCuts(cuts), seen: copyRef(seen), at }, 1, false, true)
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
      const copy = validRecordCopyOfType(record, seq, 'group-join')
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
      const copy = validRecordCopyOfType(record, seq, 'group-confirm')
      if (copy === null || copy.type !== 'group-confirm' || copy.group !== group) return
      out.push({ writer: copy.writer, seq: copy.seq, digest: copy.digest, dseq: seq })
    })
  } catch {}
  return out
}

// A diary's `group-cut` marks for `group` as { writer, cut, seq, at }, plus
// { gap: true } when the entries skip a seq (a history read with a hole may
// miss a mark). A deleted block this replica never read is no gap: only
// blocks read count, so every replica holding the same blocks agrees
// (docs/protocol.md "Deletion").
function groupCutHistory (entries, group) {
  const out = []
  let next = 0
  let gap = false
  try {
    eachEntry(entries, (seq, record) => {
      if (seq !== next) gap = true
      next = seq + 1
      const copy = validRecordCopyOfType(record, seq, 'group-cut')
      if (copy === null || copy.type !== 'group-cut' || copy.group !== group) return
      out.push({ writer: copy.writer, cut: copy.cut, seq, at: copy.at })
    })
  } catch {
    gap = true
  }
  if (gap) out.push({ gap: true })
  return out
}

// The diaries' marks (groupCutHistory items) as diary -> Map writer ->
// lowest cut, plus the diaries whose history as read has a hole. A gap cuts
// nothing here: unlike the creator's root rule, a hole only delays a mark on
// another writer until it fills, and treating it as a cut would let any hole
// silence every device of the diary.
function cutTable (marks) {
  const cuts = new Map()
  const gaps = new Set()
  if (!(marks instanceof Map)) return { cuts, gaps }
  for (const [d, list] of marks) {
    if (!Array.isArray(list)) continue
    let m = cuts.get(d)
    for (const x of list) {
      try {
        if (!isPlainObject(x)) continue
        if (x.gap === true) {
          gaps.add(d)
          continue
        }
        const w = x.writer
        const c = x.cut
        if (!isHex64(w) || !Number.isSafeInteger(c) || c < 0) continue
        if (!m) {
          m = new Map()
          cuts.set(d, m)
        }
        if (!m.has(w) || c < m.get(w)) m.set(w, c)
      } catch {}
    }
  }
  return { cuts, gaps }
}

// The slot walk (#350, design B with A): which writers one diary counts in
// root G, from its own group-join and group-cut records for G in diary seq
// order only, so the fold of every reader and the seeder agree, and every
// decision depends on earlier records alone (a prefix of the diary never
// disagrees with the whole diary on the entries it holds). Per writer the
// state goes one way: none, live, frozen, released.
// - An on:true join of a writer in state none takes a live slot while fewer
//   than MAX_GROUP_WRITERS_PER_DIARY are live (one less from the diary's
//   first on:true join of the root key itself: the root always counts and
//   never walks); with no room it never counts, even if a slot frees later.
//   Repeated and on:false joins change no slot.
// - A cut on a live or frozen writer lowers its cut (the lowest wins, and it
//   always applies to its records). Cut 0 releases it while fewer than
//   MAX_WRITER_RELEASES_PER_DIARY were released; a cut >= 1 freezes a live
//   writer while fewer than MAX_FROZEN_WRITERS_PER_DIARY are frozen; with no
//   room the writer keeps its state and its slot.
// - A cut on a writer in state none or released, and every mark on the root,
//   is ignored.
// Counted writers are the live and frozen ones.
function slotWalkState () {
  return {
    live: 0,
    frozen: 0,
    released: 0,
    rootSlot: false,
    // The last seq stepped: a caller feeding a log in order (the seeder's
    // scan) skips what it already stepped.
    last: -1,
    state: new Map(),
    cut: new Map(),
    first: new Map(),
    over: new Set()
  }
}

// One event of the walk, in diary seq order: { kind: 'join', writer, on,
// seq } or { kind: 'cut', writer, cut, seq }.
function slotWalkStep (s, e, G) {
  if (Number.isSafeInteger(e.seq)) s.last = Math.max(s.last, e.seq)
  const w = e.writer
  if (e.kind === 'join') {
    if (e.on !== true) return
    if (w === G) {
      s.rootSlot = true
      return
    }
    if (s.state.has(w) || s.over.has(w)) return
    if (s.live < MAX_GROUP_WRITERS_PER_DIARY - (s.rootSlot ? 1 : 0)) {
      s.state.set(w, 'live')
      s.first.set(w, e.seq)
      s.live++
    } else {
      s.over.add(w)
    }
    return
  }
  if (w === G) return
  const st = s.state.get(w)
  if (st !== 'live' && st !== 'frozen') return
  const prev = s.cut.has(w) ? s.cut.get(w) : Infinity
  s.cut.set(w, Math.min(prev, e.cut))
  if (e.cut === 0) {
    if (s.released >= MAX_WRITER_RELEASES_PER_DIARY) return
    s.state.set(w, 'released')
    if (st === 'live') s.live--
    else s.frozen--
    s.released++
    return
  }
  if (st === 'live' && s.frozen < MAX_FROZEN_WRITERS_PER_DIARY) {
    s.state.set(w, 'frozen')
    s.live--
    s.frozen++
  }
}

// The walk events of one diary for G from its join history (groupJoinHistory
// items) and its marks (groupCutHistory items), sorted so any order of the
// input lists gives the same walk. A join with no valid seq sorts last, as
// the per-diary cap always ranked it; a mark with none cannot be placed and
// is skipped. `gap`: the marks report a hole in the diary as read.
function slotEvents (joins, marks) {
  const events = []
  let gap = false
  if (Array.isArray(joins)) {
    for (let i = 0; i < joins.length; i++) {
      const j = plainCopy(joins[i])
      if (j === null || typeof j.on !== 'boolean' || !isHex64(j.writer)) continue
      const seq = Number.isSafeInteger(j.seq) && j.seq >= 0 ? j.seq : Infinity
      events.push({ kind: 'join', writer: j.writer, on: j.on, seq, cut: 0 })
    }
  }
  if (Array.isArray(marks)) {
    for (let i = 0; i < marks.length; i++) {
      const m = plainCopy(marks[i])
      if (m === null) continue
      if (m.gap === true) {
        gap = true
        continue
      }
      if (!isHex64(m.writer) || !Number.isSafeInteger(m.cut) || m.cut < 0 || !Number.isSafeInteger(m.seq) || m.seq < 0) continue
      events.push({ kind: 'cut', writer: m.writer, on: false, seq: m.seq, cut: m.cut })
    }
  }
  events.sort(slotEventOrder)
  return { events, gap }
}

// A diary has one record per seq; ties only come from malformed input and
// still sort one way: joins first (on before off), then writer, then cut.
function slotEventOrder (a, b) {
  return (a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1) ||
    (a.kind === b.kind ? 0 : a.kind === 'join' ? -1 : 1) ||
    (a.on === b.on ? 0 : a.on ? -1 : 1) ||
    cmp(a.writer, b.writer) || a.cut - b.cut
}

// The cut a diary marks on an own writer of a private group it replaces, so
// the slot walk gives its slot back to the new writer. A boxless header is
// header-invalid there, so nothing of the writer ever counts: 0, whatever it
// holds. A writer boxed to another key is cut like any retired writer
// (retiredWriterCut). null when block 0 is not held.
function replacedWriterCut (entries) {
  const held = heldWriterRecords(entries)
  if (held === null) return null
  if (held.head.box === null || held.head.box === undefined) return 0
  return retiredWriterCut(entries)
}

// The cut a diary marks on its own writer when a join replaces it (retired
// by a leave, or naming a CW the gate retired), so the slot walk frees its
// live slot for the new writer while no record it holds stops counting: 0
// for a header with no rejoin, 1 for a header with a rejoin (the generation
// reads its block 0), else the length held (the device holds its own core
// whole). `entries` are the writer's records as held ({ seq, record }).
// null when block 0 is not held.
function retiredWriterCut (entries) {
  const held = heldWriterRecords(entries)
  if (held === null) return null
  if (held.last > 0) return held.last + 1
  return held.head.rejoin ? 1 : 0
}

function heldWriterRecords (entries) {
  if (!Array.isArray(entries)) return null
  let head = null
  let last = -1
  for (const e of entries) {
    if (!e || !Number.isSafeInteger(e.seq) || e.seq < 0) continue
    if (e.seq === 0) head = e.record
    if (e.seq > last) last = e.seq
  }
  return isPlainObject(head) ? { head, last } : null
}

// The walk of one diary for G (see slotWalkState): { live, frozen,
// released } as sets of writers, `cut` (writer -> lowest cut, for the
// writers a cut applied to), `first` (writer -> seq of the join that gave
// its slot), `rootSlot`, `gap` and `bound` (some on:true join for G, the
// root's included). Never throws.
function slotWalk (joins, marks, G) {
  const s = slotWalkState()
  let gap = false
  let bound = false
  try {
    const got = slotEvents(joins, marks)
    gap = got.gap
    for (const e of got.events) {
      if (e.kind === 'join' && e.on) bound = true
      slotWalkStep(s, e, G)
    }
  } catch {}
  return slotWalkResult(s, gap, bound)
}

// Whether a new writer the diary joins to G now takes a live slot in its
// walk, after the events the caller writes first (`extra`, in order:
// { kind: 'join', writer, on } or { kind: 'cut', writer, cut }), so a node
// refuses a join the walk would never count before it writes anything.
// `joins` and `marks`: the diary's groupJoinHistory and groupCutHistory
// items for G. Never throws (false on bad input).
function walkHasRoom (joins, marks, G, extra = []) {
  try {
    const s = slotWalkState()
    for (const e of slotEvents(joins, marks).events) slotWalkStep(s, e, G)
    let seq = s.last
    for (const e of extra) slotWalkStep(s, { ...e, seq: ++seq }, G)
    return s.live < MAX_GROUP_WRITERS_PER_DIARY - (s.rootSlot ? 1 : 0)
  } catch {
    return false
  }
}

// The cut a diary's slot walk for G gives its writer W, as a seeder keeps W
// (seeder.js groupWalkCut): 0 once released, its lowest cut while counted,
// null with none. `entries`: the diary's records as read ({ seq, record }).
// Never throws.
function diaryWriterCut (entries, G, W) {
  try {
    return walkWriterCut(slotWalk(groupJoinHistory(entries, G), groupCutHistory(entries, G), G), W)
  } catch {}
  return null
}

function walkWriterCut (w, W) {
  if (w.released.has(W)) return 0
  if ((w.live.has(W) || w.frozen.has(W)) && w.cut.has(W)) return w.cut.get(W)
  return null
}

// What diaryWriterCut reads of a diary's records: its group-join and
// group-cut records. A node keeps these per diary length (walkRecordsCut)
// instead of every record. Never throws.
function diaryWalkRecords (entries) {
  const kept = []
  try {
    eachEntry(entries, (seq, record) => {
      if (validRecordCopyOfType(record, seq, 'group-join') !== null || validRecordCopyOfType(record, seq, 'group-cut') !== null) kept.push({ seq, record })
    })
  } catch {}
  return { entries: kept, walks: new Map() }
}

// diaryWriterCut(entries, G, W) over diaryWalkRecords(entries): the same
// cut, each group's walk stepped once. The seqs the kept records skip give
// a gap mark, which changes no cut. Never throws.
function walkRecordsCut (records, G, W) {
  try {
    let w = records.walks.get(G)
    if (w === undefined) {
      w = slotWalk(groupJoinHistory(records.entries, G), groupCutHistory(records.entries, G), G)
      records.walks.set(G, w)
    }
    return walkWriterCut(w, W)
  } catch {}
  return null
}

// The header stubs a node hands buildGroup or buildCommunity (`heads`,
// bindCores): block 0 of each held core some diary in `joins` (Map diary ->
// groupJoinHistory) bound on, when that diary is not the one its header
// names. `firsts`: Map key -> { entry, diary }, `entry` the core's block 0
// as held and `diary` the one a writer header for this root names, else
// null. Never throws.
function headerStubs (joins, firsts) {
  const out = []
  try {
    const binders = new Map()
    for (const [d, list] of joins) {
      for (const j of list) {
        if (j.on !== true) continue
        if (!binders.has(j.writer)) binders.set(j.writer, new Set())
        binders.get(j.writer).add(d)
      }
    }
    for (const [key, f] of firsts) {
      const ds = binders.get(key)
      if (ds !== undefined && (ds.size > 1 || !ds.has(f.diary))) out.push({ key, entries: [f.entry] })
    }
  } catch {}
  return out
}

function slotWalkResult (s, gap = false, bound = false) {
  const live = new Set()
  const frozen = new Set()
  const released = new Set()
  for (const [w, st] of s.state) (st === 'live' ? live : st === 'frozen' ? frozen : released).add(w)
  return { live, frozen, released, over: new Set(s.over), cut: new Map(s.cut), first: new Map(s.first), rootSlot: s.rootSlot, gap, bound }
}

function groupJoinHistory (entries, group) {
  const out = []
  try {
    eachEntry(entries, (seq, record) => {
      const copy = validRecordCopyOfType(record, seq, 'group-join')
      if (copy === null || copy.type !== 'group-join' || copy.group !== group) return
      out.push({ writer: copy.writer, on: copy.on, seq, rejoin: copy.rejoin === undefined ? null : copy.rejoin })
    })
  } catch {}
  return out.sort((a, b) => a.seq - b.seq || cmp(a.writer, b.writer))
}

// The roots a diary binds now, chosen like the seeder's liveGroupJoins (the
// first MAX_GROUPS_PER_DIARY groups by live join seq, among the writers the
// slot walk counts per group), so a second device of the same account opens
// exactly the roots the seeders keep. Never throws.
function diaryGroupKeys (entries, max = MAX_GROUPS_PER_DIARY) {
  try {
    if (!Array.isArray(entries)) return []
    // group -> the walk's events: a later leave does not free the writer's
    // slot, only a diary cut does. The events are built from the validated
    // copies and stepped as they are, so the walk copies no record twice.
    const events = new Map()
    eachEntry(entries, (seq, record) => {
      const copy = validRecordCopyOfType(record, seq, 'group-join') || validRecordCopyOfType(record, seq, 'group-cut')
      if (copy === null) return
      let ev = events.get(copy.group)
      if (ev === undefined) {
        ev = []
        events.set(copy.group, ev)
      }
      if (copy.type === 'group-join') ev.push({ kind: 'join', writer: copy.writer, on: copy.on, seq, cut: 0 })
      else ev.push({ kind: 'cut', writer: copy.writer, on: false, seq, cut: copy.cut })
    })
    const allowed = new Set()
    for (const [group, ev] of events) {
      const s = slotWalkState()
      for (const e of ev.sort(slotEventOrder)) slotWalkStep(s, e, group)
      const wk = slotWalkResult(s)
      // The root's own key always takes one slot.
      if (wk.rootSlot) allowed.add(group + ':' + group)
      for (const writer of [...wk.live, ...wk.frozen]) allowed.add(group + ':' + writer)
    }
    const live = [...groupJoins(entries).values()].sort((a, b) => a.seq - b.seq)
    const groups = new Set()
    const out = []
    for (const j of live) {
      if (!allowed.has(j.group + ':' + j.writer)) continue
      if (groups.has(j.group)) continue
      if (groups.size >= max) continue
      groups.add(j.group)
      out.push(j.group)
    }
    return out
  } catch {
    return []
  }
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

// A reader from before group-react drops such a block as malformed, and a
// ref naming it resolves to the nearest lower record of its writer. So that
// every other record orders and folds exactly as there, reactions travel
// beside a core's records and never become nodes of the causal order. So do
// the forum side records (group-topic, group-poll, group-choice), for the
// same reason: an old reader sees the topic as a plain chat post.
function splitReacts (records) {
  const reacts = records.filter((x) => SIDE_TYPES.has(x.record.type))
  // Images and descriptions have no reaction target and also apply to
  // communities.
  const images = records.filter((x) => x.record.type === 'group-image')
  const abouts = records.filter((x) => x.record.type === 'group-about')
  const side = reacts.length > 0 || images.length > 0 || abouts.length > 0
  return { records: side ? records.filter((x) => !SIDE_TYPES.has(x.record.type) && x.record.type !== 'group-image' && x.record.type !== 'group-about') : records, reacts, images, abouts }
}

// Lengths and cuts address core blocks, including non-causal side records.
function lastCoreSeq (log) {
  let last = 0
  for (const records of [log.records, log.reacts, log.images, log.abouts]) {
    if (records && records.length) last = Math.max(last, records[records.length - 1].seq)
  }
  return last
}

// Foruns e enquetes and Eventos, from the side records foldCore judged
// eligible (marks: group-topic, group-poll and group-event by the root's own
// diary on a root post; choices: group-choice of a member now on a shown post).
//   - A root post is a topic when its author's diary marked it (any of its
//     cores). It gets `topic: { poll }`, and it and every post whose replyTo
//     chain reaches it get `thread: { writer, seq }` of the root.
//   - Its poll is the group-poll with the lowest seq on the root's own writer
//     core, after the root: an append-only core cannot put a later poll in
//     front of the votes, nor can another device of the author. Future-dated
//     polls (isFuture) are candidates too: when the lowest seq is one, the
//     topic has no poll until its date (never a higher seq meanwhile), so a
//     poll written ahead cannot later swap the options under the votes. The
//     votes are on the topic, so while poll is null they show no totals.
//   - An event is the group-event with the lowest seq on the root's own writer
//     core, after the root, by the same rule (any root, topic or not; a
//     future-dated one holds the root eventless until its date). A root
//     carries a poll or an event, never both: the lowest seq of the two
//     decides and the other is ignored for good. The event is
//     `event: { writer, seq, title, start, end, place, totals, by }` with
//     totals/by in [going, maybe] order, from votes of pick 0 and 1 (a higher
//     pick is ignored like an out-of-range poll pick).
//   - Votes fold like reactions: one per member diary, on one writer core the
//     higher seq, across its cores the later `at`, then writer, then seq. A
//     pick outside the poll's options is ignored (the earlier pick stays) and
//     null withdraws. poll = { writer, seq, options, totals, by }, by[i] the
//     diaries on option i in vote order (totals[i] === by[i].length).
// Posts with none of this keep their exact keys.
function foldTopics (posts, postById, marks, choices) {
  const topics = new Map()
  for (const { n, id, post } of marks) if (n.record.type === 'group-topic' && !topics.has(id)) topics.set(id, { post, poll: null })
  // The one poll or event of a root: the lowest seq of either kind (a poll
  // only on a topic) on the root's own core, after the root.
  const first = new Map()
  for (const { n, id, post, future } of marks) {
    const r = n.record
    if (r.type !== 'group-poll' && r.type !== 'group-event') continue
    if (n.writer !== post.writer || n.seq <= post.seq) continue
    const had = first.get(id)
    if (had === undefined || n.seq < had.n.seq) first.set(id, { n, post, future })
  }
  const events = new Map()
  for (const [id, { n, post, future }] of first) {
    if (future) continue
    const r = n.record
    if (r.type === 'group-poll') {
      // A poll is shown only on a topic, but it decides against an event
      // whether or not the topic mark exists yet: a later mark must never
      // turn the RSVPs of an event into votes of a poll.
      const t = topics.get(id)
      if (t !== undefined) t.poll = { writer: n.writer, seq: n.seq, options: r.options }
    } else events.set(id, { post, writer: n.writer, seq: n.seq, title: r.title, start: r.start, end: r.end, place: r.place })
  }
  if (topics.size === 0 && events.size === 0) return
  // The options a vote may pick on a root: a poll's, or going and maybe.
  const slots = (id) => {
    const t = topics.get(id)
    if (t !== undefined && t.poll !== null) return t.poll.options.length
    return events.has(id) ? 2 : 0
  }
  const latestOn = new Map()
  for (const { n, id, d } of choices) {
    const r = n.record
    const count = slots(id)
    if (count === 0 || (r.pick !== null && r.pick >= count)) continue
    const k = id + ':' + n.writer
    const had = latestOn.get(k)
    if (had === undefined || had.seq < n.seq) latestOn.set(k, { id, d, seq: n.seq, pick: r.pick, key: orderKey(r.at, n.writer, n.seq) })
  }
  const winners = new Map()
  for (const x of latestOn.values()) {
    const k = x.id + ':' + x.d
    const had = winners.get(k)
    if (had === undefined || compareOrder(had.key, x.key) < 0) winners.set(k, x)
  }
  const votes = new Map()
  for (const x of [...winners.values()].sort((a, b) => compareOrder(a.key, b.key))) {
    if (x.pick !== null) pushTo(votes, x.id, x)
  }
  for (const [id, t] of topics) {
    let poll = null
    if (t.poll !== null) {
      const by = t.poll.options.map(() => [])
      for (const x of votes.get(id) || []) by[x.pick].push(x.d)
      poll = { writer: t.poll.writer, seq: t.poll.seq, options: t.poll.options.slice(), totals: by.map((l) => l.length), by }
    }
    t.post.topic = { poll }
  }
  for (const [id, e] of events) {
    const by = [[], []]
    for (const x of votes.get(id) || []) by[x.pick].push(x.d)
    e.post.event = { writer: e.writer, seq: e.seq, title: e.title, start: e.start, end: e.end, place: e.place, totals: by.map((l) => l.length), by }
  }
  // The thread of every post: the top of its replyTo chain, once per post.
  const top = new Map()
  for (const p of posts) {
    const path = []
    let cur = p
    let found = null
    const seen = new Set()
    while (cur !== undefined) {
      const id = cur.writer + ':' + cur.seq
      if (top.has(id)) {
        found = top.get(id)
        break
      }
      if (seen.has(id)) break
      seen.add(id)
      path.push(id)
      if (cur.replyTo === null) {
        found = topics.has(id) ? id : null
        break
      }
      cur = postById.get(cur.replyTo.writer + ':' + cur.replyTo.seq)
    }
    for (const id of path) top.set(id, found)
    if (found !== null) {
      const root = topics.get(found).post
      p.thread = { writer: root.writer, seq: root.seq }
    }
  }
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

// The record each charter field's value comes from now, as `{ writer, seq }`
// or null (`admin`: per member hex): the `seen` a creator device's next
// record of that field names (protocol section 10, writer contract).
function emptyCharterTop () {
  return { meta: null, image: null, about: null, admin: new Map() }
}

function emptyGroup () {
  return {
    rootCut: null,
    kind: null,
    name: null,
    image: null,
    imageAuthor: null,
    about: null,
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
    charterWriters: new Set(),
    charterTop: emptyCharterTop(),
    cuts: new Map(),
    cutUnknown: new Set(),
    frozen: new Set(),
    released: new Set(),
    slots: new Map(),
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
// writer from `unlisted` (0, or Infinity for an event that skips them). A
// positive admit or grant may also carry `auto`, the cuts the fold derives
// for the diary's new devices it does not list (autoAdmit); a side record
// (`side`) of such a writer counts from seq 1, as under an admit listing it
// with cut 1. The state of (writer, seq) is the one of the last event, from
// index `from`, whose cut is at or below seq.
function layerAt (events, writer, seq, from = 0, side = false) {
  if (!events) return false
  for (let i = events.length - 1; i >= from; i--) {
    const e = events[i]
    let c = e.cuts.get(writer)
    if (c === undefined) c = e.auto && e.auto.has(writer) ? (side ? 1 : e.auto.get(writer)) : e.unlisted
    if (c <= seq) return e.on
  }
  return false
}

// The state a layer gives a writer's next records: from its cut on when an
// event lists it, otherwise only through an event that covers unlisted
// writers.
function layerNow (events, writer) {
  return layerAt(events, writer, Number.MAX_SAFE_INTEGER)
}

// A grant or admit layer read with its historical cover (`hist`, autoCover)
// in place of the strict `auto`: what a listed writer keeps after its CW
// retires.
function withHist (events) {
  return events ? events.map((e) => e.hist ? { ...e, auto: e.hist } : e) : events
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

// The blocks a writer's cut keeps from the cut on.
function keptPastCut (record) {
  return record.type === 'group-leave' || record.type === 'group-key'
}

// How many blocks from 0 on some copy of a core holds, valid or not.
function heldPrefix (copies) {
  const held = new Set()
  for (const x of copies) for (const seq of x.log.raw.keys()) held.add(seq)
  let n = 0
  while (held.has(n)) n++
  return n
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
  } else if (t === 'group-hide' || t === 'group-react') {
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
function checkRejoins (candidates, rootEntry, voided = new Set()) {
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
      const last = lastCoreSeq(target)
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
    // rejected itself), or one its diary's slot walk refused for good, is
    // invalid; naming an unknown writer or record is not known yet.
    if ((candidates.has(c.rejoin.writer) || voided.has(c.diary + ':' + c.rejoin.writer)) && !valid.has(c.rejoin.writer)) rejected.add(c.key)
  }
  return { valid, rejected }
}

// Bound pairs, and per pair the rejoin its earliest on:true join names (null
// when none or malformed).
function readJoins (joins) {
  const bound = new Set()
  const joinSeq = new Map()
  const joinRejoin = new Map()
  if (!(joins instanceof Map)) return { bound, joinRejoin }
  for (const [diary, list] of joins) {
    if (!isHex64(diary) || !Array.isArray(list)) continue
    for (let i = 0; i < list.length; i++) {
      const j = plainCopy(list[i])
      if (j === null || j.on !== true || !isHex64(j.writer)) continue
      const pair = diary + ':' + j.writer
      const seq = Number.isSafeInteger(j.seq) && j.seq >= 0 ? j.seq : Infinity
      bound.add(pair)
      if (!joinSeq.has(pair) || seq < joinSeq.get(pair)) {
        joinSeq.set(pair, seq)
        joinRejoin.set(pair, validRef(j.rejoin, 1) ? copyRef(j.rejoin) : null)
      }
    }
  }
  return { bound, joinRejoin }
}

// The slot walk (slotWalk) of every diary in `joins` for root G, with its
// marks: a diary binding hundreds of writers must not push others out of
// the group cap, and only its own cuts give a slot back.
function diaryWalks (joins, marks, G) {
  const out = new Map()
  if (!(joins instanceof Map)) return out
  for (const [d, list] of joins) {
    if (!isHex64(d) || !Array.isArray(list)) continue
    const own = marks instanceof Map ? marks.get(d) : undefined
    out.set(d, slotWalk(list, own, G))
  }
  return out
}

// Per `diary:writer` pair a walk counts or released: { cut (Infinity when
// none), frozen, released }; a released writer gave its slot back but its
// block 0, leaves and key blocks still count (cut 0). `voided`: the pairs a
// walk refused for good (a join past the cap).
function walkSlots (walks) {
  const slot = new Map()
  const voided = new Set()
  for (const [d, wk] of walks) {
    for (const w of wk.live) slot.set(d + ':' + w, { cut: wk.cut.has(w) ? wk.cut.get(w) : Infinity, frozen: false, released: false })
    for (const w of wk.frozen) slot.set(d + ':' + w, { cut: wk.cut.get(w), frozen: true, released: false })
    for (const w of wk.released) slot.set(d + ':' + w, { cut: 0, frozen: true, released: true })
    for (const w of wk.over) voided.add(d + ':' + w)
  }
  return { slot, voided }
}

// One result row per diary of the walks: how many writers it holds live and
// frozen and how many it released in this root (nodes derive the room left).
function walkCounts (walks) {
  const out = new Map()
  for (const [d, wk] of walks) {
    if (!wk.bound) continue
    out.set(d, { live: wk.live.size, frozen: wk.frozen.size, released: wk.released.size })
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
// withdrawn when unlisted; from L at the latest when L is in the root). The
// charter the creator's other devices wrote gets no such exception: a leave
// withdraws it whole, and a group root left unlisted by a leave on another
// device keeps nothing either.
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
// (Map diary -> [{ writer, on, seq }], groupJoinHistory), `heads` (header
// stubs: { key, entries } whose block 0 alone is read, bindCores) and `now`. The
// result is the same for any delivery order of the same records, never
// throws, and a missing writer only removes its records and sets
// `incomplete`. Authority never depends on `at`: only the creator appoints or
// demotes admins (with cuts on the admin's writers), on the root or on its
// other bound writers (the sibling charter), a ban or admit can never
// target the creator or an admin of the final root state, and a ban or an
// unban counts in causal order, an unban only when it lifts the latest ban
// seen for that diary. `community` is the parent community's input
// (buildCommunity's), or null, and a standalone root (no community) ignores
// it; a root of kind community is folded by buildCommunity only.
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
  result.cutUnknown = bound.cutUnknown
  result.frozen = bound.frozen
  result.released = bound.released
  result.slots = bound.slots
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
  const standalone = !asCommunity && isStandaloneHeader(header)
  const { bound, joinRejoin } = readJoins(joins)
  const rootBound = bound.has(creator + ':' + G)
  // A standalone group has no parent to wait for: any community input is
  // ignored, so no catalogue can attach it.
  const parent = asCommunity || standalone ? { C: null, orphan: false, incomplete: false } : resolveParent(input.community, G, header)
  const C = parent.C
  let incomplete = !rootBound || parent.incomplete
  const marks = cutTable(input.marks)
  const walks = diaryWalks(joins, input.marks, G)
  // A hole in the history of a diary that binds a writer here may hide the
  // cut that freed or froze a slot: the fold is not complete about it.
  for (const [, wk] of walks) if (wk.gap && wk.bound) incomplete = true
  // The walk's verdict per writer key: the diary whose walk counts it (live
  // or frozen) or released it, with its cut, and the writers some diary's
  // walk refused for good (over its cap).
  const { slot, voided } = walkSlots(walks)

  const copies = new Map()
  if (Array.isArray(writers)) {
    for (let i = 0; i < writers.length; i++) {
      const w = writers[i]
      if (!isPlainObject(w)) continue
      const key = w.key
      if (!isHex64(key) || key === G) continue
      const log = readLog(w.entries, false, null, priv, asCommunity)
      if (log.header === null && !log.raw.has(0)) continue
      pushTo(copies, key, { log, diary: w.diary, signed: Number.isSafeInteger(w.signed) && w.signed > 0 ? w.signed : 0 })
    }
  }
  // Header stubs (#350): block 0 alone of a core a diary bound here whose
  // header cannot count for that diary. Only block 0 is read, it merges with
  // the core's other copies (a block 0 that differs is a fork), and it is no
  // copy for any diary: it settles the pairs its header rules out (below),
  // never counts a writer.
  if (Array.isArray(input.heads)) {
    for (let i = 0; i < input.heads.length; i++) {
      const x = input.heads[i]
      if (!isPlainObject(x) || !isHex64(x.key) || x.key === G) continue
      const read = readLog(x.entries, false, null, priv, asCommunity)
      if (!read.raw.has(0)) continue
      pushTo(copies, x.key, { log: { header: read.header, records: [], raw: new Map([[0, read.raw.get(0)]]) }, diary: null, signed: 0 })
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
  // Writers whose header names a diary whose walk neither counts nor
  // released them: never candidates, never awaited.
  const uncounted = new Set()
  // Per writer whose copies agree, the header its block 0 holds, or null when
  // that block is no valid writer header (undecodable, invalid or v1).
  const heads = new Map()
  for (const [key, list] of copies) {
    const log = mergeCopies(list.map((x) => x.log))
    if (log === null) continue
    heads.set(key, log.header)
    if (log.header === null) continue
    const h = log.header
    if (h.group !== G || !bound.has(h.diary + ':' + key) || !list.some((x) => x.diary === h.diary)) continue
    // header-invalid: a group writer names its device's community writer
    // where a community writer names none, and a writer's recipient key must
    // match the visibility. A `member` mismatch rejects at any cut: no
    // release or cut of its diary makes such a header count.
    if ((h.member === null) !== asCommunity) {
      invalid.add(key)
      continue
    }
    // A writer of a standalone group names the group itself: no community
    // writer can bind it, and a writer naming G anywhere else meets the gate.
    if (standalone && h.member !== G) {
      invalid.add(key)
      continue
    }
    if ((h.box !== null) !== priv) {
      // A writer cut at 0 with such a header (a boxless writer its diary
      // replaced) holds nothing that counts: rejected, never awaited.
      const s0 = slot.get(h.diary + ':' + key)
      if (s0 !== undefined && s0.cut === 0) invalid.add(key)
      continue
    }
    // The community gate binds a group writer strictly to a counted CW of
    // its own diary; a CW not held while C is incomplete is awaited.
    if (C !== null && (!C.state.counted.has(h.member) || C.state.cwDiary.get(h.member) !== h.diary)) {
      if (C.result.incomplete && !C.state.cwDiary.has(h.member)) incomplete = true
      else invalid.add(key)
      continue
    }
    // Only a writer its diary's slot walk counts or released is a candidate
    // (the walk replaces the old per-diary cap). One cut at 0 gave its slot
    // back, but its block 0, leaves and key blocks still count (below).
    const sl = slot.get(h.diary + ':' + key)
    if (sl === undefined) {
      uncounted.add(key)
      continue
    }
    // A writer its own diary cut (owner decision, #350, "Corte é final"):
    // its records from the cut on are dropped before folding, and no record
    // of another diary brings them back. Block 0, every leave (a cut never
    // undoes a leave nor the rejoin naming it) and every key block (kept
    // valid for reading only, so history stays readable) stay. The walk
    // decides the slot, but the records stop at the lowest of its cut and
    // every mark held: a mark the walk ignored (written before the join it
    // reads, or seen by a reader whose hole hides that join) still cuts.
    const held = marks.cuts.get(h.diary)
    const cut = Math.min(sl.cut, held && held.has(key) ? held.get(key) : Infinity)
    const end = cut === Infinity ? Infinity : Math.max(cut, 1)
    // Seeders hold a cut writer sparse, and readers read past a hole (#350):
    // a copy counts up to its first hole, and past it only the blocks a cut
    // keeps, once the hole is at or past the cut. A sparse copy then folds
    // like the whole one, and a partial copy, cut or not, as the prefix it
    // always was.
    const prefix = heldPrefix(list)
    const records = log.records.filter((x) => x.seq < Math.min(prefix, end) || (prefix >= end && keptPastCut(x.record)))
    // A CW's generation counts its header's rejoin only when the diary's
    // earliest on-join of it names the same leave (dropStaleLeaves).
    const c = { key, diary: h.diary, member: h.member, rejoin: h.rejoin, at: h.at, ...splitReacts(records) }
    if (cut !== Infinity) {
      c.cut = cut
      c.held = log.records.length ? log.records[log.records.length - 1].seq : 0
      // The length its writer signed, which a sparse copy proves without
      // holding the blocks past the cut.
      const signed = Math.max(0, ...list.map((x) => x.signed))
      if (signed > 0) c.signed = signed
    }
    c.frozen = sl.frozen
    c.released = sl.released
    if (asCommunity) c.joinRejoin = joinRejoin.get(h.diary + ':' + key) || null
    candidates.set(key, c)
  }
  // A root its creator's diary never bound carries no authority and no
  // posts: anyone can name any diary in a header. Only the header is read.
  const rootRecords = rootBound ? rootLog.records : []
  const rootEntry = { key: G, diary: creator, rejoin: null, at: header.at, ...splitReacts(rootRecords) }
  const { valid, rejected } = checkRejoins(candidates, rootEntry, voided)
  // Every writer a walk counts or released must be held, frozen and
  // released ones included, whatever its diary's latest join says (a seeder
  // hiding one would hide the leave it holds); a writer no walk counts is
  // never awaited. A held writer whose header does not match the group's
  // kind (a `member` mismatch, a replaced boxless writer) is rejected above,
  // never awaited. Neither is a pair whose writer's held block 0 rules it
  // out: no valid header, or one naming another group or another diary than
  // the pair's. Block 0 is signed by the writer's key, so no copy can make a
  // writer whose header counts for a pair read as ruled out there.
  for (const pair of slot.keys()) {
    const w = pair.slice(65)
    if (valid.has(w) || rejected.has(w) || invalid.has(w) || uncounted.has(w)) continue
    if (heads.has(w)) {
      const h = heads.get(w)
      if (h === null || h.group !== G || h.diary !== pair.slice(0, 64)) continue
    }
    incomplete = true
  }
  const capped = [...valid.values()]
  // Over the group cap the creator's and the admins' writers go first, so
  // moderation is never evicted, and banned diaries last; within each tier
  // frozen writers go after live ones, released ones last.
  const rank = (c) => c.released ? 2 : c.frozen ? 1 : 0
  const select = (banned, admins) => {
    const tier = (c) => (rootBound && c.diary === creator) ? 0 : admins.has(c.diary) ? 1 : banned.has(c.diary) ? 3 : 2
    const ranked = capped.slice().sort((a, b) => (tier(a) - tier(b)) || (rank(a) - rank(b)) || cmp(a.key, b.key))
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
  const ctx = { G, header, creator, rootBound, rootEntry, now, C, standalone, orphan: parent.orphan, bound: valid, confirms: input.confirms, marks: input.marks }
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
  // The diaries a hole in their history as read may hide a mark of, among
  // those binding a counted writer: nodes must not take the fold as
  // complete about cuts for them.
  const cutUnknown = new Set(sel.kept.filter((l) => marks.gaps.has(l.diary)).map((l) => l.diary))
  // The kept writers the walk froze (counted below their cut, never written
  // to again), released ones included, those it released (block 0, leaves
  // and key blocks only), and per diary the walk's slot counts.
  const frozen = new Set(sel.kept.filter((l) => l.frozen).map((l) => l.key))
  const released = new Set(sel.kept.filter((l) => l.released).map((l) => l.key))
  return { ctx, kept: sel.kept, incomplete, priv, cutUnknown, frozen, released, slots: walkCounts(walks) }
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

// Charter-shaped records off the root that only readers of the sibling
// charter accept (older ones drop them as root-only): a group's group-meta,
// group-admin, group-image and group-about, and in C a CW grant (on: true,
// `group: null`) or a group-create. Kept only on writers of the diary that
// bound the root, so no other diary adds a node or an order edge that older
// readers never see.
function dropForeignCharter (kept, owner, isC) {
  const foreign = (r) => isC
    ? (r.type === 'group-admin' && r.on === true && r.group === null) || r.type === 'group-create'
    : CHARTER_TYPES.has(r.type)
  return kept.map((l) => {
    if (l.diary === owner) return l
    const keep = (list) => list && list.some((x) => foreign(x.record)) ? list.filter((x) => !foreign(x.record)) : list
    const records = keep(l.records)
    const images = keep(l.images)
    const abouts = keep(l.abouts)
    return records === l.records && images === l.images && abouts === l.abouts ? l : { ...l, records, images, abouts }
  })
}

// `auth`, in the opened pass of a private group, is the plaintext pass's
// authority: moderation and membership come from it alone, so decrypted
// edges only place content.
// A root of kind community folds in community mode: no posts or keys, admit
// and ban only from records with `group: null`, and the catalogue of its
// groups.
function foldCore ({ G, header, creator, rootBound, rootEntry, now, C = null, standalone = false, bound = null, confirms = null, marks = null }, kept, auth = null) {
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
  kept = dropForeignCharter(kept, rootBound ? creator : null, isC)
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
  const live = (w) => cs === null || (inC(writerDiary.get(w)) && !cs.retiredC.has(cwOf.get(w)) && admittedCw(w) && !cs.bannedCws.has(cwOf.get(w)))
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
  // Per CW of the creator's diary, the bound a confirmed counted leave
  // retiring it gives: the leave's own seq when written on it, else the cut
  // it lists for it. It comes from the earliest leave set that bounds the
  // CW, the lowest within that set, and a later set never lowers or raises
  // it, as for C's root (owner decision, 2026-11-24): a creator leaving
  // again from a new device does not list the CWs the first leave retired,
  // which would read them at 0. Repairs and creates on that CW at or above
  // it are void.
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
    const boundSet = new Map()
    for (const n of ownLeaves) {
      if (!isConfirmed(n)) continue
      const k = setOf(n)
      const lower = (w, b) => {
        const s = boundSet.get(w)
        if (s !== undefined && s < k) return
        repairBound.set(w, s === k ? Math.min(b, repairBound.get(w)) : b)
        boundSet.set(w, k)
      }
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
  const leavePosOf = (L) => L.pos
  const leavesBefore = (d, pos) => {
    const list = leavesOf.get(d)
    return list ? firstAbove(list, pos - 1, leavePosOf) : 0
  }
  // The sibling charter: the creator's other devices write the charter too
  // (name, join, image, description, admin grants and demotions), on a
  // writer of its current generation (the latest leave of its diary named
  // by the writer's rejoin, public groups included), below its diary's cut
  // (bindCores), before any leave (withdrawn), and only while the creating
  // device's root holds its powers: in C until the gate, in a group until a
  // mark of the creator's diary cuts the root. A retired CW and a writer
  // whose CW left C carry none, as for every other authority.
  // A later leave of the diary ends it too: a leave keeps the records below
  // it on its own writer, and the charter written off the root must not
  // outlive the creator's leave.
  const curGen = (n) => {
    // Side records sit half a position after their anchor.
    const m = leavesBefore(owner, Math.ceil(n.pos))
    return noLaterLeave(n) && (m === 0 || names(n.writer, leavesOf.get(owner)[m - 1]))
  }
  const noLaterLeave = (n) => leavesBefore(owner, Math.ceil(n.pos)) === (leavesOf.has(owner) ? leavesOf.get(owner).length : 0)
  const siblingHist = (n) => owner !== null && n.diary === owner && n.writer !== G && !n.virtual
  const siblingBase = (n) => siblingHist(n) && curGen(n) && !(isC && monoRetired.has(n.writer))
  const charterLive = isC ? gateSet < 0 : gRootCut === Infinity
  const siblingPlain = (n) => siblingBase(n) && charterLive && rootLive && !voidAuth(n) && !withdrawn(n)
  // Which charter record wins a field (name and join, each member's admin
  // status, image, description). A root record ranks by its position. A
  // sibling record ranks by what its `seen` names, never by its own
  // position, which a forward ref to a writer someone else controls can
  // move past a later root record: right after a root record the reader
  // holds, one level after the current record of the same field on another
  // of the creator's writers, else below every root record. Ties go by
  // depth, writer and seq.
  const FLOOR = { pos: -Infinity, sub: 0, depth: 0 }
  const rankCmp = (a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0) || a.sub - b.sub || a.depth - b.depth
  const atOf = (r) => {
    const t = isPlainObject(r) && typeof r.at === 'string' ? Date.parse(r.at) : NaN
    return Number.isFinite(t) ? t : Infinity
  }
  const rootNodes = order.filter((n) => n.writer === G && !n.virtual)
  const rootAts = new Map()
  for (const f of ['records', 'reacts', 'images', 'abouts']) for (const x of logs[0][f] || []) rootAts.set(x.seq, atOf(x.record))
  // A sibling record naming root seq s was written after every root record
  // up to s, so the latest `at` among them bounds it: the writer moves `at`
  // past the cut on a repair, never on the posts and key blocks after it.
  const rootTrust = new Map()
  let rootHigh = -Infinity
  for (const s of [...rootAts.keys()].sort((x, y) => x - y)) {
    rootHigh = Math.max(rootHigh, rootAts.get(s))
    rootTrust.set(s, rootHigh)
  }
  const rootSlot = (s) => {
    if (!rootAts.has(s)) return null
    const j = firstAbove(rootNodes, s, (n) => n.seq)
    return j > 0 ? { pos: rootNodes[j - 1].pos + 0.5, sub: s + 0.5, depth: 0 } : null
  }
  // The diary cut bound: on a creator writer its diary cut, a record counts
  // as charter only when it and every counted record its rank rests on were
  // written by the earliest such cut's `at`, so a stolen key's record naming a root
  // seq the root reaches only after the cut never ranks there. A mark with
  // no valid `at` bounds everything.
  const cutAt = new Map()
  const ownMarks = owner !== null && marks instanceof Map ? marks.get(owner) : null
  if (Array.isArray(ownMarks)) {
    for (const m of ownMarks) {
      if (!isPlainObject(m) || m.gap === true || !isHex64(m.writer) || m.writer === G || !Number.isSafeInteger(m.cut) || m.cut < 0) continue
      const t = atOf(m)
      cutAt.set(m.writer, Math.min(t === Infinity ? -Infinity : t, cutAt.has(m.writer) ? cutAt.get(m.writer) : Infinity))
    }
  }
  // `nodes`: one field's root and sibling records, each at its own position
  // (`pos`). `counts` judges a record there; `rootRank` ranks a root record.
  // Returns the records that take effect (`on`: walking down the ranks, a
  // record whose position is below every higher-ranked one's, so a record
  // never acts before something that outranks it) and the top one.
  // A record that does not count voids itself, never a record of another
  // writer that names it: that one keeps the rank the chain gives, judged by
  // the `at` of the root record and of the counted records only (`trust`),
  // since a void record's own `at` is whatever its writer chose. Below a
  // record that does not count it must also have been written after that
  // `trust`, or a void record naming a later root seq would lift it.
  const charterRanks = (nodes, rootRank, counts) => {
    const byRef = new Map()
    for (const n of nodes) if (n.writer !== G) byRef.set(n.writer + ':' + n.seq, n)
    const infos = new Map()
    // `trust` and `clean` (every record counts) describe the chain below n.
    const judge = (n, rank, trust, clean) => {
      const own = atOf(n.record)
      if (!clean && trust > own) return judge(n, FLOOR, -Infinity, true)
      const ok = counts(n) && (n.writer === G || Math.max(own, trust) <= (cutAt.has(n.writer) ? cutAt.get(n.writer) : Infinity))
      return { rank, ok, trust: ok ? Math.max(own, trust) : trust, clean: clean && ok }
    }
    const floor = (n) => judge(n, FLOOR, -Infinity, true)
    // A ref to the record's own writer never ranks it (as in causal order a
    // forward one places nothing).
    const next = (n) => {
      const ref = n.writer === G ? null : n.record.seen
      if (!isPlainObject(ref) || ref.writer === n.writer || ref.writer === G) return null
      const t = byRef.get(ref.writer + ':' + ref.seq)
      return t === undefined ? null : t
    }
    const terminal = (n) => {
      if (n.writer === G) return judge(n, rootRank(n), -Infinity, true)
      const ref = n.record.seen
      const slot = isPlainObject(ref) && ref.writer === G ? rootSlot(ref.seq) : null
      return slot === null ? floor(n) : judge(n, slot, rootTrust.get(ref.seq), true)
    }
    // Chains are walked without recursion; every record of a ref cycle ranks
    // at the floor.
    const infoOf = (n) => {
      const path = []
      const at = new Map()
      let cur = n
      while (!infos.has(cur)) {
        if (at.has(cur)) {
          const i = at.get(cur)
          for (let c = i; c < path.length; c++) infos.set(path[c], floor(path[c]))
          path.length = i
          break
        }
        const t = next(cur)
        if (t === null) {
          infos.set(cur, terminal(cur))
          break
        }
        at.set(cur, path.length)
        path.push(cur)
        cur = t
      }
      for (let c = path.length - 1; c >= 0; c--) {
        const m = path[c]
        const ti = infos.get(next(m))
        infos.set(m, judge(m, { pos: ti.rank.pos, sub: ti.rank.sub, depth: ti.rank.depth + 1 }, ti.trust, ti.clean))
      }
      return infos.get(n)
    }
    const ranked = []
    for (const n of nodes) {
      const info = infoOf(n)
      if (info.ok) ranked.push({ n, rank: info.rank })
    }
    ranked.sort((a, b) => rankCmp(b.rank, a.rank) || cmp(b.n.writer, a.n.writer) || b.n.seq - a.n.seq)
    const on = new Set()
    let min = Infinity
    for (const { n } of ranked) {
      if (n.pos < min) on.add(n)
      min = Math.min(min, n.pos)
    }
    return { on, top: ranked.length > 0 ? ranked[0].n : null }
  }
  const atPos = (n) => ({ pos: n.pos, sub: 0, depth: 0 })
  // Each member's admin status: the grants and demotions that take effect,
  // at their own positions.
  // `readOn`: the same rank with no leave, withdrawal, generation or
  // liveness term, for the reading layer, so a grant handed out stays
  // readable after the creator leaves while a record the rank or the cut
  // bound keeps from taking effect never reaches it.
  const adminOn = new Set()
  const readOn = new Set()
  const adminTop = new Map()
  if (!auth) {
    const byMember = new Map()
    for (const n of order) {
      const r = n.record
      if (r.type !== 'group-admin' || r.member === creator) continue
      if (n.writer !== G && (!siblingHist(n) || (isC && r.group !== null) || cwDemotion(n))) continue
      pushTo(byMember, r.member, n)
    }
    const counts = (n) => n.writer === G ? !withdrawn(n) && !voidAuth(n) && !rootVoid(n) : siblingPlain(n)
    // Every root record enters the reading layer, so every one is ranked
    // there, counted or not.
    const reads = (n) => n.writer === G || siblingHist(n)
    for (const [d, list] of byMember) {
      const ranks = charterRanks(list, atPos, counts)
      for (const n of ranks.on) adminOn.add(n)
      if (ranks.top !== null) adminTop.set(d, ranks.top)
      for (const n of charterRanks(list, atPos, reads).on) readOn.add(n)
    }
  }
  for (let i = 0; i < order.length; i++) {
    const n = order[i]
    const r = n.record
    if (auth || r.type !== 'group-admin' || r.member === creator) continue
    if (n.writer !== G) {
      if (cwDemotion(n)) {
        removals.push(n)
        pushTo(rootAdmin, r.member, { on: false, cuts: cutsMap(r.cuts), unlisted: 0 })
        continue
      }
      if (!siblingHist(n) || (isC && r.group !== null)) continue
    }
    // A grant never reaches a writer's past from seq 0: a writer missing
    // from its cuts gets only the automatic cover of an admit (grantCover),
    // from its first record after the grant, so a hidden or forgotten device
    // never gains authority over records a later demotion could not undo. A
    // demotion still covers every writer.
    const cuts = cutsMap(r.cuts)
    const gen = admitGen(r.member, cuts, i)
    const event = { on: r.on, cuts, unlisted: r.on ? Infinity : 0, gen, pos: n.pos, auto: r.on ? new Map() : null }
    // A sibling record enters the reading layer where its rank lets it take
    // effect, whatever later happens to its writer, as the root's does. The
    // union keeps a counted grant there when a record that does not count
    // ties with it and would switch it off. Its cover there is its own
    // (historical, grantCover), not the effective one.
    if (n.writer === G || adminOn.has(n) || readOn.has(n)) pushTo(rawAdmin, r.member, { ...event, auto: r.on ? new Map() : null })
    if (!adminOn.has(n)) continue
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
  const reactNodes = []
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
  // its cuts. Grants give nothing to writers they neither list nor cover,
  // and bans still apply by their cuts.
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
  // ever listed or covered the cited CW at or below the cited length (or
  // C's creator):
  // no demotion, C ban or leave makes history unreadable. Sending needs C's
  // current layers there, C admin now and a live writer.
  const viaCommunity = (n) => {
    const a = n.record.auth
    if (cs === null || a === null || holdsG(n)) return null
    const d = n.diary
    // Judged against the CW's signed length, not its length after a diary
    // cut: a cut never makes the history a key block handed out unreadable
    // (sending still needs the CW in C's authorityWriters, which a cut CW is not).
    if (a.writer !== cwOf.get(n.writer) || cs.cwDiary.get(a.writer) !== d || !cs.lastSeq.has(a.writer) || a.seq > cs.heldSeq.get(a.writer) + 1) return null
    const isCreatorC = d === C.result.creator
    const lists = (e) => e.on && ((e.cuts.has(a.writer) && e.cuts.get(a.writer) <= a.seq) || (e.auto && e.auto.has(a.writer) && e.auto.get(a.writer) <= a.seq))
    if (!isCreatorC && !(cs.rawAdminC.get(d) || []).some(lists)) return null
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
  // Whether a record shows in an approval group through its writer's grant
  // (historical cover). A covered writer's side records (`side`: reactions
  // and votes) count from seq 1, as under admits (autoAdmit); an opened
  // record takes its envelope's verdict for the same flag.
  const adminOf = (n, side = false) => {
    const v = auth ? auth.sealedAdmin.get(envelopeId(n)) : undefined
    if (v !== undefined) return side ? v.side : v.plain
    return adminAt(n.diary, n.writer, n.seq, n.pos, side, true)
  }
  const genOf = (n) => auth && auth.sealedGen.has(envelopeId(n)) ? auth.sealedGen.get(envelopeId(n)) : leaves.get(n.diary) || 0
  // In the opened pass a sibling's sealed charter keeps its envelope's
  // authority (which judged its generation where the envelope sorts).
  const siblingCharter = (n) => auth
    ? siblingHist(n) && noLaterLeave(n) && charterLive && rootLive && !voidAuth(n) && !outOf(n) && auth.sealedAuth.get(envelopeId(n)) === true
    : siblingPlain(n)
  // Leaving ends the nomination and the admission (owner decision): for a
  // diary with leaves, a grant or admit counts only when
  // its cuts prove it saw every leave of that diary (the leave's writer cut
  // past it, or a writer whose rejoin names it cut at 1 or more). Cuts are
  // the admin's, so no `at`, `seen`, join order or extra writer the leaver
  // picks makes an earlier event look later.
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
  // autoAdmit (owner decision, #350): a member's admission covers the new
  // devices of its diary while it has not left or been banned, and an admin
  // grant covers the admin's new devices the same way (owner decision,
  // 2026-11-23). Each positive admit or grant covers the writers of its own
  // generation it does not list: those whose header puts them in the
  // generation the event observed (admitGen).
  // A writer's generation comes from its header and the leave it names,
  // never from order positions: 0 without a rejoin; with a rejoin naming a
  // leave L of the diary, the leaves observed along its rejoin chain (L and
  // its cuts, then the leave L's writer rejoined from, and so on), L
  // included (writerGen; a rejoin naming no leave of the diary covers
  // nothing). In C
  // it is the CW's generation (part.genOf). The covered writer gets the cut
  // an admin listing it would have written: its first record after the
  // event in causal order, else its next seq. Its records before the event
  // stay uncovered. A later leave ends the cover from the leave on exactly
  // as for a listed writer (leave withdrawal, and a post after the leave
  // only counts admits of its generation or later), so its records from
  // before the leave stay, and an earlier event never covers a writer of a
  // later generation (a device back after a leave needs a new admit or
  // grant, and a device from before a leave is never covered by a later
  // one). Its side records (reactions, votes, topic marks) never become
  // nodes of the order and count from seq 1, as under an admit listing it
  // with cut 1 (layerAt `side`), still under every other check.
  // Under a community, leaving it counts too, decided from headers and the
  // event's own cuts, never from order positions (a
  // community leave has no causal link to G's admits): never a writer whose
  // CW C retired, and only an event that lists a G writer of the diary bound
  // to a CW of the same community generation (genOfC) as the writer's CW.
  // Auto cuts never prove a leave was seen (sawPrefix and admitGen read
  // `cuts` only). The opened pass of a private group reuses these events, so
  // both passes agree on who is covered.
  const leaveRef = new Map()
  for (const list of leavesOf.values()) for (const L of list) leaveRef.set(L.writer + ':' + L.seq, L)
  // Leaves may cut only their own writer (member.js cleanup paths), so the
  // generation follows the whole rejoin chain: each leave, its cuts, and
  // the leave its writer rejoined from, a leave visited at most once.
  const genOfLeave = new Map()
  const leaveGen = (L) => {
    if (genOfLeave.has(L)) return genOfLeave.get(L)
    const cuts = new Map()
    const seen = new Set()
    for (let x = L; x !== undefined && x.diary === L.diary && !seen.has(x);) {
      seen.add(x)
      for (const [cw, c] of cutsMap(x.record.cuts)) if (c > (cuts.get(cw) || 0)) cuts.set(cw, c)
      if (x.seq + 1 > (cuts.get(x.writer) || 0)) cuts.set(x.writer, x.seq + 1)
      const r = rejoinRef.get(x.writer)
      x = r === undefined ? undefined : leaveRef.get(r.writer + ':' + r.seq)
    }
    const g = admitGen(L.diary, cuts, Infinity)
    genOfLeave.set(L, g)
    return g
  }
  const writerGen = (w, d) => {
    const r = rejoinRef.get(w)
    if (r === undefined) return 0
    const L = leaveRef.get(r.writer + ':' + r.seq)
    if (L === undefined || L.diary !== d) return -1
    return leaveGen(L)
  }
  const genOfWriter = (w, d) => {
    if (isC) return monoRetired.has(w) ? -1 : (part.genOf.get(w) || 0)
    if (cs !== null && cs.retiredC.has(cwOf.get(w))) return -1
    return writerGen(w, d)
  }
  // The reading layer's cover is historical: a grant handed out keeps the
  // keys its covered writers distributed readable after they retire, as
  // for a listed writer.
  const histGenOf = (w, d) => isC ? (part.genOf.get(w) || 0) : writerGen(w, d)
  const cwGen = (w) => cwOf.has(w) && cs.genOfC.has(cwOf.get(w)) ? cs.genOfC.get(cwOf.get(w)) : -1
  const sameCGen = (e, w, d) => {
    const g = cwGen(w)
    if (g < 0) return false
    for (const x of e.cuts.keys()) if (writerDiary.get(x) === d && cwGen(x) === g) return true
    return false
  }
  const seqsOf = new Map()
  if (!auth) for (const n of order) if (!n.virtual && n.seq >= 1) pushTo(seqsOf, n.writer, n)
  const seqPos = (x) => x.pos
  const autoCover = (layers, genOf, key = 'auto') => {
    for (const l of kept) {
      const w = l.key
      const d = l.diary
      const list = layers.get(d)
      if (w === G || !list) continue
      const gen = genOf(w, d)
      if (gen < 0) continue
      const mine = seqsOf.get(w) || []
      const next = lastCoreSeq(l) + 1
      for (const e of list) {
        if (!e.on || e.gen !== gen || e.cuts.has(w)) continue
        // Cuts past a leave that sorts after the event prove it seen
        // (sawPrefix) without raising admitGen: such an event's generation
        // is unclear, and it covers nobody it does not list.
        if (!isC && sawPrefix(e, d) > gen) continue
        if (cs !== null && !sameCGen(e, w, d)) continue
        const j = firstAbove(mine, e.pos, seqPos)
        if (!e[key]) e[key] = new Map()
        e[key].set(w, j < mine.length ? mine[j].seq : next)
      }
    }
  }
  // Grants are covered before the loop, which judges authority with them;
  // admits after it, which builds them.
  if (!auth) {
    autoCover(rootAdmin, genOfWriter)
    autoCover(rawAdmin, histGenOf)
    // The grant cover as of the writer's generation (`hist`), whatever
    // retired its CW since: a listed writer keeps its cut then, so a
    // covered one keeps its earlier posts and reactions in an approval
    // group, and in C its admission (admittedCws) and its key power at a
    // leave (powerC). Authority stays on the strict `auto`.
    autoCover(rootAdmin, histGenOf, 'hist')
  }
  // In a private group, authority after its holder's leave needs a grant
  // that saw every leave of that diary sorting before the record (the
  // creator: a writer whose rejoin names its latest such leave), as for
  // keys: a departed admin's old grant moderates nothing, whatever `seen`
  // or rejoin it uses.
  const priv = header.visibility === 'private'
  const isAdmin = (d, w, s) => layerAt(rootAdmin.get(d), w, s)
  const adminAt = (d, w, s, pos, side = false, hist = false) => {
    const m = priv ? leavesBefore(d, pos) : 0
    const events = m === 0 ? rootAdmin.get(d) : sawLayer(rootAdmin.get(d), d, m, d)
    return layerAt(hist ? withHist(events) : events, w, s, 0, side)
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
  // live writer the grant lists or covers: a departed admin, or one back in
  // C on a device of a later generation, is none.
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
  // A reaction is judged at an anchor taken from the reaction-free order:
  // its own envelope in the opened pass of a private group (it stays the
  // sealed node an older reader sees), else the node before it on its own
  // core, as if it were a post right there. Its own edges place nothing.
  const reactsAt = new Map()
  if (!isC) {
    const byWriter = new Map()
    for (const n of order) if (!n.virtual) pushTo(byWriter, n.writer, n)
    for (const log of logs) {
      for (const x of log.reacts || []) {
        const list = byWriter.get(log.key) || []
        const j = firstAbove(list, x.seq - 1, (m) => m.seq)
        const own = x.envelope === true
        if (own && (j === list.length || list[j].seq !== x.seq)) continue
        const anchor = own ? list[j] : j > 0 ? list[j - 1] : null
        const p = { writer: log.key, diary: log.diary, seq: x.seq, record: x.record, kid: null, virtual: false, pos: anchor === null ? -0.5 : own ? anchor.pos : anchor.pos + 0.5 }
        pushTo(reactsAt, anchor, p)
      }
    }
  }
  const judgeReacts = (anchor) => {
    for (const p of reactsAt.get(anchor) || []) reactNodes.push({ n: p, withdrawn: outOf(p), gen: genOf(p) })
  }
  const metaRanks = charterRanks(
    order.filter((n) => n.record.type === 'group-meta' && (n.writer === G || (siblingHist(n) && !(isC && cwRepair(n))))),
    atPos,
    (n) => (header.visibility === 'public' || n.record.join === 'approval') &&
      (n.writer === G ? !(header.visibility === 'public' ? withdrawn(n) : outOf(n)) && !voidAuth(n) && !rootVoid(n) : siblingCharter(n))
  )
  const metaOn = metaRanks.on
  let cwMetaNode = null
  judgeReacts(null)
  for (let i = 0; i < order.length; i++) {
    if (i > 0) judgeReacts(order[i - 1])
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
        // withdrawal still covers every writer. The diary's later devices
        // get automatic cuts after the loop (autoAdmit).
        pushTo(admits, r.member, { on: r.on, cuts, unlisted: r.on ? Infinity : 0, gen: admitGen(r.member, cuts, i), by: n.diary, pos: n.pos, auto: r.on ? new Map() : null })
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
        // The root's metas and the sibling charter's apply in causal order
        // where they take effect (metaOn), the top-ranked last.
        if (isC && n.writer !== G && cwRepair(n)) {
          cwMeta = r
          cwMetaNode = n
        } else if (metaOn.has(n)) {
          name = r.name
          // A private group always asks for approval.
          if (header.visibility === 'public') join = r.join
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
        sealedAdmin.set(envelopeId(n), { plain: adminAt(n.diary, n.writer, n.seq, n.pos, false, true), side: adminAt(n.diary, n.writer, n.seq, n.pos, true, true) })
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
  if (order.length > 0) judgeReacts(order[order.length - 1])
  // A CW meta of the returning creator overrides the root's metas: the root
  // lost its powers, and its counted metas came before them ending.
  if (cwMeta !== null) {
    name = cwMeta.name
    join = cwMeta.join
  }

  // Plain images and descriptions use the preceding causal node; sealed ones
  // keep their envelope's position so opening them never changes the causal
  // order.
  const sideWriters = new Map()
  for (const n of order) if (!n.virtual) pushTo(sideWriters, n.writer, n)
  // The counted side record of `field` (images, abouts) that wins: a
  // counted CW repair overrides the root, even with a lower writer seq;
  // otherwise the top-ranked root or sibling record (charterRanks), each
  // judged at its own position.
  // Among repairs, one also sorts after what its `seen` names (the nearest
  // lower node of that writer among the records held, as refs resolve), at
  // that node's slot: a device with no node of its own yet would otherwise
  // sit before everything. In a slot, root side records sort by root seq and
  // a record seeing the root sorts right after the root seq it names. A
  // repair naming another device's side record of the same field sorts right
  // after it (one level deeper), so one device replaces another's.
  const logOf = new Map(logs.map((l) => [l.key, l]))
  // A ref to the record's own writer at or above its own seq places nothing,
  // as in causal order.
  const forward = (ref, n) => ref.writer === n.writer && ref.seq >= n.seq
  const seenSlot = (ref, n) => {
    if (!isPlainObject(ref) || forward(ref, n) || !logOf.has(ref.writer) || ref.seq > lastCoreSeq(logOf.get(ref.writer))) return null
    const list = sideWriters.get(ref.writer) || []
    const j = firstAbove(list, ref.seq, (m) => m.seq)
    return j > 0 ? { pos: list[j - 1].pos + 0.5, sub: ref.writer === G ? ref.seq + 0.5 : 0, depth: 0 } : null
  }
  const later = (a, b) => a.pos - b.pos || a.sub - b.sub || a.depth - b.depth
  const lastSide = (field) => {
    const nodes = []
    const byRef = new Map()
    for (const log of logs) {
      const list = sideWriters.get(log.key) || []
      for (const x of log[field] || []) {
        const j = firstAbove(list, x.envelope ? x.seq : x.seq - 1, (n) => n.seq)
        const anchor = { pos: j > 0 ? list[j - 1].pos + (x.envelope ? 0 : 0.5) : -0.5, sub: log.key === G ? x.seq : 0, depth: 0 }
        const n = { writer: log.key, diary: log.diary, seq: x.seq, record: x.record, virtual: false, anchor, pos: anchor.pos, key: null }
        nodes.push(n)
        if (log.key !== G) byRef.set(log.key + ':' + x.seq, n)
      }
    }
    const targetOf = (n) => n.writer !== G && isPlainObject(n.record.seen) && !forward(n.record.seen, n) ? byRef.get(n.record.seen.writer + ':' + n.record.seen.seq) : undefined
    const atLeast = (k, seen) => seen !== null && later(seen, k) >= 0 ? seen : k
    // Chains are walked without recursion; every record of a ref cycle keeps
    // its own anchor, whatever order the records come in.
    const keyOf = (n) => {
      const path = []
      const inPath = new Map()
      let cur = n
      while (cur !== undefined && cur.key === null && !inPath.has(cur)) {
        inPath.set(cur, path.length)
        path.push(cur)
        cur = targetOf(cur)
      }
      let i = path.length
      if (cur !== undefined && inPath.has(cur)) {
        for (let c = inPath.get(cur); c < path.length; c++) path[c].key = path[c].anchor
        i = inPath.get(cur)
      } else if (cur === undefined) {
        const last = path[--i]
        last.key = atLeast(last.anchor, last.writer === G ? null : seenSlot(last.record.seen, last))
      }
      for (let c = i - 1; c >= 0; c--) {
        const t = (c + 1 < path.length ? path[c + 1] : cur).key
        path[c].key = atLeast(path[c].anchor, { pos: t.pos, sub: t.sub, depth: t.depth + 1 })
      }
      return n.key
    }
    const repairs = isC ? nodes.filter((n) => n.writer !== G && cwRepair(n)) : []
    if (repairs.length > 0) {
      for (const n of repairs) keyOf(n)
      repairs.sort((a, b) => later(a.key, b.key) || cmp(a.writer, b.writer) || a.seq - b.seq)
      return repairs[repairs.length - 1]
    }
    return charterRanks(
      nodes.filter((n) => n.writer === G || siblingHist(n)),
      (n) => n.anchor,
      (n) => n.writer === G ? !outOf(n) && !voidAuth(n) && !rootVoid(n) : siblingCharter(n)
    ).top
  }
  const chosenImage = lastSide('images')
  const image = chosenImage === null ? null : chosenImage.record.image
  const imageAuthor = image === null ? null : chosenImage.diary
  const chosenAbout = lastSide('abouts')
  const about = chosenAbout === null ? null : chosenAbout.record.about
  const refOf = (n) => n === null ? null : { writer: n.writer, seq: n.seq }
  const charterTop = {
    meta: refOf(cwMetaNode !== null ? cwMetaNode : metaRanks.top),
    image: refOf(chosenImage),
    about: refOf(chosenAbout),
    admin: new Map([...adminTop].sort((a, b) => cmp(a[0], b[0])).map(([d, n]) => [d, refOf(n)]))
  }

  // In C an admit's cover as of the CW's generation (`hist`), whatever
  // retired the CW since, as for a grant: a covered CW keeps its admission
  // (admittedCws) after it retires, as a listed one keeps its cut.
  if (!auth) {
    autoCover(admits, genOfWriter)
    if (isC) autoCover(admits, histGenOf, 'hist')
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
  const admittedAt = (d, gen, w, s, side = false) => layerAt(admitsFrom(d, gen), w, s, 0, side)
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
      fwd: r.fwd === 1 ? 1 : 0,
      replyTo: r.replyTo === null ? null : { writer: r.replyTo.writer, seq: r.replyTo.seq },
      ...(Array.isArray(r.media) ? { media: copyGroupMedia(r.media, typeof r.media[0].key === 'string') } : {}),
      ...(isPlainObject(r.card) ? { card: copyLinkCard(r.card, (d) => copyGroupItem(d, typeof d.key === 'string')) } : {}),
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
  // Reactions: one per member diary per target and an empty emoji clears
  // it. A reaction counts only where a post at its anchor would (not
  // withdrawn, banned or unadmitted), from a diary that is a member now, on
  // a post that is shown. A later reaction of the diary replaces an earlier
  // one: on one writer core the higher seq, across its cores the later
  // `at`, then writer, then seq. No causal position takes part.
  // In the opened pass membership is the plaintext pass's: leaves and
  // rejoins placed by decrypted edges must not decide it.
  const memberNow = auth ? auth.members : members
  const postById = new Map()
  for (const p of posts) postById.set(p.writer + ':' + p.seq, p)
  const latestOn = new Map()
  const topicMarks = []
  const choices = []
  for (const { n, withdrawn: out, gen } of reactNodes) {
    const r = n.record
    const d = n.diary
    // A topic or poll stays its author's mark on a post that stays: leaving
    // later does not turn a topic back into chat. A vote needs a member now,
    // as a reaction does.
    const mark = r.type === 'group-topic' || r.type === 'group-poll' || r.type === 'group-event'
    // A future-dated poll or event stays a candidate (foldTopics): dropping it
    // would let a later one win now and the lower seq replace it under its votes.
    const future = isFuture(r.at, now)
    if (out || (future && r.type !== 'group-poll' && r.type !== 'group-event') || (!mark && memberNow.get(d) !== 'member')) continue
    if (d !== owner && (layerAt(bans.get(d), n.writer, n.seq) ||
      (join === 'approval' && !admittedAt(d, gen, n.writer, n.seq, true) && !adminOf(n, true) && !adminC(d)))) continue
    const id = r.target.writer + ':' + r.target.seq
    const post = postById.get(id)
    if (post === undefined) continue
    // A hidden root keeps its marks (its `hidden` hides topic, poll and event with
    // it, and an unhide brings them back); votes on it never count.
    if (mark) {
      if (post.replyTo === null && post.diary === d) topicMarks.push({ n, id, post, future })
      continue
    }
    if (post.hidden) continue
    if (r.type === 'group-choice') {
      choices.push({ n, id, d })
      continue
    }
    const k = id + ':' + n.writer
    const had = latestOn.get(k)
    if (had === undefined || had.seq < n.seq) latestOn.set(k, { id, d, writer: n.writer, seq: n.seq, emoji: r.emoji, key: orderKey(r.at, n.writer, n.seq) })
  }
  const winners = new Map()
  for (const x of latestOn.values()) {
    const k = x.id + ':' + x.d
    const had = winners.get(k)
    if (had === undefined || compareOrder(had.key, x.key) < 0) winners.set(k, x)
  }
  const reactions = new Map()
  for (const x of [...winners.values()].sort((a, b) => compareOrder(a.key, b.key))) {
    if (x.emoji === '') continue
    let byDiary = reactions.get(x.id)
    if (!byDiary) {
      byDiary = new Map()
      reactions.set(x.id, byDiary)
    }
    byDiary.set(x.d, x.emoji)
  }
  for (const [id, byDiary] of reactions) {
    // The cap keeps the emojis most members chose. A tie goes to the emoji
    // first used in the order of the winning reactions (byDiary holds them in
    // that order): by emoji text, keycaps and symbols that one person picked
    // took the slots ahead of the emojis everyone uses.
    const groups = new Map()
    for (const [d, emoji] of byDiary) {
      let g = groups.get(emoji)
      if (!g) {
        g = { emoji, count: 0, by: [], first: groups.size }
        groups.set(emoji, g)
      }
      g.count++
      g.by.push(d)
    }
    if (groups.size === 0) continue
    postById.get(id).reactions = [...groups.values()]
      .sort((a, b) => b.count - a.count || a.first - b.first)
      .slice(0, GROUP_REACTIONS_MAX)
      .map(({ emoji, count, by }) => ({ emoji, count, by }))
  }
  foldTopics(posts, postById, topicMarks, choices)

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
  // not live in C (the root: rootLive). A writer its own diary cut is
  // neither: nothing it appends counts.
  const cuts = new Map()
  for (const l of logs) if (l.cut !== undefined && counted.has(l.key)) cuts.set(l.key, l.cut)
  const liveWriters = new Set()
  const authorityWriters = new Set()
  const endPos = order.length
  for (const l of logs) {
    const w = l.key
    const d = l.diary
    if (!counted.has(w) || retired.has(w) || cuts.has(w)) continue
    if (isC
      ? members.get(d) !== 'member' || layerNow(bans.get(d), w)
      : members.get(d) === 'banned' || layerNow(bans.get(d), w) || bannedC(d) || (w === G ? !rootLive : cs !== null && !live(w))) continue
    liveWriters.add(w)
    const next = lastCoreSeq(l) + 1
    const power = d === owner
      ? rootLive && ownerAt({ writer: w, diary: d, pos: endPos }) && !rootVoid({ writer: w, seq: next })
      : adminAt(d, w, next, endPos) && !layerAt(bans.get(d), w, next)
    if (power) authorityWriters.add(w)
  }
  // The live writers of the creator's diary whose next record would count
  // as charter: the root while it holds its powers, and those the sibling
  // charter covers.
  const charterWriters = new Set()
  for (const l of logs) {
    const w = l.key
    if (owner === null || l.diary !== owner || !liveWriters.has(w)) continue
    const n = { writer: w, diary: owner, seq: lastCoreSeq(l) + 1, pos: endPos, virtual: false, record: { type: 'group-meta' } }
    if (w === G ? !withdrawn(n) && !voidAuth(n) && !rootVoid(n) : siblingPlain(n)) charterWriters.add(w)
  }
  // "Entitled writers": keys go to writers, never to a diary as a whole, so
  // a pending device of a member diary gets nothing, and a retired device
  // never keeps receiving through an earlier grant. After a leave, only
  // events that saw every leave count, and the creator only on a writer
  // whose rejoin names its latest leave.
  // Under the gate a writer must also be live in C (the root: rootLive),
  // and C's creator and admins receive keys on their live writers; after
  // a G leave, community power holds only on a writer whose rejoin names
  // the latest leave, as for G's creator. A community group without its
  // parent (missing, pending or orphan) entitles nobody; a standalone group
  // has no gate, only its own layers.
  const entitled = (w) => {
    const d = writerDiary.get(w)
    if ((cs === null && !standalone) || d === undefined || !counted.has(w) || retired.has(w) || left.has(d) || layerNow(bans.get(d), w)) return false
    if (w === G ? !rootLive : cs !== null && !live(w)) return false
    // A root its creator's diary marked never receives keys again (a stolen
    // creating device would read every later post); the creator receives
    // them on its new writer.
    if (w === G && !isC && gRootCut !== Infinity) return false
    // A writer its own diary cut never receives keys again, whatever the
    // cut: an epoch sealed to it stops being eligible, so the group rotates
    // as after a removal (owner decision, #350).
    if (cuts.has(w)) return false
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
  // A key block its writer's own diary cut past (bindCores keeps it) stays
  // valid for reading only: it never sends and hands no recipient.
  for (const kn of keyNodes) if (cuts.has(kn.n.writer) && kn.n.seq >= Math.max(cuts.get(kn.n.writer), 1)) kn.send = false
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
      // Historical cover: the CW that wrote the leave is retired by it.
      const powerC = d === C.result.creator || S.leaves.some((L) => layerAt(withHist(cs.rootAdminC.get(d)), L.writer, L.seq))
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
      ...logs.map((l) => [l.key, lastCoreSeq(l)]),
      ...virtual.map((l) => [l.key, cs.lastSeq.get(l.key)])
    ]),
    entitled,
    counted,
    retired,
    withdrawn,
    auth: { rootAdmin, bans, admits, sealedAuth, sealedOut, sealedGen, sealedAdmin, members },
    // For a private group's `last`, once its envelopes are opened.
    order
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
    // The catalogue: only the creator creates groups. First the root, one
    // append-only chain, in root seq order below createCut: its first
    // counted create is Geral, so a CW create never becomes Geral nor takes
    // a slot from the root. Then the creator's CWs in causal order. Each
    // group once, up to MAX_GROUPS_PER_COMMUNITY; past the cap an orphan.
    const creates = order.filter((n) => n.writer === G && n.record.type === 'group-create' && n.record.group !== G).sort((a, b) => a.seq - b.seq)
    // A create on a creator CW: not past a leave on that CW. A confirmed
    // leave's bound on it (repairBound) always applies, whatever at or seen
    // the create carries; once the gate is set a CW counts only below such
    // a bound (none: nothing counts), and a CW of a generation after the
    // gate never creates. An unconfirmed leave voids no create, as it voids
    // no repair (owner decision, 2026-11-24): it retires the generation's
    // CWs (part.retired), but a thief holding one CW must not orphan the
    // groups made on the others. The remedy for a stolen CW is the diary
    // cut.
    const cwCreate = (n) => {
      const w = n.writer
      if (owner === null || n.diary !== owner) return false
      const own = part.leaveOf.get(w)
      if (own !== undefined && own.seq < n.seq) return false
      const bounded = repairBound.has(w)
      if (bounded && n.seq >= repairBound.get(w)) return false
      if (gateSet >= 0 && !bounded) return false
      return gateSet < 0 || (part.genOf.get(w) || 0) <= gateSet
    }
    for (const n of order) if (n.writer !== G && n.record.type === 'group-create' && n.record.group !== G) creates.push(n)
    const created = new Map()
    const overflow = new Set()
    let general = null
    for (const n of creates) {
      const g = n.record.group
      if (created.has(g) || overflow.has(g)) continue
      if (n.writer === G ? !authorized(n, createCut) : !cwCreate(n)) continue
      if (general === null && n.writer === G) general = g
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
      // of its own generation, cover included (its earlier records follow
      // the A1 rule).
      const layer = retired.has(w) ? withHist(admits.get(d)) : admitsFrom(d, leaves.get(d) || 0)
      const grants = retired.has(w) ? withHist(rootAdmin.get(d)) : rootAdmin.get(d)
      if (join === 'open' || d === owner || layerNow(layer, w) || layerNow(grants, w)) admittedCws.add(w)
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
      // Each CW's leave-set generation by its header: the automatic cover of
      // a G writer needs an admit listing a writer of the same one.
      genOfC: part.genOf,
      retiredBy,
      leavesOf,
      rejoinOf: rejoinRef,
      cwDiary: writerDiary,
      counted,
      lastSeq: state.lastSeq,
      // The last seq per counted CW before any diary cut: of a cut CW, the
      // last its signed length proves, so a copy trimmed at the cut reads
      // the history a whole copy reads (#350).
      heldSeq: new Map(logs.map((l) => [l.key, Math.max(state.lastSeq.get(l.key) || 0, l.held || 0, (l.signed || 0) - 1)])),
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
      image,
      imageAuthor,
      about,
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
      charterWriters,
      charterTop,
      cuts,
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
    image,
    imageAuthor,
    about,
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
    charterWriters,
    charterTop,
    // The lowest cut the creator's diary marks on the root (`group-cut`),
    // or null: root records at or above it carry no authority.
    rootCut: gRootCut === Infinity ? null : gRootCut,
    // Each counted writer its own diary cut (`group-cut`) -> the lowest cut:
    // its records from max(cut, 1) on do not count.
    cuts,
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
// places content: posts, hides, images and the private name. Epoch keys live in
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
    const owner = ctx.rootBound ? ctx.creator : null
    // A reaction's envelope stays the sealed node an older reader keeps, so
    // its inner edges never move a record; the reaction rides beside it.
    const reactIds = new Set()
    const open = (log) => {
      let changed = false
      const reacts = []
      const images = []
      const abouts = []
      const records = log.records.map((x) => {
        if (x.record.type !== 'group-sealed') return x
        const inner = openEnvelope(x.record, log.key, x.seq, ctx.G, held)
        // Another diary's sealed charter off the root stays sealed, as older
        // readers keep it (dropForeignCharter).
        if (inner === null || (log.key !== ctx.G && log.diary !== owner && CHARTER_TYPES.has(inner.type))) {
          sealed++
          return x
        }
        if (inner.type === 'group-react') {
          reacts.push({ seq: x.seq, record: inner, envelope: true })
          reactIds.add(log.key + ':' + x.seq)
          return x
        }
        if (inner.type === 'group-image') {
          images.push({ seq: x.seq, record: inner, envelope: true })
          return x
        }
        if (inner.type === 'group-about') {
          abouts.push({ seq: x.seq, record: inner, envelope: true })
          return x
        }
        changed = true
        return { seq: x.seq, record: inner, kid: x.record.kid }
      })
      return changed || reacts.length > 0 || images.length > 0 || abouts.length > 0 ? { ...log, records, reacts, images, abouts } : log
    }
    const rootEntry = open(ctx.rootEntry)
    const content = foldCore({ ...ctx, rootEntry }, kept.map(open), plain.state.auth).result
    // `last` (the `seen` a new record writes) never names a reaction, so no
    // record ever depends on one.
    let last = plain.result.last
    if (last !== null && reactIds.has(refId(last))) {
      last = null
      const order = plain.state.order
      for (let i = order.length - 1; i >= 0 && last === null; i--) {
        const n = order[i]
        if (reactIds.has(refId(n))) continue
        if ((n.seq >= 1 && n.record.type !== 'community-leave') || n.record.type === 'group-rejoin') last = { writer: n.writer, seq: n.seq }
      }
    }
    // Without a parent community (missing, pending or orphan) nothing is
    // eligible: a loss of power with no record ("Eligibility" 4). A
    // standalone group has none to wait for.
    const pick = ctx.C === null && ctx.standalone !== true ? { epoch: null, rekeyPending: held.size > 0 } : chooseEpoch(plain.state, epochs, held, mine)
    const st = plain.state
    return {
      ...plain.result,
      name: content.name,
      image: content.image,
      imageAuthor: content.imageAuthor,
      about: content.about,
      // Name, image and description come from the opened pass, admin status
      // from the sealed one, as the values above.
      charterTop: { ...content.charterTop, admin: plain.result.charterTop.admin },
      posts: content.posts,
      future: content.future,
      last,
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
// as a group-post, group-hide, group-react, group-meta, group-image or
// group-about (the fold counts charter off the root only from the creator's
// devices).
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
  return validateGroupRecord(record, seq, { root: writer === G, sealed: true }) === null ? record : null
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
    image: null,
    imageAuthor: null,
    about: null,
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
    charterWriters: new Set(),
    charterTop: emptyCharterTop(),
    cuts: new Map(),
    cutUnknown: new Set(),
    frozen: new Set(),
    released: new Set(),
    slots: new Map(),
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
// catalogue of its groups: Geral, the root's first group-create, then the
// creator's other creates, on the root and then on its CWs, at most
// MAX_GROUPS_PER_COMMUNITY.
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
// repairC(cw, seq), withdrawnC(cw, seq), retiredC, genOfC, leavesOf, rejoinOf,
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
  result.cutUnknown = bound.cutUnknown
  result.frozen = bound.frozen
  result.released = bound.released
  result.slots = bound.slots
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
  MAX_FROZEN_WRITERS_PER_DIARY,
  MAX_WRITER_RELEASES_PER_DIARY,
  GROUP_TYPES,
  MAX_KEY_RECIPIENTS,
  MAX_KEY_BASIS,
  MAX_SEALED_INNER_BYTES,
  GROUP_POST_V2_KEYS,
  validGroupCard,
  isWeakBoxKey,
  validateGroupHeader,
  isStandaloneHeader,
  validateWriterHeader,
  validateGroupRecord,
  groupHeader,
  writerHeader,
  groupPost,
  groupHide,
  groupReact,
  groupTopic,
  groupPoll,
  groupChoice,
  groupEvent,
  groupAdmit,
  groupBan,
  groupMeta,
  groupImage,
  groupAbout,
  groupAdmin,
  groupLeave,
  groupInvites,
  groupCreateRecord,
  communityAdmit,
  communityBan,
  communityDemote,
  communityGrant,
  communityMetaCw,
  communityImageCw,
  communityAboutCw,
  communityDrop,
  communityHide,
  communityInvites,
  groupKey,
  groupSealed,
  sealedInner,
  groupJoins,
  groupJoinHistory,
  diaryGroupKeys,
  groupCutHistory,
  groupConfirmHistory,
  slotWalk,
  diaryWriterCut,
  diaryWalkRecords,
  walkRecordsCut,
  headerStubs,
  slotWalkState,
  replacedWriterCut,
  retiredWriterCut,
  slotWalkStep,
  slotWalkResult,
  walkHasRoom,
  leaveDigest,
  orderKey,
  compareOrder,
  isFuture,
  buildGroup,
  buildCommunity
}
