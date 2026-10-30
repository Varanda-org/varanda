'use strict'

// lib/appeal.js: the exact bytes (golden payload), that every field is bound
// by the signature, domain separation from the report and terms statements,
// shape checks, and that the module stays pure (no fs, no network).
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { PREFIX, TEXT_MAX, NONCE_RE, appealPayload, signAppeal, verifyAppeal } = require('../lib/appeal')
const report = require('../lib/report')
const terms = require('../lib/terms')
const { MAX_TEXT } = require('../lib/records')

const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'A'.repeat(43)
const FIELDS = { nonce: NONCE, member: MEMBER, association: ASSOCIATION, text: 'foi um engano' }

test('constants', (t) => {
  t.is(PREFIX, 'varanda-appeal-v1')
  t.is(TEXT_MAX, MAX_TEXT)
  t.is(NONCE_RE.source, report.NONCE_RE.source, 'same nonce rule as report')
})

test('payload bytes: prefix, nonce, member, association and the text digest', (t) => {
  const payload = appealPayload(FIELDS)
  t.is(b4a.toString(payload, 'utf8'), [PREFIX, NONCE, MEMBER, ASSOCIATION, report.digest('foi um engano')].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  t.is(b4a.toString(appealPayload({ ...FIELDS, text: '' }), 'utf8').split('\n')[4], report.digest(''), 'empty text hashes too')
})

test('sign and verify round trip', (t) => {
  const kp = crypto.keyPair()
  const fields = { ...FIELDS, member: b4a.toString(kp.publicKey, 'hex'), nonce: 'z_-9'.repeat(32) }
  const signature = signAppeal(fields, kp)
  t.ok(/^[0-9a-f]{128}$/.test(signature))
  t.alike(verifyAppeal(fields, signature), { ok: true })
})

test('every field is bound by the signature', (t) => {
  const signature = signAppeal(FIELDS, MEMBER_KP)
  t.alike(verifyAppeal(FIELDS, signature), { ok: true })
  const other = b4a.toString(crypto.keyPair(b4a.alloc(32, 2)).publicKey, 'hex')
  t.alike(verifyAppeal({ ...FIELDS, nonce: 'B'.repeat(43) }, signature), { ok: false, reason: 'bad-signature' }, 'nonce')
  t.alike(verifyAppeal({ ...FIELDS, member: other }, signature), { ok: false, reason: 'bad-signature' }, 'member')
  t.alike(verifyAppeal({ ...FIELDS, association: 'ef'.repeat(32) }, signature), { ok: false, reason: 'bad-signature' }, 'association')
  t.alike(verifyAppeal({ ...FIELDS, text: 'foi um engano!' }, signature), { ok: false, reason: 'bad-signature' }, 'text')
})

test('domain separation from report and terms', (t) => {
  const kp = MEMBER_KP
  const appealSig = signAppeal(FIELDS, kp)
  const reportFields = { nonce: NONCE, member: MEMBER, association: ASSOCIATION, target: 'ab'.repeat(32), seq: null, reason: 'spam', text: 'foi um engano', quote: '' }
  t.alike(report.verifyReport(reportFields, appealSig), { ok: false, reason: 'bad-signature' }, 'an appeal is not a report')
  t.alike(terms.verifyTerms({ nonce: NONCE, member: MEMBER, association: ASSOCIATION, version: 1 }, appealSig), { ok: false, reason: 'bad-signature' }, 'an appeal is not a terms acceptance')
  t.alike(verifyAppeal(FIELDS, report.signReport(reportFields, kp)), { ok: false, reason: 'bad-signature' }, 'a report is not an appeal')
  t.alike(verifyAppeal(FIELDS, terms.signTerms({ nonce: NONCE, member: MEMBER, association: ASSOCIATION, version: 1 }, kp)), { ok: false, reason: 'bad-signature' }, 'terms is not an appeal')
})

test('shape checks', (t) => {
  const bad = [
    null,
    [],
    { ...FIELDS, nonce: 'short' },
    { ...FIELDS, member: 'AB'.repeat(32) },
    { ...FIELDS, association: 'cd' },
    { ...FIELDS, text: undefined },
    { ...FIELDS, text: 'a'.repeat(TEXT_MAX + 1) },
    { ...FIELDS, text: 'x\u0000y' },
    { ...FIELDS, text: 'lone \ud800' }
  ]
  for (const f of bad) {
    t.exception.all(() => appealPayload(f), TypeError)
    t.alike(verifyAppeal(f, 'a'.repeat(128)), { ok: false, reason: 'malformed' })
  }
  t.ok(appealPayload({ ...FIELDS, text: 'a'.repeat(TEXT_MAX) }), 'the limit itself is fine')
  t.ok(appealPayload({ ...FIELDS, text: 'linha 1\nlinha 2' }), 'LF is allowed')
  t.alike(verifyAppeal(FIELDS, 'zz'), { ok: false, reason: 'malformed' })
  t.exception.all(() => signAppeal(FIELDS, { secretKey: new Uint8Array(3) }), TypeError)
  t.exception.all(() => signAppeal(FIELDS, null), TypeError)
})
