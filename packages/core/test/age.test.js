'use strict'

// lib/age.js: the exact bytes (golden vector), that every field is bound by
// the signature, domain separation from the terms and invite statements,
// shape checks, and that the module stays pure (no fs, no network).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PREFIX,
  ACTIONS,
  NONCE_RE,
  agePayload,
  signAge,
  verifyAge
} = require('../lib/age')
const terms = require('../lib/terms')
const invite = require('../lib/invite')

const coreRoot = path.join(__dirname, '..')

// Fixed keys: the member pair from a seed of 32 bytes 0x01.
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)

const FIELDS = {
  action: 'session',
  nonce: NONCE,
  member: MEMBER,
  association: ASSOCIATION
}

test('constants', (t) => {
  t.is(PREFIX, 'varanda-age-v1')
  t.alike(ACTIONS, ['session', 'result'])
  t.ok(Object.isFrozen(ACTIONS))
  t.is(NONCE_RE.source, terms.NONCE_RE.source, 'same nonce rule as terms')
  t.ok(NONCE_RE.test('A-_9'.repeat(32)))
  t.absent(NONCE_RE.test('a'.repeat(42)))
  t.absent(NONCE_RE.test('a'.repeat(129)))
})

test('golden vector: exact bytes and signature', (t) => {
  t.is(MEMBER, '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c')
  const payload = agePayload(FIELDS)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-age-v1',
    'session',
    NONCE,
    MEMBER,
    ASSOCIATION
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  const signature = signAge(FIELDS, MEMBER_KP)
  t.is(signature, '329b505d6d6e1743e401ddea83cf12476a1e06e37ebb795d56d21a098af430a82129a1c65df2a4016b7f1bfb3240d2553b8d43864dea17f303334a4c4b97680a')
  t.alike(verifyAge(FIELDS, signature), { ok: true })
})

test('sign and verify round trip, both actions', (t) => {
  const kp = crypto.keyPair()
  for (const action of ACTIONS) {
    const fields = { action, nonce: 'z_-9'.repeat(32), member: b4a.toString(kp.publicKey, 'hex'), association: ASSOCIATION }
    const signature = signAge(fields, kp)
    t.ok(/^[0-9a-f]{128}$/.test(signature))
    t.alike(verifyAge(fields, signature), { ok: true }, action)
    t.alike(verifyAge({ ...fields }, signature), { ok: true }, 'a copy verifies')
  }
})

test('every field is bound by the signature', (t) => {
  const signature = signAge(FIELDS, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    action: { action: 'result' },
    nonce: { nonce: 'B'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    association: { association: 'ef'.repeat(32) }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyAge({ ...FIELDS, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  t.alike(verifyAge(FIELDS, signAge(FIELDS, other)), { ok: false, reason: 'bad-signature' }, 'another key')
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifyAge(FIELDS, flipped), { ok: false, reason: 'bad-signature' }, 'one flipped digit')
})

test('terms and invite signatures by the member key are not age requests, and vice versa', (t) => {
  const termsFields = { nonce: NONCE, member: MEMBER, association: ASSOCIATION, version: terms.TERMS_VERSION }
  const sigTerms = terms.signTerms(termsFields, MEMBER_KP)
  const inviteFields = { action: 'issue', nonce: NONCE, member: MEMBER, association: ASSOCIATION }
  const sigInvite = invite.signInvite(inviteFields, MEMBER_KP)

  for (const action of ACTIONS) {
    const fields = { ...FIELDS, action }
    t.alike(verifyAge(fields, sigTerms), { ok: false, reason: 'bad-signature' }, 'terms as age ' + action)
    t.alike(verifyAge(fields, sigInvite), { ok: false, reason: 'bad-signature' }, 'invite as age ' + action)
    const sigAge = signAge(fields, MEMBER_KP)
    t.alike(terms.verifyTerms(termsFields, sigAge), { ok: false, reason: 'bad-signature' }, 'age ' + action + ' as terms')
    t.alike(invite.verifyInvite(inviteFields, sigAge), { ok: false, reason: 'bad-signature' }, 'age ' + action + ' as invite')
  }
  // Same action word on both sides: the prefix alone keeps them apart.
  t.absent(crypto.verify(invite.invitePayload(inviteFields), b4a.from(signAge(FIELDS, MEMBER_KP), 'hex'), MEMBER_KP.publicKey))
  t.ok(b4a.toString(agePayload(FIELDS)).startsWith('varanda-age-v1\n'))
})

test('shape: payload throws TypeError, verify answers malformed and never throws', (t) => {
  const bad = [
    null,
    undefined,
    [],
    'x',
    42,
    new Map(),
    { ...FIELDS, action: 'issue' },
    { ...FIELDS, action: 'Session' },
    { ...FIELDS, action: '' },
    { ...FIELDS, action: null },
    { ...FIELDS, nonce: 'a'.repeat(42) },
    { ...FIELDS, nonce: 'a'.repeat(42) + '+' },
    { ...FIELDS, nonce: 'a'.repeat(129) },
    { ...FIELDS, nonce: 1 },
    { ...FIELDS, member: MEMBER.toUpperCase() },
    { ...FIELDS, member: MEMBER.slice(1) },
    { ...FIELDS, member: null },
    { ...FIELDS, association: ASSOCIATION.toUpperCase() },
    { ...FIELDS, association: ASSOCIATION.slice(1) },
    { ...FIELDS, association: undefined }
  ]
  const signature = signAge(FIELDS, MEMBER_KP)
  for (const fields of bad) {
    const label = String(JSON.stringify(fields))
    t.exception.all(() => agePayload(fields), TypeError, label)
    t.exception.all(() => signAge(fields, MEMBER_KP), TypeError, 'sign ' + label)
    t.alike(verifyAge(fields, signature), { ok: false, reason: 'malformed' }, label)
  }
  for (const sig of [null, undefined, '', signature.toUpperCase(), signature.slice(2), signature + '00', 'g' + signature.slice(1), 42, {}]) {
    t.alike(verifyAge(FIELDS, sig), { ok: false, reason: 'malformed' }, 'signature ' + String(sig).slice(0, 8))
  }
  const hostile = { get action () { throw new Error('boom') } }
  t.alike(verifyAge(hostile, signature), { ok: false, reason: 'malformed' })
  t.alike(verifyAge(), { ok: false, reason: 'malformed' })
  t.exception.all(() => signAge(FIELDS, null), TypeError)
  t.exception.all(() => signAge(FIELDS, { secretKey: b4a.alloc(32) }), TypeError)
})

test('the module is pure: no fs, no network, no cert.js', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/age.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'age.js')).map(([id]) => id)
  t.alike(own.sort(), ['b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
