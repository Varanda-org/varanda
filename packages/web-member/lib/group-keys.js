'use strict'

// The browser node's private-group secrets, in memory only: this device's
// X25519 box key pair (derived from the passkey PRF and the kv
// 'groupBoxDevice' nonce, docs/protocol.md "Box keys") and the epoch keys
// opened from group-key records, by kid ({ writer, seq } of the epoch's
// first group-key block). Nothing here is ever written to storage: epoch
// keys are reopened in each session. lock(), signOut() and close() zero
// every buffer; a generation counter makes an unlock or a put that resolves
// after one of them drop what it would have installed.
const b4a = require('b4a')
const { UsageError } = require('@varanda/core/lib/errors')
const { KEY_BYTES } = require('@varanda/core/lib/group-crypto')
const { boxKeyPairFromPrf } = require('./passkey')
const store = require('./node-store')

const HEX64 = /^[0-9a-f]{64}$/
const KID = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/
const CLOSED = 'chaves de grupo encerradas'

function randomHex (n) {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return b4a.toString(out, 'hex')
}

function zero (buf) {
  if (buf instanceof Uint8Array) buf.fill(0)
}

function zeroPair (pair) {
  if (pair === null) return
  zero(pair.publicKey)
  zero(pair.secretKey)
}

// kid as a { writer, seq } ref or its 'writer:seq' string -> the canonical
// string, or null.
function kidString (kid) {
  if (typeof kid === 'string') return KID.test(kid) ? kid : null
  if (kid === null || typeof kid !== 'object') return null
  const { writer, seq } = kid
  if (typeof writer !== 'string' || !HEX64.test(writer)) return null
  if (!Number.isSafeInteger(seq) || seq < 0) return null
  return writer + ':' + seq
}

// opts.hkdf: the injected HKDF of passkey.js (the Bare worklet's).
// opts.randomHex: (bytes) -> hex, for the device nonce (tests).
function createGroupKeys ({ hkdf, randomHex: draw = randomHex } = {}) {
  let generation = 0
  let closed = false
  let box = null
  const epochs = new Map()

  function wipe () {
    zeroPair(box)
    box = null
    for (const key of epochs.values()) zero(key)
    epochs.clear()
  }

  function lock () {
    generation++
    wipe()
  }

  function close () {
    closed = true
    lock()
  }

  function current (token) {
    return !closed && token === generation
  }

  // Derives the box key pair for this storage (creating the device nonce on
  // first use) and installs it, replacing any previous pair and dropping
  // every epoch key (a new unlock may be another identity). The PRF is
  // copied synchronously, so the caller may zero it right away. -> the
  // public key (a fresh copy). Throws LOCKED when a lock, signOut, close or
  // a later unlock happened meanwhile; nothing is installed then.
  async function unlock (storage, prf) {
    if (closed) throw new UsageError(CLOSED)
    if (!(prf instanceof Uint8Array) || prf.byteLength !== 32) throw new TypeError('resultado PRF inválido')
    const prfCopy = new Uint8Array(prf)
    lock()
    const token = generation
    let pair = null
    try {
      const nonceHex = await store.ensureGroupBoxDevice(storage, draw(32))
      if (!current(token)) throw new UsageError(store.LOCKED)
      pair = await boxKeyPairFromPrf(prfCopy, b4a.from(nonceHex, 'hex'), { hkdf })
    } finally {
      prfCopy.fill(0)
    }
    if (!current(token)) {
      zeroPair(pair)
      throw new UsageError(store.LOCKED)
    }
    box = pair
    return new Uint8Array(pair.publicKey)
  }

  // A token for a group operation: put() with a stale one installs nothing.
  function token () {
    return generation
  }

  // The held pair (not a copy: never keep it past the operation), or null.
  function boxKeyPair () {
    return box
  }

  function boxPublicKey () {
    return box === null ? null : new Uint8Array(box.publicKey)
  }

  // Installs an epoch key opened under `tok` (token()). The key is copied;
  // the caller zeroes its own buffer. -> true when installed, false when a
  // lock, signOut, close or unlock came in between (nothing kept).
  function put (tok, kid, key) {
    const id = kidString(kid)
    if (id === null) throw new TypeError('kid inválido')
    if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) throw new TypeError('chave de época inválida')
    if (!current(tok) || box === null) return false
    const copy = new Uint8Array(key)
    const prev = epochs.get(id)
    if (prev !== undefined) zero(prev)
    epochs.set(id, copy)
    return true
  }

  // The held epoch key (not a copy: never keep it past the operation), or
  // null.
  function get (kid) {
    const id = kidString(kid)
    if (id === null) return null
    return epochs.get(id) || null
  }

  function has (kid) {
    return get(kid) !== null
  }

  return {
    unlock,
    lock,
    signOut: lock,
    close,
    token,
    boxKeyPair,
    boxPublicKey,
    put,
    get,
    has,
    get size () { return epochs.size },
    get unlocked () { return box !== null },
    get closed () { return closed }
  }
}

module.exports = { createGroupKeys, kidString }
