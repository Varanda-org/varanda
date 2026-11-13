'use strict'

// apps/cli/lib/account/phone-client.js against the loopback Didit fake. No
// socket leaves 127.0.0.1: the endpoint base and the fetch both point at the
// fake.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { createPhoneClient, phoneOutcome } = require('../lib/account/phone-client')
const { startFakeDidit, loopbackFetch, PHONE_CODE } = require('./helpers/fake-didit')

const API_KEY = 'didit-key-de-teste-SEGREDO'
const PHONE = '+5511987654321'
const WRONG_CODE = '654321'
const CARRIER = 'Operadora-SENTINELA'
const REQUEST_ID = 'req-SENTINELA-0001'

async function fakeFor (t) {
  const fake = await startFakeDidit()
  t.teardown(() => fake.close(), { force: true })
  return fake
}

function client (fake, extra = {}) {
  return createPhoneClient({
    apiKey: API_KEY,
    endpoints: { base: fake.base },
    fetch: loopbackFetch(fake.base),
    ...extra
  })
}

function noLeak (t, value) {
  const text = JSON.stringify(value) + String(value && value.message)
  for (const secret of [API_KEY, PHONE, PHONE.slice(3), PHONE_CODE, WRONG_CODE, CARRIER, REQUEST_ID]) {
    t.absent(text.includes(secret), 'leaks nothing')
  }
}

function allKeys (value, out = []) {
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      allKeys(v, out)
    }
  }
  return out
}

test('createPhoneClient refuses a bad key without echoing it', (t) => {
  const bad = ['', 'chave com espaco-SEGREDO', 'chave\nSEGREDO', 'x'.repeat(513), 42, undefined]
  for (const apiKey of bad) {
    try {
      createPhoneClient({ apiKey })
      t.fail('should throw')
    } catch (err) {
      t.ok(err instanceof TypeError)
      const text = String(err.message) + String(err.stack)
      t.absent(text.includes('SEGREDO'), 'message does not echo the value')
    }
  }
  t.ok(createPhoneClient({ apiKey: API_KEY, fetch: () => {} }), 'no workflow id needed')
})

test('send: POST with the key, SMS only, a fresh vendor_data and nothing else', async (t) => {
  const fake = await fakeFor(t)
  const p = client(fake)
  const first = await p.send({ phone: PHONE })
  t.alike(first, { ok: true, status: 'enviado' })
  noLeak(t, first)
  await p.send({ phone: PHONE })

  t.is(fake.seen.length, 2)
  const req = fake.seen[0]
  t.is(req.method, 'POST')
  t.is(req.path, '/v3/phone/send/')
  t.is(req.headers['x-api-key'], API_KEY)
  t.alike(Object.keys(req.body).sort(), ['options', 'phone_number', 'vendor_data'])
  t.is(req.body.phone_number, PHONE)
  t.alike(req.body.options, { preferred_channel: 'sms', locale: 'pt-BR', code_size: 6 })
  t.ok(/^[A-Za-z0-9_-]{22}$/.test(req.body.vendor_data), '16 random bytes as base64url')
  t.not(fake.seen[1].body.vendor_data, req.body.vendor_data, 'vendor_data is fresh per send')
})

test('send: each provider status', async (t) => {
  const fake = await fakeFor(t)
  const p = client(fake)
  const cases = [
    [{ status: 'Success', request_id: REQUEST_ID }, { ok: true, status: 'enviado' }],
    [{ status: 'Retry', request_id: REQUEST_ID }, { ok: true, status: 'enviado' }],
    [{ status: 'Blocked', request_id: REQUEST_ID }, { ok: true, status: 'bloqueado' }],
    [{ status: 'Pending' }, { ok: false, reason: 'formato', fields: [] }],
    [{ status: 'toString' }, { ok: false, reason: 'formato', fields: [] }],
    [{ status: ['Success'] }, { ok: false, reason: 'formato', fields: [] }],
    [{ status: ['Retry'] }, { ok: false, reason: 'formato', fields: [] }],
    [{ status: { toString: () => 'Blocked' } }, { ok: false, reason: 'formato', fields: [] }],
    [{ status: 1 }, { ok: false, reason: 'formato', fields: [] }],
    [{}, { ok: false, reason: 'formato', fields: [] }],
    [['Success'], { ok: false, reason: 'formato', fields: [] }]
  ]
  for (const [body, expected] of cases) {
    fake.script({ phoneSend: (req, res, ctx) => ctx.json(res, 200, body) })
    const r = await p.send({ phone: PHONE })
    t.alike(r, expected, JSON.stringify(body))
    noLeak(t, r)
  }
})

test('check: POST with the DECLINE actions and no enrichment flag', async (t) => {
  const fake = await fakeFor(t)
  const p = client(fake)
  const ok = await p.check({ phone: PHONE, code: PHONE_CODE })
  t.alike(ok, { ok: true, outcome: 'aprovado', unknownType: false })
  noLeak(t, ok)
  const wrong = await p.check({ phone: PHONE, code: WRONG_CODE })
  t.alike(wrong, { ok: true, outcome: 'codigo-invalido', unknownType: false })
  noLeak(t, wrong)

  const req = fake.seen[0]
  t.is(req.method, 'POST')
  t.is(req.path, '/v3/phone/check/')
  t.is(req.headers['x-api-key'], API_KEY)
  t.alike(req.body, {
    phone_number: PHONE,
    code: PHONE_CODE,
    voip_number_action: 'DECLINE',
    disposable_number_action: 'DECLINE',
    duplicated_phone_number_action: 'NO_ACTION'
  })
})

test('check: the provider answer is mapped through phoneOutcome', async (t) => {
  const fake = await fakeFor(t)
  const p = client(fake)
  fake.script({
    phoneCheck: (req, res, ctx) => ctx.json(res, 200, {
      status: 'Approved',
      request_id: REQUEST_ID,
      phone: { phone_number: PHONE, is_virtual: false, is_disposable: false, carrier: { name: CARRIER, type: 'Pager' } }
    })
  })
  const r = await p.check({ phone: PHONE, code: PHONE_CODE })
  t.alike(r, { ok: true, outcome: 'recusado-linha', unknownType: false })
  noLeak(t, r)
})

test('phoneOutcome: Approved', (t) => {
  const line = (extra = {}, carrier = { type: 'mobile' }) => ({
    status: 'Approved',
    phone: { is_virtual: false, is_disposable: false, country_code: 'BR', carrier, ...extra }
  })
  t.alike(phoneOutcome(line()), { outcome: 'aprovado', unknownType: false })
  for (const type of ['mobile', 'Cellular', 'WIRELESS']) {
    t.alike(phoneOutcome(line({}, { type })), { outcome: 'aprovado', unknownType: false }, type)
  }
  t.alike(phoneOutcome(line({ is_virtual: true })), { outcome: 'recusado-linha', unknownType: false }, 'virtual')
  t.alike(phoneOutcome(line({ is_disposable: true })), { outcome: 'recusado-linha', unknownType: false }, 'disposable')
  const deny = ['landline', 'fixed', 'fixed_line', 'fixedline', 'voip', 'isp', 'vpn', 'pager', 'tollfree', 'toll_free', 'premium', 'VoIP', 'Fixed_Line']
  for (const type of deny) {
    t.alike(phoneOutcome(line({}, { type })), { outcome: 'recusado-linha', unknownType: false }, type)
  }
  t.alike(phoneOutcome(line({}, { type: 'mvno' })), { outcome: 'aprovado', unknownType: true }, 'unknown type accepted')
  t.alike(phoneOutcome(line({}, { type: '' })), { outcome: 'aprovado', unknownType: true }, 'empty type accepted')
  for (const type of ['voip ', 'VoIP\n', 'landline ', ' Fixed_Line\t']) {
    t.alike(phoneOutcome(line({}, { type })), { outcome: 'recusado-linha', unknownType: false }, 'trimmed ' + JSON.stringify(type))
  }
  t.alike(phoneOutcome(line({}, { type: ' Mobile ' })), { outcome: 'aprovado', unknownType: false }, 'trimmed mobile')
  // A line type that cannot be read is accepted but flagged for the log.
  t.alike(phoneOutcome(line({}, {})), { outcome: 'aprovado', unknownType: true }, 'no type')
  t.alike(phoneOutcome(line({}, { type: 7 })), { outcome: 'aprovado', unknownType: true }, 'non-string type')
  t.alike(phoneOutcome(line({}, null)), { outcome: 'aprovado', unknownType: true }, 'no carrier')
  t.alike(phoneOutcome({ status: 'Approved', phone: null }), { outcome: 'aprovado', unknownType: true }, 'phone null')
  t.alike(phoneOutcome({ status: 'Approved' }), { outcome: 'aprovado', unknownType: true }, 'no phone')
  t.alike(phoneOutcome(line({ is_virtual: 'true' })), { outcome: 'aprovado', unknownType: false }, 'only a literal true flags')
  t.alike(phoneOutcome(line({ country_code: 'US' })), { outcome: 'aprovado', unknownType: false }, 'country_code is never read')
  t.alike(phoneOutcome(line({ country_code: 'BRA' })), { outcome: 'aprovado', unknownType: false })
})

test('phoneOutcome: other statuses', (t) => {
  t.alike(phoneOutcome({ status: 'Declined', phone: { is_virtual: true } }), { outcome: 'recusado-linha', unknownType: false })
  t.alike(phoneOutcome({ status: 'Declined', phone: { is_disposable: true } }), { outcome: 'recusado-linha', unknownType: false })
  t.alike(phoneOutcome({ status: 'Declined', phone: { is_virtual: false, is_disposable: false } }), { outcome: 'expirado', unknownType: false }, 'attempts used up')
  t.alike(phoneOutcome({ status: 'Declined', phone: null }), { outcome: 'expirado', unknownType: false })
  for (const type of ['voip', 'landline ', 'VoIP\n', 'pager']) {
    t.alike(phoneOutcome({ status: 'Declined', phone: { is_virtual: false, carrier: { type } } }), { outcome: 'recusado-linha', unknownType: false }, 'declined ' + JSON.stringify(type))
  }
  t.alike(phoneOutcome({ status: 'Declined', phone: { carrier: { type: 'mobile' } } }), { outcome: 'expirado', unknownType: false }, 'declined mobile')
  t.alike(phoneOutcome({ status: 'Declined', phone: { carrier: { type: 'mvno' } } }), { outcome: 'expirado', unknownType: false }, 'declined unknown type')
  t.alike(phoneOutcome({ status: 'Declined' }), { outcome: 'expirado', unknownType: false }, 'declined without phone')
  t.alike(phoneOutcome({ status: 'Failed', phone: null }), { outcome: 'codigo-invalido', unknownType: false })
  t.alike(phoneOutcome({ status: 'Expired or Not Found' }), { outcome: 'expirado', unknownType: false })
  for (const body of [{ status: 'Pending' }, { status: 'approved' }, {}, null, [], 'Approved', [{ status: 'Approved' }]]) {
    t.alike(phoneOutcome(body), { outcome: 'desconhecido', unknownType: false }, JSON.stringify(body))
  }
})

test('phoneOutcome never returns vendor data', (t) => {
  const r = phoneOutcome({
    status: 'Approved',
    request_id: REQUEST_ID,
    phone: { phone_number: PHONE, carrier: { name: CARRIER, type: 'mvno' } }
  })
  t.alike(Object.keys(r).sort(), ['outcome', 'unknownType'])
  noLeak(t, r)
})

test('HTTP errors collapse to a coarse reason with field names only', async (t) => {
  const fake = await fakeFor(t)
  const p = client(fake)
  const codes = [
    [400, 'http-400', ['phone_number']],
    [403, 'http-403', ['detail']],
    [429, 'http-429', ['detail']],
    [500, 'http-500', []],
    [502, 'http-502', []]
  ]
  for (const [code, reason, fields] of codes) {
    const body = code === 400 ? { phone_number: [PHONE + ' is a landline'] } : { detail: 'x ' + PHONE + ' ' + PHONE_CODE }
    fake.script({
      phoneSend: (req, res, ctx) => ctx.json(res, code, body),
      phoneCheck: (req, res, ctx) => ctx.json(res, code, body)
    })
    const s = await p.send({ phone: PHONE })
    t.alike(s, { ok: false, reason, fields }, 'send ' + code)
    noLeak(t, s)
    const c = await p.check({ phone: PHONE, code: PHONE_CODE })
    t.alike(c, { ok: false, reason, fields }, 'check ' + code)
    noLeak(t, c)
  }
})

test('timeout, network error, redirect, oversize and non-JSON bodies', async (t) => {
  const fake = await fakeFor(t)

  fake.script(() => {})
  t.alike(await client(fake, { timeoutMs: 100 }).send({ phone: PHONE }), { ok: false, reason: 'tempo', fields: [] }, 'no answer')
  fake.script({
    phoneCheck (req, res) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write('{"status":')
    }
  })
  t.alike(await client(fake, { timeoutMs: 100 }).check({ phone: PHONE, code: PHONE_CODE }), { ok: false, reason: 'tempo', fields: [] }, 'body stalls')

  const down = createPhoneClient({ apiKey: API_KEY, endpoints: { base: fake.base }, fetch: () => Promise.reject(new TypeError('fetch failed')) })
  t.alike(await down.send({ phone: PHONE }), { ok: false, reason: 'rede', fields: [] }, 'network error')

  const before = fake.seen.length
  fake.script((req, res) => {
    if (req.url === '/elsewhere') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"Success"}')
    res.writeHead(307, { Location: fake.base + '/elsewhere' }).end()
  })
  t.alike(await client(fake).send({ phone: PHONE }), { ok: false, reason: 'rede', fields: [] }, 'redirect refused')
  t.is(fake.seen.length, before + 1, 'only the original request was made')

  const p = client(fake)
  fake.script({ phoneSend: (req, res, ctx) => ctx.json(res, 200, { status: 'Success', pad: 'x'.repeat(70000) }) })
  t.alike(await p.send({ phone: PHONE }), { ok: false, reason: 'formato', fields: [] }, 'oversize declared')
  fake.script({
    phoneCheck (req, res) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'Approved', pad: 'x'.repeat(70000) }))
    }
  })
  t.alike(await p.check({ phone: PHONE, code: PHONE_CODE }), { ok: false, reason: 'formato', fields: [] }, 'oversize streamed')

  fake.script({ phoneSend: (req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>' + PHONE + '</html>') })
  t.alike(await p.send({ phone: PHONE }), { ok: false, reason: 'formato', fields: [] }, 'not JSON')
  fake.script({ phoneCheck: (req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{not json') })
  t.alike(await p.check({ phone: PHONE, code: PHONE_CODE }), { ok: false, reason: 'formato', fields: [] }, 'bad JSON')
})

test('bad input never fetches', async (t) => {
  let calls = 0
  const p = createPhoneClient({
    apiKey: API_KEY,
    fetch: () => {
      calls++
      throw new Error('should not fetch')
    }
  })
  const bad = { ok: false, reason: 'entrada', fields: [] }
  const phones = ['11987654321', '5511987654321', '+551133334444', '+5501987654321', '+5511987654', '+15551234567', ' +5511987654321', 5511987654321, undefined, null]
  for (const phone of phones) {
    t.alike(await p.send({ phone }), bad, 'send ' + String(phone))
    t.alike(await p.check({ phone, code: PHONE_CODE }), bad, 'check ' + String(phone))
  }
  for (const code of ['12345', '1234567', 'abcdef', '12345a', ' 123456', 123456, undefined, '１２３４５６']) {
    t.alike(await p.check({ phone: PHONE, code }), bad, 'code ' + String(code))
  }
  t.alike(await p.send(), bad)
  t.alike(await p.check(), bad)
  t.alike(await p.send({ phone: PHONE, channel: 'sms' }).then((r) => r.reason), 'rede', 'a channel argument is ignored')
  t.is(calls, 1, 'only the valid request reached fetch')
})

test('no request carries signals, an IP, metadata, a workflow id or a member key', async (t) => {
  const fake = await fakeFor(t)
  const p = client(fake, { workflowId: '11111111-2222-4333-8444-555555555555' })
  await p.send({ phone: PHONE, signals: { ip: '203.0.113.9' }, member: 'a'.repeat(64), channel: 'outro' })
  await p.check({ phone: PHONE, code: PHONE_CODE, ip: '203.0.113.9', member: 'a'.repeat(64) })
  await p.check({ phone: PHONE, code: WRONG_CODE })
  t.is(fake.seen.length, 3)
  for (const req of fake.seen) {
    const keys = allKeys(req.body).map((k) => k.toLowerCase())
    for (const banned of ['signals', 'ip', 'ip_address', 'metadata', 'workflow_id', 'member', 'member_key', 'channel', 'paid_enrichment']) {
      t.absent(keys.includes(banned), req.path + ' has no ' + banned)
    }
    const text = JSON.stringify(req.body)
    t.absent(text.includes('203.0.113.9'))
    t.absent(text.includes('a'.repeat(64)))
    t.absent(text.includes('11111111-2222'))
    t.absent(text.includes('outro'))
  }
})

test('SMS only: every send asks for sms and the client never names the other channel', async (t) => {
  const fake = await fakeFor(t)
  const p = client(fake)
  for (let i = 0; i < 3; i++) await p.send({ phone: PHONE })
  const sends = fake.seen.filter((s) => s.path === '/v3/phone/send/')
  t.is(sends.length, 3)
  for (const req of sends) t.is(req.body.options.preferred_channel, 'sms')
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'account', 'phone-client.js'), 'utf8')
  t.absent(source.toLowerCase().includes('whatsapp'))
})
