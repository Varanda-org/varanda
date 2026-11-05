'use strict'

// lib/page-proof.js: the exact bytes (golden vector), the canonical
// operation and its hash, that every field is bound by the signature, domain
// separation from the wallet statement, refused actions, forbidden operation
// keys, shape checks, hostile input, and that the module stays pure.
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
  pagePayload,
  signPage,
  verifyPage
} = require('../lib/page-proof')
const accountLink = require('../lib/account-link')
const wallet = require('../lib/wallet-proof')

const coreRoot = path.join(__dirname, '..')

// Fixed keys: the member pair from a seed of 32 bytes 0x01.
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const PAGE = 'ab'.repeat(32)
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)
const OP = { text: 'oi\nmundo', media: [{ sha256: 'ef'.repeat(32), width: 512 }] }
const OP_JSON = '{"media":[{"sha256":"' + 'ef'.repeat(32) + '","width":512}],"text":"oi\\nmundo"}'
const OP_HASH = b4a.toString(crypto.hash(b4a.from(OP_JSON, 'utf8')), 'hex')

const FIELDS = {
  action: 'post',
  nonce: NONCE,
  member: MEMBER,
  page: PAGE,
  association: ASSOCIATION,
  opHash: OP_HASH
}

const PAGELESS = ['create', 'list', 'terms']

test('constants', (t) => {
  t.is(PREFIX, 'varanda-page-v1')
  t.alike(ACTIONS, [
    'create', 'list', 'status', 'post', 'reply', 'quote', 'delete', 'like', 'repost', 'profile',
    'avatar', 'rename', 'invite', 'dm-list', 'dm-thread', 'dm-send', 'dm-set',
    'dm-seen', 'follow', 'follows', 'media', 'notices', 'terms', 'community-join',
    'community-leave', 'group-join', 'group-leave', 'group-post', 'group-read'
  ])
  t.ok(Object.isFrozen(ACTIONS))
  t.is(NONCE_RE.source, accountLink.NONCE_RE.source, 'same nonce rule as account-link')
})

test('golden vector: canonical op, op hash, exact bytes and signature', (t) => {
  t.is(canonicalOp(OP), OP_JSON)
  t.is(opHash(OP), OP_HASH)
  t.is(canonicalOp({}), '{}')
  const payload = pagePayload(FIELDS)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-page-v1',
    'post',
    NONCE,
    MEMBER,
    PAGE,
    ASSOCIATION,
    OP_HASH
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  const signature = signPage(FIELDS, MEMBER_KP)
  t.is(signature, 'aa00590606735ec8ea631eb5f41c3e6e8293a72a059c6cfaee1f173ac0010217d16299caba4a8dbf6a650f6079f4295604b1f1640859d6b454da3e0d932a0503')
  t.alike(verifyPage(FIELDS, signature), { ok: true })
})

test('canonical op: stable across key order at every depth, exact values', (t) => {
  const a = { text: 'x', media: [{ b: 1, a: 2 }], flag: true, none: null }
  const b = { none: null, flag: true, media: [{ a: 2, b: 1 }], text: 'x' }
  t.is(canonicalOp(a), canonicalOp(b))
  t.is(opHash(a), opHash(b))
  t.is(canonicalOp(b), '{"flag":true,"media":[{"a":2,"b":1}],"none":null,"text":"x"}')
  const nullProto = Object.create(null)
  nullProto.media = [{ width: 512, sha256: 'ef'.repeat(32) }]
  nullProto.text = 'oi\nmundo'
  t.is(opHash(nullProto), OP_HASH, 'a null-prototype object hashes the same')
  t.is(opHash(JSON.parse(OP_JSON)), OP_HASH, 'the service recomputes the same hash from the JSON')
  t.not(opHash({ n: '10' }), opHash({ n: 10 }), 'a string and a number differ')
  t.not(opHash({ a: [1, 2] }), opHash({ a: [2, 1] }), 'array order is kept')
  t.not(opHash({ a: 'x', b: 'y' }), opHash({ a: 'xy' }))
  t.is(canonicalOp({ s: 'aspas " e \\ barra' }), '{"s":"aspas \\" e \\\\ barra"}')
  t.is(canonicalOp({ s: 'ção 😀' }), '{"s":"ção 😀"}', 'non-ASCII kept as UTF-8')
  t.is(canonicalOp({ n: 1.5, z: 0, m: -3 }), '{"m":-3,"n":1.5,"z":0}')
  const parsed = JSON.parse('{"__proto__":{"a":1}}')
  t.is(canonicalOp(parsed), '{"__proto__":{"a":1}}', 'a parsed __proto__ key is plain data')
})

// An independent serializer: keys in ascending UTF-16 order at every depth,
// built by hand so JSON.stringify's own key order cannot leak in.
function manualJson (v) {
  if (Array.isArray(v)) return '[' + v.map(manualJson).join(',') + ']'
  if (v !== null && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + manualJson(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

test('canonical op: array-index-like keys are refused, output is ascending-key JSON', (t) => {
  for (const op of [{ 10: 1, 2: 2 }, { 0: 'x' }, { text: 'x', 7: 1 }, { media: [{ 1: 1 }] }, { a: { b: { 4294967295: 1 } } }]) {
    t.exception.all(() => canonicalOp(op), TypeError, 'canonical ' + JSON.stringify(op))
    t.exception.all(() => opHash(op), TypeError, 'hash ' + JSON.stringify(op))
  }
  const accepted = [
    { '01': 1, '-1': 2, 1.5: 3, '2a': 4, ' 2': 5, b: 6, A: 7 },
    { text: 'x', media: [{ width: 512, sha256: 'ef'.repeat(32) }], flag: true, none: null },
    { z: { y: [1, { b: 'ç', a: '😀' }] }, é: 1, '😀': 2, '~': 4, '￿': 3 },
    JSON.parse(OP_JSON)
  ]
  for (const op of accepted) t.is(canonicalOp(op), manualJson(op), 'ascending ' + manualJson(op))
})

test('canonical op: size and depth limits', (t) => {
  const near = { s: 'x'.repeat(16 * 1024 - 8) }
  t.is(b4a.byteLength(canonicalOp(near)), 16 * 1024)
  t.exception.all(() => canonicalOp({ s: 'x'.repeat(16 * 1024 - 7) }), TypeError, 'one byte over 16 KiB')
  t.exception.all(() => canonicalOp({ s: 'ç'.repeat(9000) }), TypeError, 'counted in UTF-8 bytes')
  t.exception.all(() => canonicalOp({ s: 'x'.repeat(10 * 1024 * 1024) }), TypeError, 'huge string')
  t.exception.all(() => canonicalOp({ a: new Array(100000).fill(0) }), TypeError, 'huge array')
  let ok = {}
  for (let i = 0; i < 7; i++) ok = { a: ok }
  t.ok(canonicalOp(ok), 'eight levels')
  let deep = {}
  for (let i = 0; i < 100000; i++) deep = { a: deep }
  t.exception.all(() => canonicalOp(deep), TypeError, 'too deep, no stack overflow')
})

test('canonical op: reads every field once', (t) => {
  let reads = 0
  const op = {}
  Object.defineProperty(op, 'text', { enumerable: true, get () { reads++; return reads === 1 ? 'a' : 'b' } })
  t.exception.all(() => canonicalOp(op), TypeError, 'an accessor is refused')
  let calls = 0
  const proxy = new Proxy({ text: 'x' }, {
    getOwnPropertyDescriptor (target, key) {
      calls++
      return Reflect.getOwnPropertyDescriptor(target, key)
    }
  })
  t.is(canonicalOp(proxy), '{"text":"x"}')
  t.is(calls, 1, 'one read per key')
  const arr = [1]
  Object.defineProperty(arr, '0', { enumerable: true, get () { return 2 } })
  t.exception.all(() => canonicalOp({ a: arr }), TypeError, 'an accessor in an array')
})

test('canonical op: forbidden keys and bad shapes throw TypeError', (t) => {
  for (const key of ['secretKey', 'pin', 'seed']) {
    t.exception.all(() => canonicalOp({ [key]: 'x' }), TypeError, 'forbidden ' + key)
    t.exception.all(() => opHash({ text: 'x', [key]: 1 }), TypeError, 'opHash forbidden ' + key)
    t.exception.all(() => opHash({ media: [{ [key]: 1 }] }), TypeError, 'nested forbidden ' + key)
  }
  const extra = [1]
  extra.foo = 1
  const bad = [
    null,
    undefined,
    [],
    'x',
    42,
    true,
    new Map(),
    new Date(0),
    { d: new Date(0) },
    { m: new Map() },
    { u: new Uint8Array(1) },
    { [Symbol('s')]: 1 },
    { s: '\ud800' },
    { s: 'a\udc00' },
    { s: '\ud83d' + 'x' },
    { '\ud800': 1 },
    { n: NaN },
    { n: Infinity },
    { n: -0 },
    { n: 10n },
    { n: undefined },
    { f: () => 1 },
    { a: [, 1] }, // eslint-disable-line no-sparse-arrays
    { a: extra },
    { a: [undefined] }
  ]
  for (const op of bad) {
    t.exception.all(() => canonicalOp(op), TypeError, 'canonical ' + typeof op)
    t.exception.all(() => opHash(op), TypeError, 'hash ' + typeof op)
  }
  const hidden = {}
  Object.defineProperty(hidden, 'text', { value: 'x', enumerable: false })
  t.exception.all(() => canonicalOp(hidden), TypeError, 'a non-enumerable key')
  const trap = new Proxy({}, { ownKeys () { throw new Error('boom') } })
  t.exception.all(() => canonicalOp(trap), TypeError, 'a throwing trap becomes TypeError')
  t.exception.all(() => canonicalOp({ a: trap }), TypeError, 'nested throwing trap')
})

test('sign and verify round trip, every action', (t) => {
  const kp = crypto.keyPair()
  for (const action of ACTIONS) {
    const fields = { action, nonce: 'z_-9'.repeat(32), member: b4a.toString(kp.publicKey, 'hex'), page: PAGE, association: ASSOCIATION, opHash: opHash({ action }) }
    const signature = signPage(fields, kp)
    t.ok(/^[0-9a-f]{128}$/.test(signature))
    t.alike(verifyPage(fields, signature), { ok: true }, action)
    t.alike(verifyPage({ ...fields }, signature), { ok: true }, 'a copy verifies')
  }
  for (const action of PAGELESS) {
    const fields = { ...FIELDS, action, page: '' }
    t.alike(verifyPage(fields, signPage(fields, MEMBER_KP)), { ok: true }, action + ' without a page')
    t.alike(verifyPage({ ...fields, page: PAGE }, signPage(fields, MEMBER_KP)), { ok: false, reason: 'bad-signature' }, action + ' page is bound')
  }
})

test('record-authenticated and unknown actions are refused', (t) => {
  const signature = signPage(FIELDS, MEMBER_KP)
  for (const action of ['accept', 'remove', 'offer', 'transfer-accept', 'close', 'move', 'unknown', 'Post', 'post ', '']) {
    const fields = { ...FIELDS, action }
    t.exception.all(() => pagePayload(fields), TypeError, 'payload ' + action)
    t.exception.all(() => signPage(fields, MEMBER_KP), TypeError, 'sign ' + action)
    t.alike(verifyPage(fields, signature), { ok: false, reason: 'malformed' }, 'verify ' + action)
  }
})

test('every field is bound by the signature', (t) => {
  const signature = signPage(FIELDS, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    action: { action: 'reply' },
    nonce: { nonce: 'B'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    page: { page: 'ef'.repeat(32) },
    association: { association: 'ef'.repeat(32) },
    op: { opHash: opHash({ ...OP, text: 'oi mundo' }) }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyPage({ ...FIELDS, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  t.alike(verifyPage(FIELDS, signPage(FIELDS, other)), { ok: false, reason: 'bad-signature' }, 'another key')
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifyPage(FIELDS, flipped), { ok: false, reason: 'bad-signature' }, 'one flipped digit')
})

test('a wallet signature over the same fields is not a page statement, and vice versa', (t) => {
  {
    const action = 'status'
    const walletFields = { action, nonce: NONCE, member: MEMBER, association: ASSOCIATION, opHash: OP_HASH }
    const pageFields = { ...FIELDS, action }
    const sigWallet = wallet.signWallet(walletFields, MEMBER_KP)
    const sigPage = signPage(pageFields, MEMBER_KP)
    t.alike(verifyPage(pageFields, sigWallet), { ok: false, reason: 'bad-signature' }, 'wallet as page')
    t.alike(wallet.verifyWallet(walletFields, sigPage), { ok: false, reason: 'bad-signature' }, 'page as wallet')
  }
  // The same bytes after the prefix line: only the prefix tells them apart.
  const pageFields = { ...FIELDS, action: 'status' }
  const rest = b4a.toString(pagePayload(pageFields)).split('\n').slice(1).join('\n')
  const forged = b4a.toString(crypto.sign(b4a.from('varanda-wallet-v1\n' + rest), MEMBER_KP.secretKey), 'hex')
  t.alike(verifyPage(pageFields, forged), { ok: false, reason: 'bad-signature' }, 'prefix separation')
  t.ok(b4a.toString(pagePayload(FIELDS)).startsWith('varanda-page-v1\n'))
})

test('shape: payload throws TypeError, verify answers malformed and never throws', (t) => {
  const bad = [
    null,
    undefined,
    [],
    'x',
    42,
    new Map(),
    { ...FIELDS, action: null },
    { ...FIELDS, nonce: 'a'.repeat(42) },
    { ...FIELDS, nonce: 'a'.repeat(42) + '+' },
    { ...FIELDS, nonce: 'a'.repeat(42) + '\n' },
    { ...FIELDS, nonce: 'a'.repeat(129) },
    { ...FIELDS, nonce: 1 },
    { ...FIELDS, member: MEMBER.toUpperCase() },
    { ...FIELDS, member: MEMBER.slice(1) },
    { ...FIELDS, member: null },
    { ...FIELDS, page: '' },
    { ...FIELDS, page: PAGE.toUpperCase() },
    { ...FIELDS, page: PAGE.slice(1) },
    { ...FIELDS, page: PAGE + '\n' },
    { ...FIELDS, page: null },
    { ...FIELDS, page: undefined },
    { ...FIELDS, action: 'create', page: 'x' },
    { ...FIELDS, association: ASSOCIATION.toUpperCase() },
    { ...FIELDS, association: undefined },
    { ...FIELDS, opHash: OP_HASH.toUpperCase() },
    { ...FIELDS, opHash: OP },
    { ...FIELDS, extra: 'x' },
    { action: 'post', nonce: NONCE, member: MEMBER, association: ASSOCIATION, opHash: OP_HASH }
  ]
  const signature = signPage(FIELDS, MEMBER_KP)
  for (const fields of bad) {
    const label = String(JSON.stringify(fields))
    t.exception.all(() => pagePayload(fields), TypeError, label)
    t.exception.all(() => signPage(fields, MEMBER_KP), TypeError, 'sign ' + label)
    t.alike(verifyPage(fields, signature), { ok: false, reason: 'malformed' }, label)
  }
  for (const action of ACTIONS.filter((a) => !PAGELESS.includes(a))) {
    t.alike(verifyPage({ ...FIELDS, action, page: '' }, signature), { ok: false, reason: 'malformed' }, action + ' needs a page')
  }
  for (const sig of [null, undefined, '', signature.toUpperCase(), signature.slice(2), signature + '00', 'g' + signature.slice(1), 42, {}]) {
    t.alike(verifyPage(FIELDS, sig), { ok: false, reason: 'malformed' }, 'signature ' + String(sig).slice(0, 8))
  }
  const hostile = { get action () { throw new Error('boom') } }
  t.alike(verifyPage(hostile, signature), { ok: false, reason: 'malformed' })
  const trap = new Proxy({ ...FIELDS }, { ownKeys () { throw new Error('boom') } })
  t.alike(verifyPage(trap, signature), { ok: false, reason: 'malformed' })
  const protoTrap = new Proxy({ ...FIELDS }, { getPrototypeOf () { throw new Error('boom') } })
  t.alike(verifyPage(protoTrap, signature), { ok: false, reason: 'malformed' })
  const sigTrap = { toString () { throw new Error('boom') } }
  t.alike(verifyPage(FIELDS, sigTrap), { ok: false, reason: 'malformed' })
  t.alike(verifyPage(), { ok: false, reason: 'malformed' })
  t.exception.all(() => signPage(FIELDS, null), TypeError)
  t.exception.all(() => signPage(FIELDS, { secretKey: b4a.alloc(32) }), TypeError)
})

test('the module is pure: no fs, no network, no cert.js', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/page-proof.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'page-proof.js')).map(([id]) => id)
  t.alike(own.sort(), ['b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
