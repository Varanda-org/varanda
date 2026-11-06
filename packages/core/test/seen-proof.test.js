'use strict'

// lib/seen-proof.js: the exact bytes, that every field is bound by the
// signature, domain separation from the push and terms statements, shape
// checks, blob hashing, and that the module stays pure (no fs, no network).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PREFIX,
  SEEN_ACTIONS,
  HASH_NONE,
  NONCE_RE,
  seenPayload,
  blobHash,
  signSeen,
  verifySeen
} = require('../lib/seen-proof')
const terms = require('../lib/terms')
const push = require('../lib/push-proof')

const coreRoot = path.join(__dirname, '..')

const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)
const BLOB = b4a.from('ciphertext')
const H1 = blobHash(BLOB)
const H2 = blobHash(b4a.from('ciphertext2'))

const FIELDS = {
  nonce: NONCE,
  member: MEMBER,
  association: ASSOCIATION,
  action: 'write',
  prevHash: HASH_NONE,
  newHash: H1
}

test('constants', (t) => {
  t.is(PREFIX, 'varanda-seen-v1')
  t.alike([...SEEN_ACTIONS], ['read', 'write', 'delete'])
  t.ok(Object.isFrozen(SEEN_ACTIONS))
  t.is(HASH_NONE, '0'.repeat(64))
  t.is(NONCE_RE.source, terms.NONCE_RE.source, 'same nonce rule as terms')
})

test('blobHash: lowercase hex BLAKE2b-256 of the exact bytes', (t) => {
  t.is(H1, '14e1acccbe57ed5ba853ba820d0a9d59b279a0405d34a367aa7af45caa8be3c3')
  t.is(H1, b4a.toString(crypto.hash(BLOB), 'hex'))
  t.is(blobHash(b4a.from('ciphertext')), H1, 'deterministic')
  t.not(H2, H1)
  t.ok(/^[0-9a-f]{64}$/.test(blobHash(b4a.alloc(0))), 'empty bytes hash')
  for (const bad of [null, undefined, 'ciphertext', 42, [1, 2], { byteLength: 3 }]) {
    t.exception.all(() => blobHash(bad), TypeError, 'refused: ' + String(bad))
  }
})

test('exact bytes and a fixed signature vector', (t) => {
  const payload = seenPayload(FIELDS)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-seen-v1',
    NONCE,
    '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c',
    ASSOCIATION,
    'write',
    '0'.repeat(64),
    '14e1acccbe57ed5ba853ba820d0a9d59b279a0405d34a367aa7af45caa8be3c3'
  ].join('\n'))
  t.is(payload.byteLength, 325)
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  const signature = signSeen(FIELDS, MEMBER_KP)
  t.is(signature, '7c0df4a714487bec08f9763105b0a3713bb307ed18dd2591f96c086314fba47c39151d2e678da4d86440f47c3b1a479ea49a0cd28ba373abbf198a1948c7f30a')
  t.alike(verifySeen(FIELDS, signature), { ok: true })
})

test('sign and verify round trip for every action', (t) => {
  const kp = crypto.keyPair()
  const member = b4a.toString(kp.publicKey, 'hex')
  const cases = [
    { action: 'read', prevHash: HASH_NONE, newHash: HASH_NONE },
    { action: 'read', prevHash: H1, newHash: HASH_NONE },
    { action: 'write', prevHash: HASH_NONE, newHash: H1 },
    { action: 'write', prevHash: H1, newHash: H2 },
    { action: 'delete', prevHash: H1, newHash: HASH_NONE },
    { action: 'delete', prevHash: HASH_NONE, newHash: HASH_NONE }
  ]
  for (const c of cases) {
    const fields = { ...FIELDS, ...c, member, nonce: 'z_-9'.repeat(32) }
    const signature = signSeen(fields, kp)
    t.ok(/^[0-9a-f]{128}$/.test(signature))
    t.alike(verifySeen(fields, signature), { ok: true }, c.action)
    t.alike(verifySeen(Object.assign(Object.create(null), fields), signature), { ok: true }, 'null prototype verifies')
  }
})

test('every field is bound by the signature', (t) => {
  const fields = { ...FIELDS, prevHash: H2 }
  const signature = signSeen(fields, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    nonce: { nonce: 'B'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    association: { association: 'ef'.repeat(32) },
    prevHash: { prevHash: H1 },
    'prevHash to none': { prevHash: HASH_NONE },
    newHash: { newHash: blobHash(b4a.from('x')) }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifySeen({ ...fields, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  t.alike(verifySeen(fields, signSeen(fields, other)), { ok: false, reason: 'bad-signature' }, 'another key')
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifySeen(fields, flipped), { ok: false, reason: 'bad-signature' }, 'one flipped digit')
})

test('action swapped: a read signature is not a delete, and vice versa', (t) => {
  const read = { ...FIELDS, action: 'read', prevHash: H1, newHash: HASH_NONE }
  const del = { ...read, action: 'delete' }
  t.alike(verifySeen(del, signSeen(read, MEMBER_KP)), { ok: false, reason: 'bad-signature' }, 'read as delete')
  t.alike(verifySeen(read, signSeen(del, MEMBER_KP)), { ok: false, reason: 'bad-signature' }, 'delete as read')
})

test('push and terms signatures by the member key are not seen statements, and vice versa', (t) => {
  const sigSeen = signSeen(FIELDS, MEMBER_KP)

  const termsFields = { nonce: NONCE, member: MEMBER, association: ASSOCIATION, version: 1 }
  const sigTerms = terms.signTerms(termsFields, MEMBER_KP)
  t.alike(verifySeen(FIELDS, sigTerms), { ok: false, reason: 'bad-signature' }, 'terms as seen')
  t.alike(terms.verifyTerms(termsFields, sigSeen), { ok: false, reason: 'bad-signature' }, 'seen as terms')
  t.absent(crypto.verify(terms.termsPayload(termsFields), b4a.from(sigSeen, 'hex'), MEMBER_KP.publicKey))

  const point = b4a.alloc(65, 7)
  point[0] = 0x04
  const b64url = (bytes) => b4a.toString(bytes, 'base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const pushFields = {
    nonce: NONCE,
    member: MEMBER,
    association: ASSOCIATION,
    action: 'on',
    endpointHash: H1,
    p256dh: b64url(point),
    auth: b64url(b4a.alloc(16, 9))
  }
  const sigPush = push.signPush(pushFields, MEMBER_KP)
  t.alike(verifySeen(FIELDS, sigPush), { ok: false, reason: 'bad-signature' }, 'push as seen')
  t.alike(push.verifyPush(pushFields, sigSeen), { ok: false, reason: 'bad-signature' }, 'seen as push')
  t.absent(crypto.verify(push.pushPayload(pushFields), b4a.from(sigSeen, 'hex'), MEMBER_KP.publicKey))

  t.ok(b4a.toString(seenPayload(FIELDS)).startsWith('varanda-seen-v1\n'))
})

test('shape: payload throws TypeError, verify answers malformed and never throws', (t) => {
  const missing = { ...FIELDS }
  delete missing.newHash
  const bad = [
    null,
    [],
    'x',
    42,
    missing,
    { ...FIELDS, extra: 1 },
    { ...FIELDS, action: 'WRITE' },
    { ...FIELDS, action: 'on' },
    { ...FIELDS, action: null },
    { ...FIELDS, nonce: 'a'.repeat(42) },
    { ...FIELDS, nonce: 'a'.repeat(42) + '+' },
    { ...FIELDS, nonce: 'a'.repeat(129) },
    { ...FIELDS, member: MEMBER.toUpperCase() },
    { ...FIELDS, member: MEMBER.slice(1) },
    { ...FIELDS, association: ASSOCIATION.slice(1) },
    { ...FIELDS, prevHash: '' },
    { ...FIELDS, prevHash: H2.toUpperCase() },
    { ...FIELDS, prevHash: null },
    { ...FIELDS, newHash: H1 + '0' },
    { ...FIELDS, newHash: b4a.from(H1, 'hex') },
    { ...FIELDS, newHash: HASH_NONE },
    { ...FIELDS, action: 'read', newHash: H1 },
    { ...FIELDS, action: 'delete', newHash: H1 }
  ]
  const signature = signSeen(FIELDS, MEMBER_KP)
  for (const fields of bad) {
    const label = JSON.stringify(fields) || String(fields)
    t.exception.all(() => seenPayload(fields), TypeError, label)
    t.exception.all(() => signSeen(fields, MEMBER_KP), TypeError, 'sign ' + label)
    t.alike(verifySeen(fields, signature), { ok: false, reason: 'malformed' }, label)
  }
  for (const sig of [null, undefined, '', signature.toUpperCase(), signature.slice(2), signature + '00', 'g' + signature.slice(1), 42, b4a.from(signature, 'hex')]) {
    t.alike(verifySeen(FIELDS, sig), { ok: false, reason: 'malformed' }, 'signature ' + String(sig).slice(0, 8))
  }
  t.alike(verifySeen(), { ok: false, reason: 'malformed' }, 'no arguments')

  const getter = { ...FIELDS }
  Object.defineProperty(getter, 'newHash', { get () { return H1 }, enumerable: true })
  const throwing = { ...FIELDS }
  Object.defineProperty(throwing, 'nonce', { get () { throw new Error('boom') }, enumerable: true })
  const hidden = { ...FIELDS }
  Object.defineProperty(hidden, 'x', { value: 1, enumerable: false })
  const sym = { ...FIELDS, [Symbol('x')]: 1 }
  const trapping = new Proxy({ ...FIELDS }, { ownKeys () { throw new Error('boom') } })
  const lying = new Proxy({ ...FIELDS }, { getOwnPropertyDescriptor () { throw new Error('boom') } })
  const protoTrap = new Proxy({ ...FIELDS }, { getPrototypeOf () { throw new Error('boom') } })
  for (const [label, hostile] of [['getter', getter], ['throwing getter', throwing], ['hidden key', hidden], ['symbol key', sym], ['ownKeys trap', trapping], ['descriptor trap', lying], ['prototype trap', protoTrap]]) {
    t.alike(verifySeen(hostile, signature), { ok: false, reason: 'malformed' }, label)
  }
  t.exception.all(() => seenPayload(getter), TypeError, 'getter refused by payload')

  t.exception.all(() => signSeen(FIELDS, null), TypeError)
  t.exception.all(() => signSeen(FIELDS, { secretKey: b4a.alloc(32) }), TypeError)
})

test('the module is pure: no fs, no network', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/seen-proof.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'seen-proof.js')).map(([id]) => id)
  t.alike(own.sort(), ['b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path', '#process']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
