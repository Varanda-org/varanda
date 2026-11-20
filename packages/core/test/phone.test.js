'use strict'

// lib/phone.js: the exact bytes (golden vector), that every field is bound by
// the signature, domain separation from the age, terms and invite statements,
// that no phone number enters the signed bytes, the Brazilian mobile rule,
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
  BR_MOBILE_RE,
  isBrMobile,
  phonePayload,
  signPhone,
  verifyPhone
} = require('../lib/phone')
const age = require('../lib/age')
const terms = require('../lib/terms')
const invite = require('../lib/invite')

const coreRoot = path.join(__dirname, '..')

// Fixed keys: the member pair from a seed of 32 bytes 0x01.
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)
const PHONE = '+5511912345678'

const FIELDS = {
  action: 'send',
  nonce: NONCE,
  member: MEMBER,
  association: ASSOCIATION
}

test('constants', (t) => {
  t.is(PREFIX, 'varanda-phone-v1')
  t.alike(ACTIONS, ['send', 'check', 'status'])
  t.ok(Object.isFrozen(ACTIONS))
  t.is(NONCE_RE.source, age.NONCE_RE.source, 'same nonce rule as age')
  t.is(NONCE_RE.source, terms.NONCE_RE.source, 'same nonce rule as terms')
  t.ok(NONCE_RE.test('A-_9'.repeat(32)))
  t.absent(NONCE_RE.test('a'.repeat(42)))
  t.absent(NONCE_RE.test('a'.repeat(129)))
  t.is(BR_MOBILE_RE.source, '^\\+55[1-9][1-9]9[0-9]{8}$')
})

test('golden vector: exact bytes and signature', (t) => {
  t.is(MEMBER, '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c')
  const payload = phonePayload(FIELDS)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-phone-v1',
    'send',
    NONCE,
    MEMBER,
    ASSOCIATION
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  const signature = signPhone(FIELDS, MEMBER_KP)
  t.is(signature, 'e5967a280ffb4e48d2abc0ffbfe8285d7926b0f51e4f8c52641e2fa23291bbddea21928310fff2cc7d137903fafe0bcb0b4e04deaa789c62e9b9b796abb3b905')
  t.alike(verifyPhone(FIELDS, signature), { ok: true })
})

test('no phone number and no code in the signed bytes', (t) => {
  const withExtras = { ...FIELDS, phone: PHONE, code: '123456' }
  const text = b4a.toString(phonePayload(withExtras), 'utf8')
  t.is(text, b4a.toString(phonePayload(FIELDS), 'utf8'), 'extra fields are ignored')
  t.absent(text.includes(PHONE), 'no number')
  t.absent(text.includes('5511912345678'), 'no digits of the number')
  t.absent(text.includes('123456'), 'no code')
  t.is(text.split('\n').length, 5, 'prefix and four fields only')
})

test('sign and verify round trip, all three actions', (t) => {
  const kp = crypto.keyPair()
  for (const action of ACTIONS) {
    const fields = { action, nonce: 'z_-9'.repeat(32), member: b4a.toString(kp.publicKey, 'hex'), association: ASSOCIATION }
    const signature = signPhone(fields, kp)
    t.ok(/^[0-9a-f]{128}$/.test(signature))
    t.alike(verifyPhone(fields, signature), { ok: true }, action)
    t.alike(verifyPhone({ ...fields }, signature), { ok: true }, 'a copy verifies')
  }
})

test('every field is bound by the signature', (t) => {
  const signature = signPhone(FIELDS, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    action: { action: 'check' },
    nonce: { nonce: 'B'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    association: { association: 'ef'.repeat(32) }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyPhone({ ...FIELDS, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  for (const action of ACTIONS) {
    const sig = signPhone({ ...FIELDS, action }, MEMBER_KP)
    for (const swapped of ACTIONS.filter((a) => a !== action)) {
      t.alike(verifyPhone({ ...FIELDS, action: swapped }, sig), { ok: false, reason: 'bad-signature' }, action + ' as ' + swapped)
    }
  }
  t.alike(verifyPhone(FIELDS, signPhone(FIELDS, other)), { ok: false, reason: 'bad-signature' }, 'another key')
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifyPhone(FIELDS, flipped), { ok: false, reason: 'bad-signature' }, 'one flipped digit')
})

test('age, terms and invite signatures by the member key are not phone requests, and vice versa', (t) => {
  const termsFields = { nonce: NONCE, member: MEMBER, association: ASSOCIATION, version: terms.TERMS_VERSION }
  const sigTerms = terms.signTerms(termsFields, MEMBER_KP)
  const inviteFields = { action: 'issue', nonce: NONCE, member: MEMBER, association: ASSOCIATION }
  const sigInvite = invite.signInvite(inviteFields, MEMBER_KP)

  for (const action of ACTIONS) {
    const fields = { ...FIELDS, action }
    const sigPhone = signPhone(fields, MEMBER_KP)
    t.alike(verifyPhone(fields, sigTerms), { ok: false, reason: 'bad-signature' }, 'terms as phone ' + action)
    t.alike(verifyPhone(fields, sigInvite), { ok: false, reason: 'bad-signature' }, 'invite as phone ' + action)
    t.alike(terms.verifyTerms(termsFields, sigPhone), { ok: false, reason: 'bad-signature' }, 'phone ' + action + ' as terms')
    t.alike(invite.verifyInvite(inviteFields, sigPhone), { ok: false, reason: 'bad-signature' }, 'phone ' + action + ' as invite')
    for (const ageAction of age.ACTIONS) {
      const ageFields = { ...fields, action: ageAction }
      t.alike(age.verifyAge(ageFields, sigPhone), { ok: false, reason: 'bad-signature' }, 'phone ' + action + ' as age ' + ageAction)
      t.alike(verifyPhone(fields, age.signAge(ageFields, MEMBER_KP)), { ok: false, reason: 'bad-signature' }, 'age ' + ageAction + ' as phone ' + action)
    }
  }
  // The same fields byte for byte after the prefix line: only the prefix
  // keeps a phone request and an age request apart.
  const rest = b4a.toString(phonePayload(FIELDS)).split('\n').slice(1).join('\n')
  const asAge = b4a.toString(crypto.sign(b4a.from(age.PREFIX + '\n' + rest), MEMBER_KP.secretKey), 'hex')
  t.alike(verifyPhone(FIELDS, asAge), { ok: false, reason: 'bad-signature' }, 'age prefix over phone fields')
  t.absent(crypto.verify(b4a.from(age.PREFIX + '\n' + rest), b4a.from(signPhone(FIELDS, MEMBER_KP), 'hex'), MEMBER_KP.publicKey))
  t.ok(b4a.toString(phonePayload(FIELDS)).startsWith('varanda-phone-v1\n'))
})

test('isBrMobile: only a Brazilian mobile in E.164', (t) => {
  t.ok(isBrMobile(PHONE))
  t.ok(isBrMobile('+5521987654321'))
  t.ok(isBrMobile('+5599999999999'))
  const refused = [
    ['+551132345678', 'landline'],
    ['+5501912345678', 'area code starting with 0'],
    ['+5510912345678', 'area code ending with 0'],
    ['+5511812345678', 'no mobile 9'],
    ['+14155552671', 'another country'],
    ['+351912345678', 'Portugal'],
    ['5511912345678', 'missing +'],
    ['005511912345678', 'international prefix instead of +'],
    ['+551191234567', 'too short'],
    ['+55119123456789', 'too long'],
    ['+55 11 91234-5678', 'formatted'],
    ['+5511912345678\n', 'trailing LF'],
    [' +5511912345678', 'leading space'],
    ['+5511９12345678', 'full-width digit'],
    ['', 'empty']
  ]
  for (const [value, label] of refused) t.absent(isBrMobile(value), label)
  for (const value of [null, undefined, 5511912345678, ['+5511912345678'], { toString: () => PHONE }, new String(PHONE)]) { // eslint-disable-line no-new-wrappers
    t.is(isBrMobile(value), false, 'non-string ' + typeof value)
  }
})

test('shape: payload throws TypeError, verify answers malformed and never throws', (t) => {
  const bad = [
    null,
    undefined,
    [],
    'x',
    42,
    new Map(),
    { ...FIELDS, action: 'session' },
    { ...FIELDS, action: 'Send' },
    { ...FIELDS, action: '' },
    { ...FIELDS, action: null },
    { ...FIELDS, nonce: 'a'.repeat(42) },
    { ...FIELDS, nonce: 'a'.repeat(42) + '+' },
    { ...FIELDS, nonce: 'a'.repeat(42) + '\n' },
    { ...FIELDS, nonce: 'a'.repeat(129) },
    { ...FIELDS, nonce: 1 },
    { ...FIELDS, member: MEMBER.toUpperCase() },
    { ...FIELDS, member: MEMBER.slice(1) },
    { ...FIELDS, member: null },
    { ...FIELDS, association: ASSOCIATION.toUpperCase() },
    { ...FIELDS, association: ASSOCIATION.slice(1) },
    { ...FIELDS, association: undefined }
  ]
  const signature = signPhone(FIELDS, MEMBER_KP)
  for (const fields of bad) {
    const label = String(JSON.stringify(fields))
    t.exception.all(() => phonePayload(fields), TypeError, label)
    t.exception.all(() => signPhone(fields, MEMBER_KP), TypeError, 'sign ' + label)
    t.alike(verifyPhone(fields, signature), { ok: false, reason: 'malformed' }, label)
  }
  for (const sig of [null, undefined, '', signature.toUpperCase(), signature.slice(2), signature + '00', 'g' + signature.slice(1), 42, {}]) {
    t.alike(verifyPhone(FIELDS, sig), { ok: false, reason: 'malformed' }, 'signature ' + String(sig).slice(0, 8))
  }
  const hostile = { get action () { throw new Error('boom') } }
  t.alike(verifyPhone(hostile, signature), { ok: false, reason: 'malformed' })
  t.alike(verifyPhone(), { ok: false, reason: 'malformed' })
  t.exception.all(() => signPhone(FIELDS, null), TypeError)
  t.exception.all(() => signPhone(FIELDS, { secretKey: b4a.alloc(32) }), TypeError)
})

test('the module is pure: no fs, no network, no cert.js', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/phone.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'phone.js')).map(([id]) => id)
  t.alike(own.sort(), ['b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
