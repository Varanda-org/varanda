// lib/hkdf.js: RFC 5869 test case 1, equality with WebCrypto HKDF-SHA-256 on
// random vectors, argument checks and zeroing of what it allocated.
const test = require('brittle')
const crypto = require('node:crypto')
const b4a = require('b4a')
const { hkdfSha256, MAX_LENGTH } = require('../lib/hkdf')

const hmac = (k, d) => new Uint8Array(crypto.createHmac('sha256', k).update(d).digest())
const hex = (u8) => b4a.toString(b4a.from(u8.buffer, u8.byteOffset, u8.byteLength), 'hex')

async function webcryptoHkdf (ikm, salt, info, length) {
  const subtle = globalThis.crypto.subtle
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

test('RFC 5869 test case 1', async (t) => {
  const ikm = new Uint8Array(22).fill(0x0b)
  const salt = new Uint8Array(13).map((_, i) => i)
  const info = new Uint8Array(10).map((_, i) => 0xf0 + i)
  const okm = await hkdfSha256(ikm, salt, info, 42, { hmac })
  t.ok(okm instanceof Uint8Array)
  t.is(okm.byteLength, 42)
  t.is(hex(okm), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
})

test('equals WebCrypto HKDF-SHA-256 on random vectors', async (t) => {
  const lengths = [1, 31, 32, 33, 42, 64, 100, 255, MAX_LENGTH]
  for (const length of lengths) {
    const ikm = crypto.randomBytes(1 + crypto.randomInt(80))
    const salt = crypto.randomBytes(crypto.randomInt(80))
    const info = crypto.randomBytes(crypto.randomInt(80))
    const ours = await hkdfSha256(new Uint8Array(ikm), new Uint8Array(salt), new Uint8Array(info), length, { hmac })
    const theirs = await webcryptoHkdf(ikm, salt, info, length)
    t.is(hex(ours), hex(theirs), 'length ' + length + ', salt ' + salt.byteLength + ', info ' + info.byteLength)
  }
})

test('empty salt and info match WebCrypto', async (t) => {
  const ikm = new Uint8Array(crypto.randomBytes(32))
  const empty = new Uint8Array(0)
  const ours = await hkdfSha256(ikm, empty, empty, 32, { hmac })
  t.is(hex(ours), hex(await webcryptoHkdf(ikm, empty, empty, 32)))
})

test('an async hmac works too', async (t) => {
  const ikm = new Uint8Array(32).fill(1)
  const salt = new Uint8Array(4).fill(2)
  const info = new Uint8Array(4).fill(3)
  const sync = await hkdfSha256(ikm, salt, info, 50, { hmac })
  const async = await hkdfSha256(ikm, salt, info, 50, { hmac: async (k, d) => hmac(k, d) })
  t.is(hex(async), hex(sync))
})

test('inputs are left unchanged', async (t) => {
  const ikm = new Uint8Array(32).fill(9)
  const salt = new Uint8Array(8).fill(8)
  const info = new Uint8Array(8).fill(7)
  await hkdfSha256(ikm, salt, info, 64, { hmac })
  t.ok(ikm.every((b) => b === 9))
  t.ok(salt.every((b) => b === 8))
  t.ok(info.every((b) => b === 7))
})

test('the PRK, T blocks and HMAC outputs it allocated are zeroed', async (t) => {
  const outputs = []
  const keys = []
  const recording = (k, d) => {
    keys.push(k)
    const out = hmac(k, d)
    outputs.push(out)
    return out
  }
  const okm = await hkdfSha256(new Uint8Array(32).fill(5), new Uint8Array(4).fill(6), new Uint8Array(2), 70, { hmac: recording })
  t.is(outputs.length, 4, 'one extract and three expand blocks')
  t.ok(outputs.every((o) => o.every((b) => b === 0)), 'every HMAC output zeroed')
  // keys[1..] is the PRK copy this module owns.
  t.ok(keys.slice(1).every((k) => k.every((b) => b === 0)), 'PRK zeroed')
  t.ok(okm.some((b) => b !== 0), 'the result itself is intact')
})

test('rejects bad arguments', async (t) => {
  const b = new Uint8Array(32)
  await t.exception.all(hkdfSha256(b, b, b, 0, { hmac }), /comprimento/)
  await t.exception.all(hkdfSha256(b, b, b, MAX_LENGTH + 1, { hmac }), /comprimento/)
  await t.exception.all(hkdfSha256(b, b, b, 1.5, { hmac }), /comprimento/)
  await t.exception.all(hkdfSha256('x', b, b, 32, { hmac }), /ikm/)
  await t.exception.all(hkdfSha256(b, null, b, 32, { hmac }), /salt/)
  await t.exception.all(hkdfSha256(b, b, [], 32, { hmac }), /info/)
  await t.exception.all(hkdfSha256(b, b, b, 32), /hmac/)
  await t.exception.all(hkdfSha256(b, b, b, 32, { hmac: () => new Uint8Array(16) }), /32 bytes/)
})
