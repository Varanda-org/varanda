'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const push = require('../lib/push-proof')
const {
  PREFIX, ACTIONS, TRANSPORTS, NONCE_RE, isNonce, isHex64, isAction,
  isTransport, isToken, isKey, tokenHash, pushDevicePayload, verifyPushDevice
} = require('../lib/push-device-proof')

const keyPair = crypto.keyPair()
const b64url = (bytes) => b4a.toString(bytes, 'base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const fields = {
  nonce: 'A'.repeat(43),
  member: b4a.toString(keyPair.publicKey, 'hex'),
  association: 'ab'.repeat(32),
  action: 'on',
  transport: 'fcm',
  tokenHash: tokenHash('fcm', 'abc_DEF-123:xyz'),
  key: b64url(b4a.alloc(16, 9))
}
const sign = (value) => b4a.toString(crypto.sign(pushDevicePayload(value), keyPair.secretKey), 'hex')

test('constants and exact statement bytes', (t) => {
  t.is(PREFIX, 'varanda-push-device-v1')
  t.alike(ACTIONS, ['on', 'off'])
  t.alike(TRANSPORTS, ['apns', 'fcm'])
  t.ok(Object.isFrozen(ACTIONS))
  t.ok(Object.isFrozen(TRANSPORTS))
  t.is(NONCE_RE.source, push.NONCE_RE.source)
  t.is(b4a.toString(pushDevicePayload(fields)), [
    PREFIX, fields.nonce, fields.member, fields.association, fields.action,
    fields.transport, fields.tokenHash, fields.key
  ].join('\n'))
})

test('tokenHash: unkeyed BLAKE2b-256 of transport and token', (t) => {
  for (const [transport, token] of [
    ['fcm', 'abc_DEF-123:xyz'], ['fcm', 'a'], ['fcm', 'Z'.repeat(4096)],
    ['apns', 'ab'.repeat(32)], ['apns', 'f'.repeat(200)]
  ]) {
    const expected = b4a.alloc(32)
    sodium.crypto_generichash(expected, b4a.from(transport + ':' + token, 'utf8'))
    t.is(tokenHash(transport, token), b4a.toString(expected, 'hex'))
  }
  t.is(tokenHash('fcm', 'abc_DEF-123:xyz'), '8f59fbe85c4f2aff3a2214a8c5316bbf28d154ab039477d34dd89496e931997e')
  t.not(tokenHash('fcm', 'ab'.repeat(32)), tokenHash('apns', 'ab'.repeat(32)), 'transport is hashed')
})

test('round trip for every action and transport', (t) => {
  for (const action of ACTIONS) {
    for (const transport of TRANSPORTS) {
      const value = { ...fields, action, transport, tokenHash: tokenHash(transport, 'ab'.repeat(32)) }
      const statement = { ...value, signature: sign(value) }
      t.is(verifyPushDevice(statement), true)
      t.is(verifyPushDevice(Object.assign(Object.create(null), statement)), true)
    }
  }
})

test('every field and the signature are bound', (t) => {
  const signature = sign(fields)
  const changes = {
    nonce: 'B'.repeat(43),
    member: b4a.toString(crypto.keyPair().publicKey, 'hex'),
    association: 'cd'.repeat(32),
    action: 'off',
    transport: 'apns',
    tokenHash: tokenHash('fcm', 'changed'),
    key: b64url(b4a.alloc(16, 10))
  }
  for (const [key, value] of Object.entries(changes)) {
    t.ok(pushDevicePayload({ ...fields, [key]: value }), 'valid replacement: ' + key)
    t.is(verifyPushDevice({ ...fields, [key]: value, signature }), false, key)
  }
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.is(verifyPushDevice({ ...fields, signature: flipped }), false)
  const otherSignature = b4a.toString(crypto.sign(pushDevicePayload(fields), crypto.keyPair().secretKey), 'hex')
  t.is(verifyPushDevice({ ...fields, signature: otherSignature }), false)
})

test('Web Push and device signatures cannot be exchanged', (t) => {
  const point = b4a.alloc(65, 7)
  point[0] = 4
  const webFields = {
    nonce: fields.nonce,
    member: fields.member,
    association: fields.association,
    action: fields.action,
    endpointHash: push.endpointHash('https://push.example/send/fixture'),
    p256dh: b64url(point),
    auth: fields.key
  }
  t.is(verifyPushDevice({ ...fields, signature: push.signPush(webFields, keyPair) }), false)
  t.alike(push.verifyPush(webFields, sign(fields)), { ok: false, reason: 'bad-signature' })
})

test('validators: nonce, hex, action, transport and canonical key edges', (t) => {
  for (const value of ['A'.repeat(43), 'z_-9'.repeat(32)]) t.ok(isNonce(value))
  for (const value of ['', 'A'.repeat(42), 'A'.repeat(129), fields.nonce + '\n', null, 43]) t.absent(isNonce(value))
  t.ok(isHex64(fields.member))
  for (const value of ['AB'.repeat(32), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), null]) t.absent(isHex64(value))
  for (const value of ACTIONS) t.ok(isAction(value))
  for (const value of ['ON', 'toggle', null, 1]) t.absent(isAction(value))
  for (const value of TRANSPORTS) t.ok(isTransport(value))
  for (const value of ['APNS', 'web', null, 1]) t.absent(isTransport(value))
  for (const last of ['A', 'Q', 'g', 'w']) t.ok(isKey('_'.repeat(21) + last))
  for (const value of [null, 1, '', 'A'.repeat(21), 'A'.repeat(23), 'A'.repeat(21) + 'B', fields.key + '=', fields.key + '\n', '+'.repeat(21) + 'A', '/'.repeat(21) + 'A']) t.absent(isKey(value))
})

test('token shape boundaries and hash rejection', (t) => {
  for (const token of ['a'.repeat(64), 'a'.repeat(65), 'a'.repeat(200)]) t.ok(isToken('apns', token))
  for (const token of ['a', 'Ab_09:-', 'a'.repeat(4096)]) t.ok(isToken('fcm', token))
  for (const transport of TRANSPORTS) {
    const invalid = transport === 'apns'
      ? ['a'.repeat(63), 'a'.repeat(201), 'AB'.repeat(32), 'g'.repeat(64)]
      : ['a'.repeat(4097), 'abc=', 'abc/', 'abc+', 'é', '\ud800']
    for (const token of [...invalid, '', null, undefined, 1, {}, 'a b', 'a\n', 'a\r', 'a\t']) {
      t.absent(isToken(transport, token))
      t.exception.all(() => tokenHash(transport, token), TypeError)
    }
  }
  t.absent(isToken('web', 'abc'))
  t.exception.all(() => tokenHash('web', 'abc'), TypeError)
})

test('invalid fields return null and never verify', (t) => {
  const signature = sign(fields)
  const invalid = [undefined, null, [], 'x', 1, { ...fields, extra: 1 }, { ...fields, [Symbol('extra')]: 1 }]
  for (const key of Object.keys(fields)) {
    const missing = { ...fields }
    delete missing[key]
    invalid.push(missing, { ...fields, [key]: null }, { ...fields, [key]: 1 }, { ...fields, [key]: '' }, { ...fields, [key]: fields[key] + '\n' })
  }
  for (const [key, value] of [
    ['nonce', 'A'.repeat(42)], ['nonce', 'A'.repeat(129)],
    ['member', 'AB'.repeat(32)], ['association', 'a'.repeat(63)],
    ['action', 'ON'], ['transport', 'web'], ['tokenHash', 'AB'.repeat(32)],
    ['key', 'A'.repeat(21) + 'B'], ['key', fields.key + '=']
  ]) invalid.push({ ...fields, [key]: value })
  for (const value of invalid) {
    t.is(pushDevicePayload(value), null)
    t.is(verifyPushDevice(value && typeof value === 'object' ? { ...value, signature } : value), false)
  }
  for (const value of [null, undefined, 1, '', signature.toUpperCase(), signature.slice(1), signature + '0', signature + '\n', 'g'.repeat(128)]) {
    t.is(verifyPushDevice({ ...fields, signature: value }), false)
  }
})

test('accessors and object traps cannot change checked bytes', (t) => {
  const signature = sign(fields)
  const accessor = (value) => Object.defineProperty(value, 'nonce', { get () { throw new Error('getter called') } })
  const hidden = (value) => Object.defineProperty(value, 'extra', { value: 1 })
  const traps = ['ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map((trap) => (value) => new Proxy(value, { [trap] () { throw new Error('trap called') } }))
  for (const alter of [accessor, hidden, ...traps]) {
    t.is(pushDevicePayload(alter({ ...fields })), null)
    t.is(verifyPushDevice(alter({ ...fields, signature })), false)
  }
  t.is(verifyPushDevice(Object.defineProperty({ ...fields }, 'signature', { get () { throw new Error('signature getter called') } })), false)
})
