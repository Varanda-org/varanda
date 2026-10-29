'use strict'

const crypto = require('node:crypto')

// Web Push from the account service with node:crypto only: VAPID (RFC 8292)
// and the aes128gcm message encryption (RFC 8291, RFC 8188). The browser push
// service only ever sees ciphertext. The endpoint allowlist below is the SSRF
// guard: a subscription is member input, so the service never POSTs to a host
// outside the known browser push services. Nothing here logs, retries or reads
// a response body.

const PUSH_ENDPOINT_HOSTS = Object.freeze(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'])
const PUSH_ENDPOINT_SUFFIXES = Object.freeze(['.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'])

const MAX_ENDPOINT = 2048
const RECORD_SIZE = 4096
// One record: 16-byte tag and the 0x02 delimiter leave 4078 bytes, and the
// header (86 bytes) shares the push services' 4096-byte message ceiling.
const MAX_PLAINTEXT = 3993
const MAX_JWT_TTL_S = 86400
const PUSH_TTL_S = 86400
const TOPIC_RE = /^[A-Za-z0-9_-]{1,32}$/
const IPV4_RE = /^[0-9.]+$/

function b64u (buf) {
  return Buffer.from(buf).toString('base64url')
}

function fromB64u (value, name, length) {
  const buf = Buffer.isBuffer(value) ? value : (typeof value === 'string' && /^[A-Za-z0-9_-]*$/.test(value) ? Buffer.from(value, 'base64url') : null)
  if (buf === null || (length !== undefined && buf.length !== length)) throw new TypeError(name + ' inválido')
  return buf
}

function generateVapidKeys () {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  const x = Buffer.from(jwk.x, 'base64url')
  const y = Buffer.from(jwk.y, 'base64url')
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([0x04]), x, y])),
    privateKey: b64u(Buffer.from(jwk.d, 'base64url'))
  }
}

function isAllowedEndpoint (url) {
  if (typeof url !== 'string' || url.length > MAX_ENDPOINT) return false
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.username !== '' || u.password !== '' || u.hash !== '') return false
  if (u.port !== '' && u.port !== '443') return false
  const host = u.hostname
  if (host.startsWith('[') || IPV4_RE.test(host)) return false
  if (PUSH_ENDPOINT_HOSTS.includes(host)) return true
  return PUSH_ENDPOINT_SUFFIXES.some((s) => host.length > s.length && host.endsWith(s))
}

function vapidPrivateKeyObject (publicKey, privateKey) {
  const pub = fromB64u(publicKey, 'chave pública VAPID', 65)
  const d = fromB64u(privateKey, 'chave privada VAPID', 32)
  if (pub[0] !== 0x04) throw new TypeError('chave pública VAPID inválida')
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: b64u(d) },
    format: 'jwk'
  })
}

function vapidAuthorization ({ endpoint, subject, publicKey, privateKey, now = Date.now(), ttlS = 43200 }) {
  if (!Number.isInteger(ttlS) || ttlS <= 0 || ttlS > MAX_JWT_TTL_S) throw new TypeError('ttlS inválido')
  if (typeof subject !== 'string' || !(subject.startsWith('https:') || subject.startsWith('mailto:'))) {
    throw new TypeError('subject VAPID inválido')
  }
  const aud = new URL(endpoint).origin
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + ttlS, sub: subject }))
  const signingInput = header + '.' + claims
  const key = vapidPrivateKeyObject(publicKey, privateKey)
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  return 'vapid t=' + signingInput + '.' + b64u(signature) + ', k=' + b64u(fromB64u(publicKey, 'chave pública VAPID', 65))
}

function hkdf (salt, ikm, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length))
}

function freshSenderKeyPair () {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  // getPrivateKey() drops leading zero bytes (about 1 key in 256), and the
  // scalar must be exactly 32 bytes.
  const d = ecdh.getPrivateKey()
  const privateKey = Buffer.concat([Buffer.alloc(32 - d.length), d])
  return { publicKey: ecdh.getPublicKey(), privateKey }
}

function encryptPayload ({ p256dh, auth, plaintext, salt = crypto.randomBytes(16), senderKeyPair = freshSenderKeyPair() }) {
  const uaPublic = fromB64u(p256dh, 'p256dh', 65)
  const authSecret = fromB64u(auth, 'auth', 16)
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')
  if (data.length > MAX_PLAINTEXT) throw new RangeError('mensagem grande demais')
  if (!Buffer.isBuffer(salt) || salt.length !== 16) throw new TypeError('salt inválido')

  const ecdh = crypto.createECDH('prime256v1')
  ecdh.setPrivateKey(fromB64u(senderKeyPair.privateKey, 'chave do remetente', 32))
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(authSecret, shared, keyInfo, 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(data), cipher.update(Buffer.from([0x02])), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, body])
}

async function sendPush ({ subscription, payload, vapid, topic, fetch = globalThis.fetch, timeoutMs = 10000, now = Date.now() }) {
  if (typeof payload !== 'string') throw new TypeError('payload inválido')
  if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) throw new TypeError('topic inválido')
  if (!subscription || !isAllowedEndpoint(subscription.endpoint)) return 'dropped'

  let body
  let authorization
  try {
    body = encryptPayload({ p256dh: subscription.p256dh, auth: subscription.auth, plaintext: payload })
    authorization = vapidAuthorization({ endpoint: subscription.endpoint, subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey, now })
  } catch {
    return 'dropped'
  }

  let res
  try {
    res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(PUSH_TTL_S),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Urgency: 'normal',
        Topic: topic,
        Authorization: authorization
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    return 'dropped'
  }
  // Release the connection without reading what the push service said.
  try {
    if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {})
  } catch {}
  if (res.status === 200 || res.status === 201) return 'ok'
  if (res.status === 404 || res.status === 410) return 'gone'
  return 'dropped'
}

module.exports = {
  PUSH_ENDPOINT_HOSTS,
  PUSH_ENDPOINT_SUFFIXES,
  MAX_PLAINTEXT,
  generateVapidKeys,
  isAllowedEndpoint,
  vapidAuthorization,
  encryptPayload,
  sendPush
}
