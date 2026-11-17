'use strict'

// The `prove` admission message (issue #32): a member signs, with its diary
// key, a payload bound to its own Noise static public key, so a seeder can
// tell that this connection belongs to a member whose diary it serves and
// keep its slot when the table is full. Browser-safe: b4a and
// hypercore-crypto only; the Hypercore 11 manifest derivation is injected by
// the caller (`manifestKey`), never required here.
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')

const PEER_PROOF_PREFIX = 'varanda-peer-proof-v1\n'
// One diary may hold a few devices and reconnects in flight, but not more,
// so a leaked diary key cannot shield a flood of connections.
const MAX_PROOFS_PER_DIARY = 4

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

function isHex64 (s) {
  return typeof s === 'string' && HEX64.test(s)
}

function isHex128 (s) {
  return typeof s === 'string' && HEX128.test(s)
}

// noiseHex is the PROVER's own Noise static public key (what the verifier
// reads as socket.remotePublicKey), so a proof is useless on any other
// connection without the prover's Noise secret key.
function peerProofPayload (noiseHex, keyHex) {
  return b4a.from(PEER_PROOF_PREFIX + noiseHex + '\n' + keyHex, 'utf8')
}

function signPeerProof ({ noiseHex, keyHex, keyPair }) {
  if (!isHex64(noiseHex)) throw new TypeError('noiseHex must be 64 lowercase hex characters')
  if (!isHex64(keyHex)) throw new TypeError('keyHex must be 64 lowercase hex characters')
  const sig = hcrypto.sign(peerProofPayload(noiseHex, keyHex), keyPair.secretKey)
  return { key: keyHex, signer: b4a.toString(keyPair.publicKey, 'hex'), sig: b4a.toString(sig, 'hex') }
}

// The signer owns the key when the key IS the signer (a Hypercore 10 or
// browser diary) or is the signer's one-signer manifest hash (a Hypercore 11
// diary, via the injected manifestKey). Never throws.
function verifyPeerProof (proof, opts) {
  try {
    const manifestKey = opts !== null && typeof opts === 'object' ? opts.manifestKey : null
    if (proof === null || typeof proof !== 'object') return false
    const noiseHex = proof.noiseHex
    const key = proof.key
    const signer = proof.signer
    const sig = proof.sig
    if (!isHex64(noiseHex) || !isHex64(key) || !isHex64(signer) || !isHex128(sig)) return false
    const signerBuf = b4a.from(signer, 'hex')
    if (hcrypto.verify(peerProofPayload(noiseHex, key), b4a.from(sig, 'hex'), signerBuf) !== true) return false
    if (signer === key) return true
    if (typeof manifestKey !== 'function') return false
    const derived = manifestKey(signerBuf)
    if (!b4a.isBuffer(derived) || derived.byteLength !== 32) return false
    return b4a.toString(derived, 'hex') === key
  } catch {
    return false
  }
}

module.exports = {
  PEER_PROOF_PREFIX,
  MAX_PROOFS_PER_DIARY,
  peerProofPayload,
  signPeerProof,
  verifyPeerProof
}
