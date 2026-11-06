'use strict'

// Direct messages (docs/protocol.md section 11): the signed inner
// plaintext, its crypto_box_seal envelope and the fixed-size drop frame.
// Building throws on a programming error; opening never throws, since
// everything it reads comes from a peer, and returns null on any failure.
// Every size is fixed so a drop says nothing about its text.
//
// No node:crypto: core also runs on Bare. The group sealTo/openFrom pair
// caps plaintext at 1024 bytes, so this module seals on its own.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { hasExactKeys, isHex64, isCanonicalIso, hasControlChars, charLength, nowIso, AUDIO_MIME, MAX_AUDIO_MS, MAX_AUDIO_BYTES } = require('./records')
const { isWeakBoxKey } = require('./group')
const { certForKey, validateCertShape } = require('./cert')
const { validateBlobDescriptor, BLOB_MAC_BYTES } = require('./blob')
const rpc = require('@varanda/rpc')
const { validLinkCard, validCardImageBytes, CARD_IMAGE_MIME } = require('./link-card')

const DM_PROTOCOL = 'varanda/dm/1'
const DM_STAMP_PROTOCOL = 'varanda/dm-stamp/1'
const DM_MAX_TEXT = 1000
// Sized for DM_MAX_TEXT code points of 4-byte characters plus the sender's
// membership certificate (a v2 one is the largest, about 700 bytes).
const DM_INNER_BYTES = 5120
const DM_SEAL_BYTES = 48
const DM_SEALED_BYTES = DM_INNER_BYTES + DM_SEAL_BYTES
const DM_MAGIC = 'VDM1'
const DM_VERSION = 1
const DM_RETENTION_MS = 7 * 86400000
const DM_POOL_MAX = 20000
// One page of base64 drops inside JSON must stay under DM_MAX_MESSAGE.
const DM_PAGE_MAX = 8
const DM_PULL_BUDGET_BYTES = 8388608
const DM_MAX_MESSAGE = 65536
const DM_STAMPS_PER_DAY = 200
const DM_STAMP_WALLET = 20
const DM_STAMP_WALLET_LOW = 10
const DM_REQUESTS_MAX = 100
const DM_MESSAGES_PER_PEER = 500
const DM_SIG_PREFIX = 'varanda-dm-v1\n'
const DM_SIG_PREFIX_V2 = 'varanda-dm-v2\n'
const DM_KEY_HKDF_SALT = 'varanda/member-dm-box/hkdf/v1'
const DM_KEY_HKDF_INFO = 'varanda/member-dm-box/x25519/v1'
const DM_LOCAL_HKDF_SALT = 'varanda/member-dm-local/hkdf/v1'
const DM_LOCAL_HKDF_INFO = 'varanda/member-dm-local/secretbox/v1'
const DM_STAMP_FDH_DOMAIN = 'varanda/dm-stamp-fdh/v1'

const DROP_MAGIC_OFFSET = 0
const DROP_VERSION_OFFSET = 4
const DROP_ID_OFFSET = 5
const DROP_KID_OFFSET = 37
const DROP_SIG_OFFSET = 45
const DROP_TOKEN_OFFSET = 301
const DROP_SEALED_OFFSET = 333
const DROP_MAGIC_BYTES = 4
const DROP_VERSION_BYTES = 1
const DROP_ID_BYTES = 32
const DROP_KID_BYTES = 8
const DROP_SIG_BYTES = 256
const DROP_TOKEN_BYTES = 32
const DM_DROP_BYTES = DROP_SEALED_OFFSET + DM_SEALED_BYTES
// The largest `items` message: DM_PAGE_MAX base64 drops with their seq.
const DROP_BASE64_BYTES = Math.ceil(DM_DROP_BYTES / 3) * 4
if (DM_PAGE_MAX * (DROP_BASE64_BYTES + 64) + 128 > DM_MAX_MESSAGE) throw new Error('DM_PAGE_MAX too large')

const DM_KINDS = Object.freeze(['msg', 'ctl'])
const DM_OPS = Object.freeze(['accepted', 'declined', 'blocked', 'unblocked', 'deleted'])
// Insertion order is the wire order: the signature covers the exact bytes.
// The lists and the canonical JSON live in @varanda/rpc so a UI measures
// the text budget with the very bytes signed here.
const INNER_KEYS = rpc.DM_INNER_KEYS
const INNER_KEYS_V2 = rpc.DM_INNER_KEYS_V2
const DM_MEDIA_KEYS = rpc.DM_MEDIA_KEYS
const BLOB_KEYS = Object.freeze(['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256'])
const DM_MEDIA_MAX = 4
const DM_MEDIA_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const DM_MEDIA_MAX_SIDE = 16384
// A voice note: the only item of its message. Its blob is the sealed file,
// so `bytes` adds the MAC to the plaintext cap that group posts share.
const DM_AUDIO_MIME = AUDIO_MIME
const DM_AUDIO_MAX_MS = MAX_AUDIO_MS
const DM_AUDIO_MAX_BYTES = MAX_AUDIO_BYTES + BLOB_MAC_BYTES

const SIG_BYTES = 64
const LEN_BYTES = 2
const SIG_PREFIX = b4a.from(DM_SIG_PREFIX, 'utf8')
const SIG_PREFIX_V2 = b4a.from(DM_SIG_PREFIX_V2, 'utf8')
const MAGIC = b4a.from(DM_MAGIC, 'ascii')
const HEX32 = /^[0-9a-f]{32}$/

function isBytes (x, len) {
  return x instanceof Uint8Array && (len === undefined || x.byteLength === len)
}

function isPlainObject (x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function isHex32 (s) {
  return typeof s === 'string' && HEX32.test(s)
}

// String.prototype.isWellFormed, spelled out for runtimes without it
// (same rule as lib/report.js).
function isWellFormed (s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (d < 0xdc00 || d > 0xdfff) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

function randomBytes (n) {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

function newMessageId () {
  return b4a.toString(randomBytes(16), 'hex')
}

function newDropId () {
  return randomBytes(DROP_ID_BYTES)
}

function validText (text, allowEmpty) {
  if (typeof text !== 'string' || !isWellFormed(text)) return false
  const n = charLength(text)
  return n >= (allowEmpty ? 0 : 1) && n <= DM_MAX_TEXT && !hasControlChars(text, true)
}

function isSide (n) {
  return Number.isInteger(n) && n >= 1 && n <= DM_MEDIA_MAX_SIDE
}

// A blob descriptor (docs/protocol.md section 13) plus what the bubble needs
// before the bytes arrive: a still image has sides and ms 0, a voice note no
// sides and its duration. Its bytes are checked once they arrive (rpc
// audioBounds), since the mime alone is not trusted.
function validMediaItem (d) {
  if (!isPlainObject(d) || !hasExactKeys(d, DM_MEDIA_KEYS)) return false
  const blob = {}
  for (const k of BLOB_KEYS) blob[k] = d[k]
  if (!validateBlobDescriptor(blob)) return false
  if (d.mime === DM_AUDIO_MIME) {
    return d.w === 0 && d.h === 0 && Number.isInteger(d.ms) && d.ms >= 1 && d.ms <= DM_AUDIO_MAX_MS && d.bytes <= DM_AUDIO_MAX_BYTES
  }
  return DM_MEDIA_MIMES.includes(d.mime) && isSide(d.w) && isSide(d.h) && d.ms === 0
}

// Walked by index: Array#every skips holes, and a sparse list would be
// signed with a null item that no reader can open.
function validMedia (media) {
  if (!Array.isArray(media) || media.length < 1 || media.length > DM_MEDIA_MAX) return false
  const ids = new Set()
  for (let i = 0; i < media.length; i++) {
    if (!Object.hasOwn(media, i) || !validMediaItem(media[i]) || ids.has(media[i].id)) return false
    if (media[i].mime === DM_AUDIO_MIME && media.length !== 1) return false
    ids.add(media[i].id)
  }
  return true
}

// A link card's thumbnail: a still JPEG media item of at most
// MAX_CARD_IMAGE_BYTES sealed bytes. Never throws (validMediaItem reads
// every key inside its own checks, and validLinkCard catches).
function validCardImage (d) {
  return validMediaItem(d) && d.mime === CARD_IMAGE_MIME && validCardImageBytes(d.bytes)
}

function validDmCard (card) {
  return validLinkCard(card, validCardImage)
}

// The per-kind shape rules, shared by building and opening. `cert` is null
// or a membership certificate naming `from`; whether it verifies for the
// association is checked on open only. v1 and v2 are two exact key sets.
// v2 is only a msg that needs it (media, a link card, or a forward), so a
// plain text message stays v1 and every message has one encoding. A card
// goes with text only: a message with media carries card null.
function validBody (b) {
  if (!isPlainObject(b)) return false
  if (b.v === 1) {
    if (!hasExactKeys(b, INNER_KEYS)) return false
  } else if (b.v === 2) {
    if (!hasExactKeys(b, INNER_KEYS_V2) || b.kind !== 'msg') return false
    // A boolean is another JSON type, so it must not count as forwarded.
    if (b.fwd !== 0 && b.fwd !== 1) return false
    if (b.card !== null && (b.media !== null || !validDmCard(b.card))) return false
    // Null media is a card or the text forward. Neither of the three is a v1 message.
    if (b.media === null ? b.fwd !== 1 && b.card === null : !validMedia(b.media)) return false
  } else {
    return false
  }
  if (!DM_KINDS.includes(b.kind)) return false
  if (!isHex32(b.id) || !isHex64(b.from) || !isHex64(b.to) || !isCanonicalIso(b.at)) return false
  if (b.cert !== null && (validateCertShape(b.cert) !== null || b.cert.member !== b.from)) return false
  if (b.kind === 'msg') {
    if (b.op !== null || b.peer !== null || b.from === b.to) return false
    if (b.replyTo !== null && !isHex32(b.replyTo)) return false
    // Empty text is a photo with no caption, not a text-only forward.
    return validText(b.text, b.v === 2 && b.media !== null)
  }
  if (b.text !== '' || b.replyTo !== null || b.from !== b.to) return false
  return DM_OPS.includes(b.op) && isHex64(b.peer) && b.peer !== b.from
}

function canonicalJson (b) {
  return rpc.canonicalDmInnerJson(b)
}

function sigPrefix (v) {
  return v === 2 ? SIG_PREFIX_V2 : SIG_PREFIX
}

// The text bytes (rpc dmTextBytes) that still fit next to the given cert,
// media and card; below zero nothing fits. buildInner stays the authority.
function textBudget (fields) {
  return rpc.dmTextBudget(fields)
}

// fields: { kind, to, text?, replyTo?, media?, card?, fwd?, op?, peer?, id?,
// at?, cert? }; from is the signing key; cert is the sender's membership
// certificate (a msg without one is built but never opens). A body that
// needs nothing of v2 is written as v1. Returns DM_INNER_BYTES bytes the
// caller owns (wipe after sealing).
function buildInner (fields, signKeyPair) {
  if (!isPlainObject(fields)) throw new TypeError('mensagem inválida')
  if (!isPlainObject(signKeyPair) || !isBytes(signKeyPair.publicKey, 32) || !isBytes(signKeyPair.secretKey, 64)) {
    throw new TypeError('chave de assinatura inválida')
  }
  const from = b4a.toString(signKeyPair.publicKey, 'hex')
  if (fields.from !== undefined && fields.from !== from) throw new TypeError('mensagem inválida')
  const kind = fields.kind
  const media = fields.media === undefined ? null : fields.media
  const card = fields.card === undefined ? null : fields.card
  const fwd = fields.fwd === undefined ? 0 : fields.fwd
  const v = rpc.dmInnerVersion({ media, card, fwd })
  const body = {
    v,
    kind,
    id: fields.id === undefined ? newMessageId() : fields.id,
    from,
    to: kind === 'ctl' && fields.to === undefined ? from : fields.to,
    replyTo: fields.replyTo === undefined ? null : fields.replyTo,
    text: fields.text === undefined && kind === 'ctl' ? '' : fields.text,
    op: fields.op === undefined ? null : fields.op,
    peer: fields.peer === undefined ? null : fields.peer,
    at: fields.at === undefined ? nowIso() : fields.at,
    cert: fields.cert === undefined ? null : fields.cert
  }
  if (v === 2) {
    body.media = media
    body.card = card
    body.fwd = fwd
  }
  if (!validBody(body)) throw new TypeError('mensagem inválida')
  const json = b4a.from(canonicalJson(body), 'utf8')
  if (json.byteLength + LEN_BYTES + SIG_BYTES > DM_INNER_BYTES) throw new TypeError('mensagem longa demais')
  const sig = hcrypto.sign(b4a.concat([sigPrefix(v), json]), signKeyPair.secretKey)
  const out = b4a.alloc(DM_INNER_BYTES)
  out[0] = json.byteLength >>> 8
  out[1] = json.byteLength & 0xff
  out.set(json, LEN_BYTES)
  out.set(sig, LEN_BYTES + json.byteLength)
  sodium.sodium_memzero(json)
  return out
}

// Reads and then zeroes buf (the plaintext from openSealed). Returns the
// body with `mine` (true when this identity wrote it) or null. opts:
// { association (hex64, required for a msg), revokedIssuers? (a Set, as in
// cert.js verifyCert) }. A msg must carry a certificate of that association
// for `from`, so one member cannot write from throwaway keys.
function openInner (buf, ownKey, opts = {}) {
  let json = null
  try {
    if (!isBytes(buf, DM_INNER_BYTES) || !isHex64(ownKey)) return null
    const { association, revokedIssuers } = isPlainObject(opts) ? opts : {}
    const len = (buf[0] << 8) | buf[1]
    if (len < 2 || len + LEN_BYTES + SIG_BYTES > DM_INNER_BYTES) return null
    for (let i = LEN_BYTES + len + SIG_BYTES; i < DM_INNER_BYTES; i++) {
      if (buf[i] !== 0) return null
    }
    json = b4a.from(buf.subarray(LEN_BYTES, LEN_BYTES + len))
    const sig = b4a.from(buf.subarray(LEN_BYTES + len, LEN_BYTES + len + SIG_BYTES))
    const text = b4a.toString(json, 'utf8')
    const body = JSON.parse(text)
    if (!validBody(body)) return null
    // The exact bytes are signed: a reordered or re-escaped JSON is refused.
    if (canonicalJson(body) !== text) return null
    if (!hcrypto.verify(b4a.concat([sigPrefix(body.v), json]), sig, b4a.from(body.from, 'hex'))) return null
    if (body.kind === 'ctl') {
      if (body.from !== ownKey) return null
      return { ...body, mine: true }
    }
    if (!isHex64(association) || body.cert === null) return null
    if (!certForKey(body.cert, body.from, association, { revokedIssuers }).ok) return null
    if (body.to === ownKey) return { ...body, mine: false }
    if (body.from === ownKey) return { ...body, mine: true }
    return null
  } catch {
    return null
  } finally {
    if (json !== null) sodium.sodium_memzero(json)
    if (isBytes(buf)) sodium.sodium_memzero(buf)
  }
}

function boxPublicKey (hex) {
  if (!isHex64(hex) || isWeakBoxKey(hex)) throw new TypeError('chave de caixa inválida')
  return b4a.from(hex, 'hex')
}

function sealInner (inner, recipientBoxPkHex) {
  if (!isBytes(inner, DM_INNER_BYTES)) throw new TypeError('inner must be ' + DM_INNER_BYTES + ' bytes')
  const pk = boxPublicKey(recipientBoxPkHex)
  const sealed = b4a.alloc(DM_SEALED_BYTES)
  sodium.crypto_box_seal(sealed, inner, pk)
  return sealed
}

// Returns the inner plaintext (caller-owned) or null.
function openSealed (sealed, boxKeyPair) {
  let out = null
  try {
    if (!isBytes(sealed, DM_SEALED_BYTES) || !isPlainObject(boxKeyPair)) return null
    const { publicKey, secretKey } = boxKeyPair
    if (!isBytes(publicKey, sodium.crypto_box_PUBLICKEYBYTES) || !isBytes(secretKey, sodium.crypto_box_SECRETKEYBYTES)) return null
    if (isWeakBoxKey(b4a.toString(publicKey, 'hex'))) return null
    out = b4a.alloc(DM_INNER_BYTES)
    if (!sodium.crypto_box_seal_open(out, sealed, publicKey, secretKey)) {
      sodium.sodium_memzero(out)
      return null
    }
    return out
  } catch {
    if (out !== null) sodium.sodium_memzero(out)
    return null
  }
}

function encodeDrop ({ dropId, kid, rsaSig, token, sealed } = {}) {
  if (!isBytes(dropId, DROP_ID_BYTES)) throw new TypeError('dropId must be ' + DROP_ID_BYTES + ' bytes')
  if (!isBytes(kid, DROP_KID_BYTES)) throw new TypeError('kid must be ' + DROP_KID_BYTES + ' bytes')
  if (!isBytes(rsaSig, DROP_SIG_BYTES)) throw new TypeError('rsaSig must be ' + DROP_SIG_BYTES + ' bytes')
  if (!isBytes(token, DROP_TOKEN_BYTES)) throw new TypeError('token must be ' + DROP_TOKEN_BYTES + ' bytes')
  if (!isBytes(sealed, DM_SEALED_BYTES)) throw new TypeError('sealed must be ' + DM_SEALED_BYTES + ' bytes')
  const out = b4a.alloc(DM_DROP_BYTES)
  out.set(MAGIC, DROP_MAGIC_OFFSET)
  out[DROP_VERSION_OFFSET] = DM_VERSION
  out.set(dropId, DROP_ID_OFFSET)
  out.set(kid, DROP_KID_OFFSET)
  out.set(rsaSig, DROP_SIG_OFFSET)
  out.set(token, DROP_TOKEN_OFFSET)
  out.set(sealed, DROP_SEALED_OFFSET)
  return out
}

// Copies, never views: the caller may reuse the frame buffer.
function decodeDrop (buf) {
  try {
    if (!isBytes(buf, DM_DROP_BYTES)) return null
    if (!b4a.equals(buf.subarray(DROP_MAGIC_OFFSET, DROP_MAGIC_OFFSET + DROP_MAGIC_BYTES), MAGIC)) return null
    if (buf[DROP_VERSION_OFFSET] !== DM_VERSION) return null
    const part = (offset, len) => b4a.from(buf.subarray(offset, offset + len))
    return {
      dropId: part(DROP_ID_OFFSET, DROP_ID_BYTES),
      kid: part(DROP_KID_OFFSET, DROP_KID_BYTES),
      rsaSig: part(DROP_SIG_OFFSET, DROP_SIG_BYTES),
      token: part(DROP_TOKEN_OFFSET, DROP_TOKEN_BYTES),
      sealed: part(DROP_SEALED_OFFSET, DM_SEALED_BYTES)
    }
  } catch {
    return null
  }
}

module.exports = Object.freeze({
  DM_PROTOCOL,
  DM_STAMP_PROTOCOL,
  DM_MAX_TEXT,
  DM_INNER_BYTES,
  DM_SEAL_BYTES,
  DM_SEALED_BYTES,
  DM_DROP_BYTES,
  DM_MAGIC,
  DM_VERSION,
  DM_RETENTION_MS,
  DM_POOL_MAX,
  DM_PAGE_MAX,
  DM_PULL_BUDGET_BYTES,
  DM_MAX_MESSAGE,
  DM_STAMPS_PER_DAY,
  DM_STAMP_WALLET,
  DM_STAMP_WALLET_LOW,
  DM_REQUESTS_MAX,
  DM_MESSAGES_PER_PEER,
  DM_SIG_PREFIX,
  DM_SIG_PREFIX_V2,
  DM_KEY_HKDF_SALT,
  DM_KEY_HKDF_INFO,
  DM_LOCAL_HKDF_SALT,
  DM_LOCAL_HKDF_INFO,
  DM_STAMP_FDH_DOMAIN,
  DM_KINDS,
  DM_OPS,
  INNER_KEYS,
  INNER_KEYS_V2,
  DM_MEDIA_KEYS,
  DM_MEDIA_MAX,
  DM_MEDIA_MIMES,
  DM_MEDIA_MAX_SIDE,
  validDmCard,
  DM_AUDIO_MIME,
  DM_AUDIO_MAX_MS,
  DM_AUDIO_MAX_BYTES,
  DROP: Object.freeze({
    MAGIC_OFFSET: DROP_MAGIC_OFFSET,
    MAGIC_BYTES: DROP_MAGIC_BYTES,
    VERSION_OFFSET: DROP_VERSION_OFFSET,
    VERSION_BYTES: DROP_VERSION_BYTES,
    ID_OFFSET: DROP_ID_OFFSET,
    ID_BYTES: DROP_ID_BYTES,
    KID_OFFSET: DROP_KID_OFFSET,
    KID_BYTES: DROP_KID_BYTES,
    SIG_OFFSET: DROP_SIG_OFFSET,
    SIG_BYTES: DROP_SIG_BYTES,
    TOKEN_OFFSET: DROP_TOKEN_OFFSET,
    TOKEN_BYTES: DROP_TOKEN_BYTES,
    SEALED_OFFSET: DROP_SEALED_OFFSET,
    SEALED_BYTES: DM_SEALED_BYTES
  }),
  isWellFormed,
  newMessageId,
  newDropId,
  textBudget,
  buildInner,
  openInner,
  sealInner,
  openSealed,
  encodeDrop,
  decodeDrop
})
