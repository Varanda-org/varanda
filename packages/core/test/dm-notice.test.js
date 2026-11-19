'use strict'

// The sealed DM notice (dm-notice.js): the recipient key sealed to the
// account service, and the seeder's one-wake-per-drop window.
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const {
  DM_NOTICE_PLAIN_BYTES, DM_NOTICE_BOX_BYTES, DM_NOTICE_MAGIC, DM_NOTICE_VERSION,
  sealDmNotice, openDmNotice, createNoticeWindow
} = require('../lib/dm-notice')

function boxKeyPair () {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function randomBytes (n) {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

// Seals a plaintext built by hand, to reach the checks after the box opens.
function sealPlain (plain, publicKey) {
  const box = b4a.alloc(plain.byteLength + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(box, plain, publicKey)
  return box
}

function goodPlain (key) {
  const plain = b4a.alloc(DM_NOTICE_PLAIN_BYTES)
  plain.set(DM_NOTICE_MAGIC, 0)
  plain[4] = DM_NOTICE_VERSION
  plain.set(key, 5)
  return plain
}

test('sizes: 68 bytes of plaintext, 116 of box', (t) => {
  t.is(DM_NOTICE_PLAIN_BYTES, 68)
  t.is(DM_NOTICE_BOX_BYTES, 116)
  t.is(DM_NOTICE_BOX_BYTES, DM_NOTICE_PLAIN_BYTES + sodium.crypto_box_SEALBYTES)
})

test('seal and open round trip, from hex and from bytes', (t) => {
  const service = boxKeyPair()
  const key = randomBytes(32)
  const hex = b4a.toString(key, 'hex')

  const fromHex = sealDmNotice(hex, service.publicKey)
  t.is(fromHex.byteLength, DM_NOTICE_BOX_BYTES)
  t.is(openDmNotice(fromHex, service), hex)

  const fromBytes = sealDmNotice(key, service.publicKey)
  t.is(fromBytes.byteLength, DM_NOTICE_BOX_BYTES)
  t.is(openDmNotice(fromBytes, service), hex)
  t.absent(b4a.equals(fromHex, fromBytes), 'every seal uses a fresh ephemeral key')
  t.is(b4a.indexOf(fromBytes, key), -1, 'the key is not in the box in clear')
})

test('a box opened with another service key is null', (t) => {
  const service = boxKeyPair()
  const other = boxKeyPair()
  const box = sealDmNotice(randomBytes(32), service.publicKey)
  t.is(openDmNotice(box, other), null)
  t.is(openDmNotice(box, { publicKey: service.publicKey, secretKey: other.secretKey }), null)
})

test('a box of the wrong length is null', (t) => {
  const service = boxKeyPair()
  const box = sealDmNotice(randomBytes(32), service.publicKey)
  t.is(openDmNotice(box.subarray(0, 115), service), null, '115 bytes')
  t.is(openDmNotice(b4a.concat([box, b4a.alloc(1)]), service), null, '117 bytes')
  t.is(openDmNotice(sealPlain(b4a.alloc(DM_NOTICE_PLAIN_BYTES + 1), service.publicKey), service), null, 'a longer plaintext')
})

test('wrong magic, version 2 or a non-zero pad byte is null', (t) => {
  const service = boxKeyPair()
  const key = randomBytes(32)
  t.is(openDmNotice(sealPlain(goodPlain(key), service.publicKey), service), b4a.toString(key, 'hex'), 'the crafted plaintext itself opens')

  const magic = goodPlain(key)
  magic[0] = 'X'.charCodeAt(0)
  t.is(openDmNotice(sealPlain(magic, service.publicKey), service), null, 'magic')

  const version = goodPlain(key)
  version[4] = 2
  t.is(openDmNotice(sealPlain(version, service.publicKey), service), null, 'version 2')

  const pad = goodPlain(key)
  pad[DM_NOTICE_PLAIN_BYTES - 1] = 1
  t.is(openDmNotice(sealPlain(pad, service.publicKey), service), null, 'last pad byte')

  const firstPad = goodPlain(key)
  firstPad[37] = 0x80
  t.is(openDmNotice(sealPlain(firstPad, service.publicKey), service), null, 'first pad byte')
})

test('hostile input never throws', (t) => {
  const service = boxKeyPair()
  const box = sealDmNotice(randomBytes(32), service.publicKey)
  for (const bad of [null, undefined, 'x', 116, {}, [], b4a.toString(box, 'hex')]) {
    t.is(openDmNotice(bad, service), null)
  }
  for (const kp of [null, undefined, {}, 'x', { publicKey: service.publicKey }, { publicKey: b4a.alloc(31), secretKey: service.secretKey }]) {
    t.is(openDmNotice(box, kp), null)
  }
})

test('a bad recipient key or service key throws', (t) => {
  const service = boxKeyPair()
  const hex = b4a.toString(randomBytes(32), 'hex')
  for (const bad of [hex.toUpperCase(), hex.slice(1), hex + '0', 'zz' + hex.slice(2), randomBytes(31), randomBytes(33), null, undefined, 1, {}]) {
    t.exception.all(() => sealDmNotice(bad, service.publicKey), TypeError)
  }
  t.exception.all(() => sealDmNotice(hex, b4a.alloc(31)), TypeError)
  t.exception.all(() => sealDmNotice(hex, b4a.toString(service.publicKey, 'hex')), TypeError)
})

test('a small-order service key throws: a box sealed to it opens without the secret', (t) => {
  const hex = b4a.toString(randomBytes(32), 'hex')
  const zero = '00'.repeat(32)
  const one = '01' + '00'.repeat(31)
  const highBit = 'ec' + 'ff'.repeat(30) + 'ff'
  for (const weak of [zero, one, highBit]) {
    t.exception.all(() => sealDmNotice(hex, b4a.from(weak, 'hex')), TypeError, weak.slice(0, 8))
  }
})

test('window: an added id is taken once', (t) => {
  const w = createNoticeWindow()
  const id = b4a.toString(randomBytes(32), 'hex')
  w.add(id)
  t.is(w.take(id), true)
  t.is(w.take(id), false, 'a second take')
  t.is(w.take(b4a.toString(randomBytes(32), 'hex')), false, 'an unknown id')
  t.is(w.take(null), false)
})

test('window: ids compare by value, bytes or hex', (t) => {
  const w = createNoticeWindow()
  const bytes = randomBytes(32)
  w.add(bytes)
  t.is(w.take(b4a.toString(bytes, 'hex')), true)
  w.add(b4a.toString(bytes, 'hex'))
  t.is(w.take(b4a.from(bytes)), true)
  t.exception.all(() => w.add(1), TypeError)
})

test('window: a take after the ttl is false', (t) => {
  let now = 1000
  const w = createNoticeWindow({ ttlMs: 100, now: () => now })
  w.add('a')
  w.add('b')
  now += 99
  t.is(w.take('a'), true, 'inside the ttl')
  now += 1
  t.is(w.take('b'), false, 'at the ttl')
  t.is(w.size, 0)
})

test('window: past max the oldest id goes', (t) => {
  const w = createNoticeWindow({ max: 3 })
  for (const id of ['a', 'b', 'c', 'd']) w.add(id)
  t.is(w.size, 3)
  t.is(w.take('a'), false, 'the oldest was dropped')
  t.is(w.take('b'), true)
  t.is(w.take('d'), true)
  t.is(w.take('c'), true)
})

test('window: options are checked', (t) => {
  t.exception.all(() => createNoticeWindow({ ttlMs: 0 }), TypeError)
  t.exception.all(() => createNoticeWindow({ max: 0 }), TypeError)
  t.exception.all(() => createNoticeWindow({ now: 1 }), TypeError)
})
