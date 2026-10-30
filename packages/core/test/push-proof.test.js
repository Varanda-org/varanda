'use strict'

// lib/push-proof.js: the exact bytes, that every field is bound by the
// signature, domain separation from the terms statement, shape checks,
// endpoint hashing, and that the module stays pure (no fs, no network).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PREFIX,
  PUSH_ACTIONS,
  NONCE_RE,
  ENDPOINT_MAX,
  endpointHash,
  pushPayload,
  signPush,
  verifyPush
} = require('../lib/push-proof')
const terms = require('../lib/terms')

const coreRoot = path.join(__dirname, '..')

function b64url (bytes) {
  return b4a.toString(bytes, 'base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123'
const POINT = b4a.alloc(65, 7)
POINT[0] = 0x04
const P256DH = b64url(POINT)
const AUTH = b64url(b4a.alloc(16, 9))

const FIELDS = {
  nonce: NONCE,
  member: MEMBER,
  association: ASSOCIATION,
  action: 'on',
  endpointHash: endpointHash(ENDPOINT),
  p256dh: P256DH,
  auth: AUTH
}

test('constants', (t) => {
  t.is(PREFIX, 'varanda-push-v1')
  t.alike([...PUSH_ACTIONS], ['on', 'off'])
  t.ok(Object.isFrozen(PUSH_ACTIONS))
  t.is(NONCE_RE.source, terms.NONCE_RE.source, 'same nonce rule as terms')
  t.is(ENDPOINT_MAX, 2048)
  t.is(P256DH.length, 87)
  t.is(AUTH.length, 22)
})

test('endpointHash: hex hash of the UTF-8 bytes, https only, bounded', (t) => {
  const h = endpointHash(ENDPOINT)
  t.ok(/^[0-9a-f]{64}$/.test(h))
  t.is(h, b4a.toString(crypto.hash(b4a.from(ENDPOINT, 'utf8')), 'hex'))
  t.is(endpointHash(ENDPOINT), h, 'deterministic')
  t.not(endpointHash(ENDPOINT + 'x'), h)
  const max = 'https://' + 'a'.repeat(ENDPOINT_MAX - 8)
  t.is(max.length, 2048)
  t.ok(/^[0-9a-f]{64}$/.test(endpointHash(max)), '2048 chars accepted')
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc',
    max + 'a',
    '',
    'https:/x',
    'HTTPS://x',
    null,
    undefined,
    42,
    b4a.from(ENDPOINT),
    { toString: () => ENDPOINT }
  ]) {
    t.exception.all(() => endpointHash(bad), TypeError, 'refused: ' + String(bad).slice(0, 24))
  }
})

test('endpointHash: only strings fetch would request unchanged', (t) => {
  for (const good of [
    'https://fcm.googleapis.com/fcm/send/abc:APA91b-x_y?z=1',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA?a=b&c=d',
    'https://web.push.apple.com/QGxy-z_1?x=%20',
    'https://fcm.googleapis.com?q=a@b'
  ]) {
    t.ok(/^[0-9a-f]{64}$/.test(endpointHash(good)), 'accepted: ' + good)
  }
  for (const [label, bad] of [
    ['tab', 'https://fcm.googleapis.com/fcm/send/a\tb'],
    ['CR', 'https://fcm.googleapis.com/fcm/send/a\rb'],
    ['LF', 'https://fcm.googleapis.com/fcm/send/a\nb'],
    ['space', 'https://fcm.googleapis.com/fcm/send/a b'],
    ['backslash', 'https://fcm.googleapis.com\\fcm/send/ab'],
    ['fragment', 'https://fcm.googleapis.com/fcm/send/ab#x'],
    ['userinfo', 'https://u:p@fcm.googleapis.com/x'],
    ['userinfo host', 'https://fcm.googleapis.com@evil.example/x'],
    ['lone surrogate', 'https://fcm.googleapis.com/fcm/send/a\ud800'],
    ['U+FFFD', 'https://fcm.googleapis.com/fcm/send/a�'],
    ['non-ASCII', 'https://fcm.googleapis.com/fcm/send/é'],
    ['DEL', 'https://fcm.googleapis.com/fcm/send/a\x7f']
  ]) {
    t.exception.all(() => endpointHash(bad), TypeError, 'refused: ' + label)
  }
})

test('exact bytes', (t) => {
  const payload = pushPayload(FIELDS)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-push-v1',
    NONCE,
    MEMBER,
    ASSOCIATION,
    'on',
    FIELDS.endpointHash,
    P256DH,
    AUTH
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
})

test('sign and verify round trip with a random key pair', (t) => {
  const kp = crypto.keyPair()
  for (const action of PUSH_ACTIONS) {
    const fields = { ...FIELDS, member: b4a.toString(kp.publicKey, 'hex'), action, nonce: 'z_-9'.repeat(32) }
    const signature = signPush(fields, kp)
    t.ok(/^[0-9a-f]{128}$/.test(signature))
    t.alike(verifyPush(fields, signature), { ok: true }, action)
    t.alike(verifyPush({ ...fields }, signature), { ok: true }, 'a copy verifies')
    t.alike(verifyPush(Object.assign(Object.create(null), fields), signature), { ok: true }, 'null prototype verifies')
  }
})

test('every field is bound by the signature', (t) => {
  const signature = signPush(FIELDS, MEMBER_KP)
  const other = crypto.keyPair()
  const point = b4a.alloc(65, 8)
  point[0] = 0x04
  const changes = {
    action: { action: 'off' },
    nonce: { nonce: 'B'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    association: { association: 'ef'.repeat(32) },
    endpointHash: { endpointHash: endpointHash(ENDPOINT + '2') },
    p256dh: { p256dh: b64url(point) },
    auth: { auth: b64url(b4a.alloc(16, 10)) }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyPush({ ...FIELDS, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  t.alike(verifyPush(FIELDS, signPush(FIELDS, other)), { ok: false, reason: 'bad-signature' }, 'another key')
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifyPush(FIELDS, flipped), { ok: false, reason: 'bad-signature' }, 'one flipped digit')
})

test('terms signatures by the member key are not push statements, and vice versa', (t) => {
  const termsFields = { nonce: NONCE, member: MEMBER, association: ASSOCIATION, version: 1 }
  const sigTerms = terms.signTerms(termsFields, MEMBER_KP)
  const sigPush = signPush(FIELDS, MEMBER_KP)
  t.alike(verifyPush(FIELDS, sigTerms), { ok: false, reason: 'bad-signature' }, 'terms as push')
  t.alike(terms.verifyTerms(termsFields, sigPush), { ok: false, reason: 'bad-signature' }, 'push as terms')
  t.absent(crypto.verify(terms.termsPayload(termsFields), b4a.from(sigPush, 'hex'), MEMBER_KP.publicKey))
  t.ok(b4a.toString(pushPayload(FIELDS)).startsWith('varanda-push-v1\n'))
})

test('shape: payload throws TypeError, verify answers malformed and never throws', (t) => {
  const noPrefix = b4a.alloc(65, 7)
  const missing = { ...FIELDS }
  delete missing.auth
  const bad = [
    null,
    [],
    'x',
    missing,
    { ...FIELDS, extra: 1 },
    { ...FIELDS, action: 'ON' },
    { ...FIELDS, action: 'toggle' },
    { ...FIELDS, action: null },
    { ...FIELDS, nonce: 'a'.repeat(42) },
    { ...FIELDS, nonce: 'a'.repeat(42) + '+' },
    { ...FIELDS, nonce: 'a'.repeat(129) },
    { ...FIELDS, member: MEMBER.toUpperCase() },
    { ...FIELDS, member: MEMBER.slice(1) },
    { ...FIELDS, association: ASSOCIATION.slice(1) },
    { ...FIELDS, endpointHash: FIELDS.endpointHash.toUpperCase() },
    { ...FIELDS, endpointHash: ENDPOINT },
    { ...FIELDS, p256dh: b64url(noPrefix) },
    { ...FIELDS, p256dh: P256DH + '=' },
    { ...FIELDS, p256dh: P256DH.slice(1) },
    { ...FIELDS, p256dh: b4a.toString(POINT, 'base64') },
    { ...FIELDS, p256dh: P256DH.slice(0, -1) + 'B' },
    { ...FIELDS, auth: AUTH + 'A' },
    { ...FIELDS, auth: AUTH.slice(0, -1) + 'B' },
    { ...FIELDS, auth: b4a.toString(b4a.alloc(16, 9), 'base64') },
    { ...FIELDS, auth: 42 }
  ]
  const signature = signPush(FIELDS, MEMBER_KP)
  for (const fields of bad) {
    const label = JSON.stringify(fields) || String(fields)
    t.exception.all(() => pushPayload(fields), TypeError, label)
    t.alike(verifyPush(fields, signature), { ok: false, reason: 'malformed' }, label)
  }
  for (const sig of [null, undefined, '', signature.toUpperCase(), signature.slice(2), signature + '00', 'g' + signature.slice(1), 42]) {
    t.alike(verifyPush(FIELDS, sig), { ok: false, reason: 'malformed' }, 'signature ' + String(sig).slice(0, 8))
  }

  const getter = { ...FIELDS }
  Object.defineProperty(getter, 'auth', { get () { return AUTH }, enumerable: true })
  const throwing = { ...FIELDS }
  Object.defineProperty(throwing, 'nonce', { get () { throw new Error('boom') }, enumerable: true })
  const hidden = { ...FIELDS }
  Object.defineProperty(hidden, 'x', { value: 1, enumerable: false })
  const sym = { ...FIELDS, [Symbol('x')]: 1 }
  const trapping = new Proxy({ ...FIELDS }, {
    ownKeys () { throw new Error('boom') }
  })
  const lying = new Proxy({ ...FIELDS }, {
    getOwnPropertyDescriptor () { throw new Error('boom') }
  })
  const protoTrap = new Proxy({ ...FIELDS }, {
    getPrototypeOf () { throw new Error('boom') }
  })
  for (const [label, hostile] of [['getter', getter], ['throwing getter', throwing], ['hidden key', hidden], ['symbol key', sym], ['ownKeys trap', trapping], ['descriptor trap', lying], ['prototype trap', protoTrap]]) {
    t.alike(verifyPush(hostile, signature), { ok: false, reason: 'malformed' }, label)
  }
  t.exception.all(() => pushPayload(getter), TypeError, 'getter refused by payload')

  t.exception.all(() => signPush(FIELDS, null), TypeError)
  t.exception.all(() => signPush(FIELDS, { secretKey: b4a.alloc(32) }), TypeError)
})

test('the module is pure: no fs, no network, no cert.js', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/push-proof.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'push-proof.js')).map(([id]) => id)
  t.alike(own.sort(), ['b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
