'use strict'

// lib/report.js: the exact bytes (golden vectors for a post report and an
// account report), that every field is bound by the signature, domain
// separation from the other signed statements, shape checks, and that the
// module stays pure (no fs, no network).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PREFIX,
  PREFIX_V2,
  PREFIX_V3,
  PREFIX_DM,
  PREFIX_DM_V2,
  REASONS,
  REASON_LABELS,
  TEXT_MAX,
  QUOTE_MAX,
  SEQ_MAX,
  NONCE_RE,
  isCleanText,
  digest,
  isGroupReport,
  reportPayload,
  signReport,
  verifyReport,
  dmReportPayload,
  signDmReport,
  verifyDmReport
} = require('../lib/report')
const { MAX_TEXT, MAX_LOG_BLOCKS } = require('../lib/records')
const { signAccountLink } = require('../lib/account-link')
const cert = require('../lib/cert')

const coreRoot = path.join(__dirname, '..')

// Fixed keys: the reporter pair from a seed of 32 bytes 0x11.
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 0x11))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const TARGET = 'ef'.repeat(32)
const NONCE = 'R'.repeat(43)

const POST = {
  nonce: NONCE,
  member: MEMBER,
  association: ASSOCIATION,
  target: TARGET,
  seq: 7,
  reason: 'assedio',
  text: 'ofensivo',
  quote: 'linha 1\nlinha 2'
}
const ACCOUNT = { ...POST, seq: null, reason: 'spam', text: '', quote: '' }
const WRITER = 'a1'.repeat(32)
const GROUP = 'b2'.repeat(32)
const GROUP_POST = { ...POST, writer: WRITER, group: GROUP }
const DM = {
  nonce: NONCE,
  member: MEMBER,
  association: ASSOCIATION,
  target: TARGET,
  reason: 'assedio',
  text: 'ofensivo',
  quote: 'linha 1\nlinha 2'
}

// Bidi controls, built from their code points so no raw one sits in source.
const RLO = String.fromCodePoint(0x202e)
const LRI = String.fromCodePoint(0x2066)

const EMPTY_DIGEST = '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8'

test('constants', (t) => {
  t.is(PREFIX, 'varanda-report-v1')
  t.alike([...REASONS], ['spam', 'assedio', 'ilegal', 'outro'])
  t.ok(Object.isFrozen(REASONS))
  t.alike({ ...REASON_LABELS }, { spam: 'spam', assedio: 'assédio', ilegal: 'conteúdo ilegal', outro: 'outro' })
  t.is(TEXT_MAX, 280)
  t.is(QUOTE_MAX, MAX_TEXT)
  t.is(QUOTE_MAX, 1000)
  t.is(SEQ_MAX, MAX_LOG_BLOCKS - 1)
  t.is(SEQ_MAX, 99999)
  t.ok(NONCE_RE.test('A-_9'.repeat(32)))
  t.absent(NONCE_RE.test('a'.repeat(42)))
  t.absent(NONCE_RE.test('a'.repeat(129)))
})

test('isCleanText and digest', (t) => {
  t.ok(isCleanText('olá 😀', false))
  t.ok(isCleanText('', false))
  t.absent(isCleanText('a\nb', false))
  t.ok(isCleanText('a\nb', true))
  const unsafe = ['\t', '\r', '\x00', '\x7f', '\x85'].concat([0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069].map((cp) => String.fromCodePoint(cp)))
  for (const ch of unsafe) {
    t.absent(isCleanText('a' + ch, true), 'unsafe U+' + ch.codePointAt(0).toString(16))
  }
  t.absent(isCleanText(1, true))
  t.is(digest(''), EMPTY_DIGEST, 'BLAKE2b-256 of the empty string')
  t.is(digest('ofensivo'), '45ba497256f581d6f28f95238271f89c269453a8a531ee4bbf398b73ccfc080c')
  t.is(digest('é'), b4a.toString(crypto.hash(b4a.from('é', 'utf8')), 'hex'), 'over the UTF-8 bytes')
})

test('golden vector: a post report, exact bytes and signature', (t) => {
  t.is(MEMBER, 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737')
  const payload = reportPayload(POST)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-report-v1',
    NONCE,
    MEMBER,
    ASSOCIATION,
    TARGET,
    '7',
    'assedio',
    '45ba497256f581d6f28f95238271f89c269453a8a531ee4bbf398b73ccfc080c',
    '0191749cdb277fcfe427ca55cab5e31636b26d76b6b8f4966e145dbb2eeacb81'
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  t.is(b4a.toString(payload).split('\n').length, 9, 'the LF inside the quote stays out of the framing')
  const signature = signReport(POST, MEMBER_KP)
  t.is(signature, '23b3a0468eb469a74a7ef9cfbc96bb682fb5cb1262c61393d60fb65ebead5377133afa5ef4c9f99edc6115513ae827df14f567a237ee0ba60a3a256e11def009')
  t.alike(verifyReport(POST, signature), { ok: true })
})

test('golden vector: an account report, exact bytes and signature', (t) => {
  const payload = reportPayload(ACCOUNT)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-report-v1',
    NONCE,
    MEMBER,
    ASSOCIATION,
    TARGET,
    '',
    'spam',
    EMPTY_DIGEST,
    EMPTY_DIGEST
  ].join('\n'))
  const signature = signReport(ACCOUNT, MEMBER_KP)
  t.is(signature, '743d27de6c9d8aa45422b9ec0efdceca3d499c6733552a9960016db155927bddbf2666b9013d0f88ea371cab39c71c31f9e1bd4415464ec51f80fbd9d825ec07')
  t.alike(verifyReport(ACCOUNT, signature), { ok: true })
  t.alike(verifyReport({ ...ACCOUNT, seq: 1 }, signature), { ok: false, reason: 'bad-signature' }, 'an account report is not a report of seq 1')
})

test('golden vector: a group message report (v2), exact bytes and signature', (t) => {
  t.is(PREFIX_V2, 'varanda-report-v2')
  t.ok(isGroupReport(GROUP_POST))
  t.absent(isGroupReport(POST))
  t.absent(isGroupReport({ ...POST, writer: null, group: null }))
  const payload = reportPayload(GROUP_POST)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-report-v2',
    NONCE,
    MEMBER,
    ASSOCIATION,
    TARGET,
    GROUP,
    WRITER,
    '7',
    'assedio',
    '45ba497256f581d6f28f95238271f89c269453a8a531ee4bbf398b73ccfc080c',
    '0191749cdb277fcfe427ca55cab5e31636b26d76b6b8f4966e145dbb2eeacb81'
  ].join('\n'))
  const signature = signReport(GROUP_POST, MEMBER_KP)
  t.is(signature, 'c9cfc5207c822b8c1803680cc24f70b83d016d599ae5a7733a9518a41b2da7cf7feb5bbc03a520b57863438e904dc793490302fd446a8ac28aa8fdf0abf3c60a')
  t.alike(verifyReport(GROUP_POST, signature), { ok: true })
  t.alike(reportPayload({ ...POST, writer: null, group: null }), reportPayload(POST), 'null writer and group keep the v1 bytes')
})

test('v1 and v2 signatures never cross', (t) => {
  const v1 = signReport(POST, MEMBER_KP)
  const v2 = signReport(GROUP_POST, MEMBER_KP)
  t.alike(verifyReport(GROUP_POST, v1), { ok: false, reason: 'bad-signature' }, 'a diary post report is not a group report')
  t.alike(verifyReport(POST, v2), { ok: false, reason: 'bad-signature' }, 'a group report is not a diary post report')
  const changes = {
    writer: { writer: 'a3'.repeat(32) },
    group: { group: 'b4'.repeat(32) },
    'writer and group swapped': { writer: GROUP, group: WRITER },
    seq: { seq: 8 },
    target: { target: '12'.repeat(32) }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyReport({ ...GROUP_POST, ...change }, v2), { ok: false, reason: 'bad-signature' }, name)
  }
  const bad = {
    'writer without seq': { ...GROUP_POST, seq: null, quote: '' },
    'writer without group': { ...POST, writer: WRITER },
    'group without writer': { ...POST, group: GROUP },
    'uppercase writer': { ...GROUP_POST, writer: WRITER.toUpperCase() },
    'short group': { ...GROUP_POST, group: 'ab'.repeat(31) },
    'writer not a string': { ...GROUP_POST, writer: 1 }
  }
  for (const [label, fields] of Object.entries(bad)) {
    t.exception.all(() => reportPayload(fields), TypeError, label)
    t.alike(verifyReport(fields, v2), { ok: false, reason: 'malformed' }, label)
  }
})

test('every field is bound by the signature', (t) => {
  const signature = signReport(POST, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    nonce: { nonce: 'S'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    association: { association: 'ab'.repeat(32) },
    target: { target: '12'.repeat(32) },
    seq: { seq: 8 },
    'seq 70': { seq: 70 },
    reason: { reason: 'spam' },
    text: { text: 'ofensiva' },
    'text empty': { text: '' },
    quote: { quote: 'linha 1\nlinha 3' },
    'quote empty': { quote: '' },
    'account report': { seq: null, quote: '' }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyReport({ ...POST, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  t.alike(verifyReport(POST, signReport(POST, other)), { ok: false, reason: 'bad-signature' }, 'signed by another key')
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifyReport(POST, flipped), { ok: false, reason: 'bad-signature' })
})

test('other statements signed by the member key are not reports', (t) => {
  const date = '2026-10-24T12:00:00.000Z'
  const link = signAccountLink({ phase: 'reserve', nonce: NONCE, member: MEMBER, username: 'ana_1', association: ASSOCIATION, sub: '' }, MEMBER_KP)
  const v1 = cert.certPayload({ member: MEMBER, ageBand: '18+', method: 'stub', date, association: ASSOCIATION })
  t.ok(b4a.toString(v1).startsWith('varanda-cert-v1\n'))
  // The moderation request (lib/mod-request.js) under its own prefix, with
  // the report's own fields after it: still not a report.
  const modRequest = b4a.concat([b4a.from('varanda-mod-request-v1\n'), reportPayload(POST).subarray(PREFIX.length + 1)])
  const reportBytes = reportPayload(POST)
  t.ok(b4a.toString(modRequest).startsWith('varanda-mod-request-v1\n'))
  const signatures = {
    'account link': link,
    'v1 cert': b4a.toString(crypto.sign(v1, MEMBER_KP.secretKey), 'hex'),
    'mod request': b4a.toString(crypto.sign(modRequest, MEMBER_KP.secretKey), 'hex')
  }
  for (const [label, signature] of Object.entries(signatures)) {
    for (const fields of [POST, ACCOUNT]) {
      t.alike(verifyReport(fields, signature), { ok: false, reason: 'bad-signature' }, label + (fields.seq === null ? ' as account report' : ' as post report'))
    }
  }
  // And the other way round: a report signature is none of them.
  const report = b4a.from(signReport(POST, MEMBER_KP), 'hex')
  t.absent(crypto.verify(v1, report, MEMBER_KP.publicKey))
  t.absent(crypto.verify(modRequest, report, MEMBER_KP.publicKey))
  t.ok(crypto.verify(reportBytes, report, MEMBER_KP.publicKey))
})

test('shape: payload throws TypeError, verify answers malformed', (t) => {
  const bad = {
    null: null,
    array: [],
    string: 'x',
    'member is target': { ...POST, target: MEMBER },
    'text of 281 code points': { ...POST, text: '😀'.repeat(281) },
    'quote of 1001 code points': { ...POST, quote: 'x'.repeat(1001) },
    'quote with seq null': { ...POST, seq: null },
    'seq 0': { ...POST, seq: 0 },
    'seq 100000': { ...POST, seq: 100000 },
    'seq 1.5': { ...POST, seq: 1.5 },
    'seq string': { ...POST, seq: '7' },
    'seq undefined': { ...POST, seq: undefined },
    'bidi control in text': { ...POST, text: 'a' + RLO + 'b' },
    'LF in text': { ...POST, text: 'a\nb' },
    'CR in quote': { ...POST, quote: 'a\rb' },
    'bidi control in quote': { ...POST, quote: 'a' + LRI + 'b' },
    'lone surrogate in text': { ...POST, text: '\ud800' },
    'lone low surrogate in text': { ...POST, text: 'a\udc00' },
    'lone surrogate in quote': { ...POST, quote: 'x\ud801' },
    'uppercase member': { ...POST, member: MEMBER.toUpperCase() },
    'uppercase target': { ...POST, target: TARGET.toUpperCase() },
    'uppercase association': { ...POST, association: ASSOCIATION.toUpperCase() },
    'short key': { ...POST, target: 'ab'.repeat(31) },
    'reason with a space': { ...POST, reason: 'spam ' },
    'reason label': { ...POST, reason: 'assédio' },
    'reason unknown': { ...POST, reason: 'other' },
    'short nonce': { ...POST, nonce: 'a'.repeat(42) },
    'nonce with padding': { ...POST, nonce: 'a'.repeat(42) + '=' },
    'text not a string': { ...POST, text: null },
    'quote not a string': { ...POST, quote: undefined }
  }
  const signature = signReport(POST, MEMBER_KP)
  for (const [label, fields] of Object.entries(bad)) {
    t.exception.all(() => reportPayload(fields), TypeError, label)
    t.alike(verifyReport(fields, signature), { ok: false, reason: 'malformed' }, label)
  }
  // The edges that are valid.
  for (const fields of [
    { ...POST, text: '😀'.repeat(280) },
    { ...POST, quote: '😀'.repeat(1000) },
    { ...POST, seq: 1 },
    { ...POST, seq: 99999 },
    { ...POST, seq: 3, quote: '' },
    { ...POST, quote: '\ud800'.toWellFormed() }
  ]) {
    t.ok(verifyReport(fields, signReport(fields, MEMBER_KP)).ok)
  }
  t.exception.all(() => signReport(POST, null), TypeError)
  t.exception.all(() => signReport(POST, { secretKey: b4a.alloc(32) }), TypeError)
})

test('a post holding a lone surrogate can be reported through its well-formed quote', (t) => {
  const postText = 'antes \ud800 depois'
  const quote = postText.toWellFormed()
  t.is(quote, 'antes ' + String.fromCodePoint(0xfffd) + ' depois')
  const fields = { ...POST, quote }
  t.alike(verifyReport(fields, signReport(fields, MEMBER_KP)), { ok: true })
  t.exception.all(() => reportPayload({ ...POST, quote: postText }), TypeError, 'the raw post text is refused')
})

test('golden vector: a private message report (dm v1), exact bytes and signature', (t) => {
  t.is(PREFIX_DM, 'varanda-dm-report-v1')
  const payload = dmReportPayload(DM)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-dm-report-v1',
    NONCE,
    MEMBER,
    ASSOCIATION,
    TARGET,
    'assedio',
    '45ba497256f581d6f28f95238271f89c269453a8a531ee4bbf398b73ccfc080c',
    '0191749cdb277fcfe427ca55cab5e31636b26d76b6b8f4966e145dbb2eeacb81'
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  t.is(b4a.toString(payload).split('\n').length, 8, 'the LF inside the quote stays out of the framing')
  const signature = signDmReport(DM, MEMBER_KP)
  t.is(signature, '801be1bfe236f9d251b827fa403572558cb4f73ed982978c867b23e1fdece04645f913be324f2c025a9ba8192a82c39080d7094fd4b295a234646c9d1e61b908')
  t.alike(verifyDmReport(DM, signature), { ok: true })
})

test('dm report: every field is bound by the signature', (t) => {
  const signature = signDmReport(DM, MEMBER_KP)
  const other = crypto.keyPair()
  const changes = {
    nonce: { nonce: 'S'.repeat(43) },
    member: { member: b4a.toString(other.publicKey, 'hex') },
    association: { association: 'ab'.repeat(32) },
    target: { target: '12'.repeat(32) },
    reason: { reason: 'spam' },
    text: { text: 'ofensiva' },
    'text empty': { text: '' },
    quote: { quote: 'linha 1\nlinha 3' }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyDmReport({ ...DM, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  t.alike(verifyDmReport(DM, signDmReport(DM, other)), { ok: false, reason: 'bad-signature' }, 'signed by another key')
})

test('dm, v1 and v2 report signatures never cross', (t) => {
  // The same nonce and body under each prefix.
  const post = { ...DM, seq: 7 }
  const group = { ...post, writer: WRITER, group: GROUP }
  const dm = signDmReport(DM, MEMBER_KP)
  const v1 = signReport(post, MEMBER_KP)
  const v2 = signReport(group, MEMBER_KP)
  t.alike(verifyDmReport(DM, v1), { ok: false, reason: 'bad-signature' }, 'a v1 report is not a dm report')
  t.alike(verifyDmReport(DM, v2), { ok: false, reason: 'bad-signature' }, 'a v2 report is not a dm report')
  t.alike(verifyReport(post, dm), { ok: false, reason: 'bad-signature' }, 'a dm report is not a v1 report')
  t.alike(verifyReport(group, dm), { ok: false, reason: 'bad-signature' }, 'a dm report is not a v2 report')
  t.alike(verifyReport(DM, dm), { ok: false, reason: 'malformed' }, 'dm fields are not v1 fields')
  const raw = b4a.from(dm, 'hex')
  t.absent(crypto.verify(reportPayload(post), raw, MEMBER_KP.publicKey))
  t.absent(crypto.verify(reportPayload(group), raw, MEMBER_KP.publicKey))
  t.ok(crypto.verify(dmReportPayload(DM), raw, MEMBER_KP.publicKey))
  const accountLink = signAccountLink({ phase: 'reserve', nonce: NONCE, member: MEMBER, username: 'ana_1', association: ASSOCIATION, sub: '' }, MEMBER_KP)
  t.alike(verifyDmReport(DM, accountLink), { ok: false, reason: 'bad-signature' }, 'an account link is not a dm report')
})

test('dm report shape: payload throws TypeError, verify answers malformed', (t) => {
  const { target, ...noTarget } = DM
  t.is(target, TARGET)
  const bad = {
    null: null,
    array: [],
    'no target': noTarget,
    'target null': { ...DM, target: null },
    'uppercase target': { ...DM, target: TARGET.toUpperCase() },
    'short target': { ...DM, target: 'ab'.repeat(31) },
    'member is target': { ...DM, target: MEMBER },
    'uppercase member': { ...DM, member: MEMBER.toUpperCase() },
    'uppercase association': { ...DM, association: ASSOCIATION.toUpperCase() },
    'short nonce': { ...DM, nonce: 'a'.repeat(42) },
    'reason unknown': { ...DM, reason: 'other' },
    'empty quote': { ...DM, quote: '' },
    'quote missing': { ...DM, quote: undefined },
    'quote of 1001 code points': { ...DM, quote: 'x'.repeat(1001) },
    'CR in quote': { ...DM, quote: 'a\rb' },
    'bidi control in quote': { ...DM, quote: 'a' + LRI + 'b' },
    'lone surrogate in quote': { ...DM, quote: 'x\ud801' },
    'LF in text': { ...DM, text: 'a\nb' },
    'text of 281 code points': { ...DM, text: '😀'.repeat(281) },
    'bidi control in text': { ...DM, text: 'a' + RLO + 'b' },
    'text not a string': { ...DM, text: null },
    'carries seq': { ...DM, seq: 7 },
    'carries seq null': { ...DM, seq: null },
    'carries writer': { ...DM, writer: WRITER },
    'carries group': { ...DM, group: GROUP },
    'carries peer': { ...DM, peer: 'a4'.repeat(32) },
    'carries an undefined writer': { ...DM, writer: undefined }
  }
  const signature = signDmReport(DM, MEMBER_KP)
  for (const [label, fields] of Object.entries(bad)) {
    t.exception.all(() => dmReportPayload(fields), TypeError, label)
    t.alike(verifyDmReport(fields, signature), { ok: false, reason: 'malformed' }, label)
  }
  for (const fields of [
    { ...DM, quote: 'a\nb' },
    { ...DM, quote: 'x' },
    { ...DM, quote: '😀'.repeat(1000) },
    { ...DM, text: '' },
    { ...DM, text: '😀'.repeat(280) }
  ]) {
    t.alike(verifyDmReport(fields, signDmReport(fields, MEMBER_KP)), { ok: true })
  }
  t.exception.all(() => signDmReport(DM, null), TypeError)
  for (const sig of [null, '', signature.toUpperCase(), signature.slice(2), 42]) {
    t.alike(verifyDmReport(DM, sig), { ok: false, reason: 'malformed' }, 'signature ' + typeof sig)
  }
  const hostile = [
    { ...DM, get quote () { throw new Error('boom') } },
    new Proxy({}, { getPrototypeOf () { throw new Error('boom') } }),
    new Proxy({ ...DM }, { ownKeys () { throw new Error('boom') } }),
    Object.create(DM)
  ]
  for (const fields of hostile) {
    t.alike(verifyDmReport(fields, signature), { ok: false, reason: 'malformed' })
  }
})

test('dm report: a hidden extra key or a shifting getter never verifies', (t) => {
  const signature = signDmReport(DM, MEMBER_KP)
  for (const key of ['seq', 'writer', 'group', 'peer']) {
    const fields = { ...DM }
    Object.defineProperty(fields, key, { value: 1, enumerable: false })
    t.alike(verifyDmReport(fields, signature), { ok: false, reason: 'malformed' }, 'non-enumerable ' + key)
    t.exception.all(() => signDmReport(fields, MEMBER_KP), TypeError)
  }
  let reads = 0
  const shifting = { ...DM }
  Object.defineProperty(shifting, 'quote', { enumerable: true, get () { reads++; return DM.quote } })
  t.alike(verifyDmReport(shifting, signature), { ok: false, reason: 'malformed' }, 'an accessor field is refused')
  t.is(reads, 0, 'and never run')
  const inherited = Object.assign(Object.create(null), DM)
  delete inherited.quote
  t.alike(verifyDmReport(inherited, signature), { ok: false, reason: 'malformed' }, 'a missing own field is refused')
})

test('verifyReport never throws on hostile input', (t) => {
  const signature = signReport(POST, MEMBER_KP)
  for (const sig of [null, undefined, '', signature.toUpperCase(), signature.slice(2), signature + '00', 42, {}, [signature]]) {
    t.alike(verifyReport(POST, sig), { ok: false, reason: 'malformed' }, 'signature ' + typeof sig)
  }
  const hostile = [
    { get nonce () { throw new Error('boom') } },
    { ...POST, get quote () { throw new Error('boom') } },
    new Proxy({}, { getPrototypeOf () { throw new Error('boom') } }),
    Object.create(POST),
    { ...POST, text: { toString () { return 'ofensivo' } } },
    { ...POST, seq: 7n },
    { ...POST, seq: Infinity },
    { ...POST, seq: NaN }
  ]
  for (const fields of hostile) {
    t.alike(verifyReport(fields, signature), { ok: false, reason: 'malformed' })
  }
  t.alike(verifyReport(undefined, undefined), { ok: false, reason: 'malformed' })
})

// The SHA-256 of some attachment bytes, as the account service computes it.
const ANEXO = require('node:crypto').createHash('sha256').update(Buffer.from('imagem')).digest('hex')
const DM_V2 = { ...DM, anexo: ANEXO }
const GROUP_V3 = { ...GROUP_POST, anexo: ANEXO }

test('dm report v2 (anexo): exact bytes, nine lines, v1 still verifies', (t) => {
  t.is(PREFIX_DM_V2, 'varanda-dm-report-v2')
  const payload = dmReportPayload(DM_V2)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-dm-report-v2',
    NONCE,
    MEMBER,
    ASSOCIATION,
    TARGET,
    'assedio',
    digest('ofensivo'),
    digest('linha 1\nlinha 2'),
    ANEXO
  ].join('\n'))
  t.is(b4a.toString(payload).split('\n').length, 9)
  const signature = signDmReport(DM_V2, MEMBER_KP)
  t.alike(verifyDmReport(DM_V2, signature), { ok: true })
  // v1 is unchanged: the golden v1 signature still verifies.
  t.alike(verifyDmReport(DM, '801be1bfe236f9d251b827fa403572558cb4f73ed982978c867b23e1fdece04645f913be324f2c025a9ba8192a82c39080d7094fd4b295a234646c9d1e61b908'), { ok: true })
  // A media-only message: v2 may quote nothing, v1 may not.
  const mediaOnly = { ...DM_V2, quote: '' }
  t.alike(verifyDmReport(mediaOnly, signDmReport(mediaOnly, MEMBER_KP)), { ok: true })
  t.exception.all(() => dmReportPayload({ ...DM, quote: '' }), /invalid dm report quote/)
})

test('dm report v2: the anexo is bound, and v1 and v2 never cross', (t) => {
  const v2 = signDmReport(DM_V2, MEMBER_KP)
  const v1 = signDmReport(DM, MEMBER_KP)
  t.alike(verifyDmReport({ ...DM_V2, anexo: 'ab'.repeat(32) }, v2), { ok: false, reason: 'bad-signature' }, 'another anexo')
  t.alike(verifyDmReport(DM, v2), { ok: false, reason: 'bad-signature' }, 'a v2 signature without its anexo')
  t.alike(verifyDmReport(DM_V2, v1), { ok: false, reason: 'bad-signature' }, 'a v1 signature with an anexo added')
  for (const anexo of [undefined, null, '', ANEXO.toUpperCase(), ANEXO.slice(1), ANEXO + '0', 1]) {
    t.alike(verifyDmReport({ ...DM, anexo }, v2), { ok: false, reason: 'malformed' }, 'anexo ' + anexo)
    t.exception.all(() => dmReportPayload({ ...DM, anexo }), TypeError)
  }
  t.alike(verifyDmReport({ ...DM_V2, extra: 1 }, v2), { ok: false, reason: 'malformed' }, 'no extra key beside the anexo')
  t.alike(verifyReport({ ...POST, anexo: ANEXO }, v2), { ok: false, reason: 'malformed' }, 'dm v2 fields are not report fields')
})

test('group report v3 (anexo): exact bytes, v2 still verifies, never crosses', (t) => {
  t.is(PREFIX_V3, 'varanda-report-v3')
  const payload = reportPayload(GROUP_V3)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-report-v3',
    NONCE,
    MEMBER,
    ASSOCIATION,
    TARGET,
    GROUP,
    WRITER,
    '7',
    'assedio',
    digest('ofensivo'),
    digest('linha 1\nlinha 2'),
    ANEXO
  ].join('\n'))
  const v3 = signReport(GROUP_V3, MEMBER_KP)
  const v2 = signReport(GROUP_POST, MEMBER_KP)
  t.alike(verifyReport(GROUP_V3, v3), { ok: true })
  t.alike(verifyReport(GROUP_POST, v2), { ok: true }, 'v2 unchanged')
  t.alike(verifyReport({ ...GROUP_POST, anexo: null }, v2), { ok: true }, 'a null anexo is no anexo')
  t.alike(verifyReport(GROUP_POST, v3), { ok: false, reason: 'bad-signature' })
  t.alike(verifyReport(GROUP_V3, v2), { ok: false, reason: 'bad-signature' })
  t.alike(verifyReport({ ...GROUP_V3, anexo: 'ab'.repeat(32) }, v3), { ok: false, reason: 'bad-signature' })
  t.alike(verifyDmReport(DM_V2, v3), { ok: false, reason: 'bad-signature' })
  // A photo-only group message quotes nothing.
  const photo = { ...GROUP_V3, quote: '' }
  t.alike(verifyReport(photo, signReport(photo, MEMBER_KP)), { ok: true })
  // A diary post or an account report never carries an anexo.
  t.exception.all(() => reportPayload({ ...POST, anexo: ANEXO }), /invalid report anexo/)
  t.exception.all(() => reportPayload({ ...ACCOUNT, anexo: ANEXO }), /invalid report anexo/)
  for (const anexo of ['', ANEXO.toUpperCase(), ANEXO.slice(1), 1]) {
    t.exception.all(() => reportPayload({ ...GROUP_POST, anexo }), /invalid report anexo/, 'anexo ' + anexo)
  }
})

// hypercore-crypto loads sodium-native under Node, whose addon loader
// (require-addon) reads the prebuild with 'fs'; the browser bundle maps it to
// a pure-JS sodium. So the module's OWN requires are pinned, and no network
// module, 'node:fs' or '#fs' is required by anything it pulls in (the rule of
// test/browser-safe.test.js).
test('the module is pure: no fs, no network, no cert.js', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/report.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'report.js')).map(([id]) => id)
  t.alike(own.sort(), ['./records', './safe', 'b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['node:fs', 'net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/mod-request.js', '/lib/account-link.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/', '/corestore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
