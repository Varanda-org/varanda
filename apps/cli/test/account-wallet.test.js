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
const { openWalletOpsStore, externalIdFor } = require('../lib/account/wallet-ops-store')
const { parseFees, feeReference } = require('../lib/account/fees')
const { createHodle, MAX_TRANSFER_CENTS } = require('../lib/account/hodle')
const { advanceOp } = require('../lib/account/wallet-webhook')
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
async function setup (t, { on = true, mode, dailyLimit, timeoutMs, withAges = false, burst, fees, maxCents, moneyTimeoutMs } = {}) {
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
  // A payout concludes at once unless a test says otherwise: the Varanda fee
  // is charged only on a concluded payout (S12).
  fake.state.payoutStatus = 'COMPLETED'
  const loopback = loopbackFetch(fake.base)
  const hodleFetch = async (url, init) => {
    const res = await loopback(url, init)
    if (c.failAfter === init.method + ' ' + new URL(url).pathname) c.guardOk = false
    return res
  }
  const hodle = on ? createHodle({ apiKey: API_KEY, endpoints: { base: fake.base }, fetch: hodleFetch, ...(timeoutMs ? { timeoutMs } : {}) }) : null
  const wallets = on ? openWalletStore(dir, { now: c.now, guard: () => c.guardOk }) : null
  const ages = withAges ? openAgeStore(dir, { now: c.now }) : null
  const ops = on ? openWalletOpsStore(dir, { now: c.now }) : null
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
    ops,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now
  }
  if (fees !== undefined) opts.fees = fees
  if (maxCents !== undefined) opts.walletMaxCents = maxCents
  if (moneyTimeoutMs !== undefined) opts.walletMoneyTimeoutMs = moneyTimeoutMs
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

  const ledger = () => {
    try {
      return fs.readFileSync(path.join(dir, 'wallet-ops.json'), 'utf8')
    } catch {
      return ''
    }
  }

  return { dir, c, iss, store, terms, ages, wallets, ops, fake, m, server, logs, texts, api, post, start, sign, step, seen, file, entry, ledger }
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

// --- money (pix and completo) ------------------------------------------------

const TREASURY = '0x' + 'ab'.repeat(20)
const FEES = parseFees({ VARANDA_FEE_PAYOUT_CENTS: '50', VARANDA_FEE_PAYOUT_BPS: '100', VARANDA_FEE_TREASURY: TREASURY })
const PIX_KEY = 'fulana@example.test'
const BENEFICIARY_CPF = '39053344705'
const PAYER_CPF = '11144477735'

function opId () {
  return nodeCrypto.randomBytes(16).toString('base64url')
}

// An approved member with a wallet holding `cents` of BRLA.
async function funded (t, s, cents = 10000) {
  await approved(t, s)
  const w = await s.step(s.m, 'wallet-create', {}, { pin: PIN })
  t.is(w.status, 200, w.text)
  const sub = s.entry().subAccountId
  s.fake.state.balances.set(sub, cents)
  return sub
}

async function review (t, s, cents, extra = {}) {
  const q = await s.step(s.m, 'payout-quote', { cents, pixKey: PIX_KEY, pixKeyType: 'EMAIL', ...extra })
  t.is(q.status, 200, q.text)
  const p = await s.step(s.m, 'preview', { kind: 'payout', cents, quoteId: q.body.quoteId })
  t.is(p.status, 200, p.text)
  return { quote: q.body, preview: p.body }
}

function payoutOp (id, cents, quote, preview, extra = {}) {
  return {
    opId: id,
    cents,
    quoteId: quote.quoteId,
    pixKey: PIX_KEY,
    pixKeyType: 'EMAIL',
    feeCents: preview.varandaFeeCents,
    pendingFeeCents: preview.pendingFeeCents,
    pendingFeeRef: preview.pendingFeeRef,
    totalDebitCents: preview.totalDebitCents,
    ...extra
  }
}

async function pay (t, s, cents, { pin = PIN, extra = {}, id = opId() } = {}) {
  const { quote, preview } = await review(t, s, cents, extra)
  const op = payoutOp(id, cents, quote, preview, extra)
  return { op, quote, preview, r: await s.step(s.m, 'payout', op, { pin }) }
}

test('wallet money: actions are 404 outside pix and completo; policy adds the cap and fees', async (t) => {
  for (const mode of ['cadastro', 'carteira']) {
    const s = await setup(t, { mode })
    for (const action of ['balance', 'statement', 'deposit', 'payout-quote', 'preview', 'payout', 'op-status']) {
      t.is((await s.start(s.m, action)).status, 404, mode + ' start ' + action)
      const r = await s.post('/account/wallet/' + action, { member: s.m.hex, nonce: 'A'.repeat(43), action, op: {}, signature: 'a'.repeat(128), pin: PIN })
      t.is(r.status, 404, mode + ' ' + action)
    }
    const p = await s.api('GET', '/account/wallet/policy')
    t.alike(Object.keys(p.body).sort(), ['available', 'mode', 'network'])
  }
  const s = await setup(t, { mode: 'pix', fees: FEES, maxCents: 200000 })
  const p = await s.api('GET', '/account/wallet/policy')
  t.is(p.body.mode, 'pix')
  t.is(p.body.maxCents, 200000)
  t.is(p.body.fees.payout, 'R$ 0,50 + 1%')
  t.is(p.body.fees.transfer, 'sem taxa')
  t.is((await s.start(s.m, 'payout')).status, 200)
  const pending = await s.step(s.m, 'balance')
  t.alike(pending.body, { error: 'carteira-pendente' })
})

test('wallet money: balance verifies the stored wallet once and reports pending fees', async (t) => {
  const s = await setup(t, { mode: 'pix' })
  await funded(t, s, 12345)
  const b = await s.step(s.m, 'balance')
  t.is(b.status, 200, b.text)
  t.alike(b.body, { cents: 12345, address: s.entry().wallet.address, network: 'polygon', pendingFeeCents: 0 })
  await s.step(s.m, 'balance')
  const checks = s.seen('POST', '/api/wallet/get').filter((q) => q.body.walletId === s.entry().wallet.id && q.body.sync === false)
  t.is(checks.length, 1, 'one wallet/get check, then cached')
})

test('wallet money: a stored wallet Hodle does not confirm is carteira-incerta and moves nothing', async (t) => {
  const s = await setup(t, { mode: 'pix' })
  await funded(t, s)
  s.fake.script({
    walletGet (req, res, ctx) {
      ctx.json(res, 200, { success: true, data: { walletId: ctx.body.walletId, addresses: { polygon: '0x' + '12'.repeat(20) }, balances: [] } })
    }
  })
  const b = await s.step(s.m, 'balance')
  t.is(b.status, 503)
  t.alike(b.body, { error: 'carteira-incerta' })
  const d = await s.step(s.m, 'deposit', { opId: opId(), cents: 1000 })
  t.alike(d.body, { error: 'carteira-incerta' })
  t.is(s.seen('POST', '/api/deposit/asset').length, 0)
  t.is(s.ledger(), '')
})

test('wallet money: deposit is idempotent across a repeated opId and shows the partner fee (C15)', async (t) => {
  const s = await setup(t, { mode: 'pix' })
  await funded(t, s, 0)
  for (const cents of [99, 300001, '1000']) {
    const bad = await s.step(s.m, 'deposit', { opId: opId(), cents })
    t.alike(bad.body, { error: 'valor-invalido' }, String(cents))
  }
  const id = opId()
  const a = await s.step(s.m, 'deposit', { opId: id, cents: 5000, payerCpf: PAYER_CPF })
  t.is(a.status, 200, a.text)
  t.ok(/^var-[0-9a-f]{32}$/.test(a.body.externalId))
  t.ok(a.body.qrCode.length > 10)
  t.is(a.body.hodleFeeCents, 100)
  t.is(a.body.netCents, 4900)
  t.is(s.seen('POST', '/api/deposit/asset')[0].body.taxId, PAYER_CPF)
  t.is(s.seen('POST', '/api/deposit/asset')[0].body.address, s.entry().wallet.address)
  const b = await s.step(s.m, 'deposit', { opId: id, cents: 5000, payerCpf: PAYER_CPF })
  t.is(b.status, 200, b.text)
  t.is(b.body.externalId, a.body.externalId)
  t.is(b.body.qrCode, a.body.qrCode)
  t.is(s.fake.state.sends.deposit, 1, 'Hodle created one charge')
  t.is(s.seen('POST', '/api/deposit/asset')[1].body.externalId, a.body.externalId, 'the same externalId re-sent')
  const diverged = await s.step(s.m, 'deposit', { opId: id, cents: 6000 })
  t.alike(diverged.body, { error: 'operacao-divergente' })
  const row = s.ops.get(a.body.externalId)
  t.is(row.status, 'pendente')
  t.is(row.hodleFeeCents, 100)

  s.fake.settleDeposit(a.body.externalId)
  const st = await s.step(s.m, 'op-status', { externalId: a.body.externalId })
  t.is(st.status, 200, st.text)
  t.is(st.body.status, 'concluido')
  t.is(st.body.kind, 'deposit')
  t.is(st.body.externalId, a.body.externalId)
  for (const text of [s.file(), s.ledger(), s.logs.join('\n')]) t.absent(text.includes(PAYER_CPF), 'payer CPF never kept or logged')
  t.absent(s.ledger().includes(a.body.qrCode), 'no QR code in the ledger')
})

test('wallet money: deposit 4xx is falhou, 5xx is incerto and an explicit retry re-sends it', async (t) => {
  const s = await setup(t, { mode: 'pix' })
  await funded(t, s, 0)
  s.fake.script({
    deposit (req, res, ctx) {
      ctx.json(res, 403, { success: false, error: 'no', code: 'THIRD_PARTY_NOT_ENABLED' })
    }
  })
  const refused = await s.step(s.m, 'deposit', { opId: opId(), cents: 1000, payerCpf: PAYER_CPF })
  t.is(refused.status, 503)
  t.is(refused.body.error, 'indisponivel')
  t.is(s.ops.get(refused.body.externalId).status, 'falhou')
  t.ok(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'terceiros-desligado' })))

  s.fake.script({
    deposit (req, res, ctx) {
      s.fake.apply('deposit', ctx)
      ctx.json(res, 502, { success: false, error: 'gateway' })
    }
  })
  const id = opId()
  const lost = await s.step(s.m, 'deposit', { opId: id, cents: 1000 })
  t.is(lost.status, 503)
  t.is(lost.body.error, 'resultado-incerto')
  t.is(s.ops.get(lost.body.externalId).status, 'incerto')
  s.fake.script({})
  const again = await s.step(s.m, 'deposit', { opId: id, cents: 1000 })
  t.is(again.status, 200, again.text)
  t.is(again.body.externalId, lost.body.externalId)
  t.is(s.fake.state.sends.deposit, 1, 'the same charge, never a second one')
  t.is(s.ops.get(lost.body.externalId).status, 'pendente')
})

test('wallet money: a deposit 409 is reconciled by a status read, never falhou (C7)', async (t) => {
  const s = await setup(t, { mode: 'pix' })
  await funded(t, s, 0)
  s.fake.script({
    deposit (req, res, ctx) {
      s.fake.apply('deposit', ctx)
      ctx.json(res, 409, { success: false, error: 'A deposit with this externalId already exists' })
    }
  })
  const r = await s.step(s.m, 'deposit', { opId: opId(), cents: 2000 })
  t.is(r.status, 200, r.text)
  t.is(r.body.status, 'pendente')
  t.is(r.body.qrCode, null)
  t.is(s.ops.get(r.body.externalId).status, 'pendente')
  t.is(s.seen('GET', '/api/deposit/' + r.body.externalId).length, 1)
  s.fake.script({})

  // EXPIRED is not final: a late Pix still lands. FAILED keeps polling until REFUNDED.
  const dep = s.fake.state.deposits.get(r.body.externalId)
  dep.status = 'EXPIRED'
  t.is((await s.step(s.m, 'op-status', { externalId: r.body.externalId })).body.status, 'expirado')
  s.c.offset += 11 * 1000
  s.fake.settleDeposit(r.body.externalId)
  t.is((await s.step(s.m, 'op-status', { externalId: r.body.externalId })).body.status, 'concluido')

  const r2 = await s.step(s.m, 'deposit', { opId: opId(), cents: 2000 })
  const dep2 = s.fake.state.deposits.get(r2.body.externalId)
  dep2.status = 'FAILED'
  t.is((await s.step(s.m, 'op-status', { externalId: r2.body.externalId })).body.status, 'falhou')
  s.c.offset += 11 * 1000
  dep2.status = 'REFUNDED'
  t.is((await s.step(s.m, 'op-status', { externalId: r2.body.externalId })).body.status, 'devolvido')
})

test('wallet money: payout with quote and fee: one payout, then one transfer to the treasury (C2, C4)', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  const sub = await funded(t, s, 10000)
  const { op, quote, preview, r } = await pay(t, s, 5000, { extra: { beneficiaryCpf: BENEFICIARY_CPF } })
  t.alike(Object.keys(quote).sort(), ['bankName', 'expiresAt', 'feeCents', 'ownerName', 'quoteId', 'taxIdMasked'])
  t.is(quote.feeCents, 75)
  t.alike(preview, {
    amountCents: 5000,
    varandaFeeCents: 100,
    hodleFeeCents: 75,
    pendingFeeCents: 0,
    pendingFeeRef: '',
    totalDebitCents: 5175,
    netReceivedCents: 5000,
    ok: true,
    reason: null,
    reservedFeeCents: 0
  })
  t.is(r.status, 200, r.text)
  const externalId = r.body.externalId
  t.alike(r.body, { externalId, status: 'concluido', fee: { cents: 100, status: 'cobrada' }, pendingFee: null })

  const q = s.seen('POST', '/api/wallet/payout/beneficiary')[0].body
  t.is(q.subAccountId, sub)
  t.is(q.walletId, s.entry().wallet.id)
  t.is(q.taxId, BENEFICIARY_CPF)
  const sent = s.seen('POST', '/api/wallet/payout')
  t.is(sent.length, 1)
  t.is(sent[0].body.quoteId, quote.quoteId)
  t.is(sent[0].body.pixKey, undefined, 'pixKey comes from the quote')
  t.is(sent[0].body.pixKeyType, undefined)
  t.is(sent[0].body.taxId, BENEFICIARY_CPF)
  t.is(sent[0].body.externalId, externalId)
  const transfers = s.seen('POST', '/api/wallet/transfer')
  t.is(transfers.length, 1)
  t.is(transfers[0].body.reference, externalId + ':taxa')
  t.is(transfers[0].body.reference, feeReference(externalId))
  t.is(transfers[0].body.recipientAddress, TREASURY)
  t.is(transfers[0].body.amount, '1.00')
  t.ok(s.fake.seen.indexOf(sent[0]) < s.fake.seen.indexOf(transfers[0]), 'the fee leg runs after the principal')
  t.is(s.fake.state.sends.payout, 1)
  t.is(s.fake.state.sends.transfer, 1)
  t.is(s.fake.state.balances.get(sub), 10000 - 5175)
  const row = s.ops.get(externalId)
  t.is(row.status, 'concluido')
  t.is(row.fee.status, 'cobrada')
  t.ok(/^0x[0-9a-f]{64}$/.test(row.fee.txHash))
  t.is(row.to, '***test')
  t.is(row.totalDebitCents, 5175)

  // The same tap again answers what is stored and sends nothing (C10).
  const again = await s.step(s.m, 'payout', op, { pin: PIN })
  t.is(again.status, 200, again.text)
  t.is(again.body.externalId, externalId)
  t.is(s.fake.state.sends.payout, 1)
  const diverged = await s.step(s.m, 'payout', { ...op, cents: 5001 }, { pin: PIN })
  t.is(diverged.status, 409)
  t.alike(diverged.body, { error: 'operacao-divergente' })

  for (const text of [s.file(), s.ledger(), s.logs.join('\n')]) {
    t.absent(text.includes(PIN), 'no PIN')
    t.absent(text.includes(BENEFICIARY_CPF), 'no CPF')
    t.absent(text.includes(PIX_KEY), 'no full Pix key')
  }
  t.absent(s.texts.join('\n').includes(PIN), 'no PIN in an answer')
  t.absent(s.texts.join('\n').includes(BENEFICIARY_CPF), 'no CPF in an answer')
})

test('wallet money: a busy fee leg stays pendente and the next payout collects it after its principal', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  await funded(t, s, 20000)
  s.fake.script({
    transfer (req, res, ctx) {
      ctx.json(res, 409, { success: false, error: 'busy', errorCode: 'WALLET_BUSY' })
    }
  })
  const first = await pay(t, s, 5000)
  t.is(first.r.status, 200, first.r.text)
  t.alike(first.r.body.fee, { cents: 100, status: 'pendente' })
  const firstId = first.r.body.externalId
  t.is(s.ops.get(firstId).fee.status, 'pendente')
  t.is(s.fake.state.sends.transfer, 0)
  s.fake.script({})

  const b = await s.step(s.m, 'balance')
  t.is(b.body.pendingFeeCents, 100)
  const second = await pay(t, s, 2000)
  t.is(second.preview.pendingFeeCents, 100)
  t.is(second.preview.pendingFeeRef, firstId + ':taxa')
  t.is(second.preview.totalDebitCents, 2000 + 70 + 75 + 100)
  t.is(second.r.status, 200, second.r.text)
  t.alike(second.r.body.pendingFee, { cents: 100, status: 'cobrada' })
  t.alike(second.r.body.fee, { cents: 70, status: 'cobrada' })
  const transfers = s.seen('POST', '/api/wallet/transfer')
  const refs = transfers.map((q) => q.body.reference)
  t.alike(refs.slice(-2), [second.r.body.externalId + ':taxa', firstId + ':taxa'], 'own fee, then the old one with its reference')
  t.is(refs.filter((ref) => ref === firstId + ':taxa').length, 2, 'the busy attempt and the one that collected it')
  const payouts = s.seen('POST', '/api/wallet/payout')
  t.ok(s.fake.seen.indexOf(payouts[payouts.length - 1]) < s.fake.seen.indexOf(transfers[transfers.length - 2]), 'no fee before the principal')
  t.is(s.fake.state.sends.transfer, 2)
  t.is(s.ops.get(firstId).fee.status, 'cobrada')
  t.is((await s.step(s.m, 'balance')).body.pendingFeeCents, 0)
})

test('wallet money: a fee mismatch is taxa-mudou and a short balance is saldo-insuficiente, before any send', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  await funded(t, s, 5174)
  const { quote, preview } = await review(t, s, 5000)
  const op = payoutOp(opId(), 5000, quote, preview)
  for (const changed of [{ feeCents: 99 }, { totalDebitCents: 5174 }, { pendingFeeCents: 1, pendingFeeRef: 'x' }]) {
    const r = await s.step(s.m, 'payout', { ...op, ...changed }, { pin: PIN })
    t.is(r.status, 409, JSON.stringify(changed))
    t.alike(r.body, { error: 'taxa-mudou' }, JSON.stringify(changed))
  }
  const typed = await s.step(s.m, 'payout', { ...op, feeCents: '100' }, { pin: PIN })
  t.alike(typed.body, { error: 'pedido-invalido' })
  const short = await s.step(s.m, 'payout', op, { pin: PIN })
  t.is(short.status, 409)
  t.alike(short.body, { error: 'saldo-insuficiente' })
  t.is(s.seen('POST', '/api/wallet/payout').length, 0)
  t.is(s.seen('POST', '/api/wallet/transfer').length, 0)
  t.is(s.ledger(), '', 'nothing written')
  const noQuote = await s.step(s.m, 'payout', { ...op, quoteId: 'other-quote' }, { pin: PIN })
  t.alike(noQuote.body, { error: 'taxa-mudou' })
})

test('wallet money: three wrong PINs are pin-invalido, pin-invalido, pin-bloqueado, with no fee leg', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  await funded(t, s, 10000)
  let wrong = 0
  s.fake.script({
    payout (req, res, ctx) {
      if (ctx.body.walletPin !== PIN && ++wrong >= 3) return ctx.json(res, 400, { success: false, error: 'PIN locked for 24 hours' })
      const out = s.fake.apply('payout', ctx)
      ctx.json(res, out.code, out.body)
    }
  })
  const got = []
  for (let i = 0; i < 3; i++) {
    const { r } = await pay(t, s, 1000, { pin: '135792' })
    got.push(r.body.error)
    t.is(s.ops.get(r.body.externalId).status, 'falhou')
  }
  t.alike(got, ['pin-invalido', 'pin-invalido', 'pin-bloqueado'])
  t.is(s.seen('POST', '/api/wallet/transfer').length, 0)
  t.is(s.fake.state.sends.payout, 0)
  const badShape = await pay(t, s, 1000, { pin: '12a456' })
  t.alike(badShape.r.body, { error: 'pin-invalido' })
  t.absent(s.logs.join('\n').includes('135792'))
})

test('wallet money: a lost payout answer is incerto, blocks new debits and op-status finds it with no second POST (C8, C9)', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES, moneyTimeoutMs: 300 })
  await funded(t, s, 10000)
  s.fake.script({
    payout (req, res, ctx) {
      s.fake.apply('payout', ctx)
    }
  })
  const { r } = await pay(t, s, 3000)
  t.is(r.status, 503)
  t.is(r.body.error, 'resultado-incerto')
  const externalId = r.body.externalId
  const row = s.ops.get(externalId)
  t.is(row.status, 'incerto')
  t.is(row.providerId, null)
  t.is(row.fee.status, 'pendente')
  t.is(s.seen('POST', '/api/wallet/transfer').length, 0, 'no fee leg after an uncertain principal')
  s.fake.script({})

  const blocked = await pay(t, s, 1000)
  t.is(blocked.r.status, 409)
  t.alike(blocked.r.body, { error: 'operacao-pendente' })
  t.is(s.fake.state.sends.payout, 1)

  for (const p of s.fake.state.payouts.values()) p.status = 'COMPLETED'
  const st = await s.step(s.m, 'op-status', { externalId })
  t.is(st.status, 200, st.text)
  t.is(st.body.status, 'concluido')
  t.ok(/^0x[0-9a-f]{64}$/.test(s.ops.get(externalId).txHash), 'the recovered hash is kept')
  t.is(s.seen('POST', '/api/wallet/payout').length, 1, 'never posted again')
  t.is(s.seen('POST', '/api/account/statement').length, 1)
  t.is((await s.step(s.m, 'balance')).body.pendingFeeCents, 80, 'the fee is now owed')

  const next = await pay(t, s, 1000)
  t.is(next.r.status, 200, next.r.text)
})

test('wallet money: a miss in the statement changes nothing; op-status is owner only and polls every 10 s', async (t) => {
  const s = await setup(t, { mode: 'pix', moneyTimeoutMs: 300 })
  await funded(t, s, 10000)
  s.fake.script({ payout () {} })
  const { r } = await pay(t, s, 3000)
  t.is(r.body.error, 'resultado-incerto')
  s.fake.script({})
  const st = await s.step(s.m, 'op-status', { externalId: r.body.externalId })
  t.is(st.body.status, 'incerto')
  await s.step(s.m, 'op-status', { externalId: r.body.externalId })
  t.is(s.seen('POST', '/api/account/statement').length, 1, 'one read per 10 s')
  s.c.offset += 11 * 1000
  await s.step(s.m, 'op-status', { externalId: r.body.externalId })
  t.is(s.seen('POST', '/api/account/statement').length, 2)

  const other = member()
  await linkDirect(s.store, s.iss, other, 'eva')
  await s.terms.accept({ member: other.hex, version: TERMS_VERSION, nonce: 'q'.repeat(43), signature: 'f'.repeat(128) })
  const foreign = await s.step(other, 'op-status', { externalId: r.body.externalId })
  t.is(foreign.status, 404)
  t.alike(foreign.body, { error: 'nao-encontrado' })
})

test('wallet money: Hodle payout refusals map to tokens and never run the fee leg', async (t) => {
  const cases = [
    [400, 'INSUFFICIENT_BALANCE', 'saldo-insuficiente', 'falhou'],
    [403, 'PER_TX_LIMIT_EXCEEDED', 'valor-invalido', 'falhou'],
    [409, 'WALLET_BUSY', 'indisponivel', 'falhou'],
    [409, 'PAYOUT_IN_PROGRESS', 'resultado-incerto', 'incerto']
  ]
  for (const [code, errorCode, token, status] of cases) {
    const s = await setup(t, { mode: 'pix', fees: FEES })
    await funded(t, s, 10000)
    s.fake.script({
      payout (req, res, ctx) {
        ctx.json(res, code, { success: false, error: 'no', errorCode })
      }
    })
    const { r } = await pay(t, s, 1000)
    t.is(r.body.error, token, errorCode)
    t.is(s.ops.get(r.body.externalId).status, status, errorCode)
    t.is(s.seen('POST', '/api/wallet/transfer').length, 0)
  }
})

test('wallet money: the statement merges Hodle rows with the ledger without double counting', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES, moneyTimeoutMs: 300, timeoutMs: 300 })
  await funded(t, s, 10000)
  const dep = await s.step(s.m, 'deposit', { opId: opId(), cents: 3000 })
  const paid = await pay(t, s, 2000)
  t.is(paid.r.status, 200, paid.r.text)
  s.fake.script({ deposit () {} })
  const lost = await s.step(s.m, 'deposit', { opId: opId(), cents: 1500 })
  t.is(lost.body.error, 'resultado-incerto')
  s.fake.script({})
  const st = await s.step(s.m, 'statement')
  t.is(st.status, 200, st.text)
  const items = st.body.items
  const ids = items.map((i) => i.externalId).filter(Boolean)
  t.is(new Set(ids).size, ids.length, 'no row twice')
  t.ok(ids.includes(dep.body.externalId))
  t.ok(ids.includes(paid.r.body.externalId))
  const payoutItem = items.find((i) => i.externalId === paid.r.body.externalId)
  t.alike(payoutItem.fee, { cents: 70, status: 'cobrada' })
  t.is(payoutItem.direction, 'out')
  t.is(payoutItem.to, '***test')
  t.is(items.filter((i) => i.kind === 'transfer').length, 0, 'the fee leg folds into its payout')
  const unsure = items.find((i) => i.externalId === lost.body.externalId)
  t.is(unsure.status, 'incerto', 'an uncertain row still shows')
  t.is(st.body.cursor, null)
  t.is(s.seen('POST', '/api/account/statement')[0].body.limit, 20)
})

// --- review round 1 ------------------------------------------------------------

test('wallet money: a fee transfer accepted but not completed stays enviada and op-status settles it by reference', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  await funded(t, s, 10000)
  s.fake.script({
    transfer (req, res, ctx) {
      s.fake.apply('transfer', ctx)
      ctx.json(res, 200, { success: true, data: { amount: ctx.body.amount } })
    }
  })
  const { r } = await pay(t, s, 5000)
  t.is(r.status, 200, r.text)
  t.alike(r.body.fee, { cents: 100, status: 'enviada' })
  const externalId = r.body.externalId
  t.is(s.ops.get(externalId).fee.status, 'enviada', 'not cobrada on an accepted, pending transfer')
  t.is(s.ops.get(externalId).fee.reference, externalId + ':taxa')
  t.is((await s.step(s.m, 'balance')).body.pendingFeeCents, 0, 'never re-presented')
  s.fake.script({})
  const st = await s.step(s.m, 'op-status', { externalId })
  t.is(st.status, 200, st.text)
  t.alike(st.body.fee, { cents: 100, status: 'cobrada' })
  t.ok(/^0x[0-9a-f]{64}$/.test(s.ops.get(externalId).fee.txHash))
  t.is(s.seen('POST', '/api/wallet/transfer').length, 1, 'never resent')
})

test('wallet money: an uncertain payout behind 60 later deposits still blocks a new debit', async (t) => {
  const s = await setup(t, { mode: 'pix', moneyTimeoutMs: 300 })
  await funded(t, s, 10000)
  s.fake.script({ payout () {} })
  const lost = await pay(t, s, 3000)
  t.is(lost.r.body.error, 'resultado-incerto')
  s.fake.script({})
  for (let i = 0; i < 60; i++) {
    s.c.offset += 1000
    await s.ops.put({ externalId: externalIdFor(s.m.hex, 'deposit', opId()), member: s.m.hex, kind: 'deposit', status: 'pendente', cents: 1000, fee: { cents: 0, status: 'nenhuma' } })
  }
  t.absent(s.ops.listByMember(s.m.hex, { limit: 50 }).some((e) => e.externalId === lost.r.body.externalId))
  const next = await pay(t, s, 1000)
  t.is(next.r.status, 409)
  t.alike(next.r.body, { error: 'operacao-pendente' })
  t.is(s.seen('POST', '/api/wallet/payout').length, 1)
})

test('wallet money: without a treasury owed fees are neither quoted nor collected', async (t) => {
  const s = await setup(t, { mode: 'pix' })
  await funded(t, s, 10000)
  const owedId = externalIdFor(s.m.hex, 'payout', opId())
  await s.ops.put({ externalId: owedId, member: s.m.hex, kind: 'payout', status: 'concluido', cents: 1000, fee: { cents: 100, status: 'pendente', reference: feeReference(owedId) }, to: '***1234', totalDebitCents: 1175 })
  t.is((await s.step(s.m, 'balance')).body.pendingFeeCents, 0)
  const { preview, r } = await pay(t, s, 2000)
  t.is(preview.pendingFeeCents, 0)
  t.is(preview.pendingFeeRef, '')
  t.is(preview.totalDebitCents, 2075)
  t.is(r.status, 200, r.text)
  t.alike(r.body, { externalId: r.body.externalId, status: 'concluido', fee: null, pendingFee: null })
  t.is(s.seen('POST', '/api/wallet/transfer').length, 0)
  t.is(s.ops.get(owedId).fee.status, 'pendente', 'the owed fee stays pendente, never enviada')
})

test('wallet money: statement pages show each operation once and fold fee legs on every page', async (t) => {
  const s = await setup(t, { mode: 'pix' })
  const sub = await funded(t, s, 10000)
  const ids = []
  for (let i = 0; i < 30; i++) {
    const externalId = externalIdFor(s.m.hex, 'deposit', opId())
    ids.push(externalId)
    await s.ops.put({ externalId, member: s.m.hex, kind: 'deposit', status: 'pendente', cents: 1000, fee: { cents: 0, status: 'nenhuma' } })
    s.fake.state.deposits.set(externalId, {
      seq: 1000 + i,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
      externalId,
      subAccountId: sub,
      walletCharge: 'wc' + i,
      trackId: 'trk' + i,
      value: 1000,
      feeCents: 0,
      status: 'PENDING'
    })
  }
  const paidId = externalIdFor(s.m.hex, 'payout', opId())
  await s.ops.put({ externalId: paidId, member: s.m.hex, kind: 'payout', status: 'concluido', cents: 1000, fee: { cents: 100, status: 'pendente', reference: feeReference(paidId) }, to: '***1234', totalDebitCents: 1175 })
  await s.ops.setFee(paidId, { status: 'enviada' })
  // The fee transfer is old enough to land on the second provider page.
  s.fake.state.transfers.set(feeReference(paidId), { seq: 500, createdAt: new Date(Date.now() - 60000).toISOString(), transactionId: 'tf1', reference: feeReference(paidId), from: sub, to: undefined, cents: 100, txHash: '0x' + 'ef'.repeat(32) })

  const pages = []
  let cursor
  for (let i = 0; i < 5; i++) {
    const r = await s.step(s.m, 'statement', cursor === undefined ? {} : { cursor })
    t.is(r.status, 200, r.text)
    pages.push(r.body)
    if (r.body.cursor === null) break
    cursor = r.body.cursor
  }
  t.ok(pages.length >= 2, 'more than one page')
  const items = pages.flatMap((p) => p.items)
  t.is(items.filter((i) => i.kind === 'deposit').length, 30, 'each deposit once across pages')
  const seen = items.map((i) => i.externalId).filter(Boolean)
  t.is(new Set(seen).size, seen.length)
  for (const id of ids) t.ok(seen.includes(id))
  t.is(items.filter((i) => i.kind === 'transfer').length, 0, 'the fee leg never shows as a debit')
  t.is(items.filter((i) => i.externalId === null).length, 0)
  t.ok(pages.every((p) => p.items.length <= 100))
  t.ok(pages.every((p) => JSON.stringify(p).length < 16384))
  t.is(s.ops.get(paidId).fee.status, 'cobrada', 'reconciled from a later page')
  const bad = await s.step(s.m, 'statement', { cursor: 'abc' })
  t.alike(bad.body, { error: 'pedido-invalido' })
})

test('wallet: a lost second submission adopts a new attempt id even when it is already closed', async (t) => {
  const s = await setup(t, { timeoutMs: 300 })
  await secondAttempt(t, s)
  t.is(s.entry().kyc.previousAttemptIds.length, 1, 'attempt 1 recorded')
  s.fake.script({
    kycSubmit (req, res, ctx) {
      s.fake.state.kyc.set('att_new2', { subAccountId: ctx.body.subAccountId, status: 'REJECTED' })
    }
  })
  const r = await s.step(s.m, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.alike(r.body, { error: 'resultado-incerto' })
  s.fake.script({})
  s.c.offset += 61 * 1000
  const st = await s.step(s.m, 'status')
  t.alike(st.body.account.kyc, { state: 'recusado', attempt: 2 })
  t.is(s.entry().kyc.attemptId, 'att_new2')
  t.absent(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'kyc-incerto' })))
})

// --- review round 2 ------------------------------------------------------------

const DAY = 24 * 3600 * 1000

test('wallet money: a refused repeat never downgrades a live deposit; only a first create becomes falhou', async (t) => {
  const s = await setup(t, { mode: 'pix' })
  await funded(t, s, 0)
  const id = opId()
  const a = await s.step(s.m, 'deposit', { opId: id, cents: 2000 })
  t.is(a.status, 200, a.text)
  s.fake.script({
    deposit (req, res, ctx) {
      ctx.json(res, 429, { success: false, error: 'slow down' })
    }
  })
  const again = await s.step(s.m, 'deposit', { opId: id, cents: 2000 })
  t.is(again.status, 429)
  t.is(again.body.error, 'limite-carteira')
  t.is(s.ops.get(a.body.externalId).status, 'pendente', 'the live charge keeps its status')
  t.is(s.seen('GET', '/api/deposit/' + a.body.externalId).length, 1, 'reconciled by a status read')

  const fresh = await s.step(s.m, 'deposit', { opId: opId(), cents: 2000 })
  t.is(fresh.body.error, 'limite-carteira')
  t.is(s.ops.get(fresh.body.externalId).status, 'falhou', 'a refused first create')
})

function failFeeTransfers (s) {
  s.fake.script({
    statement (req, res, ctx) {
      const out = s.fake.apply('statement', ctx)
      for (const op of out.body.data.operations) if (op.reference) op.status = 'FAILED'
      ctx.json(res, out.code, out.body)
    }
  })
}

test('wallet money: a fee leg the provider reports FAILED goes back to pendente, never cobrada, even with a hash', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  await funded(t, s, 10000)
  s.fake.script({
    transfer (req, res, ctx) {
      s.fake.apply('transfer', ctx)
      ctx.json(res, 200, { success: true, data: { amount: ctx.body.amount } })
    }
  })
  const first = await pay(t, s, 5000)
  t.is(s.ops.get(first.r.body.externalId).fee.status, 'enviada')
  failFeeTransfers(s)
  const st = await s.step(s.m, 'op-status', { externalId: first.r.body.externalId })
  t.is(st.status, 200, st.text)
  t.alike(st.body.fee, { cents: 100, status: 'pendente' }, 'op-status: failed wins over the hash')

  s.fake.script({
    transfer (req, res, ctx) {
      s.fake.apply('transfer', ctx)
      ctx.json(res, 200, { success: true, data: { amount: ctx.body.amount } })
    }
  })
  const second = await pay(t, s, 1000)
  t.is(s.ops.get(second.r.body.externalId).fee.status, 'enviada')
  failFeeTransfers(s)
  const page = await s.step(s.m, 'statement')
  t.is(page.status, 200, page.text)
  t.is(s.ops.get(second.r.body.externalId).fee.status, 'pendente', 'statement: failed wins over the hash')
})

test('wallet money: an accepted payout whose body says FAILED or REFUNDED is stored as such and charges no fee', async (t) => {
  for (const [status, ours] of [['FAILED', 'falhou'], ['REFUNDED', 'devolvido']]) {
    const s = await setup(t, { mode: 'pix', fees: FEES })
    await funded(t, s, 10000)
    s.fake.script({
      payout (req, res, ctx) {
        const out = s.fake.apply('payout', ctx)
        ctx.json(res, out.code, { ...out.body, status })
      }
    })
    const { r } = await pay(t, s, 2000)
    t.is(r.status, 200, r.text)
    t.is(r.body.status, ours, status)
    t.is(r.body.fee, null, 'no fee shown as owed on ' + status)
    t.is(s.ops.get(r.body.externalId).status, ours)
    t.is(s.seen('POST', '/api/wallet/transfer').length, 0, 'no fee leg on ' + status)
    t.is((await s.step(s.m, 'balance')).body.pendingFeeCents, 0, 'nothing owed')
  }
})

test('wallet money: op-status searches the window around an old lost payout, past three pages; past 89 days it waits for the operator', async (t) => {
  const s = await setup(t, { mode: 'pix', moneyTimeoutMs: 300 })
  await funded(t, s, 10000)
  s.fake.script({
    payout (req, res, ctx) {
      s.fake.apply('payout', ctx)
    }
  })
  const { r } = await pay(t, s, 3000)
  t.is(r.body.error, 'resultado-incerto')
  const externalId = r.body.externalId
  const created = Date.parse(s.ops.get(externalId).createdAt)
  const [record] = [...s.fake.state.payouts.values()]
  let pages = 0
  s.fake.script({
    statement (req, res, ctx) {
      pages++
      const op = pages < 6
        ? { id: 'op_x' + pages, type: 'payout', status: 'COMPLETED', valueInBrl: '1.00', fee: '0', createdAt: record.createdAt, externalId: 'other-' + pages }
        : { id: 'op_hit', type: 'payout', status: 'COMPLETED', valueInBrl: '30.00', fee: '0.75', createdAt: record.createdAt, externalId, txHash: record.txHash }
      ctx.json(res, 200, { success: true, data: { operations: [op], nextCursor: 'p' + pages } })
    }
  })
  s.c.offset += 20 * DAY
  const st = await s.step(s.m, 'op-status', { externalId })
  t.is(st.status, 200, st.text)
  t.is(st.body.status, 'concluido', 'found on the sixth page')
  t.is(pages, 6)
  const sent = s.seen('POST', '/api/account/statement').slice(-1)[0].body
  t.is(Date.parse(sent.from), created - DAY, 'a day before the row')
  t.ok(Math.abs(Date.parse(sent.to) - s.c.now()) < 60000, 'up to now, 20 days on')
  t.ok(Date.parse(sent.to) <= created + 30 * DAY, 'never past 30 days after the row')
  t.is(s.seen('POST', '/api/wallet/payout').length, 1)

  const old = await setup(t, { mode: 'pix', moneyTimeoutMs: 300 })
  await funded(t, old, 10000)
  old.fake.script({ payout () {} })
  const lost = await pay(t, old, 3000)
  old.fake.script({})
  old.c.offset += 90 * DAY
  const late = await old.step(old.m, 'op-status', { externalId: lost.r.body.externalId })
  t.is(late.body.status, 'incerto')
  t.ok(old.logs.includes(JSON.stringify({ event: 'carteira', reason: 'consulta-antiga' })))
  t.is(old.seen('POST', '/api/account/statement').length, 0)
})

// --- security fix cycle 1 ---------------------------------------------------

test('wallet money: a 5xx payout answer is incerto whatever code it carries, and blocks the next debit (S10)', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  await funded(t, s, 10000)
  s.fake.script({
    payout (req, res, ctx) {
      ctx.json(res, 503, { success: false, error: 'no', errorCode: 'PIN_INVALID' })
    }
  })
  const { r } = await pay(t, s, 1000)
  t.is(r.status, 503, r.text)
  t.is(r.body.error, 'resultado-incerto')
  t.is(s.ops.get(r.body.externalId).status, 'incerto', 'the debit may have happened')
  t.is(s.seen('POST', '/api/wallet/transfer').length, 0, 'no fee leg')
  s.fake.script({})
  const next = await pay(t, s, 1000)
  t.is(next.r.body.error, 'operacao-pendente')
  t.is(s.seen('POST', '/api/wallet/payout').length, 1, 'no second payout')
})

test('wallet money: a row a status read ends during the payout call gets no fee leg and shows no fee (S2)', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  await funded(t, s, 10000)
  s.fake.script({
    async payout (req, res, ctx) {
      const out = s.fake.apply('payout', ctx)
      // What an op-status or webhook read would write while the call is open.
      const row = s.ops.get(ctx.body.externalId)
      await advanceOp(s.ops, row, { status: 'falhou' })
      ctx.json(res, out.code, out.body)
    }
  })
  const { r } = await pay(t, s, 2000)
  t.is(r.status, 200, r.text)
  t.is(r.body.status, 'falhou', 'the ledger, not the answer')
  t.is(r.body.fee, null)
  t.is(r.body.pendingFee, null)
  t.is(s.seen('POST', '/api/wallet/transfer').length, 0, 'no fee transfer dispatched')
  t.is(s.ops.get(r.body.externalId).status, 'falhou')
})

test('wallet money: a fee leg settles only from the member outbound transfer of its amount (S3)', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  await funded(t, s, 10000)
  s.fake.script({
    transfer (req, res, ctx) {
      s.fake.apply('transfer', ctx)
      ctx.json(res, 200, { success: true, data: { amount: ctx.body.amount } })
    }
  })
  const { r } = await pay(t, s, 5000)
  t.is(r.status, 200, r.text)
  const externalId = r.body.externalId
  const reference = externalId + ':taxa'
  t.is(s.ops.get(externalId).fee.status, 'enviada')
  t.is(s.ops.get(externalId).fee.cents, 100)
  const at = new Date(s.c.now()).toISOString()
  let n = 0
  const op = (extra) => ({ id: 'op_s3_' + (++n), type: 'transfer', status: 'COMPLETED', valueInBrl: '1.00', fee: '0', createdAt: at, reference, txHash: '0x' + 'ef'.repeat(32), direction: 'out', ...extra })
  const showing = (ops) => s.fake.script({
    statement (req, res, ctx) {
      ctx.json(res, 200, { success: true, data: { operations: ops } })
    }
  })
  const fee = () => s.ops.get(externalId).fee.status

  showing([op({ direction: 'in' })])
  t.is((await s.step(s.m, 'statement')).status, 200)
  t.is(fee(), 'enviada', 'an inbound row with the reference does not settle')
  showing([op({ valueInBrl: '0.99' })])
  t.is((await s.step(s.m, 'statement')).status, 200)
  t.is(fee(), 'enviada', 'another amount does not settle')
  showing([op({ type: 'deposit', direction: 'in' })])
  t.is((await s.step(s.m, 'statement')).status, 200)
  t.is(fee(), 'enviada', 'a deposit carrying the reference does not settle')
  showing([op({ direction: 'in', status: 'FAILED', txHash: null })])
  t.is((await s.step(s.m, 'statement')).status, 200)
  t.is(fee(), 'enviada', 'a mismatched failed row does not reset the fee')

  // op-status looks the fee up by reference: the same rule.
  showing([op({ direction: 'in' })])
  const st = await s.step(s.m, 'op-status', { externalId })
  t.is(st.status, 200, st.text)
  t.alike(st.body.fee, { cents: 100, status: 'enviada' }, 'op-status: an inbound row does not settle')

  showing([op({})])
  t.is((await s.step(s.m, 'statement')).status, 200)
  t.is(fee(), 'cobrada', 'the real outbound row settles')
  showing([op({ direction: 'in', status: 'FAILED', txHash: null })])
  s.c.offset += 11000
  t.is((await s.step(s.m, 'op-status', { externalId })).status, 200)
  t.is(fee(), 'cobrada', 'a mismatched failed row never resets a collected fee')
  t.is(s.seen('POST', '/api/wallet/transfer').length, 1, 'never resent')
})

test('wallet money: the quote keeps a hash of the Pix key; a payout to another key is refused (S4)', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  await funded(t, s, 10000)
  const { quote, preview } = await review(t, s, 1000)
  const other = await s.step(s.m, 'payout', payoutOp(opId(), 1000, quote, preview, { pixKey: 'outra@example.test' }), { pin: PIN })
  t.alike(other.body, { error: 'pedido-invalido' })
  const otherType = await s.step(s.m, 'payout', payoutOp(opId(), 1000, quote, preview, { pixKey: '+5511987654321', pixKeyType: 'PHONE' }), { pin: PIN })
  t.alike(otherType.body, { error: 'pedido-invalido' })
  const ok = await s.step(s.m, 'payout', payoutOp(opId(), 1000, quote, preview), { pin: PIN })
  t.is(ok.status, 200, ok.text)
  t.is(s.seen('POST', '/api/wallet/payout').length, 1)
})

test('wallet money: a fee above one transfer is refused at quote and preview, before any principal (S5)', async (t) => {
  const fees = parseFees({ VARANDA_FEE_PAYOUT_BPS: '2000', VARANDA_FEE_TREASURY: TREASURY })
  const s = await setup(t, { mode: 'pix', fees, maxCents: 100000000 })
  await funded(t, s, 0)
  // 20% of 5000100 is 1000020, over the per-transfer limit.
  const big = 5000100
  t.ok(Math.round(big * 0.2) > MAX_TRANSFER_CENTS)
  const q = await s.step(s.m, 'payout-quote', { cents: big, pixKey: PIX_KEY, pixKeyType: 'EMAIL' })
  t.alike(q.body, { error: 'valor-invalido' })
  t.is(s.seen('POST', '/api/wallet/payout/beneficiary').length, 0, 'Hodle never asked for a quote')
  const p = await s.step(s.m, 'preview', { kind: 'payout', cents: big })
  t.is(p.status, 200, p.text)
  t.is(p.body.ok, false)
  t.is(p.body.reason, 'valor-invalido')
  // Exactly at the limit is still accepted: 20% of 5000000 is 1000000.
  const edge = await s.step(s.m, 'preview', { kind: 'payout', cents: 5000000 })
  t.is(edge.body.ok, true, edge.text)
  t.is(edge.body.varandaFeeCents, MAX_TRANSFER_CENTS)
  t.is(s.seen('POST', '/api/wallet/payout').length, 0)
})

test('wallet money: re-tapping a pending deposit never spends the deposit window, but has its own small window (S7, R1)', async (t) => {
  // A member share of 50 paid calls, above the 29 made here.
  const s = await setup(t, { mode: 'pix', dailyLimit: 200 })
  await funded(t, s, 0)
  const id = opId()
  const first = await s.step(s.m, 'deposit', { opId: id, cents: 5000 })
  t.is(first.status, 200, first.text)
  // Four 10-minute windows of six re-taps: 24 re-taps, more than the 20/day
  // deposit window holds.
  for (let w = 0; w < 4; w++) {
    for (let i = 0; i < 6; i++) {
      const again = await s.step(s.m, 'deposit', { opId: id, cents: 5000 })
      if (again.status !== 200) t.fail('re-tap ' + w + '.' + i + ': ' + again.text)
    }
    const seventh = await s.step(s.m, 'deposit', { opId: id, cents: 5000 })
    t.is(seventh.status, 429, 'the 7th re-tap within 10 minutes is refused')
    t.alike(seventh.body, { error: 'limite-carteira' })
    s.c.offset += 601 * 1000
  }
  const other = await s.step(s.m, 'deposit', { opId: opId(), cents: 5000 })
  t.is(other.status, 200, 'a new charge still has room: ' + other.text)
})

test('wallet money: a re-tap is a paid call, so it passes the daily ceiling (R1)', async (t) => {
  // At 10 the member's share equals the ceiling, so the ceiling is what refuses.
  const s = await setup(t, { mode: 'pix', dailyLimit: 10 })
  await funded(t, s, 0)
  const id = opId()
  const first = await s.step(s.m, 'deposit', { opId: id, cents: 5000 })
  t.is(first.status, 200, first.text)
  const calls = () => s.seen('POST', '/api/deposit/asset').length
  const sends = calls()
  // Spend what is left of the shared ceiling with re-taps, in windows of six.
  let refused = null
  for (let i = 0; i < 200 && refused === null; i++) {
    if (i > 0 && i % 6 === 0) s.c.offset += 601 * 1000
    const again = await s.step(s.m, 'deposit', { opId: id, cents: 5000 })
    if (again.status !== 200) refused = again
  }
  t.ok(refused !== null, 'a re-tap is eventually refused by the ceiling')
  t.alike(refused.body, { error: 'indisponivel' })
  t.ok(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'teto-diario' })))
  const after = calls()
  const again = await s.step(s.m, 'deposit', { opId: id, cents: 5000 })
  t.is(again.status, 503)
  t.is(calls(), after, 'no Hodle call past the ceiling')
  t.ok(after > sends, 're-taps did reach Hodle before the ceiling')
})

async function joined (s, name, n) {
  const who = member()
  await linkDirect(s.store, s.iss, who, name)
  await s.terms.accept({ member: who.hex, version: TERMS_VERSION, nonce: nodeCrypto.randomBytes(32).toString('base64url').slice(0, 43), signature: (n % 10).toString().repeat(128) })
  return who
}

test('wallet money: one member uses at most their share of the daily ceiling; the ceiling still stops everyone (X1)', async (t) => {
  const s = await setup(t, { mode: 'pix', dailyLimit: 40 })
  // optin, kyc-submit and wallet-create: three paid calls of the share of 10.
  await funded(t, s, 10000)
  const quoteOp = { cents: 1000, pixKey: PIX_KEY, pixKeyType: 'EMAIL' }
  for (let i = 0; i < 7; i++) {
    const q = await s.step(s.m, 'payout-quote', quoteOp)
    if (q.status !== 200) t.fail('quote ' + i + ': ' + q.text)
  }
  const quotes = s.seen('POST', '/api/wallet/payout/beneficiary').length
  const eleventh = await s.step(s.m, 'payout-quote', quoteOp)
  t.is(eleventh.status, 429, 'the 11th paid call of one member is refused')
  t.alike(eleventh.body, { error: 'limite-carteira' })
  t.is(s.seen('POST', '/api/wallet/payout/beneficiary').length, quotes, 'no Hodle call past the share')
  const b = await joined(s, 'bia', 1)
  const ob = await s.step(b, 'optin', ADULT)
  t.is(ob.status, 200, 'another member still has room: ' + ob.text)

  const small = await setup(t, { mode: 'pix', dailyLimit: 12 })
  await funded(t, small, 10000)
  for (let i = 0; i < 7; i++) await small.step(small.m, 'payout-quote', quoteOp)
  const c = await joined(small, 'caio', 2)
  t.is((await small.step(c, 'optin', ADULT)).status, 200)
  const d = await joined(small, 'davi', 3)
  t.is((await small.step(d, 'optin', ADULT)).status, 200)
  const e = await joined(small, 'eva', 4)
  const full = await small.step(e, 'optin', ADULT)
  t.is(full.status, 503, 'an empty ceiling refuses a member with share left')
  t.alike(full.body, { error: 'indisponivel' })
  t.ok(small.logs.includes(JSON.stringify({ event: 'carteira', reason: 'teto-diario' })))
})

test('wallet money: a ledger read failing right after a successful payout is resultado-incerto (R3)', async (t) => {
  const s = await setup(t, { mode: 'pix' })
  await funded(t, s, 10000)
  const { quote, preview } = await review(t, s, 5000)
  const get = s.ops.get.bind(s.ops)
  let reads = 0
  // The first read after the call feeds the write of the accepted status;
  // the next one is the read the fee legs follow.
  s.ops.get = (id) => {
    if (s.seen('POST', '/api/wallet/payout').length > 0 && ++reads >= 2) throw new Error('disk gone')
    return get(id)
  }
  const r = await s.step(s.m, 'payout', payoutOp(opId(), 5000, quote, preview), { pin: PIN })
  s.ops.get = get
  t.is(r.status, 503, r.text)
  t.is(r.body.error, 'resultado-incerto', 'never a refusal the app retries with a new opId')
  t.is(typeof r.body.externalId, 'string')
  t.is(s.seen('POST', '/api/wallet/payout').length, 1)
  t.ok(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'armazenamento-indisponivel' })))
})

test('wallet money: a payout must leave every other pending fee in the wallet, and collects only the oldest (S11)', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  const sub = await funded(t, s, 20000)
  s.fake.script({
    transfer (req, res, ctx) {
      ctx.json(res, 409, { success: false, error: 'busy', errorCode: 'WALLET_BUSY' })
    }
  })
  const first = await pay(t, s, 5000)
  t.alike(first.r.body.fee, { cents: 100, status: 'pendente' })
  const second = await pay(t, s, 2000)
  t.alike(second.r.body.fee, { cents: 70, status: 'pendente' })
  t.is(s.ops.outstandingFees(s.m.hex).cents, 170)
  s.fake.script({})

  const { quote, preview } = await review(t, s, 1000)
  t.is(preview.pendingFeeCents, 100, 'the oldest fee is collected')
  t.is(preview.pendingFeeRef, first.r.body.externalId + ':taxa')
  t.is(preview.totalDebitCents, 1000 + 60 + 75 + 100, 'the signed debit is unchanged')
  t.is(preview.reservedFeeCents, 70, 'the other fee is reserved')
  const payoutsBefore = s.seen('POST', '/api/wallet/payout').length
  s.fake.state.balances.set(sub, preview.totalDebitCents)
  const short = await s.step(s.m, 'payout', payoutOp(opId(), 1000, quote, preview), { pin: PIN })
  t.alike(short.body, { error: 'saldo-insuficiente' }, 'covers the debit but not the second fee')
  t.is(s.seen('POST', '/api/wallet/payout').length, payoutsBefore, 'nothing sent')

  s.fake.state.balances.set(sub, preview.totalDebitCents + 70)
  const ok = await s.step(s.m, 'payout', payoutOp(opId(), 1000, quote, preview), { pin: PIN })
  t.is(ok.status, 200, ok.text)
  t.alike(ok.body.fee, { cents: 60, status: 'cobrada' })
  t.alike(ok.body.pendingFee, { cents: 100, status: 'cobrada' })
  t.is(s.ops.get(first.r.body.externalId).fee.status, 'cobrada')
  t.is(s.ops.get(second.r.body.externalId).fee.status, 'pendente', 'only one old fee per send')
  t.is(s.fake.state.balances.get(sub), 70, 'the reserved fee stays in the wallet')
})

test('wallet money: the Varanda fee is charged only once Hodle reports the payout concluded (S12)', async (t) => {
  const s = await setup(t, { mode: 'pix', fees: FEES })
  const sub = await funded(t, s, 20000)
  s.fake.state.payoutStatus = null
  const first = await pay(t, s, 5000)
  t.is(first.r.status, 200, first.r.text)
  t.is(first.r.body.status, 'pendente')
  t.alike(first.r.body.fee, { cents: 100, status: 'pendente' }, 'charged in a later send')
  t.is(s.seen('POST', '/api/wallet/transfer').length, 0, 'no fee transfer while the Pix is pending')
  const firstId = first.r.body.externalId
  t.is(s.ops.get(firstId).fee.status, 'pendente')
  t.is(s.ops.get(firstId).fee.reference, firstId + ':taxa')

  // Pending: reserved, not collectable.
  const early = await review(t, s, 1000)
  t.is(early.preview.pendingFeeCents, 0)
  t.is(early.preview.reservedFeeCents, 100)

  // It concludes later (op-status reads it): nothing is charged then.
  s.fake.state.payouts.get(s.ops.get(firstId).providerId).status = 'COMPLETED'
  const st = await s.step(s.m, 'op-status', { externalId: firstId })
  t.is(st.body.status, 'concluido')
  t.is(s.seen('POST', '/api/wallet/transfer').length, 0, 'no PIN, no charge on conclusion')

  // The next payout, itself still pending, collects it as leg 3.
  const second = await pay(t, s, 1000)
  t.is(second.preview.pendingFeeCents, 100)
  t.is(second.preview.pendingFeeRef, firstId + ':taxa')
  t.is(second.r.status, 200, second.r.text)
  t.alike(second.r.body.fee, { cents: 60, status: 'pendente' })
  t.alike(second.r.body.pendingFee, { cents: 100, status: 'cobrada' })
  t.alike(s.seen('POST', '/api/wallet/transfer').map((q) => q.body.reference), [firstId + ':taxa'])
  t.is(s.ops.get(firstId).fee.status, 'cobrada')

  // A payout that ends falhou never has its fee collected or reserved.
  const secondId = second.r.body.externalId
  s.fake.state.payouts.get(s.ops.get(secondId).providerId).status = 'FAILED'
  s.c.offset += 11000
  t.is((await s.step(s.m, 'op-status', { externalId: secondId })).body.status, 'falhou')
  const after = await review(t, s, 1000)
  t.is(after.preview.pendingFeeCents, 0, 'never collected')
  t.is(after.preview.reservedFeeCents, 0, 'no longer reserved')
  t.is(s.ops.outstandingFees(s.m.hex).cents, 0)

  // A payout answered COMPLETED runs leg 2 at once.
  s.fake.state.payoutStatus = 'COMPLETED'
  const third = await s.step(s.m, 'payout', payoutOp(opId(), 1000, after.quote, after.preview), { pin: PIN })
  t.is(third.status, 200, third.text)
  t.is(third.body.status, 'concluido')
  t.alike(third.body.fee, { cents: 60, status: 'cobrada' })
  t.is(s.seen('POST', '/api/wallet/transfer').length, 2)
  t.ok(s.fake.state.balances.get(sub) >= 0)
})

test('wallet money: payouts racing for the last ceiling slot reach the balance read once (Y1)', async (t) => {
  // optin, kyc-submit, wallet-create and payout-quote for two members: 8.
  const s = await setup(t, { mode: 'pix', dailyLimit: 9 })
  await funded(t, s, 10000)
  const b = await joined(s, 'bia', 1)
  t.is((await s.step(b, 'optin', ADULT)).status, 200)
  await documents(t, s, b)
  markReady(s)
  const sub = await s.step(b, 'kyc-submit', { kycHash: kycHash(KYC) }, { kyc: KYC })
  t.is(sub.status, 200, sub.text)
  t.is((await s.step(b, 'status')).body.account.kyc.state, 'aprovado')
  t.is((await s.step(b, 'wallet-create', {}, { pin: PIN })).status, 200)
  s.fake.state.balances.set(s.wallets.get(b.hex).subAccountId, 10000)

  async function ready (who) {
    const q = await s.step(who, 'payout-quote', { cents: 1000, pixKey: PIX_KEY, pixKeyType: 'EMAIL' })
    t.is(q.status, 200, q.text)
    const p = await s.step(who, 'preview', { kind: 'payout', cents: 1000, quoteId: q.body.quoteId })
    t.is(p.status, 200, p.text)
    return payoutOp(opId(), 1000, q.body, p.body)
  }
  const opA = await ready(s.m)
  const opB = await ready(b)
  // Each balance read is held long enough for the other payout to arrive.
  s.fake.script({
    walletGet (req, res, ctx) {
      const r = s.fake.apply('walletGet', ctx)
      setTimeout(() => ctx.json(res, r.code, r.body), ctx.body.sync === true ? 300 : 0)
    }
  })
  const reads = () => s.seen('POST', '/api/wallet/get').filter((q) => q.body.sync === true).length
  const before = reads()
  const results = await Promise.all([
    s.step(s.m, 'payout', opA, { pin: PIN }),
    s.step(b, 'payout', opB, { pin: PIN })
  ])
  t.is(reads() - before, 1, 'only one payout reaches hodle.balance')
  t.alike(results.map((r) => r.status).sort(), [200, 503], results.map((r) => r.text).join(' '))
  t.alike(results.find((r) => r.status === 503).body, { error: 'indisponivel' })
  t.ok(s.logs.includes(JSON.stringify({ event: 'carteira', reason: 'teto-diario' })))
})
