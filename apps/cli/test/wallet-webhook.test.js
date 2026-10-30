'use strict'

// apps/cli/lib/account/wallet-webhook.js mounted by server.js: the Hodle
// webhook sink. Loopback only, with the wallet and ledger stores on a temp
// directory. The sink never moves money; a deposit or payout event that
// would end an operation reads it back from the loopback Hodle fake.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { openAccountStore } = require('../lib/account/store')
const { openWalletStore } = require('../lib/account/wallet-store')
const { openWalletOpsStore, externalIdFor } = require('../lib/account/wallet-ops-store')
const { createAccountServer } = require('../lib/account/server')
const { parseWebhookSecrets, MAX_BODY } = require('../lib/account/wallet-webhook')
const { createHodle } = require('../lib/account/hodle')
const { startFakeHodle, loopbackFetch } = require('./helpers/fake-hodle')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const SECRET = 'c0ffee'.repeat(10) + 'abcd'
const OTHER_SECRET = 'ab'.repeat(32)
const CPF = '52998224725'
const PIN = '482915'
const API_KEY = 'hodle_test_webhookKey0123456789'

function member () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function opId () {
  return nodeCrypto.randomBytes(16).toString('base64url')
}

async function setup (t, { secrets } = {}) {
  const fake = await startFakeHodle()
  t.teardown(() => fake.close(), { force: true })
  const hodle = createHodle({ apiKey: API_KEY, endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base) })
  const dir = path.join(tmpDir(t), 'account')
  const c = { offset: 0 }
  c.now = () => Date.now() + c.offset
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  const wallets = openWalletStore(dir, { now: c.now })
  const ops = openWalletOpsStore(dir, { now: c.now })
  const logs = []
  const server = createAccountServer({
    association: cert.association,
    origin: ORIGIN,
    google: { authorizeUrl: () => 'https://accounts.google.test/auth', exchange: async () => { throw new Error('no') } },
    store: openAccountStore(dir, { now: c.now }),
    hodle,
    wallets,
    ops,
    walletWebhookSecrets: secrets === undefined ? null : secrets,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port
  const texts = []

  function sign (raw, { secret = SECRET, ts = Math.floor(c.now() / 1000) } = {}) {
    const signature = nodeCrypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex')
    return { 'x-hodle-timestamp': String(ts), 'x-hodle-signature': signature }
  }

  async function deliver (event, body, { headers, raw, secret, ts, unsigned = false } = {}) {
    const text = raw !== undefined ? raw : JSON.stringify(body)
    const h = { 'content-type': 'application/json', ...(unsigned ? {} : sign(text, { secret, ts })), ...headers }
    const res = await fetch(base + '/account/wallet/webhook/' + event, { method: 'POST', headers: h, body: text })
    const out = await res.text()
    texts.push(out)
    let parsed = null
    try { parsed = JSON.parse(out) } catch {}
    return { status: res.status, body: parsed }
  }

  const files = () => ['wallet.json', 'wallet-ops.json'].map((f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8')
    } catch {
      return ''
    }
  }).join('\n')

  return { c, fake, wallets, ops, logs, texts, deliver, sign, files }
}

async function openMember (s, { attemptId = 'att_one' } = {}) {
  const m = member()
  const subAccountId = 'sub-' + m.slice(0, 12)
  await s.wallets.create({ member: m, subAccountId, network: 'polygon' })
  s.fake.state.subaccounts.set(subAccountId, { name: 'membro-' + m.slice(0, 32) })
  await s.wallets.setKyc({ member: m, status: 'documentos', documentId: 'doc_a', selfieId: 'doc_b' })
  await s.wallets.setKyc({ member: m, status: 'pendente', attemptId })
  return { m, subAccountId }
}

async function ledgerRow (s, m, kind, status = 'pendente') {
  const externalId = externalIdFor(m, kind, opId())
  const row = kind === 'payout'
    ? { externalId, member: m, kind, status, cents: 1000, fee: { cents: 0, status: 'nenhuma' }, to: '***test', totalDebitCents: 1075 }
    : { externalId, member: m, kind, status, cents: 1000, fee: { cents: 0, status: 'nenhuma' } }
  await s.ops.put(row)
  return externalId
}

// Hodle's own record of the operation, the one the webhook's read finds.
let fakeSeq = 1000
function fakePayout (s, subAccountId, externalId, status) {
  const p = {
    seq: ++fakeSeq,
    createdAt: new Date(Date.now() + fakeSeq).toISOString(),
    transactionId: 'tx-' + fakeSeq,
    externalId,
    subAccountId,
    network: 'polygon',
    value: 1000,
    feeCents: 75,
    status,
    txHash: '0x' + 'ab'.repeat(32),
    endToEndId: 'E' + String(fakeSeq).padStart(31, '0')
  }
  s.fake.state.payouts.set(p.transactionId, p)
  return p
}

function fakeDeposit (s, subAccountId, externalId) {
  const r = s.fake.apply('deposit', { body: { subAccountId, value: 1000, asset: 'BRLA', address: '0x' + 'cd'.repeat(20), network: 'polygon', externalId } })
  if (r.code !== 200) throw new Error('fake deposit ' + r.code)
}

const tokens = (s) => s.logs.map((l) => JSON.parse(l)).filter((e) => e.event === 'carteira').map((e) => e.reason)

test('webhook: no secrets is the generic 404 for every path', async (t) => {
  const s = await setup(t)
  for (const event of ['KYC_APPROVED', 'WEBHOOK_TEST', 'x']) {
    const r = await s.deliver(event, { event, data: {} })
    t.is(r.status, 404)
    t.alike(r.body, { error: 'nao-encontrado' })
  }
})

test('webhook: a registrar path answers only the test event, unverified and without state (C1)', async (t) => {
  const s = await setup(t, { secrets: new Map([['KYC_APPROVED', 'registrar']]) })
  const { m, subAccountId } = await openMember(s)
  const before = s.files()
  const ok = await s.deliver('KYC_APPROVED', { event: 'WEBHOOK_TEST', data: {} }, { unsigned: true })
  t.is(ok.status, 200)
  t.alike(ok.body, {})
  const real = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { attemptId: 'att_one', subAccountId } })
  t.is(real.status, 401)
  t.alike(real.body, { error: 'nao-autorizado' })
  t.is(s.files(), before, 'no store touched')
  t.is(s.wallets.get(m).kyc.status, 'pendente')
  const other = await s.deliver('DISPUTE_CREATED', { event: 'WEBHOOK_TEST' }, { unsigned: true })
  t.is(other.status, 404, 'an event that was never configured is hidden')
})

test('webhook: signature, skew, Origin and event checks; HMAC keyed with the secret string', async (t) => {
  const secrets = parseWebhookSecrets('KYC_APPROVED:' + SECRET + ',DEPOSIT_ASSET_SUCCESS:' + OTHER_SECRET)
  const s = await setup(t, { secrets })
  const { m, subAccountId } = await openMember(s)
  const body = { event: 'KYC_APPROVED', data: { attemptId: 'att_one', subAccountId } }
  const raw = JSON.stringify(body)

  const hexKeyed = nodeCrypto.createHmac('sha256', Buffer.from(SECRET, 'hex')).update('1.' + raw).digest('hex')
  const stringKeyed = nodeCrypto.createHmac('sha256', SECRET).update('1.' + raw).digest('hex')
  t.not(hexKeyed, stringKeyed, 'the two key readings differ')
  t.is(s.sign(raw, { ts: 1 })['x-hodle-signature'], stringKeyed)
  t.is(stringKeyed, nodeCrypto.createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(Buffer.from('1.' + raw)).digest('hex'))

  const ts = Math.floor(s.c.now() / 1000)
  const badHex = await s.deliver('KYC_APPROVED', null, { raw, headers: { 'x-hodle-timestamp': String(ts), 'x-hodle-signature': nodeCrypto.createHmac('sha256', Buffer.from(SECRET, 'hex')).update(ts + '.' + raw).digest('hex') } })
  t.is(badHex.status, 401, 'a hex-decoded key is refused')
  const wrong = await s.deliver('KYC_APPROVED', body, { secret: OTHER_SECRET })
  t.is(wrong.status, 401, 'another webhook secret')
  const tampered = await s.deliver('KYC_APPROVED', null, { raw: raw.replace('att_one', 'att_two'), headers: s.sign(raw) })
  t.is(tampered.status, 401, 'body changed after signing')
  const skewed = await s.deliver('KYC_APPROVED', body, { ts: ts - 301 })
  t.is(skewed.status, 401, 'old timestamp')
  const future = await s.deliver('KYC_APPROVED', body, { ts: ts + 301 })
  t.is(future.status, 401, 'future timestamp')
  const browser = await s.deliver('KYC_APPROVED', body, { headers: { origin: ORIGIN } })
  t.is(browser.status, 401, 'Origin header')
  const missing = await s.deliver('KYC_APPROVED', body, { unsigned: true })
  t.is(missing.status, 401, 'no signature')
  const mismatch = await s.deliver('DEPOSIT_ASSET_SUCCESS', body, { secret: OTHER_SECRET })
  t.is(mismatch.status, 401, 'path and body events differ')
  t.alike(mismatch.body, { error: 'nao-autorizado' })
  t.is(s.wallets.get(m).kyc.status, 'pendente', 'nothing applied by a refused delivery')

  const test1 = await s.deliver('KYC_APPROVED', { event: 'WEBHOOK_TEST', data: {} }, { unsigned: true })
  t.is(test1.status, 401, 'a configured secret verifies the test event too')
  const test2 = await s.deliver('KYC_APPROVED', { event: 'WEBHOOK_TEST', data: {} })
  t.is(test2.status, 200)
  t.is(s.wallets.get(m).kyc.status, 'pendente')

  const ok = await s.deliver('KYC_APPROVED', body, { ts: ts - 299 })
  t.is(ok.status, 200)
  t.is(s.wallets.get(m).kyc.status, 'aprovado')

  const big = await s.deliver('KYC_APPROVED', null, { raw: JSON.stringify({ event: 'KYC_APPROVED', pad: 'x'.repeat(70000) }) })
  t.is(big.status, 413)
})

test('webhook: KYC_APPROVED flips a member created after start; other attempts and secondary verdicts are ignored', async (t) => {
  const s = await setup(t, { secrets: new Map([['KYC_APPROVED', SECRET], ['KYC_REJECTED', SECRET]]) })
  const a = await openMember(s, { attemptId: 'att_a' })
  const stale = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { attemptId: 'att_old', subAccountId: a.subAccountId } })
  t.is(stale.status, 200)
  t.is(s.wallets.get(a.m).kyc.status, 'pendente', 'not the current attempt')
  const secondary = await s.deliver('KYC_REJECTED', { event: 'KYC_REJECTED', data: { attemptId: 'att_a', subAccountId: a.subAccountId, provider: 'SECONDARY' } })
  t.is(secondary.status, 200)
  t.is(s.wallets.get(a.m).kyc.status, 'pendente', 'a second verification never decides')
  const unknown = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { attemptId: 'att_a', subAccountId: 'sub-nobody' } })
  t.is(unknown.status, 200)
  const ok = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { attemptId: 'att_a', subAccountId: a.subAccountId } })
  t.is(ok.status, 200)
  t.is(s.wallets.get(a.m).kyc.status, 'aprovado')

  // Two members, deliveries out of order.
  const b = await openMember(s, { attemptId: 'att_b' })
  const c = await openMember(s, { attemptId: 'att_c' })
  await s.deliver('KYC_REJECTED', { event: 'KYC_REJECTED', data: { attemptId: 'att_c', subAccountId: c.subAccountId } })
  await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { attemptId: 'att_b', subAccountId: b.subAccountId } })
  await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { attemptId: 'att_c', subAccountId: c.subAccountId } })
  t.is(s.wallets.get(b.m).kyc.status, 'aprovado')
  t.is(s.wallets.get(c.m).kyc.status, 'recusado', 'a late approval never overturns a rejection')
})

test('webhook: deposit and payout events move existing rows only, once', async (t) => {
  const events = ['DEPOSIT_PIX_CONFIRMED', 'DEPOSIT_ASSET_SUCCESS', 'DEPOSIT_ASSET_REFUNDED', 'PAYOUT_SUCCESSFUL']
  const s = await setup(t, { secrets: new Map(events.map((e) => [e, SECRET])) })
  const { m, subAccountId } = await openMember(s)
  const dep = await ledgerRow(s, m, 'deposit', 'enviado')
  fakeDeposit(s, subAccountId, dep)
  s.fake.settleDeposit(dep)
  const success = { event: 'DEPOSIT_ASSET_SUCCESS', data: { eventId: 'deposit-completed-1', externalId: dep, success: true } }
  t.is((await s.deliver('DEPOSIT_ASSET_SUCCESS', success)).status, 200)
  t.is(s.ops.get(dep).status, 'concluido')
  const dup = await s.deliver('DEPOSIT_ASSET_SUCCESS', success)
  t.is(dup.status, 200)
  t.ok(tokens(s).includes('webhook-repetido'))

  // A partial refund keeps the status; a full one ends it.
  await s.deliver('DEPOSIT_ASSET_REFUNDED', { event: 'DEPOSIT_ASSET_REFUNDED', data: { eventId: 'refund-1', externalId: dep, status: 'COMPLETED', partial: true } })
  t.is(s.ops.get(dep).status, 'concluido')
  s.fake.state.deposits.get(dep).status = 'REFUNDED'
  await s.deliver('DEPOSIT_ASSET_REFUNDED', { event: 'DEPOSIT_ASSET_REFUNDED', data: { eventId: 'refund-2', externalId: dep, status: 'REFUNDED' } })
  t.is(s.ops.get(dep).status, 'devolvido')

  const before = s.files()
  const stranger = externalIdFor(m, 'deposit', opId())
  t.is((await s.deliver('DEPOSIT_PIX_CONFIRMED', { event: 'DEPOSIT_PIX_CONFIRMED', data: { eventId: 'x-1', externalId: stranger } })).status, 200)
  t.is(s.ops.get(stranger), null, 'never creates a ledger row')
  t.is((await s.deliver('DEPOSIT_PIX_CONFIRMED', { event: 'DEPOSIT_PIX_CONFIRMED', data: { eventId: 'x-2', externalId: 'my-order-123' } })).status, 200)
  t.is(s.files(), before)

  const pay = await ledgerRow(s, m, 'payout', 'incerto')
  const p = fakePayout(s, subAccountId, pay, 'COMPLETED')
  await s.deliver('PAYOUT_SUCCESSFUL', { event: 'PAYOUT_SUCCESSFUL', data: { transactionId: p.transactionId, externalId: pay, status: 'COMPLETED', txHash: '0x' + 'CD'.repeat(32), pixKey: 'recipient@example.com' } })
  const row = s.ops.get(pay)
  t.is(row.status, 'concluido')
  t.is(row.txHash, p.txHash, 'the hash Hodle reports, not the delivery\'s')
  t.absent(s.files().includes('recipient@example.com'))
})

test('webhook: a final payout or deposit event writes only the status Hodle reports (S1)', async (t) => {
  const events = ['PAYOUT_FAILED', 'PAYOUT_SUCCESSFUL', 'DEPOSIT_ASSET_SUCCESS']
  const s = await setup(t, { secrets: new Map(events.map((e) => [e, SECRET])) })
  const { m, subAccountId } = await openMember(s)

  // PAYOUT_FAILED while Hodle shows the payout completed: never falhou.
  const done = await ledgerRow(s, m, 'payout', 'pendente')
  const pd = fakePayout(s, subAccountId, done, 'COMPLETED')
  const failed = await s.deliver('PAYOUT_FAILED', { event: 'PAYOUT_FAILED', data: { transactionId: pd.transactionId, externalId: done, status: 'FAILED' } })
  t.is(failed.status, 200)
  t.is(s.ops.get(done).status, 'concluido', 'Hodle says COMPLETED, so the row is concluido')
  t.is(s.ops.unresolvedDebits(m).length, 0)

  // PAYOUT_FAILED while Hodle still processes it: the row is not ended.
  const busy = await ledgerRow(s, m, 'payout', 'incerto')
  const pb = fakePayout(s, subAccountId, busy, 'PENDING')
  t.is((await s.deliver('PAYOUT_FAILED', { event: 'PAYOUT_FAILED', data: { transactionId: pb.transactionId, externalId: busy, status: 'FAILED' } })).status, 200)
  t.is(s.ops.get(busy).status, 'pendente', 'never falhou while Hodle reports PENDING')

  // PAYOUT_SUCCESSFUL flips only because Hodle reports COMPLETED.
  const later = await ledgerRow(s, m, 'payout', 'pendente')
  const pl = fakePayout(s, subAccountId, later, 'PENDING')
  t.is((await s.deliver('PAYOUT_SUCCESSFUL', { event: 'PAYOUT_SUCCESSFUL', data: { transactionId: pl.transactionId, externalId: later, status: 'COMPLETED' } })).status, 200)
  t.is(s.ops.get(later).status, 'pendente', 'a success Hodle does not show yet changes nothing')

  // DEPOSIT_ASSET_SUCCESS follows the fake's deposit status.
  const dep = await ledgerRow(s, m, 'deposit', 'enviado')
  fakeDeposit(s, subAccountId, dep)
  t.is((await s.deliver('DEPOSIT_ASSET_SUCCESS', { event: 'DEPOSIT_ASSET_SUCCESS', data: { eventId: 'dep-early', externalId: dep } })).status, 200)
  t.is(s.ops.get(dep).status, 'pendente', 'Hodle still shows the charge pending')
  s.fake.settleDeposit(dep)
  t.is((await s.deliver('DEPOSIT_ASSET_SUCCESS', { event: 'DEPOSIT_ASSET_SUCCESS', data: { eventId: 'dep-paid', externalId: dep } })).status, 200)
  t.is(s.ops.get(dep).status, 'concluido')
  t.ok(s.fake.seen.some((r) => r.method === 'GET' && r.path === '/api/deposit/' + dep), 'the deposit was read from Hodle')
})

test('webhook: a failed read answers 503 and is not remembered, so the retry applies (S1)', async (t) => {
  const s = await setup(t, { secrets: new Map([['PAYOUT_FAILED', SECRET]]) })
  const { m, subAccountId } = await openMember(s)
  const pay = await ledgerRow(s, m, 'payout', 'pendente')
  const p = fakePayout(s, subAccountId, pay, 'FAILED')
  const body = { event: 'PAYOUT_FAILED', data: { transactionId: p.transactionId, externalId: pay, status: 'FAILED' } }
  s.fake.script({ statement: (req, res, ctx) => ctx.json(res, 500, { success: false, error: 'down' }) })
  const down = await s.deliver('PAYOUT_FAILED', body)
  t.is(down.status, 503)
  t.alike(down.body, { error: 'indisponivel' })
  t.is(s.ops.get(pay).status, 'pendente', 'nothing written without Hodle\'s answer')
  t.ok(tokens(s).includes('webhook-leitura'))
  s.fake.script({})
  const again = await s.deliver('PAYOUT_FAILED', body)
  t.is(again.status, 200)
  t.is(s.ops.get(pay).status, 'falhou', 'Hodle confirms the failure')
  t.absent(tokens(s).includes('webhook-repetido'), 'the failed delivery was not deduped')
})

test('webhook: unsigned traffic never spends the window; verified deliveries do; a body over 16 KiB is refused (S6, R2)', async (t) => {
  const s = await setup(t, { secrets: new Map([['KYC_APPROVED', SECRET]]) })
  const { m, subAccountId } = await openMember(s)
  t.is(MAX_BODY, 16384)
  const over = await s.deliver('KYC_APPROVED', null, { raw: JSON.stringify({ event: 'KYC_APPROVED', pad: 'x'.repeat(MAX_BODY) }) })
  t.is(over.status, 413)
  for (let i = 0; i < 310; i++) {
    const r = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: {} }, { unsigned: true })
    if (r.status !== 401) t.fail('unsigned request ' + i + ' answered ' + r.status)
  }
  const real = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { attemptId: 'att_one', subAccountId } })
  t.is(real.status, 200, 'a signed delivery after 310 unsigned ones is not 429')
  t.is(s.wallets.get(m).kyc.status, 'aprovado', 'and it is applied')
  t.absent(tokens(s).includes('webhook-limite'))
  // Distinct bodies: an identical one would be answered as a replay.
  for (let i = 2; i <= 300; i++) {
    const r = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { n: i } })
    if (r.status !== 200) t.fail('signed delivery ' + i + ' answered ' + r.status)
  }
  const limited = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { n: 301 } })
  t.is(limited.status, 429, 'the 301st verified delivery in a minute is refused')
  t.ok(tokens(s).includes('webhook-limite'))
  const unsigned = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: {} }, { unsigned: true })
  t.is(unsigned.status, 401, 'unsigned traffic is still checked, never 429')
  s.c.offset += 61 * 1000
  const later = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { n: 302 } })
  t.is(later.status, 200, 'a new window admits again')
})

test('webhook: a replayed genuine delivery never spends the window; a 503 stays retryable (Y2)', async (t) => {
  const s = await setup(t, { secrets: new Map([['KYC_APPROVED', SECRET], ['PAYOUT_FAILED', SECRET]]) })
  const { m, subAccountId } = await openMember(s)
  const captured = { event: 'KYC_APPROVED', data: { n: 0 } }
  const ts = Math.floor(s.c.now() / 1000)
  for (let i = 0; i < 400; i++) {
    const r = await s.deliver('KYC_APPROVED', captured, { ts })
    if (r.status !== 200) t.fail('replay ' + i + ' answered ' + r.status)
  }
  t.absent(tokens(s).includes('webhook-limite'))
  t.is(tokens(s).filter((x) => x === 'webhook-repetido').length, 399)
  // 298 distinct deliveries and one real one fit the window of 300 only if
  // the 400 replays spent a single unit.
  for (let i = 1; i < 299; i++) {
    const r = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { n: i } })
    if (r.status !== 200) t.fail('distinct delivery ' + i + ' answered ' + r.status)
  }
  const real = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { attemptId: 'att_one', subAccountId } })
  t.is(real.status, 200, 'a different genuine delivery after the replays is admitted')
  t.is(s.wallets.get(m).kyc.status, 'aprovado', 'and applied')
  t.absent(tokens(s).includes('webhook-limite'))

  s.c.offset += 61 * 1000
  const pay = await ledgerRow(s, m, 'payout', 'pendente')
  const p = fakePayout(s, subAccountId, pay, 'FAILED')
  const body = { event: 'PAYOUT_FAILED', data: { transactionId: p.transactionId, externalId: pay, status: 'FAILED' } }
  const sent = Math.floor(s.c.now() / 1000)
  s.fake.script({ statement: (req, res, ctx) => ctx.json(res, 500, { success: false, error: 'down' }) })
  t.is((await s.deliver('PAYOUT_FAILED', body, { ts: sent })).status, 503)
  s.fake.script({})
  const again = await s.deliver('PAYOUT_FAILED', body, { ts: sent })
  t.is(again.status, 200)
  t.is(s.ops.get(pay).status, 'falhou', 'the same signed delivery is applied once the read recovers')
})

test('webhook: registrar posts have their own window and never spend the one signed deliveries use (X2)', async (t) => {
  const s = await setup(t, { secrets: new Map([['DEPOSIT_ASSET_SUCCESS', 'registrar'], ['KYC_APPROVED', SECRET]]) })
  const { m, subAccountId } = await openMember(s)
  for (let i = 0; i < 30; i++) {
    const r = await s.deliver('DEPOSIT_ASSET_SUCCESS', { event: 'WEBHOOK_TEST' }, { unsigned: true })
    if (r.status !== 200) t.fail('registrar post ' + i + ' answered ' + r.status)
  }
  t.absent(tokens(s).includes('webhook-limite'))
  const limited = await s.deliver('DEPOSIT_ASSET_SUCCESS', { event: 'WEBHOOK_TEST' }, { unsigned: true })
  t.is(limited.status, 429, 'the 31st registrar post in a minute is refused')
  t.ok(tokens(s).includes('webhook-limite'))
  for (let i = 31; i < 300; i++) await s.deliver('DEPOSIT_ASSET_SUCCESS', { event: 'WEBHOOK_TEST' }, { unsigned: true })
  const real = await s.deliver('KYC_APPROVED', { event: 'KYC_APPROVED', data: { attemptId: 'att_one', subAccountId } })
  t.is(real.status, 200, 'a signed delivery after 300 registrar posts is not 429')
  t.is(s.wallets.get(m).kyc.status, 'aprovado', 'and it is applied')
  s.c.offset += 61 * 1000
  const later = await s.deliver('DEPOSIT_ASSET_SUCCESS', { event: 'WEBHOOK_TEST' }, { unsigned: true })
  t.is(later.status, 200, 'a new window admits registrar posts again')
})

test('webhook: disputes set the flag and keep the status; two members, reordered deliveries (C3)', async (t) => {
  const events = ['DISPUTE_CREATED', 'DISPUTE_ACCEPTED', 'DISPUTE_CANCELED']
  const s = await setup(t, { secrets: new Map(events.map((e) => [e, SECRET])) })
  const a = await openMember(s, { attemptId: 'att_a' })
  const b = await openMember(s, { attemptId: 'att_b' })
  const depA = await ledgerRow(s, a.m, 'deposit', 'enviado')
  await s.ops.put({ externalId: depA, member: a.m, kind: 'deposit', status: 'concluido', cents: 1000, fee: { cents: 0, status: 'nenhuma' } })
  const depB = await ledgerRow(s, b.m, 'deposit', 'concluido')
  const dispute = (event, externalId, endToEndId) => ({
    event,
    data: { status: event.slice(8), endToEndId, value: 1000, reason: 'texto livre do pagador', payer: { taxId: CPF }, walletCharge: { externalId } }
  })

  await s.deliver('DISPUTE_ACCEPTED', dispute('DISPUTE_ACCEPTED', depB, 'E2EB'))
  await s.deliver('DISPUTE_CREATED', dispute('DISPUTE_CREATED', depA, 'E2EA'))
  await s.deliver('DISPUTE_CREATED', dispute('DISPUTE_CREATED', depB, 'E2EB'))
  t.is(s.ops.get(depA).dispute, 'aberta')
  t.is(s.ops.get(depA).status, 'concluido', 'the status never changes')
  t.is(s.ops.get(depB).dispute, 'aceita', 'a late creation never reopens a decided dispute')
  t.ok(tokens(s).includes('contestacao'))
  await s.deliver('DISPUTE_CANCELED', dispute('DISPUTE_CANCELED', depA, 'E2EA'))
  t.is(s.ops.get(depA).dispute, 'cancelada')
  const before = s.files()
  await s.deliver('DISPUTE_CREATED', dispute('DISPUTE_CREATED', 'my-order-123', 'E2EC'))
  t.is(s.files(), before, 'a foreign id touches nothing')

  const exposed = s.files() + '\n' + s.logs.join('\n') + '\n' + s.texts.join('\n')
  for (const value of [CPF, PIN, SECRET, 'texto livre do pagador']) t.absent(exposed.includes(value))
  for (const line of s.logs) {
    const e = JSON.parse(line)
    t.alike(Object.keys(e).sort(), e.event === 'carteira' ? ['event', 'reason'] : Object.keys(e).sort())
  }
})

test('webhook: parseWebhookSecrets accepts EVENT:hex64 and EVENT:registrar only', async (t) => {
  t.is(parseWebhookSecrets(''), null)
  const m = parseWebhookSecrets('KYC_APPROVED:registrar, DEPOSIT_ASSET_SUCCESS:' + SECRET)
  t.is(m.get('KYC_APPROVED'), 'registrar')
  t.is(m.get('DEPOSIT_ASSET_SUCCESS'), SECRET)
  for (const bad of ['KYC_APPROVED', 'KYC_APPROVED:' + SECRET.toUpperCase(), 'kyc:' + SECRET, 'A:registrar,A:registrar', 'A:abc']) {
    t.exception.all(() => parseWebhookSecrets(bad), /VARANDA_HODLE_WEBHOOK_SECRETS/)
  }
  try {
    parseWebhookSecrets('A:' + SECRET.slice(2))
  } catch (err) {
    t.absent(err.message.includes(SECRET.slice(2)), 'the value is never in the message')
  }
})

test('webhook: after a lost submit a KYC event for an id never seen before is adopted; a previous id is ignored', async (t) => {
  const s = await setup(t, { secrets: new Map([['KYC_APPROVED', SECRET], ['KYC_REJECTED', SECRET]]) })
  const { m, subAccountId } = await openMember(s, { attemptId: 'att_1' })
  await s.wallets.setKyc({ member: m, status: 'recusado' })
  await s.wallets.setKyc({ member: m, status: 'documentos', documentId: 'doc_c', selfieId: 'doc_d' })
  await s.wallets.setKyc({ member: m, status: 'pendente' })
  t.alike(s.wallets.get(m).kyc.previousAttemptIds, ['att_1'])
  t.is(s.wallets.get(m).kyc.attemptId, null, 'the submit answer was lost')

  await s.deliver('KYC_REJECTED', { event: 'KYC_REJECTED', data: { attemptId: 'att_1', subAccountId } })
  t.is(s.wallets.get(m).kyc.status, 'pendente', 'the closed first attempt never ends this one')
  await s.deliver('KYC_REJECTED', { event: 'KYC_REJECTED', data: { attemptId: 'att_2', subAccountId } })
  const k = s.wallets.get(m).kyc
  t.is(k.status, 'recusado', 'a new id is this attempt, even when closed')
  t.is(k.attemptId, 'att_2')
  t.is(k.attempt, 2)
})
