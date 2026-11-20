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
//
// Two more tiers serve the browser node and the native worklet, which turn
// them on; no other process pays for them:
// - digests (loadDigests): a BLAKE2b-256 digest of each triple that verified
//   (a domain tag, the key, the signature, then the message), kept across
//   restarts in the node's own storage, so a returning visit does not check
//   every followed diary's certificate again. Anything that can write that
//   storage already controls what the node shows.
// - warm: before a synchronous read, the signatures it will check are
//   verified with WebCrypto Ed25519 (native code, off the main thread),
//   where the platform has it. Only chains rooted at the association key are
//   warmed, each link only after the one before it verified, so every key
//   checked this way is the association or an issuer it signed for; and only
//   triples that pass the encoding checks libsodium makes before its own
//   check (canonical S, A and R, neither A nor R of small order). A triple
//   WebCrypto rejects, or one that fails those checks, is left to the real
//   check. No third party can make WebCrypto accept a triple libsodium
//   rejects under those keys: the remaining difference between the two
//   would need a signature made on purpose by the association's own keys.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const MAX_ENTRIES = 4096
const MAX_BYTES = 4 * 1024 * 1024 // message bytes kept, all entries
const MAX_DIGESTS = 4096
const WARM_PARALLEL = 16

const kept = new Map() // public key hex + signature hex -> message copy (oldest first)
let keptBytes = 0

const DIGEST_TAG = b4a.from('varanda verified v1')
const digests = new Set() // digest hex, oldest first
let digestsOn = false
const listeners = new Set()

function isBytes (x) {
  return x instanceof Uint8Array
}

function memoable (message, signature, publicKey) {
  return isBytes(message) && isBytes(signature) && isBytes(publicKey) &&
    signature.byteLength === 64 && publicKey.byteLength === 32
}

function idOf (signature, publicKey) {
  return b4a.toString(publicKey, 'hex') + b4a.toString(signature, 'hex')
}

function digestOf (message, signature, publicKey) {
  return b4a.toString(crypto.hash([DIGEST_TAG, publicKey, signature, message]), 'hex')
}

// true when this exact triple verified before (memo or digest), else the
// digest to record once it verifies (null while digests are off).
function known (id, message, signature, publicKey) {
  const seen = kept.get(id)
  if (seen !== undefined && b4a.equals(seen, message)) {
    // Most recently used last.
    kept.delete(id)
    kept.set(id, seen)
    return true
  }
  if (!digestsOn) return null
  const digest = digestOf(message, signature, publicKey)
  if (!digests.has(digest)) return digest
  digests.delete(digest)
  digests.add(digest)
  remember(id, message)
  return true
}

function verify (message, signature, publicKey) {
  if (!memoable(message, signature, publicKey)) return crypto.verify(message, signature, publicKey)
  const id = idOf(signature, publicKey)
  const digest = known(id, message, signature, publicKey)
  if (digest === true) return true
  const ok = crypto.verify(message, signature, publicKey)
  if (ok === true) verified(id, message, digest)
  return ok
}

function verified (id, message, digest) {
  remember(id, message)
  if (digest !== null && digestsOn) addDigest(digest)
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

function addDigest (digest) {
  if (digests.has(digest)) return
  digests.add(digest)
  while (digests.size > MAX_DIGESTS) digests.delete(digests.values().next().value)
  for (const fn of listeners) {
    try { fn() } catch {}
  }
}

// ---- digests kept across restarts ----

// Turns the digest tier on and adds the digests of `hex` (exportDigests
// output, oldest first; anything else adds nothing) -> how many were added.
function loadDigests (hex) {
  digestsOn = true
  if (typeof hex !== 'string' || hex.length % 64 !== 0 || !/^[0-9a-f]*$/.test(hex)) return 0
  // The loaded digests are older than any already in memory (checks made
  // while the stored list was read), so they go first and leave first.
  const kept = [...digests]
  digests.clear()
  for (let at = Math.max(0, hex.length - MAX_DIGESTS * 64); at < hex.length; at += 64) digests.add(hex.slice(at, at + 64))
  let added = digests.size
  for (const digest of kept) {
    if (digests.delete(digest)) added--
    digests.add(digest)
  }
  while (digests.size > MAX_DIGESTS) digests.delete(digests.values().next().value)
  return added
}

// The digests as one lowercase hex string, oldest first.
function exportDigests () {
  return [...digests].join('')
}

// fn() after each digest added by a verification -> unsubscribe.
function onDigest (fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Drops the digests and turns the tier off until the next loadDigests.
function clearDigests () {
  digests.clear()
  digestsOn = false
}

// ---- warm: WebCrypto ahead of a synchronous check ----

// Little-endian: the group order L, the field prime p.
const ORDER = b4a.from('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010', 'hex')
const PRIME = b4a.from('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex')
// The encodings of the points of small order (libsodium's list), sign bit
// cleared: 0, 1, the two of order 8 and the non-canonical p - 1, p, p + 1.
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
].map((h) => b4a.from(h, 'hex'))

// a < b, both 32-byte little-endian.
function lessThan (a, b) {
  for (let i = 31; i >= 0; i--) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return false
}

// A point encoding whose y (sign bit cleared) is below p and that is not of
// small order.
function goodPoint (bytes) {
  const y = b4a.from(bytes)
  y[31] &= 0x7f
  if (!lessThan(y, PRIME)) return false
  return !SMALL_ORDER.some((s) => b4a.equals(s, y))
}

function encodingOk (signature, publicKey) {
  return lessThan(signature.subarray(32, 64), ORDER) &&
    goodPoint(signature.subarray(0, 32)) && goodPoint(publicKey)
}

// RFC 8032 section 7.1, test 1 (the empty message).
const PROBE = {
  publicKey: b4a.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex'),
  signature: b4a.from('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b', 'hex'),
  message: b4a.alloc(0)
}
const ALGORITHM = { name: 'Ed25519' }

let support = null // Promise<subtle | null>
const importedKeys = new Map() // public key hex -> Promise<CryptoKey>
const inflight = new Map() // id -> { message, promise }

// The platform's SubtleCrypto when it verifies Ed25519 (a known good
// signature passes, the same one with a flipped bit fails), else null.
function ed25519Subtle () {
  if (support === null) support = probe(globalThis.crypto && globalThis.crypto.subtle)
  return support
}

async function probe (subtle) {
  try {
    if (!subtle || typeof subtle.importKey !== 'function' || typeof subtle.verify !== 'function') return null
    const key = await subtle.importKey('raw', PROBE.publicKey, ALGORITHM, false, ['verify'])
    const bad = b4a.from(PROBE.signature)
    bad[0] ^= 1
    const good = await subtle.verify(ALGORITHM, key, PROBE.signature, PROBE.message)
    const rejected = await subtle.verify(ALGORITHM, key, bad, PROBE.message)
    return good === true && rejected === false ? subtle : null
  } catch {
    return null
  }
}

function importKey (subtle, publicKey) {
  const hex = b4a.toString(publicKey, 'hex')
  let key = importedKeys.get(hex)
  if (key === undefined) {
    if (importedKeys.size >= 64) importedKeys.clear()
    key = subtle.importKey('raw', b4a.from(publicKey), ALGORITHM, false, ['verify'])
    importedKeys.set(hex, key)
  }
  return key
}

// true when the triple is now known good.
async function warmOne (subtle, { message, signature, publicKey }) {
  if (!memoable(message, signature, publicKey)) return false
  const id = idOf(signature, publicKey)
  const digest = known(id, message, signature, publicKey)
  if (digest === true) return true
  if (!encodingOk(signature, publicKey)) return false
  const running = inflight.get(id)
  if (running !== undefined && b4a.equals(running.message, message)) return running.promise
  const promise = (async () => {
    try {
      const key = await importKey(subtle, publicKey)
      if (await subtle.verify(ALGORITHM, key, signature, message) !== true) return false
      verified(id, message, digest)
      return true
    } catch {
      return false
    }
  })()
  inflight.set(id, { message, promise })
  try {
    return await promise
  } finally {
    if (inflight.get(id) !== undefined && inflight.get(id).promise === promise) inflight.delete(id)
  }
}

// Verifies ahead, with WebCrypto, the signatures a synchronous check is
// about to make (see the header). `chains` is a list of lists of
// { message, signature, publicKey } (Uint8Arrays), each list in check order
// with its first link signed by `rootKey`; anything else is skipped. Never
// throws and changes no answer: a warmed triple is one verify() would accept
// anyway. -> how many links are known good afterwards.
async function warm (chains, rootKey) {
  try {
    if (!Array.isArray(chains) || !isBytes(rootKey) || rootKey.byteLength !== 32) return 0
    const rooted = chains.filter((chain) => Array.isArray(chain) && chain.length > 0 &&
      chain[0] !== null && typeof chain[0] === 'object' && isBytes(chain[0].publicKey) && b4a.equals(chain[0].publicKey, rootKey))
    if (rooted.length === 0) return 0
    const subtle = await ed25519Subtle()
    if (subtle === null) return 0
    let good = 0
    let next = 0
    const worker = async () => {
      while (next < rooted.length) {
        for (const link of rooted[next++]) {
          if (link === null || typeof link !== 'object' || !(await warmOne(subtle, link))) break
          good++
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(WARM_PARALLEL, rooted.length) }, worker))
    return good
  } catch {
    return 0
  }
}

// ---- tests only ----

function memoSize () {
  return { entries: kept.size, bytes: keptBytes }
}

function clearMemo () {
  kept.clear()
  keptBytes = 0
}

// Replaces the platform's SubtleCrypto (null: none) for warm.
function useSubtle (subtle) {
  support = probe(subtle)
  importedKeys.clear()
  return support
}

module.exports = {
  verify,
  warm,
  loadDigests,
  exportDigests,
  onDigest,
  clearDigests,
  memoSize,
  clearMemo,
  useSubtle,
  MAX_ENTRIES,
  MAX_BYTES,
  MAX_DIGESTS
}
