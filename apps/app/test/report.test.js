'use strict'

// The report helpers (src/report.js). ES module loaded through import();
// fetch is stubbed, nothing touches the network.
const test = require('brittle')
const core = require('@varanda/core/lib/report')

const load = () => import('../src/report.js')
const M = 'ab'.repeat(32)
const T = 'cd'.repeat(32)
const NONCE = 'n'.repeat(43)
const SIG = 'ef'.repeat(64)
const LONE = String.fromCharCode(0xd800)
const FFFD = String.fromCodePoint(0xfffd)

function stub (t, res) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return typeof res === 'function' ? res() : res
  }
  t.teardown(() => { globalThis.fetch = real })
  return calls
}
const json = (status, obj, type = 'application/json') => ({
  ok: status < 400,
  status,
  headers: { get: () => type },
  text: async () => JSON.stringify(obj)
})

test('REASONS follow the core order and labels', async (t) => {
  const { REASONS, TEXT_MAX } = await load()
  t.alike(REASONS.map(([id]) => id), core.REASONS.slice())
  for (const [id, label] of REASONS) t.is(label, core.REASON_LABELS[id])
  t.is(TEXT_MAX, core.TEXT_MAX)
})

test('validateReportText trims and bounds by code points', async (t) => {
  const { validateReportText } = await load()
  t.is(validateReportText('  oi  '), 'oi')
  t.is(validateReportText(' \t  '), '')
  t.is(validateReportText(''), '')
  t.is(validateReportText(undefined), '')
  t.is(validateReportText('a'.repeat(280)), 'a'.repeat(280))
  t.is(validateReportText('a'.repeat(281)), null)
  // 280 astral characters are 560 UTF-16 units and still fit.
  const astral = String.fromCodePoint(0x1f600).repeat(280)
  t.is(validateReportText(astral), astral)
  t.is(validateReportText(astral + 'a'), null)
})

test('wellFormed replaces lone surrogates only', async (t) => {
  const { wellFormed } = await load()
  t.is(wellFormed('a' + LONE + 'b'), 'a' + FFFD + 'b')
  t.is(wellFormed(String.fromCharCode(0xdc00)), FFFD)
  const pair = String.fromCodePoint(0x1f600)
  t.is(wellFormed(pair), pair)
  t.is(wellFormed(null), '')
})

test('a post with a lone surrogate can be reported once normalized', async (t) => {
  const { wellFormed } = await load()
  const crypto = require('hypercore-crypto')
  const kp = crypto.keyPair()
  const fields = {
    nonce: NONCE,
    member: kp.publicKey.toString('hex'),
    association: M,
    target: T,
    seq: 3,
    reason: 'spam',
    text: '',
    quote: 'oi ' + LONE
  }
  // TypeError is a native error: brittle needs exception.all to expect it.
  t.exception.all(() => core.signReport(fields, kp), /invalid report quote/)
  const normalized = { ...fields, quote: wellFormed(fields.quote) }
  const sig = core.signReport(normalized, kp)
  t.ok(core.verifyReport(normalized, sig).ok)
})

test('every error token maps to a fixed message', async (t) => {
  const { toError } = await load()
  const cases = {
    'nao-vinculado': 'Para denunciar, primeiro vincule sua conta Google em Ajustes → Conta e @nome.',
    'limite-denuncias': 'muitas denúncias em 24 horas; tente de novo amanhã',
    limite: 'a moderação não pode receber denúncias agora',
    'assinatura-invalida': 'não foi possível provar a chave',
    expirado: 'a denúncia expirou, tente de novo',
    'pedido-invalido': 'denúncia inválida'
  }
  for (const [code, message] of Object.entries(cases)) {
    const err = toError(code)
    t.is(err.message, message, code)
    t.is(err.code, code)
  }
  for (const other of ['', 'toString', '__proto__', 'nome-em-uso', undefined, 5]) {
    const err = toError(other)
    t.is(err.message, 'serviço indisponível')
    t.is(err.code, 'indisponivel')
  }
})

test('request builders: same-origin POST with the exact body keys', async (t) => {
  const { buildReportStart, buildReportSend } = await load()
  const start = buildReportStart({ member: M })
  t.is(start.url, '/account/report/start')
  t.is(start.init.method, 'POST')
  t.is(start.init.credentials, 'same-origin')
  t.is(start.init.cache, 'no-store')
  t.alike(start.init.headers, { accept: 'application/json', 'content-type': 'application/json' })
  t.alike(JSON.parse(start.init.body), { member: M })

  const fields = { member: M, nonce: NONCE, target: T, seq: 4, reason: 'assedio', text: 'x', quote: 'post', signature: SIG }
  const send = buildReportSend(fields)
  t.is(send.url, '/account/report')
  t.is(send.init.method, 'POST')
  t.is(send.init.credentials, 'same-origin')
  t.is(send.init.cache, 'no-store')
  t.alike(Object.keys(JSON.parse(send.init.body)).sort(), ['member', 'nonce', 'quote', 'reason', 'seq', 'signature', 'target', 'text'])
  t.alike(JSON.parse(send.init.body), fields)

  const account = JSON.parse(buildReportSend({ ...fields, seq: null, quote: '' }).init.body)
  t.is(account.seq, null)
  t.is(account.quote, '')
})

test('reportStart and reportSend parse the answers', async (t) => {
  const { reportStart, reportSend } = await load()
  let calls = stub(t, json(200, { nonce: NONCE }))
  t.alike(await reportStart({ member: M }), { nonce: NONCE })
  t.is(calls[0].url, '/account/report/start')
  t.ok(calls[0].init.signal, 'aborts after the timeout')

  calls = stub(t, json(200, { id: 'r1', duplicate: true }))
  t.alike(await reportSend({ member: M, nonce: NONCE, target: T, seq: null, reason: 'outro', text: '', quote: '', signature: SIG }), { id: 'r1', duplicate: true })
  t.is(calls[0].url, '/account/report')
})

test('failures never expose the body', async (t) => {
  const { reportStart, reportSend } = await load()
  stub(t, json(403, { error: 'nao-vinculado' }))
  await t.exception(reportStart({ member: M }), /vincule sua conta Google/)

  stub(t, json(429, { error: 'limite-denuncias' }))
  await t.exception(reportSend({}), /muitas denúncias/)

  stub(t, json(500, { error: 'segredo interno' }))
  await t.exception(reportStart({ member: M }), /^Error: serviço indisponível$/)

  stub(t, json(200, { nonce: NONCE }, 'text/html'))
  await t.exception(reportStart({ member: M }), /serviço indisponível/)

  stub(t, { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"nonce":"' + 'a'.repeat(5000) + '"}' })
  await t.exception(reportStart({ member: M }), /serviço indisponível/)

  stub(t, () => { throw new Error('rede caiu') })
  await t.exception(reportStart({ member: M }), /serviço indisponível/)

  stub(t, json(200, { nonce: 5 }))
  await t.exception(reportStart({ member: M }), /serviço indisponível/)
})

test('app client: absolute URLs, header and no credentials only with the flag on', async (t) => {
  const { buildReportStart, buildReportSend } = await load()
  const { setInstallation } = await import('../src/installation.js')
  const { setAppClient } = await import('../src/appClient.js')
  t.teardown(() => { setInstallation(null); setAppClient(false) })
  const fields = { member: M, nonce: NONCE, target: T, seq: 4, reason: 'assedio', text: 'x', quote: 'post', signature: SIG }

  t.ok(setInstallation('https://example.test'))
  setAppClient(true)
  const start = buildReportStart({ member: M })
  const send = buildReportSend(fields)
  t.is(start.url, 'https://example.test/account/report/start')
  t.is(send.url, 'https://example.test/account/report')
  for (const r of [start, send]) {
    t.is(r.init.credentials, 'omit')
    t.absent('cache' in r.init, 'no cache option in the app')
    t.alike(r.init.headers, { accept: 'application/json', 'content-type': 'application/json', 'x-varanda-client': 'app' })
  }

  setAppClient(false)
  setInstallation(null)
  const web = buildReportStart({ member: M })
  t.is(web.url, '/account/report/start')
  t.is(web.init.credentials, 'same-origin')
  t.is(web.init.cache, 'no-store', 'the web keeps no-store')
  t.alike(web.init.headers, { accept: 'application/json', 'content-type': 'application/json' })
})
