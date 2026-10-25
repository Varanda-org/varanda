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
  REASONS,
  REASON_LABELS,
  TEXT_MAX,
  QUOTE_MAX,
  SEQ_MAX,
  NONCE_RE,
  isCleanText,
  digest,
  reportPayload,
  signReport,
  verifyReport
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
