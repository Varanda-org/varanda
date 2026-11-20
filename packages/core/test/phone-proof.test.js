'use strict'

// lib/phone-proof.js: the exact bytes (golden vectors), that every field is
// bound by the issuer signature, domain separation from the age attestations
// and the other issuer and member statements, shape refusals (no phone field
// ever fits), the verifier reason order, that the verifiers never throw, and
// that the module stays pure.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PHONE_VERIFIED_PREFIX,
  PHONE_SINCE_PREFIX,
  MAX_PHONE_PROOF_BYTES,
  phoneVerifiedPayload,
  phoneSincePayload,
  createPhoneVerified,
  createPhoneSince,
  validatePhoneVerifiedShape,
  validatePhoneSinceShape,
  verifyPhoneVerified,
  verifyPhoneSince
} = require('../lib/phone-proof')
const ageProof = require('../lib/age-proof')
const cert = require('../lib/cert')
const age = require('../lib/age')
const phone = require('../lib/phone')

const coreRoot = path.join(__dirname, '..')
const LF = '\n'

// Fixed keys: the member pair from a seed of 32 bytes 0x01, the association
// from 0x0a and the issuer from 0x0b (the same as test/age-proof.test.js).
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const ASSOC_KP = crypto.keyPair(b4a.alloc(32, 10))
const ISSUER_KP = crypto.keyPair(b4a.alloc(32, 11))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOC = b4a.toString(ASSOC_KP.publicKey, 'hex')
const ISSUER = b4a.toString(ISSUER_KP.publicKey, 'hex')
const ISSUER_DATE = '2026-01-01T00:00:00.000Z'
const DATE = '2026-11-11T12:00:00.000Z'
const SINCE = '2026-11-10T00:00:00.000Z'
const SINCE_DATE = '2026-11-11T10:00:00.000Z'
const ISSUER_CERT = cert.createIssuerCert({ issuer: ISSUER, date: ISSUER_DATE }, ASSOC_KP)

const GOLDEN_ISSUER_SIG = '887953115755357518720fa5c5a681b6a630a1965ac514bc963b1d43aebaab9ca371ce32abddf425eca8dedb69596a67f4f4b252bd181f662b3a5533d6a0610c'
const GOLDEN_VERIFIED_SIG = 'c8e0ef51ee594593fb931c41d611678bbb594bea13e81e1718ee19ba49900532cfff450b1424e36a38b001a9aa57be43b1a3b246eac8d6e0bd5842c54938780a'
const GOLDEN_SINCE_SIG = '959fc904569032dbce9b849f1b9bb59878b93bdb43dca63370000f96f45609fad6917258c0a5e1cc90514da676c0635ce2543bc379f6b4d4fad5088d9d80a504'

function verified () {
  return createPhoneVerified({ member: MEMBER, date: DATE }, ISSUER_KP, ISSUER_CERT)
}

function since () {
  return createPhoneSince({ since: SINCE, date: SINCE_DATE }, ISSUER_KP, ISSUER_CERT)
}

function flipHex (s) {
  return (s[0] === '0' ? '1' : '0') + s.slice(1)
}

// Another association with its own certified issuer.
function otherChain () {
  const assocKp = crypto.keyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = cert.createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex'), date: ISSUER_DATE }, assocKp)
  return { assocKp, issuerKp, issuerCert, assoc: b4a.toString(assocKp.publicKey, 'hex') }
}

test('constants', (t) => {
  t.is(PHONE_VERIFIED_PREFIX, 'varanda-phone-verified-v1')
  t.is(PHONE_SINCE_PREFIX, 'varanda-phone-since-v1')
  t.is(MAX_PHONE_PROOF_BYTES, 1024)
  for (const other of [age.PREFIX, phone.PREFIX, ageProof.AGE_VERIFIED_PREFIX, ageProof.AGE_SINCE_PREFIX]) {
    t.not(PHONE_VERIFIED_PREFIX, other)
    t.not(PHONE_SINCE_PREFIX, other)
  }
})

test('golden vector: phone-verified exact bytes and signature', (t) => {
  t.is(MEMBER, '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c')
  t.is(ASSOC, '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c')
  t.is(ISSUER, '66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a')
  t.is(ISSUER_CERT.signature, GOLDEN_ISSUER_SIG)
  const att = verified()
  t.alike(att, {
    type: 'phone-verified',
    member: MEMBER,
    date: DATE,
    association: ASSOC,
    issuer: ISSUER,
    issuerDate: ISSUER_DATE,
    issuerSignature: GOLDEN_ISSUER_SIG,
    signature: GOLDEN_VERIFIED_SIG
  })
  t.alike(Object.keys(att), ['type', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature'])
  const payload = phoneVerifiedPayload(att)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-phone-verified-v1',
    MEMBER,
    DATE,
    ASSOC,
    ISSUER,
    ISSUER_DATE,
    GOLDEN_ISSUER_SIG
  ].join(LF))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  t.ok(crypto.verify(payload, b4a.from(GOLDEN_VERIFIED_SIG, 'hex'), ISSUER_KP.publicKey))
  t.alike(verifyPhoneVerified(att, MEMBER, ASSOC), { ok: true })
  t.alike(verifyPhoneVerified(att, MEMBER.toUpperCase(), ASSOC.toUpperCase()), { ok: true }, 'case of the arguments does not matter')
  t.ok(b4a.byteLength(JSON.stringify(att)) < MAX_PHONE_PROOF_BYTES)
})

test('golden vector: phone-since exact bytes and signature', (t) => {
  const att = since()
  t.alike(att, {
    type: 'phone-since',
    since: SINCE,
    date: SINCE_DATE,
    association: ASSOC,
    issuer: ISSUER,
    issuerDate: ISSUER_DATE,
    issuerSignature: GOLDEN_ISSUER_SIG,
    signature: GOLDEN_SINCE_SIG
  })
  t.alike(Object.keys(att), ['type', 'since', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature'])
  const payload = phoneSincePayload(att)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-phone-since-v1',
    SINCE,
    SINCE_DATE,
    ASSOC,
    ISSUER,
    ISSUER_DATE,
    GOLDEN_ISSUER_SIG
  ].join(LF))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  t.ok(crypto.verify(payload, b4a.from(GOLDEN_SINCE_SIG, 'hex'), ISSUER_KP.publicKey))
  t.alike(verifyPhoneSince(att, ASSOC), { ok: true })
  t.ok(b4a.byteLength(JSON.stringify(att)) < MAX_PHONE_PROOF_BYTES)
})

test('create: lowercases the member, defaults the phone-since date, round trips through JSON', (t) => {
  const att = createPhoneVerified({ member: MEMBER.toUpperCase(), date: DATE }, ISSUER_KP, ISSUER_CERT)
  t.is(att.member, MEMBER)
  t.is(att.signature, GOLDEN_VERIFIED_SIG)
  t.alike(verifyPhoneVerified(JSON.parse(JSON.stringify(att)), MEMBER, ASSOC), { ok: true })
  const before = Date.now()
  const s = createPhoneSince({ since: SINCE }, ISSUER_KP, ISSUER_CERT)
  t.ok(cert.isCanonicalIso(s.date))
  t.ok(Date.parse(s.date) >= before - 1000 && Date.parse(s.date) <= Date.now() + 1000)
  t.alike(verifyPhoneSince(JSON.parse(JSON.stringify(s)), ASSOC), { ok: true })
  t.alike(verifyPhoneSince(att, ASSOC), { ok: false, reason: 'malformed' }, 'a phone-verified is not a phone-since shape')
  t.alike(verifyPhoneVerified(s, MEMBER, ASSOC), { ok: false, reason: 'malformed' }, 'a phone-since is not a phone-verified shape')
})

test('every signed field of phone-verified is bound by the signature', (t) => {
  const att = verified()
  const other = otherChain()
  const otherMember = b4a.toString(crypto.keyPair().publicKey, 'hex')
  t.alike(verifyPhoneVerified({ ...att, member: otherMember }, otherMember, ASSOC), { ok: false, reason: 'bad-signature' }, 'member')
  t.alike(verifyPhoneVerified({ ...att, date: '2026-11-11T12:00:00.001Z' }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'date')
  t.alike(verifyPhoneVerified({ ...att, signature: flipHex(att.signature) }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'signature')
  // The delegation fields are bound twice; the issuer chain catches them first.
  t.alike(verifyPhoneVerified({ ...att, association: other.assoc }, MEMBER, other.assoc), { ok: false, reason: 'bad-issuer-signature' }, 'association')
  t.alike(verifyPhoneVerified({ ...att, issuerDate: '2026-01-02T00:00:00.000Z' }, MEMBER, ASSOC), { ok: false, reason: 'bad-issuer-signature' }, 'issuerDate')
  t.alike(verifyPhoneVerified({ ...att, issuerSignature: flipHex(att.issuerSignature) }, MEMBER, ASSOC), { ok: false, reason: 'bad-issuer-signature' }, 'issuerSignature')
  t.alike(verifyPhoneVerified({ ...att, issuer: b4a.toString(other.issuerKp.publicKey, 'hex') }, MEMBER, ASSOC), { ok: false, reason: 'bad-issuer-signature' }, 'issuer')

  // A second issuer certified by the same association: the delegation is
  // valid, so only the payload signature can refuse the swapped issuer.
  const sibling = crypto.keyPair()
  const siblingCert = cert.createIssuerCert({ issuer: b4a.toString(sibling.publicKey, 'hex'), date: ISSUER_DATE }, ASSOC_KP)
  const swapped = { ...att, issuer: siblingCert.issuer, issuerSignature: siblingCert.signature }
  t.alike(verifyPhoneVerified(swapped, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'issuer swapped for a valid sibling')
  const resigned = createPhoneVerified({ member: MEMBER, date: DATE }, sibling, siblingCert)
  t.alike(verifyPhoneVerified({ ...resigned, signature: att.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'signature by another issuer')
  t.alike(verifyPhoneVerified(resigned, MEMBER, ASSOC), { ok: true }, 'the sibling signs its own')
})

test('every signed field of phone-since is bound by the signature', (t) => {
  const att = since()
  const other = otherChain()
  t.alike(verifyPhoneSince({ ...att, since: '1970-01-01T00:00:00.000Z' }, ASSOC), { ok: false, reason: 'bad-signature' }, 'since')
  t.alike(verifyPhoneSince({ ...att, date: '2026-11-11T10:00:00.001Z' }, ASSOC), { ok: false, reason: 'bad-signature' }, 'date')
  t.alike(verifyPhoneSince({ ...att, signature: flipHex(att.signature) }, ASSOC), { ok: false, reason: 'bad-signature' }, 'signature')
  t.alike(verifyPhoneSince({ ...att, association: other.assoc }, other.assoc), { ok: false, reason: 'bad-issuer-signature' }, 'association')
  t.alike(verifyPhoneSince({ ...att, issuerDate: '2026-01-02T00:00:00.000Z' }, ASSOC), { ok: false, reason: 'bad-issuer-signature' }, 'issuerDate')
  t.alike(verifyPhoneSince({ ...att, issuerSignature: flipHex(att.issuerSignature) }, ASSOC), { ok: false, reason: 'bad-issuer-signature' }, 'issuerSignature')
  const sibling = crypto.keyPair()
  const siblingCert = cert.createIssuerCert({ issuer: b4a.toString(sibling.publicKey, 'hex'), date: ISSUER_DATE }, ASSOC_KP)
  t.alike(verifyPhoneSince({ ...att, issuer: siblingCert.issuer, issuerSignature: siblingCert.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'issuer swapped for a valid sibling')
})

test('domain separation: age attestations, both ways, with the same issuer, member and dates', (t) => {
  const v = verified()
  const s = since()
  const av = ageProof.createAgeVerified({ member: MEMBER, date: DATE }, ISSUER_KP, ISSUER_CERT)
  const as = ageProof.createAgeSince({ since: SINCE, date: SINCE_DATE }, ISSUER_KP, ISSUER_CERT)
  t.alike(ageProof.verifyAgeVerified(av, MEMBER, ASSOC), { ok: true })
  t.alike(ageProof.verifyAgeSince(as, ASSOC), { ok: true })

  // Only the prefix differs between each pair of payloads.
  t.is(b4a.toString(phoneVerifiedPayload(v)).split(LF).slice(1).join(LF), b4a.toString(ageProof.ageVerifiedPayload(av)).split(LF).slice(1).join(LF))
  t.is(b4a.toString(phoneSincePayload(s)).split(LF).slice(1).join(LF), b4a.toString(ageProof.ageSincePayload(as)).split(LF).slice(1).join(LF))

  // An age signature never verifies as a phone attestation.
  t.alike(verifyPhoneVerified({ ...v, signature: av.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-verified signature as phone-verified')
  t.alike(verifyPhoneVerified({ ...v, signature: as.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-since signature as phone-verified')
  t.alike(verifyPhoneSince({ ...s, signature: as.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-since signature as phone-since')
  t.alike(verifyPhoneSince({ ...s, signature: av.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-verified signature as phone-since')
  t.alike(verifyPhoneVerified({ ...av, type: 'phone-verified' }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-verified relabelled')
  t.alike(verifyPhoneSince({ ...as, type: 'phone-since' }, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-since relabelled')
  t.alike(verifyPhoneVerified(av, MEMBER, ASSOC), { ok: false, reason: 'malformed' }, 'age-verified as is')
  t.alike(verifyPhoneSince(as, ASSOC), { ok: false, reason: 'malformed' }, 'age-since as is')

  // And the reverse: a phone signature never verifies as an age attestation.
  t.alike(ageProof.verifyAgeVerified({ ...av, signature: v.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-verified signature as age-verified')
  t.alike(ageProof.verifyAgeVerified({ ...av, signature: s.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-since signature as age-verified')
  t.alike(ageProof.verifyAgeSince({ ...as, signature: s.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-since signature as age-since')
  t.alike(ageProof.verifyAgeSince({ ...as, signature: v.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-verified signature as age-since')
  t.alike(ageProof.verifyAgeVerified({ ...v, type: 'age-verified' }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-verified relabelled')
  t.alike(ageProof.verifyAgeSince({ ...s, type: 'age-since' }, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-since relabelled')
  t.alike(ageProof.verifyAgeVerified(v, MEMBER, ASSOC), { ok: false, reason: 'malformed' }, 'phone-verified as is')
  t.alike(ageProof.verifyAgeSince(s, ASSOC), { ok: false, reason: 'malformed' }, 'phone-since as is')
})

test('domain separation: phone attestations, username record, v2 certificate, the age and phone requests', (t) => {
  const v = verified()
  const s = since()

  // The phone attestations against each other, with the same delegation.
  t.alike(verifyPhoneSince({ ...s, signature: v.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-verified signature as phone-since')
  t.alike(verifyPhoneVerified({ ...v, signature: s.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-since signature as phone-verified')
  // Same date on both: only the prefix and the second field differ.
  const sameDate = createPhoneSince({ since: SINCE, date: DATE }, ISSUER_KP, ISSUER_CERT)
  t.alike(verifyPhoneVerified({ ...v, signature: sameDate.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' })

  // Username record and v2 certificate by the same issuer for the same member.
  const record = cert.createUsernameRecord({ member: MEMBER, username: 'ana_maria', date: DATE }, ISSUER_KP, ISSUER_CERT)
  const v2 = cert.createIssuedCert({ member: MEMBER, date: DATE }, ISSUER_KP, ISSUER_CERT)
  t.alike(cert.verifyUsernameRecord(record, MEMBER, ASSOC), { ok: true })
  t.alike(cert.verifyCert(v2, ASSOC), { ok: true })
  t.alike(cert.verifyUsernameRecord({ ...record, signature: v.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-verified as username')
  t.alike(cert.verifyUsernameRecord({ ...record, signature: s.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-since as username')
  t.alike(cert.verifyCert({ ...v2, signature: v.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-verified as v2 cert')
  t.alike(cert.verifyCert({ ...v2, signature: s.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'phone-since as v2 cert')
  for (const [name, sig] of [['username', record.signature], ['v2 cert', v2.signature]]) {
    t.alike(verifyPhoneVerified({ ...v, signature: sig }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, name + ' as phone-verified')
    t.alike(verifyPhoneSince({ ...s, signature: sig }, ASSOC), { ok: false, reason: 'bad-signature' }, name + ' as phone-since')
  }
  // The issuer delegation itself, signed by the association, is not an attestation.
  t.alike(verifyPhoneVerified({ ...v, signature: GOLDEN_ISSUER_SIG }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' })
  t.alike(verifyPhoneSince({ ...s, signature: GOLDEN_ISSUER_SIG }, ASSOC), { ok: false, reason: 'bad-signature' })

  // The member's 'varanda-age-v1' and 'varanda-phone-v1' requests, here signed
  // by the issuer key so that the signer is the same and only the bytes differ.
  const reqFields = { nonce: 'A'.repeat(43), member: ISSUER, association: ASSOC }
  const requests = [
    ...age.ACTIONS.map((action) => ['age request ' + action, { ...reqFields, action }, age.signAge, age.verifyAge]),
    ...phone.ACTIONS.map((action) => ['phone request ' + action, { ...reqFields, action }, phone.signPhone, phone.verifyPhone])
  ]
  for (const [name, fields, signFn, verifyFn] of requests) {
    const reqSig = signFn(fields, ISSUER_KP)
    t.alike(verifyFn(fields, reqSig), { ok: true }, name)
    t.alike(verifyPhoneVerified({ ...v, signature: reqSig }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, name + ' as phone-verified')
    t.alike(verifyPhoneSince({ ...s, signature: reqSig }, ASSOC), { ok: false, reason: 'bad-signature' }, name + ' as phone-since')
    t.alike(verifyFn(fields, v.signature), { ok: false, reason: 'bad-signature' }, 'phone-verified as ' + name)
    t.alike(verifyFn(fields, s.signature), { ok: false, reason: 'bad-signature' }, 'phone-since as ' + name)
  }

  // The payloads never share a first line.
  const av = ageProof.createAgeVerified({ member: MEMBER, date: DATE }, ISSUER_KP, ISSUER_CERT)
  const as = ageProof.createAgeSince({ since: SINCE, date: SINCE_DATE }, ISSUER_KP, ISSUER_CERT)
  const firstLines = [
    b4a.toString(phoneVerifiedPayload(v)).split(LF)[0],
    b4a.toString(phoneSincePayload(s)).split(LF)[0],
    b4a.toString(ageProof.ageVerifiedPayload(av)).split(LF)[0],
    b4a.toString(ageProof.ageSincePayload(as)).split(LF)[0],
    b4a.toString(cert.usernameRecordPayload(record)).split(LF)[0],
    b4a.toString(cert.certPayloadV2(v2)).split(LF)[0],
    b4a.toString(age.agePayload({ ...reqFields, action: age.ACTIONS[0] })).split(LF)[0],
    b4a.toString(phone.phonePayload({ ...reqFields, action: phone.ACTIONS[0] })).split(LF)[0]
  ]
  t.is(new Set(firstLines).size, firstLines.length, firstLines.join(' '))
})

test('shape refusals', (t) => {
  const v = verified()
  const s = since()
  t.is(validatePhoneVerifiedShape(v), null)
  t.is(validatePhoneSinceShape(s), null)

  const withoutV = { ...v }
  delete withoutV.date
  const withoutS = { ...s }
  delete withoutS.since
  const nullProto = Object.assign(Object.create(null), v)
  t.is(validatePhoneVerifiedShape(nullProto), null, 'a null-prototype copy is fine')

  const huge = 'a'.repeat(MAX_PHONE_PROOF_BYTES * 4)
  const badVerified = {
    'extra key phone': { ...v, phone: '+5511987654321' },
    'extra key number': { ...v, number: '+5511987654321' },
    'extra key mask': { ...v, mask: '+55 11 9****-4321' },
    'extra key provider': { ...v, provider: 'x' },
    'missing key': withoutV,
    'type of phone-since': { ...v, type: 'phone-since' },
    'type of age-verified': { ...v, type: 'age-verified' },
    'type username': { ...v, type: 'username' },
    'uppercase member': { ...v, member: v.member.toUpperCase() },
    'uppercase association': { ...v, association: v.association.toUpperCase() },
    'uppercase issuer': { ...v, issuer: v.issuer.toUpperCase() },
    'uppercase issuerSignature': { ...v, issuerSignature: v.issuerSignature.toUpperCase() },
    'uppercase signature': { ...v, signature: v.signature.toUpperCase() },
    'short member': { ...v, member: v.member.slice(2) },
    'short signature': { ...v, signature: v.signature.slice(2) },
    'empty signature': { ...v, signature: '' },
    'date without milliseconds': { ...v, date: '2026-11-11T12:00:00Z' },
    'date with offset': { ...v, date: '2026-11-11T12:00:00.000+00:00' },
    'invalid month': { ...v, date: '2026-13-01T00:00:00.000Z' },
    'numeric date': { ...v, date: Date.parse(DATE) },
    'non-canonical issuerDate': { ...v, issuerDate: '2026-01-01' },
    'issuer === association': { ...v, issuer: v.association },
    'member number': { ...v, member: 1 },
    'member null': { ...v, member: null },
    'over the byte cap': { ...v, member: huge },
    'over the byte cap (signature)': { ...v, signature: huge }
  }
  for (const [name, att] of Object.entries(badVerified)) {
    t.is(validatePhoneVerifiedShape(att), 'malformed', name)
    t.alike(verifyPhoneVerified(att, MEMBER, ASSOC), { ok: false, reason: 'malformed' }, 'verify ' + name)
  }
  const badSince = {
    'extra key member': { ...s, member: MEMBER },
    'extra key phone': { ...s, phone: '+5511987654321' },
    'extra key number': { ...s, number: '+5511987654321' },
    'missing key': withoutS,
    'type of phone-verified': { ...s, type: 'phone-verified' },
    'type of age-since': { ...s, type: 'age-since' },
    'since null': { ...s, since: null },
    'since non-canonical': { ...s, since: '2026-11-10' },
    'since number': { ...s, since: 0 },
    'uppercase signature': { ...s, signature: s.signature.toUpperCase() },
    'issuer === association': { ...s, issuer: s.association },
    'over the byte cap': { ...s, since: huge }
  }
  for (const [name, att] of Object.entries(badSince)) {
    t.is(validatePhoneSinceShape(att), 'malformed', name)
    t.alike(verifyPhoneSince(att, ASSOC), { ok: false, reason: 'malformed' }, 'verify ' + name)
  }
  for (const junk of [null, undefined, [], 'x', 42, true, new Map(), new Date(), [v]]) {
    t.is(validatePhoneVerifiedShape(junk), 'malformed')
    t.is(validatePhoneSinceShape(junk), 'malformed')
  }
})

test('payload builders throw TypeError on a bad shape', (t) => {
  const v = verified()
  const s = since()
  for (const bad of [null, undefined, [], 'x', 1, { ...v, type: 'phone-since' }, { ...v, type: 'age-verified' }, { ...v, member: 'AB'.repeat(32) }, { ...v, issuer: v.association }, s]) {
    t.exception.all(() => phoneVerifiedPayload(bad), TypeError, String(JSON.stringify(bad)).slice(0, 40))
  }
  for (const bad of [null, undefined, [], 'x', 1, { ...s, since: null }, { ...s, date: 'now' }, { ...s, type: 'age-since' }, v]) {
    t.exception.all(() => phoneSincePayload(bad), TypeError, String(JSON.stringify(bad)).slice(0, 40))
  }
  const hostile = { type: 'phone-verified', get member () { throw new Error('boom') } }
  t.exception.all(() => phoneVerifiedPayload(hostile), TypeError)
})

test('verifyPhoneVerified reason order', (t) => {
  const v = verified()
  const other = otherChain()
  const stranger = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const revokedIssuers = new Set([ISSUER])

  // Each step only fails once every earlier one would pass.
  t.alike(verifyPhoneVerified({ ...v, extra: 1 }, stranger, other.assoc, { revokedIssuers }), { ok: false, reason: 'malformed' })
  t.alike(verifyPhoneVerified({ ...v, signature: flipHex(v.signature) }, stranger, other.assoc, { revokedIssuers }), { ok: false, reason: 'member-mismatch' })
  t.alike(verifyPhoneVerified({ ...v, signature: flipHex(v.signature) }, MEMBER, other.assoc, { revokedIssuers }), { ok: false, reason: 'untrusted-association' })
  t.alike(verifyPhoneVerified({ ...v, issuerSignature: flipHex(v.issuerSignature), signature: flipHex(v.signature) }, MEMBER, ASSOC, { revokedIssuers }), { ok: false, reason: 'bad-issuer-signature' })
  t.alike(verifyPhoneVerified({ ...v, signature: flipHex(v.signature) }, MEMBER, ASSOC, { revokedIssuers }), { ok: false, reason: 'bad-signature' })
  t.alike(verifyPhoneVerified(v, MEMBER, ASSOC, { revokedIssuers }), { ok: false, reason: 'revoked-issuer' })
  t.alike(verifyPhoneVerified(v, MEMBER, ASSOC, { revokedIssuers: new Set([stranger]) }), { ok: true })
  t.alike(verifyPhoneVerified(v, MEMBER, ASSOC, {}), { ok: true })
  t.alike(verifyPhoneVerified(v, MEMBER, ASSOC, { revokedIssuers: [ISSUER] }), { ok: true }, 'no has method means none revoked')

  // The association argument must be hex64.
  t.alike(verifyPhoneVerified(v, MEMBER, 'zz'), { ok: false, reason: 'malformed' })
  t.alike(verifyPhoneVerified(v, MEMBER, null), { ok: false, reason: 'malformed' })
  t.alike(verifyPhoneVerified(v, null, ASSOC), { ok: false, reason: 'member-mismatch' })
})

test('verifyPhoneSince reason order', (t) => {
  const s = since()
  const other = otherChain()
  const revokedIssuers = new Set([ISSUER])
  t.alike(verifyPhoneSince({ ...s, since: null }, other.assoc, { revokedIssuers }), { ok: false, reason: 'malformed' })
  t.alike(verifyPhoneSince({ ...s, signature: flipHex(s.signature) }, other.assoc, { revokedIssuers }), { ok: false, reason: 'untrusted-association' })
  t.alike(verifyPhoneSince({ ...s, issuerSignature: flipHex(s.issuerSignature), signature: flipHex(s.signature) }, ASSOC, { revokedIssuers }), { ok: false, reason: 'bad-issuer-signature' })
  t.alike(verifyPhoneSince({ ...s, signature: flipHex(s.signature) }, ASSOC, { revokedIssuers }), { ok: false, reason: 'bad-signature' })
  t.alike(verifyPhoneSince(s, ASSOC, { revokedIssuers }), { ok: false, reason: 'revoked-issuer' })
  t.alike(verifyPhoneSince(s, ASSOC), { ok: true })
  t.alike(verifyPhoneSince(s, 'zz'), { ok: false, reason: 'malformed' })

  // An attestation minted under another association's issuer never passes here.
  const foreign = createPhoneSince({ since: '1970-01-01T00:00:00.000Z', date: SINCE_DATE }, other.issuerKp, other.issuerCert)
  t.alike(verifyPhoneSince(foreign, other.assoc), { ok: true })
  t.alike(verifyPhoneSince(foreign, ASSOC), { ok: false, reason: 'untrusted-association' })
  t.alike(verifyPhoneSince({ ...foreign, association: ASSOC }, ASSOC), { ok: false, reason: 'bad-issuer-signature' })
})

test('verifiers never throw on junk', (t) => {
  const v = verified()
  const s = since()
  const huge = 'x'.repeat(1 << 20)
  const hostile = new Proxy({}, { ownKeys () { throw new Error('boom') }, get () { throw new Error('boom') } })
  const getter = { ...v }
  Object.defineProperty(getter, 'member', { enumerable: true, get () { throw new Error('boom') } })
  const cyclic = { ...v }
  cyclic.self = cyclic
  const big = { ...v }
  big.signature = 10n
  const junk = [null, undefined, 0, 1, NaN, -1, true, false, '', huge, [], [v], [null], {}, () => {}, Symbol('x'), new Map(), new Date(), hostile, getter, cyclic, big, Object.create(v)]
  for (const att of junk) {
    for (const member of [MEMBER, null, 42, huge, [], {}]) {
      for (const assoc of [ASSOC, null, 42, huge, [], {}]) {
        let r
        try {
          r = verifyPhoneVerified(att, member, assoc)
        } catch (err) {
          t.fail('verifyPhoneVerified threw: ' + err.message)
          continue
        }
        if (r.ok) t.fail('junk verified')
      }
    }
    for (const assoc of [ASSOC, null, 42, huge, [], {}]) {
      let r
      try {
        r = verifyPhoneSince(att, assoc, { revokedIssuers: hostile })
      } catch (err) {
        t.fail('verifyPhoneSince threw: ' + err.message)
        continue
      }
      if (r.ok) t.fail('junk verified')
    }
  }
  t.alike(verifyPhoneVerified(), { ok: false, reason: 'malformed' })
  t.alike(verifyPhoneSince(), { ok: false, reason: 'malformed' })
  t.alike(verifyPhoneVerified(getter, MEMBER, ASSOC), { ok: false, reason: 'malformed' })
  t.alike(verifyPhoneSince(s, ASSOC, hostile), { ok: false, reason: 'malformed' }, 'hostile options are caught')
  t.pass('no throw')
})

test('create* throw TypeError on bad inputs like createIssuedCert', (t) => {
  const other = otherChain()
  const stranger = crypto.keyPair()
  const badVerified = [
    () => createPhoneVerified({ member: 'abc', date: DATE }, ISSUER_KP, ISSUER_CERT),
    () => createPhoneVerified({ member: 'zz'.repeat(32), date: DATE }, ISSUER_KP, ISSUER_CERT),
    () => createPhoneVerified({ member: MEMBER }, ISSUER_KP, ISSUER_CERT),
    () => createPhoneVerified({ member: MEMBER, date: '2026-11-11T12:00:00Z' }, ISSUER_KP, ISSUER_CERT),
    () => createPhoneVerified({ member: MEMBER, date: DATE }, null, ISSUER_CERT),
    () => createPhoneVerified({ member: MEMBER, date: DATE }, { secretKey: b4a.alloc(32) }, ISSUER_CERT),
    () => createPhoneVerified({ member: MEMBER, date: DATE }, stranger, ISSUER_CERT),
    () => createPhoneVerified({ member: MEMBER, date: DATE }, ISSUER_KP, null),
    () => createPhoneVerified({ member: MEMBER, date: DATE }, ISSUER_KP, { ...ISSUER_CERT, extra: 1 }),
    () => createPhoneVerified({ member: MEMBER, date: DATE }, ISSUER_KP, { ...ISSUER_CERT, signature: flipHex(ISSUER_CERT.signature) }),
    () => createPhoneVerified({ member: MEMBER, date: DATE }, ISSUER_KP, other.issuerCert),
    () => createPhoneVerified(undefined, ISSUER_KP, ISSUER_CERT)
  ]
  for (const fn of badVerified) t.exception.all(fn, TypeError)
  const badSince = [
    () => createPhoneSince({ date: SINCE_DATE }, ISSUER_KP, ISSUER_CERT),
    () => createPhoneSince({ since: null, date: SINCE_DATE }, ISSUER_KP, ISSUER_CERT),
    () => createPhoneSince({ since: '2026-11-10', date: SINCE_DATE }, ISSUER_KP, ISSUER_CERT),
    () => createPhoneSince({ since: SINCE, date: 'now' }, ISSUER_KP, ISSUER_CERT),
    () => createPhoneSince({ since: SINCE, date: SINCE_DATE }, stranger, ISSUER_CERT),
    () => createPhoneSince({ since: SINCE, date: SINCE_DATE }, ISSUER_KP, other.issuerCert),
    () => createPhoneSince({ since: SINCE, date: SINCE_DATE }, ISSUER_KP, { ...ISSUER_CERT, issuer: ASSOC }),
    () => createPhoneSince(undefined, ISSUER_KP, ISSUER_CERT)
  ]
  for (const fn of badSince) t.exception.all(fn, TypeError)
})

test('create* never copy a phone field into an attestation', (t) => {
  const v = createPhoneVerified({ member: MEMBER, date: DATE, phone: '+5511987654321', number: '+5511987654321', mask: 'x', index: 'y', provider: 'z' }, ISSUER_KP, ISSUER_CERT)
  const s = createPhoneSince({ since: SINCE, date: SINCE_DATE, phone: '+5511987654321' }, ISSUER_KP, ISSUER_CERT)
  t.alike(v, verified())
  t.alike(s, since())
  t.absent(JSON.stringify([v, s]).includes('5511987654321'))
})

test('the module is pure: only b4a, hypercore-crypto and ./cert, no network', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/phone-proof.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'phone-proof.js')).map(([id]) => id)
  t.alike(own.sort(), ['./cert', 'b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
  // cert.js reaches the file system only through the '#fs' and '#path'
  // imports; this module must not touch them, nor process, itself.
  const src = fs.readFileSync(path.join(coreRoot, 'lib', 'phone-proof.js'), 'utf8')
  for (const word of ['#fs', '#path', '#process', 'process.', "require('fs')", "require('node:"]) {
    t.absent(src.includes(word), 'source does not mention ' + word)
  }
})
