'use strict'

// Blind RSA stamps for direct messages (lib/dm-postage.js). No network.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('node:crypto')
const hcrypto = require('hypercore-crypto')
const postage = require('../lib/dm-postage')

const {
  representative, isUsableToken, newToken, blind, sign, unblind, verify,
  kidOf, publicKey, parsePublicKey, bigToBytes, toBase64, fromBase64, gcd, MODULUS_BYTES
} = postage

// Fixtures generate keys on the spot (AGENTS.md): one RSA-2048 key per run.
// node:crypto is the independent reference: its own MGF1 over SHA-256 and a
// raw RSA private operation (no padding) give the signature that the BigInt
// code must reproduce and verify.
function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

function referenceRep (token) {
  const seed = Buffer.concat([Buffer.from('varanda/dm-stamp-fdh/v1', 'utf8'), token])
  const blocks = []
  for (let i = 0; blocks.length * 32 < 256; i++) {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(i)
    blocks.push(crypto.createHash('sha256').update(Buffer.concat([seed, counter])).digest())
  }
  return Buffer.concat(blocks).subarray(0, 256)
}

function makeFixture () {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  const n = fromBase64url(jwk.n)
  for (;;) {
    const token = crypto.randomBytes(32)
    const rep = referenceRep(token)
    if (BigInt('0x' + rep.toString('hex')) >= n) continue
    const sig = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, rep)
    return { n, e: fromBase64url(jwk.e), d: fromBase64url(jwk.d), token, sig: sig.toString('base64') }
  }
}

const FIXTURE = makeFixture()
const N = FIXTURE.n
const E = FIXTURE.e
const D = FIXTURE.d
const PUB = publicKey(N, E)
const TOKEN = b4a.from(FIXTURE.token)

test('public key shape and kid', (t) => {
  t.alike(Object.keys(PUB), ['v', 'kid', 'n', 'e'])
  t.is(PUB.v, 1)
  t.is(PUB.n, N.toString(10))
  t.is(PUB.e, '65537')
  t.is(PUB.kid, b4a.toString(hcrypto.hash(b4a.from(N.toString(10), 'utf8')).subarray(0, 8), 'hex'))
  t.is(kidOf(N), PUB.kid)
  t.alike(parsePublicKey(PUB), { n: N, e: E })
  t.is(parsePublicKey({ ...PUB, kid: '0'.repeat(16) }), null, 'wrong kid')
  t.is(parsePublicKey({ ...PUB, e: '3' }), null, 'other exponent')
  t.is(parsePublicKey({ ...PUB, n: '0' + N.toString(10) }), null, 'non-canonical decimal')
  t.is(parsePublicKey({ ...PUB, extra: 1 }), null)
  const small = 3233n
  t.is(parsePublicKey(publicKey(small)), null, 'not 2048 bits')
  t.is(parsePublicKey(null), null)
})

test('the node:crypto reference verifies under BigInt', (t) => {
  const sig = fromBase64(FIXTURE.sig)
  t.ok(sig !== null)
  t.ok(verify(TOKEN, sig, PUB), 'BigInt signature')
  t.ok(verify(TOKEN, b4a.from(FIXTURE.sig, 'base64'), PUB), 'wire bytes')
  t.is(representative(TOKEN), BigInt('0x' + referenceRep(FIXTURE.token).toString('hex')), 'representative matches node:crypto MGF1')
  t.is(sign(representative(TOKEN), N, D), sig, 'BigInt sign matches node:crypto')
  const { blinded, r } = blind(representative(TOKEN), N, E)
  t.is(unblind(sign(blinded, N, D), r, N), sig, 'blind, sign, unblind gives the node:crypto signature')

  const flipped = b4a.from(FIXTURE.sig, 'base64')
  flipped[100] ^= 1
  t.absent(verify(TOKEN, flipped, PUB), 'flipped signature byte')
  const other = b4a.from(TOKEN)
  other[0] ^= 1
  t.absent(verify(other, sig, PUB), 'flipped token byte')
  t.absent(verify(TOKEN, sig, { ...PUB, kid: '0'.repeat(16) }))
  t.absent(verify(TOKEN, 0n, PUB))
  t.absent(verify(TOKEN, N, PUB), 'signature not below n')
  t.absent(verify(TOKEN, b4a.alloc(255), PUB))
  t.absent(verify(null, sig, PUB))
})

test('blind, sign, unblind, verify round trip', (t) => {
  const token = newToken(N)
  t.ok(isUsableToken(token, N))
  const rep = representative(token)
  const { blinded, r } = blind(rep, N, E)
  t.ok(r >= 1n && r < N && gcd(r, N) === 1n)
  t.not(blinded, rep, 'the signer never sees the representative')
  const blindSig = sign(blinded, N, D)
  const sig = unblind(blindSig, r, N)
  t.ok(verify(token, sig, PUB))
  t.ok(verify(token, bigToBytes(sig), PUB))
  t.absent(verify(newToken(N), sig, PUB), 'a stamp covers its own token only')
})

test('sign refuses values outside the group of units', (t) => {
  t.is(sign(0n, N, D), null)
  t.is(sign(N, N, D), null)
  t.is(sign(N + 5n, N, D), null)
  // Toy key n = 61 * 53: a multiple of a prime factor shares it with n.
  t.not(sign(33n, 3233n, 2753n), null)
  t.is(sign(61n, 3233n, 2753n), null, 'gcd with n is not 1')
  t.is(sign('1', N, D), null)
})

test('representative and usable tokens', (t) => {
  const rep = representative(TOKEN)
  t.ok(rep < 2n ** 2048n)
  t.is(rep, representative(b4a.from(TOKEN)), 'deterministic')
  t.not(rep, representative(b4a.alloc(32)))
  t.exception.all(() => representative(b4a.alloc(31)), TypeError)
  // A representative at or above n is unusable.
  t.absent(isUsableToken(TOKEN, rep))
  t.ok(isUsableToken(TOKEN, N))
  t.absent(isUsableToken(b4a.alloc(31), N))
})

test('canonical base64 wire integers', (t) => {
  const sig = fromBase64(FIXTURE.sig)
  t.is(toBase64(sig), FIXTURE.sig)
  t.is(toBase64(1n).length, FIXTURE.sig.length, 'fixed width')
  t.is(b4a.from(toBase64(1n), 'base64').byteLength, MODULUS_BYTES)
  t.is(fromBase64(toBase64(1n)), 1n)
  t.is(fromBase64(FIXTURE.sig.slice(0, -4)), null, 'short')
  t.is(fromBase64(FIXTURE.sig.replace(/==$/, 'w=')), null, 'non-canonical padding bits')
  t.is(fromBase64(FIXTURE.sig + '='), null)
  t.is(fromBase64('***'), null)
  t.is(fromBase64(null), null)
  t.exception.all(() => bigToBytes(2n ** 2048n), TypeError)
})
