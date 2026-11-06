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
// The plaintext is padded (0x80 then zeros) so that it fills every block of
// the item: the ciphertext is always blocks * MEDIA_BLOCK_BYTES, and the short
// last block of a plain item, which gives its exact size away, never exists.
//
// sealMedia throws on a programming error; openMedia and the validators never
// throw, since what they read comes from a peer. Zeroing is best effort, as
// in lib/group-crypto.js.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const {
  MEDIA_BLOCK_BYTES, MAX_MEDIA_BLOCKS, MAX_MEDIA_ITEM_BLOCKS, MAX_MEDIA_PER_POST, MEDIA_MIMES,
  MAX_MEDIA_DIMENSION, DESCRIPTOR_KEYS, isPlainObject, hasExactKeys, isHex64, validDescriptor
} = require('./records')

const SEALED_MEDIA_MIME = 'application/octet-stream'
const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES
const MAC_BYTES = sodium.crypto_secretbox_MACBYTES
const PAD_MARK = 0x80
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

// A public item: an ordinary post descriptor (still images). Never throws.
function validPublicItem (d) {
  return validDescriptor(d)
}

// A private item, valid only inside a group-sealed inner record. Every block
// is full (the padding), still images only (ms 0). Never throws.
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
      typeof plainMime === 'string' && MEDIA_MIMES.includes(plainMime) &&
      isHex64(plainSha256) &&
      isIntIn(w, 1, MAX_MEDIA_DIMENSION) &&
      isIntIn(h, 1, MAX_MEDIA_DIMENSION) &&
      ms === 0
  } catch {
    return false
  }
}

// A group post's media: 1..MAX_MEDIA_PER_POST items, all private inside a
// sealed inner and all public elsewhere, each at its own place in a media
// core. By index, never every(): a hole in a sparse array is invalid.
// Never throws.
function validGroupMedia (media, sealed) {
  try {
    if (!Array.isArray(media) || media.length < 1 || media.length > MAX_MEDIA_PER_POST) return false
    const valid = sealed === true ? validPrivateItem : validPublicItem
    const places = new Set()
    for (let i = 0; i < media.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(media, i)) return false
      const d = media[i]
      if (!valid(d)) return false
      const place = d.core + ':' + d.start
      if (places.has(place)) return false
      places.add(place)
    }
    return true
  } catch {
    return false
  }
}

// A copy with exactly the keys of the expected kind (anything else is
// passed through for validation to reject).
function copyGroupItem (d, sealed) {
  if (!isPlainObject(d)) return d
  const out = {}
  for (const k of sealed === true ? PRIVATE_ITEM_KEYS : DESCRIPTOR_KEYS) out[k] = d[k]
  return out
}

function copyGroupMedia (media, sealed) {
  return Array.isArray(media) ? Array.from(media, (d) => copyGroupItem(d, sealed)) : media
}

// -> { cipher, item }: `cipher` is what the writer appends to its media core
// (exactly item.blocks full blocks); `item` is a private item without `core`
// and `start`, which the caller adds once it knows where the bytes went.
function sealMedia (plain, { plainMime, w, h, ms = 0 } = {}) {
  if (!isBytes(plain) || plain.byteLength < 1 || plain.byteLength > MAX_SEALED_MEDIA_PLAIN_BYTES) {
    throw new TypeError('plain must be 1..' + MAX_SEALED_MEDIA_PLAIN_BYTES + ' bytes')
  }
  if (!MEDIA_MIMES.includes(plainMime)) throw new TypeError('plainMime must be a still image type')
  if (!isIntIn(w, 1, MAX_MEDIA_DIMENSION) || !isIntIn(h, 1, MAX_MEDIA_DIMENSION)) throw new TypeError('w and h must be 1..' + MAX_MEDIA_DIMENSION)
  if (ms !== 0) throw new TypeError('ms must be 0')
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

// The image bytes of a private item, or null: the ciphertext must be the
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
    if (sha256Hex(plain) !== item.plainSha256) {
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
