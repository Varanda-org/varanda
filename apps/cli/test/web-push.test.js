'use strict'

// apps/cli/lib/account/web-push.js: the RFC 8291 Appendix A vector, a
// round trip through a decryptor written here independently of the module,
// the VAPID JWT, the endpoint allowlist, and sendPush against a loopback
// node:http server. No socket leaves 127.0.0.1: the injected fetch rewrites an
// allowlisted push host to the loopback server, the allowlist itself is never
// widened.

const test = require('brittle')
const http = require('node:http')
const crypto = require('node:crypto')
const {
  PUSH_ENDPOINT_HOSTS,
  PUSH_ENDPOINT_SUFFIXES,
  generateVapidKeys,
  isAllowedEndpoint,
  vapidAuthorization,
  encryptPayload,
  sendPush
} = require('../lib/account/web-push')

// RFC 8291 Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  ciphertext: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
}

const SUBJECT = 'mailto:operador@example.test'

function publicOf (privateB64u) {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(privateB64u, 'base64url'))
  return ecdh.getPublicKey().toString('base64url')
}

// HKDF (RFC 5869) from HMAC, deliberately not crypto.hkdfSync, so the round
// trip does not share a derivation path with the module under test.
function hmac (key, data) {
  return crypto.createHmac('sha256', key).update(data).digest()
}

function hkdf (salt, ikm, info, length) {
  const prk = hmac(salt, ikm)
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length)
}

function decrypt (message, uaPrivate, authB64u) {
  const salt = message.subarray(0, 16)
  const rs = message.readUInt32BE(16)
  const idlen = message[20]
  const asPublic = message.subarray(21, 21 + idlen)
  const ciphertext = message.subarray(21 + idlen)
  const ua = crypto.createECDH('prime256v1')
  ua.setPrivateKey(uaPrivate)
  const shared = ua.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info'), Buffer.from([0]), ua.getPublicKey(), asPublic])
  const ikm = hkdf(Buffer.from(authB64u, 'base64url'), shared, keyInfo, 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\u0000'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\u0000'), 12)
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  // RFC 8188 section 2: strip trailing zero padding, then the delimiter.
  let end = padded.length - 1
  while (end > 0 && padded[end] === 0) end--
  return { rs, idlen, length: padded.length, delimiter: padded[end], plaintext: padded.subarray(0, end).toString('utf8') }
}

function subscriptionKeys () {
  const ua = crypto.createECDH('prime256v1')
  ua.generateKeys()
  return { uaPrivate: ua.getPrivateKey(), p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
}

test('RFC 8291 Appendix A: the published ciphertext byte for byte', (t) => {
  t.is(publicOf(RFC.asPrivate), RFC.asPublic, 'as key pair matches the RFC')
  t.is(publicOf(RFC.uaPrivate), RFC.uaPublic, 'ua key pair matches the RFC')
  const out = encryptPayload({
    p256dh: RFC.uaPublic,
    auth: RFC.auth,
    plaintext: RFC.plaintext,
    salt: Buffer.from(RFC.salt, 'base64url'),
    senderKeyPair: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate }
  })
  t.is(out.toString('base64url'), RFC.ciphertext)
  t.is(decrypt(out, Buffer.from(RFC.uaPrivate, 'base64url'), RFC.auth).plaintext, RFC.plaintext)
})

test('round trip through an independent decryptor for a random subscription', (t) => {
  const { uaPrivate, p256dh, auth } = subscriptionKeys()
  const text = 'Ana começou a seguir você'
  const out = encryptPayload({ p256dh, auth, plaintext: text })
  const got = decrypt(out, uaPrivate, auth)
  t.is(got.plaintext, text)
  t.is(got.rs, 4096)
  t.is(got.idlen, 65)
  t.is(got.delimiter, 0x02, 'single final record')
  t.not(encryptPayload({ p256dh, auth, plaintext: text }).equals(out), 'fresh salt and sender key each time')
})

test('fresh sender keys never fail on a short private scalar', (t) => {
  // About 1 generated scalar in 256 starts with a zero byte; 4096 runs miss
  // one with probability ~1e-7.
  const { uaPrivate, p256dh, auth } = subscriptionKeys()
  let failed = 0
  for (let i = 0; i < 4096; i++) {
    try {
      if (decrypt(encryptPayload({ p256dh, auth, plaintext: 'x' }), uaPrivate, auth).plaintext !== 'x') failed++
    } catch {
      failed++
    }
  }
  t.is(failed, 0)
})

test('encryptPayload refuses oversize plaintext and bad keys', (t) => {
  const { uaPrivate, p256dh, auth } = subscriptionKeys()
  const max = 'a'.repeat(3993)
  t.is(decrypt(encryptPayload({ p256dh, auth, plaintext: max }), uaPrivate, auth).plaintext, max)
  t.exception.all(() => encryptPayload({ p256dh, auth, plaintext: 'a'.repeat(3994) }))
  t.exception.all(() => encryptPayload({ p256dh: 'AAAA', auth, plaintext: 'x' }))
  t.exception.all(() => encryptPayload({ p256dh, auth: 'AAAA', plaintext: 'x' }))
})

test('encryptPayload padTo: zero padding after the delimiter, one ciphertext length for any text', (t) => {
  const { uaPrivate, p256dh, auth } = subscriptionKeys()
  const short = 'Ana curtiu seu post'
  const long = 'Maria Aparecida dos Santos Oliveira começou a seguir você'
  const a = encryptPayload({ p256dh, auth, plaintext: short, padTo: 1024 })
  const b = encryptPayload({ p256dh, auth, plaintext: long, padTo: 1024 })
  const got = decrypt(a, uaPrivate, auth)
  t.is(got.plaintext, short)
  t.is(got.delimiter, 0x02)
  t.is(got.length, 1024, 'plaintext, delimiter and padding fill padTo')
  t.is(decrypt(b, uaPrivate, auth).plaintext, long)
  t.is(a.length, b.length, 'same ciphertext length')
  t.is(a.length, 21 + 65 + 1024 + 16)
  t.is(encryptPayload({ p256dh, auth, plaintext: short, padTo: 0 }).length, 21 + 65 + Buffer.byteLength(short) + 1 + 16, 'padTo 0 adds nothing')
  t.is(decrypt(encryptPayload({ p256dh, auth, plaintext: 'x'.repeat(2000), padTo: 1024 }), uaPrivate, auth).plaintext, 'x'.repeat(2000), 'longer than padTo: sent unpadded')
  t.is(decrypt(encryptPayload({ p256dh, auth, plaintext: short, padTo: 4080 }), uaPrivate, auth).length, 4080, 'padTo up to one record')
  t.exception.all(() => encryptPayload({ p256dh, auth, plaintext: short, padTo: 4081 }), /padTo/)
  t.exception.all(() => encryptPayload({ p256dh, auth, plaintext: short, padTo: -1 }), /padTo/)
  t.exception.all(() => encryptPayload({ p256dh, auth, plaintext: short, padTo: 1.5 }), /padTo/)
})

test('generateVapidKeys: 65-byte uncompressed point and 32-byte scalar, unpadded base64url', (t) => {
  const { publicKey, privateKey } = generateVapidKeys()
  t.ok(/^[A-Za-z0-9_-]+$/.test(publicKey) && /^[A-Za-z0-9_-]+$/.test(privateKey))
  const pub = Buffer.from(publicKey, 'base64url')
  t.is(pub.length, 65)
  t.is(pub[0], 0x04)
  t.is(Buffer.from(privateKey, 'base64url').length, 32)
  t.is(publicOf(privateKey), publicKey, 'the pair belongs together')
})

test('vapidAuthorization: ES256 JWT verifies, aud/exp/sub right, ttl capped at 24 h', (t) => {
  const keys = generateVapidKeys()
  const now = 1761700000123
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def?x=1'
  const value = vapidAuthorization({ endpoint, subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey, now })
  const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(value)
  t.ok(m, 'header shape')
  t.is(m[4], keys.publicKey)
  t.alike(JSON.parse(Buffer.from(m[1], 'base64url')), { typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'))
  t.is(claims.aud, 'https://fcm.googleapis.com')
  t.is(claims.exp, Math.floor(now / 1000) + 43200)
  t.is(claims.sub, SUBJECT)

  const pub = Buffer.from(keys.publicKey, 'base64url')
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk'
  })
  const sig = Buffer.from(m[3], 'base64url')
  t.is(sig.length, 64, 'raw r||s signature')
  t.ok(crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key, dsaEncoding: 'ieee-p1363' }, sig))
  t.absent(crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2] + 'x'), { key, dsaEncoding: 'ieee-p1363' }, sig))

  const day = vapidAuthorization({ endpoint, subject: 'https://varanda.test', publicKey: keys.publicKey, privateKey: keys.privateKey, now, ttlS: 86400 })
  t.is(JSON.parse(Buffer.from(day.split('.')[1], 'base64url')).exp, Math.floor(now / 1000) + 86400)
  t.exception.all(() => vapidAuthorization({ endpoint, subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey, now, ttlS: 86401 }), /TypeError/)
  t.exception.all(() => vapidAuthorization({ endpoint, subject: 'http://varanda.test', publicKey: keys.publicKey, privateKey: keys.privateKey, now }), /TypeError/)
})

test('isAllowedEndpoint: only the known browser push services', (t) => {
  t.ok(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/abc'))
  t.ok(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'))
  t.ok(isAllowedEndpoint('https://web.push.apple.com/QAbc'))
  t.ok(isAllowedEndpoint('https://api.push.apple.com/abc'))
  t.ok(isAllowedEndpoint('https://wns2-db5p.notify.windows.com/w/?token=abc'))
  t.ok(isAllowedEndpoint('https://fcm.googleapis.com:443/fcm/send/abc'))
  t.ok(PUSH_ENDPOINT_HOSTS.every((h) => isAllowedEndpoint('https://' + h + '/x')))
  t.ok(Object.isFrozen(PUSH_ENDPOINT_HOSTS) && Object.isFrozen(PUSH_ENDPOINT_SUFFIXES))

  t.absent(isAllowedEndpoint('http://fcm.googleapis.com/fcm/send/abc'), 'http')
  t.absent(isAllowedEndpoint('https://127.0.0.1/x'), 'ipv4 literal')
  t.absent(isAllowedEndpoint('https://[::1]/x'), 'ipv6 literal')
  t.absent(isAllowedEndpoint('https://fcm.googleapis.com.evil.example/x'), 'lookalike suffix')
  t.absent(isAllowedEndpoint('https://evilpush.apple.com/x'), 'suffix without the dot')
  t.absent(isAllowedEndpoint('https://push.apple.com/x'), 'bare suffix')
  t.absent(isAllowedEndpoint('https://user:pw@fcm.googleapis.com/x'), 'credentials')
  t.absent(isAllowedEndpoint('https://user@fcm.googleapis.com/x'), 'username')
  t.absent(isAllowedEndpoint('https://fcm.googleapis.com/x#frag'), 'hash')
  t.absent(isAllowedEndpoint('https://fcm.googleapis.com:8443/x'), 'port 8443')
  t.absent(isAllowedEndpoint('https://fcm.googleapis.com/' + 'a'.repeat(2048)), 'too long')
  t.absent(isAllowedEndpoint('not a url'))
  t.absent(isAllowedEndpoint(null))
})

// Loopback push service: `handler(req, body, res)` may be replaced per test,
// `seen` records every request the server received.
async function fakePushService (t) {
  const seen = []
  const state = { handler: (req, body, res) => { res.writeHead(201); res.end() } }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      state.handler(req, body, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  const port = server.address().port
  const fetched = []
  // Only an allowlisted push host is ever rewritten, and only to loopback.
  const fetch = (url, init) => {
    const u = new URL(url)
    if (!PUSH_ENDPOINT_HOSTS.includes(u.hostname)) throw new Error('unexpected host ' + u.hostname)
    fetched.push(url)
    return globalThis.fetch('http://127.0.0.1:' + port + u.pathname + u.search, init)
  }
  return { seen, state, fetch, fetched, port }
}

function pushArgs (fetch, extra = {}) {
  const { uaPrivate, p256dh, auth } = subscriptionKeys()
  const vapid = { ...generateVapidKeys(), subject: SUBJECT }
  return {
    uaPrivate,
    args: {
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/sub-1', p256dh, auth },
      payload: 'Ana curtiu seu post',
      vapid,
      topic: 'curtida_1',
      fetch,
      ...extra
    }
  }
}

test('sendPush: 201 is ok, request carries the RFC 8030/8291/8292 headers and ciphertext', async (t) => {
  const svc = await fakePushService(t)
  const { uaPrivate, args } = pushArgs(svc.fetch)
  t.is(await sendPush(args), 'ok')
  t.is(svc.seen.length, 1)
  const req = svc.seen[0]
  t.is(req.method, 'POST')
  t.is(req.url, '/fcm/send/sub-1')
  t.is(req.headers.ttl, '86400')
  t.is(req.headers['content-encoding'], 'aes128gcm')
  t.is(req.headers['content-type'], 'application/octet-stream')
  t.is(req.headers.urgency, 'normal')
  t.is(req.headers.topic, 'curtida_1')
  t.ok(req.headers.authorization.startsWith('vapid t='))
  t.ok(req.headers.authorization.endsWith(', k=' + args.vapid.publicKey))
  t.is(decrypt(req.body, uaPrivate, args.subscription.auth).plaintext, 'Ana curtiu seu post')
})

test('sendPush: padTo reaches the encryption', async (t) => {
  const svc = await fakePushService(t)
  const { uaPrivate, args } = pushArgs(svc.fetch, { padTo: 1024 })
  t.is(await sendPush(args), 'ok')
  const got = decrypt(svc.seen[0].body, uaPrivate, args.subscription.auth)
  t.is(got.plaintext, 'Ana curtiu seu post')
  t.is(got.length, 1024)
})

test('sendPush: status classes', async (t) => {
  const svc = await fakePushService(t)
  const cases = [[200, 'ok'], [201, 'ok'], [404, 'gone'], [410, 'gone'], [429, 'dropped'], [500, 'dropped'], [503, 'dropped'], [400, 'dropped'], [413, 'dropped']]
  for (const [status, expected] of cases) {
    svc.state.handler = (req, body, res) => { res.writeHead(status); res.end('corpo que nunca é lido') }
    const { args } = pushArgs(svc.fetch)
    t.is(await sendPush(args), expected, String(status))
  }
  t.is(svc.seen.length, cases.length, 'one request each, never retried')
})

test('sendPush: a 302 is not followed', async (t) => {
  const svc = await fakePushService(t)
  svc.state.handler = (req, body, res) => {
    res.writeHead(302, { Location: 'http://127.0.0.1:' + svc.port + '/elsewhere' })
    res.end()
  }
  const { args } = pushArgs(svc.fetch)
  t.is(await sendPush(args), 'dropped')
  t.is(svc.seen.length, 1)
  t.is(svc.seen[0].url, '/fcm/send/sub-1', 'redirect target never requested')
})

test('sendPush: a slow push service is dropped on timeout', async (t) => {
  const svc = await fakePushService(t)
  svc.state.handler = () => {}
  const { args } = pushArgs(svc.fetch, { timeoutMs: 200 })
  const started = Date.now()
  t.is(await sendPush(args), 'dropped')
  t.ok(Date.now() - started < 5000)
  t.is(svc.seen.length, 1)
})

test('sendPush: a network error is dropped', async (t) => {
  const { args } = pushArgs(() => Promise.reject(new Error('ECONNREFUSED')))
  t.is(await sendPush(args), 'dropped')
})

test('sendPush: a disallowed endpoint is dropped without any request', async (t) => {
  let calls = 0
  const fetch = () => { calls++; throw new Error('must not be called') }
  for (const endpoint of ['https://127.0.0.1/x', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/x']) {
    const { args } = pushArgs(fetch)
    args.subscription.endpoint = endpoint
    t.is(await sendPush(args), 'dropped', endpoint)
  }
  t.is(calls, 0)
})

test('sendPush: bad subscription keys are dropped, bad topic or payload throw', async (t) => {
  let calls = 0
  const fetch = () => { calls++; return Promise.resolve(new Response(null, { status: 201 })) }
  const bad = pushArgs(fetch)
  bad.args.subscription.p256dh = 'AAAA'
  t.is(await sendPush(bad.args), 'dropped')
  t.is(calls, 0)
  await t.exception.all(sendPush({ ...pushArgs(fetch).args, topic: 'a'.repeat(33) }), /topic/)
  await t.exception.all(sendPush({ ...pushArgs(fetch).args, topic: 'com espaço' }), /topic/)
  await t.exception.all(sendPush({ ...pushArgs(fetch).args, payload: 42 }), /payload/)
})
