'use strict'

// The sealed notice a member hands a seeder after a DM drop: the recipient's
// member key, sealed (crypto_box_seal) to the account service's wake key. The
// seeder only forwards it, so it never learns more about the recipient than
// the drop's bucket already says; the service opens it and pushes the
// recipient. The plaintext has a fixed size (magic, version, key, zero
// padding) so every box is the same length whoever it names.
//
// Pure: no I/O, runs on Node and Bare and in the browser node.
const sodium = require('sodium-universal')
const b4a = require('b4a')
const { isWeakBoxKey } = require('./group')

const DM_NOTICE_MAGIC = b4a.from('DMN1', 'utf8')
const DM_NOTICE_VERSION = 1
const DM_NOTICE_KEY_BYTES = 32
const DM_NOTICE_PLAIN_BYTES = 68
const DM_NOTICE_BOX_BYTES = DM_NOTICE_PLAIN_BYTES + sodium.crypto_box_SEALBYTES
const KEY_OFFSET = DM_NOTICE_MAGIC.byteLength + 1
const PAD_OFFSET = KEY_OFFSET + DM_NOTICE_KEY_BYTES
const HEX64 = /^[0-9a-f]{64}$/

const DM_NOTICE_TTL_MS = 60000
const DM_NOTICE_WINDOW_MAX = 8

function isBytes (x, len) {
  return x instanceof Uint8Array && x.byteLength === len
}

function recipientBytes (recipientKey) {
  if (typeof recipientKey === 'string' && HEX64.test(recipientKey)) return b4a.from(recipientKey, 'hex')
  if (isBytes(recipientKey, DM_NOTICE_KEY_BYTES)) return recipientKey
  throw new TypeError('recipientKey must be 64 lowercase hex or ' + DM_NOTICE_KEY_BYTES + ' bytes')
}

function sealDmNotice (recipientKey, serviceKey) {
  const key = recipientBytes(recipientKey)
  if (!isBytes(serviceKey, sodium.crypto_box_PUBLICKEYBYTES)) {
    throw new TypeError('serviceKey must be ' + sodium.crypto_box_PUBLICKEYBYTES + ' bytes')
  }
  // A small-order point gives a constant shared secret in sodium-javascript
  // (the browser node), so anyone, the seeder included, could open the box.
  if (isWeakBoxKey(b4a.toString(serviceKey, 'hex'))) throw new TypeError('serviceKey is a small-order point')
  const plain = b4a.alloc(DM_NOTICE_PLAIN_BYTES)
  plain.set(DM_NOTICE_MAGIC, 0)
  plain[DM_NOTICE_MAGIC.byteLength] = DM_NOTICE_VERSION
  plain.set(key, KEY_OFFSET)
  const box = b4a.alloc(DM_NOTICE_BOX_BYTES)
  try {
    sodium.crypto_box_seal(box, plain, serviceKey)
  } finally {
    sodium.sodium_memzero(plain)
  }
  return box
}

// Returns the recipient key as 64 lowercase hex, or null. Never throws: the
// box comes from an untrusted member through a seeder.
function openDmNotice (box, keyPair) {
  let plain = null
  try {
    if (!isBytes(box, DM_NOTICE_BOX_BYTES)) return null
    if (keyPair === null || typeof keyPair !== 'object') return null
    const { publicKey, secretKey } = keyPair
    if (!isBytes(publicKey, sodium.crypto_box_PUBLICKEYBYTES) || !isBytes(secretKey, sodium.crypto_box_SECRETKEYBYTES)) return null
    plain = b4a.alloc(DM_NOTICE_PLAIN_BYTES)
    if (!sodium.crypto_box_seal_open(plain, box, publicKey, secretKey)) return null
    if (!b4a.equals(plain.subarray(0, DM_NOTICE_MAGIC.byteLength), DM_NOTICE_MAGIC)) return null
    if (plain[DM_NOTICE_MAGIC.byteLength] !== DM_NOTICE_VERSION) return null
    // A non-zero pad would be a covert channel from the sender to the service.
    for (let i = PAD_OFFSET; i < DM_NOTICE_PLAIN_BYTES; i++) if (plain[i] !== 0) return null
    return b4a.toString(plain.subarray(KEY_OFFSET, PAD_OFFSET), 'hex')
  } catch {
    return null
  } finally {
    if (plain !== null) sodium.sodium_memzero(plain)
  }
}

// Byte ids become hex so a drop id read from decodeDrop (bytes) and one read
// off the wire (hex) are the same entry.
function idKey (id) {
  if (typeof id === 'string') return id
  if (id instanceof Uint8Array) return b4a.toString(id, 'hex')
  return null
}

// The drops a seeder stored recently, each good for one notice: a wake for
// an id it never stored, or a second wake for the same one, wakes nobody.
function createNoticeWindow ({ ttlMs = DM_NOTICE_TTL_MS, max = DM_NOTICE_WINDOW_MAX, now = Date.now } = {}) {
  if (!(ttlMs > 0) || !Number.isFinite(ttlMs)) throw new TypeError('invalid ttlMs')
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('invalid max')
  if (typeof now !== 'function') throw new TypeError('invalid now')
  // id -> time added, in insertion order, so the first entry is the oldest.
  const added = new Map()

  return {
    get size () { return added.size },
    add (id) {
      const k = idKey(id)
      if (k === null) throw new TypeError('id must be a string or bytes')
      added.delete(k)
      added.set(k, now())
      while (added.size > max) added.delete(added.keys().next().value)
    },
    take (id) {
      const k = idKey(id)
      if (k === null || !added.has(k)) return false
      const at = added.get(k)
      added.delete(k)
      const age = now() - at
      return age >= 0 && age < ttlMs
    }
  }
}

module.exports = {
  DM_NOTICE_MAGIC,
  DM_NOTICE_VERSION,
  DM_NOTICE_KEY_BYTES,
  DM_NOTICE_PLAIN_BYTES,
  DM_NOTICE_BOX_BYTES,
  DM_NOTICE_TTL_MS,
  DM_NOTICE_WINDOW_MAX,
  sealDmNotice,
  openDmNotice,
  createNoticeWindow
}
