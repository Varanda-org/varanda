'use strict'

// The blob chunk frame and descriptor (lib/blob.js).
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('node:crypto')
const sodium = require('sodium-universal')
const {
  BLOB_PROTOCOL, BLOB_MAGIC, BLOB_CHUNK_BYTES, BLOB_MAX_CHUNKS, BLOB_RETENTION_MS, BLOB_POOL_BYTES,
  BLOB_MAX_MESSAGE, BLOB_FRAME_BYTES, FRAME, newBlobId, chunkCheck, encodeChunk, decodeChunk,
  validateBlobDescriptor, padChunk, BLOB_CHECK_PREFIX
} = require('../lib/blob')
const blobExports = require('../lib/blob')
const postage = require('../lib/dm-postage')
const { MAX_MEDIA_ITEM_BLOCKS, MEDIA_BLOCK_BYTES } = require('../lib/records')

function randomBytes (n) {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

function frame (over = {}) {
  return encodeChunk({
    id: newBlobId(),
    index: 0,
    count: 1,
    kid: randomBytes(8),
    sig: randomBytes(256),
    token: randomBytes(32),
    bytes: randomBytes(BLOB_CHUNK_BYTES),
    ...over
  })
}

test('constants', (t) => {
  t.is(BLOB_PROTOCOL, 'varanda/blob/1')
  t.is(BLOB_MAGIC, 'VBL1')
  t.is(BLOB_CHUNK_BYTES, 32768)
  t.is(BLOB_MAX_CHUNKS, 257)
  t.ok(BLOB_MAX_CHUNKS * BLOB_CHUNK_BYTES >= MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES + 16, 'an 8 MiB plaintext plus MAC fits')
  t.ok((BLOB_MAX_CHUNKS - 1) * BLOB_CHUNK_BYTES < MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES + 16, 'and needs the last chunk')
  t.is(BLOB_RETENTION_MS, 7 * 86400000)
  t.is(BLOB_POOL_BYTES, 2 * 1024 * 1024 * 1024)
  t.is(BLOB_FRAME_BYTES, FRAME.BYTES_OFFSET + BLOB_CHUNK_BYTES)
  t.ok(Math.ceil(BLOB_FRAME_BYTES / 3) * 4 + 64 < BLOB_MAX_MESSAGE, 'a put message fits')
})

test('encode and decode round trip; the last chunk is zero-padded', (t) => {
  const id = newBlobId()
  const kid = randomBytes(8)
  const sig = randomBytes(256)
  const token = randomBytes(32)
  const bytes = randomBytes(1000)
  const buf = encodeChunk({ id, index: 2, count: 3, kid, sig, token, bytes })
  t.is(buf.byteLength, BLOB_FRAME_BYTES)
  t.is(b4a.toString(buf.subarray(0, 4), 'ascii'), 'VBL1')
  const c = decodeChunk(buf)
  t.ok(c)
  t.ok(b4a.equals(c.id, id))
  t.is(c.index, 2)
  t.is(c.count, 3)
  t.ok(b4a.equals(c.kid, kid))
  t.ok(b4a.equals(c.sig, sig))
  t.is(c.bytes.byteLength, BLOB_CHUNK_BYTES)
  t.ok(b4a.equals(c.bytes.subarray(0, 1000), bytes))
  t.ok(c.bytes.subarray(1000).every((x) => x === 0))
  t.ok(b4a.equals(c.token, token))
  t.ok(b4a.equals(c.check, chunkCheck(id, 2, 3, c.bytes)))
  t.absent('salt' in c)
  buf.fill(0)
  t.is(c.index, 2, 'decode copies')
  t.ok(b4a.equals(c.id, id))
})

test('truncated, padded or altered frames are refused', (t) => {
  const buf = frame({ count: 4, index: 1 })
  t.ok(decodeChunk(buf))
  t.is(decodeChunk(buf.subarray(0, BLOB_FRAME_BYTES - 1)), null, 'truncated')
  t.is(decodeChunk(buf.subarray(0, 100)), null, 'header only')
  t.is(decodeChunk(b4a.concat([buf, b4a.alloc(1)])), null, 'one byte more')
  t.is(decodeChunk(null), null)
  t.is(decodeChunk('x'), null)

  const fields = [
    ['magic', 0],
    ['version', FRAME.VERSION_OFFSET],
    ['id', FRAME.ID_OFFSET + 5],
    ['index', FRAME.INDEX_OFFSET + 1],
    ['count', FRAME.COUNT_OFFSET + 1],
    ['check', FRAME.CHECK_OFFSET + 3],
    ['bytes', FRAME.BYTES_OFFSET + 100]
  ]
  for (const [name, at] of fields) {
    const bad = b4a.from(buf)
    bad[at] ^= 0x01
    t.is(decodeChunk(bad), null, name + ' changed')
  }
  // kid, sig and token are the stamp: the pool's verifier judges them, not
  // decode.
  for (const [name, at] of [['kid', FRAME.KID_OFFSET], ['sig', FRAME.SIG_OFFSET + 9], ['token', FRAME.TOKEN_OFFSET + 3]]) {
    const changed = b4a.from(buf)
    changed[at] ^= 1
    t.ok(decodeChunk(changed), name + ' changed still decodes')
  }
})

test('count and index bounds', (t) => {
  t.ok(decodeChunk(frame({ count: BLOB_MAX_CHUNKS, index: BLOB_MAX_CHUNKS - 1 })))
  t.exception.all(() => frame({ count: 0 }), /count/)
  t.exception.all(() => frame({ count: BLOB_MAX_CHUNKS + 1 }), /count/)
  t.exception.all(() => frame({ count: 2, index: 2 }), /index/)
  t.exception.all(() => frame({ index: -1 }), /index/)
  t.exception.all(() => frame({ id: randomBytes(31) }), /id/)
  t.exception.all(() => frame({ kid: randomBytes(7) }), /kid/)
  t.exception.all(() => frame({ sig: randomBytes(255) }), /sig/)
  t.exception.all(() => frame({ token: randomBytes(31) }), /token/)
  t.exception.all(() => frame({ token: undefined }), /token/)
  t.exception.all(() => frame({ bytes: b4a.alloc(0) }), /bytes/)
  t.exception.all(() => frame({ bytes: b4a.alloc(BLOB_CHUNK_BYTES + 1) }), /bytes/)

  // A frame claiming a count over the limit, with a check computed over it,
  // still decodes to null.
  const buf = frame({ count: 2, index: 1 })
  buf[FRAME.COUNT_OFFSET] = (BLOB_MAX_CHUNKS + 1) >>> 8
  buf[FRAME.COUNT_OFFSET + 1] = (BLOB_MAX_CHUNKS + 1) & 0xff
  t.is(decodeChunk(buf), null)
})

test('blob descriptor shape', (t) => {
  const good = {
    id: b4a.toString(randomBytes(32), 'hex'),
    key: b4a.toString(randomBytes(32), 'hex'),
    nonce: b4a.toString(randomBytes(24), 'hex'),
    chunks: 2,
    bytes: BLOB_CHUNK_BYTES + 1,
    sha256: b4a.toString(randomBytes(32), 'hex')
  }
  t.ok(validateBlobDescriptor(good))
  t.ok(validateBlobDescriptor({ ...good, chunks: BLOB_MAX_CHUNKS, bytes: MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES + 16 }))
  t.absent(validateBlobDescriptor({ ...good, chunks: 3 }), 'chunks must match bytes')
  t.absent(validateBlobDescriptor({ ...good, bytes: 16, chunks: 1 }), 'no room for a MAC')
  t.absent(validateBlobDescriptor({ ...good, nonce: good.nonce.slice(2) }))
  t.absent(validateBlobDescriptor({ ...good, key: good.key.toUpperCase() }))
  t.absent(validateBlobDescriptor({ ...good, extra: 1 }))
  const { sha256, ...missing } = good
  t.absent(validateBlobDescriptor(missing))
  t.absent(validateBlobDescriptor(null))
  t.absent(validateBlobDescriptor([]))
})

// One RSA-2048 modulus per run (AGENTS.md: fixtures generate keys on the spot).
function modulus () {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  return BigInt('0x' + Buffer.from(publicKey.export({ format: 'jwk' }).n, 'base64url').toString('hex'))
}

test('frame layout: token, then check, then bytes', (t) => {
  t.is(FRAME.MAGIC_OFFSET, 0)
  t.is(FRAME.VERSION_OFFSET, 4)
  t.is(FRAME.ID_OFFSET, 5)
  t.is(FRAME.INDEX_OFFSET, 37)
  t.is(FRAME.COUNT_OFFSET, 39)
  t.is(FRAME.KID_OFFSET, 41)
  t.is(FRAME.SIG_OFFSET, 49)
  t.is(FRAME.TOKEN_OFFSET, FRAME.SIG_OFFSET + FRAME.SIG_BYTES)
  t.is(FRAME.TOKEN_BYTES, 32)
  t.is(FRAME.CHECK_OFFSET, FRAME.TOKEN_OFFSET + FRAME.TOKEN_BYTES)
  t.is(FRAME.CHECK_BYTES, 32)
  t.is(FRAME.BYTES_OFFSET, FRAME.CHECK_OFFSET + FRAME.CHECK_BYTES)
  t.is(BLOB_FRAME_BYTES, 369 + BLOB_CHUNK_BYTES)
  t.is(BLOB_FRAME_BYTES, 33137)
  t.ok(Math.ceil(BLOB_FRAME_BYTES / 3) * 4 + 128 <= BLOB_MAX_MESSAGE, 'a full frame in base64 fits a message')
  t.absent('SALT_OFFSET' in FRAME)
  t.absent('SALT_BYTES' in FRAME)
  for (const gone of ['stampableChunk', 'chunkToken', 'MAX_SALT_DRAWS', 'BLOB_TOKEN_PREFIX']) t.absent(gone in blobExports, gone + ' is gone')
})

test('any random usable blob token stamps any chunk', (t) => {
  const n = modulus()
  const runs = 300
  let usable = 0
  let carried = 0
  for (let i = 0; i < runs; i++) {
    const token = postage.newToken(n, 'blob')
    if (postage.isUsableToken(token, n, 'blob')) usable++
    const id = newBlobId()
    const count = 1 + (i % BLOB_MAX_CHUNKS)
    const index = i % count
    const bytes = randomBytes(1 + (i * 997) % BLOB_CHUNK_BYTES)
    const buf = encodeChunk({ id, index, count, kid: randomBytes(8), sig: randomBytes(256), token, bytes })
    const c = decodeChunk(buf)
    if (c !== null && b4a.equals(c.token, token) && b4a.equals(c.check, chunkCheck(id, index, count, padChunk(bytes)))) carried++
  }
  t.is(usable, runs, 'every token is signable')
  t.is(carried, runs, 'every frame decodes with the token it was given')

  // One token, bought before any chunk existed, fits two unrelated chunks.
  const token = postage.newToken(n, 'blob')
  const a = encodeChunk({ id: newBlobId(), index: 0, count: 1, kid: randomBytes(8), sig: randomBytes(256), token, bytes: randomBytes(10) })
  const b = encodeChunk({ id: newBlobId(), index: 4, count: 9, kid: randomBytes(8), sig: randomBytes(256), token, bytes: randomBytes(BLOB_CHUNK_BYTES) })
  t.ok(b4a.equals(decodeChunk(a).token, token))
  t.ok(b4a.equals(decodeChunk(b).token, token))
})

test('the check binds the id, index, count and bytes', (t) => {
  const id = newBlobId()
  const bytes = randomBytes(BLOB_CHUNK_BYTES)
  const check = chunkCheck(id, 1, 3, bytes)
  const expect = b4a.alloc(32)
  sodium.crypto_generichash(expect, b4a.concat([b4a.from('varanda/blob-chunk/v1\n'), id, b4a.from([0, 1, 0, 3]), bytes]))
  t.is(BLOB_CHECK_PREFIX, 'varanda/blob-chunk/v1\n')
  t.ok(b4a.equals(check, expect), 'BLAKE2b-256 over prefix, id, index, count and bytes')
  const otherId = b4a.from(id)
  otherId[31] ^= 1
  const otherBytes = b4a.from(bytes)
  otherBytes[BLOB_CHUNK_BYTES - 1] ^= 1
  t.absent(b4a.equals(check, chunkCheck(otherId, 1, 3, bytes)), 'id')
  t.absent(b4a.equals(check, chunkCheck(id, 2, 3, bytes)), 'index')
  t.absent(b4a.equals(check, chunkCheck(id, 1, 4, bytes)), 'count')
  t.absent(b4a.equals(check, chunkCheck(id, 1, 3, otherBytes)), 'bytes')
  t.exception.all(() => chunkCheck(id, 1, 3, randomBytes(10)), /bytes/)
  t.exception.all(() => chunkCheck(id, 3, 3, bytes), /index/)

  // Changing any covered field under the same check breaks decode.
  const good = encodeChunk({ id, index: 1, count: 3, kid: randomBytes(8), sig: randomBytes(256), token: randomBytes(32), bytes })
  t.ok(decodeChunk(good))
  const place = (buf, offset, value) => { buf[offset] = value >>> 8; buf[offset + 1] = value & 0xff }
  const variants = {
    id: (buf) => buf.set(otherId, FRAME.ID_OFFSET),
    index: (buf) => place(buf, FRAME.INDEX_OFFSET, 2),
    count: (buf) => place(buf, FRAME.COUNT_OFFSET, 4),
    bytes: (buf) => buf.set(otherBytes, FRAME.BYTES_OFFSET)
  }
  for (const [name, change] of Object.entries(variants)) {
    const bad = b4a.from(good)
    change(bad)
    t.ok(b4a.equals(bad.subarray(FRAME.CHECK_OFFSET, FRAME.CHECK_OFFSET + 32), check), name + ': check kept')
    t.is(decodeChunk(bad), null, name + ' changed under the same check')
  }
})

test('frames of earlier layouts are refused', (t) => {
  const id = newBlobId()
  const bytes = randomBytes(BLOB_CHUNK_BYTES)
  const place = b4a.from([0, 0, 0, 1])
  const header = (size) => {
    const buf = b4a.alloc(size)
    buf.set(b4a.from('VBL1'), 0)
    buf[4] = 1
    buf.set(id, 5)
    buf.set(place, 37)
    buf.set(randomBytes(8), 41)
    buf.set(randomBytes(256), 49)
    return buf
  }
  const hash = (parts) => {
    const out = b4a.alloc(32)
    sodium.crypto_generichash(out, b4a.concat([b4a.from(BLOB_CHECK_PREFIX), ...parts]))
    return out
  }

  // Salt-free layout: ... sig (256) || token (32) || bytes, 337 + BLOB_CHUNK_BYTES.
  const old = header(337 + BLOB_CHUNK_BYTES)
  old.set(hash([id, place, bytes]), 305)
  old.set(bytes, 337)
  t.is(decodeChunk(old), null, 'salt-free size')
  t.is(decodeChunk(b4a.concat([old, b4a.alloc(BLOB_FRAME_BYTES - old.byteLength)])), null, 'salt-free fields padded to the new size')

  // Salt layout: ... sig (256) || salt (16) || token (32) || bytes, 353 + BLOB_CHUNK_BYTES (33121).
  const salt = randomBytes(16)
  const salted = header(353 + BLOB_CHUNK_BYTES)
  t.is(salted.byteLength, 33121)
  salted.set(salt, 305)
  salted.set(hash([id, place, salt, bytes]), 321)
  salted.set(bytes, 353)
  t.is(decodeChunk(salted), null, 'salt layout size')
  t.is(decodeChunk(b4a.concat([salted, b4a.alloc(BLOB_FRAME_BYTES - salted.byteLength)])), null, 'salt fields padded to the new size')
})
