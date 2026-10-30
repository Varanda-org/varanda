'use strict'

// apps/cli/lib/account/hodle.js against the loopback Hodle fake. No socket
// leaves 127.0.0.1: the endpoint base and the fetch both point at the fake.

const test = require('brittle')
const {
  createHodle,
  kycOutcome,
  decodeDeposit,
  decodeQuote,
  decodePayout,
  redact,
  brlToCents,
  centsToAmount,
  depositOutcome,
  BASES,
  MONEY_TIMEOUT_MS
} = require('../lib/account/hodle')
const { startFakeHodle, loopbackFetch, FIXTURES, PROTECTED_KEY, KEYS_WINDOW_MS } = require('./helpers/fake-hodle')

const API_KEY = 'hodle_test_SEGREDO-chave-de-teste'
const PIN = '482915'
const CPF = '98765432100'
const NAME = 'membro-0a1b2c3d'

async function fakeFor (t) {
  const fake = await startFakeHodle()
  t.teardown(() => fake.close(), { force: true })
  return fake
}

function client (fake, extra = {}) {
  return createHodle({
    apiKey: API_KEY,
    endpoints: { base: fake.base },
    fetch: loopbackFetch(fake.base),
    ...extra
  })
}

function noLeak (t, value) {
  const text = JSON.stringify(value) + String(value && value.message) + String(value && value.stack)
  for (const secret of [API_KEY, 'SEGREDO', PIN, CPF]) t.absent(text.includes(secret), 'leaks nothing')
}

function kycFields (subAccountId, extra = {}) {
  return {
    subAccountId,
    fullName: 'Pessoa de Teste',
    dateOfBirth: '1990-01-15',
    taxIdNumber: CPF,
    email: 'pessoa@example.com',
    state: 'SP',
    city: 'São Paulo',
    zipCode: '01000-000',
    streetAddress: 'Av. Paulista, 1000',
    uploadedSelfieId: 'doc_selfie1',
    uploadedDocumentId: 'doc_id1',
    ...extra
  }
}

function checkRequest (t, seen, method, path) {
  t.is(seen.method, method)
  t.is(seen.path + seen.query, path)
  t.is(seen.headers.authorization, 'Bearer ' + API_KEY)
  t.is(seen.headers.accept, 'application/json')
}

async function onboarded (h) {
  const sub = await h.createSubaccount({ name: NAME })
  return sub.subAccountId
}

test('createHodle refuses a bad key or network without echoing it', (t) => {
  const bad = [
    { apiKey: '' },
    { apiKey: 'SEGREDO-sem-prefixo-123456' },
    { apiKey: 'hodle_prod_SEGREDO123' },
    { apiKey: 'hodle_test_SEG' },
    { apiKey: 'hodle_test_SEGREDO com espaco' },
    { apiKey: 'hodle_test_SEGREDO\nlinha' },
    { apiKey: 'hodle_test_' + 'SEGREDO'.repeat(40) },
    { apiKey: 42 },
    { apiKey: API_KEY, network: 'tron-SEGREDO' },
    { apiKey: API_KEY, network: 'solana' },
    { apiKey: API_KEY, endpoints: { base: '' } }
  ]
  for (const opts of bad) {
    try {
      createHodle(opts)
      t.fail('should throw')
    } catch (err) {
      t.ok(err instanceof TypeError)
      noLeak(t, err)
    }
  }
  t.is(createHodle({ apiKey: API_KEY }).network, 'polygon')
  t.is(createHodle({ apiKey: API_KEY, network: 'base' }).network, 'base')
})

test('base url follows the key prefix', async (t) => {
  const urls = []
  const capture = (url) => {
    urls.push(String(url))
    throw new Error('captured')
  }
  await createHodle({ apiKey: 'hodle_live_abcdefgh123', fetch: capture }).kycStatus('att_1')
  await createHodle({ apiKey: 'hodle_test_abcdefgh123', fetch: capture }).kycStatus('att_1')
  t.alike(urls, [BASES.live + '/api/kyc/att_1', BASES.test + '/api/kyc/att_1'])
  t.is(BASES.live, 'https://api.hodle.com.br')
  t.is(BASES.test, 'https://sandbox-api.hodle.com.br')
})

test('createSubaccount: POST /api/subaccount with an individual account', async (t) => {
  const fake = await fakeFor(t)
  const result = await client(fake).createSubaccount({ name: NAME })
  t.is(result.ok, true)
  t.alike(Object.keys(result).sort(), ['ok', 'subAccountId'])
  t.ok(fake.state.subaccounts.has(result.subAccountId))
  t.is(fake.seen.length, 1)
  checkRequest(t, fake.seen[0], 'POST', '/api/subaccount')
  t.is(fake.seen[0].headers['content-type'], 'application/json')
  t.alike(fake.seen[0].body, { name: NAME, accountType: 'INDIVIDUAL' })
})

test('input checks refuse before any request', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const refused = [
    h.createSubaccount({ name: '' }),
    h.createSubaccount({ name: 'x'.repeat(65) }),
    h.createSubaccount({ name: 'a\nb' }),
    h.findSubaccounts({}),
    h.createSubaccount({ name: 'membro-\ud800' }),
    h.findSubaccounts({ name: 'membro-\ud800' }),
    h.findSubaccounts({ name: '\udc00membro' }),
    h.kycSubmit(kycFields('sub1', { city: 'S\ud800o Paulo' })),
    h.kycDocument({ subAccountId: 'sub/1', documentType: 'ID' }),
    h.kycDocument({ subAccountId: 'sub1', documentType: 'SELFIE' }),
    h.kycDocument({ subAccountId: 'sub1', documentType: 'ID', isDoubleSided: 'sim' }),
    h.kycDocumentReady({ subAccountId: 'sub1', documentId: 'x'.repeat(129) }),
    h.kycSubmit(kycFields('sub1', { taxIdNumber: '123.456.789-00' })),
    h.kycSubmit(kycFields('sub1', { taxIdNumber: '1234567890' })),
    h.kycSubmit(kycFields('sub1', { dateOfBirth: '15/01/1990' })),
    h.kycSubmit(kycFields('sub1', { dateOfBirth: '1990-13-01' })),
    h.kycSubmit(kycFields('sub1', { city: 'x'.repeat(257) })),
    h.kycSubmit(kycFields('sub1', { fullName: undefined })),
    h.kycSubmit(kycFields('sub1', { uploadedSelfieId: 'doc selfie' })),
    h.kycSubmit(kycFields('sub1', { sandboxReject: 'true' })),
    h.kycStatus('att 1'),
    h.createWallet({ subAccountId: 'sub1', walletPin: '12345' }),
    h.createWallet({ subAccountId: 'sub1', walletPin: '1234567' }),
    h.createWallet({ subAccountId: 'sub1', walletPin: 'abcdef' }),
    h.createWallet({ subAccountId: 'sub1', walletPin: 482915 }),
    h.walletKeys({ subAccountId: 'sub1', walletId: '' }),
    h.walletGet({ subAccountId: 'sub1', sync: 'yes' }),
    h.kycDocumentReady({ subAccountId: 'sub1', documentId: '..' }),
    h.kycDocumentReady({ subAccountId: '.', documentId: 'doc_1' }),
    h.kycStatus('..'),
    h.kycStatus('...'),
    h.walletKeys({ subAccountId: 'sub1', walletId: '.' }),
    h.kycSubmit(kycFields('sub1', { dateOfBirth: '2023-02-29' })),
    h.kycSubmit(kycFields('sub1', { dateOfBirth: '1990-04-31' })),
    h.kycSubmit(kycFields('sub1', { dateOfBirth: '2999-01-01' })),
    h.kycSubmit(kycFields('sub1', { phone: 42 }))
  ]
  for (const result of await Promise.all(refused)) {
    t.alike(result, { ok: false, reason: 'entrada' })
    noLeak(t, result)
  }
  t.is(fake.seen.length, 0, 'no request reached the fake')
})

test('createWallet refuses a bad PIN before any request', async (t) => {
  const fake = await fakeFor(t)
  const result = await client(fake).createWallet({ subAccountId: 'sub1', walletPin: '12a456' })
  t.alike(result, { ok: false, reason: 'entrada' })
  t.is(fake.seen.length, 0)
})

test('kycDocument: double-sided ID and liveness selfie', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const sub = await onboarded(h)

  const id = await h.kycDocument({ subAccountId: sub, documentType: 'ID', isDoubleSided: true })
  t.is(id.ok, true)
  t.alike(Object.keys(id).sort(), ['documentId', 'ok', 'uploadUrlBack', 'uploadUrlFront'])
  t.ok(id.uploadUrlFront.startsWith('https://uploads.hodle.com.br/'))
  checkRequest(t, fake.seen[1], 'POST', '/api/kyc/document')
  t.alike(fake.seen[1].body, { subAccountId: sub, documentType: 'ID', isDoubleSided: true })

  const front = await h.kycDocument({ subAccountId: sub, documentType: 'PASSPORT' })
  t.alike(Object.keys(front).sort(), ['documentId', 'ok', 'uploadUrlFront'])

  const selfie = await h.kycDocument({ subAccountId: sub, documentType: 'SELFIE-FROM-LIVENESS' })
  t.is(selfie.ok, true)
  t.alike(Object.keys(selfie).sort(), ['documentId', 'livenessUrl', 'ok'])
  t.ok(selfie.livenessUrl.startsWith('https://app.hodle.com.br/liveness/'))
  t.absent(JSON.stringify(selfie).includes('livenessIdentityPoolId'))
})

test('kycDocument: hosted urls outside the exact hodle hosts are refused', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const badUploads = [
    'https://evil.hodle.com.br/x',
    'https://app.hodle.com.br/x',
    'https://uploads.hodle.com.br.evil.test/x',
    'http://uploads.hodle.com.br/x',
    'https://user:pw@uploads.hodle.com.br/x',
    'https://uploads.hodle.com.br:8443/x',
    'javascript:alert(1)',
    42
  ]
  for (const url of badUploads) {
    fake.script({ kycDocument (req, res, ctx) { ctx.json(res, 201, { success: true, data: { documentId: 'doc_1', uploadUrlFront: url } }) } })
    const result = await h.kycDocument({ subAccountId: 'sub1', documentType: 'ID' })
    t.is(result.reason, 'formato', 'upload url refused')
    t.is(result.uncertain, true)
  }
  for (const url of ['https://uploads.hodle.com.br/l', 'https://liveness.hodle.com.br/l', 'https://app.hodle.com.br.evil.test/l']) {
    fake.script({ kycDocument (req, res, ctx) { ctx.json(res, 201, { success: true, data: { documentId: 'doc_1', livenessUrl: url } }) } })
    const result = await h.kycDocument({ subAccountId: 'sub1', documentType: 'SELFIE-FROM-LIVENESS' })
    t.is(result.reason, 'formato', 'liveness url refused')
  }
  fake.script({ kycDocument (req, res, ctx) { ctx.json(res, 201, { success: true, data: { documentId: 'doc_1', uploadUrlFront: 'https://uploads.hodle.com.br/f' } }) } })
  const missingBack = await h.kycDocument({ subAccountId: 'sub1', documentType: 'ID', isDoubleSided: true })
  t.is(missingBack.reason, 'formato', 'a double-sided document needs its back url')
})

test('kycDocumentReady: GET with the subaccount in the query', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const sub = await onboarded(h)
  const doc = await h.kycDocument({ subAccountId: sub, documentType: 'SELFIE-FROM-LIVENESS' })
  t.alike(await h.kycDocumentReady({ subAccountId: sub, documentId: doc.documentId }), { ok: true, ready: false })
  checkRequest(t, fake.seen[2], 'GET', '/api/kyc/document/' + doc.documentId + '?subAccountId=' + sub)
  fake.state.documents.get(doc.documentId).ready = true
  t.alike(await h.kycDocumentReady({ subAccountId: sub, documentId: doc.documentId }), { ok: true, ready: true })
})

test('kycLatest: GET by subaccount, adopts lastAttemptId, refuses anything else', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const sub = await onboarded(h)
  t.alike(await h.kycLatest({ subAccountId: sub }), { ok: true, lastAttemptId: null, outcome: null })
  checkRequest(t, fake.seen[1], 'GET', '/api/kyc?subAccountId=' + sub)
  const submitted = await h.kycSubmit(kycFields(sub, { zipCode: '01000000' }))
  t.alike(await h.kycLatest({ subAccountId: sub }), { ok: true, lastAttemptId: submitted.attemptId, outcome: 'aprovado' })
  for (const data of [{}, { lastAttemptId: '..' }, { lastAttemptId: 7 }, { lastAttemptId: 'a b' }]) {
    fake.script({ kycLatest: (req, res, ctx) => ctx.json(res, 200, { success: true, data }) })
    t.alike(await h.kycLatest({ subAccountId: sub }), { ok: false, reason: 'formato' }, JSON.stringify(data))
  }
  fake.script({ kycLatest: (req, res, ctx) => ctx.json(res, 200, { success: true, lastAttemptId: 'att_top' }) })
  t.alike(await h.kycLatest({ subAccountId: sub }), { ok: true, lastAttemptId: 'att_top', outcome: null })
  t.alike(await h.kycLatest({ subAccountId: '..' }), { ok: false, reason: 'entrada' })
})

test('kycSubmit: BRA tax country, whitelisted fields, sandbox rejection', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const sub = await onboarded(h)
  const result = await h.kycSubmit(kycFields(sub, { phone: '+5511999990000', ignored: 'x' }))
  t.is(result.ok, true)
  t.alike(Object.keys(result).sort(), ['attemptId', 'ok'])
  noLeak(t, result)
  const sent = fake.seen[1]
  checkRequest(t, sent, 'POST', '/api/kyc')
  t.is(sent.body.countryOfTaxId, 'BRA')
  t.is(sent.body.country, 'BRA')
  t.is(sent.body.taxIdNumber, CPF)
  t.is(sent.body.phone, '+5511999990000')
  t.absent('ignored' in sent.body)
  t.absent('sandboxReject' in sent.body)

  t.alike(await h.kycStatus(result.attemptId), { ok: true, outcome: 'aprovado' })
  checkRequest(t, fake.seen[2], 'GET', '/api/kyc/' + result.attemptId)

  const rejected = await h.kycSubmit(kycFields(sub, { sandboxReject: true }))
  t.is(fake.seen[3].body.sandboxReject, true)
  const status = await h.kycStatus(rejected.attemptId)
  t.alike(status, { ok: true, outcome: 'recusado' })
  t.absent(JSON.stringify(status).includes('SANDBOX_SIMULATED'), 'rejection text dropped')

  const blanks = await h.kycSubmit(kycFields(sub, { phone: '', addressNumber: null, addressComplement: '   ' }))
  t.is(blanks.ok, true, 'empty optional fields are treated as absent')
  const blankBody = fake.seen[fake.seen.length - 1].body
  for (const k of ['phone', 'addressNumber', 'addressComplement']) t.absent(k in blankBody)
  t.is((await h.kycSubmit(kycFields(sub, { dateOfBirth: '2024-02-29' }))).ok, true, 'a real leap day passes')
})

test('kycOutcome maps every status and drops the rest', (t) => {
  t.is(kycOutcome({ status: 'PENDING' }), 'pendente')
  t.is(kycOutcome({ status: 'APPROVED' }), 'aprovado')
  t.is(kycOutcome({ status: 'REJECTED', rejectionReason: 'x' }), 'recusado')
  t.is(kycOutcome({ status: 'EXPIRED' }), 'expirado')
  t.is(kycOutcome({ status: 'approved' }), 'desconhecido')
  t.is(kycOutcome({ status: 'toString' }), 'desconhecido')
  t.is(kycOutcome({ status: 'FAILED' }), 'desconhecido')
  t.is(kycOutcome({}), 'desconhecido')
  t.is(kycOutcome(null), 'desconhecido')
  t.is(kycOutcome([]), 'desconhecido')
})

test('createWallet: network in the body, lowercased address, new key kept', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake, { network: 'base' })
  const sub = await onboarded(h)
  const result = await h.createWallet({ subAccountId: sub, walletPin: PIN })
  t.is(result.ok, true)
  t.alike(Object.keys(result).sort(), ['address', 'ok', 'protectedSymmetricKey', 'walletId'])
  t.ok(/^0x[0-9a-f]{40}$/.test(result.address))
  t.ok(result.protectedSymmetricKey.startsWith(PROTECTED_KEY))
  const sent = fake.seen[1]
  checkRequest(t, sent, 'POST', '/api/wallet/create')
  t.alike(sent.body, { network: 'base', walletPin: PIN, subAccountId: sub })
  t.is(fake.state.walletCreates, 1)
  noLeak(t, result)

  fake.script({ walletCreate (req, res, ctx) { ctx.json(res, 201, { success: true, data: { id: 'w1', address: '0x' + 'a'.repeat(40), network: 'polygon', protectedSymmetricKey: 'k' } }) } })
  const wrongNet = await h.createWallet({ subAccountId: sub, walletPin: PIN })
  t.alike(wrongNet, { ok: false, reason: 'formato', uncertain: true }, 'a wallet on another network is refused')
  fake.script({ walletCreate (req, res, ctx) { ctx.json(res, 201, { success: true, data: { id: 'w1', address: '0x123', protectedSymmetricKey: 'k' } }) } })
  t.is((await h.createWallet({ subAccountId: sub, walletPin: PIN })).reason, 'formato')
})

test('walletKeys keeps the walletId and is rate limited per minute', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const sub = await onboarded(h)
  const wallet = await h.createWallet({ subAccountId: sub, walletPin: PIN })

  const keys = await h.walletKeys({ subAccountId: sub })
  t.alike(keys, { ok: true, walletId: wallet.walletId, protectedSymmetricKey: wallet.protectedSymmetricKey })
  checkRequest(t, fake.seen[2], 'POST', '/api/wallet/keys')
  t.alike(fake.seen[2].body, { subAccountId: sub })
  t.absent(JSON.stringify(keys).includes('membro@example.com'), 'email dropped')

  fake.state.now += 15000
  const limited = await h.walletKeys({ subAccountId: sub, walletId: wallet.walletId })
  t.alike(limited, { ok: false, reason: 'http-429', retryAfter: 45 })
  t.alike(fake.seen[3].body, { subAccountId: sub, walletId: wallet.walletId })

  fake.state.now += KEYS_WINDOW_MS
  t.is((await h.walletKeys({ subAccountId: sub, walletId: wallet.walletId })).walletId, wallet.walletId)

  fake.script({ walletKeys (req, res, ctx) { ctx.json(res, 200, { success: true, data: { walletId: 'otro', protectedSymmetricKey: 'k' } }) } })
  t.is((await h.walletKeys({ subAccountId: sub, walletId: wallet.walletId })).reason, 'formato', 'another wallet is refused')
  fake.script({ walletKeys (req, res, ctx) { ctx.json(res, 200, { success: true, data: { protectedSymmetricKey: 'k' } }) } })
  t.is((await h.walletKeys({ subAccountId: sub })).reason, 'formato', 'a key without its walletId is refused')
})

test('walletGet: address of the configured network or null, its balances only', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const sub = await onboarded(h)

  t.alike(await h.walletGet({ subAccountId: sub }), { ok: true, address: null, balances: [], walletId: null, verified: false })
  checkRequest(t, fake.seen[1], 'POST', '/api/wallet/get')
  t.alike(fake.seen[1].body, { subAccountId: sub, sync: false })

  const wallet = await h.createWallet({ subAccountId: sub, walletPin: PIN })
  const read = await h.walletGet({ subAccountId: sub, walletId: wallet.walletId, sync: true })
  t.alike(read, {
    ok: true,
    address: wallet.address,
    balances: [{ network: 'polygon', asset: 'BRLA', amount: '0.00' }],
    walletId: wallet.walletId,
    verified: true
  })
  t.alike(fake.seen[3].body, { subAccountId: sub, sync: true, walletId: wallet.walletId })

  const other = await h.walletGet({ subAccountId: sub, walletId: 'w-desconhecida' })
  t.alike(other, { ok: false, reason: 'http-404' })

  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { walletId: 'outra', addresses: {}, balances: [] } }) } })
  t.is((await h.walletGet({ subAccountId: sub, walletId: wallet.walletId })).reason, 'formato')
  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { addresses: { polygon: 'TQHv' }, balances: [] } }) } })
  t.is((await h.walletGet({ subAccountId: sub })).reason, 'formato')
  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { addresses: {}, balances: [{ network: 'polygon', asset: 'BRLA', amount: 1 }] } }) } })
  t.is((await h.walletGet({ subAccountId: sub })).reason, 'formato')

  const addr = '0x' + 'b'.repeat(40)
  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { addresses: { polygon: addr }, balances: [] } }) } })
  t.alike(await h.walletGet({ subAccountId: sub, walletId: wallet.walletId }),
    { ok: true, address: addr, balances: [], walletId: null, verified: false }, 'no echo: not verified')
  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { walletId: '..', addresses: {}, balances: [] } }) } })
  t.is((await h.walletGet({ subAccountId: sub })).reason, 'formato', 'a dot id echoed back is refused')

  const others = []
  for (let i = 0; i < 100; i++) others.push({ network: 'tron', asset: 'USDT', amount: '0' })
  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { addresses: {}, balances: [...others, { network: 'polygon', asset: 'BRLA', amount: '3.5' }] } }) } })
  t.alike((await h.walletGet({ subAccountId: sub })).balances, [{ network: 'polygon', asset: 'BRLA', amount: '3.5' }],
    'other networks do not count toward the row bound')
  const many = []
  for (let i = 0; i < 513; i++) many.push({ network: 'tron', asset: 'USDT', amount: '0' })
  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { addresses: {}, balances: many } }) } })
  t.is((await h.walletGet({ subAccountId: sub })).reason, 'formato', 'the raw array stays bounded')
})

test('C12: an uncertain subaccount creation is recovered by name, never created again', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake, { timeoutMs: 100 })
  const realCreate = (req, res, ctx) => {
    const id = 'sub-' + ctx.body.name
    fake.state.subaccounts.set(id, { name: ctx.body.name })
    // The provider applies the creation, then the answer never arrives.
  }
  fake.script({ createSubaccount: realCreate })
  const created = await h.createSubaccount({ name: NAME })
  t.alike(created, { ok: false, reason: 'tempo', uncertain: true })

  fake.state.subaccounts.set('sub-other', { name: NAME + '-x' })
  const found = await h.findSubaccounts({ name: NAME })
  t.alike(found, { ok: true, subAccountIds: ['sub-' + NAME], complete: true })
  const last = fake.seen[fake.seen.length - 1]
  checkRequest(t, last, 'GET', '/api/subaccount?name=' + NAME)
  t.is(fake.seen.filter((r) => r.method === 'POST').length, 1, 'no second creation')

  const none = await h.findSubaccounts({ name: 'membro-ffffffff' })
  t.alike(none, { ok: true, subAccountIds: [], complete: true })

  fake.script({ listSubaccounts (req, res, ctx) { ctx.json(res, 200, { success: true, data: { items: [{ subAccountId: 's1', name: NAME }], nextCursor: 'abc' } }) } })
  t.alike(await h.findSubaccounts({ name: NAME }), { ok: true, subAccountIds: ['s1'], complete: false })
  fake.script({ listSubaccounts (req, res, ctx) { ctx.json(res, 200, { success: true, data: [{ name: NAME }] }) } })
  t.is((await h.findSubaccounts({ name: NAME })).reason, 'formato', 'a matching row without an id')

  fake.script({ listSubaccounts (req, res, ctx) { ctx.json(res, 200, { success: true, data: { items: [{ id: 's1', name: NAME }] }, nextCursor: 'abc' }) } })
  t.alike(await h.findSubaccounts({ name: NAME }), { ok: true, subAccountIds: ['s1'], complete: false }, 'top-level cursor')
  fake.script({ listSubaccounts (req, res, ctx) { ctx.json(res, 200, { success: true, data: [{ id: 's1', name: NAME }], cursor: 'abc' }) } })
  t.is((await h.findSubaccounts({ name: NAME })).complete, false, 'cursor beside a bare list')
  fake.script({ listSubaccounts (req, res, ctx) { ctx.json(res, 200, { success: true, data: { subaccounts: [{ id: 's1', name: NAME }], next: 'p2' } }) } })
  t.is((await h.findSubaccounts({ name: NAME })).complete, false, 'next inside data')

  fake.script({ listSubaccounts (req, res, ctx) { ctx.json(res, 200, { success: true, data: [null, 'x', { name: NAME + '-z' }, { id: 's1', name: NAME }] }) } })
  t.alike(await h.findSubaccounts({ name: NAME }), { ok: true, subAccountIds: ['s1'], complete: true }, 'odd rows for other names are skipped')
})

test('C12: an uncertain wallet creation leaves a readable wallet without address', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake, { timeoutMs: 100 })
  const sub = await onboarded(h)
  fake.script({ walletCreate () {} })
  const created = await h.createWallet({ subAccountId: sub, walletPin: PIN })
  t.alike(created, { ok: false, reason: 'tempo', uncertain: true })
  fake.script({})
  t.alike(await h.walletGet({ subAccountId: sub }), { ok: true, address: null, balances: [], walletId: null, verified: false })
  t.is(fake.state.walletCreates, 0)
})

test('success:false, non-JSON, oversized and redirected answers', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const cases = [
    [(req, res) => json(res, 200, { success: false, error: 'nope ' + PIN }), 'formato'],
    [(req, res) => json(res, 200, { data: { attemptId: 'a1', status: 'APPROVED' } }), 'formato'],
    [(req, res) => json(res, 200, ['x']), 'formato'],
    [(req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>' + API_KEY + '</html>'), 'formato'],
    [(req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{not json'), 'formato'],
    [(req, res) => json(res, 200, { success: true, data: { status: 'APPROVED', pad: 'x'.repeat(70000) } }), 'formato'],
    [(req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: { status: 'APPROVED', pad: 'x'.repeat(70000) } }))
    }, 'formato'],
    [(req, res) => res.writeHead(302, { Location: 'https://api.hodle.com.br/api/kyc/a1' }).end(), 'rede']
  ]
  for (const [handler, reason] of cases) {
    fake.script(handler)
    const result = await h.kycStatus('att_1')
    t.alike(result, { ok: false, reason })
    noLeak(t, result)
  }
  fake.script((req, res) => json(res, 201, { success: false, data: { subAccountId: 's1' } }))
  t.alike(await h.createSubaccount({ name: NAME }), { ok: false, reason: 'formato', uncertain: true })

  function json (res, code, obj) {
    const text = JSON.stringify(obj)
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
  }
})

test('a stall before headers or inside the body is a timeout', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake, { timeoutMs: 5000 })
  fake.script(() => {})
  t.alike(await h.kycStatus('att_1', { timeoutMs: 100 }), { ok: false, reason: 'tempo' }, 'per-call deadline')
  fake.script((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"success":true,')
  })
  t.alike(await h.kycStatus('att_1', { timeoutMs: 100 }), { ok: false, reason: 'tempo' })
  t.alike(await h.createWallet({ subAccountId: 's1', walletPin: PIN }, { timeoutMs: 100 }),
    { ok: false, reason: 'tempo', uncertain: true })
})

test('4xx and 5xx: status, schema-like code, values dropped', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const sub = await onboarded(h)
  fake.script({
    kycSubmit (req, res, ctx) {
      ctx.json(res, 400, {
        success: false,
        error: 'Validation failed for ' + CPF,
        errorCode: 'KYC_PODS_INVALID_ADDRESS',
        details: [{ field: 'taxIdNumber', message: CPF }]
      })
    }
  })
  const bad = await h.kycSubmit(kycFields(sub))
  t.alike(bad, { ok: false, reason: 'http-400', code: 'KYC_PODS_INVALID_ADDRESS' })
  noLeak(t, bad)

  fake.script({ kycSubmit (req, res, ctx) { ctx.json(res, 409, { success: false, code: 'KYC_PROVIDER_REJECTED', reason: 'x' }) } })
  t.alike(await h.kycSubmit(kycFields(sub)), { ok: false, reason: 'http-409', code: 'KYC_PROVIDER_REJECTED' })

  fake.script({ kycSubmit (req, res, ctx) { ctx.json(res, 403, { success: false, errorCode: 'lower-' + PIN }) } })
  t.alike(await h.kycSubmit(kycFields(sub)), { ok: false, reason: 'http-403' }, 'a code that is not schema-like is dropped')

  fake.script({ kycSubmit (req, res) { res.writeHead(401, { 'Content-Type': 'text/html' }).end('<html>' + API_KEY + '</html>') } })
  t.alike(await h.kycSubmit(kycFields(sub)), { ok: false, reason: 'http-401' })

  fake.script({ kycSubmit (req, res, ctx) { ctx.json(res, 502, { success: false, errorCode: 'IMPORT_NOT_ENABLED' }) } })
  t.alike(await h.kycSubmit(kycFields(sub)), { ok: false, reason: 'http-502', code: 'IMPORT_NOT_ENABLED', uncertain: true })
  fake.script({ kycStatus (req, res, ctx) { ctx.json(res, 503, { success: false }) } })
  t.alike(await h.kycStatus('att_1'), { ok: false, reason: 'http-503' }, 'a read is never uncertain')

  fake.script({ kycStatus (req, res, ctx) { ctx.json(res, 429, { success: false }, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }) } })
  t.alike(await h.kycStatus('att_1'), { ok: false, reason: 'http-429' }, 'a date Retry-After is ignored')
  fake.script({ kycStatus (req, res, ctx) { ctx.json(res, 429, { success: false }, { 'Retry-After': '30' }) } })
  t.alike(await h.kycStatus('att_1'), { ok: false, reason: 'http-429', retryAfter: 30 })
})

test('no result or error carries the PIN, CPF or key', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const sub = await onboarded(h)
  const results = [
    await h.kycSubmit(kycFields(sub)),
    await h.createWallet({ subAccountId: sub, walletPin: PIN }),
    await h.walletKeys({ subAccountId: sub }),
    await h.walletGet({ subAccountId: sub }),
    await h.findSubaccounts({ name: NAME })
  ]
  for (const r of results) {
    t.is(r.ok, true)
    noLeak(t, r)
  }
  fake.script((req, res) => res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, error: API_KEY + PIN + CPF })))
  noLeak(t, await h.kycSubmit(kycFields(sub)))
  noLeak(t, await h.createWallet({ subAccountId: sub, walletPin: PIN }))
})

test('C6: flat bodies are read from the top level', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  fake.script({ documentReady (req, res, ctx) { ctx.json(res, 200, { success: true, documentId: 'doc_1', ready: true }) } })
  t.alike(await h.kycDocumentReady({ subAccountId: 's1', documentId: 'doc_1' }), { ok: true, ready: true })

  const deposit = decodeDeposit(FIXTURES.deposit)
  t.alike(deposit, {
    externalId: 'my-order-123',
    qrCode: '00020101021226...',
    expiresAt: '2026-10-05T14:10:00.000Z',
    walletCharge: '66fc0b7e2a4b5c6d7e8f9012',
    feeCents: 100
  })
  t.absent(JSON.stringify(deposit).includes('qrcode'), 'qrCodeImage dropped')
  const spaced = '00020126330014br.gov.bcb.pix0111123456789005204000053039865802BR5913Fulano de Tal6009Sao Paulo62070503***6304ABCD'
  t.is(decodeDeposit({ ...FIXTURES.deposit, qrCode: spaced }).qrCode, spaced, 'spaces in a BR Code are kept')
  t.is(decodeDeposit({ ...FIXTURES.deposit, qrCode: 'a\nb' }), null)
  t.is(decodeDeposit({ ...FIXTURES.deposit, qrCode: 'x'.repeat(1025) }), null)
  t.is(decodeDeposit({ ...FIXTURES.deposit, qrCode: '   ' }), null)
  t.is(decodeDeposit({ ...FIXTURES.deposit, qrCode: null }), null)
  t.is(decodeDeposit({ ...FIXTURES.deposit, expiresAt: undefined }), null)
  t.is(decodeDeposit({ ...FIXTURES.deposit, fee: '1.00' }), null)
  t.is(decodeDeposit({ ...FIXTURES.deposit, success: false }), null)

  t.alike(decodeQuote(FIXTURES.quote), {
    quoteId: 'b0f1c7de-9f2b-4a71-9c1e-2f4e2a1d6c88',
    fee: '0.75',
    pixKeyOwner: { name: 'Thiago Mota dos Santos', taxId: '545.***.***-10', bankName: 'NU PAGAMENTOS - IP' }
  })
  t.is(decodeQuote({ ...FIXTURES.quote, quoteId: undefined }), null)
  t.is(decodeQuote({ ...FIXTURES.quote, quote: { fee: -1 } }), null)

  t.alike(decodePayout(FIXTURES.payout), { transactionId: '65f1a8', status: 'PROCESSING', fee: '1.55' })
  t.is(decodePayout({ ...FIXTURES.payout, fee: 'muito' }), null)

  t.alike(decodePayout({ success: true, data: { transactionId: 't1', status: 'COMPLETED', fee: '0' } }),
    { transactionId: 't1', status: 'COMPLETED', fee: '0' }, 'an enveloped body still decodes')
})

test('redact drops secret fields at any depth', (t) => {
  const input = { walletPin: PIN, a: { taxIdNumber: CPF, protectedSymmetricKey: 'k', keep: 1 }, list: [{ walletPin: PIN }] }
  const out = redact(input)
  t.alike(out, { a: { keep: 1 }, list: [{}] })
  t.is(input.walletPin, PIN, 'input untouched')
  t.is(redact('x'), 'x')
})

test('loopbackFetch throws on another origin', async (t) => {
  const fake = await fakeFor(t)
  const f = loopbackFetch(fake.base)
  t.exception.all(() => f('https://api.hodle.com.br/api/kyc/a1'), /non-loopback/)
  t.exception.all(() => f(fake.base + '.evil.test/x'), /non-loopback/)
  const h = createHodle({ apiKey: API_KEY, fetch: f })
  t.alike(await h.kycStatus('att_1'), { ok: false, reason: 'rede' })
  t.is(fake.seen.length, 0)
})

// Money calls (PR2). Amounts are integer cents; the PIN and the protected key
// below are sentinels that must never come back in a result.

const PIX_EMAIL = 'recipient@example.com'
const RANDOM_KEY = '123e4567-e89b-12d3-a456-426614174000'
const ADDRESS = '0x' + 'c'.repeat(40)

function noLeakMoney (t, value) {
  const text = JSON.stringify(value)
  for (const secret of [API_KEY, 'SEGREDO', PIN, CPF, PROTECTED_KEY, 'Invalid PIN', 'MARIA SOUZA', 'FULANO']) {
    t.absent(text.includes(secret), 'leaks nothing')
  }
}

// A subaccount with a wallet holding `cents` BRLA on the fake.
async function funded (h, fake, cents = 0, name = NAME) {
  const sub = await h.createSubaccount({ name })
  const wallet = await h.createWallet({ subAccountId: sub.subAccountId, walletPin: PIN })
  fake.state.balances.set(sub.subAccountId, cents)
  return { subAccountId: sub.subAccountId, walletId: wallet.walletId, protectedSymmetricKey: wallet.protectedSymmetricKey, address: wallet.address }
}

function lastSeen (fake) {
  return fake.seen[fake.seen.length - 1]
}

test('brlToCents and centsToAmount: string arithmetic, dust floored', (t) => {
  const cents = [
    ['0.75', 75], ['12.34', 1234], ['12.3', 1230], ['12', 1200], ['0', 0], ['0.009', 0],
    ['1.999999999999999999', 199], ['12.345', 1234], ['0.1', 10], ['90071992547409.91', 9007199254740991]
  ]
  for (const [text, want] of cents) t.is(brlToCents(text), want, text)
  for (const bad of ['', '.5', '1.', '-1', '1e3', '1,50', ' 1', '1.0000000000000000001', '90071992547409.92', 1.5, null, undefined]) {
    t.is(brlToCents(bad), null, String(bad))
  }
  const amounts = [[1234, '12.34'], [75, '0.75'], [5, '0.05'], [0, '0.00'], [100, '1.00'], [9007199254740991, '90071992547409.91']]
  for (const [c, want] of amounts) t.is(centsToAmount(c), want, String(c))
  for (const bad of [-1, 1.5, NaN, '12', null, 2 ** 53]) t.is(centsToAmount(bad), null, String(bad))
  t.ok(MONEY_TIMEOUT_MS > 25000, 'money calls outlast the provider nonce wait')
})

test('money input checks refuse before any request', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const cred = { walletPin: PIN, protectedSymmetricKey: PROTECTED_KEY }
  const payout = { subAccountId: 's1', walletId: 'w1', externalId: 'po-1', valueCents: 500, quoteId: 'q1', ...cred }
  const transfer = { fromSubAccountId: 's1', walletId: 'w1', toSubAccountId: 's2', amountCents: 100, reference: 'fee-1', ...cred }
  const refused = [
    h.balance({ subAccountId: '..' }),
    h.balance({ subAccountId: 's1', walletId: '' }),
    h.statement({ subAccountId: 's1', limit: 51 }),
    h.statement({ subAccountId: 's1', limit: 0 }),
    h.statement({ subAccountId: 's1', from: 'ontem' }),
    h.statement({ subAccountId: 's1', type: 'swap' }),
    h.statement({ subAccountId: 's1', type: [] }),
    h.statement({ subAccountId: 's1', cursor: 'a b' }),
    h.findByReference({ subAccountId: 's1' }),
    h.findByReference({ subAccountId: 's1', externalId: 'e1', reference: 'r1' }),
    h.findByReference({ subAccountId: 's1', externalId: 'e1', days: 91 }),
    h.findByReference({ subAccountId: 's1', externalId: 'e1', days: 90 }),
    h.payoutQuote({ valueCents: 500, pixKey: PIX_EMAIL, pixKeyType: 'EMAIL', taxId: '123456789012' }),
    h.payout({ ...payout, taxId: '1234567890123' }),
    h.createDeposit({ subAccountId: 's1', valueCents: 99, address: ADDRESS, externalId: 'd1' }),
    h.createDeposit({ subAccountId: 's1', valueCents: 100.5, address: ADDRESS, externalId: 'd1' }),
    h.createDeposit({ subAccountId: 's1', valueCents: 100, address: 'TQHvPfake', externalId: 'd1' }),
    h.createDeposit({ subAccountId: 's1', valueCents: 100, address: ADDRESS, externalId: 'd 1' }),
    h.createDeposit({ subAccountId: 's1', valueCents: 100, address: ADDRESS, externalId: 'd1', expiresIn: 59 }),
    h.createDeposit({ subAccountId: 's1', valueCents: 100, address: ADDRESS, externalId: 'd1', taxId: '123.456.789-00' }),
    h.depositStatus({ subAccountId: 's1', externalId: '..' }),
    h.payoutQuote({ valueCents: 9, pixKey: PIX_EMAIL, pixKeyType: 'EMAIL' }),
    h.payoutQuote({ valueCents: 500, pixKey: RANDOM_KEY, pixKeyType: 'EVP' }),
    h.payoutQuote({ valueCents: 500, pixKey: 'not-an-email', pixKeyType: 'EMAIL' }),
    h.payoutQuote({ valueCents: 500, pixKey: '11999990000', pixKeyType: 'PHONE' }),
    h.payoutQuote({ valueCents: 500, pixKey: PIX_EMAIL, pixKeyType: 'EMAIL', taxId: '1234' }),
    h.payoutQuote({ valueCents: 500, pixKey: PIX_EMAIL, pixKeyType: 'EMAIL', walletId: '' }),
    h.payout({ ...payout, valueCents: 9 }),
    h.payout({ ...payout, walletPin: '12345' }),
    h.payout({ ...payout, protectedSymmetricKey: 'k k' }),
    h.payout({ ...payout, externalId: undefined }),
    h.payout({ ...payout, quoteId: undefined }),
    h.payout({ ...payout, quoteId: undefined, pixKey: RANDOM_KEY, pixKeyType: 'EVP' }),
    h.payoutStatus('..'),
    h.transfer({ ...transfer, recipientAddress: ADDRESS }),
    h.transfer({ ...transfer, toSubAccountId: undefined }),
    h.transfer({ ...transfer, toSubAccountId: undefined, recipientAddress: 'TQHvPfake' }),
    h.transfer({ ...transfer, amountCents: 0 }),
    h.transfer({ ...transfer, amountCents: 1000001 }),
    h.transfer({ ...transfer, reference: 'r'.repeat(65) }),
    h.transfer({ ...transfer, reference: 'a\nb' }),
    h.transfer({ ...transfer, reference: undefined }),
    h.transfer({ ...transfer, walletPin: 482915 })
  ]
  for (const result of await Promise.all(refused)) {
    t.alike(result, { ok: false, reason: 'entrada' })
    noLeakMoney(t, result)
  }
  t.is(fake.seen.length, 0, 'no request reached the fake')
})

test('balance: BRLA on the configured network only, fresh read, null walletId omitted', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const acct = await funded(h, fake, 1234)
  t.alike(await h.balance({ subAccountId: acct.subAccountId, walletId: acct.walletId }),
    { ok: true, cents: 1234, address: acct.address })
  t.alike(lastSeen(fake).body, { subAccountId: acct.subAccountId, sync: true, walletId: acct.walletId })
  await h.balance({ subAccountId: acct.subAccountId, walletId: null })
  t.alike(lastSeen(fake).body, { subAccountId: acct.subAccountId, sync: true })

  fake.script({
    walletGet (req, res, ctx) {
      ctx.json(res, 200, {
        success: true,
        data: {
          addresses: {},
          balances: [
            { network: 'polygon', asset: 'USDT', amount: '500.00' },
            { network: 'base', asset: 'BRLA', amount: '900.00' },
            { network: 'polygon', asset: 'BRLA', amount: '12.349' }
          ]
        }
      })
    }
  })
  t.alike(await h.balance({ subAccountId: 's1' }), { ok: true, cents: 1234, address: null })
  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { addresses: {}, balances: [{ network: 'polygon', asset: 'USDT', amount: '5' }] } }) } })
  t.is((await h.balance({ subAccountId: 's1' })).cents, 0, 'no BRLA row holds zero')
  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { addresses: {}, balances: [{ network: 'polygon', asset: 'BRLA', amount: '9'.repeat(30) }] } }) } })
  t.alike(await h.balance({ subAccountId: 's1' }), { ok: false, reason: 'formato' }, 'an unsafe amount is refused')
})

test('statement: POST body, typed rows, unknown keys dropped, cursor', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const acct = await funded(h, fake, 10000)
  const cred = { walletPin: PIN, protectedSymmetricKey: acct.protectedSymmetricKey }
  const other = await funded(h, fake, 0, NAME + '-b')
  await h.transfer({ fromSubAccountId: acct.subAccountId, walletId: acct.walletId, toSubAccountId: other.subAccountId, amountCents: 250, reference: 'ref-1', ...cred })
  await h.createDeposit({ subAccountId: acct.subAccountId, valueCents: 5000, address: acct.address, externalId: 'dep-1' })

  const r = await h.statement({ subAccountId: acct.subAccountId, from: '2026-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z', limit: 10 })
  t.is(r.ok, true)
  checkRequest(t, lastSeen(fake), 'POST', '/api/account/statement')
  t.alike(lastSeen(fake).body, { subAccountId: acct.subAccountId, limit: 10, from: '2026-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z' })
  t.is(r.cursor, null)
  t.is(r.operations.length, 2)
  const [dep, tr] = r.operations
  t.alike(Object.keys(dep).sort(), ['cents', 'createdAt', 'direction', 'externalId', 'feeCents', 'id', 'status', 'type'])
  t.is(dep.type, 'deposit')
  t.is(dep.cents, 5000)
  t.is(dep.feeCents, 100)
  t.is(dep.direction, 'in')
  t.alike(Object.keys(tr).sort(), ['cents', 'createdAt', 'direction', 'feeCents', 'id', 'reference', 'status', 'txHash', 'type'])
  t.is(tr.reference, 'ref-1')
  t.is(tr.direction, 'out')
  t.is(tr.cents, 250)
  t.absent(JSON.stringify(r).includes('vendorNote'))

  const inbound = await h.statement({ subAccountId: other.subAccountId, type: 'transfer' })
  t.is(inbound.operations[0].direction, 'in')
  t.is(lastSeen(fake).body.type, 'transfer')
  t.is(lastSeen(fake).body.limit, 50, 'default limit')

  const paged = await h.statement({ subAccountId: acct.subAccountId, limit: 1 })
  t.is(paged.operations.length, 1)
  t.is(paged.cursor, '1')
  const next = await h.statement({ subAccountId: acct.subAccountId, limit: 1, cursor: paged.cursor })
  t.is(next.operations[0].type, 'transfer')
  t.is(lastSeen(fake).body.cursor, '1')

  const row = { id: 'op_1', type: 'payout', status: 'COMPLETED', valueInBrl: '27.40', fee: '1.55', createdAt: '2026-04-28T23:32:10.000Z' }
  const page = (operations, extra = {}) => ({ statement (req, res, ctx) { ctx.json(res, 200, { success: true, data: { operations, ...extra } }) } })
  fake.script(page([{ ...row, txHash: '0xeafe9c...', reference: 'x'.repeat(200), externalId: 'a b', direction: 'sideways' }]))
  t.alike((await h.statement({ subAccountId: 's1' })).operations,
    [{ id: 'op_1', type: 'payout', status: 'COMPLETED', cents: 2740, feeCents: 155, createdAt: row.createdAt }],
    'malformed optional fields are dropped')
  const unreadable = [
    { ...row, id: undefined },
    { ...row, valueInBrl: 27.4 },
    { ...row, valueInBrl: undefined, asset: 'USDT', amount: '5.00' },
    { ...row, createdAt: 'ontem' },
    { ...row, fee: 'x' },
    { ...row, status: 'em andamento' },
    null
  ]
  for (const bad of unreadable) {
    fake.script(page([bad, { ...row, id: 'op_2' }]))
    t.alike(await h.statement({ subAccountId: 's1' }),
      { ok: true, operations: [{ id: 'op_2', type: 'payout', status: 'COMPLETED', cents: 2740, feeCents: 155, createdAt: row.createdAt }], cursor: null, skipped: 1 },
      'an unreadable row is skipped and counted: ' + JSON.stringify(bad))
  }
  fake.script(page([{ ...row, status: 'completed' }]))
  t.is((await h.statement({ subAccountId: 's1' })).operations[0].status, 'COMPLETED', 'status upper-cased')
  fake.script(page([{ ...row, valueInBrl: undefined, asset: 'BRLA', amount: '3.21' }]))
  t.is((await h.statement({ subAccountId: 's1' })).operations[0].cents, 321, 'BRLA amount stands in for valueInBrl')
  fake.script(page([], { nextCursor: 'a b' }))
  t.alike(await h.statement({ subAccountId: 's1' }), { ok: false, reason: 'formato' })
})

test('createDeposit: BRLA on the network, idempotent by externalId, partner fee kept (C6, C15)', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const acct = await funded(h, fake)
  const args = { subAccountId: acct.subAccountId, valueCents: 5000, address: acct.address, externalId: 'dep-1' }
  const first = await h.createDeposit(args)
  t.is(first.ok, true)
  t.alike(Object.keys(first).sort(), ['expiresAt', 'externalId', 'hodleFeeCents', 'ok', 'qrCode', 'status', 'trackId', 'walletCharge'])
  t.is(first.hodleFeeCents, 100)
  t.is(first.status, 'pendente')
  t.is(first.trackId, first.walletCharge)
  t.absent(JSON.stringify(first).includes('qrcode/'), 'qrCodeImage dropped')
  checkRequest(t, lastSeen(fake), 'POST', '/api/deposit/asset')
  t.alike(lastSeen(fake).body, {
    value: 5000, asset: 'BRLA', network: 'polygon', address: acct.address, externalId: 'dep-1', subAccountId: acct.subAccountId, expiresIn: 900
  })

  const again = await h.createDeposit(args)
  t.alike(again, first, 'same externalId returns the original charge')
  t.is(fake.state.sends.deposit, 1, 'one charge created')
  t.is(fake.state.deposits.size, 1)

  await h.createDeposit({ ...args, externalId: 'dep-2', taxId: '12345678000199', expiresIn: 60 })
  t.is(lastSeen(fake).body.taxId, '12345678000199')
  t.is(lastSeen(fake).body.expiresIn, 60)

  const other = await funded(h, fake, 0, NAME + '-b')
  const clash = await h.createDeposit({ ...args, subAccountId: other.subAccountId })
  t.alike(clash, { ok: false, reason: 'http-409' }, 'a 409 is not uncertain: the caller reconciles by GET')

  fake.script({ deposit (req, res, ctx) { ctx.json(res, 200, { ...FIXTURES.deposit, externalId: 'dep-1', expiresAt: null }) } })
  t.is((await h.createDeposit(args)).expiresAt, null, 'a rail-set lifetime has no countdown')
  fake.script({ deposit (req, res, ctx) { ctx.json(res, 200, { ...FIXTURES.deposit, externalId: 'someone-else' }) } })
  t.alike(await h.createDeposit(args), { ok: false, reason: 'formato', uncertain: true }, 'another externalId echoed is refused')
  fake.script({ deposit (req, res, ctx) { ctx.json(res, 200, { ...FIXTURES.deposit, qrCode: null }) } })
  t.alike(await h.createDeposit(args), { ok: false, reason: 'formato', uncertain: true })
  fake.script({ deposit () {} })
  t.alike(await h.createDeposit(args, { timeoutMs: 100 }), { ok: false, reason: 'tempo', uncertain: true })
})

test('decodeDeposit accepts a null expiresAt and still checks a timestamp', (t) => {
  t.is(decodeDeposit({ ...FIXTURES.deposit, expiresAt: null }).expiresAt, null)
  t.is(decodeDeposit({ ...FIXTURES.deposit, expiresAt: 'amanhã' }), null)
  t.is(decodeDeposit({ ...FIXTURES.deposit, expiresAt: 42 }), null)
  t.is(decodeDeposit({ ...FIXTURES.deposit, expiresAt: undefined }), null)
})

test('depositStatus: GET carries the subaccount, statuses mapped (C7), payer dropped', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const acct = await funded(h, fake)
  await h.createDeposit({ subAccountId: acct.subAccountId, valueCents: 5000, address: acct.address, externalId: 'dep-1' })
  const pending = await h.depositStatus({ subAccountId: acct.subAccountId, externalId: 'dep-1' })
  t.alike(pending, { ok: true, status: 'PENDING', outcome: 'pendente', final: false, hodleFeeCents: 100 })
  checkRequest(t, lastSeen(fake), 'GET', '/api/deposit/dep-1?subAccountId=' + acct.subAccountId)

  fake.settleDeposit('dep-1')
  const done = await h.depositStatus({ subAccountId: acct.subAccountId, externalId: 'dep-1' })
  t.is(done.outcome, 'concluido')
  t.is(done.final, true)
  t.ok(/^0x[0-9a-f]{64}$/.test(done.txHash))
  noLeakMoney(t, done)
  t.is(fake.state.balances.get(acct.subAccountId), 4900, 'credited value minus the partner fee')

  t.alike(await h.depositStatus({ subAccountId: 'outra', externalId: 'dep-1' }), { ok: false, reason: 'http-404' })

  const table = {
    PENDING: ['pendente', false],
    FIAT_PAID: ['pendente', false],
    PROCESSING: ['pendente', false],
    COMPLETED: ['concluido', true],
    EXPIRED: ['expirado', false],
    FAILED: ['devolvendo', false],
    REFUNDED: ['devolvido', true]
  }
  for (const [status, [outcome, final]] of Object.entries(table)) {
    t.is(depositOutcome(status), outcome, status)
    fake.state.deposits.get('dep-1').status = status
    const r = await h.depositStatus({ subAccountId: acct.subAccountId, externalId: 'dep-1' })
    t.is(r.outcome, outcome)
    t.is(r.final, final)
  }
  t.is(depositOutcome('toString'), 'desconhecido')
  fake.script({ depositStatus (req, res, ctx) { ctx.json(res, 200, { success: true, data: { externalId: 'outro', status: 'COMPLETED' } }) } })
  t.alike(await h.depositStatus({ subAccountId: 's1', externalId: 'dep-1' }), { ok: false, reason: 'formato' })
})

test('payoutQuote: scoped fields, RANDOM key type, flat body decoded (C4, C5, C6)', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const q = await h.payoutQuote({ valueCents: 5000, pixKey: RANDOM_KEY, pixKeyType: 'RANDOM', subAccountId: 's1', walletId: 'w1', taxId: CPF })
  t.is(q.ok, true)
  t.alike(Object.keys(q).sort(), ['bankName', 'expiresAt', 'feeCents', 'ok', 'ownerName', 'quoteId', 'taxIdMasked'])
  t.is(q.feeCents, 75)
  t.is(q.ownerName, 'Thiago Mota dos Santos')
  t.is(q.taxIdMasked, '545.***.***-10')
  t.is(q.bankName, 'NU PAGAMENTOS - IP')
  checkRequest(t, lastSeen(fake), 'POST', '/api/wallet/payout/beneficiary')
  t.alike(lastSeen(fake).body, {
    value: 5000, network: 'polygon', asset: 'BRLA', pixKey: RANDOM_KEY, pixKeyType: 'RANDOM', subAccountId: 's1', walletId: 'w1', taxId: CPF
  })
  const quoted = fake.state.quotes.get(q.quoteId)
  t.is(quoted.taxId, CPF, 'the fake caches the quoted scope')
  t.absent(JSON.stringify(q).includes(CPF))

  await h.payoutQuote({ valueCents: 5000, pixKey: PIX_EMAIL, pixKeyType: 'EMAIL', walletId: null })
  t.alike(lastSeen(fake).body, { value: 5000, network: 'polygon', asset: 'BRLA', pixKey: PIX_EMAIL, pixKeyType: 'EMAIL' })

  fake.script({ payoutQuote (req, res, ctx) { ctx.json(res, 200, FIXTURES.quote) } })
  const fixed = await h.payoutQuote({ valueCents: 5000, pixKey: PIX_EMAIL, pixKeyType: 'EMAIL' })
  t.is(fixed.feeCents, 75)
  t.is(fixed.expiresAt, '2026-08-31T14:35:00.000Z')
  fake.script({ payoutQuote (req, res, ctx) { ctx.json(res, 200, { ...FIXTURES.quote, pixKeyOwner: { ...FIXTURES.quote.pixKeyOwner, name: 'n'.repeat(129) } }) } })
  t.alike(await h.payoutQuote({ valueCents: 5000, pixKey: PIX_EMAIL, pixKeyType: 'EMAIL' }), { ok: false, reason: 'formato', uncertain: true })
  fake.script({ payoutQuote (req, res, ctx) { ctx.json(res, 202, { success: true, status: 'PENDING', pricingPending: true }) } })
  t.alike(await h.payoutQuote({ valueCents: 5000, pixKey: PIX_EMAIL, pixKeyType: 'EMAIL' }), { ok: false, reason: 'formato', uncertain: true })
})

test('payout against a quote: pixKey omitted, idempotent by externalId, status read', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const acct = await funded(h, fake, 10000)
  const q = await h.payoutQuote({ valueCents: 5000, pixKey: PIX_EMAIL, pixKeyType: 'EMAIL', subAccountId: acct.subAccountId, walletId: acct.walletId, taxId: CPF })
  const args = {
    subAccountId: acct.subAccountId,
    walletId: acct.walletId,
    walletPin: PIN,
    protectedSymmetricKey: acct.protectedSymmetricKey,
    externalId: 'po-1',
    valueCents: 5000,
    quoteId: q.quoteId,
    pixKey: PIX_EMAIL,
    pixKeyType: 'EMAIL',
    taxId: CPF
  }
  const r = await h.payout(args, { timeoutMs: 2000 })
  t.alike(r, { ok: true, transactionId: r.transactionId, status: 'PROCESSING', feeCents: 75, existing: false })
  checkRequest(t, lastSeen(fake), 'POST', '/api/wallet/payout')
  const sent = lastSeen(fake).body
  t.absent('pixKey' in sent, 'pixKey comes from the quote')
  t.absent('pixKeyType' in sent)
  t.alike(sent, {
    value: 5000,
    network: 'polygon',
    asset: 'BRLA',
    subAccountId: acct.subAccountId,
    externalId: 'po-1',
    walletPin: PIN,
    protectedSymmetricKey: acct.protectedSymmetricKey,
    walletId: acct.walletId,
    quoteId: q.quoteId,
    taxId: CPF
  })
  t.is(fake.state.balances.get(acct.subAccountId), 10000 - 5075)
  noLeakMoney(t, r)

  const again = await h.payout(args, { timeoutMs: 2000 })
  t.alike(again, { ...r, existing: true }, 'the original payout comes back')
  t.is(fake.state.sends.payout, 1, 'one payout sent')

  t.alike(await h.payoutStatus(r.transactionId), { ok: true, status: 'PENDING' })
  checkRequest(t, lastSeen(fake), 'GET', '/api/wallet/payout/' + r.transactionId)
  fake.state.payouts.get(r.transactionId).status = 'COMPLETED'
  const done = await h.payoutStatus(r.transactionId)
  t.alike(Object.keys(done).sort(), ['endToEndId', 'ok', 'status', 'txHash'])
  t.is(done.status, 'COMPLETED')
  noLeakMoney(t, done)
  fake.state.payouts.get(r.transactionId).status = 'REFUNDED'
  const refunded = await h.payoutStatus(r.transactionId)
  t.is(refunded.failureCode, 'PAYOUT_FAILED')
  t.absent(JSON.stringify(refunded).includes('inválida'), 'failureReason dropped')

  const direct = await h.payout({ ...args, externalId: 'po-2', quoteId: undefined, valueCents: 100, walletId: null, taxId: undefined }, { timeoutMs: 2000 })
  t.is(direct.ok, true)
  t.is(lastSeen(fake).body.pixKey, PIX_EMAIL, 'without a quote the key is sent')
  t.absent('walletId' in lastSeen(fake).body, 'a null walletId is omitted')

  const reused = await h.payout({ ...args, externalId: 'po-3' }, { timeoutMs: 2000 })
  t.alike(reused, { ok: false, reason: 'http-400' }, 'a used quote is refused')
})

test('PIN and provider codes are mapped, the message and body dropped', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const acct = await funded(h, fake, 10000)
  const args = {
    subAccountId: acct.subAccountId,
    walletPin: '000000',
    protectedSymmetricKey: acct.protectedSymmetricKey,
    externalId: 'po-1',
    valueCents: 500,
    pixKey: PIX_EMAIL,
    pixKeyType: 'EMAIL'
  }
  for (let i = 0; i < 3; i++) {
    const r = await h.payout({ ...args, externalId: 'po-' + i }, { timeoutMs: 2000 })
    t.alike(r, { ok: false, reason: 'http-400', code: 'PIN_INVALID' })
    noLeakMoney(t, r)
  }
  const locked = await h.transfer({
    fromSubAccountId: acct.subAccountId, toSubAccountId: acct.subAccountId, amountCents: 1, walletPin: PIN, protectedSymmetricKey: acct.protectedSymmetricKey, reference: 'r1'
  }, { timeoutMs: 2000 })
  t.alike(locked, { ok: false, reason: 'http-400', code: 'PIN_LOCKED' }, 'locked even with the right PIN')
  t.is(fake.state.sends.payout + fake.state.sends.transfer, 0)

  const scripted = [
    [400, { success: false, error: 'Wrong PIN for ' + PIN, errorCode: 'INVALID_PIN' }, { reason: 'http-400', code: 'PIN_INVALID' }],
    [400, { success: false, errorCode: 'PIN_LOCKED' }, { reason: 'http-400', code: 'PIN_LOCKED' }],
    [400, { success: false, error: 'Carteira bloqueada: PIN' }, { reason: 'http-400', code: 'PIN_LOCKED' }],
    [400, { success: false, error: 'Insufficient balance', errorCode: 'INSUFFICIENT_BALANCE' }, { reason: 'http-400', code: 'INSUFFICIENT_BALANCE' }],
    [400, { success: false, error: 'Validation failed' }, { reason: 'http-400' }],
    [400, { success: false, error: 'x'.repeat(600) + ' PIN' }, { reason: 'http-400' }],
    [403, { success: false, error: 'Invalid PIN' }, { reason: 'http-403' }],
    [403, { success: false, errorCode: 'PER_TX_LIMIT_EXCEEDED' }, { reason: 'http-403', code: 'PER_TX_LIMIT_EXCEEDED' }],
    [403, { success: false, errorCode: 'THIRD_PARTY_NOT_ENABLED' }, { reason: 'http-403', code: 'THIRD_PARTY_NOT_ENABLED' }],
    [409, { success: false, errorCode: 'PAYOUT_IN_PROGRESS' }, { reason: 'http-409', code: 'PAYOUT_IN_PROGRESS' }],
    [409, { success: false, errorCode: 'WALLET_BUSY', retryable: true, blockingTransactionId: 'b1' }, { reason: 'http-409', code: 'WALLET_BUSY' }]
  ]
  for (const [code, body, want] of scripted) {
    fake.script({ payout (req, res, ctx) { ctx.json(res, code, body) } })
    const r = await h.payout({ ...args, walletPin: PIN }, { timeoutMs: 2000 })
    t.alike(r, { ok: false, ...want }, JSON.stringify(body).slice(0, 60))
    noLeakMoney(t, r)
  }
  fake.script({ createSubaccount (req, res, ctx) { ctx.json(res, 400, { success: false, error: 'Invalid PIN' }) } })
  t.alike(await h.createSubaccount({ name: NAME }), { ok: false, reason: 'http-400' }, 'only PIN-signed calls read the message')
})

test('transfer: BRLA by reference, balances moved, repeat is existing (C2)', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const from = await funded(h, fake, 5000)
  const to = await funded(h, fake, 0, NAME + '-b')
  const args = {
    fromSubAccountId: from.subAccountId,
    walletId: from.walletId,
    toSubAccountId: to.subAccountId,
    amountCents: 1234,
    walletPin: PIN,
    protectedSymmetricKey: from.protectedSymmetricKey,
    reference: 'fee po-1 #1'
  }
  const r = await h.transfer(args, { timeoutMs: 2000 })
  t.is(r.ok, true)
  t.alike(Object.keys(r).sort(), ['existing', 'ok', 'status', 'txHash'])
  t.is(r.status, 'done')
  t.is(r.existing, false)
  checkRequest(t, lastSeen(fake), 'POST', '/api/wallet/transfer')
  t.alike(lastSeen(fake).body, {
    fromSubAccountId: from.subAccountId,
    network: 'polygon',
    asset: 'BRLA',
    amount: '12.34',
    walletPin: PIN,
    protectedSymmetricKey: from.protectedSymmetricKey,
    reference: 'fee po-1 #1',
    walletId: from.walletId,
    toSubAccountId: to.subAccountId
  })
  t.is(fake.state.balances.get(from.subAccountId), 5000 - 1234)
  t.is(fake.state.balances.get(to.subAccountId), 1234)
  noLeakMoney(t, r)

  const again = await h.transfer(args, { timeoutMs: 2000 })
  t.alike(again, { ok: true, status: 'done', existing: true, txHash: r.txHash, transactionId: again.transactionId })
  t.is(fake.state.sends.transfer, 1, 'one transfer sent')
  t.is(fake.state.balances.get(to.subAccountId), 1234)
  noLeakMoney(t, again)

  await h.transfer({ ...args, toSubAccountId: undefined, recipientAddress: ADDRESS, walletId: null, reference: 'ext-1', amountCents: 1 }, { timeoutMs: 2000 })
  t.is(lastSeen(fake).body.recipientAddress, ADDRESS)
  t.absent('walletId' in lastSeen(fake).body)
  t.absent('toSubAccountId' in lastSeen(fake).body)

  const conflicts = [
    [{ success: false, errorCode: 'WALLET_BUSY', transactionId: 't1' }, { ok: false, reason: 'http-409', code: 'WALLET_BUSY' }],
    [{ success: false, errorCode: 'TRANSFER_IN_PROGRESS' }, { ok: false, reason: 'http-409', code: 'TRANSFER_IN_PROGRESS' }],
    [{ success: false, transactionId: 't1', status: 'PENDING', txHash: null }, { ok: true, status: 'pending', existing: true, transactionId: 't1' }],
    [{ success: false, transactionId: 't1', status: 'completed' }, { ok: true, status: 'done', existing: true, transactionId: 't1' }],
    [{ success: false, data: { transactionId: 't1', status: 'FAILED' } }, { ok: false, reason: 'http-409', code: 'TRANSFER_FAILED' }],
    [{ success: false, transactionId: 't1', status: 'rejected', txHash: '0x' + 'a'.repeat(64) }, { ok: false, reason: 'http-409', code: 'TRANSFER_FAILED' }],
    [{ success: false, transactionId: 't1', status: 'QUEUED' }, { ok: true, status: 'pending', existing: true, transactionId: 't1' }],
    [{ success: false, transactionId: 't1', txHash: '0x' + 'a'.repeat(64), amount: '12.34', toSubAccountId: to.subAccountId },
      { ok: true, status: 'done', existing: true, transactionId: 't1', txHash: '0x' + 'a'.repeat(64) }],
    [{ success: false, transactionId: 't1', status: 'COMPLETED', amount: '99.00' }, { ok: false, reason: 'formato', uncertain: true }],
    [{ success: false, transactionId: 't1', status: 'COMPLETED', amount: 'muito' }, { ok: false, reason: 'formato', uncertain: true }],
    [{ success: false, transactionId: 't1', status: 'COMPLETED', toSubAccountId: 'outra' }, { ok: false, reason: 'formato', uncertain: true }],
    [{ success: false, transactionId: 't1', status: 'COMPLETED', recipientAddress: ADDRESS }, { ok: true, status: 'done', existing: true, transactionId: 't1' }],
    [{ success: false, transactionId: 't1', status: 'COMPLETED', destination: ADDRESS }, { ok: false, reason: 'formato', uncertain: true }],
    [{ success: false, transactionId: 't1', status: 'COMPLETED', destination: to.subAccountId }, { ok: true, status: 'done', existing: true, transactionId: 't1' }],
    [{ success: false, transactionId: 't1', reference: 'someone-else', txHash: '0x' + 'a'.repeat(64) }, { ok: false, reason: 'http-409' }],
    [{ success: false, error: 'conflict' }, { ok: false, reason: 'http-409' }]
  ]
  for (const [body, want] of conflicts) {
    fake.script({ transfer (req, res, ctx) { ctx.json(res, 409, body) } })
    t.alike(await h.transfer(args, { timeoutMs: 2000 }), want, JSON.stringify(body))
  }

  const answers = [
    [{ status: 'PENDING', txHash: null, amount: '12.34' }, { ok: true, status: 'pending', existing: false }],
    [{ status: 'processing' }, { ok: true, status: 'pending', existing: false }],
    [{ status: 'QUEUED' }, { ok: true, status: 'pending', existing: false }],
    [{ amount: '12.34' }, { ok: true, status: 'pending', existing: false }],
    [{ status: 'Completed' }, { ok: true, status: 'done', existing: false }],
    [{ status: 'FAILED', txHash: null }, { ok: false, reason: 'http-200', code: 'TRANSFER_FAILED' }],
    [{ status: 'rejected' }, { ok: false, reason: 'http-200', code: 'TRANSFER_FAILED' }],
    [{ status: 'CANCELED', txHash: '0x' + 'b'.repeat(64) }, { ok: false, reason: 'http-200', code: 'TRANSFER_FAILED' }]
  ]
  for (const [data, want] of answers) {
    fake.script({ transfer (req, res, ctx) { ctx.json(res, 200, { success: true, data }) } })
    t.alike(await h.transfer(args, { timeoutMs: 2000 }), want, JSON.stringify(data))
  }
  const toAddr = { ...args, toSubAccountId: undefined, recipientAddress: ADDRESS }
  fake.script({ transfer (req, res, ctx) { ctx.json(res, 409, { success: false, transactionId: 't1', status: 'COMPLETED', recipientAddress: '0x' + 'd'.repeat(40) }) } })
  t.alike(await h.transfer(toAddr, { timeoutMs: 2000 }), { ok: false, reason: 'formato', uncertain: true }, 'another address on the reused reference')
  fake.script({ transfer (req, res, ctx) { ctx.json(res, 409, { success: false, transactionId: 't1', status: 'COMPLETED', toSubAccountId: to.subAccountId }) } })
  t.alike(await h.transfer(toAddr, { timeoutMs: 2000 }), { ok: false, reason: 'formato', uncertain: true }, 'a subaccount where an address was asked')
  fake.script({ transfer (req, res, ctx) { ctx.json(res, 409, { success: false, transactionId: 't1', status: 'COMPLETED', destination: ADDRESS.toUpperCase().replace('0X', '0x') }) } })
  t.alike(await h.transfer(toAddr, { timeoutMs: 2000 }), { ok: true, status: 'done', existing: true, transactionId: 't1' })
  fake.script({ transfer (req, res, ctx) { ctx.json(res, 200, { success: true, data: { txHash: '0x' + 'a'.repeat(64), amount: '99.00' } }) } })
  t.alike(await h.transfer(args, { timeoutMs: 2000 }), { ok: false, reason: 'formato', uncertain: true }, 'another amount echoed')
  fake.script({ transfer () {} })
  t.alike(await h.transfer(args, { timeoutMs: 100 }), { ok: false, reason: 'tempo', uncertain: true })
})

test('C8: an executed payout whose answer was dropped is found in the statement', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const acct = await funded(h, fake, 10000)
  fake.script({
    payout (req, res, ctx) {
      // The provider executes the payout, then the answer is lost and no
      // webhook is configured.
      fake.apply('payout', ctx)
    }
  })
  const args = {
    subAccountId: acct.subAccountId,
    walletPin: PIN,
    protectedSymmetricKey: acct.protectedSymmetricKey,
    externalId: 'po-lost',
    valueCents: 500,
    pixKey: PIX_EMAIL,
    pixKeyType: 'EMAIL'
  }
  t.alike(await h.payout(args, { timeoutMs: 200 }), { ok: false, reason: 'tempo', uncertain: true })
  t.is(fake.state.sends.payout, 1, 'the payout did happen')
  fake.script({})

  const found = await h.findByReference({ subAccountId: acct.subAccountId, externalId: 'po-lost', days: 3 })
  t.is(found.ok, true)
  t.is(found.complete, true)
  t.is(found.operation.type, 'payout')
  t.is(found.operation.externalId, 'po-lost')
  t.is(found.operation.cents, 500)
  t.is(found.operation.feeCents, 75)
  t.ok(/^0x[0-9a-f]{64}$/.test(found.operation.txHash))
  const sent = lastSeen(fake).body
  t.is(sent.limit, 50)
  t.ok(Math.abs(Date.parse(sent.from) - (Date.now() - 3 * 86400000)) < 60000, 'window of `days`')
  noLeakMoney(t, found)

  t.alike(await h.findByReference({ subAccountId: acct.subAccountId, externalId: 'po-never' }), { ok: true, operation: null, complete: true })

  await h.transfer({ fromSubAccountId: acct.subAccountId, recipientAddress: ADDRESS, amountCents: 10, walletPin: PIN, protectedSymmetricKey: acct.protectedSymmetricKey, reference: 'fee po-lost' }, { timeoutMs: 2000 })
  const byRef = await h.findByReference({ subAccountId: acct.subAccountId, reference: 'fee po-lost' })
  t.is(byRef.operation.type, 'transfer')
  t.is(byRef.operation.reference, 'fee po-lost')

  let pages = 0
  fake.script({
    statement (req, res, ctx) {
      pages++
      const op = { id: 'op_' + pages, type: 'payout', status: 'COMPLETED', valueInBrl: '1.00', fee: '0', createdAt: '2026-04-28T23:32:10.000Z', externalId: 'x' + pages }
      ctx.json(res, 200, { success: true, data: { operations: [op], nextCursor: 'p' + pages } })
    }
  })
  t.alike(await h.findByReference({ subAccountId: acct.subAccountId, externalId: 'po-lost' }), { ok: true, operation: null, complete: false })
  t.is(pages, 3, 'at most three pages')
  t.alike(fake.seen.slice(-2).map((r) => r.body.cursor), ['p1', 'p2'])
  const windows = fake.seen.slice(-3).map((r) => [r.body.from, r.body.to])
  t.ok(windows.every(([from, to]) => from === windows[0][0] && to === windows[0][1]), 'one window on every page')
  t.is(Date.parse(windows[0][1]) - Date.parse(windows[0][0]), 7 * 86400000, 'both bounds from one instant')
  t.ok(Math.abs(Date.parse(windows[0][1]) - Date.now()) < 60000)
  pages = 0
  t.is((await h.findByReference({ subAccountId: acct.subAccountId, externalId: 'x2' })).operation.id, 'op_2')

  fake.script({ statement (req, res, ctx) { ctx.json(res, 503, { success: false }) } })
  t.alike(await h.findByReference({ subAccountId: acct.subAccountId, externalId: 'po-lost' }), { ok: false, reason: 'http-503' }, 'a read failure is never uncertain')

  const good = { id: 'op_9', type: 'transfer', status: 'COMPLETED', valueInBrl: '1.00', createdAt: '2026-04-28T23:32:10.000Z', reference: 'other' }
  const odd = { id: 'op_bad', type: 'payout', status: 'COMPLETED', valueInBrl: 'muito', createdAt: '2026-04-28T23:32:10.000Z', externalId: 'po-lost', reference: 'fee po-lost' }
  fake.script({ statement (req, res, ctx) { ctx.json(res, 200, { success: true, data: { operations: [odd, good] } }) } })
  t.alike(await h.findByReference({ subAccountId: acct.subAccountId, externalId: 'po-lost' }), { ok: false, reason: 'formato' },
    'the searched row is unreadable: never reported as a miss')
  t.alike(await h.findByReference({ subAccountId: acct.subAccountId, reference: 'fee po-lost' }), { ok: false, reason: 'formato' })
  t.alike(await h.findByReference({ subAccountId: acct.subAccountId, reference: 'other' }),
    { ok: true, operation: { id: 'op_9', type: 'transfer', status: 'COMPLETED', cents: 100, feeCents: 0, createdAt: good.createdAt, reference: 'other' }, complete: true },
    'an unreadable row for another search is skipped')
  t.alike(await h.findByReference({ subAccountId: acct.subAccountId, externalId: 'po-x' }), { ok: true, operation: null, complete: true })
})

test('C6: fake answers the documented flat payout body', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const args = { subAccountId: 's1', walletPin: PIN, protectedSymmetricKey: PROTECTED_KEY, externalId: 'po-1', valueCents: 5000, quoteId: 'q1' }
  const brla = { ...FIXTURES.payout, asset: 'BRLA' }
  fake.script({ payout (req, res, ctx) { ctx.json(res, 202, brla) } })
  const r = await h.payout(args, { timeoutMs: 2000 })
  t.alike(r, { ok: true, transactionId: '65f1a8', status: 'PROCESSING', feeCents: 155, existing: false })
  fake.script({ payout (req, res, ctx) { ctx.json(res, 202, { ...brla, fee: 1.55 }) } })
  t.is((await h.payout(args, { timeoutMs: 2000 })).feeCents, 155, 'a numeric fee is read as its decimal text')
  fake.script({ payout (req, res, ctx) { ctx.json(res, 202, { ...brla, valueInBrl: undefined, asset: undefined }) } })
  t.is((await h.payout(args, { timeoutMs: 2000 })).ok, true, 'absent value and asset are not checked')

  const mismatches = [
    FIXTURES.payout,
    { ...brla, valueInBrl: '50.01' },
    { ...brla, valueInBrl: 'cinquenta' },
    { ...brla, valueInBrl: '5.00', alreadyProcessed: true }
  ]
  for (const body of mismatches) {
    fake.script({ payout (req, res, ctx) { ctx.json(res, 202, body) } })
    t.alike(await h.payout(args, { timeoutMs: 2000 }), { ok: false, reason: 'formato', uncertain: true }, JSON.stringify(body).slice(0, 80))
  }
  fake.script({ payout (req, res, ctx) { ctx.json(res, 202, { ...brla, valueInBrl: '50', alreadyProcessed: true }) } })
  t.is((await h.payout(args, { timeoutMs: 2000 })).existing, true, 'decimal compare: 50 equals 50.00')
})

test('balance: a read for a wallet the provider did not echo is refused', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { addresses: {}, balances: [{ network: 'polygon', asset: 'BRLA', amount: '7.00' }] } }) } })
  t.alike(await h.balance({ subAccountId: 's1', walletId: 'w1' }), { ok: false, reason: 'formato' })
  t.alike(await h.balance({ subAccountId: 's1' }), { ok: true, cents: 700, address: null }, 'no wallet asked: no echo needed')
  fake.script({ walletGet (req, res, ctx) { ctx.json(res, 200, { success: true, data: { walletId: 'w1', addresses: {}, balances: [{ network: 'polygon', asset: 'BRLA', amount: '7.00' }] } }) } })
  t.alike(await h.balance({ subAccountId: 's1', walletId: 'w1' }), { ok: true, cents: 700, address: null })
})

test('findByReference: a 89-day window is the widest, both bounds sent', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const acct = await funded(h, fake)
  t.alike(await h.findByReference({ subAccountId: acct.subAccountId, externalId: 'e1', days: 89 }), { ok: true, operation: null, complete: true })
  const { from, to } = lastSeen(fake).body
  t.is(Date.parse(to) - Date.parse(from), 89 * 86400000)
})

test('payoutQuote and payout accept a beneficiary CNPJ as taxId', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const acct = await funded(h, fake, 10000)
  const CNPJ = '12345678000199'
  const q = await h.payoutQuote({ valueCents: 500, pixKey: CNPJ, pixKeyType: 'CNPJ', subAccountId: acct.subAccountId, taxId: CNPJ })
  t.is(q.ok, true)
  t.is(lastSeen(fake).body.taxId, CNPJ)
  const r = await h.payout({
    subAccountId: acct.subAccountId,
    walletPin: PIN,
    protectedSymmetricKey: acct.protectedSymmetricKey,
    externalId: 'po-cnpj',
    valueCents: 500,
    quoteId: q.quoteId,
    taxId: CNPJ
  }, { timeoutMs: 2000 })
  t.is(r.ok, true)
  t.is(lastSeen(fake).body.taxId, CNPJ)
  noLeakMoney(t, r)
})

test('C8: findByReference over an explicit window reads up to maxPages pages', async (t) => {
  const fake = await fakeFor(t)
  const h = client(fake)
  const from = '2026-01-10T00:00:00.000Z'
  const to = '2026-02-09T00:00:00.000Z'
  for (const bad of [
    { from, to: from },
    { from: to, to: from },
    { from, to: '2026-04-10T00:00:01.000Z' },
    { from },
    { to },
    { from: 'ontem', to },
    { from, to, days: 7 },
    { from, to, maxPages: 11 },
    { from, to, maxPages: 0 }
  ]) {
    t.alike(await h.findByReference({ subAccountId: 's1', externalId: 'e1', ...bad }), { ok: false, reason: 'entrada' }, JSON.stringify(bad))
  }
  let pages = 0
  fake.script({
    statement (req, res, ctx) {
      pages++
      const hit = pages === 8
      const op = { id: 'op_' + pages, type: 'payout', status: 'COMPLETED', valueInBrl: '1.00', fee: '0', createdAt: '2026-01-20T00:00:00.000Z', externalId: hit ? 'old-po' : 'x' + pages }
      ctx.json(res, 200, { success: true, data: { operations: [op], nextCursor: 'p' + pages } })
    }
  })
  const found = await h.findByReference({ subAccountId: 's1', externalId: 'old-po', from, to, maxPages: 10 })
  t.is(found.operation.id, 'op_8')
  t.is(pages, 8)
  t.ok(fake.seen.slice(-8).every((r) => r.body.from === from && r.body.to === to), 'the window on every page')
  pages = 0
  t.alike(await h.findByReference({ subAccountId: 's1', externalId: 'never', from, to, maxPages: 10 }), { ok: true, operation: null, complete: false })
  t.is(pages, 10, 'at most maxPages')
  pages = 0
  await h.findByReference({ subAccountId: 's1', externalId: 'never', days: 7 })
  t.is(pages, 3, 'the default path keeps three pages')
})
