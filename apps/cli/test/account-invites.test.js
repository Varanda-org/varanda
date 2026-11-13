'use strict'

// apps/cli/lib/account/server.js with sign-up invites
// (apps/cli/lib/account/invites-store.js, @varanda/core/lib/invite): the
// invite gate at start, the in-memory reservation, phone verification,
// strict single use at finish, the policy read and the issue routes.
// Loopback only: fake providers, random key pairs, a temporary data dir.

const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { signPhone } = require('@varanda/core/lib/phone')
const { signInvite } = require('@varanda/core/lib/invite')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { createGoogle } = require('../lib/account/google')
const { openAccountStore, phoneSub } = require('../lib/account/store')
const { openInvitesStore, inviteId, CODE_RE, FILE } = require('../lib/account/invites-store')
const { openInviteDrops, KEY_FILE: DROPS_KEY_FILE } = require('../lib/account/invite-drops')
const { openPushStore } = require('../lib/account/push-store')
const { generateVapidKeys } = require('../lib/account/web-push')
const { createAccountServer, COOKIE } = require('../lib/account/server')
const { tmpDir } = require('./helpers/net')
const { linkByPhone, phoneServerOptions } = require('./helpers/phone-link')
const { freePort } = require('./helpers/free-port')
const { STUB_CODE } = require('../scripts/phone-stub')

const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-de-teste'
const EMAIL = 'membro@example.test'
const ACCESS = 'ya29.access-token-de-teste'
const DAY_MS = 86400000

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

// Fake provider on 127.0.0.1; `account.sub` is what the next exchange answers.
async function fakeGoogle (t) {
  const seen = []
  const account = { sub: '1000000000000000000001', email: EMAIL }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname
      seen.push({ method: req.method, path: pathname })
      if (pathname === '/token') return json(res, 200, { access_token: ACCESS, token_type: 'Bearer', expires_in: 3599, id_token: idToken(account.sub) })
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
  const tokenCalls = () => seen.filter((r) => r.path === '/token').length
  return { account, endpoints, fetch, tokenCalls, requestCalls: () => seen.length }
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association }
}

function member () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

function clock () {
  const c = { offset: 0, frozen: null, now: () => (c.frozen ?? Date.now()) + c.offset }
  return c
}

let subSeq = 100
function nextSub () {
  return '20000000000000000' + String(subSeq++).padStart(5, '0')
}

// Links `m` straight through the store (no invite), for inviters.
async function linkDirect (s, m, username) {
  const row = s.store.start({ member: m.hex, username })
  s.store.reserve(row.id)
  s.store.putGoogle(row.id, { sub: nextSub(), email: EMAIL })
  await s.store.finish(row.id, { signature: 'a'.repeat(128) }, s.iss.keyPair, s.iss.cert, s.iss.association)
  // Existing inviters also need a verified phone to issue invitations.
  if (!s.phones.verified(m.hex)) {
    const phone = '+55119' + String(s.phoneNumbers.length + 1).padStart(8, '0')
    s.phoneNumbers.push(phone)
    await s.phones.record({ member: m.hex, phone }, { linked: (key) => s.store.status(key).linked, burnable: () => false, deleted: () => false })
  }
}

// `inviting: false` passes invites = null. `badSidecar` plants an invalid
// invites.json before the sidecar opens. `wrap` may replace sidecar methods.
// `frozen` fixes the clock before anything opens; `invitesOpts({ dir, c,
// store })` adds options to the invites store (the drops' `opened`) and
// `serverOpts` to the server.
async function setup (t, { inviting = true, badSidecar = false, storeOpts = {}, wrap = (x) => x, frozen = null, invitesOpts = () => ({}), serverOpts = {} } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  c.frozen = frozen
  const iss = issuer()
  const fake = await fakeGoogle(t)
  const google = createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/callback', endpoints: fake.endpoints, fetch: fake.fetch })
  const store = openAccountStore(dir, { now: c.now, ...storeOpts })
  if (badSidecar) fs.writeFileSync(path.join(dir, FILE), '{"v":1,"invites":"nope"}\n', { mode: 0o600 })
  const invites = inviting ? openInvitesStore(dir, { now: c.now, perWeek: 2, isUsed: (id) => store.inviteUsed(id), ...invitesOpts({ dir, c, store }) }) : null
  const logs = []
  const texts = []
  const phoneOptions = phoneServerOptions()
  const phoneNumbers = []
  const phoneClient = {
    ...phoneOptions.phoneClient,
    send: (args) => {
      phoneNumbers.push(args.phone)
      return phoneOptions.phoneClient.send(args)
    }
  }
  const port = await freePort()
  const origin = 'http://127.0.0.1:' + port
  const server = createAccountServer({
    association: iss.association,
    origin,
    phones: phoneOptions.phones,
    phoneClient,
    google,
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    invites: invites === null ? null : wrap(invites),
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now,
    ...serverOpts
  })
  const listener = await server.listen({ host: '127.0.0.1', port })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function api (method, pathname, { body, cookie } = {}) {
    const init = { method, redirect: 'manual', headers: {} }
    if (cookie) init.headers.cookie = COOKIE + '=' + cookie
    if (body !== undefined) {
      init.headers.origin = origin
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    texts.push(text, res.headers.get('location') || '', res.headers.get('set-cookie') || '')
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, body: parsed, text }
  }

  return { dir, c, iss, fake, store, invites, server, logs, texts, api, origin, phones: phoneOptions.phones, phoneNumbers }
}

function cookieOf (res) {
  const m = /^__Host-varanda-link=([A-Za-z0-9_-]+); Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=(\d+)$/.exec(res.headers.get('set-cookie') || '')
  return m ? { id: m[1], maxAge: Number(m[2]) } : null
}

function sign (s, m, phase, nonce, username, sub = '') {
  return signAccountLink({ phase, nonce, member: m.hex, username, association: s.iss.association, sub }, m.kp)
}

// The invite issue routes for `who`; `signer` signs instead of `who`.
async function issue (s, who, signer = who) {
  const started = await s.api('POST', '/account/invites/start', { body: { member: who.hex } })
  if (started.status !== 200) return started
  const nonce = started.body.nonce
  const signature = signInvite({ action: 'issue', nonce, member: who.hex, association: s.iss.association }, signer.kp)
  const res = await s.api('POST', '/account/invites/finish', { body: { member: who.hex, nonce, signature } })
  res.nonce = nonce
  res.signature = signature
  return res
}

function startWith (s, m, username, invite) {
  const body = { member: m.hex, username }
  if (invite !== undefined) body.invite = invite
  return s.api('POST', '/account/start', { body })
}

async function begin (s, m, username, invite) {
  const started = await startWith(s, m, username, invite)
  if (started.status !== 200) return { started }
  const cookie = cookieOf(started).id
  return { started, cookie }
}

async function phoneStep (s, m, action, extra = {}) {
  const started = await s.api('POST', '/account/phone/start', { body: { member: m.hex } })
  if (started.status !== 200) return started
  const nonce = started.body.nonce
  const signature = signPhone({ action, nonce, member: m.hex, association: s.iss.association }, m.kp)
  return s.api('POST', '/account/phone/' + action, { body: { member: m.hex, nonce, signature, ...extra } })
}

async function verifyPhone (s, m) {
  if (s.phones.verified(m.hex)) return phoneStep(s, m, 'status')
  const phone = '+55119' + String(s.phoneNumbers.length + 1).padStart(8, '0')
  const sent = await phoneStep(s, m, 'send', { phone })
  if (sent.status !== 200) return sent
  return phoneStep(s, m, 'check', { code: STUB_CODE })
}

function finishBody (s, m, username, a) {
  return { signature: sign(s, m, 'finish', a.started.body.nonce, username, phoneSub(m.hex)) }
}

function finish (s, m, username, a) {
  return s.api('POST', '/account/finish', { cookie: a.cookie, body: finishBody(s, m, username, a) })
}

async function linkWith (s, m, username, code) {
  const done = await linkByPhone({
    origin: s.origin,
    member: m.hex,
    username,
    invite: code,
    sign: (fields) => {
      const statement = { ...fields, association: s.iss.association }
      return fields.action ? signPhone(statement, m.kp) : signAccountLink(statement, m.kp)
    },
    onResponse: (r) => {
      if (typeof r.request.phone === 'string') s.phoneNumbers.push(r.request.phone)
      s.texts.push(r.text, r.headers.get('location') || '', r.headers.get('set-cookie') || '')
    }
  })
  s.texts.push(JSON.stringify(done))
  return done
}

// No response body, redirect, cookie or log line carries the code or its id.
function noLeak (t, s, code) {
  const all = s.texts.join('\n') + '\n' + s.logs.join('\n')
  const responsesOnly = s.texts.filter((x) => !x.includes('"code"')).join('\n') + '\n' + s.logs.join('\n')
  t.absent(responsesOnly.includes(code), 'the code is only in its issue response')
  t.absent(all.includes(inviteId(code)), 'the invite id is never in a response or log line')
  t.absent(s.logs.join('\n').includes(code), 'no log line carries the code')
  t.absent(s.phoneNumbers.some((phone) => all.includes(phone) || all.includes(phone.slice(3))), 'no phone number in responses or logs')
}

test('invites off: open sign-up as today, no invite routes', async (t) => {
  const s = await setup(t, { inviting: false })
  const m = member()
  const started = await startWith(s, m, 'ana')
  t.is(started.status, 200, started.text)
  t.is(s.store.get(cookieOf(started).id).invite, null, 'no invite on the row')
  const ignored = await startWith(s, member(), 'bia', 'x'.repeat(43))
  t.is(ignored.status, 200, 'body.invite is ignored')
  t.is(s.store.get(cookieOf(ignored).id).invite, null)

  const policy = await s.api('GET', '/account/invites/policy')
  t.is(policy.status, 200)
  t.alike(policy.body, { required: false })

  const st = await s.api('POST', '/account/invites/start', { body: { member: m.hex } })
  t.is(st.status, 404)
  t.alike(st.body, { error: 'nao-encontrado' })
  const fin = await s.api('POST', '/account/invites/finish', { body: { member: m.hex, nonce: 'n', signature: 's' } })
  t.is(fin.status, 404)
  t.alike(fin.body, { error: 'nao-encontrado' })

  await linkDirect(s, m, 'carla')
  const status = await s.api('GET', '/account/status?member=' + m.hex)
  t.absent('invites' in status.body, 'status unchanged')
})

test('invites on: policy, start needs a usable code', async (t) => {
  const s = await setup(t)
  const policy = await s.api('GET', '/account/invites/policy')
  t.is(policy.status, 200)
  t.alike(policy.body, { required: true, perWeek: 2 })

  const m = member()
  const none = await startWith(s, m, 'ana')
  t.is(none.status, 403)
  t.alike(none.body, { error: 'convite-obrigatorio' })
  t.is(cookieOf(none), null, 'no pending row')

  const notString = await startWith(s, m, 'ana', 42)
  t.is(notString.status, 403)

  const bad = await startWith(s, m, 'ana', 'curto')
  t.is(bad.status, 404)
  t.alike(bad.body, { error: 'convite-invalido' })
  t.is(cookieOf(bad), null)

  const unknown = await startWith(s, m, 'ana', 'A'.repeat(43))
  t.is(unknown.status, 404)
  t.alike(unknown.body, { error: 'convite-invalido' })
  t.is(cookieOf(unknown), null)
  t.is(s.fake.tokenCalls(), 0)
})

test('issue: linked members only, two per Brasília week, signed and single-use nonces', async (t) => {
  const s = await setup(t)
  s.c.frozen = Date.parse('2026-11-04T15:00:00.000Z')
  const inviter = member()
  await linkDirect(s, inviter, 'ana')

  const first = await issue(s, inviter)
  t.is(first.status, 200, first.text)
  t.alike(Object.keys(first.body).sort(), ['code', 'expiresAt', 'remaining', 'resetsAt', 'used'])
  t.ok(CODE_RE.test(first.body.code) && first.body.code.length === 43, '43-char code')
  t.is(first.body.used, 1)
  t.is(first.body.remaining, 1)
  t.is(first.body.resetsAt, '2026-11-09T03:00:00.000Z')
  t.is(first.body.expiresAt, new Date(s.c.frozen + 7 * DAY_MS).toISOString())
  t.absent(first.text.includes(first.signature), 'the signature is never echoed')

  const second = await issue(s, inviter)
  t.is(second.status, 200)
  t.is(second.body.remaining, 0)
  const third = await issue(s, inviter)
  t.is(third.status, 429)
  t.alike(third.body, { error: 'limite-convites' })
  t.is(s.invites.count().total, 2, 'nothing created past the limit')

  s.c.frozen = Date.parse('2026-11-09T02:59:00.000Z')
  t.is((await issue(s, inviter)).status, 429, 'still Sunday in Brasília')
  s.c.frozen = Date.parse('2026-11-09T03:00:00.000Z')
  const monday = await issue(s, inviter)
  t.is(monday.status, 200, 'Monday 00:00 Brasília restores the allowance')
  t.is(monday.body.used, 1)

  const stranger = member()
  const unlinked = await s.api('POST', '/account/invites/start', { body: { member: stranger.hex } })
  t.is(unlinked.status, 403)
  t.alike(unlinked.body, { error: 'nao-vinculado' })

  const wrong = await issue(s, inviter, stranger)
  t.is(wrong.status, 400)
  t.alike(wrong.body, { error: 'assinatura-invalida' })

  const ok = await issue(s, inviter)
  t.is(ok.status, 200)
  const replay = await s.api('POST', '/account/invites/finish', { body: { member: inviter.hex, nonce: ok.nonce, signature: ok.signature } })
  t.is(replay.status, 404)
  t.alike(replay.body, { error: 'expirado' })
  t.is(s.invites.count().total, 4)
  for (const line of s.logs) t.absent(/[0-9a-f]{16}/.test(line), 'tokens only in logs')
})

test('happy path: the code is held at start, consumed by the first finish, refused afterwards', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const id = inviteId(code)

  const b = member()
  const a = await begin(s, b, 'bia', code)
  t.is(a.started.status, 200, a.started.text)
  t.absent(a.started.text.includes(code), 'start never echoes the code')

  const other = await startWith(s, member(), 'caio', code)
  t.is(other.status, 404, 'held by another key during phone verification')
  t.alike(other.body, { error: 'convite-invalido' })
  t.is(cookieOf(other), null)

  const checked = await verifyPhone(s, b)
  t.is(checked.status, 200)
  t.is(checked.body.state, 'verificado')
  t.is(s.fake.tokenCalls(), 0)
  t.absent(s.store.inviteUsed(id), 'phone verification alone does not spend the invite')
  t.is(s.invites.check(id), null, 'the sidecar stays unspent until the link commits')

  const done = await finish(s, b, 'bia', a)
  t.is(done.status, 200, done.text)
  t.ok(s.store.inviteUsed(id), 'the link records the invite')
  t.is(s.invites.check(id), 'convite-invalido', 'the sidecar is marked')
  t.ok(s.logs.some((l) => l === JSON.stringify({ event: 'convite', reason: 'usado' })))

  const inviterStatus = await s.api('GET', '/account/status?member=' + inviter.hex)
  t.is(inviterStatus.body.linked, true)
  t.absent('invites' in inviterStatus.body, 'status never carries invite counts')
  const own = await s.api('GET', '/account/status?member=' + b.hex)
  t.absent('invites' in own.body, 'status never carries invite counts')
  const inviterNext = await issue(s, inviter)
  t.is(inviterNext.body.used, 2, 'the used invite still counts for the inviter')
  t.is(inviterNext.body.remaining, 0)
  const ownFirst = await issue(s, b)
  t.is(ownFirst.status, 200, 'the invited member may invite too')
  t.is(ownFirst.body.used, 1)
  t.is(ownFirst.body.remaining, 1)

  const again = await startWith(s, member(), 'davi', code)
  t.is(again.status, 404, 'a used code is refused at start')
  t.is(cookieOf(again), null)
  noLeak(t, s, code)
})

test('a bare retry by the same member takes the code over', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const b = member()
  const one = await startWith(s, b, 'bia', code)
  t.is(one.status, 200)
  const two = await startWith(s, b, 'bia', code)
  t.is(two.status, 200, two.text)
  t.not(cookieOf(one).id, cookieOf(two).id)
  t.is(s.store.get(cookieOf(one).id), null, 'the old row is dropped')
  const stranger = await startWith(s, member(), 'caio', code)
  t.is(stranger.status, 404, 'still held for the new row')
  const done = await linkWith(s, b, 'bia', code)
  t.is(done.cert.member, b.hex, 'one more retry by the same member links')
  t.is((await s.api('GET', '/account/pending', { cookie: cookieOf(one).id })).status, 404, 'the first cookie names nothing')
  noLeak(t, s, code)
})

test('a code used during phone verification is refused at finish', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const b = member()
  const a = await begin(s, b, 'bia', code)
  t.is((await verifyPhone(s, b)).body.state, 'verificado')
  await s.invites.consume(inviteId(code))
  const done = await finish(s, b, 'bia', a)
  t.is(done.status, 404)
  t.alike(done.body, { error: 'convite-invalido' })
  t.is(cookieOf(done).maxAge, 0, 'the cookie is cleared')
  t.is(s.fake.tokenCalls(), 0, 'no token exchange')
  t.is(s.store.get(a.cookie), null, 'the row is dropped')
  t.ok(s.logs.includes(JSON.stringify({ event: 'convite', reason: 'convite-invalido' })))
  t.absent(done.text.includes(code))
  t.absent(s.store.status(b.hex).linked, 'no link was committed')
  noLeak(t, s, code)
})

test('a full cap refuses at phone finish without spending the invite', async (t) => {
  const s = await setup(t, { storeOpts: { maxMembers: 2 } })
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const b = member()
  const a = await begin(s, b, 'bia', code)
  t.is((await verifyPhone(s, b)).body.state, 'verificado')
  await linkDirect(s, member(), 'xavier')
  const done = await finish(s, b, 'bia', a)
  t.is(done.status, 503)
  t.alike(done.body, { error: 'lista-de-espera' })
  t.is(s.fake.tokenCalls(), 0)
  t.is(s.invites.check(inviteId(code)), null, 'the code stays usable')
  t.absent(s.store.inviteUsed(inviteId(code)))
  noLeak(t, s, code)
})

test('a retired Google callback never exchanges a code or spends the invite', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const c = member()
  const a = await begin(s, c, 'bia', code)
  for (const query of ['code=codigo-1', 'error=access_denied']) {
    const cb = await s.api('GET', '/account/callback?state=antigo&' + query, { cookie: a.cookie })
    t.is(cb.status, 302)
    t.is(cb.headers.get('location'), s.origin + '/?conta=erro')
    t.is(s.fake.tokenCalls(), 0)
    t.is(s.fake.requestCalls(), 0, 'no outbound request')
  }
  t.absent(s.store.inviteUsed(inviteId(code)))
  const other = await startWith(s, member(), 'dora', code)
  t.is(other.status, 404, 'the hold stays: another member is told convite-invalido')
  t.alike(other.body, { error: 'convite-invalido' })
  const later = await startWith(s, c, 'caio', code)
  t.is(later.status, 200, later.text)
  const done = await linkWith(s, c, 'caio', code)
  t.is(done.cert.member, c.hex, 'the later phone start links')
  noLeak(t, s, code)
})

// Pending rows created before retirement still exercise cookie ownership.
async function legacyRow (s, m, username, code, claimed) {
  const a = await begin(s, m, username, code)
  s.store.reserve(a.cookie)
  if (claimed) s.store.putGoogle(a.cookie, { sub: nextSub(), email: EMAIL })
  return a
}

test('a same-member retry that the store refuses keeps the previous row and reservation', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  await linkDirect(s, member(), 'xavier')
  const { code } = (await issue(s, inviter)).body
  const b = member()
  const first = await startWith(s, b, 'bia', code)
  t.is(first.status, 200)
  const retry = await startWith(s, b, 'xavier', code)
  t.is(retry.status, 409)
  t.alike(retry.body, { error: 'nome-em-uso' })
  t.ok(s.store.get(cookieOf(first).id) !== null, 'the bare row survives')
  t.is((await startWith(s, member(), 'caio', code)).status, 404, 'the code is still held')
  const a = { started: first, cookie: cookieOf(first).id }
  const checked = await verifyPhone(s, b)
  t.is(checked.status, 200)
  t.is(checked.body.state, 'verificado')
  const done = await finish(s, b, 'bia', a)
  t.is(done.status, 200, done.text)
  t.ok(s.store.inviteUsed(inviteId(code)))
  noLeak(t, s, code)
})

test('retired authorize refuses before proof checks and leaves the invite unspent', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const b = member()
  const a = await begin(s, b, 'bia', code)
  for (const signature of ['invalid', sign(s, b, 'reserve', a.started.body.nonce, 'bia')]) {
    const auth = await s.api('POST', '/account/authorize', { cookie: a.cookie, body: { signature } })
    t.is(auth.status, 410)
    t.alike(auth.body, { error: 'versao-antiga' })
    t.is(auth.headers.get('set-cookie'), null, 'no new row')
  }
  t.is(s.fake.tokenCalls(), 0)
  t.is(s.fake.requestCalls(), 0, 'no outbound request')
  t.is(s.store.get(a.cookie).phase, 'reserve', 'the original row is untouched')
  t.is(s.invites.check(inviteId(code)), null)
  t.is((await verifyPhone(s, b)).body.state, 'verificado')
  const done = await finish(s, b, 'bia', a)
  t.is(done.status, 200, done.text)
  noLeak(t, s, code)
})

test('an unsigned start cannot replace a legacy Google row and its finish is retired', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const b = member()
  const a = await legacyRow(s, b, 'bia', code, true)
  t.is((await verifyPhone(s, b)).body.state, 'verificado')
  const replay = await startWith(s, b, 'bia', code)
  t.is(replay.status, 404)
  t.alike(replay.body, { error: 'convite-invalido' })
  t.is(cookieOf(replay), null, 'no new row')
  const done = await finish(s, b, 'bia', a)
  t.is(done.status, 404, 'a legacy Google row cannot finish even with a verified phone')
  t.alike(done.body, { error: 'expirado' })
  t.absent(s.store.inviteUsed(inviteId(code)))
  noLeak(t, s, code)
})

test('overlapping finishes of one member with two codes mark only the recorded one', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const codeA = (await issue(s, inviter)).body.code
  const codeB = (await issue(s, inviter)).body.code
  const b = member()
  const one = await begin(s, b, 'bia', codeA)
  const two = await begin(s, b, 'bia', codeB)
  t.is(one.started.status, 200)
  t.is(two.started.status, 200)
  t.is((await verifyPhone(s, b)).body.state, 'verificado')
  const [bodyOne, bodyTwo] = [finishBody(s, b, 'bia', one), finishBody(s, b, 'bia', two)]
  const both = await Promise.all([
    s.api('POST', '/account/finish', { cookie: one.cookie, body: bodyOne }),
    s.api('POST', '/account/finish', { cookie: two.cookie, body: bodyTwo })
  ])
  t.alike(both.map((r) => r.status), [200, 200])
  const ids = [inviteId(codeA), inviteId(codeB)]
  t.is(ids.filter((id) => s.store.inviteUsed(id)).length, 1, 'one link records one invite')
  for (const id of ids) {
    t.is(s.invites.check(id) === null, !s.store.inviteUsed(id), 'the sidecar matches the directory')
  }
})

test('a finish refused with nome-em-uso drops the row and frees the code at once', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const id = inviteId(code)
  const b = member()
  const a = await begin(s, b, 'bia', code)
  await linkDirect(s, member(), 'bia')
  t.is((await verifyPhone(s, b)).body.state, 'verificado')
  const done = await finish(s, b, 'bia', a)
  t.is(done.status, 409)
  t.alike(done.body, { error: 'nome-em-uso' })
  t.is(cookieOf(done)?.maxAge, 0, 'the cookie is cleared')
  t.is(s.store.get(a.cookie), null, 'the row is dropped')
  t.is(s.invites.check(id), null, 'the sidecar is not marked')
  t.absent(s.store.inviteUsed(id), 'no link holds it')
  const retry = await finish(s, b, 'bia', a)
  t.is(retry.status, 404, 'the old cookie names nothing')
  t.alike(retry.body, { error: 'expirado' })
  const restarted = await begin(s, b, 'bia2', code)
  const second = await finish(s, b, 'bia2', restarted)
  t.is(second.status, 200, 'the same member restarts at once with the same code and another name')
  t.ok(s.store.inviteUsed(id))
  t.is(s.invites.check(id), 'convite-invalido', 'consumed only by the link')
  noLeak(t, s, code)
})

test('a finish refused with conta-vinculada drops the row and frees the code for another key', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const id = inviteId(code)
  const b = member()
  const a = await begin(s, b, 'bia', code)
  t.is((await verifyPhone(s, b)).body.state, 'verificado')
  await linkDirect(s, b, 'biaantes')
  const done = await finish(s, b, 'bia', a)
  t.is(done.status, 409)
  t.alike(done.body, { error: 'conta-vinculada' })
  t.is(cookieOf(done)?.maxAge, 0, 'the cookie is cleared')
  t.is(s.store.get(a.cookie), null, 'the row is dropped')
  t.is(s.invites.check(id), null, 'the sidecar is not marked')
  t.absent(s.store.inviteUsed(id))
  const c = member()
  const other = await linkWith(s, c, 'caio', code)
  t.is(other.cert.member, c.hex, 'another key links with the released code')
  t.ok(s.store.inviteUsed(id))
  noLeak(t, s, code)
})

test('two concurrent finishes: one links, the other answers expirado', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const b = member()
  const a = await begin(s, b, 'bia', code)
  t.is((await verifyPhone(s, b)).body.state, 'verificado')
  const body = finishBody(s, b, 'bia', a)
  const both = await Promise.all([
    s.api('POST', '/account/finish', { cookie: a.cookie, body }),
    s.api('POST', '/account/finish', { cookie: a.cookie, body })
  ])
  t.alike(both.map((r) => r.status).sort(), [200, 404])
  const refused = both.find((r) => r.status === 404)
  t.alike(refused.body, { error: 'expirado' })
  t.ok(s.store.inviteUsed(inviteId(code)))
})

test('a failed sidecar mark still answers the committed link; the directory heals it', async (t) => {
  const s = await setup(t, { wrap: (inv) => ({ ...inv, consume: async () => { throw new Error('disco cheio') } }) })
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  const { code } = (await issue(s, inviter)).body
  const b = member()
  const done = await linkWith(s, b, 'bia', code)
  t.is(done.cert.member, b.hex)
  t.ok(s.logs.includes(JSON.stringify({ event: 'convite', reason: 'marca-falhou' })))
  t.is(s.invites.check(inviteId(code)), 'convite-invalido', 'isUsed reports the link')
  const again = await startWith(s, member(), 'caio', code)
  t.is(again.status, 404)
  noLeak(t, s, code)
})

test('a link is valid for 7 days after creation, across the week end', async (t) => {
  const s = await setup(t)
  const inviter = member()
  await linkDirect(s, inviter, 'ana')
  // Sunday 23:00 in Brasília.
  const created = Date.parse('2026-11-09T02:00:00.000Z')
  s.c.frozen = created
  const { code } = (await issue(s, inviter)).body
  s.c.frozen = Date.parse('2026-11-11T15:00:00.000Z')
  const wed = await startWith(s, member(), 'bia', code)
  t.is(wed.status, 200, 'still valid on Wednesday')
  s.c.frozen = created + 7 * DAY_MS
  const late = await startWith(s, member(), 'caio', code)
  t.is(late.status, 404, 'refused at createdAt + 7 days')
  noLeak(t, s, code)
})

test('an unavailable sidecar fails closed for new keys only', async (t) => {
  const s = await setup(t, { badSidecar: true })
  t.absent(s.invites.available())
  const linkedOne = member()
  await linkDirect(s, linkedOne, 'ana')

  const started = await startWith(s, member(), 'bia', 'A'.repeat(43))
  t.is(started.status, 503)
  t.alike(started.body, { error: 'indisponivel' })
  t.is(cookieOf(started), null)

  const policy = await s.api('GET', '/account/invites/policy')
  t.alike(policy.body, { required: true, perWeek: 2 })

  const status = await s.api('GET', '/account/status?member=' + linkedOne.hex)
  t.is(status.status, 200)
  t.absent('invites' in status.body)

  const iss = await s.api('POST', '/account/invites/start', { body: { member: linkedOne.hex } })
  t.is(iss.status, 503)

  const again = await startWith(s, linkedOne, 'ana', 'A'.repeat(43))
  t.is(again.status, 409, 'a linked key never consults the sidecar')
  t.alike(again.body, { error: 'conta-vinculada' })
})

// Member keys are public: a status read must not reveal how many invites a
// member created this week (audit F1).
test('status never reveals invite counts, healthy or corrupt sidecar', async (t) => {
  for (const badSidecar of [false, true]) {
    const s = await setup(t, { badSidecar })
    const m = member()
    await linkDirect(s, m, 'ana')
    if (!badSidecar) t.is((await issue(s, m)).status, 200)
    const status = await s.api('GET', '/account/status?member=' + m.hex)
    t.is(status.status, 200)
    t.is(status.body.linked, true)
    t.absent('invites' in status.body, badSidecar ? 'corrupt invites.json' : 'healthy invites.json')
    t.absent(/remaining|perWeek|resetsAt|opened|used|mode|minute|secret/.test(status.text))
  }
})

// start with the link cookie of an earlier row (or none).
function startCookie (s, m, username, invite, cookie) {
  return s.api('POST', '/account/start', { cookie, body: { member: m.hex, username, invite } })
}

test('the browser holding a legacy row may restart with its cookie and link by phone', async (t) => {
  for (const claimed of [false, true]) {
    const s = await setup(t)
    const inviter = member()
    await linkDirect(s, inviter, 'ana')
    const { code } = (await issue(s, inviter)).body
    const b = member()
    const a = await legacyRow(s, b, 'bia', code, claimed)
    t.is(a.started.status, 200)
    t.is(s.store.get(a.cookie).phase, 'finish')
    const again = await startCookie(s, b, 'bia2', code, a.cookie)
    t.is(again.status, 200, (claimed ? 'Google-claimed' : 'post-authorize') + ' row taken over by its own cookie')
    if (again.status !== 200) continue
    t.ok(cookieOf(again) !== null && cookieOf(again).id !== a.cookie, 'a new cookie')
    t.is(s.store.get(a.cookie), null, 'the old row is dropped')
    t.is((await startWith(s, member(), 'caio', code)).status, 404, 'the code moved to the new row')
    const b2 = { started: again, cookie: cookieOf(again).id }
    const checked = await verifyPhone(s, b)
    t.is(checked.status, 200)
    t.is(checked.body.state, 'verificado')
    const done = await finish(s, b, 'bia2', b2)
    t.is(done.status, 200, 'the new row links')
    t.ok(s.store.inviteUsed(inviteId(code)))
    noLeak(t, s, code)
  }
})

test('without its cookie, or with another row\'s cookie, a legacy row is never replaced', async (t) => {
  for (const claimed of [false, true]) {
    const s = await setup(t)
    const inviter = member()
    await linkDirect(s, inviter, 'ana')
    const { code } = (await issue(s, inviter)).body
    const b = member()
    const a = await legacyRow(s, b, 'bia', code, claimed)
    t.is(s.store.get(a.cookie).phase, 'finish')
    const bare = await startWith(s, b, 'bia', code)
    t.is(bare.status, 404, 'no cookie: refused')
    t.alike(bare.body, { error: 'convite-invalido' })
    // A live row of the same member with another code: its cookie names
    // that row, not the one holding `code`.
    const otherRow = await startWith(s, b, 'bia3', (await issue(s, inviter)).body.code)
    t.is(otherRow.status, 200)
    const foreign = await startCookie(s, b, 'bia', code, cookieOf(otherRow).id)
    t.is(foreign.status, 404, 'another row\'s cookie grants nothing')
    t.alike(foreign.body, { error: 'convite-invalido' })
    t.ok(s.store.get(a.cookie) !== null, 'the original row survives')
    const done = await finish(s, b, 'bia', a)
    t.is(done.status, 404, 'the legacy finish is retired')
    t.alike(done.body, { error: 'expirado' })
    t.absent(s.store.inviteUsed(inviteId(code)))
    noLeak(t, s, code)
  }
})

// The signed weekly allowance read: a nonce from invites/start, signed for
// 'summary' (or `action`) by `signer`.
async function summary (s, who, { action = 'summary', signer = who } = {}) {
  const started = await s.api('POST', '/account/invites/start', { body: { member: who.hex } })
  if (started.status !== 200) return started
  const nonce = started.body.nonce
  const signature = signInvite({ action, nonce, member: who.hex, association: s.iss.association }, signer.kp)
  const res = await s.api('POST', '/account/invites/summary', { body: { member: who.hex, nonce, signature } })
  res.nonce = nonce
  res.signature = signature
  return res
}

// Monday 00:00 in Brasília.
const MONDAY = Date.parse('2026-11-09T03:00:00.000Z')
const WEEK_MS = 7 * DAY_MS

// The real drops sidecar behind the store's `opened`, as serve() wires it.
function withDrops (holder) {
  return ({ dir, c, store }) => {
    holder.drops = openInviteDrops(dir, { perWeek: 2, now: c.now })
    return { opened: (m, nowMs) => holder.drops.opened(m, store.linkedAt(m), nowMs) }
  }
}

test('summary: semanal mode opens the whole week, follows issue, policy unchanged', async (t) => {
  const s = await setup(t)
  const m = member()
  await linkDirect(s, m, 'ana')
  t.alike((await s.api('GET', '/account/invites/policy')).body, { required: true, perWeek: 2 }, 'policy body unchanged')

  const first = await summary(s, m)
  t.is(first.status, 200, first.text)
  t.alike(Object.keys(first.body).sort(), ['mode', 'opened', 'perWeek', 'remaining', 'resetsAt', 'used'])
  t.is(first.body.mode, 'semanal')
  t.is(first.body.perWeek, 2)
  t.is(first.body.opened, 2, 'opened === perWeek')
  t.is(first.body.used, 0)
  t.is(first.body.remaining, 2)
  t.ok(typeof first.body.resetsAt === 'string')

  t.is((await issue(s, m)).status, 200)
  const after = await summary(s, m)
  t.is(after.body.used, 1)
  t.is(after.body.remaining, 1)
})

test('summary: nonce reuse, an issue signature, an unlinked member and open sign-up are refused', async (t) => {
  const s = await setup(t)
  const m = member()
  await linkDirect(s, m, 'ana')
  const ok = await summary(s, m)
  t.is(ok.status, 200)
  const reused = await s.api('POST', '/account/invites/summary', { body: { member: m.hex, nonce: ok.nonce, signature: ok.signature } })
  t.is(reused.status, 404)
  t.alike(reused.body, { error: 'expirado' })

  const wrong = await summary(s, m, { action: 'issue' })
  t.is(wrong.status, 400)
  t.alike(wrong.body, { error: 'assinatura-invalida' })
  const spent = await s.api('POST', '/account/invites/summary', { body: { member: m.hex, nonce: wrong.nonce, signature: signInvite({ action: 'summary', nonce: wrong.nonce, member: m.hex, association: s.iss.association }, m.kp) } })
  t.alike(spent.body, { error: 'expirado' }, 'the nonce was spent before the signature check')

  const other = member()
  const stranger = await summary(s, other, { signer: m })
  t.is(stranger.status, 403)
  t.alike(stranger.body, { error: 'nao-vinculado' })

  const open = await setup(t, { inviting: false })
  const none = await open.api('POST', '/account/invites/summary', { body: { member: m.hex, nonce: 'A'.repeat(43), signature: 'a'.repeat(128) } })
  t.is(none.status, 404)
})

test('sorteio: issue waits for the drawn minute, then opens one code; Monday clears an unused grant', async (t) => {
  const holder = {}
  const s = await setup(t, { frozen: MONDAY, invitesOpts: withDrops(holder), serverOpts: { invitesMode: 'sorteio' } })
  const m = member()
  await linkDirect(s, m, 'ana')
  t.alike((await s.api('GET', '/account/invites/policy')).body, { required: true, perWeek: 2 }, 'policy body unchanged')
  // minutes() is in slot order, not chronological: sort a copy.
  const mins = [...holder.drops.minutes(m.hex, s.store.linkedAt(m.hex), MONDAY)].sort((a, b) => a - b)
  t.is(mins.length, 2)
  t.ok(mins[0] > MONDAY && mins[1] > mins[0], 'two distinct minutes in the week')

  s.c.frozen = mins[0] - 60000
  const early = await issue(s, m)
  t.is(early.status, 429)
  t.alike(early.body, { error: 'convite-aguardando' })
  t.absent(fs.existsSync(path.join(s.dir, FILE)) && JSON.parse(fs.readFileSync(path.join(s.dir, FILE), 'utf8')).invites.length > 0, 'nothing minted')
  const waiting = await summary(s, m)
  t.alike({ ...waiting.body, resetsAt: null }, { mode: 'sorteio', perWeek: 2, opened: 0, used: 0, remaining: 0, resetsAt: null })

  s.c.frozen = mins[0]
  const one = await issue(s, m)
  t.is(one.status, 200, one.text)
  t.ok(CODE_RE.test(one.body.code))
  const again = await issue(s, m)
  t.alike(again.body, { error: 'convite-aguardando' }, 'only one code before the second minute')
  const used = await summary(s, m)
  t.is(used.body.opened, 1)
  t.is(used.body.used, 1)
  t.is(used.body.remaining, 0, 'remaining 0 while perWeek is 2')

  s.c.frozen = mins[1]
  t.is((await summary(s, m)).body.remaining, 1, 'the second grant opened, unused')
  s.c.frozen = MONDAY + WEEK_MS
  const next = await summary(s, m)
  t.alike({ ...next.body, resetsAt: null }, { mode: 'sorteio', perWeek: 2, opened: 0, used: 0, remaining: 0, resetsAt: null }, 'the unused grant does not carry over')

  const secret = JSON.parse(fs.readFileSync(path.join(s.dir, DROPS_KEY_FILE), 'utf8')).secret
  const logs = s.logs.join('\n')
  t.absent(logs.includes(secret), 'no log line carries the secret')
  t.absent(logs.includes(m.hex), 'no log line carries the member')
  for (const ms of mins) {
    t.absent(logs.includes(String(ms)) || logs.includes(new Date(ms).toISOString()), 'no log line carries a minute')
  }
})

test('sorteio: a member whose opened is 0 all week cannot issue', async (t) => {
  const s = await setup(t, { frozen: MONDAY, invitesOpts: () => ({ opened: () => 0 }), serverOpts: { invitesMode: 'sorteio' } })
  const m = member()
  await linkDirect(s, m, 'ana')
  for (const at of [MONDAY, MONDAY + 3 * DAY_MS + 15 * 3600000, MONDAY + WEEK_MS - 60000]) {
    s.c.frozen = at
    const r = await issue(s, m)
    t.is(r.status, 429)
    t.alike(r.body, { error: 'convite-aguardando' })
  }
  const sum = await summary(s, m)
  t.is(sum.body.opened, 0)
  t.is(sum.body.remaining, 0)
})

test('sorteio: a bad drops key file makes issue and summary indisponivel and writes no invite', async (t) => {
  const holder = {}
  const open = withDrops(holder)
  const s = await setup(t, {
    frozen: MONDAY + DAY_MS,
    invitesOpts: (ctx) => {
      fs.writeFileSync(path.join(ctx.dir, DROPS_KEY_FILE), '{"v":1,"secret":"nope"}\n', { mode: 0o600 })
      return open(ctx)
    },
    serverOpts: { invitesMode: 'sorteio' }
  })
  t.absent(holder.drops.available())
  const m = member()
  await linkDirect(s, m, 'ana')
  const r = await issue(s, m)
  t.is(r.status, 503)
  t.alike(r.body, { error: 'indisponivel' })
  const sum = await summary(s, m)
  t.is(sum.status, 503)
  t.alike(sum.body, { error: 'indisponivel' })
  t.absent(fs.existsSync(path.join(s.dir, FILE)) && JSON.parse(fs.readFileSync(path.join(s.dir, FILE), 'utf8')).invites.length > 0, 'no invite row written')
})

test('notifyInvite: no push without the current terms; inviteRoom follows push', async (t) => {
  const plain = await setup(t)
  t.is(plain.server.notifyInvite({ member: member().hex, topic: 't'.repeat(32), deadline: Date.now() + 60000 }), 'none', 'push off')
  t.is(plain.server.inviteRoom(), 0, 'push off: no room')

  const dir = path.join(tmpDir(t), 'push')
  fs.mkdirSync(dir, { recursive: true })
  const pushStore = openPushStore(dir)
  const sent = []
  const accepted = member()
  const pending = member()
  const terms = {
    available: () => true,
    list: (m) => m === accepted.hex ? [{ version: TERMS_VERSION }] : [{ version: TERMS_VERSION - 1 }]
  }
  const s = await setup(t, {
    serverOpts: {
      terms,
      push: { pushStore, vapid: { ...generateVapidKeys(), subject: ORIGIN }, send: async (args) => { sent.push(args); return 'ok' }, relayTokenHash: null }
    }
  })
  t.ok(s.server.inviteRoom() > 0)
  for (const who of [accepted, pending]) {
    const ua = nodeCrypto.createECDH('prime256v1')
    ua.generateKeys()
    await pushStore.put({ member: who.hex, endpoint: 'https://fcm.googleapis.com/fcm/send/' + who.hex.slice(0, 16), p256dh: ua.getPublicKey().toString('base64url'), auth: nodeCrypto.randomBytes(16).toString('base64url') })
  }
  const deadline = Date.now() + 3600000
  t.is(s.server.notifyInvite({ member: pending.hex, topic: 'a'.repeat(32), deadline }), 'none', 'older terms: nothing sent')
  terms.available = () => false
  t.is(s.server.notifyInvite({ member: accepted.hex, topic: 'a'.repeat(32), deadline }), 'none', 'terms unavailable: nothing sent')
  terms.available = () => true
  t.is(s.server.notifyInvite({ member: accepted.hex, topic: 'a'.repeat(32), deadline }), 'queued')
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(sent.length, 1, 'only the member with the current terms got a push')
})

test('inviteConsent: true only with the current terms in an available store', async (t) => {
  const plain = await setup(t)
  t.is(plain.server.inviteConsent(member().hex), false, 'no terms store')

  const accepted = member()
  const older = member()
  const terms = {
    available: () => true,
    list: (m) => m === accepted.hex ? [{ version: TERMS_VERSION - 1 }, { version: TERMS_VERSION }] : m === older.hex ? [{ version: TERMS_VERSION - 1 }] : []
  }
  const s = await setup(t, { serverOpts: { terms } })
  t.is(s.server.inviteConsent(accepted.hex), true)
  t.is(s.server.inviteConsent(older.hex), false, 'an older version only')
  t.is(s.server.inviteConsent(member().hex), false, 'never accepted')
  terms.available = () => false
  t.is(s.server.inviteConsent(accepted.hex), false, 'store unavailable')
  terms.available = () => true
  terms.list = () => { throw new Error('boom') }
  t.is(s.server.inviteConsent(accepted.hex), false, 'a throwing store')
})
