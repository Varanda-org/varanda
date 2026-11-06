'use strict'

// Blobs (docs/protocol.md section 13): the media a direct message carries,
// cut into fixed-size, individually stamped chunks that a member puts into
// the seeder's blob pool (lib/blob-pool.js) over 'varanda/blob/1'
// (lib/blob-net.js). The client encrypts the whole object with secretbox
// under a random key and nonce before cutting it; the key and the nonce only
// travel inside the sealed DM, in the blob descriptor, and never on this
// channel, so the seeder holds ciphertext it cannot open.
//
// Chunk frame, BLOB_FRAME_BYTES (33137), every field fixed:
//   offset 0     magic 'VBL1' (4)
//   offset 4     version (1)
//   offset 5     id (32)
//   offset 37    index uint16be (2)
//   offset 39    count uint16be (2)
//   offset 41    kid (8)
//   offset 49    sig (256)
//   offset 305   token (32)
//   offset 337   check (32)
//   offset 369   bytes (BLOB_CHUNK_BYTES, the last chunk zero-padded)
// The stamp is (kid, sig, token): a blind RSA signature on token under the
// seeder's blob stamp key. token is a random 32-byte value, exactly like a
// DM token (dm-postage.js newToken(n, 'blob')), never derived from the chunk:
// a client buys blob stamps ahead of time into a wallet and spends any one on
// any chunk later, so the seeder cannot link a stamp request on the
// identified stamp link to the chunks that later arrive on the anonymous
// blob link by their timing. The pool refuses a token already spent.
//
// check is chunkCheck(id, index, count, bytes), BLAKE2b-256 over the prefix,
// the id, the index, the count and the padded bytes; decodeChunk recomputes
// it, so a frame (a stored one too) whose id, index, count or bytes changed
// is refused. It does not cover the stamp: kid, sig and token are judged by
// the pool's verifier, and a stored file whose stamp changed is caught by the
// pool's recorded token and frame hash.
//
// Building throws on a programming error; decoding never throws, since
// everything it reads comes from a peer, and returns null on any failure.
// No node:crypto: core also runs on Bare.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const { hasExactKeys } = require('./records')

const BLOB_PROTOCOL = 'varanda/blob/1'
const BLOB_MAGIC = 'VBL1'
const BLOB_VERSION = 1
const BLOB_CHUNK_BYTES = 32768
// An 8 MiB plaintext (MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES in
// records.js) plus the secretbox MAC needs one chunk more than 256.
const BLOB_MAX_CHUNKS = 257
const BLOB_RETENTION_MS = 7 * 86400000
const BLOB_POOL_BYTES = 2 * 1024 * 1024 * 1024
// One base64 frame inside a JSON put must fit.
const BLOB_MAX_MESSAGE = 65536
const BLOB_CHECK_PREFIX = 'varanda/blob-chunk/v1\n'
const BLOB_MAC_BYTES = 16

const MAGIC_OFFSET = 0
const VERSION_OFFSET = 4
const ID_OFFSET = 5
const INDEX_OFFSET = 37
const COUNT_OFFSET = 39
const KID_OFFSET = 41
const SIG_OFFSET = 49
const TOKEN_OFFSET = 305
const CHECK_OFFSET = 337
const BYTES_OFFSET = 369
const MAGIC_BYTES = 4
const ID_BYTES = 32
const KID_BYTES = 8
const SIG_BYTES = 256
const TOKEN_BYTES = 32
const CHECK_BYTES = 32
const BLOB_FRAME_BYTES = BYTES_OFFSET + BLOB_CHUNK_BYTES
const FRAME_BASE64_BYTES = Math.ceil(BLOB_FRAME_BYTES / 3) * 4
if (FRAME_BASE64_BYTES + 128 > BLOB_MAX_MESSAGE) throw new Error('BLOB_MAX_MESSAGE too small')

const MAGIC = b4a.from(BLOB_MAGIC, 'ascii')
const CHECK_PREFIX = b4a.from(BLOB_CHECK_PREFIX, 'utf8')
const HEX64 = /^[0-9a-f]{64}$/
const HEX48 = /^[0-9a-f]{48}$/

function isBytes (x, len) {
  return x instanceof Uint8Array && (len === undefined || x.byteLength === len)
}

function isCount (n) {
  return Number.isInteger(n) && n >= 1 && n <= BLOB_MAX_CHUNKS
}

function isIndex (index, count) {
  return Number.isInteger(index) && index >= 0 && index < count
}

function u16 (buf, offset) {
  return (buf[offset] << 8) | buf[offset + 1]
}

function newBlobId () {
  const id = b4a.alloc(ID_BYTES)
  sodium.randombytes_buf(id)
  return id
}

// The content check of a chunk: BLAKE2b-256 over the prefix, the id, the
// index, the count and the padded bytes.
function chunkCheck (id, index, count, bytes) {
  if (!isBytes(id, ID_BYTES)) throw new TypeError('id must be ' + ID_BYTES + ' bytes')
  if (!isCount(count)) throw new TypeError('invalid count')
  if (!isIndex(index, count)) throw new TypeError('invalid index')
  if (!isBytes(bytes, BLOB_CHUNK_BYTES)) throw new TypeError('bytes must be ' + BLOB_CHUNK_BYTES + ' bytes')
  const place = b4a.alloc(4)
  place[0] = index >>> 8
  place[1] = index & 0xff
  place[2] = count >>> 8
  place[3] = count & 0xff
  const out = b4a.alloc(CHECK_BYTES)
  sodium.crypto_generichash(out, b4a.concat([CHECK_PREFIX, id, place, bytes]))
  return out
}

// bytes may be shorter than BLOB_CHUNK_BYTES (the last chunk): it is
// zero-padded, and the check covers the padded bytes.
function padChunk (bytes) {
  if (!isBytes(bytes) || bytes.byteLength < 1 || bytes.byteLength > BLOB_CHUNK_BYTES) {
    throw new TypeError('bytes must be 1 to ' + BLOB_CHUNK_BYTES + ' bytes')
  }
  if (bytes.byteLength === BLOB_CHUNK_BYTES) return bytes
  const out = b4a.alloc(BLOB_CHUNK_BYTES)
  out.set(bytes, 0)
  return out
}

// token is the random stamped token the client spends on this chunk.
function encodeChunk ({ id, index, count, kid, sig, token, bytes } = {}) {
  const padded = padChunk(bytes)
  const check = chunkCheck(id, index, count, padded)
  if (!isBytes(kid, KID_BYTES)) throw new TypeError('kid must be ' + KID_BYTES + ' bytes')
  if (!isBytes(sig, SIG_BYTES)) throw new TypeError('sig must be ' + SIG_BYTES + ' bytes')
  if (!isBytes(token, TOKEN_BYTES)) throw new TypeError('token must be ' + TOKEN_BYTES + ' bytes')
  const out = b4a.alloc(BLOB_FRAME_BYTES)
  out.set(MAGIC, MAGIC_OFFSET)
  out[VERSION_OFFSET] = BLOB_VERSION
  out.set(id, ID_OFFSET)
  out[INDEX_OFFSET] = index >>> 8
  out[INDEX_OFFSET + 1] = index & 0xff
  out[COUNT_OFFSET] = count >>> 8
  out[COUNT_OFFSET + 1] = count & 0xff
  out.set(kid, KID_OFFSET)
  out.set(sig, SIG_OFFSET)
  out.set(token, TOKEN_OFFSET)
  out.set(check, CHECK_OFFSET)
  out.set(padded, BYTES_OFFSET)
  return out
}

// Copies, never views: the caller may reuse the frame buffer. A truncated or
// padded frame (a frame of an earlier layout among them), a wrong magic or
// version, a count outside 1..BLOB_MAX_CHUNKS, an index outside the count
// and a check that does not match the frame are all null.
function decodeChunk (buf) {
  try {
    if (!isBytes(buf, BLOB_FRAME_BYTES)) return null
    if (!b4a.equals(buf.subarray(MAGIC_OFFSET, MAGIC_OFFSET + MAGIC_BYTES), MAGIC)) return null
    if (buf[VERSION_OFFSET] !== BLOB_VERSION) return null
    const index = u16(buf, INDEX_OFFSET)
    const count = u16(buf, COUNT_OFFSET)
    if (!isCount(count) || !isIndex(index, count)) return null
    const part = (offset, len) => b4a.from(buf.subarray(offset, offset + len))
    const chunk = {
      id: part(ID_OFFSET, ID_BYTES),
      index,
      count,
      kid: part(KID_OFFSET, KID_BYTES),
      sig: part(SIG_OFFSET, SIG_BYTES),
      token: part(TOKEN_OFFSET, TOKEN_BYTES),
      check: part(CHECK_OFFSET, CHECK_BYTES),
      bytes: part(BYTES_OFFSET, BLOB_CHUNK_BYTES)
    }
    if (!b4a.equals(chunkCheck(chunk.id, index, count, chunk.bytes), chunk.check)) return null
    return chunk
  } catch {
    return null
  }
}

// The blob descriptor inside a sealed DM: { id, key, nonce, chunks, bytes,
// sha256 }, all hex but the counts. bytes is the ciphertext length (the
// plaintext plus the secretbox MAC) and chunks must be exactly the chunks it
// fills. Never throws.
function validateBlobDescriptor (d) {
  try {
    if (d === null || typeof d !== 'object' || Array.isArray(d)) return false
    if (!hasExactKeys(d, ['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256'])) return false
    if (typeof d.id !== 'string' || !HEX64.test(d.id)) return false
    if (typeof d.key !== 'string' || !HEX64.test(d.key)) return false
    if (typeof d.nonce !== 'string' || !HEX48.test(d.nonce)) return false
    if (typeof d.sha256 !== 'string' || !HEX64.test(d.sha256)) return false
    if (!isCount(d.chunks)) return false
    if (!Number.isInteger(d.bytes) || d.bytes <= BLOB_MAC_BYTES || d.bytes > BLOB_MAX_CHUNKS * BLOB_CHUNK_BYTES) return false
    return d.chunks === Math.ceil(d.bytes / BLOB_CHUNK_BYTES)
  } catch {
    return false
  }
}

module.exports = Object.freeze({
  BLOB_PROTOCOL,
  BLOB_MAGIC,
  BLOB_VERSION,
  BLOB_CHUNK_BYTES,
  BLOB_MAX_CHUNKS,
  BLOB_RETENTION_MS,
  BLOB_POOL_BYTES,
  BLOB_MAX_MESSAGE,
  BLOB_CHECK_PREFIX,
  BLOB_MAC_BYTES,
  BLOB_FRAME_BYTES,
  FRAME: Object.freeze({
    MAGIC_OFFSET,
    VERSION_OFFSET,
    ID_OFFSET,
    INDEX_OFFSET,
    COUNT_OFFSET,
    KID_OFFSET,
    SIG_OFFSET,
    TOKEN_OFFSET,
    CHECK_OFFSET,
    BYTES_OFFSET,
    ID_BYTES,
    KID_BYTES,
    SIG_BYTES,
    TOKEN_BYTES,
    CHECK_BYTES
  }),
  newBlobId,
  chunkCheck,
  padChunk,
  encodeChunk,
  decodeChunk,
  validateBlobDescriptor
})
