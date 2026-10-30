// HKDF-SHA-256 (RFC 5869, extract then expand) over an injected HMAC, for
// runtimes whose WebCrypto has no HKDF deriveBits (bare-crypto offers only
// PBKDF2 there, but a Node-style createHmac). The caller supplies
// hmac(key, data) -> 32 bytes (sync or async); nothing here imports a
// runtime module, so the same code runs in Node, Bare and the browser.
// Every buffer allocated on the way (the PRK, each T block, the HMAC inputs
// and outputs) is zeroed before returning; the result is a fresh Uint8Array.

const HASH_BYTES = 32
const MAX_LENGTH = 255 * HASH_BYTES

function checkBytes (value, name) {
  if (!(value instanceof Uint8Array)) throw new TypeError('hkdf: ' + name + ' inválido')
}

// The HMAC output copied into memory this module owns, the original zeroed.
async function mac (hmac, key, data) {
  const raw = await hmac(key, data)
  if (!(raw instanceof Uint8Array) || raw.byteLength !== HASH_BYTES) {
    throw new TypeError('hkdf: hmac deve devolver 32 bytes')
  }
  const out = new Uint8Array(raw)
  try {
    raw.fill(0)
  } catch {}
  return out
}

async function hkdfSha256 (ikm, salt, info, length, { hmac } = {}) {
  checkBytes(ikm, 'ikm')
  checkBytes(salt, 'salt')
  checkBytes(info, 'info')
  if (!Number.isInteger(length) || length < 1 || length > MAX_LENGTH) {
    throw new RangeError('hkdf: comprimento inválido')
  }
  if (typeof hmac !== 'function') throw new TypeError('hkdf: hmac ausente')

  const okm = new Uint8Array(length)
  // An absent salt is HashLen zero bytes (RFC 5869 2.2); an empty HMAC key
  // pads to the same block, but say it explicitly.
  const saltKey = salt.byteLength === 0 ? new Uint8Array(HASH_BYTES) : salt
  let prk = null
  let t = new Uint8Array(0)
  const input = new Uint8Array(HASH_BYTES + info.byteLength + 1)
  try {
    prk = await mac(hmac, saltKey, ikm)
    let offset = 0
    for (let i = 1; offset < length; i++) {
      const tLen = t.byteLength
      input.set(t, 0)
      input.set(info, tLen)
      input[tLen + info.byteLength] = i
      const next = await mac(hmac, prk, input.subarray(0, tLen + info.byteLength + 1))
      t.fill(0)
      t = next
      const n = Math.min(HASH_BYTES, length - offset)
      okm.set(t.subarray(0, n), offset)
      offset += n
    }
    return okm
  } catch (err) {
    okm.fill(0)
    throw err
  } finally {
    if (prk !== null) prk.fill(0)
    t.fill(0)
    input.fill(0)
  }
}

module.exports = { hkdfSha256, HASH_BYTES, MAX_LENGTH }
