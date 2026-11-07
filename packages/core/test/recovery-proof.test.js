'use strict'

// lib/recovery-proof.js: the exact bytes (golden vectors), that every field
// and the action are bound by the signature, domain separation from the
// terms, account-link and certificate statements, shape checks, the blob
// hash, and that the module stays pure (no fs, no network).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PREFIX,
  ACTIONS,
  KINDS,
  NONCE_RE,
  checkFields,
  recoveryPayload,
  signRecovery,
  verifyRecovery,
  blobHashOf
} = require('../lib/recovery-proof')
const terms = require('../lib/terms')
const accountLink = require('../lib/account-link')
const cert = require('../lib/cert')

const coreRoot = path.join(__dirname, '..')

// Fixed keys: the member pair from a seed of 32 bytes 0x01.
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)
const LOOKUP = 'ab'.repeat(32)
const BLOB_HASH = 'ef'.repeat(32)

const PUT = {
  action: 'put',
  nonce: NONCE,
  member: MEMBER,
  association: ASSOCIATION,
  kind: 'passkey',
  lookupId: LOOKUP,
  blobHash: BLOB_HASH
}
const REMOVE = { ...PUT, action: 'remove', blobHash: '' }
const LIST = { ...PUT, action: 'list', kind: '', lookupId: '', blobHash: '' }

test('constants', (t) => {
  t.is(PREFIX, 'varanda-recovery-v1')
  t.alike([...ACTIONS], ['put', 'remove', 'list'])
  t.alike([...KINDS], ['passkey', 'code'])
  t.is(NONCE_RE, terms.NONCE_RE, 'the nonce rule is the one in terms.js')
  t.ok(Object.isFrozen(ACTIONS))
  t.ok(Object.isFrozen(KINDS))
})

test('golden vectors: exact bytes and signature', (t) => {
  t.is(MEMBER, '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c')
  const put = recoveryPayload(PUT)
  t.is(b4a.toString(put, 'utf8'), [
    'varanda-recovery-v1',
    'put',
    NONCE,
    MEMBER,
    ASSOCIATION,
    'passkey',
    LOOKUP,
    BLOB_HASH
  ].join('\n'))
  t.is(put[put.length - 1] === 0x0a, false, 'no trailing LF')
  t.is(b4a.toString(recoveryPayload(REMOVE), 'utf8'), [
    'varanda-recovery-v1', 'remove', NONCE, MEMBER, ASSOCIATION, 'passkey', LOOKUP, ''
  ].join('\n'))
  t.is(b4a.toString(recoveryPayload(LIST), 'utf8'), [
    'varanda-recovery-v1', 'list', NONCE, MEMBER, ASSOCIATION, '', '', ''
  ].join('\n'))
  const signature = signRecovery(PUT, MEMBER_KP)
  t.is(signature, '1261ad9768bb6925988e084e507e58cdbfd22e073dd95108c3b18884b0faa9c403244328c3325beed75e386f2e93e20cf7023e0d1552e740d2ed1086ee022601')
  t.alike(verifyRecovery(PUT, signature), { ok: true })
})

test('sign and verify round trip, every action and kind', (t) => {
  const kp = crypto.keyPair()
  const member = b4a.toString(kp.publicKey, 'hex')
  const all = [
    { ...PUT, member },
    { ...PUT, member, kind: 'code', nonce: 'z_-9'.repeat(32) },
    { ...REMOVE, member },
    { ...REMOVE, member, kind: 'code' },
    { ...LIST, member }
  ]
  for (const fields of all) {
    t.is(checkFields(fields), null)
    const signature = signRecovery(fields, kp)
    t.ok(/^[0-9a-f]{128}$/.test(signature))
    t.alike(verifyRecovery(fields, signature), { ok: true }, fields.action + ' ' + fields.kind)
    t.alike(verifyRecovery({ ...fields }, signature), { ok: true }, 'a copy verifies')
  }
})

test('a put signature is never a remove or a list, and the reverse', (t) => {
  const sigPut = signRecovery(PUT, MEMBER_KP)
  const sigRemove = signRecovery(REMOVE, MEMBER_KP)
  const sigList = signRecovery(LIST, MEMBER_KP)
  t.alike(verifyRecovery(REMOVE, sigPut), { ok: false, reason: 'bad-signature' }, 'put as remove')
  t.alike(verifyRecovery(LIST, sigPut), { ok: false, reason: 'bad-signature' }, 'put as list')
  t.alike(verifyRecovery(PUT, sigRemove), { ok: false, reason: 'bad-signature' }, 'remove as put')
  t.alike(verifyRecovery(LIST, sigRemove), { ok: false, reason: 'bad-signature' }, 'remove as list')
  t.alike(verifyRecovery(PUT, sigList), { ok: false, reason: 'bad-signature' }, 'list as put')
  t.alike(verifyRecovery(REMOVE, sigList), { ok: false, reason: 'bad-signature' }, 'list as remove')
})

test('every field is bound by the signature', (t) => {
  const signature = signRecovery(PUT, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    nonce: { nonce: 'B'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    association: { association: 'ef'.repeat(32) },
    kind: { kind: 'code' },
    lookupId: { lookupId: 'ac'.repeat(32) },
    blobHash: { blobHash: 'ee'.repeat(32) }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyRecovery({ ...PUT, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  t.alike(verifyRecovery(PUT, signRecovery(PUT, other)), { ok: false, reason: 'bad-signature' }, 'another key')
  // One flipped byte of the signature, at the start, middle and end.
  for (const i of [0, 63, 127]) {
    const c = signature[i] === '0' ? '1' : '0'
    const flipped = signature.slice(0, i) + c + signature.slice(i + 1)
    t.alike(verifyRecovery(PUT, flipped), { ok: false, reason: 'bad-signature' }, 'flipped at ' + i)
  }
})

test('terms, account-link and certificate signatures by the member key are not recovery statements, and vice versa', (t) => {
  const sigPut = signRecovery(PUT, MEMBER_KP)

  const termsFields = { nonce: NONCE, member: MEMBER, association: ASSOCIATION, version: 1 }
  const sigTerms = terms.signTerms(termsFields, MEMBER_KP)
  for (const fields of [PUT, REMOVE, LIST]) {
    t.alike(verifyRecovery(fields, sigTerms), { ok: false, reason: 'bad-signature' }, 'terms as recovery ' + fields.action)
  }
  t.alike(terms.verifyTerms(termsFields, sigPut), { ok: false, reason: 'bad-signature' }, 'recovery as terms')

  for (const phase of accountLink.PHASES) {
    const link = {
      phase,
      nonce: NONCE,
      member: MEMBER,
      username: 'ana_1',
      association: ASSOCIATION,
      sub: phase === 'finish' ? '109876543210987654321' : phase === 'passkey' ? 'ab'.repeat(32) : ''
    }
    const sigLink = accountLink.signAccountLink(link, MEMBER_KP)
    t.alike(verifyRecovery(PUT, sigLink), { ok: false, reason: 'bad-signature' }, 'account-link ' + phase + ' as recovery')
    t.alike(accountLink.verifyAccountLink(link, sigPut), { ok: false, reason: 'bad-signature' }, 'recovery as account-link ' + phase)
  }

  // A member certificate payload signed by the same key.
  const certBytes = cert.certPayload({
    member: MEMBER,
    ageBand: '18+',
    method: 'self',
    date: '2026-11-06T00:00:00.000Z',
    association: ASSOCIATION
  })
  const sigCert = b4a.toString(crypto.sign(certBytes, MEMBER_KP.secretKey), 'hex')
  t.alike(verifyRecovery(PUT, sigCert), { ok: false, reason: 'bad-signature' }, 'certificate as recovery')
  t.absent(crypto.verify(certBytes, b4a.from(sigPut, 'hex'), MEMBER_KP.publicKey), 'recovery as certificate')
})

test('only the prefix separates a recovery signature from the same content under another domain', (t) => {
  const text = b4a.toString(recoveryPayload(PUT), 'utf8')
  const rest = text.slice(PREFIX.length)
  const sign = (body) => b4a.toString(crypto.sign(b4a.from(body, 'utf8'), MEMBER_KP.secretKey), 'hex')
  t.alike(verifyRecovery(PUT, sign(PREFIX + rest)), { ok: true }, 'control: the same bytes with the recovery prefix')
  for (const other of [terms.PREFIX, accountLink.PREFIX, 'varanda-cert-v1', 'varanda-cert-v2']) {
    t.not(other, PREFIX)
    t.alike(verifyRecovery(PUT, sign(other + rest)), { ok: false, reason: 'bad-signature' }, 'prefix ' + other)
  }
  t.alike(verifyRecovery(PUT, sign(rest.slice(1))), { ok: false, reason: 'bad-signature' }, 'no prefix at all')
})

test('shape: payload throws TypeError, verify answers malformed and never throws', (t) => {
  const bad = [
    [null, 'fields'],
    [[], 'fields'],
    ['x', 'fields'],
    [{ ...PUT, action: 'get' }, 'action'],
    [{ ...PUT, action: 'PUT' }, 'action'],
    [{ ...PUT, action: undefined }, 'action'],
    [{ ...PUT, nonce: 'a'.repeat(42) }, 'nonce'],
    [{ ...PUT, nonce: 'a'.repeat(42) + '+' }, 'nonce'],
    [{ ...PUT, nonce: 'a'.repeat(129) }, 'nonce'],
    [{ ...PUT, member: MEMBER.toUpperCase() }, 'member'],
    [{ ...PUT, member: MEMBER.slice(1) }, 'member'],
    [{ ...PUT, association: ASSOCIATION.toUpperCase() }, 'association'],
    [{ ...PUT, association: ASSOCIATION.slice(1) }, 'association'],
    [{ ...PUT, kind: '' }, 'kind'],
    [{ ...PUT, kind: 'password' }, 'kind'],
    [{ ...PUT, kind: undefined }, 'kind'],
    [{ ...PUT, lookupId: '' }, 'lookupId'],
    [{ ...PUT, lookupId: LOOKUP.toUpperCase() }, 'lookupId'],
    [{ ...PUT, lookupId: LOOKUP.slice(1) }, 'lookupId'],
    [{ ...PUT, blobHash: '' }, 'blobHash'],
    [{ ...PUT, blobHash: BLOB_HASH.toUpperCase() }, 'blobHash'],
    [{ ...PUT, blobHash: undefined }, 'blobHash'],
    [{ ...REMOVE, kind: '' }, 'kind'],
    [{ ...REMOVE, lookupId: '' }, 'lookupId'],
    [{ ...REMOVE, blobHash: BLOB_HASH }, 'blobHash'],
    [{ ...REMOVE, blobHash: undefined }, 'blobHash'],
    [{ ...LIST, kind: 'passkey' }, 'kind'],
    [{ ...LIST, kind: undefined }, 'kind'],
    [{ ...LIST, lookupId: LOOKUP }, 'lookupId'],
    [{ ...LIST, blobHash: BLOB_HASH }, 'blobHash']
  ]
  const signature = signRecovery(PUT, MEMBER_KP)
  for (const [fields, reason] of bad) {
    const label = JSON.stringify(fields)
    t.is(checkFields(fields), reason, 'reason ' + reason + ' for ' + label)
    t.exception.all(() => recoveryPayload(fields), TypeError, label)
    t.alike(verifyRecovery(fields, signature), { ok: false, reason: 'malformed' }, label)
    t.exception.all(() => signRecovery(fields, MEMBER_KP), TypeError, 'sign ' + label)
  }
  for (const sig of [null, undefined, '', signature.toUpperCase(), signature.slice(2), signature + '00', 'g' + signature.slice(1), 42]) {
    t.alike(verifyRecovery(PUT, sig), { ok: false, reason: 'malformed' }, 'signature ' + String(sig).slice(0, 8))
  }
  const hostile = { get action () { throw new Error('boom') } }
  t.alike(verifyRecovery(hostile, signature), { ok: false, reason: 'malformed' })
  t.exception.all(() => signRecovery(PUT, null), TypeError)
  t.exception.all(() => signRecovery(PUT, { secretKey: b4a.alloc(32) }), TypeError)
})

// An object whose getters answer `first` on the first read and `later`
// afterwards, counting the reads.
function flipping (base, flips) {
  const reads = {}
  const o = {}
  for (const [k, v] of Object.entries(base)) {
    reads[k] = 0
    Object.defineProperty(o, k, {
      enumerable: true,
      get () {
        reads[k]++
        return k in flips && reads[k] > 1 ? flips[k] : v
      }
    })
  }
  return { o, reads }
}

test('each field is read once: accessors can not pass the check with one value and sign or verify another', (t) => {
  const other = crypto.keyPair()
  const flips = {
    action: 'remove',
    nonce: 'B'.repeat(43),
    member: b4a.toString(other.publicKey, 'hex'),
    association: 'ef'.repeat(32),
    kind: 'code',
    lookupId: 'ac'.repeat(32),
    blobHash: 'ee'.repeat(32)
  }
  const signature = signRecovery(PUT, MEMBER_KP)

  const a = flipping(PUT, flips)
  t.is(signRecovery(a.o, MEMBER_KP), signature, 'sign uses the checked values')
  for (const k of Object.keys(PUT)) t.is(a.reads[k], 1, 'sign reads ' + k + ' once')

  const b = flipping(PUT, flips)
  t.alike(verifyRecovery(b.o, signature), { ok: true }, 'verify uses the checked values')
  for (const k of Object.keys(PUT)) t.is(b.reads[k], 1, 'verify reads ' + k + ' once')

  const c = flipping(PUT, flips)
  t.alike(recoveryPayload(c.o), recoveryPayload(PUT), 'payload uses the checked values')
  for (const k of Object.keys(PUT)) t.is(c.reads[k], 1, 'payload reads ' + k + ' once')

  // A value that passes once and then turns into an LF injection is never signed.
  const d = flipping(PUT, { blobHash: BLOB_HASH + '\nput' })
  t.is(signRecovery(d.o, MEMBER_KP), signature)
})

test('blobHashOf: BLAKE2b-256 over kind, lookupId, nonce and ciphertext joined by LF', (t) => {
  const blob = { nonce: '6e6f6e6365', ciphertext: '63697068657274657874' }
  const h = blobHashOf({ kind: 'code', lookupId: LOOKUP, blob })
  const expected = b4a.toString(crypto.hash(b4a.from(['code', LOOKUP, blob.nonce, blob.ciphertext].join('\n'), 'utf8')), 'hex')
  t.is(h, expected)
  t.is(h, '548fb3d1338f8a2a0cbe668a3de6d3c60e5f102c70f0601c3ca9fe2d955ad452', 'golden hash')
  t.ok(/^[0-9a-f]{64}$/.test(h))
  t.is(checkFields({ ...PUT, blobHash: h }), null, 'a put accepts it as blobHash')
  t.not(blobHashOf({ kind: 'passkey', lookupId: LOOKUP, blob }), h, 'kind is bound')
  t.not(blobHashOf({ kind: 'code', lookupId: 'ac'.repeat(32), blob }), h, 'lookupId is bound')
  t.not(blobHashOf({ kind: 'code', lookupId: LOOKUP, blob: { ...blob, nonce: '6e6f6e6366' } }), h, 'nonce is bound')
  t.not(blobHashOf({ kind: 'code', lookupId: LOOKUP, blob: { ...blob, ciphertext: '63697068657274657875' } }), h, 'ciphertext is bound')

  const bad = [
    undefined,
    null,
    { kind: 'x', lookupId: LOOKUP, blob },
    { kind: 'code', lookupId: LOOKUP.toUpperCase(), blob },
    { kind: 'code', lookupId: LOOKUP, blob: null },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: '', ciphertext: 'x' } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'x', ciphertext: 7 } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'a\nb', ciphertext: 'ab' } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'ab', ciphertext: 'x' } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'AB', ciphertext: 'ab' } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'ab', ciphertext: 'AB' } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVydGV4dA' } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'ab\n', ciphertext: 'ab' } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'ab', ciphertext: 'ab\n' } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'ab\ud800', ciphertext: 'ab' } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'ab', ciphertext: '\udc00ab' } },
    { kind: 'code', lookupId: LOOKUP, blob: { nonce: 'ab', ciphertext: '' } }
  ]
  for (const input of bad) t.exception.all(() => blobHashOf(input), TypeError, JSON.stringify(input))

  // Each blob part is read once: a getter that passes the check with hex and
  // then answers LF or a lone surrogate never reaches the hash.
  const reads = { nonce: 0, ciphertext: 0 }
  const tricky = {}
  Object.defineProperty(tricky, 'nonce', { enumerable: true, get () { return reads.nonce++ === 0 ? blob.nonce : 'a\nb' } })
  Object.defineProperty(tricky, 'ciphertext', { enumerable: true, get () { return reads.ciphertext++ === 0 ? blob.ciphertext : '\ud800' } })
  t.is(blobHashOf({ kind: 'code', lookupId: LOOKUP, blob: tricky }), h, 'hashes the checked values')
  t.is(reads.nonce, 1, 'nonce read once')
  t.is(reads.ciphertext, 1, 'ciphertext read once')
})

// hypercore-crypto loads sodium-native under Node, whose addon loader reads
// the prebuild with 'fs'; the browser bundle maps it to a pure-JS sodium. So
// the module's OWN requires are pinned, and no network module or '#fs' is
// required by anything it pulls in.
test('the module is pure: no fs, no network, no cert.js', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/recovery-proof.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'recovery-proof.js')).map(([id]) => id)
  t.alike(own.sort(), ['./terms', 'b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
