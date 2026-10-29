'use strict'

// lib/invite.js: the exact bytes (golden vector), that every field is bound
// by the signature, domain separation from the account-link and terms
// statements, shape checks, and that the module stays pure (no fs, no
// network).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PREFIX,
  ACTIONS,
  NONCE_RE,
  invitePayload,
  signInvite,
  verifyInvite
} = require('../lib/invite')
const accountLink = require('../lib/account-link')
const terms = require('../lib/terms')

const coreRoot = path.join(__dirname, '..')

// Fixed keys: the member pair from a seed of 32 bytes 0x01.
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)

const FIELDS = {
  action: 'issue',
  nonce: NONCE,
  member: MEMBER,
  association: ASSOCIATION
}

test('constants', (t) => {
  t.is(PREFIX, 'varanda-invite-v1')
  t.alike(ACTIONS, ['issue'])
  t.ok(Object.isFrozen(ACTIONS))
  t.is(NONCE_RE.source, accountLink.NONCE_RE.source, 'same nonce rule as account-link')
  t.is(NONCE_RE.source, terms.NONCE_RE.source, 'same nonce rule as terms')
})

test('golden vector: exact bytes and signature', (t) => {
  t.is(MEMBER, '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c')
  const payload = invitePayload(FIELDS)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-invite-v1',
    'issue',
    NONCE,
    MEMBER,
    ASSOCIATION
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  const signature = signInvite(FIELDS, MEMBER_KP)
  t.is(signature, 'c90cef7d2828e019c98327ec609d8e35eaf795d088b2145b8dff2c0bb03f7e6b9b1b96417aea0d77a54c3cce4da6149ddd7e2a654a8473a273d38ad855790906')
  t.alike(verifyInvite(FIELDS, signature), { ok: true })
})

test('sign and verify round trip', (t) => {
  const kp = crypto.keyPair()
  const fields = { ...FIELDS, member: b4a.toString(kp.publicKey, 'hex'), nonce: 'z_-9'.repeat(32) }
  const signature = signInvite(fields, kp)
  t.ok(/^[0-9a-f]{128}$/.test(signature))
  t.alike(verifyInvite(fields, signature), { ok: true })
  t.alike(verifyInvite({ ...fields }, signature), { ok: true }, 'a copy verifies')
})

test('every field is bound by the signature', (t) => {
  const signature = signInvite(FIELDS, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    nonce: { nonce: 'B'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    association: { association: 'ef'.repeat(32) }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyInvite({ ...FIELDS, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  // The action is bound too: the bytes for another action differ.
  const revokeBytes = b4a.from([PREFIX, 'revoke', NONCE, MEMBER, ASSOCIATION].join('\n'), 'utf8')
  t.absent(crypto.verify(revokeBytes, b4a.from(signature, 'hex'), MEMBER_KP.publicKey), 'action')
  t.alike(verifyInvite({ ...FIELDS, action: 'revoke' }, signature), { ok: false, reason: 'malformed' }, 'unknown action')
  // A signature by another key for the same member.
  t.alike(verifyInvite(FIELDS, signInvite(FIELDS, other)), { ok: false, reason: 'bad-signature' })
  // One flipped bit.
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifyInvite(FIELDS, flipped), { ok: false, reason: 'bad-signature' })
})

test('terms and account-link signatures over the same nonce are not invites, and vice versa', (t) => {
  const sigInvite = signInvite(FIELDS, MEMBER_KP)

  const termsFields = { nonce: NONCE, member: MEMBER, association: ASSOCIATION, version: 1 }
  const sigTerms = terms.signTerms(termsFields, MEMBER_KP)
  t.alike(verifyInvite(FIELDS, sigTerms), { ok: false, reason: 'bad-signature' }, 'terms as invite')
  t.alike(terms.verifyTerms(termsFields, sigInvite), { ok: false, reason: 'bad-signature' }, 'invite as terms')

  for (const phase of accountLink.PHASES) {
    const link = {
      phase,
      nonce: NONCE,
      member: MEMBER,
      username: 'ana_1',
      association: ASSOCIATION,
      sub: phase === 'finish' ? '109876543210987654321' : ''
    }
    const sigLink = accountLink.signAccountLink(link, MEMBER_KP)
    t.alike(verifyInvite(FIELDS, sigLink), { ok: false, reason: 'bad-signature' }, 'account-link ' + phase + ' as invite')
    t.alike(accountLink.verifyAccountLink(link, sigInvite), { ok: false, reason: 'bad-signature' }, 'invite as account-link ' + phase)
  }

  t.ok(b4a.toString(invitePayload(FIELDS)).startsWith('varanda-invite-v1\n'))
})

test('shape: payload throws TypeError, verify answers malformed and never throws', (t) => {
  const bad = [
    null,
    [],
    'x',
    { ...FIELDS, action: 'revoke' },
    { ...FIELDS, action: 'ISSUE' },
    { ...FIELDS, action: '' },
    { ...FIELDS, action: undefined },
    { ...FIELDS, nonce: 'a'.repeat(42) },
    { ...FIELDS, nonce: 'a'.repeat(42) + '+' },
    { ...FIELDS, nonce: 'a'.repeat(129) },
    { ...FIELDS, member: MEMBER.toUpperCase() },
    { ...FIELDS, member: MEMBER.slice(1) },
    { ...FIELDS, association: ASSOCIATION.toUpperCase() },
    { ...FIELDS, association: ASSOCIATION.slice(1) }
  ]
  const signature = signInvite(FIELDS, MEMBER_KP)
  for (const fields of bad) {
    t.exception.all(() => invitePayload(fields), TypeError, JSON.stringify(fields))
    t.alike(verifyInvite(fields, signature), { ok: false, reason: 'malformed' }, JSON.stringify(fields))
  }
  for (const sig of [null, undefined, '', signature.toUpperCase(), signature.slice(2), signature + '00', 'g' + signature.slice(1), 42]) {
    t.alike(verifyInvite(FIELDS, sig), { ok: false, reason: 'malformed' }, 'signature ' + String(sig).slice(0, 8))
  }
  const hostile = { get action () { throw new Error('boom') } }
  t.alike(verifyInvite(hostile, signature), { ok: false, reason: 'malformed' })
  t.exception.all(() => signInvite(FIELDS, null), TypeError)
  t.exception.all(() => signInvite(FIELDS, { secretKey: b4a.alloc(32) }), TypeError)
})

// hypercore-crypto loads sodium-native under Node, whose addon loader
// (require-addon) reads the prebuild with 'fs'; the browser bundle maps it to
// a pure-JS sodium. So the module's OWN requires are pinned, and no network
// module or '#fs' is required by anything it pulls in.
test('the module is pure: no fs, no network, no cert.js', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/invite.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'invite.js')).map(([id]) => id)
  t.alike(own.sort(), ['b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
