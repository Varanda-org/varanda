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
const { generateVapidKeys, sendPush, encryptPayload } = require('../lib/account/web-push')
const { createPushRoutes, PUSH_PAD_TO, INVITE_QUEUE_MAX, MAX_QUEUE, MAX_IN_FLIGHT, DM_NOTICE_TERMS_FLOOR, GROUP_NOTICE_TERMS_FLOOR, RELAY_BODY_MAX } = require('../lib/account/push-routes')
const { loadOrCreateWakeKey } = require('../lib/account/push-wake-key')
const { sealDmNotice, DM_NOTICE_BOX_BYTES } = require('@varanda/core/lib/dm-notice')
const { createAccountServer, keyedWindow } = require('../lib/account/server')
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
  const wakeKey = loadOrCreateWakeKey(dir)
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
          delayMs: () => 0,
          relayTokenHash: token ? sha256(relayToken) : null,
          topicKey: TOPIC_KEY,
          wakeKey
        }
      : null,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port
  if (keys !== null) secrets.push(keys.privateKey, keys.publicKey)
  secrets.push(relayToken, wakeKey.secretKey.toString('hex'), wakeKey.secretKey.toString('base64url'))

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

  // A DM box for `key` (hex) sealed to this service's wake key, as the
  // seeder relays it (apps/cli/lib/push-relay.js sendDm).
  const dmBox = (key, to = wakeKey.publicKey) => sealDmNotice(key, to).toString('base64url')
  const relayDm = (key, opts) => relay({ v: 1, kind: 'dm', box: dmBox(key) }, opts)
  // A stored subscription without the opt-in proof, so a test can choose
  // which Terms version the member accepted.
  async function subscribe (who, host) {
    const sub = subscription(host)
    await pushStore.put({ member: who.hex, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
    return sub
  }

  return { dir, c, iss, store, terms, pushStore, keys, wakeKey, dmBox, relayDm, subscribe, relayToken, delivered, statusOf, logs, texts, secrets, listener, server, m, actor, request, post, start, sign, finish, toggle, check, acceptTerms, relay, like }
}

// No endpoint, key, nonce, signature, token or notice text in any log line.
function cleanLogs (t, s, endpoints = []) {
  const all = s.logs.join('\n')
  for (const secret of [...s.secrets, ...endpoints]) t.absent(all.includes(secret), 'a secret or an endpoint in the logs')
  t.absent(all.includes('curtiu'), 'no notice text in the logs')
  t.absent(all.includes('Bia Souza'), 'no actor name in the logs')
  t.absent(all.includes(EMAIL), 'no e-mail in the logs')
  t.absent(/[0-9a-f]{64}/.test(all), 'no member or page key in the logs')
  for (const line of s.logs) {
    const e = JSON.parse(line)
    t.ok(Object.keys(e).every((k) => k === 'event' || k === 'reason' || (k === 'kind' && e.kind === 'dm')), 'only event, reason and a DM kind: ' + line)
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
  const body = await res.json()
  t.alike(body, { key: on.keys.publicKey, wake: on.wakeKey.publicKey.toString('base64url') })
  t.is(Buffer.from(body.wake, 'base64url').length, 32, 'the wake key is 32 bytes')
  t.absent(body.wake.includes('='), 'unpadded')
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
  const r = createPushRoutes({ association: '0'.repeat(64), accounts: { status: () => ({ linked: false }) }, relayTokenHash, delayMs: () => 0, http, ...extra })
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
  t.is((await s.relay('x'.repeat(9 * 1024))).status, 413, 'body over 8192 bytes')
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
    t.is(got.headers.Topic, nodeCrypto.createHmac('sha256', TOPIC_KEY).update(event.actor + ':' + event.seq + ':' + event.recipient).digest('hex').slice(0, 32))
    t.not(got.headers.Topic, sha256(event.actor + ':' + event.seq + ':' + event.recipient).toString('hex').slice(0, 32), 'never the bare hash of public values')
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

test('relay: a quote and a mention from one record reach both recipients with their own text', async (t) => {
  const s = await setup(t)
  const author = member()
  const subM = subscription()
  const subA = subscription()
  await s.acceptTerms(s.m)
  await s.acceptTerms(s.actor)
  await s.toggle(s.m, 'on', subM)
  await s.toggle(s.actor, 'on', subA)
  const base = { v: 1, actor: author.hex, seq: 5, ref: author.hex + ':5', name: 'Caio' }
  const quote = { ...base, kind: 'quote', recipient: s.m.hex }
  const mention = { ...base, kind: 'mention', recipient: s.actor.hex }
  t.is((await s.relay(quote)).status, 202)
  t.is((await s.relay(mention)).status, 202)
  t.is((await s.relay(mention)).status, 202, 'the same event again')
  await until(() => s.delivered.length === 2, { name: 'both recipients' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(s.delivered.length, 2, 'the duplicate sent nothing')
  const toM = s.delivered.find((d) => d.url === subM.endpoint)
  const toA = s.delivered.find((d) => d.url === subA.endpoint)
  t.alike(JSON.parse(decrypt(toM.body, subM.uaPrivate, subM.auth)), { v: 1, kind: 'quote', body: 'Caio citou seu post', actor: author.hex, recipient: s.m.hex, ref: base.ref })
  t.alike(JSON.parse(decrypt(toA.body, subA.uaPrivate, subA.auth)), { v: 1, kind: 'mention', body: 'Caio mencionou você', actor: author.hex, recipient: s.actor.hex, ref: base.ref })
  t.not(toM.headers.Topic, toA.headers.Topic, 'one topic per recipient')
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
    stop: Object.assign(async () => { child.kill('SIGTERM'); return exited }, { exited }),
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
  const wakeFile = JSON.parse(fs.readFileSync(path.join(dir, 'push-wake.json'), 'utf8'))
  t.is(fs.statSync(path.join(dir, 'push-wake.json')).mode & 0o777, 0o600, 'the wake key is created on the first start')
  t.absent(plain.stdout().includes(wakeFile.secretKey), 'the wake secret never printed')

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
  t.alike(await key2.json(), { key: printed.publicKey, wake: Buffer.from(wakeFile.publicKey, 'hex').toString('base64url') }, 'the wake key of the first start, kept across a restart')
  t.absent(svc.stdout().includes(stored.privateKey), 'the private key never printed')
  t.absent(svc.stdout().includes(wakeFile.secretKey), 'the wake secret never printed')
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

  // A wake key file that is not a pair it wrote stops the service: a new
  // key would orphan every box sealed to the old one.
  const badWake = JSON.stringify({ v: 1, publicKey: wakeFile.publicKey, secretKey: 'ab'.repeat(32) })
  fs.writeFileSync(path.join(dir, 'push-wake.json'), badWake)
  const refusedWake = await serveCli(t, dir, env)
  const code = await refusedWake.stop.exited
  t.not(code, 0, 'refuses to start')
  t.absent(listeningPort(refusedWake.stdout()), 'never listened')
  t.absent((refusedWake.stdout() + refusedWake.stderr()).includes('ab'.repeat(32)), 'the secret never printed')
  t.is(fs.readFileSync(path.join(dir, 'push-wake.json'), 'utf8'), badWake, 'never replaced')
})

const DM_KEYS = ['g', 'kind', 'v']

test('relay: a DM box reaches only its member with { v: 1, kind: dm, g }, once per 15 minutes', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m, DM_NOTICE_TERMS_FLOOR)
  await s.acceptTerms(s.actor, DM_NOTICE_TERMS_FLOOR)
  const mine = [await s.subscribe(s.m), await s.subscribe(s.m, 'updates.push.services.mozilla.com')]
  const other = await s.subscribe(s.actor)

  const before = s.c.now()
  const r = await s.relayDm(s.m.hex)
  t.is(r.status, 202)
  t.alike(r.body, {})
  await until(() => s.delivered.length === 2, { name: 'two sends' })
  const after = s.c.now()
  const topics = new Set()
  for (const sub of mine) {
    const got = s.delivered.filter((d) => d.url === sub.endpoint)
    t.is(got.length, 1, 'one send to each of the member\'s devices')
    topics.add(got[0].headers.Topic)
    const plain = decrypt(got[0].body, sub.uaPrivate, sub.auth)
    const payload = JSON.parse(plain)
    t.alike(Object.keys(payload).sort(), DM_KEYS)
    t.is(payload.v, 1)
    t.is(payload.kind, 'dm')
    t.ok(Number.isSafeInteger(payload.g) && payload.g >= before && payload.g <= after, 'g is the enqueue time')
    t.absent(/[0-9a-f]{64}/.test(plain), 'no key in the payload')
    t.absent(/ana|bia/i.test(plain), 'no name in the payload')
  }
  t.is(topics.size, 1, 'one topic for every device of one notice')
  t.absent(s.delivered.some((d) => d.url === other.endpoint), 'nobody else is told')

  // A second box for the same member inside 15 minutes sends nothing.
  t.is((await s.relayDm(s.m.hex)).status, 202)
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(s.delivered.length, 2, 'coalesced')

  // Padded like every other notice.
  await s.relay(s.like(s.actor, s.m))
  await until(() => s.delivered.length === 4, { name: 'like sends' })
  const like = s.delivered.find((d, i) => i >= 2 && d.url === mine[0].endpoint)
  t.is(like.body.length, s.delivered[0].body.length, 'same size as a like')

  // The other member is not under the first member's cooldown.
  t.is((await s.relayDm(s.actor.hex)).status, 202)
  await until(() => s.delivered.length === 5, { name: 'other member' })
  t.is(s.delivered[4].url, other.endpoint)

  // Past the window the member is told again.
  s.c.offset += 15 * 60 * 1000
  t.is((await s.relayDm(s.m.hex)).status, 202)
  await until(() => s.delivered.length === 7, { name: 'next window' })
  cleanLogs(t, s, [...mine, other].map((x) => x.endpoint))
})

test('relay: a DM box for a member below the Terms floor or without a device sends nothing', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m, DM_NOTICE_TERMS_FLOOR - 1)
  const sub = await s.subscribe(s.m)
  t.is((await s.relayDm(s.m.hex)).status, 202)
  await until(() => s.logs.includes(JSON.stringify({ event: 'push', kind: 'dm', reason: 'termos-pendentes' })), { name: 'terms refusal' })
  t.is(s.delivered.length, 0, 'an older acceptance does not cover DM notices')

  await s.acceptTerms(s.m, DM_NOTICE_TERMS_FLOOR)
  s.c.offset += 15 * 60 * 1000
  t.is((await s.relayDm(s.m.hex)).status, 202)
  await until(() => s.delivered.length === 1, { name: 'sent once accepted' })
  t.is(s.delivered[0].url, sub.endpoint)

  // Accepted, no device: nothing, and no error.
  await s.acceptTerms(s.actor, DM_NOTICE_TERMS_FLOOR)
  t.is((await s.relayDm(s.actor.hex)).status, 202)
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(s.delivered.length, 1)
  cleanLogs(t, s, [sub.endpoint])
})

test('relay: a bad DM box is 202 and sends nothing, a bad shape is 400, the old wake is dropped and no Bearer is hidden', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m, DM_NOTICE_TERMS_FLOOR)
  const sub = await s.subscribe(s.m)
  const good = s.dmBox(s.m.hex)
  t.is(good.length, Math.ceil(DM_NOTICE_BOX_BYTES * 4 / 3), 'the length relayed')
  // The last character of 116 bytes carries 4 bits and 2 unused ones:
  // flipping an unused bit decodes to the same bytes.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const last = alphabet.indexOf(good[good.length - 1])
  const nonCanonical = good.slice(0, -1) + alphabet[last ^ 1]
  t.alike(Buffer.from(nonCanonical, 'base64url'), Buffer.from(good, 'base64url'), 'same bytes, other spelling')
  const otherKey = loadOrCreateWakeKey(path.join(tmpDir(t), 'other'))
  const boxes = [
    ['sealed to another key', s.dmBox(s.m.hex, otherKey.publicKey)],
    ['one byte short', Buffer.from(good, 'base64url').subarray(1).toString('base64url')],
    ['one byte long', Buffer.concat([Buffer.from(good, 'base64url'), Buffer.from([0])]).toString('base64url')],
    ['non-canonical', nonCanonical],
    ['padded', good + '='],
    ['standard alphabet', Buffer.from(good, 'base64url').toString('base64')],
    ['empty', ''],
    ['flipped byte', (() => { const b = Buffer.from(good, 'base64url'); b[40] ^= 1; return b.toString('base64url') })()]
  ]
  for (const [label, box] of boxes) {
    const r = await s.relay({ v: 1, kind: 'dm', box })
    t.is(r.status, 202, label + ': 202')
    t.alike(r.body, {}, label + ': empty answer')
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(s.delivered.length, 0, 'no bad box sends anything')
  const invalid = JSON.stringify({ event: 'push', kind: 'dm', reason: 'caixa-invalida' })
  t.ok(s.logs.filter((l) => l === invalid).length >= 7, 'each logged as caixa-invalida')

  for (const bad of [
    { v: 1, kind: 'dm', box: good, recipient: s.m.hex },
    { v: 2, kind: 'dm', box: good },
    { v: 1, kind: 'dm' },
    { v: 1, kind: 'dm', box: 7 },
    { v: 1, kind: 'dm', box: [good] },
    { v: 1, kind: 'dm-wake', recipient: s.m.hex }
  ]) {
    const r = await s.relay(bad)
    t.is(r.status, 400, JSON.stringify(Object.keys(bad)))
    t.alike(r.body, { error: 'pedido-invalido' })
  }

  // The old global wake: accepted and dropped.
  const legacy = await s.relay({ v: 1, kind: 'dm-wake' })
  t.is(legacy.status, 202)
  t.alike(legacy.body, {})

  // No Bearer, or a wrong one: the generic 404, as for every relay event.
  for (const auth of [null, 'Bearer ' + 'ab'.repeat(32)]) {
    const r = await s.relay({ v: 1, kind: 'dm', box: good }, { auth })
    t.is(r.status, 404)
    t.alike(r.body, { error: 'nao-encontrado' })
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(s.delivered.length, 0, 'nothing sent')

  // None of the above spent the member's cooldown.
  t.is((await s.relay({ v: 1, kind: 'dm', box: good })).status, 202)
  await until(() => s.delivered.length === 1, { name: 'the good box' })
  t.is(s.delivered[0].url, sub.endpoint)
  cleanLogs(t, s, [sub.endpoint])
})

// The key the stub pages store fails on.
const PAGES_THROW_KEY = 'fe'.repeat(32)

// createPushRoutes with a real push store and keyedWindow, a stub pages
// store and Terms store, and a send spy.
async function dmRoutes (t, { pages = new Map(), accepted = () => true, terms = null, pushStore = null, delay = 0, delayMs = () => delay } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const clock = { t: Date.parse('2026-11-18T12:00:00.000Z') }
  clock.now = () => clock.t
  const store = pushStore ?? openPushStore(dir, { now: clock.now })
  const wakeKey = loadOrCreateWakeKey(path.join(tmpDir(t), 'wake'))
  const token = 'dd'.repeat(32)
  const sent = []
  const logs = []
  let next = null
  const replies = []
  const r = createPushRoutes({
    association: '0'.repeat(64),
    accounts: { status: () => ({ linked: false }) },
    terms: terms ?? { available: () => true, list: (member) => accepted(member) ? [{ version: DM_NOTICE_TERMS_FLOOR }] : [{ version: DM_NOTICE_TERMS_FLOOR - 1 }] },
    pagesStore: {
      get (key) {
        if (key === PAGES_THROW_KEY) throw new Error('indisponivel')
        return pages.has(key) ? { ...pages.get(key) } : null
      }
    },
    pushStore: store,
    vapid: { ...generateVapidKeys(), subject: ORIGIN },
    wakeKey,
    topicKey: TOPIC_KEY,
    send: async (args) => { sent.push({ endpoint: args.subscription.endpoint, payload: JSON.parse(args.payload), topic: args.topic }); return 'ok' },
    delayMs,
    relayTokenHash: sha256(token),
    log: (e) => logs.push(JSON.stringify(e)),
    now: clock.now,
    http: { ...HTTP_STUB, send: (res, status) => replies.push(status), readJsonBody: async () => next, keyedWindow }
  })
  t.teardown(() => r.close())
  const relay = (event) => {
    next = event
    return r.handleRelay({ method: 'POST', headers: { authorization: 'Bearer ' + token } }, {})
  }
  const dm = (key) => relay({ v: 1, kind: 'dm', box: sealDmNotice(key, wakeKey.publicKey).toString('base64url') })
  async function subscribe (who) {
    const sub = subscription()
    await store.put({ member: who.hex, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
    return sub
  }
  return { r, clock, sent, logs, replies, relay, dm, subscribe }
}

function noKeysLogged (t, logs) {
  const all = logs.join('\n')
  t.absent(/[0-9a-f]{64}/.test(all), 'no member or page key in the logs')
  t.absent(/[0-9a-f]{32}/.test(all), 'no notice id or key in the logs')
  for (const line of logs) {
    const e = JSON.parse(line)
    t.ok(Object.keys(e).every((k) => k === 'event' || k === 'reason' || (k === 'kind' && ['dm', 'group'].includes(e.kind))), 'only event, reason and kind: ' + line)
  }
}

test('relay: a DM box naming a live Página reaches its owner and admins as dm-page, never the page key', async (t) => {
  const page = member()
  const closedPage = member()
  const movedPage = member()
  const owner = member()
  const admin = member()
  const outsider = member()
  const pages = new Map([
    [page.hex, { owner: owner.hex, admins: [admin.hex], closed: null, movedTo: null, paused: false }],
    [closedPage.hex, { owner: owner.hex, admins: [admin.hex], closed: '2026-11-17T00:00:00.000Z', movedTo: null, paused: false }],
    [movedPage.hex, { owner: owner.hex, admins: [admin.hex], closed: '2026-11-17T00:00:00.000Z', movedTo: page.hex, paused: false }]
  ])
  const d = await dmRoutes(t, { pages })
  const subs = { owner: await d.subscribe(owner), admin: await d.subscribe(admin), page: await d.subscribe(page), outsider: await d.subscribe(outsider), closed: await d.subscribe(closedPage) }

  await d.dm(page.hex)
  t.alike(d.replies, [202])
  await until(() => d.sent.length === 2, { name: 'owner and admin' })
  t.alike(d.sent.map((x) => x.endpoint).sort(), [subs.owner.endpoint, subs.admin.endpoint].sort())
  for (const x of d.sent) {
    t.alike(Object.keys(x.payload).sort(), DM_KEYS)
    t.is(x.payload.kind, 'dm-page')
    t.is(x.payload.g, d.clock.t)
  }
  t.absent(d.sent.some((x) => x.endpoint === subs.page.endpoint), 'never the page key itself')

  // The cooldown is the page's: a second box for it sends nothing, while the
  // owner's own DM notice still goes out, as kind dm.
  await d.dm(page.hex)
  await d.dm(owner.hex)
  await until(() => d.sent.length === 3, { name: 'owner own' })
  t.is(d.sent[2].endpoint, subs.owner.endpoint)
  t.is(d.sent[2].payload.kind, 'dm')
  t.not(d.sent[2].topic, d.sent.find((x) => x.endpoint === subs.owner.endpoint).topic, 'a fresh topic per notice')

  // A closed or moved page has no roster to tell: only the key's own rows.
  await d.dm(closedPage.hex)
  await d.dm(movedPage.hex)
  await until(() => d.sent.length === 4, { name: 'closed page own row' })
  t.is(d.sent[3].endpoint, subs.closed.endpoint)
  t.is(d.sent[3].payload.kind, 'dm')
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(d.sent.length, 4, 'neither the owner nor the admin of a closed or moved page')
  t.absent(d.sent.some((x) => x.endpoint === subs.outsider.endpoint))
  noKeysLogged(t, d.logs)
})

test('relay: a Página admin below the Terms floor is skipped; one member gets 60 DM notices an hour', async (t) => {
  const owner = member()
  const admin = member()
  const pages = new Map()
  const keys = []
  for (let i = 0; i < 62; i++) {
    const p = member()
    keys.push(p.hex)
    pages.set(p.hex, { owner: owner.hex, admins: [admin.hex], closed: null, movedTo: null, paused: false })
  }
  const d = await dmRoutes(t, { pages, accepted: (m) => m !== admin.hex })
  const ownerSub = await d.subscribe(owner)
  await d.subscribe(admin)
  for (let i = 0; i < 61; i++) await d.dm(keys[i])
  await until(() => d.r.stats().queued === 0 && d.r.stats().inFlight === 0, { name: 'drained' })
  t.is(d.sent.length, 60, 'the 61st page notice in an hour is over the cap')
  t.ok(d.sent.every((x) => x.endpoint === ownerSub.endpoint), 'the admin below the floor gets nothing')
  t.is(d.logs.filter((l) => l === JSON.stringify({ event: 'push', kind: 'dm', reason: 'teto' })).length, 1)
  t.ok(d.logs.includes(JSON.stringify({ event: 'push', kind: 'dm', reason: 'termos-pendentes' })))
  d.clock.t += 3600 * 1000
  await d.dm(keys[61])
  await until(() => d.sent.length === 61, { name: 'next hour' })
  noKeysLogged(t, d.logs)
})

test('relay: a DM box that reaches nobody leaves the 15-minute window open', async (t) => {
  const m = member()
  let ok = false
  const d = await dmRoutes(t, { accepted: () => ok })
  await d.dm(m.hex)
  t.ok(d.logs.includes(JSON.stringify({ event: 'push', kind: 'dm', reason: 'termos-pendentes' })), 'below the Terms floor')
  ok = true
  await d.dm(m.hex)
  t.is(d.logs.filter((l) => l === JSON.stringify({ event: 'push', kind: 'dm', reason: 'descartado' })).length, 0, 'no device yet, still not charged')
  const sub = await d.subscribe(m)
  await d.dm(m.hex)
  await until(() => d.sent.length === 1, { name: 'first notice that reaches a device' })
  t.is(d.sent[0].endpoint, sub.endpoint)
  await d.dm(m.hex)
  t.is(d.logs.filter((l) => l === JSON.stringify({ event: 'push', kind: 'dm', reason: 'descartado' })).length, 1, 'the queued notice took the window')
  d.clock.t += 15 * 60 * 1000
  await d.dm(m.hex)
  await until(() => d.sent.length === 2, { name: 'next window' })
  noKeysLogged(t, d.logs)
})

test('relay: each Página member draws its own delay, shared only by its own devices', async (t) => {
  const page = member()
  const owner = member()
  const admin = member()
  const idle = member()
  let draws = 0
  const pages = new Map([[page.hex, { owner: owner.hex, admins: [admin.hex, idle.hex], closed: null, movedTo: null, paused: false }]])
  const d = await dmRoutes(t, { pages, delayMs: () => { draws++; return 0 } })
  await d.subscribe(owner)
  await d.subscribe(owner)
  await d.subscribe(admin)
  await d.dm(page.hex)
  await until(() => d.sent.length === 3, { name: 'owner twice, admin once' })
  t.is(draws, 2, 'one draw for the owner (two devices), one for the admin, none for an admin with no device')
})

test('relay: a Página notice skips an admin removed, or a page closed, while it waited', async (t) => {
  const page = member()
  const owner = member()
  const admin = member()
  const pages = new Map([[page.hex, { owner: owner.hex, admins: [admin.hex], closed: null, movedTo: null, paused: false }]])
  const d = await dmRoutes(t, { pages, delay: 50 })
  const subs = { owner: await d.subscribe(owner), admin: await d.subscribe(admin) }
  const settled = () => d.r.stats().queued === 0 && d.r.stats().inFlight === 0
  await d.dm(page.hex)
  t.is(d.r.stats().queued, 2, 'owner and admin queued')
  pages.set(page.hex, { ...pages.get(page.hex), admins: [] })
  d.clock.t += 50
  await until(settled, { name: 'both jobs handled' })
  t.alike(d.sent.map((s) => s.endpoint), [subs.owner.endpoint], 'only the owner, who still runs the page')
  t.is(d.r.stats().dropped, 1)

  d.clock.t += 15 * 60 * 1000
  pages.set(page.hex, { ...pages.get(page.hex), admins: [admin.hex] })
  await d.dm(page.hex)
  t.is(d.r.stats().queued, 2)
  pages.set(page.hex, { ...pages.get(page.hex), closed: '2026-11-18T12:15:00.000Z' })
  d.clock.t += 50
  await until(settled, { name: 'jobs of the closed page handled' })
  t.is(d.sent.length, 1, 'nothing for a page closed meanwhile')
  t.is(d.r.stats().dropped, 3)
  noKeysLogged(t, d.logs)
})

test('relay: an unreadable pages store reads as a member key; no wake key drops every box', async (t) => {
  const d = await dmRoutes(t)
  const odd = { hex: PAGES_THROW_KEY }
  const sub = await d.subscribe(odd)
  await d.dm(odd.hex)
  await until(() => d.sent.length === 1, { name: 'member path' })
  t.is(d.sent[0].endpoint, sub.endpoint)
  t.is(d.sent[0].payload.kind, 'dm')
  noKeysLogged(t, d.logs)

  const logs = []
  const replies = []
  const sent = []
  const token = 'ee'.repeat(32)
  const off = createPushRoutes({
    association: '0'.repeat(64),
    accounts: { status: () => ({ linked: false }) },
    terms: { available: () => true, list: () => [{ version: DM_NOTICE_TERMS_FLOOR }] },
    pushStore: { available: () => true, list: () => [{ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }] },
    vapid: { ...generateVapidKeys(), subject: ORIGIN },
    send: async () => { sent.push(1); return 'ok' },
    delayMs: () => 0,
    relayTokenHash: sha256(token),
    log: (e) => logs.push(e),
    http: { ...HTTP_STUB, send: (res, status, body) => replies.push([status, body]), readJsonBody: async () => ({ v: 1, kind: 'dm', box: sealDmNotice(odd.hex, loadOrCreateWakeKey(path.join(tmpDir(t), 'w')).publicKey).toString('base64url') }), keyedWindow }
  })
  await off.handleRelay({ method: 'POST', headers: { authorization: 'Bearer ' + token } }, {})
  t.alike(replies, [[202, {}]])
  t.alike(logs, [{ event: 'push', kind: 'dm', reason: 'indisponivel' }])
  t.is(sent.length, 0)
  await off.close()
})

test('relay: DM notices only enter while the queue is under half full, a member gets every device or none', async (t) => {
  const HALF = Math.floor(MAX_QUEUE / 2)
  const big = member()
  const fits = member()
  const late = member()
  const rows = new Map([[big.hex, HALF + 1], [fits.hex, HALF - 4], [late.hex, 5]])
  const pushStore = {
    available: () => true,
    list: (m) => Array.from({ length: rows.get(m) || 0 }, (_, i) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + m.slice(0, 8) + i, p256dh: 'p' + i, auth: 'a' + i }))
  }
  const d = await dmRoutes(t, { pushStore, delay: 60000 })
  await d.dm(big.hex)
  t.is(d.r.stats().queued, 0, 'more devices than half the queue: none queued')
  t.is(d.r.stats().dropped, HALF + 1)
  await d.dm(fits.hex)
  t.is(d.r.stats().queued, HALF - 4)
  await d.dm(late.hex)
  t.is(d.r.stats().queued, HALF - 4, '5 devices do not fit in the 4 left: none queued')
  t.is(d.r.stats().dropped, HALF + 1 + 5)
  t.is(d.logs.filter((l) => l === JSON.stringify({ event: 'push', kind: 'dm', reason: 'descartado' })).length, 2)
  t.is(d.sent.length, 0, 'still waiting for the delay')
  noKeysLogged(t, d.logs)
})

function groupEvent (recipients, extra = {}) {
  return {
    v: 1,
    kind: 'group',
    group: member().hex,
    visibility: 'public',
    name: 'Clube de leitura',
    nid: nodeCrypto.randomBytes(16).toString('hex'),
    recipients,
    ...extra
  }
}

function groupRoutes (t, options = {}) {
  return dmRoutes(t, {
    terms: { available: () => true, list: () => [{ version: GROUP_NOTICE_TERMS_FLOOR }] },
    ...options
  })
}

test('relay: a group notice fans out to 64 members once, including overlapping chunks after the cooldown', async (t) => {
  const d = await groupRoutes(t)
  const members = Array.from({ length: 64 }, () => member())
  const endpoints = []
  for (const m of members) endpoints.push((await d.subscribe(m)).endpoint)
  const event = groupEvent(members.map((m) => m.hex))
  await d.relay(event)
  t.alike(d.replies, [202])
  await until(() => d.r.stats().queued === 0 && d.r.stats().inFlight === 0, { name: '64 group notices drained' })
  t.alike(d.sent.map((s) => s.endpoint).sort(), endpoints.sort(), 'each member once')
  t.is(d.r.stats().seen, 64, 'one seen entry per recipient')
  for (const s of d.sent) t.alike(s.payload, { v: 1, kind: 'group', group: event.group, body: event.name, g: d.clock.t })
  await d.relay(event)
  t.is(d.sent.length, 64, 'immediate replay sends nothing')

  d.clock.t += 10 * 60 * 1000
  await d.relay(event)
  t.is(d.sent.length, 64, 'seen survives the cooldown')
  const next = member()
  const sub = await d.subscribe(next)
  await d.relay({ ...event, recipients: [members[0].hex, next.hex] })
  await until(() => d.r.stats().queued === 0 && d.r.stats().inFlight === 0, { name: 'overlapping chunk drained' })
  t.is(d.sent.length, 65, 'only the new recipient in the later chunk')
  t.is(d.sent[64].endpoint, sub.endpoint)
  t.is(d.r.stats().seen, 65)
  t.absent(d.logs.join('\n').includes(event.name), 'no group name in logs')
  noKeysLogged(t, d.logs)
})

test('relay: group cooldown is per group and member and ends at ten minutes', async (t) => {
  const d = await groupRoutes(t)
  const a = member()
  const b = member()
  const sa = await d.subscribe(a)
  const sb = await d.subscribe(b)
  const event = groupEvent([a.hex])
  const next = (recipients = [a.hex]) => groupEvent(recipients, { group: event.group })
  await d.relay(event)
  await d.relay(next([a.hex, b.hex]))
  await until(() => d.sent.length === 2, { name: 'one notice each' })
  t.alike(d.sent.map((s) => s.endpoint), [sa.endpoint, sb.endpoint])
  await d.relay(groupEvent([a.hex]))
  await until(() => d.sent.length === 3, { name: 'another group' })
  d.clock.t += 10 * 60 * 1000 - 1
  await d.relay(next())
  t.is(d.sent.length, 3, 'still inside the window')
  d.clock.t++
  await d.relay(next())
  await until(() => d.sent.length === 4, { name: 'next group window' })
  t.is(d.sent[3].endpoint, sa.endpoint)
  t.not(d.sent[3].topic, d.sent[0].topic, 'fresh topic for the next notice')
  noKeysLogged(t, d.logs)
})

test('relay: group validation accepts 64 recipients and refuses extra keys, private names and a 9 KB body', async (t) => {
  const s = await setup(t)
  const event = groupEvent(Array.from({ length: 64 }, () => member().hex))
  t.is(RELAY_BODY_MAX, 8192)
  t.ok(Buffer.byteLength(JSON.stringify(event)) > 1024, 'larger than the old body limit')
  const good = await s.relay(event)
  t.is(good.status, 202)
  t.alike(good.body, {})
  for (const bad of [
    { ...event, author: s.actor.hex },
    { ...event, visibility: 'private' },
    { ...event, recipients: [...event.recipients, s.m.hex] },
    { ...event, recipients: [s.m.hex, s.m.hex] },
    { ...event, recipients: [] },
    { ...event, nid: 'A'.repeat(32) },
    { ...event, name: '\u001b[31mnome' }
  ]) {
    const r = await s.relay(bad)
    t.is(r.status, 400)
    t.alike(r.body, { error: 'pedido-invalido' })
  }
  const oversized = JSON.stringify(event).padEnd(9 * 1024, ' ')
  t.is((await s.relay(oversized)).status, 413, 'valid JSON still exceeds the body limit')
  t.is(s.delivered.length, 0)
  noKeysLogged(t, s.logs)
})

test('relay: private group payloads contain only the kind and enqueue time, public names may be null', async (t) => {
  const d = await groupRoutes(t)
  const m = member()
  await d.subscribe(m)
  const event = groupEvent([m.hex], { visibility: 'private', name: null })
  await d.relay(event)
  await until(() => d.sent.length === 1, { name: 'private notice' })
  t.alike(d.sent[0].payload, { v: 1, kind: 'group-private', g: d.clock.t })
  t.absent(/[0-9a-f]{32}/.test(JSON.stringify(d.sent[0].payload)), 'no group, member or notice id')
  const publicEvent = groupEvent([m.hex], { name: null })
  await d.relay(publicEvent)
  await until(() => d.sent.length === 2, { name: 'unnamed public notice' })
  t.alike(d.sent[1].payload, { v: 1, kind: 'group', group: publicEvent.group, body: null, g: d.clock.t })
  noKeysLogged(t, d.logs)
})

test('relay: group Terms floor is 94 per member; skipped members keep their cooldown open', async (t) => {
  const old = member()
  const current = member()
  const future = member()
  const unreadable = member()
  let available = true
  let version = 93
  const d = await groupRoutes(t, {
    terms: {
      available: () => available,
      list: (m) => {
        if (m === unreadable.hex) throw new Error('indisponivel')
        return [{ version: m === old.hex ? version : m === future.hex ? 95 : 94 }]
      }
    }
  })
  t.is(GROUP_NOTICE_TERMS_FLOOR, 94)
  await d.subscribe(old)
  const currentSub = await d.subscribe(current)
  const futureSub = await d.subscribe(future)
  await d.subscribe(unreadable)
  const event = groupEvent([old.hex, current.hex, future.hex, unreadable.hex])
  await d.relay(event)
  await until(() => d.r.stats().queued === 0 && d.r.stats().inFlight === 0, { name: 'eligible group members' })
  t.alike(d.sent.map((s) => s.endpoint), [currentSub.endpoint, futureSub.endpoint])
  t.is(d.logs.filter((l) => l === JSON.stringify({ event: 'push', kind: 'group', reason: 'termos-pendentes' })).length, 2)
  version = 94
  await d.relay(groupEvent([old.hex], { group: event.group }))
  await until(() => d.sent.length === 3, { name: 'newly accepted terms without waiting' })

  const idle = member()
  const empty = groupEvent([idle.hex])
  await d.relay(empty)
  await d.subscribe(idle)
  available = false
  await d.relay(groupEvent([idle.hex], { group: empty.group }))
  t.ok(d.logs.includes(JSON.stringify({ event: 'push', kind: 'group', reason: 'indisponivel' })))
  available = true
  await d.relay(groupEvent([idle.hex], { group: empty.group }))
  await until(() => d.sent.length === 4, { name: 'new device without waiting' })
  noKeysLogged(t, d.logs)
})

test('relay: group notices have a separate hourly cap of 60 per member', async (t) => {
  const d = await groupRoutes(t)
  const m = member()
  const other = member()
  await d.subscribe(m)
  const otherSub = await d.subscribe(other)
  const first = groupEvent([m.hex])
  await d.relay(first)
  for (let i = 0; i < 61; i++) await d.relay(groupEvent([m.hex], { group: first.group }))
  for (let i = 0; i < 59; i++) await d.relay(groupEvent([m.hex]))
  const capped = groupEvent([m.hex, other.hex])
  await d.relay(capped)
  await until(() => d.r.stats().queued === 0 && d.r.stats().inFlight === 0, { name: 'hourly group cap drained' })
  t.is(d.sent.length, 61, 'cooldown refusals do not spend the hourly cap')
  t.is(d.sent[60].endpoint, otherSub.endpoint, 'the other member has a separate budget')
  t.is(d.logs.filter((l) => l === JSON.stringify({ event: 'push', kind: 'group', reason: 'teto' })).length, 1)
  await d.dm(m.hex)
  await d.relay({ v: 1, kind: 'like', actor: other.hex, recipient: m.hex, seq: 1, ref: m.hex + ':7', name: null })
  await until(() => d.sent.length === 63, { name: 'DM and social budgets remain available' })
  t.alike(d.sent.slice(61).map((s) => s.payload.kind), ['dm', 'like'])
  d.clock.t += 3600 * 1000 - 1
  await d.relay(groupEvent([m.hex], { group: capped.group }))
  t.is(d.sent.length, 63, 'still capped just before the next hour')
  d.clock.t++
  await d.relay(groupEvent([m.hex], { group: capped.group }))
  await until(() => d.sent.length === 64, { name: 'next hour without a cooldown charge from the refusal' })
  noKeysLogged(t, d.logs)
})

test('relay: group notices take at most half the queue and only charge a cooldown when every device fits', async (t) => {
  const half = Math.floor(MAX_QUEUE / 2)
  const big = member()
  const fits = member()
  const late = member()
  const broken = member()
  let unreadable = true
  const rows = new Map([[big.hex, half + 1], [fits.hex, half - 4], [late.hex, 5], [broken.hex, 1]])
  const pushStore = {
    available: () => true,
    list: (m) => {
      if (m === broken.hex && unreadable) throw new Error('indisponivel')
      return Array.from({ length: rows.get(m) || 0 }, (_, i) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + m.slice(0, 8) + i, p256dh: 'p' + i, auth: 'a' + i }))
    }
  }
  const d = await groupRoutes(t, { pushStore, delay: 60000 })
  const event = groupEvent([big.hex, fits.hex, late.hex, broken.hex])
  await d.relay(event)
  t.is(d.r.stats().queued, half - 4, 'only the member whose devices fit')
  t.is(d.r.stats().dropped, half + 1 + 5)
  t.ok(d.logs.includes(JSON.stringify({ event: 'push', kind: 'group', reason: 'indisponivel' })))
  rows.set(big.hex, 1)
  rows.set(late.hex, 2)
  unreadable = false
  await d.relay(groupEvent([big.hex, late.hex, broken.hex], { group: event.group }))
  t.is(d.r.stats().queued, half, 'the refused members still have their windows open')
  t.is(d.sent.length, 0, 'all notices wait for their delay')
  noKeysLogged(t, d.logs)
})

test('relay: group delays and HMAC topics are per member and shared by that member devices', async (t) => {
  let draws = 0
  const d = await groupRoutes(t, { delayMs: () => ++draws * 20 })
  const a = member()
  const b = member()
  const idle = member()
  const subs = [await d.subscribe(a), await d.subscribe(a), await d.subscribe(b)]
  const event = groupEvent([a.hex, b.hex, idle.hex])
  const g = d.clock.t
  await d.relay(event)
  t.is(draws, 2, 'one draw per member with devices')
  t.is(d.sent.length, 0)
  d.clock.t += 20
  await until(() => d.sent.length === 2, { name: 'first member devices' })
  t.alike(d.sent.map((s) => s.endpoint).sort(), subs.slice(0, 2).map((s) => s.endpoint).sort())
  d.clock.t += 20
  await until(() => d.sent.length === 3, { name: 'second member device' })
  t.is(d.sent[2].endpoint, subs[2].endpoint)
  t.is(d.sent[0].topic, d.sent[1].topic)
  t.not(d.sent[0].topic, d.sent[2].topic)
  for (const s of d.sent) {
    const recipient = s.endpoint === subs[2].endpoint ? b.hex : a.hex
    const input = 'group ' + event.nid + ' ' + g + ' ' + recipient
    t.is(s.topic, nodeCrypto.createHmac('sha256', TOPIC_KEY).update(input).digest('hex').slice(0, 32))
    t.not(s.topic, sha256(input).toString('hex').slice(0, 32), 'never a bare hash')
    t.is(s.payload.g, g, 'enqueue time, not send time')
  }
  noKeysLogged(t, d.logs)
})

// notifyInvite through createPushRoutes: a real push store on disk, an
// injected clock, and either the real sendPush over a fake push service or a
// send stub that records exactly what it was handed.
async function inviteRoutes (t, { vapid = true, spy = false, hold = false } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const clock = { t: Date.parse('2026-11-05T15:00:00.000Z') }
  clock.now = () => clock.t
  const pushStore = openPushStore(dir, { now: clock.now })
  const keys = generateVapidKeys()
  const delivered = []
  const statusOf = new Map()
  const fakeFetch = async (url, init) => {
    delivered.push({ url, headers: init.headers, body: init.body })
    return { status: statusOf.get(url) ?? 201, body: null }
  }
  const calls = []
  const held = []
  let holding = hold
  const send = async (args) => {
    calls.push(args)
    if (holding) await new Promise((resolve) => held.push(resolve))
    if (spy) return 'ok'
    return sendPush({ ...args, fetch: fakeFetch, now: clock.now() })
  }
  const logs = []
  const http = {
    send: () => {},
    sendError: () => {},
    readJsonBody: async () => ({}),
    checkPost: () => {},
    RouteError: Error,
    refuse: (code) => new Error(code),
    fromStore: (e) => e,
    keyedWindow: () => () => true
  }
  const r = createPushRoutes({
    association: '0'.repeat(64),
    accounts: { status: () => ({ linked: false }) },
    delayMs: () => 0,
    pushStore,
    vapid: vapid ? { ...keys, subject: ORIGIN } : null,
    send,
    topicKey: TOPIC_KEY,
    log: (e) => logs.push(JSON.stringify(e)),
    now: clock.now,
    http
  })
  async function subscribe (who, host) {
    const sub = subscription(host)
    await pushStore.put({ member: who.hex, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
    return sub
  }
  const release = () => {
    holding = false
    while (held.length > 0) held.shift()()
  }
  return { r, clock, pushStore, keys, delivered, statusOf, calls, logs, subscribe, release }
}

const INVITE_TOPIC = 'inviteTopic_0123456789abcdef'

function cleanInviteLogs (t, logs, endpoints) {
  const all = logs.join('\n')
  t.absent(/[0-9a-f]{64}/.test(all), 'no 64-hex key in the logs')
  for (const e of endpoints) t.absent(all.includes(e), 'no endpoint in the logs')
  t.absent(/convite|invite/i.test(all), 'no notice text in the logs')
  for (const line of logs) t.ok(Object.keys(JSON.parse(line)).every((k) => k === 'event' || k === 'reason'), 'only event and reason: ' + line)
}

test('notifyInvite: two devices get the kind-only payload, padded like a like, one topic, TTL from the deadline', async (t) => {
  const s = await inviteRoutes(t)
  const m = member()
  const subs = [await s.subscribe(m), await s.subscribe(m, 'updates.push.services.mozilla.com')]
  const deadline = s.clock.t + 3600 * 1000 + 500
  t.is(s.r.notifyInvite({ member: m.hex, topic: INVITE_TOPIC, deadline }), 'queued')
  await until(() => s.delivered.length === 2, { name: 'two sends' })
  for (const sub of subs) {
    const got = s.delivered.find((d) => d.url === sub.endpoint)
    t.ok(got, 'one send to each device')
    t.alike(JSON.parse(decrypt(got.body, sub.uaPrivate, sub.auth)), { v: 1, kind: 'invite-drop' })
    t.is(got.headers.Topic, INVITE_TOPIC)
    t.is(got.headers.TTL, '3601', 'the seconds left to the deadline, rounded up')
  }
  t.is(new Set(s.delivered.map((d) => d.headers.Topic)).size, 1)
  t.is(s.delivered[0].body.length, s.delivered[1].body.length)
  for (const c of s.calls) {
    t.is(c.payload, JSON.stringify({ v: 1, kind: 'invite-drop' }))
    t.is(c.padTo, PUSH_PAD_TO)
    t.is(c.ttlS, 3601)
  }
  // The same length as a like padded by the same rule.
  const like = encryptPayload({ p256dh: subs[0].p256dh, auth: subs[0].auth, plaintext: JSON.stringify({ v: 1, kind: 'like', body: 'Bia Souza curtiu seu post', actor: m.hex, recipient: m.hex, ref: m.hex + ':7' }), padTo: PUSH_PAD_TO })
  t.is(s.delivered[0].body.length, like.length, 'the length tells the kind apart from nothing')
  cleanInviteLogs(t, s.logs, subs.map((x) => x.endpoint))
})

test('notifyInvite: no transport or no device is none and sends nothing', async (t) => {
  const off = await inviteRoutes(t, { vapid: false, spy: true })
  const m = member()
  await off.subscribe(m)
  t.is(off.r.notifyInvite({ member: m.hex, topic: INVITE_TOPIC, deadline: off.clock.t + 60000 }), 'none', 'vapid null')
  t.is(off.r.room(), 0, 'no transport, no room: the loop claims nothing')
  const s = await inviteRoutes(t, { spy: true })
  t.is(s.r.notifyInvite({ member: member().hex, topic: INVITE_TOPIC, deadline: s.clock.t + 60000 }), 'none', 'no subscription')
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(off.calls.length + s.calls.length, 0)
  t.is(s.r.stats().queued, 0)
})

test('notifyInvite: a bad member, topic or deadline is a TypeError', async (t) => {
  const s = await inviteRoutes(t, { spy: true })
  const ok = { member: member().hex, topic: INVITE_TOPIC, deadline: s.clock.t + 60000 }
  for (const bad of [{ member: 'AB'.repeat(32) }, { member: 'ab' }, { topic: 'x'.repeat(33) }, { topic: 'a b' }, { topic: undefined }, { deadline: 1.5 }, { deadline: '1' }, { deadline: undefined }]) {
    t.exception.all(() => s.r.notifyInvite({ ...ok, ...bad }), TypeError, JSON.stringify(bad))
  }
})

test('notifyInvite: a deadline passed at send time sends nothing', async (t) => {
  const s = await inviteRoutes(t, { spy: true, hold: true })
  const m = member()
  const filler = member()
  for (let i = 0; i < 4; i++) await s.subscribe(filler)
  const sub = await s.subscribe(m)
  // Eight sends in flight keep the invite job queued while the clock moves.
  for (let i = 0; i < 2; i++) s.r.notifyInvite({ member: filler.hex, topic: INVITE_TOPIC, deadline: s.clock.t + 3600 * 1000 })
  t.is(s.calls.length, MAX_IN_FLIGHT)
  t.is(s.r.notifyInvite({ member: m.hex, topic: INVITE_TOPIC, deadline: s.clock.t + 1000 }), 'queued')
  t.is(s.r.stats().queued, 1)
  s.clock.t += 1000
  s.release()
  await until(() => s.r.stats().queued === 0 && s.r.stats().inFlight === 0, { name: 'drained' })
  t.absent(s.calls.some((c) => c.subscription.endpoint === sub.endpoint), 'past the deadline: never sent')
  t.ok(s.logs.includes(JSON.stringify({ event: 'push', reason: 'descartado' })))
  t.is(s.r.room(), INVITE_QUEUE_MAX, 'the dropped job left the invite count')
  cleanInviteLogs(t, s.logs, [sub.endpoint])
})

test('notifyInvite: the TTL handed to send is the seconds left, capped at 24 h', async (t) => {
  const s = await inviteRoutes(t, { spy: true })
  const m = member()
  await s.subscribe(m)
  s.r.notifyInvite({ member: m.hex, topic: INVITE_TOPIC, deadline: s.clock.t + 1 })
  s.r.notifyInvite({ member: m.hex, topic: INVITE_TOPIC, deadline: s.clock.t + 90 * 1000 })
  s.r.notifyInvite({ member: m.hex, topic: INVITE_TOPIC, deadline: s.clock.t + 3 * 86400 * 1000 })
  await until(() => s.calls.length === 3, { name: 'three sends' })
  t.alike(s.calls.map((c) => c.ttlS), [1, 90, 86400])
})

test('notifyInvite: room shrinks with queued invite jobs, never past a quarter of the queue, and a like still queues', async (t) => {
  const s = await inviteRoutes(t, { spy: true, hold: true })
  t.is(INVITE_QUEUE_MAX, Math.floor(MAX_QUEUE / 4))
  t.is(s.r.room(), INVITE_QUEUE_MAX)
  const members = []
  for (let i = 0; i < 40; i++) {
    const m = member()
    for (let j = 0; j < 4; j++) await s.subscribe(m)
    members.push(m)
  }
  const deadline = s.clock.t + 3600 * 1000
  // The first MAX_IN_FLIGHT jobs leave the queue for delivery at once.
  t.is(s.r.notifyInvite({ member: members[0].hex, topic: INVITE_TOPIC, deadline }), 'queued')
  t.is(s.r.notifyInvite({ member: members[1].hex, topic: INVITE_TOPIC, deadline }), 'queued')
  t.is(s.r.room(), INVITE_QUEUE_MAX)
  t.is(s.r.notifyInvite({ member: members[2].hex, topic: INVITE_TOPIC, deadline }), 'queued')
  t.is(s.r.room(), INVITE_QUEUE_MAX - 4)
  let i = 3
  let result
  while ((result = s.r.notifyInvite({ member: members[i++].hex, topic: INVITE_TOPIC, deadline })) === 'queued') {
    t.ok(s.r.stats().queued <= INVITE_QUEUE_MAX, 'never over the invite cap')
  }
  t.is(result, 'dropped', 'devices exist but nothing fit')
  t.is(s.r.room(), 0)
  t.is(s.r.stats().queued, INVITE_QUEUE_MAX)
  t.ok(s.logs.includes(JSON.stringify({ event: 'push', reason: 'descartado' })))

  // The social queue keeps its room: a like still enqueues.
  const token = 'ab'.repeat(32)
  const liker = member()
  const relayed = createPushRoutes({
    association: '0'.repeat(64),
    accounts: { status: () => ({ linked: false }) },
    delayMs: () => 0,
    pushStore: s.pushStore,
    vapid: { ...s.keys, subject: ORIGIN },
    send: () => new Promise(() => {}),
    relayTokenHash: sha256(token),
    log: () => {},
    now: s.clock.now,
    http: {
      send: () => {},
      sendError: () => { throw new Error('refused') },
      readJsonBody: async () => ({ v: 1, kind: 'like', actor: liker.hex, recipient: members[0].hex, seq: 1, ref: members[0].hex + ':7', name: null }),
      checkPost: () => {},
      RouteError: Error,
      refuse: (code) => new Error(code),
      fromStore: (e) => e,
      keyedWindow: () => () => true
    }
  })
  // A second routes object whose invite cap is full gets a relayed like.
  for (let k = 0; k < members.length; k++) relayed.notifyInvite({ member: members[k].hex, topic: INVITE_TOPIC, deadline })
  t.is(relayed.room(), 0)
  const queuedBefore = relayed.stats().queued
  await relayed.handleRelay({ method: 'POST', headers: { authorization: 'Bearer ' + token } }, {})
  t.is(relayed.stats().queued, queuedBefore + 4, 'the like queued for every device')
  t.is(relayed.room(), 0, 'and the invite room is unchanged')

  s.release()
  await until(() => s.r.stats().queued === 0 && s.r.stats().inFlight === 0, { name: 'drained' })
  t.is(s.r.room(), INVITE_QUEUE_MAX, 'every job that left gave its room back')
})

test('notifyInvite: a member gets every device or none', async (t) => {
  const s = await inviteRoutes(t, { spy: true, hold: true })
  const withDevices = async (n) => {
    const m = member()
    for (let j = 0; j < n; j++) await s.subscribe(m)
    return m
  }
  const deadline = s.clock.t + 3600 * 1000
  while (s.r.room() > 4) t.is(s.r.notifyInvite({ member: (await withDevices(4)).hex, topic: INVITE_TOPIC, deadline }), 'queued')
  t.is(s.r.room(), 4)
  t.is(s.r.notifyInvite({ member: (await withDevices(2)).hex, topic: INVITE_TOPIC, deadline }), 'queued')
  t.is(s.r.room(), 2)
  const four = await withDevices(4)
  const before = s.r.stats().queued
  t.is(s.r.notifyInvite({ member: four.hex, topic: INVITE_TOPIC, deadline }), 'dropped', 'two places left, four devices: none queued')
  t.is(s.r.stats().queued, before, 'nothing of that member entered the queue')
  t.ok(s.logs.includes(JSON.stringify({ event: 'push', reason: 'descartado' })))
  s.release()
  await until(() => s.r.stats().queued === 0 && s.r.stats().inFlight === 0, { name: 'drained' })
  const reached = new Set(s.pushStore.list(four.hex).map((x) => x.endpoint))
  t.absent(s.calls.some((c) => reached.has(c.subscription.endpoint)), 'no device of the dropped member got a send')
})

test('notifyInvite: no invite enters once member notices fill half the queue', async (t) => {
  const s = await inviteRoutes(t, { spy: true })
  const token = 'cd'.repeat(32)
  const recipient = member()
  const stored = []
  for (let j = 0; j < 4; j++) stored.push(await s.subscribe(recipient))
  let seq = 0
  const actor = member()
  const relayed = createPushRoutes({
    association: '0'.repeat(64),
    accounts: { status: () => ({ linked: false }) },
    delayMs: () => 0,
    pushStore: s.pushStore,
    vapid: { ...s.keys, subject: ORIGIN },
    send: () => new Promise(() => {}),
    relayTokenHash: sha256(token),
    topicKey: TOPIC_KEY,
    log: () => {},
    now: s.clock.now,
    http: {
      send: () => {},
      sendError: () => { throw new Error('refused') },
      readJsonBody: async () => ({ v: 1, kind: 'like', actor: actor.hex, recipient: recipient.hex, seq: ++seq, ref: recipient.hex + ':7', name: null }),
      checkPost: () => {},
      RouteError: Error,
      refuse: (code) => new Error(code),
      fromStore: (e) => e,
      keyedWindow: () => () => true
    }
  })
  t.is(relayed.room(), INVITE_QUEUE_MAX)
  while (relayed.stats().queued < Math.floor(MAX_QUEUE / 2)) {
    await relayed.handleRelay({ method: 'POST', headers: { authorization: 'Bearer ' + token } }, {})
  }
  t.is(relayed.room(), 0, 'half the queue holds member notices: no room for invites')
  const invited = member()
  await s.subscribe(invited)
  t.is(relayed.notifyInvite({ member: invited.hex, topic: INVITE_TOPIC, deadline: s.clock.t + 60000 }), 'dropped')
  t.is(stored.length, 4)
})

test('notifyInvite: a 410 removes the row; the relay still refuses an invite-drop event', async (t) => {
  const s = await inviteRoutes(t)
  const m = member()
  const gone = await s.subscribe(m)
  const live = await s.subscribe(m)
  s.statusOf.set(gone.endpoint, 410)
  t.is(s.r.notifyInvite({ member: m.hex, topic: INVITE_TOPIC, deadline: s.clock.t + 60000 }), 'queued')
  await until(() => s.logs.includes(JSON.stringify({ event: 'push', reason: 'removido' })), { name: 'removido' })
  t.alike(s.pushStore.list(m.hex).map((r) => r.endpoint), [live.endpoint])
  cleanInviteLogs(t, s.logs, [gone.endpoint, live.endpoint])

  const relay = await setup(t)
  await relay.acceptTerms(relay.m)
  const sub = subscription()
  await relay.toggle(relay.m, 'on', sub)
  const res = await relay.relay({ v: 1, kind: 'invite-drop' })
  t.is(res.status, 400)
  t.alike(res.body, { error: 'pedido-invalido' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(relay.delivered.length, 0, 'the relay never delivers an invite drop')
  cleanLogs(t, relay, [sub.endpoint])
})

// Privacy delay: every notice waits one random 0 to 60 s, shared by all its copies.
const HTTP_STUB = { send: () => {}, sendError: () => {}, readJsonBody: async () => ({}), checkPost: () => {}, RouteError: Error, refuse: (c) => new Error(c), fromStore: (e) => e, keyedWindow: () => () => true }

async function delayedRoutes (t, delays, extra = {}) {
  const s = await inviteRoutes(t, { spy: true })
  const timers = []
  const cleared = []
  const sent = []
  const logs = []
  let i = 0
  const r = createPushRoutes({
    association: '0'.repeat(64),
    accounts: { status: () => ({ linked: false }) },
    pushStore: s.pushStore,
    vapid: { ...s.keys, subject: ORIGIN },
    send: async (args) => { sent.push(args.subscription.endpoint); return 'ok' },
    delayMs: () => delays[i++ % delays.length],
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h },
    clearTimer: (h) => cleared.push(h),
    log: (e) => logs.push(e),
    now: s.clock.now,
    http: HTTP_STUB,
    ...extra
  })
  // Time passes and the latest timer fires.
  const fire = (ms = 60000) => {
    s.clock.t += ms
    timers[timers.length - 1].fn()
  }
  return { s, r, timers, cleared, sent, logs, fire }
}

const invite = (s, m) => ({ member: m.hex, topic: INVITE_TOPIC, deadline: s.clock.t + 300000 })

test('push delay: a job waits for its own random time, once, and a stale timer is replaced', async (t) => {
  const { s, r, timers, cleared, sent, fire } = await delayedRoutes(t, [30000, 5000])
  const m = member()
  const n = member()
  const a = await s.subscribe(m)
  const b = await s.subscribe(n)
  t.is(r.notifyInvite(invite(s, m)), 'queued')
  t.is(r.notifyInvite(invite(s, n)), 'queued')
  t.is(sent.length, 0, 'nothing is sent at enqueue time')
  t.is(r.stats().queued, 2)
  t.is(timers[timers.length - 1].ms, 5000, 'the timer targets the earliest job')
  fire(5000)
  await until(() => sent.length === 1, { name: 'first sent' })
  t.is(sent[0], b.endpoint)
  t.is(r.stats().queued, 1)
  fire(25000)
  await until(() => sent.length === 2, { name: 'second sent' })
  t.is(sent[1], a.endpoint)
  t.is(r.stats().queued, 0)
  t.ok(cleared.length > 0, 'a pending timer is cleared when re-armed')
  await r.close()
})

test('push delay: every copy of one notice leaves at the same time, from one draw', async (t) => {
  let draws = 0
  const { s, r, sent, fire } = await delayedRoutes(t, [30000], { delayMs: () => { draws++; return 30000 } })
  const m = member()
  await s.subscribe(m)
  await s.subscribe(m)
  await s.subscribe(m)
  t.is(r.notifyInvite(invite(s, m)), 'queued')
  t.is(draws, 1, 'one draw for the three copies of the invite')
  fire(29999)
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(sent.length, 0, 'no copy leaves early')
  fire(1)
  await until(() => sent.length === 3, { name: 'the three copies sent together' })
  t.is(r.notifyDeletion({ member: m.hex }), 'queued')
  t.is(draws, 2, 'one draw for the three copies of the deletion notice')
  await r.close()
  t.is(r.room(), 0, 'a closed service claims no invite slot')
})

test('push delay: a row turned off or re-keyed while its job waits is never sent to', async (t) => {
  const { s, r, sent, logs, fire } = await delayedRoutes(t, [30000])
  const m = member()
  const gone = await s.subscribe(m)
  const rekeyed = await s.subscribe(m)
  const moved = await s.subscribe(m)
  t.is(r.notifyInvite(invite(s, m)), 'queued')
  await s.pushStore.remove({ member: m.hex, endpoint: gone.endpoint })
  const fresh = subscription()
  await s.pushStore.put({ member: m.hex, endpoint: rekeyed.endpoint, p256dh: fresh.p256dh, auth: fresh.auth })
  const other = member()
  await s.pushStore.put({ member: other.hex, endpoint: moved.endpoint, p256dh: moved.p256dh, auth: moved.auth })
  fire()
  await until(() => r.stats().queued === 0 && r.stats().inFlight === 0 && r.stats().dropped >= 3, { name: 'dropped' })
  t.is(sent.length, 0, 'nothing was sent')
  t.is(r.stats().dropped, 3)
  t.is(logs.filter((e) => e.reason === 'descartado').length, 3)
  await r.close()
})

test('push delay: the relay path (/push-event) waits too', async (t) => {
  const token = 'ef'.repeat(32)
  const actor = member()
  const recipient = member()
  const event = { v: 1, kind: 'like', actor: actor.hex, recipient: recipient.hex, seq: 1, ref: recipient.hex + ':7', name: null }
  const { s, r, sent, timers, fire } = await delayedRoutes(t, [20000], {
    relayTokenHash: sha256(token),
    http: { ...HTTP_STUB, readJsonBody: async () => event }
  })
  const sub = await s.subscribe(recipient)
  await r.handleRelay({ method: 'POST', headers: { authorization: 'Bearer ' + token } }, {})
  t.is(sent.length, 0, 'not sent at once')
  t.is(r.stats().queued, 1)
  t.is(timers[timers.length - 1].ms, 20000)
  fire(20000)
  await until(() => sent.length === 1, { name: 'relay sent' })
  t.is(sent[0], sub.endpoint)
  await r.close()
})

test('push delay: a DM notice waits one delay for every device of the member', async (t) => {
  const token = 'fa'.repeat(32)
  const wakeKey = loadOrCreateWakeKey(path.join(tmpDir(t), 'wake'))
  const m = member()
  const { s, r, sent, timers, fire } = await delayedRoutes(t, [10000, 40000], {
    relayTokenHash: sha256(token),
    wakeKey,
    terms: { available: () => true, list: () => [{ version: DM_NOTICE_TERMS_FLOOR }] },
    http: { ...HTTP_STUB, readJsonBody: async () => ({ v: 1, kind: 'dm', box: sealDmNotice(m.hex, wakeKey.publicKey).toString('base64url') }) }
  })
  const a = await s.subscribe(m)
  const b = await s.subscribe(m)
  await r.handleRelay({ method: 'POST', headers: { authorization: 'Bearer ' + token } }, {})
  t.is(sent.length, 0, 'not sent at once')
  t.is(r.stats().queued, 2)
  t.is(timers[timers.length - 1].ms, 10000, 'one draw for every device')
  fire(10000)
  await until(() => sent.length === 2, { name: 'both devices together' })
  t.alike(sent.slice().sort(), [a.endpoint, b.endpoint].sort())
  await r.close()
})

test('push delay: a deletion notice waits', async (t) => {
  const { s, r, sent, timers, fire } = await delayedRoutes(t, [15000])
  const m = member()
  const sub = await s.subscribe(m)
  t.is(r.notifyDeletion({ member: m.hex }), 'queued')
  t.is(sent.length, 0, 'not sent at once')
  t.is(timers[timers.length - 1].ms, 15000)
  fire(15000)
  await until(() => sent.length === 1, { name: 'deletion sent' })
  t.is(sent[0], sub.endpoint)
  await r.close()
})

test('push delay: close sends the jobs still waiting, now, once, and clears the timer', async (t) => {
  const { s, r, timers, cleared, sent } = await delayedRoutes(t, [40000])
  const m = member()
  const sub = await s.subscribe(m)
  r.notifyInvite(invite(s, m))
  const pending = timers[timers.length - 1]
  t.is(sent.length, 0)
  await r.close()
  t.ok(cleared.includes(pending), 'timer cleared')
  t.alike(sent, [sub.endpoint], 'flushed at close')
  t.is(r.stats().queued, 0)
  pending.fn()
  await r.close()
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is(sent.length, 1, 'no second send')
  // A job queued after close is never sent.
  t.is(r.notifyDeletion({ member: m.hex }), 'queued')
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is(sent.length, 1, 'nothing after close')
})

test('push delay: close flush is bounded and never waits on a send that hangs', async (t) => {
  const timers = []
  const hang = await delayedRoutes(t, [40000], { send: () => new Promise(() => {}), setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h } })
  const m = member()
  await hang.s.subscribe(m)
  hang.r.notifyDeletion({ member: m.hex })
  const closing = hang.r.close()
  const limit = timers[timers.length - 1]
  t.is(limit.ms, 3000, 'bounded by a short total timeout')
  limit.fn()
  await closing
  t.pass('close returned')
})

test('push delay: the default delay is crypto-random in [0, 60000] and a timer is armed and unref-ed', async (t) => {
  const { pushDelay, PUSH_DELAY_MAX_MS } = require('../lib/account/push-routes')
  t.is(PUSH_DELAY_MAX_MS, 60000)
  const seen = new Set()
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < 2000; i++) {
    const d = pushDelay()
    if (!Number.isInteger(d) || d < 0 || d > 60000) return t.fail('out of range: ' + d)
    seen.add(d)
    min = Math.min(min, d)
    max = Math.max(max, d)
  }
  t.ok(seen.size > 1000, 'real variation (' + seen.size + ' distinct)')
  t.ok(min < 3000 && max > 57000, 'spread over the whole range')

  const s = await inviteRoutes(t, { spy: true })
  let handle = null
  const r = createPushRoutes({
    association: '0'.repeat(64),
    accounts: { status: () => ({ linked: false }) },
    pushStore: s.pushStore,
    vapid: { ...s.keys, subject: ORIGIN },
    send: async () => 'ok',
    delayMs: () => 5000,
    setTimer: (fn, ms) => { handle = { ms, unref () { this.unrefed = true } }; return handle },
    clearTimer: () => {},
    log: () => {},
    now: s.clock.now,
    http: HTTP_STUB
  })
  const m = member()
  await s.subscribe(m)
  r.notifyInvite(invite(s, m))
  t.ok(handle !== null, 'a timer was armed')
  t.is(handle.ms, 5000)
  t.ok(handle.unrefed, 'unref-ed')
  await r.close()
})

// A tick in flight may still queue a push: it must reach the queue before
// close() flushes it, or its invite slot is marked and never sent.
test('serve: the invite loop and the deletion sweep stop before the push queue closes (issue #231)', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'commands', 'account.js'), 'utf8')
  const close = src.indexOf('await listener.close()')
  t.ok(close > 0, 'serve() closes the listener')
  const loop = src.indexOf('await loop.stop()')
  t.ok(loop > 0 && loop < close, 'the invite loop stops first')
  const sweep = src.indexOf('if (stopDeletionSweep !== null) stopDeletionSweep()')
  t.ok(sweep > 0 && sweep < close, 'the deletion sweep stops first')
})

test('relay: one actor gets 30 pushes an hour across all recipients; another actor and the next hour still go through', async (t) => {
  const { keyedWindow } = require('../lib/account/server')
  const token = 'cd'.repeat(32)
  const hexOf = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex')
  const recipients = []
  for (let i = 0; i < 40; i++) recipients.push(hexOf('r' + i))
  const pushStore = {
    available: () => true,
    all: () => [],
    list: (m) => recipients.includes(m) ? [{ endpoint: 'https://fcm.googleapis.com/fcm/send/' + m.slice(0, 8), p256dh: 'p', auth: 'a' }] : [],
    remove: async () => ({ changed: true })
  }
  const logs = []
  const clock = { t: Date.parse('2026-11-03T12:00:00.000Z') }
  let next = null
  const http = {
    send: () => {},
    sendError: () => { throw new Error('refused') },
    readJsonBody: async () => next,
    checkPost: () => {},
    RouteError: Error,
    refuse: (code) => new Error(code),
    fromStore: (e) => e,
    keyedWindow
  }
  const r = createPushRoutes({
    association: '0'.repeat(64),
    accounts: { status: () => ({ linked: false }) },
    delayMs: () => 0,
    relayTokenHash: sha256(token),
    pushStore,
    vapid: {},
    send: () => Promise.resolve('ok'),
    log: (e) => logs.push(e),
    now: () => clock.t,
    http
  })
  let seq = 0
  const mention = (actor, recipient) => {
    next = { v: 1, kind: 'mention', actor, recipient, seq: ++seq, ref: actor + ':' + seq, name: null }
    return r.handleRelay({ method: 'POST', headers: { authorization: 'Bearer ' + token } }, {})
  }
  const capped = () => logs.filter((e) => e.reason === 'teto').length
  const spammer = hexOf('spammer')

  // 15 to one recipient: the pair cap refuses 5, and those spend no actor slot.
  for (let i = 0; i < 15; i++) await mention(spammer, recipients[0])
  t.is(capped(), 5, 'the pair cap refuses the 11th to 15th')
  for (let i = 1; i <= 20; i++) await mention(spammer, recipients[i])
  t.is(capped(), 5, '30 queued pushes pass: refused ones spent no actor slot')
  await mention(spammer, recipients[21])
  t.is(capped(), 6, 'the 31st queued push is teto')
  await mention(hexOf('other'), recipients[22])
  t.is(capped(), 6, 'another actor still reaches a recipient')
  clock.t += 3600 * 1000
  await mention(spammer, recipients[23])
  t.is(capped(), 6, 'the next hour opens a new window')
  await until(() => r.stats().queued === 0 && r.stats().inFlight === 0, { name: 'drained' })
})

// Recall: an undone follow, like or repost drops the notice while it still
// waits for its delay. The real keyedWindow, so the cooldown is the one
// deliver charges.
async function recallRoutes (t, extra = {}) {
  const token = 'cd'.repeat(32)
  let next = null
  const replies = []
  // Every window give-back, so a test can count refunds (four each).
  const releases = []
  const counted = (...args) => {
    const w = keyedWindow(...args)
    const check = (...a) => w(...a)
    check.release = (key, at) => {
      releases.push(key)
      w.release(key, at)
    }
    return check
  }
  const d = await delayedRoutes(t, [30000], {
    relayTokenHash: sha256(token),
    http: { ...HTTP_STUB, send: (res, status) => replies.push(status), readJsonBody: async () => next, keyedWindow: counted },
    ...extra
  })
  const relay = (event) => {
    next = event
    return d.r.handleRelay({ method: 'POST', headers: { authorization: 'Bearer ' + token } }, {})
  }
  let seq = 0
  const notice = (kind, from, to, ref = null) => relay({ v: 1, kind, actor: from.hex, recipient: to.hex, seq: ++seq, ref, name: null })
  const undo = (kind, from, to, ref = null) => relay({ v: 1, op: 'cancel', kind, actor: from.hex, recipient: to.hex, ref })
  const reasons = () => d.logs.map((e) => e.reason)
  const clean = (t) => {
    for (const e of d.logs) t.ok(Object.keys(e).every((k) => k === 'event' || k === 'reason'), 'only event and reason')
  }
  return { ...d, token, replies, releases, relay, notice, undo, reasons, clean }
}

test('recall: a cancel drops every waiting copy of the like, 202, and a new like of the same post is delivered', async (t) => {
  const { s, r, sent, fire, replies, notice, undo, reasons, clean } = await recallRoutes(t)
  const actor = member()
  const m = member()
  const a = await s.subscribe(m)
  const b = await s.subscribe(m)
  const post = m.hex + ':7'
  await notice('like', actor, m, post)
  t.is(r.stats().queued, 2, 'one copy per device waits')
  await undo('like', actor, m, post)
  t.alike(replies, [202, 202])
  t.is(r.stats().queued, 0, 'both copies recalled')
  t.ok(reasons().includes('cancelado'))
  fire()
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(sent.length, 0, 'nothing was sent')
  await notice('like', actor, m, post)
  t.is(r.stats().queued, 2, 'the recall gave the cooldown back')
  fire()
  await until(() => sent.length === 2, { name: 'the new like sent' })
  t.alike(sent.slice().sort(), [a.endpoint, b.endpoint].sort())
  t.is(r.stats().dropped, 0, 'a recall is not a drop')
  clean(t)
  await r.close()
})

test('recall: only the same kind, actor, recipient and ref is dropped', async (t) => {
  const { s, r, sent, fire, notice, undo, reasons } = await recallRoutes(t)
  const actor = member()
  const other = member()
  const m = member()
  const n = member()
  await s.subscribe(m)
  await s.subscribe(n)
  const post = m.hex + ':7'
  await notice('like', actor, m, post)
  await notice('like', actor, m, m.hex + ':8')
  await notice('like', other, m, post)
  await notice('repost', actor, m, post)
  await notice('like', actor, n, n.hex + ':7')
  await notice('follow', actor, m)
  t.is(r.stats().queued, 6)
  await undo('like', actor, m, post)
  t.is(r.stats().queued, 5, 'only the matching like')
  await undo('follow', other, m)
  await undo('repost', actor, m, m.hex + ':8')
  await undo('like', actor, m, post)
  t.is(r.stats().queued, 5, 'no other notice matches, and a recalled one is gone')
  t.alike(reasons().filter((x) => x === 'cancelado' || x === 'descartado'), ['cancelado', 'descartado', 'descartado', 'descartado'])
  await undo('follow', actor, m)
  t.is(r.stats().queued, 4, 'a follow recall has no ref')
  fire()
  await until(() => sent.length === 4, { name: 'the rest sent' })
  await r.close()
})

test('recall: an invite drop, a deletion notice and a DM notice never match', async (t) => {
  const wakeKey = loadOrCreateWakeKey(path.join(tmpDir(t), 'wake'))
  const { s, r, sent, fire, relay, undo, reasons } = await recallRoutes(t, {
    wakeKey,
    terms: { available: () => true, list: () => [{ version: DM_NOTICE_TERMS_FLOOR }] }
  })
  const actor = member()
  const m = member()
  await s.subscribe(m)
  t.is(r.notifyInvite(invite(s, m)), 'queued')
  t.is(r.notifyDeletion({ member: m.hex }), 'queued')
  await relay({ v: 1, kind: 'dm', box: sealDmNotice(m.hex, wakeKey.publicKey).toString('base64url') })
  t.is(r.stats().queued, 3)
  await undo('follow', actor, m)
  await undo('like', actor, m, m.hex + ':1')
  await undo('repost', actor, m, m.hex + ':1')
  t.is(r.stats().queued, 3, 'nothing recalled')
  t.absent(reasons().includes('cancelado'))
  t.is(r.room(), INVITE_QUEUE_MAX - 1, 'the invite still holds its slot')
  fire()
  await until(() => sent.length === 3, { name: 'all three sent' })
  await r.close()
})

test('recall: a copy already in flight is sent, and the cooldown stays spent', async (t) => {
  const held = []
  const { s, r, sent, notice, undo, reasons } = await recallRoutes(t, {
    delayMs: () => 0,
    send: (args) => new Promise((resolve) => held.push(() => { sent.push(args.subscription.endpoint); resolve('ok') }))
  })
  const actor = member()
  const filler = member()
  const m = member()
  // Other notices hold all but two slots, so two of m's four copies leave
  // at once and two wait for room.
  for (let i = 0; i < MAX_IN_FLIGHT - 2; i++) {
    const other = member()
    await s.subscribe(other)
    await notice('follow', filler, other)
  }
  const mine = []
  for (let i = 0; i < 4; i++) mine.push((await s.subscribe(m)).endpoint)
  const post = m.hex + ':7'
  await notice('like', actor, m, post)
  t.is(r.stats().inFlight, MAX_IN_FLIGHT, 'the pool is full')
  t.is(r.stats().queued, 2, 'two copies still wait')
  await undo('like', actor, m, post)
  t.is(r.stats().queued, 0, 'the waiting copies are recalled')
  t.is(r.stats().inFlight, MAX_IN_FLIGHT, 'the copies in flight stay')
  t.ok(reasons().includes('cancelado'))
  while (held.length > 0) held.shift()()
  await until(() => r.stats().inFlight === 0, { name: 'in-flight copies done' })
  t.is(sent.filter((e) => mine.includes(e)).length, 2, 'the copies in flight were sent, the recalled ones never')
  await notice('like', actor, m, post)
  t.is(r.stats().queued + r.stats().inFlight, 0, 'a device already got it: the cooldown still holds')
  t.is(reasons()[reasons().length - 1], 'descartado')
  await undo('like', actor, m, post)
  t.is(reasons()[reasons().length - 1], 'descartado', 'nothing left to recall')
  await r.close()
})

test('recall: like and unlike loops inside the delay leave the actor, pair and recipient budgets untouched', async (t) => {
  const { s, r, notice, undo, reasons } = await recallRoutes(t)
  const teto = () => reasons().filter((x) => x === 'teto').length
  const m = member()
  const xs = [member(), member(), member()]
  for (const who of [m, ...xs]) await s.subscribe(who)
  const attacker = member()
  const others = Array.from({ length: 6 }, () => member())
  // 40 cycles from one actor (over its 30) and 70 on one recipient (over
  // its 60), 10 per pair.
  for (const to of [m, ...xs]) {
    for (let i = 0; i < 10; i++) {
      await notice('like', attacker, to, to.hex + ':1')
      await undo('like', attacker, to, to.hex + ':1')
    }
  }
  for (const from of others) {
    for (let i = 0; i < 10; i++) {
      await notice('like', from, m, m.hex + ':1')
      await undo('like', from, m, m.hex + ':1')
    }
  }
  t.is(teto(), 0, 'no cycle was capped')
  t.is(r.stats().queued, 0, 'every cycle was recalled')
  for (let i = 0; i < 10; i++) await notice('like', attacker, m, m.hex + ':' + (100 + i))
  t.is(teto(), 0, 'the pair budget is whole: 10 pass')
  await notice('like', attacker, m, m.hex + ':110')
  t.is(teto(), 1, 'the 11th is teto')
  for (let i = 0; i < 10; i++) await notice('like', attacker, xs[0], xs[0].hex + ':' + (100 + i))
  for (let i = 0; i < 10; i++) await notice('like', attacker, xs[1], xs[1].hex + ':' + (100 + i))
  t.is(teto(), 1, 'the actor budget is whole: 30 pass')
  await notice('like', attacker, xs[2], xs[2].hex + ':100')
  t.is(teto(), 2, 'the 31st is teto')
  const fresh = Array.from({ length: 6 }, () => member())
  for (const from of fresh.slice(0, 5)) {
    for (let i = 0; i < 10; i++) await notice('like', from, m, m.hex + ':' + (200 + i))
  }
  t.is(teto(), 2, 'the recipient budget is whole: 60 pass')
  await notice('like', fresh[5], m, m.hex + ':200')
  t.is(teto(), 3, 'the 61st is teto')
  await r.close()
})

test('recall: a notice whose only copy the push service refused as gone gives its cooldown back', async (t) => {
  const outcomes = ['gone']
  const { s, r, sent, fire, notice, undo, reasons, releases } = await recallRoutes(t, {
    send: async (args) => {
      const outcome = outcomes.length > 0 ? outcomes.shift() : 'ok'
      if (outcome === 'ok') sent.push(args.subscription.endpoint)
      return outcome
    }
  })
  const actor = member()
  const m = member()
  await s.subscribe(m)
  const post = m.hex + ':7'
  await notice('like', actor, m, post)
  fire()
  await until(() => r.stats().queued === 0 && r.stats().inFlight === 0, { name: 'the copy settled' })
  t.ok(reasons().includes('removido'), 'the gone row was removed')
  await undo('like', actor, m, post)
  t.is(reasons()[reasons().length - 1], 'cancelado', 'the undo recalls a notice no device got')
  t.is(releases.length, 4, 'one refund')
  // The browser subscribes again, so the redo has a device.
  const b = await s.subscribe(m)
  await notice('like', actor, m, post)
  t.is(r.stats().queued, 1, 'the redo is queued, not descartado')
  fire()
  await until(() => sent.length === 1, { name: 'the redo sent' })
  t.is(sent[0], b.endpoint)
  await r.close()
})

// 'dropped' covers a timeout or a reset after the push service may have
// taken the POST, so the notice may be on the device already.
test('recall: a dropped copy then a cancel refunds nothing', async (t) => {
  const outcomes = ['dropped']
  const { s, r, fire, notice, undo, reasons, releases } = await recallRoutes(t, {
    send: async () => outcomes.length > 0 ? outcomes.shift() : 'ok'
  })
  const teto = () => reasons().filter((x) => x === 'teto').length
  const actor = member()
  const m = member()
  await s.subscribe(m)
  const post = m.hex + ':7'
  await notice('like', actor, m, post)
  fire()
  await until(() => r.stats().queued === 0 && r.stats().inFlight === 0, { name: 'the copy settled' })
  t.ok(reasons().includes('falhou'))
  await undo('like', actor, m, post)
  t.is(reasons()[reasons().length - 1], 'descartado', 'nothing to recall')
  t.is(releases.length, 0, 'no refund')
  await notice('like', actor, m, post)
  t.is(reasons()[reasons().length - 1], 'descartado', 'the cooldown still holds')
  for (let i = 0; i < 9; i++) await notice('like', actor, m, m.hex + ':' + (100 + i))
  t.is(teto(), 0)
  await notice('like', actor, m, m.hex + ':109')
  t.is(teto(), 1, 'the pair budget stays spent: the 10th is teto')
  await r.close()
})

test('recall: a notice a device got refunds nothing', async (t) => {
  const { s, r, sent, fire, notice, undo, reasons } = await recallRoutes(t)
  const teto = () => reasons().filter((x) => x === 'teto').length
  const actor = member()
  const m = member()
  await s.subscribe(m)
  const post = m.hex + ':7'
  await notice('like', actor, m, post)
  fire()
  await until(() => sent.length === 1 && r.stats().inFlight === 0, { name: 'sent' })
  await undo('like', actor, m, post)
  t.is(reasons()[reasons().length - 1], 'descartado', 'nothing to recall')
  await notice('like', actor, m, post)
  t.is(reasons()[reasons().length - 1], 'descartado', 'the cooldown still holds')
  for (let i = 0; i < 9; i++) await notice('like', actor, m, m.hex + ':' + (100 + i))
  t.is(teto(), 0)
  await notice('like', actor, m, m.hex + ':109')
  t.is(teto(), 1, 'the pair budget stays spent: the 10th is teto')
  await r.close()
})

// Two copies in flight when the undo comes: the refund waits for both, and
// happens once, only if neither may have reached a device. pump runs the
// refund right after it counts a send down, so inFlight reaching a value
// means every copy settled by then has had its refund check.
async function inFlightRecall (t, outcomes) {
  const held = []
  const d = await recallRoutes(t, {
    delayMs: () => 0,
    send: () => new Promise((resolve) => held.push(resolve))
  })
  const { s, r, notice, undo, reasons, releases } = d
  const teto = () => reasons().filter((x) => x === 'teto').length
  const actor = member()
  const m = member()
  await s.subscribe(m)
  await s.subscribe(m)
  const post = m.hex + ':7'
  await notice('like', actor, m, post)
  t.is(r.stats().inFlight, 2, 'both copies in flight')
  await undo('like', actor, m, post)
  t.is(reasons()[reasons().length - 1], 'cancelado')
  await notice('like', actor, m, post)
  t.is(reasons()[reasons().length - 1], 'descartado', 'no refund while a copy is out')
  t.is(r.stats().inFlight, 2, 'the redo queued nothing')
  held[0](outcomes[0])
  await until(() => r.stats().inFlight === 1, { name: 'the first copy settled' })
  t.is(releases.length, 0, 'no refund while the other copy is out')
  held[1](outcomes[1])
  await until(() => r.stats().inFlight === 0, { name: 'both copies settled' })
  await undo('like', actor, m, post)
  t.is(reasons()[reasons().length - 1], 'descartado', 'a cancelled notice is not recalled twice')
  return { ...d, teto, actor, m, post, held }
}

test('recall: copies in flight that are both gone give the charges back once', async (t) => {
  const { s, r, notice, releases, actor, m, post, held } = await inFlightRecall(t, ['gone', 'gone'])
  // Cooldown, actor, pair and recipient, once each: zero refunds give 0 and
  // two give 8.
  t.is(releases.length, 4, 'exactly one refund')
  t.is(new Set(releases).size, 4, 'one give-back per window')
  // Both rows were removed: the browser subscribes again.
  await s.subscribe(m)
  await notice('like', actor, m, post)
  t.is(r.stats().inFlight, 1, 'the redo is sent, not descartado')
  const release = () => { while (held.length > 0) held.shift()('ok') }
  await until(() => { release(); return r.stats().inFlight === 0 && r.stats().queued === 0 }, { name: 'drained' })
  await r.close()
})

for (const outcomes of [['gone', 'ok'], ['gone', 'dropped']]) {
  test('recall: copies in flight where one may reach a device refund nothing (' + outcomes[1] + ')', async (t) => {
    const { r, notice, teto, reasons, releases, actor, m, post, held } = await inFlightRecall(t, outcomes)
    t.is(releases.length, 0, 'no refund')
    await notice('like', actor, m, post)
    t.is(reasons()[reasons().length - 1], 'descartado', 'the cooldown still holds')
    // Pair window: the recalled like. Nine more pass, the tenth is teto.
    for (let i = 0; i < 9; i++) await notice('like', actor, m, m.hex + ':' + (200 + i))
    t.is(teto(), 0)
    await notice('like', actor, m, m.hex + ':209')
    t.is(teto(), 1, 'the pair budget stays spent')
    const release = () => { while (held.length > 0) held.shift()('ok') }
    await until(() => { release(); return r.stats().inFlight === 0 && r.stats().queued === 0 }, { name: 'drained' })
    await r.close()
  })
}
