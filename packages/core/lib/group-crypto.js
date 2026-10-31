'use strict'

// Private group crypto (docs/protocol.md, private groups): epoch keys seal
// records with crypto_secretbox_easy, and epoch keys travel to each device's
// X25519 box key with crypto_box_seal. Sealing validates its inputs and
// throws on a programming error; opening never throws, since everything it
// reads comes from a peer, and returns null on any failure.
//
// Secrets the caller receives (newEpochKey(), the output of openFrom() and
// openEpochKey(), a key pair's secretKey) are caller-owned: wipe them with
// wipe() when done. The module zeroes the temporary buffers it owns.
// Zeroing is best effort on Node
// and Bare (the GC may have moved or copied memory) and nominal in the
// browser, where sodium-javascript copies inputs internally.

const sodium = require('sodium-universal')
const b4a = require('b4a')

const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES
const MAC_BYTES = sodium.crypto_secretbox_MACBYTES
const BOX_PUBLIC_BYTES = sodium.crypto_box_PUBLICKEYBYTES
const BOX_SECRET_BYTES = sodium.crypto_box_SECRETKEYBYTES
const BOX_SEED_BYTES = sodium.crypto_box_SEEDBYTES
const SEAL_BYTES = sodium.crypto_box_SEALBYTES
// 48 sealed 32-byte keys plus refs keep a group-key block under 16 KiB.
const MAX_KEY_RECIPIENTS = 48
// The inner record's compact JSON (docs/protocol.md, `group-sealed`): with
// the base64 growth and the envelope fields it leaves the block under
// MAX_BLOCK_BYTES.
const MAX_SEALED_INNER_BYTES = 12000
const MAX_SEALED_PLAIN_BYTES = 1024
const KEY_TAG_BYTES = 16
const KEY_TAG_DOMAIN = b4a.from('varanda/group-key/v1', 'utf8')
const KEY_COMMIT_BYTES = 32
const KEY_COMMIT_DOMAIN = b4a.from('varanda/group-key-commit/v1', 'utf8')
// A sealed epoch key: crypto_box_seal of key || tag.
const SEALED_EPOCH_KEY_BYTES = KEY_BYTES + KEY_TAG_BYTES + SEAL_BYTES

const HEX_NONCE = /^[0-9a-f]{48}$/
const HEX_KEY = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function isBytes (x, len) {
  return x instanceof Uint8Array && (len === undefined || x.byteLength === len)
}

function isPlainObject (x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function wipe (bytes) {
  if (isBytes(bytes)) sodium.sodium_memzero(bytes)
}

function newEpochKey () {
  const key = b4a.alloc(KEY_BYTES)
  sodium.randombytes_buf(key)
  return key
}

function sealRecord (record, key) {
  if (!isPlainObject(record)) throw new TypeError('record must be an object')
  if (!isBytes(key, KEY_BYTES)) throw new TypeError('key must be ' + KEY_BYTES + ' bytes')
  const json = JSON.stringify(record)
  if (typeof json !== 'string') throw new TypeError('record is not serializable')
  const plain = b4a.from(json, 'utf8')
  try {
    if (plain.byteLength > MAX_SEALED_INNER_BYTES) throw new RangeError('record too large')
    const nonce = b4a.alloc(NONCE_BYTES)
    sodium.randombytes_buf(nonce)
    const box = b4a.alloc(plain.byteLength + MAC_BYTES)
    sodium.crypto_secretbox_easy(box, plain, nonce, key)
    return { nonce: b4a.toString(nonce, 'hex'), box: b4a.toString(box, 'base64') }
  } finally {
    sodium.sodium_memzero(plain)
  }
}

// Strict base64: canonical padding and the exact re-encoding, so one record
// has one encoding.
function decodeBase64 (s, maxBytes) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return null
  if (s.length > Math.ceil(maxBytes / 3) * 4) return null
  if (!BASE64.test(s)) return null
  const buf = b4a.from(s, 'base64')
  if (buf.byteLength > maxBytes || b4a.toString(buf, 'base64') !== s) return null
  return buf
}

function openRecord (sealed, key) {
  let plain = null
  try {
    if (!isPlainObject(sealed) || !isBytes(key, KEY_BYTES)) return null
    const { nonce, box } = sealed
    if (typeof nonce !== 'string' || !HEX_NONCE.test(nonce)) return null
    const cipher = decodeBase64(box, MAX_SEALED_INNER_BYTES + MAC_BYTES)
    if (cipher === null || cipher.byteLength < MAC_BYTES + 2) return null
    plain = b4a.alloc(cipher.byteLength - MAC_BYTES)
    if (!sodium.crypto_secretbox_open_easy(plain, cipher, b4a.from(nonce, 'hex'), key)) return null
    const value = JSON.parse(b4a.toString(plain, 'utf8'))
    return isPlainObject(value) ? value : null
  } catch {
    return null
  } finally {
    if (plain !== null) sodium.sodium_memzero(plain)
  }
}

function newBoxKeyPair () {
  const publicKey = b4a.alloc(BOX_PUBLIC_BYTES)
  const secretKey = b4a.alloc(BOX_SECRET_BYTES)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function boxKeyPairFromSeed (seed) {
  if (!isBytes(seed, BOX_SEED_BYTES)) throw new TypeError('seed must be ' + BOX_SEED_BYTES + ' bytes')
  const publicKey = b4a.alloc(BOX_PUBLIC_BYTES)
  const secretKey = b4a.alloc(BOX_SECRET_BYTES)
  sodium.crypto_box_seed_keypair(publicKey, secretKey, seed)
  return { publicKey, secretKey }
}

function sealTo (bytes, boxPk) {
  if (!isBytes(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_SEALED_PLAIN_BYTES) {
    throw new TypeError('bytes must be 1..' + MAX_SEALED_PLAIN_BYTES + ' bytes')
  }
  if (!isBytes(boxPk, BOX_PUBLIC_BYTES)) throw new TypeError('box public key must be ' + BOX_PUBLIC_BYTES + ' bytes')
  const sealed = b4a.alloc(bytes.byteLength + SEAL_BYTES)
  sodium.crypto_box_seal(sealed, bytes, boxPk)
  return sealed
}

function openFrom (sealed, keyPair) {
  try {
    if (!isBytes(sealed) || sealed.byteLength <= SEAL_BYTES) return null
    if (sealed.byteLength > MAX_SEALED_PLAIN_BYTES + SEAL_BYTES) return null
    if (!isPlainObject(keyPair)) return null
    const { publicKey, secretKey } = keyPair
    if (!isBytes(publicKey, BOX_PUBLIC_BYTES) || !isBytes(secretKey, BOX_SECRET_BYTES)) return null
    const out = b4a.alloc(sealed.byteLength - SEAL_BYTES)
    if (!sodium.crypto_box_seal_open(out, sealed, publicKey, secretKey)) {
      sodium.sodium_memzero(out)
      return null
    }
    return out
  } catch {
    return null
  }
}

// Binds a sealed epoch key to its group and epoch (docs/protocol.md,
// `group-key`): BLAKE2b-128 over the domain, group, kid writer and kid seq
// as 8-byte big-endian.
function keyTag (groupHex, kidWriterHex, kidSeq) {
  if (typeof groupHex !== 'string' || !HEX_KEY.test(groupHex)) throw new TypeError('group must be 64 lowercase hex')
  if (typeof kidWriterHex !== 'string' || !HEX_KEY.test(kidWriterHex)) throw new TypeError('kid writer must be 64 lowercase hex')
  if (!Number.isSafeInteger(kidSeq) || kidSeq < 0) throw new TypeError('kid seq must be a non-negative safe integer')
  const seq = b4a.alloc(8)
  const view = new DataView(seq.buffer, seq.byteOffset, 8)
  view.setUint32(0, Math.floor(kidSeq / 0x100000000))
  view.setUint32(4, kidSeq >>> 0)
  const input = b4a.concat([KEY_TAG_DOMAIN, b4a.from(groupHex, 'hex'), b4a.from(kidWriterHex, 'hex'), seq])
  const out = b4a.alloc(KEY_TAG_BYTES)
  sodium.crypto_generichash(out, input)
  return out
}

// Commits an epoch's first block to its one key (docs/protocol.md,
// `group-key`), so a continuation from anyone can only hand that key:
// BLAKE2b-256 over the domain, group, kid writer, kid seq as 8-byte
// big-endian and the key.
function keyCommit (key, groupHex, kid) {
  if (!isBytes(key, KEY_BYTES)) throw new TypeError('key must be ' + KEY_BYTES + ' bytes')
  if (!isKid(kid)) throw new TypeError('kid must be { writer, seq }')
  if (typeof groupHex !== 'string' || !HEX_KEY.test(groupHex)) throw new TypeError('group must be 64 lowercase hex')
  const seq = b4a.alloc(8)
  const view = new DataView(seq.buffer, seq.byteOffset, 8)
  view.setUint32(0, Math.floor(kid.seq / 0x100000000))
  view.setUint32(4, kid.seq >>> 0)
  const input = b4a.concat([KEY_COMMIT_DOMAIN, b4a.from(groupHex, 'hex'), b4a.from(kid.writer, 'hex'), seq, key])
  try {
    const out = b4a.alloc(KEY_COMMIT_BYTES)
    sodium.crypto_generichash(out, input)
    return out
  } finally {
    sodium.sodium_memzero(input)
  }
}

function isKid (kid) {
  return isPlainObject(kid) && typeof kid.writer === 'string' && HEX_KEY.test(kid.writer) &&
    Number.isSafeInteger(kid.seq) && kid.seq >= 0
}

// The tag stops a sealed key from being replayed into another group or epoch.
function sealEpochKey (key, groupHex, kid, boxPk) {
  if (!isBytes(key, KEY_BYTES)) throw new TypeError('key must be ' + KEY_BYTES + ' bytes')
  if (!isKid(kid)) throw new TypeError('kid must be { writer, seq }')
  const plain = b4a.alloc(KEY_BYTES + KEY_TAG_BYTES)
  try {
    plain.set(key, 0)
    plain.set(keyTag(groupHex, kid.writer, kid.seq), KEY_BYTES)
    return sealTo(plain, boxPk)
  } finally {
    sodium.sodium_memzero(plain)
  }
}

function openEpochKey (sealed, keyPair, groupHex, kid) {
  let plain = null
  try {
    if (!isBytes(sealed, SEALED_EPOCH_KEY_BYTES) || !isKid(kid)) return null
    const tag = keyTag(groupHex, kid.writer, kid.seq)
    plain = openFrom(sealed, keyPair)
    if (plain === null || plain.byteLength !== KEY_BYTES + KEY_TAG_BYTES) return null
    if (!sodium.sodium_memcmp(plain.subarray(KEY_BYTES), tag)) return null
    return b4a.from(plain.subarray(0, KEY_BYTES))
  } catch {
    return null
  } finally {
    if (plain !== null) sodium.sodium_memzero(plain)
  }
}

module.exports = {
  KEY_BYTES,
  NONCE_BYTES,
  BOX_PUBLIC_BYTES,
  BOX_SECRET_BYTES,
  SEAL_BYTES,
  KEY_TAG_BYTES,
  KEY_COMMIT_BYTES,
  SEALED_EPOCH_KEY_BYTES,
  MAX_KEY_RECIPIENTS,
  MAX_SEALED_INNER_BYTES,
  MAX_SEALED_PLAIN_BYTES,
  wipe,
  newEpochKey,
  sealRecord,
  openRecord,
  newBoxKeyPair,
  boxKeyPairFromSeed,
  sealTo,
  openFrom,
  keyTag,
  keyCommit,
  sealEpochKey,
  openEpochKey
}
