'use strict'

// lib/age-proof.js: the exact bytes (golden vectors), that every field is
// bound by the issuer signature, domain separation from the other issuer and
// member statements, shape refusals, the verifier reason order, that the
// verifiers never throw, and that the module stays pure.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  AGE_VERIFIED_PREFIX,
  AGE_SINCE_PREFIX,
  MAX_AGE_PROOF_BYTES,
  ageVerifiedPayload,
  ageSincePayload,
  createAgeVerified,
  createAgeSince,
  validateAgeVerifiedShape,
  validateAgeSinceShape,
  verifyAgeVerified,
  verifyAgeSince
} = require('../lib/age-proof')
const cert = require('../lib/cert')
const age = require('../lib/age')

const coreRoot = path.join(__dirname, '..')
const LF = '\n'

// Fixed keys: the member pair from a seed of 32 bytes 0x01, the association
// from 0x0a and the issuer from 0x0b.
const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const ASSOC_KP = crypto.keyPair(b4a.alloc(32, 10))
const ISSUER_KP = crypto.keyPair(b4a.alloc(32, 11))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOC = b4a.toString(ASSOC_KP.publicKey, 'hex')
const ISSUER = b4a.toString(ISSUER_KP.publicKey, 'hex')
const ISSUER_DATE = '2026-01-01T00:00:00.000Z'
const DATE = '2026-10-30T12:00:00.000Z'
const SINCE = '2026-10-29T00:00:00.000Z'
const SINCE_DATE = '2026-11-04T10:00:00.000Z'
const ISSUER_CERT = cert.createIssuerCert({ issuer: ISSUER, date: ISSUER_DATE }, ASSOC_KP)

const GOLDEN_ISSUER_SIG = '887953115755357518720fa5c5a681b6a630a1965ac514bc963b1d43aebaab9ca371ce32abddf425eca8dedb69596a67f4f4b252bd181f662b3a5533d6a0610c'
const GOLDEN_VERIFIED_SIG = 'ef1922fb332e3c7360fcfa52a340d3d4a95ea15b0bc1838043b697f1b718ef75a890c1dc641aff39fe9375396ea41225a4e5774ee9bc4e2fa0022c75eb537e05'
const GOLDEN_SINCE_SIG = 'b659c5ce568ff9a918d2bd59f394ffcff5b95002dff5ca180f8470f2f5fdd10513dc2ef2fd26eacd536d6fb96119a1cd1d1e53dba0ade6fc0454e2a8ee6a8a00'

function verified () {
  return createAgeVerified({ member: MEMBER, date: DATE }, ISSUER_KP, ISSUER_CERT)
}

function since () {
  return createAgeSince({ since: SINCE, date: SINCE_DATE }, ISSUER_KP, ISSUER_CERT)
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
  t.is(AGE_VERIFIED_PREFIX, 'varanda-age-verified-v1')
  t.is(AGE_SINCE_PREFIX, 'varanda-age-since-v1')
  t.is(MAX_AGE_PROOF_BYTES, 1024)
  t.not(AGE_VERIFIED_PREFIX, age.PREFIX)
  t.not(AGE_SINCE_PREFIX, age.PREFIX)
})

test('golden vector: age-verified exact bytes and signature', (t) => {
  t.is(MEMBER, '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c')
  t.is(ASSOC, '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c')
  t.is(ISSUER, '66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a')
  t.is(ISSUER_CERT.signature, GOLDEN_ISSUER_SIG)
  const att = verified()
  t.alike(att, {
    type: 'age-verified',
    member: MEMBER,
    date: DATE,
    association: ASSOC,
    issuer: ISSUER,
    issuerDate: ISSUER_DATE,
    issuerSignature: GOLDEN_ISSUER_SIG,
    signature: GOLDEN_VERIFIED_SIG
  })
  t.alike(Object.keys(att), ['type', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature'])
  const payload = ageVerifiedPayload(att)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-age-verified-v1',
    MEMBER,
    DATE,
    ASSOC,
    ISSUER,
    ISSUER_DATE,
    GOLDEN_ISSUER_SIG
  ].join(LF))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  t.ok(crypto.verify(payload, b4a.from(GOLDEN_VERIFIED_SIG, 'hex'), ISSUER_KP.publicKey))
  t.alike(verifyAgeVerified(att, MEMBER, ASSOC), { ok: true })
  t.alike(verifyAgeVerified(att, MEMBER.toUpperCase(), ASSOC.toUpperCase()), { ok: true }, 'case of the arguments does not matter')
  t.ok(b4a.byteLength(JSON.stringify(att)) < MAX_AGE_PROOF_BYTES)
})

test('golden vector: age-since exact bytes and signature', (t) => {
  const att = since()
  t.alike(att, {
    type: 'age-since',
    since: SINCE,
    date: SINCE_DATE,
    association: ASSOC,
    issuer: ISSUER,
    issuerDate: ISSUER_DATE,
    issuerSignature: GOLDEN_ISSUER_SIG,
    signature: GOLDEN_SINCE_SIG
  })
  t.alike(Object.keys(att), ['type', 'since', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature'])
  const payload = ageSincePayload(att)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-age-since-v1',
    SINCE,
    SINCE_DATE,
    ASSOC,
    ISSUER,
    ISSUER_DATE,
    GOLDEN_ISSUER_SIG
  ].join(LF))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  t.alike(verifyAgeSince(att, ASSOC), { ok: true })
  t.ok(b4a.byteLength(JSON.stringify(att)) < MAX_AGE_PROOF_BYTES)
})

test('create: lowercases the member, defaults the age-since date, round trips through JSON', (t) => {
  const att = createAgeVerified({ member: MEMBER.toUpperCase(), date: DATE }, ISSUER_KP, ISSUER_CERT)
  t.is(att.member, MEMBER)
  t.is(att.signature, GOLDEN_VERIFIED_SIG)
  t.alike(verifyAgeVerified(JSON.parse(JSON.stringify(att)), MEMBER, ASSOC), { ok: true })
  const before = Date.now()
  const s = createAgeSince({ since: SINCE }, ISSUER_KP, ISSUER_CERT)
  t.ok(cert.isCanonicalIso(s.date))
  t.ok(Date.parse(s.date) >= before - 1000 && Date.parse(s.date) <= Date.now() + 1000)
  t.alike(verifyAgeSince(JSON.parse(JSON.stringify(s)), ASSOC), { ok: true })
  t.alike(verifyAgeSince(att, ASSOC), { ok: false, reason: 'malformed' }, 'an age-verified is not an age-since shape')
  t.alike(verifyAgeVerified(s, MEMBER, ASSOC), { ok: false, reason: 'malformed' }, 'an age-since is not an age-verified shape')
})

test('every signed field of age-verified is bound by the signature', (t) => {
  const att = verified()
  const other = otherChain()
  const otherMember = b4a.toString(crypto.keyPair().publicKey, 'hex')
  t.alike(verifyAgeVerified({ ...att, member: otherMember }, otherMember, ASSOC), { ok: false, reason: 'bad-signature' }, 'member')
  t.alike(verifyAgeVerified({ ...att, date: '2026-10-30T12:00:00.001Z' }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'date')
  t.alike(verifyAgeVerified({ ...att, signature: flipHex(att.signature) }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'signature')
  // The delegation fields are bound twice; the issuer chain catches them first.
  t.alike(verifyAgeVerified({ ...att, association: other.assoc }, MEMBER, other.assoc), { ok: false, reason: 'bad-issuer-signature' }, 'association')
  t.alike(verifyAgeVerified({ ...att, issuerDate: '2026-01-02T00:00:00.000Z' }, MEMBER, ASSOC), { ok: false, reason: 'bad-issuer-signature' }, 'issuerDate')
  t.alike(verifyAgeVerified({ ...att, issuerSignature: flipHex(att.issuerSignature) }, MEMBER, ASSOC), { ok: false, reason: 'bad-issuer-signature' }, 'issuerSignature')
  t.alike(verifyAgeVerified({ ...att, issuer: b4a.toString(other.issuerKp.publicKey, 'hex') }, MEMBER, ASSOC), { ok: false, reason: 'bad-issuer-signature' }, 'issuer')

  // A second issuer certified by the same association: the delegation is
  // valid, so only the payload signature can refuse the swapped issuer.
  const sibling = crypto.keyPair()
  const siblingCert = cert.createIssuerCert({ issuer: b4a.toString(sibling.publicKey, 'hex'), date: ISSUER_DATE }, ASSOC_KP)
  const swapped = { ...att, issuer: siblingCert.issuer, issuerSignature: siblingCert.signature }
  t.alike(verifyAgeVerified(swapped, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'issuer swapped for a valid sibling')
  const resigned = createAgeVerified({ member: MEMBER, date: DATE }, sibling, siblingCert)
  t.alike(verifyAgeVerified({ ...resigned, signature: att.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'signature by another issuer')
  t.alike(verifyAgeVerified(resigned, MEMBER, ASSOC), { ok: true }, 'the sibling signs its own')
})

test('every signed field of age-since is bound by the signature', (t) => {
  const att = since()
  const other = otherChain()
  t.alike(verifyAgeSince({ ...att, since: '1970-01-01T00:00:00.000Z' }, ASSOC), { ok: false, reason: 'bad-signature' }, 'since')
  t.alike(verifyAgeSince({ ...att, date: '2026-11-04T10:00:00.001Z' }, ASSOC), { ok: false, reason: 'bad-signature' }, 'date')
  t.alike(verifyAgeSince({ ...att, signature: flipHex(att.signature) }, ASSOC), { ok: false, reason: 'bad-signature' }, 'signature')
  t.alike(verifyAgeSince({ ...att, association: other.assoc }, other.assoc), { ok: false, reason: 'bad-issuer-signature' }, 'association')
  t.alike(verifyAgeSince({ ...att, issuerDate: '2026-01-02T00:00:00.000Z' }, ASSOC), { ok: false, reason: 'bad-issuer-signature' }, 'issuerDate')
  t.alike(verifyAgeSince({ ...att, issuerSignature: flipHex(att.issuerSignature) }, ASSOC), { ok: false, reason: 'bad-issuer-signature' }, 'issuerSignature')
  const sibling = crypto.keyPair()
  const siblingCert = cert.createIssuerCert({ issuer: b4a.toString(sibling.publicKey, 'hex'), date: ISSUER_DATE }, ASSOC_KP)
  t.alike(verifyAgeSince({ ...att, issuer: siblingCert.issuer, issuerSignature: siblingCert.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'issuer swapped for a valid sibling')
})

test('domain separation: age-verified, age-since, username record, v2 certificate and the age request', (t) => {
  const v = verified()
  const s = since()

  // The age attestations against each other, with the same delegation.
  t.alike(verifyAgeSince({ ...s, signature: v.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-verified signature as age-since')
  t.alike(verifyAgeVerified({ ...v, signature: s.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-since signature as age-verified')
  // Same date on both: only the prefix and the second field differ.
  const sameDate = createAgeSince({ since: SINCE, date: DATE }, ISSUER_KP, ISSUER_CERT)
  t.alike(verifyAgeVerified({ ...v, signature: sameDate.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' })

  // Username record and v2 certificate by the same issuer for the same member.
  const record = cert.createUsernameRecord({ member: MEMBER, username: 'ana_maria', date: DATE }, ISSUER_KP, ISSUER_CERT)
  const v2 = cert.createIssuedCert({ member: MEMBER, date: DATE }, ISSUER_KP, ISSUER_CERT)
  t.alike(cert.verifyUsernameRecord(record, MEMBER, ASSOC), { ok: true })
  t.alike(cert.verifyCert(v2, ASSOC), { ok: true })
  t.alike(cert.verifyUsernameRecord({ ...record, signature: v.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-verified as username')
  t.alike(cert.verifyUsernameRecord({ ...record, signature: s.signature }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-since as username')
  t.alike(cert.verifyCert({ ...v2, signature: v.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-verified as v2 cert')
  t.alike(cert.verifyCert({ ...v2, signature: s.signature }, ASSOC), { ok: false, reason: 'bad-signature' }, 'age-since as v2 cert')
  for (const [name, sig] of [['username', record.signature], ['v2 cert', v2.signature]]) {
    t.alike(verifyAgeVerified({ ...v, signature: sig }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, name + ' as age-verified')
    t.alike(verifyAgeSince({ ...s, signature: sig }, ASSOC), { ok: false, reason: 'bad-signature' }, name + ' as age-since')
  }
  // The issuer delegation itself, signed by the association, is not an attestation.
  t.alike(verifyAgeVerified({ ...v, signature: GOLDEN_ISSUER_SIG }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' })

  // The member's 'varanda-age-v1' request, here signed by the issuer key so
  // that the signer is the same and only the bytes differ.
  const reqFields = { action: 'result', nonce: 'A'.repeat(43), member: ISSUER, association: ASSOC }
  const reqSig = age.signAge(reqFields, ISSUER_KP)
  t.alike(age.verifyAge(reqFields, reqSig), { ok: true })
  t.alike(verifyAgeVerified({ ...v, signature: reqSig }, MEMBER, ASSOC), { ok: false, reason: 'bad-signature' }, 'age request as age-verified')
  t.alike(verifyAgeSince({ ...s, signature: reqSig }, ASSOC), { ok: false, reason: 'bad-signature' }, 'age request as age-since')
  t.alike(age.verifyAge(reqFields, v.signature), { ok: false, reason: 'bad-signature' }, 'age-verified as age request')
  t.alike(age.verifyAge(reqFields, s.signature), { ok: false, reason: 'bad-signature' }, 'age-since as age request')
  for (const action of age.ACTIONS) {
    t.alike(age.verifyAge({ ...reqFields, action }, v.signature), { ok: false, reason: 'bad-signature' })
  }

  // The payloads never share a first line.
  const firstLines = [
    b4a.toString(ageVerifiedPayload(v)).split(LF)[0],
    b4a.toString(ageSincePayload(s)).split(LF)[0],
    b4a.toString(cert.usernameRecordPayload(record)).split(LF)[0],
    b4a.toString(cert.certPayloadV2(v2)).split(LF)[0],
    b4a.toString(age.agePayload(reqFields)).split(LF)[0]
  ]
  t.is(new Set(firstLines).size, firstLines.length, firstLines.join(' '))
})

test('shape refusals', (t) => {
  const v = verified()
  const s = since()
  t.is(validateAgeVerifiedShape(v), null)
  t.is(validateAgeSinceShape(s), null)

  const withoutV = { ...v }
  delete withoutV.date
  const withoutS = { ...s }
  delete withoutS.since
  const nullProto = Object.assign(Object.create(null), v)
  t.is(validateAgeVerifiedShape(nullProto), null, 'a null-prototype copy is fine')

  const huge = 'a'.repeat(MAX_AGE_PROOF_BYTES * 4)
  const badVerified = {
    'extra key': { ...v, band: '18+' },
    'missing key': withoutV,
    'type of age-since': { ...v, type: 'age-since' },
    'type username': { ...v, type: 'username' },
    'uppercase member': { ...v, member: v.member.toUpperCase() },
    'uppercase association': { ...v, association: v.association.toUpperCase() },
    'uppercase issuer': { ...v, issuer: v.issuer.toUpperCase() },
    'uppercase issuerSignature': { ...v, issuerSignature: v.issuerSignature.toUpperCase() },
    'uppercase signature': { ...v, signature: v.signature.toUpperCase() },
    'short member': { ...v, member: v.member.slice(2) },
    'short signature': { ...v, signature: v.signature.slice(2) },
    'empty signature': { ...v, signature: '' },
    'date without milliseconds': { ...v, date: '2026-10-30T12:00:00Z' },
    'date with offset': { ...v, date: '2026-10-30T12:00:00.000+00:00' },
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
    t.is(validateAgeVerifiedShape(att), 'malformed', name)
    t.alike(verifyAgeVerified(att, MEMBER, ASSOC), { ok: false, reason: 'malformed' }, 'verify ' + name)
  }
  const badSince = {
    'extra key': { ...s, member: MEMBER },
    'missing key': withoutS,
    'type of age-verified': { ...s, type: 'age-verified' },
    'since null': { ...s, since: null },
    'since non-canonical': { ...s, since: '2026-10-29' },
    'since number': { ...s, since: 0 },
    'uppercase signature': { ...s, signature: s.signature.toUpperCase() },
    'issuer === association': { ...s, issuer: s.association },
    'over the byte cap': { ...s, since: huge }
  }
  for (const [name, att] of Object.entries(badSince)) {
    t.is(validateAgeSinceShape(att), 'malformed', name)
    t.alike(verifyAgeSince(att, ASSOC), { ok: false, reason: 'malformed' }, 'verify ' + name)
  }
  for (const junk of [null, undefined, [], 'x', 42, true, new Map(), new Date(), [v]]) {
    t.is(validateAgeVerifiedShape(junk), 'malformed')
    t.is(validateAgeSinceShape(junk), 'malformed')
  }
})

test('payload builders throw TypeError on a bad shape', (t) => {
  const v = verified()
  const s = since()
  for (const bad of [null, undefined, [], 'x', 1, { ...v, type: 'age-since' }, { ...v, member: 'AB'.repeat(32) }, { ...v, issuer: v.association }, s]) {
    t.exception.all(() => ageVerifiedPayload(bad), TypeError, String(JSON.stringify(bad)).slice(0, 40))
  }
  for (const bad of [null, undefined, [], 'x', 1, { ...s, since: null }, { ...s, date: 'now' }, v]) {
    t.exception.all(() => ageSincePayload(bad), TypeError, String(JSON.stringify(bad)).slice(0, 40))
  }
  const hostile = { type: 'age-verified', get member () { throw new Error('boom') } }
  t.exception.all(() => ageVerifiedPayload(hostile), TypeError)
})

test('verifyAgeVerified reason order', (t) => {
  const v = verified()
  const other = otherChain()
  const stranger = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const revokedIssuers = new Set([ISSUER])

  // Each step only fails once every earlier one would pass.
  t.alike(verifyAgeVerified({ ...v, extra: 1 }, stranger, other.assoc, { revokedIssuers }), { ok: false, reason: 'malformed' })
  t.alike(verifyAgeVerified({ ...v, signature: flipHex(v.signature) }, stranger, other.assoc, { revokedIssuers }), { ok: false, reason: 'member-mismatch' })
  t.alike(verifyAgeVerified({ ...v, signature: flipHex(v.signature) }, MEMBER, other.assoc, { revokedIssuers }), { ok: false, reason: 'untrusted-association' })
  t.alike(verifyAgeVerified({ ...v, issuerSignature: flipHex(v.issuerSignature), signature: flipHex(v.signature) }, MEMBER, ASSOC, { revokedIssuers }), { ok: false, reason: 'bad-issuer-signature' })
  t.alike(verifyAgeVerified({ ...v, signature: flipHex(v.signature) }, MEMBER, ASSOC, { revokedIssuers }), { ok: false, reason: 'bad-signature' })
  t.alike(verifyAgeVerified(v, MEMBER, ASSOC, { revokedIssuers }), { ok: false, reason: 'revoked-issuer' })
  t.alike(verifyAgeVerified(v, MEMBER, ASSOC, { revokedIssuers: new Set([stranger]) }), { ok: true })
  t.alike(verifyAgeVerified(v, MEMBER, ASSOC, {}), { ok: true })
  t.alike(verifyAgeVerified(v, MEMBER, ASSOC, { revokedIssuers: [ISSUER] }), { ok: true }, 'no has method means none revoked')

  // The association argument must be hex64.
  t.alike(verifyAgeVerified(v, MEMBER, 'zz'), { ok: false, reason: 'malformed' })
  t.alike(verifyAgeVerified(v, MEMBER, null), { ok: false, reason: 'malformed' })
  t.alike(verifyAgeVerified(v, null, ASSOC), { ok: false, reason: 'member-mismatch' })
})

test('verifyAgeSince reason order', (t) => {
  const s = since()
  const other = otherChain()
  const revokedIssuers = new Set([ISSUER])
  t.alike(verifyAgeSince({ ...s, since: null }, other.assoc, { revokedIssuers }), { ok: false, reason: 'malformed' })
  t.alike(verifyAgeSince({ ...s, signature: flipHex(s.signature) }, other.assoc, { revokedIssuers }), { ok: false, reason: 'untrusted-association' })
  t.alike(verifyAgeSince({ ...s, issuerSignature: flipHex(s.issuerSignature), signature: flipHex(s.signature) }, ASSOC, { revokedIssuers }), { ok: false, reason: 'bad-issuer-signature' })
  t.alike(verifyAgeSince({ ...s, signature: flipHex(s.signature) }, ASSOC, { revokedIssuers }), { ok: false, reason: 'bad-signature' })
  t.alike(verifyAgeSince(s, ASSOC, { revokedIssuers }), { ok: false, reason: 'revoked-issuer' })
  t.alike(verifyAgeSince(s, ASSOC), { ok: true })
  t.alike(verifyAgeSince(s, 'zz'), { ok: false, reason: 'malformed' })

  // An attestation minted under another association's issuer never passes here.
  const foreign = createAgeSince({ since: '1970-01-01T00:00:00.000Z', date: SINCE_DATE }, other.issuerKp, other.issuerCert)
  t.alike(verifyAgeSince(foreign, other.assoc), { ok: true })
  t.alike(verifyAgeSince(foreign, ASSOC), { ok: false, reason: 'untrusted-association' })
  t.alike(verifyAgeSince({ ...foreign, association: ASSOC }, ASSOC), { ok: false, reason: 'bad-issuer-signature' })
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
          r = verifyAgeVerified(att, member, assoc)
        } catch (err) {
          t.fail('verifyAgeVerified threw: ' + err.message)
          continue
        }
        if (r.ok) t.fail('junk verified')
      }
    }
    for (const assoc of [ASSOC, null, 42, huge, [], {}]) {
      let r
      try {
        r = verifyAgeSince(att, assoc, { revokedIssuers: hostile })
      } catch (err) {
        t.fail('verifyAgeSince threw: ' + err.message)
        continue
      }
      if (r.ok) t.fail('junk verified')
    }
  }
  t.alike(verifyAgeVerified(), { ok: false, reason: 'malformed' })
  t.alike(verifyAgeSince(), { ok: false, reason: 'malformed' })
  t.alike(verifyAgeVerified(getter, MEMBER, ASSOC), { ok: false, reason: 'malformed' })
  t.alike(verifyAgeSince(s, ASSOC, hostile), { ok: false, reason: 'malformed' }, 'hostile options are caught')
  t.pass('no throw')
})

test('create* throw TypeError on bad inputs like createIssuedCert', (t) => {
  const other = otherChain()
  const stranger = crypto.keyPair()
  const badVerified = [
    () => createAgeVerified({ member: 'abc', date: DATE }, ISSUER_KP, ISSUER_CERT),
    () => createAgeVerified({ member: 'zz'.repeat(32), date: DATE }, ISSUER_KP, ISSUER_CERT),
    () => createAgeVerified({ member: MEMBER }, ISSUER_KP, ISSUER_CERT),
    () => createAgeVerified({ member: MEMBER, date: '2026-10-30T12:00:00Z' }, ISSUER_KP, ISSUER_CERT),
    () => createAgeVerified({ member: MEMBER, date: DATE }, null, ISSUER_CERT),
    () => createAgeVerified({ member: MEMBER, date: DATE }, { secretKey: b4a.alloc(32) }, ISSUER_CERT),
    () => createAgeVerified({ member: MEMBER, date: DATE }, stranger, ISSUER_CERT),
    () => createAgeVerified({ member: MEMBER, date: DATE }, ISSUER_KP, null),
    () => createAgeVerified({ member: MEMBER, date: DATE }, ISSUER_KP, { ...ISSUER_CERT, extra: 1 }),
    () => createAgeVerified({ member: MEMBER, date: DATE }, ISSUER_KP, { ...ISSUER_CERT, signature: flipHex(ISSUER_CERT.signature) }),
    () => createAgeVerified({ member: MEMBER, date: DATE }, ISSUER_KP, other.issuerCert),
    () => createAgeVerified(undefined, ISSUER_KP, ISSUER_CERT)
  ]
  for (const fn of badVerified) t.exception.all(fn, TypeError)
  const badSince = [
    () => createAgeSince({ date: SINCE_DATE }, ISSUER_KP, ISSUER_CERT),
    () => createAgeSince({ since: null, date: SINCE_DATE }, ISSUER_KP, ISSUER_CERT),
    () => createAgeSince({ since: '2026-10-29', date: SINCE_DATE }, ISSUER_KP, ISSUER_CERT),
    () => createAgeSince({ since: SINCE, date: 'now' }, ISSUER_KP, ISSUER_CERT),
    () => createAgeSince({ since: SINCE, date: SINCE_DATE }, stranger, ISSUER_CERT),
    () => createAgeSince({ since: SINCE, date: SINCE_DATE }, ISSUER_KP, other.issuerCert),
    () => createAgeSince({ since: SINCE, date: SINCE_DATE }, ISSUER_KP, { ...ISSUER_CERT, issuer: ASSOC }),
    () => createAgeSince(undefined, ISSUER_KP, ISSUER_CERT)
  ]
  for (const fn of badSince) t.exception.all(fn, TypeError)
})

test('the module is pure: only b4a, hypercore-crypto and ./cert, no network', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/age-proof.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'age-proof.js')).map(([id]) => id)
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
  const src = fs.readFileSync(path.join(coreRoot, 'lib', 'age-proof.js'), 'utf8')
  for (const word of ['#fs', '#path', '#process', 'process.', "require('fs')", "require('node:"]) {
    t.absent(src.includes(word), 'source does not mention ' + word)
  }
})
