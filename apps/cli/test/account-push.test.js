'use strict'

// apps/cli/lib/account/push-routes.js (mounted by server.js) and the
// push-key / status / export parts of apps/cli/lib/commands/account.js:
// the opt-in and opt-out of a browser subscription with a diary-key proof,
// the check route, and the seeder's /push-event relay. Loopback only: the
// members are linked in-process, the push service is an injected fetch (no
// request ever leaves the process) and Google is never reached.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { signPush } = require('@varanda/core/lib/push-proof')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPushStore } = require('../lib/account/push-store')
const { generateVapidKeys, sendPush } = require('../lib/account/web-push')
const { createPushRoutes } = require('../lib/account/push-routes')
const { createAccountServer } = require('../lib/account/server')
const { createPushKey, writeJsonExclusive } = require('../lib/commands/account')
const { tmpDir, until } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const ORIGIN = 'https://varanda.test'
const TOPIC_KEY = nodeCrypto.randomBytes(32)
const SUB = '1098765432109876543210'
const EMAIL = 'membro@example.test'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

const google = {
  authorizeUrl: () => { throw new Error('google called') },
  exchange: async () => { throw new Error('google called') }
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association, assoc }
}

function member () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

async function linkDirect (accounts, iss, m, username, sub = SUB, email = EMAIL) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub, email })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

// A browser subscription: the endpoint and the RFC 8291 keys, with the
// private half kept to decrypt what the injected push service receives.
function subscription (host = 'fcm.googleapis.com') {
  const ua = nodeCrypto.createECDH('prime256v1')
  ua.generateKeys()
  return {
    endpoint: 'https://' + host + '/fcm/send/' + nodeCrypto.randomBytes(16).toString('hex'),
    p256dh: ua.getPublicKey().toString('base64url'),
    auth: nodeCrypto.randomBytes(16).toString('base64url'),
    uaPrivate: ua.getPrivateKey()
  }
}

// RFC 8291 decryption written here, independently of web-push.js.
function decrypt (message, uaPrivate, authB64u) {
  const hmac = (key, data) => nodeCrypto.createHmac('sha256', key).update(data).digest()
  const hkdf = (salt, ikm, info, length) => hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length)
  const salt = message.subarray(0, 16)
  const idlen = message[20]
  const asPublic = message.subarray(21, 21 + idlen)
  const ciphertext = message.subarray(21 + idlen)
  const ua = nodeCrypto.createECDH('prime256v1')
  ua.setPrivateKey(uaPrivate)
  const shared = ua.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\u0000'), ua.getPublicKey(), asPublic])
  const ikm = hkdf(Buffer.from(authB64u, 'base64url'), shared, keyInfo, 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\u0000'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\u0000'), 12)
  const decipher = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  // RFC 8188 section 2: strip trailing zero padding, then the 0x02 delimiter.
  let end = padded.length - 1
  while (end > 0 && padded[end] === 0) end--
  if (padded[end] !== 0x02) throw new Error('bad delimiter')
  return padded.subarray(0, end).toString('utf8')
}

const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest()

// A service with `m` linked as 'ana' and `actor` linked as 'bia', a terms
// store and a push store on the same dir, and an injected push service.
// `vapid: false` runs without a key, `token: false` without a relay token,
// `push: false` without the push option at all.
async function setup (t, { vapid = true, token = true, push = true, send = null } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const c = { offset: 0 }
  c.now = () => Date.now() + c.offset
  const iss = issuer()
  const store = openAccountStore(dir, { now: c.now })
  const m = member()
  const actor = member()
  await linkDirect(store, iss, m, 'ana')
  await linkDirect(store, iss, actor, 'bia', '2222222222222222222222', 'bia@example.test')
  const terms = openTermsStore(dir, { now: c.now })
  const pushStore = openPushStore(dir, { now: c.now })
  const keys = vapid ? generateVapidKeys() : null
  const relayToken = nodeCrypto.randomBytes(32).toString('hex')
  // What the push service received, and the status it answers per endpoint.
  const delivered = []
  const statusOf = new Map()
  const fakeFetch = async (url, init) => {
    delivered.push({ url, headers: init.headers, body: init.body })
    return { status: statusOf.get(url) ?? 201, body: null }
  }
  const logs = []
  const texts = []
  const secrets = []
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google,
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    terms,
    push: push
      ? {
          pushStore,
          vapid: keys === null ? null : { ...keys, subject: ORIGIN },
          send: send ?? ((args) => sendPush({ ...args, fetch: fakeFetch, now: c.now() })),
          relayTokenHash: token ? sha256(relayToken) : null,
          topicKey: TOPIC_KEY
        }
      : null,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port
  if (keys !== null) secrets.push(keys.privateKey, keys.publicKey)
  secrets.push(relayToken)

  async function request (method, pathname, body, headers = {}) {
    const init = { method, headers }
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    texts.push(text)
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }

  function post (pathname, body, { origin = ORIGIN, type = 'application/json' } = {}) {
    const headers = { 'content-type': type }
    if (origin !== null) headers.origin = origin
    return request('POST', pathname, body, headers)
  }

  const start = (who, action) => post('/account/push/start', { member: who.hex, action })
  function sign (who, nonce, action, sub) {
    const { endpointHash } = require('@varanda/core/lib/push-proof')
    const signature = signPush({ nonce, member: who.hex, association: iss.association, action, endpointHash: endpointHash(sub.endpoint), p256dh: sub.p256dh, auth: sub.auth }, who.kp)
    secrets.push(nonce, signature)
    return signature
  }
  const finish = (who, nonce, action, sub, signature) =>
    post('/account/push/finish', { member: who.hex, nonce, action, signature, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
  // start -> sign -> finish for `who` and `sub`.
  async function toggle (who, action, sub) {
    const started = await start(who, action)
    if (started.status !== 200) return started
    return finish(who, started.body.nonce, action, sub, sign(who, started.body.nonce, action, sub))
  }
  // The endpoint and both keys of `sub`; `over` replaces or drops fields.
  function check (who, sub, over = {}) {
    const body = { member: who.hex, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, ...over }
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k]
    return post('/account/push/check', body)
  }
  const acceptTerms = (who, version = TERMS_VERSION) =>
    terms.accept({ member: who.hex, version, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })

  function relay (event, { auth = 'Bearer ' + relayToken, origin = null, type = 'application/json' } = {}) {
    const headers = { 'content-type': type }
    if (auth !== null) headers.authorization = auth
    if (origin !== null) headers.origin = origin
    return request('POST', '/push-event', event, headers)
  }
  let seq = 0
  const like = (from, to, extra = {}) => ({
    v: 1,
    kind: 'like',
    actor: from.hex,
    recipient: to.hex,
    seq: ++seq,
    ref: to.hex + ':' + 7,
    name: 'Bia Souza',
    ...extra
  })

  return { dir, c, iss, store, terms, pushStore, keys, relayToken, delivered, statusOf, logs, texts, secrets, listener, server, m, actor, request, post, start, sign, finish, toggle, check, acceptTerms, relay, like }
}

// No endpoint, key, nonce, signature, token or notice text in any log line.
function cleanLogs (t, s, endpoints = []) {
  const all = s.logs.join('\n')
  for (const secret of [...s.secrets, ...endpoints]) t.absent(all.includes(secret), 'a secret or an endpoint in the logs')
  t.absent(all.includes('curtiu'), 'no notice text in the logs')
  t.absent(all.includes('Bia Souza'), 'no actor name in the logs')
  t.absent(all.includes(EMAIL), 'no e-mail in the logs')
  for (const line of s.logs) {
    const e = JSON.parse(line)
    t.ok(Object.keys(e).every((k) => k === 'event' || k === 'reason'), 'only event and reason: ' + line)
  }
}

test('push key: 503 without a VAPID key, 200 with one; no push option mounts nothing', async (t) => {
  const off = await setup(t, { vapid: false })
  const r = await off.request('GET', '/account/push/key')
  t.is(r.status, 503)
  t.alike(r.body, { error: 'indisponivel' })
  const startOff = await off.start(off.m, 'on')
  t.is(startOff.status, 503, 'turning on needs the key')

  const on = await setup(t)
  const res = await fetch('http://127.0.0.1:' + on.listener.port + '/account/push/key')
  t.is(res.status, 200)
  t.is(res.headers.get('cache-control'), 'no-store')
  t.alike(await res.json(), { key: on.keys.publicKey })
  on.pushStore.fail()
  t.is((await on.request('GET', '/account/push/key')).status, 503, 'an unavailable store hides the key')

  const none = await setup(t, { push: false })
  t.is((await none.request('GET', '/account/push/key')).status, 404)
  t.is((await none.relay(none.like(none.actor, none.m))).status, 404)
})

test('push: on and off with a real proof; check follows the stored row', async (t) => {
  const s = await setup(t)
  const sub = subscription()
  await s.acceptTerms(s.m)

  const started = await s.start(s.m, 'on')
  t.is(started.status, 200, started.text)
  t.alike(Object.keys(started.body), ['nonce'])
  t.ok(TOKEN_RE.test(started.body.nonce))
  const on = await s.finish(s.m, started.body.nonce, 'on', sub, s.sign(s.m, started.body.nonce, 'on', sub))
  t.is(on.status, 200, on.text)
  t.alike(on.body, { ok: true, changed: true })
  t.absent(on.text.includes(sub.endpoint), 'the endpoint is never echoed')
  t.alike(s.pushStore.list(s.m.hex), [{ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }])

  const again = await s.toggle(s.m, 'on', sub)
  t.alike(again.body, { ok: true, changed: false }, 'same subscription again')
  t.alike((await s.check(s.m, sub)).body, { registered: true })
  t.alike((await s.check(s.m, subscription())).body, { registered: false }, 'unknown endpoint')
  t.alike((await s.check(s.actor, sub)).body, { registered: false }, 'another member')

  const off = await s.toggle(s.m, 'off', sub)
  t.is(off.status, 200, off.text)
  t.alike(off.body, { ok: true, changed: true })
  t.alike(s.pushStore.list(s.m.hex), [])
  t.alike((await s.check(s.m, sub)).body, { registered: false })
  t.alike((await s.toggle(s.m, 'off', sub)).body, { ok: true, changed: false })
  for (const text of s.texts) t.absent(text.includes(sub.endpoint), 'no endpoint in any answer')
  cleanLogs(t, s, [sub.endpoint])
})

test('push check: registered only with the stored endpoint and both keys', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  const sub = subscription()
  t.alike((await s.toggle(s.m, 'on', sub)).body, { ok: true, changed: true })
  const other = subscription()
  t.alike((await s.check(s.m, sub)).body, { registered: true }, 'all three right')
  // What a push service knows: the endpoint it issued, never the keys.
  t.alike((await s.check(s.m, sub, { p256dh: other.p256dh })).body, { registered: false }, 'wrong p256dh')
  t.alike((await s.check(s.m, sub, { auth: other.auth })).body, { registered: false }, 'wrong auth')
  t.alike((await s.check(s.m, sub, { p256dh: other.p256dh, auth: other.auth })).body, { registered: false }, 'both wrong')
  for (const over of [{ p256dh: undefined }, { auth: undefined }, { p256dh: undefined, auth: undefined }, { p256dh: 'x' }, { auth: 'x' }, { auth: 5 }]) {
    const r = await s.check(s.m, sub, over)
    t.is(r.status, 400, JSON.stringify(over))
    t.alike(r.body, { error: 'pedido-invalido' })
  }
  for (const text of s.texts) t.absent(text.includes(sub.endpoint), 'no endpoint in any answer')
  cleanLogs(t, s, [sub.endpoint])
})

test('push: nonce reuse, wrong action, other member, bad endpoints and missing v3 acceptance are refused', async (t) => {
  const s = await setup(t)
  const sub = subscription()

  // Missing acceptance of the current terms: an older version does not count.
  await s.acceptTerms(s.m, 1)
  const pending = await s.toggle(s.m, 'on', sub)
  t.is(pending.status, 409, pending.text)
  t.alike(pending.body, { error: 'termos-pendentes' })
  t.alike(s.pushStore.list(s.m.hex), [], 'nothing stored before consent')
  // Turning off needs no acceptance.
  const offWithout = await s.toggle(s.m, 'off', sub)
  t.is(offWithout.status, 200, offWithout.text)
  t.alike(offWithout.body, { ok: true, changed: false })
  await s.acceptTerms(s.m)

  // Single-use.
  const a = await s.start(s.m, 'on')
  const sig = s.sign(s.m, a.body.nonce, 'on', sub)
  t.is((await s.finish(s.m, a.body.nonce, 'on', sub, sig)).status, 200)
  const replay = await s.finish(s.m, a.body.nonce, 'on', sub, sig)
  t.is(replay.status, 404)
  t.alike(replay.body, { error: 'expirado' })

  // A nonce for 'on' presented as 'off', even with a valid 'off' proof.
  const b = await s.start(s.m, 'on')
  const wrongAction = await s.finish(s.m, b.body.nonce, 'off', sub, s.sign(s.m, b.body.nonce, 'off', sub))
  t.is(wrongAction.status, 404)
  t.alike(wrongAction.body, { error: 'expirado' })
  t.alike(s.pushStore.list(s.m.hex).length, 1, 'still on')

  // Issued to m, presented by another member with its own proof; spent.
  const c = await s.start(s.m, 'on')
  const stolen = await s.finish(s.actor, c.body.nonce, 'on', sub, s.sign(s.actor, c.body.nonce, 'on', sub))
  t.alike(stolen.body, { error: 'expirado' })
  const late = await s.finish(s.m, c.body.nonce, 'on', sub, s.sign(s.m, c.body.nonce, 'on', sub))
  t.alike(late.body, { error: 'expirado' }, 'spent by the other attempt')

  // TTL.
  const d = await s.start(s.m, 'on')
  s.c.offset += 600 * 1000
  t.alike((await s.finish(s.m, d.body.nonce, 'on', sub, s.sign(s.m, d.body.nonce, 'on', sub))).body, { error: 'expirado' })

  // A proof over another subscription.
  const e = await s.start(s.m, 'on')
  const other = subscription()
  const swapped = await s.finish(s.m, e.body.nonce, 'on', sub, s.sign(s.m, e.body.nonce, 'on', other))
  t.is(swapped.status, 400)
  t.alike(swapped.body, { error: 'assinatura-invalida' })

  // http, an unlisted host, and non-canonical spellings of a listed one.
  const http = { ...subscription(), endpoint: 'http://fcm.googleapis.com/fcm/send/abc' }
  const httpStart = await s.start(s.m, 'on')
  const httpRes = await s.finish(s.m, httpStart.body.nonce, 'on', http, 'a'.repeat(128))
  t.alike(httpRes.body, { error: 'pedido-invalido' }, 'http endpoint')
  t.alike((await s.toggle(s.m, 'on', subscription('push.example.test'))).body, { error: 'pedido-invalido' }, 'unlisted host')
  const base = subscription()
  const path0 = new URL(base.endpoint).pathname
  for (const spelling of [
    'https://fcm.googleapis.com:443' + path0,
    'https://FCM.googleapis.com' + path0,
    'https://fcm.googleapis.com/fcm/./send/' + path0.split('/').pop(),
    'https://fcm.googleapis.com\\fcm/send/' + path0.split('/').pop()
  ]) {
    const odd = { ...base, endpoint: spelling }
    const n = await s.start(s.m, 'on')
    const r = await s.finish(s.m, n.body.nonce, 'on', odd, 'a'.repeat(128))
    t.alike(r.body, { error: 'pedido-invalido' }, 'non-canonical ' + JSON.stringify(spelling))
    const offN = await s.start(s.m, 'off')
    t.alike((await s.finish(s.m, offN.body.nonce, 'off', odd, 'a'.repeat(128))).body, { error: 'pedido-invalido' }, 'off too')
    t.alike((await s.check(s.m, odd)).body, { error: 'pedido-invalido' }, 'check too')
  }

  // Unlinked members, bad actions, Origin.
  t.alike((await s.start(member(), 'on')).body, { error: 'nao-vinculado' })
  t.alike((await s.start(s.m, 'maybe')).body, { error: 'pedido-invalido' })
  t.is((await s.post('/account/push/start', { member: s.m.hex, action: 'on' }, { origin: null })).status, 403)
  t.is((await s.post('/account/push/check', { member: s.m.hex, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, { origin: 'https://evil.test' })).status, 403)
  t.is((await s.post('/account/push/start', { member: s.m.hex, action: 'on' }, { type: 'text/plain' })).status, 400)
  cleanLogs(t, s, [sub.endpoint])
})

test('push check: refuses an unlisted host and is rate-limited per member', async (t) => {
  const s = await setup(t)
  const unlisted = await s.check(s.m, subscription('push.example.test'))
  t.is(unlisted.status, 400)
  t.alike(unlisted.body, { error: 'pedido-invalido' })
  const sub = subscription()
  for (let i = 0; i < 30; i++) {
    const r = await s.check(s.m, sub)
    t.is(r.status, 200, 'check ' + (i + 1))
  }
  const over = await s.check(s.m, sub)
  t.is(over.status, 429)
  t.is((await s.check(s.actor, sub)).status, 200, 'another member has its own window')
  s.c.offset += 600 * 1000
  t.is((await s.check(s.m, sub)).status, 200, 'the window restarts')
})

test('push check: checks with a guessed endpoint never drain the window of the real one', async (t) => {
  const s = await setup(t)
  // Anyone knows the member key, not the browser's endpoint.
  for (let i = 0; i < 30; i++) await s.check(s.m, subscription())
  const guessed = subscription()
  for (let i = 0; i < 30; i++) await s.check(s.m, guessed)
  t.is((await s.check(s.m, guessed)).status, 429, 'the guessed endpoint has its own window')
  t.is((await s.check(s.m, subscription())).status, 200, 'the real endpoint still answers')
})

// A request double whose header reads and body reads are recorded.
function spyRequest (headers) {
  const read = []
  const req = {
    method: 'POST',
    headers: new Proxy(headers, { get (target, key) { read.push(key); return target[key] } }),
    socket: { destroy () {} },
    on (name) { read.push('on:' + name); return req },
    once (name) { read.push('once:' + name); return req }
  }
  return { req, read }
}

function spyResponse () {
  const out = { headers: {}, sent: null }
  out.res = {
    setHeader (k, v) { out.headers[k] = v },
    once () {}
  }
  return out
}

function routes (relayTokenHash, extra = {}) {
  const errors = []
  const http = {
    send: () => { throw new Error('answered') },
    sendError: (res, err) => errors.push(err),
    readJsonBody: () => { throw new Error('body read') },
    checkPost: () => {},
    RouteError: Error,
    refuse: (token) => ({ token, status: 404 }),
    fromStore: (e) => e,
    keyedWindow: () => () => true
  }
  const r = createPushRoutes({ association: '0'.repeat(64), accounts: { status: () => ({ linked: false }) }, relayTokenHash, http, ...extra })
  return { r, errors }
}

test('relay: without a token nothing is read; a wrong token or an Origin never reads the body', async (t) => {
  const none = routes(null)
  const a = spyRequest({ authorization: 'Bearer x', 'content-type': 'application/json' })
  const ra = spyResponse()
  await none.r.handleRelay(a.req, ra.res)
  t.alike(none.errors.map((e) => e.token), ['nao-encontrado'])
  t.absent(a.read.includes('authorization'), 'Authorization unread without a token')
  t.absent(a.read.some((k) => typeof k === 'string' && k.startsWith('on:')), 'body unread')
  t.is(ra.headers.Connection, 'close')

  const token = 'cd'.repeat(32)
  const gated = routes(sha256(token))
  for (const headers of [
    { authorization: 'Bearer ' + 'ab'.repeat(32), 'content-type': 'application/json' },
    { 'content-type': 'application/json' },
    { authorization: 'Bearer ' + token, origin: ORIGIN, 'content-type': 'application/json' }
  ]) {
    const b = spyRequest(headers)
    await gated.r.handleRelay(b.req, spyResponse().res)
    t.absent(b.read.some((k) => typeof k === 'string' && k.startsWith('on:')), 'body unread')
  }
  t.alike(gated.errors.map((e) => e.token), ['nao-encontrado', 'nao-encontrado', 'nao-encontrado'])

  // And over the real listener.
  const off = await setup(t, { token: false })
  const noToken = await off.relay(off.like(off.actor, off.m))
  t.is(noToken.status, 404)
  t.alike(noToken.body, { error: 'nao-encontrado' })
  const s = await setup(t)
  t.is((await s.relay(s.like(s.actor, s.m), { auth: 'Bearer ' + 'ab'.repeat(32) })).status, 404, 'wrong token')
  t.is((await s.relay(s.like(s.actor, s.m), { auth: null })).status, 404, 'no header')
  t.is((await s.relay(s.like(s.actor, s.m), { origin: ORIGIN })).status, 404, 'Origin header')
  t.is((await s.relay(s.like(s.actor, s.m), { type: 'text/plain' })).status, 400, 'not JSON')
  const bad = await s.relay({ ...s.like(s.actor, s.m), extra: 1 })
  t.is(bad.status, 400)
  t.alike(bad.body, { error: 'pedido-invalido' })
  t.is((await s.relay('x'.repeat(2000))).status, 413, 'body over 1024 bytes')
  t.is(s.delivered.length, 0)
  cleanLogs(t, s)
})

test('relay: a like reaches every subscription encrypted, once, with the actor name and nothing else', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  const subs = [subscription(), subscription('updates.push.services.mozilla.com')]
  for (const sub of subs) t.alike((await s.toggle(s.m, 'on', sub)).body, { ok: true, changed: true })

  const event = s.like(s.actor, s.m)
  const r = await s.relay(event)
  t.is(r.status, 202)
  t.alike(r.body, {})
  await until(() => s.delivered.length === 2, { name: 'two sends' })
  for (const sub of subs) {
    const got = s.delivered.find((d) => d.url === sub.endpoint)
    t.ok(got, 'one send to each subscription')
    t.is(got.headers['Content-Encoding'], 'aes128gcm')
    t.is(got.headers.Topic, nodeCrypto.createHmac('sha256', TOPIC_KEY).update(event.actor + ':' + event.seq).digest('hex').slice(0, 32))
    t.not(got.headers.Topic, sha256(event.actor + ':' + event.seq).toString('hex').slice(0, 32), 'never the bare hash of public values')
    const payload = JSON.parse(decrypt(got.body, sub.uaPrivate, sub.auth))
    t.alike(payload, { v: 1, kind: 'like', body: 'Bia Souza curtiu seu post', actor: s.actor.hex, recipient: s.m.hex, ref: event.ref })
  }

  // The same actor:seq again: no second send.
  t.is((await s.relay(event)).status, 202)
  // No name: the actor's verified username stands in.
  const unnamed = s.like(s.actor, s.m, { ref: s.m.hex + ':9', name: null })
  t.is((await s.relay(unnamed)).status, 202)
  await until(() => s.delivered.length === 4, { name: 'unnamed sends' })
  t.is(JSON.parse(decrypt(s.delivered[2].body, subs.find((x) => x.endpoint === s.delivered[2].url).uaPrivate, subs.find((x) => x.endpoint === s.delivered[2].url).auth)).body, 'bia curtiu seu post')
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(s.delivered.length, 4, 'the duplicate sent nothing')

  // A recipient without subscriptions answers the same 202.
  const lonely = s.like(s.m, s.actor)
  t.is((await s.relay(lonely)).status, 202)
  await until(() => s.logs.filter((l) => l === JSON.stringify({ event: 'push', reason: 'enviado' })).length === 4, { name: 'logged' })
  cleanLogs(t, s, subs.map((x) => x.endpoint))
})

test('relay: a follow and a like have the same ciphertext length', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  const sub = subscription()
  await s.toggle(s.m, 'on', sub)
  await s.relay(s.like(s.actor, s.m, { kind: 'follow', ref: null, name: 'Bia' }))
  await s.relay(s.like(s.actor, s.m, { name: 'Bia Souza de Oliveira Santos' }))
  await until(() => s.delivered.length === 2, { name: 'two sends' })
  const follow = s.delivered.find((d) => JSON.parse(decrypt(d.body, sub.uaPrivate, sub.auth)).kind === 'follow')
  const like = s.delivered.find((d) => JSON.parse(decrypt(d.body, sub.uaPrivate, sub.auth)).kind === 'like')
  t.ok(follow && like, 'both delivered')
  t.is(follow.body.length, like.body.length, 'the length shows neither the kind nor the name')
  cleanLogs(t, s, [sub.endpoint])
})

test('relay: like on/off/on within 600 s sends once; the 61st event in an hour is the cap; 410 removes the row', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  const sub = subscription()
  await s.toggle(s.m, 'on', sub)

  const first = s.like(s.actor, s.m)
  await s.relay(first)
  // The 'off' record is never relayed (pushCandidate); the second 'on' is a
  // new seq for the same post.
  await s.relay(s.like(s.actor, s.m))
  await until(() => s.delivered.length === 1, { name: 'first send' })
  await until(() => s.logs.includes(JSON.stringify({ event: 'push', reason: 'descartado' })), { name: 'cooldown' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(s.delivered.length, 1, 'one send for the repeated like')
  s.c.offset += 600 * 1000
  await s.relay(s.like(s.actor, s.m))
  await until(() => s.delivered.length === 2, { name: 'after the cooldown' })

  // Per-recipient cap: 60 pushes an hour, charged only when one is queued.
  const target = member()
  await linkDirect(s.store, s.iss, target, 'caio', '3333333333333333333333', 'caio@example.test')
  await s.acceptTerms(target)
  await s.toggle(target, 'on', subscription())
  for (let i = 0; i < 60; i++) {
    const from = member()
    t.is((await s.relay({ ...s.like(from, target), name: null })).status, 202)
  }
  t.absent(s.logs.includes(JSON.stringify({ event: 'push', reason: 'teto' })), '60 pass')
  t.is((await s.relay({ ...s.like(member(), target), name: null })).status, 202, 'still 202')
  await until(() => s.logs.includes(JSON.stringify({ event: 'push', reason: 'teto' })), { name: 'teto' })

  // A 410 from the push service removes that subscription.
  s.statusOf.set(sub.endpoint, 410)
  s.c.offset += 600 * 1000
  await s.relay(s.like(s.actor, s.m))
  await until(() => s.pushStore.list(s.m.hex).length === 0, { name: 'row removed' })
  await until(() => s.logs.includes(JSON.stringify({ event: 'push', reason: 'removido' })), { name: 'removido' })
  t.alike((await s.check(s.m, sub)).body, { registered: false })
  cleanLogs(t, s, [sub.endpoint])
})

test('relay: like toggles never spend the recipient budget; one actor gets 10 pushes an hour per recipient', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  const sub = subscription()
  await s.toggle(s.m, 'on', sub)
  const teto = JSON.stringify({ event: 'push', reason: 'teto' })

  // 60 'on' records of one like, a new seq each: one push, the rest cooldown.
  for (let i = 0; i < 60; i++) t.is((await s.relay({ ...s.like(s.actor, s.m), name: null })).status, 202)
  await until(() => s.delivered.length === 1, { name: 'one send' })
  const third = member()
  await s.relay({ ...s.like(third, s.m), name: null })
  await until(() => s.delivered.length === 2, { name: 'another actor still reaches the recipient' })
  t.absent(s.logs.includes(teto), 'no cap reached')

  // Ten distinct events from one actor pass, the 11th is the cap; another
  // actor's still goes through.
  const before = s.delivered.length
  for (let i = 0; i < 9; i++) await s.relay({ ...s.like(s.actor, s.m, { ref: s.m.hex + ':' + (100 + i) }), name: null })
  await until(() => s.delivered.length === before + 9, { name: 'ten from one actor' })
  t.absent(s.logs.includes(teto), 'ten pass')
  await s.relay({ ...s.like(s.actor, s.m, { ref: s.m.hex + ':200' }), name: null })
  await until(() => s.logs.includes(teto), { name: 'the 11th is teto' })
  await s.relay({ ...s.like(member(), s.m), name: null })
  await until(() => s.delivered.length === before + 10, { name: 'another actor after the cap' })
  t.is(s.logs.filter((l) => l === teto).length, 1, 'only the 11th was dropped')
  cleanLogs(t, s, [sub.endpoint])
})

test('relay: two replies to the same post within 600 s are two notices', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  const sub = subscription()
  await s.toggle(s.m, 'on', sub)
  await s.relay(s.like(s.actor, s.m, { kind: 'reply' }))
  await s.relay(s.like(s.actor, s.m, { kind: 'reply' }))
  await until(() => s.delivered.length === 2, { name: 'both replies sent' })
  cleanLogs(t, s, [sub.endpoint])
})

test('relay: a 410 for keys that were replaced meanwhile keeps the new row', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = await setup(t, {
    send: async () => {
      await gate
      return 'gone'
    }
  })
  await s.acceptTerms(s.m)
  const sub = subscription()
  await s.toggle(s.m, 'on', sub)
  await s.relay({ ...s.like(s.actor, s.m), name: null })
  await until(() => s.server.pushStats().inFlight === 1, { name: 'send in flight' })
  // The browser re-subscribed the same endpoint with new keys meanwhile.
  const fresh = { ...subscription(), endpoint: sub.endpoint }
  t.alike((await s.toggle(s.m, 'on', fresh)).body, { ok: true, changed: true })
  release()
  await until(() => s.server.pushStats().inFlight === 0, { name: 'send settled' })
  t.alike((await s.check(s.m, fresh)).body, { registered: true }, 'the re-keyed row stays')
  t.alike((await s.check(s.m, sub)).body, { registered: false }, 'the old keys no longer match')
  cleanLogs(t, s, [sub.endpoint])
})

test('relay: a notice queued behind 8 in-flight sends is not sent after opt-out', async (t) => {
  const sent = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = await setup(t, {
    send: async ({ subscription }) => {
      sent.push(subscription.endpoint)
      await gate
      return 'ok'
    }
  })
  await s.acceptTerms(s.m)
  const sub = subscription()
  await s.toggle(s.m, 'on', sub)
  // Distinct actors, so no cooldown applies: 8 sends block, the 9th queues.
  for (let i = 0; i < 9; i++) t.is((await s.relay({ ...s.like(member(), s.m), name: null })).status, 202)
  await until(() => sent.length === 8, { name: 'eight in flight' })
  t.alike((await s.toggle(s.m, 'off', sub)).body, { ok: true, changed: true })
  release()
  const done = () => s.logs.filter((l) => l === JSON.stringify({ event: 'push', reason: 'enviado' }) || l === JSON.stringify({ event: 'push', reason: 'descartado' })).length
  await until(() => done() === 9, { name: 'all nine settled' })
  t.is(sent.length, 8, 'the queued notice is never sent')
  t.ok(s.logs.includes(JSON.stringify({ event: 'push', reason: 'descartado' })))
  cleanLogs(t, s, [sub.endpoint])
})

test('createPushKey: a key created between the check and the write is never replaced', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'push-vapid.json')
  const first = createPushKey(dir)
  const bytes = fs.readFileSync(file)
  t.is(JSON.parse(bytes).publicKey, first)
  t.exception(() => createPushKey(dir), /chave de push já existe/)
  t.alike(fs.readFileSync(file), bytes, 'a second run leaves the file byte-identical')

  // The race: a concurrent run created the file after this run's check.
  const existsSync = fs.existsSync
  fs.existsSync = (p) => p === file ? false : existsSync(p)
  try {
    t.exception(() => createPushKey(dir), /chave de push já existe/)
  } finally {
    fs.existsSync = existsSync
  }
  t.alike(fs.readFileSync(file), bytes, 'the first key is kept')
  let code = null
  try { writeJsonExclusive(file, { v: 1 }, 0o600) } catch (err) { code = err.code }
  t.is(code, 'EEXIST')
  t.alike(fs.readFileSync(file), bytes)
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.alike(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left behind')
})

function varanda (dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], { env: { ...cleanEnv, ...env }, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

async function serveCli (t, dir, env) {
  const child = spawn(process.execPath, [BIN, 'account', '--json', '--account-port', '0', '--data', dir], { env: { ...cleanEnv, ...env } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
  t.teardown(() => { child.kill('SIGKILL') }, { force: true })
  return {
    stop: async () => { child.kill('SIGTERM'); return exited },
    stdout: () => stdout,
    stderr: () => stderr
  }
}

function listeningPort (out) {
  for (const line of out.split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e.event === 'listening') return e.port
    } catch {}
  }
  return null
}

test('account push-key prints only the public key and refuses a second run; serve, status and export', async (t) => {
  t.timeout(90000)
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const env = {
    VARANDA_ASSOCIATION: iss.association,
    VARANDA_PUBLIC_ORIGIN: ORIGIN,
    VARANDA_GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
    VARANDA_GOOGLE_CLIENT_SECRET: 'segredo-de-teste'
  }

  // Without push-vapid.json and VARANDA_PUSH_TOKEN: starts as before, key
  // 503, /push-event 404.
  const plain = await serveCli(t, dir, env)
  const port = await until(() => listeningPort(plain.stdout()), { name: 'listening' })
  t.ok(plain.stdout().includes(JSON.stringify({ event: 'push', reason: 'desligado' })))
  const key = await fetch('http://127.0.0.1:' + port + '/account/push/key')
  t.is(key.status, 503)
  const relay = await fetch('http://127.0.0.1:' + port + '/push-event', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'ab'.repeat(32) }, body: '{}' })
  t.is(relay.status, 404)
  const busy = varanda(dir, ['account', 'push-key'], env)
  t.is(busy.code, 1, 'refused while the service runs')
  t.ok(busy.stderr.includes('serviço de conta em execução'), busy.stderr)
  t.is(await plain.stop(), 0, plain.stderr())

  const made = varanda(dir, ['account', 'push-key', '--json'], env)
  t.is(made.code, 0, made.stderr)
  const printed = JSON.parse(made.stdout.trim())
  t.alike(Object.keys(printed), ['publicKey'])
  const file = path.join(dir, 'push-vapid.json')
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.alike(Object.keys(stored).sort(), ['privateKey', 'publicKey', 'v'])
  t.is(stored.publicKey, printed.publicKey)
  t.absent(made.stdout.includes(stored.privateKey), 'never the private key')
  const twice = varanda(dir, ['account', 'push-key'], env)
  t.is(twice.code, 1)
  t.ok(twice.stderr.includes('chave de push já existe'), twice.stderr)
  t.is(JSON.parse(fs.readFileSync(file, 'utf8')).privateKey, stored.privateKey, 'the key is kept')

  // A member with one subscription: status and export carry counts only.
  const accounts = openAccountStore(dir)
  const m = member()
  await linkDirect(accounts, iss, m, 'ana')
  await accounts.close()
  const sub = subscription()
  await openPushStore(dir).put({ member: m.hex, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
  const status = varanda(dir, ['account', 'status'])
  t.is(status.code, 0, status.stderr)
  t.ok(status.stdout.includes('avisos push: ligados (1 aparelhos)'), status.stdout)
  t.absent(status.stdout.includes(sub.endpoint))
  const exported = varanda(dir, ['account', 'export'])
  t.is(exported.code, 0, exported.stderr)
  t.is(JSON.parse(exported.stdout.trim()).pushDevices, 1)
  t.absent(exported.stdout.includes(sub.endpoint), 'never an endpoint')
  fs.unlinkSync(path.join(dir, 'push.json'))
  t.is(JSON.parse(varanda(dir, ['account', 'export']).stdout.trim()).pushDevices, 0, 'no push.json exports 0')

  // With the key and a token: on, and the key route answers it.
  const token = 'cd'.repeat(32)
  const svc = await serveCli(t, dir, { ...env, VARANDA_PUSH_TOKEN: token })
  const port2 = await until(() => listeningPort(svc.stdout()), { name: 'listening again' })
  t.ok(svc.stdout().includes(JSON.stringify({ event: 'push', reason: 'ligado' })))
  const key2 = await fetch('http://127.0.0.1:' + port2 + '/account/push/key')
  t.alike(await key2.json(), { key: printed.publicKey })
  t.absent(svc.stdout().includes(stored.privateKey), 'the private key never printed')
  t.absent(svc.stdout().includes(token), 'the token never printed')
  t.is(await svc.stop(), 0, svc.stderr())

  // A malformed key file: push stays off without printing the file.
  fs.writeFileSync(file, JSON.stringify({ v: 1, publicKey: stored.publicKey, privateKey: generateVapidKeys().privateKey }))
  const broken = await serveCli(t, dir, env)
  await until(() => listeningPort(broken.stdout()), { name: 'listening broken' })
  t.ok(broken.stdout().includes(JSON.stringify({ event: 'push', reason: 'indisponivel' })))
  t.ok(broken.stdout().includes(JSON.stringify({ event: 'push', reason: 'desligado' })))
  t.is(await broken.stop(), 0, broken.stderr())
  t.ok(varanda(dir, ['account', 'status']).stdout.includes('avisos push: desligados'))
})
