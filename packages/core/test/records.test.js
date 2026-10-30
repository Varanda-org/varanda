'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const records = require('../lib/records')
const certLib = require('../lib/cert')
const { latestUsername, latestUsernameRecord } = require('../lib/username')
const { MAX_CERT_BYTES } = require('@varanda/rpc')
const { testnet } = require('./helpers/net')

const {
  MAX_NAME, MAX_BIO, MAX_TEXT, MAX_BLOCK_BYTES, MAX_LOG_BLOCKS, MAX_LOG_BYTES,
  nowIso, isHex64, isCanonicalIso, decodeBlock,
  memberCertRecord, profileRecord, postRecord, validateRecord, parseRef, formatRef,
  latestProfile, genesisCert, mediaCoreRecord, followRecord,
  MEDIA_BLOCK_BYTES, MAX_MEDIA_BLOCKS, MAX_MEDIA_BYTES, MAX_MEDIA_CORES, MAX_MEDIA_PER_POST,
  MAX_MEDIA_ITEM_BLOCKS, MEDIA_MIMES, MAX_MEDIA_DIMENSION
} = records

const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'

function cert (over = {}) {
  return {
    v: 1,
    member: K1,
    ageBand: '18+',
    method: 'stub',
    date: AT,
    association: K2,
    signature: 'c'.repeat(128),
    ...over
  }
}

test('records', async (t) => {
  await testnet(t)

  t.is(MAX_NAME, 80)
  t.is(MAX_BIO, 280)
  t.is(MAX_TEXT, 1000)
  t.is(MAX_BLOCK_BYTES, 16384)
  t.is(MAX_LOG_BLOCKS, 100000)
  t.is(MAX_LOG_BYTES, 64 * 1024 * 1024)
  t.ok(isCanonicalIso(nowIso()))
  t.ok(isHex64(K1))
  t.absent(isHex64('A'.repeat(64)))
  t.absent(isHex64('a'.repeat(63)))
  t.absent(isHex64(5))
})

test('isCanonicalIso never throws', async (t) => {
  await testnet(t)
  t.ok(isCanonicalIso(AT))
  t.absent(isCanonicalIso('2026-13-01T00:00:00.000Z'))
  t.absent(isCanonicalIso('2026-01-01'))
  t.absent(isCanonicalIso(123))
  t.absent(isCanonicalIso(null))
  t.absent(isCanonicalIso({}))
})

test('decodeBlock', async (t) => {
  await testnet(t)
  t.alike(decodeBlock(b4a.from('{"a":1}')), { a: 1 })
  t.is(decodeBlock(b4a.from('not json')), null)
  t.is(decodeBlock(b4a.from('null')), null)
  t.is(decodeBlock(b4a.from('[1]')), null)
  t.is(decodeBlock(b4a.from('"x"')), null)
  t.is(decodeBlock(b4a.from('5')), null)
  t.is(decodeBlock('{"a":1}'), null)
  t.is(decodeBlock(undefined), null)
  t.alike(decodeBlock(new Uint8Array(b4a.from('{"a":1}'))), { a: 1 })
  // A block over MAX_BLOCK_BYTES is never parsed (S3).
  const padding = ' '.repeat(MAX_BLOCK_BYTES - '{"a":1}'.length)
  t.alike(decodeBlock(b4a.from('{"a":1}' + padding)), { a: 1 }, 'exactly MAX_BLOCK_BYTES is parsed')
  t.is(decodeBlock(b4a.from('{"a":1}' + padding + ' ')), null, 'MAX_BLOCK_BYTES + 1 is null')
  t.is(decodeBlock(b4a.alloc(MAX_BLOCK_BYTES + 1, 0x20)), null)
})

test('builders', async (t) => {
  await testnet(t)
  t.alike(memberCertRecord(cert()), { type: 'member-cert', cert: cert() })
  t.alike(profileRecord({ name: 'Ana', at: AT }), { type: 'profile', name: 'Ana', bio: '', at: AT })
  t.alike(postRecord({ text: 'oi', at: AT }), { type: 'post', text: 'oi', at: AT, replyTo: null })
  t.ok(isCanonicalIso(profileRecord({ name: 'Ana' }).at))
  t.ok(isCanonicalIso(postRecord({ text: 'oi' }).at))
  const reply = postRecord({ text: 'oi', at: AT, replyTo: { author: K1, seq: 1 } })
  t.alike(reply.replyTo, { author: K1, seq: 1 })

  await t.exception.all(async () => memberCertRecord({}), /malformed/)
  await t.exception.all(async () => memberCertRecord(cert({ v: 2 })), TypeError)
  await t.exception.all(async () => profileRecord({ name: '' }), TypeError)
  await t.exception.all(async () => profileRecord({ name: 'Ana', bio: 'x'.repeat(MAX_BIO + 1) }), /bio-length/)
  await t.exception.all(async () => postRecord({ text: '' }), /text-length/)
  await t.exception.all(async () => postRecord({ text: 'x', replyTo: { author: K1, seq: 0 } }), /reply-invalid/)
  await t.exception.all(async () => postRecord({ text: 'x', at: 'nope' }), /date-invalid/)
  await t.exception.all(async () => postRecord(), TypeError)
})

test('validateRecord: shape and ordering', async (t) => {
  await testnet(t)
  t.is(validateRecord(null, 1), 'malformed')
  t.is(validateRecord('x', 1), 'malformed')
  t.is(validateRecord([], 1), 'malformed')
  t.is(validateRecord({ type: 'other' }, 1), 'malformed')
  t.is(validateRecord(undefined, 0), 'malformed')

  const profile = { type: 'profile', name: 'Ana', bio: '', at: AT }
  const post = { type: 'post', text: 'oi', at: AT, replyTo: null }
  const certRec = { type: 'member-cert', cert: cert() }
  t.is(validateRecord(profile, 0), 'genesis-required')
  t.is(validateRecord(post, 0), 'genesis-required')
  t.is(validateRecord(certRec, 0), null)
  t.is(validateRecord(certRec, 1), 'cert-not-first')
  t.is(validateRecord(profile, 1), null)
  t.is(validateRecord(post, 2), null)
})

test('validateRecord: member-cert shape', async (t) => {
  await testnet(t)
  const rec = (c) => ({ type: 'member-cert', cert: c })
  t.is(validateRecord(rec(cert()), 0), null)
  t.is(validateRecord(rec(null), 0), 'malformed')
  t.is(validateRecord(rec([]), 0), 'malformed')
  t.is(validateRecord(rec(cert({ extra: 1 })), 0), 'malformed')
  const missing = cert()
  delete missing.method
  t.is(validateRecord(rec(missing), 0), 'malformed')
  t.is(validateRecord(rec(cert({ v: 2 })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ member: 'A'.repeat(64) })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ association: 'z'.repeat(64) })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ signature: 'c'.repeat(127) })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ signature: 'C'.repeat(128) })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ ageBand: '' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ method: 5 })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ date: '' })), 0), 'malformed')
})

test('validateRecord: profile rules', async (t) => {
  await testnet(t)
  const p = (over) => ({ type: 'profile', name: 'Ana', bio: '', at: AT, ...over })
  t.is(validateRecord(p({ name: '' }), 1), 'name-length')
  t.is(validateRecord(p({ name: 5 }), 1), 'name-length')
  t.is(validateRecord(p({ name: 'x'.repeat(MAX_NAME) }), 1), null)
  t.is(validateRecord(p({ name: 'x'.repeat(MAX_NAME + 1) }), 1), 'name-length')
  t.is(validateRecord(p({ bio: 'x'.repeat(MAX_BIO) }), 1), null)
  t.is(validateRecord(p({ bio: 'x'.repeat(MAX_BIO + 1) }), 1), 'bio-length')
  t.is(validateRecord(p({ bio: null }), 1), 'bio-length')
  t.is(validateRecord(p({ name: 'a\nb' }), 1), 'control-chars')
  t.is(validateRecord(p({ name: 'a\tb' }), 1), 'control-chars')
  t.is(validateRecord(p({ bio: 'a\nb' }), 1), null)
  t.is(validateRecord(p({ bio: 'a\rb' }), 1), 'control-chars')
  t.is(validateRecord(p({ bio: 'a\u0000b' }), 1), 'control-chars')
  t.is(validateRecord(p({ at: '2026-13-01T00:00:00.000Z' }), 1), 'date-invalid')
  t.is(validateRecord(p({ at: 12345 }), 1), 'date-invalid')
  t.is(validateRecord(p({ at: undefined }), 1), 'date-invalid')
  t.is(validateRecord(p({ at: '2026-01-01' }), 1), 'date-invalid')
})

test('validateRecord: post rules', async (t) => {
  await testnet(t)
  const p = (over) => ({ type: 'post', text: 'oi', at: AT, replyTo: null, ...over })
  t.is(validateRecord(p({ text: '' }), 1), 'text-length')
  t.is(validateRecord(p({ text: 7 }), 1), 'text-length')
  t.is(validateRecord(p({ text: 'x'.repeat(MAX_TEXT) }), 1), null)
  t.is(validateRecord(p({ text: 'x'.repeat(MAX_TEXT + 1) }), 1), 'text-length')
  t.is(validateRecord(p({ text: 'a\nb' }), 1), null)
  t.is(validateRecord(p({ text: 'a\tb' }), 1), 'control-chars')
  t.is(validateRecord(p({ at: '2026-13-01T00:00:00.000Z' }), 1), 'date-invalid')
  t.is(validateRecord(p({ at: null }), 1), 'date-invalid')
  t.is(validateRecord(p({ replyTo: { author: K1, seq: 1 } }), 1), null)
  t.is(validateRecord(p({ replyTo: { author: K1, seq: 0 } }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: { author: K1, seq: 1.5 } }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: { author: 'A'.repeat(64), seq: 1 } }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: { author: K1, seq: 1, extra: 1 } }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: { author: K1 } }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: undefined }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: 'x' }), 1), 'reply-invalid')
})

test('records have exactly their keys (S3)', async (t) => {
  await testnet(t)
  const post = { type: 'post', text: 'oi', at: AT, replyTo: null }
  const profile = { type: 'profile', name: 'Ana', bio: '', at: AT }
  t.is(validateRecord(post, 1), null)
  t.is(validateRecord(profile, 1), null)
  t.is(validateRecord({ ...post, extra: 'x'.repeat(10) }, 1), 'malformed', 'post with an extra key')
  t.is(validateRecord({ ...post, media: null }, 1), 'media-invalid')
  t.is(validateRecord({ ...profile, extra: 1 }, 1), 'malformed', 'profile with an extra key')
  const noReply = { ...post }
  delete noReply.replyTo
  t.is(validateRecord(noReply, 1), 'malformed', 'post without replyTo')
  const noBio = { ...profile }
  delete noBio.bio
  t.is(validateRecord(noBio, 1), 'malformed', 'profile without bio')
  // The builders always write every key (replyTo null when absent).
  t.alike(Object.keys(postRecord({ text: 'oi', at: AT })), ['type', 'text', 'at', 'replyTo'])
  t.alike(Object.keys(profileRecord({ name: 'Ana', at: AT })), ['type', 'name', 'bio', 'at'])
})

test('forbidden characters in name, bio and text (S5)', async (t) => {
  await testnet(t)
  const profile = (over) => ({ type: 'profile', name: 'Ana', bio: 'oi', at: AT, ...over })
  const post = (over) => ({ type: 'post', text: 'oi', at: AT, replyTo: null, ...over })
  const forbidden = {
    DEL: '\u007f',
    'C1 NEL': '\u0085',
    'C1 0x9f': '\u009f',
    'line separator': '\u2028',
    'paragraph separator': '\u2029',
    LRE: '\u202a',
    RLO: '\u202e',
    LRI: '\u2066',
    PDI: '\u2069',
    ESC: '\u001b',
    CR: '\r'
  }
  for (const [label, ch] of Object.entries(forbidden)) {
    t.is(validateRecord(profile({ name: 'a' + ch + 'b' }), 1), 'control-chars', 'name: ' + label)
    t.is(validateRecord(profile({ bio: 'a' + ch + 'b' }), 1), 'control-chars', 'bio: ' + label)
    t.is(validateRecord(post({ text: 'a' + ch + 'b' }), 1), 'control-chars', 'text: ' + label)
  }
  // Neighbours of the forbidden ranges and ordinary non-ASCII stay valid.
  for (const ch of [' ', '\u2027', '\u202f', '\u2065', '\u206a', 'é', '😀', 'ç']) {
    t.is(validateRecord(profile({ bio: 'a' + ch + 'b' }), 1), null, 'bio allows ' + JSON.stringify(ch))
    t.is(validateRecord(post({ text: 'a' + ch + 'b' }), 1), null, 'text allows ' + JSON.stringify(ch))
  }
  t.is(validateRecord(post({ text: 'a\nb' }), 1), null, 'LF stays allowed in text')
  t.is(validateRecord(profile({ name: 'a\nb' }), 1), 'control-chars', 'LF stays forbidden in name')
  await t.exception.all(async () => postRecord({ text: 'x\u202ey' }), /control-chars/)
  await t.exception.all(async () => profileRecord({ name: 'x\u007f' }), /control-chars/)
})

test('validateRecord never throws', async (t) => {
  await testnet(t)
  const hostile = {
    get type () { throw new Error('boom') }
  }
  t.is(validateRecord(hostile, 1), 'malformed')
  const hostileText = { type: 'post', get text () { throw new Error('boom') }, at: AT, replyTo: null }
  t.is(validateRecord(hostileText, 1), 'malformed')
  t.is(validateRecord(Object.create(null), 1), 'malformed')
  for (const v of [undefined, null, 0, 'x', true, Symbol('s'), () => {}, NaN]) {
    t.is(validateRecord(v, 1), 'malformed')
  }
})

test('parseRef and formatRef', async (t) => {
  await testnet(t)
  t.alike(parseRef(K1 + ':3'), { author: K1, seq: 3 })
  t.alike(parseRef('A'.repeat(64) + ':0'), { author: K1, seq: 0 })
  t.is(parseRef(K1), null)
  t.is(parseRef(K1 + ':'), null)
  t.is(parseRef(K1 + ':-1'), null)
  t.is(parseRef(K1 + ':1.5'), null)
  t.is(parseRef(K1 + ':1a'), null)
  t.is(parseRef('abc:1'), null)
  t.is(parseRef(null), null)
  t.is(formatRef({ author: K1, seq: 4 }), K1 + ':4')
  t.alike(parseRef(formatRef({ author: K2, seq: 9 })), { author: K2, seq: 9 })
})

test('latestProfile ignores invalid blocks', async (t) => {
  await testnet(t)
  const entries = [
    { seq: 0, record: { type: 'member-cert', cert: cert() } },
    { seq: 1, record: { type: 'profile', name: 'Ana', bio: 'um', at: AT } },
    { seq: 2, record: { type: 'post', text: 'oi', at: AT, replyTo: null } },
    { seq: 3, record: { type: 'profile', name: 'Ana Maria', bio: 'dois', at: AT } },
    { seq: 4, record: { type: 'profile', name: '', bio: '', at: AT } },
    { seq: 5, record: null }
  ]
  t.alike(latestProfile(entries), { name: 'Ana Maria', bio: 'dois' })
  t.is(latestProfile(entries.slice(0, 1)), null)
  t.is(latestProfile([]), null)
  // a profile at seq 0 is invalid (genesis-required)
  t.is(latestProfile([{ seq: 0, record: { type: 'profile', name: 'X', bio: '', at: AT } }]), null)
})

test('genesisCert', async (t) => {
  await testnet(t)
  const c = cert()
  t.alike(genesisCert([{ seq: 0, record: { type: 'member-cert', cert: c } }]), c)
  t.is(genesisCert([{ seq: 0, record: { type: 'post', text: 'oi', at: AT, replyTo: null } }]), null)
  t.is(genesisCert([{ seq: 0, record: null }]), null)
  t.is(genesisCert([{ seq: 1, record: { type: 'member-cert', cert: c } }]), null)
  t.is(genesisCert([{ seq: 0, record: { type: 'member-cert', cert: cert({ v: 2 }) } }]), null)
  t.is(genesisCert([]), null)
})

test('member-cert shape matches cert.js field rules', async (t) => {
  await testnet(t)
  const rec = (c) => ({ type: 'member-cert', cert: c })
  t.is(validateRecord(rec(cert({ date: 'not-a-date' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ date: '2026-13-01T00:00:00.000Z' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ date: '2026-01-01' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ ageBand: 'Adulto X' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ method: 'Stub' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ method: 'x'.repeat(33) })), 0), 'malformed')
  await t.exception.all(async () => memberCertRecord(cert({ date: 'not-a-date' })), /malformed/)
})

test('parseRef rejects non-canonical and unsafe seqs; replies need safe seqs', async (t) => {
  await testnet(t)
  t.is(parseRef(K1 + ':9007199254740993'), null)
  t.is(parseRef(K1 + ':9007199254740992'), null)
  t.alike(parseRef(K1 + ':9007199254740991'), { author: K1, seq: 9007199254740991 })
  t.is(parseRef(K1 + ':01'), null)
  t.is(parseRef(K1 + ':00'), null)
  t.alike(parseRef(K1 + ':10'), { author: K1, seq: 10 })
  const p = (seq) => ({ type: 'post', text: 'oi', at: AT, replyTo: { author: K1, seq } })
  t.is(validateRecord(p(2 ** 53), 1), 'reply-invalid')
  t.is(validateRecord(p(Number.MAX_SAFE_INTEGER), 1), null)
})

test('latestProfile and genesisCert return copies', async (t) => {
  await testnet(t)
  const c = cert()
  const entries = [
    { seq: 0, record: { type: 'member-cert', cert: c } },
    { seq: 1, record: { type: 'profile', name: 'Ana', bio: 'um', at: AT } }
  ]
  const got = genesisCert(entries)
  t.alike(got, cert())
  t.not(got, c)
  got.member = K2
  t.is(entries[0].record.cert.member, K1)

  const prof = latestProfile(entries)
  prof.name = 'Outra'
  t.is(entries[1].record.name, 'Ana')

  // a profile whose name changes after the first read: the value read once
  // is the one validated and returned
  let reads = 0
  const shifty = { type: 'profile', get name () { return reads++ === 0 ? 'Ana' : 'x'.repeat(500) }, bio: '', at: AT }
  t.alike(latestProfile([{ seq: 1, record: shifty }]), { name: 'Ana', bio: '' })
})

test('validRecordCopy skips a revoked proxy or a throwing prototype trap', async (t) => {
  await testnet(t)
  const { proxy, revoke } = Proxy.revocable({ type: 'post', text: 'oi', at: AT, replyTo: null }, {})
  revoke()
  const trap = new Proxy({ type: 'post', text: 'oi', at: AT, replyTo: null }, {
    getPrototypeOf () { throw new Error('boom') }
  })
  for (const hostile of [proxy, trap]) {
    t.execution(() => records.validRecordCopy(hostile, 1))
    t.is(records.validRecordCopy(hostile, 1), null)
  }
  t.is(latestProfile([{ seq: 1, record: proxy }]), null)
})

// Member certificate v2 and the username record (docs/protocol.md section 3).
function issuerSetup () {
  const assocKp = crypto.keyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = certLib.createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex'), date: AT }, assocKp)
  return { assocKp, assocHex: issuerCert.association, issuerKp, issuerCert }
}

test('validateRecord: v2 member-cert and username records', async (t) => {
  await testnet(t)
  const { issuerKp, issuerCert } = issuerSetup()
  const v2 = certLib.createIssuedCert({ member: K1, date: AT }, issuerKp, issuerCert)
  const certRec = { type: 'member-cert', cert: v2 }
  t.is(validateRecord(certRec, 0), null)
  t.is(validateRecord(certRec, 1), 'cert-not-first')
  t.alike(memberCertRecord(v2), certRec)
  t.alike(genesisCert([{ seq: 0, record: certRec }]), v2)

  const name = certLib.createUsernameRecord({ member: K1, username: 'ana', date: AT }, issuerKp, issuerCert)
  t.is(validateRecord(name, 0), 'genesis-required')
  t.is(validateRecord(name, 1), null)
  t.is(validateRecord(name, 7), null)
  t.is(validateRecord({ ...name, extra: 1 }, 1), 'malformed')
  t.is(validateRecord({ ...name, username: 'Ana' }, 1), 'malformed')
  t.is(validateRecord({ ...name, username: 'abc123' }, 1), 'malformed')
  t.is(validateRecord({ ...name, issuer: name.association }, 1), 'malformed')
  // a username record is never a genesis block nor a certificate
  t.is(validateRecord({ type: 'member-cert', cert: name }, 0), 'malformed')
  t.is(latestProfile([{ seq: 1, record: name }]), null)
})

// Records.js duplicates the certificate and username-record shape rules
// instead of importing cert.js; both validators must agree on every input.
test('records and cert.js shape rules agree (parity)', async (t) => {
  await testnet(t)
  const { assocKp, issuerKp, issuerCert } = issuerSetup()
  const v1 = certLib.createCert({ member: K1, date: AT }, assocKp)
  const v2 = certLib.createIssuedCert({ member: K1, date: AT }, issuerKp, issuerCert)
  const name = certLib.createUsernameRecord({ member: K1, username: 'ana_maria', date: AT }, issuerKp, issuerCert)
  const drop = (o, k) => { const c = { ...o }; delete c[k]; return c }

  const certs = [
    v1, v2,
    { ...v1, extra: 1 }, { ...v1, v: 2 }, { ...v1, ageBand: 'unchecked', method: 'google' }, { ...v1, method: 'Stub' },
    drop(v1, 'method'),
    { ...v2, v: 1 }, { ...v2, v: 3 }, { ...v2, ageBand: '18+' }, { ...v2, method: 'stub' },
    { ...v2, issuer: v2.association }, { ...v2, issuer: v2.issuer.toUpperCase() },
    { ...v2, issuerSignature: 'c'.repeat(127) }, { ...v2, issuerDate: '2026-01-01' }, { ...v2, date: '2026-13-01T00:00:00.000Z' },
    { ...v2, username: 'ana' }, drop(v2, 'issuerDate'), { ...v2, member: 'A'.repeat(64) },
    null, [], 'x', 5, Object.create(null)
  ]
  for (const [i, c] of certs.entries()) {
    const viaCert = certLib.validateCertShape(c) === null
    const viaRecords = validateRecord({ type: 'member-cert', cert: c }, 0) === null
    t.is(viaRecords, viaCert, 'cert #' + i)
  }

  const usernames = ['ana', 'Ana', '1ana', 'ab', 'a'.repeat(20), 'a'.repeat(21), 'abc123', 'facade', 'abcdeg', 'ana-b', 'aná', 5]
  const names = [
    name,
    ...usernames.map((username) => ({ ...name, username })),
    { ...name, extra: 1 }, drop(name, 'issuer'), { ...name, type: 'profile' },
    { ...name, issuer: name.association }, { ...name, member: K1.toUpperCase() },
    { ...name, signature: 'c'.repeat(128) }, { ...name, signature: 'C'.repeat(128) },
    { ...name, date: 'nope' }, { ...name, issuerDate: 5 }
  ]
  for (const [i, r] of names.entries()) {
    const viaCert = certLib.validateUsernameRecordShape(r) === null
    const viaRecords = validateRecord(r, 1) === null
    t.is(viaRecords, viaCert, 'username record #' + i)
  }
})

test('the largest legal v2 member-cert and username record fit the limits', async (t) => {
  await testnet(t)
  // The longest canonical ISO date (expanded year) and the longest username.
  const LONG_DATE = new Date(-8.64e15).toISOString()
  t.is(LONG_DATE.length, 27)
  t.ok(isCanonicalIso(LONG_DATE))
  const sig = 'f'.repeat(128)
  const c = {
    v: 2,
    member: K1,
    ageBand: 'unchecked',
    method: 'google',
    date: LONG_DATE,
    association: K2,
    issuer: 'c'.repeat(64),
    issuerDate: LONG_DATE,
    issuerSignature: sig,
    signature: sig
  }
  const certRec = { type: 'member-cert', cert: c }
  t.is(validateRecord(certRec, 0), null)
  t.ok(b4a.byteLength(JSON.stringify(c)) < MAX_CERT_BYTES, 'cert under MAX_CERT_BYTES')
  t.ok(b4a.byteLength(JSON.stringify(certRec)) < MAX_BLOCK_BYTES, 'block 0 under MAX_BLOCK_BYTES')
  const name = {
    type: 'username',
    username: 'z'.repeat(20),
    member: K1,
    date: LONG_DATE,
    association: K2,
    issuer: 'c'.repeat(64),
    issuerDate: LONG_DATE,
    issuerSignature: sig,
    signature: sig
  }
  t.is(validateRecord(name, 1), null)
  t.ok(b4a.byteLength(JSON.stringify(name)) < MAX_BLOCK_BYTES, 'username record under MAX_BLOCK_BYTES')
  t.ok(b4a.byteLength(JSON.stringify(name)) < 2048, 'username record under the username.add limit')
})

test('latestUsername: only the newest own record is a candidate', async (t) => {
  await testnet(t)
  const { assocHex, issuerKp, issuerCert } = issuerSetup()
  const other = issuerSetup()
  const v2 = certLib.createIssuedCert({ member: K1, date: AT }, issuerKp, issuerCert)
  const named = (username, member = K1, setup = { issuerKp, issuerCert }) =>
    certLib.createUsernameRecord({ member, username, date: AT }, setup.issuerKp, setup.issuerCert)
  const ana = named('ana')
  const bia = named('bia')
  const base = [
    { seq: 0, record: { type: 'member-cert', cert: v2 } },
    { seq: 1, record: ana },
    { seq: 2, record: { type: 'post', text: 'oi', at: AT, replyTo: null } },
    { seq: 3, record: bia }
  ]
  // an older valid record followed by a newer valid one: the newer
  t.is(latestUsername(base, K1, assocHex), 'bia')
  t.alike(latestUsernameRecord(base, K1, assocHex), bia)
  t.not(latestUsernameRecord(base, K1, assocHex), bia, 'a copy')
  t.is(latestUsername(base.slice(0, 3), K1, assocHex), 'ana')
  t.is(latestUsername(base.slice(0, 1), K1, assocHex), null)
  t.is(latestUsername([], K1, assocHex), null)
  // the entries order does not matter, the seq does
  t.is(latestUsername(base.slice().reverse(), K1, assocHex), 'bia')
  // a username record at seq 0 is not valid
  t.is(latestUsername([{ seq: 0, record: ana }], K1, assocHex), null)

  // another member's record (copied from someone else's diary) is never a
  // candidate, so it neither hides nor replaces the name
  const foreign = base.concat([{ seq: 4, record: named('caio', K2) }, { seq: 5, record: null }])
  t.is(latestUsername(foreign, K1, assocHex), 'bia')
  t.is(latestUsername(foreign.slice().reverse(), K1, assocHex), 'bia')
  t.is(latestUsername(foreign, K2, assocHex), 'caio', 'it is the candidate of its own member')

  // an invalid NEWEST own record gives null: no fallback to an older record
  const invalidNewest = [
    ['another association', named('dani', K1, other)],
    ['a swapped issuerSignature', { ...named('edu'), issuerSignature: other.issuerCert.signature }],
    ['a tampered name', { ...ana, username: 'fabi' }]
  ]
  for (const [label, record] of invalidNewest) {
    const entries = base.concat([{ seq: 6, record }])
    t.is(latestUsername(entries, K1, assocHex), null, label + ' on the newest record -> null')
    t.is(latestUsername(entries.slice().reverse(), K1, assocHex), null, label + ', reversed input -> null')
  }
  // the record signed for the other association is valid there
  t.is(latestUsername(base.concat([{ seq: 6, record: named('dani', K1, other) }]), K1, other.assocHex), 'dani')
  // a valid record after the invalid one is the candidate again
  t.is(latestUsername(base.concat([{ seq: 6, record: { ...ana, username: 'fabi' } }, { seq: 7, record: ana }]), K1, assocHex), 'ana')

  // hostile input never throws
  for (const bad of [null, undefined, 5, [null], [{ seq: 1, get record () { throw new Error('boom') } }]]) {
    t.is(latestUsername(bad, K1, assocHex), null)
  }
  t.is(latestUsername(base, null, assocHex), null)
  t.is(latestUsername(base, K1, 'zz'), null)
  t.is(latestUsername(base, K1, null), null)
})

test('latestUsername: a record from a revoked issuer is invalid', async (t) => {
  await testnet(t)
  const { assocHex, assocKp, issuerKp, issuerCert } = issuerSetup()
  const issuer = issuerCert.issuer
  const v2 = certLib.createIssuedCert({ member: K1, date: AT }, issuerKp, issuerCert)
  // a second issuer certified by the same association
  const newKp = crypto.keyPair()
  const newCert = certLib.createIssuerCert({ issuer: b4a.toString(newKp.publicKey, 'hex'), date: AT }, assocKp)
  const ana = certLib.createUsernameRecord({ member: K1, username: 'ana', date: AT }, issuerKp, issuerCert)
  const bia = certLib.createUsernameRecord({ member: K1, username: 'bia', date: AT }, newKp, newCert)
  const entries = [
    { seq: 0, record: { type: 'member-cert', cert: v2 } },
    { seq: 1, record: ana }
  ]
  const revokedIssuers = new Set([issuer])
  t.is(latestUsername(entries, K1, assocHex), 'ana')
  t.is(latestUsername(entries, K1, assocHex, { revokedIssuers: new Set() }), 'ana')
  t.is(latestUsername(entries, K1, assocHex, { revokedIssuers }), null)
  t.is(latestUsernameRecord(entries, K1, assocHex, { revokedIssuers }), null)
  // a newer record from a non-revoked issuer is the name again
  const relinked = entries.concat([{ seq: 2, record: bia }])
  t.is(latestUsername(relinked, K1, assocHex, { revokedIssuers }), 'bia')
  // no fallback: a revoked newest record hides an older valid one
  const hidden = [entries[0], { seq: 1, record: bia }, { seq: 2, record: ana }]
  t.is(latestUsername(hidden, K1, assocHex), 'ana')
  t.is(latestUsername(hidden, K1, assocHex, { revokedIssuers }), null)
})

const DESC = { core: K2, mime: 'image/jpeg', start: 1, blocks: 2, bytes: 32769, sha256: 'd'.repeat(64), width: 640, height: 480 }

test('media constants', async (t) => {
  await testnet(t)
  t.is(MEDIA_BLOCK_BYTES, 32768)
  t.is(MAX_MEDIA_BLOCKS, 8192)
  t.is(MAX_MEDIA_BYTES, 268435456)
  t.is(MAX_MEDIA_CORES, 4)
  t.is(MAX_MEDIA_PER_POST, 4)
  t.is(MAX_MEDIA_ITEM_BLOCKS, 256)
  t.alike([...MEDIA_MIMES], ['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
  t.is(MAX_MEDIA_DIMENSION, 16384)
})

test('validateRecord: posts with media', async (t) => {
  await testnet(t)
  const post = (over) => ({ type: 'post', text: 'oi', at: AT, replyTo: null, ...over })
  const withMedia = (media, over) => post({ media, ...over })
  // Exactly 4 keys, or exactly those plus media.
  t.is(validateRecord(post(), 1), null)
  t.is(validateRecord(withMedia([DESC]), 1), null)
  t.is(validateRecord(withMedia([DESC, DESC, DESC, DESC]), 1), null)
  t.is(validateRecord(withMedia([DESC], { extra: 1 }), 1), 'malformed', 'media plus an extra key')
  const noReply = withMedia([DESC])
  delete noReply.replyTo
  t.is(validateRecord(noReply, 1), 'malformed', 'media without replyTo')
  // Text: 0..MAX_TEXT with media, 1..MAX_TEXT without.
  t.is(validateRecord(withMedia([DESC], { text: '' }), 1), null)
  t.is(validateRecord(post({ text: '' }), 1), 'text-length')
  t.is(validateRecord(withMedia([DESC], { text: 'x'.repeat(MAX_TEXT + 1) }), 1), 'text-length')
  t.is(validateRecord(withMedia([DESC], { text: 'a\u202eb' }), 1), 'control-chars')
  t.is(validateRecord(withMedia([DESC], { at: 'x' }), 1), 'date-invalid')
  t.is(validateRecord(withMedia([DESC], { replyTo: 'x' }), 1), 'reply-invalid')
  t.is(validateRecord(withMedia([DESC]), 0), 'genesis-required')
  // The media list.
  for (const media of [null, [], [DESC, DESC, DESC, DESC, DESC], DESC, 'x', 1, {}, [null], [[]]]) {
    t.is(validateRecord(withMedia(media), 1), 'media-invalid', 'media ' + JSON.stringify(media))
  }
  // Sparse arrays: a hole is never a descriptor.
  const holed = [DESC, DESC]
  delete holed[0]
  const between = [DESC, DESC, DESC]
  delete between[1]
  for (const media of [new Array(1), new Array(4), holed, between]) {
    t.is(validateRecord(withMedia(media), 1), 'media-invalid', 'sparse media of length ' + media.length)
    t.is(records.validRecordCopy(withMedia(media), 1), null)
  }
  await t.exception.all(async () => postRecord({ text: '', at: AT, media: new Array(1) }), /media-invalid/)
  await t.exception.all(async () => postRecord({ text: 'x', at: AT, media: between }), /media-invalid/)
  // Descriptor edge cases.
  const maxItem = { ...DESC, mime: 'image/gif', start: MAX_MEDIA_BLOCKS - MAX_MEDIA_ITEM_BLOCKS, blocks: MAX_MEDIA_ITEM_BLOCKS, bytes: MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES, width: MAX_MEDIA_DIMENSION, height: MAX_MEDIA_DIMENSION }
  for (const d of [maxItem, { ...DESC, blocks: 1, bytes: 1 }, { ...DESC, blocks: 1, bytes: 32768 }, { ...DESC, bytes: 65536 }, { ...DESC, start: 8191, blocks: 1, bytes: 1 }, { ...DESC, mime: 'image/png' }, { ...DESC, mime: 'image/webp' }, { ...DESC, width: 1, height: 1 }]) {
    t.is(validateRecord(withMedia([d]), 1), null, 'valid ' + JSON.stringify(d))
  }
  const missing = { ...DESC }
  delete missing.sha256
  const bad = [
    missing,
    { ...DESC, extra: 1 },
    { ...DESC, core: 'A'.repeat(64) },
    { ...DESC, core: K2.slice(1) },
    { ...DESC, sha256: 'D'.repeat(64) },
    { ...DESC, mime: 'video/mp4' },
    { ...DESC, mime: 'image/svg+xml' },
    { ...DESC, mime: 'IMAGE/JPEG' },
    { ...DESC, start: 0 },
    { ...DESC, start: MAX_MEDIA_BLOCKS },
    { ...DESC, start: 1.5 },
    { ...DESC, start: '1' },
    { ...DESC, blocks: 0 },
    { ...DESC, blocks: MAX_MEDIA_ITEM_BLOCKS + 1, bytes: (MAX_MEDIA_ITEM_BLOCKS + 1) * MEDIA_BLOCK_BYTES },
    { ...DESC, start: MAX_MEDIA_BLOCKS - 1, blocks: 2 },
    { ...DESC, start: MAX_MEDIA_BLOCKS - MAX_MEDIA_ITEM_BLOCKS + 1, blocks: MAX_MEDIA_ITEM_BLOCKS, bytes: MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES },
    { ...DESC, bytes: 32768 },
    { ...DESC, bytes: 65537 },
    { ...DESC, blocks: 1, bytes: 0 },
    { ...DESC, bytes: 40000.5 },
    { ...DESC, width: 0 },
    { ...DESC, height: MAX_MEDIA_DIMENSION + 1 },
    { ...DESC, width: null }
  ]
  for (const d of bad) t.is(validateRecord(withMedia([DESC, d]), 1), 'media-invalid', 'invalid ' + JSON.stringify(d))
  // Hostile getters never throw.
  const hostile = { ...DESC }
  Object.defineProperty(hostile, 'core', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(withMedia([hostile]), 1), 'media-invalid')
})

test('postRecord with media', async (t) => {
  await testnet(t)
  const rec = postRecord({ text: '', at: AT, media: [DESC] })
  t.alike(Object.keys(rec), ['type', 'text', 'at', 'replyTo', 'media'])
  t.alike(rec.media, [DESC])
  t.ok(rec.media[0] !== DESC, 'a copy of each descriptor')
  t.alike(Object.keys(rec.media[0]), ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height'])
  t.alike(Object.keys(postRecord({ text: 'oi', at: AT })), ['type', 'text', 'at', 'replyTo'], 'no media key when absent')
  await t.exception.all(async () => postRecord({ text: '', at: AT }), /text-length/)
  await t.exception.all(async () => postRecord({ text: 'x', at: AT, media: [] }), /media-invalid/)
  t.alike(postRecord({ text: 'x', at: AT, media: [{ ...DESC, extra: 1 }] }).media, [DESC], 'only the descriptor keys are copied')
  await t.exception.all(async () => postRecord({ text: 'x', at: AT, media: [{ ...DESC, bytes: 0 }] }), /media-invalid/)
  await t.exception.all(async () => postRecord({ text: 'x', at: AT, media: null }), /media-invalid/)
})

test('media-core and follow records', async (t) => {
  await testnet(t)
  const mc = { type: 'media-core', key: K2, at: AT }
  const fo = { type: 'follow', key: K2, on: true, at: AT }
  t.is(validateRecord(mc, 1), null)
  t.is(validateRecord(fo, 1), null)
  t.is(validateRecord({ ...fo, on: false }, 1), null)
  t.is(validateRecord(mc, 0), 'genesis-required')
  t.is(validateRecord(fo, 0), 'genesis-required')
  for (const key of ['A'.repeat(64), K2.slice(1), 1, null]) {
    t.is(validateRecord({ ...mc, key }, 1), 'malformed', 'media-core key ' + key)
    t.is(validateRecord({ ...fo, key }, 1), 'malformed', 'follow key ' + key)
  }
  for (const on of [1, 'true', null, undefined]) t.is(validateRecord({ ...fo, on }, 1), 'malformed', 'on ' + on)
  t.is(validateRecord({ ...mc, extra: 1 }, 1), 'malformed')
  t.is(validateRecord({ ...fo, extra: 1 }, 1), 'malformed')
  t.is(validateRecord({ ...mc, on: true }, 1), 'malformed')
  const noOn = { ...fo }
  delete noOn.on
  t.is(validateRecord(noOn, 1), 'malformed')
  t.is(validateRecord({ ...mc, at: '2026-01-01' }, 1), 'date-invalid')
  t.is(validateRecord({ ...fo, at: null }, 1), 'date-invalid')
  t.alike(mediaCoreRecord({ key: K2, at: AT }), mc)
  t.alike(followRecord({ key: K2, on: true, at: AT }), fo)
  t.ok(isCanonicalIso(followRecord({ key: K2, on: false }).at))
  await t.exception.all(async () => mediaCoreRecord({ key: 'x', at: AT }), /malformed/)
  await t.exception.all(async () => followRecord({ key: K2, on: 'yes', at: AT }), /malformed/)
})

test('like and repost records', async (t) => {
  await testnet(t)
  const { likeRecord, repostRecord } = records
  for (const type of ['like', 'repost']) {
    const rec = (over) => ({ type, to: { author: K1, seq: 3 }, on: true, at: AT, ...over })
    t.is(validateRecord(rec(), 1), null, type)
    t.is(validateRecord(rec({ on: false }), 1), null, type + ' off')
    t.is(validateRecord(rec({ to: { author: K2, seq: 1 } }), 5), null, type + ' seq 1 target')
    t.is(validateRecord(rec(), 0), 'genesis-required', type + ' never at seq 0')
    t.is(validateRecord(rec({ extra: 1 }), 1), 'malformed', type + ' with an extra key')
    const noOn = rec()
    delete noOn.on
    t.is(validateRecord(noOn, 1), 'malformed', type + ' without on')
    const noTo = rec()
    delete noTo.to
    t.is(validateRecord(noTo, 1), 'malformed', type + ' without to')
    t.is(validateRecord({ ...rec(), key: K1 }, 1), 'malformed', type + ' with a follow key')
    for (const on of [1, 0, 'true', null, undefined]) t.is(validateRecord(rec({ on }), 1), 'malformed', type + ' on ' + on)
    const badTo = [
      null, 'x', 1, [], [K1, 3], K1 + ':3',
      { author: K1, seq: 3, extra: 1 },
      { author: 'A'.repeat(64), seq: 3 },
      { author: K1.slice(1), seq: 3 },
      { author: K1, seq: 0 },
      { author: K1, seq: -1 },
      { author: K1, seq: 1.5 },
      { author: K1, seq: '3' },
      { author: K1, seq: Number.MAX_SAFE_INTEGER + 1 },
      { author: K1 },
      { seq: 3 }
    ]
    for (const to of badTo) t.is(validateRecord(rec({ to }), 1), 'malformed', type + ' to ' + JSON.stringify(to))
    t.is(validateRecord(rec({ at: '2026-01-01' }), 1), 'date-invalid')
    t.is(validateRecord(rec({ at: null }), 1), 'date-invalid')
    t.is(records.validRecordCopy(rec({ to: { author: K1, seq: 0 } }), 1), null)
  }
  // Builders: exact keys, a copy of `to` with only its keys.
  const to = { author: K1, seq: 3, extra: 'x' }
  const like = likeRecord({ to, on: true, at: AT })
  t.alike(like, { type: 'like', to: { author: K1, seq: 3 }, on: true, at: AT })
  t.alike(Object.keys(like), ['type', 'to', 'on', 'at'])
  t.ok(like.to !== to, 'to is copied')
  t.alike(repostRecord({ to, on: false, at: AT }), { type: 'repost', to: { author: K1, seq: 3 }, on: false, at: AT })
  t.ok(isCanonicalIso(likeRecord({ to, on: false }).at))
  await t.exception.all(async () => likeRecord({ to: { author: K1, seq: 0 }, on: true, at: AT }), /malformed/)
  await t.exception.all(async () => repostRecord({ to: { author: K1, seq: 1 }, on: 'yes', at: AT }), /malformed/)
  await t.exception.all(async () => repostRecord({ to: null, on: true, at: AT }), /malformed/)
  await t.exception.all(async () => likeRecord(), /malformed/)
})

test('quote posts', async (t) => {
  await testnet(t)
  const Q = { author: K2, seq: 4 }
  const quote = (over) => ({ type: 'post', text: 'olha isso', at: AT, replyTo: null, quote: Q, ...over })
  t.is(validateRecord(quote(), 1), null)
  t.is(validateRecord(quote({ media: [DESC] }), 1), null, 'quote with media')
  t.is(validateRecord(quote({ media: [DESC, DESC, DESC, DESC] }), 1), null)
  t.is(validateRecord(quote({ quote: { author: K1, seq: 1 } }), 2), null, 'quoting an own post')
  t.is(validateRecord(quote(), 0), 'genesis-required')
  // replyTo must be null.
  t.is(validateRecord(quote({ replyTo: { author: K1, seq: 1 } }), 1), 'quote-with-reply')
  t.is(validateRecord(quote({ replyTo: { author: K1, seq: 1 }, media: [DESC] }), 1), 'quote-with-reply')
  t.is(validateRecord(quote({ replyTo: 'x' }), 1), 'quote-with-reply')
  // Key sets: exactly the quote keys, optionally plus media.
  t.is(validateRecord(quote({ extra: 1 }), 1), 'malformed')
  t.is(validateRecord(quote({ media: [DESC], extra: 1 }), 1), 'malformed')
  const noReply = quote()
  delete noReply.replyTo
  t.is(validateRecord(noReply, 1), 'malformed', 'quote without replyTo')
  // The quote target: never null, exactly { author, seq }.
  const badQuote = [null, undefined, 'x', 1, [], K2 + ':4', { author: K2, seq: 4, extra: 1 }, { author: 'B'.repeat(64), seq: 4 }, { author: K2, seq: 0 }, { author: K2, seq: 1.5 }, { author: K2 }]
  for (const q of badQuote) {
    t.is(validateRecord(quote({ quote: q }), 1), 'quote-invalid', 'quote ' + JSON.stringify(q))
    t.is(validateRecord(quote({ quote: q, media: [DESC] }), 1), 'quote-invalid', 'quote with media ' + JSON.stringify(q))
  }
  // Text: 1..MAX_TEXT, even with media.
  t.is(validateRecord(quote({ text: '' }), 1), 'text-length')
  t.is(validateRecord(quote({ text: '', media: [DESC] }), 1), 'text-length', 'empty quote text refused even with media')
  t.is(validateRecord(quote({ text: 'x'.repeat(MAX_TEXT) }), 1), null)
  t.is(validateRecord(quote({ text: 'x'.repeat(MAX_TEXT + 1) }), 1), 'text-length')
  t.is(validateRecord(quote({ text: 'a‮b' }), 1), 'control-chars')
  t.is(validateRecord(quote({ at: 'x' }), 1), 'date-invalid')
  t.is(validateRecord(quote({ media: [] }), 1), 'media-invalid')
  t.is(validateRecord(quote({ media: [{ ...DESC, extra: 1 }] }), 1), 'media-invalid')
  // Photo-only plain posts keep their empty text.
  t.is(validateRecord({ type: 'post', text: '', at: AT, replyTo: null, media: [DESC] }, 1), null)
  // postRecord: quote only when given, copied with only its keys.
  const given = { author: K2, seq: 4, extra: 'x' }
  const rec = postRecord({ text: 'oi', at: AT, quote: given })
  t.alike(Object.keys(rec), ['type', 'text', 'at', 'replyTo', 'quote'])
  t.alike(rec.quote, Q)
  t.ok(rec.quote !== given, 'quote is copied')
  const withMedia = postRecord({ text: 'oi', at: AT, quote: Q, media: [DESC] })
  t.alike(Object.keys(withMedia), ['type', 'text', 'at', 'replyTo', 'quote', 'media'])
  t.absent('quote' in postRecord({ text: 'oi', at: AT }))
  await t.exception.all(async () => postRecord({ text: 'oi', at: AT, quote: null }), /quote-invalid/)
  await t.exception.all(async () => postRecord({ text: 'oi', at: AT, quote: Q, replyTo: { author: K1, seq: 1 } }), /quote-with-reply/)
  await t.exception.all(async () => postRecord({ text: '', at: AT, quote: Q, media: [DESC] }), /text-length/)
})

test('old readers: unknown types stay malformed', async (t) => {
  await testnet(t)
  // A record of a future type is skipped exactly as before.
  t.is(validateRecord({ type: 'bookmark', to: { author: K1, seq: 1 }, on: true, at: AT }, 1), 'malformed')
  t.is(validateRecord({ type: 'reaction', to: { author: K1, seq: 1 }, on: true, at: AT }, 1), 'malformed')
  t.is(validateRecord({ type: 'like', to: { author: K1, seq: 1 }, on: true, at: AT, emoji: 'x' }, 1), 'malformed', 'like with an extra key')
  t.is(records.validRecordCopy({ type: 'bookmark', at: AT }, 1), null)
  // Hostile getters on the new shapes never throw.
  const hostile = { type: 'like', on: true, at: AT }
  Object.defineProperty(hostile, 'to', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(hostile, 1), 'malformed')
  const hostileQuote = { type: 'post', text: 'oi', at: AT, replyTo: null }
  Object.defineProperty(hostileQuote, 'quote', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(hostileQuote, 1), 'malformed')
})

test('group-join records', async (t) => {
  await testnet(t)
  const { groupJoinRecord, TYPES, MAX_GROUP_WRITERS, MAX_GROUPS_PER_DIARY, MAX_GROUPS_PER_COMMUNITY, MAX_GROUP_CUTS, MAX_GROUP_NAME, MAX_GROUP_WRITERS_PER_DIARY } = records
  t.alike([...TYPES], ['member-cert', 'profile', 'post', 'username', 'media-core', 'follow', 'like', 'repost', 'group-join'], 'TYPES parity')
  t.ok(Object.isFrozen(TYPES))
  t.alike([MAX_GROUP_WRITERS, MAX_GROUPS_PER_DIARY, MAX_GROUPS_PER_COMMUNITY, MAX_GROUP_CUTS, MAX_GROUP_NAME, MAX_GROUP_WRITERS_PER_DIARY], [512, 64, 32, 16, 80, 8])
  const gj = { type: 'group-join', group: K1, writer: K2, on: true, at: AT }
  t.is(validateRecord(gj, 1), null)
  t.is(validateRecord({ ...gj, writer: K1 }, 1), null, 'the creator binds the root itself')
  t.is(validateRecord({ ...gj, on: false }, 3), null)
  t.is(validateRecord(gj, 0), 'genesis-required')
  for (const k of ['A'.repeat(64), K1.slice(1), 1, null]) {
    t.is(validateRecord({ ...gj, group: k }, 1), 'malformed', 'group ' + k)
    t.is(validateRecord({ ...gj, writer: k }, 1), 'malformed', 'writer ' + k)
  }
  for (const on of [1, 'true', null, undefined]) t.is(validateRecord({ ...gj, on }, 1), 'malformed', 'on ' + on)
  t.is(validateRecord({ ...gj, extra: 1 }, 1), 'malformed')
  const noWriter = { ...gj }
  delete noWriter.writer
  t.is(validateRecord(noWriter, 1), 'malformed')
  t.is(validateRecord({ ...gj, at: '2026-01-01' }, 1), 'date-invalid')
  t.alike(groupJoinRecord({ group: K1, writer: K2, on: true, at: AT }), gj)
  t.alike(Object.keys(groupJoinRecord({ group: K1, writer: K2, on: false })), ['type', 'group', 'writer', 'on', 'at'])
  await t.exception.all(async () => groupJoinRecord({ group: K1, writer: 'x', on: true, at: AT }), /malformed/)
  const hostile = { type: 'group-join', group: K1, on: true, at: AT }
  Object.defineProperty(hostile, 'writer', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(hostile, 1), 'malformed')
})
