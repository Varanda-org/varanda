'use strict'

// Ed25519 verification (hypercore-crypto verify) with a bounded memo of the
// signatures that verified.
//
// Every read of the browser node checks the same signatures again: each
// followed diary's certificate and username record, the issuer delegation
// they embed, the stored blocklist snapshot (twice per read). The web bundle
// verifies in pure JavaScript (sodium-javascript: about 4 ms per signature
// on a desktop, several times that on a phone, against 0.07 ms native), so
// these checks were most of a feed.read or profile.read there.
//
// A signature check is a pure function of (message, signature, public key):
// remembering that an exact triple verified changes no answer. The memo is
// keyed by the public key and the signature, looked up only at their exact
// lengths (32 and 64 bytes, so two inputs never share a key), and holds a
// copy of the message, compared byte for byte. Only successes are kept: a
// failure always runs the real check (and throws as it does). Nothing else
// is remembered, so revocation, the association and the shapes are checked
// by the callers on every call.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const MAX_ENTRIES = 4096
const MAX_BYTES = 4 * 1024 * 1024 // message bytes kept, all entries

const kept = new Map() // public key hex + signature hex -> message copy (oldest first)
let keptBytes = 0

function isBytes (x) {
  return x instanceof Uint8Array
}

function verify (message, signature, publicKey) {
  const memo = isBytes(message) && isBytes(signature) && isBytes(publicKey) &&
    signature.byteLength === 64 && publicKey.byteLength === 32
  if (!memo) return crypto.verify(message, signature, publicKey)
  const id = b4a.toString(publicKey, 'hex') + b4a.toString(signature, 'hex')
  const seen = kept.get(id)
  if (seen !== undefined && b4a.equals(seen, message)) {
    // Most recently used last.
    kept.delete(id)
    kept.set(id, seen)
    return true
  }
  const ok = crypto.verify(message, signature, publicKey)
  if (ok === true) remember(id, message)
  return ok
}

function remember (id, message) {
  if (message.byteLength > MAX_BYTES) return
  const old = kept.get(id)
  if (old !== undefined) {
    kept.delete(id)
    keptBytes -= old.byteLength
  }
  const copy = b4a.alloc(message.byteLength)
  copy.set(message)
  kept.set(id, copy)
  keptBytes += copy.byteLength
  while (kept.size > MAX_ENTRIES || keptBytes > MAX_BYTES) {
    const [oldest, bytes] = kept.entries().next().value
    kept.delete(oldest)
    keptBytes -= bytes.byteLength
  }
}

// Tests only.
function memoSize () {
  return { entries: kept.size, bytes: keptBytes }
}

function clearMemo () {
  kept.clear()
  keptBytes = 0
}

module.exports = { verify, memoSize, clearMemo, MAX_ENTRIES, MAX_BYTES }
