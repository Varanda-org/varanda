'use strict'

// The key of a Hypercore 11 diary (docs/protocol.md section 1) is not its
// signer's public key but the hash of the default one-signer manifest of
// that key, so a verifier holding a signature by the signer needs this to
// tell whether the signer owns a diary key. It must load in the browser
// bundle and on Bare, so it reproduces hypercore 11.40.4 (lib/verifier.js
// manifestHash over Verifier.defaultSignerManifest, lib/caps.js,
// lib/messages.js) with b4a, compact-encoding and sodium-universal instead
// of requiring hypercore or corestore. The parity tests pin it to the
// installed Hypercore and to a real Corestore diary.
const b4a = require('b4a')
const c = require('compact-encoding')
const sodium = require('sodium-universal')

const HEX64 = /^[0-9a-f]{64}$/

// hypercore-crypto namespace('hypercore', 6), as lib/caps.js takes it:
// entry i is BLAKE2b-256(BLAKE2b-256('hypercore') || i).
function namespaceEntry (index) {
  const ns = b4a.alloc(33)
  sodium.crypto_generichash(ns.subarray(0, 32), b4a.from('hypercore', 'utf8'))
  ns[32] = index
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, ns)
  return out
}

const MANIFEST = namespaceEntry(3)
const DEFAULT_NAMESPACE = namespaceEntry(4)

function signerBytes (signer) {
  if (typeof signer === 'string') {
    if (!HEX64.test(signer)) throw new TypeError('signer must be 32 bytes or 64 lowercase hex characters')
    return b4a.from(signer, 'hex')
  }
  if (signer instanceof Uint8Array && signer.byteLength === 32) return signer
  throw new TypeError('signer must be 32 bytes or 64 lowercase hex characters')
}

// What manifestHash hashes: caps.MANIFEST, then the manifest as
// lib/messages.js encodes Verifier.defaultSignerManifest(signer).
function manifestSignable (publicKey) {
  const fields = [
    [c.fixed32, MANIFEST],
    [c.uint, 1], // manifest version
    [c.uint, 0], // flags: no patch, prologue, linked cores nor user data
    [c.uint, 0], // hash: blake2b
    [c.uint, 1], // quorum
    [c.uint, 1], // signer count
    [c.uint, 0], // signature: ed25519
    [c.fixed32, DEFAULT_NAMESPACE],
    [c.fixed32, publicKey]
  ]
  const state = c.state()
  for (const [enc, value] of fields) enc.preencode(state, value)
  state.buffer = b4a.alloc(state.end)
  for (const [enc, value] of fields) enc.encode(state, value)
  return state.buffer
}

// signer: a 32-byte public key or its 64 lowercase hex characters. Returns
// the 32-byte diary key; throws TypeError on anything else.
function diaryKeyOfSigner (signer) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, manifestSignable(signerBytes(signer)))
  return out
}

// True only for a manifest diary of that signer. A Hypercore 10 or browser
// diary, whose key IS the signer, is false here: a hash never maps a key to
// itself. Never throws.
function isDiaryOfSigner (keyHex, signerHex) {
  try {
    if (typeof keyHex !== 'string' || !HEX64.test(keyHex)) return false
    if (typeof signerHex !== 'string' || !HEX64.test(signerHex)) return false
    return b4a.toString(diaryKeyOfSigner(signerHex), 'hex') === keyHex
  } catch {
    return false
  }
}

module.exports = {
  diaryKeyOfSigner,
  isDiaryOfSigner
}
