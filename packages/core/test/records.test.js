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
  t.alike(latestProfile(entries), { name: 'Ana Maria', bio: 'dois', avatar: null })
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
  t.alike(latestProfile([{ seq: 1, record: shifty }]), { name: 'Ana', bio: '', avatar: null })
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
  t.is(MAX_MEDIA_PER_POST, 10)
  t.is(records.MAX_DELETE_RANGES, 4)
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
  for (const media of [null, [], new Array(11).fill(DESC), DESC, 'x', 1, {}, [null], [[]]]) {
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

// The widest descriptor: every number at its longest decimal form.
const WIDEST = { core: K2, mime: 'image/jpeg', start: MAX_MEDIA_BLOCKS - MAX_MEDIA_ITEM_BLOCKS, blocks: MAX_MEDIA_ITEM_BLOCKS, bytes: MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES, sha256: 'd'.repeat(64), width: MAX_MEDIA_DIMENSION, height: MAX_MEDIA_DIMENSION }

test('validateRecord: ten media items on a post, reply and quote', async (t) => {
  await testnet(t)
  const ten = new Array(10).fill(WIDEST)
  const eleven = new Array(11).fill(WIDEST)
  const shapes = {
    post: { type: 'post', text: 'oi', at: AT, replyTo: null },
    reply: { type: 'post', text: 'oi', at: AT, replyTo: { author: K1, seq: 2 } },
    quote: { type: 'post', text: 'oi', at: AT, replyTo: null, quote: { author: K1, seq: 2 } }
  }
  for (const [name, rec] of Object.entries(shapes)) {
    t.is(validateRecord({ ...rec, media: ten }, 3), null, name + ' with 10 media items')
    t.is(validateRecord({ ...rec, media: eleven }, 3), 'media-invalid', name + ' with 11 media items')
  }
  t.is(postRecord({ text: '', at: AT, media: ten }).media.length, 10)
  await t.exception.all(async () => postRecord({ text: '', at: AT, media: eleven }), /media-invalid/)
  // A lone surrogate is escaped to six JSON bytes, the most any code point
  // costs, and the year 275760 is the longest canonical date.
  const worst = { ...shapes.quote, text: '\ud800'.repeat(MAX_TEXT), at: new Date(8.64e15).toISOString(), quote: { author: K1, seq: Number.MAX_SAFE_INTEGER }, media: ten }
  t.is(validateRecord(worst, 3), null)
  const bytes = b4a.byteLength(JSON.stringify(worst))
  t.ok(bytes <= MAX_BLOCK_BYTES, 'worst ten-media quote ' + bytes + ' bytes')
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

const THUMB = { core: K2, mime: 'image/jpeg', start: 3, blocks: 1, bytes: 32768, sha256: 'e'.repeat(64), width: 400, height: 210 }
const CARD = { url: 'https://example.com/a', host: 'example.com', title: 'Título', desc: 'Descrição', image: THUMB }

test('validateRecord: posts with a link preview', (t) => {
  t.alike(records.POST_PREVIEW_KEYS, ['type', 'text', 'at', 'replyTo', 'preview'])
  t.alike(records.QUOTE_PREVIEW_KEYS, ['type', 'text', 'at', 'replyTo', 'quote', 'preview'])
  const post = (over) => ({ type: 'post', text: 'olha https://example.com/a', at: AT, replyTo: null, preview: CARD, ...over })
  const quote = { author: K1, seq: 3 }
  t.is(validateRecord(post(), 1), null)
  t.is(validateRecord(post({ preview: { ...CARD, image: null } }), 1), null, 'no thumbnail')
  t.is(validateRecord(post({ replyTo: { author: K1, seq: 2 } }), 1), null, 'a reply with a preview')
  t.is(validateRecord(post({ quote }), 1), null, 'a quote with a preview')
  t.is(validateRecord(post({ quote, replyTo: { author: K1, seq: 2 } }), 1), 'quote-with-reply')
  t.is(validateRecord(post({ text: '' }), 1), 'text-length', 'a preview is not a caption-free photo')
  t.is(validateRecord(post({ text: 'a\u202eb' }), 1), 'control-chars')
  t.is(validateRecord(post({ media: [DESC] }), 1), 'malformed', 'media and a preview together')
  t.is(validateRecord(post({ quote, media: [DESC] }), 1), 'malformed', 'a quote with media and a preview')
  t.is(validateRecord(post({ extra: 1 }), 1), 'malformed')
  t.is(validateRecord(post({ preview: null }), 1), 'preview-invalid', 'a null preview is no preview: the 4-key form')
  const bad = {
    http: { ...CARD, url: 'http://example.com/a' },
    javascript: { ...CARD, url: 'javascript:alert(1)' },
    data: { ...CARD, url: 'data:text/html,x' },
    ftp: { ...CARD, url: 'ftp://example.com/a' },
    credentials: { ...CARD, url: 'https://u:p@example.com/a' },
    'host mismatch': { ...CARD, host: 'evil.com' },
    'long title': { ...CARD, title: 'x'.repeat(81) },
    'long desc': { ...CARD, desc: 'x'.repeat(161) },
    'control in title': { ...CARD, title: 'a\u0007' },
    'bidi in desc': { ...CARD, desc: 'a‮' },
    'image over 32768': { ...CARD, image: { ...THUMB, blocks: 2, bytes: 32769 } },
    'image not jpeg': { ...CARD, image: { ...THUMB, mime: 'image/png' } },
    'image a dm blob': { ...CARD, image: { id: 'a'.repeat(64), key: 'b'.repeat(64), nonce: 'c'.repeat(48), chunks: 1, bytes: 100, sha256: 'd'.repeat(64), mime: 'image/jpeg', w: 1, h: 1, ms: 0 } },
    'image a url': { ...CARD, image: 'https://example.com/x.jpg' },
    'extra key': { ...CARD, extra: 1 },
    'not an object': 'https://example.com/a'
  }
  for (const [name, preview] of Object.entries(bad)) t.is(validateRecord(post({ preview }), 1), 'preview-invalid', name)
  const hostile = { ...CARD }
  Object.defineProperty(hostile, 'title', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(post({ preview: hostile }), 1), 'preview-invalid')
})

test('postRecord with a link preview round-trips', async (t) => {
  const rec = postRecord({ text: 'olha', at: AT, preview: { ...CARD, extra: 1, image: { ...THUMB, extra: 1 } } })
  t.alike(Object.keys(rec), ['type', 'text', 'at', 'replyTo', 'preview'])
  t.alike(rec.preview, CARD, 'only the card and descriptor keys are copied')
  const decoded = decodeBlock(Buffer.from(JSON.stringify(rec)))
  t.is(validateRecord(decoded, 1), null)
  t.alike(records.validRecordCopy(decoded, 1).preview, CARD)
  t.alike(Object.keys(postRecord({ text: 'oi', at: AT, preview: null })), ['type', 'text', 'at', 'replyTo'], 'null preview adds no key')
  const q = postRecord({ text: 'oi', at: AT, quote: { author: K1, seq: 1 }, preview: CARD })
  t.alike(Object.keys(q), ['type', 'text', 'at', 'replyTo', 'quote', 'preview'])
  await t.exception.all(async () => postRecord({ text: 'x', at: AT, media: [DESC], preview: CARD }), /malformed/)
  await t.exception.all(async () => postRecord({ text: 'x', at: AT, preview: { ...CARD, url: 'http://example.com/a' } }), /preview-invalid/)
  // Posts without a preview still open as before.
  t.is(validateRecord({ type: 'post', text: 'oi', at: AT, replyTo: null }, 1), null)
  t.is(validateRecord({ type: 'post', text: '', at: AT, replyTo: null, media: [DESC] }, 1), null)
  // The worst preview post still fits one block.
  const worst = postRecord({
    text: '\u{1F600}'.repeat(MAX_TEXT),
    at: AT,
    quote: { author: K1, seq: Number.MAX_SAFE_INTEGER },
    preview: {
      url: 'https://example.com/' + '%'.repeat(280),
      host: 'example.com',
      title: '\u{1F600}'.repeat(80),
      desc: '\u{1F600}'.repeat(160),
      image: { ...THUMB, start: 8191, width: 16384, height: 16384 }
    }
  })
  t.ok(Buffer.byteLength(JSON.stringify(worst)) < MAX_BLOCK_BYTES, 'worst preview post ' + Buffer.byteLength(JSON.stringify(worst)) + ' bytes')
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
  t.is(validateRecord(quote({ text: 'a\u202eb' }), 1), 'control-chars')
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
  t.alike([...TYPES], ['member-cert', 'profile', 'post', 'username', 'media-core', 'follow', 'like', 'repost', 'group-join', 'delete', 'group-cut', 'group-confirm', 'dm-key', 'page-roster', 'page-accept', 'page-offer', 'page-close', 'page-moved', 'page-origin', 'page-delegate', 'page-link', 'listing', 'listing-edit', 'listing-status', 'listing-rate', 'testimonial', 'testimonial-show', 'moment', 'post-share'], 'TYPES parity')
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

test('group-join records with a rejoin', async (t) => {
  await testnet(t)
  const { groupJoinRecord } = records
  const gj = { type: 'group-join', group: K1, writer: K2, on: true, rejoin: { writer: K1, seq: 2 }, at: AT }
  t.is(validateRecord(gj, 1), null)
  t.is(validateRecord({ ...gj, rejoin: null }, 1), null, 'a null rejoin')
  t.is(validateRecord({ ...gj, on: false }, 1), null)
  for (const rejoin of [{ writer: K1, seq: 0 }, { writer: K1, seq: 1.5 }, { writer: K1, seq: '2' }, { writer: 'A'.repeat(64), seq: 2 }, { writer: K1 }, { writer: K1, seq: 2, extra: 1 }, [K1, 2], 'x', 1, undefined]) {
    t.is(validateRecord({ ...gj, rejoin }, 1), 'malformed', 'rejoin ' + JSON.stringify(rejoin))
  }
  t.is(validateRecord({ ...gj, extra: 1 }, 1), 'malformed', 'exact keys')
  const noAt = { ...gj }
  delete noAt.at
  t.is(validateRecord(noAt, 1), 'malformed')
  t.is(validateRecord({ ...gj, at: '2026-01-01' }, 1), 'date-invalid')
  t.alike(groupJoinRecord({ group: K1, writer: K2, on: true, rejoin: { writer: K1, seq: 2 }, at: AT }), gj)
  t.alike(Object.keys(groupJoinRecord({ group: K1, writer: K2, on: true, rejoin: null })), ['type', 'group', 'writer', 'on', 'rejoin', 'at'])
  t.alike(Object.keys(groupJoinRecord({ group: K1, writer: K2, on: true })), ['type', 'group', 'writer', 'on', 'at'], 'without rejoin as before')
  await t.exception.all(async () => groupJoinRecord({ group: K1, writer: K2, on: true, rejoin: { writer: K1, seq: 0 }, at: AT }), /malformed/)
})

test('group-confirm records', async (t) => {
  await testnet(t)
  const { groupConfirmRecord } = records
  const D = 'd'.repeat(64)
  const gc = { type: 'group-confirm', group: K1, writer: K2, seq: 3, digest: D, at: AT }
  t.is(validateRecord(gc, 1), null)
  t.is(validateRecord(gc, 0), 'genesis-required', 'diary seq >= 1')
  for (const seq of [0, -1, 1.5, '3', null, undefined]) t.is(validateRecord({ ...gc, seq }, 1), 'malformed', 'seq ' + seq)
  for (const digest of ['D'.repeat(64), 'd'.repeat(63), 'g'.repeat(64), null, 1]) t.is(validateRecord({ ...gc, digest }, 1), 'malformed', 'digest ' + digest)
  for (const k of ['A'.repeat(64), K1.slice(1), null]) {
    t.is(validateRecord({ ...gc, group: k }, 1), 'malformed', 'group ' + k)
    t.is(validateRecord({ ...gc, writer: k }, 1), 'malformed', 'writer ' + k)
  }
  t.is(validateRecord({ ...gc, extra: 1 }, 1), 'malformed', 'exact keys')
  t.is(validateRecord({ ...gc, at: '2026-01-01' }, 1), 'date-invalid')
  t.alike(groupConfirmRecord({ group: K1, writer: K2, seq: 3, digest: D, at: AT }), gc)
  t.alike(Object.keys(groupConfirmRecord({ group: K1, writer: K2, seq: 3, digest: D })), ['type', 'group', 'writer', 'seq', 'digest', 'at'])
  await t.exception.all(async () => groupConfirmRecord({ group: K1, writer: K2, seq: 0, digest: D, at: AT }), /malformed/)
})

test('group-cut records', async (t) => {
  await testnet(t)
  const { groupCutRecord } = records
  const gc = { type: 'group-cut', group: K1, writer: K1, cut: 5, at: AT }
  t.is(validateRecord(gc, 1), null)
  t.is(validateRecord({ ...gc, cut: 0 }, 1), null, 'cut 0')
  t.is(validateRecord({ ...gc, writer: K2 }, 4), null, 'any writer of the group')
  t.is(validateRecord(gc, 0), 'genesis-required', 'seq >= 1')
  for (const cut of [-1, 1.5, '5', null, undefined, Number.MAX_SAFE_INTEGER + 1]) t.is(validateRecord({ ...gc, cut }, 1), 'malformed', 'cut ' + cut)
  for (const k of ['A'.repeat(64), K1.slice(1), 1, null]) {
    t.is(validateRecord({ ...gc, group: k }, 1), 'malformed', 'group ' + k)
    t.is(validateRecord({ ...gc, writer: k }, 1), 'malformed', 'writer ' + k)
  }
  t.is(validateRecord({ ...gc, extra: 1 }, 1), 'malformed', 'exact keys')
  t.is(validateRecord({ ...gc, on: false }, 1), 'malformed', 'not a group-join variant')
  const noCut = { ...gc }
  delete noCut.cut
  t.is(validateRecord(noCut, 1), 'malformed')
  t.is(validateRecord({ ...gc, at: '2026-01-01' }, 1), 'date-invalid')
  t.alike(groupCutRecord({ group: K1, writer: K1, cut: 5, at: AT }), gc)
  t.alike(Object.keys(groupCutRecord({ group: K1, writer: K1, cut: 0 })), ['type', 'group', 'writer', 'cut', 'at'])
  await t.exception.all(async () => groupCutRecord({ group: K1, writer: K1, cut: -1, at: AT }), /malformed/)
})

const AVATAR = { core: K2, mime: 'image/webp', start: 3, blocks: 2, bytes: 40000, sha256: 'e'.repeat(64), width: 512, height: 512 }

test('avatar constants match @varanda/rpc', async (t) => {
  await testnet(t)
  const rpc = require('@varanda/rpc')
  t.is(records.AVATAR_SIDE, 512)
  t.is(records.MAX_AVATAR_BLOCKS, 8)
  t.is(records.MAX_AVATAR_BYTES, 262144)
  t.is(records.MAX_AVATAR_BYTES, 8 * MEDIA_BLOCK_BYTES)
  t.alike([...records.AVATAR_MIMES], ['image/jpeg', 'image/webp'])
  t.ok(Object.isFrozen(records.AVATAR_MIMES))
  t.alike(records.PROFILE_AVATAR_KEYS, ['type', 'name', 'bio', 'at', 'avatar'])
  t.is(rpc.AVATAR_SIDE, records.AVATAR_SIDE)
  t.is(rpc.MAX_AVATAR_BLOCKS, records.MAX_AVATAR_BLOCKS)
  t.is(rpc.MAX_AVATAR_BYTES, records.MAX_AVATAR_BYTES)
  t.alike([...rpc.AVATAR_MIMES], [...records.AVATAR_MIMES])
})

test('validateRecord: profile with an avatar', async (t) => {
  await testnet(t)
  const p = (avatar, over) => ({ type: 'profile', name: 'Ana', bio: '', at: AT, avatar, ...over })
  t.is(validateRecord(p(AVATAR), 1), null)
  t.is(validateRecord(p({ ...AVATAR, mime: 'image/jpeg' }), 1), null)
  t.is(validateRecord(p({ ...AVATAR, blocks: 8, bytes: 262144 }), 1), null)
  t.is(validateRecord(p({ ...AVATAR, blocks: 1, bytes: 1 }), 1), null)
  t.ok(records.validAvatar(AVATAR))
  const extra = { ...AVATAR, extra: 1 }
  const missing = { ...AVATAR }
  delete missing.sha256
  for (const avatar of [
    { ...AVATAR, mime: 'image/png' },
    { ...AVATAR, mime: 'image/gif' },
    { ...AVATAR, width: 511, height: 511 },
    { ...AVATAR, width: 513, height: 513 },
    { ...AVATAR, width: 512, height: 511 },
    { ...AVATAR, width: 511, height: 512 },
    { ...AVATAR, blocks: 9, bytes: 9 * MEDIA_BLOCK_BYTES },
    { ...AVATAR, blocks: 8, bytes: 262145 },
    { ...AVATAR, bytes: 1 },
    extra,
    missing,
    null,
    undefined,
    [AVATAR],
    'x',
    {}
  ]) {
    t.is(validateRecord(p(avatar), 1), 'media-invalid', JSON.stringify(avatar))
    t.absent(records.validAvatar(avatar))
  }
  // The other profile rules still apply with an avatar.
  t.is(validateRecord(p(AVATAR, { name: '' }), 1), 'name-length')
  t.is(validateRecord(p(AVATAR, { bio: 'x'.repeat(MAX_BIO + 1) }), 1), 'bio-length')
  t.is(validateRecord(p(AVATAR, { name: 'a\nb' }), 1), 'control-chars')
  t.is(validateRecord(p(AVATAR, { at: 'x' }), 1), 'date-invalid')
  t.is(validateRecord(p(AVATAR), 0), 'genesis-required')
  // Any other key set is malformed.
  t.is(validateRecord(p(AVATAR, { extra: 1 }), 1), 'malformed')
  t.is(validateRecord({ type: 'profile', name: 'Ana', at: AT, avatar: AVATAR }, 1), 'malformed')
  t.is(validateRecord({ type: 'profile', name: 'Ana', bio: '', at: AT, media: [AVATAR] }, 1), 'malformed')
  t.is(validateRecord({ type: 'profile', name: 'Ana', bio: '', avatar: AVATAR }, 1), 'malformed')
})

test('validateRecord: hostile avatars never throw', async (t) => {
  await testnet(t)
  const getter = { type: 'profile', name: 'Ana', bio: '', at: AT }
  Object.defineProperty(getter, 'avatar', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(getter, 1), 'malformed')
  const inner = { ...AVATAR }
  Object.defineProperty(inner, 'width', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord({ type: 'profile', name: 'Ana', bio: '', at: AT, avatar: inner }, 1), 'media-invalid')
  t.absent(records.validAvatar(inner))
  const proxy = new Proxy({ ...AVATAR }, { get () { throw new Error('boom') }, ownKeys () { throw new Error('boom') } })
  t.is(validateRecord({ type: 'profile', name: 'Ana', bio: '', at: AT, avatar: proxy }, 1), 'media-invalid')
  t.absent(records.validAvatar(proxy))
  const { proxy: revoked, revoke } = Proxy.revocable({ ...AVATAR }, {})
  revoke()
  t.absent(records.validAvatar(revoked))
  t.is(validateRecord({ type: 'profile', name: 'Ana', bio: '', at: AT, avatar: revoked }, 1), 'media-invalid')
  // A mime that changes between reads: validated once on the copy.
  let reads = 0
  const shifty = { ...AVATAR }
  Object.defineProperty(shifty, 'mime', { enumerable: true, get () { return reads++ === 0 ? 'image/webp' : 'image/png' } })
  const got = records.validRecordCopy({ type: 'profile', name: 'Ana', bio: '', at: AT, avatar: shifty }, 1)
  t.ok(got === null || got.avatar.mime === 'image/webp')
})

test('profileRecord and profileRecords', async (t) => {
  await testnet(t)
  t.alike(Object.keys(profileRecord({ name: 'Ana', at: AT, avatar: null })), ['type', 'name', 'bio', 'at'])
  t.alike(Object.keys(profileRecord({ name: 'Ana', at: AT, avatar: AVATAR })), ['type', 'name', 'bio', 'at', 'avatar'])
  const src = { ...AVATAR }
  const one = profileRecord({ name: 'Ana', at: AT, avatar: src })
  t.not(one.avatar, src)
  t.alike(one.avatar, AVATAR)
  await t.exception.all(async () => profileRecord({ name: 'Ana', at: AT, avatar: { ...AVATAR, width: 640 } }), /media-invalid/)
  t.alike(profileRecord({ name: 'Ana', at: AT, avatar: { ...AVATAR, extra: 1 } }).avatar, AVATAR, 'the builder copies only the descriptor keys')

  const plainOnly = records.profileRecords({ name: 'Ana', bio: 'um', at: AT })
  t.is(plainOnly.length, 1)
  t.alike(plainOnly[0], { type: 'profile', name: 'Ana', bio: 'um', at: AT })
  t.is(records.profileRecords({ name: 'Ana', at: AT, avatar: null }).length, 1)

  const pair = records.profileRecords({ name: 'Ana', bio: 'um', avatar: AVATAR })
  t.is(pair.length, 2)
  t.alike(Object.keys(pair[0]), ['type', 'name', 'bio', 'at'])
  t.alike(Object.keys(pair[1]), ['type', 'name', 'bio', 'at', 'avatar'])
  t.is(pair[0].name, pair[1].name)
  t.is(pair[0].bio, pair[1].bio)
  t.is(pair[0].at, pair[1].at)
  t.ok(isCanonicalIso(pair[0].at))
  t.alike(pair[1].avatar, AVATAR)
  for (const r of pair) t.is(validateRecord(r, 1), null)
  await t.exception.all(async () => records.profileRecords({ name: 'Ana', avatar: { ...AVATAR, mime: 'image/png' } }), /media-invalid/)
})

test('latestProfile: avatar from the newest valid profile', async (t) => {
  await testnet(t)
  const pair = records.profileRecords({ name: 'Ana', bio: 'um', at: AT, avatar: AVATAR })
  const entries = [
    { seq: 0, record: { type: 'member-cert', cert: cert() } },
    { seq: 1, record: pair[0] },
    { seq: 2, record: pair[1] }
  ]
  const got = latestProfile(entries)
  t.alike(got, { name: 'Ana', bio: 'um', avatar: AVATAR })
  t.not(got.avatar, pair[1].avatar)
  got.avatar.width = 1
  t.is(pair[1].avatar.width, 512)
  t.is(latestProfile(entries).avatar.width, 512)

  // An old reader knows only the 4-key form: it skips the 5-key block and
  // still sees the same name and bio.
  const oldLatest = (list) => {
    let best = null
    for (const { seq, record } of list) {
      if (seq === 0 || record.type !== 'profile' || Object.keys(record).length !== 4) continue
      if (best === null || seq > best.seq) best = { seq, name: record.name, bio: record.bio }
    }
    return best && { name: best.name, bio: best.bio }
  }
  t.alike(oldLatest(entries), { name: got.name, bio: got.bio })

  // A newer plain profile removes the avatar.
  const removed = [...entries, { seq: 3, record: profileRecord({ name: 'Ana', bio: 'um', at: AT }) }]
  t.is(latestProfile(removed).avatar, null)
  // An invalid newer 5-key block is skipped.
  const bad = [...entries, { seq: 3, record: { ...pair[1], avatar: { ...AVATAR, width: 640, height: 640 } } }]
  t.alike(latestProfile(bad).avatar, AVATAR)
})

test('validateRecord: delete records', async (t) => {
  await testnet(t)
  const { deleteRecord, DELETE_RANGE_KEYS } = records
  const del = { type: 'delete', seq: 3, at: AT }
  const RANGE = { core: K2, start: 1, blocks: 2 }
  t.is(validateRecord(del, 7), null)
  t.is(validateRecord(del, 4), null, 'the block right after the target')
  t.is(validateRecord({ ...del, media: [RANGE] }, 7), null)
  t.is(validateRecord({ ...del, media: [RANGE, RANGE, RANGE, RANGE] }, 7), null)
  t.is(validateRecord(del, 0), 'genesis-required')
  t.is(validateRecord({ ...del, seq: 7 }, 7), 'delete-invalid', 'self target')
  t.is(validateRecord({ ...del, seq: 8 }, 7), 'delete-invalid', 'forward target')
  for (const seq of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    t.is(validateRecord({ ...del, seq }, 7), 'delete-invalid', 'seq ' + String(seq))
  }
  t.is(validateRecord({ ...del, seq: 1 }, 1), 'delete-invalid', 'a tombstone at block 1 has no target')
  t.is(validateRecord(del, undefined), 'delete-invalid', 'no block index')
  t.is(validateRecord({ ...del, extra: 1 }, 7), 'malformed')
  t.is(validateRecord({ ...del, author: K1 }, 7), 'malformed', 'no author field')
  t.is(validateRecord({ ...del, v: 1 }, 7), 'malformed', 'no version field')
  t.is(validateRecord({ ...del, kind: 'post' }, 7), 'malformed', 'no kind field')
  const noAt = { ...del }
  delete noAt.at
  t.is(validateRecord(noAt, 7), 'malformed')
  t.is(validateRecord({ ...del, at: '2026-01-01' }, 7), 'date-invalid')
  t.is(validateRecord({ ...del, at: null }, 7), 'date-invalid')
  const badMedia = [
    null, [], {}, [RANGE, RANGE, RANGE, RANGE, RANGE], [null], [{ ...RANGE, extra: 1 }],
    [{ core: K2, start: 1 }], [{ ...RANGE, core: 'A'.repeat(64) }], [{ ...RANGE, start: 0 }],
    [{ ...RANGE, start: MAX_MEDIA_BLOCKS }], [{ ...RANGE, blocks: 0 }],
    [{ ...RANGE, blocks: MAX_MEDIA_ITEM_BLOCKS + 1 }], [{ ...RANGE, start: 1.5 }],
    [{ ...RANGE, start: MAX_MEDIA_BLOCKS - 1, blocks: 2 }]
  ]
  for (const media of badMedia) t.is(validateRecord({ ...del, media }, 7), 'media-invalid', 'media ' + JSON.stringify(media))
  const sparse = [RANGE, RANGE]
  sparse.length = 3
  t.is(validateRecord({ ...del, media: sparse }, 7), 'media-invalid', 'sparse media')
  t.is(validateRecord({ ...del, media: [{ ...RANGE, start: MAX_MEDIA_BLOCKS - 2, blocks: 2 }] }, 7), null, 'last block of the core')

  t.alike(DELETE_RANGE_KEYS, ['core', 'start', 'blocks'])
  t.alike(deleteRecord({ seq: 3, at: AT }), del)
  t.alike(Object.keys(deleteRecord({ seq: 3, at: AT })), ['type', 'seq', 'at'], 'no media key when absent')
  t.alike(deleteRecord({ seq: 3, at: AT, media: [{ ...RANGE, extra: 1 }] }), { ...del, media: [RANGE] }, 'only the range keys are copied')
  t.ok(isCanonicalIso(deleteRecord({ seq: 1 }).at))
  await t.exception.all(async () => deleteRecord({ seq: 0, at: AT }), /delete-invalid/)
  await t.exception.all(async () => deleteRecord({ seq: '3', at: AT }), /delete-invalid/)
  await t.exception.all(async () => deleteRecord({ at: AT }), /delete-invalid/)
  await t.exception.all(async () => deleteRecord({ seq: 3, at: AT, media: [] }), /media-invalid/)
  await t.exception.all(async () => deleteRecord({ seq: 3, at: AT, media: null }), /media-invalid/)
  await t.exception.all(async () => deleteRecord({ seq: 3, at: 'x' }), /date-invalid/)

  // deleteRecords keeps every record at MAX_DELETE_RANGES ranges or fewer.
  const { deleteRecords, MAX_DELETE_RANGES } = records
  const ranges = Array.from({ length: 10 }, (_, i) => ({ core: K2, start: i + 1, blocks: 1 }))
  const split = deleteRecords({ seq: 3, at: AT, media: ranges })
  t.is(split.length, 3)
  t.alike(split.map((r) => r.media.length), [4, 4, 2])
  t.alike(split.flatMap((r) => r.media), ranges, 'the chunks concatenate to the input in order')
  for (const r of split) {
    t.is(r.seq, 3)
    t.is(r.at, AT)
    t.ok(r.media.length <= MAX_DELETE_RANGES)
    t.is(validateRecord(r, 7), null)
  }
  const nowSplit = deleteRecords({ seq: 3, media: ranges })
  t.ok(nowSplit.every((r) => r.at === nowSplit[0].at), 'one at for every chunk')
  t.ok(isCanonicalIso(nowSplit[0].at))
  const four = deleteRecords({ seq: 3, at: AT, media: ranges.slice(0, 4) })
  t.is(four.length, 1)
  t.alike(four[0], { ...del, media: ranges.slice(0, 4) })
  const bare = deleteRecords({ seq: 3, at: AT })
  t.is(bare.length, 1)
  t.alike(bare[0], del)
  t.absent('media' in bare[0], 'no media key when absent')
  await t.exception.all(async () => deleteRecords({ seq: 3, at: AT, media: [] }), /media-invalid/)

  // Hostile getters and proxies never throw.
  const hostileSeq = { type: 'delete', at: AT }
  Object.defineProperty(hostileSeq, 'seq', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(hostileSeq, 7), 'malformed')
  const hostileRange = { core: K2, start: 1 }
  Object.defineProperty(hostileRange, 'blocks', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord({ ...del, media: [hostileRange] }, 7), 'malformed')
  const trap = new Proxy({ ...del }, { ownKeys () { throw new Error('boom') } })
  t.is(validateRecord(trap, 7), 'malformed')
  t.is(records.validRecordCopy(hostileSeq, 7), null)
  t.alike(records.validRecordCopy(del, 7), del)
})

test('validateRecord: post-share records', async (t) => {
  const { postShareRecord, POST_SHARE_KEYS } = records
  const share = { type: 'post-share', seq: 3, at: AT }
  t.alike([...POST_SHARE_KEYS], ['type', 'seq', 'at'])
  t.ok(Object.isFrozen(POST_SHARE_KEYS))
  t.is(validateRecord(share, 7), null)
  t.is(validateRecord(share, 4), null, 'the block right after the post')
  t.is(validateRecord(share, 0), 'genesis-required')
  t.is(validateRecord({ ...share, extra: 1 }, 7), 'malformed', 'a fourth key')
  t.is(validateRecord({ ...share, nonce: K1 }, 7), 'malformed', 'no nonce field')
  t.is(validateRecord({ ...share, origin: K1 }, 7), 'malformed', 'no origin field')
  const noAt = { ...share }
  delete noAt.at
  t.is(validateRecord(noAt, 7), 'malformed', 'missing at')
  const noSeq = { ...share }
  delete noSeq.seq
  t.is(validateRecord(noSeq, 7), 'malformed', 'missing seq')
  t.is(validateRecord({ ...share, seq: 7 }, 7), 'post-share-invalid', 'self target')
  t.is(validateRecord({ ...share, seq: 8 }, 7), 'post-share-invalid', 'forward target')
  for (const seq of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    t.is(validateRecord({ ...share, seq }, 7), 'post-share-invalid', 'seq ' + String(seq))
  }
  t.is(validateRecord({ ...share, seq: 1 }, 1), 'post-share-invalid', 'a share at block 1 has no post')
  t.is(validateRecord(share, undefined), 'post-share-invalid', 'no block index')
  t.is(validateRecord({ ...share, at: '2026-01-01' }, 7), 'date-invalid')
  t.is(validateRecord({ ...share, at: null }, 7), 'date-invalid')
  const hostile = { type: 'post-share', at: AT }
  Object.defineProperty(hostile, 'seq', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(hostile, 7), 'malformed', 'a throwing getter never throws')

  t.alike(postShareRecord({ seq: 3, at: AT }), share)
  t.alike(Object.keys(postShareRecord({ seq: 3, at: AT })), ['type', 'seq', 'at'])
  t.ok(isCanonicalIso(postShareRecord({ seq: 1 }).at))
  await t.exception.all(async () => postShareRecord({ seq: 0, at: AT }), /post-share-invalid/)
  await t.exception.all(async () => postShareRecord({ seq: '3', at: AT }), /post-share-invalid/)
  await t.exception.all(async () => postShareRecord({ at: AT }), /post-share-invalid/)
  await t.exception.all(async () => postShareRecord(), /post-share-invalid/)
  await t.exception.all(async () => postShareRecord({ seq: 3, at: 'x' }), /date-invalid/)
})

test('validateRecord: dm-key', (t) => {
  const { DM_KEY_KEYS, validRecordCopy } = records
  const { pushCandidate } = require('../lib/push-events')
  t.alike(DM_KEY_KEYS, ['type', 'box', 'gen', 'at'])
  const box = '9'.repeat(64)
  const dmKey = (over = {}) => ({ type: 'dm-key', box, gen: 1, at: AT, ...over })
  t.is(validateRecord(dmKey(), 3), null)
  t.alike(validRecordCopy(dmKey({ gen: 2 }), 3), dmKey({ gen: 2 }), 'round trip')
  t.alike(decodeBlock(b4a.from(JSON.stringify(dmKey()))), dmKey())
  t.is(validateRecord({ ...dmKey(), extra: 1 }, 3), 'malformed', 'extra key')
  t.is(validateRecord({ type: 'dm-key', box, at: AT }, 3), 'malformed', 'missing gen')
  t.is(validateRecord(dmKey({ box: 'A'.repeat(64) }), 3), 'malformed', 'uppercase hex')
  t.is(validateRecord(dmKey({ box: 'a'.repeat(63) }), 3), 'malformed', 'short hex')
  t.is(validateRecord(dmKey({ box: '0'.repeat(64) }), 3), 'malformed', 'weak box key')
  t.is(validateRecord(dmKey({ box: 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' }), 3), 'malformed', 'weak box key, high bit set')
  t.is(validateRecord(dmKey({ gen: 0 }), 3), 'malformed', 'gen 0')
  t.is(validateRecord(dmKey({ gen: 4294967295 }), 3), null, 'gen 2^32 - 1')
  t.is(validateRecord(dmKey({ gen: 4294967296 }), 3), 'malformed', 'gen above uint32')
  t.is(validateRecord(dmKey({ gen: 1.5 }), 3), 'malformed', 'gen not an integer')
  t.is(validateRecord(dmKey({ gen: '1' }), 3), 'malformed', 'gen string')
  t.is(validateRecord(dmKey({ at: 'nope' }), 3), 'date-invalid', 'bad date')
  t.is(validateRecord(dmKey(), 0), 'genesis-required', 'seq 0')

  const NOW = Date.parse(AT) + 60000
  const args = { author: K1, seq: 3, isMember: () => true, isBlocked: () => false, now: NOW }
  t.is(pushCandidate({ ...args, record: dmKey() }), null, 'no push candidate')
  t.is(pushCandidate({ ...args, record: dmKey({ box: K2 }) }), null, 'box key never read as a target')
})

test('dm-key: no notice row', (t) => {
  const { createNoticeIndex } = require('../lib/notices')
  const { createPostNoticeIndex } = require('../lib/post-notices')
  const author = 'c'.repeat(64)
  const followRec = { type: 'follow', key: K1, on: true, at: AT }
  const postRec = { type: 'post', text: 'oi', at: AT, replyTo: { author: K1, seq: 1 } }
  const dmRec = { type: 'dm-key', box: K1, gen: 1, at: AT }

  const notices = createNoticeIndex()
  notices.foldFollow(author, 1, followRec)
  notices.foldFollow(author, 2, postRec)
  notices.foldFollow(author, 3, dmRec)
  notices.commit(author)
  const rows = notices.page({ target: K1, isBlocked: () => false }).items
  t.is(rows.length, 1, 'only the follow row')
  t.is(rows[0].seq, 1)

  const posts = createPostNoticeIndex({ verifyUsername: () => true })
  posts.foldPost(author, 1, followRec)
  posts.foldPost(author, 2, postRec)
  posts.foldPost(author, 3, dmRec)
  posts.settle(author)
  const page = posts.pageV2({ target: K1, issuerUsable: () => true, now: Date.parse(AT) + 60000 })
  t.is(page.items.length, 1, 'only the reply row')
  t.is(page.items[0].seq, 2)
})

// Pages (lib/page.js): shapes only, the signatures are checked by the reader.
test('validateRecord: page records', (t) => {
  const { PAGE_KEYS, validRecordCopy } = records
  const P = '1'.repeat(64)
  const O = '2'.repeat(64)
  const A1 = '3'.repeat(64)
  const A2 = '4'.repeat(64)
  const N = 'n'.repeat(43)
  const SIG = 'c'.repeat(128)
  const trio = { association: K2, issuer: '5'.repeat(64), issuerDate: AT, issuerSignature: SIG }
  const valid = {
    'page-roster': { type: 'page-roster', page: P, gen: 1, owner: O, admins: [A1, A2], prev: null, at: AT, nonce: N, ...trio, signature: SIG, countersignature: SIG },
    'page-origin': { type: 'page-origin', page: P, from: K1, fromSeq: 4, gen: 3, owner: O, admins: [], at: AT, nonce: N, actor: O, ...trio, signature: SIG, countersignature: SIG },
    'page-close': { type: 'page-close', page: P, gen: 2, at: AT, nonce: N, actor: O, ...trio, signature: SIG, countersignature: SIG },
    'page-moved': { type: 'page-moved', page: P, to: K1, gen: 1, at: AT, nonce: N, actor: O, ...trio, signature: SIG, countersignature: SIG },
    'page-accept': { type: 'page-accept', page: P, gen: 2, rosterSignature: SIG, at: AT, nonce: N, actor: A1, signature: SIG },
    'page-offer': { type: 'page-offer', page: P, to: A1, exp: AT, gen: 1, at: AT, nonce: N, actor: O, signature: SIG },
    'page-link': { type: 'page-link', page: P, diary: K1, actor: A1, at: AT, nonce: N, ...trio, signature: SIG },
    'page-delegate': { type: 'page-delegate', actor: A1, at: AT }
  }
  for (const [type, r] of Object.entries(valid)) {
    t.alike(Object.keys(r).sort(), [...PAGE_KEYS[type]].sort(), type + ' keys')
    t.is(validateRecord(r, 3), null, type + ' valid')
    t.alike(validRecordCopy(r, 3), r, type + ' copy')
    t.is(validateRecord({ ...r, extra: 1 }, 3), 'malformed', type + ' extra key')
    for (const k of Object.keys(r)) {
      const missing = { ...r }
      delete missing[k]
      t.is(validateRecord(missing, 3), 'malformed', type + ' without ' + k)
    }
    t.is(validateRecord(r, 0), 'genesis-required', type + ' at seq 0')
  }
  const bad = (type, over, why) => t.is(validateRecord({ ...valid[type], ...over }, 3), 'malformed', type + ': ' + why)

  bad('page-roster', { gen: 0 }, 'gen 0')
  bad('page-roster', { gen: 4294967296 }, 'gen above uint32')
  t.is(validateRecord({ ...valid['page-roster'], gen: 4294967295, prev: 9 }, 3), null, 'gen 2^32 - 1')
  bad('page-roster', { gen: '1' }, 'gen string')
  bad('page-roster', { prev: 0 }, 'prev 0')
  bad('page-roster', { prev: 1.5 }, 'prev not an integer')
  bad('page-roster', { admins: [A2, A1] }, 'admins unsorted')
  bad('page-roster', { admins: [A1, A1] }, 'admins repeated')
  bad('page-roster', { admins: [O] }, 'owner among admins')
  bad('page-roster', { admins: ['A'.repeat(64)] }, 'uppercase admin')
  bad('page-roster', { admins: 'x' }, 'admins not an array')
  bad('page-roster', { admins: new Array(1) }, 'sparse admins')
  const many = Array.from({ length: 17 }, (_, i) => (i + 16).toString(16).padStart(64, '0'))
  t.is(validateRecord({ ...valid['page-roster'], admins: many.slice(0, 16) }, 3), null, '16 admins')
  bad('page-roster', { admins: many }, '17 admins')
  bad('page-roster', { nonce: 'n'.repeat(42) }, 'short nonce')
  bad('page-roster', { nonce: 'n'.repeat(42) + '=' }, 'nonce charset')
  bad('page-roster', { at: 'nope' }, 'bad date')
  bad('page-roster', { page: 'A'.repeat(64) }, 'uppercase page')
  bad('page-roster', { issuer: K2 }, 'issuer equals the association')
  bad('page-roster', { countersignature: 'c'.repeat(127) }, 'short countersignature')
  bad('page-origin', { from: P }, 'from equals page')
  bad('page-origin', { fromSeq: 0 }, 'fromSeq 0')
  bad('page-origin', { actor: A1 }, 'actor is not the owner')
  bad('page-origin', { admins: [O] }, 'owner among admins')
  bad('page-close', { gen: 1 }, 'gen 1')
  bad('page-moved', { to: P }, 'moved to itself')
  bad('page-accept', { gen: 1 }, 'gen 1')
  bad('page-accept', { rosterSignature: 'x' }, 'bad rosterSignature')
  t.is(validateRecord({ ...valid['page-offer'], to: null, exp: null }, 3), null, 'offer cancel')
  bad('page-offer', { to: null }, 'to null with exp')
  bad('page-offer', { exp: null }, 'exp null with to')
  bad('page-offer', { exp: 'nope' }, 'bad exp')
  bad('page-link', { diary: P }, 'diary equals page')
  bad('page-link', { actor: K1 }, 'actor equals diary')
  bad('page-link', { actor: P }, 'actor equals page')
  bad('page-delegate', { actor: 'x' }, 'bad actor')

  const noAssoc = (type) => {
    const r = { ...valid[type] }
    delete r.association
    return r
  }
  t.is(validateRecord(noAssoc('page-link'), 3), 'malformed', 'page-link without association')
  t.is(validateRecord(noAssoc('page-close'), 3), 'malformed', 'page-close without association')
  t.is(validateRecord({ type: 'page-invite', page: P, at: AT }, 3), 'malformed', 'no page-invite record')

  const hostile = { ...valid['page-roster'] }
  Object.defineProperty(hostile, 'admins', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(hostile, 3), 'malformed')
  t.is(validRecordCopy(hostile, 3), null)
})

test('testimonial records: sealed commitment shape', async (t) => {
  const { testimonialRecord, MAX_TESTIMONIAL, MAX_TESTIMONIAL_PLAIN, MAX_TESTIMONIAL_SEALED, MAX_TESTIMONIAL_BOX, MIN_TESTIMONIAL_PLAIN } = records
  t.is(MAX_TESTIMONIAL, 400)
  t.is(MAX_TESTIMONIAL_PLAIN, 1686)
  t.is(MAX_TESTIMONIAL_SEALED, 1734)
  t.is(MAX_TESTIMONIAL_BOX, 2312)
  const box = b4a.toString(b4a.alloc(200, 7), 'base64')
  const tr = { type: 'testimonial', to: K2, gen: 1, hash: 'c'.repeat(64), box, at: AT }
  t.is(validateRecord(tr, 1), null)
  t.is(validateRecord(tr, 0), 'genesis-required')
  t.alike(testimonialRecord({ to: K2, gen: 1, hash: 'c'.repeat(64), box, at: AT }), tr)
  t.alike(Object.keys(testimonialRecord({ to: K2, gen: 3, hash: 'c'.repeat(64), box })), ['type', 'to', 'gen', 'hash', 'box', 'at'])
  t.is(validateRecord({ ...tr, extra: 1 }, 1), 'malformed', 'extra key')
  const missing = { ...tr }
  delete missing.gen
  t.is(validateRecord(missing, 1), 'malformed', 'missing key')
  for (const k of ['A'.repeat(64), K1.slice(1), 1, null]) {
    t.is(validateRecord({ ...tr, to: k }, 1), 'malformed', 'to ' + k)
    t.is(validateRecord({ ...tr, hash: k }, 1), 'malformed', 'hash ' + k)
  }
  for (const gen of [0, -1, 1.5, '1', null, 4294967296]) t.is(validateRecord({ ...tr, gen }, 1), 'malformed', 'gen ' + gen)
  // Box: canonical base64 of MIN..MAX sealed bytes.
  const sealedOf = (n) => b4a.toString(b4a.alloc(n, 9), 'base64')
  t.is(validateRecord({ ...tr, box: sealedOf(MAX_TESTIMONIAL_SEALED) }, 1), null, 'largest box fits')
  t.is(sealedOf(MAX_TESTIMONIAL_SEALED).length, MAX_TESTIMONIAL_BOX)
  t.is(validateRecord({ ...tr, box: sealedOf(MAX_TESTIMONIAL_SEALED + 1) }, 1), 'malformed', 'one byte over')
  t.is(validateRecord({ ...tr, box: sealedOf(MIN_TESTIMONIAL_PLAIN + 48) }, 1), null, 'smallest box')
  t.is(validateRecord({ ...tr, box: sealedOf(MIN_TESTIMONIAL_PLAIN + 47) }, 1), 'malformed', 'too small')
  for (const bad of ['', box.slice(0, -1), box.replace(/=*$/, ''), box + '====', '-_' + box.slice(2), 1, null]) {
    t.is(validateRecord({ ...tr, box: bad }, 1), 'malformed', 'box ' + String(bad).slice(0, 8))
  }
  // A non-canonical last character (unused bits set) is refused.
  const odd = b4a.toString(b4a.alloc(199, 7), 'base64')
  const tweak = odd.slice(0, -2) + String.fromCharCode(odd.charCodeAt(odd.length - 2) + 1) + '='
  t.is(validateRecord({ ...tr, box: odd }, 1), null)
  t.is(validateRecord({ ...tr, box: tweak }, 1), 'malformed', 'non-canonical base64')
  t.is(validateRecord({ ...tr, at: '2026-01-01' }, 1), 'date-invalid')
  await t.exception.all(async () => testimonialRecord({ to: K2, gen: 0, hash: 'c'.repeat(64), box, at: AT }), /malformed/)
})

test('testimonial-show records: the recipient copy', async (t) => {
  const { testimonialShowRecord } = records
  const nonce = 'd'.repeat(64)
  const sr = { type: 'testimonial-show', from: K1, seq: 5, text: 'Pessoa incrível.\nObrigado!', nonce, at: AT }
  t.is(validateRecord(sr, 1), null)
  t.alike(testimonialShowRecord({ from: K1, seq: 5, text: sr.text, nonce, at: AT }), sr)
  t.alike(Object.keys(testimonialShowRecord({ from: K1, seq: 1, text: 'oi', nonce })), ['type', 'from', 'seq', 'text', 'nonce', 'at'])
  t.is(validateRecord({ ...sr, extra: 1 }, 1), 'malformed')
  for (const k of ['A'.repeat(64), K1.slice(1), 1, null]) {
    t.is(validateRecord({ ...sr, from: k }, 1), 'malformed', 'from ' + k)
    t.is(validateRecord({ ...sr, nonce: k }, 1), 'malformed', 'nonce ' + k)
  }
  for (const seq of [0, -1, 1.5, '1', null]) t.is(validateRecord({ ...sr, seq }, 1), 'malformed', 'seq ' + seq)
  t.is(validateRecord({ ...sr, text: 'x'.repeat(400) }, 1), null, '400 chars')
  t.is(validateRecord({ ...sr, text: '\u{1F600}'.repeat(400) }, 1), null, '400 non-BMP chars')
  t.is(validateRecord({ ...sr, text: 'x'.repeat(401) }, 1), 'malformed', '401 chars')
  t.is(validateRecord({ ...sr, text: '' }, 1), 'malformed', 'empty')
  const bads = ['a\u0000b', 'a\rb', 'a\u202eb', 'a\u2028b', 'a\u0085b', 'a\ud800b', 'a\udc00', 7]
  for (let i = 0; i < bads.length; i++) t.is(validateRecord({ ...sr, text: bads[i] }, 1), 'malformed', 'bad text #' + i)
  t.is(validateRecord({ ...sr, at: '2026-01-01T00:00:00Z' }, 1), 'date-invalid')
})

test('testimonial records: old readers skip both as malformed', async (t) => {
  // A copy of TYPES before Depoimentos: an old reader skips both records.
  const OLD_TYPES = ['member-cert', 'profile', 'post', 'username', 'media-core', 'follow', 'like', 'repost', 'group-join', 'delete', 'group-cut', 'group-confirm', 'dm-key', 'page-roster', 'page-accept', 'page-offer', 'page-close', 'page-moved', 'page-origin', 'page-delegate', 'page-link']
  const oldReader = (r) => (OLD_TYPES.includes(r.type) ? validateRecord(r, 1) : 'malformed')
  const box = b4a.toString(b4a.alloc(200, 7), 'base64')
  t.is(oldReader({ type: 'testimonial', to: K2, gen: 1, hash: 'c'.repeat(64), box, at: AT }), 'malformed')
  t.is(oldReader({ type: 'testimonial-show', from: K1, seq: 1, text: 'oi', nonce: 'd'.repeat(64), at: AT }), 'malformed')
  // Neither borrows another type's shape.
  t.is(validateRecord({ type: 'testimonial', to: K2, on: true, at: AT }, 1), 'malformed')
  t.is(validateRecord({ type: 'testimonial-show', text: 'oi', at: AT, replyTo: null }, 1), 'malformed')
})

function momentMedia (over = {}) {
  return { id: 'a'.repeat(64), key: 'b'.repeat(64), nonce: 'c'.repeat(48), chunks: 2, bytes: 40000, sha256: 'd'.repeat(64), mime: 'image/jpeg', w: 1080, h: 1350, ms: 0, ...over }
}

test('moment records: one public blob image and short text', async (t) => {
  const { momentRecord, MOMENT_KEYS, MOMENT_MEDIA_KEYS, MAX_MOMENT_TEXT, MEDIA_MIMES } = records
  t.alike(MOMENT_KEYS, ['type', 'text', 'at', 'media'])
  t.alike(MOMENT_MEDIA_KEYS, ['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms'])
  t.is(MAX_MOMENT_TEXT, 200)
  const mr = { type: 'moment', text: 'Pôr do sol 🌅\nna varanda', at: AT, media: momentMedia() }
  t.is(validateRecord(mr, 1), null)
  t.is(validateRecord(mr, 0), 'genesis-required')
  t.is(validateRecord({ ...mr, text: '' }, 1), null, 'photo only')
  t.is(validateRecord({ ...mr, text: '😀'.repeat(200) }, 1), null, '200 code points')
  t.is(validateRecord({ ...mr, text: 'x'.repeat(201) }, 1), 'text-length')
  t.is(validateRecord({ ...mr, text: '😀'.repeat(201) }, 1), 'text-length')
  const bads = ['a\u0000b', 'a\rb', 'a\u202eb', 'a\u2028b', 'a\u0085b', 'a\ud800b', 'a\udc00', 7, null]
  for (let i = 0; i < bads.length; i++) t.is(validateRecord({ ...mr, text: bads[i] }, 1), 'text-length', 'bad text #' + i)
  t.is(validateRecord({ ...mr, at: '2026-01-01T00:00:00Z' }, 1), 'date-invalid')
  // Exact record keys.
  t.is(validateRecord({ ...mr, extra: 1 }, 1), 'malformed')
  t.is(validateRecord({ type: 'moment', text: 'oi', at: AT }, 1), 'malformed', 'media required')
  t.is(validateRecord({ type: 'moment', text: 'oi', at: AT, replyTo: null }, 1), 'malformed')
  // Every chat image mime, never audio.
  for (const mime of MEDIA_MIMES) t.is(validateRecord({ ...mr, media: momentMedia({ mime }) }, 1), null, mime)
  const badMedia = [
    null, [], 'x', [momentMedia()],
    momentMedia({ extra: 1 }),
    { ...momentMedia(), ms: undefined },
    momentMedia({ mime: 'audio/mp4', w: 0, h: 0, ms: 3000 }),
    momentMedia({ mime: 'audio/mp4' }),
    momentMedia({ mime: 'image/svg+xml' }),
    momentMedia({ ms: 1 }),
    momentMedia({ ms: '0' }),
    momentMedia({ w: 0 }),
    momentMedia({ h: 16385 }),
    momentMedia({ w: 1.5 }),
    momentMedia({ nonce: 'c'.repeat(64) }),
    momentMedia({ nonce: 'c'.repeat(47) }),
    momentMedia({ nonce: 'C'.repeat(48) }),
    momentMedia({ id: 'a'.repeat(63) }),
    momentMedia({ key: 'z'.repeat(64) }),
    momentMedia({ sha256: 7 }),
    momentMedia({ chunks: 3 }),
    momentMedia({ chunks: 1 }),
    momentMedia({ bytes: 16, chunks: 1 }),
    momentMedia({ bytes: 258 * 32768, chunks: 258 })
  ]
  const { ms, ...noMs } = momentMedia()
  badMedia.push(noMs)
  for (let i = 0; i < badMedia.length; i++) t.is(validateRecord({ ...mr, media: badMedia[i] }, 1), 'media-invalid', 'bad media #' + i)
  t.is(validateRecord({ ...mr, media: momentMedia({ bytes: 17, chunks: 1 }) }, 1), null, 'smallest blob')
  t.is(validateRecord({ ...mr, media: momentMedia({ bytes: 257 * 32768, chunks: 257 }) }, 1), null, 'largest blob')
  // Builder: exact keys, extra item keys dropped, invalid input throws.
  t.alike(momentRecord({ text: mr.text, media: mr.media, at: AT }), mr)
  t.alike(Object.keys(momentRecord({ media: momentMedia() })), ['type', 'text', 'at', 'media'])
  t.is(momentRecord({ media: momentMedia() }).text, '')
  t.alike(momentRecord({ text: 'oi', media: momentMedia({ extra: 1 }), at: AT }).media, momentMedia())
  const media = momentMedia()
  t.not(momentRecord({ media, at: AT }).media, media, 'the item is copied')
  await t.exception.all(async () => momentRecord({ text: 'oi', at: AT }), /media-invalid/)
  await t.exception.all(async () => momentRecord({ text: 'x'.repeat(201), media, at: AT }), /text-length/)
  await t.exception.all(async () => momentRecord({ media: momentMedia({ mime: 'audio/mp4' }), at: AT }), /media-invalid/)
  // Hostile getters never throw out of validation.
  const hostile = { type: 'moment', text: 'oi', at: AT }
  Object.defineProperty(hostile, 'media', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(hostile, 1), 'malformed')
})

test('moment records: old readers skip it as malformed', async (t) => {
  // A copy of TYPES before Momentos: an old reader skips the record as any
  // unknown type today.
  const OLD_TYPES = ['member-cert', 'profile', 'post', 'username', 'media-core', 'follow', 'like', 'repost', 'group-join', 'delete', 'group-cut', 'group-confirm', 'dm-key', 'page-roster', 'page-accept', 'page-offer', 'page-close', 'page-moved', 'page-origin', 'page-delegate', 'page-link', 'testimonial', 'testimonial-show']
  const oldReader = (r) => (OLD_TYPES.includes(r.type) ? validateRecord(r, 1) : 'malformed')
  const mr = { type: 'moment', text: 'oi', at: AT, media: momentMedia() }
  t.is(oldReader(mr), 'malformed')
  t.is(validateRecord({ ...mr, type: 'momento' }, 1), 'malformed', 'unknown types stay malformed')
  // It does not borrow a post shape.
  t.is(validateRecord({ type: 'moment', text: 'oi', at: AT, replyTo: null }, 1), 'malformed')
  t.is(validateRecord({ type: 'post', text: 'oi', at: AT, replyTo: null, media: [momentMedia()] }, 1), 'media-invalid', 'not a post media descriptor')
})

test('moment records: music is the one other key set', async (t) => {
  const { momentRecord, MOMENT_KEYS, MOMENT_MUSIC_RECORD_KEYS } = records
  t.alike(MOMENT_MUSIC_RECORD_KEYS, ['type', 'text', 'at', 'media', 'music'])
  const music = { p: 'audius', id: 'D7KyD', start: 30 }
  const mr = { type: 'moment', text: 'oi', at: AT, media: momentMedia(), music }
  t.is(validateRecord(mr, 1), null)
  t.is(validateRecord({ ...mr, music: { p: 'audius', id: 'A'.repeat(32), start: 7200 } }, 1), null, 'maximal music')
  t.is(validateRecord({ ...mr, music: { p: 'audius', id: 'a', start: 0 } }, 1), null, 'minimal music')
  t.is(validateRecord({ ...mr, text: '' }, 1), null, 'photo and music only')
  t.is(validateRecord(mr, 0), 'genesis-required')
  const badMusic = [
    null, undefined, 0, 'audius', [], [music], {},
    { p: 'audius', id: 'D7KyD' },
    { p: 'audius', start: 0 },
    { id: 'D7KyD', start: 0 },
    { ...music, title: 'Canção' },
    { ...music, p: 'spotify' },
    { ...music, p: 'Audius' },
    { ...music, id: '' },
    { ...music, id: 'A'.repeat(33) },
    { ...music, id: 'a-b' },
    { ...music, id: 'a b' },
    { ...music, id: 7 },
    { ...music, start: -1 },
    { ...music, start: 7201 },
    { ...music, start: 1.5 },
    { ...music, start: '30' },
    { ...music, start: null }
  ]
  for (let i = 0; i < badMusic.length; i++) t.is(validateRecord({ ...mr, music: badMusic[i] }, 1), 'music-invalid', 'bad music #' + i)
  t.is(validateRecord({ ...mr, extra: 1 }, 1), 'malformed', 'an extra key next to music')
  const { media, ...noMedia } = mr
  t.is(validateRecord(noMedia, 1), 'malformed', 'music never replaces the photo')
  t.is(validateRecord({ ...mr, media: momentMedia({ ms: 1 }) }, 1), 'media-invalid', 'the photo is still checked')
  t.is(validateRecord({ ...mr, text: 'x'.repeat(201) }, 1), 'text-length')
  t.is(validateRecord({ ...mr, at: '2026-01-01T00:00:00Z' }, 1), 'date-invalid')
  // Builder: music only when given and not null, copied with exactly its keys.
  t.alike(momentRecord({ text: 'oi', media: momentMedia(), music, at: AT }), mr)
  t.alike(Object.keys(momentRecord({ media: momentMedia(), music })), MOMENT_MUSIC_RECORD_KEYS)
  t.alike(Object.keys(momentRecord({ media: momentMedia(), music: null })), MOMENT_KEYS, 'null music writes the 4-key record')
  t.alike(Object.keys(momentRecord({ media: momentMedia(), music: undefined })), MOMENT_KEYS)
  t.not(momentRecord({ media: momentMedia(), music, at: AT }).music, music, 'the music is copied')
  t.alike(momentRecord({ media: momentMedia(), music: { ...music, title: 'x' }, at: AT }).music, music, 'extra keys dropped')
  await t.exception.all(async () => momentRecord({ media: momentMedia(), music: { ...music, start: -1 }, at: AT }), /music-invalid/)
  await t.exception.all(async () => momentRecord({ media: momentMedia(), music: 'D7KyD', at: AT }), /music-invalid/)
  await t.exception.all(async () => momentRecord({ media: momentMedia(), music: { p: 'audius', id: 'D7KyD' }, at: AT }), /music-invalid/)
  // A reader from before music in momentos knows only the 4-key set.
  const oldReader = (r) => (hasExact(r, MOMENT_KEYS) ? validateRecord(r, 1) : 'malformed')
  t.is(oldReader(mr), 'malformed', 'an old reader skips a moment with music')
  t.is(oldReader({ type: 'moment', text: 'oi', at: AT, media: momentMedia() }), null, 'and still reads one without')
})

function hasExact (obj, keys) {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

const PLACE = { uf: 'SP', city: 'São Paulo', bairro: 'Pinheiros' }
const LDESC = (start) => ({ core: K1, mime: 'image/webp', start, blocks: 1, bytes: 1000, sha256: 'e'.repeat(64), width: 512, height: 512 })
const listing = (over = {}) => ({ type: 'listing', kind: 'produto', title: 'Bicicleta', text: 'Aro 29', price: 50000, unit: null, cat: 'esporte', place: PLACE, at: AT, ...over })

test('listing records: shape, media, units and kinds', (t) => {
  t.ok(records.TYPES.includes('listing') && records.TYPES.includes('listing-rate'))
  t.is(validateRecord(listing(), 1), null, 'without media')
  t.is(validateRecord(listing({ media: [LDESC(1), LDESC(2)] }), 1), null, 'with media')
  t.is(validateRecord(listing({ media: [LDESC(1), LDESC(2), LDESC(3), LDESC(4), LDESC(5)] }), 1), 'media-invalid', 'a 5th photo')
  t.is(validateRecord(listing({ media: [] }), 1), 'media-invalid')
  t.is(validateRecord(listing({ unit: 'hora' }), 1), 'unit-invalid', 'hora on a produto')
  t.is(validateRecord(listing({ kind: 'servico', unit: 'hora' }), 1), null)
  t.is(validateRecord(listing({ kind: 'procura', price: null }), 1), null, 'procura a combinar')
  t.is(validateRecord(listing({ kind: 'procura', unit: 'hora' }), 1), 'unit-invalid', 'procura with a unit')
  t.is(validateRecord({ ...listing(), extra: 1 }, 1), 'malformed', 'extra key')
  t.is(validateRecord(listing({ at: 'yesterday' }), 1), 'date-invalid')
  t.is(validateRecord(listing(), 0), 'genesis-required')
  const built = records.listingRecord({ kind: 'produto', title: 'Bicicleta', price: 50000, cat: 'esporte', place: { ...PLACE, extra: 1 }, at: AT })
  t.alike(built.place, PLACE, 'builder copies place keys only')
  t.is(built.text, '')
  t.exception.all(() => records.listingRecord({ kind: 'produto', title: 'x', price: 1, unit: 'hora', cat: 'esporte', place: PLACE }), /unit-invalid/)
  t.alike(records.LISTING_KEYS, ['type', 'kind', 'title', 'text', 'price', 'unit', 'cat', 'place', 'at'])
})

test('listing-edit and listing-status records target an earlier block', (t) => {
  const edit = { type: 'listing-edit', seq: 3, title: 'Bike', text: '', price: 40000, unit: null, cat: 'esporte', place: PLACE, at: AT }
  t.is(validateRecord(edit, 4), null)
  t.is(validateRecord(edit, 3), 'target-invalid', 'edit at its own seq')
  t.is(validateRecord({ ...edit, seq: 0 }, 4), 'target-invalid')
  t.is(validateRecord({ ...edit, kind: 'produto' }, 4), 'malformed', 'an edit has no kind')
  t.is(validateRecord({ ...edit, media: [LDESC(1), LDESC(2), LDESC(3), LDESC(4), LDESC(5)] }, 4), 'media-invalid')
  t.alike(records.listingEditRecord({ seq: 3, title: 'Bike', price: 40000, cat: 'esporte', place: PLACE, at: AT }), { ...edit })
  t.exception.all(() => records.listingEditRecord({ seq: 'x', title: 'Bike', price: 1, cat: 'esporte', place: PLACE }), /target-invalid/)

  const status = { type: 'listing-status', seq: 3, status: 'vendido', at: AT }
  t.is(validateRecord(status, 4), null)
  t.is(validateRecord(status, 3), 'target-invalid', 'status at its own seq')
  t.is(validateRecord({ ...status, status: 'perdido' }, 4), 'status-invalid')
  t.is(validateRecord({ ...status, extra: 1 }, 4), 'malformed')
  t.alike(records.listingStatusRecord({ seq: 3, status: 'reservado', at: AT }), { ...status, status: 'reservado' })
  t.exception.all(() => records.listingStatusRecord({ seq: 3, status: 'x' }), /status-invalid/)
})

test('listing-rate records round-trip', (t) => {
  const rate = records.listingRateRecord({ to: { author: K2, seq: 5, x: 1 }, offer: 'f'.repeat(32), consent: 'c'.repeat(128), stars: 5, text: 'Ótimo', at: AT })
  t.alike(rate, { type: 'listing-rate', to: { author: K2, seq: 5 }, offer: 'f'.repeat(32), consent: 'c'.repeat(128), stars: 5, text: 'Ótimo', at: AT })
  t.alike(decodeBlock(b4a.from(JSON.stringify(rate))), rate)
  t.is(validateRecord(rate, 1), null)
  t.is(validateRecord({ ...rate, stars: 0 }, 1), 'stars-invalid')
  t.is(validateRecord({ ...rate, to: { author: K2, seq: 0 } }, 1), 'target-invalid')
  t.is(validateRecord({ ...rate, offer: 'f'.repeat(31) }, 1), 'malformed')
  t.is(validateRecord({ ...rate, consent: 'C'.repeat(128) }, 1), 'malformed')
  t.exception.all(() => records.listingRateRecord({ to: { author: K2, seq: 5 }, offer: 'f'.repeat(32), consent: 'c'.repeat(128), stars: 0 }), /stars-invalid/)
})

test('listing types leave posts and deletes unchanged', (t) => {
  t.is(validateRecord({ type: 'post', text: 'oi', at: AT, replyTo: null }, 1), null)
  t.is(validateRecord({ type: 'post', text: 'oi', at: AT, replyTo: null, kind: 'produto' }, 1), 'malformed')
  const ranges = [1, 2, 3, 4, 5].map((start) => ({ core: K1, start, blocks: 1 }))
  t.is(validateRecord({ type: 'delete', seq: 1, at: AT, media: ranges }, 2), 'media-invalid', 'a 5-range delete')
  t.is(validateRecord({ type: 'delete', seq: 1, at: AT, media: ranges.slice(0, 4) }, 2), null)
})

test('listing builders treat media null or empty as no photos', (t) => {
  const fields = { title: 'Mesa', price: 100, cat: 'moveis', place: PLACE, at: AT }
  t.absent('media' in records.listingEditRecord({ seq: 2, ...fields, media: null }))
  t.absent('media' in records.listingEditRecord({ seq: 2, ...fields, media: [] }))
  t.absent('media' in records.listingRecord({ kind: 'produto', ...fields, media: null }))
  t.is(validateRecord({ type: 'listing-edit', seq: 2, text: '', unit: null, ...fields, media: null }, 3), 'media-invalid', 'a null on the wire stays invalid')
})

const VDESC = { core: K2, mime: 'video/mp4', start: 3, blocks: 4, bytes: 100000, sha256: 'e'.repeat(64), width: 1080, height: 1920, ms: 15000 }
const VPAIR = [DESC, VDESC]

test('video constants', (t) => {
  t.is(records.VIDEO_MIME, 'video/mp4')
  t.is(records.MAX_VIDEO_MS, 30000)
  t.is(records.MAX_VIDEO_DIMENSION, 1920)
  t.is(records.MAX_VIDEO_PIXELS, 2073600)
  t.is(records.MAX_MOMENT_VIDEO_MS, 15000)
  t.is(records.MAX_MOMENT_VIDEO_BYTES, 4194304)
  t.alike([...records.VIDEO_DESCRIPTOR_KEYS], ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height', 'ms'])
  t.ok(Object.isFrozen(records.VIDEO_DESCRIPTOR_KEYS))
  t.absent(MEDIA_MIMES.includes('video/mp4'), 'still images only')
})

test('validateRecord: a video post is exactly [JPEG poster, video]', (t) => {
  const shapes = {
    post: { type: 'post', text: '', at: AT, replyTo: null },
    reply: { type: 'post', text: '', at: AT, replyTo: { author: K1, seq: 2 } },
    quote: { type: 'post', text: 'oi', at: AT, replyTo: null, quote: { author: K1, seq: 2 } }
  }
  for (const [name, rec] of Object.entries(shapes)) {
    t.is(validateRecord({ ...rec, media: VPAIR }, 3), null, name + ' with a video')
  }
  t.is(validateRecord({ ...shapes.quote, text: '', media: VPAIR }, 3), 'text-length', 'a video quote still needs text')
  const post = (media) => ({ ...shapes.post, media })
  for (const video of [
    { ...VDESC, ms: 1 },
    { ...VDESC, ms: 30000 },
    { ...VDESC, width: 1920, height: 1080 },
    { ...VDESC, width: 1, height: 1 },
    { ...VDESC, start: MAX_MEDIA_BLOCKS - MAX_MEDIA_ITEM_BLOCKS, blocks: MAX_MEDIA_ITEM_BLOCKS, bytes: MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES },
    { ...VDESC, blocks: 1, bytes: 1 }
  ]) t.is(validateRecord(post([DESC, video]), 1), null, 'valid ' + JSON.stringify(video))
  const { ms, ...noMs } = VDESC
  const holed = [DESC, VDESC]
  delete holed[0]
  const hostile = { ...VDESC }
  Object.defineProperty(hostile, 'ms', { enumerable: true, get () { throw new Error('boom') } })
  const hostilePoster = { ...DESC }
  Object.defineProperty(hostilePoster, 'mime', { enumerable: true, get () { throw new Error('boom') } })
  const bad = {
    reversed: [VDESC, DESC],
    'video alone': [VDESC],
    'video plus photos': [DESC, VDESC, DESC],
    'photos then video': [DESC, DESC, VDESC],
    'two videos': [VDESC, VDESC],
    'png poster': [{ ...DESC, mime: 'image/png' }, VDESC],
    'poster with ms': [{ ...DESC, ms: 1 }, VDESC],
    'ms 0': [DESC, { ...VDESC, ms: 0 }],
    'ms 30001': [DESC, { ...VDESC, ms: 30001 }],
    'ms 1.5': [DESC, { ...VDESC, ms: 1.5 }],
    'ms string': [DESC, { ...VDESC, ms: '1000' }],
    'width 1921': [DESC, { ...VDESC, width: 1921, height: 1 }],
    'height 1921': [DESC, { ...VDESC, width: 1, height: 1921 }],
    '1920x1920': [DESC, { ...VDESC, width: 1920, height: 1920 }],
    'width 0': [DESC, { ...VDESC, width: 0 }],
    'extra key': [DESC, { ...VDESC, extra: 1 }],
    'no ms': [DESC, noMs],
    'webm video': [DESC, { ...VDESC, mime: 'video/webm' }],
    'audio second': [DESC, { ...VDESC, mime: 'audio/mp4', width: 0, height: 0 }],
    'bytes over blocks': [DESC, { ...VDESC, bytes: 4 * MEDIA_BLOCK_BYTES + 1 }],
    '257 blocks': [DESC, { ...VDESC, start: 1, blocks: 257, bytes: 257 * MEDIA_BLOCK_BYTES }],
    'past the core': [DESC, { ...VDESC, start: MAX_MEDIA_BLOCKS - 1, blocks: 2 }],
    'upper-case core': [DESC, { ...VDESC, core: K2.toUpperCase() }],
    sparse: holed,
    'sparse of two': new Array(2),
    'getter-throwing video': [DESC, hostile],
    'getter-throwing poster': [hostilePoster, VDESC]
  }
  for (const [name, media] of Object.entries(bad)) {
    t.is(validateRecord(post(media), 1), 'media-invalid', name)
    t.is(records.validRecordCopy(post(media), 1), null, name + ' copy')
  }
  // Only the pair takes a video: every other descriptor stays a still image.
  t.absent(records.validDescriptor(VDESC), 'validDescriptor refuses a video')
  t.absent(records.validDescriptor(noMs), 'even without ms')
  t.ok(records.validVideoDescriptor(VDESC))
  t.absent(records.validVideoDescriptor(DESC))
  t.ok(records.validPostMedia(VPAIR))
  for (const v of [null, undefined, 'x', {}, VDESC, [DESC]]) t.absent(records.validPostMedia(v))
  t.absent(records.validAvatar(VDESC), 'not an avatar')
  t.absent(records.validPreviewImage(VDESC), 'not a preview thumbnail')
  t.is(validateRecord({ ...shapes.post, text: 'oi', preview: { url: 'https://example.com/a', host: 'example.com', title: 'T', desc: '', image: VDESC } }, 1), 'preview-invalid')
  const listing = { type: 'listing', kind: 'produto', title: 'Bicicleta', text: 'Aro 29', price: 50000, unit: null, cat: 'esporte', place: { uf: 'SP', city: 'São Paulo', bairro: 'Pinheiros' }, at: AT }
  t.is(validateRecord(listing, 1), null, 'the listing fixture is valid')
  t.is(validateRecord({ ...listing, media: VPAIR }, 1), 'media-invalid', 'the pair in a listing')
  t.is(validateRecord({ type: 'profile', name: 'Ana', bio: '', at: AT, avatar: VDESC }, 1), 'media-invalid', 'not an avatar record')
  // The existing photo refusal of a video mime stands.
  t.is(validateRecord(post([{ ...DESC, mime: 'video/mp4' }]), 1), 'media-invalid')
  // The worst video quote fits one block.
  const worst = { ...shapes.quote, text: '\ud800'.repeat(MAX_TEXT), at: new Date(8.64e15).toISOString(), quote: { author: K1, seq: Number.MAX_SAFE_INTEGER }, media: [WIDEST, { ...WIDEST, mime: 'video/mp4', width: 1920, height: 1080, ms: 30000 }] }
  t.is(validateRecord(worst, 3), null)
  t.ok(b4a.byteLength(JSON.stringify(worst)) <= MAX_BLOCK_BYTES)
})

test('postRecord with a video keeps ms on the video only', async (t) => {
  const rec = postRecord({ text: '', at: AT, media: [{ ...DESC, extra: 1, ms: 5 }, { ...VDESC, extra: 1 }] })
  t.alike(rec.media, VPAIR, 'extra keys dropped, ms kept on the video')
  t.alike(Object.keys(rec.media[0]), ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height'])
  t.alike(Object.keys(rec.media[1]), ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height', 'ms'])
  t.ok(rec.media[1] !== VDESC, 'a copy')
  t.alike(postRecord({ text: 'oi', at: AT, quote: { author: K1, seq: 2 }, media: VPAIR }).media, VPAIR)
  t.alike(postRecord({ text: '', at: AT, replyTo: { author: K1, seq: 2 }, media: VPAIR }).media, VPAIR)
  t.alike(records.validRecordCopy(rec, 1).media, VPAIR)
  await t.exception.all(async () => postRecord({ text: '', at: AT, media: [VDESC, DESC] }), /media-invalid/)
  await t.exception.all(async () => postRecord({ text: '', at: AT, media: [DESC, { ...VDESC, ms: 30001 }] }), /media-invalid/)
})

function momentVideo (over = {}) {
  return momentMedia({ mime: 'video/mp4', w: 1080, h: 1920, ms: 15000, bytes: 4194304 + 16, chunks: 129, ...over })
}

test('moment records: a short video', async (t) => {
  const { momentRecord } = records
  const mr = { type: 'moment', text: '', at: AT, media: momentVideo() }
  t.is(validateRecord(mr, 1), null, '4 MiB plus the MAC')
  for (const media of [
    momentVideo({ ms: 1 }),
    momentVideo({ w: 1920, h: 1080 }),
    momentVideo({ w: 1, h: 1 }),
    momentVideo({ bytes: 17, chunks: 1 })
  ]) t.is(validateRecord({ ...mr, media }, 1), null, 'valid ' + JSON.stringify(media))
  const bad = {
    'one byte over': momentVideo({ bytes: 4194304 + 17 }),
    'one chunk over': momentVideo({ bytes: 130 * 32768, chunks: 130 }),
    'ms 15001': momentVideo({ ms: 15001 }),
    'ms 0': momentVideo({ ms: 0 }),
    'ms 1.5': momentVideo({ ms: 1.5 }),
    'w 1921': momentVideo({ w: 1921, h: 1 }),
    '1920x1920': momentVideo({ w: 1920, h: 1920 }),
    'h 0': momentVideo({ h: 0 }),
    'chunks mismatch': momentVideo({ chunks: 128 }),
    'extra key': momentVideo({ extra: 1 }),
    webm: momentVideo({ mime: 'video/webm' })
  }
  for (const [name, media] of Object.entries(bad)) t.is(validateRecord({ ...mr, media }, 1), 'media-invalid', name)
  // A photo momento is unchanged: an image with ms stays refused.
  t.is(validateRecord({ ...mr, media: momentMedia({ ms: 1000 }) }, 1), 'media-invalid')
  t.is(validateRecord({ ...mr, media: momentMedia({ bytes: 257 * 32768, chunks: 257 }) }, 1), null, 'a photo keeps the whole blob cap')
  t.is(JSON.stringify(momentRecord({ text: 'oi', media: momentMedia(), at: AT })),
    '{"type":"moment","text":"oi","at":"2026-01-01T00:00:00.000Z","media":{"id":"' + 'a'.repeat(64) + '","key":"' + 'b'.repeat(64) + '","nonce":"' + 'c'.repeat(48) + '","chunks":2,"bytes":40000,"sha256":"' + 'd'.repeat(64) + '","mime":"image/jpeg","w":1080,"h":1350,"ms":0}}',
    'a photo momento is byte-identical')
  t.alike(momentRecord({ media: { ...momentVideo(), extra: 1 }, at: AT }).media, momentVideo(), 'the builder keeps ms')
  await t.exception.all(async () => momentRecord({ media: momentVideo({ ms: 15001 }), at: AT }), /media-invalid/)
  const hostile = { ...momentVideo() }
  Object.defineProperty(hostile, 'ms', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord({ ...mr, media: hostile }, 1), 'malformed', 'a throwing getter is caught')
})

test('video rules match @varanda/rpc (parity)', (t) => {
  const rpc = require('@varanda/rpc')
  for (const name of ['VIDEO_MIME', 'MAX_VIDEO_MS', 'MAX_VIDEO_DIMENSION', 'MAX_VIDEO_PIXELS', 'MAX_MOMENT_VIDEO_MS', 'MAX_MOMENT_VIDEO_BYTES']) {
    t.is(rpc[name], records[name], name)
  }
  const posts = [
    VPAIR, [VDESC, DESC], [VDESC], [DESC, VDESC, DESC], [VDESC, VDESC], [{ ...DESC, mime: 'image/png' }, VDESC],
    [DESC, { ...VDESC, ms: 0 }], [DESC, { ...VDESC, ms: 30000 }], [DESC, { ...VDESC, ms: 30001 }],
    [DESC, { ...VDESC, width: 1920, height: 1080 }], [DESC, { ...VDESC, width: 1921, height: 1 }],
    [DESC, { ...VDESC, width: 1920, height: 1920 }], [DESC, { ...VDESC, extra: 1 }], [DESC, { ...VDESC, mime: 'video/webm' }],
    [DESC, { ...VDESC, blocks: 1, bytes: 1 }], [DESC, { ...VDESC, bytes: 4 * MEDIA_BLOCK_BYTES + 1 }],
    [DESC], [DESC, DESC], [{ ...DESC, mime: 'video/mp4' }]
  ]
  for (const media of posts) {
    const core = validateRecord({ type: 'post', text: 'oi', at: AT, replyTo: null, media }, 1) === null
    t.is(rpc.validateParams('post.create', { text: 'oi', media }).ok, core, 'post ' + JSON.stringify(media))
    t.is(rpc.validateParams('post.quote', { to: K1 + ':1', text: 'oi', media }).ok, core, 'quote ' + JSON.stringify(media))
  }
  const moments = [
    momentVideo(), momentVideo({ bytes: 4194304 + 17 }), momentVideo({ ms: 15000 }), momentVideo({ ms: 15001 }),
    momentVideo({ ms: 0 }), momentVideo({ w: 1920, h: 1080 }), momentVideo({ w: 1920, h: 1920 }), momentVideo({ w: 1921, h: 1 }),
    momentVideo({ bytes: 17, chunks: 1 }), momentVideo({ bytes: 16, chunks: 1 }), momentVideo({ chunks: 128 }),
    momentMedia(), momentMedia({ ms: 1000 }), momentMedia({ bytes: 257 * 32768, chunks: 257 }), momentMedia({ mime: 'audio/mp4', w: 0, h: 0, ms: 1000 })
  ]
  for (const media of moments) {
    const core = validateRecord({ type: 'moment', text: '', at: AT, media }, 1) === null
    t.is(rpc.validateParams('moment.create', { text: '', media }).ok, core, 'moment ' + JSON.stringify(media))
  }
})
