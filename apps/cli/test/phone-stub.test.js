'use strict'

// apps/cli/scripts/phone-stub.js: the SMS client stand-in. No socket. The
// shared helper is only loaded here, to show that requiring it binds nothing.

const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { isBrMobile } = require('@varanda/core/lib/phone')
const { createPhoneStub, STUB_CODE } = require('../scripts/phone-stub')

const PHONE = '+5511987654321'
const PHONE_B = '+5521987654321'
const PHONE_C = '+5599999999999'
const WRONG_CODE = '654321'
const STUB_PATH = path.join(__dirname, '..', 'scripts', 'phone-stub.js')
const HELPER_PATH = path.join(__dirname, 'helpers', 'phone-link.js')

function listeningCount () {
  return process._getActiveHandles().filter((h) => h instanceof net.Server).length
}

function noSecrets (t, value, secrets) {
  const text = JSON.stringify(value)
  for (const secret of secrets) t.absent(text.includes(secret), 'answer carries no secret')
}

test('the stub answers the client interface for any Brazilian mobile', async (t) => {
  t.is(STUB_CODE, '123456')
  const stub = createPhoneStub()
  t.alike(Object.keys(stub).sort(), ['check', 'send'])
  for (const phone of [PHONE, PHONE_B, PHONE_C]) {
    t.ok(isBrMobile(phone))
    const sent = await stub.send({ phone })
    t.alike(sent, { ok: true, status: 'enviado' })
    noSecrets(t, sent, [phone, STUB_CODE])
    const ok = await stub.check({ phone, code: STUB_CODE })
    t.alike(ok, { ok: true, outcome: 'aprovado', unknownType: false })
    noSecrets(t, ok, [phone, STUB_CODE])
  }
  const again = await createPhoneStub().send({ phone: PHONE })
  t.alike(again, { ok: true, status: 'enviado' })
})

test('a wrong code is refused, and a bad number or code is bad input', async (t) => {
  const stub = createPhoneStub()
  const wrong = await stub.check({ phone: PHONE, code: WRONG_CODE })
  t.alike(wrong, { ok: true, outcome: 'codigo-invalido', unknownType: false })
  noSecrets(t, wrong, [PHONE, WRONG_CODE, STUB_CODE])
  t.not(wrong.outcome, 'aprovado')

  const badCodes = ['', '12345', '1234567', '12345a', '123456 ', ' 123456', STUB_CODE + '\n', 123456, null, undefined]
  for (const code of badCodes) {
    const r = await stub.check({ phone: PHONE, code })
    t.alike(r, { ok: false, reason: 'entrada', fields: [] }, 'code ' + typeof code)
    noSecrets(t, r, [PHONE, STUB_CODE])
  }

  const badPhones = ['+551132345678', '+14155552671', '+5511912345678\n', '5511987654321', '', null, undefined, 5511987654321]
  for (const phone of badPhones) {
    t.alike(await stub.send({ phone }), { ok: false, reason: 'entrada', fields: [] })
    t.alike(await stub.check({ phone, code: STUB_CODE }), { ok: false, reason: 'entrada', fields: [] })
  }
  t.alike(await stub.send(), { ok: false, reason: 'entrada', fields: [] })
  t.alike(await stub.check(), { ok: false, reason: 'entrada', fields: [] })
})

test('the stub source opens no socket', (t) => {
  const source = fs.readFileSync(STUB_PATH, 'utf8')
  for (const banned of ['node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'fetch(', 'createServer', '.listen(']) {
    t.absent(source.includes(banned), banned)
  }
})

test('the helper module loads without starting a server', (t) => {
  const before = listeningCount()
  const helper = require('./helpers/phone-link')
  t.is(listeningCount(), before)
  t.is(typeof helper.linkByPhone, 'function')
  t.is(typeof helper.phoneServerOptions, 'function')
  const source = fs.readFileSync(HELPER_PATH, 'utf8')
  for (const banned of ['createServer', '.listen(', 'x-varanda-redeem', 'ageRequired']) {
    t.absent(source.includes(banned), banned)
  }
  t.ok(source.includes('appProof'))
  t.ok(source.includes('x-varanda-link') || source.includes('LINK_HEADER'))

  const opts = helper.phoneServerOptions()
  const other = helper.phoneServerOptions()
  t.teardown(() => {
    fs.rmSync(opts.dir, { recursive: true, force: true })
    fs.rmSync(other.dir, { recursive: true, force: true })
  })
  t.is(listeningCount(), before)
  t.alike(Object.keys(opts.phoneClient).sort(), ['check', 'send'])
  t.is(opts.key.length, 32)
  t.ok(Buffer.isBuffer(opts.key))
  t.absent(opts.key.equals(other.key))
  t.not(opts.dir, other.dir)
  t.ok(opts.phones.available())
  t.absent(Object.hasOwn(opts, 'ageRequired'))
})
