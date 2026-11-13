'use strict'

// apps/cli/lib/account/server.js and apps/cli/lib/commands/account.js: the
// account service, the phone sign-up (./helpers/phone-link.js and the SMS
// stub) and the account-link signer with random key pairs. The member Google
// sign-in is retired: a loopback fake Google (as google.test.js) is still
// passed in, and its request log proves the retired routes never call out.
// No socket leaves 127.0.0.1: the service binds loopback, the fake provider
// binds loopback, and the spawned CLI only answers health and refusals.

const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert, certForKey, verifyUsernameRecord } = require('@varanda/core/lib/cert')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { signPhone, isBrMobile } = require('@varanda/core/lib/phone')
const { createGoogle } = require('../lib/account/google')
const { openAccountStore, phoneSub, COOLDOWN_MS, PENDING_TTL_MS } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openInvitesStore, inviteId } = require('../lib/account/invites-store')
const { createAccountServer, keyedWindow, takeLock, lockHeld, loadIssuer, LOCK_FILE, KEY_FILE, CERT_FILE, COOKIE, MAX_SOCKETS, DEFAULT_RATE, DEFAULT_BURST } = require('../lib/account/server')
const { readEnv, closeIfOwned, loseLock, startTermsHeal, startHeal, storeUnavailable } = require('../lib/commands/account')
const { UsageError } = require('../lib/cli')
const { STUB_CODE } = require('../scripts/phone-stub')
const { tmpDir, until } = require('./helpers/net')
const { linkByPhone, phoneServerOptions } = require('./helpers/phone-link')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-de-teste'
// A 22-digit subject: any leak shows as a 16-hex run in a log line.
const SUB = '1098765432109876543210'
const EMAIL = 'membro@example.test'
const ACCESS = 'ya29.access-token-de-teste'
const HEX16 = /[0-9a-f]{16}/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

function b64url (obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function idToken (sub) {
  const payload = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, exp: Math.floor(Date.now() / 1000) + 3600 }
  return b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(payload) + '.c2ln'
}

function json (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

// Fake provider on 127.0.0.1; `account.sub` / `account.email` are what the
// next exchange answers; `seen` records every request; `account.onToken`,
// when set, runs before the token answer (something that happens mid-exchange).
async function fakeGoogle (t) {
  const seen = []
  const account = { sub: SUB, email: EMAIL, tokenStatus: 200 }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname
      seen.push({ method: req.method, path: pathname, headers: req.headers, body })
      if (pathname === '/token') {
        if (account.onToken) account.onToken()
        if (account.tokenStatus !== 200) return json(res, account.tokenStatus, { error: 'invalid_grant' })
        return json(res, 200, { access_token: ACCESS, token_type: 'Bearer', expires_in: 3599, id_token: idToken(account.sub) })
      }
      if (pathname === '/userinfo') return json(res, 200, { sub: account.sub, email: account.email, email_verified: true })
      res.writeHead(404).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }), { force: true })
  const endpoints = { authUrl: base + '/auth', tokenUrl: base + '/token', userinfoUrl: base + '/userinfo' }
  const fetch = (url, init) => {
    if (!String(url).startsWith(base + '/')) throw new Error('non-loopback request')
    return globalThis.fetch(url, init)
  }
  return { seen, account, endpoints, fetch }
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

// A clock that starts at the real time and can be advanced (rate windows
// and TTLs follow it). Setting `frozen` stops it at that instant.
function clock () {
  const c = { offset: 0, frozen: null, now: () => (c.frozen ?? Date.now()) + c.offset }
  return c
}

// The service checks Origin against its own origin, and the phone driver
// sends its fetch base as Origin, so the service listens on a port known
// before it is created.
async function freePort () {
  const srv = net.createServer()
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address()
  await new Promise((resolve) => srv.close(resolve))
  return port
}

// `phone` (default true) turns hosted phone verification on with the SMS
// stub: the only way a new member links. `google` is still passed (the
// service ignores it), so `fake.seen` counts any outbound request.
async function setup (t, { configured = true, phone = true, storeOpts = {}, serverOpts = {} } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  const iss = issuer()
  const fake = await fakeGoogle(t)
  const google = createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/callback', endpoints: fake.endpoints, fetch: fake.fetch })
  const store = openAccountStore(dir, { now: c.now, ...storeOpts })
  const phoneOpts = phone ? phoneServerOptions() : null
  const logs = []
  const port = await freePort()
  const base = 'http://127.0.0.1:' + port
  const server = createAccountServer({
    association: iss.association,
    origin: base,
    google,
    store,
    issuer: configured ? { keyPair: iss.keyPair, cert: iss.cert } : null,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now,
    phoneClient: phoneOpts === null ? null : phoneOpts.phoneClient,
    phones: phoneOpts === null ? null : phoneOpts.phones,
    ...serverOpts
  })
  const listener = await server.listen({ host: '127.0.0.1', port })
  t.teardown(() => listener.close(), { force: true })

  // { status, headers, body (parsed JSON or null), text }
  async function api (method, pathname, { body, cookie, origin = base, headers = {}, raw } = {}) {
    const init = { method, redirect: 'manual', headers: { ...headers } }
    if (cookie) init.headers.cookie = COOKIE + '=' + cookie
    if (body !== undefined || raw !== undefined) {
      if (origin !== null) init.headers.origin = origin
      if (!('content-type' in init.headers)) init.headers['content-type'] = 'application/json'
      init.body = raw !== undefined ? raw : JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, body: parsed, text }
  }

  return { dir, c, iss, fake, store, logs, api, base, origin: base, port: listener.port, listener, server }
}

function cookieOf (res) {
  const header = res.headers.get('set-cookie')
  const m = /^__Host-varanda-link=([A-Za-z0-9_-]+); Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=(\d+)$/.exec(header || '')
  return m ? { id: m[1], maxAge: Number(m[2]) } : null
}

function sign (s, m, phase, nonce, username, sub = '') {
  return signAccountLink({ phase, nonce, member: m.hex, username, association: s.iss.association, sub }, m.kp)
}

// The finish proof of the phone link: its subject is phoneSub(member).
function finishSig (s, m, nonce, username) {
  return sign(s, m, 'finish', nonce, username, phoneSub(m.hex))
}

// The signer linkByPhone takes: phone steps are varanda-phone-v1
// statements, the finish the account-link proof.
function signer (s, m) {
  return (fields) => fields.phase === 'finish'
    ? signAccountLink({ ...fields, association: s.iss.association }, m.kp)
    : signPhone({ ...fields, association: s.iss.association }, m.kp)
}

// One Brazilian mobile per call, so two members never share a number.
let phoneSeq = nodeCrypto.randomInt(0, 100000000)
function freshPhone () {
  phoneSeq = (phoneSeq + 1) % 100000000
  const phone = '+55119' + String(phoneSeq).padStart(8, '0')
  if (!isBrMobile(phone)) throw new Error('bad test phone')
  return phone
}

// The phone check alone (start, send, check with STUB_CODE), so a test can
// drive /account/finish itself; -> the check answer. `headers` go on every
// step (the app header, for one).
async function verifyPhone (s, m, { headers, origin } = {}) {
  const step = async (action, extra) => {
    const started = await s.api('POST', '/account/phone/start', { origin, headers, body: { member: m.hex } })
    const nonce = started.body.nonce
    const signature = signPhone({ action, nonce, member: m.hex, association: s.iss.association }, m.kp)
    return s.api('POST', '/account/phone/' + action, { origin, headers, body: { member: m.hex, nonce, signature, ...extra } })
  }
  const sent = await step('send', { phone: freshPhone() })
  if (sent.status !== 200) return sent
  return step('check', { code: STUB_CODE })
}

// Web start; -> { started, cookie, nonce }.
async function startLink (s, m, username) {
  const started = await s.api('POST', '/account/start', { body: { member: m.hex, username } })
  if (started.status !== 200) return { started }
  return { started, cookie: cookieOf(started).id, nonce: started.body.nonce }
}

// The whole phone link for `m` (helpers/phone-link.js); -> { finish:
// { status, body } }, the finish answer or the refusal of the step that
// failed.
async function link (s, m, username, { app = false } = {}) {
  try {
    const body = await linkByPhone({ origin: s.origin, member: m, username, sign: signer(s, m), app })
    return { finish: { status: 200, body } }
  } catch (err) {
    if (typeof err.status !== 'number') throw err
    return { finish: { status: err.status, body: { error: err.token } } }
  }
}

// Nothing reached the (retired) Google endpoints.
function noOutbound (t, s, label) {
  t.is(s.fake.seen.length, 0, label + ': no outbound request')
}

// brittle's t.exception rethrows a TypeError as "native" unless awaited
// through .all; a plain try/catch is clearer for a synchronous throw.
function throwsMessage (t, fn, re, msg) {
  try {
    fn()
    t.fail(msg + ': did not throw')
  } catch (err) {
    t.ok(re.test(err.message), msg + ': ' + err.message)
  }
}

// GET with an explicit Host header (undici's fetch always sets Host from
// the URL); -> status.
function rawGet (port, host, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
}

function noPersonalData (t, text, label) {
  t.absent(text.includes(EMAIL), label + ': no e-mail')
  t.absent(text.includes(SUB), label + ': no sub')
  t.absent(text.includes(CLIENT_SECRET), label + ': no secret')
  t.absent(text.includes(ACCESS), label + ': no access token')
}

test('full link: start, phone check, finish proof, certificate and username record', async (t) => {
  const s = await setup(t)
  const m = member()

  const health = await s.api('GET', '/account/health')
  t.is(health.status, 200)
  t.alike(health.body, { status: 'ok' })
  // The exact bytes deploy.sh (servido_conta) compares with cmp.
  t.is(await (await fetch('http://127.0.0.1:' + s.port + '/account/health')).text(), '{"status":"ok"}\n', 'health body is {"status":"ok"} + LF')
  for (const [k, v] of [['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer']]) {
    t.is(health.headers.get(k), v, k)
  }
  t.is(health.headers.get('access-control-allow-origin'), null, 'no CORS header')

  const started = await s.api('POST', '/account/start', { body: { member: m.hex, username: 'ana' } })
  t.is(started.status, 200)
  t.ok(TOKEN_RE.test(started.body.nonce), 'nonce is 32 bytes base64url')
  t.alike(Object.keys(started.body), ['nonce'])
  const cookie = cookieOf(started)
  t.ok(cookie !== null && TOKEN_RE.test(cookie.id), 'cookie carries the pending id')
  t.is(cookie.maxAge, 600)

  const early = await s.api('POST', '/account/finish', { cookie: cookie.id, body: { signature: finishSig(s, m, started.body.nonce, 'ana') } })
  t.alike([early.status, early.body], [403, { error: 'telefone-pendente' }], 'no link before the phone check')
  const checked = await verifyPhone(s, m)
  t.is(checked.status, 200, checked.text)
  t.is(checked.body.state, 'verificado')

  const finish = await s.api('POST', '/account/finish', { cookie: cookie.id, body: { signature: finishSig(s, m, started.body.nonce, 'ana') } })
  t.is(finish.status, 200, 'finish: ' + finish.text)
  t.alike(Object.keys(finish.body).sort(), ['cert', 'nextChangeAt', 'usernameRecord'])
  const { cert, usernameRecord, nextChangeAt } = finish.body
  t.alike(certForKey(cert, m.hex, s.iss.association), { ok: true })
  t.is(cert.issuer, b4a.toString(s.iss.keyPair.publicKey, 'hex'), 'issued by the service key')
  t.is(cert.v, 2)
  t.alike(verifyUsernameRecord(usernameRecord, m.hex, s.iss.association), { ok: true })
  t.is(usernameRecord.username, 'ana')
  t.is(Date.parse(nextChangeAt), Date.parse(usernameRecord.date) + COOLDOWN_MS)
  t.is(cookieOf(finish).maxAge, 0, 'the cookie is cleared')
  noPersonalData(t, finish.text, 'finish')

  const again = await s.api('POST', '/account/finish', { cookie: cookie.id, body: { signature: finishSig(s, m, started.body.nonce, 'ana') } })
  t.is(again.status, 404)
  t.alike(again.body, { error: 'expirado' }, 'the row is gone after a successful finish (C8)')

  const status = await s.api('GET', '/account/status?member=' + m.hex)
  t.is(status.status, 200)
  t.alike(status.body, { linked: true, username: 'ana', cert, usernameRecord, nextChangeAt }, 'status returns the identical cert')
  noPersonalData(t, status.text, 'status')

  const lookup = await s.api('GET', '/account/username/ana')
  t.is(lookup.status, 200)
  t.alike(lookup.body, { member: m.hex, usernameRecord })
  noPersonalData(t, lookup.text, 'lookup')

  const unknown = await s.api('GET', '/account/username/zoe')
  t.is(unknown.status, 404)
  t.alike(unknown.body, { error: 'nao-encontrado' })
  const other = await s.api('GET', '/account/status?member=' + member().hex)
  t.alike(other.body, { linked: false })

  const log = s.logs.join('\n')
  noPersonalData(t, log, 'log')
  t.absent(HEX16.test(log), 'no 16-hex run in the log')
  t.ok(s.logs.includes(JSON.stringify({ event: 'linked' })))
  noOutbound(t, s, 'the phone link')
})

test('callback (retired): every query redirects to /?conta=erro; nothing is read, exchanged or written', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await startLink(s, m, 'ana')
  t.ok(a.cookie)
  const before = JSON.stringify(s.store.get(a.cookie))

  for (const [label, cookie, query] of [
    ['no query', null, ''],
    ['a code', null, '?state=' + 'A'.repeat(43) + '&code=codigo-1'],
    ['a live row cookie and a code', a.cookie, '?state=' + 'A'.repeat(43) + '&code=codigo-1'],
    ['a Google error', a.cookie, '?state=' + 'A'.repeat(43) + '&error=access_denied']
  ]) {
    const cb = await s.api('GET', '/account/callback' + query, { cookie })
    t.is(cb.status, 302, label)
    t.is(cb.headers.get('location'), s.origin + '/?conta=erro', label + ': the web answer')
    t.is(cb.headers.get('cache-control'), 'no-store', label + ': not cached')
    t.is(cb.headers.get('set-cookie'), null, label + ': no cookie set or cleared')
  }
  t.is(JSON.stringify(s.store.get(a.cookie)), before, 'the pending row is untouched')
  noOutbound(t, s, 'callback')
  t.ok(s.logs.includes(JSON.stringify({ event: 'callback', reason: 'aposentado' })))
  t.absent(s.logs.join('\n').includes('codigo-1'), 'the code is never logged')
  t.absent(s.logs.includes(JSON.stringify({ event: 'callback', reason: 'ok' })), 'never an ok')
})

test('authorize (retired): 410 versao-antiga before any proof, store call or Google URL', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await startLink(s, m, 'ana')
  const calls = []
  for (const name of ['reserve', 'putGoogle', 'markAnswered', 'start', 'finish', 'dropPending']) {
    const real = s.store[name]
    s.store[name] = (...args) => {
      calls.push(name)
      return real.apply(s.store, args)
    }
  }
  const before = JSON.stringify(s.store.get(a.cookie))

  for (const [label, opts] of [
    ['a valid reserve proof', { cookie: a.cookie, body: { signature: sign(s, m, 'reserve', a.nonce, 'ana') } }],
    ['a malformed signature', { cookie: a.cookie, body: { signature: 'zz' } }],
    ['no cookie', { body: { signature: sign(s, m, 'reserve', a.nonce, 'ana') } }],
    ['an app client', { origin: null, headers: { 'x-varanda-client': 'app', 'x-varanda-link': nodeCrypto.randomBytes(32).toString('base64url') }, body: { signature: 'a'.repeat(128) } }]
  ]) {
    const r = await s.api('POST', '/account/authorize', opts)
    t.alike([r.status, r.body], [410, { error: 'versao-antiga' }], label)
    t.absent(r.text.includes('authorizeUrl'), label + ': no Google URL')
  }
  t.alike(calls, [], 'no store call')
  t.is(JSON.stringify(s.store.get(a.cookie)), before, 'the row stays in reserve')
  noOutbound(t, s, 'authorize')
  t.ok(s.logs.includes(JSON.stringify({ event: 'refused', reason: 'versao-antiga' })))

  // The row is still the member's: the phone link finishes it.
  t.is((await verifyPhone(s, m)).status, 200)
  const finish = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: finishSig(s, m, a.nonce, 'ana') } })
  t.is(finish.status, 200, finish.text)
})

test('signatures: wrong phase, wrong key, name, subject and shape are refused; the right proof finishes once', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await startLink(s, m, 'ana')
  t.is((await verifyPhone(s, m)).status, 200)

  const reserveSig = sign(s, m, 'reserve', a.nonce, 'ana')
  const wrongPhase = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: reserveSig } })
  t.alike([wrongPhase.status, wrongPhase.body], [400, { error: 'assinatura-invalida' }], 'a reserve signature does not finish')

  const other = member()
  const wrongKey = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: finishSig(s, other, a.nonce, 'ana') } })
  t.alike([wrongKey.status, wrongKey.body], [400, { error: 'assinatura-invalida' }], 'signed by another key')

  const wrongName = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: finishSig(s, m, a.nonce, 'anna') } })
  t.alike(wrongName.body, { error: 'assinatura-invalida' }, 'signed over another name')

  const googleSub = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: sign(s, m, 'finish', a.nonce, 'ana', SUB) } })
  t.alike([googleSub.status, googleSub.body], [400, { error: 'assinatura-invalida' }], 'signed over a Google subject')

  const malformed = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: 'zz' } })
  t.alike([malformed.status, malformed.body], [400, { error: 'assinatura-invalida' }])

  const noCookie = await s.api('POST', '/account/finish', { body: { signature: finishSig(s, m, a.nonce, 'ana') } })
  t.alike([noCookie.status, noCookie.body], [404, { error: 'expirado' }])

  const good = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: finishSig(s, m, a.nonce, 'ana') } })
  t.is(good.status, 200, 'the right proof still works after the refusals')
  const replay = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: finishSig(s, m, a.nonce, 'ana') } })
  t.alike([replay.status, replay.body], [404, { error: 'expirado' }], 'the nonce is single-use')
})

test('finish: a row holding a Google subject (from before the retirement) answers expirado and links nothing', async (t) => {
  const s = await setup(t)
  const m = member()
  t.is((await verifyPhone(s, m)).status, 200)
  const row = s.store.start({ member: m.hex, username: 'ana' })
  s.store.reserve(row.id)
  s.store.putGoogle(row.id, { sub: SUB, email: EMAIL })
  for (const sub of [SUB, phoneSub(m.hex)]) {
    const r = await s.api('POST', '/account/finish', { cookie: row.id, body: { signature: sign(s, m, 'finish', row.nonce, 'ana', sub) } })
    t.alike([r.status, r.body], [404, { error: 'expirado' }], sub === SUB ? 'signed over the Google subject' : 'signed over the phone subject')
  }
  t.alike((await s.api('GET', '/account/status?member=' + m.hex)).body, { linked: false })
  t.is(s.store.memberForSub(SUB), null, 'the Google subject is bound to nobody')
  noOutbound(t, s, 'finish')

  // A web row the retired authorize had moved past reserve, with no subject.
  const n = member()
  t.is((await verifyPhone(s, n)).status, 200)
  const moved = s.store.start({ member: n.hex, username: 'bia' })
  s.store.reserve(moved.id)
  const r = await s.api('POST', '/account/finish', { cookie: moved.id, body: { signature: finishSig(s, n, moved.nonce, 'bia') } })
  t.alike([r.status, r.body], [404, { error: 'expirado' }], 'a row past reserve')
})

test('start: wrong member, taken, 6-hex and reserved names, a linked member cannot start again', async (t) => {
  const s = await setup(t)
  const m = member()
  const done = await link(s, m, 'ana')
  t.is(done.finish.status, 200)

  const bad = await s.api('POST', '/account/start', { body: { member: m.hex.toUpperCase(), username: 'bia' } })
  t.alike([bad.status, bad.body], [400, { error: 'pedido-invalido' }], 'member must be lowercase hex64')
  const short = await s.api('POST', '/account/start', { body: { member: 'abc', username: 'bia' } })
  t.is(short.status, 400)

  const taken = await s.api('POST', '/account/start', { body: { member: member().hex, username: 'ana' } })
  t.alike([taken.status, taken.body], [409, { error: 'nome-em-uso' }])
  const hex6 = await s.api('POST', '/account/start', { body: { member: member().hex, username: 'abc123' } })
  t.alike([hex6.status, hex6.body], [400, { error: 'nome-invalido' }])
  const reserved = await s.api('POST', '/account/start', { body: { member: member().hex, username: 'admin' } })
  t.alike([reserved.status, reserved.body], [400, { error: 'nome-invalido' }])
  t.is(cookieOf(reserved), null, 'no cookie on a refusal')

  const secondSub = await s.api('POST', '/account/start', { body: { member: m.hex, username: 'bia' } })
  t.alike([secondSub.status, secondSub.body], [409, { error: 'conta-vinculada' }], 'a linked member cannot start again')

  const fresh = await link(s, member(), 'cris')
  t.is(fresh.finish.status, 200, 'another member links')
})

test('start: the Vitrine handles shown on varanda.app are reserved', async (t) => {
  const s = await setup(t)
  const handles = ['lia_oliveira', 'joao_nascimento', 'cecilia_ramos', 'andre_costa', 'bia_araujo',
    'tomas_ferreira', 'biblioteca_praca', 'horta_do_bairro']
  for (const username of handles) {
    const res = await s.api('POST', '/account/start', { body: { member: member().hex, username } })
    t.alike([res.status, res.body], [400, { error: 'nome-invalido' }], username)
    t.is(cookieOf(res), null, username + ': no cookie')
  }
  const near = await s.api('POST', '/account/start', { body: { member: member().hex, username: 'lia_oliveira2' } })
  t.is(near.status, 200, 'only the exact handle is reserved')
})

test('a pending row holds no name; an expired row finishes nothing; the link takes the name', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await startLink(s, m, 'ana')
  t.is((await verifyPhone(s, m)).status, 200)
  const notYet = await s.api('POST', '/account/start', { body: { member: member().hex, username: 'ana' } })
  t.is(notYet.status, 200, 'a pending row holds nothing, even with the phone checked')
  s.c.offset += PENDING_TTL_MS
  const late = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: finishSig(s, m, a.nonce, 'ana') } })
  t.alike([late.status, late.body], [404, { error: 'expirado' }], 'the row expired')
  t.alike((await s.api('GET', '/account/status?member=' + m.hex)).body, { linked: false })

  const b = await startLink(s, m, 'ana')
  const done = await s.api('POST', '/account/finish', { cookie: b.cookie, body: { signature: finishSig(s, m, b.nonce, 'ana') } })
  t.is(done.status, 200, 'a fresh row links: ' + done.text)
  const held = await s.api('POST', '/account/start', { body: { member: member().hex, username: 'ana' } })
  t.alike(held.body, { error: 'nome-em-uso' }, 'held once linked')
})

test('rename: cooldown, key proof over the rename nonce, single-use nonce, old name never reassigned', async (t) => {
  const s = await setup(t)
  const m = member()
  const done = await link(s, m, 'ana')
  const nextChangeAt = done.finish.body.nextChangeAt

  const blocked = await s.api('POST', '/account/rename/start', { body: { member: m.hex, username: 'bia' } })
  t.alike([blocked.status, blocked.body], [409, { error: 'troca-bloqueada', nextChangeAt }])
  const same = await s.api('POST', '/account/rename/start', { body: { member: m.hex, username: 'ana' } })
  t.is(same.status, 200, 'the current name is not a change')
  const unlinked = await s.api('POST', '/account/rename/start', { body: { member: member().hex, username: 'bia' } })
  t.alike([unlinked.status, unlinked.body], [404, { error: 'nao-encontrado' }])
  const invalid = await s.api('POST', '/account/rename/start', { body: { member: m.hex, username: 'abc123' } })
  t.alike(invalid.body, { error: 'nome-invalido' })

  s.c.offset += COOLDOWN_MS
  const started = await s.api('POST', '/account/rename/start', { body: { member: m.hex, username: 'bia' } })
  t.is(started.status, 200)
  t.ok(TOKEN_RE.test(started.body.nonce))
  t.is(cookieOf(started), null, 'no cookie: the key proof is the authority')
  const nonce = started.body.nonce

  const wrongPhase = await s.api('POST', '/account/rename/finish', { body: { member: m.hex, nonce, signature: sign(s, m, 'reserve', nonce, 'bia') } })
  t.alike([wrongPhase.status, wrongPhase.body], [400, { error: 'assinatura-invalida' }])
  const spent = await s.api('POST', '/account/rename/finish', { body: { member: m.hex, nonce, signature: sign(s, m, 'rename', nonce, 'bia') } })
  t.alike([spent.status, spent.body], [404, { error: 'expirado' }], 'a nonce is spent by its first finish')

  const again = await s.api('POST', '/account/rename/start', { body: { member: m.hex, username: 'bia' } })
  const nonce2 = again.body.nonce
  const other = await s.api('POST', '/account/rename/finish', { body: { member: member().hex, nonce: nonce2, signature: sign(s, m, 'rename', nonce2, 'bia') } })
  t.alike(other.body, { error: 'expirado' }, 'another member cannot spend the nonce')

  const third = await s.api('POST', '/account/rename/start', { body: { member: m.hex, username: 'bia' } })
  const nonce3 = third.body.nonce
  const finished = await s.api('POST', '/account/rename/finish', { body: { member: m.hex, nonce: nonce3, signature: sign(s, m, 'rename', nonce3, 'bia') } })
  t.is(finished.status, 200, finished.text)
  t.alike(Object.keys(finished.body).sort(), ['nextChangeAt', 'usernameRecord'])
  t.alike(verifyUsernameRecord(finished.body.usernameRecord, m.hex, s.iss.association), { ok: true })
  t.is(finished.body.usernameRecord.username, 'bia')
  t.is(Date.parse(finished.body.nextChangeAt), Date.parse(finished.body.usernameRecord.date) + COOLDOWN_MS)

  const replay = await s.api('POST', '/account/rename/finish', { body: { member: m.hex, nonce: nonce3, signature: sign(s, m, 'rename', nonce3, 'bia') } })
  t.alike([replay.status, replay.body], [404, { error: 'expirado' }], 'replayed nonce')

  const status = await s.api('GET', '/account/status?member=' + m.hex)
  t.is(status.body.username, 'bia')
  t.alike(status.body.usernameRecord, finished.body.usernameRecord)
  t.is(status.body.nextChangeAt, finished.body.nextChangeAt)
  t.alike((await s.api('GET', '/account/username/ana')).body, { error: 'nao-encontrado' }, 'the old name no longer resolves')
  t.is((await s.api('GET', '/account/username/bia')).body.member, m.hex)

  const other2 = await s.api('POST', '/account/start', { body: { member: member().hex, username: 'ana' } })
  t.alike(other2.body, { error: 'nome-em-uso' }, 'a name once held is never given to another member')
  const blockedAgain = await s.api('POST', '/account/rename/start', { body: { member: m.hex, username: 'ana' } })
  t.is(blockedAgain.body.error, 'troca-bloqueada', 'the cooldown restarted')
  t.ok(s.logs.includes(JSON.stringify({ event: 'renamed' })))
  noPersonalData(t, s.logs.join('\n'), 'log')
})

test('request hygiene: host, origin, content type, body size, methods and unknown paths', async (t) => {
  const s = await setup(t)
  const m = member()
  const body = { member: m.hex, username: 'ana' }

  const noOrigin = await s.api('POST', '/account/start', { body, origin: null })
  t.alike([noOrigin.status, noOrigin.body], [403, { error: 'pedido-invalido' }])
  const otherOrigin = await s.api('POST', '/account/start', { body, origin: 'https://outro.test' })
  t.is(otherOrigin.status, 403)
  const form = await s.api('POST', '/account/start', { body, headers: { 'content-type': 'text/plain' } })
  t.alike([form.status, form.body], [400, { error: 'pedido-invalido' }])
  const charset = await s.api('POST', '/account/start', { body, headers: { 'content-type': 'application/json; charset=utf-8' } })
  t.is(charset.status, 200, 'a charset parameter is fine')
  const notObject = await s.api('POST', '/account/start', { raw: '[1]' })
  t.is(notObject.status, 400)
  const broken = await s.api('POST', '/account/start', { raw: '{' })
  t.is(broken.status, 400)
  const big = await s.api('POST', '/account/start', { raw: JSON.stringify({ member: m.hex, username: 'ana', pad: 'x'.repeat(5000) }) })
  t.alike([big.status, big.body], [413, { error: 'pedido-invalido' }])

  const options = await s.api('OPTIONS', '/account/start')
  t.is(options.status, 404)
  t.is(options.headers.get('access-control-allow-origin'), null)
  t.is((await s.api('GET', '/account/start')).status, 404)
  t.is((await s.api('POST', '/account/health', { body: {} })).status, 404)
  t.is((await s.api('GET', '/account/nope')).status, 404)
  t.is((await s.api('GET', '/')).status, 404)
  t.is((await s.api('GET', '/account/username/Ana')).status, 404)
  t.is((await s.api('GET', '/account/status?member=xyz')).status, 400)
  t.is((await s.api('GET', '/account/pending', { cookie: 'x'.repeat(43) })).status, 404)

  t.is(await rawGet(s.port, 'varanda.test', '/account/health'), 421, 'a Host that is not this listener')
  t.is(await rawGet(s.port, '127.0.0.1:1', '/account/health'), 421, 'another port')
  t.is(await rawGet(s.port, 'localhost:' + s.port, '/account/health'), 421, 'only 127.0.0.1:<port>')
  t.is(await rawGet(s.port, '127.0.0.1:' + s.port, '/account/health'), 200)

  const log = s.logs.join('\n')
  t.absent(log.includes('outro.test'), 'the foreign origin is not logged')
  t.absent(log.includes(m.hex.slice(0, 16)), 'the member key is not logged')
})

test('rate limits: nothing charged before a proof; per-member windows after a valid signature', async (t) => {
  const s = await setup(t)

  // Unauthenticated starts naming a victim's (public) key never lock the
  // victim out: start charges no per-member window.
  const victim = member()
  for (let i = 0; i < 6; i++) {
    const r = await s.api('POST', '/account/start', { body: { member: victim.hex, username: 'ana' } })
    t.is(r.status, 200, 'start ' + (i + 1) + ' by anyone')
  }
  const own = await link(s, victim, 'ana')
  t.is(own.finish.status, 200, 'the victim\'s own signed flow still links')

  // Unauthenticated finishes share nothing with a member's valid finish.
  const m = member()
  const a = await startLink(s, m, 'bia')
  t.is((await verifyPhone(s, m)).status, 200)
  s.c.offset += 10 * 1000 // refill the global bucket
  for (let i = 0; i < 30; i++) {
    const r = await s.api('POST', '/account/finish', { body: { signature: 'a'.repeat(128) } })
    t.is(r.status, 404, 'finish without a row ' + (i + 1))
  }
  const finish = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: finishSig(s, m, a.nonce, 'bia') } })
  t.is(finish.status, 200, 'the member\'s valid finish: ' + finish.text)

  // Unauthenticated rename/starts naming a linked member do not block its
  // own signed rename.
  s.c.offset += COOLDOWN_MS
  for (let i = 0; i < 6; i++) {
    const r = await s.api('POST', '/account/rename/start', { body: { member: victim.hex, username: 'ana_' + i } })
    t.is(r.status, 200, 'rename/start ' + (i + 1) + ' by anyone')
  }
  const started = await s.api('POST', '/account/rename/start', { body: { member: victim.hex, username: 'anita' } })
  const nonce = started.body.nonce
  const renamed = await s.api('POST', '/account/rename/finish', { body: { member: victim.hex, nonce, signature: sign(s, victim, 'rename', nonce, 'anita') } })
  t.is(renamed.status, 200, 'the victim\'s own signed rename: ' + renamed.text)

  // The per-member window is charged once the signature verified: 10
  // finishes per member per 10 min. A member with no phone checked is
  // refused after the charge, so its row stays for the next try.
  s.c.offset += 600 * 1000
  const spender = member()
  const sp = await startLink(s, spender, 'carla')
  const spend = () => s.api('POST', '/account/finish', { cookie: sp.cookie, body: { signature: finishSig(s, spender, sp.nonce, 'carla') } })
  for (let i = 0; i < 10; i++) {
    const r = await spend()
    t.alike([r.status, r.body], [403, { error: 'telefone-pendente' }], 'signed finish ' + (i + 1))
  }
  const eleventh = await spend()
  t.alike([eleventh.status, eleventh.body], [429, { error: 'pedido-invalido' }], 'the eleventh signed finish')
  const otherM = member()
  const o = await startLink(s, otherM, 'dora')
  const other = await s.api('POST', '/account/finish', { cookie: o.cookie, body: { signature: finishSig(s, otherM, o.nonce, 'dora') } })
  t.is(other.status, 403, 'another member is not affected')
  s.c.offset += 600 * 1000
  const sp2 = await startLink(s, spender, 'carla')
  const later = await s.api('POST', '/account/finish', { cookie: sp2.cookie, body: { signature: finishSig(s, spender, sp2.nonce, 'carla') } })
  t.is(later.status, 403, 'the window passed')
})

test('keyedWindow at capacity admits a new key: expired windows go first, then the oldest', (t) => {
  const c = clock()
  const w = keyedWindow(1, 1000, c.now, 3)
  for (const k of ['a', 'b', 'c']) t.ok(w(k), k + ' admitted')
  t.absent(w('a'), 'a is over its limit')
  t.ok(w('d'), 'd admitted at capacity: a (the oldest) is dropped')
  t.ok(w('a'), 'a is a new key again (b dropped)')
  t.absent(w('d'), 'd keeps its count')
  c.offset += 1000
  t.ok(w('e'), 'e admitted: every window expired')
  t.ok(w('d'), 'd restarted after its window expired')
  t.ok(w('a'), 'a too')
  t.ok(w('f'), 'f admitted: the oldest live window (e) is dropped')
  t.absent(w('d'), 'd still counted')
  t.ok(w('e'), 'e is new again')
})

test('pending (retired): 404 expirado for a live row, a V or a redeem code; nothing is read or written', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await startLink(s, m, 'ana')
  const v = nodeCrypto.randomBytes(32).toString('base64url')
  const proof = nodeCrypto.createHash('sha256').update(Buffer.from(v, 'base64url')).digest('base64url')
  const app = await s.api('POST', '/account/start', { origin: null, headers: { 'x-varanda-client': 'app' }, body: { member: member().hex, username: 'bia', appProof: proof } })
  t.is(app.status, 200)
  const before = JSON.stringify(s.store.get(a.cookie))
  for (const [label, opts] of [
    ['the live row cookie', { cookie: a.cookie }],
    ['no cookie', {}],
    ['an app V', { origin: null, headers: { 'x-varanda-client': 'app', 'x-varanda-link': v } }],
    ['an app V and a redeem code', { origin: null, headers: { 'x-varanda-client': 'app', 'x-varanda-link': v, 'x-varanda-redeem': 'A'.repeat(43) } }]
  ]) {
    const r = await s.api('GET', '/account/pending', opts)
    t.alike([r.status, r.body], [404, { error: 'expirado' }], label)
    t.absent(r.text.includes(a.nonce), label + ': no nonce')
  }
  t.is(JSON.stringify(s.store.get(a.cookie)), before, 'the row is untouched')
  t.is(s.server.appStats().rows, 1, 'the app row stays')
  noOutbound(t, s, 'pending')
})

test('unconfigured service: health ok, link routes 503 indisponivel, the retired routes answer as ever, reads answer', async (t) => {
  const s = await setup(t, { configured: false })
  const m = member()
  t.alike((await s.api('GET', '/account/health')).body, { status: 'ok' })
  const start = await s.api('POST', '/account/start', { body: { member: m.hex, username: 'ana' } })
  t.alike([start.status, start.body], [503, { error: 'indisponivel' }])
  t.is(cookieOf(start), null)
  for (const [method, p, body] of [
    ['POST', '/account/finish', { signature: 'a'.repeat(128) }],
    ['POST', '/account/rename/start', { member: m.hex, username: 'ana' }],
    ['POST', '/account/rename/finish', { member: m.hex, nonce: 'A'.repeat(43), signature: 'a'.repeat(128) }]
  ]) {
    const r = await s.api(method, p, body === undefined ? { cookie: 'A'.repeat(43) } : { body, cookie: 'A'.repeat(43) })
    t.alike([r.status, r.body], [503, { error: 'indisponivel' }], method + ' ' + p)
  }
  const auth = await s.api('POST', '/account/authorize', { cookie: 'A'.repeat(43), body: { signature: 'a'.repeat(128) } })
  t.alike([auth.status, auth.body], [410, { error: 'versao-antiga' }], 'authorize: a definite refusal, never 503')
  const pending = await s.api('GET', '/account/pending', { cookie: 'A'.repeat(43) })
  t.alike([pending.status, pending.body], [404, { error: 'expirado' }])
  const cb = await s.api('GET', '/account/callback?state=' + 'A'.repeat(43) + '&code=x', { cookie: 'A'.repeat(43) })
  t.alike([cb.status, cb.headers.get('location')], [302, s.origin + '/?conta=erro'])
  t.alike((await s.api('GET', '/account/status?member=' + m.hex)).body, { linked: false })
  t.is((await s.api('GET', '/account/username/ana')).status, 404)
  noOutbound(t, s, 'unconfigured')
})

test('createAccountServer refuses an issuer certificate for another association or key', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const otherIss = issuer()
  const store = openAccountStore(dir)
  const google = createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/callback', fetch: () => { throw new Error('no network') } })
  throwsMessage(t, () => createAccountServer({ association: iss.association, origin: ORIGIN, google, store, issuer: { keyPair: iss.keyPair, cert: otherIss.cert } }), /another association or key/, 'cert of another association')
  throwsMessage(t, () => createAccountServer({ association: iss.association, origin: ORIGIN, google, store, issuer: { keyPair: otherIss.keyPair, cert: iss.cert } }), /another association or key/, 'cert for another key')
  throwsMessage(t, () => createAccountServer({ association: iss.association, origin: 'http://varanda.test', google, store, issuer: null }), /origin/, 'http origin')
  throwsMessage(t, () => createAccountServer({ association: iss.association, origin: 'http://example.test', google, store, issuer: null }), /origin/, 'http origin on another host')
  throwsMessage(t, () => createAccountServer({ association: iss.association, origin: 'http://192.168.1.2', google, store, issuer: null }), /origin/, 'http origin on a LAN address')
  t.ok(createAccountServer({ association: iss.association, origin: 'http://localhost:8080', google, store, issuer: null }), 'http://localhost:8080 (the hosted lab) accepted')
  t.ok(createAccountServer({ association: iss.association, origin: ORIGIN, store, issuer: null }), 'no google option: the member sign-in is retired')
  const server = createAccountServer({ association: iss.association, origin: ORIGIN, google, store, issuer: null })
  throwsMessage(t, () => server.listen({ host: '0.0.0.0', port: 0 }), /account-host/, 'any-address bind')

  // loadIssuer: nothing, key only, a cert of another association, the right cert.
  const logs = []
  const log = (e) => logs.push(e)
  t.is(loadIssuer(dir, iss.association, log), null)
  const { saveKeyPairFile } = require('@varanda/core/lib/cert')
  saveKeyPairFile(path.join(dir, KEY_FILE), iss.keyPair)
  t.is(loadIssuer(dir, iss.association, log), null, 'key without certificate')
  fs.writeFileSync(path.join(dir, CERT_FILE), JSON.stringify(otherIss.cert))
  t.is(loadIssuer(dir, iss.association, log), null, 'certificate of another association')
  t.alike(logs, [{ event: 'issuer', reason: 'untrusted-association' }])
  fs.writeFileSync(path.join(dir, CERT_FILE), JSON.stringify(iss.cert))
  const loaded = loadIssuer(dir, iss.association, log)
  t.alike(loaded.cert, iss.cert)
  t.ok(b4a.equals(loaded.keyPair.publicKey, iss.keyPair.publicKey))
})

test('data-dir lock: a second service refuses, a stale lock is recovered, release removes it', (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const lockFile = path.join(dir, LOCK_FILE)
  const readLock = () => JSON.parse(fs.readFileSync(lockFile, 'utf8'))
  const refused = (msg) => throwsMessage(t, () => takeLock(dir), /outro serviço de conta usa este diretório/, msg)
  // The lock is published by temp file + link: nothing else may linger.
  const onlyLock = (msg) => t.alike(fs.readdirSync(dir), fs.existsSync(lockFile) ? [LOCK_FILE] : [], msg)

  const lock = takeLock(dir)
  t.ok(fs.existsSync(lockFile))
  t.is(fs.statSync(lockFile).mode & 0o777, 0o600)
  t.is(readLock().pid, process.pid)
  t.ok(/^[0-9a-f]{32}$/.test(readLock().token), 'the lock carries a token')
  onlyLock('no temp file after publish')
  t.ok(lockHeld(dir))
  refused('second lock')
  onlyLock('no temp file after a refusal')
  lock.release()
  t.absent(fs.existsSync(lockFile))
  t.absent(lockHeld(dir))

  // Liveness is the mtime, never the pid: in the deployed container every
  // node is PID 1 (the service and `docker compose run` alike), so a fresh
  // lock is live whatever its pid says, and a lock older than LOCK_STALE_MS
  // is recovered whatever its pid says (a crashed PID 1 included).
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  const old = (Date.now() - 31 * 1000) / 1000
  for (const [label, pid] of [['own pid', process.pid], ['pid 1', 1], ['dead pid', dead]]) {
    fs.writeFileSync(lockFile, JSON.stringify({ pid, at: '2026-01-01T00:00:00.000Z', token: 'x'.repeat(32) }) + '\n')
    t.ok(lockHeld(dir), label + ': a fresh lock is live')
    refused(label + ': a fresh lock refuses')
    t.is(readLock().pid, pid, label + ': the fresh lock was left alone')
    onlyLock(label + ': no leftovers after a refusal')
    fs.utimesSync(lockFile, old, old)
    t.absent(lockHeld(dir), label + ': a lock 31 s old is stale')
    const retaken = takeLock(dir)
    t.is(readLock().pid, process.pid, label + ': stale lock replaced')
    onlyLock(label + ': no leftovers after a recovery')
    retaken.release()
    t.absent(fs.existsSync(lockFile), label + ': released')
  }

  // An empty file (a writer mid-publish under older code) and a malformed
  // one follow the same rule: live while fresh, recovered once stale.
  for (const [label, content] of [['empty', ''], ['malformed', 'lixo']]) {
    fs.writeFileSync(lockFile, content)
    t.ok(lockHeld(dir), 'a fresh ' + label + ' lock is live')
    refused('fresh ' + label + ' lock')
    t.is(fs.readFileSync(lockFile, 'utf8'), content, 'the ' + label + ' lock was left alone')
    onlyLock('no leftovers after refusing an ' + label + ' lock')
    fs.utimesSync(lockFile, old, old)
    t.absent(lockHeld(dir), 'an old ' + label + ' lock is stale')
    const retaken = takeLock(dir)
    t.is(readLock().pid, process.pid, 'an old ' + label + ' lock is recovered')
    onlyLock('no leftovers after recovering a ' + label + ' lock')
    retaken.release()
  }

  // release() never deletes a lock that is not its own.
  const mine = takeLock(dir)
  const other = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'f'.repeat(32) }) + '\n'
  fs.writeFileSync(lockFile, other)
  mine.release()
  t.is(fs.readFileSync(lockFile, 'utf8'), other, 'a lock with another token survives release')
  t.ok(lockHeld(dir))
  fs.unlinkSync(lockFile)
})

test('data-dir lock: owned() reads the lock now, and the shutdown close runs only while it is ours', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const lockFile = path.join(dir, LOCK_FILE)
  // No heartbeat tick during the test: owned() alone must notice the takeover.
  const lock = takeLock(dir, { heartbeatMs: 60 * 60 * 1000 })
  t.teardown(() => lock.release(), { force: true })
  t.is(lock.owned(), true, 'owned while held')

  let closes = 0
  const store = { close: async () => { closes++ } }
  t.is(await closeIfOwned(null, lock, false), 'skipped', 'no store: nothing to close')
  t.is(await closeIfOwned(store, lock, true), 'skipped', 'lost: skipped')
  t.is(closes, 0)

  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'f'.repeat(32) }) + '\n')
  t.is(lock.owned(), false, 'not owned once another token is on disk')
  t.is(await closeIfOwned(store, lock, false), 'skipped', 'a takeover between ticks skips the close')
  t.is(closes, 0, 'the store was not closed')
  fs.unlinkSync(lockFile)
  t.is(lock.owned(), false, 'not owned once the lock file is gone')

  const mine = takeLock(dir, { heartbeatMs: 60 * 60 * 1000 })
  t.teardown(() => mine.release(), { force: true })
  t.is(await closeIfOwned(store, mine, false), 'closed', 'owned and not lost: closed')
  t.is(closes, 1)
  const failing = { close: async () => { throw new Error('boom') } }
  const events = []
  t.is(await closeIfOwned(failing, mine, false, (e) => events.push(e)), 'failed', 'a failing close is reported, so serve() exits non-zero')
  t.alike(events, [{ event: 'close', reason: 'falhou' }], 'logged without detail')
})

test('data-dir lock: a lost lock marks the store unavailable before the service stops', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const store = openAccountStore(dir)
  const calls = []
  const fail = store.fail
  store.fail = () => { calls.push('fail'); fail() }
  loseLock(store, (event) => calls.push(event.event + ':' + event.reason), () => calls.push('stop'))
  t.alike(calls, ['fail', 'lock:perdido', 'stop'], 'fail() runs first, synchronously')
  const row = store.start({ member: b4a.toString(crypto.keyPair().publicKey, 'hex'), username: 'alba' })
  store.putGoogle(row.id, { sub: 'sub-alba', email: 'a@example.test' })
  try {
    await store.finish(row.id, { signature: 'a'.repeat(128) }, null, null, null)
    t.fail('finish resolved')
  } catch (err) {
    t.is(err.code, 'indisponivel', 'a request still draining is refused')
  }
  const none = []
  loseLock(null, () => none.push('log'), () => none.push('stop'))
  t.alike(none, ['log', 'stop'], 'a lock lost before the store opened only stops')

  // The terms store is failed too, synchronously, next to the directory.
  const terms = openTermsStore(dir)
  const both = []
  const termsFail = terms.fail
  terms.fail = () => { both.push('terms'); termsFail() }
  loseLock(store, (event) => both.push(event.event), () => both.push('stop'), terms)
  t.alike(both, ['terms', 'lock', 'stop'], 'terms.fail() runs before the log and the stop')
  t.is(terms.available(), false)
  try {
    await terms.accept({ member: b4a.toString(crypto.keyPair().publicKey, 'hex'), version: 1, nonce: 'n'.repeat(43), signature: 'a'.repeat(128) })
    t.fail('accept resolved')
  } catch (err) {
    t.is(err.code, 'indisponivel', 'a terms accept still draining is refused')
  }
  t.is(await terms.heal(), false, 'nor does heal() write')
  try {
    await terms.accept({ member: b4a.toString(crypto.keyPair().publicKey, 'hex'), version: 2, nonce: 'n'.repeat(43), signature: 'a'.repeat(128) })
    t.fail('accept resolved')
  } catch (err) {
    t.is(err.code, 'indisponivel', 'later accepts stay refused')
  }
})

test('serve wiring: startTermsHeal heals on its interval and logs only a repair', async (t) => {
  const results = [false, true, false]
  let heals = 0
  const events = []
  const terms = { heal: async () => results[heals++] ?? false }
  const stop = startTermsHeal(terms, (event) => events.push(event), 5)
  await until(() => heals >= 3)
  t.alike(events, [{ event: 'terms', reason: 'reparado' }], 'logged once, for the heal that wrote')
  stop()
  const after = heals
  await new Promise((resolve) => setTimeout(resolve, 30))
  t.is(heals, after, 'stop() clears the interval')
})

test('serve wiring: the push store heals on the same loop, logged as push', async (t) => {
  const results = [true, false]
  let heals = 0
  const events = []
  const stop = startHeal({ heal: async () => results[heals++] ?? false }, 'push', (event) => events.push(event), 5)
  await until(() => heals >= 2)
  stop()
  t.alike(events, [{ event: 'push', reason: 'reparado' }])
})

test('serve wiring: a store that fails at runtime logs store:indisponivel once and stops the service', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const calls = []
  // As serve() passes it: log (no personal data), then stop.
  const store = openAccountStore(dir, {
    onUnavailable: () => storeUnavailable((event) => calls.push(event), () => calls.push('stop'))
  })
  const member = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const row = store.start({ member, username: 'alba' })
  store.putGoogle(row.id, { sub: 'sub-alba', email: 'a@example.test' })
  // The first link writes the journal header; then the journal disappears
  // behind the writer, so the next write trips the writer guard.
  const iss = crypto.keyPair()
  const assoc = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: b4a.toString(iss.publicKey, 'hex') }, assoc)
  await store.finish(row.id, { signature: 'a'.repeat(128) }, iss, issuerCert, issuerCert.association)
  t.alike(calls, [], 'nothing while the store works')
  fs.unlinkSync(path.join(dir, fs.readdirSync(dir).find((name) => name.startsWith('directory.journal.'))))
  for (const name of ['bia', 'cora']) {
    const next = store.start({ member: b4a.toString(crypto.keyPair().publicKey, 'hex'), username: name })
    store.putGoogle(next.id, { sub: 'sub-' + name, email: 'b@example.test' })
    try {
      await store.finish(next.id, { signature: 'a'.repeat(128) }, iss, issuerCert, issuerCert.association)
      t.fail('finish resolved')
    } catch (err) {
      t.is(err.code, 'indisponivel', name + ': refused')
    }
  }
  t.alike(calls, [{ event: 'store', reason: 'indisponivel' }, 'stop'], 'logged without personal data, then stopped, once')
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('data-dir lock: the heartbeat keeps it live, and a lock that is no longer ours is reported lost', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const lockFile = path.join(dir, LOCK_FILE)
  const mtime = () => fs.statSync(lockFile).mtimeMs
  // Small windows so the test runs in milliseconds: a heartbeat every 20 ms,
  // stale after 150 ms.
  const windows = { heartbeatMs: 20, staleMs: 150 }

  const lock = takeLock(dir, windows)
  t.teardown(() => lock.release(), { force: true })
  const born = mtime()
  await sleep(400)
  t.ok(mtime() > born, 'the heartbeat refreshed the mtime')
  t.ok(lockHeld(dir, windows), 'live well past staleMs while the heartbeat runs')
  throwsMessage(t, () => takeLock(dir, windows), /outro serviço de conta usa este diretório/, 'a served lock refuses')
  t.is(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid, 'and is left alone')
  lock.release()
  t.absent(fs.existsSync(lockFile), 'released')

  // Without a heartbeat (a crashed holder) the same lock goes stale.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'x'.repeat(32) }) + '\n')
  t.ok(lockHeld(dir, windows), 'fresh')
  await sleep(300)
  t.absent(lockHeld(dir, windows), 'stale once no heartbeat refreshes it')
  takeLock(dir, windows).release()
  t.absent(fs.existsSync(lockFile))

  // The token on disk changes (another writer took the lock over): onLost
  // fires once, the heartbeat stops and the foreign lock is never touched.
  let lost = 0
  const taken = takeLock(dir, { ...windows, onLost: () => { lost++ } })
  const foreign = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'f'.repeat(32) }) + '\n'
  fs.writeFileSync(lockFile, foreign)
  const stamp = (Date.now() - 1000) / 1000
  fs.utimesSync(lockFile, stamp, stamp)
  const foreignMtime = mtime()
  await until(() => lost > 0, { name: 'lost' })
  await sleep(100)
  t.is(lost, 1, 'reported once')
  t.is(mtime(), foreignMtime, 'the foreign lock is not refreshed')
  taken.release()
  t.is(fs.readFileSync(lockFile, 'utf8'), foreign, 'nor removed')
  fs.unlinkSync(lockFile)

  // The lock file vanished: lost as well.
  let gone = 0
  const vanished = takeLock(dir, { ...windows, onLost: () => { gone++ } })
  fs.unlinkSync(lockFile)
  await until(() => gone > 0, { name: 'gone' })
  vanished.release()
  t.absent(fs.existsSync(lockFile))
})

// --- the CLI ---------------------------------------------------------------------

function varanda (dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], { env: { ...cleanEnv, ...env }, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('account key, cert add, status and export', async (t) => {
  const root = tmpDir(t)
  const dir = path.join(root, 'account')
  const iss = issuer()
  const association = iss.association

  const noAssoc = varanda(dir, ['account', 'key'])
  t.is(noAssoc.code, 2)
  t.ok(noAssoc.stderr.includes('informe --association'))

  const key = varanda(dir, ['account', 'key', '--association', association])
  t.is(key.code, 0, key.stderr)
  const m = /^chave do emissor: ([0-9a-f]{64})\n$/.exec(key.stdout)
  t.ok(m, 'prints only the public key: ' + JSON.stringify(key.stdout))
  const publicKey = m[1]
  const keyFile = path.join(dir, KEY_FILE)
  t.is(fs.statSync(keyFile).mode & 0o777, 0o600)
  t.is(fs.statSync(dir).mode & 0o777, 0o700)
  const secret = JSON.parse(fs.readFileSync(keyFile, 'utf8')).secretKey
  t.absent(key.stdout.includes(secret.slice(0, 16)), 'no secret on stdout')
  t.alike(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { v: 1, role: 'account', association })
  t.is(varanda(dir, ['account', 'key']).stdout, key.stdout, 'idempotent, association from config.json')
  t.is(varanda(dir, ['account', 'key', '--association', issuer().association]).code, 1, 'another association is refused')
  t.ok(varanda(dir, ['account', 'key', '--association', issuer().association]).stderr.includes('associação diferente da configurada'))

  const before = varanda(dir, ['account', 'status'])
  t.is(before.code, 0, before.stderr)
  t.ok(before.stdout.includes('emissor não certificado'))
  t.ok(before.stdout.includes('certificado: ausente'))
  t.ok(before.stdout.includes('vínculos: 0'))
  t.ok(before.stdout.includes('estado: parado'))
  t.ok(before.stdout.includes('Triagem IA: desligada'), 'no exemplars.json yet')
  t.ok(before.stdout.includes('aceites dos termos: 0'), 'no terms.json yet')

  const certFile = path.join(root, 'issuer-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createIssuerCert({ issuer: publicKey }, issuer().assoc)))
  const foreign = varanda(dir, ['account', 'cert', 'add', '--cert-file', certFile])
  t.is(foreign.code, 1)
  t.ok(foreign.stderr.includes('untrusted-association'), foreign.stderr)
  fs.writeFileSync(certFile, JSON.stringify(createIssuerCert({ issuer: b4a.toString(crypto.keyPair().publicKey, 'hex') }, iss.assoc)))
  const otherKey = varanda(dir, ['account', 'cert', 'add', '--cert-file', certFile])
  t.is(otherKey.code, 1)
  t.ok(otherKey.stderr.includes('de outra chave'), otherKey.stderr)
  t.absent(fs.existsSync(path.join(dir, CERT_FILE)), 'nothing stored')
  t.is(varanda(dir, ['account', 'cert', 'add']).code, 2, '--cert-file required')

  fs.writeFileSync(certFile, JSON.stringify(createIssuerCert({ issuer: publicKey }, iss.assoc)))
  const added = varanda(dir, ['account', 'cert', 'add', '--cert-file', certFile])
  t.is(added.code, 0, added.stderr)
  t.is(added.stdout, 'certificado do emissor gravado\n')
  t.is(fs.statSync(path.join(dir, CERT_FILE)).mode & 0o777, 0o600)
  const after = varanda(dir, ['account', 'status', '--json'])
  const status = JSON.parse(after.stdout.trim().split('\n').pop())
  t.is(status.certificate, 'ok')
  t.is(status.configured, true)
  t.is(status.publicKey, publicKey)
  t.absent(varanda(dir, ['account', 'status']).stdout.includes('emissor não certificado'))
  t.is(status.triage, null)
  t.is(status.terms, 0)

  // The precedents are counted from exemplars.json, read-only.
  const exemplarsFile = path.join(dir, 'exemplars.json')
  const exemplars = JSON.stringify({ v: 1, model: 'modelo', items: [{}, {}] })
  fs.writeFileSync(exemplarsFile, exemplars)
  t.ok(varanda(dir, ['account', 'status']).stdout.includes('Triagem IA: 2 precedentes'))
  t.alike(JSON.parse(varanda(dir, ['account', 'status', '--json']).stdout.trim().split('\n').pop()).triage, { exemplars: 2 })
  t.is(fs.readFileSync(exemplarsFile, 'utf8'), exemplars, 'never rewritten')
  fs.writeFileSync(exemplarsFile, '{')
  t.ok(varanda(dir, ['account', 'status']).stdout.includes('Triagem IA: indisponível'))
  fs.unlinkSync(exemplarsFile)

  // A link made in-process, then exported by the CLI.
  const store = openAccountStore(dir)
  const row = store.start({ member: member().hex, username: 'ana' })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: SUB, email: EMAIL })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, association)
  const exported = varanda(dir, ['account', 'export'])
  t.is(exported.code, 0, exported.stderr)
  const lines = exported.stdout.trim().split('\n').map((l) => JSON.parse(l))
  t.is(lines.length, 1)
  t.alike(Object.keys(lines[0]).sort(), ['email', 'linkedAt', 'member', 'pushDevices', 'sub', 'terms', 'username'])
  t.alike(lines[0].terms, [], 'no terms.json: no acceptance')
  t.is(lines[0].email, EMAIL)
  t.is(lines[0].sub, SUB)
  t.absent(exported.stdout.includes(secret.slice(0, 16)), 'never the secret')
  t.absent(exported.stdout.includes('signature'))
  t.ok(varanda(dir, ['account', 'status']).stdout.includes('vínculos: 1'))

  // An acceptance recorded in-process shows in the export (version and date
  // only, never the nonce or the signature) and in the status count.
  const termsSig = 'b'.repeat(128)
  const accepted = await openTermsStore(dir).accept({ member: lines[0].member, version: 1, nonce: 'n'.repeat(43), signature: termsSig })
  const withTerms = varanda(dir, ['account', 'export'])
  t.is(withTerms.code, 0, withTerms.stderr)
  t.alike(JSON.parse(withTerms.stdout.trim()).terms, [{ version: 1, acceptedAt: accepted.acceptedAt }])
  t.absent(withTerms.stdout.includes(termsSig), 'never the terms signature')
  t.ok(varanda(dir, ['account', 'status']).stdout.includes('aceites dos termos: 1'))
  const termsFile = path.join(dir, 'terms.json')
  const termsBytes = fs.readFileSync(termsFile)
  fs.writeFileSync(termsFile, '{')
  const badTerms = varanda(dir, ['account', 'export'])
  t.is(badTerms.code, 1, 'a malformed terms.json fails the export')
  t.ok(badTerms.stderr.includes('terms.json inválido'), badTerms.stderr)
  t.ok(varanda(dir, ['account', 'status']).stdout.includes('aceites dos termos: indisponível (terms.json inválido)'))
  t.is(JSON.parse(varanda(dir, ['account', 'status', '--json']).stdout.trim().split('\n').pop()).terms, 'indisponivel')
  t.is(fs.readFileSync(termsFile, 'utf8'), '{', 'never rewritten')
  fs.writeFileSync(termsFile, termsBytes)

  const lock = takeLock(dir)
  const busy = varanda(dir, ['account', 'export'])
  t.is(busy.code, 1)
  t.ok(busy.stderr.includes('serviço de conta em execução'))
  t.ok(varanda(dir, ['account', 'status']).stdout.includes('estado: em execução'))
  lock.release()

  const memberDir = path.join(root, 'member')
  fs.mkdirSync(memberDir)
  fs.writeFileSync(path.join(memberDir, 'config.json'), JSON.stringify({ v: 1, role: 'member', association }))
  for (const args of [['account', 'key'], ['account', 'status'], ['account', 'export']]) {
    const r = varanda(memberDir, args)
    t.is(r.code, 1, args.join(' '))
    t.ok(r.stderr.includes('diretório não é do serviço de conta'), r.stderr)
  }
  t.is(varanda(dir, ['account', 'nope']).code, 2)
})

test('readEnv: VARANDA_AI off, sombra or 1; token, seeder URL and model dir checked without echo', (t) => {
  const base = { VARANDA_PUBLIC_ORIGIN: ORIGIN, VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID, VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET }
  const token = 'ab'.repeat(32)
  t.is(readEnv(base, '/data').triage, null, 'unset: off')
  t.is(readEnv({ ...base, VARANDA_AI: '' }, '/data').triage, null, 'empty: off')
  t.is(readEnv({ ...cleanEnv, ...base }, '/data').triage, null, 'cleanEnv (no VARANDA_*) keeps it off')
  t.alike(readEnv({ ...base, VARANDA_AI: 'sombra', VARANDA_TRIAGE_TOKEN: token }, '/data').triage,
    { mode: 'sombra', token, seederHttp: 'http://127.0.0.1:8789', modelDir: path.join('/data', 'ai-model') })
  t.alike(readEnv({ ...base, VARANDA_AI: '1', VARANDA_TRIAGE_TOKEN: token, VARANDA_SEEDER_HTTP: 'http://[::1]:9000/', VARANDA_AI_MODEL_DIR: '/modelo' }, '/data').triage,
    { mode: 'auto', token, seederHttp: 'http://[::1]:9000', modelDir: '/modelo' })
  t.is(readEnv({ ...base, VARANDA_AI: '1', VARANDA_TRIAGE_TOKEN: token, VARANDA_SEEDER_HTTP: 'http://localhost:8789' }, '/data').triage.seederHttp, 'http://localhost:8789')

  const usage = (env, message) => {
    try {
      readEnv({ ...base, ...env }, '/data')
      t.fail('accepted: ' + message)
    } catch (err) {
      t.is(err.code, 'USAGE', message)
      t.is(err.message, message)
      for (const v of Object.values(env)) if (v.length > 3) t.absent(err.message.includes(v), 'the value is not echoed')
    }
  }
  for (const ai of ['true', 'auto', '0', 'SOMBRA', ' 1']) usage({ VARANDA_AI: ai, VARANDA_TRIAGE_TOKEN: token }, 'VARANDA_AI inválido')
  usage({ VARANDA_AI: '1' }, 'VARANDA_TRIAGE_TOKEN inválido')
  usage({ VARANDA_AI: 'sombra', VARANDA_TRIAGE_TOKEN: 'AB'.repeat(32) }, 'VARANDA_TRIAGE_TOKEN inválido')
  usage({ VARANDA_AI: 'sombra', VARANDA_TRIAGE_TOKEN: 'ab'.repeat(31) }, 'VARANDA_TRIAGE_TOKEN inválido')
  for (const url of ['https://127.0.0.1:8789', 'http://10.0.0.1:8789', 'http://127.0.0.1', 'http://127.0.0.1:8789/x', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'http://seeder:8789']) {
    usage({ VARANDA_AI: '1', VARANDA_TRIAGE_TOKEN: token, VARANDA_SEEDER_HTTP: url }, 'VARANDA_SEEDER_HTTP inválido')
  }
})

test('account status, export and serve on a directory restored from an older backup', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const association = iss.association
  const env = {
    VARANDA_ASSOCIATION: association,
    VARANDA_PUBLIC_ORIGIN: ORIGIN,
    VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID,
    VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET
  }
  t.is(varanda(dir, ['account', 'key', '--association', association]).code, 0)
  const file = path.join(dir, 'directory.json')
  const hwm = path.join(dir, 'directory.hwm')
  const linkOne = async (username) => {
    const store = openAccountStore(dir)
    const row = store.start({ member: member().hex, username })
    store.putGoogle(row.id, { sub: 'sub-' + username, email: EMAIL })
    await store.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, association)
    await store.close()
  }
  await linkOne('ana')
  const backup = fs.readFileSync(file)
  await linkOne('bia')
  t.is(JSON.parse(fs.readFileSync(hwm, 'utf8')).seq, 2)
  fs.writeFileSync(file, backup)

  const status = varanda(dir, ['account', 'status'])
  t.is(status.code, 0, status.stderr)
  t.ok(status.stdout.includes('vínculos: 1'))
  t.ok(status.stdout.includes('aviso: diretório de contas restaurado de uma cópia antiga; confira o backup'), 'status warns')
  const json = varanda(dir, ['account', 'status', '--json'])
  t.is(JSON.parse(json.stdout.trim().split('\n').pop()).restored, true, 'and reports the flag')
  const exported = varanda(dir, ['account', 'export'])
  t.is(exported.code, 0, 'export still reads')
  t.is(exported.stdout.trim().split('\n').length, 1)
  t.ok(exported.stderr.includes('restaurado de uma cópia antiga'), 'and warns on stderr')

  const refused = varanda(dir, ['account', '--json'], env)
  t.is(refused.code, 1, 'the service refuses to start')
  t.ok(refused.stdout.includes(JSON.stringify({ event: 'store', reason: 'restaurado' })), 'logged as a store event')
  t.ok(refused.stderr.includes('diretório de contas restaurado de uma cópia antiga; confira o backup'), refused.stderr)
  t.absent(fs.existsSync(path.join(dir, LOCK_FILE)), 'the lock is released')

  // The operator who meant to restore the older copy removes the mark.
  fs.unlinkSync(hwm)
  t.absent(varanda(dir, ['account', 'status']).stdout.includes('aviso:'), 'no warning once acknowledged')
  await linkOne('bia')
  t.is(JSON.parse(fs.readFileSync(hwm, 'utf8')).seq, 2, 'a new mark from the restored copy on')
})

// Spawns `account` on a free port; -> { child, port, stdout(), stop() }.
async function serveCli (t, dir, env) {
  const child = spawn(process.execPath, [BIN, 'account', '--json', '--account-port', '0', '--data', dir], { env: { ...cleanEnv, ...env } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
  t.teardown(() => { child.kill('SIGKILL') }, { force: true })
  const stop = async () => {
    child.kill('SIGTERM')
    return exited
  }
  return { child, exited, stop, stdout: () => stdout, stderr: () => stderr }
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

test('account (serve): boots unconfigured, takes the data-dir lock, stops on SIGTERM', async (t) => {
  t.timeout(60000)
  const dir = path.join(tmpDir(t), 'account')
  const association = issuer().association
  const env = {
    VARANDA_ASSOCIATION: association,
    VARANDA_PUBLIC_ORIGIN: ORIGIN,
    VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID,
    VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET
  }

  const missing = varanda(dir, ['account'], { ...env, VARANDA_PUBLIC_ORIGIN: 'http://varanda.test' })
  t.is(missing.code, 2)
  t.ok(missing.stderr.includes('VARANDA_PUBLIC_ORIGIN inválido'))
  t.absent(missing.stderr.includes('http://varanda.test'), 'the value is not printed')
  const noSecret = varanda(dir, ['account'], { ...env, VARANDA_GOOGLE_CLIENT_SECRET: '' })
  t.is(noSecret.code, 2)
  const anyHost = varanda(dir, ['account', '--account-host', '0.0.0.0'], env)
  t.is(anyHost.code, 2)
  t.ok(anyHost.stderr.includes('account-host inválido'))

  // Leftovers of the removed payments account: deleted at startup, logged by
  // name only.
  const leftovers = ['wallet.json', 'wallet-ops.json', '.wallet.json.1.0123456789ab.tmp']
  fs.mkdirSync(dir, { recursive: true })
  for (const name of leftovers) fs.writeFileSync(path.join(dir, name), 'SEGREDO-NAO-LOGAR')

  const svc = await serveCli(t, dir, env)
  const port = await until(() => listeningPort(svc.stdout()), { name: 'listening' })
  // 'listening' and 'ready' are two writes; they can arrive in separate chunks.
  t.ok(await until(() => svc.stdout().includes(JSON.stringify({ event: 'ready', configured: false })), { name: 'ready' }))
  t.ok(svc.stdout().includes(JSON.stringify({ event: 'triage', reason: 'desligada' })), 'VARANDA_AI unset: triage off')
  t.ok(svc.stdout().includes(JSON.stringify({ event: 'idade', reason: 'desligada' })), 'Didit unset: age verification off')
  for (const name of leftovers) {
    t.absent(fs.existsSync(path.join(dir, name)), name + ' removed')
    t.ok(svc.stdout().includes(JSON.stringify({ event: 'carteira', reason: 'removido', file: name })), name + ' logged')
  }
  t.absent(svc.stdout().includes('SEGREDO-NAO-LOGAR'), 'no file content in the log')
  t.absent(svc.stdout().includes(JSON.stringify({ event: 'carteira', reason: 'desligada' })), 'no payments account to report')
  t.ok(lockHeld(dir), 'lock taken')
  const health = await fetch('http://127.0.0.1:' + port + '/account/health')
  t.alike(await health.json(), { status: 'ok' })
  const start = await fetch('http://127.0.0.1:' + port + '/account/start', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ member: member().hex, username: 'ana' })
  })
  t.is(start.status, 503)
  t.alike(await start.json(), { error: 'indisponivel' })

  const second = varanda(dir, ['account'], env)
  t.is(second.code, 1)
  t.ok(second.stderr.includes('outro serviço de conta usa este diretório'), second.stderr)
  // Other processes (another container in Docker) see the live lock.
  t.ok(varanda(dir, ['account', 'status']).stdout.includes('estado: em execução'))
  const busy = varanda(dir, ['account', 'export'])
  t.is(busy.code, 1)
  t.ok(busy.stderr.includes('serviço de conta em execução'), busy.stderr)

  t.is(await svc.stop(), 0, svc.stderr())
  t.absent(fs.existsSync(path.join(dir, LOCK_FILE)), 'lock released')
  const out = svc.stdout()
  t.absent(out.includes(CLIENT_SECRET))
  t.absent(HEX16.test(out), 'no 16-hex run on stdout')
  t.absent(out.includes(ORIGIN), 'the origin is not printed')

  // The lock on disk stops being the service's own (another token): at the
  // next heartbeat (LOCK_HEARTBEAT_MS = 10 s) the service logs 'perdido',
  // exits non-zero and leaves the foreign lock in place.
  const again = await serveCli(t, dir, env)
  await until(() => listeningPort(again.stdout()), { name: 'listening again' })
  const lockFile = path.join(dir, LOCK_FILE)
  const foreign = JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'f'.repeat(32) }) + '\n'
  fs.writeFileSync(lockFile, foreign)
  t.is(await again.exited, 1, 'exits non-zero once the lock is lost')
  t.ok(again.stdout().includes(JSON.stringify({ event: 'lock', reason: 'perdido' })), 'the loss is logged')
  t.is(fs.readFileSync(lockFile, 'utf8'), foreign, 'the foreign lock survives')
})

test('account (serve): an invalid VARANDA_AI is a usage error; a missing model runs without triage', async (t) => {
  t.timeout(60000)
  const root = tmpDir(t)
  const dir = path.join(root, 'account')
  const token = 'cd'.repeat(32)
  const env = {
    VARANDA_ASSOCIATION: issuer().association,
    VARANDA_PUBLIC_ORIGIN: ORIGIN,
    VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID,
    VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET
  }
  const bad = varanda(dir, ['account'], { ...env, VARANDA_AI: 'talvez' })
  t.is(bad.code, 2)
  t.ok(bad.stderr.includes('VARANDA_AI inválido'))
  t.absent(fs.existsSync(path.join(dir, LOCK_FILE)), 'refused before the lock and the listen')
  const badToken = varanda(dir, ['account'], { ...env, VARANDA_AI: '1', VARANDA_TRIAGE_TOKEN: 'segredo' })
  t.is(badToken.code, 2)
  t.absent(badToken.stderr.includes('segredo'), 'the token is never printed')

  const svc = await serveCli(t, dir, { ...env, VARANDA_AI: '1', VARANDA_TRIAGE_TOKEN: token, VARANDA_AI_MODEL_DIR: path.join(root, 'sem-modelo') })
  const port = await until(() => listeningPort(svc.stdout()), { name: 'listening' })
  t.ok(svc.stdout().includes(JSON.stringify({ event: 'triage', reason: 'sem-modelo' })), 'the token is logged')
  const health = await fetch('http://127.0.0.1:' + port + '/account/health')
  t.is(health.status, 200, 'the healthcheck stays green')
  t.is(await svc.stop(), 0, svc.stderr())
  t.absent(svc.stdout().includes(token), 'never the triage token')
  t.absent(fs.existsSync(path.join(dir, 'exemplars.json')), 'nothing of the triage was opened')
})

// --- capacity: member cap and configurable limits ---------------------------------

test('member cap: a new start on a full service is 503 lista-de-espera; status, lookup and linked members unchanged', async (t) => {
  const s = await setup(t, { storeOpts: { maxMembers: 1 } })
  const linked = member()
  t.is((await link(s, linked, 'ana')).finish.status, 200)

  const waiting = member()
  const started = await s.api('POST', '/account/start', { body: { member: waiting.hex, username: 'bia' } })
  t.is(started.status, 503)
  t.alike(started.body, { error: 'lista-de-espera' }, 'the body is only the token')
  t.is(started.headers.get('set-cookie'), null, 'no pending row, no cookie')
  const again = await s.api('POST', '/account/start', { body: { member: linked.hex, username: 'outra' } })
  t.alike([again.status, again.body], [409, { error: 'conta-vinculada' }], 'a linked member still hears conta-vinculada')

  const unknown = await s.api('GET', '/account/status?member=' + waiting.hex)
  t.alike(unknown.body, { linked: false }, 'status of an unknown member is unchanged')
  const own = await s.api('GET', '/account/status?member=' + linked.hex)
  t.is(own.body.linked, true)
  t.is((await s.api('GET', '/account/username/ana')).status, 200, 'lookup unchanged')

  t.ok(s.logs.includes(JSON.stringify({ event: 'lista-de-espera' })), 'logged as the bare event')
  const log = s.logs.join('\n')
  noPersonalData(t, log, 'log')
  t.absent(log.includes(waiting.hex), 'log: no member key')
})

test('member cap: a finish after the cap filled is 503 lista-de-espera and links nothing', async (t) => {
  const s = await setup(t, { storeOpts: { maxMembers: 2 } })
  t.is((await link(s, member(), 'ana')).finish.status, 200)
  const late = member()
  const a = await startLink(s, late, 'bia')
  t.is((await verifyPhone(s, late)).status, 200)
  t.is((await link(s, member(), 'cora')).finish.status, 200, 'the cap fills meanwhile')
  const finish = await s.api('POST', '/account/finish', { cookie: a.cookie, body: { signature: finishSig(s, late, a.nonce, 'bia') } })
  t.alike([finish.status, finish.body], [503, { error: 'lista-de-espera' }])
  t.alike(cookieOf(finish), { id: a.cookie, maxAge: 0 }, 'the link cookie is cleared as on success')
  t.alike((await s.api('GET', '/account/status?member=' + late.hex)).body, { linked: false })
  t.is(s.store.get(a.cookie), null, 'the pending row is gone')
  t.is((await s.api('GET', '/account/username/bia')).status, 404)
})

test('member cap: the retired callback on a full service redirects with erro and drops nothing', async (t) => {
  const s = await setup(t, { storeOpts: { maxMembers: 2 } })
  t.is((await link(s, member(), 'ana')).finish.status, 200)
  const late = member()
  const a = await startLink(s, late, 'bia')
  t.is((await link(s, member(), 'cora')).finish.status, 200, 'the cap fills meanwhile')

  const cb = await s.api('GET', '/account/callback?state=' + 'A'.repeat(43) + '&code=codigo-1', { cookie: a.cookie })
  t.is(cb.status, 302)
  t.is(cb.headers.get('location'), s.origin + '/?conta=erro', 'never the waitlist answer of the old flow')
  t.is(cb.headers.get('set-cookie'), null, 'the link cookie is left alone')
  t.ok(s.store.get(a.cookie) !== null, 'the pending row is not dropped by the callback')
  noOutbound(t, s, 'callback on a full service')
  t.absent(s.logs.includes(JSON.stringify({ event: 'callback', reason: 'lista-de-espera' })), 'no callback waitlist line')
  const log = s.logs.join('\n')
  noPersonalData(t, log, 'log')
  t.absent(log.includes(late.hex), 'log: no member key')
})

test('member cap: a second finish for a key linked meanwhile is not refused by the cap', async (t) => {
  const s = await setup(t, { storeOpts: { maxMembers: 2 } })
  t.is((await link(s, member(), 'ana')).finish.status, 200)
  const m = member()
  // Two link flows for the same key (two tabs); the first fills the last slot.
  const first = await startLink(s, m, 'bia')
  const second = await startLink(s, m, 'bia')
  t.is((await verifyPhone(s, m)).status, 200)
  const f1 = await s.api('POST', '/account/finish', { cookie: first.cookie, body: { signature: finishSig(s, m, first.nonce, 'bia') } })
  t.is(f1.status, 200, 'the first flow links the key into the last slot')

  const f2 = await s.api('POST', '/account/finish', { cookie: second.cookie, body: { signature: finishSig(s, m, second.nonce, 'bia') } })
  t.absent(f2.body && f2.body.error === 'lista-de-espera', 'the linked key is not sent to the waitlist: ' + f2.text)
  t.is(f2.status, 200, 'the same account answers again')
  t.alike(f2.body.cert, f1.body.cert, 'the same certificate')
})

test('admission: with no member cap the service answers exactly { open: true }', async (t) => {
  const s = await setup(t)
  const r = await s.api('GET', '/account/admission')
  t.is(r.status, 200)
  t.alike(r.body, { open: true }, 'the whole body')
})

test('admission: follows the member cap, sets no cookie, is not cached and changes no later refusal', async (t) => {
  const s = await setup(t, { storeOpts: { maxMembers: 1 } })
  const before = await s.api('GET', '/account/admission')
  t.alike([before.status, before.body], [200, { open: true }], 'nobody linked yet')
  t.is((await link(s, member(), 'ana')).finish.status, 200)

  const full = await s.api('GET', '/account/admission')
  t.alike([full.status, full.body], [200, { open: false }], 'the cap is full')
  t.is(full.headers.get('set-cookie'), null, 'no cookie')
  t.ok((full.headers.get('cache-control') || '').includes('no-store'), 'never cached')
  const query = await s.api('GET', '/account/admission?invite=x')
  t.alike([query.status, query.body], [200, { open: false }], 'the query string changes nothing')

  const started = await s.api('POST', '/account/start', { body: { member: member().hex, username: 'bia' } })
  t.alike([started.status, started.body], [503, { error: 'lista-de-espera' }], 'start still refuses')
  const policy = await s.api('GET', '/account/invites/policy')
  t.alike([policy.status, policy.body], [200, { required: false }], 'the invites policy body is unchanged')
})

test('admission: the read holds no seat, so a following start still answers 200', async (t) => {
  const s = await setup(t, { storeOpts: { maxMembers: 1 } })
  t.alike((await s.api('GET', '/account/admission')).body, { open: true })
  const started = await s.api('POST', '/account/start', { body: { member: member().hex, username: 'ana' } })
  t.is(started.status, 200)
})

test('admission: POST is not a route', async (t) => {
  const s = await setup(t)
  const r = await s.api('POST', '/account/admission', { body: {} })
  t.alike([r.status, r.body], [404, { error: 'nao-encontrado' }])
})

test('global bucket: ratePerSecond 1, burst 1 answers 429 on the second immediate request', async (t) => {
  const s = await setup(t, { serverOpts: { ratePerSecond: 1, burst: 1 } })
  s.c.frozen = Date.now()
  const first = await s.api('GET', '/account/status?member=' + member().hex)
  t.is(first.status, 200)
  const second = await s.api('GET', '/account/status?member=' + member().hex)
  t.alike([second.status, second.body], [429, { error: 'pedido-invalido' }])
  s.c.offset += 1000
  t.is((await s.api('GET', '/account/status?member=' + member().hex)).status, 200, 'one token per second')
})

test('defaults: 64 sockets, bucket 20/s with burst 100; invalid limits are refused', async (t) => {
  t.is(MAX_SOCKETS, 64)
  t.is(DEFAULT_RATE, 20)
  t.is(DEFAULT_BURST, 100)
  const s = await setup(t)
  s.c.frozen = Date.now()
  for (let i = 0; i < 100; i++) {
    const r = await s.api('GET', '/account/status?member=' + member().hex)
    if (r.status !== 200) {
      t.fail('request ' + (i + 1) + ' within the default burst: ' + r.status)
      break
    }
  }
  t.is((await s.api('GET', '/account/status?member=' + member().hex)).status, 429, 'the 101st immediate request')

  const iss = issuer()
  const base = { association: iss.association, origin: ORIGIN, google: { authorizeUrl () {}, exchange () {} }, store: { start () {} } }
  for (const bad of [{ maxConnections: 0 }, { ratePerSecond: 1.5 }, { burst: '100' }]) {
    throwsMessage(t, () => createAccountServer({ ...base, ...bad }), /positive integer/, JSON.stringify(bad))
  }
})

test('readEnv: optional capacity variables, canonical integers in range, values never in the error', (t) => {
  const env = { VARANDA_PUBLIC_ORIGIN: ORIGIN, VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID, VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET }
  t.alike(readEnv(env).limits, {}, 'absent: every default')
  t.alike(readEnv({ ...env, VARANDA_MAX_MEMBERS: '', VARANDA_ACCOUNT_RATE: '   ' }).limits, {}, 'empty after trim: default')
  t.alike(readEnv({
    ...env,
    VARANDA_MAX_MEMBERS: '500',
    VARANDA_ACCOUNT_MAX_PENDING: '100000',
    VARANDA_ACCOUNT_MAX_CONNECTIONS: ' 256 ',
    VARANDA_ACCOUNT_RATE: '1',
    VARANDA_ACCOUNT_BURST: '400'
  }).limits, { maxMembers: 500, maxPending: 100000, maxConnections: 256, ratePerSecond: 1, burst: 400 })

  const bad = [
    ['VARANDA_MAX_MEMBERS', 'abc'],
    ['VARANDA_MAX_MEMBERS', '0'],
    ['VARANDA_MAX_MEMBERS', '4097'],
    ['VARANDA_MAX_MEMBERS', '012'],
    ['VARANDA_MAX_MEMBERS', '1e3'],
    ['VARANDA_MAX_MEMBERS', '-5'],
    ['VARANDA_ACCOUNT_MAX_CONNECTIONS', '4097'],
    ['VARANDA_ACCOUNT_RATE', '10001'],
    ['VARANDA_ACCOUNT_BURST', '100001'],
    ['VARANDA_ACCOUNT_MAX_PENDING', '0']
  ]
  for (const [name, value] of bad) {
    try {
      readEnv({ ...env, [name]: value })
      t.fail(name + '=' + value + ': accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, name + '=' + value + ': usage error')
      t.is(err.message, name + ' inválido', 'the value is not in the message')
    }
  }
})

test('readEnv: Didit pair on together or off together, values never in the error', (t) => {
  const env = { VARANDA_PUBLIC_ORIGIN: ORIGIN, VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID, VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET }
  const KEY = 'chave-sentinela-didit-77'
  const WORKFLOW = '0a1B2c3D-4e5F-6789-abcd-EF0123456789'
  t.is(readEnv(env).didit, null, 'unset: off')
  t.is(readEnv({ ...env, VARANDA_DIDIT_API_KEY: '', VARANDA_DIDIT_WORKFLOW_ID: '' }).didit, null, 'empty: off')
  t.is(readEnv({ ...env, VARANDA_DIDIT_DAILY_LIMIT: 'abc' }).didit, null, 'the limit is ignored while off')
  t.alike(readEnv({ ...env, VARANDA_DIDIT_API_KEY: KEY, VARANDA_DIDIT_WORKFLOW_ID: WORKFLOW }).didit, { apiKey: KEY, workflowId: WORKFLOW, dailyLimit: 200 })
  t.is(readEnv({ ...env, VARANDA_DIDIT_API_KEY: KEY, VARANDA_DIDIT_WORKFLOW_ID: WORKFLOW, VARANDA_DIDIT_DAILY_LIMIT: '50' }).didit.dailyLimit, 50)
  t.is(readEnv({ ...env, VARANDA_DIDIT_API_KEY: KEY, VARANDA_DIDIT_WORKFLOW_ID: WORKFLOW, VARANDA_DIDIT_DAILY_LIMIT: '' }).didit.dailyLimit, 200, 'empty limit: default')

  const bad = [
    [{ VARANDA_DIDIT_API_KEY: KEY }, 'VARANDA_DIDIT_API_KEY e VARANDA_DIDIT_WORKFLOW_ID vêm juntas'],
    [{ VARANDA_DIDIT_WORKFLOW_ID: WORKFLOW }, 'VARANDA_DIDIT_API_KEY e VARANDA_DIDIT_WORKFLOW_ID vêm juntas'],
    [{ VARANDA_DIDIT_API_KEY: KEY, VARANDA_DIDIT_WORKFLOW_ID: '' }, 'VARANDA_DIDIT_API_KEY e VARANDA_DIDIT_WORKFLOW_ID vêm juntas'],
    [{ VARANDA_DIDIT_API_KEY: 'chave sentinela', VARANDA_DIDIT_WORKFLOW_ID: WORKFLOW }, 'VARANDA_DIDIT_API_KEY inválido'],
    [{ VARANDA_DIDIT_API_KEY: KEY + '\n', VARANDA_DIDIT_WORKFLOW_ID: WORKFLOW }, 'VARANDA_DIDIT_API_KEY inválido'],
    [{ VARANDA_DIDIT_API_KEY: 'k'.repeat(257), VARANDA_DIDIT_WORKFLOW_ID: WORKFLOW }, 'VARANDA_DIDIT_API_KEY inválido'],
    [{ VARANDA_DIDIT_API_KEY: KEY, VARANDA_DIDIT_WORKFLOW_ID: 'fluxo-sentinela' }, 'VARANDA_DIDIT_WORKFLOW_ID inválido'],
    [{ VARANDA_DIDIT_API_KEY: KEY, VARANDA_DIDIT_WORKFLOW_ID: WORKFLOW + '0' }, 'VARANDA_DIDIT_WORKFLOW_ID inválido']
  ]
  for (const limit of ['0', '-1', '1.5', 'abc', '100001']) {
    bad.push([{ VARANDA_DIDIT_API_KEY: KEY, VARANDA_DIDIT_WORKFLOW_ID: WORKFLOW, VARANDA_DIDIT_DAILY_LIMIT: limit }, 'VARANDA_DIDIT_DAILY_LIMIT inválido'])
  }
  for (const [vars, message] of bad) {
    const label = JSON.stringify(vars)
    try {
      readEnv({ ...env, ...vars })
      t.fail(label + ': accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, label + ': usage error')
      t.is(err.message, message, label + ': message')
      for (const value of Object.values(vars)) {
        if (value !== '') t.absent(err.message.includes(value), 'the value is not in the message')
      }
    }
  }
})

test('readEnv: VARANDA_PREVIEW turns link previews off with 0, on otherwise, and refuses other values', (t) => {
  const env = { VARANDA_PUBLIC_ORIGIN: ORIGIN, VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID, VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET }
  t.is(readEnv(env).preview, true, 'unset: on')
  t.is(readEnv({ ...env, VARANDA_PREVIEW: '' }).preview, true, 'empty: on')
  t.is(readEnv({ ...env, VARANDA_PREVIEW: '1' }).preview, true)
  t.is(readEnv({ ...env, VARANDA_PREVIEW: '0' }).preview, false)
  for (const value of ['off', 'false', ' 0', '2']) {
    try {
      readEnv({ ...env, VARANDA_PREVIEW: value })
      t.fail(JSON.stringify(value) + ': accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, JSON.stringify(value))
      t.is(err.message, 'VARANDA_PREVIEW inválido: use 0 ou 1')
    }
  }
})

test('readEnv: GIF pair on together or off together, https only, values never in the error', (t) => {
  const env = { VARANDA_PUBLIC_ORIGIN: ORIGIN, VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID, VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET }
  const URL_OK = 'https://gifs-sentinela.example/v1'
  const KEY = 'chave-sentinela-gif-91'
  t.is(readEnv(env).gif, null, 'unset: off')
  t.is(readEnv({ ...env, VARANDA_GIF_API_URL: '', VARANDA_GIF_API_KEY: '' }).gif, null, 'empty: off')
  t.is(readEnv({ ...env, VARANDA_GIF_MEDIA_HOSTS: '10.0.0.1' }).gif, null, 'media hosts ignored while off')
  const on = readEnv({ ...env, VARANDA_GIF_API_URL: URL_OK, VARANDA_GIF_API_KEY: KEY, VARANDA_GIF_MEDIA_HOSTS: ' Media.Sentinela.example , cdn.sentinela.example' }).gif
  t.is(on.base, URL_OK)
  t.is(on.apiKey, KEY)
  t.alike([...on.hosts].sort(), ['cdn.sentinela.example', 'gifs-sentinela.example', 'media.sentinela.example'])

  const bad = [
    [{ VARANDA_GIF_API_URL: URL_OK }, 'VARANDA_GIF_API_URL e VARANDA_GIF_API_KEY vêm juntas'],
    [{ VARANDA_GIF_API_KEY: KEY }, 'VARANDA_GIF_API_URL e VARANDA_GIF_API_KEY vêm juntas'],
    [{ VARANDA_GIF_API_URL: 'http://gifs-sentinela.example', VARANDA_GIF_API_KEY: KEY }, 'VARANDA_GIF_API_URL inválido: use uma URL https sem usuário, consulta nem endereço IP'],
    [{ VARANDA_GIF_API_URL: 'https://10.9.8.7/sentinela', VARANDA_GIF_API_KEY: KEY }, 'VARANDA_GIF_API_URL inválido: use uma URL https sem usuário, consulta nem endereço IP'],
    [{ VARANDA_GIF_API_URL: URL_OK + '?api_key=sentinela', VARANDA_GIF_API_KEY: KEY }, 'VARANDA_GIF_API_URL inválido: use uma URL https sem usuário, consulta nem endereço IP'],
    [{ VARANDA_GIF_API_URL: URL_OK, VARANDA_GIF_API_KEY: 'chave sentinela' }, 'VARANDA_GIF_API_KEY inválido'],
    [{ VARANDA_GIF_API_URL: URL_OK, VARANDA_GIF_API_KEY: KEY, VARANDA_GIF_MEDIA_HOSTS: '10.1.1.1' }, 'VARANDA_GIF_MEDIA_HOSTS inválido: use nomes de host separados por vírgula'],
    [{ VARANDA_GIF_API_URL: URL_OK, VARANDA_GIF_API_KEY: KEY, VARANDA_GIF_MEDIA_HOSTS: 'ok.example,,sentinela' }, 'VARANDA_GIF_MEDIA_HOSTS inválido: use nomes de host separados por vírgula']
  ]
  for (const [vars, message] of bad) {
    const label = JSON.stringify(vars)
    try {
      readEnv({ ...env, ...vars })
      t.fail(label + ': accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, label + ': usage error')
      t.is(err.message, message, label + ': message')
      for (const value of Object.values(vars)) {
        if (value !== '') t.absent(err.message.includes(value), 'the value is not in the message')
      }
    }
  }
})

test('readEnv: Audius on with the key, optional values checked, values never in the error', (t) => {
  const env = { VARANDA_PUBLIC_ORIGIN: ORIGIN, VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID, VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET }
  const KEY = 'chave-sentinela-audius-73'
  t.is(readEnv(env).audius, null, 'unset: off')
  t.is(readEnv({ ...cleanEnv, ...env }).audius, null, 'cleanEnv (no VARANDA_*) keeps it off')
  t.is(readEnv({
    ...env,
    VARANDA_AUDIUS_API_KEY: '',
    VARANDA_AUDIUS_API_URL: '',
    VARANDA_AUDIUS_APP_NAME: '',
    VARANDA_AUDIUS_MOMENTS: '',
    VARANDA_AUDIUS_COVERS: '',
    VARANDA_AUDIUS_STREAMS: ''
  }).audius, null, 'all empty, as compose passes them: off')

  t.alike(readEnv({ ...env, VARANDA_AUDIUS_API_KEY: KEY }).audius, {
    base: 'https://api.audius.co/v1',
    apiHost: 'api.audius.co',
    apiKey: KEY,
    appName: 'varanda',
    moments: false,
    covers: false,
    streams: 16
  }, 'the key alone: defaults, momentos and covers off')
  t.is(readEnv({ ...env, VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_MOMENTS: '0' }).audius.moments, false)
  t.is(readEnv({ ...env, VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_COVERS: '0' }).audius.covers, false, 'covers 0: off')
  t.is(readEnv({ ...env, VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_COVERS: '' }).audius.covers, false, 'covers empty: off')
  t.is(readEnv({ ...env, VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_COVERS: '1' }).audius.covers, true, 'covers 1: on')
  t.is(readEnv({ ...env, VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_COVERS: '1' }).audius.moments, false, 'covers do not turn momentos on')
  t.alike(readEnv({
    ...env,
    VARANDA_AUDIUS_API_KEY: KEY,
    VARANDA_AUDIUS_API_URL: 'https://Audius-Sentinela.example/v1/',
    VARANDA_AUDIUS_APP_NAME: 'varanda-teste',
    VARANDA_AUDIUS_MOMENTS: '1',
    VARANDA_AUDIUS_COVERS: '1',
    VARANDA_AUDIUS_STREAMS: ' 32 '
  }).audius, {
    base: 'https://audius-sentinela.example/v1',
    apiHost: 'audius-sentinela.example',
    apiKey: KEY,
    appName: 'varanda-teste',
    moments: true,
    covers: true,
    streams: 32
  }, 'every optional value set')

  const bad = [
    [{ VARANDA_AUDIUS_API_URL: 'https://audius-sentinela.example/v1' }, 'VARANDA_AUDIUS_API_KEY ausente'],
    [{ VARANDA_AUDIUS_APP_NAME: 'sentinela' }, 'VARANDA_AUDIUS_API_KEY ausente'],
    [{ VARANDA_AUDIUS_MOMENTS: '1' }, 'VARANDA_AUDIUS_API_KEY ausente'],
    [{ VARANDA_AUDIUS_COVERS: '1' }, 'VARANDA_AUDIUS_API_KEY ausente'],
    [{ VARANDA_AUDIUS_COVERS: '0', VARANDA_AUDIUS_API_KEY: '' }, 'VARANDA_AUDIUS_API_KEY ausente'],
    [{ VARANDA_AUDIUS_STREAMS: '8', VARANDA_AUDIUS_API_KEY: '' }, 'VARANDA_AUDIUS_API_KEY ausente'],
    [{ VARANDA_AUDIUS_API_KEY: 'chave sentinela' }, 'VARANDA_AUDIUS_API_KEY inválido'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_API_URL: 'http://audius-sentinela.example' }, 'VARANDA_AUDIUS_API_URL inválido: use uma URL https sem usuário, consulta nem endereço IP'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_API_URL: 'https://10.9.8.7/sentinela' }, 'VARANDA_AUDIUS_API_URL inválido: use uma URL https sem usuário, consulta nem endereço IP'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_API_URL: 'https://audius-sentinela.example/v1?api_key=sentinela' }, 'VARANDA_AUDIUS_API_URL inválido: use uma URL https sem usuário, consulta nem endereço IP'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_APP_NAME: 'Sentinela_App' }, 'VARANDA_AUDIUS_APP_NAME inválido: use letras minúsculas, números e hífen, até 32'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_MOMENTS: 'sim-sentinela' }, 'VARANDA_AUDIUS_MOMENTS inválido: use 0 ou 1'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_COVERS: 'sim-sentinela' }, 'VARANDA_AUDIUS_COVERS inválido: use 0 ou 1'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_COVERS: 'true' }, 'VARANDA_AUDIUS_COVERS inválido: use 0 ou 1'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_STREAMS: '33' }, 'VARANDA_AUDIUS_STREAMS inválido: use um número inteiro de 1 a 32'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_STREAMS: '0' }, 'VARANDA_AUDIUS_STREAMS inválido: use um número inteiro de 1 a 32'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_STREAMS: '08' }, 'VARANDA_AUDIUS_STREAMS inválido: use um número inteiro de 1 a 32'],
    [{ VARANDA_AUDIUS_API_KEY: KEY, VARANDA_AUDIUS_STREAMS: 'sentinela' }, 'VARANDA_AUDIUS_STREAMS inválido: use um número inteiro de 1 a 32']
  ]
  for (const [vars, message] of bad) {
    const label = JSON.stringify(vars)
    try {
      readEnv({ ...env, ...vars })
      t.fail(label + ': accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, label + ': usage error')
      t.is(err.message, message, label + ': message')
      for (const value of Object.values(vars)) {
        if (value !== '') t.absent(err.message.includes(value), 'the value is not in the message')
      }
    }
  }
})

test('account (serve): an invalid capacity variable exits 2 without printing it', (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const r = varanda(dir, ['account'], {
    VARANDA_ASSOCIATION: issuer().association,
    VARANDA_PUBLIC_ORIGIN: ORIGIN,
    VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID,
    VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    VARANDA_MAX_MEMBERS: 'zz9zz'
  })
  t.is(r.code, 2)
  t.ok(r.stderr.includes('VARANDA_MAX_MEMBERS inválido'), r.stderr)
  t.absent(r.stderr.includes('zz9zz') || r.stdout.includes('zz9zz'), 'the value is not printed')
})

// --- native app clients (apps/cli/lib/account/app-return.js) ----------------

const APP = { 'x-varanda-client': 'app' }

// The app's in-memory secret V and the appProof it sends at start.
function appSecret () {
  const v = nodeCrypto.randomBytes(32).toString('base64url')
  return { v, proof: nodeCrypto.createHash('sha256').update(Buffer.from(v, 'base64url')).digest('base64url') }
}

function appHeaders (secret) {
  const headers = { ...APP }
  if (secret) headers['x-varanda-link'] = secret.v
  return headers
}

function appApi (s, method, pathname, { secret, body } = {}) {
  return s.api(method, pathname, { origin: null, headers: appHeaders(secret), body })
}

// App start (no cookie). `link`: the earlier V the start presents (starting
// over). -> { secret, started, nonce }.
async function appStart (s, m, username, { secret = appSecret(), invite, link = null } = {}) {
  const body = { member: m.hex, username, appProof: secret.proof }
  if (invite !== undefined) body.invite = invite
  const started = await s.api('POST', '/account/start', { origin: null, headers: appHeaders(link), body })
  return { secret, started, nonce: started.status === 200 ? started.body.nonce : null }
}

function appFinish (s, m, secret, nonce, username) {
  return appApi(s, 'POST', '/account/finish', { secret, body: { signature: finishSig(s, m, nonce, username) } })
}

test('app return (retired): 404 expirado with or without a query, never echoes it', async (t) => {
  const s = await setup(t, { configured: false })
  const R = appSecret().v
  const withCode = await s.api('GET', '/account/app/conta?conta=ok&codigo=' + R)
  t.alike([withCode.status, withCode.body], [404, { error: 'expirado' }])
  t.is(withCode.headers.get('cache-control'), 'no-store')
  t.is(withCode.headers.get('access-control-allow-origin'), null)
  t.absent(withCode.text.includes(R), 'a code in the query is never rendered')
  const bare = await s.api('GET', '/account/app/conta')
  t.alike([bare.status, bare.body], [404, { error: 'expirado' }])
  t.absent(s.logs.join('\n').includes(R), 'the query is never logged')
  noOutbound(t, s, 'app return')
})

test('app clients: an Origin-less POST needs the app header and JSON; a present Origin must still match', async (t) => {
  const s = await setup(t)
  const body = (m) => ({ member: m.hex, username: 'ana', appProof: appSecret().proof })

  const bare = await s.api('POST', '/account/start', { origin: null, body: body(member()) })
  t.is(bare.status, 403, 'no Origin and no app header')
  const wrongHeader = await s.api('POST', '/account/start', { origin: null, headers: { 'x-varanda-client': 'App' }, body: body(member()) })
  t.is(wrongHeader.status, 403, 'the header value is exact')
  const nullOrigin = await s.api('POST', '/account/start', { origin: 'null', headers: APP, body: body(member()) })
  t.is(nullOrigin.status, 403, 'Origin null stays refused')
  const foreign = await s.api('POST', '/account/start', { origin: 'https://evil.test', headers: APP, body: body(member()) })
  t.is(foreign.status, 403, 'a mismatched Origin with the app header')
  const text = await s.api('POST', '/account/start', { origin: null, headers: { ...APP, 'content-type': 'text/plain' }, body: body(member()) })
  t.is(text.status, 400, 'the app header does not lift the JSON rule')
  const ok = await s.api('POST', '/account/start', { origin: null, headers: APP, body: body(member()) })
  t.is(ok.status, 200, 'app header + JSON is accepted: ' + ok.text)
})

test('app start: appProof is required in its exact shape, the answer is { nonce } with no cookie', async (t) => {
  const s = await setup(t)
  const m = member()
  const good = appSecret().proof
  // The last character of 32 bytes carries 4 data bits and two zero bits
  // (one of AEIMQUYcgkosw048); the next character sets a stray bit, a
  // non-canonical spelling of the same bytes.
  const nonCanonical = good.slice(0, 42) + String.fromCharCode(good.charCodeAt(42) + 1)
  for (const appProof of [undefined, '', good.slice(0, 42), good + 'A', good.slice(0, 42) + '=', good.slice(0, 42) + '+', 42, nonCanonical]) {
    const r = await s.api('POST', '/account/start', { origin: null, headers: APP, body: { member: m.hex, username: 'ana', appProof } })
    t.is(r.status, 400, 'refused: ' + JSON.stringify(appProof))
    t.alike(r.body, { error: 'pedido-invalido' })
  }
  const r = await s.api('POST', '/account/start', { origin: null, headers: APP, body: { member: m.hex, username: 'ana', appProof: good } })
  t.is(r.status, 200)
  t.alike(Object.keys(r.body), ['nonce'])
  t.ok(TOKEN_RE.test(r.body.nonce))
  t.is(r.headers.get('set-cookie'), null, 'no cookie for an app row')

  const reused = await s.api('POST', '/account/start', { origin: null, headers: APP, body: { member: member().hex, username: 'bia', appProof: good } })
  t.is(reused.status, 400, 'a live appProof is not taken by a start without its V')
})

test('app flow: start, phone check and finish with V alone; no cookie; nothing secret logged', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await appStart(s, m, 'ana')
  t.is(a.started.status, 200, a.started.text)
  t.is(a.started.headers.get('set-cookie'), null)

  const early = await appFinish(s, m, a.secret, a.nonce, 'ana')
  t.alike([early.status, early.body], [403, { error: 'telefone-pendente' }], 'no link before the phone check')
  const checked = await verifyPhone(s, m, { origin: null, headers: APP })
  t.is(checked.status, 200, 'the phone steps over the app header: ' + checked.text)

  const finish = await appFinish(s, m, a.secret, a.nonce, 'ana')
  t.is(finish.status, 200, finish.text)
  t.alike(certForKey(finish.body.cert, m.hex, s.iss.association), { ok: true })
  t.is(finish.headers.get('set-cookie'), null, 'no cookie to clear for an app row')
  t.is((await s.api('GET', '/account/status?member=' + m.hex)).body.linked, true)
  t.is(s.server.appStats().rows, 0, 'the app entry goes with the row')

  const replay = await appFinish(s, m, a.secret, a.nonce, 'ana')
  t.is(replay.status, 404, 'the row is spent')

  const all = s.logs.join('\n')
  for (const [label, secret] of [['V', a.secret.v], ['appProof', a.secret.proof], ['nonce', a.nonce]]) {
    t.absent(all.includes(secret), 'no ' + label + ' in the logs')
  }
  noOutbound(t, s, 'app flow')
})

test('app flow: linkByPhone with app true links over the V header path', async (t) => {
  const s = await setup(t)
  const m = member()
  const done = await link(s, m, 'ana', { app: true })
  t.is(done.finish.status, 200)
  t.alike(certForKey(done.finish.body.cert, m.hex, s.iss.association), { ok: true })
  t.is(done.finish.body.usernameRecord.username, 'ana')
  t.is((await s.api('GET', '/account/status?member=' + m.hex)).body.linked, true)
  t.is(s.server.appStats().rows, 0)
})

test('app flow: without its V nothing finishes an app row; nothing is linked', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await appStart(s, m, 'ana')
  t.is((await verifyPhone(s, m)).status, 200)

  const noV = await appFinish(s, m, null, a.nonce, 'ana')
  t.alike([noV.status, noV.body], [404, { error: 'expirado' }], 'no V')
  const wrongV = await appFinish(s, m, appSecret(), a.nonce, 'ana')
  t.alike([wrongV.status, wrongV.body], [404, { error: 'expirado' }], 'another V')
  const badV = await s.api('POST', '/account/finish', { origin: null, headers: { ...APP, 'x-varanda-link': 'not-a-secret' }, body: { signature: finishSig(s, m, a.nonce, 'ana') } })
  t.alike([badV.status, badV.body], [404, { error: 'expirado' }], 'a V of the wrong shape')
  const proofAsV = await s.api('POST', '/account/finish', { origin: null, headers: { ...APP, 'x-varanda-link': a.secret.proof }, body: { signature: finishSig(s, m, a.nonce, 'ana') } })
  t.alike([proofAsV.status, proofAsV.body], [404, { error: 'expirado' }], 'the appProof is not V')
  t.is((await s.api('GET', '/account/status?member=' + m.hex)).body.linked, false, 'nothing linked')
  t.is(s.server.appStats().rows, 1, 'the row waits for its V')
})

test('app flow: a wrong V fails; the right V still works', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await appStart(s, m, 'ana')
  t.is((await verifyPhone(s, m)).status, 200)
  const wrongV = await appFinish(s, m, appSecret(), a.nonce, 'ana')
  t.is(wrongV.status, 404)
  const ok = await appFinish(s, m, a.secret, a.nonce, 'ana')
  t.is(ok.status, 200, ok.text)
})

test('app flow: a refused finish keeps the row for V; the successful one spends it', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await appStart(s, m, 'ana')
  t.is((await verifyPhone(s, m)).status, 200)
  const bad = await appApi(s, 'POST', '/account/finish', { secret: a.secret, body: { signature: finishSig(s, member(), a.nonce, 'ana') } })
  t.is(bad.status, 400, 'a bad signature')
  const good = await appFinish(s, m, a.secret, a.nonce, 'ana')
  t.is(good.status, 200, good.text)
  const again = await appFinish(s, m, a.secret, a.nonce, 'ana')
  t.is(again.status, 404, 'spent by the successful finish')
  t.alike(again.body, { error: 'expirado' })
})

test('app flow: the row expires with the pending TTL; V then finishes nothing', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await appStart(s, m, 'ana')
  t.is((await verifyPhone(s, m)).status, 200)
  s.c.offset += PENDING_TTL_MS
  const finish = await appFinish(s, m, a.secret, a.nonce, 'ana')
  t.alike([finish.status, finish.body], [404, { error: 'expirado' }])
  t.is((await s.api('GET', '/account/status?member=' + m.hex)).body.linked, false, 'nothing linked')
})

test('app flow: the retired callback never returns to the app return and never mints a code', async (t) => {
  const s = await setup(t)
  const a = await appStart(s, member(), 'ana')
  t.is(a.started.status, 200)
  for (const query of ['?state=' + 'A'.repeat(43) + '&code=codigo-1', '?state=' + 'A'.repeat(43) + '&error=access_denied', '']) {
    const cb = await s.api('GET', '/account/callback' + query)
    t.is(cb.headers.get('location'), s.origin + '/?conta=erro', 'the web answer: ' + query)
    t.absent(cb.headers.get('location').includes('codigo'), 'no code')
    t.is(cb.headers.get('set-cookie'), null)
  }
  t.is(s.server.appStats().rows, 1, 'the app row is untouched')
  noOutbound(t, s, 'app callback')
})

test('app restart with the same V: the old row is gone and the new one finishes', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await appStart(s, m, 'ana')
  t.is(a.started.status, 200, a.started.text)
  const b = await appStart(s, m, 'ana', { secret: a.secret, link: a.secret })
  t.is(b.started.status, 200, 'the holder of V starts over with the same appProof: ' + b.started.text)
  t.not(b.nonce, a.nonce)
  t.is(s.server.appStats().rows, 1, 'one live app row')

  t.is((await verifyPhone(s, m)).status, 200)
  const old = await appFinish(s, m, a.secret, a.nonce, 'ana')
  t.alike([old.status, old.body], [400, { error: 'assinatura-invalida' }], 'V now names the new row: the old nonce does not sign it')
  const finish = await appFinish(s, m, a.secret, b.nonce, 'ana')
  t.is(finish.status, 200, finish.text)
})

test('app restart on an invite-only server: V is the bearer proof of the old row', async (t) => {
  const holder = {}
  const invites = openInvitesStore(tmpDir(t), { perWeek: 2, isUsed: (id) => holder.store.inviteUsed(id) })
  const s = await setup(t, { serverOpts: { invites } })
  holder.store = s.store
  const { code } = await invites.issue(member().hex)
  const m = member()
  const a = await appStart(s, m, 'ana', { invite: code })
  t.is(a.started.status, 200, a.started.text)

  const wrongV = await s.api('POST', '/account/start', { origin: null, headers: { ...APP, 'x-varanda-link': appSecret().v }, body: { member: m.hex, username: 'ana', invite: code, appProof: a.secret.proof } })
  t.alike([wrongV.status, wrongV.body], [400, { error: 'pedido-invalido' }], 'a live appProof is not taken by a start without its V')

  const fresh = appSecret()
  const restart = await s.api('POST', '/account/start', { origin: null, headers: { ...APP, 'x-varanda-link': a.secret.v }, body: { member: m.hex, username: 'ana', invite: code, appProof: fresh.proof } })
  t.is(restart.status, 200, 'the holder of V starts over: ' + restart.text)
  t.is((await verifyPhone(s, m)).status, 200)
  const gone = await appFinish(s, m, a.secret, a.nonce, 'ana')
  t.alike([gone.status, gone.body], [404, { error: 'expirado' }], 'the old row is gone with its V')
  const finish = await appFinish(s, m, fresh, restart.body.nonce, 'ana')
  t.is(finish.status, 200, finish.text)
  t.ok(s.store.inviteUsed(inviteId(code)), 'the invite is spent by the link')
})

test('app rows: a row evicted by a start flood finishes nothing and its entry goes', async (t) => {
  const s = await setup(t, { storeOpts: { maxPending: 1 } })
  const m = member()
  const a = await appStart(s, m, 'ana')
  t.is(a.started.status, 200, a.started.text)
  t.is((await verifyPhone(s, m)).status, 200)
  s.store.start({ member: member().hex, username: 'bia' })
  const finish = await appFinish(s, m, a.secret, a.nonce, 'ana')
  t.alike([finish.status, finish.body], [404, { error: 'expirado' }])
  t.is(s.server.appStats().rows, 0, 'the entry is gone')
})

test('app rows: an expired row is dropped on the next request of any kind', async (t) => {
  const s = await setup(t)
  const a = await appStart(s, member(), 'ana')
  t.is(a.started.status, 200)
  t.alike(s.server.appStats(), { rows: 1 }, 'held while the row lives')
  s.c.offset += PENDING_TTL_MS + 1000
  t.is((await s.api('GET', '/account/username/zoe')).status, 404, 'an unrelated public read')
  t.alike(s.server.appStats(), { rows: 0 }, 'dropped without a later app start')
})
