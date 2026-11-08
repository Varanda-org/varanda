'use strict'

const { utf8ByteLength, charLength } = require('./text')
const L = require('./limits')
const { DM_MEDIA_KEYS, DM_CARD_KEYS } = require('./dm-budget')
const { cardUrlHost, cardTextLength, MAX_CARD_TITLE, MAX_CARD_DESC, MAX_CARD_IMAGE_BYTES } = require('./link-card')
const { MAX_AUDIO_MS } = require('./audio-bounds')
const F = require('./feira')
const IC = require('./invite-card')

const HEX64 = /^[0-9a-f]{64}$/
const REF = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/

function isPlainObject (v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasOwn (obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function isId (v) {
  return Number.isSafeInteger(v) && v >= 1 && v <= L.MAX_ID
}

function isKey (v) {
  return typeof v === 'string' && HEX64.test(v)
}

// '<hex64>:<seq>' with lowercase hex, canonical decimal and seq >= minSeq.
function isRef (v, minSeq = 1) {
  if (typeof v !== 'string') return false
  const m = REF.exec(v)
  if (!m) return false
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) && String(seq) === m[2] && seq >= minSeq
}

function str (min, max) {
  return (v) => typeof v === 'string' && charLength(v) >= min && charLength(v) <= max
}

function int (min, max) {
  return (v) => Number.isSafeInteger(v) && v >= min && v <= max
}

const isBool = (v) => typeof v === 'boolean'

// profile.read: 1..PROFILE_LIMIT_MAX keys; duplicates allowed (the node folds
// them).
function isKeyList (v) {
  return Array.isArray(v) && v.length >= 1 && v.length <= L.PROFILE_LIMIT_MAX && v.every(isKey)
}

function isRefList (v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > L.ENGAGEMENT_LIMIT_MAX) return false
  const seen = new Set()
  for (let i = 0; i < v.length; i++) {
    if (!isRef(v[i], 1) || seen.has(v[i])) return false
    seen.add(v[i])
  }
  return true
}

function isPeekSeqs (v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > L.PEEK_SEQS_MAX) return false
  for (let i = 0; i < v.length; i++) {
    if (!Number.isSafeInteger(v[i]) || v[i] < 1 || (i > 0 && v[i] <= v[i - 1])) return false
  }
  return true
}

// The isCanonicalIso rule of @varanda/core lib/records.js, which this package
// cannot import: a string that round-trips through Date unchanged.
const MAX_ISO = 32

function isCanonicalIso (v) {
  if (typeof v !== 'string' || v.length > MAX_ISO) return false
  try {
    return new Date(v).toISOString() === v
  } catch {
    return false
  }
}

// feed.read `before` (docs/rpc.md 5.13): exactly { at, author, seq }, the
// feed-order position of the oldest item the caller holds.
function isFeedCursor (v) {
  if (!isPlainObject(v) || Object.keys(v).length !== 3) return false
  if (!hasOwn(v, 'at') || !hasOwn(v, 'author') || !hasOwn(v, 'seq')) return false
  return isCanonicalIso(v.at) && isKey(v.author) && Number.isSafeInteger(v.seq) && v.seq >= 1
}

// peek.read `after` (docs/rpc.md 5.22): exactly { round, at, author, seq }, the
// peek-order position of the last item the caller holds.
function isPeekCursor (v) {
  if (!isPlainObject(v) || Object.keys(v).length !== 4) return false
  if (!hasOwn(v, 'round') || !hasOwn(v, 'at') || !hasOwn(v, 'author') || !hasOwn(v, 'seq')) return false
  return Number.isSafeInteger(v.round) && v.round >= 0 && isCanonicalIso(v.at) && isKey(v.author) &&
    Number.isSafeInteger(v.seq) && v.seq >= 1
}

// notices.list `after` (docs/rpc.md 5.28): exactly { at, key }, or exactly
// { at, key, seq } after a reply, quote or mention notice; the notices-order
// position of the last item the caller holds.
function isNoticesCursor (v) {
  if (!isPlainObject(v)) return false
  const count = Object.keys(v).length
  if (!hasOwn(v, 'at') || !hasOwn(v, 'key')) return false
  if (count === 2) return isCanonicalIso(v.at) && isKey(v.key)
  if (count !== 3 || !hasOwn(v, 'seq')) return false
  return isCanonicalIso(v.at) && isKey(v.key) && Number.isSafeInteger(v.seq) && v.seq >= 1
}

// group.read `before` (docs/rpc.md 5.40): exactly { at, writer, seq }, the
// group-order position of the oldest item the caller holds.
function isGroupCursor (v) {
  if (!isPlainObject(v) || Object.keys(v).length !== 3) return false
  if (!hasOwn(v, 'at') || !hasOwn(v, 'writer') || !hasOwn(v, 'seq')) return false
  return isCanonicalIso(v.at) && isKey(v.writer) && Number.isSafeInteger(v.seq) && v.seq >= 1
}

// group.post `replyTo`: exactly { writer, seq }.
function isGroupRef (v) {
  if (!isPlainObject(v) || Object.keys(v).length !== 2) return false
  if (!hasOwn(v, 'writer') || !hasOwn(v, 'seq')) return false
  return isKey(v.writer) && Number.isSafeInteger(v.seq) && v.seq >= 1
}

const GROUP_JOINS = ['open', 'approval']
const isGroupJoin = (v) => typeof v === 'string' && GROUP_JOINS.includes(v)
const isGroupVisibility = (v) => v === 'public' || v === 'private'

// post.create / post.reply / post.quote `media`: 1..MAX_MEDIA_PER_POST descriptors.
// Duplicated from validDescriptor in @varanda/core lib/records.js, which this
// package cannot import (same rules, exact keys).
const DESCRIPTOR_KEYS = ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height']
const AUDIO_DESCRIPTOR_KEYS = [...DESCRIPTOR_KEYS, 'ms']
// Same voice bounds as core records.js, dm.js and group-media.js, without
// importing core into this package or widening diary image descriptors.
const AUDIO_MIME = 'audio/mp4'
const MAX_AUDIO_BYTES = 1572864
const DM_AUDIO_MAX_BYTES = MAX_AUDIO_BYTES + L.DM_MEDIA_MAC_BYTES
const MAX_AUDIO_SEALED_BLOCKS = Math.ceil((MAX_AUDIO_BYTES + 16 + 1) / L.MEDIA_BLOCK_BYTES)

function isDescriptor (d) {
  if (!isPlainObject(d)) return false
  const own = Object.keys(d)
  if (own.length !== DESCRIPTOR_KEYS.length || !DESCRIPTOR_KEYS.every((k) => hasOwn(d, k))) return false
  const { core, mime, start, blocks, bytes, sha256, width, height } = d
  return isKey(core) &&
    typeof mime === 'string' && L.MEDIA_MIMES.includes(mime) &&
    int(1, L.MAX_MEDIA_BLOCKS - 1)(start) &&
    int(1, L.MAX_MEDIA_ITEM_BLOCKS)(blocks) &&
    start + blocks <= L.MAX_MEDIA_BLOCKS &&
    Number.isSafeInteger(bytes) &&
    bytes > (blocks - 1) * L.MEDIA_BLOCK_BYTES &&
    bytes <= blocks * L.MEDIA_BLOCK_BYTES &&
    isKey(sha256) &&
    int(1, L.MAX_MEDIA_DIMENSION)(width) &&
    int(1, L.MAX_MEDIA_DIMENSION)(height)
}

function isAudioDescriptor (d) {
  if (!isPlainObject(d) || Object.keys(d).length !== AUDIO_DESCRIPTOR_KEYS.length ||
    !AUDIO_DESCRIPTOR_KEYS.every((k) => hasOwn(d, k))) return false
  const { core, mime, start, blocks, bytes, sha256, width, height, ms } = d
  return isKey(core) &&
    mime === AUDIO_MIME &&
    int(1, L.MAX_MEDIA_BLOCKS - 1)(start) &&
    int(1, L.MAX_MEDIA_ITEM_BLOCKS)(blocks) &&
    start + blocks <= L.MAX_MEDIA_BLOCKS &&
    Number.isSafeInteger(bytes) &&
    bytes > (blocks - 1) * L.MEDIA_BLOCK_BYTES &&
    bytes <= blocks * L.MEDIA_BLOCK_BYTES &&
    bytes <= MAX_AUDIO_BYTES &&
    isKey(sha256) &&
    width === 0 && height === 0 && int(1, MAX_AUDIO_MS)(ms)
}

function isChatMediaKind (mime, w, h, ms) {
  if (mime === AUDIO_MIME) return w === 0 && h === 0 && int(1, MAX_AUDIO_MS)(ms)
  return isMediaMime(mime) && int(1, L.MAX_MEDIA_DIMENSION)(w) &&
    int(1, L.MAX_MEDIA_DIMENSION)(h) && ms === 0
}

// profile.set `avatar`: same rules as validAvatar in @varanda/core lib/records.js.
function isAvatar (v) {
  return isDescriptor(v) &&
    L.AVATAR_MIMES.includes(v.mime) &&
    v.width === L.AVATAR_SIDE &&
    v.height === L.AVATAR_SIDE &&
    v.blocks <= L.MAX_AVATAR_BLOCKS &&
    v.bytes <= L.MAX_AVATAR_BYTES
}

// By index, never every(): a hole in a sparse array is undefined and invalid.
function isMediaList (v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > L.MAX_MEDIA_PER_POST) return false
  for (let i = 0; i < v.length; i++) {
    if (!isDescriptor(v[i])) return false
  }
  return true
}

// Private group items: where the ciphertext lives in the writer's media core
// (a descriptor without the image size, which ciphertext does not have),
// then the secret and what it hides. Same rules as validPrivateItem in
// @varanda/core lib/group-media.js (protocol section 10).
const GROUP_PRIVATE_MEDIA_KEYS = ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'key', 'nonce', 'plainMime', 'plainSha256', 'w', 'h', 'ms']

function isPrivateGroupMediaItem (d) {
  if (!isPlainObject(d) || Object.keys(d).length !== GROUP_PRIVATE_MEDIA_KEYS.length ||
    !GROUP_PRIVATE_MEDIA_KEYS.every((k) => hasOwn(d, k))) return false
  return isKey(d.core) &&
    d.mime === 'application/octet-stream' &&
    int(1, L.MAX_MEDIA_BLOCKS - 1)(d.start) &&
    int(1, L.MAX_MEDIA_ITEM_BLOCKS)(d.blocks) &&
    d.start + d.blocks <= L.MAX_MEDIA_BLOCKS &&
    d.bytes === d.blocks * L.MEDIA_BLOCK_BYTES &&
    isKey(d.sha256) &&
    isKey(d.key) &&
    typeof d.nonce === 'string' && HEX48.test(d.nonce) &&
    (d.plainMime !== AUDIO_MIME || d.blocks <= MAX_AUDIO_SEALED_BLOCKS) &&
    isKey(d.plainSha256) &&
    isChatMediaKind(d.plainMime, d.w, d.h, d.ms)
}

// Group media identities are distinct even when their other fields differ.
function isGroupMediaList (v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > L.MAX_MEDIA_PER_POST) return false
  const identities = new Set()
  for (let i = 0; i < v.length; i++) {
    const item = v[i]
    if (!isDescriptor(item) && !isAudioDescriptor(item) && !isPrivateGroupMediaItem(item)) return false
    if ((item.mime === AUDIO_MIME || item.plainMime === AUDIO_MIME) && v.length !== 1) return false
    const identity = item.core + ':' + item.start
    if (identities.has(identity)) return false
    identities.add(identity)
  }
  return true
}

function isLinkCard (card, validImage) {
  if (!isPlainObject(card) || Object.keys(card).length !== DM_CARD_KEYS.length ||
    !DM_CARD_KEYS.every((key) => hasOwn(card, key))) return false
  const host = cardUrlHost(card.url)
  if (host === null || card.host !== host) return false
  const title = cardTextLength(card.title)
  const desc = cardTextLength(card.desc)
  if (title < 0 || title > MAX_CARD_TITLE || desc < 0 || desc > MAX_CARD_DESC) return false
  return card.image === null || (validImage(card.image) && card.image.bytes <= MAX_CARD_IMAGE_BYTES)
}

function isPublicCard (card) {
  return isLinkCard(card, (image) => isDescriptor(image) && image.mime === 'image/jpeg')
}

function isGroupCard (card, sealed) {
  return sealed
    ? isLinkCard(card, (image) => isPrivateGroupMediaItem(image) && image.plainMime === 'image/jpeg')
    : isPublicCard(card)
}

function isDmCard (card) {
  return isLinkCard(card, (image) => isDmMediaItem(image) && image.mime === 'image/jpeg' && image.ms === 0)
}

// With media the text may be empty (a photo-only post); without, 1..MAX_TEXT.
function postCross (given, value) {
  if (hasOwn(value, 'media') && (hasOwn(value, 'preview') || hasOwn(value, 'card'))) return 'parâmetro inválido: media'
  if (!hasOwn(value, 'media') && charLength(value.text) < 1) return 'parâmetro inválido: text'
  return null
}

// account.sign (docs/rpc.md 5.18). Duplicated from
// @varanda/core lib/account-link.js, which this package cannot import.
const ACCOUNT_PHASES = ['reserve', 'finish', 'rename', 'delete', 'passkey', 'cancel']
const HEX64_SUB_RE = /^[0-9a-f]{64}$/
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const SUB_RE = /^[\x21-\x7e]{1,255}$/
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const HEX6 = /^[0-9a-f]{6}$/

const isPhase = (v) => typeof v === 'string' && ACCOUNT_PHASES.includes(v)
const isNonce = (v) => typeof v === 'string' && NONCE_RE.test(v)
const isUsername = (v) => typeof v === 'string' && USERNAME_RE.test(v) && !HEX6.test(v)
const isSub = (v) => v === '' || (typeof v === 'string' && SUB_RE.test(v))

// report.sign (docs/rpc.md 5.20). Duplicated from @varanda/core
// lib/report.js (REASONS, TEXT_MAX, SEQ_MAX = MAX_LOG_BLOCKS - 1), which this
// package cannot import.
const REPORT_REASONS = ['spam', 'assedio', 'ilegal', 'outro']
const REPORT_TEXT_MAX = 280
const REPORT_SEQ_MAX = 99999

const isReason = (v) => typeof v === 'string' && REPORT_REASONS.includes(v)

// listing.* (docs/rpc.md, Feira): the record rules live in feira.js.
const HEX32_RE = /^[0-9a-f]{32}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const LISTING_MINE_LIMIT_MAX = 20
const LISTING_RATINGS_REFS_MAX = 32
const RATING_REF_KEYS = ['rater', 'seq']

const isHex32 = (v) => typeof v === 'string' && HEX32_RE.test(v)
const isHex128 = (v) => typeof v === 'string' && HEX128_RE.test(v)
const isListingPrice = (v) => F.isPrice(v)
const isListingUnit = (v) => v === null || F.isUnit(v)
const isListingTitle = str(1, F.MAX_LISTING_TITLE)

function isRatingRefs (v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > LISTING_RATINGS_REFS_MAX) return false
  for (let i = 0; i < v.length; i++) {
    const r = v[i]
    if (!isPlainObject(r)) return false
    const own = Object.keys(r)
    if (own.length !== RATING_REF_KEYS.length || !RATING_REF_KEYS.every((k) => hasOwn(r, k))) return false
    if (!isKey(r.rater) || !int(1, Number.MAX_SAFE_INTEGER)(r.seq)) return false
  }
  return true
}

// An edit carries no kind: servico, the widest, here; the node checks the
// pair against the listing it edits.
function listingUnitCross (given, value) {
  return F.unitAllowed(hasOwn(value, 'kind') ? value.kind : 'servico', value.price, value.unit) ? null : 'parâmetro inválido: unit'
}

// terms.sign (docs/rpc.md 5.29). Duplicated from @varanda/core lib/terms.js
// (VERSION_MAX), which this package cannot import.
const TERMS_VERSION_MAX = 9999

// inviteCard.sign / inviteCard.verify: a value is valid only when already
// canonical, so the signed bytes are exactly what the caller sent.
const HEX128 = /^[0-9a-f]{128}$/
const isInviteCardDesign = (v) => IC.designIndex(v) >= 0
const isInviteCardName = (v) => typeof v === 'string' && IC.canonicalInviteCardText(v, IC.NAME_MAX) === v
const isInviteCardMessage = (v) => typeof v === 'string' &&
  IC.canonicalInviteCardText(v, IC.MESSAGE_MAX_BYTES, { multiline: true }) === v &&
  utf8ByteLength(v) <= IC.MESSAGE_MAX_BYTES
const isSignature = (v) => typeof v === 'string' && HEX128.test(v)
const INVITE_CARD_FIELDS = {
  code: req(IC.isInviteCode),
  design: req(isInviteCardDesign),
  name: req(isInviteCardName),
  message: req(isInviteCardMessage),
  expires: req(IC.isInviteCardExpires)
}

// invite.sign (docs/rpc.md 5.30). Duplicated from @varanda/core
// lib/invite.js (ACTIONS), which this package cannot import.
const INVITE_ACTIONS = ['issue', 'summary']

const isInviteAction = (v) => typeof v === 'string' && INVITE_ACTIONS.includes(v)

// age.sign (docs/rpc.md 5.32). Duplicated from @varanda/core lib/age.js
// (ACTIONS) because this package has no dependencies.
const AGE_ACTIONS = ['session', 'result']

const isAgeAction = (v) => typeof v === 'string' && AGE_ACTIONS.includes(v)

// push.sign (docs/rpc.md 5.31). Duplicated from @varanda/core
// lib/push-proof.js (an https endpoint of 1..2048 printable ASCII
// characters with no backslash, an empty username, password and hash; p256dh of 1..128 and auth of 1..32 from
// [A-Za-z0-9_-]), which this package cannot import.
const PUSH_ENDPOINT_MAX = 2048
const PUSH_P256DH_RE = /^[A-Za-z0-9_-]{1,128}$/
const PUSH_AUTH_RE = /^[A-Za-z0-9_-]{1,32}$/

const isPushAction = (v) => v === 'on' || v === 'off'
const isPushP256dh = (v) => typeof v === 'string' && PUSH_P256DH_RE.test(v)
const isPushAuth = (v) => typeof v === 'string' && PUSH_AUTH_RE.test(v)

// seen.sign / seen.merge (docs/rpc.md 5.95 and 5.96). These bounds mirror
// core's seen-blob and seen-proof without importing dependencies here.
const SEEN_BLOB_B64 = 43744
const SEEN_TOKEN_RE = /^[0-9a-f]{32}$/
const SEEN_PAGE_RE = /^page:[0-9a-f]{64}$/
const isSeenAction = (v) => v === 'read' || v === 'write' || v === 'delete'

function isSeenBlob (v) {
  // 32808 bytes is divisible by three, so canonical base64 has no padding.
  return v === null || (typeof v === 'string' && v.length === SEEN_BLOB_B64 && !/[^A-Za-z0-9+/]/.test(v))
}

function isSeenTokens (v, max) {
  if (!Array.isArray(v) || v.length > max) return false
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string' || v[i].length !== 32 || !SEEN_TOKEN_RE.test(v[i])) return false
  }
  return true
}

function isSeenAvisos (v) {
  if (!isPlainObject(v) || !hasOwn(v, 'own') || !isSeenTokens(v.own, 256)) return false
  if (Object.keys(v).some((key) => key !== 'own' && key !== 'pages')) return false
  if (!hasOwn(v, 'pages')) return true
  if (!isPlainObject(v.pages)) return false
  const pages = Object.keys(v.pages)
  return pages.length <= 4 && pages.every((key) => key.length === 69 && SEEN_PAGE_RE.test(key) && isSeenTokens(v.pages[key], 32))
}

// Global URL, not an import: this package stays free of @varanda/core. The
// signed statement hashes the exact string, so it must be the string fetch
// would request: the URL parser strips tab, CR and LF and reads a backslash
// as '/', hence printable ASCII only (counted in UTF-16 units, so a lone
// surrogate cannot slip through) and no backslash or '#'.
function isPushEndpoint (v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > PUSH_ENDPOINT_MAX) return false
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x21 || c > 0x7e || c === 0x5c || c === 0x23) return false
  }
  try {
    const url = new URL(v)
    // Canonical only: fetch would request the parsed href (default port,
    // case of the host, dot segments), not the string that was signed.
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '' && url.href === v
  } catch {
    return false
  }
}

// Host controls of the in-app web node (docs/rpc.md 5.50 to 5.56), IPC only.
// The PRF output is the 32-byte root secret every member key derives from.
const PRF_RE = /^[0-9a-f]{64}$/
const CREDENTIAL_ID_RE = /^[\x21-\x7e]{1,1024}$/
// What the host names in its cache directory: no separator or dot segment.
const MEDIA_NAME_RE = /^[0-9a-f]{32}\.bin$/
const MEDIA_SIDE_MAX = 16384

const isMediaName = (v) => typeof v === 'string' && MEDIA_NAME_RE.test(v)
const isPrf = (v) => typeof v === 'string' && PRF_RE.test(v)
const isCredentialId = (v) => typeof v === 'string' && CREDENTIAL_ID_RE.test(v)
const isUserId = (v) => v === '' || isKey(v)
const isMediaMime = (v) => typeof v === 'string' && L.MEDIA_MIMES.includes(v)
const isUploadMime = (v) => isMediaMime(v) || v === AUDIO_MIME

function mediaUploadCross (given, value) {
  if (value.mime === AUDIO_MIME) {
    if (value.kind !== 'voice') return 'parâmetro inválido: kind'
    if (!hasOwn(value, 'ms')) return 'parâmetro obrigatório: ms'
    if (value.width !== 0) return 'parâmetro inválido: width'
    if (value.height !== 0) return 'parâmetro inválido: height'
  } else {
    if (hasOwn(value, 'kind')) return 'parâmetro inválido: kind'
    if (hasOwn(value, 'ms')) return 'parâmetro inválido: ms'
    if (value.width === 0) return 'parâmetro inválido: width'
    if (value.height === 0) return 'parâmetro inválido: height'
  }
  return null
}

// recovery.sign and the identity.recovery* host controls (docs/rpc.md 5.90
// to 5.94). Duplicated from @varanda/core lib/recovery-proof.js and
// @varanda/web-member lib/recovery.js, which this package cannot import: a
// recovery blob is { v: 1, kind, nonce: 24 bytes, ciphertext: 82 bytes } in
// lowercase hex, exact keys; a recovery code is at most 64 characters before
// the worklet normalizes it.
const RECOVERY_ACTIONS = ['put', 'remove', 'list']
const RECOVERY_KINDS = ['passkey', 'code']
const RECOVERY_CIPHERTEXT_RE = /^[0-9a-f]{164}$/
const RECOVERY_BLOB_KEYS = ['v', 'kind', 'nonce', 'ciphertext']
const RECOVERY_CODE_MAX = 64

const isRecoveryAction = (v) => typeof v === 'string' && RECOVERY_ACTIONS.includes(v)
const isRecoveryKind = (v) => typeof v === 'string' && RECOVERY_KINDS.includes(v)

function isRecoveryBlob (v) {
  if (!isPlainObject(v)) return false
  const own = Object.keys(v)
  if (own.length !== RECOVERY_BLOB_KEYS.length || !RECOVERY_BLOB_KEYS.every((k) => hasOwn(v, k))) return false
  return v.v === 1 && isRecoveryKind(v.kind) &&
    typeof v.nonce === 'string' && HEX48.test(v.nonce) &&
    typeof v.ciphertext === 'string' && RECOVERY_CIPHERTEXT_RE.test(v.ciphertext)
}

// A passkey wrap carries the wrapping passkey's PRF (`secret`), a code
// lookup the typed code; never both.
function recoverySecretCross (given, value) {
  if (value.kind === 'passkey') {
    if (!hasOwn(given, 'secret')) return 'parâmetro obrigatório: secret'
    if (hasOwn(given, 'code')) return 'code só com kind code'
  } else {
    if (hasOwn(given, 'secret')) return 'secret só com kind passkey'
  }
  return null
}

// community.leave's force: true skips every wait of the creator's leave, a
// list only the waits it names.
const LEAVE_WAITS = ['root', 'groups', 'devices']
const isLeaveForce = (v) => isBool(v) ||
  (Array.isArray(v) && v.length > 0 && v.every((w) => LEAVE_WAITS.includes(w)) && new Set(v).size === v.length)

const DM_ID_RE = /^[0-9a-f]{32}$/
const DM_STATES = ['accepted', 'declined', 'blocked', 'unblocked', 'deleted']
// dm.list rows are small (docs/rpc.md 5.77); the dm.thread maxima live in
// limits.js with the other measured page sizes.
const DM_LIST_LIMIT_DEFAULT = 30
const DM_LIST_LIMIT_MAX = 50
const isDmId = (v) => typeof v === 'string' && DM_ID_RE.test(v)
const isDmState = (v) => typeof v === 'string' && DM_STATES.includes(v)
const isDmFolder = (v) => v === 'inbox' || v === 'request'

// dm.send `media` (docs/rpc.md 5.75): 1..MAX_DM_MEDIA items, each a blob
// descriptor (the validateBlobDescriptor rules of @varanda/core lib/blob.js,
// which this package cannot import) plus mime, w, h and ms, exact keys. bytes
// counts the ciphertext (plaintext plus the MAC), so chunks is fixed by bytes.
// ms is 0 for images and the bounded duration for a voice note.
const HEX48 = /^[0-9a-f]{48}$/

function isDmMediaItem (d) {
  if (!isPlainObject(d)) return false
  const own = Object.keys(d)
  if (own.length !== DM_MEDIA_KEYS.length || !DM_MEDIA_KEYS.every((k) => hasOwn(d, k))) return false
  const { id, key, nonce, chunks, bytes, sha256, mime, w, h, ms } = d
  return isKey(id) && isKey(key) && isKey(sha256) &&
    typeof nonce === 'string' && HEX48.test(nonce) &&
    int(1, L.DM_MEDIA_MAX_CHUNKS)(chunks) &&
    Number.isSafeInteger(bytes) &&
    bytes > L.DM_MEDIA_MAC_BYTES &&
    bytes <= L.DM_MEDIA_MAX_CHUNKS * L.DM_MEDIA_CHUNK_BYTES &&
    chunks === Math.ceil(bytes / L.DM_MEDIA_CHUNK_BYTES) &&
    (mime !== AUDIO_MIME || bytes <= DM_AUDIO_MAX_BYTES) &&
    isChatMediaKind(mime, w, h, ms)
}

// By index, never every(): a hole in a sparse array is undefined and invalid.
// Distinct blob ids, as the core v2 inner requires (protocol section 11), so
// a list the node would refuse is refused here as a parameter error.
function isDmMediaList (v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > L.MAX_DM_MEDIA) return false
  const ids = new Set()
  for (let i = 0; i < v.length; i++) {
    if (!isDmMediaItem(v[i]) || ids.has(v[i].id)) return false
    if (v[i].mime === AUDIO_MIME && v.length !== 1) return false
    ids.add(v[i].id)
  }
  return true
}

// dm.list `before` (docs/rpc.md 5.77): exactly { at, peer }, the list-order
// position of the oldest conversation the caller holds.
function isDmListCursor (v) {
  if (!isPlainObject(v) || Object.keys(v).length !== 2) return false
  if (!hasOwn(v, 'at') || !hasOwn(v, 'peer')) return false
  return isCanonicalIso(v.at) && isKey(v.peer)
}

// page.sign (docs/rpc.md 5.84). Duplicated from @varanda/core
// lib/page-proof.js (ACTIONS, PAGELESS and the canonicalOp rules) because
// this package has no dependencies. The record actions sign page records
// (records.js), not a page statement, so page-proof does not list them.
// 'offer-cancel' of page-proof is not signed here: an offer only ends on the
// diary through the signed cancel offer ({ to: null, exp: null }).
const PAGE_ACTIONS = [
  'create', 'list', 'status', 'post', 'reply', 'quote', 'delete', 'like', 'repost', 'profile', 'avatar',
  'rename', 'invite', 'dm-list', 'dm-thread', 'dm-send', 'dm-set', 'dm-seen', 'follow',
  'follows', 'media', 'notices', 'terms', 'community-join', 'community-leave', 'group-join', 'group-leave',
  'group-post', 'group-read', 'listing', 'listing-edit', 'listing-status', 'listing-consent',
  'accept', 'remove', 'offer', 'transfer-accept', 'close', 'move'
]
const PAGE_PAGELESS = ['create', 'list', 'terms']
const PAGE_OP_MAX_BYTES = 16 * 1024
const PAGE_OP_MAX_DEPTH = 8
// association is filled by the node from its own configured association,
// never taken from the caller (docs/rpc.md 5.84).
const PAGE_OP_FORBIDDEN = ['secretKey', 'pin', 'seed', 'association']
const PAGE_OP_INDEX_KEY_RE = /^(0|[1-9][0-9]*)$/
// page.feed: the newest follows of the page the app peeks at once.
const PAGE_FEED_KEYS_MAX = 64
// page.read: the follows a result carries (newest by seq) and its links (one
// per roster member in force, MAX_PAGE_ADMINS of records.js plus the owner),
// so its worst case fits MAX_MESSAGE where 4095 follows would not.
const PAGE_READ_FOLLOWS_MAX = 64
const PAGE_READ_LINKS_MAX = 16 + 1

const isPageAction = (v) => typeof v === 'string' && PAGE_ACTIONS.includes(v)
const isPagePage = (v) => v === '' || isKey(v)

// The 'offer' op: `to` and `exp` both null (the cancel) or a key and a
// canonical ISO date; the rest of its shape is the node's check.
function isPageOfferPair (op) {
  if (!hasOwn(op, 'to') || !hasOwn(op, 'exp')) return true
  if (op.to === null || op.exp === null) return op.to === null && op.exp === null
  return isKey(op.to) && isCanonicalIso(op.exp)
}

function isPageOpString (s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

// A running lower bound of the canonical JSON size stops a huge op before
// JSON.stringify sees it; the exact size is checked at the end.
function pageOpValue (v, depth, budget) {
  const charge = (n) => {
    budget.used += n
    if (budget.used > PAGE_OP_MAX_BYTES) throw new TypeError('page op too large')
  }
  if (v === null || typeof v === 'boolean') return charge(4)
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Object.is(v, -0)) throw new TypeError('invalid page op')
    return charge(1)
  }
  if (typeof v === 'string') {
    charge(v.length + 2)
    if (!isPageOpString(v)) throw new TypeError('invalid page op')
    return
  }
  if (depth >= PAGE_OP_MAX_DEPTH) throw new TypeError('page op too deep')
  const array = Array.isArray(v)
  if (array ? Object.getPrototypeOf(v) !== Array.prototype : !isPlainObject(v)) throw new TypeError('invalid page op')
  const own = Reflect.ownKeys(v)
  if (array && own.length !== v.length + 1) throw new TypeError('invalid page op')
  // The same charge as canonicalOp: own keys of an array include 'length'.
  charge(1 + Math.max(array ? v.length : own.length, 1))
  for (const key of own) {
    if (array && key === 'length') continue
    if (typeof key !== 'string') throw new TypeError('invalid page op')
    if (array) {
      if (!PAGE_OP_INDEX_KEY_RE.test(key) || Number(key) >= v.length) throw new TypeError('invalid page op')
    } else {
      // An index-like key would be reordered by JSON.stringify, so canonicalOp
      // refuses it too.
      if (PAGE_OP_FORBIDDEN.includes(key) || PAGE_OP_INDEX_KEY_RE.test(key) || !isPageOpString(key)) throw new TypeError('invalid page op')
      charge(key.length + 3)
    }
    const d = Object.getOwnPropertyDescriptor(v, key)
    if (d === undefined || !('value' in d) || !d.enumerable) throw new TypeError('invalid page op')
    pageOpValue(d.value, depth + 1, budget)
  }
}

// A plain object whose canonical JSON (page-proof canonicalOp) is at most
// 16 KiB, with no key named secretKey, pin, seed or association and no
// array-index-like object key ("0", "10") at any depth.
function isPageOp (v) {
  if (!isPlainObject(v)) return false
  try {
    pageOpValue(v, 0, { used: 0 })
    return utf8ByteLength(JSON.stringify(v)) <= PAGE_OP_MAX_BYTES
  } catch {
    return false
  }
}

function isPageFeedKeys (v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > PAGE_FEED_KEYS_MAX) return false
  const seen = new Set()
  for (let i = 0; i < v.length; i++) {
    if (!isKey(v[i]) || seen.has(v[i])) return false
    seen.add(v[i])
  }
  return true
}

function isCert (v) {
  if (!isPlainObject(v)) return false
  return utf8ByteLength(JSON.stringify(v)) <= L.MAX_CERT_BYTES
}

// username.add (docs/rpc.md 5.19): an issuer-signed username record is far
// smaller than a cert; the node verifies it, this only bounds the size.
const MAX_USERNAME_RECORD_BYTES = 2048

function isUsernameRecord (v) {
  if (!isPlainObject(v)) return false
  return utf8ByteLength(JSON.stringify(v)) <= MAX_USERNAME_RECORD_BYTES
}

// age.proof (docs/rpc.md 5.83): an issuer-signed age attestation; the node
// verifies it against its own key and the association, this only bounds the
// size.
const MAX_AGE_PROOF_BYTES = 1024

function isAgeProof (v) {
  if (!isPlainObject(v)) return false
  return utf8ByteLength(JSON.stringify(v)) <= MAX_AGE_PROOF_BYTES
}

// field(check, { optional, fallback }): `fallback` is filled in when the
// field is absent (the handler always sees it).
function req (check) {
  return { check, optional: false }
}

function opt (check, fallback) {
  return { check, optional: true, fallback }
}

const none = {}

// method -> { fields, mutating, cross? }. Every params object has exactly
// a subset of `fields` (all required ones present).
const SPECS = {
  'session.open': { fields: { token: opt(str(1, L.MAX_TOKEN)) } },
  'node.info': { fields: none },
  'identity.create': { fields: none, mutating: true },
  'identity.show': { fields: none },
  'cert.add': { fields: { cert: req(isCert) }, mutating: true },
  // Signs the account-link statement with the identity key; the node fills
  // in member and association itself, so a caller never chooses the bytes.
  'account.sign': {
    fields: {
      phase: req(isPhase),
      nonce: req(isNonce),
      username: req(isUsername),
      sub: req(isSub)
    },
    cross (given, value) {
      // A Google subject only at 'finish', an attestation hash (hex64) only
      // at 'passkey', and always there; '' everywhere else.
      if (value.phase === 'passkey') return HEX64_SUB_RE.test(value.sub) ? null : 'parâmetro inválido: sub'
      if ((value.phase === 'finish') !== (value.sub !== '')) return 'parâmetro inválido: sub'
      return null
    }
  },
  // Appends an issuer-signed username record to the own diary; the node
  // verifies it against its own key and the association.
  'username.add': { fields: { record: req(isUsernameRecord) }, mutating: true },
  // Signs a report statement with the identity key; the node fills in
  // member and association itself and hashes text and quote into the
  // payload, so a caller never chooses the bytes. `seq` absent = a report of
  // the whole account (no quote); present = a report of that post, quoting
  // its text (empty for a photo-only post). `anexo` (a group message only)
  // is the hex SHA-256 of an attached image: the node signs that digest,
  // never the bytes.
  'report.sign': {
    fields: {
      nonce: req(isNonce),
      target: req(isKey),
      seq: opt(int(1, REPORT_SEQ_MAX)),
      writer: opt(isKey),
      group: opt(isKey),
      reason: req(isReason),
      text: opt(str(0, REPORT_TEXT_MAX), ''),
      quote: opt(str(0, L.MAX_TEXT), ''),
      anexo: opt(isKey),
      kind: opt((v) => v === 'listing')
    },
    cross (given, value) {
      if (hasOwn(value, 'kind')) {
        if (!hasOwn(value, 'seq')) return 'kind listing só com seq'
        if (hasOwn(value, 'writer') || hasOwn(value, 'group') || hasOwn(value, 'anexo')) return 'kind listing sem writer, group ou anexo'
      }
      if (!hasOwn(value, 'seq') && value.quote !== '') return 'quote só com seq'
      // A group post is addressed by its writer core inside the group.
      if (hasOwn(value, 'writer') && (!hasOwn(value, 'seq') || !hasOwn(value, 'group'))) return 'writer só com seq e group'
      if (hasOwn(value, 'group') && !hasOwn(value, 'writer')) return 'group só com writer'
      // A diary post is on the seeder, where the moderator reads it.
      if (hasOwn(value, 'anexo') && !hasOwn(value, 'writer')) return 'anexo só com writer'
      return null
    }
  },
  // Signs a blocked member's appeal with the identity key; the node fills in
  // member and association itself and hashes the text into the payload, so a
  // caller never chooses the bytes.
  'appeal.sign': {
    fields: {
      nonce: req(isNonce),
      text: opt(str(0, L.MAX_TEXT), '')
    }
  },
  // Signs the terms-acceptance statement with the identity key; the node
  // fills in member and association itself, so a caller never chooses the
  // bytes.
  'terms.sign': {
    fields: {
      nonce: req(isNonce),
      version: req(int(1, TERMS_VERSION_MAX))
    }
  },
  // Signs a recovery-entry request with the identity key; the node fills in
  // member and association and hashes the blob itself, so a caller never
  // chooses the bytes. Not mutating: it only signs, the account service
  // stores. `list` names no entry; `put` carries the blob, `remove` does not.
  'recovery.sign': {
    fields: {
      action: req(isRecoveryAction),
      nonce: req(isNonce),
      kind: opt(isRecoveryKind),
      lookupId: opt(isKey),
      blob: opt(isRecoveryBlob)
    },
    cross (given, value) {
      if (value.action === 'list') {
        if (hasOwn(given, 'kind') || hasOwn(given, 'lookupId') || hasOwn(given, 'blob')) return 'list sem kind, lookupId nem blob'
        return null
      }
      if (!hasOwn(given, 'kind')) return 'parâmetro obrigatório: kind'
      if (!hasOwn(given, 'lookupId')) return 'parâmetro obrigatório: lookupId'
      if (value.action === 'put') {
        if (!hasOwn(given, 'blob')) return 'parâmetro obrigatório: blob'
        if (value.blob.kind !== value.kind) return 'parâmetro inválido: blob'
      } else if (hasOwn(given, 'blob')) {
        return 'blob só com put'
      }
      return null
    }
  },
  // Signs the signup-invite request with the identity key; the node fills in
  // member and association itself, so a caller never chooses the bytes.
  'invite.sign': {
    fields: {
      action: req(isInviteAction),
      nonce: req(isNonce)
    }
  },
  // Signs a signup invite card with the identity key; the node fills in the
  // member itself, so a caller never chooses who signs. Not mutating: it
  // only signs.
  'inviteCard.sign': { fields: { ...INVITE_CARD_FIELDS } },
  // Checks a card's signature against the member key it names. Pure.
  'inviteCard.verify': {
    fields: {
      ...INVITE_CARD_FIELDS,
      member: req(isKey),
      signature: req(isSignature)
    }
  },
  // Signs the age-verification request with the identity key; the node fills
  // in member and association itself, so a caller never chooses the bytes.
  'age.sign': {
    fields: {
      action: req(isAgeAction),
      nonce: req(isNonce)
    }
  },
  // Stores the account service's signed age attestations in the browser
  // node after verifying them; since: null clears the stored one. A local,
  // idempotent store, so not mutating: the client re-reads node.info.
  'age.proof': {
    fields: {
      verified: opt(isAgeProof),
      since: opt((v) => v === null || isAgeProof(v))
    },
    cross (given) {
      return hasOwn(given, 'verified') || hasOwn(given, 'since') ? null : 'parâmetro obrigatório: verified'
    }
  },
  // Signs the push opt-in statement with the identity key; the node fills
  // in member, association and the endpoint hash itself, so a caller never
  // chooses the bytes.
  'push.sign': {
    fields: {
      nonce: req(isNonce),
      action: req(isPushAction),
      endpoint: req(isPushEndpoint),
      p256dh: req(isPushP256dh),
      auth: req(isPushAuth)
    }
  },
  'profile.set': {
    // No fallback: an absent avatar keeps the newest own one (docs/rpc.md 5.6).
    fields: {
      name: req(str(1, L.MAX_NAME)),
      bio: opt(str(0, L.MAX_BIO), ''),
      avatar: opt((v) => v === null || isAvatar(v))
    },
    mutating: true
  },
  // Tombstones the caller's own profile version, or the compatibility pair
  // it belongs to (docs/rpc.md 5.34).
  'profile.delete': { fields: { to: req((v) => isRef(v, 1)) }, mutating: true },
  'post.create': {
    fields: { text: req(str(0, L.MAX_TEXT)), media: opt(isMediaList), preview: opt(isPublicCard) },
    mutating: true,
    cross: postCross
  },
  'post.reply': {
    fields: { to: req((v) => isRef(v, 1)), text: req(str(0, L.MAX_TEXT)), media: opt(isMediaList), preview: opt(isPublicCard) },
    mutating: true,
    cross: postCross
  },
  'post.quote': {
    fields: { to: req((v) => isRef(v, 1)), text: req(str(1, L.MAX_TEXT)), media: opt(isMediaList), preview: opt(isPublicCard) },
    mutating: true,
    cross: postCross
  },
  // Tombstones the caller's own publication (docs/rpc.md 5.33).
  'post.delete': { fields: { to: req((v) => isRef(v, 1)) }, mutating: true },
  'like.set': { fields: { to: req((v) => isRef(v, 1)), on: req(isBool) }, mutating: true },
  'repost.set': { fields: { to: req((v) => isRef(v, 1)), on: req(isBool) }, mutating: true },
  'engagement.read': { fields: { refs: req(isRefList) } },
  'listing.create': {
    fields: {
      kind: req(F.isKind),
      title: req(isListingTitle),
      text: req(str(0, L.MAX_TEXT)),
      price: req(isListingPrice),
      unit: req(isListingUnit),
      cat: req(F.isCat),
      place: req(F.isPlace),
      media: opt(isMediaList)
    },
    mutating: true,
    cross: listingUnitCross
  },
  'listing.status': { fields: { to: req((v) => isRef(v, 1)), status: req(F.isStatus) }, mutating: true },
  'listing.delete': { fields: { to: req((v) => isRef(v, 1)) }, mutating: true },
  // A full snapshot: media null drops the photos, so it is never left out.
  'listing.edit': {
    fields: {
      to: req((v) => isRef(v, 1)),
      expectedRevision: req(int(0, Number.MAX_SAFE_INTEGER)),
      title: req(isListingTitle),
      text: req(str(0, L.MAX_TEXT)),
      price: req(isListingPrice),
      unit: req(isListingUnit),
      cat: req(F.isCat),
      place: req(F.isPlace),
      media: req((v) => v === null || isMediaList(v))
    },
    mutating: true,
    cross: listingUnitCross
  },
  'listing.mine': {
    fields: {
      before: opt(int(1, Number.MAX_SAFE_INTEGER)),
      limit: opt(int(1, LISTING_MINE_LIMIT_MAX), LISTING_MINE_LIMIT_MAX)
    }
  },
  // Signs the deal consent with the identity key and appends nothing.
  'listing.consent': { fields: { to: req((v) => isRef(v, 1)), rater: req(isKey), offer: req(isHex32) } },
  'listing.rate': {
    fields: {
      to: req((v) => isRef(v, 1)),
      offer: req(isHex32),
      consent: req(isHex128),
      stars: req(F.isStars),
      text: req(str(0, F.MAX_RATE_TEXT))
    },
    mutating: true
  },
  'listing.ratings': { fields: { author: req(isKey), seq: req(int(1, Number.MAX_SAFE_INTEGER)), refs: req(isRatingRefs) } },
  'diary.peek': {
    fields: {
      author: req(isKey),
      seqs: req(isPeekSeqs),
      profileSeq: opt(int(1, Number.MAX_SAFE_INTEGER)),
      usernameSeq: opt(int(1, Number.MAX_SAFE_INTEGER))
    }
  },
  'follow.add': { fields: { key: req(isKey) }, mutating: true },
  'follow.remove': { fields: { key: req(isKey) }, mutating: true },
  'follow.list': {
    fields: {
      offset: opt(int(0, Number.MAX_SAFE_INTEGER), 0),
      limit: opt(int(1, L.FOLLOW_LIMIT_MAX), L.FOLLOW_LIMIT_DEFAULT)
    }
  },
  'log.read': {
    fields: {
      author: opt(isKey),
      limit: opt(int(1, L.LOG_LIMIT_MAX), L.LOG_LIMIT_DEFAULT),
      // Exclusive block-seq bound; absent = the newest page.
      before: opt(int(1, Number.MAX_SAFE_INTEGER))
    }
  },
  'feed.read': {
    fields: {
      limit: opt(int(1, L.FEED_LIMIT_MAX), L.FEED_LIMIT_DEFAULT),
      // Exclusive feed-order cursor; absent = the newest page.
      before: opt(isFeedCursor)
    }
  },
  // Names of the given authors from local data only (docs/rpc.md 5.21).
  'profile.read': { fields: { authors: req(isKeyList) } },
  // Espiadinha page: diaries the person does not follow (docs/rpc.md 5.22).
  'peek.read': {
    fields: {
      limit: opt(int(1, L.PEEK_LIMIT_MAX), L.PEEK_LIMIT_DEFAULT),
      // Exclusive peek-order cursor; absent = the first page (rebuilds the snapshot).
      after: opt(isPeekCursor)
    }
  },
  // People who follow the caller and whom the caller does not follow yet, plus
  // the replies, quotes and mentions that name the caller and the likes and
  // reposts of the caller's posts.
  // Success: { notices: [{ kind: 'follow' | 'reply' | 'quote' | 'mention' | 'like' | 'repost',
  // key: hex64, seq: integer >= 1, at: ISO, name: string|null,
  // username: string|null, seen: hex32, avatar: AvatarDescriptor|null,
  // post?: '<hex64>:<seq>' }],
  // next: null | { at, key } | { at, key, seq }, incomplete: boolean,
  // supported: boolean, activity: boolean }.
  // No count or total.
  // kind is absent on a notice of a node that predates it, and means 'follow'.
  // name and avatar come from the author's profile and username is their
  // verified username, for every kind;
  // seq is the block of their signed follow record; for a reply, quote or
  // mention, key:seq is the author's signed POST block that replied to, quoted
  // or mentioned the caller; for a like or repost, key:seq is the engager's
  // signed on:true like or repost block, at is its at, and post names the
  // caller's post it targets. post is absent on every other kind.
  // seen is an opaque token, stable per identity, keyed by the identity secret
  // and unlinkable to the follower without it (what the app stores as seen);
  // one row per block. next is the next-page cursor; it
  // carries seq whenever the read went over the notices channel v3 or v2.
  // incomplete means the seeder's index or the read's budget was not complete;
  // supported is false when the seeder speaks none of the notices channels;
  // activity is false only when the rows came over the follows-only channel
  // v1 because the seeder speaks neither v3 nor v2; every other result says
  // true. Likes and reposts come only over v3.
  // Hosted web only: the core node answers USAGE 'avisos disponíveis só no navegador'
  // (docs/rpc.md 5.28).
  'notices.list': {
    fields: {
      limit: opt(int(1, L.NOTICES_LIMIT_MAX), L.NOTICES_LIMIT_DEFAULT),
      after: opt(isNoticesCursor)
    }
  },
  // Public groups (docs/rpc.md 5.36 to 5.49). Every method names the group by
  // its root key; the node fills in everything else.
  // `visibility` is fixed at creation (docs/rpc.md 5.36); a private group forces
  // join 'approval'. No method changes it afterwards.
  'group.create': {
    fields: { name: req(str(1, L.MAX_GROUP_NAME)), join: req(isGroupJoin), visibility: opt(isGroupVisibility, 'public'), community: req(isKey) },
    mutating: true
  },
  // `community` names the group's community when its root is not held yet (docs/rpc.md 5.37).
  'group.join': { fields: { group: req(isKey), community: opt(isKey) }, mutating: true },
  'group.leave': { fields: { group: req(isKey) }, mutating: true },
  'group.post': {
    fields: { group: req(isKey), text: req(str(0, L.MAX_TEXT)), replyTo: opt(isGroupRef), fwd: opt(int(0, 1), 0), media: opt(isGroupMediaList), card: opt((v) => isGroupCard(v, false) || isGroupCard(v, true)), sealed: opt(isBool) },
    mutating: true,
    cross: (given, value) => {
      if (value.sealed === true && !hasOwn(value, 'media') && !hasOwn(value, 'card')) return 'parâmetro inválido: sealed'
      if (value.media && !value.media.every((item) => (item.mime === 'application/octet-stream') === (value.sealed === true))) return 'parâmetro inválido: media'
      if (value.card && !isGroupCard(value.card, value.sealed === true)) return 'parâmetro inválido: card'
      return postCross(given, value)
    }
  },
  'group.read': {
    fields: {
      group: req(isKey),
      limit: opt(int(1, L.GROUP_LIMIT_MAX), L.GROUP_LIMIT_DEFAULT),
      // Exclusive group-order cursor; absent = the newest page.
      before: opt(isGroupCursor)
    }
  },
  // Idempotent local mark like dm.seen. Result { ok: true }: writes no diary,
  // never goes to peers; the client re-reads community.info. upTo is optional,
  // the shape of group.read's before (5.40) but inclusive: the newest post the
  // screen painted, and the mark is that post. Absent, the node marks the newest
  // readable post. Not named before because group.read's before is exclusive.
  'group.seen': { fields: { group: req(isKey), upTo: opt(isGroupCursor) } },
  'group.list': {
    fields: {
      offset: opt(int(0, Number.MAX_SAFE_INTEGER), 0),
      limit: opt(int(1, L.GROUP_LIMIT_MAX), L.GROUP_LIMIT_DEFAULT)
    }
  },
  // Result adds memberInvite: boolean, whether plain members may invite
  // (docs/rpc.md 5.71); false on pending objects.
  'group.info': { fields: { group: req(isKey) } },
  'group.members': {
    fields: {
      group: req(isKey),
      offset: opt(int(0, Number.MAX_SAFE_INTEGER), 0),
      limit: opt(int(1, L.GROUP_MEMBERS_LIMIT_MAX), L.GROUP_MEMBERS_LIMIT_MAX)
    }
  },
  'group.requests': {
    fields: {
      group: req(isKey),
      offset: opt(int(0, Number.MAX_SAFE_INTEGER), 0),
      limit: opt(int(1, L.GROUP_MEMBERS_LIMIT_MAX), L.GROUP_MEMBERS_LIMIT_MAX)
    }
  },
  'group.admit': { fields: { group: req(isKey), member: req(isKey), on: req(isBool) }, mutating: true },
  'group.ban': { fields: { group: req(isKey), member: req(isKey), on: req(isBool) }, mutating: true },
  'group.admin': { fields: { group: req(isKey), member: req(isKey), on: req(isBool) }, mutating: true },
  // Private groups (docs/rpc.md 5.61): a new epoch key for the group, never returned.
  'group.rekey': { fields: { group: req(isKey) }, mutating: true },
  'group.hide': { fields: { group: req(isKey), target: req(isGroupRef), on: req(isBool) }, mutating: true },
  // Communities (docs/rpc.md 5.57 to 5.70): hold the groups, named by their root key.
  // community.link was removed in protocol v2 (docs/rpc.md 5.58): an unknown method.
  'community.create': { fields: { name: req(str(1, L.MAX_GROUP_NAME)), join: req(isGroupJoin) }, mutating: true },
  // Success: { community, name, join, creator, role, state, members, admins,
  // groups, general, incomplete, leavePending: boolean, repair: boolean,
  // dropped: [group key], memberInvite: boolean }. memberInvite is whether
  // plain members may invite (docs/rpc.md 5.72); false on pending objects.
  // leavePending is true only for C's creator whose own leave, noted by this
  // device, is written but not confirmed by the diary yet: community.leave
  // finishes it. repair is true only for C's creator whose root's powers
  // ended (cwDemote) and who writes through a live CW: community.meta then
  // goes through that CW and community.removeGroup is open. dropped lists
  // the groups currently taken off C's catalogue (sorted keys, never Geral),
  // which community.removeGroup with undo puts back. Every groups row also
  // has last: null | { name: string|null, username: string|null, preview:
  // string, at: canonical ISO, mine: boolean, hidden: boolean } and unread:
  // integer 0..99 (99 means 99 or more). preview is raw peer text cut to 140
  // code points with Array.from (nothing appended), '' when hidden.
  'community.info': { fields: { community: req(isKey) } },
  'community.list': { fields: none },
  'community.admin': { fields: { community: req(isKey), member: req(isKey), on: req(isBool) }, mutating: true },
  'community.join': { fields: { community: req(isKey) }, mutating: true },
  // force: C's creator leaves even with group roots its diary bound not held
  // here yet; those roots stay unmarked (docs/rpc.md 5.64).
  'community.leave': { fields: { community: req(isKey), force: opt(isLeaveForce, false) }, mutating: true },
  'community.members': {
    fields: {
      community: req(isKey),
      offset: opt(int(0, Number.MAX_SAFE_INTEGER), 0),
      limit: opt(int(1, L.GROUP_MEMBERS_LIMIT_MAX), L.GROUP_MEMBERS_LIMIT_MAX)
    }
  },
  'community.requests': {
    fields: {
      community: req(isKey),
      offset: opt(int(0, Number.MAX_SAFE_INTEGER), 0),
      limit: opt(int(1, L.GROUP_MEMBERS_LIMIT_MAX), L.GROUP_MEMBERS_LIMIT_MAX)
    }
  },
  'community.admit': { fields: { community: req(isKey), member: req(isKey), on: req(isBool) }, mutating: true },
  'community.ban': { fields: { community: req(isKey), member: req(isKey), on: req(isBool) }, mutating: true },
  'community.meta': {
    fields: { community: req(isKey), name: opt(str(1, L.MAX_GROUP_NAME)), join: opt(isGroupJoin) },
    mutating: true,
    cross (given, value) {
      if (!hasOwn(value, 'name') && !hasOwn(value, 'join')) return 'nada a alterar'
      return null
    }
  },
  // C's creator, back after its root's powers ended, takes a group off C's
  // catalogue through its CW (docs/rpc.md 5.70). Geral never leaves. undo:
  // puts a group it dropped back. Success: { ok: true }.
  'community.removeGroup': { fields: { community: req(isKey), group: req(isKey), undo: opt(isBool, false) }, mutating: true },
  // "Membros podem convidar" (docs/rpc.md 5.71, 5.72). Success: { ok: true }.
  // The same-value check is the node's.
  'group.invitePolicy': { fields: { group: req(isKey), members: req(isBool) }, mutating: true },
  'community.invitePolicy': { fields: { community: req(isKey), members: req(isBool) }, mutating: true },
  // Conversas, browser node only (docs/rpc.md 5.73 to 5.81, 5.88). dm.pull and
  // dm.seen write only local state and must survive an uncertain answer, so
  // they are not mutating: the client may repeat them.
  'dm.enable': { fields: none, mutating: true },
  'dm.lookup': { fields: { member: req(isKey) } },
  // With media the text may be empty, as postCross; the sealed frame's own
  // budget (buildInner, 'mensagem longa demais') is the node's check.
  'dm.send': {
    fields: { to: req(isKey), text: req(str(0, L.MAX_TEXT)), replyTo: opt(isDmId), fwd: opt(int(0, 1), 0), media: opt(isDmMediaList), card: opt(isDmCard) },
    mutating: true,
    cross: postCross
  },
  'dm.pull': { fields: none },
  'dm.list': {
    fields: {
      folder: opt(isDmFolder, 'inbox'),
      limit: opt(int(1, DM_LIST_LIMIT_MAX), DM_LIST_LIMIT_DEFAULT),
      before: opt(isDmListCursor)
    }
  },
  'dm.thread': { fields: { peer: req(isKey), before: opt(isDmId), limit: opt(int(1, L.DM_THREAD_LIMIT_MAX), L.DM_THREAD_LIMIT_DEFAULT) } },
  'dm.set': { fields: { peer: req(isKey), state: req(isDmState) }, mutating: true },
  'dm.seen': { fields: { peer: req(isKey) } },
  // The node fills in member and association and hashes text and quote; the
  // quote is the chosen message as this device decrypted it, which no one
  // can verify. target is the sender's diary key, never its signature.
  // `anexo` is the hex SHA-256 of an attached image (the node signs the
  // digest, never the bytes); only with it may the quote be empty (a
  // media-only message).
  'dm.reportSign': {
    fields: {
      nonce: req(isNonce),
      target: req(isKey),
      reason: req(isReason),
      text: opt(str(0, REPORT_TEXT_MAX), ''),
      quote: req(str(0, L.MAX_TEXT)),
      anexo: opt(isKey)
    },
    cross (given, value) {
      if (value.quote === '' && !hasOwn(value, 'anexo')) return 'parâmetro inválido: quote'
      return null
    }
  },
  // Páginas (docs/rpc.md 5.84 to 5.87). page.sign signs a page statement or
  // a page record and appends nothing; the node fills in member, actor and
  // association, so a caller never chooses the bytes. The exact op of each
  // record action is the node's check.
  'page.sign': {
    fields: {
      action: req(isPageAction),
      nonce: req(isNonce),
      page: req(isPagePage),
      op: req(isPageOp)
    },
    cross (given, value) {
      if (value.page === '' && !PAGE_PAGELESS.includes(value.action)) return 'parâmetro inválido: page'
      if (value.action === 'offer' && !isPageOfferPair(value.op)) return 'parâmetro inválido: op'
      return null
    }
  },
  'page.read': { fields: { key: req(isKey), full: opt(isBool, false) } },
  // Browser node only. A page of feed.read rows over the page's follows; a
  // larger limit would not fit MAX_MESSAGE (FEED_LIMIT_MAX, test/sizes.test.js).
  'page.feed': {
    fields: {
      page: req(isKey),
      keys: req(isPageFeedKeys),
      limit: opt(int(1, L.FEED_LIMIT_MAX), L.FEED_LIMIT_DEFAULT)
    }
  },
  // Core node only: the Ed25519 delegate a core diary signs pages with.
  'page.register': { fields: none, mutating: true },
  'seen.sign': { fields: { nonce: req(isNonce), action: req(isSeenAction) } },
  // Idempotent local store, like group.seen.
  'seen.merge': {
    fields: { blob: req(isSeenBlob), avisos: req(isSeenAvisos), unchanged: req(isBool) },
    cross (given, value) {
      return value.unchanged && value.blob !== null ? 'unchanged só com blob nulo' : null
    }
  },
  'group.meta': {
    fields: { group: req(isKey), name: opt(str(1, L.MAX_GROUP_NAME)), join: opt(isGroupJoin) },
    mutating: true,
    cross (given, value) {
      if (!hasOwn(value, 'name') && !hasOwn(value, 'join')) return 'nada a alterar'
      return null
    }
  },
  'sync.start': {
    fields: {
      once: opt(isBool, false),
      timeoutMs: opt(int(L.SYNC_TIMEOUT_MIN, L.SYNC_TIMEOUT_MAX))
    },
    mutating: true,
    cross (given, value) {
      if (hasOwn(given, 'timeoutMs') && value.once !== true) return 'timeoutMs só com once'
      if (value.once === true && !hasOwn(given, 'timeoutMs')) value.timeoutMs = L.SYNC_TIMEOUT_DEFAULT
      return null
    }
  },
  'sync.stop': { fields: none, mutating: true },
  'sync.status': { fields: none },
  // IPC only: offered by the in-app worklet (apps/app/worklet/main.js), not
  // by the node session or varanda-serve (docs/rpc.md 5.17).
  'node.close': { fields: none, mutating: true },
  // IPC only: offered by the in-app web-node worklet, never by the node
  // session, varanda-serve or the browser page (docs/rpc.md 5.50 to 5.56).
  // `prf` never appears in a result, an event or a log.
  'identity.install': {
    fields: {
      prf: req(isPrf),
      credentialId: req(isCredentialId),
      userId: req(isUserId),
      rpId: req(str(1, 253)),
      resumed: req(isBool)
    },
    mutating: true
  },
  'identity.clear': { fields: none, mutating: true },
  'identity.status': { fields: none },
  'identity.reset': { fields: none, mutating: true },
  'identity.forget': { fields: none, mutating: true },
  // Only after the host durably stored the session of a non-resumed install:
  // it lifts the signedOut barrier, which the install itself never does.
  'identity.sessionSaved': { fields: none, mutating: true },
  // IPC only, in-app web-node worklet (docs/rpc.md 5.91 to 5.94). None
  // changes a diary; lookup, open and wrap change no stored state (open
  // consumes the pending wrap key), so they are not mutating; recoveryBind
  // rewrites the kv passkey record and is. Only recoveryOpen's `prf` and
  // recoveryWrap's `code` (kind code) carry a secret back; no error or log
  // names one.
  'identity.recoveryLookup': {
    fields: {
      kind: req(isRecoveryKind),
      secret: opt(isPrf),
      code: opt(str(1, RECOVERY_CODE_MAX))
    },
    cross (given, value) {
      const m = recoverySecretCross(given, value)
      if (m !== null) return m
      if (value.kind === 'code' && !hasOwn(given, 'code')) return 'parâmetro obrigatório: code'
      return null
    }
  },
  'identity.recoveryOpen': {
    fields: {
      blob: req(isRecoveryBlob),
      member: req(isKey)
    }
  },
  'identity.recoveryWrap': {
    fields: {
      kind: req(isRecoveryKind),
      secret: opt(isPrf)
    },
    cross: recoverySecretCross
  },
  // Rebinds the worklet's stored passkey record to a new credential while it
  // is unlocked and holds the root.
  // Rewrites the kv passkey record: mutating like identity.install, so a
  // failed call reports an unknown outcome instead of being retried blindly.
  // userId: the recovery passkey's wrap-marked user id, never '' (the
  // worklet checks the mark itself).
  'identity.recoveryBind': {
    fields: {
      credentialId: req(isCredentialId),
      userId: req(isKey)
    },
    mutating: true
  },
  'media.uploadFile': {
    fields: {
      name: req(isMediaName),
      mime: req(isUploadMime),
      width: req(int(0, MEDIA_SIDE_MAX)),
      height: req(int(0, MEDIA_SIDE_MAX)),
      kind: opt((v) => v === 'voice'),
      ms: opt(int(1, MAX_AUDIO_MS)),
      sealed: opt(isBool)
    },
    mutating: true,
    cross: mediaUploadCross
  },
  // IPC only, in-app web-node worklet (docs/rpc.md 5.88): the photo of a
  // chat goes to the anonymous blob channel (protocol section 13) from a
  // cache file, as media.uploadFile; the result is a dm.send media item. On
  // the web the bytes never cross RPC (MAX_REQUEST): the page hands them to
  // the node's media facade instead. `to` (5.97, required) keys the sealed
  // blob to one destination, so the same photo for two conversations never
  // shares a blob, and dm.send refuses the item for any other destination.
  'dm.putMedia': {
    fields: {
      name: req(isMediaName),
      to: req(isKey),
      mime: req(isUploadMime),
      width: req(int(0, MEDIA_SIDE_MAX)),
      height: req(int(0, MEDIA_SIDE_MAX)),
      kind: opt((v) => v === 'voice'),
      ms: opt(int(1, MAX_AUDIO_MS))
    },
    mutating: true,
    cross: mediaUploadCross
  },
  // IPC only, in-app web-node worklet (docs/rpc.md 5.89): the opened image
  // of a chat item is written to a file in the worklet's read directory and
  // only its name comes back, since a photo is far above MAX_MESSAGE. A DM
  // item is { kind: 'dm', from, id, index }, a private group item
  // { kind: 'group', diary, item }. Not mutating: it changes no diary.
  'media.readFile': {
    fields: {
      kind: req((v) => v === 'dm' || v === 'group'),
      from: opt(isKey),
      id: opt(isDmId),
      index: opt((v) => v === 'card' || int(0, L.MAX_DM_MEDIA - 1)(v)),
      diary: opt(isKey),
      item: opt(isPrivateGroupMediaItem)
    },
    cross (given) {
      const dm = ['from', 'id', 'index']
      const group = ['diary', 'item']
      const want = given.kind === 'dm' ? dm : group
      const other = given.kind === 'dm' ? group : dm
      for (const k of want) if (!hasOwn(given, k)) return 'parâmetro obrigatório: ' + k
      for (const k of other) if (hasOwn(given, k)) return 'parâmetro desconhecido'
      return null
    }
  }
}

const METHODS = Object.freeze(Object.keys(SPECS))
const MUTATING = Object.freeze(METHODS.filter((m) => SPECS[m].mutating === true))

function isMethod (method) {
  return typeof method === 'string' && hasOwn(SPECS, method)
}

function isMutating (method) {
  return MUTATING.includes(method)
}

function fail (message) {
  return { ok: false, code: 'USAGE', message }
}

// Validates the params of a known method and returns a fresh normalized
// copy (defaults filled in). Messages name the field, never echo a value.
// Never throws.
function validateParams (method, params) {
  try {
    if (!isMethod(method)) return fail('método desconhecido')
    if (!isPlainObject(params)) return fail('params inválidos')
    const spec = SPECS[method]
    for (const key of Object.keys(params)) {
      if (!hasOwn(spec.fields, key)) return fail('parâmetro desconhecido')
    }
    const value = {}
    for (const name of Object.keys(spec.fields)) {
      const field = spec.fields[name]
      if (!hasOwn(params, name)) {
        if (!field.optional) return fail('parâmetro obrigatório: ' + name)
        if (field.fallback !== undefined) value[name] = field.fallback
        continue
      }
      const v = params[name]
      if (!field.check(v)) return fail('parâmetro inválido: ' + name)
      value[name] = v
    }
    if (spec.cross) {
      const message = spec.cross(params, value)
      if (message !== null) return fail(message)
    }
    return { ok: true, value }
  } catch {
    return fail('params inválidos')
  }
}

module.exports = {
  METHODS,
  MUTATING,
  isMethod,
  isMutating,
  validateParams,
  isPlainObject,
  hasOwn,
  isId,
  isKey,
  isRef,
  PAGE_READ_FOLLOWS_MAX,
  PAGE_READ_LINKS_MAX
}
