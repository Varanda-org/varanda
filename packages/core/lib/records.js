'use strict'

// Media attachments: a post may carry up to MAX_MEDIA_PER_POST descriptors
// pointing into a media core (a separate Hypercore whose block 0 is a media
// header, lib/media.js) that the diary declares with a `media-core` record.
// Moderation lists are signed snapshots outside the diary (lib/blocklist.js).
// Engagement: `like` and `repost` records toggle a target post ({ author,
// seq }, seq >= 1) on or off, the last operation per (type, target) wins
// (lib/engagement.js); a quote is a `post` with a `quote` target and no
// `replyTo`. Older readers skip these as invalid; the diary stays valid.

const b4a = require('b4a')
const { validLinkCard, validCardImageBytes, copyLinkCard, CARD_IMAGE_MIME } = require('./link-card')
const { feira } = require('@varanda/rpc')

const MAX_NAME = 80
const MAX_BIO = 280
const MAX_TEXT = 1000
// Storage limits (security audit S3): one raw block, and one whole log.
const MAX_BLOCK_BYTES = 16384
const MAX_LOG_BLOCKS = 100000
const MAX_LOG_BYTES = 64 * 1024 * 1024
// Media (lib/media.js): every media core block is MEDIA_BLOCK_BYTES except
// the last block of an item (1..MEDIA_BLOCK_BYTES).
const MEDIA_BLOCK_BYTES = 32768
const MAX_MEDIA_BLOCKS = 8192 // blocks per media core, header included
const MAX_MEDIA_BYTES = 268435456 // 256 MiB per media core
const MAX_MEDIA_CORES = 4 // latest media-core declarations honoured per diary
const MAX_MEDIA_PER_POST = 4
const MAX_MEDIA_ITEM_BLOCKS = 256 // 8 MiB per item
const MEDIA_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_MEDIA_DIMENSION = 16384
// Voice notes (chats only, never diary posts): one MPEG-4 audio item.
const AUDIO_MIME = 'audio/mp4'
const MAX_AUDIO_MS = 120000
const MAX_AUDIO_BYTES = 1572864
// Groups (lib/group.js): a diary binds a group writer core with `group-join`.
const MAX_GROUP_WRITERS = 512
const MAX_GROUPS_PER_DIARY = 64
const MAX_GROUPS_PER_COMMUNITY = 32
const MAX_GROUP_CUTS = 16
// Writers one diary may count in a group; also the cuts of a group-leave.
const MAX_GROUP_WRITERS_PER_DIARY = 8
const MAX_GROUP_NAME = 80
// Profile avatar: one square still image in this device's media core.
const AVATAR_SIDE = 512
const MAX_AVATAR_BLOCKS = 8
const MAX_AVATAR_BYTES = 8 * MEDIA_BLOCK_BYTES
const AVATAR_MIMES = Object.freeze(['image/jpeg', 'image/webp'])

const CERT_KEYS = ['v', 'member', 'ageBand', 'method', 'date', 'association', 'signature']
const CERT_KEYS_V2 = ['v', 'member', 'ageBand', 'method', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']
const PROFILE_KEYS = ['type', 'name', 'bio', 'at']
const PROFILE_AVATAR_KEYS = ['type', 'name', 'bio', 'at', 'avatar']
const POST_KEYS = ['type', 'text', 'at', 'replyTo']
const POST_MEDIA_KEYS = ['type', 'text', 'at', 'replyTo', 'media']
const QUOTE_KEYS = ['type', 'text', 'at', 'replyTo', 'quote']
const QUOTE_MEDIA_KEYS = ['type', 'text', 'at', 'replyTo', 'quote', 'media']
// A link card (lib/link-card.js) instead of media, never both: two more
// exact sets that older readers skip as malformed, as they skip media.
const POST_PREVIEW_KEYS = ['type', 'text', 'at', 'replyTo', 'preview']
const QUOTE_PREVIEW_KEYS = ['type', 'text', 'at', 'replyTo', 'quote', 'preview']
const ENGAGEMENT_KEYS = ['type', 'to', 'on', 'at']
const TARGET_KEYS = ['author', 'seq']
const DESCRIPTOR_KEYS = Object.freeze(['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height'])
const AUDIO_DESCRIPTOR_KEYS = Object.freeze(['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height', 'ms'])
const MEDIA_CORE_KEYS = ['type', 'key', 'at']
const FOLLOW_KEYS = ['type', 'key', 'on', 'at']
// A key advertisement only (docs/protocol.md section 11): one per identity,
// the highest gen wins.
const DM_KEY_KEYS = ['type', 'box', 'gen', 'at']
// The key derivation encodes gen as uint32be: a higher gen no device can
// derive would outrank every real key.
const MAX_DM_KEY_GEN = 4294967295
const GROUP_JOIN_KEYS = ['type', 'group', 'writer', 'on', 'at']
// A community writer created by a rejoin also names, in its join, the leave
// its header's `rejoin` names (null otherwise): the diary signs the writer's
// generation, so an old device key cannot rewrite it.
const GROUP_JOIN_REJOIN_KEYS = ['type', 'group', 'writer', 'on', 'rejoin', 'at']
const JOIN_REJOIN_KEYS = ['writer', 'seq']
// The diary vouches that its writer `writer`'s records in group `group` at
// seq >= `cut` carry no authority (a group root its creator left behind).
const GROUP_CUT_KEYS = ['type', 'group', 'writer', 'cut', 'at']
// The diary confirms the EXACT leave at (`writer`, `seq`) in `group` whose
// record digest (group.js leaveDigest) is `digest`.
const GROUP_CONFIRM_KEYS = ['type', 'group', 'writer', 'seq', 'digest', 'at']
// A tombstone: no author field, the diary signature is the authority, so a
// tombstone in another diary targets nothing (lib/deletion.js).
const DELETE_KEYS = ['type', 'seq', 'at']
const DELETE_MEDIA_KEYS = ['type', 'seq', 'at', 'media']
const DELETE_RANGE_KEYS = ['core', 'start', 'blocks']
const USERNAME_KEYS = ['type', 'username', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']
// Same field rules as validateCertShape and validateUsernameRecordShape in
// lib/cert.js (not imported here); packages/core/test/records.test.js checks parity.
const AGE_BAND_RE = /^[a-z0-9+-]{1,32}$/
const METHOD_RE = /^[a-z0-9-]{1,32}$/
const AGE_BAND_V2 = 'unchecked'
const METHOD_V2 = 'google'
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const FALLBACK_HANDLE_RE = /^[0-9a-f]{6}$/

function nowIso () {
  return new Date().toISOString()
}

function isHex64 (s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
}

function isHex128 (s) {
  return typeof s === 'string' && /^[0-9a-f]{128}$/.test(s)
}

function isCanonicalIso (s) {
  try {
    return typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s
  } catch {
    return false
  }
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

// A block over MAX_BLOCK_BYTES is never parsed (security audit S3).
function decodeBlock (buf) {
  if (!b4a.isBuffer(buf) && !(buf instanceof Uint8Array)) return null
  if (buf.byteLength > MAX_BLOCK_BYTES) return null
  try {
    const value = JSON.parse(b4a.toString(buf, 'utf8'))
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

function charLength (s) {
  return Array.from(s).length
}

// Forbidden in name, bio and text (security audit S5): C0 controls (only LF
// when allowLf), DEL, C1 controls, the line/paragraph separators U+2028 and
// U+2029 and the bidi embedding/override/isolate controls U+202A-U+202E and
// U+2066-U+2069, so a record can never forge a terminal line or reorder it.
function isForbiddenChar (cp, allowLf) {
  if (cp < 0x20) return !(allowLf && cp === 0x0a)
  if (cp >= 0x7f && cp <= 0x9f) return true
  if (cp === 0x2028 || cp === 0x2029) return true
  if (cp >= 0x202a && cp <= 0x202e) return true
  return cp >= 0x2066 && cp <= 0x2069
}

function hasControlChars (s, allowLf) {
  for (const ch of s) {
    if (isForbiddenChar(ch.codePointAt(0), allowLf)) return true
  }
  return false
}

function isUsername (s) {
  return typeof s === 'string' && USERNAME_RE.test(s) && !FALLBACK_HANDLE_RE.test(s)
}

// The issuer fields shared by a v2 certificate and a username record.
function validDelegation (o) {
  return isHex64(o.association) &&
    isHex64(o.issuer) &&
    o.issuer !== o.association &&
    isHex128(o.issuerSignature) &&
    isCanonicalIso(o.issuerDate)
}

function validCertShape (cert) {
  if (!isPlainObject(cert)) return false
  if (hasExactKeys(cert, CERT_KEYS)) {
    return cert.v === 1 &&
      isHex64(cert.member) &&
      isHex64(cert.association) &&
      isHex128(cert.signature) &&
      typeof cert.ageBand === 'string' && AGE_BAND_RE.test(cert.ageBand) &&
      typeof cert.method === 'string' && METHOD_RE.test(cert.method) &&
      isCanonicalIso(cert.date)
  }
  if (hasExactKeys(cert, CERT_KEYS_V2)) {
    return cert.v === 2 &&
      isHex64(cert.member) &&
      validDelegation(cert) &&
      isHex128(cert.signature) &&
      cert.ageBand === AGE_BAND_V2 &&
      cert.method === METHOD_V2 &&
      isCanonicalIso(cert.date)
  }
  return false
}

function validUsernameShape (record) {
  if (!hasExactKeys(record, USERNAME_KEYS)) return false
  return isUsername(record.username) &&
    isHex64(record.member) &&
    validDelegation(record) &&
    isHex128(record.signature) &&
    isCanonicalIso(record.date)
}

// A group-leave sits at seq >= 1 of its writer (group.js validRef).
function validJoinRejoin (r) {
  return isPlainObject(r) && hasExactKeys(r, JOIN_REJOIN_KEYS) && isHex64(r.writer) && Number.isSafeInteger(r.seq) && r.seq >= 1
}

// A post reference: exactly { author: lowercase hex64, seq: safe int >= 1 }.
function validTarget (r) {
  if (!isPlainObject(r) || !hasExactKeys(r, TARGET_KEYS)) return false
  return isHex64(r.author) && Number.isSafeInteger(r.seq) && r.seq >= 1
}

function validReplyTo (r) {
  return r === null || validTarget(r)
}

function isIntIn (v, min, max) {
  return Number.isSafeInteger(v) && v >= min && v <= max
}

// A media descriptor (exact keys): where an item lives in a media core and
// what it is. Key-agnostic: "core is not the diary key" is checked by the
// readers and writers (lib/media.js). Never throws.
function validDescriptor (d) {
  try {
    if (!isPlainObject(d) || !hasExactKeys(d, DESCRIPTOR_KEYS)) return false
    const { core, mime, start, blocks, bytes, sha256, width, height } = d
    return isHex64(core) &&
      typeof mime === 'string' && MEDIA_MIMES.includes(mime) &&
      isIntIn(start, 1, MAX_MEDIA_BLOCKS - 1) &&
      isIntIn(blocks, 1, MAX_MEDIA_ITEM_BLOCKS) &&
      start + blocks <= MAX_MEDIA_BLOCKS &&
      Number.isSafeInteger(bytes) &&
      bytes > (blocks - 1) * MEDIA_BLOCK_BYTES &&
      bytes <= blocks * MEDIA_BLOCK_BYTES &&
      isHex64(sha256) &&
      isIntIn(width, 1, MAX_MEDIA_DIMENSION) &&
      isIntIn(height, 1, MAX_MEDIA_DIMENSION)
  } catch {
    return false
  }
}

// A voice note descriptor (exact keys): a post descriptor plus its duration,
// with no picture size. Group posts only; validDescriptor, which diary posts
// use, stays still images. Never throws.
function validAudioDescriptor (d) {
  try {
    if (!isPlainObject(d) || !hasExactKeys(d, AUDIO_DESCRIPTOR_KEYS)) return false
    const { core, mime, start, blocks, bytes, sha256, width, height, ms } = d
    return isHex64(core) &&
      mime === AUDIO_MIME &&
      isIntIn(start, 1, MAX_MEDIA_BLOCKS - 1) &&
      isIntIn(blocks, 1, MAX_MEDIA_ITEM_BLOCKS) &&
      start + blocks <= MAX_MEDIA_BLOCKS &&
      Number.isSafeInteger(bytes) &&
      bytes > (blocks - 1) * MEDIA_BLOCK_BYTES &&
      bytes <= blocks * MEDIA_BLOCK_BYTES &&
      bytes <= MAX_AUDIO_BYTES &&
      isHex64(sha256) &&
      width === 0 &&
      height === 0 &&
      isIntIn(ms, 1, MAX_AUDIO_MS)
  } catch {
    return false
  }
}

// Never throws.
function validAvatar (d) {
  try {
    return validDescriptor(d) &&
      AVATAR_MIMES.includes(d.mime) &&
      d.width === AVATAR_SIDE &&
      d.height === AVATAR_SIDE &&
      d.blocks <= MAX_AVATAR_BLOCKS &&
      d.bytes <= MAX_AVATAR_BYTES
  } catch {
    return false
  }
}

// A post preview's thumbnail: a still JPEG descriptor of one media block.
// Never throws.
function validPreviewImage (d) {
  try {
    return validDescriptor(d) && d.mime === CARD_IMAGE_MIME && validCardImageBytes(d.bytes)
  } catch {
    return false
  }
}

function validPreview (card) {
  return validLinkCard(card, validPreviewImage)
}

// By index, never every(): a hole in a sparse array is undefined and invalid.
function validMediaList (media) {
  if (!Array.isArray(media) || media.length < 1 || media.length > MAX_MEDIA_PER_POST) return false
  for (let i = 0; i < media.length; i++) {
    if (!validDescriptor(media[i])) return false
  }
  return true
}

// By index, never every(): a hole in a sparse array is undefined and invalid.
function validDeleteRanges (media) {
  if (!Array.isArray(media) || media.length < 1 || media.length > MAX_MEDIA_PER_POST) return false
  for (let i = 0; i < media.length; i++) {
    const r = media[i]
    if (!isPlainObject(r) || !hasExactKeys(r, DELETE_RANGE_KEYS)) return false
    if (!isHex64(r.core) || !isIntIn(r.start, 1, MAX_MEDIA_BLOCKS - 1) || !isIntIn(r.blocks, 1, MAX_MEDIA_ITEM_BLOCKS)) return false
    if (r.start + r.blocks > MAX_MEDIA_BLOCKS) return false
  }
  return true
}

// Pages (lib/page.js): shape only here; the signatures are checked where a
// page diary is read. A bad page record is 'malformed', never thrown.
const MAX_PAGE_ADMINS = 16
const MAX_PAGE_GEN = 4294967295
const PAGE_NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const PAGE_KEYS = Object.freeze({
  'page-roster': ['type', 'page', 'gen', 'owner', 'admins', 'prev', 'at', 'nonce', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature', 'countersignature'],
  'page-origin': ['type', 'page', 'from', 'fromSeq', 'gen', 'owner', 'admins', 'at', 'nonce', 'actor', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature', 'countersignature'],
  'page-close': ['type', 'page', 'gen', 'at', 'nonce', 'actor', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature', 'countersignature'],
  'page-moved': ['type', 'page', 'to', 'gen', 'at', 'nonce', 'actor', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature', 'countersignature'],
  'page-accept': ['type', 'page', 'gen', 'rosterSignature', 'at', 'nonce', 'actor', 'signature'],
  'page-offer': ['type', 'page', 'to', 'exp', 'gen', 'at', 'nonce', 'actor', 'signature'],
  'page-link': ['type', 'page', 'diary', 'actor', 'at', 'nonce', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature'],
  'page-delegate': ['type', 'actor', 'at']
})

// Sorted strictly ascending (so unique), by index: a sparse hole is invalid.
function validPageAdmins (admins, owner) {
  if (!Array.isArray(admins) || admins.length > MAX_PAGE_ADMINS) return false
  for (let i = 0; i < admins.length; i++) {
    const a = admins[i]
    if (!isHex64(a) || a === owner) return false
    if (i > 0 && !(admins[i - 1] < a)) return false
  }
  return true
}

function validPageShape (r) {
  const type = r.type
  if (!hasExactKeys(r, PAGE_KEYS[type])) return false
  if (type === 'page-delegate') return isHex64(r.actor) && isCanonicalIso(r.at)
  if (!isHex64(r.page) || !isCanonicalIso(r.at) || typeof r.nonce !== 'string' || !PAGE_NONCE_RE.test(r.nonce)) return false
  if (type === 'page-link') {
    return isHex64(r.diary) && isHex64(r.actor) && r.diary !== r.page && r.actor !== r.diary && r.actor !== r.page &&
      validDelegation(r) && isHex128(r.signature)
  }
  if (!isHex128(r.signature)) return false
  const minGen = type === 'page-close' || type === 'page-accept' ? 2 : 1
  if (!isIntIn(r.gen, minGen, MAX_PAGE_GEN)) return false
  if (type === 'page-accept') return isHex64(r.actor) && isHex128(r.rosterSignature)
  if (type === 'page-offer') {
    if (!isHex64(r.actor)) return false
    if (r.to === null) return r.exp === null
    return isHex64(r.to) && isCanonicalIso(r.exp)
  }
  if (!validDelegation(r) || !isHex128(r.countersignature)) return false
  if (type === 'page-roster') {
    return isHex64(r.owner) && validPageAdmins(r.admins, r.owner) &&
      (r.prev === null || (Number.isSafeInteger(r.prev) && r.prev >= 1))
  }
  if (!isHex64(r.actor)) return false
  if (type === 'page-close') return true
  if (type === 'page-moved') return isHex64(r.to) && r.to !== r.page
  // page-origin: signed by its owner.
  return isHex64(r.from) && r.from !== r.page && Number.isSafeInteger(r.fromSeq) && r.fromSeq >= 1 &&
    isHex64(r.owner) && r.actor === r.owner && validPageAdmins(r.admins, r.owner)
}

const TYPES = Object.freeze(['member-cert', 'profile', 'post', 'username', 'media-core', 'follow', 'like', 'repost', 'group-join', 'delete', 'group-cut', 'group-confirm', 'dm-key', 'page-roster', 'page-accept', 'page-offer', 'page-close', 'page-moved', 'page-origin', 'page-delegate', 'page-link', 'listing', 'listing-edit', 'listing-status', 'listing-rate'])

// Required lazily: lib/group.js requires this module at load time.
function weakBoxKey (hex) {
  return require('./group').isWeakBoxKey(hex)
}

function check (record, seq) {
  if (!isPlainObject(record)) return 'malformed'
  const type = record.type
  if (!TYPES.includes(type)) return 'malformed'
  if (seq === 0 && type !== 'member-cert') return 'genesis-required'
  if (type === 'member-cert') {
    if (seq !== 0) return 'cert-not-first'
    return validCertShape(record.cert) ? null : 'malformed'
  }
  // `seq` is the tombstone's own block index: it can only target an earlier block.
  if (type === 'delete') {
    const withMedia = hasExactKeys(record, DELETE_MEDIA_KEYS)
    if (!withMedia && !hasExactKeys(record, DELETE_KEYS)) return 'malformed'
    if (!Number.isSafeInteger(record.seq) || record.seq < 1 || !(record.seq < seq)) return 'delete-invalid'
    if (!isCanonicalIso(record.at)) return 'date-invalid'
    if (withMedia && !validDeleteRanges(record.media)) return 'media-invalid'
    return null
  }
  // Shape only: the issuer signatures are checked by verifyUsernameRecord
  // (lib/cert.js) where the username is read (lib/username.js).
  if (type === 'username') return validUsernameShape(record) ? null : 'malformed'
  if (Object.prototype.hasOwnProperty.call(PAGE_KEYS, type)) return validPageShape(record) ? null : 'malformed'
  if (type === 'profile') {
    const withAvatar = hasExactKeys(record, PROFILE_AVATAR_KEYS)
    if (!withAvatar && !hasExactKeys(record, PROFILE_KEYS)) return 'malformed'
    if (withAvatar && !validAvatar(record.avatar)) return 'media-invalid'
    const { name, bio, at } = record
    if (typeof name !== 'string' || charLength(name) < 1 || charLength(name) > MAX_NAME) return 'name-length'
    if (typeof bio !== 'string' || charLength(bio) > MAX_BIO) return 'bio-length'
    if (hasControlChars(name, false) || hasControlChars(bio, true)) return 'control-chars'
    if (!isCanonicalIso(at)) return 'date-invalid'
    return null
  }
  if (type === 'media-core') {
    if (!hasExactKeys(record, MEDIA_CORE_KEYS) || !isHex64(record.key)) return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  if (type === 'follow') {
    if (!hasExactKeys(record, FOLLOW_KEYS) || !isHex64(record.key) || typeof record.on !== 'boolean') return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  if (type === 'dm-key') {
    if (!hasExactKeys(record, DM_KEY_KEYS) || !isHex64(record.box) || weakBoxKey(record.box)) return 'malformed'
    if (!Number.isSafeInteger(record.gen) || record.gen < 1 || record.gen > MAX_DM_KEY_GEN) return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  // The creator binds the group root itself: writer may equal group.
  if (type === 'group-join') {
    const withRejoin = hasExactKeys(record, GROUP_JOIN_REJOIN_KEYS)
    if ((!withRejoin && !hasExactKeys(record, GROUP_JOIN_KEYS)) || !isHex64(record.group) || !isHex64(record.writer) || typeof record.on !== 'boolean') return 'malformed'
    if (withRejoin && record.rejoin !== null && !validJoinRejoin(record.rejoin)) return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  if (type === 'group-confirm') {
    if (!hasExactKeys(record, GROUP_CONFIRM_KEYS) || !isHex64(record.group) || !isHex64(record.writer) || !Number.isSafeInteger(record.seq) || record.seq < 1) return 'malformed'
    if (!isHex64(record.digest)) return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  if (type === 'group-cut') {
    if (!hasExactKeys(record, GROUP_CUT_KEYS) || !isHex64(record.group) || !isHex64(record.writer) || !Number.isSafeInteger(record.cut) || record.cut < 0) return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  if (type === 'like' || type === 'repost') {
    if (!hasExactKeys(record, ENGAGEMENT_KEYS) || !validTarget(record.to) || typeof record.on !== 'boolean') return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  // Feira (docs/protocol.md, "Feira"): an older reader skips these types as
  // unknown and the diary is not rejected. Whether an edit or a status
  // targets a live listing of this diary, and whether a rating is a
  // self-rating, is the fold's check (lib/listing.js): this module sees one
  // record, not the diary.
  if (type === 'listing' || type === 'listing-edit') {
    const reason = type === 'listing' ? feira.checkListingShape(record) : feira.checkEditShape(record, seq)
    if (reason !== null) return reason
    if (Object.prototype.hasOwnProperty.call(record, 'media') && !validMediaList(record.media)) return 'media-invalid'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  if (type === 'listing-status') return feira.checkStatusShape(record, seq)
  if (type === 'listing-rate') {
    const reason = feira.checkRateShape(record)
    if (reason !== null) return reason
    if (!validTarget(record.to)) return 'target-invalid'
    if (!/^[0-9a-f]{32}$/.test(record.offer) || !isHex128(record.consent)) return 'malformed'
    return isCanonicalIso(record.at) ? null : 'date-invalid'
  }
  const withPreview = hasExactKeys(record, POST_PREVIEW_KEYS) || hasExactKeys(record, QUOTE_PREVIEW_KEYS)
  const isQuote = hasExactKeys(record, QUOTE_KEYS) || hasExactKeys(record, QUOTE_MEDIA_KEYS) || hasExactKeys(record, QUOTE_PREVIEW_KEYS)
  const withMedia = hasExactKeys(record, POST_MEDIA_KEYS) || hasExactKeys(record, QUOTE_MEDIA_KEYS)
  if (!isQuote && !withMedia && !withPreview && !hasExactKeys(record, POST_KEYS)) return 'malformed'
  if (withMedia && !validMediaList(record.media)) return 'media-invalid'
  if (withPreview && !validPreview(record.preview)) return 'preview-invalid'
  const { text, at, replyTo } = record
  // A post with media may have an empty text (a photo-only post); a quote
  // always has text, with or without media.
  const minText = withMedia && !isQuote ? 0 : 1
  if (typeof text !== 'string' || charLength(text) < minText || charLength(text) > MAX_TEXT) return 'text-length'
  if (hasControlChars(text, true)) return 'control-chars'
  if (!isCanonicalIso(at)) return 'date-invalid'
  if (isQuote) {
    if (replyTo !== null) return 'quote-with-reply'
    return validTarget(record.quote) ? null : 'quote-invalid'
  }
  if (!validReplyTo(replyTo)) return 'reply-invalid'
  return null
}

// Never throws, whatever the input (hostile getters included).
function validateRecord (record, seq) {
  try {
    return check(record, seq)
  } catch {
    return 'malformed'
  }
}

function build (record, seq) {
  const reason = validateRecord(record, seq)
  if (reason) throw new TypeError(reason)
  return record
}

function memberCertRecord (cert) {
  return build({ type: 'member-cert', cert }, 0)
}

// `avatar` is added only when given and not null.
function profileRecord ({ name, bio = '', avatar, at = nowIso() } = {}) {
  const record = { type: 'profile', name, bio, at }
  if (avatar !== undefined && avatar !== null) record.avatar = copyDescriptor(avatar)
  return build(record, 1)
}

// With an avatar, a plain profile followed by the same profile with the
// avatar: a reader that only knows the 4-key form keeps the name and bio.
function profileRecords ({ name, bio = '', avatar = null, at = nowIso() } = {}) {
  const plain = profileRecord({ name, bio, at })
  if (avatar === undefined || avatar === null) return [plain]
  return [plain, profileRecord({ name, bio, avatar, at })]
}

// A copy with exactly the descriptor keys (anything else is passed through
// for validation to reject).
function copyDescriptor (d) {
  if (!isPlainObject(d)) return d
  const out = {}
  for (const k of DESCRIPTOR_KEYS) out[k] = d[k]
  return out
}

// A copy with exactly the target keys (anything else is passed through for
// validation to reject).
function copyTarget (r) {
  if (!isPlainObject(r)) return r
  return { author: r.author, seq: r.seq }
}

// `quote`, `media` and `preview` are added only when given (a null preview
// is no preview). Media and a preview together match no key set.
function postRecord ({ text, replyTo = null, at = nowIso(), media, quote, preview } = {}) {
  const record = { type: 'post', text, at, replyTo }
  if (quote !== undefined) record.quote = copyTarget(quote)
  if (media !== undefined) record.media = Array.isArray(media) ? media.map(copyDescriptor) : media
  if (preview !== undefined && preview !== null) record.preview = copyLinkCard(preview, copyDescriptor)
  return build(record, 1)
}

function likeRecord ({ to, on, at = nowIso() } = {}) {
  return build({ type: 'like', to: copyTarget(to), on, at }, 1)
}

function repostRecord ({ to, on, at = nowIso() } = {}) {
  return build({ type: 'repost', to: copyTarget(to), on, at }, 1)
}

function mediaCoreRecord ({ key, at = nowIso() } = {}) {
  return build({ type: 'media-core', key, at }, 1)
}

function followRecord ({ key, on, at = nowIso() } = {}) {
  return build({ type: 'follow', key, on, at }, 1)
}

// `rejoin` is added only when given (null or { writer, seq }).
function groupJoinRecord ({ group, writer, on, rejoin, at = nowIso() } = {}) {
  if (rejoin === undefined) return build({ type: 'group-join', group, writer, on, at }, 1)
  const ref = isPlainObject(rejoin) ? { writer: rejoin.writer, seq: rejoin.seq } : rejoin
  return build({ type: 'group-join', group, writer, on, rejoin: ref, at }, 1)
}

function groupConfirmRecord ({ group, writer, seq, digest, at = nowIso() } = {}) {
  return build({ type: 'group-confirm', group, writer, seq, digest, at }, 1)
}

function groupCutRecord ({ group, writer, cut, at = nowIso() } = {}) {
  return build({ type: 'group-cut', group, writer, cut, at }, 1)
}

// A copy with exactly the range keys (anything else is passed through for
// validation to reject).
function copyRange (r) {
  if (!isPlainObject(r)) return r
  return { core: r.core, start: r.start, blocks: r.blocks }
}

// Validated as if appended right after its target; the store validates it
// again at its real block index. `media` is added only when given.
function deleteRecord ({ seq, at = nowIso(), media } = {}) {
  const record = { type: 'delete', seq, at }
  if (media !== undefined) record.media = Array.isArray(media) ? media.map(copyRange) : media
  return build(record, Number.isSafeInteger(seq) ? seq + 1 : 1)
}

function copyPlace (p) {
  if (!isPlainObject(p)) return p
  return { uf: p.uf, city: p.city, bairro: p.bairro }
}

function listingFields (record, { title, text = '', price, unit = null, cat, place, media, at = nowIso() }) {
  Object.assign(record, { title, text, price, unit, cat, place: copyPlace(place), at })
  // Null or [] is "no photos" (listing.edit sends null to drop them): the
  // record then has no media key, the only form a reader accepts.
  if (media === undefined || media === null || (Array.isArray(media) && media.length === 0)) return record
  record.media = Array.isArray(media) ? media.map(copyDescriptor) : media
  return record
}

// `media` is added only when it holds photos, here and in an edit.
function listingRecord ({ kind, ...fields } = {}) {
  return build(listingFields({ type: 'listing', kind }, fields), 1)
}

// The whole new content of listing `seq`; its kind stays the root's.
// Validated as if appended right after its target, like deleteRecord.
function listingEditRecord ({ seq, ...fields } = {}) {
  return build(listingFields({ type: 'listing-edit', seq }, fields), Number.isSafeInteger(seq) ? seq + 1 : 1)
}

function listingStatusRecord ({ seq, status, at = nowIso() } = {}) {
  return build({ type: 'listing-status', seq, status, at }, Number.isSafeInteger(seq) ? seq + 1 : 1)
}

function listingRateRecord ({ to, offer, consent, stars, text = '', at = nowIso() } = {}) {
  return build({ type: 'listing-rate', to: copyTarget(to), offer, consent, stars, text, at }, 1)
}

function parseRef (str) {
  if (typeof str !== 'string') return null
  // Canonical decimal only: no leading zeros (except '0'), no rounding.
  const m = /^([0-9a-fA-F]{64}):(0|[1-9][0-9]*)$/.exec(str)
  if (!m) return null
  const seq = Number(m[2])
  if (!Number.isSafeInteger(seq) || String(seq) !== m[2]) return null
  return { author: m[1].toLowerCase(), seq }
}

function formatRef ({ author, seq }) {
  return author + ':' + seq
}

// Fallback for a runtime without structuredClone (bare-runtime 1.34.1 has
// it; the Bare embedded by react-native-bare-kit may differ): copies plain
// data only (null, booleans, numbers, strings, arrays, plain objects) and
// throws on anything else (functions, undefined, BigInt, symbols, class
// instances, cycles), which the caller turns into null exactly as a
// structuredClone DataCloneError or a validation failure would.
function plainClone (value, seen) {
  if (value === null) return null
  const type = typeof value
  if (type === 'boolean' || type === 'number' || type === 'string') return value
  if (type !== 'object') throw new TypeError('not plain data')
  if (seen.has(value)) throw new TypeError('cycle')
  seen.add(value)
  let copy
  if (Array.isArray(value)) {
    copy = []
    for (let i = 0; i < value.length; i++) copy.push(plainClone(value[i], seen))
  } else {
    if (!isPlainObject(value)) throw new TypeError('not plain data')
    copy = {}
    // A data property, never an assignment: an own '__proto__' key must be
    // copied as a key (as structuredClone does), not run the prototype setter.
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, { value: plainClone(value[key], seen), enumerable: true, writable: true, configurable: true })
    }
  }
  seen.delete(value)
  return copy
}

function cloneRecord (record) {
  if (typeof structuredClone === 'function') return structuredClone(record)
  return plainClone(record, new Set())
}

// Plain-data copy of a valid record, or null. The record is read once (by
// structuredClone, or by the plain-data walker above where the runtime has
// none) and validated on the copy, so accessors cannot change a field
// between validation and use, and callers never get references into the
// caller's log entries. Never throws.
function validRecordCopy (record, seq) {
  let copy
  try {
    // Inside the try: a revoked Proxy or a throwing getPrototypeOf trap is
    // skipped, never thrown.
    if (!isPlainObject(record)) return null
    copy = cloneRecord(record)
  } catch {
    return null
  }
  return validateRecord(copy, seq) === null ? copy : null
}

// Plain-data copy of any value read once, or null. Never throws.
function plainCopy (value) {
  try {
    if (!isPlainObject(value)) return null
    return cloneRecord(value)
  } catch {
    return null
  }
}

function latestProfile (entries) {
  return pickProfile(entries, validRecordCopy)
}

// latestProfile over entries whose records are already validRecordCopy
// output for that same entry's seq (or null): lib/feed.js copies each entry
// once per call and hands the copies to every walker. Never pass a caller's
// records here, they would skip both the copy and the validation.
function latestProfileOfCopies (copies) {
  return pickProfile(copies, (record) => record)
}

function pickProfile (entries, copyOf) {
  let best = null
  for (const { seq, record } of entries) {
    const copy = copyOf(record, seq)
    if (copy === null || copy.type !== 'profile') continue
    if (best === null || seq > best.seq) best = { seq, name: copy.name, bio: copy.bio, avatar: copy.avatar }
  }
  if (!best) return null
  return { name: best.name, bio: best.bio, avatar: best.avatar === undefined ? null : copyDescriptor(best.avatar) }
}

function genesisCert (entries) {
  const first = entries[0]
  if (!first || first.seq !== 0) return null
  const copy = validRecordCopy(first.record, 0)
  if (copy === null || copy.type !== 'member-cert') return null
  return copy.cert
}

module.exports = {
  MAX_NAME,
  MAX_BIO,
  MAX_TEXT,
  MAX_BLOCK_BYTES,
  MAX_LOG_BLOCKS,
  MAX_LOG_BYTES,
  MEDIA_BLOCK_BYTES,
  MAX_MEDIA_BLOCKS,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_CORES,
  MAX_MEDIA_PER_POST,
  MAX_MEDIA_ITEM_BLOCKS,
  MEDIA_MIMES,
  MAX_MEDIA_DIMENSION,
  AUDIO_MIME,
  MAX_AUDIO_MS,
  MAX_AUDIO_BYTES,
  DESCRIPTOR_KEYS,
  AUDIO_DESCRIPTOR_KEYS,
  MAX_GROUP_WRITERS,
  MAX_GROUPS_PER_DIARY,
  MAX_GROUPS_PER_COMMUNITY,
  MAX_GROUP_CUTS,
  MAX_GROUP_NAME,
  MAX_GROUP_WRITERS_PER_DIARY,
  TYPES,
  PAGE_KEYS,
  MAX_PAGE_ADMINS,
  MAX_PAGE_GEN,
  DM_KEY_KEYS,
  MAX_DM_KEY_GEN,
  AVATAR_SIDE,
  MAX_AVATAR_BLOCKS,
  MAX_AVATAR_BYTES,
  AVATAR_MIMES,
  PROFILE_AVATAR_KEYS,
  POST_PREVIEW_KEYS,
  QUOTE_PREVIEW_KEYS,
  DELETE_RANGE_KEYS,
  LISTING_KEYS: feira.LISTING_KEYS,
  LISTING_MEDIA_KEYS: feira.LISTING_MEDIA_KEYS,
  LISTING_EDIT_KEYS: feira.EDIT_KEYS,
  LISTING_EDIT_MEDIA_KEYS: feira.EDIT_MEDIA_KEYS,
  LISTING_STATUS_KEYS: feira.STATUS_KEYS,
  LISTING_RATE_KEYS: feira.RATE_KEYS,
  nowIso,
  isPlainObject,
  hasExactKeys,
  hasControlChars,
  charLength,
  plainCopy,
  isHex64,
  isHex128,
  isCanonicalIso,
  decodeBlock,
  memberCertRecord,
  profileRecord,
  profileRecords,
  postRecord,
  mediaCoreRecord,
  followRecord,
  groupJoinRecord,
  groupCutRecord,
  groupConfirmRecord,
  likeRecord,
  repostRecord,
  deleteRecord,
  listingRecord,
  listingEditRecord,
  listingStatusRecord,
  listingRateRecord,
  validDescriptor,
  validAudioDescriptor,
  validAvatar,
  validPreview,
  validPreviewImage,
  validateRecord,
  validRecordCopy,
  parseRef,
  formatRef,
  latestProfile,
  latestProfileOfCopies,
  genesisCert
}
