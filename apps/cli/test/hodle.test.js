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
  BASES
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
