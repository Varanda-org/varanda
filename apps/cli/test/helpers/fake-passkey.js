'use strict'

// A software passkey for the account service tests: an ES256 or RS256 key
// pair, the attestation object of its creation (fmt 'none') and assertions
// over any challenge, origin, flags and counter. Nothing here reaches a real
// authenticator.

const nodeCrypto = require('node:crypto')

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40

function head (major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n])
  if (n < 0x10000) {
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(n, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = (major << 5) | 26
  b.writeUInt32BE(n, 1)
  return b
}

// Map (insertion order), Buffer, string, integer or array -> CBOR bytes.
function cbor (value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8')
    return Buffer.concat([head(3, b.length), b])
  }
  if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)])
  if (value instanceof Map) {
    const parts = [head(5, value.size)]
    for (const [k, v] of value) parts.push(cbor(k), cbor(v))
    return Buffer.concat(parts)
  }
  throw new TypeError('cbor: unsupported value')
}

function sha256 (b) {
  return nodeCrypto.createHash('sha256').update(b).digest()
}

function createFakePasskey ({ rpId, alg = -7, credentialId = nodeCrypto.randomBytes(16), signCount = 0 } = {}) {
  const pair = alg === -7
    ? nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = pair.publicKey.export({ format: 'jwk' })
  const coseKey = alg === -7
    ? new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
    : new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]])
  let counter = signCount
  const id = Buffer.from(credentialId)

  function authData ({ flags, count, attested = false, rp = rpId, key = coseKey }) {
    const out = [sha256(Buffer.from(rp, 'utf8')), Buffer.from([flags | (attested ? AT : 0)])]
    const c = Buffer.alloc(4)
    c.writeUInt32BE(count, 0)
    out.push(c)
    if (attested) {
      const len = Buffer.alloc(2)
      len.writeUInt16BE(id.length, 0)
      out.push(Buffer.alloc(16), len, id, cbor(key))
    }
    return Buffer.concat(out)
  }

  // The creation's attestation object, base64url. Options alter what a real
  // authenticator would have produced, for the refusal tests.
  function attestationObject ({ rp = rpId, flags = UP | UV | BE | BS, key = coseKey, extraTop = false } = {}) {
    const top = new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData({ flags, count: counter, attested: true, rp, key })]])
    if (extraTop) top.set('x', 1)
    return cbor(top).toString('base64url')
  }

  // An assertion over `challenge` (Buffer). Each call moves the counter when
  // `step` > 0, as a device-bound authenticator does (synced ones stay at 0).
  function assert ({ challenge, origin, type = 'webauthn.get', flags = UP | UV | BE | BS, rp = rpId, step = 0, count, crossOrigin, topOrigin, signWith = null, tamper = null } = {}) {
    counter += step
    const cd = { type, challenge: challenge.toString('base64url'), origin }
    if (crossOrigin !== undefined) cd.crossOrigin = crossOrigin
    if (topOrigin !== undefined) cd.topOrigin = topOrigin
    const clientData = Buffer.from(JSON.stringify(cd), 'utf8')
    const ad = authData({ flags, count: count === undefined ? counter : count, rp })
    const data = Buffer.concat([ad, sha256(clientData)])
    const key = signWith || pair.privateKey
    const signature = alg === -7
      ? nodeCrypto.sign('sha256', data, { key, dsaEncoding: 'der' })
      : nodeCrypto.sign('sha256', data, { key, padding: nodeCrypto.constants.RSA_PKCS1_PADDING })
    const out = {
      credentialId: id.toString('base64url'),
      clientDataJSON: clientData.toString('base64url'),
      authenticatorData: ad.toString('base64url'),
      signature: signature.toString('base64url')
    }
    return tamper ? tamper(out) : out
  }

  return {
    alg,
    credentialId: id.toString('base64url'),
    privateKey: pair.privateKey,
    coseKey,
    attestationObject,
    assert
  }
}

module.exports = { createFakePasskey, cbor, UP, UV, BE, BS, AT }
