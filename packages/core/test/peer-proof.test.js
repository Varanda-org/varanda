'use strict'

// The `prove` message's signature (issue #32): bound to the prover's Noise
// key, owned by the signer either directly (Hypercore 10 / browser diary,
// key == public key) or through the Hypercore 11 one-signer manifest.
const test = require('brittle')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const Verifier = require('hypercore/lib/verifier')
const { tmpDir } = require('./helpers/tmp')
const {
  PEER_PROOF_PREFIX,
  MAX_PROOFS_PER_DIARY,
  peerProofPayload,
  signPeerProof,
  verifyPeerProof
} = require('../lib/peer-proof')

const hex = (b) => b4a.toString(b, 'hex')
const manifestKey = (pk) => Hypercore.key(Verifier.defaultSignerManifest(pk))

function flipHex (s, i) {
  const c = s[i] === '0' ? '1' : '0'
  return s.slice(0, i) + c + s.slice(i + 1)
}

test('constants and payload layout', (t) => {
  t.is(PEER_PROOF_PREFIX, 'varanda-peer-proof-v1\n')
  t.is(MAX_PROOFS_PER_DIARY, 4)
  const noise = 'aa'.repeat(32)
  const key = 'bb'.repeat(32)
  t.alike(peerProofPayload(noise, key), b4a.from('varanda-peer-proof-v1\n' + noise + '\n' + key, 'utf8'))
})

test('round trip with key == signer, and every tampering fails', (t) => {
  const keyPair = hcrypto.keyPair()
  const keyHex = hex(keyPair.publicKey)
  const noiseHex = hex(hcrypto.keyPair().publicKey)
  const proof = signPeerProof({ noiseHex, keyHex, keyPair })
  t.alike(Object.keys(proof).sort(), ['key', 'sig', 'signer'])
  t.is(proof.key, keyHex)
  t.is(proof.signer, keyHex)
  t.ok(/^[0-9a-f]{128}$/.test(proof.sig), 'sig is 128 lowercase hex')
  t.ok(verifyPeerProof({ noiseHex, ...proof }))
  t.ok(verifyPeerProof({ noiseHex, ...proof }, { manifestKey }), 'manifestKey is not needed but harmless')

  const otherNoise = hex(hcrypto.keyPair().publicKey)
  const otherKey = hex(hcrypto.keyPair().publicKey)
  t.absent(verifyPeerProof({ ...proof, noiseHex: otherNoise }), 'wrong noise key')
  t.absent(verifyPeerProof({ noiseHex, ...proof, key: otherKey }), 'wrong key')
  t.absent(verifyPeerProof({ noiseHex, ...proof, signer: otherKey }), 'wrong signer')
  t.absent(verifyPeerProof({ noiseHex, ...proof, sig: flipHex(proof.sig, 0) }), 'flipped first sig byte')
  t.absent(verifyPeerProof({ noiseHex, ...proof, sig: flipHex(proof.sig, 127) }), 'flipped last sig byte')
  t.absent(verifyPeerProof({ noiseHex, ...proof, sig: proof.sig.toUpperCase() }), 'uppercase sig')
  t.absent(verifyPeerProof({ noiseHex: noiseHex.toUpperCase(), ...proof }), 'uppercase noise')
  t.absent(verifyPeerProof({ noiseHex, ...proof, key: keyHex.toUpperCase(), signer: keyHex.toUpperCase() }), 'uppercase key and signer')

  // A proof signed by one key pair for another key is not ownership.
  const forged = signPeerProof({ noiseHex, keyHex: otherKey, keyPair })
  t.absent(verifyPeerProof({ noiseHex, ...forged }), 'signer does not own key')
  t.absent(verifyPeerProof({ noiseHex, ...forged }, { manifestKey }), 'not the signer manifest either')
})

test('malformed input and throwing getters return false', (t) => {
  const keyPair = hcrypto.keyPair()
  const keyHex = hex(keyPair.publicKey)
  const noiseHex = 'aa'.repeat(32)
  const proof = { noiseHex, ...signPeerProof({ noiseHex, keyHex, keyPair }) }
  t.ok(verifyPeerProof(proof))
  for (const bad of [null, undefined, 1, 'x', [], {}]) {
    t.absent(verifyPeerProof(bad), 'not a proof: ' + JSON.stringify(bad))
  }
  for (const field of ['noiseHex', 'key', 'signer', 'sig']) {
    for (const v of [undefined, null, 7, '', 'zz', proof[field].slice(2), proof[field] + 'aa', b4a.from(proof[field], 'hex')]) {
      t.absent(verifyPeerProof({ ...proof, [field]: v }), field + ' malformed')
    }
  }
  const throwing = Object.defineProperty({ ...proof }, 'sig', { get () { throw new Error('boom') } })
  t.absent(verifyPeerProof(throwing), 'getter that throws')
  const options = Object.defineProperty({}, 'manifestKey', { get () { throw new Error('boom') } })
  t.absent(verifyPeerProof(proof, options), 'options getter that throws')
  t.ok(verifyPeerProof(proof, null), 'null options: no manifestKey, key == signer still verifies')
})

test('Hypercore 11 diary: the manifest key proves ownership', async (t) => {
  const store = new Corestore(tmpDir(t))
  t.teardown(() => store.close())
  const core = store.get({ name: 'diary' })
  await core.ready()
  const keyHex = hex(core.key)
  const signerHex = hex(core.keyPair.publicKey)
  t.not(keyHex, signerHex, 'the diary key is a manifest hash, not the public key')
  t.is(hex(manifestKey(core.keyPair.publicKey)), keyHex, 'derivation matches the real core')

  const noiseHex = hex(hcrypto.keyPair().publicKey)
  const proof = signPeerProof({ noiseHex, keyHex, keyPair: core.keyPair })
  t.is(proof.signer, signerHex)
  t.ok(verifyPeerProof({ noiseHex, ...proof }, { manifestKey }), 'verifies with manifestKey')
  t.absent(verifyPeerProof({ noiseHex, ...proof }), 'fails without manifestKey')
  t.absent(verifyPeerProof({ noiseHex, ...proof }, { manifestKey: 'nope' }), 'fails with a non-function manifestKey')
  t.absent(verifyPeerProof({ noiseHex, ...proof }, { manifestKey: () => { throw new Error('boom') } }), 'fails when manifestKey throws')
  t.absent(verifyPeerProof({ noiseHex, ...proof }, { manifestKey: () => keyHex }), 'fails when manifestKey returns a string')

  const other = hcrypto.keyPair()
  const byOther = signPeerProof({ noiseHex, keyHex, keyPair: other })
  t.absent(verifyPeerProof({ noiseHex, ...byOther }, { manifestKey }), 'a different signer does not own the diary')
  t.absent(verifyPeerProof({ noiseHex, ...proof, signer: hex(other.publicKey) }, { manifestKey }), 'swapped signer fails the signature')
})

test('signPeerProof refuses malformed hex', (t) => {
  const keyPair = hcrypto.keyPair()
  t.exception.all(() => signPeerProof({ noiseHex: 'AA'.repeat(32), keyHex: hex(keyPair.publicKey), keyPair }), /noiseHex/)
  t.exception.all(() => signPeerProof({ noiseHex: 'aa'.repeat(32), keyHex: 'x', keyPair }), /keyHex/)
})
