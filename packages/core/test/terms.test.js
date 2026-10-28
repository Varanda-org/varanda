'use strict'

// lib/terms.js: the exact bytes (golden vector), that every field is bound
// by the signature, domain separation from the account-link and report
// statements, shape checks, and that the module stays pure (no fs, no
// network).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PREFIX,
  TERMS_VERSION,
  VERSION_MAX,
  NONCE_RE,
  isTermsVersion,
  termsPayload,
  signTerms,
  verifyTerms
} = require('../lib/terms')
const accountLink = require('../lib/account-link')
const report = require('../lib/report')

const coreRoot = path.join(__dirname, '..')

// Fixed keys: the member pair from a seed of 32 bytes 0x01.
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)

const FIELDS = {
  nonce: NONCE,
  member: MEMBER,
  association: ASSOCIATION,
  version: 1
}

test('constants', (t) => {
  t.is(PREFIX, 'varanda-terms-v1')
  t.is(TERMS_VERSION, 2)
  t.is(VERSION_MAX, 9999)
  t.is(NONCE_RE.source, accountLink.NONCE_RE.source, 'same nonce rule as account-link')
  t.ok(NONCE_RE.test('A-_9'.repeat(32)))
  t.absent(NONCE_RE.test('a'.repeat(42)))
  t.absent(NONCE_RE.test('a'.repeat(129)))
  t.ok(isTermsVersion(TERMS_VERSION))
  for (const v of [1, 2, 9999]) t.ok(isTermsVersion(v), 'version ' + v)
  for (const v of [0, -1, 10000, 1.5, '1', null, undefined, NaN, Infinity, 2 ** 53]) {
    t.absent(isTermsVersion(v), 'not a version: ' + String(v))
  }
})

test('golden vector: exact bytes and signature', (t) => {
  t.is(MEMBER, '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c')
  const payload = termsPayload(FIELDS)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-terms-v1',
    NONCE,
    MEMBER,
    ASSOCIATION,
    '1'
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  const signature = signTerms(FIELDS, MEMBER_KP)
  t.is(signature, '200a193cb85fbd5b903c16da579db37766ceefe1f130634adb13181953503071ffecdab5f49dcd394b22c16e0bfb7b34d59fc3cc102faf85ffebd25d9141f30c')
  t.alike(verifyTerms(FIELDS, signature), { ok: true })
})

test('sign and verify round trip', (t) => {
  const kp = crypto.keyPair()
  const fields = { ...FIELDS, member: b4a.toString(kp.publicKey, 'hex'), version: VERSION_MAX, nonce: 'z_-9'.repeat(32) }
  const signature = signTerms(fields, kp)
  t.ok(/^[0-9a-f]{128}$/.test(signature))
  t.alike(verifyTerms(fields, signature), { ok: true })
  t.alike(verifyTerms({ ...fields }, signature), { ok: true }, 'a copy verifies')
})

test('every field is bound by the signature', (t) => {
  const signature = signTerms(FIELDS, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    nonce: { nonce: 'B'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    association: { association: 'ef'.repeat(32) },
    version: { version: 2 }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyTerms({ ...FIELDS, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  // A signature by another key for the same member.
  t.alike(verifyTerms(FIELDS, signTerms(FIELDS, other)), { ok: false, reason: 'bad-signature' })
  // One flipped bit.
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifyTerms(FIELDS, flipped), { ok: false, reason: 'bad-signature' })
})

test('account-link and report signatures by the member key are not terms acceptances, and vice versa', (t) => {
  const sigTerms = signTerms(FIELDS, MEMBER_KP)
  const termsBytes = termsPayload(FIELDS)

  // Account link, every phase.
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
    t.alike(verifyTerms(FIELDS, sigLink), { ok: false, reason: 'bad-signature' }, 'account-link ' + phase + ' as terms')
    t.alike(accountLink.verifyAccountLink(link, sigTerms), { ok: false, reason: 'bad-signature' }, 'terms as account-link ' + phase)
    t.absent(crypto.verify(accountLink.accountLinkPayload(link), b4a.from(sigTerms, 'hex'), MEMBER_KP.publicKey))
  }

  // Report, on a post and on an account.
  const post = {
    nonce: NONCE,
    member: MEMBER,
    association: ASSOCIATION,
    target: 'ef'.repeat(32),
    seq: 1,
    reason: 'spam',
    text: '',
    quote: ''
  }
  for (const [label, rep] of [['post', post], ['account', { ...post, seq: null }]]) {
    const sigReport = report.signReport(rep, MEMBER_KP)
    t.alike(verifyTerms(FIELDS, sigReport), { ok: false, reason: 'bad-signature' }, 'report ' + label + ' as terms')
    t.alike(report.verifyReport(rep, sigTerms), { ok: false, reason: 'bad-signature' }, 'terms as report ' + label)
  }

  t.ok(b4a.toString(termsBytes).startsWith('varanda-terms-v1\n'))
})

test('shape: payload throws TypeError, verify answers malformed and never throws', (t) => {
  const bad = [
    null,
    [],
    'x',
    { ...FIELDS, version: 0 },
    { ...FIELDS, version: 10000 },
    { ...FIELDS, version: 1.5 },
    { ...FIELDS, version: '1' },
    { ...FIELDS, version: null },
    { ...FIELDS, version: undefined },
    { ...FIELDS, nonce: 'a'.repeat(42) },
    { ...FIELDS, nonce: 'a'.repeat(42) + '+' },
    { ...FIELDS, nonce: 'a'.repeat(129) },
    { ...FIELDS, member: MEMBER.toUpperCase() },
    { ...FIELDS, member: MEMBER.slice(1) },
    { ...FIELDS, association: ASSOCIATION.toUpperCase() },
    { ...FIELDS, association: ASSOCIATION.slice(1) }
  ]
  const signature = signTerms(FIELDS, MEMBER_KP)
  for (const fields of bad) {
    t.exception.all(() => termsPayload(fields), TypeError, JSON.stringify(fields))
    t.alike(verifyTerms(fields, signature), { ok: false, reason: 'malformed' }, JSON.stringify(fields))
  }
  for (const sig of [null, undefined, '', signature.toUpperCase(), signature.slice(2), signature + '00', 'g' + signature.slice(1), 42]) {
    t.alike(verifyTerms(FIELDS, sig), { ok: false, reason: 'malformed' }, 'signature ' + String(sig).slice(0, 8))
  }
  const hostile = { get nonce () { throw new Error('boom') } }
  t.alike(verifyTerms(hostile, signature), { ok: false, reason: 'malformed' })
  t.exception.all(() => signTerms(FIELDS, null), TypeError)
  t.exception.all(() => signTerms(FIELDS, { secretKey: b4a.alloc(32) }), TypeError)
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
    "require('./lib/terms.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'terms.js')).map(([id]) => id)
  t.alike(own.sort(), ['b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
