'use strict'

// lib/account-link.js: the exact bytes (golden vector), that every field is
// bound by the signature, domain separation from the certificate payloads,
// shape checks, and that the module stays pure (no fs, no network).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PREFIX,
  PHASES,
  NONCE_RE,
  SUB_RE,
  USERNAME_RE,
  isUsername,
  accountLinkPayload,
  signAccountLink,
  verifyAccountLink
} = require('../lib/account-link')
const cert = require('../lib/cert')

const coreRoot = path.join(__dirname, '..')

// Fixed keys: the member pair from a seed of 32 bytes 0x01.
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)

const FINISH = {
  phase: 'finish',
  nonce: NONCE,
  member: MEMBER,
  username: 'ana_1',
  association: ASSOCIATION,
  sub: '109876543210987654321'
}

test('constants', (t) => {
  t.alike([...PHASES], ['reserve', 'finish', 'rename'])
  t.ok(Object.isFrozen(PHASES))
  t.is(PREFIX, 'varanda-account-link-v1')
  t.ok(NONCE_RE.test('A-_9'.repeat(32)))
  t.absent(NONCE_RE.test('a'.repeat(42)))
  t.absent(NONCE_RE.test('a'.repeat(129)))
  t.absent(SUB_RE.test('a b'))
  t.absent(SUB_RE.test('a\nb'))
  t.absent(SUB_RE.test(''))
  t.is(USERNAME_RE.source, cert.USERNAME_RE.source, 'same rule as cert.js')
  for (const s of ['ana', 'ana_1', 'a' + 'b'.repeat(19), 'abc123', 'deadbe', 'Ana', '1ana', 'ab', 'a'.repeat(21), 'a-b', 'abcdefg', 'abc12z']) {
    t.is(isUsername(s), cert.isUsername(s), 'parity with cert.js: ' + s)
  }
})

test('golden vector: exact bytes and signature', (t) => {
  t.is(MEMBER, '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c')
  const payload = accountLinkPayload(FINISH)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-account-link-v1',
    'finish',
    NONCE,
    MEMBER,
    'ana_1',
    ASSOCIATION,
    '109876543210987654321'
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  const signature = signAccountLink(FINISH, MEMBER_KP)
  t.is(signature, '9ecdafa5508c7200c49d4952fa699bc8f57160269f83e8b445eb111e1af1ea763f8b2d4edd67083ce7f8af0008f4ba880b92677d9bd1fb82ab213bdea67ed00e')
  t.alike(verifyAccountLink(FINISH, signature), { ok: true })

  const reserve = { ...FINISH, phase: 'reserve', sub: '' }
  t.is(b4a.toString(accountLinkPayload(reserve), 'utf8'), ['varanda-account-link-v1', 'reserve', NONCE, MEMBER, 'ana_1', ASSOCIATION, ''].join('\n'), 'empty sub: the payload ends with LF + empty field')
})

test('every field is bound by the signature', (t) => {
  const signature = signAccountLink(FINISH, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    phase: { phase: 'reserve', sub: '' },
    nonce: { nonce: 'B'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    username: { username: 'ana_2' },
    association: { association: 'ef'.repeat(32) },
    sub: { sub: '109876543210987654322' }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyAccountLink({ ...FINISH, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  // A signature by another key for the same member.
  t.alike(verifyAccountLink(FINISH, signAccountLink(FINISH, other)), { ok: false, reason: 'bad-signature' })
  // One flipped bit.
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifyAccountLink(FINISH, flipped), { ok: false, reason: 'bad-signature' })
})

test('a phase never verifies as another phase', (t) => {
  const reserve = { ...FINISH, phase: 'reserve', sub: '' }
  const rename = { ...FINISH, phase: 'rename', sub: '' }
  const sigReserve = signAccountLink(reserve, MEMBER_KP)
  t.alike(verifyAccountLink(reserve, sigReserve), { ok: true })
  t.alike(verifyAccountLink(rename, sigReserve), { ok: false, reason: 'bad-signature' }, 'reserve is not rename')
  for (const sub of ['x', FINISH.sub]) {
    t.alike(verifyAccountLink({ ...reserve, phase: 'finish', sub }, sigReserve), { ok: false, reason: 'bad-signature' }, 'reserve is not finish')
  }
  const sigRename = signAccountLink(rename, MEMBER_KP)
  t.alike(verifyAccountLink(reserve, sigRename), { ok: false, reason: 'bad-signature' }, 'rename is not reserve')
})

test('certificate and issuer payloads signed by the member key are not account links', (t) => {
  const date = '2026-10-24T12:00:00.000Z'
  const v1 = cert.certPayload({ member: MEMBER, ageBand: '18+', method: 'stub', date, association: ASSOCIATION })
  const issuer = cert.issuerCertPayload({ issuer: MEMBER, date, association: ASSOCIATION })
  t.ok(b4a.toString(v1).startsWith('varanda-cert-v1\n'))
  t.ok(b4a.toString(issuer).startsWith('varanda-issuer-v1\n'))
  for (const [label, bytes] of [['v1 cert', v1], ['issuer', issuer]]) {
    const signature = b4a.toString(crypto.sign(bytes, MEMBER_KP.secretKey), 'hex')
    for (const phase of PHASES) {
      const fields = { ...FINISH, phase, sub: phase === 'finish' ? FINISH.sub : '' }
      t.alike(verifyAccountLink(fields, signature), { ok: false, reason: 'bad-signature' }, label + ' as ' + phase)
    }
  }
  // And the other way round: an account-link signature is no certificate.
  const link = b4a.from(signAccountLink(FINISH, MEMBER_KP), 'hex')
  t.absent(crypto.verify(v1, link, MEMBER_KP.publicKey))
  t.absent(crypto.verify(issuer, link, MEMBER_KP.publicKey))
})

test('shape: payload throws TypeError, verify answers malformed and never throws', (t) => {
  const bad = [
    null,
    [],
    'x',
    { ...FINISH, phase: 'link' },
    { ...FINISH, nonce: 'a'.repeat(42) },
    { ...FINISH, nonce: 'a'.repeat(42) + '=' },
    { ...FINISH, member: MEMBER.toUpperCase() },
    { ...FINISH, member: 'ab'.repeat(31) },
    { ...FINISH, username: 'Ana' },
    { ...FINISH, username: 'abc123' },
    { ...FINISH, association: ASSOCIATION.toUpperCase() },
    { ...FINISH, sub: '' },
    { ...FINISH, sub: 'a b' },
    { ...FINISH, sub: 'a\nb' },
    { ...FINISH, sub: 'x'.repeat(256) },
    { ...FINISH, sub: undefined },
    { ...FINISH, phase: 'reserve' },
    { ...FINISH, phase: 'rename' }
  ]
  const signature = signAccountLink(FINISH, MEMBER_KP)
  for (const fields of bad) {
    t.exception.all(() => accountLinkPayload(fields), TypeError, JSON.stringify(fields))
    t.alike(verifyAccountLink(fields, signature), { ok: false, reason: 'malformed' }, JSON.stringify(fields))
  }
  for (const sig of [null, '', signature.toUpperCase(), signature.slice(2), signature + '00', 42]) {
    t.alike(verifyAccountLink(FINISH, sig), { ok: false, reason: 'malformed' }, 'signature ' + String(sig).slice(0, 8))
  }
  const hostile = { get phase () { throw new Error('boom') } }
  t.alike(verifyAccountLink(hostile, signature), { ok: false, reason: 'malformed' })
  t.exception.all(() => signAccountLink(FINISH, null), TypeError)
  t.exception.all(() => signAccountLink(FINISH, { secretKey: b4a.alloc(32) }), TypeError)
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
    "require('./lib/account-link.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'account-link.js')).map(([id]) => id)
  t.alike(own.sort(), ['b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
