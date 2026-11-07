'use strict'

// apps/cli/lib/account/webauthn.js: the key from a creation's attestation
// object and the check of a fresh assertion against it, with a software
// passkey (./helpers/fake-passkey.js) for ES256 and RS256.

const test = require('brittle')
const nodeCrypto = require('node:crypto')
const {
  keyFromAttestation,
  attestationHash,
  verifyAssertion,
  passkeyOrigins,
  parseAuthData
} = require('../lib/account/webauthn')
const { createFakePasskey, cbor, UP, UV } = require('./helpers/fake-passkey')

const RP = 'varanda.test'
const ORIGIN = 'https://varanda.test'
const ORIGINS = [ORIGIN]

function enrolled (pk) {
  return keyFromAttestation({ attestationObject: pk.attestationObject(), credentialId: pk.credentialId, rpId: RP })
}

for (const alg of [-7, -257]) {
  test('webauthn ' + alg + ': the creation key verifies a fresh assertion over the challenge', (t) => {
    const pk = createFakePasskey({ rpId: RP, alg })
    const key = enrolled(pk)
    t.ok(key, 'key read from the attestation object')
    t.is(key.alg, alg)
    t.is(key.signCount, 0)
    t.ok(/^[0-9a-f]+$/.test(key.spki))
    const challenge = nodeCrypto.randomBytes(32)
    const r = verifyAssertion({ assertion: pk.assert({ challenge, origin: ORIGIN }), key, challenge, rpId: RP, origins: ORIGINS })
    t.alike(r, { ok: true, signCount: 0 })
  })
}

test('webauthn: every forged or mismatched assertion is refused with its reason', (t) => {
  const pk = createFakePasskey({ rpId: RP })
  const key = enrolled(pk)
  const challenge = nodeCrypto.randomBytes(32)
  const base = { key, challenge, rpId: RP, origins: ORIGINS }
  const check = (assertion) => verifyAssertion({ ...base, assertion })

  t.is(check(pk.assert({ challenge: nodeCrypto.randomBytes(32), origin: ORIGIN })).reason, 'desafio', 'another challenge')
  t.is(check(pk.assert({ challenge, origin: 'https://evil.test' })).reason, 'origem', 'another origin')
  t.is(check(pk.assert({ challenge, origin: ORIGIN, crossOrigin: true })).reason, 'origem', 'cross-origin iframe')
  t.is(check(pk.assert({ challenge, origin: ORIGIN, topOrigin: 'https://evil.test' })).reason, 'origem', 'a top origin')
  t.is(check(pk.assert({ challenge, origin: ORIGIN, type: 'webauthn.create' })).reason, 'tipo', 'a creation clientData')
  t.is(check(pk.assert({ challenge, origin: ORIGIN, rp: 'evil.test' })).reason, 'rp', 'another rpIdHash')
  t.is(check(pk.assert({ challenge, origin: ORIGIN, flags: UP })).reason, 'verificacao', 'no UV')
  t.is(check(pk.assert({ challenge, origin: ORIGIN, flags: UV })).reason, 'verificacao', 'no UP')
  const other = createFakePasskey({ rpId: RP })
  t.is(check(pk.assert({ challenge, origin: ORIGIN, signWith: other.privateKey })).reason, 'assinatura', 'signed by another key (a forged authenticator)')
  t.is(check(other.assert({ challenge, origin: ORIGIN })).reason, 'assinatura', 'a whole assertion of another passkey')
  t.is(check(pk.assert({
    challenge,
    origin: ORIGIN,
    tamper: (a) => {
      const ad = Buffer.from(a.authenticatorData, 'base64url')
      ad[36] ^= 1
      return { ...a, authenticatorData: ad.toString('base64url') }
    }
  })).reason, 'assinatura', 'authenticator data changed after signing')
  t.is(check(pk.assert({ challenge, origin: ORIGIN, tamper: (a) => ({ ...a, signature: 'AAAA' }) })).reason, 'assinatura', 'garbage signature')
  t.is(check(pk.assert({ challenge, origin: ORIGIN, tamper: (a) => ({ ...a, clientDataJSON: '!!' }) })).reason, 'forma', 'not base64url')
  t.is(check(pk.assert({ challenge, origin: ORIGIN, tamper: (a) => ({ ...a, clientDataJSON: Buffer.from('[1]').toString('base64url') }) })).reason, 'forma', 'clientData not an object')
  t.is(check(null).reason, 'forma')
  t.is(verifyAssertion({ ...base, key: { ...key, alg: -8 }, assertion: pk.assert({ challenge, origin: ORIGIN }) }).reason, 'forma', 'unknown algorithm')
})

test('webauthn: the counter must move once it ever moved; synced passkeys stay at 0', (t) => {
  const pk = createFakePasskey({ rpId: RP })
  const key = enrolled(pk)
  const challenge = nodeCrypto.randomBytes(32)
  const v = (assertion, k = key) => verifyAssertion({ assertion, key: k, challenge, rpId: RP, origins: ORIGINS })
  t.alike(v(pk.assert({ challenge, origin: ORIGIN })), { ok: true, signCount: 0 }, '0 then 0')
  t.alike(v(pk.assert({ challenge, origin: ORIGIN, count: 5 })), { ok: true, signCount: 5 }, '0 then 5')
  t.is(v(pk.assert({ challenge, origin: ORIGIN, count: 5 }), { ...key, signCount: 5 }).reason, 'contador', '5 then 5')
  t.is(v(pk.assert({ challenge, origin: ORIGIN, count: 4 }), { ...key, signCount: 5 }).reason, 'contador', '5 then 4 (a clone)')
  t.is(v(pk.assert({ challenge, origin: ORIGIN, count: 0 }), { ...key, signCount: 5 }).reason, 'contador', '5 then 0')
  t.alike(v(pk.assert({ challenge, origin: ORIGIN, count: 6 }), { ...key, signCount: 5 }), { ok: true, signCount: 6 })
})

test('webauthn: an attestation object for another rp, another credential, without UP or with a bad key is refused', (t) => {
  const pk = createFakePasskey({ rpId: RP })
  const att = pk.attestationObject()
  t.is(keyFromAttestation({ attestationObject: pk.attestationObject({ rp: 'evil.test' }), credentialId: pk.credentialId, rpId: RP }), null, 'another rpIdHash')
  t.is(keyFromAttestation({ attestationObject: att, credentialId: nodeCrypto.randomBytes(16).toString('base64url'), rpId: RP }), null, 'another credential id')
  t.is(keyFromAttestation({ attestationObject: pk.attestationObject({ flags: UV }), credentialId: pk.credentialId, rpId: RP }), null, 'no user presence')
  t.is(keyFromAttestation({ attestationObject: pk.attestationObject({ extraTop: true }), credentialId: pk.credentialId, rpId: RP }), null, 'an unknown top-level field')
  const offCurve = new Map(pk.coseKey)
  offCurve.set(-3, Buffer.alloc(32, 7))
  t.is(keyFromAttestation({ attestationObject: pk.attestationObject({ key: offCurve }), credentialId: pk.credentialId, rpId: RP }), null, 'a point off the curve')
  const ed = new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.alloc(32, 1)]])
  t.is(keyFromAttestation({ attestationObject: pk.attestationObject({ key: ed }), credentialId: pk.credentialId, rpId: RP }), null, 'an algorithm the app never asks for')
  t.is(keyFromAttestation({ attestationObject: att.slice(0, -4), credentialId: pk.credentialId, rpId: RP }), null, 'truncated')
  t.is(keyFromAttestation({ attestationObject: cbor(new Map([['fmt', 'none']])).toString('base64url'), credentialId: pk.credentialId, rpId: RP }), null, 'no authData')
  t.is(keyFromAttestation({ attestationObject: 'x'.repeat(4000), credentialId: pk.credentialId, rpId: RP }), null, 'over the size cap')
  t.is(keyFromAttestation({}), null)
})

test('webauthn: attestationHash is the SHA-256 of the decoded bytes', (t) => {
  const pk = createFakePasskey({ rpId: RP })
  const att = pk.attestationObject()
  t.is(attestationHash(att), nodeCrypto.createHash('sha256').update(Buffer.from(att, 'base64url')).digest('hex'))
  t.is(attestationHash('!!'), null)
})

test('webauthn: parseAuthData refuses trailing bytes and short data', (t) => {
  const pk = createFakePasskey({ rpId: RP })
  const a = pk.assert({ challenge: Buffer.alloc(32), origin: ORIGIN })
  const ad = Buffer.from(a.authenticatorData, 'base64url')
  t.ok(parseAuthData(ad))
  t.is(parseAuthData(Buffer.concat([ad, Buffer.from([0])])), null)
  t.is(parseAuthData(ad.subarray(0, 36)), null)
})

test('webauthn: passkeyOrigins derives the rpId and the Android origin from the deploy fingerprint', (t) => {
  t.alike(passkeyOrigins({ origin: 'https://bora.varanda.app' }), { rpId: 'bora.varanda.app', origins: ['https://bora.varanda.app'] })
  const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')
  const r = passkeyOrigins({ origin: 'https://bora.varanda.app', androidCertSha256: fp })
  t.is(r.origins[1], 'android:apk-key-hash:' + Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url'))
  t.exception.all(() => passkeyOrigins({ origin: 'https://bora.varanda.app', androidCertSha256: 'ab:cd' }), /fingerprint/)
  t.exception.all(() => passkeyOrigins({ origin: 'nope' }), /origin/)
})
