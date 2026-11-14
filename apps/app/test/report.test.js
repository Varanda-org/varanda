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
    'nao-vinculado': 'Termine o cadastro em Ajustes → Conta e @nome.',
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
  await t.exception(reportStart({ member: M }), /Termine o cadastro/)

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

const W = '12'.repeat(32)
const G = '34'.repeat(32)

// fetch stub that answers start with a nonce and the POST with an id.
function flowStub (t, { failSend = false } = {}) {
  const calls = stub(t, async () => {
    const url = calls[calls.length - 1].url
    if (url.endsWith('/start')) return json(200, { nonce: NONCE })
    return failSend ? json(500, { error: 'x' }) : json(200, { id: 'r1' })
  })
  return calls
}

test('group message report: fields reach report.sign and the POST', async (t) => {
  const { submitReport } = await load()
  const calls = flowStub(t)
  let params = null
  const out = await submitReport({
    member: M,
    target: T,
    seq: 4,
    writer: W,
    group: G,
    reason: 'spam',
    text: 'nota',
    quote: 'oi ' + LONE,
    sign: async (p) => { params = p; return { signature: SIG } },
    isStale: () => false
  })
  t.alike(out, { id: 'r1', duplicate: false })
  t.alike(params, { nonce: NONCE, target: T, reason: 'spam', text: 'nota', seq: 4, quote: 'oi ' + FFFD, writer: W, group: G })
  t.alike(JSON.parse(calls[1].init.body), { member: M, nonce: NONCE, target: T, seq: 4, writer: W, group: G, reason: 'spam', text: 'nota', quote: 'oi ' + FFFD, signature: SIG })
})

test('existing variants: diary post and whole account carry no writer or group', async (t) => {
  const { submitReport } = await load()
  const calls = flowStub(t)
  const seen = []
  const sign = async (p) => { seen.push(p); return { signature: SIG } }
  await submitReport({ member: M, target: T, seq: 2, reason: 'outro', text: '', quote: 'q', sign, isStale: () => false })
  await submitReport({ member: M, target: T, seq: null, reason: 'outro', text: '', quote: 'ignored', sign, isStale: () => false })
  t.alike(seen[0], { nonce: NONCE, target: T, reason: 'outro', text: '', seq: 2, quote: 'q' })
  t.alike(seen[1], { nonce: NONCE, target: T, reason: 'outro', text: '' })
  t.alike(Object.keys(JSON.parse(calls[1].init.body)).sort(), ['member', 'nonce', 'quote', 'reason', 'seq', 'signature', 'target', 'text'])
  const whole = JSON.parse(calls[3].init.body)
  t.is(whole.seq, null)
  t.is(whole.quote, '')
})

test('nothing is asked before the explicit send', async (t) => {
  const calls = flowStub(t)
  await load()
  t.is(calls.length, 0, 'loading the module never asks for a nonce')
})

test('cancelling between steps stops the flow', async (t) => {
  const { submitReport } = await load()
  const base = { member: M, target: T, seq: 4, writer: W, group: G, reason: 'spam', text: '', quote: 'q' }
  let signed = 0
  const sign = async () => { signed++; return { signature: SIG } }

  const a = flowStub(t)
  t.is(await submitReport({ ...base, sign, isStale: () => true }), null, 'stale after the nonce')
  t.is(signed, 0, 'never signed')
  t.is(a.length, 1, 'only the nonce request')

  const b = flowStub(t)
  let checks = 0
  t.is(await submitReport({ ...base, sign, isStale: () => ++checks === 2 }), null, 'stale after signing')
  t.is(signed, 1)
  t.is(b.length, 1, 'never posted')
})

test('an identity change between steps invalidates the flow', async (t) => {
  const { submitReport } = await load()
  const calls = flowStub(t)
  let current = M
  const out = await submitReport({
    member: M,
    target: T,
    seq: 4,
    writer: W,
    group: G,
    reason: 'spam',
    text: '',
    quote: 'q',
    sign: async () => { current = 'ff'.repeat(32); return { signature: SIG } },
    isStale: () => current !== M
  })
  t.is(out, null)
  t.is(calls.length, 1, 'the signed statement is not posted under another identity')
})

test('a failed POST is not retried', async (t) => {
  const { submitReport } = await load()
  const calls = flowStub(t, { failSend: true })
  await t.exception(submitReport({ member: M, target: T, seq: 4, writer: W, group: G, reason: 'spam', text: '', quote: 'q', sign: async () => ({ signature: SIG }), isStale: () => false }))
  t.is(calls.length, 2, 'one nonce, one POST')
})

test('dm report: dm.reportSign params and a kind dm POST with the sender as target, nothing else', async (t) => {
  const { submitDmReport } = await load()
  const calls = flowStub(t)
  let params = null
  const out = await submitDmReport({
    member: M,
    target: T,
    reason: 'assedio',
    text: 'nota',
    quote: 'oi ' + LONE,
    sign: async (p) => { params = p; return { signature: SIG } },
    isStale: () => false
  })
  t.alike(out, { id: 'r1', duplicate: false })
  t.alike(params, { nonce: NONCE, target: T, reason: 'assedio', text: 'nota', quote: 'oi ' + FFFD })
  t.is(calls[1].url.endsWith('/account/report'), true)
  const body = JSON.parse(calls[1].init.body)
  t.alike(body, { kind: 'dm', member: M, nonce: NONCE, target: T, reason: 'assedio', text: 'nota', quote: 'oi ' + FFFD, signature: SIG })
  for (const k of ['peer', 'seq', 'writer', 'group', 'from', 'to']) t.absent(Object.hasOwn(body, k), 'no ' + k)
  const st = core.verifyDmReport
  t.is(typeof st, 'function', 'core verifies this statement')
})

test('dm report: stale stops before signing; a failed POST is not retried', async (t) => {
  const { submitDmReport } = await load()
  let signed = 0
  const sign = async () => { signed++; return { signature: SIG } }
  const a = flowStub(t)
  t.is(await submitDmReport({ member: M, target: T, reason: 'spam', text: '', quote: 'q', sign, isStale: () => true }), null)
  t.is(signed, 0)
  t.is(a.length, 1)
  const b = flowStub(t, { failSend: true })
  await t.exception(submitDmReport({ member: M, target: T, reason: 'spam', text: '', quote: 'q', sign, isStale: () => false }))
  t.is(b.length, 2, 'one nonce, one POST')
})

// Anexo: the decrypted image a private message or private group report
// carries (POST /account/report/anexo, statement dm v2 / report v3).

const nodeCrypto = require('crypto')
const sha256Hex = (bytes) => nodeCrypto.createHash('sha256').update(bytes).digest('hex')
const ID = '56'.repeat(16)
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9])

function anexoOf (bytes) {
  return { bytes, digest: sha256Hex(bytes) }
}

test('toBase64 matches standard base64 with padding', async (t) => {
  const { toBase64 } = await load()
  for (let n = 0; n < 40; n++) {
    const bytes = nodeCrypto.randomBytes(n)
    t.is(toBase64(new Uint8Array(bytes)), bytes.toString('base64'), n + ' bytes')
  }
})

test('dm report with an image: digest signed, body on the anexo route verifies as the server checks it', async (t) => {
  const { submitDmReport } = await load()
  const calls = flowStub(t)
  const kp = require('hypercore-crypto').keyPair()
  const member = kp.publicKey.toString('hex')
  let params = null
  const out = await submitDmReport({
    member,
    target: T,
    reason: 'ilegal',
    text: 'nota',
    quote: 'olha isso',
    anexo: anexoOf(JPEG),
    sign: async (p) => {
      params = p
      return { signature: core.signDmReport({ ...p, member, association: M }, kp) }
    },
    isStale: () => false
  })
  t.alike(out, { id: 'r1', duplicate: false })
  t.alike(params, { nonce: NONCE, target: T, reason: 'ilegal', text: 'nota', quote: 'olha isso', anexo: sha256Hex(JPEG) })
  t.is(calls.length, 2, 'one nonce, one POST')
  t.ok(calls[1].url.endsWith('/account/report/anexo'))
  const body = JSON.parse(calls[1].init.body)
  t.alike(Object.keys(body).sort(), ['anexo', 'kind', 'member', 'nonce', 'quote', 'reason', 'signature', 'target', 'text'])
  t.is(body.kind, 'dm')
  const received = Buffer.from(body.anexo, 'base64')
  t.alike(new Uint8Array(received), JPEG, 'the exact bytes travel')
  const fields = { nonce: body.nonce, member, association: M, target: body.target, reason: body.reason, text: body.text, quote: body.quote, anexo: sha256Hex(received) }
  t.ok(core.verifyDmReport(fields, body.signature).ok, 'dm v2 statement verifies over the received bytes')
})

test('media-only dm report: empty quote plus the digest', async (t) => {
  const { submitDmReport } = await load()
  const calls = flowStub(t)
  let params = null
  await submitDmReport({
    member: M,
    target: T,
    reason: 'spam',
    text: '',
    quote: '',
    anexo: anexoOf(JPEG),
    sign: async (p) => { params = p; return { signature: SIG } },
    isStale: () => false
  })
  t.is(params.quote, '')
  t.is(params.anexo, sha256Hex(JPEG))
  const body = JSON.parse(calls[1].init.body)
  t.is(body.quote, '')
  t.is(typeof body.anexo, 'string')
})

test('dm report without an image keeps the plain route and v1 params', async (t) => {
  const { submitDmReport } = await load()
  const calls = flowStub(t)
  let params = null
  await submitDmReport({ member: M, target: T, reason: 'spam', text: '', quote: 'q', anexo: null, sign: async (p) => { params = p; return { signature: SIG } }, isStale: () => false })
  t.absent(Object.hasOwn(params, 'anexo'))
  t.ok(calls[1].url.endsWith('/account/report'))
  t.absent(Object.hasOwn(JSON.parse(calls[1].init.body), 'anexo'))
})

test('private group report with an image: report.sign gets the digest, v3 verifies', async (t) => {
  const { submitReport } = await load()
  const calls = flowStub(t)
  const kp = require('hypercore-crypto').keyPair()
  const member = kp.publicKey.toString('hex')
  let params = null
  await submitReport({
    member,
    target: T,
    seq: 7,
    writer: W,
    group: G,
    reason: 'assedio',
    text: '',
    quote: '',
    anexo: anexoOf(JPEG),
    sign: async (p) => {
      params = p
      return { signature: core.signReport({ ...p, member, association: M }, kp) }
    },
    isStale: () => false
  })
  t.alike(params, { nonce: NONCE, target: T, reason: 'assedio', text: '', seq: 7, quote: '', writer: W, group: G, anexo: sha256Hex(JPEG) })
  t.ok(calls[1].url.endsWith('/account/report/anexo'))
  const body = JSON.parse(calls[1].init.body)
  const received = Buffer.from(body.anexo, 'base64')
  const fields = { nonce: body.nonce, member, association: M, target: body.target, seq: body.seq, writer: body.writer, group: body.group, reason: body.reason, text: body.text, quote: body.quote, anexo: sha256Hex(received) }
  t.ok(core.verifyReport(fields, body.signature).ok, 'report v3 verifies over the received bytes')
})

test('a diary post or account report never carries an image', async (t) => {
  const { submitReport } = await load()
  const calls = flowStub(t)
  const seen = []
  const sign = async (p) => { seen.push(p); return { signature: SIG } }
  await submitReport({ member: M, target: T, seq: 2, reason: 'spam', text: '', quote: 'q', anexo: anexoOf(JPEG), sign, isStale: () => false })
  await submitReport({ member: M, target: T, seq: null, reason: 'spam', text: '', anexo: anexoOf(JPEG), sign, isStale: () => false })
  for (const p of seen) t.absent(Object.hasOwn(p, 'anexo'))
  t.ok(calls[1].url.endsWith('/account/report'))
  t.ok(calls[3].url.endsWith('/account/report'))
  t.absent(Object.hasOwn(JSON.parse(calls[1].init.body), 'anexo'))
})

test('anexoRef: dm and private group items; public group posts and gone items have none', async (t) => {
  const { anexoRef } = await load()
  const sealed = { core: W, start: 0, blocks: 1, sha256: 'aa'.repeat(32), key: 'k', nonce: 'n', plainMime: 'image/jpeg' }
  const plain = { core: W, start: 0, blocks: 1, sha256: 'aa'.repeat(32), mime: 'image/jpeg' }
  const dmItem = { id: 'x', mime: 'image/jpeg' }
  t.alike(anexoRef({ dm: true, id: ID, author: T, text: '', media: [{ unavailable: true }, dmItem] }), { kind: 'dm', from: T, id: ID, index: 1, item: dmItem })
  t.is(anexoRef({ dm: true, id: ID, author: T, text: '' }), null, 'no media')
  t.is(anexoRef({ dm: true, id: ID, author: T, media: [{ unavailable: true }] }), null, 'all gone')
  t.is(anexoRef({ dm: true, id: 'bad', author: T, media: [dmItem] }), null)
  const group = { author: T, seq: 3, text: '', group: G, writer: W }
  t.alike(anexoRef({ ...group, private: true, media: [sealed] }), { kind: 'group', diary: T, item: sealed })
  t.is(anexoRef({ ...group, private: false, media: [plain] }), null, 'a public post points at the post')
  t.is(anexoRef({ ...group, private: true, media: [plain] }), null, 'only a sealed item')
  t.is(anexoRef(null), null)
})

test('prepareAnexo: re-encoded JPEG under the cap is hashed', async (t) => {
  const { prepareAnexo, ANEXO_MAX_BYTES } = await load()
  const calls = stub(t, json(500, {}))
  const ref = { kind: 'dm', from: T, id: ID, index: 0 }
  let asked = null
  let cap = null
  const out = await prepareAnexo(ref, {
    source: async (r) => { asked = r; return { uri: 'blob:local/1', mime: 'image/png', w: 10, h: 10 } },
    encode: async (entry, max) => { cap = max; return { bytes: JPEG, mime: 'image/jpeg', width: 10, height: 10 } }
  })
  t.is(asked, ref)
  t.is(cap, ANEXO_MAX_BYTES)
  t.ok(ANEXO_MAX_BYTES <= 1024 * 1024)
  t.is(out.status, 'ok')
  t.alike(out.bytes, JPEG)
  t.is(out.digest, sha256Hex(JPEG))
  t.is(calls.length, 0, 'nothing fetched')
})

test('prepareAnexo: over the cap, not jpeg, gone, broken or remote', async (t) => {
  const { prepareAnexo } = await load()
  const calls = stub(t, json(500, {}))
  const ref = { kind: 'dm', from: T, id: ID, index: 0 }
  const local = async () => ({ uri: 'file:///cache/x', mime: 'image/jpeg', w: 4, h: 4 })
  const big = await prepareAnexo(ref, { source: local, max: 4, encode: async () => ({ bytes: JPEG, mime: 'image/jpeg', width: 4, height: 4 }) })
  t.is(big.status, 'over')
  t.absent(Object.hasOwn(big, 'bytes'))
  const webp = await prepareAnexo(ref, { source: local, encode: async () => ({ bytes: JPEG, mime: 'image/webp', width: 4, height: 4 }) })
  t.is(webp.status, 'over')
  t.is((await prepareAnexo(ref, { source: async () => ({ unavailable: true }), encode: async () => { throw new Error('never') } })).status, 'unavailable')
  t.is((await prepareAnexo(ref, { source: local, encode: async () => { throw new Error('decode') } })).status, 'unavailable')
  t.is((await prepareAnexo(null, { source: local, encode: async () => ({}) })).status, 'unavailable')
  let encoded = 0
  const remote = await prepareAnexo(ref, {
    source: async () => ({ uri: 'https://cdn.example.com/x.jpg', mime: 'image/jpeg', w: 4, h: 4 }),
    encode: async () => { encoded++; return { bytes: JPEG, mime: 'image/jpeg' } }
  })
  t.is(remote.status, 'unavailable', 'a third-party URL is never used')
  t.is(encoded, 0)
  t.is(calls.length, 0, 'nothing fetched')
})

test('anexo POST goes to the installation, with a longer timeout than plain reports', async (t) => {
  const { buildDmReportSend, buildReportSend } = await load()
  const a = buildDmReportSend({ member: M, nonce: NONCE, target: T, reason: 'spam', text: '', quote: '', signature: SIG, anexo: JPEG })
  const b = buildReportSend({ member: M, nonce: NONCE, target: T, seq: 1, writer: W, group: G, reason: 'spam', text: '', quote: '', signature: SIG, anexo: JPEG })
  const plain = buildDmReportSend({ member: M, nonce: NONCE, target: T, reason: 'spam', text: '', quote: 'q', signature: SIG })
  for (const r of [a, b]) {
    t.ok(r.url.endsWith('/account/report/anexo'))
    t.is(r.url, plain.url + '/anexo', 'same installation as every report')
    t.ok(r.timeout > plain.timeout)
    t.ok(r.timeout <= 15000)
  }
})

test('Denunciar drops the decrypted preview in the background and prepares it again on return', (t) => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/screens/Denunciar.js'), 'utf8')
  t.ok(/AppState\.addEventListener\('change'/.test(src), 'listens to the app state')
  t.ok(/state === 'background'\) setAwake\(false\)/.test(src), 'background drops it')
  t.ok(/!awake\)/.test(src) && /member, awake\]\)/.test(src), 'the preparation depends on being awake')
  t.ok(/sub\.remove\(\)/.test(src), 'the listener is removed')
})

// Voice notes: an audio/mp4 item is sent as it is, read from the local copy,
// checked with audioBounds and hashed (statement dm v2 / report v3).

const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))
function box (type, ...parts) {
  const body = parts.flat()
  return [...be32(8 + body.length), ...ascii(type), ...body]
}
function m4a ({ handler = 'soun', ms = 3000 } = {}) {
  const hdlr = box('hdlr', [0, 0, 0, 0], be32(0), ascii(handler), be32(0), be32(0), be32(0), [0])
  const minf = box('minf', box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))), box('stbl', box('stsd', [0, 0, 0, 0], be32(1), box('mp4a', new Array(28).fill(0), box('esds', [0, 0, 0, 0], [3, 25, 0, 1, 0, 4, 17, 64, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2, 18, 16, 6, 1, 2]))), box('stts', [0, 0, 0, 0], be32(1), be32(ms), be32(1)), box('stsz', [0, 0, 0, 0], be32(1), be32(ms)), box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(ms), be32(1)), box('stco', [0, 0, 0, 0], be32(1), be32(0))))
  const trak = box('trak', box('tkhd', new Array(84).fill(0)), box('mdia', box('mdhd', new Array(12).fill(0), be32(1000), be32(0), [0, 0, 0, 0]), hdlr, minf))
  const mvhd = box('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(ms), new Array(80).fill(0))
  return new Uint8Array([...box('ftyp', ascii('M4A '), be32(0), ascii('M4A '), ascii('isom')), ...box('moov', mvhd, trak), ...box('mdat', new Array(ms + 4).fill(1))])
}
const M4A = m4a()
const DM_VOICE = { kind: 'dm', from: T, id: ID, index: 0, item: { id: 'v', mime: 'audio/mp4', w: 0, h: 0, ms: 3000 } }
const GROUP_VOICE = { kind: 'group', diary: T, item: { core: W, start: 0, blocks: 1, sha256: 'aa'.repeat(32), key: 'k', nonce: 'n', plainMime: 'audio/mp4', ms: 3000 } }
const neverEncode = async () => { throw new Error('a voice note is never re-encoded') }

test('anexoRef picks a voice note like an image', async (t) => {
  const { anexoRef, isAudioItem } = await load()
  t.alike(anexoRef({ dm: true, id: ID, author: T, text: '', media: [DM_VOICE.item] }), DM_VOICE)
  t.alike(anexoRef({ author: T, seq: 3, text: '', group: G, writer: W, private: true, media: [GROUP_VOICE.item] }), GROUP_VOICE)
  t.ok(isAudioItem(DM_VOICE.item))
  t.ok(isAudioItem(GROUP_VOICE.item))
  t.absent(isAudioItem({ mime: 'image/jpeg' }))
  t.absent(isAudioItem({ plainMime: 'image/jpeg', mime: 'audio/mp4' }), 'plainMime decides for a sealed item')
})

test('prepareAnexo: a voice note is read as it is, bounded and hashed', async (t) => {
  const { prepareAnexo } = await load()
  const calls = stub(t, json(500, {}))
  for (const ref of [DM_VOICE, GROUP_VOICE]) {
    const read = []
    const out = await prepareAnexo(ref, {
      source: async () => ({ uri: 'blob:local/v', mime: 'audio/mp4', w: 0, h: 0, ms: 3000 }),
      encode: neverEncode,
      readBytes: async (uri) => { read.push(uri); return M4A }
    })
    t.alike(read, ['blob:local/v'])
    t.is(out.status, 'ok')
    t.is(out.kind, 'audio')
    t.is(out.mime, 'audio/mp4')
    t.is(out.ms, 3000)
    t.is(out.uri, 'blob:local/v')
    t.alike(out.bytes, M4A, 'the exact bytes, not re-encoded')
    t.is(out.digest, sha256Hex(M4A))
  }
  t.is(calls.length, 0, 'nothing fetched')
})

test('prepareAnexo: a voice note over the cap, unreadable, not audio only, or remote', async (t) => {
  const { prepareAnexo, ANEXO_AUDIO_TOO_BIG, ANEXO_MAX_BYTES } = await load()
  const calls = stub(t, json(500, {}))
  const local = async () => ({ uri: 'file:///cache/v.m4a', mime: 'audio/mp4', w: 0, h: 0 })
  t.is(ANEXO_AUDIO_TOO_BIG, 'O áudio não coube e não foi enviado.')

  let bounded = 0
  const big = await prepareAnexo(DM_VOICE, { source: local, encode: neverEncode, max: M4A.byteLength - 1, readBytes: async () => M4A, audioBounds: () => { bounded++; return { ms: 1 } } })
  t.alike(big, { status: 'over', kind: 'audio', uri: 'file:///cache/v.m4a' })
  t.is(bounded, 0, 'a file over the cap is never walked')
  const huge = new Uint8Array(ANEXO_MAX_BYTES + 1)
  huge.set(M4A)
  t.is((await prepareAnexo(DM_VOICE, { source: local, encode: neverEncode, readBytes: async () => huge })).status, 'over', 'the default cap is 700 KB')

  const video = await prepareAnexo(DM_VOICE, { source: local, encode: neverEncode, readBytes: async () => m4a({ handler: 'vide' }) })
  t.alike(video, { status: 'unavailable', kind: 'audio' }, 'a video track is refused')
  t.is((await prepareAnexo(DM_VOICE, { source: local, encode: neverEncode, readBytes: async () => m4a({ ms: 120001 }) })).status, 'unavailable', 'too long')
  t.is((await prepareAnexo(DM_VOICE, { source: local, encode: neverEncode, readBytes: async () => { throw new Error('gone') } })).status, 'unavailable')
  t.is((await prepareAnexo(DM_VOICE, { source: local, encode: neverEncode, readBytes: async () => new Uint8Array(0) })).status, 'unavailable')
  t.is((await prepareAnexo(DM_VOICE, { source: local, encode: neverEncode })).status, 'unavailable', 'no reader')
  t.is((await prepareAnexo(DM_VOICE, { source: async () => ({ unavailable: true }), encode: neverEncode, readBytes: async () => M4A })).status, 'unavailable')
  t.is((await prepareAnexo(DM_VOICE, { source: async () => ({ uri: 'blob:x', mime: 'image/jpeg', w: 4, h: 4 }), encode: neverEncode, readBytes: async () => M4A })).status, 'unavailable', 'the source must agree it is audio')

  let readCount = 0
  const remote = await prepareAnexo(DM_VOICE, {
    source: async () => ({ uri: 'https://cdn.example.com/v.m4a', mime: 'audio/mp4', w: 0, h: 0 }),
    encode: neverEncode,
    readBytes: async () => { readCount++; return M4A }
  })
  t.alike(remote, { status: 'unavailable', kind: 'audio' }, 'a third-party URL is never used')
  t.is(readCount, 0)
  t.is(calls.length, 0, 'nothing fetched')
})

test('dm report with a voice note: dm v2 verifies over the received bytes', async (t) => {
  const { prepareAnexo, submitDmReport } = await load()
  const prepared = await prepareAnexo(DM_VOICE, { source: async () => ({ uri: 'blob:local/v', mime: 'audio/mp4' }), encode: neverEncode, readBytes: async () => M4A })
  const calls = flowStub(t)
  const kp = require('hypercore-crypto').keyPair()
  const member = kp.publicKey.toString('hex')
  let params = null
  await submitDmReport({
    member,
    target: T,
    reason: 'assedio',
    text: '',
    quote: '',
    anexo: { bytes: prepared.bytes, digest: prepared.digest },
    sign: async (p) => {
      params = p
      return { signature: core.signDmReport({ ...p, member, association: M }, kp) }
    },
    isStale: () => false
  })
  t.alike(params, { nonce: NONCE, target: T, reason: 'assedio', text: '', quote: '', anexo: sha256Hex(M4A) })
  t.ok(calls[1].url.endsWith('/account/report/anexo'))
  const body = JSON.parse(calls[1].init.body)
  const received = Buffer.from(body.anexo, 'base64')
  t.alike(new Uint8Array(received), M4A, 'the exact audio bytes travel')
  const fields = { nonce: body.nonce, member, association: M, target: body.target, reason: body.reason, text: body.text, quote: body.quote, anexo: sha256Hex(received) }
  t.ok(core.verifyDmReport(fields, body.signature).ok)
})

test('private group report with a voice note: report v3 verifies over the received bytes', async (t) => {
  const { prepareAnexo, submitReport } = await load()
  const prepared = await prepareAnexo(GROUP_VOICE, { source: async () => ({ uri: 'file:///cache/v.m4a', mime: 'audio/mp4' }), encode: neverEncode, readBytes: async () => M4A })
  const calls = flowStub(t)
  const kp = require('hypercore-crypto').keyPair()
  const member = kp.publicKey.toString('hex')
  let params = null
  await submitReport({
    member,
    target: T,
    seq: 9,
    writer: W,
    group: G,
    reason: 'ilegal',
    text: 'nota',
    quote: '',
    anexo: { bytes: prepared.bytes, digest: prepared.digest },
    sign: async (p) => {
      params = p
      return { signature: core.signReport({ ...p, member, association: M }, kp) }
    },
    isStale: () => false
  })
  t.is(params.anexo, sha256Hex(M4A))
  t.ok(calls[1].url.endsWith('/account/report/anexo'))
  const body = JSON.parse(calls[1].init.body)
  const received = Buffer.from(body.anexo, 'base64')
  t.alike(new Uint8Array(received), M4A)
  const fields = { nonce: body.nonce, member, association: M, target: body.target, seq: body.seq, writer: body.writer, group: body.group, reason: body.reason, text: body.text, quote: body.quote, anexo: sha256Hex(received) }
  t.ok(core.verifyReport(fields, body.signature).ok)
})

test('Denunciar plays a voice note and says it goes open to moderation', async (t) => {
  const { ANEXO_AUDIO_NOTICE } = await load()
  t.is(ANEXO_AUDIO_NOTICE, 'O áudio vai para a moderação, aberto.')
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/screens/Denunciar.js'), 'utf8')
  t.ok(/<VoiceBubble state='ok' uri=\{anexo\.uri\}/.test(src), 'plays the local copy that is sent')
  t.ok(/anexo\.status === 'ok' && anexo\.kind === 'audio'/.test(src), 'only once prepared, so a background drop unmounts the player')
  t.ok(/readBytes: readReportAudio/.test(src), 'reads through the platform reader')
})

// Feira listing reports (kind 'listing', docs/rpc.md 5.20): the diary-post
// body plus kind, signed under varanda-listing-report-v1.

test('listingTarget keeps the root seq and refuses anything else', async (t) => {
  const { listingTarget } = await load()
  t.alike(listingTarget({ kind: 'listing', author: T, seq: 7, editSeq: 12, title: 'Bolo' }), { author: T, seq: 7, title: 'Bolo' }, 'an edit seq is never used')
  t.alike(listingTarget({ kind: 'listing', author: T, seq: 7 }), { author: T, seq: 7, title: '' })
  t.is(listingTarget(null), null)
  t.is(listingTarget({ author: T, seq: 7 }), null, 'a diary post is not a listing')
  t.is(listingTarget({ kind: 'listing', author: 'xy', seq: 7 }), null)
  t.is(listingTarget({ kind: 'listing', author: T, seq: 0 }), null)
  t.is(listingTarget({ kind: 'listing', author: T, seq: '7' }), null)
  t.is(listingTarget({ kind: 'listing', author: T, seq: null }), null)
})

test('listing report: report.sign kind listing and the exact POST body, verified as the server checks it', async (t) => {
  const { submitListingReport } = await load()
  const calls = flowStub(t)
  const keyPair = require('hypercore-crypto').keyPair()
  const member = keyPair.publicKey.toString('hex')
  const association = '78'.repeat(32)
  let params = null
  const out = await submitListingReport({
    member,
    target: T,
    seq: 7,
    reason: 'ilegal',
    text: 'nota',
    quote: 'Bolo ' + LONE,
    sign: async (p) => {
      params = p
      const { kind, ...rest } = p
      return { signature: core.signListingReport({ ...rest, member, association }, keyPair) }
    },
    isStale: () => false
  })
  t.alike(out, { id: 'r1', duplicate: false })
  t.alike(params, { kind: 'listing', nonce: NONCE, target: T, seq: 7, reason: 'ilegal', text: 'nota', quote: 'Bolo ' + FFFD })
  t.is(calls.length, 2, 'one nonce, one POST')
  t.alike(JSON.parse(calls[0].init.body), { member })
  t.ok(calls[1].url.endsWith('/account/report'))
  t.absent(calls[1].url.endsWith('/anexo'))
  const body = JSON.parse(calls[1].init.body)
  t.alike(Object.keys(body).sort(), ['kind', 'member', 'nonce', 'quote', 'reason', 'seq', 'signature', 'target', 'text'])
  t.alike(body, { kind: 'listing', member, nonce: NONCE, target: T, seq: 7, reason: 'ilegal', text: 'nota', quote: 'Bolo ' + FFFD, signature: body.signature })
  for (const k of ['writer', 'group', 'anexo', 'peer']) t.absent(Object.hasOwn(body, k), 'no ' + k)
  const fields = { nonce: body.nonce, member: body.member, association, target: body.target, seq: body.seq, reason: body.reason, text: body.text, quote: body.quote }
  t.ok(core.verifyListingReport(fields, body.signature).ok, 'the listing statement verifies')
  t.absent(core.verifyReport(fields, body.signature).ok, 'never as a diary post report')
})

test('listing report: every existing reason is accepted', async (t) => {
  const { REASONS, listingReportParams } = await load()
  for (const [id] of REASONS) {
    t.is(listingReportParams({ nonce: NONCE, target: T, seq: 1, reason: id, text: '', quote: '' }).reason, id)
  }
})

test('listing report: stale stops before signing; a failed POST is not retried', async (t) => {
  const { submitListingReport } = await load()
  let signed = 0
  const sign = async () => { signed++; return { signature: SIG } }
  const base = { member: M, target: T, seq: 7, reason: 'spam', text: '', quote: 'q' }
  const a = flowStub(t)
  t.is(await submitListingReport({ ...base, sign, isStale: () => true }), null)
  t.is(signed, 0)
  t.is(a.length, 1)
  const b = flowStub(t, { failSend: true })
  await t.exception(submitListingReport({ ...base, sign, isStale: () => false }))
  t.is(b.length, 2, 'one nonce, one POST')
})

test('listing reports leave every existing body byte for byte', async (t) => {
  const { buildReportSend, buildDmReportSend } = await load()
  const post = { member: M, nonce: NONCE, target: T, seq: 4, reason: 'spam', text: 'x', quote: 'q', signature: SIG }
  t.is(buildReportSend(post).init.body, JSON.stringify(post))
  const account = { ...post, seq: null, quote: '' }
  t.is(buildReportSend(account).init.body, JSON.stringify(account))
  const group = { member: M, nonce: NONCE, target: T, seq: 4, reason: 'spam', text: 'x', quote: 'q', signature: SIG, writer: W, group: G }
  t.is(buildReportSend({ ...post, writer: W, group: G }).init.body, JSON.stringify(group))
  const dm = { kind: 'dm', member: M, nonce: NONCE, target: T, reason: 'spam', text: 'x', quote: 'q', signature: SIG }
  t.is(buildDmReportSend({ member: M, nonce: NONCE, target: T, reason: 'spam', text: 'x', quote: 'q', signature: SIG }).init.body, JSON.stringify(dm))
})

test('Denunciar reports a listing through the pure module with a fixed seq', (t) => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/screens/Denunciar.js'), 'utf8')
  t.ok(/submitListingReport\(\{/.test(src), 'uses the listing submit')
  t.ok(/setListing\(open \? listingTarget\(target\) : null\)/.test(src), 'the listing is taken from the pure module when the sheet opens')
  t.ok(/\[open, listingAuthor\]\)/.test(src), 'a new seq for the same listing does not move it')
  t.ok(/seq: listing\.seq/.test(src), 'the frozen seq is reported')
  t.ok(/'Denunciar anúncio'/.test(src))
  t.ok(/displayText\(quote, \{ multiline: true \}\)/.test(src), 'the title shows through displayText')
})

test('Denunciar: reasons are radio rows, the privacy caption stays and the submit sits below the scroll', (t) => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/screens/Denunciar.js'), 'utf8')
  t.ok(src.includes("<View style={styles.reasons} accessibilityRole='radiogroup' accessibilityLabel='Motivo da denúncia'>"), 'the reasons form one named radio group')
  t.ok(src.includes('{REASONS.map(([id, label], i) => (\n            <ReasonRow key={id} label={label} first={i === 0} checked={reason === id} onPress={() => setReason(id)} />'), 'same ids and labels, one row each')
  const row = src.slice(src.indexOf('function ReasonRow'), src.indexOf('const makeStyles'))
  t.ok(row.includes("accessibilityRole='radio'") && row.includes('accessibilityState={{ checked }}') && row.includes('aria-checked={checked}'), 'each row is a checked radio')
  t.ok(row.includes("{checked ? <Icon name='ok'"), 'a check marks the selected reason')
  t.ok(row.includes("e.key !== ' '") && row.includes('e.preventDefault()'), 'Space selects on the web')
  t.ok(src.includes('<HelpNote doc={HELP.denuncia}><Soft>{SHORT.reportPrivacy}</Soft></HelpNote>'), 'the privacy sentence stays visible')
  t.is(src.split("label='enviar denúncia'").length - 1, 1, 'one submit button')
  t.ok(/<Btn\n\s+label='enviar denúncia'\n\s+onPress=\{submit\}\n\s+pending=\{send\.pending\}/.test(src), 'the submit runs once per press through useAction')
  const sheet = src.slice(src.indexOf("<Sheet open={open} onClose={onClose} title='Denunciar'>"))
  t.ok(sheet.indexOf('</ScrollView>') < sheet.indexOf('{footer}'), 'the submit is outside the scroll, at the bottom')
  t.ok(src.includes("import { KeyboardForm } from './Perfil'"), 'the shared keyboard form')
  t.ok(/<KeyboardForm>\s*<ScrollView[^>]*>\s*\{body\}\s*<\/ScrollView>\s*\{footer\}\s*<\/KeyboardForm>\s*<\/Sheet>/.test(sheet), 'the keyboard lifts the submit and its error')
  const footer = src.slice(src.indexOf('footer = ('), src.indexOf('return (\n    <Sheet'))
  t.ok(footer.includes('<ErrorText>{send.error}</ErrorText>') && footer.includes("label='enviar denúncia'"), 'the error shows next to the submit')
  t.is(src.split('send.run(').length - 1, 1, 'one send path, never a resend')
})
