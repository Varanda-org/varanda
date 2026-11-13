'use strict'

// Group post media (docs/protocol.md section 10, "Group post media"). A
// public group's post points into its writer's media cores with ordinary
// post descriptors (lib/records.js). A private group's item lives in the
// same media cores as secretbox ciphertext under a fresh per-item key and
// nonce; the key, the nonce and what the image is travel only inside the
// group-sealed inner record, so a seeder serving the media core holds bytes
// it cannot open. Retention follows the writer core, like post media: the
// blob pool's sweep (lib/blob-pool.js) never sees these bytes.
//
// A voice note (audio/mp4, records.js validAudioDescriptor) is the only item
// of its post, never next to images. Its bytes are checked with audioBounds
// (@varanda/rpc) when sealed and when opened: the mime alone is not trusted.
//
// The plaintext is padded (0x80 then zeros) so that it fills every block of
// the item: the ciphertext is always blocks * MEDIA_BLOCK_BYTES, and the short
// last block of a plain item, which gives its exact size away, never exists.
//
// sealMedia throws on a programming error; openMedia and the validators never
// throw, since what they read comes from a peer. Zeroing is best effort, as
// in lib/group-crypto.js.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const { audioBounds, AUDIO_MS_TOLERANCE } = require('@varanda/rpc')
const {
  MEDIA_BLOCK_BYTES, MAX_MEDIA_BLOCKS, MAX_MEDIA_ITEM_BLOCKS, MEDIA_MIMES,
  MAX_MEDIA_DIMENSION, DESCRIPTOR_KEYS, AUDIO_DESCRIPTOR_KEYS, AUDIO_MIME, MAX_AUDIO_MS, MAX_AUDIO_BYTES,
  isPlainObject, hasExactKeys, isHex64, validDescriptor, validAudioDescriptor
} = require('./records')

const SEALED_MEDIA_MIME = 'application/octet-stream'
const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES
const MAC_BYTES = sodium.crypto_secretbox_MACBYTES
const PAD_MARK = 0x80
// Not MAX_MEDIA_PER_POST: the sealed inner budget (MAX_SEALED_INNER_BYTES,
// lib/group-crypto.js) was measured for four private items, so this cap
// stays when the public post cap grows. Same value as MAX_GROUP_MEDIA in
// @varanda/rpc.
const MAX_GROUP_MEDIA = 4
// The MAC and at least the pad mark share the item's blocks with the image.
const MAX_SEALED_MEDIA_PLAIN_BYTES = MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES - MAC_BYTES - 1
// Where the ciphertext lives (a post descriptor without the image size,
// which a ciphertext does not have), then the secret and what it hides.
const PRIVATE_ITEM_KEYS = Object.freeze(['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'key', 'nonce', 'plainMime', 'plainSha256', 'w', 'h', 'ms'])
const HEX_NONCE = /^[0-9a-f]{48}$/

function isIntIn (v, min, max) {
  return Number.isSafeInteger(v) && v >= min && v <= max
}

function isBytes (x) {
  return x instanceof Uint8Array
}

function sha256Hex (bytes) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, bytes)
  return b4a.toString(out, 'hex')
}

function wipe (bytes) {
  if (isBytes(bytes)) sodium.sodium_memzero(bytes)
}

// The blocks a padded item of `n` plaintext bytes fills.
function sealedBlocks (n) {
  return Math.ceil((n + 1 + MAC_BYTES) / MEDIA_BLOCK_BYTES)
}

const MAX_AUDIO_SEALED_BLOCKS = sealedBlocks(MAX_AUDIO_BYTES)

// A public item: an ordinary post descriptor (still images) or a voice note
// descriptor. Never throws.
function validPublicItem (d) {
  return validDescriptor(d) || validAudioDescriptor(d)
}

// Picture size and duration of a private item: a still image has sides and
// ms 0, a voice note has no sides and 1..MAX_AUDIO_MS. Never throws.
function validPlainKind (plainMime, w, h, ms) {
  if (plainMime === AUDIO_MIME) return w === 0 && h === 0 && isIntIn(ms, 1, MAX_AUDIO_MS)
  return typeof plainMime === 'string' && MEDIA_MIMES.includes(plainMime) &&
    isIntIn(w, 1, MAX_MEDIA_DIMENSION) && isIntIn(h, 1, MAX_MEDIA_DIMENSION) && ms === 0
}

// A private item, valid only inside a group-sealed inner record. Every block
// is full (the padding). Never throws.
function validPrivateItem (d) {
  try {
    if (!isPlainObject(d) || !hasExactKeys(d, PRIVATE_ITEM_KEYS)) return false
    const { core, mime, start, blocks, bytes, sha256, key, nonce, plainMime, plainSha256, w, h, ms } = d
    return isHex64(core) &&
      mime === SEALED_MEDIA_MIME &&
      isIntIn(start, 1, MAX_MEDIA_BLOCKS - 1) &&
      isIntIn(blocks, 1, MAX_MEDIA_ITEM_BLOCKS) &&
      start + blocks <= MAX_MEDIA_BLOCKS &&
      bytes === blocks * MEDIA_BLOCK_BYTES &&
      isHex64(sha256) &&
      isHex64(key) &&
      typeof nonce === 'string' && HEX_NONCE.test(nonce) &&
      (plainMime !== AUDIO_MIME || blocks <= MAX_AUDIO_SEALED_BLOCKS) &&
      isHex64(plainSha256) &&
      validPlainKind(plainMime, w, h, ms)
  } catch {
    return false
  }
}

// A group post's media: 1..MAX_GROUP_MEDIA items, all private inside a
// sealed inner and all public elsewhere, each at its own place in a media
// core, or one voice note alone. By index, never every(): a hole in a sparse
// array is invalid. Never throws.
function validGroupMedia (media, sealed) {
  try {
    if (!Array.isArray(media) || media.length < 1 || media.length > MAX_GROUP_MEDIA) return false
    const valid = sealed === true ? validPrivateItem : validPublicItem
    const places = new Set()
    for (let i = 0; i < media.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(media, i)) return false
      const d = media[i]
      if (!valid(d)) return false
      if (isAudioItem(d, sealed) && media.length !== 1) return false
      const place = d.core + ':' + d.start
      if (places.has(place)) return false
      places.add(place)
    }
    return true
  } catch {
    return false
  }
}

function isAudioItem (d, sealed) {
  return (sealed === true ? d.plainMime : d.mime) === AUDIO_MIME
}

// A copy with exactly the keys of the expected kind (anything else is
// passed through for validation to reject).
function copyGroupItem (d, sealed) {
  if (!isPlainObject(d)) return d
  const out = {}
  const keys = sealed === true ? PRIVATE_ITEM_KEYS : isAudioItem(d, false) ? AUDIO_DESCRIPTOR_KEYS : DESCRIPTOR_KEYS
  for (const k of keys) out[k] = d[k]
  return out
}

function copyGroupMedia (media, sealed) {
  return Array.isArray(media) ? Array.from(media, (d) => copyGroupItem(d, sealed)) : media
}

// -> { cipher, item }: `cipher` is what the writer appends to its media core
// (exactly item.blocks full blocks); `item` is a private item without `core`
// and `start`, which the caller adds once it knows where the bytes went.
// A voice note's ms is its container's duration: the caller's ms, when
// given, must be within AUDIO_MS_TOLERANCE of it, and the item carries the
// container's.
function sealMedia (plain, { plainMime, w, h, ms } = {}) {
  if (!isBytes(plain) || plain.byteLength < 1 || plain.byteLength > MAX_SEALED_MEDIA_PLAIN_BYTES) {
    throw new TypeError('plain must be 1..' + MAX_SEALED_MEDIA_PLAIN_BYTES + ' bytes')
  }
  if (plainMime === AUDIO_MIME) {
    if (plain.byteLength > MAX_AUDIO_BYTES) throw new TypeError('a voice note must be at most ' + MAX_AUDIO_BYTES + ' bytes')
    if (w !== 0 || h !== 0 || (ms !== undefined && !isIntIn(ms, 1, MAX_AUDIO_MS))) throw new TypeError('a voice note has w and h 0 and ms 1..' + MAX_AUDIO_MS)
    const audio = audioBounds(plain)
    if (audio === null) throw new TypeError('plain is not an audio-only MPEG-4 file')
    if (ms !== undefined && Math.abs(ms - audio.ms) > AUDIO_MS_TOLERANCE) throw new TypeError('ms does not match the voice note duration')
    ms = audio.ms
  } else {
    if (!MEDIA_MIMES.includes(plainMime)) throw new TypeError('plainMime must be a still image type or ' + AUDIO_MIME)
    if (!isIntIn(w, 1, MAX_MEDIA_DIMENSION) || !isIntIn(h, 1, MAX_MEDIA_DIMENSION)) throw new TypeError('w and h must be 1..' + MAX_MEDIA_DIMENSION)
    if (ms !== undefined && ms !== 0) throw new TypeError('ms must be 0')
    ms = 0
  }
  const blocks = sealedBlocks(plain.byteLength)
  const bytes = blocks * MEDIA_BLOCK_BYTES
  const padded = b4a.alloc(bytes - MAC_BYTES)
  const key = b4a.alloc(KEY_BYTES)
  const nonce = b4a.alloc(NONCE_BYTES)
  try {
    padded.set(plain, 0)
    padded[plain.byteLength] = PAD_MARK
    sodium.randombytes_buf(key)
    sodium.randombytes_buf(nonce)
    const cipher = b4a.alloc(bytes)
    sodium.crypto_secretbox_easy(cipher, padded, nonce, key)
    return {
      cipher,
      item: {
        mime: SEALED_MEDIA_MIME,
        blocks,
        bytes,
        sha256: sha256Hex(cipher),
        key: b4a.toString(key, 'hex'),
        nonce: b4a.toString(nonce, 'hex'),
        plainMime,
        plainSha256: sha256Hex(plain),
        w,
        h,
        ms
      }
    }
  } finally {
    wipe(padded)
    wipe(key)
  }
}

// Audio-only bytes in bounds whose container duration is within
// AUDIO_MS_TOLERANCE of the declared ms (a peer's ms is not trusted).
function voiceMatches (plain, ms) {
  if (plain.byteLength > MAX_AUDIO_BYTES) return false
  const audio = audioBounds(plain)
  return audio !== null && Math.abs(ms - audio.ms) <= AUDIO_MS_TOLERANCE
}

// The image or voice note bytes of a private item, or null: the ciphertext must be the
// item's exact bytes and hash, open under its key and nonce, carry a valid
// pad and hash to plainSha256. The caller owns (and may wipe) the result.
function openMedia (cipher, item) {
  let padded = null
  let key = null
  try {
    if (!validPrivateItem(item) || !isBytes(cipher) || cipher.byteLength !== item.bytes) return null
    if (sha256Hex(cipher) !== item.sha256) return null
    key = b4a.from(item.key, 'hex')
    padded = b4a.alloc(cipher.byteLength - MAC_BYTES)
    if (!sodium.crypto_secretbox_open_easy(padded, cipher, b4a.from(item.nonce, 'hex'), key)) return null
    let end = padded.byteLength - 1
    while (end >= 0 && padded[end] === 0) end--
    // A pad mark with no image before it, or a pad wider than the last
    // block, is not what sealMedia writes.
    if (end < 1 || padded[end] !== PAD_MARK || sealedBlocks(end) !== item.blocks) return null
    const plain = b4a.from(padded.subarray(0, end))
    if (sha256Hex(plain) !== item.plainSha256 || (item.plainMime === AUDIO_MIME && !voiceMatches(plain, item.ms))) {
      wipe(plain)
      return null
    }
    return plain
  } catch {
    return null
  } finally {
    wipe(padded)
    wipe(key)
  }
}

module.exports = {
  SEALED_MEDIA_MIME,
  MAX_GROUP_MEDIA,
  MAX_SEALED_MEDIA_PLAIN_BYTES,
  PRIVATE_ITEM_KEYS,
  validPublicItem,
  validPrivateItem,
  validGroupMedia,
  copyGroupItem,
  copyGroupMedia,
  sealMedia,
  openMedia
}
