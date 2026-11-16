'use strict'

const test = require('brittle')
const b4a = require('b4a')
const nodeCrypto = require('crypto')
const { validateParams } = require('@varanda/rpc')
const sodium = require('../lib/sodium-browser')
const { outboxKeyFromPrf, dmLocalKeyFromPrf, toBase64Url, fromBase64Url, OUTBOX_HKDF_SALT, OUTBOX_HKDF_INFO } = require('../lib/passkey')
const { hkdfSha256 } = require('../lib/hkdf')
const { sealOutbox, openOutbox, BAD_BOX, BOX_MAX } = require('../lib/outbox-seal')

const prf = () => new Uint8Array(nodeCrypto.randomBytes(32))
const ITEM = {
  id: '0123456789abcdef',
  author: 'ab'.repeat(32),
  association: 'cd'.repeat(32),
  kind: 'reply',
  to: 'ef'.repeat(32) + ':7',
  text: 'oi\nalguém \ud800 aí? 🌻',
  writtenAt: '2026-11-15T12:00:00.000Z'
}
const bound = ({ to, text, ...rest }) => rest

function badBox (t, fn, label) {
  try {
    fn()
    t.fail(label + ': opened')
  } catch (err) {
    t.is(err.message, BAD_BOX, label)
    t.is(err.code, 'USAGE', label + ' is a usage error')
  }
}

// A box of an arbitrary plaintext under `key`, to reach the checks behind
// the MAC.
function rawBox (key, value) {
  const plain = b4a.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  const nonce = b4a.alloc(24)
  sodium.randombytes_buf(nonce)
  const ct = b4a.alloc(plain.byteLength + 16)
  sodium.crypto_secretbox_easy(ct, plain, nonce, key)
  return toBase64Url(b4a.concat([nonce, ct]))
}

test('the outbox key is the HKDF of the PRF with its own labels', async (t) => {
  const p = prf()
  const key = await outboxKeyFromPrf(p)
  t.is(key.byteLength, 32)
  t.is(b4a.toString(OUTBOX_HKDF_SALT), 'varanda/member-outbox/hkdf/v1')
  t.is(b4a.toString(OUTBOX_HKDF_INFO), 'varanda/member-outbox/secretbox/v1')
  const hmac = (k, d) => new Uint8Array(nodeCrypto.createHmac('sha256', k).update(d).digest())
  const expected = await hkdfSha256(p, OUTBOX_HKDF_SALT, OUTBOX_HKDF_INFO, 32, { hmac })
  t.alike(key, new Uint8Array(expected), 'as WebCrypto HKDF-SHA-256')
  t.alike(await outboxKeyFromPrf(p, { hkdf: (ikm, salt, info, n) => hkdfSha256(ikm, salt, info, n, { hmac }) }), key, 'the injected hkdf gives the same key')
  t.unlike(key, await dmLocalKeyFromPrf(p), 'not the dm local key')
  await t.exception.all(outboxKeyFromPrf(new Uint8Array(31)), TypeError)
})

test('seal and open round trip, a fresh nonce per seal', async (t) => {
  const key = await outboxKeyFromPrf(prf())
  const a = sealOutbox(key, ITEM)
  const b = sealOutbox(key, ITEM)
  t.not(a, b, 'two seals differ')
  t.not(fromBase64Url(a).subarray(0, 24).toString(), fromBase64Url(b).subarray(0, 24).toString(), 'different nonces')
  t.alike(openOutbox(key, a, bound(ITEM)), { to: ITEM.to, text: ITEM.text })
  t.alike(openOutbox(key, b, bound(ITEM)), { to: ITEM.to, text: ITEM.text })
  const post = { ...ITEM, kind: 'post', to: null }
  t.alike(openOutbox(key, sealOutbox(key, post), bound(post)), { to: null, text: ITEM.text })
  t.absent(a.includes('alguém') || a.includes('='), 'base64url, no clear text, no padding')
})

test('the largest item fits the box bound, and the bound is the rpc one', async (t) => {
  const key = await outboxKeyFromPrf(prf())
  const big = { ...ITEM, to: 'ef'.repeat(32) + ':' + Number.MAX_SAFE_INTEGER, text: '\ud800'.repeat(1000) }
  t.ok(validateParams('outbox.seal', big).ok)
  const box = sealOutbox(key, big)
  t.ok(box.length <= BOX_MAX, box.length + ' <= ' + BOX_MAX)
  t.alike(openOutbox(key, box, bound(big)), { to: big.to, text: big.text })
  const open = { box: 'A'.repeat(BOX_MAX), ...bound(ITEM) }
  t.ok(validateParams('outbox.open', open).ok, 'BOX_MAX passes outbox.open')
  t.is(BOX_MAX % 4, 0)
  t.absent(validateParams('outbox.open', { ...open, box: 'A'.repeat(BOX_MAX + 4) }).ok, 'four more do not')
})

test('a changed byte, a truncated box or a bad encoding does not open', async (t) => {
  const key = await outboxKeyFromPrf(prf())
  const box = sealOutbox(key, ITEM)
  const bytes = fromBase64Url(box)
  for (const at of [0, 23, 24, bytes.byteLength - 1]) {
    const flipped = new Uint8Array(bytes)
    flipped[at] ^= 1
    badBox(t, () => openOutbox(key, toBase64Url(flipped), bound(ITEM)), 'byte ' + at + ' flipped')
  }
  badBox(t, () => openOutbox(key, toBase64Url(bytes.subarray(0, bytes.byteLength - 1)), bound(ITEM)), 'truncated by one byte')
  badBox(t, () => openOutbox(key, toBase64Url(bytes.subarray(0, 40)), bound(ITEM)), 'nonce and MAC only')
  badBox(t, () => openOutbox(key, '', bound(ITEM)), 'empty')
  badBox(t, () => openOutbox(key, box.slice(0, -1) + '+', bound(ITEM)), 'not base64url')
  badBox(t, () => openOutbox(key, box + '=', bound(ITEM)), 'padding')
  badBox(t, () => openOutbox(key, box + 'A', bound(ITEM)), 'a length that cannot decode')
  badBox(t, () => openOutbox(key, 'A'.repeat(BOX_MAX + 4), bound(ITEM)), 'over the bound')
  // The last char of a box whose length is 2 mod 3 carries unused bits.
  const short = sealOutbox(key, { ...ITEM, text: 'a' })
  const n = fromBase64Url(short).byteLength
  if (n % 3 !== 0) {
    const last = short[short.length - 1]
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const twin = short.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1]
    t.alike(fromBase64Url(twin), fromBase64Url(short), 'the twin decodes to the same bytes')
    badBox(t, () => openOutbox(key, twin, bound({ ...ITEM, text: 'a' })), 'non-canonical encoding')
  } else {
    t.pass('length multiple of 3, no unused bits')
  }
})

test('each readable field changed does not open', async (t) => {
  const key = await outboxKeyFromPrf(prf())
  const box = sealOutbox(key, ITEM)
  const changes = {
    id: 'fedcba9876543210',
    author: 'ba'.repeat(32),
    association: 'dc'.repeat(32),
    kind: 'post',
    writtenAt: '2026-11-15T12:00:00.001Z'
  }
  for (const [k, v] of Object.entries(changes)) {
    badBox(t, () => openOutbox(key, box, { ...bound(ITEM), [k]: v }), k + ' changed')
  }
  const other = sealOutbox(key, { ...ITEM, id: changes.id })
  badBox(t, () => openOutbox(key, other, bound(ITEM)), 'a box copied from another item')
})

test('another PRF, another version or a malformed plaintext does not open', async (t) => {
  const key = await outboxKeyFromPrf(prf())
  const otherKey = await outboxKeyFromPrf(prf())
  badBox(t, () => openOutbox(key, sealOutbox(otherKey, ITEM), bound(ITEM)), 'sealed under another PRF')
  const fields = [ITEM.id, ITEM.author, ITEM.association, ITEM.kind, ITEM.to, ITEM.text, ITEM.writtenAt]
  t.alike(openOutbox(key, rawBox(key, [1, ...fields]), bound(ITEM)), { to: ITEM.to, text: ITEM.text }, 'the raw form opens')
  badBox(t, () => openOutbox(key, rawBox(key, [2, ...fields]), bound(ITEM)), 'version 2')
  badBox(t, () => openOutbox(key, rawBox(key, ['1', ...fields]), bound(ITEM)), 'version as a string')
  badBox(t, () => openOutbox(key, rawBox(key, [1, ...fields, 'x']), bound(ITEM)), 'an extra element')
  badBox(t, () => openOutbox(key, rawBox(key, [1, ...fields.slice(0, 6)]), bound(ITEM)), 'a missing element')
  badBox(t, () => openOutbox(key, rawBox(key, { v: 1 }), bound(ITEM)), 'not an array')
  badBox(t, () => openOutbox(key, rawBox(key, '[1,'), bound(ITEM)), 'not JSON')
  const asPost = { ...ITEM, kind: 'post' }
  badBox(t, () => openOutbox(key, rawBox(key, [1, ITEM.id, ITEM.author, ITEM.association, 'post', ITEM.to, ITEM.text, ITEM.writtenAt]), bound(asPost)), 'a post with a target')
  badBox(t, () => openOutbox(key, rawBox(key, [1, ITEM.id, ITEM.author, ITEM.association, 'reply', null, ITEM.text, ITEM.writtenAt]), bound(ITEM)), 'a reply without a target')
  badBox(t, () => openOutbox(key, rawBox(key, [1, ...fields.slice(0, 5), 7, ITEM.writtenAt]), bound(ITEM)), 'a text that is not a string')
})

test('a key that is not 32 bytes is refused', async (t) => {
  const key = await outboxKeyFromPrf(prf())
  const box = sealOutbox(key, ITEM)
  t.exception.all(() => sealOutbox(new Uint8Array(31), ITEM), TypeError)
  t.exception.all(() => openOutbox(new Uint8Array(33), box, bound(ITEM)), TypeError)
  t.exception.all(() => openOutbox(null, box, bound(ITEM)), TypeError)
})
