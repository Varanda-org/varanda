'use strict'

// The appeal helpers (src/appeal.js). ES module loaded through import();
// fetch is stubbed, nothing touches the network.
const test = require('brittle')
const core = require('@varanda/core/lib/appeal')

const load = () => import('../src/appeal.js')
const M = 'ab'.repeat(32)
const NONCE = 'n'.repeat(43)
const SIG = 'ef'.repeat(64)
const LONE = String.fromCharCode(0xd800)

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

test('TEXT_MAX follows the core limit', async (t) => {
  const { TEXT_MAX } = await load()
  t.is(TEXT_MAX, core.TEXT_MAX)
})

test('validateAppealText trims and bounds by code points', async (t) => {
  const { validateAppealText, TEXT_MAX } = await load()
  t.is(validateAppealText('  oi  '), 'oi')
  t.is(validateAppealText(' \t  '), '')
  t.is(validateAppealText(undefined), '')
  t.is(validateAppealText('a'.repeat(TEXT_MAX)), 'a'.repeat(TEXT_MAX))
  t.is(validateAppealText('a'.repeat(TEXT_MAX + 1)), null)
  const astral = String.fromCodePoint(0x1f600).repeat(TEXT_MAX)
  t.is(validateAppealText(astral), astral, 'astral characters count once')
  t.is(validateAppealText(astral + 'a'), null)
})

test('a text with a lone surrogate can be signed once normalized', async (t) => {
  const { wellFormed } = await load()
  const crypto = require('hypercore-crypto')
  const kp = crypto.keyPair()
  const fields = { nonce: NONCE, member: kp.publicKey.toString('hex'), association: M, text: 'oi ' + LONE }
  t.exception.all(() => core.signAppeal(fields, kp), /invalid appeal text/)
  const normalized = { ...fields, text: wellFormed(fields.text) }
  t.ok(core.verifyAppeal(normalized, core.signAppeal(normalized, kp)).ok)
})

test('every error token maps to a fixed message', async (t) => {
  const { toError } = await load()
  const cases = {
    'nao-vinculado': 'Para recorrer, primeiro vincule sua conta Google em Ajustes → Conta e @nome.',
    'nao-bloqueado': 'esta conta não está bloqueada',
    'limite-recursos': 'você já recorreu nos últimos 30 dias',
    limite: 'a moderação não pode receber recursos agora',
    'assinatura-invalida': 'não foi possível provar a chave',
    expirado: 'o recurso expirou, tente de novo',
    'pedido-invalido': 'recurso inválido'
  }
  for (const [code, message] of Object.entries(cases)) {
    const err = toError(code)
    t.is(err.message, message, code)
    t.is(err.code, code)
  }
  for (const other of ['', 'toString', '__proto__', 'limite-denuncias', undefined, 5]) {
    const err = toError(other)
    t.is(err.message, 'serviço indisponível')
    t.is(err.code, 'indisponivel')
  }
})

test('request builders: same-origin POST with the exact body keys', async (t) => {
  const { buildAppealStart, buildAppealSend } = await load()
  const start = buildAppealStart({ member: M })
  t.is(start.url, '/account/appeal/start')
  t.is(start.init.method, 'POST')
  t.is(start.init.credentials, 'same-origin')
  t.is(start.init.cache, 'no-store')
  t.alike(JSON.parse(start.init.body), { member: M })

  const fields = { member: M, nonce: NONCE, text: 'foi um engano', signature: SIG }
  const send = buildAppealSend(fields)
  t.is(send.url, '/account/appeal')
  t.alike(Object.keys(JSON.parse(send.init.body)).sort(), ['member', 'nonce', 'signature', 'text'])
  t.alike(JSON.parse(send.init.body), fields)
})

test('appealStart and appealSend parse the answers', async (t) => {
  const { appealStart, appealSend } = await load()
  let calls = stub(t, json(200, { nonce: NONCE }))
  t.alike(await appealStart({ member: M }), { nonce: NONCE })
  t.is(calls[0].url, '/account/appeal/start')
  t.ok(calls[0].init.signal, 'aborts after the timeout')

  calls = stub(t, json(200, { id: 'a1', duplicate: true }))
  t.alike(await appealSend({ member: M, nonce: NONCE, text: '', signature: SIG }), { id: 'a1', duplicate: true })
  t.is(calls[0].url, '/account/appeal')
})

test('failures never expose the body', async (t) => {
  const { appealStart, appealSend } = await load()
  stub(t, json(403, { error: 'nao-vinculado' }))
  await t.exception(appealStart({ member: M }), /vincule sua conta Google/)

  stub(t, json(403, { error: 'nao-bloqueado' }))
  await t.exception(appealSend({}), /não está bloqueada/)

  stub(t, json(429, { error: 'limite-recursos' }))
  await t.exception(appealSend({}), /30 dias/)

  stub(t, json(500, { error: 'segredo interno' }))
  await t.exception(appealStart({ member: M }), /^Error: serviço indisponível$/)

  stub(t, json(200, { nonce: NONCE }, 'text/html'))
  await t.exception(appealStart({ member: M }), /serviço indisponível/)

  stub(t, () => { throw new Error('rede caiu') })
  await t.exception(appealStart({ member: M }), /serviço indisponível/)

  stub(t, json(200, { nonce: 5 }))
  await t.exception(appealStart({ member: M }), /serviço indisponível/)
})

test('app client: absolute URLs, header and no credentials only with the flag on', async (t) => {
  const { buildAppealStart, buildAppealSend } = await load()
  const { setInstallation } = await import('../src/installation.js')
  const { setAppClient } = await import('../src/appClient.js')
  t.teardown(() => { setInstallation(null); setAppClient(false) })
  const fields = { member: M, nonce: NONCE, text: 'x', signature: SIG }

  t.ok(setInstallation('https://example.test'))
  setAppClient(true)
  const start = buildAppealStart({ member: M })
  const send = buildAppealSend(fields)
  t.is(start.url, 'https://example.test/account/appeal/start')
  t.is(send.url, 'https://example.test/account/appeal')
  for (const r of [start, send]) {
    t.is(r.init.credentials, 'omit')
    t.absent('cache' in r.init, 'no cache option in the app')
    t.alike(r.init.headers, { accept: 'application/json', 'content-type': 'application/json', 'x-varanda-client': 'app' })
  }

  setAppClient(false)
  setInstallation(null)
  t.is(buildAppealStart({ member: M }).url, '/account/appeal/start')
})
