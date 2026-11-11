'use strict'

// apps/cli/lib/account/phone-routes.js mounted by server.js: hosted
// verification of a Brazilian mobile with Didit (policy, since, start, send,
// check, status) and the gates that keep a key without a verified number
// from a Google sign-in, a certificate, a rename or an invite. Loopback only:
// the Didit fake of helpers/fake-didit.js, a real phone store and a real age
// store in a tmp dir, members linked in-process, and a Google stub whose
// exchange is never reached.

const test = require('brittle')
const nodeCrypto = require('node:crypto')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { signAge } = require('@varanda/core/lib/age')
const { signPhone } = require('@varanda/core/lib/phone')
const { verifyPhoneVerified, verifyPhoneSince } = require('@varanda/core/lib/phone-proof')
const { signInvite } = require('@varanda/core/lib/invite')
const { openAccountStore } = require('../lib/account/store')
const { openAgeStore } = require('../lib/account/age-store')
const { openPhoneStore } = require('../lib/account/phone-store')
const { openInvitesStore } = require('../lib/account/invites-store')
const { createPhoneClient } = require('../lib/account/phone-client')
const { createPhoneRoutes } = require('../lib/account/phone-routes')
const { openPasskeyStore } = require('../lib/account/passkey-store')
const { keyFromAttestation } = require('../lib/account/webauthn')
const { createFakePasskey } = require('./helpers/fake-passkey')
const { createAccountServer, COOKIE } = require('../lib/account/server')
const { startFakeDidit, loopbackFetch, PHONE_CODE } = require('./helpers/fake-didit')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const API_KEY = 'test-phone-key-123'
const EMAIL = 'membro@example.test'
const GOOGLE_URL = 'https://accounts.google.test/auth?state=x'
const DAY = 24 * 3600 * 1000
const WRONG_CODE = '654321'
const PHONE_A = '+5511987654321'
const PHONE_B = '+5521912345678'
const PHONE_C = '+5531998887777'
const PHONE_D = '+5541991112222'
const PHONE_E = '+5551993334444'
const PHONE_F = '+5561995556666'
const FIXTURES = [PHONE_A, PHONE_B, PHONE_C, PHONE_D, PHONE_E, PHONE_F]

function googleStub () {
  const g = { calls: 0 }
  g.authorizeUrl = () => {
    g.calls++
    return GOOGLE_URL
  }
  g.exchange = async () => { throw new Error('google called') }
  return g
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

let subSeq = 100
function nextSub () {
  return '40000000000000000' + String(subSeq++).padStart(5, '0')
}

async function linkDirect (store, iss, m, username) {
  const row = store.start({ member: m.hex, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: nextSub(), email: EMAIL })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

// `phone: false` leaves the client and the store null; `age: false` the
// age pair. `key` is the phone store key (32 bytes). `c.guardOk = false`
// makes every phone.json write fail. `c.blocked` is the published blocklist
// of the fake moderation desk: [{ member, reportIds }].
// `before(dir, iss)` runs before the stores open.
// `passkeys: true` opens a passkey store, so Excluir conta can run.
async function setup (t, { phone = true, age = true, inviting = false, maxMembers = null, dailyLimit, withIssuer = true, key, sendTimeoutMs, burst, before, passkeys = false } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const c = { offset: 0, guardOk: true, blocked: [] }
  c.now = () => Date.now() + c.offset
  const iss = issuer()
  const store = openAccountStore(dir, { now: c.now, maxMembers })
  const linked = member()
  await linkDirect(store, iss, linked, 'ana')
  if (before) await before(dir, iss)
  const fake = await startFakeDidit()
  t.teardown(() => fake.close(), { force: true })
  const phoneKey = key || nodeCrypto.randomBytes(32)
  const client = phone ? createPhoneClient({ apiKey: API_KEY, endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base), ...(sendTimeoutMs ? { timeoutMs: sendTimeoutMs } : {}) }) : null
  const phones = phone ? openPhoneStore(dir, { key: phoneKey, now: c.now, guard: () => c.guardOk }) : null
  const ages = age ? openAgeStore(dir, { now: c.now }) : null
  const invites = inviting ? openInvitesStore(dir, { now: c.now, perWeek: 5, isUsed: (id) => store.inviteUsed(id) }) : null
  const moderation = fakeModeration(c)
  const passkeyStore = passkeys ? openPasskeyStore(dir, { now: c.now }) : null
  const google = googleStub()
  const logs = []
  const answers = []
  const opts = {
    association: iss.association,
    origin: ORIGIN,
    google,
    store,
    issuer: withIssuer ? { keyPair: iss.keyPair, cert: iss.cert } : null,
    invites,
    moderation,
    passkeys: passkeyStore,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now
  }
  if (age) {
    // Never called by these tests: the bands are written straight to the store.
    opts.didit = { createSession: async () => ({ ok: false, reason: 'entrada' }), decision: async () => ({ ok: false }), deleteSession: async () => ({ ok: true }) }
    opts.ages = ages
  }
  if (phone) {
    opts.phoneClient = client
    opts.phones = phones
  }
  if (dailyLimit !== undefined) opts.phoneDailyLimit = dailyLimit
  if (burst !== undefined) {
    opts.burst = burst
    opts.ratePerSecond = burst
  }
  const server = createAccountServer(opts)
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function api (method, pathname, { body, cookie } = {}) {
    const init = { method, redirect: 'manual', headers: {} }
    if (cookie) init.headers.cookie = COOKIE + '=' + cookie
    if (body !== undefined) {
      init.headers.origin = ORIGIN
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    answers.push({ pathname, text, body: parsed })
    return { status: res.status, headers: res.headers, body: parsed, text }
  }
  const post = (pathname, body, extra = {}) => api('POST', pathname, { body, ...extra })

  const signFor = (who, action, nonce) => signPhone({ action, nonce, member: who.hex, association: iss.association }, who.kp)
  const start = (who) => post('/account/phone/start', { member: who.hex })

  async function step (who, action, extra = {}) {
    const started = await start(who)
    if (started.status !== 200) return started
    const nonce = started.body.nonce
    return post('/account/phone/' + action, { member: who.hex, nonce, signature: signFor(who, action, nonce), ...extra })
  }

  async function band (who) {
    await ages.record({ member: who.hex, band: '18+', method: 'didit', checkedAt: new Date(c.now()).toISOString() })
  }

  // Band (when age is on), send and the correct code.
  async function verify (who, number) {
    if (age && !ages.verified(who.hex)) await band(who)
    const sent = await step(who, 'send', { phone: number })
    if (sent.status !== 200 || sent.body.state !== 'enviado') return sent
    return step(who, 'check', { code: PHONE_CODE })
  }

  const sends = () => fake.seen.filter((r) => r.path === '/v3/phone/send/')
  const checks = () => fake.seen.filter((r) => r.path === '/v3/phone/check/')

  return { dir, c, iss, store, ages, phones, passkeyStore, phoneKey, invites, fake, google, linked, logs, answers, server, api, post, signFor, start, step, band, verify, sends, checks }
}

// The published blocklist is c.blocked; Excluir conta's own block request
// leaves it as it is (a pending change, not yet published).
function fakeModeration (c) {
  return {
    blocked: () => c.blocked.map((b) => ({ member: b.member, reportIds: [...b.reportIds], kind: 'conta' })),
    requestDeletion: async () => ({ change: null, kind: 'igual' })
  }
}

// A second service on the same stores runs the start sweep with the
// server's own callbacks; resolves once that sweep is done.
async function sweepVia (s, who) {
  createAccountServer({
    association: s.iss.association,
    origin: ORIGIN,
    google: googleStub(),
    store: s.store,
    moderation: fakeModeration(s.c),
    phoneClient: createPhoneClient({ apiKey: API_KEY, endpoints: { base: s.fake.base }, fetch: loopbackFetch(s.fake.base) }),
    phones: s.phones,
    now: s.c.now
  })
  await s.phones.settled(who.hex)
}

function sign (s, m, phase, nonce, username, sub = '') {
  return signAccountLink({ phase, nonce, member: m.hex, username, association: s.iss.association, sub }, m.kp)
}

function cookieOf (res) {
  const m = /^__Host-varanda-link=([A-Za-z0-9_-]+);/.exec(res.headers.get('set-cookie') || '')
  return m ? m[1] : null
}

async function authorize (s, m, username, invite, previous) {
  const body = { member: m.hex, username }
  if (invite !== undefined) body.invite = invite
  const started = await s.post('/account/start', body, previous ? { cookie: previous } : {})
  if (started.status !== 200) return { started, auth: started }
  const cookie = cookieOf(started)
  const auth = await s.post('/account/authorize', { signature: sign(s, m, 'reserve', started.body.nonce, username) }, { cookie })
  return { started, cookie, auth, nonce: started.body.nonce }
}

async function finish (s, m, username, cookie) {
  s.store.putGoogle(cookie, { sub: nextSub(), email: EMAIL })
  const pending = await s.api('GET', '/account/pending', { cookie })
  return s.post('/account/finish', { signature: sign(s, m, 'finish', pending.body.nonce, username, pending.body.sub) }, { cookie })
}

async function renameFinish (s, m, username, signer = m) {
  const rn = await s.post('/account/rename/start', { member: m.hex, username })
  return s.post('/account/rename/finish', { member: m.hex, nonce: rn.body.nonce, signature: sign(s, signer, 'rename', rn.body.nonce, username) })
}

async function invitesFinish (s, m, signer = m) {
  const st = await s.post('/account/invites/start', { member: m.hex })
  return s.post('/account/invites/finish', {
    member: m.hex,
    nonce: st.body.nonce,
    signature: signInvite({ action: 'issue', nonce: st.body.nonce, member: m.hex, association: s.iss.association }, signer.kp)
  })
}

// The phone log lines written while `fn` runs.
async function logged (s, fn) {
  const before = s.logs.length
  const r = await fn()
  return { r, lines: s.logs.slice(before).filter((l) => JSON.parse(l).event === 'telefone') }
}

function local (number) {
  return number.slice(3)
}

// No phone answer or log line carries a number, its local digits, the code
// or a member key (the proof names its own member, so it is set aside).
function noPersonalData (t, s, members = []) {
  const phoneAnswers = s.answers.filter((a) => a.pathname.startsWith('/account/phone')).map((a) => {
    if (a.body && typeof a.body === 'object' && 'proof' in a.body) {
      const { proof, ...rest } = a.body
      return JSON.stringify(rest)
    }
    return a.text
  })
  const all = s.answers.map((a) => a.text).join('\n') + '\n' + s.logs.join('\n')
  const logs = s.logs.join('\n')
  for (const number of FIXTURES) {
    t.absent(all.includes(number) || all.includes(local(number)), 'no number in any answer or log line')
  }
  t.absent(all.includes(PHONE_CODE), 'no code')
  t.absent(all.includes(API_KEY), 'no api key')
  for (const m of [s.linked, ...members]) {
    t.absent(logs.includes(m.hex), 'no member key in a log line')
    t.absent(phoneAnswers.join('\n').includes(m.hex), 'no member key in a phone answer outside its proof')
  }
  for (const line of s.logs) {
    const e = JSON.parse(line)
    if (e.event !== 'telefone') continue
    t.alike(Object.keys(e), ['event', 'reason'], 'phone logs carry only event and reason')
  }
}

test('phone off: policy not required, since null, every POST refuses, the gates stay open', async (t) => {
  const s = await setup(t, { phone: false, inviting: true })
  const policy = await s.api('GET', '/account/phone/policy')
  t.is(policy.status, 200)
  t.alike(policy.body, { required: false })
  const since = await s.api('GET', '/account/phone/since')
  t.is(since.status, 200)
  t.alike(since.body, { since: null })

  const m = member()
  for (const action of ['start', 'send', 'check', 'status']) {
    const r = await s.post('/account/phone/' + action, { member: m.hex, nonce: 'A'.repeat(43), signature: 'a'.repeat(128), phone: PHONE_A, code: PHONE_CODE })
    t.is(r.status, 503, action)
    t.alike(r.body, { error: 'indisponivel' })
  }

  await s.band(s.linked)
  const rn = await renameFinish(s, s.linked, 'ana')
  t.is(rn.status, 200, rn.text)
  const inv = await invitesFinish(s, s.linked)
  t.is(inv.status, 200, inv.text)
  await s.band(m)
  const a = await authorize(s, m, 'bia', inv.body.code)
  t.is(a.auth.status, 200, a.auth.text)
  const done = await finish(s, m, 'bia', a.cookie)
  t.is(done.status, 200, done.text)
  t.is(s.sends().length + s.checks().length, 0, 'the provider never called')
  t.alike(s.server.phoneStats(), { nonces: 0, pending: 0 })
})

test('phone on: policy, send, check and status, with a proof for that member and association only', async (t) => {
  const s = await setup(t)
  const policy = await s.api('GET', '/account/phone/policy')
  t.alike(policy.body, { required: true })

  const m = member()
  await s.band(m)
  const started = await s.start(m)
  t.is(started.status, 200)
  t.alike(Object.keys(started.body), ['nonce'])
  t.ok(/^[A-Za-z0-9_-]{43}$/.test(started.body.nonce))

  const sent = await s.step(m, 'send', { phone: PHONE_A })
  t.is(sent.status, 200, sent.text)
  t.alike(sent.body, { state: 'enviado' })
  t.is(s.sends().length, 1)
  t.is(s.sends()[0].body.phone_number, PHONE_A)
  t.is(s.sends()[0].body.options.preferred_channel, 'sms')
  t.absent(JSON.stringify(s.sends()[0].body).includes(m.hex), 'no member key to the provider')
  t.alike(s.server.phoneStats().pending, 1)

  const checked = await s.step(m, 'check', { code: PHONE_CODE })
  t.is(checked.status, 200, checked.text)
  t.alike(Object.keys(checked.body), ['state', 'proof'])
  t.is(checked.body.state, 'verificado')
  const proof = checked.body.proof
  t.alike(verifyPhoneVerified(proof, m.hex, s.iss.association), { ok: true })
  t.is(proof.date, s.phones.live(m.hex).verifiedAt)
  t.is(verifyPhoneVerified(proof, member().hex, s.iss.association).reason, 'member-mismatch')
  t.is(verifyPhoneVerified(proof, m.hex, b4a.toString(crypto.keyPair().publicKey, 'hex')).reason, 'untrusted-association')
  t.is(s.checks().length, 1)
  t.alike(s.server.phoneStats().pending, 0)

  const status = await s.step(m, 'status')
  t.alike(status.body, { state: 'verificado', proof })
  t.alike((await s.step(member(), 'status')).body, { state: 'nenhum' })

  // The same number again: verified, no charge and no provider call.
  s.c.offset += 61 * 1000
  const again = await s.step(m, 'send', { phone: PHONE_A })
  t.alike(again.body, { state: 'verificado', proof })
  t.is(s.sends().length, 1)
  noPersonalData(t, s, [m])
})

test('phone gates on: authorize, finish, rename and invites refuse a key without a number only after a valid signature, then allow it', async (t) => {
  const s = await setup(t, { inviting: true })
  await s.band(s.linked)

  const badRename = await renameFinish(s, s.linked, 'ana', member())
  t.is(badRename.status, 400)
  t.alike(badRename.body, { error: 'assinatura-invalida' })
  const rn = await renameFinish(s, s.linked, 'ana')
  t.is(rn.status, 403)
  t.alike(rn.body, { error: 'telefone-pendente' })
  const badInv = await invitesFinish(s, s.linked, member())
  t.alike(badInv.body, { error: 'assinatura-invalida' })
  const inv = await invitesFinish(s, s.linked)
  t.is(inv.status, 403)
  t.alike(inv.body, { error: 'telefone-pendente' })

  t.alike((await s.verify(s.linked, PHONE_A)).body.state, 'verificado')
  t.is((await renameFinish(s, s.linked, 'ana')).status, 200)
  const issued = await invitesFinish(s, s.linked)
  t.is(issued.status, 200, issued.text)
  const code = issued.body.code

  // A fresh key with a band: authorize refused with no Google URL.
  const m = member()
  await s.band(m)
  const started = await s.post('/account/start', { member: m.hex, username: 'bia', invite: code })
  t.is(started.status, 200, started.text)
  const cookie = cookieOf(started)
  const badAuth = await s.post('/account/authorize', { signature: sign(s, member(), 'reserve', started.body.nonce, 'bia') }, { cookie })
  t.alike(badAuth.body, { error: 'assinatura-invalida' })
  const auth = await s.post('/account/authorize', { signature: sign(s, m, 'reserve', started.body.nonce, 'bia') }, { cookie })
  t.is(auth.status, 403)
  t.alike(auth.body, { error: 'telefone-pendente' })
  t.is(s.google.calls, 0)

  // finish refused too, even with a subject on the row.
  s.store.reserve(cookie)
  s.store.putGoogle(cookie, { sub: nextSub(), email: EMAIL })
  const pending = await s.api('GET', '/account/pending', { cookie })
  const badFin = await s.post('/account/finish', { signature: sign(s, member(), 'finish', pending.body.nonce, 'bia', pending.body.sub) }, { cookie })
  t.alike(badFin.body, { error: 'assinatura-invalida' })
  const fin = await s.post('/account/finish', { signature: sign(s, m, 'finish', pending.body.nonce, 'bia', pending.body.sub) }, { cookie })
  t.is(fin.status, 403)
  t.alike(fin.body, { error: 'telefone-pendente' })
  t.absent(s.store.status(m.hex).linked)

  // Verified: a new start, authorize and finish go through.
  t.alike((await s.verify(m, PHONE_B)).body.state, 'verificado')
  const b = await authorize(s, m, 'bia', code, cookie)
  t.is(b.auth.status, 200, b.auth.text)
  t.is(b.auth.body.authorizeUrl, GOOGLE_URL)
  const done = await finish(s, m, 'bia', b.cookie)
  t.is(done.status, 200, done.text)
  t.ok(s.store.status(m.hex).linked)

  // Nothing about the phone in the certificate or /account/status.
  t.absent(/phone|telefone|celular/i.test(JSON.stringify(done.body)), 'no phone field in the finish answer')
  t.absent(/phone|telefone|celular/i.test(JSON.stringify(s.store.status(m.hex).cert)), 'no phone field in the certificate')
  const status = await s.api('GET', '/account/status?member=' + m.hex)
  t.absent(/phone|telefone|celular/i.test(status.text), 'no phone in /account/status')
  noPersonalData(t, s, [m])
})

test('phone: with no band idade-pendente wins and the provider is never called', async (t) => {
  const s = await setup(t)
  const m = member()
  const r = await s.step(m, 'send', { phone: PHONE_A })
  t.is(r.status, 403)
  t.alike(r.body, { error: 'idade-pendente' })
  t.is(s.sends().length, 0)
  // The gates answer the age check first.
  const rn = await renameFinish(s, s.linked, 'ana')
  t.alike(rn.body, { error: 'idade-pendente' })
})

test('phone: with age checks off a send needs no band', async (t) => {
  const s = await setup(t, { age: false })
  const m = member()
  const r = await s.step(m, 'send', { phone: PHONE_A })
  t.is(r.status, 200, r.text)
  t.alike(r.body, { state: 'enviado' })
  t.alike((await s.step(m, 'check', { code: PHONE_CODE })).body.state, 'verificado')
})

test('phone send: input checks in order, an invalid number, a channel, a deleted account', async (t) => {
  const s = await setup(t)
  const m = member()
  await s.band(m)
  for (const bad of ['+551133334444', '11987654321', '+14155550123', 5511987654321, null]) {
    const r = await s.step(m, 'send', { phone: bad })
    t.is(r.status, 400)
    t.alike(r.body, { error: 'telefone-invalido' })
  }
  const channel = await s.step(m, 'send', { phone: PHONE_A, channel: 'whatsapp' })
  t.is(channel.status, 400)
  t.alike(channel.body, { error: 'pedido-invalido' })
  t.is(s.sends().length, 0)

  await s.band(s.linked)
  await s.store.deleteMember(s.linked.hex)
  for (const action of ['send', 'check']) {
    const r = await s.step(s.linked, action, { phone: PHONE_A, code: PHONE_CODE })
    t.is(r.status, 409, action)
    t.alike(r.body, { error: 'conta-excluida' })
  }
  t.is(s.sends().length, 0)
})

test('phone nonces: single-use, member-bound, expiring, action-bound, never an age signature', async (t) => {
  const s = await setup(t)
  const m = member()
  await s.band(m)
  const body = (nonce, signature) => ({ member: m.hex, nonce, signature, phone: PHONE_A })

  const a = (await s.start(m)).body.nonce
  const wrongAction = await s.post('/account/phone/send', body(a, s.signFor(m, 'check', a)))
  t.alike(wrongAction.body, { error: 'assinatura-invalida' })
  const reused = await s.post('/account/phone/send', body(a, s.signFor(m, 'send', a)))
  t.alike(reused.body, { error: 'expirado' }, 'spent by the failed attempt')

  const b = (await s.start(m)).body.nonce
  const age = signAge({ action: 'session', nonce: b, member: m.hex, association: s.iss.association }, m.kp)
  t.alike((await s.post('/account/phone/send', body(b, age))).body, { error: 'assinatura-invalida' })

  const other = member()
  const c = (await s.start(other)).body.nonce
  t.alike((await s.post('/account/phone/send', body(c, s.signFor(m, 'send', c)))).body, { error: 'expirado' }, 'a nonce minted for another member')

  const d = (await s.start(m)).body.nonce
  s.c.offset += 601 * 1000
  t.alike((await s.post('/account/phone/send', body(d, s.signFor(m, 'send', d)))).body, { error: 'expirado' })

  const e = (await s.start(m)).body.nonce
  const foreign = signPhone({ action: 'send', nonce: e, member: m.hex, association: b4a.toString(crypto.keyPair().publicKey, 'hex') }, m.kp)
  t.alike((await s.post('/account/phone/send', body(e, foreign))).body, { error: 'assinatura-invalida' }, 'another association')
  t.is(s.sends().length, 0)

  const f = (await s.start(m)).body.nonce
  const ok = await s.post('/account/phone/send', body(f, s.signFor(m, 'send', f)))
  t.alike(ok.body, { state: 'enviado' })
  t.alike((await s.post('/account/phone/send', body(f, s.signFor(m, 'send', f)))).body, { error: 'expirado' }, 'single use after a success')
  t.alike(Object.keys((await s.start(member())).body), ['nonce'], 'start reveals nothing')
})

test('phone limits: a 60 s cooldown, five sends a day per member, three per number', async (t) => {
  const s = await setup(t)
  const m = member()
  await s.band(m)
  t.alike((await s.step(m, 'send', { phone: PHONE_A })).body, { state: 'enviado' })
  const soon = await s.step(m, 'send', { phone: PHONE_B })
  t.is(soon.status, 429)
  t.alike(soon.body, { error: 'limite-telefone' })
  for (const number of [PHONE_B, PHONE_C, PHONE_D, PHONE_E]) {
    s.c.offset += 61 * 1000
    t.alike((await s.step(m, 'send', { phone: number })).body, { state: 'enviado' })
  }
  s.c.offset += 61 * 1000
  const sixth = await s.step(m, 'send', { phone: PHONE_F })
  t.alike(sixth.body, { error: 'limite-telefone' }, 'the member window')
  t.is(s.sends().length, 5)

  // Three members on one number, then the number window.
  for (let i = 0; i < 2; i++) {
    const other = member()
    await s.band(other)
    t.alike((await s.step(other, 'send', { phone: PHONE_A })).body, { state: 'enviado' })
  }
  const fourth = member()
  await s.band(fourth)
  t.alike((await s.step(fourth, 'send', { phone: PHONE_A })).body, { error: 'limite-telefone' }, 'the number window')
  t.is(s.sends().length, 7)

  // A day later both windows are open again.
  s.c.offset += DAY
  t.alike((await s.step(fourth, 'send', { phone: PHONE_A })).body, { state: 'enviado' })
})

test('phone limits: refused sends never charge the daily ceiling, which answers 503', async (t) => {
  const s = await setup(t, { dailyLimit: 4 })
  const send = async (number) => {
    const who = member()
    await s.band(who)
    return s.step(who, 'send', { phone: number })
  }
  for (let i = 0; i < 3; i++) t.alike((await send(PHONE_A)).body, { state: 'enviado' })
  t.alike((await send(PHONE_A)).body, { error: 'limite-telefone' }, 'refused by the number window, not charged')
  t.alike((await send(PHONE_B)).body, { state: 'enviado' }, 'the fourth charge')
  const { r, lines } = await logged(s, () => send(PHONE_C))
  t.is(r.status, 503)
  t.alike(r.body, { error: 'indisponivel' })
  t.alike(lines, [JSON.stringify({ event: 'telefone', reason: 'teto-diario' })])
  t.is(s.sends().length, 4)

  // Linked members have their own ceiling, read at each request.
  const late = member()
  await s.band(late)
  t.alike((await s.step(late, 'send', { phone: PHONE_D })).body, { error: 'indisponivel' })
  await linkDirect(s.store, s.iss, late, 'lia')
  t.alike((await s.step(late, 'send', { phone: PHONE_D })).body, { state: 'enviado' }, 'linked between two calls: the other ceiling')
})

test('phone: two concurrent sends for one member make one provider call', async (t) => {
  const s = await setup(t)
  s.fake.script({ phoneSend: (req, res, ctx) => setTimeout(() => ctx.json(res, 200, { status: 'Success' }), 150) })
  const m = member()
  await s.band(m)
  const a = (await s.start(m)).body.nonce
  const b = (await s.start(m)).body.nonce
  const body = (nonce) => ({ member: m.hex, nonce, signature: s.signFor(m, 'send', nonce), phone: PHONE_A })
  const [ra, rb] = await Promise.all([s.post('/account/phone/send', body(a)), s.post('/account/phone/send', body(b))])
  t.alike(ra.body, { state: 'enviado' })
  t.alike(rb.body, { state: 'enviado' })
  t.is(s.sends().length, 1)
})

test('phone: free, taken and burned numbers get identical send answers and logs; uniqueness is told only after a correct code', async (t) => {
  const s = await setup(t)
  // The linked member holds A; a blocked unlinked key held C.
  t.alike((await s.verify(s.linked, PHONE_A)).body.state, 'verificado')
  const blocked = member()
  t.alike((await s.verify(blocked, PHONE_C)).body.state, 'verificado')
  s.c.blocked.push({ member: blocked.hex, reportIds: ['r1'] })

  const taker = member()
  const free = member()
  const burner = member()
  for (const who of [taker, free, burner]) await s.band(who)
  const taken = await logged(s, () => s.step(taker, 'send', { phone: PHONE_A }))
  const open = await logged(s, () => s.step(free, 'send', { phone: PHONE_B }))
  const burned = await logged(s, () => s.step(burner, 'send', { phone: PHONE_C }))
  for (const x of [taken, open, burned]) {
    t.is(x.r.status, 200)
    t.is(x.r.text, open.r.text, 'the same answer')
    t.alike(x.lines, open.lines, 'the same log lines')
  }

  const inUse = await s.step(taker, 'check', { code: PHONE_CODE })
  t.is(inUse.status, 409)
  t.alike(inUse.body, { error: 'telefone-em-uso' })
  const burnt = await s.step(burner, 'check', { code: PHONE_CODE })
  t.alike(burnt.body, { error: 'telefone-em-uso' })
  t.alike((await s.step(free, 'check', { code: PHONE_CODE })).body.state, 'verificado')
  t.alike((await s.step(taker, 'status')).body, { state: 'nenhum' })
  t.alike((await s.step(taker, 'check', { code: PHONE_CODE })).body, { error: 'codigo-expirado' }, 'the pending send is gone')
  noPersonalData(t, s, [taker, free, burner, blocked])
})

test('phone: an unlinked holder is superseded; a blocked owner burns every number it held; a self-deleted owner does not', async (t) => {
  const s = await setup(t)
  const unlinked = member()
  t.alike((await s.verify(unlinked, PHONE_A)).body.state, 'verificado')
  const next = member()
  t.alike((await s.verify(next, PHONE_A)).body.state, 'verificado', 'an unlinked holder gives way')
  t.alike((await s.step(unlinked, 'status')).body, { state: 'nenhum' })

  // A linked member replaces B by C, then is blocked with a report.
  t.alike((await s.verify(s.linked, PHONE_B)).body.state, 'verificado')
  s.c.offset += 61 * 1000
  t.alike((await s.verify(s.linked, PHONE_C)).body.state, 'verificado')
  s.c.blocked.push({ member: s.linked.hex, reportIds: ['r1'] })
  for (const number of [PHONE_B, PHONE_C]) {
    const who = member()
    t.alike((await s.verify(who, number)).body, { error: 'telefone-em-uso' }, 'burned, the replaced one included')
  }

  // A self-deleted owner: Excluir conta queues a block with no report id.
  const leaver = member()
  await linkDirect(s.store, s.iss, leaver, 'leo')
  t.alike((await s.verify(leaver, PHONE_D)).body.state, 'verificado')
  await s.store.deleteMember(leaver.hex)
  s.c.blocked.push({ member: leaver.hex, reportIds: [] })
  t.alike((await s.verify(member(), PHONE_D)).body.state, 'verificado', 'the number is free again')
})

test('phone: a blocked member can still verify a first number', async (t) => {
  const s = await setup(t)
  s.c.blocked.push({ member: s.linked.hex, reportIds: ['r1'] })
  const sent = await s.verify(s.linked, PHONE_A)
  t.alike(sent.body.state, 'verificado')
})

test('phone check: a wrong code three times, then codigo-expirado; a malformed code is refused before the provider', async (t) => {
  const s = await setup(t)
  const m = member()
  await s.band(m)
  t.alike((await s.step(m, 'send', { phone: PHONE_A })).body, { state: 'enviado' })
  const malformed = await s.step(m, 'check', { code: '12345' })
  t.is(malformed.status, 400)
  t.alike(malformed.body, { error: 'codigo-invalido' })
  t.is(s.checks().length, 0)
  for (let i = 0; i < 3; i++) {
    const r = await s.step(m, 'check', { code: WRONG_CODE })
    t.is(r.status, 400)
    t.alike(r.body, { error: 'codigo-invalido' })
  }
  const after = await s.step(m, 'check', { code: PHONE_CODE })
  t.is(after.status, 410)
  t.alike(after.body, { error: 'codigo-expirado' })
  t.is(s.checks().length, 3)
  t.alike((await s.step(member(), 'check', { code: PHONE_CODE })).body, { error: 'codigo-expirado' }, 'no send at all')
})

test('phone check: a virtual line is refused; an unknown outcome is 503', async (t) => {
  const s = await setup(t)
  const m = member()
  await s.band(m)
  s.fake.script({ phoneCheck: (req, res, ctx) => ctx.json(res, 200, { status: 'Approved', phone: { is_virtual: true } }) })
  await s.step(m, 'send', { phone: PHONE_A })
  const r = await s.step(m, 'check', { code: PHONE_CODE })
  t.is(r.status, 409)
  t.alike(r.body, { error: 'telefone-recusado' })
  t.alike((await s.step(m, 'status')).body, { state: 'nenhum' })

  s.c.offset += 61 * 1000
  s.fake.script({ phoneCheck: (req, res, ctx) => ctx.json(res, 200, { status: 'Something' }) })
  await s.step(m, 'send', { phone: PHONE_B })
  const unknown = await s.step(m, 'check', { code: PHONE_CODE })
  t.is(unknown.status, 503)
  t.alike(unknown.body, { error: 'indisponivel' })
  t.ok(s.logs.includes(JSON.stringify({ event: 'telefone', reason: 'resultado-desconhecido' })))
})

test('phone send: provider refusals map to tokens and log field names, never values', async (t) => {
  const s = await setup(t)
  const m = member()
  await s.band(m)
  s.fake.script({ phoneSend: (req, res, ctx) => ctx.json(res, 400, { phone_number: ['invalid ' + PHONE_A], detail: API_KEY }) })
  const { r, lines } = await logged(s, () => s.step(m, 'send', { phone: PHONE_A }))
  t.is(r.status, 503)
  t.alike(r.body, { error: 'indisponivel' })
  t.alike(lines, [
    JSON.stringify({ event: 'telefone', reason: 'didit-envio-http-400' }),
    JSON.stringify({ event: 'telefone', reason: 'didit-envio-campo-phone_number' }),
    JSON.stringify({ event: 'telefone', reason: 'didit-envio-campo-detail' })
  ])
  t.alike(s.server.phoneStats().pending, 0, 'nothing pending after a refusal')

  s.fake.script({ phoneSend: (req, res, ctx) => ctx.json(res, 429, {}) })
  t.alike((await s.step(m, 'send', { phone: PHONE_A })).body, { error: 'limite-telefone' })
  s.fake.script({ phoneSend: (req, res, ctx) => ctx.json(res, 200, { status: 'Blocked' }) })
  t.alike((await s.step(m, 'send', { phone: PHONE_A })).body, { error: 'limite-telefone' })
  s.fake.script({ phoneSend: (req, res, ctx) => ctx.json(res, 502, {}) })
  const uncertain = await s.step(m, 'send', { phone: PHONE_B })
  t.is(uncertain.status, 503)
  t.alike(uncertain.body, { error: 'resultado-incerto' })
  t.alike(s.server.phoneStats().pending, 1, 'a code may still arrive')
  noPersonalData(t, s, [m])
})

test('phone: a timeout on send leaves a pending entry that a later check approves', async (t) => {
  const s = await setup(t, { sendTimeoutMs: 200 })
  s.fake.script({ phoneSend: () => {} })
  const m = member()
  await s.band(m)
  const r = await s.step(m, 'send', { phone: PHONE_A })
  t.is(r.status, 503)
  t.alike(r.body, { error: 'resultado-incerto' })
  t.ok(s.logs.includes(JSON.stringify({ event: 'telefone', reason: 'didit-envio-tempo' })))
  s.fake.script({})
  const checked = await s.step(m, 'check', { code: PHONE_CODE })
  t.is(checked.status, 200, checked.text)
  t.is(checked.body.state, 'verificado')
})

test('phone: a failed write answers resultado-incerto and the retry records without a second provider check', async (t) => {
  const s = await setup(t)
  const m = member()
  await s.band(m)
  await s.step(m, 'send', { phone: PHONE_A })
  s.c.guardOk = false
  const r = await s.step(m, 'check', { code: PHONE_CODE })
  t.is(r.status, 503)
  t.alike(r.body, { error: 'resultado-incerto' })
  t.ok(s.logs.includes(JSON.stringify({ event: 'telefone', reason: 'gravacao-falhou' })))
  t.absent(s.phones.verified(m.hex))
  t.is(s.checks().length, 1)
  s.c.guardOk = true
  const retry = await s.step(m, 'check', { code: PHONE_CODE })
  t.is(retry.body.state, 'verificado')
  t.ok(s.phones.verified(m.hex))
  t.is(s.checks().length, 1, 'no second provider check')
})

test('phone: a store opened with the wrong key keeps the policy required and the gates shut', async (t) => {
  const s = await setup(t, {
    inviting: true,
    before: async (dir) => {
      const other = openPhoneStore(dir, { key: nodeCrypto.randomBytes(32) })
      const cbs = { linked: () => false, burnable: () => false, deleted: () => false }
      await other.record({ member: member().hex, phone: PHONE_A }, cbs)
    }
  })
  t.absent(s.phones.available())
  t.alike((await s.api('GET', '/account/phone/policy')).body, { required: true })
  await s.band(s.linked)
  t.alike((await renameFinish(s, s.linked, 'ana')).body, { error: 'telefone-pendente' })
  t.alike((await invitesFinish(s, s.linked)).body, { error: 'telefone-pendente' })
  for (const action of ['send', 'check', 'status']) {
    const { r, lines } = await logged(s, () => s.step(s.linked, action, { phone: PHONE_B, code: PHONE_CODE }))
    t.is(r.status, 503, action)
    t.alike(r.body, { error: 'indisponivel' })
    t.alike(lines, [JSON.stringify({ event: 'telefone', reason: 'armazenamento-indisponivel' })])
  }
  const since = await s.api('GET', '/account/phone/since')
  t.is(since.status, 503)
  t.is(s.sends().length, 0)
  t.ok(s.logs.includes(JSON.stringify({ event: 'telefone', reason: 'varredura-falhou' })), 'the start sweep failed and said so')
})

test('phone: unblocking gives the number back after a sweep', async (t) => {
  const s = await setup(t)
  const holder = s.linked
  t.alike((await s.verify(holder, PHONE_A)).body.state, 'verificado')
  const other = member()
  await s.band(other)
  const sweep = () => sweepVia(s, holder)

  s.c.blocked.push({ member: holder.hex, reportIds: ['r1'] })
  await sweep()
  t.alike(s.phones.counts(), { live: 1, ended: 0, burned: 1 })
  t.alike((await s.step(other, 'send', { phone: PHONE_A })).body, { state: 'enviado' })
  t.alike((await s.step(other, 'check', { code: PHONE_CODE })).body, { error: 'telefone-em-uso' })

  s.c.blocked = []
  await sweep()
  t.alike(s.phones.counts(), { live: 1, ended: 0, burned: 0 })
  t.is((await s.step(holder, 'status')).body.state, 'verificado', 'the member keeps the number')
  s.c.offset += 61 * 1000
  await s.step(other, 'send', { phone: PHONE_A })
  t.alike((await s.step(other, 'check', { code: PHONE_CODE })).body, { error: 'telefone-em-uso' }, 'still held by a live linked row')

  // Trocar número ends the holder's row: the number is free (a day later,
  // past the number's daily window).
  await s.phones.end(holder.hex, 'trocado')
  s.c.offset += DAY
  t.alike((await s.step(other, 'send', { phone: PHONE_A })).body, { state: 'enviado' })
  t.is((await s.step(other, 'check', { code: PHONE_CODE })).body.state, 'verificado')
})

test('phone since route: null before the first verification, then signed and cached for at most 60 s', async (t) => {
  const s = await setup(t)
  const none = await s.api('GET', '/account/phone/since')
  t.is(none.status, 200)
  t.alike(none.body, { since: null })

  t.alike((await s.verify(member(), PHONE_A)).body.state, 'verificado')
  const r = await s.api('GET', '/account/phone/since')
  t.is(r.status, 200)
  t.alike(Object.keys(r.body), ['since'])
  t.is(r.body.since.type, 'phone-since')
  t.is(r.body.since.since, s.phones.since())
  t.alike(verifyPhoneSince(r.body.since, s.iss.association), { ok: true })
  t.is(verifyPhoneSince(r.body.since, b4a.toString(crypto.keyPair().publicKey, 'hex')).reason, 'untrusted-association')
  t.absent(/\+55|phone_number|index/.test(r.text))

  const first = r.body.since
  s.c.offset += 30 * 1000
  t.alike((await s.api('GET', '/account/phone/since')).body.since, first, 'within 60 s: the same object')
  s.c.offset += 31 * 1000
  const later = (await s.api('GET', '/account/phone/since')).body.since
  t.is(later.since, first.since)
  t.ok(new Date(later.date).getTime() >= new Date(first.date).getTime() + 60 * 1000, 'past 60 s: re-signed')
  t.alike(verifyPhoneSince(later, s.iss.association), { ok: true })
  s.c.offset -= 10 * 1000
  const back = (await s.api('GET', '/account/phone/since')).body.since
  t.not(back.date, later.date, 'the clock went backwards: re-signed')
})

test('phone since route: a failed store is a 503, never null', async (t) => {
  const s = await setup(t)
  t.alike((await s.verify(member(), PHONE_A)).body.state, 'verificado')
  s.phones.fail()
  const r = await s.api('GET', '/account/phone/since')
  t.is(r.status, 503)
  t.alike(r.body, { error: 'indisponivel' })
  t.ok(s.logs.includes(JSON.stringify({ event: 'telefone', reason: 'armazenamento-indisponivel' })))
})

test('phone: without an issuer verificado carries no proof and since is null', async (t) => {
  const s = await setup(t, { withIssuer: false })
  const m = member()
  const r = await s.verify(m, PHONE_A)
  t.alike(r.body, { state: 'verificado' })
  t.alike((await s.step(m, 'status')).body, { state: 'verificado' })
  s.c.offset += 61 * 1000
  t.alike((await s.step(m, 'send', { phone: PHONE_A })).body, { state: 'verificado' })
  t.alike((await s.api('GET', '/account/phone/since')).body, { since: null })
})

test('phone since route: off never serves since; GET only, refused like the policy on a wrong method', async (t) => {
  const off = await setup(t, { phone: false })
  t.alike((await off.api('GET', '/account/phone/since')).body, { since: null })
  const s = await setup(t)
  const wrongPolicy = await s.api('POST', '/account/phone/policy', { body: {} })
  const wrongSince = await s.api('POST', '/account/phone/since', { body: {} })
  t.not(wrongPolicy.status, 200)
  t.is(wrongSince.status, wrongPolicy.status)
  t.alike(wrongSince.body, wrongPolicy.body)
  const getSend = await s.api('GET', '/account/phone/send')
  t.is(getSend.status, 404)
})

test('phone since route: its rate limit is separate from the policy\'s', async (t) => {
  class RouteError extends Error {
    constructor (token, status) { super(token); this.token = token; this.status = status }
  }
  const sent = []
  const iss = issuer()
  const routes = createPhoneRoutes({
    association: iss.association,
    store: {},
    client: { send: async () => ({ ok: false }), check: async () => ({ ok: false }) },
    phones: { since: () => '2026-11-11T00:00:00.000Z', sweep: async () => ({}), available: () => true },
    ageVerified: () => true,
    linked: () => false,
    deleted: () => false,
    burnable: () => false,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    http: {
      send: (res, status, body) => sent.push({ status, body }),
      RouteError,
      refuse: (token) => new RouteError(token, 404),
      keyedWindow: () => () => true,
      fixedWindow: () => { let left = 1; return () => left-- > 0 }
    }
  })
  const get = (pathname) => routes.handle({ method: 'GET' }, {}, new URL(pathname, ORIGIN))
  await get('/account/phone/policy')
  await t.exception(get('/account/phone/policy'), /pedido-invalido/, 'policy window spent')
  await get('/account/phone/since')
  await t.exception(get('/account/phone/since'), /pedido-invalido/, 'since window spent')
  t.alike(sent[0], { status: 200, body: { required: true } })
  t.is(sent[1].body.since.type, 'phone-since')
})

test('createPhoneRoutes: malformed options throw', (t) => {
  const http = { send () {}, RouteError: Error, refuse: (x) => new Error(x), keyedWindow: () => () => true, fixedWindow: () => () => true }
  const base = { association: issuer().association, store: {}, ageVerified: () => true, linked: () => false, deleted: () => false, burnable: () => false, http }
  t.exception.all(() => createPhoneRoutes({ ...base, client: {} }), /phoneClient/)
  t.exception.all(() => createPhoneRoutes({ ...base, linked: true }), /linked/)
  t.exception.all(() => createPhoneRoutes({ ...base, dailyLimit: 0 }), /phoneDailyLimit/)
  t.exception.all(() => createPhoneRoutes({ ...base, issuer: {} }), /issuer/)
  t.execution(() => createPhoneRoutes(base), 'off: accepted')
})

// The provider's check answers only once `release()` is called.
function holdChecks (s) {
  const held = []
  s.fake.script({
    phoneCheck: (req, res, ctx) => held.push(() => ctx.json(res, 200, ctx.body.code === PHONE_CODE
      ? { status: 'Approved', phone: { is_virtual: false, is_disposable: false, carrier: { type: 'mobile' } } }
      : { status: 'Failed' }))
  })
  return {
    waiting: () => held.length,
    release () {
      s.fake.script({})
      for (const answer of held.splice(0)) answer()
    }
  }
}

async function waitFor (fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

test('phone send: another number while a send is in flight is refused, and pending keeps the number really sent to', async (t) => {
  const s = await setup(t)
  s.fake.script({ phoneSend: (req, res, ctx) => setTimeout(() => ctx.json(res, 200, { status: 'Success' }), 150) })
  const m = member()
  await s.band(m)
  const a = (await s.start(m)).body.nonce
  const b = (await s.start(m)).body.nonce
  const body = (nonce, phone) => ({ member: m.hex, nonce, signature: s.signFor(m, 'send', nonce), phone })
  const first = s.post('/account/phone/send', body(a, PHONE_A))
  t.ok(await waitFor(() => s.sends().length === 1))
  const other = await s.post('/account/phone/send', body(b, PHONE_B))
  t.is(other.status, 429)
  t.alike(other.body, { error: 'limite-telefone' })
  t.alike((await first).body, { state: 'enviado' })
  t.is(s.sends().length, 1)
  s.fake.script({})
  t.is((await s.step(m, 'check', { code: PHONE_CODE })).body.state, 'verificado')
  t.is(s.phones.live(m.hex).index, s.phones.indexOf(PHONE_A), 'the number the code went to')
})

test('phone check: a newer send while the provider checks wins, and the old approval records nothing', async (t) => {
  const s = await setup(t)
  const m = member()
  await s.band(m)
  await s.step(m, 'send', { phone: PHONE_A })
  const hold = holdChecks(s)
  const checking = s.step(m, 'check', { code: PHONE_CODE })
  t.ok(await waitFor(() => hold.waiting() === 1))
  s.c.offset += 61 * 1000
  t.alike((await s.step(m, 'send', { phone: PHONE_B })).body, { state: 'enviado' })
  hold.release()
  const r = await checking
  t.is(r.status, 410)
  t.alike(r.body, { error: 'codigo-expirado' })
  t.absent(s.phones.verified(m.hex), 'nothing recorded')
  t.is((await s.step(m, 'check', { code: PHONE_CODE })).body.state, 'verificado')
  t.is(s.phones.live(m.hex).index, s.phones.indexOf(PHONE_B), 'the newer number')
})

test('phone check: an account deleted while the provider checks records nothing', async (t) => {
  const s = await setup(t)
  await s.band(s.linked)
  await s.step(s.linked, 'send', { phone: PHONE_A })
  const hold = holdChecks(s)
  const checking = s.step(s.linked, 'check', { code: PHONE_CODE })
  t.ok(await waitFor(() => hold.waiting() === 1))
  await s.store.deleteMember(s.linked.hex)
  hold.release()
  const r = await checking
  t.is(r.status, 409)
  t.alike(r.body, { error: 'conta-excluida' })
  t.absent(s.phones.verified(s.linked.hex), 'nothing recorded')
  t.is(s.server.phoneStats().pending, 0)
})

test('phone limits: a number at its cap never spends a member send', async (t) => {
  const s = await setup(t)
  for (let i = 0; i < 3; i++) {
    const other = member()
    await s.band(other)
    t.alike((await s.step(other, 'send', { phone: PHONE_A })).body, { state: 'enviado' })
  }
  const m = member()
  await s.band(m)
  t.alike((await s.step(m, 'send', { phone: PHONE_A })).body, { error: 'limite-telefone' })
  for (const number of [PHONE_B, PHONE_C, PHONE_D, PHONE_E, PHONE_F]) {
    t.alike((await s.step(m, 'send', { phone: number })).body, { state: 'enviado' }, 'still five sends')
    s.c.offset += 61 * 1000
  }
})

test('phone: an operator-blocked member who deletes the account stays burned; unblocking clears it after a sweep', async (t) => {
  const s = await setup(t, { passkeys: true })
  const holder = s.linked
  t.is((await s.verify(holder, PHONE_A)).body.state, 'verificado')
  const pk = createFakePasskey({ rpId: 'varanda.test' })
  const key = keyFromAttestation({ attestationObject: pk.attestationObject(), credentialId: pk.credentialId, rpId: 'varanda.test' })
  await s.passkeyStore.add({ member: holder.hex, credentialId: pk.credentialId, ...key })
  // Blocked outside the panel: a published block with no report id.
  s.c.blocked.push({ member: holder.hex, reportIds: [] })

  const st = await s.post('/account/delete/start', { member: holder.hex })
  t.is(st.status, 200, st.text)
  const done = await s.post('/account/delete/finish', {
    member: holder.hex,
    nonce: st.body.nonce,
    signature: sign(s, holder, 'delete', st.body.nonce, st.body.username),
    assertion: pk.assert({ challenge: Buffer.from(st.body.nonce, 'base64url'), origin: ORIGIN })
  })
  t.is(done.status, 200, done.text)
  t.ok(s.store.deletedAt(holder.hex) !== null)
  t.is(s.phones.counts().burned, 1, 'burned before the deletion marked the key')

  const other = member()
  t.alike((await s.verify(other, PHONE_A)).body, { error: 'telefone-em-uso' })

  // The operator lifts the block: the next sweep clears the burn.
  s.c.blocked = []
  await sweepVia(s, holder)
  t.is(s.phones.counts().burned, 0)
  s.c.offset += 61 * 1000
  t.is((await s.verify(other, PHONE_A)).body.state, 'verificado')
})

test('phone check: a check while another is in flight is refused with no provider call and no attempt spent', async (t) => {
  const s = await setup(t)
  const m = member()
  await s.band(m)
  await s.step(m, 'send', { phone: PHONE_A })
  const hold = holdChecks(s)
  const first = s.step(m, 'check', { code: WRONG_CODE })
  t.ok(await waitFor(() => hold.waiting() === 1))
  for (let i = 0; i < 2; i++) {
    const r = await s.step(m, 'check', { code: WRONG_CODE })
    t.is(r.status, 429)
    t.alike(r.body, { error: 'limite-telefone' })
  }
  t.is(hold.waiting(), 1, 'no provider call')
  hold.release()
  t.alike((await first).body, { error: 'codigo-invalido' })
  t.is(s.checks().length, 1)
  t.is((await s.step(m, 'check', { code: PHONE_CODE })).body.state, 'verificado', 'one attempt spent, not three')
})

test('phone limits: three wrong codes never open an early resend', async (t) => {
  const s = await setup(t)
  const m = member()
  await s.band(m)
  t.alike((await s.step(m, 'send', { phone: PHONE_A })).body, { state: 'enviado' })
  for (let i = 0; i < 3; i++) await s.step(m, 'check', { code: WRONG_CODE })
  t.alike((await s.step(m, 'check', { code: PHONE_CODE })).body, { error: 'codigo-expirado' }, 'pending is gone')
  const soon = await s.step(m, 'send', { phone: PHONE_A })
  t.is(soon.status, 429)
  t.alike(soon.body, { error: 'limite-telefone' })
  t.is(s.sends().length, 1)
  s.c.offset += 61 * 1000
  t.alike((await s.step(m, 'send', { phone: PHONE_A })).body, { state: 'enviado' })
  t.is(s.sends().length, 2)
})

test('phone: Excluir conta waits for the burn of a blocked member when the sweep fails; nobody else is held', async (t) => {
  const s = await setup(t, { passkeys: true })
  const enrol = async (who) => {
    const pk = createFakePasskey({ rpId: 'varanda.test' })
    const key = keyFromAttestation({ attestationObject: pk.attestationObject(), credentialId: pk.credentialId, rpId: 'varanda.test' })
    await s.passkeyStore.add({ member: who.hex, credentialId: pk.credentialId, ...key })
    return pk
  }
  const remove = async (who, pk) => {
    const st = await s.post('/account/delete/start', { member: who.hex })
    if (st.status !== 200) return st
    return s.post('/account/delete/finish', {
      member: who.hex,
      nonce: st.body.nonce,
      signature: sign(s, who, 'delete', st.body.nonce, st.body.username),
      assertion: pk.assert({ challenge: Buffer.from(st.body.nonce, 'base64url'), origin: ORIGIN })
    })
  }
  const holder = s.linked
  t.is((await s.verify(holder, PHONE_A)).body.state, 'verificado')
  const holderKey = await enrol(holder)
  const free = member()
  await linkDirect(s.store, s.iss, free, 'otto')
  const freeKey = await enrol(free)
  s.c.blocked.push({ member: holder.hex, reportIds: [] })
  s.c.guardOk = false

  const held = await remove(holder, holderKey)
  t.is(held.status, 503)
  t.alike(held.body, { error: 'indisponivel' })
  t.is(s.store.deletedAt(holder.hex), null, 'not deleted')
  t.ok(s.logs.includes(JSON.stringify({ event: 'telefone', reason: 'varredura-exclusao-falhou' })))

  const blockedList = s.c.blocked
  s.c.blocked = null
  const unknown = await remove(holder, holderKey)
  t.alike(unknown.body, { error: 'indisponivel' }, 'an unreadable list holds it too')
  t.is(s.store.deletedAt(holder.hex), null)
  s.c.blocked = blockedList

  const done = await remove(free, freeKey)
  t.is(done.status, 200, done.text)
  t.ok(s.store.deletedAt(free.hex) !== null, 'a member who is not blocked is deleted')

  s.c.guardOk = true
  const later = await remove(holder, holderKey)
  t.is(later.status, 200, later.text)
  t.is(s.phones.counts().burned, 1, 'burned before the deletion marked the key')
})
