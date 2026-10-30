'use strict'

// lib/wallet-proof.js: the exact bytes (golden vector), the canonical
// operation and its hash, that every field is bound by the signature, domain
// separation from the age and push statements, forbidden operation keys,
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
  canonicalOp,
  opHash,
  walletPayload,
  signWallet,
  verifyWallet
} = require('../lib/wallet-proof')
const terms = require('../lib/terms')
const age = require('../lib/age')
const push = require('../lib/push-proof')

const coreRoot = path.join(__dirname, '..')

// Fixed keys: the member pair from a seed of 32 bytes 0x01.
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)
const OP = { kind: 'pf', amount: 1500 }
const OP_HASH = '12a02daa215a90d80fbd81b2b5933ddb65eda18ba0bed37cde4738c5eba888a4'

const FIELDS = {
  action: 'optin',
  nonce: NONCE,
  member: MEMBER,
  association: ASSOCIATION,
  opHash: OP_HASH
}

function b64url (bytes) {
  return b4a.toString(bytes, 'base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

test('constants', (t) => {
  t.is(PREFIX, 'varanda-wallet-v1')
  t.alike(ACTIONS, [
    'optin', 'kyc-document', 'kyc-submit', 'status', 'wallet-create', 'balance', 'statement', 'deposit',
    'payout-quote', 'preview', 'payout', 'op-status', 'transfer', 'send-crypto', 'swap-quote', 'swap'
  ])
  t.ok(Object.isFrozen(ACTIONS))
  t.is(NONCE_RE.source, terms.NONCE_RE.source, 'same nonce rule as terms')
  t.is(NONCE_RE.source, age.NONCE_RE.source, 'same nonce rule as age')
})

test('golden vector: canonical op, op hash, exact bytes and signature', (t) => {
  t.is(MEMBER, '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c')
  t.is(canonicalOp(OP), '{"amount":1500,"kind":"pf"}')
  t.is(opHash(OP), OP_HASH)
  t.is(OP_HASH, b4a.toString(crypto.hash(b4a.from('{"amount":1500,"kind":"pf"}', 'utf8')), 'hex'), 'hash of the UTF-8 bytes')
  t.is(canonicalOp({}), '{}')
  const payload = walletPayload(FIELDS)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-wallet-v1',
    'optin',
    NONCE,
    MEMBER,
    ASSOCIATION,
    OP_HASH
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  const signature = signWallet(FIELDS, MEMBER_KP)
  t.is(signature, 'd13d1504a6a6bd32d8fd63b97837e629969b6ab7868ff4f64029733e55e30bfafe9f4c993cefd07c2bfbc4327ab7defa678111cb634679dcd59a726ecb3af10d')
  t.alike(verifyWallet(FIELDS, signature), { ok: true })
})

test('canonical op: independent of key order, no whitespace, exact values', (t) => {
  const a = { amount: 10, pixKey: 'a b', quoteId: 'q1' }
  const b = { quoteId: 'q1', pixKey: 'a b', amount: 10 }
  t.is(canonicalOp(a), canonicalOp(b))
  t.is(opHash(a), opHash(b))
  t.is(canonicalOp(b), '{"amount":10,"pixKey":"a b","quoteId":"q1"}')
  const nullProto = Object.create(null)
  nullProto.kind = 'pf'
  nullProto.amount = 1500
  t.is(opHash(nullProto), OP_HASH, 'a null-prototype object hashes the same')
  t.not(opHash({ amount: '10' }), opHash({ amount: 10 }), 'a string and a number differ')
  t.not(opHash({ a: 'x', b: 'y' }), opHash({ a: 'xy' }))
  t.is(canonicalOp({ s: 'aspas " e \\ barra' }), '{"s":"aspas \\" e \\\\ barra"}')
  t.is(canonicalOp({ s: 'ção 😀' }), '{"s":"ção 😀"}', 'non-ASCII kept as UTF-8')
  const max = {}
  for (let i = 0; i < 16; i++) max['k' + i] = i
  t.ok(canonicalOp(max))
  t.ok(canonicalOp({ s: 'x'.repeat(512), n: Number.MAX_SAFE_INTEGER, z: 0, e: '' }))
  t.ok(canonicalOp({ ['a' + 'B'.repeat(31)]: 1 }), 'a 32-character key')
})

test('canonical op: reads every field once', (t) => {
  let reads = 0
  const op = {}
  Object.defineProperty(op, 'amount', { enumerable: true, get () { reads++; return reads === 1 ? 1 : 2 } })
  t.exception.all(() => canonicalOp(op), TypeError, 'an accessor is refused')
  let calls = 0
  const proxy = new Proxy({ amount: 1 }, {
    getOwnPropertyDescriptor (target, key) {
      calls++
      return Reflect.getOwnPropertyDescriptor(target, key)
    }
  })
  t.is(canonicalOp(proxy), '{"amount":1}')
  t.is(calls, 1, 'one read per key')
})

test('canonical op: forbidden keys and bad shapes throw TypeError', (t) => {
  for (const key of ['pin', 'walletPin', 'protectedSymmetricKey', 'taxId', 'taxIdNumber', 'cpf']) {
    t.exception.all(() => canonicalOp({ [key]: '1234' }), TypeError, 'forbidden ' + key)
    t.exception.all(() => opHash({ amount: 1, [key]: 1 }), TypeError, 'opHash forbidden ' + key)
  }
  const tooMany = {}
  for (let i = 0; i < 17; i++) tooMany['k' + i] = i
  const bad = [
    null,
    undefined,
    [],
    'x',
    42,
    new Map(),
    new Date(0),
    tooMany,
    { Amount: 1 },
    { '1a': 1 },
    { 'a-b': 1 },
    { a_b: 1 },
    { '': 1 },
    { ['a' + 'b'.repeat(32)]: 1 },
    { [Symbol('s')]: 1 },
    { s: 'x'.repeat(513) },
    { s: 'a\nb' },
    { s: 'a\tb' },
    { s: '\u0000' },
    { s: '\u007f' },
    { s: '\u0085' },
    { s: '\ud800' },
    { s: 'a\udc00' },
    { s: '\ud83d' + 'x' },
    { n: -1 },
    { n: 1.5 },
    { n: 2 ** 53 },
    { n: NaN },
    { n: Infinity },
    { n: true },
    { n: null },
    { n: {} },
    { n: [] },
    { n: 10n }
  ]
  for (const op of bad) {
    t.exception.all(() => canonicalOp(op), TypeError, 'canonical ' + typeof op)
    t.exception.all(() => opHash(op), TypeError, 'hash ' + typeof op)
  }
  const hidden = {}
  Object.defineProperty(hidden, 'amount', { value: 1, enumerable: false })
  t.exception.all(() => canonicalOp(hidden), TypeError, 'a non-enumerable key')
})

test('sign and verify round trip, every action', (t) => {
  const kp = crypto.keyPair()
  for (const action of ACTIONS) {
    const fields = { action, nonce: 'z_-9'.repeat(32), member: b4a.toString(kp.publicKey, 'hex'), association: ASSOCIATION, opHash: opHash({ action: 'x' }) }
    const signature = signWallet(fields, kp)
    t.ok(/^[0-9a-f]{128}$/.test(signature))
    t.alike(verifyWallet(fields, signature), { ok: true }, action)
    t.alike(verifyWallet({ ...fields }, signature), { ok: true }, 'a copy verifies')
  }
})

test('swap-quote and swap (receive USDC, convert to BRLA) sign over the operation', (t) => {
  const quote = { from: 'USDC', to: 'BRLA', amount: 2500000 }
  const fields = { ...FIELDS, action: 'swap-quote', opHash: opHash(quote) }
  const sigQuote = signWallet(fields, MEMBER_KP)
  t.alike(verifyWallet(fields, sigQuote), { ok: true })
  const swap = { quoteId: 'q-123', from: 'USDC', to: 'BRLA', amount: 2500000 }
  const swapFields = { ...FIELDS, action: 'swap', opHash: opHash(swap) }
  const sigSwap = signWallet(swapFields, MEMBER_KP)
  t.alike(verifyWallet(swapFields, sigSwap), { ok: true })
  t.alike(verifyWallet({ ...swapFields, action: 'swap-quote' }, sigSwap), { ok: false, reason: 'bad-signature' }, 'a swap is not a quote')
  t.alike(verifyWallet({ ...swapFields, opHash: opHash({ ...swap, amount: 2500001 }) }, sigSwap), { ok: false, reason: 'bad-signature' }, 'another amount')
})

test('every field is bound by the signature', (t) => {
  const signature = signWallet(FIELDS, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    action: { action: 'status' },
    nonce: { nonce: 'B'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    association: { association: 'ef'.repeat(32) },
    op: { opHash: opHash({ kind: 'pf', amount: 1501 }) }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyWallet({ ...FIELDS, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  t.alike(verifyWallet(FIELDS, signWallet(FIELDS, other)), { ok: false, reason: 'bad-signature' }, 'another key')
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifyWallet(FIELDS, flipped), { ok: false, reason: 'bad-signature' }, 'one flipped digit')
})

test('age and push signatures by the member key are not wallet statements, and vice versa', (t) => {
  const ageFields = { action: 'session', nonce: NONCE, member: MEMBER, association: ASSOCIATION }
  const sigAge = age.signAge(ageFields, MEMBER_KP)
  const point = b4a.alloc(65, 7)
  point[0] = 0x04
  const pushFields = {
    nonce: NONCE,
    member: MEMBER,
    association: ASSOCIATION,
    action: 'on',
    endpointHash: OP_HASH,
    p256dh: b64url(point),
    auth: b64url(b4a.alloc(16, 9))
  }
  const sigPush = push.signPush(pushFields, MEMBER_KP)
  const termsFields = { nonce: NONCE, member: MEMBER, association: ASSOCIATION, version: terms.TERMS_VERSION }
  const sigTerms = terms.signTerms(termsFields, MEMBER_KP)

  for (const action of ACTIONS) {
    const fields = { ...FIELDS, action }
    t.alike(verifyWallet(fields, sigAge), { ok: false, reason: 'bad-signature' }, 'age as wallet ' + action)
    t.alike(verifyWallet(fields, sigPush), { ok: false, reason: 'bad-signature' }, 'push as wallet ' + action)
    t.alike(verifyWallet(fields, sigTerms), { ok: false, reason: 'bad-signature' }, 'terms as wallet ' + action)
    const sigWallet = signWallet(fields, MEMBER_KP)
    t.alike(age.verifyAge(ageFields, sigWallet), { ok: false, reason: 'bad-signature' }, 'wallet ' + action + ' as age')
    t.alike(push.verifyPush(pushFields, sigWallet), { ok: false, reason: 'bad-signature' }, 'wallet ' + action + ' as push')
    t.alike(terms.verifyTerms(termsFields, sigWallet), { ok: false, reason: 'bad-signature' }, 'wallet ' + action + ' as terms')
  }
  t.ok(b4a.toString(walletPayload(FIELDS)).startsWith('varanda-wallet-v1\n'))
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
    { ...FIELDS, action: 'Optin' },
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
    { ...FIELDS, association: undefined },
    { ...FIELDS, opHash: OP_HASH.toUpperCase() },
    { ...FIELDS, opHash: OP_HASH.slice(1) },
    { ...FIELDS, opHash: OP },
    { ...FIELDS, extra: 'x' },
    { action: 'optin', nonce: NONCE, member: MEMBER, association: ASSOCIATION }
  ]
  const signature = signWallet(FIELDS, MEMBER_KP)
  for (const fields of bad) {
    const label = String(JSON.stringify(fields))
    t.exception.all(() => walletPayload(fields), TypeError, label)
    t.exception.all(() => signWallet(fields, MEMBER_KP), TypeError, 'sign ' + label)
    t.alike(verifyWallet(fields, signature), { ok: false, reason: 'malformed' }, label)
  }
  for (const sig of [null, undefined, '', signature.toUpperCase(), signature.slice(2), signature + '00', 'g' + signature.slice(1), 42, {}]) {
    t.alike(verifyWallet(FIELDS, sig), { ok: false, reason: 'malformed' }, 'signature ' + String(sig).slice(0, 8))
  }
  const hostile = { get action () { throw new Error('boom') } }
  t.alike(verifyWallet(hostile, signature), { ok: false, reason: 'malformed' })
  const trap = new Proxy({ ...FIELDS }, { ownKeys () { throw new Error('boom') } })
  t.alike(verifyWallet(trap, signature), { ok: false, reason: 'malformed' })
  t.alike(verifyWallet(), { ok: false, reason: 'malformed' })
  t.exception.all(() => signWallet(FIELDS, null), TypeError)
  t.exception.all(() => signWallet(FIELDS, { secretKey: b4a.alloc(32) }), TypeError)
})

test('the module is pure: no fs, no network, no cert.js', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/wallet-proof.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'wallet-proof.js')).map(([id]) => id)
  t.alike(own.sort(), ['b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
