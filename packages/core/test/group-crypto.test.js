'use strict'

const test = require('brittle')
const crypto = require('node:crypto')
const b4a = require('b4a')
const {
  MAX_KEY_RECIPIENTS,
  MAX_SEALED_INNER_BYTES,
  KEY_TAG_BYTES,
  wipe,
  keyTag,
  keyCommit,
  sealEpochKey,
  openEpochKey,
  SEALED_EPOCH_KEY_BYTES,
  MAX_SEALED_PLAIN_BYTES,
  newEpochKey,
  sealRecord,
  openRecord,
  newBoxKeyPair,
  boxKeyPairFromSeed,
  sealTo,
  openFrom
} = require('../lib/group-crypto')
const { MAX_BLOCK_BYTES } = require('../lib/records')

const SEED = b4a.from(Array.from({ length: 32 }, (_, i) => i))
// Computed once with sodium-universal and pinned; also checked below against
// an independent derivation (SHA-512 of the seed, X25519 base point).
const SEED_PK = '4701d08488451f545a409fb58ae3e58581ca40ac3f7f114698cd71deac73ca01'
const SEED_SK = '3d94eea49c580aef816935762be049559d6d1440dede12e6a125f1841fff8e6f'

const RECORD = { type: 'group-post', text: 'olá, grupo 🌴', at: 1767225600000 }

function flipBase64 (s, index) {
  const buf = b4a.from(s, 'base64')
  buf[index] ^= 1
  return b4a.toString(buf, 'base64')
}

test('epoch keys are 32 fresh random bytes', (t) => {
  const a = newEpochKey()
  const b = newEpochKey()
  t.ok(a instanceof Uint8Array)
  t.is(a.byteLength, 32)
  t.absent(b4a.equals(a, b), 'two keys differ')
})

test('sealRecord / openRecord round trip with compact JSON', (t) => {
  const key = newEpochKey()
  const sealed = sealRecord(RECORD, key)
  t.alike(Object.keys(sealed).sort(), ['box', 'nonce'])
  t.ok(/^[0-9a-f]{48}$/.test(sealed.nonce), '24-byte hex nonce')
  t.is(b4a.from(sealed.box, 'base64').byteLength, b4a.byteLength(JSON.stringify(RECORD)) + 16, 'compact JSON plus MAC')
  t.alike(openRecord(sealed, key), RECORD)
  t.not(sealRecord(RECORD, key).nonce, sealed.nonce, 'a fresh nonce per seal')
})

test('openRecord returns null on tampering, wrong key, truncation and bad encodings', (t) => {
  const key = newEpochKey()
  const sealed = sealRecord(RECORD, key)
  const cipher = b4a.from(sealed.box, 'base64')

  t.is(openRecord(sealed, newEpochKey()), null, 'wrong key')
  t.is(openRecord({ ...sealed, box: flipBase64(sealed.box, 0) }, key), null, 'flipped MAC byte')
  t.is(openRecord({ ...sealed, box: flipBase64(sealed.box, cipher.byteLength - 1) }, key), null, 'flipped ciphertext byte')
  const nonce = b4a.from(sealed.nonce, 'hex')
  nonce[0] ^= 1
  t.is(openRecord({ ...sealed, nonce: b4a.toString(nonce, 'hex') }, key), null, 'flipped nonce')
  t.is(openRecord({ ...sealed, box: b4a.toString(cipher.subarray(0, cipher.byteLength - 1), 'base64') }, key), null, 'truncated box')
  t.is(openRecord({ ...sealed, box: b4a.toString(cipher.subarray(0, 16), 'base64') }, key), null, 'MAC only')
  t.is(openRecord({ ...sealed, box: '' }, key), null, 'empty box')
  t.is(openRecord({ ...sealed, nonce: sealed.nonce.slice(0, 46) }, key), null, '23-byte nonce')
  t.is(openRecord({ ...sealed, nonce: sealed.nonce + '00' }, key), null, '25-byte nonce')
  t.is(openRecord({ ...sealed, nonce: sealed.nonce.toUpperCase() }, key), null, 'uppercase hex')
  t.is(openRecord({ ...sealed, nonce: 'zz' + sealed.nonce.slice(2) }, key), null, 'non-hex nonce')
  t.is(openRecord({ ...sealed, box: sealed.box.replace(/=*$/, '') }, key), null, 'unpadded base64')
  t.is(openRecord({ ...sealed, box: '!' + sealed.box.slice(1) }, key), null, 'invalid base64 character')
  t.is(openRecord({ ...sealed, box: sealed.box + '\n' }, key), null, 'trailing whitespace')
  t.is(openRecord({ ...sealed, nonce: 1 }, key), null, 'number nonce')
  t.is(openRecord({ ...sealed, box: cipher }, key), null, 'bytes instead of base64')
  t.is(openRecord(null, key), null, 'null sealed')
  t.is(openRecord([sealed.nonce, sealed.box], key), null, 'array sealed')
  t.is(openRecord(sealed, key.subarray(0, 31)), null, 'short key')
  t.is(openRecord(sealed, b4a.toString(key, 'hex')), null, 'hex key')
  t.is(openRecord(sealed, null), null, 'null key')
  const huge = b4a.toString(b4a.alloc(MAX_SEALED_INNER_BYTES + 17), 'base64')
  t.is(openRecord({ nonce: sealed.nonce, box: huge }, key), null, 'oversize box')
})

test('openRecord returns null when the plaintext is not a JSON object', (t) => {
  const key = newEpochKey()
  // Seal raw payloads directly: sealRecord only takes objects.
  const sodium = require('sodium-universal')
  const seal = (text) => {
    const plain = b4a.from(text, 'utf8')
    const nonce = b4a.alloc(24)
    sodium.randombytes_buf(nonce)
    const box = b4a.alloc(plain.byteLength + 16)
    sodium.crypto_secretbox_easy(box, plain, nonce, key)
    return { nonce: b4a.toString(nonce, 'hex'), box: b4a.toString(box, 'base64') }
  }
  t.alike(openRecord(seal('{"a":1}'), key), { a: 1 }, 'control')
  for (const text of ['[1,2]', '"x"', '12', 'null', 'true', '{"a":', 'not json', 'ÿþ']) {
    t.is(openRecord(seal(text), key), null, JSON.stringify(text))
  }
})

test('sealRecord validates its inputs', (t) => {
  const key = newEpochKey()
  t.exception.all(() => sealRecord(null, key), /object/)
  t.exception.all(() => sealRecord([1], key), /object/)
  t.exception.all(() => sealRecord('x', key), /object/)
  t.exception.all(() => sealRecord(RECORD, key.subarray(0, 16)), /32 bytes/)
  t.exception.all(() => sealRecord(RECORD, 'k'), /32 bytes/)
  t.exception.all(() => sealRecord({ text: 'a'.repeat(MAX_SEALED_INNER_BYTES) }, key), /too large/)
})

test('box key pairs: random and deterministic from a seed (golden vector)', (t) => {
  const a = newBoxKeyPair()
  t.is(a.publicKey.byteLength, 32)
  t.is(a.secretKey.byteLength, 32)
  t.absent(b4a.equals(a.publicKey, newBoxKeyPair().publicKey))

  const kp = boxKeyPairFromSeed(SEED)
  t.is(b4a.toString(kp.publicKey, 'hex'), SEED_PK, 'pinned public key')
  t.is(b4a.toString(kp.secretKey, 'hex'), SEED_SK, 'pinned secret key')
  t.alike(boxKeyPairFromSeed(SEED), kp, 'same seed, same pair')

  // libsodium: sk = SHA-512(seed)[0..32], pk = X25519(sk, 9).
  const sk = crypto.createHash('sha512').update(SEED).digest().subarray(0, 32)
  t.is(sk.toString('hex'), SEED_SK, 'secret key from SHA-512 of the seed')
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), sk])
  const priv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  const pk = Buffer.from(crypto.createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url')
  t.is(pk.toString('hex'), SEED_PK, 'public key from node:crypto X25519')

  t.exception.all(() => boxKeyPairFromSeed(SEED.subarray(0, 31)), /32 bytes/)
  t.exception.all(() => boxKeyPairFromSeed('seed'), /32 bytes/)
})

test('sealTo / openFrom round trip, and null on any failure', (t) => {
  const kp = newBoxKeyPair()
  const key = newEpochKey()
  const sealed = sealTo(key, kp.publicKey)
  t.is(sealed.byteLength, 32 + 48)
  t.alike(openFrom(sealed, kp), key)
  t.absent(b4a.equals(sealTo(key, kp.publicKey), sealed), 'ephemeral key per seal')

  t.is(openFrom(sealed, newBoxKeyPair()), null, 'wrong key pair')
  t.is(openFrom(sealed, { publicKey: newBoxKeyPair().publicKey, secretKey: kp.secretKey }), null, 'mismatched public key')
  for (const i of [0, 31, 32, 47, 48, sealed.byteLength - 1]) {
    const bad = b4a.from(sealed)
    bad[i] ^= 1
    t.is(openFrom(bad, kp), null, 'flipped byte ' + i)
  }
  t.is(openFrom(sealed.subarray(0, sealed.byteLength - 1), kp), null, 'truncated')
  t.is(openFrom(sealed.subarray(0, 48), kp), null, 'seal overhead only')
  t.is(openFrom(b4a.alloc(0), kp), null, 'empty')
  t.is(openFrom(b4a.alloc(MAX_SEALED_PLAIN_BYTES + 49), kp), null, 'oversize')
  t.is(openFrom(b4a.toString(sealed, 'base64'), kp), null, 'string instead of bytes')
  t.is(openFrom(sealed, null), null, 'null key pair')
  t.is(openFrom(sealed, { publicKey: kp.publicKey }), null, 'no secret key')
  t.is(openFrom(sealed, { publicKey: kp.publicKey, secretKey: kp.secretKey.subarray(0, 31) }), null, 'short secret key')

  t.exception.all(() => sealTo(b4a.alloc(0), kp.publicKey), /bytes/)
  t.exception.all(() => sealTo(b4a.alloc(MAX_SEALED_PLAIN_BYTES + 1), kp.publicKey), /bytes/)
  t.exception.all(() => sealTo('key', kp.publicKey), /bytes/)
  t.exception.all(() => sealTo(key, kp.publicKey.subarray(0, 31)), /public key/)
})

test('a group-key-like block with MAX_KEY_RECIPIENTS sealed keys fits in one block', (t) => {
  t.is(MAX_KEY_RECIPIENTS, 48)
  const key = newEpochKey()
  const hex = () => crypto.randomBytes(32).toString('hex')
  const ref = () => ({ writer: hex(), seq: 4294967295 })
  const group = hex()
  const kid = ref()
  const block = {
    type: 'group-key',
    group,
    kid,
    basis: Array.from({ length: 16 }, ref),
    at: 1767225600000,
    keys: Array.from({ length: MAX_KEY_RECIPIENTS }, () => {
      const kp = newBoxKeyPair()
      return { writer: hex(), to: b4a.toString(kp.publicKey, 'hex'), sealed: b4a.toString(sealEpochKey(key, group, kid, kp.publicKey), 'base64') }
    })
  }
  const bytes = b4a.byteLength(JSON.stringify(block))
  t.ok(bytes < MAX_BLOCK_BYTES, bytes + ' bytes < ' + MAX_BLOCK_BYTES)
})

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function rawSeal (plain, key) {
  const sodium = require('sodium-universal')
  const nonce = b4a.alloc(24)
  sodium.randombytes_buf(nonce)
  const box = b4a.alloc(plain.byteLength + 16)
  sodium.crypto_secretbox_easy(box, plain, nonce, key)
  return { nonce: b4a.toString(nonce, 'hex'), box: b4a.toString(box, 'base64') }
}

// A compact JSON object of exactly n bytes.
function jsonOfSize (n) {
  return b4a.from(JSON.stringify({ t: 'a'.repeat(n - 8) }))
}

test('openRecord rejects non-canonical base64 with nonzero trailing bits', (t) => {
  const key = newEpochKey()
  // 3 bytes of JSON + 16 = 19 bytes: '==' padding, 4 unused trailing bits.
  const sealed = rawSeal(b4a.from('{ }'), key)
  t.ok(sealed.box.endsWith('=='), 'padded box')
  t.alike(openRecord(sealed, key), {}, 'control opens')
  const i = sealed.box.length - 3
  const loose = sealed.box.slice(0, i) + ALPHABET[ALPHABET.indexOf(sealed.box[i]) ^ 1] + '=='
  t.alike(b4a.from(loose, 'base64'), b4a.from(sealed.box, 'base64'), 'a lenient decoder reads the same bytes')
  t.is(openRecord({ ...sealed, box: loose }, key), null, 'non-canonical encoding refused')
})

test('the MAX_SEALED_INNER_BYTES bound on both sides', (t) => {
  const key = newEpochKey()
  t.is(MAX_SEALED_INNER_BYTES, 12000)
  const max = jsonOfSize(MAX_SEALED_INNER_BYTES)
  t.is(max.byteLength, MAX_SEALED_INNER_BYTES)
  const record = JSON.parse(b4a.toString(max))
  const sealed = sealRecord(record, key)
  t.alike(openRecord(sealed, key), record, 'exactly the max seals and opens')
  t.exception.all(() => sealRecord({ t: 'a'.repeat(MAX_SEALED_INNER_BYTES - 7) }, key), /too large/, 'one byte over refused')

  // A max-size box passes the size checks and fails only at the MAC.
  const tampered = b4a.from(sealed.box, 'base64')
  t.is(tampered.byteLength, MAX_SEALED_INNER_BYTES + 16)
  tampered[tampered.byteLength - 1] ^= 1
  t.is(openRecord({ ...sealed, box: b4a.toString(tampered, 'base64') }, key), null, 'max-size tampered box: null')
  t.is(openRecord(rawSeal(jsonOfSize(MAX_SEALED_INNER_BYTES + 1), key), key), null, 'a valid box one byte over: null')
})

test('openRecord: an own __proto__ key stays an own key', (t) => {
  const key = newEpochKey()
  const value = openRecord(rawSeal(b4a.from('{"__proto__":{"polluted":1},"a":1}'), key), key)
  t.ok(value !== null)
  t.is(Object.getPrototypeOf(value), Object.prototype, 'prototype untouched')
  t.ok(Object.prototype.hasOwnProperty.call(value, '__proto__'), '__proto__ is an own key')
  t.is(value.polluted, undefined)
  t.is({}.polluted, undefined, 'Object.prototype not polluted')
})

test('openFrom accepts a subarray of a larger buffer', (t) => {
  const kp = newBoxKeyPair()
  const key = newEpochKey()
  const sealed = sealTo(key, kp.publicKey)
  const big = b4a.alloc(sealed.byteLength + 20, 0xaa)
  big.set(sealed, 7)
  const view = big.subarray(7, 7 + sealed.byteLength)
  t.ok(view.buffer.byteLength > view.byteLength, 'shares a larger ArrayBuffer')
  t.alike(openFrom(view, kp), key)
})

test('wipe zeroes caller-owned secrets and ignores non-bytes', (t) => {
  const key = newEpochKey()
  const kp = newBoxKeyPair()
  const opened = openFrom(sealTo(key, kp.publicKey), kp)
  for (const secret of [key, kp.secretKey, opened]) {
    wipe(secret)
    t.alike(secret, b4a.alloc(32), 'zeroed')
  }
  t.execution(() => { wipe(null); wipe('abc'); wipe([1, 2]) }, 'non-bytes ignored')
})

test('keyTag: BLAKE2b-128 binding of group and kid (pinned vectors)', (t) => {
  const a = keyTag('a'.repeat(64), 'b'.repeat(64), 7)
  t.is(KEY_TAG_BYTES, 16)
  t.is(a.byteLength, KEY_TAG_BYTES)
  t.is(b4a.toString(a, 'hex'), '1ed8aa677c59e6a78947331d0bae14ec')
  t.is(b4a.toString(keyTag('0'.repeat(64), 'f'.repeat(64), 4294967297), 'hex'), '49169818c15e632c269ac4c2a6df5f98', 'seq above 2^32')
  t.absent(b4a.equals(keyTag('a'.repeat(64), 'b'.repeat(64), 8), a), 'seq bound')
  t.absent(b4a.equals(keyTag('b'.repeat(64), 'a'.repeat(64), 7), a), 'order bound')
  t.exception.all(() => keyTag('A'.repeat(64), 'b'.repeat(64), 7), /group/)
  t.exception.all(() => keyTag('a'.repeat(62), 'b'.repeat(64), 7), /group/)
  t.exception.all(() => keyTag('a'.repeat(64), 'b'.repeat(66), 7), /kid writer/)
  t.exception.all(() => keyTag('a'.repeat(64), 'b'.repeat(64), -1), /kid seq/)
  t.exception.all(() => keyTag('a'.repeat(64), 'b'.repeat(64), 1.5), /kid seq/)
  t.exception.all(() => keyTag('a'.repeat(64), 'b'.repeat(64), 2 ** 53), /kid seq/)
})

test('sealEpochKey / openEpochKey bind the key to its group and kid', (t) => {
  const kp = newBoxKeyPair()
  const key = newEpochKey()
  const group = crypto.randomBytes(32).toString('hex')
  const kid = { writer: crypto.randomBytes(32).toString('hex'), seq: 3 }
  const sealed = sealEpochKey(key, group, kid, kp.publicKey)
  t.is(sealed.byteLength, 96)
  t.is(SEALED_EPOCH_KEY_BYTES, 96)
  t.is(b4a.toString(sealed, 'base64').length, 128, '128 base64 characters')
  t.alike(openEpochKey(sealed, kp, group, kid), key)

  // The plaintext is key || tag, exactly as the spec writes it.
  const plain = openFrom(sealed, kp)
  t.alike(plain.subarray(0, 32), key)
  t.alike(plain.subarray(32), keyTag(group, kid.writer, kid.seq))

  t.is(openEpochKey(sealed, kp, crypto.randomBytes(32).toString('hex'), kid), null, 'other group')
  t.is(openEpochKey(sealed, kp, group, { ...kid, seq: 4 }), null, 'other kid seq')
  t.is(openEpochKey(sealed, kp, group, { ...kid, writer: group }), null, 'other kid writer')
  t.is(openEpochKey(sealed, newBoxKeyPair(), group, kid), null, 'wrong key pair')
  const bad = b4a.from(sealed)
  bad[60] ^= 1
  t.is(openEpochKey(bad, kp, group, kid), null, 'tampered')
  t.is(openEpochKey(sealTo(key, kp.publicKey), kp, group, kid), null, 'untagged 80-byte seal')
  t.is(openEpochKey(sealTo(b4a.concat([key, b4a.alloc(16)]), kp.publicKey), kp, group, kid), null, 'zero tag')
  t.is(openEpochKey(sealed, kp, 'zz', kid), null, 'bad group')
  t.is(openEpochKey(sealed, kp, group, null), null, 'no kid')
  t.is(openEpochKey(sealed, kp, group, { writer: kid.writer, seq: -1 }), null, 'bad kid seq')
  t.is(openEpochKey(b4a.toString(sealed, 'base64'), kp, group, kid), null, 'string sealed')

  t.exception.all(() => sealEpochKey(key.subarray(0, 31), group, kid, kp.publicKey), /32 bytes/)
  t.exception.all(() => sealEpochKey(key, group, { writer: 'x', seq: 1 }, kp.publicKey), /kid/)
  t.exception.all(() => sealEpochKey(key, 'x', kid, kp.publicKey), /group/)
  t.exception.all(() => sealEpochKey(key, group, kid, kp.publicKey.subarray(1)), /public key/)
})

test('keyCommit: BLAKE2b-256 commitment of one key to its group and kid (pinned vectors)', (t) => {
  const sodium = require('sodium-universal')
  const key = b4a.alloc(32, 7)
  const kid = { writer: 'b'.repeat(64), seq: 7 }
  const c = keyCommit(key, 'a'.repeat(64), kid)
  t.is(c.byteLength, 32)
  t.is(b4a.toString(c, 'hex'), '9a54f3da1805c32346dc6287d5c2a706d7b74be2a00147540d3b6b9ea3f44b4b')
  // An independent computation of the same input.
  const input = b4a.concat([b4a.from('varanda/group-key-commit/v1'), b4a.from('a'.repeat(64), 'hex'), b4a.from('b'.repeat(64), 'hex'), b4a.from([0, 0, 0, 0, 0, 0, 0, 7]), key])
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, input)
  t.alike(c, out)
  t.is(b4a.toString(keyCommit(b4a.alloc(32), '0'.repeat(64), { writer: 'f'.repeat(64), seq: 4294967297 }), 'hex'), '4e91b26110daa929090e5930273eb858cb8c702062941ff09264f345d619e307', 'seq above 2^32')
  t.absent(b4a.equals(keyCommit(b4a.alloc(32, 8), 'a'.repeat(64), kid), c), 'key bound')
  t.absent(b4a.equals(keyCommit(key, 'a'.repeat(64), { ...kid, seq: 8 }), c), 'kid bound')
  t.absent(b4a.equals(keyCommit(key, 'c'.repeat(64), kid), c), 'group bound')
  t.exception.all(() => keyCommit(b4a.alloc(31), 'a'.repeat(64), kid))
  t.exception.all(() => keyCommit(key, 'A'.repeat(64), kid))
  t.exception.all(() => keyCommit(key, 'a'.repeat(64), { writer: 'b'.repeat(64) }))
})
