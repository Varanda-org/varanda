'use strict'

// apps/cli/lib/account/wallet-routes.js mounted by server.js: the optional
// payments account (policy, start, optin, kyc-document, kyc-submit, status,
// wallet-create). Loopback only: the Hodle fake of helpers/fake-hodle.js and
// members linked in-process.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { signWallet, opHash } = require('@varanda/core/lib/wallet-proof')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openAgeStore } = require('../lib/account/age-store')
const { openWalletStore } = require('../lib/account/wallet-store')
const { createHodle } = require('../lib/account/hodle')
const { createAccountServer } = require('../lib/account/server')
const { canonicalJson } = require('../lib/account/wallet-routes')
const { startFakeHodle, loopbackFetch } = require('./helpers/fake-hodle')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const API_KEY = 'hodle_test_fakekey0123456789'
const PIN = '482915'
const ADULT = Object.freeze({ adult: 1 })
const KYC = Object.freeze({
  fullName: 'Fulana de Tal',
  dateOfBirth: '1990-05-17',
  taxIdNumber: '52998224725',
  email: 'fulana@example.test',
  country: 'BR',
  state: 'SP',
  city: 'Sao Paulo',
  zipCode: '01310100',
  streetAddress: 'Avenida Paulista 1000'
})

function googleStub () {
  return {
    authorizeUrl: () => 'https://accounts.google.test/auth',
    exchange: async () => { throw new Error('google called') }
  }
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
async function linkDirect (store, iss, m, username) {
  const row = store.start({ member: m.hex, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: '40000000000000000' + String(subSeq++).padStart(5, '0'), email: 'membro@example.test' })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

function kycHash (kyc) {
  return nodeCrypto.createHash('sha256').update(canonicalJson(kyc), 'utf8').digest('hex')
}

// `on: false` leaves hodle and wallets null. `timeoutMs` shortens the Hodle
// client's deadline for the lost-answer tests.
async function setup (t, { on = true, mode, dailyLimit, timeoutMs, withAges = false, burst } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  // `c.failAfter` = 'METHOD /path': wallet.json writes start failing as
  // soon as Hodle answered that call.
  const c = { offset: 0, guardOk: true, failAfter: null }
  c.now = () => Date.now() + c.offset
  const iss = issuer()
  const store = openAccountStore(dir, { now: c.now })
  const terms = openTermsStore(dir, { now: c.now })
  const m = member()
  await linkDirect(store, iss, m, 'ana')
  await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
  const fake = await startFakeHodle()
  t.teardown(() => fake.close(), { force: true })
  const loopback = loopbackFetch(fake.base)
  const hodleFetch = async (url, init) => {
    const res = await loopback(url, init)
    if (c.failAfter === init.method + ' ' + new URL(url).pathname) c.guardOk = false
    return res
  }
  const hodle = on ? createHodle({ apiKey: API_KEY, endpoints: { base: fake.base }, fetch: hodleFetch, ...(timeoutMs ? { timeoutMs } : {}) }) : null
  const wallets = on ? openWalletStore(dir, { now: c.now, guard: () => c.guardOk }) : null
  const ages = withAges ? openAgeStore(dir, { now: c.now }) : null
  const logs = []
  const texts = []
  const opts = {
    association: iss.association,
    origin: ORIGIN,
    google: googleStub(),
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    terms,
    hodle,
    wallets,
    ages,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now
  }
  if (mode !== undefined) opts.walletMode = mode
  if (dailyLimit !== undefined) opts.walletDailyLimit = dailyLimit
  if (burst !== undefined) {
    opts.burst = burst
    opts.ratePerSecond = burst
  }
  const server = createAccountServer(opts)
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function api (method, pathname, body) {
    const init = { method, headers: {} }
    if (body !== undefined) {
      init.headers.origin = ORIGIN
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    texts.push(text)
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }
  const post = (pathname, body) => api('POST', pathname, body)
  const start = (who, action) => post('/account/wallet/start', { member: who.hex, action })
  const sign = (who, action, nonce, op) => signWallet({ action, nonce, member: who.hex, association: iss.association, opHash: opHash(op) }, who.kp)

  async function step (who, action, op = {}, extra = {}) {
    const started = await start(who, action)
    if (started.status !== 200) return started
    const nonce = started.body.nonce
    return post('/account/wallet/' + action, { member: who.hex, nonce, action, op, signature: sign(who, action, nonce, op), ...extra })
  }

  const seen = (method, p) => fake.seen.filter((r) => r.method === method && (typeof p === 'string' ? r.path === p : p.test(r.path)))
  const file = () => {
    try {
      return fs.readFileSync(path.join(dir, 'wallet.json'), 'utf8')
    } catch {
      return ''
    }
  }
  const entry = () => {
    const text = file()
    return text === '' ? null : (JSON.parse(text).members[m.hex] || null)
  }

  return { dir, c, iss, store, terms, ages, wallets, fake, m, server, logs, texts, api, post, start, sign, step, seen, file, entry }
}

function markReady (s) {
  for (const doc of s.fake.state.documents.values()) doc.ready = true
}

async function documents (t, s, who = s.m) {
  const doc = await s.step(who, 'kyc-document', { documentType: 'ID' })
  t.is(doc.status, 200, doc.text)
  const selfie = await s.step(who, 'kyc-document', { documentType: 'SELFIE-FROM-LIVENESS' })
  t.is(selfie.status, 200, selfie.text)
  return { doc, selfie }
}

async function approved (t, s) {
  const o = await s.step(s.m, 'optin', ADULT)
  t.is(o.status, 200, o.text)
  await documents(t, s)
  markReady(s)
  const sub = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.is(sub.status, 200, sub.text)
  const st = await s.step(s.m, 'status')
  t.is(st.status, 200, st.text)
  t.is(st.body.account.kyc.state, 'aprovado')
}

test('wallet: policy off and on, routes 503 when off', async (t) => {
  const off = await setup(t, { on: false })
  const p = await off.api('GET', '/account/wallet/policy')
  t.is(p.status, 200)
  t.alike(p.body, { available: false, network: null, mode: 'cadastro' })
  const st = await off.start(off.m, 'optin')
  t.is(st.status, 503)
  t.alike(st.body, { error: 'indisponivel' })
  const r = await off.post('/account/wallet/optin', { member: off.m.hex, nonce: 'A'.repeat(43), action: 'optin', op: {}, signature: 'a'.repeat(128) })
  t.is(r.status, 503)
  t.ok(off.logs.includes(JSON.stringify({ event: 'carteira', reason: 'desligada' })))

  const s = await setup(t)
  const on = await s.api('GET', '/account/wallet/policy')
  t.alike(on.body, { available: true, network: 'polygon', mode: 'cadastro' })
  t.ok(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'ligada' })))
})

test('wallet: C11 wallet-create is 404 in cadastro and exists in carteira', async (t) => {
  const s = await setup(t)
  const st = await s.start(s.m, 'wallet-create')
  t.is(st.status, 404)
  const r = await s.post('/account/wallet/wallet-create', { member: s.m.hex, nonce: 'A'.repeat(43), action: 'wallet-create', op: {}, signature: 'a'.repeat(128), pin: PIN })
  t.is(r.status, 404)
  const unknown = await s.start(s.m, 'payout')
  t.is(unknown.status, 404)

  const w = await setup(t, { mode: 'carteira' })
  const p = await w.api('GET', '/account/wallet/policy')
  t.is(p.body.mode, 'carteira')
  const ok = await w.start(w.m, 'wallet-create')
  t.is(ok.status, 200)
  t.ok(/^[A-Za-z0-9_-]{43}$/.test(ok.body.nonce))
})

test('wallet: start needs no proof; signed routes refuse bad proofs, unlinked members and missing terms', async (t) => {
  const s = await setup(t)
  const started = await s.start(s.m, 'status')
  t.is(started.status, 200)
  const nonce = started.body.nonce

  const missing = await s.post('/account/wallet/status', { member: s.m.hex, nonce, action: 'status', op: {} })
  t.is(missing.status, 400)
  t.alike(missing.body, { error: 'assinatura-invalida' })
  const forged = await s.post('/account/wallet/status', { member: s.m.hex, nonce, action: 'status', op: {}, signature: s.sign(member(), 'status', nonce, {}) })
  t.alike(forged.body, { error: 'assinatura-invalida' })
  // A failed signature does not consume the nonce; a verified request does.
  const valid = { member: s.m.hex, nonce, action: 'status', op: {}, signature: s.sign(s.m, 'status', nonce, {}) }
  const ok = await s.post('/account/wallet/status', valid)
  t.is(ok.status, 200, ok.text)
  const replay = await s.post('/account/wallet/status', valid)
  t.is(replay.status, 404)
  t.alike(replay.body, { error: 'expirado' })

  const other = member()
  const n1 = (await s.start(s.m, 'optin')).body.nonce
  const wrong = await s.post('/account/wallet/optin', { member: s.m.hex, nonce: n1, action: 'optin', op: {}, signature: s.sign(other, 'optin', n1, {}) })
  t.alike(wrong.body, { error: 'assinatura-invalida' })

  const n2 = (await s.start(s.m, 'kyc-document')).body.nonce
  const mismatch = await s.post('/account/wallet/kyc-document', { member: s.m.hex, nonce: n2, action: 'kyc-document', op: { documentType: 'PASSPORT' }, signature: s.sign(s.m, 'kyc-document', n2, { documentType: 'ID' }) })
  t.alike(mismatch.body, { error: 'assinatura-invalida' })

  // A nonce minted for one action does not serve another.
  const n3 = (await s.start(s.m, 'status')).body.nonce
  const crossed = await s.post('/account/wallet/optin', { member: s.m.hex, nonce: n3, action: 'optin', op: {}, signature: s.sign(s.m, 'optin', n3, {}) })
  t.alike(crossed.body, { error: 'expirado' })

  const stranger = member()
  const unlinked = await s.step(stranger, 'optin', ADULT)
  t.is(unlinked.status, 403)
  t.alike(unlinked.body, { error: 'nao-vinculado' })

  const fresh = member()
  await linkDirect(s.store, s.iss, fresh, 'bia')
  const noTerms = await s.step(fresh, 'optin', ADULT)
  t.is(noTerms.status, 409)
  t.alike(noTerms.body, { error: 'termos-pendentes' })
  await s.terms.accept({ member: fresh.hex, version: TERMS_VERSION - 1, nonce: 'm'.repeat(43), signature: 'c'.repeat(128) })
  const oldTerms = await s.step(fresh, 'optin', ADULT)
  t.alike(oldTerms.body, { error: 'termos-pendentes' })

  t.is(s.fake.seen.length, 0, 'Hodle never called')
})

test('wallet: optin twice and concurrently makes one subaccount', async (t) => {
  const s = await setup(t)
  const [a, b] = await Promise.all([s.step(s.m, 'optin', ADULT), s.step(s.m, 'optin', ADULT)])
  t.is(a.status, 200, a.text)
  t.is(b.status, 200, b.text)
  const again = await s.step(s.m, 'optin', ADULT)
  t.is(again.status, 200)
  t.is(s.seen('POST', '/api/subaccount').length, 1)
  t.is(s.seen('POST', '/api/subaccount')[0].body.name, 'membro-' + s.m.hex.slice(0, 32))
  t.is(s.seen('POST', '/api/subaccount')[0].body.name.length, 39)
  t.alike(again.body.account, {
    kyc: { state: 'documentos', attempt: 1 },
    network: 'polygon',
    address: null,
    wallet: null,
    walletUncertain: false,
    subaccountUncertain: false,
    documentReady: false,
    selfieReady: false
  })
  t.ok(s.entry().subAccountId)
})

test('wallet: a 16-17 band is refused before any call', async (t) => {
  const s = await setup(t, { withAges: true })
  await s.ages.record({ member: s.m.hex, band: '16-17', method: 'didit' })
  const r = await s.step(s.m, 'optin', ADULT)
  t.is(r.status, 403)
  t.alike(r.body, { error: 'idade-minima' })
  t.is(s.fake.seen.length, 0)
  t.is(s.entry(), null)
})

test('wallet: kyc-document URLs go only to the prover', async (t) => {
  const s = await setup(t)
  const before = await s.step(s.m, 'kyc-document', { documentType: 'ID' })
  t.is(before.status, 403)
  t.alike(before.body, { error: 'carteira-pendente' })
  await s.step(s.m, 'optin', ADULT)
  const bad = await s.step(s.m, 'kyc-document', { documentType: 'ID', isDoubleSided: 2 })
  t.alike(bad.body, { error: 'pedido-invalido' })
  const doc = await s.step(s.m, 'kyc-document', { documentType: 'ID', isDoubleSided: 1 })
  t.is(doc.status, 200, doc.text)
  t.ok(doc.body.uploadUrlFront.startsWith('https://uploads.hodle.com.br/'))
  t.ok(doc.body.uploadUrlBack.startsWith('https://uploads.hodle.com.br/'))
  t.is(s.seen('POST', '/api/kyc/document')[0].body.isDoubleSided, true)
  const selfie = await s.step(s.m, 'kyc-document', { documentType: 'SELFIE-FROM-LIVENESS' })
  t.ok(selfie.body.livenessUrl.startsWith('https://app.hodle.com.br/'))
  const e = s.entry()
  t.is(e.kyc.documentId, doc.body.documentId)
  t.is(e.kyc.selfieId, selfie.body.documentId)
  t.is(e.kyc.status, 'documentos')
  const logs = s.logs.join('\n')
  t.absent(logs.includes('hodle.com.br'), 'no URL in a log line')
  t.absent(s.file().includes('hodle.com.br'), 'no URL in wallet.json')
})

test('wallet: kyc-submit needs ready documents and the signed hash; the CPF reaches only Hodle', async (t) => {
  const s = await setup(t)
  await s.step(s.m, 'optin', ADULT)
  await documents(t, s)
  const early = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.is(early.status, 409)
  t.alike(early.body, { error: 'documentos-pendentes' })
  markReady(s)
  // A not-ready answer is cached for 20 s.
  const cached = await s.step(s.m, 'status')
  t.is(cached.body.account.documentReady, false)
  s.c.offset += 21 * 1000
  const st = await s.step(s.m, 'status')
  t.is(st.body.account.documentReady, true)
  t.is(st.body.account.selfieReady, true)

  const changed = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: { ...KYC, city: 'Campinas' } })
  t.alike(changed.body, { error: 'assinatura-invalida' })
  const young = { ...KYC, dateOfBirth: new Date(Date.now() - 17 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10) }
  const minor = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(young) }, { kyc: young })
  t.is(minor.status, 403)
  t.alike(minor.body, { error: 'idade-minima' })
  const badCpf = { ...KYC, taxIdNumber: '529.982.247-25' }
  const formatted = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(badCpf) }, { kyc: badCpf })
  t.alike(formatted.body, { error: 'pedido-invalido' })
  t.is(s.seen('POST', '/api/kyc').length, 0)

  const ok = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.is(ok.status, 200, ok.text)
  t.is(ok.body.account.kyc.state, 'pendente')
  const sent = s.seen('POST', '/api/kyc')
  t.is(sent.length, 1)
  t.is(sent[0].body.taxIdNumber, KYC.taxIdNumber)
  t.is(sent[0].body.country, 'BRA')
  t.is(s.entry().kyc.status, 'pendente')
  t.ok(s.entry().kyc.attemptId)
  const exposed = s.file() + '\n' + s.logs.join('\n') + '\n' + s.texts.join('\n')
  for (const value of [KYC.taxIdNumber, KYC.fullName, KYC.email, KYC.streetAddress, KYC.dateOfBirth, KYC.zipCode]) {
    t.absent(exposed.includes(value), 'personal field kept out of the file, logs and answers')
  }
})

test('wallet: status reads the KYC result at most once per 20 s and persists aprovado', async (t) => {
  const s = await setup(t)
  let status = 'PENDING'
  s.fake.script({
    kycStatus (req, res, ctx) {
      ctx.json(res, 200, { success: true, data: { attemptId: ctx.id, status } })
    }
  })
  await s.step(s.m, 'optin', ADULT)
  await documents(t, s)
  markReady(s)
  await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  const reads = () => s.seen('GET', /^\/api\/kyc\/att_/).length
  await s.step(s.m, 'status')
  await s.step(s.m, 'status')
  t.is(reads(), 1)
  status = 'APPROVED'
  const still = await s.step(s.m, 'status')
  t.is(still.body.account.kyc.state, 'pendente')
  t.is(reads(), 1)
  s.c.offset += 21 * 1000
  const now = await s.step(s.m, 'status')
  t.is(reads(), 2)
  t.is(now.body.account.kyc.state, 'aprovado')
  t.is(s.entry().kyc.status, 'aprovado')
  await s.step(s.m, 'status')
  t.is(reads(), 2, 'no read once approved')
})

test('wallet: wallet-create once, the PIN never kept, logged or echoed', async (t) => {
  const s = await setup(t, { mode: 'carteira' })
  const none = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  t.alike(none.body, { error: 'carteira-pendente' })
  await s.step(s.m, 'optin', ADULT)
  const pending = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  t.is(pending.status, 409)
  t.alike(pending.body, { error: 'kyc-pendente' })
  await approved(t, s)
  for (const pin of [undefined, '12345', '1234567', 'abcdef', 123456, '111111', '123456', '345678', '987654', '012345', '٤٨٢٩١٥']) {
    const bad = await s.step(s.m, 'wallet-create', {}, pin === undefined ? {} : { pin })
    t.is(bad.status, 400)
    t.alike(bad.body, { error: 'pin-invalido' })
  }
  const [a, b] = await Promise.all([
    s.step(s.m, 'wallet-create', {}, { pin: PIN }),
    s.step(s.m, 'wallet-create', {}, { pin: PIN })
  ])
  t.is(a.status, 200, a.text)
  t.is(b.status, 200, b.text)
  t.ok(/^0x[0-9a-f]{40}$/.test(a.body.address))
  t.is(b.body.address, a.body.address)
  const again = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  t.is(again.body.address, a.body.address)
  t.is(s.seen('POST', '/api/wallet/create').length, 1)
  t.is(s.fake.state.walletCreates, 1)
  const e = s.entry()
  t.is(e.wallet.address, a.body.address)
  t.ok(e.wallet.id)
  t.is(e.walletUncertain, false)
  const st = await s.step(s.m, 'status')
  t.alike(st.body.account.wallet, { address: a.body.address })
  t.is(st.body.account.address, a.body.address)
  for (const text of [s.file(), s.logs.join('\n'), s.texts.join('\n')]) {
    t.absent(text.includes(PIN), 'no PIN')
  }
  t.absent(s.texts.join('\n').includes('psk-fake-hodle'), 'no wrapped key in an answer')
})

test('wallet: kyc-recusado and C14 new attempt', async (t) => {
  const s = await setup(t, { mode: 'carteira' })
  s.fake.script({
    kycStatus (req, res, ctx) {
      ctx.json(res, 200, { success: true, data: { attemptId: ctx.id, status: 'REJECTED' } })
    }
  })
  await s.step(s.m, 'optin', ADULT)
  await documents(t, s)
  markReady(s)
  await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  const st = await s.step(s.m, 'status')
  t.alike(st.body.account.kyc, { state: 'recusado', attempt: 1 })
  const refused = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  t.is(refused.status, 403)
  t.alike(refused.body, { error: 'kyc-recusado' })
  const again = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.alike(again.body, { error: 'documentos-pendentes' })

  const doc = await s.step(s.m, 'kyc-document', { documentType: 'ID' })
  t.is(doc.status, 200)
  const e = s.entry()
  t.is(e.kyc.attempt, 2)
  t.is(e.kyc.status, 'documentos')
  t.is(e.kyc.selfieId, null)
  t.is(e.kyc.attemptId, null)
  const st2 = await s.step(s.m, 'status')
  t.alike(st2.body.account.kyc, { state: 'documentos', attempt: 2 })
  t.is(st2.body.account.selfieReady, false)
})

test('wallet: a 5xx on create is resultado-incerto and a later read adopts the wallet (C13)', async (t) => {
  const s = await setup(t, { mode: 'carteira' })
  await approved(t, s)
  let created = null
  s.fake.script({
    walletCreate (req, res, ctx) {
      const { subAccountId } = ctx.body
      created = { id: 'w' + nodeCrypto.randomBytes(8).toString('hex'), address: '0x' + nodeCrypto.randomBytes(20).toString('hex'), network: 'polygon', protectedSymmetricKey: 'psk-lost-answer' }
      s.fake.state.wallets.set(subAccountId, [created])
      ctx.json(res, 500, { success: false, error: 'boom' })
    }
  })
  const r = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  t.is(r.status, 503)
  t.alike(r.body, { error: 'resultado-incerto' })
  t.is(s.entry().walletUncertain, true)
  t.ok(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'hodle-carteira-http-500' })))
  const st = await s.step(s.m, 'status')
  t.is(st.body.account.walletUncertain, true)
  t.is(st.body.account.wallet, null)

  const adopt = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  t.is(adopt.status, 200, adopt.text)
  t.is(adopt.body.address, created.address)
  t.is(s.seen('POST', '/api/wallet/create').length, 1, 'never created again')
  t.is(s.seen('POST', '/api/wallet/keys').length, 1)
  const checks = s.seen('POST', '/api/wallet/get').filter((q) => q.body.walletId === created.id)
  t.is(checks.length, 1, 'the walletId from wallet/keys is checked with wallet/get')
  const e = s.entry()
  t.is(e.wallet.id, created.id)
  t.is(e.wallet.address, created.address)
  t.is(e.walletUncertain, false)
  t.absent(s.file().includes(PIN))
})

test('wallet: an uncertain create with no wallet at Hodle stays frozen (C12)', async (t) => {
  const s = await setup(t, { mode: 'carteira', timeoutMs: 300 })
  await approved(t, s)
  s.fake.script({ walletCreate () {} })
  const r = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  t.alike(r.body, { error: 'resultado-incerto' })
  t.is(s.entry().walletUncertain, true)
  s.fake.script({})
  for (let i = 0; i < 2; i++) {
    const again = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
    t.is(again.status, 503)
    t.alike(again.body, { error: 'carteira-incerta' })
  }
  t.is(s.seen('POST', '/api/wallet/create').length, 1, 'never created again')
  t.is(s.entry().walletUncertain, true)
})

test('wallet: a 4xx on create is indisponivel and clears the marker; 403 logs pin-plataforma', async (t) => {
  const s = await setup(t, { mode: 'carteira' })
  await approved(t, s)
  s.fake.script({
    walletCreate (req, res, ctx) {
      ctx.json(res, 403, { success: false, error: 'Forbidden' })
    }
  })
  const r = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  t.is(r.status, 503)
  t.alike(r.body, { error: 'indisponivel' })
  t.is(s.entry().walletUncertain, false)
  t.ok(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'pin-plataforma' })))
  s.fake.script({
    walletCreate (req, res, ctx) {
      ctx.json(res, 400, { success: false, error: 'Bad' })
    }
  })
  const r2 = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  t.alike(r2.body, { error: 'indisponivel' })
  t.is(s.entry().walletUncertain, false)
  t.is(s.entry().wallet, null)
})

test('wallet: a lost createSubaccount freezes the member until a lookup finds exactly one (C12)', async (t) => {
  const s = await setup(t, { timeoutMs: 300 })
  s.fake.script({ createSubaccount () {} })
  const r = await s.step(s.m, 'optin', ADULT)
  t.is(r.status, 503)
  t.alike(r.body, { error: 'resultado-incerto' })
  const e = s.entry()
  t.is(e.subAccountId, null)
  t.is(e.subaccountUncertain, true)
  s.fake.script({})

  const st = await s.step(s.m, 'status')
  t.is(st.status, 200, st.text)
  t.alike(st.body.account, {
    kyc: { state: 'documentos', attempt: 0 },
    network: 'polygon',
    address: null,
    wallet: null,
    walletUncertain: false,
    subaccountUncertain: true,
    documentReady: false,
    selfieReady: false
  })
  const again = await s.step(s.m, 'optin', ADULT)
  t.is(again.status, 503)
  t.alike(again.body, { error: 'carteira-incerta' })
  const doc = await s.step(s.m, 'kyc-document', { documentType: 'ID' })
  t.alike(doc.body, { error: 'carteira-incerta' })
  t.is(s.seen('POST', '/api/subaccount').length, 1, 'never created again')

  // Two subaccounts under the name stay ambiguous.
  s.fake.state.subaccounts.set('sub-one', { name: 'membro-' + s.m.hex.slice(0, 32) })
  s.fake.state.subaccounts.set('sub-two', { name: 'membro-' + s.m.hex.slice(0, 32) })
  const two = await s.step(s.m, 'status')
  t.is(two.body.account.subaccountUncertain, true)
  s.fake.state.subaccounts.delete('sub-two')
  const one = await s.step(s.m, 'status')
  t.is(one.body.account.subaccountUncertain, false)
  t.is(one.body.account.kyc.attempt, 1)
  t.is(s.entry().subAccountId, 'sub-one')
  t.is(s.entry().subaccountUncertain, false)
  t.is(s.seen('POST', '/api/subaccount').length, 1)
})

test('wallet: a 4xx on createSubaccount clears the intent so opt-in can run again', async (t) => {
  const s = await setup(t)
  s.fake.script({
    createSubaccount (req, res, ctx) {
      ctx.json(res, 400, { success: false, error: 'Validation failed' })
    }
  })
  const r = await s.step(s.m, 'optin', ADULT)
  t.alike(r.body, { error: 'indisponivel' })
  t.is(s.entry().subaccountUncertain, false)
  const st = await s.step(s.m, 'status')
  t.alike(st.body, { account: null })
  s.fake.script({})
  const ok = await s.step(s.m, 'optin', ADULT)
  t.is(ok.status, 200, ok.text)
})

test('wallet: the shared daily ceiling refuses before the member window and logs teto-diario', async (t) => {
  const s = await setup(t, { dailyLimit: 1 })
  const ok = await s.step(s.m, 'optin', ADULT)
  t.is(ok.status, 200)
  const other = member()
  await linkDirect(s.store, s.iss, other, 'caio')
  await s.terms.accept({ member: other.hex, version: TERMS_VERSION, nonce: 'o'.repeat(43), signature: 'd'.repeat(128) })
  const full = await s.step(other, 'optin', ADULT)
  t.is(full.status, 503)
  t.alike(full.body, { error: 'indisponivel' })
  t.ok(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'teto-diario' })))
  t.is(s.seen('POST', '/api/subaccount').length, 1)
})

test('wallet: C16 canonical JSON matches the app vector', async (t) => {
  const input = Object.freeze({ z: 'fim', á: 'ação', a: 'linha\n"aspas"', 2: 'dois', 10: 'dez', '😀': 'rosto', '': 'privado' })
  const expected = '{"10":"dez","2":"dois","a":"linha\\n\\"aspas\\"","z":"fim","á":"ação","😀":"rosto","":"privado"}'
  const hash = '000885f86d0a62f19f7a29a0d3ab17994d8316253310494a9fd57f7780717333'
  t.is(canonicalJson(input), expected)
  t.is(kycHash(input), hash)
})

test('wallet: log lines carry only the carteira event and a token', async (t) => {
  const s = await setup(t, { mode: 'carteira' })
  await approved(t, s)
  await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  for (const line of s.logs) {
    const e = JSON.parse(line)
    if (e.event === 'carteira') {
      t.alike(Object.keys(e).sort(), ['event', 'reason'])
      t.ok(/^[a-z0-9-]{1,64}$/.test(e.reason), e.reason)
    }
  }
  t.absent(s.logs.join('\n').includes(API_KEY))
})

test('wallet: a failed write after Hodle accepted is resultado-incerto for every action', async (t) => {
  const storage = JSON.stringify({ event: 'carteira', reason: 'armazenamento-indisponivel' })

  const a = await setup(t)
  a.c.failAfter = 'POST /api/subaccount'
  const optin = await a.step(a.m, 'optin', ADULT)
  t.is(optin.status, 503)
  t.alike(optin.body, { error: 'resultado-incerto' }, 'optin')
  t.ok(a.logs.includes(storage))
  t.is(a.entry().subaccountUncertain, true, 'the intent stays on disk')

  const b = await setup(t)
  await b.step(b.m, 'optin', ADULT)
  b.c.failAfter = 'POST /api/kyc/document'
  const doc = await b.step(b.m, 'kyc-document', { documentType: 'ID' })
  t.alike(doc.body, { error: 'resultado-incerto' }, 'kyc-document')
  t.ok(b.logs.includes(storage))

  const c = await setup(t)
  await c.step(c.m, 'optin', ADULT)
  await documents(t, c)
  markReady(c)
  c.c.failAfter = 'POST /api/kyc'
  const sub = await c.step(c.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.alike(sub.body, { error: 'resultado-incerto' }, 'kyc-submit')
  t.ok(c.logs.includes(storage))

  const d = await setup(t, { mode: 'carteira' })
  await approved(t, d)
  d.c.failAfter = 'POST /api/wallet/create'
  const create = await d.step(d.m, 'wallet-create', {}, { pin: PIN })
  t.alike(create.body, { error: 'resultado-incerto' }, 'wallet-create')
  t.ok(d.logs.includes(storage))
  t.is(d.entry().walletUncertain, true, 'the marker stays on disk')
})

test('wallet: one network source, a differing walletNetwork throws', async (t) => {
  const fake = await startFakeHodle()
  t.teardown(() => fake.close(), { force: true })
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const hodle = createHodle({ apiKey: API_KEY, network: 'base', endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base) })
  const base = {
    association: iss.association,
    origin: ORIGIN,
    google: googleStub(),
    store: openAccountStore(dir),
    hodle,
    wallets: openWalletStore(dir)
  }
  t.exception.all(() => createAccountServer({ ...base, walletNetwork: 'polygon' }), /walletNetwork/)
  const server = createAccountServer({ ...base, walletNetwork: 'base' })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const res = await fetch('http://127.0.0.1:' + listener.port + '/account/wallet/policy')
  t.alike(await res.json(), { available: true, network: 'base', mode: 'cadastro' })
  const plain = createAccountServer(base)
  t.ok(plain)
})

test('wallet: optin requires the signed 18+ declaration before any call', async (t) => {
  const s = await setup(t)
  for (const op of [{}, { adult: 0 }, { adult: '1' }]) {
    const r = await s.step(s.m, 'optin', op)
    t.is(r.status, 403)
    t.alike(r.body, { error: 'idade-minima' }, JSON.stringify(op))
  }
  const extra = await s.step(s.m, 'optin', { adult: 1, other: 1 })
  t.alike(extra.body, { error: 'pedido-invalido' })
  t.is(s.fake.seen.length, 0)
  t.is(s.entry(), null)
})

test('wallet: the 18th birthday counts on the Brasilia calendar', async (t) => {
  const s = await setup(t)
  await s.step(s.m, 'optin', ADULT)
  await documents(t, s)
  markReady(s)
  const born = { ...KYC, dateOfBirth: '2008-10-31' }
  s.c.offset = Date.parse('2026-10-31T02:00:00.000Z') - Date.now()
  const early = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(born) }, { kyc: born })
  t.is(early.status, 403)
  t.alike(early.body, { error: 'idade-minima' })
  s.c.offset = Date.parse('2026-10-31T03:00:00.000Z') - Date.now()
  const ok = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(born) }, { kyc: born })
  t.is(ok.status, 200, ok.text)
})

test('wallet: a lost KYC submission stays pendente, is never resent and is found by kycLatest', async (t) => {
  const s = await setup(t, { timeoutMs: 300 })
  await s.step(s.m, 'optin', ADULT)
  await documents(t, s)
  markReady(s)
  let latest = true
  s.fake.script({
    kycSubmit (req, res, ctx) {
      s.fake.state.kyc.set('att_lost1', { subAccountId: ctx.body.subAccountId, status: 'APPROVED' })
    },
    kycLatest (req, res, ctx) {
      ctx.json(res, 200, { success: true, data: { lastAttemptId: latest ? null : 'att_lost1' } })
    }
  })
  const r = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.is(r.status, 503)
  t.alike(r.body, { error: 'resultado-incerto' })
  t.is(s.entry().kyc.status, 'pendente')
  t.is(s.entry().kyc.attemptId, null)
  const again = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.is(again.status, 409)
  t.alike(again.body, { error: 'kyc-pendente' })
  t.is(s.seen('POST', '/api/kyc').length, 1, 'the personal data is sent once')

  const lookups = () => s.seen('GET', '/api/kyc').length
  const fresh = await s.step(s.m, 'status')
  t.is(fresh.body.account.kyc.state, 'pendente')
  t.is(lookups(), 0, 'no lookup while the intent is younger than 60 s')
  s.c.offset += 61 * 1000
  const st1 = await s.step(s.m, 'status')
  t.is(st1.body.account.kyc.state, 'pendente')
  await s.step(s.m, 'status')
  t.is(lookups(), 1, 'at most one lookup per 20 s')
  latest = false
  s.c.offset += 21 * 1000
  const st2 = await s.step(s.m, 'status')
  t.is(lookups(), 2)
  t.is(s.entry().kyc.attemptId, 'att_lost1')
  t.is(st2.body.account.kyc.state, 'aprovado')
  t.is(s.entry().kyc.status, 'aprovado')
})

test('wallet: a definite refusal of the KYC submission ends the attempt', async (t) => {
  const s = await setup(t)
  await s.step(s.m, 'optin', ADULT)
  await documents(t, s)
  markReady(s)
  s.fake.script({
    kycSubmit (req, res, ctx) {
      ctx.json(res, 400, { success: false, error: 'Validation failed' })
    }
  })
  const r = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.alike(r.body, { error: 'indisponivel' })
  t.is(s.entry().kyc.status, 'recusado')
  s.fake.script({})
  const doc = await s.step(s.m, 'kyc-document', { documentType: 'ID' })
  t.is(doc.status, 200)
  t.is(s.entry().kyc.attempt, 2)
})

// Attempt 1 rejected, attempt 2 documents uploaded and ready.
async function secondAttempt (t, s) {
  s.fake.script({
    kycStatus (req, res, ctx) {
      ctx.json(res, 200, { success: true, data: { attemptId: ctx.id, status: 'REJECTED' } })
    }
  })
  await s.step(s.m, 'optin', ADULT)
  await documents(t, s)
  markReady(s)
  await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  const st = await s.step(s.m, 'status')
  t.alike(st.body.account.kyc, { state: 'recusado', attempt: 1 })
  for (const attempt of s.fake.state.kyc.values()) attempt.status = 'REJECTED'
  s.fake.script({})
  await documents(t, s)
  markReady(s)
  t.is(s.entry().kyc.attempt, 2)
}

test('wallet: a lost second submission never adopts the rejected first attempt', async (t) => {
  const s = await setup(t, { timeoutMs: 300 })
  await secondAttempt(t, s)
  s.fake.script({ kycSubmit () {} })
  const r = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.alike(r.body, { error: 'resultado-incerto' })
  s.fake.script({})
  s.c.offset += 61 * 1000
  const st = await s.step(s.m, 'status')
  t.is(s.seen('GET', '/api/kyc').length, 1)
  t.alike(st.body.account.kyc, { state: 'pendente', attempt: 2 })
  t.is(s.entry().kyc.status, 'pendente')
  t.is(s.entry().kyc.attemptId, null)
  t.is(s.entry().kyc.attempt, 2)
  t.ok(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'kyc-incerto' })))
})

test('wallet: status never looks the attempt up while the submit is in flight', async (t) => {
  const s = await setup(t)
  await secondAttempt(t, s)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  s.fake.script({
    async kycSubmit (req, res, ctx) {
      await gate
      s.fake.state.kyc.set('att_new2', { subAccountId: ctx.body.subAccountId, status: 'PENDING' })
      ctx.json(res, 202, { success: true, data: { attemptId: 'att_new2', status: 'PENDING' } })
    }
  })
  const submit = s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  for (let i = 0; i < 200 && s.seen('POST', '/api/kyc').length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  s.c.offset += 61 * 1000
  const st = await s.step(s.m, 'status')
  t.alike(st.body.account.kyc, { state: 'pendente', attempt: 2 })
  t.is(s.seen('GET', '/api/kyc').length, 0, 'no lookup during the submit')
  release()
  const done = await submit
  t.is(done.status, 200, done.text)
  t.is(s.entry().kyc.attemptId, 'att_new2')
  t.is(s.entry().kyc.status, 'pendente')
  t.is(s.entry().kyc.attempt, 2)
})

test('wallet: wallet-create refuses an entry opened on another network', async (t) => {
  const s = await setup(t, { mode: 'carteira' })
  await approved(t, s)
  const hodle = createHodle({ apiKey: API_KEY, network: 'base', endpoints: { base: s.fake.base }, fetch: loopbackFetch(s.fake.base) })
  const logs = []
  const server = createAccountServer({
    association: s.iss.association,
    origin: ORIGIN,
    google: googleStub(),
    store: s.store,
    terms: s.terms,
    hodle,
    wallets: openWalletStore(s.dir, { now: s.c.now }),
    walletMode: 'carteira',
    log: (e) => logs.push(JSON.stringify(e)),
    now: s.c.now
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  const nonce = (await post('/account/wallet/start', { member: s.m.hex, action: 'wallet-create' })).body.nonce
  const r = await post('/account/wallet/wallet-create', { member: s.m.hex, nonce, action: 'wallet-create', op: {}, signature: s.sign(s.m, 'wallet-create', nonce, {}), pin: PIN })
  t.is(r.status, 409)
  t.alike(r.body, { error: 'rede-divergente' })
  t.ok(logs.includes(JSON.stringify({ event: 'carteira', reason: 'rede-divergente' })))
  t.is(s.seen('POST', '/api/wallet/create').length, 0)
  t.is(s.seen('POST', '/api/wallet/get').length, 0)
  t.is(s.entry().network, 'polygon')
  t.is(s.entry().walletUncertain, false)
})

const signedStatus = (s, who, nonce) => s.post('/account/wallet/status', { member: who.hex, nonce, action: 'status', op: {}, signature: s.sign(who, 'status', nonce, {}) })

test('wallet: start keeps no state, so a flood of random keys changes nothing for others', async (t) => {
  const s = await setup(t, { burst: 5000 })
  const kept = (await s.start(s.m, 'status')).body.nonce
  let refused = 0
  for (let i = 0; i < 1100; i++) if ((await s.start(member(), 'status')).status !== 200) refused++
  t.is(refused, 0, 'never refused by a table')
  t.is((await s.start(s.m, 'status')).status, 200, 'the member can still start')
  t.is((await signedStatus(s, s.m, kept)).status, 200, 'the earlier token still works')
}, { timeout: 60000 })

test('wallet: starts in a victim name never invalidate or rate limit the victim', async (t) => {
  const s = await setup(t, { burst: 5000 })
  const kept = (await s.start(s.m, 'status')).body.nonce
  for (let i = 0; i < 200; i++) {
    const r = await s.start(s.m, 'status')
    if (r.status !== 200) return t.fail('start refused after ' + i)
  }
  t.is((await signedStatus(s, s.m, kept)).status, 200, 'the earliest token still works')
})

test('wallet: a token works only for its member and action, before it expires', async (t) => {
  const s = await setup(t)
  const other = member()
  await linkDirect(s.store, s.iss, other, 'dora')
  await s.terms.accept({ member: other.hex, version: TERMS_VERSION, nonce: 'p'.repeat(43), signature: 'e'.repeat(128) })
  const forA = (await s.start(s.m, 'status')).body.nonce
  t.alike((await signedStatus(s, other, forA)).body, { error: 'expirado' }, 'another member')
  const forX = (await s.start(s.m, 'optin')).body.nonce
  t.alike((await signedStatus(s, s.m, forX)).body, { error: 'expirado' }, 'another action')
  const old = (await s.start(s.m, 'status')).body.nonce
  s.c.offset += 601 * 1000
  t.alike((await signedStatus(s, s.m, old)).body, { error: 'expirado' }, 'expired')
  const flipped = forA.slice(0, 20) + (forA[20] === 'A' ? 'B' : 'A') + forA.slice(21)
  t.alike((await signedStatus(s, s.m, flipped)).body, { error: 'expirado' }, 'tampered')
  t.alike((await signedStatus(s, s.m, 'A'.repeat(43))).body, { error: 'expirado' }, 'forged')
  t.is((await signedStatus(s, other, (await s.start(other, 'status')).body.nonce)).status, 200)
})

test('wallet: a token from a previous server instance fails', async (t) => {
  const s = await setup(t)
  const nonce = (await s.start(s.m, 'status')).body.nonce
  const hodle = createHodle({ apiKey: API_KEY, endpoints: { base: s.fake.base }, fetch: loopbackFetch(s.fake.base) })
  const server = createAccountServer({
    association: s.iss.association,
    origin: ORIGIN,
    google: googleStub(),
    store: s.store,
    terms: s.terms,
    hodle,
    wallets: openWalletStore(s.dir, { now: s.c.now }),
    now: s.c.now
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const res = await fetch('http://127.0.0.1:' + listener.port + '/account/wallet/status', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ member: s.m.hex, nonce, action: 'status', op: {}, signature: s.sign(s.m, 'status', nonce, {}) })
  })
  t.is(res.status, 404)
  t.alike(await res.json(), { error: 'expirado' })
  t.is((await signedStatus(s, s.m, nonce)).status, 200, 'the minting instance still accepts it')
})

test('wallet: an unlinked key with a valid signature allocates no spent entry', async (t) => {
  const s = await setup(t)
  const stranger = member()
  const nonce = (await s.start(stranger, 'status')).body.nonce
  const before = s.server.walletStats().spent
  const r = await signedStatus(s, stranger, nonce)
  t.is(r.status, 403)
  t.alike(r.body, { error: 'nao-vinculado' })
  t.is(s.server.walletStats().spent, before, 'spent unchanged')
  // The token is bound to the stranger's key: a linked member cannot use it.
  t.alike((await signedStatus(s, s.m, nonce)).body, { error: 'expirado' })
  const ok = await signedStatus(s, s.m, (await s.start(s.m, 'status')).body.nonce)
  t.is(ok.status, 200)
  t.is(s.server.walletStats().spent, before + 1, 'a linked member allocates one')
})

async function readyToSubmit (t, s) {
  await s.step(s.m, 'optin', ADULT)
  await documents(t, s)
  markReady(s)
  return s.entry().kyc
}

test('wallet: a rate-limited or key-refused KYC submit goes back to documentos with the uploads', async (t) => {
  for (const [code, token] of [[429, 'limite-carteira'], [401, 'indisponivel'], [403, 'indisponivel']]) {
    const s = await setup(t)
    const before = await readyToSubmit(t, s)
    s.fake.script({
      kycSubmit (req, res, ctx) {
        ctx.json(res, code, { success: false, error: 'no' })
      }
    })
    const r = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
    t.alike(r.body, { error: token }, String(code))
    const k = s.entry().kyc
    t.is(k.status, 'documentos', String(code))
    t.is(k.attempt, 1)
    t.is(k.documentId, before.documentId)
    t.is(k.selfieId, before.selfieId)
    t.ok(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'hodle-kyc-http-' + code })))
    s.fake.script({})
    const again = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
    t.is(again.status, 200, again.text)
    t.is(s.seen('POST', '/api/kyc/document').length, 2, 'no new upload needed')
  }
})

test('wallet: a 422 refusal of the KYC submit ends the attempt', async (t) => {
  const s = await setup(t)
  await readyToSubmit(t, s)
  s.fake.script({
    kycSubmit (req, res, ctx) {
      ctx.json(res, 422, { success: false, error: 'bad' })
    }
  })
  const r = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.alike(r.body, { error: 'indisponivel' })
  t.is(s.entry().kyc.status, 'recusado')
})
