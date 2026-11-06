'use strict'

// The account helpers (src/account.js). ES module loaded through import();
// fetch is stubbed, nothing touches the network.
const test = require('brittle')

const load = () => import('../src/account.js')
const M = 'ab'.repeat(32)

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

test('isUsername normalizes and rejects', async (t) => {
  const { isUsername } = await load()
  t.is(isUsername('@Ana_01'), 'ana_01')
  t.is(isUsername('ana'), 'ana')
  for (const bad of ['@@ana', 'an', '1ana', 'ana-b', 'a'.repeat(21), 'e905a4', '@E905A4', '', null, 5]) {
    t.is(isUsername(bad), null, String(bad))
  }
  t.is(isUsername('a'.repeat(20)), 'a'.repeat(20))
})

test('parseReturn maps the three outcomes', async (t) => {
  const { parseReturn } = await load()
  t.is(parseReturn('?conta=ok'), 'conta vinculada')
  t.is(parseReturn('?conta=erro'), 'não foi possível vincular a conta')
  t.is(parseReturn('?x=1&conta=cancelado'), 'vínculo cancelado')
  t.is(parseReturn('?conta=outro'), null)
  t.is(parseReturn('?conta=toString'), null)
  t.is(parseReturn(''), null)
  t.is(parseReturn(undefined), null)
  t.is(parseReturn('?conta=lista-de-espera'), null, 'the waitlist is not a return notice')
})

test('parseReturnWaitlist: ?conta=lista-de-espera is the calm waitlist sentence', async (t) => {
  const { parseReturnWaitlist, toError } = await load()
  t.is(parseReturnWaitlist('?conta=lista-de-espera'), toError('lista-de-espera').message, 'the same sentence as a 503')
  t.is(parseReturnWaitlist('?x=1&conta=lista-de-espera'), toError('lista-de-espera').message)
  t.is(parseReturnWaitlist('?conta=ok'), '')
  t.is(parseReturnWaitlist('?conta=outro'), '')
  t.is(parseReturnWaitlist(''), '')
  t.is(parseReturnWaitlist(undefined), '')
})

test('usernameMatches', async (t) => {
  const { usernameMatches } = await load()
  t.ok(usernameMatches({ member: M, username: 'ana' }, M, 'ana'))
  t.not(usernameMatches({ member: M, username: 'ana' }, M, 'bia'), 'other name')
  t.not(usernameMatches({ member: 'cd', username: 'ana' }, M, 'ana'), 'other member')
  t.not(usernameMatches(null, M, 'ana'))
  t.not(usernameMatches([], M, 'ana'))
})

test('formatNextChange is DD/MM/AAAA in local time', async (t) => {
  const { formatNextChange } = await load()
  const d = new Date(2026, 10, 3, 12)
  t.is(formatNextChange(d.toISOString()), '03/11/2026')
  t.is(formatNextChange('lixo'), '')
  t.is(formatNextChange(null), '')
})

test('error mapper uses fixed messages and never a raw body', async (t) => {
  const { toError } = await load()
  t.is(toError('nome-em-uso').message, 'esse nome já está em uso')
  t.is(toError('nome-invalido').message, 'nome inválido')
  t.is(toError('conta-vinculada').message, 'esta conta Google já está vinculada a outra chave')
  t.is(toError('assinatura-invalida').message, 'não foi possível provar a chave')
  t.is(toError('expirado').message, 'o vínculo expirou, comece de novo')
  const waiting = toError('lista-de-espera')
  t.is(waiting.message, 'A Varanda está cheia por enquanto. Esta tentativa não criou conta nem lugar em fila; volte daqui a alguns dias para tentar de novo. Quem já entrou continua usando a rede normalmente.')
  t.is(waiting.code, 'lista-de-espera')
  const other = toError('<html>secret@example.com</html>')
  t.is(other.message, 'serviço indisponível')
  t.is(other.code, 'indisponivel')
  const d = new Date(2026, 10, 3, 12)
  const lock = toError('troca-bloqueada', d.toISOString())
  t.is(lock.code, 'troca-bloqueada')
  t.is(lock.message, 'você poderá trocar de novo em 03/11/2026')
  t.is(lock.nextChangeAt, d.toISOString())
})

test('request builders: URL, method, headers, body', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { ok: 1 }))
  await a.accountStatus(M)
  await a.startLink({ member: M, username: 'ana' })
  await a.authorizeLink({ signature: 'ff' })
  await a.finishLink({ signature: 'ff' })
  await a.renameStart({ member: M, username: 'bia' })
  await a.renameFinish({ member: M, nonce: 'n', signature: 'ff' })
  await a.lookupUsername('a b')
  t.alike(calls.map(c => c.init.method + ' ' + c.url), [
    'GET /account/status?member=' + M,
    'POST /account/start',
    'POST /account/authorize',
    'POST /account/finish',
    'POST /account/rename/start',
    'POST /account/rename/finish',
    'GET /account/username/a%20b'
  ])
  for (const c of calls) {
    t.is(c.init.credentials, 'same-origin')
    t.is(c.init.cache, 'no-store')
    t.ok(c.init.signal)
  }
  t.is(calls[0].init.body, undefined)
  t.is(calls[1].init.headers['content-type'], 'application/json')
  t.alike(JSON.parse(calls[1].init.body), { member: M, username: 'ana' })
  t.alike(JSON.parse(calls[5].init.body), { member: M, nonce: 'n', signature: 'ff' })
})

test('lookupUsername: absolute only with an https account origin', async (t) => {
  const a = await load()
  const calls = stub(t, json(404, { error: 'nao-encontrado' }))
  t.is(await a.lookupUsername('ana', { origin: 'https://contas.example.test' }), null)
  await a.lookupUsername('ana', {})
  await a.lookupUsername('ana', { origin: undefined })
  await a.lookupUsername('ana', { origin: 'http://contas.example.test' })
  t.alike(calls.map(c => c.url), [
    'https://contas.example.test/account/username/ana',
    '/account/username/ana',
    '/account/username/ana',
    '/account/username/ana'
  ])
})

test('404 gives null for pending and lookup, an error elsewhere', async (t) => {
  const a = await load()
  stub(t, json(404, { error: 'nao-encontrado' }))
  t.is(await a.readPending(), null)
  t.is(await a.lookupUsername('ana'), null)
  // The pending route answers "no pending link" with a 404 expirado: still null.
  stub(t, json(404, { error: 'expirado' }))
  t.is(await a.readPending(), null)
  await t.exception(a.accountStatus(M))
})

test('error tokens become coded errors; bad bodies are ignored', async (t) => {
  const a = await load()
  stub(t, json(409, { error: 'nome-em-uso' }))
  try { await a.startLink({ member: M, username: 'ana' }); t.fail() } catch (e) { t.is(e.code, 'nome-em-uso') }
  stub(t, json(500, { error: 'nome-em-uso' }, 'text/html'))
  try { await a.startLink({ member: M, username: 'ana' }); t.fail() } catch (e) { t.is(e.message, 'serviço indisponível') }
  stub(t, json(200, { pad: 'x'.repeat(5000) }))
  await t.exception(a.accountStatus(M), 'oversized body refused')
  stub(t, () => { throw new Error('rede') })
  try { await a.accountStatus(M); t.fail() } catch (e) { t.is(e.message, 'serviço indisponível') }
})

test('termsStart/termsFinish: same-origin no-store POSTs with exactly those keys', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { nonce: 'n1', version: 2, acceptedAt: '2026-10-27T12:00:00.000Z' }))
  t.alike(await a.termsStart({ member: M, version: 2 }), { nonce: 'n1' })
  t.alike(await a.termsFinish({ member: M, nonce: 'n1', signature: 'ff' }), { version: 2, acceptedAt: '2026-10-27T12:00:00.000Z' })
  t.alike(calls.map(c => c.init.method + ' ' + c.url), ['POST /account/terms/start', 'POST /account/terms/finish'])
  for (const c of calls) {
    t.is(c.init.credentials, 'same-origin')
    t.is(c.init.cache, 'no-store')
    t.is(c.init.headers['content-type'], 'application/json')
    t.ok(c.init.signal)
  }
  t.alike(JSON.parse(calls[0].init.body), { member: M, version: 2 })
  t.alike(JSON.parse(calls[1].init.body), { member: M, nonce: 'n1', signature: 'ff' })
})

test('termsStart/termsFinish: nao-vinculado and unexpected bodies', async (t) => {
  const a = await load()
  stub(t, json(403, { error: 'nao-vinculado' }))
  try { await a.termsStart({ member: M, version: 1 }); t.fail() } catch (e) {
    t.is(e.code, 'nao-vinculado')
    t.is(e.message, 'esta conta não tem vínculo com uma conta Google')
  }
  try { await a.termsFinish({ member: M, nonce: 'n', signature: 'ff' }); t.fail() } catch (e) { t.is(e.code, 'nao-vinculado') }
  stub(t, json(200, { nonce: 5 }))
  try { await a.termsStart({ member: M, version: 1 }); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
  stub(t, json(200, { version: '1', acceptedAt: '2026-10-27T12:00:00.000Z' }))
  try { await a.termsFinish({ member: M, nonce: 'n', signature: 'ff' }); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
  stub(t, json(200, { version: 1.5, acceptedAt: 'x' }))
  try { await a.termsFinish({ member: M, nonce: 'n', signature: 'ff' }); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
  stub(t, json(200, { version: 1, acceptedAt: null }))
  try { await a.termsFinish({ member: M, nonce: 'n', signature: 'ff' }); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
})

// A valid uncompressed P-256 point: 0x04 then 64 bytes, unpadded base64url.
const VAPID = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url')
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'p', auth: 'a' }

test('pushKey: the key, or null on 503, a bad shape or no answer', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { key: VAPID }))
  t.is(await a.pushKey(), VAPID)
  t.is(calls[0].init.method + ' ' + calls[0].url, 'GET /account/push/key')
  t.is(calls[0].init.cache, 'no-store')
  stub(t, json(503, { error: 'indisponivel' }))
  t.is(await a.pushKey(), null, '503')
  for (const bad of [VAPID + '=', VAPID.slice(1), 'A' + VAPID.slice(1), 5, null, '']) {
    stub(t, json(200, { key: bad }))
    t.is(await a.pushKey(), null, 'shape ' + String(bad).slice(0, 8))
  }
  stub(t, json(200, { key: VAPID }, 'text/html'))
  t.is(await a.pushKey(), null, 'not JSON')
  stub(t, () => { throw new Error('rede') })
  t.is(await a.pushKey(), null, 'transport')
})

test('pushStart/pushFinish/pushCheck: same-origin POSTs with exactly those keys', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { nonce: 'n1', ok: true, changed: true, registered: true }))
  t.alike(await a.pushStart({ member: M, action: 'on' }), { nonce: 'n1' })
  t.alike(await a.pushFinish({ member: M, nonce: 'n1', action: 'on', signature: 'ff', ...SUB }), { ok: true, changed: true })
  t.alike(await a.pushCheck({ member: M, ...SUB }), { registered: true })
  t.alike(calls.map(c => c.init.method + ' ' + c.url), ['POST /account/push/start', 'POST /account/push/finish', 'POST /account/push/check'])
  for (const c of calls) {
    t.is(c.init.credentials, 'same-origin')
    t.is(c.init.cache, 'no-store')
    t.is(c.init.headers['content-type'], 'application/json')
    t.ok(c.init.signal)
  }
  t.alike(JSON.parse(calls[0].init.body), { member: M, action: 'on' })
  t.alike(JSON.parse(calls[1].init.body), { member: M, nonce: 'n1', action: 'on', signature: 'ff', ...SUB })
  t.alike(JSON.parse(calls[2].init.body), { member: M, ...SUB })
  t.alike(Object.keys(JSON.parse(calls[2].init.body)), ['member', 'endpoint', 'p256dh', 'auth'])
})

test('push error tokens: refusals are definite, start never uncertain', async (t) => {
  const a = await load()
  const finish = () => a.pushFinish({ member: M, nonce: 'n', action: 'on', signature: 'ff', ...SUB })
  for (const [status, token] of [[400, 'expirado'], [400, 'assinatura-invalida'], [403, 'termos-pendentes'], [400, 'pedido-invalido'], [403, 'nao-vinculado']]) {
    stub(t, json(status, { error: token }))
    try { await finish(); t.fail() } catch (e) {
      t.is(e.code, token)
      t.absent(e.uncertain, token + ' is a refusal')
    }
  }
  stub(t, json(400, { error: '<b>x</b>' }))
  try { await finish(); t.fail() } catch (e) {
    t.is(e.message, 'serviço indisponível')
    t.absent(e.uncertain)
  }
  stub(t, () => { throw new Error('rede') })
  try { await a.pushStart({ member: M, action: 'on' }); t.fail() } catch (e) {
    t.is(e.code, 'indisponivel')
    t.absent(e.uncertain, 'start changes nothing')
  }
  stub(t, json(200, { nonce: 7 }))
  try { await a.pushStart({ member: M, action: 'off' }); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
})

test('pushFinish: no answer, a 5xx or an unreadable success is uncertain', async (t) => {
  const a = await load()
  const finish = () => a.pushFinish({ member: M, nonce: 'n', action: 'off', signature: 'ff', ...SUB })
  const cases = [
    ['transport', () => { throw new Error('rede') }],
    ['5xx', json(502, {}, 'text/html')],
    ['5xx token', json(503, { error: 'indisponivel' })],
    ['bad body', json(200, { ok: 1 })],
    ['not JSON', json(200, { ok: true, changed: true }, 'text/plain')]
  ]
  for (const [name, res] of cases) {
    const calls = stub(t, res)
    try { await finish(); t.fail() } catch (e) {
      t.is(e.code, 'indisponivel', name)
      t.is(e.uncertain, true, name)
    }
    t.is(calls.length, 1, name + ': sent once, never retried')
  }
})

test('pushCheck: null on any failure or shape', async (t) => {
  const a = await load()
  stub(t, json(200, { registered: false }))
  t.alike(await a.pushCheck({ member: M, ...SUB }), { registered: false })
  for (const res of [json(200, { registered: 'yes' }), json(429, { error: 'limite' }), () => { throw new Error('rede') }]) {
    stub(t, res)
    t.is(await a.pushCheck({ member: M, ...SUB }), null)
  }
})

const CODE = 'Q'.repeat(43)
const ISO = '2026-11-02T03:00:00.000Z'

test('invite error tokens and parseReturnInvite', async (t) => {
  const { toError, parseReturn, parseReturnInvite } = await load()
  t.is(toError('convite-obrigatorio').code, 'convite-obrigatorio')
  t.is(toError('convite-obrigatorio').message, 'Para entrar, abra o link de convite que alguém da rede te enviou. Nada sobre você fica guardado enquanto o convite não for usado.')
  t.is(toError('convite-invalido').message, 'Este convite não vale mais: já foi usado, venceu ou não existe. Peça outro link para quem te convidou.')
  t.is(toError('limite-convites').message, 'Você já criou os convites desta semana. Na segunda-feira volta a contar.')
  t.is(toError('convite-aguardando').code, 'convite-aguardando')
  t.is(toError('convite-aguardando').message, 'Seu convite desta semana ainda não chegou. Ele aparece de surpresa, com um aviso.')
  t.is(parseReturn('?conta=convite-invalido'), null, 'not a return notice')
  t.is(parseReturnInvite('?conta=convite-invalido'), toError('convite-invalido').message)
  t.is(parseReturnInvite('?x=1&conta=convite-invalido'), toError('convite-invalido').message)
  t.is(parseReturnInvite('?conta=lista-de-espera'), '')
  t.is(parseReturnInvite('?conta=ok'), '')
  t.is(parseReturnInvite(''), '')
  t.is(parseReturnInvite(undefined), '')
})

test('startLink adds the invite only when it is a well-formed code', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { ok: 1 }))
  await a.startLink({ member: M, username: 'ana' })
  await a.startLink({ member: M, username: 'ana', invite: null })
  await a.startLink({ member: M, username: 'ana', invite: 'abc' })
  await a.startLink({ member: M, username: 'ana', invite: CODE })
  t.is(calls[0].init.body, JSON.stringify({ member: M, username: 'ana' }))
  t.is(calls[1].init.body, JSON.stringify({ member: M, username: 'ana' }))
  t.is(calls[2].init.body, JSON.stringify({ member: M, username: 'ana' }))
  t.alike(JSON.parse(calls[3].init.body), { member: M, username: 'ana', invite: CODE })
})

test('invitePolicy: the two shapes, null on 404, anything else refused', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { required: false }))
  t.alike(await a.invitePolicy(), { required: false })
  t.is(calls[0].init.method + ' ' + calls[0].url, 'GET /account/invites/policy')
  t.is(calls[0].init.body, undefined)
  stub(t, json(200, { required: true, perWeek: 5 }))
  t.alike(await a.invitePolicy(), { required: true, perWeek: 5 })
  stub(t, json(200, { required: true, perWeek: 100 }))
  t.alike(await a.invitePolicy(), { required: true, perWeek: 100 })
  stub(t, json(404, { error: 'nao-encontrado' }))
  t.is(await a.invitePolicy(), null)
  const bad = [
    { required: false, extra: 1 }, { required: false, perWeek: 5 }, { required: true }, { required: true, perWeek: 0 },
    { required: true, perWeek: 101 }, { required: true, perWeek: 2.5 }, { required: true, perWeek: '5' },
    { required: true, perWeek: 5, x: 1 }, { required: 'true', perWeek: 5 }, {}, [],
    { required: true, perWeek: 5, mode: 'sorteio' }
  ]
  for (const body of bad) {
    stub(t, json(200, body))
    try { await a.invitePolicy(); t.fail(JSON.stringify(body)) } catch (e) { t.is(e.code, 'indisponivel', JSON.stringify(body)) }
  }
})

test('invitesSummary: the exact shape, request and older service fallback', async (t) => {
  const a = await load()
  const args = { member: M, nonce: 'n1', signature: 'ff' }
  const summary = { mode: 'sorteio', perWeek: 5, opened: 2, used: 1, remaining: 1, resetsAt: ISO }
  const calls = stub(t, json(200, summary))
  t.alike(await a.invitesSummary(args), summary)
  t.is(calls.length, 1)
  t.is(calls[0].init.method + ' ' + calls[0].url, 'POST /account/invites/summary')
  t.alike(JSON.parse(calls[0].init.body), args)
  t.is(calls[0].init.credentials, 'same-origin')
  t.is(calls[0].init.cache, 'no-store')
  for (const body of [
    { ...summary, mode: 'semanal', opened: 5, remaining: 4 },
    { ...summary, opened: 0, used: 0, remaining: 0 },
    { ...summary, perWeek: 1, opened: 1, used: 0 },
    { ...summary, perWeek: 100, opened: 100, used: 99 },
    { ...summary, used: 6, remaining: 0 },
    { ...summary, used: Number.MAX_SAFE_INTEGER, remaining: 0 }
  ]) {
    stub(t, json(200, body))
    t.alike(await a.invitesSummary(args), body)
  }
  stub(t, json(404, { error: 'nao-encontrado' }))
  t.is(await a.invitesSummary(args), null)
  // An expired nonce is a 404 too, but a refusal, never "older service".
  stub(t, json(404, { error: 'expirado' }))
  try { await a.invitesSummary(args); t.fail('expirado must throw') } catch (e) { t.is(e.code, 'expirado') }
  // The weekly mode always opens the whole allowance.
  stub(t, json(200, { ...summary, mode: 'semanal', opened: 2, used: 1, remaining: 1 }))
  try { await a.invitesSummary(args); t.fail('semanal with opened below perWeek') } catch (e) { t.is(e.code, 'indisponivel') }
})

test('invitesSummary: malformed summaries are unavailable and failures are never retried', async (t) => {
  const a = await load()
  const args = { member: M, nonce: 'n1', signature: 'ff' }
  const summary = { mode: 'sorteio', perWeek: 5, opened: 2, used: 1, remaining: 1, resetsAt: ISO }
  const bad = [null, [], {}, { ...summary, extra: 1 }]
  for (const key of Object.keys(summary)) {
    const body = { ...summary }
    delete body[key]
    bad.push(body)
  }
  for (const [key, values] of Object.entries({
    mode: ['x', null],
    perWeek: [0, 101, 1.5, '5', null],
    opened: [-1, 6, 1.5, '2', null],
    used: [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1],
    remaining: [-1, 0, 3, 1.5, '1', null],
    resetsAt: [null, 'tomorrow', '2026-11-02T03:00:00Z', '2026-11-02T03:00:00.0Z', '2026-02-30T03:00:00.000Z', '2026-11-02T00:00:00.000-03:00']
  })) {
    for (const value of values) bad.push({ ...summary, [key]: value })
  }
  for (const body of bad) {
    stub(t, json(200, body))
    try { await a.invitesSummary(args); t.fail(JSON.stringify(body)) } catch (e) {
      t.is(e.code, 'indisponivel', JSON.stringify(body))
      t.is(e.message, 'serviço indisponível')
    }
  }
  for (const res of [json(503, { error: 'indisponivel' }), () => { throw new Error('network') }]) {
    const calls = stub(t, res)
    try { await a.invitesSummary(args); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
    t.is(calls.length, 1, 'never retried')
  }
})

test('invitesStart/invitesFinish: shapes and refusals', async (t) => {
  const a = await load()
  const ok = { code: CODE, expiresAt: ISO, used: 1, remaining: 4, resetsAt: ISO, extra: 'x' }
  const calls = stub(t, json(200, { nonce: 'n1', ...ok }))
  t.alike(await a.invitesStart({ member: M }), { nonce: 'n1' })
  t.alike(await a.invitesFinish({ member: M, nonce: 'n1', signature: 'ff' }), { code: CODE, expiresAt: ISO, used: 1, remaining: 4, resetsAt: ISO })
  t.alike(calls.map(c => c.init.method + ' ' + c.url), ['POST /account/invites/start', 'POST /account/invites/finish'])
  t.alike(JSON.parse(calls[0].init.body), { member: M })
  t.alike(JSON.parse(calls[1].init.body), { member: M, nonce: 'n1', signature: 'ff' })
  for (const c of calls) {
    t.is(c.init.credentials, 'same-origin')
    t.is(c.init.cache, 'no-store')
  }
  stub(t, json(200, { nonce: 5 }))
  try { await a.invitesStart({ member: M }); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
  const bad = [
    { ...ok, code: 'abc' }, { ...ok, expiresAt: 'amanhã' }, { ...ok, used: -1 }, { ...ok, remaining: -1 },
    { ...ok, remaining: 1.5 }, { ...ok, resetsAt: null }, { ...ok, used: '1' }
  ]
  for (const body of bad) {
    stub(t, json(200, body))
    try { await a.invitesFinish({ member: M, nonce: 'n', signature: 'ff' }); t.fail() } catch (e) {
      t.is(e.code, 'indisponivel')
      t.is(e.message, 'serviço indisponível')
    }
  }
  stub(t, json(429, { error: 'limite-convites' }))
  try { await a.invitesFinish({ member: M, nonce: 'n', signature: 'ff' }); t.fail() } catch (e) { t.is(e.code, 'limite-convites') }
})

test('age error tokens map to fixed messages', async (t) => {
  const { toError } = await load()
  t.is(toError('idade-pendente').code, 'idade-pendente')
  t.is(toError('idade-pendente').message, 'Confirme sua idade antes de continuar.')
  t.is(toError('limite-idade').code, 'limite-idade')
  t.is(toError('limite-idade').message, 'Muitas tentativas de verificação. Tente de novo amanhã.')
})

test('agePolicy: { required } or null on any failure', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { required: true }))
  t.alike(await a.agePolicy(), { required: true })
  t.is(calls[0].init.method + ' ' + calls[0].url, 'GET /account/age/policy')
  t.is(calls[0].init.body, undefined)
  t.is(calls[0].init.cache, 'no-store')
  stub(t, json(200, { required: false }))
  t.alike(await a.agePolicy(), { required: false })
  stub(t, json(404, { error: 'nao-encontrado' }))
  t.is(await a.agePolicy(), null, '404')
  stub(t, json(503, { error: 'indisponivel' }))
  t.is(await a.agePolicy(), null, '503')
  stub(t, () => { throw new Error('rede') })
  t.is(await a.agePolicy(), null, 'network')
  stub(t, json(200, { required: false }, 'text/html'))
  t.is(await a.agePolicy(), null, 'not JSON')
  for (const body of [{ required: 'false' }, { required: 0 }, { required: false, x: 1 }, {}, [], { required: null }]) {
    stub(t, json(200, body))
    t.is(await a.agePolicy(), null, JSON.stringify(body))
  }
})

// Opaque to the app: the node verifies the signatures (age.proof).
const SINCE_PROOF = {
  type: 'age-since',
  since: '2026-11-01T00:00:00.000Z',
  date: '2026-11-04T10:00:00.000Z',
  association: 'cd'.repeat(32),
  issuer: 'ef'.repeat(32),
  issuerDate: '2026-01-01T00:00:00.000Z',
  issuerSignature: '12'.repeat(64),
  signature: '34'.repeat(64)
}
const VERIFIED_PROOF = { ...SINCE_PROOF, type: 'age-verified', member: M, date: '2026-10-30T12:00:00.000Z' }
delete VERIFIED_PROOF.since
const OVERSIZE = { ...VERIFIED_PROOF, pad: 'x'.repeat(1024) }

test('ageSince: a bounded signed object, null, or undefined on any failure', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { since: SINCE_PROOF }))
  t.alike(await a.ageSince(), SINCE_PROOF)
  t.is(calls[0].init.method + ' ' + calls[0].url, 'GET /account/age/since')
  t.is(calls[0].init.body, undefined)
  stub(t, json(200, { since: null }))
  t.is(await a.ageSince(), null)
  stub(t, () => { throw new Error('rede') })
  t.is(await a.ageSince(), undefined, 'network')
  stub(t, json(404, { error: 'nao-encontrado' }))
  t.is(await a.ageSince(), undefined, '404')
  stub(t, json(200, { since: SINCE_PROOF }, 'text/html'))
  t.is(await a.ageSince(), undefined, 'not JSON')
  t.is(a.MAX_AGE_PROOF_BYTES, 1024)
  const bad = [
    { since: SINCE_PROOF, x: 1 }, {}, [], { since: 5 }, { since: 'ontem' }, { since: '2026-11-01T00:00:00.000Z' },
    { since: [] }, { since: true }, { since: OVERSIZE }, { since: undefined }
  ]
  for (const body of bad) {
    stub(t, json(200, body))
    t.is(await a.ageSince(), undefined, JSON.stringify(body).slice(0, 80))
  }
})

test('ageResult / ageSession: a verificado carries a bounded proof object, else none', async (t) => {
  const a = await load()
  const args = { member: M, nonce: 'n1', signature: 'ff' }
  for (const call of [a.ageResult, a.ageSession]) {
    stub(t, json(200, { state: 'verificado', proof: VERIFIED_PROOF }))
    t.alike(await call(args), { state: 'verificado', proof: VERIFIED_PROOF })
    for (const proof of [undefined, null, 'assinado', 5, [], [VERIFIED_PROOF], OVERSIZE]) {
      stub(t, json(200, proof === undefined ? { state: 'verificado' } : { state: 'verificado', proof }))
      t.alike(await call(args), { state: 'verificado' }, 'proof ' + JSON.stringify(proof)?.slice(0, 40))
    }
  }
  stub(t, json(200, { state: 'recusado', proof: VERIFIED_PROOF }))
  t.alike(await a.ageResult(args), { state: 'recusado' }, 'a proof only with verificado')
  const fits = { ...VERIFIED_PROOF, pad: 'x'.repeat(1024 - JSON.stringify({ ...VERIFIED_PROOF, pad: '' }).length) }
  t.is(JSON.stringify(fits).length, 1024)
  stub(t, json(200, { state: 'verificado', proof: fits }))
  t.alike(await a.ageResult(args), { state: 'verificado', proof: fits }, 'exactly 1024 bytes is accepted')
  const multi = { ...VERIFIED_PROOF, pad: 'é'.repeat(Math.ceil((1025 - JSON.stringify({ ...VERIFIED_PROOF, pad: '' }).length) / 2)) }
  t.ok(JSON.stringify(multi).length <= 1024, 'fits in characters')
  stub(t, json(200, { state: 'verificado', proof: multi }))
  t.alike(await a.ageResult(args), { state: 'verificado' }, 'counted in UTF-8 bytes')
})

test('ageStart: nonce, refusals', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { nonce: 'n1' }))
  t.alike(await a.ageStart({ member: M }), { nonce: 'n1' })
  t.is(calls[0].init.method + ' ' + calls[0].url, 'POST /account/age/start')
  t.alike(JSON.parse(calls[0].init.body), { member: M })
  t.is(calls[0].init.credentials, 'same-origin')
  stub(t, json(200, { nonce: 5 }))
  try { await a.ageStart({ member: M }); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
  stub(t, json(429, { error: 'limite-idade' }))
  try { await a.ageStart({ member: M }); t.fail() } catch (e) { t.is(e.code, 'limite-idade') }
})

test('ageSession: https url or verificado, anything else refused', async (t) => {
  const a = await load()
  const args = { member: M, nonce: 'n1', signature: 'ff' }
  const url = 'https://verify.example.test/session/abc'
  const calls = stub(t, json(200, { url }))
  t.alike(await a.ageSession(args), { url })
  t.is(calls[0].init.method + ' ' + calls[0].url, 'POST /account/age/session')
  t.alike(JSON.parse(calls[0].init.body), args)
  stub(t, json(200, { state: 'verificado' }))
  t.alike(await a.ageSession(args), { state: 'verificado' })
  const bad = [
    { url: 'http://verify.example.test/s' }, { url: 'https://user:pw@verify.example.test/s' },
    { url: 'https://user@verify.example.test/s' }, { url: 'javascript:alert(1)' }, { url: 'https://' },
    { url: 5 }, { state: 'pendente' }, { state: 'Verificado' }, {}, { ok: true }
  ]
  for (const body of bad) {
    stub(t, json(200, body))
    try { await a.ageSession(args); t.fail(JSON.stringify(body)) } catch (e) {
      t.is(e.code, 'indisponivel', JSON.stringify(body))
      t.is(e.uncertain, true, JSON.stringify(body))
    }
  }
})

test('ageSession: invite only when well formed; no answer is uncertain, refusals definite', async (t) => {
  const a = await load()
  const args = { member: M, nonce: 'n1', signature: 'ff' }
  const calls = stub(t, json(200, { state: 'verificado' }))
  await a.ageSession({ ...args, invite: 'abc' })
  await a.ageSession({ ...args, invite: null })
  await a.ageSession({ ...args, invite: CODE })
  t.alike(JSON.parse(calls[0].init.body), args)
  t.alike(JSON.parse(calls[1].init.body), args)
  t.alike(JSON.parse(calls[2].init.body), { ...args, invite: CODE })
  const sent = stub(t, () => { throw new Error('rede') })
  try { await a.ageSession(args); t.fail() } catch (e) {
    t.is(e.code, 'indisponivel')
    t.is(e.uncertain, true)
  }
  t.is(sent.length, 1, 'never retried')
  for (const [status, token] of [[400, 'convite-invalido'], [400, 'assinatura-invalida'], [429, 'limite-idade']]) {
    stub(t, json(status, { error: token }))
    try { await a.ageSession(args); t.fail() } catch (e) {
      t.is(e.code, token)
      t.absent(e.uncertain, token)
    }
  }
})

test('age calls: the service\'s own 503 token is a definite refusal; a 5xx without one stays uncertain', async (t) => {
  const a = await load()
  const args = { member: M, nonce: 'n1', signature: 'ff' }
  for (const call of [a.ageSession, a.ageResult]) {
    stub(t, json(503, { error: 'indisponivel' }))
    try { await call(args); t.fail() } catch (e) {
      t.is(e.code, 'indisponivel')
      t.absent(e.uncertain, 'nothing was created: not uncertain')
    }
    stub(t, json(502, null, 'text/html'))
    try { await call(args); t.fail() } catch (e) {
      t.is(e.code, 'indisponivel')
      t.is(e.uncertain, true, 'a proxy page is still unknown')
    }
    stub(t, json(500, { error: 'algo-que-nao-existe' }))
    try { await call(args); t.fail() } catch (e) {
      t.is(e.uncertain, true, 'an unknown token is still unknown')
    }
    stub(t, json(503, { error: 'resultado-incerto' }))
    try { await call(args); t.fail() } catch (e) {
      t.is(e.uncertain, true, 'the service says it may have been applied')
    }
  }
  // Other uncertain calls keep treating every 5xx as unknown.
  stub(t, json(503, { error: 'indisponivel' }))
  try { await a.pushFinish({ member: M, nonce: 'n', action: 'on', signature: 'ff', endpoint: 'https://push.test/x', p256dh: 'a', auth: 'b' }); t.fail() } catch (e) {
    t.is(e.uncertain, true)
  }
})

test('ageResult: known states only', async (t) => {
  const a = await load()
  const args = { member: M, nonce: 'n1', signature: 'ff' }
  for (const state of ['verificado', 'pendente', 'recusado', 'inconclusivo', 'expirado', 'nenhum']) {
    const calls = stub(t, json(200, { state }))
    t.alike(await a.ageResult(args), { state })
    t.is(calls[0].init.method + ' ' + calls[0].url, 'POST /account/age/result')
    t.alike(JSON.parse(calls[0].init.body), args)
  }
  for (const body of [{ state: 'aprovado' }, { state: 'Verificado' }, { state: 1 }, {}, { state: ['verificado'] }]) {
    stub(t, json(200, body))
    try { await a.ageResult(args); t.fail(JSON.stringify(body)) } catch (e) {
      t.is(e.code, 'indisponivel', JSON.stringify(body))
      t.is(e.uncertain, true, 'a malformed answer is uncertain: ' + JSON.stringify(body))
    }
  }
  const sent = stub(t, () => { throw new Error('rede') })
  try { await a.ageResult(args); t.fail() } catch (e) {
    t.is(e.code, 'indisponivel')
    t.is(e.uncertain, true, 'no answer is uncertain')
  }
  t.is(sent.length, 1, 'never retried')
  stub(t, json(429, { error: 'limite-idade' }))
  try { await a.ageResult(args); t.fail() } catch (e) {
    t.is(e.code, 'limite-idade')
    t.absent(e.uncertain, 'a refusal is definite')
  }
})

test('app client: absolute URLs, header and no credentials only with the flag on', async (t) => {
  const a = await load()
  const { setInstallation } = await import('../src/installation.js')
  const { setAppClient } = await import('../src/appClient.js')
  t.teardown(() => { setInstallation(null); setAppClient(false) })

  const web = a.buildRequest('POST', '/account/start', { member: M })
  t.is(web.url, '/account/start')
  t.is(web.init.credentials, 'same-origin')
  t.absent('x-varanda-client' in web.init.headers, 'the web sends no client header')
  t.is(a.buildRequest('GET', '/account/pending?member=' + M).init.credentials, 'same-origin', 'web GETs unchanged')

  t.ok(setInstallation('https://example.test'))
  setAppClient(true)
  const calls = stub(t, json(200, { ok: 1 }))
  await a.accountStatus(M)
  await a.startLink({ member: M, username: 'ana' })
  await a.renameStart({ member: M, username: 'bia' })
  t.is(calls[0].url, 'https://example.test/account/status?member=' + M)
  t.is(calls[0].init.method, 'GET')
  t.absent('x-varanda-client' in calls[0].init.headers, 'only POSTs carry the header')
  t.is(calls[0].init.credentials, 'omit', 'a GET never carries cookies either')
  t.is(calls.length, 3)
  t.is(a.buildRequest('GET', '/account/pending?member=' + M).init.credentials, 'omit')
  for (const c of calls) t.absent('cache' in c.init, 'no cache option in the app')
  t.absent('cache' in a.buildRequest('GET', '/account/pending?member=' + M).init)
  for (const c of calls.slice(1)) {
    t.is(c.init.method, 'POST')
    t.ok(c.url.startsWith('https://example.test/account/'), c.url)
    t.is(c.init.credentials, 'omit')
    t.is(c.init.headers['x-varanda-client'], 'app')
    t.is(c.init.headers['content-type'], 'application/json')
  }

  setAppClient(false)
  const off = a.buildRequest('POST', '/account/start', { member: M })
  t.is(off.url, 'https://example.test/account/start', 'the URL follows the installation alone')
  t.is(off.init.credentials, 'same-origin')
  t.absent('x-varanda-client' in off.init.headers)
  t.is(off.init.cache, 'no-store', 'the web keeps no-store')
  t.is(a.buildRequest('GET', '/account/status?member=' + M).init.credentials, 'same-origin')
})

test('app link proofs: appProof, x-varanda-link and x-varanda-redeem only from the app', async (t) => {
  const a = await load()
  const { setInstallation } = await import('../src/installation.js')
  const { setAppClient } = await import('../src/appClient.js')
  t.teardown(() => { setInstallation(null); setAppClient(false) })
  const V = 'V'.repeat(42) + 'A'
  const R = 'R'.repeat(42) + 'A'
  const P = 'P'.repeat(42) + 'A'
  const SIG = 'sig'

  // The web: no proof ever goes out, even when the caller passes one.
  let calls = stub(t, json(200, { ok: 1 }))
  await a.startLink({ member: M, username: 'ana', appProof: P, linkSecret: V })
  await a.authorizeLink({ signature: SIG, linkSecret: V })
  await a.readPending({ linkSecret: V, redeem: R })
  await a.finishLink({ signature: SIG, linkSecret: V, redeem: R })
  await a.readPending()
  await a.finishLink({ signature: SIG })
  t.is(calls.length, 6)
  t.alike(JSON.parse(calls[0].init.body), { member: M, username: 'ana' }, 'no appProof in the web body')
  for (const c of calls) {
    t.ok(c.url.startsWith('/account/'), 'relative URL ' + c.url)
    t.alike(Object.keys(c.init.headers).filter((h) => h.startsWith('x-varanda')), [], 'no app header on the web')
    t.is(c.init.credentials, 'same-origin')
  }
  t.alike(calls[2].init.headers, { accept: 'application/json' }, 'web pending headers unchanged')

  // The app.
  t.ok(setInstallation('https://example.test'))
  setAppClient(true)
  calls = stub(t, json(200, { ok: 1 }))
  await a.startLink({ member: M, username: 'ana', appProof: P })
  t.alike(JSON.parse(calls[0].init.body), { member: M, username: 'ana', appProof: P })
  t.absent('x-varanda-link' in calls[0].init.headers, 'a first start holds no V')
  await a.startLink({ member: M, username: 'ana', appProof: P, linkSecret: V })
  t.is(calls[1].init.headers['x-varanda-link'], V, 'a restart presents the held V')
  t.absent('x-varanda-redeem' in calls[1].init.headers)
  await a.startLink({ member: M, username: 'ana', appProof: 'short', linkSecret: 'bad' })
  t.alike(JSON.parse(calls[2].init.body), { member: M, username: 'ana' }, 'a malformed appProof is not sent')
  t.absent('x-varanda-link' in calls[2].init.headers, 'a malformed V is not sent')
  await a.authorizeLink({ signature: SIG, linkSecret: V })
  t.is(calls[3].init.headers['x-varanda-link'], V)
  t.alike(JSON.parse(calls[3].init.body), { signature: SIG })
  await a.readPending({ linkSecret: V, redeem: R })
  t.is(calls[4].init.method, 'GET')
  t.is(calls[4].init.headers['x-varanda-link'], V)
  t.is(calls[4].init.headers['x-varanda-redeem'], R)
  await a.finishLink({ signature: SIG, linkSecret: V, redeem: R })
  t.is(calls[5].url, 'https://example.test/account/finish')
  t.is(calls[5].init.headers['x-varanda-link'], V)
  t.is(calls[5].init.headers['x-varanda-redeem'], R)
  t.is(calls[5].init.headers['x-varanda-client'], 'app')
  t.alike(JSON.parse(calls[5].init.body), { signature: SIG }, 'the proofs never go in the body')
  t.is(calls.length, 6)

  // Without both V and R nothing is asked or sent.
  t.is(await a.readPending(), null)
  t.is(await a.readPending({ linkSecret: V }), null)
  t.is(await a.readPending({ redeem: R }), null)
  for (const opts of [{}, { linkSecret: V }, { redeem: R }, { linkSecret: V, redeem: 'x' }]) {
    try {
      await a.finishLink({ signature: SIG, ...opts })
      t.fail('sent without the proofs')
    } catch (e) {
      t.is(e.code, 'expirado')
      t.absent(e.uncertain, 'nothing was sent, so nothing is uncertain')
    }
  }
  t.is(calls.length, 6, 'a native finish or pending without V and R is never sent')
})

const LOOKUP = 'cd'.repeat(32)
const BLOB = { v: 1, kind: 'passkey', nonce: '0a'.repeat(24), ciphertext: '1b'.repeat(82) }

test('recovery calls: same-origin POSTs with exactly those keys', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { nonce: 'n'.repeat(43) }))
  t.alike(await a.recoveryStart({ member: M }), { nonce: 'n'.repeat(43) })
  const puts = stub(t, json(200, { createdAt: '2026-11-06T12:00:00.000Z', changed: true }))
  t.alike(await a.recoveryPut({ member: M, nonce: 'n', signature: 'ff', kind: 'passkey', lookupId: LOOKUP, blob: BLOB }), { ok: true, changed: true, createdAt: '2026-11-06T12:00:00.000Z' })
  const removes = stub(t, json(200, { changed: true }))
  t.alike(await a.recoveryRemove({ member: M, nonce: 'n', signature: 'ff', kind: 'code', lookupId: LOOKUP }), { ok: true, changed: true })
  const writes = [...puts, ...removes]
  const lists = stub(t, json(200, { entries: [{ lookupId: LOOKUP, kind: 'code', createdAt: '2026-11-06T12:00:00.000Z' }] }))
  t.alike(await a.recoveryList({ member: M, nonce: 'n', signature: 'ff' }), [{ lookupId: LOOKUP, kind: 'code', createdAt: '2026-11-06T12:00:00.000Z' }])
  const fetches = stub(t, json(200, { member: M, kind: 'passkey', blob: BLOB }))
  t.alike(await a.recoveryFetch(LOOKUP), { member: M, kind: 'passkey', blob: BLOB })
  const all = [...calls, ...writes, ...lists, ...fetches]
  t.alike(all.map(c => c.init.method + ' ' + c.url), [
    'POST /account/recovery/start',
    'POST /account/recovery/put',
    'POST /account/recovery/remove',
    'POST /account/recovery/list',
    'POST /account/recovery/fetch'
  ])
  t.alike(all.map(c => JSON.parse(c.init.body)), [
    { member: M },
    { member: M, nonce: 'n', signature: 'ff', kind: 'passkey', lookupId: LOOKUP, blob: BLOB },
    { member: M, nonce: 'n', signature: 'ff', kind: 'code', lookupId: LOOKUP },
    { member: M, nonce: 'n', signature: 'ff' },
    { lookupId: LOOKUP }
  ])
  for (const c of all) {
    t.is(c.init.credentials, 'same-origin')
    t.absent(c.url.includes(LOOKUP), 'the lookup id never rides in a URL')
  }
})

test('recoveryFetch: null only on 404, an https origin is absolute, any other failure throws', async (t) => {
  const a = await load()
  stub(t, json(404, { error: 'nao-encontrado', recovery: true }))
  t.is(await a.recoveryFetch(LOOKUP), null)
  const calls = stub(t, json(404, { error: 'nao-encontrado', recovery: true }))
  t.is(await a.recoveryFetch(LOOKUP, { origin: 'https://varanda.example' }), null)
  t.is(calls[0].url, 'https://varanda.example/account/recovery/fetch')
  for (const [name, res] of [
    ['503', () => json(503, { error: 'indisponivel' })],
    ['500 html', () => json(500, {}, 'text/html')],
    ['no answer', () => { throw new Error('rede') }],
    ['429', () => json(429, { error: 'limite' })],
    ['404 html', () => json(404, {}, 'text/html')],
    ['404 empty', () => ({ ok: false, status: 404, headers: { get: () => 'application/json' }, text: async () => '' })],
    ['404 not json', () => ({ ok: false, status: 404, headers: { get: () => 'application/json' }, text: async () => 'nada' })],
    ['404 no error', () => json(404, {})],
    ['404 other token', () => json(404, { error: 'expirado' })],
    ['404 without recovery mark', () => json(404, { error: 'nao-encontrado' })],
    ['404 recovery not true', () => json(404, { error: 'nao-encontrado', recovery: 'true' })],
    ['other member shape', () => json(200, { member: 'x', kind: 'passkey', blob: BLOB })],
    ['kind mismatch', () => json(200, { member: M, kind: 'code', blob: BLOB })],
    ['extra key', () => json(200, { member: M, kind: 'passkey', blob: BLOB, x: 1 })],
    ['bad blob', () => json(200, { member: M, kind: 'passkey', blob: { ...BLOB, ciphertext: 'zz' } })],
    ['blob extra key', () => json(200, { member: M, kind: 'passkey', blob: { ...BLOB, x: 1 } })]
  ]) {
    stub(t, res)
    try { await a.recoveryFetch(LOOKUP); t.fail(name) } catch (e) { t.ok(e instanceof Error, name) }
  }
  // A 404 that is not the service's own answer is "could not ask", never
  // "not registered": a null would let the app install a ceremony PRF. An
  // older server answers its unknown route with a bare 'nao-encontrado'.
  for (const res of [json(404, {}, 'text/html'), json(404, {}), json(404, { error: 'expirado' }), json(404, { error: 'nao-encontrado' })]) {
    stub(t, res)
    try { await a.recoveryFetch(LOOKUP); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
  }
})

test('recoveryPut/recoveryRemove: real answer shapes, changed and createdAt come from the service', async (t) => {
  const a = await load()
  const put = () => a.recoveryPut({ member: M, nonce: 'n', signature: 'ff', kind: 'code', lookupId: LOOKUP, blob: { ...BLOB, kind: 'code' } })
  const remove = () => a.recoveryRemove({ member: M, nonce: 'n', signature: 'ff', kind: 'code', lookupId: LOOKUP })
  stub(t, json(200, { createdAt: '2026-11-06T12:00:00.000Z', changed: false }))
  t.alike(await put(), { ok: true, changed: false, createdAt: '2026-11-06T12:00:00.000Z' })
  stub(t, json(200, { createdAt: 'ontem', changed: true }))
  t.alike(await put(), { ok: true, changed: true }, 'an unreadable createdAt is left out')
  stub(t, json(200, { changed: false }))
  t.alike(await remove(), { ok: true, changed: false })
  stub(t, json(200, { changed: 'yes' }))
  t.alike(await remove(), { ok: true, changed: false }, 'only a literal true is a change')
})

test('recoveryList: exact entry shape or indisponivel', async (t) => {
  const a = await load()
  stub(t, json(200, { entries: [] }))
  t.alike(await a.recoveryList({ member: M, nonce: 'n', signature: 'ff' }), [])
  for (const body of [
    {},
    { entries: {} },
    { entries: [], x: 1 },
    { entries: [{ lookupId: LOOKUP, kind: 'code' }] },
    { entries: [{ lookupId: LOOKUP, kind: 'code', createdAt: 'ontem' }] },
    { entries: [{ lookupId: 'AB'.repeat(32), kind: 'code', createdAt: '2026-11-06T12:00:00.000Z' }] },
    { entries: [{ lookupId: LOOKUP, kind: 'senha', createdAt: '2026-11-06T12:00:00.000Z' }] },
    { entries: [{ lookupId: LOOKUP, kind: 'code', createdAt: '2026-11-06T12:00:00.000Z', blob: BLOB }] }
  ]) {
    stub(t, json(200, body))
    try { await a.recoveryList({ member: M, nonce: 'n', signature: 'ff' }); t.fail() } catch (e) { t.is(e.code, 'indisponivel', JSON.stringify(body)) }
  }
  stub(t, json(200, {}))
  try { await a.recoveryStart({ member: M }); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
})

test('recovery tokens: limite-recuperacao everywhere, nao-encontrado only on recovery routes', async (t) => {
  const a = await load()
  t.is(a.toError('limite-recuperacao').message, 'você já tem o máximo de passkeys e códigos cadastrados; remova um antes')
  t.is(a.toError('limite-recuperacao').code, 'limite-recuperacao')
  t.is(a.toError('limite').code, 'indisponivel', 'the shared cap token is not the recovery one')
  stub(t, json(409, { error: 'limite-recuperacao' }))
  try {
    await a.recoveryPut({ member: M, nonce: 'n', signature: 'ff', kind: 'passkey', lookupId: LOOKUP, blob: BLOB })
    t.fail()
  } catch (e) {
    t.is(e.code, 'limite-recuperacao')
    t.absent(e.uncertain, 'a 4xx refusal is definite')
  }
  stub(t, json(404, { error: 'nao-encontrado' }))
  try { await a.recoveryRemove({ member: M, nonce: 'n', signature: 'ff', kind: 'code', lookupId: LOOKUP }); t.fail() } catch (e) {
    t.is(e.code, 'nao-encontrado')
    t.is(e.message, 'esta passkey ou este código não está ligado a uma conta neste endereço')
  }
  stub(t, json(404, { error: 'nao-encontrado' }))
  try { await a.renameStart({ member: M, username: 'bia' }); t.fail() } catch (e) {
    t.is(e.code, 'indisponivel', 'rename keeps its fallback')
    t.is(e.message, 'serviço indisponível')
  }
  t.is(a.toError('nao-encontrado').code, 'indisponivel')
})

test('recoveryPut/recoveryRemove: no answer, any 5xx or an unreadable success is uncertain', async (t) => {
  const a = await load()
  const put = () => a.recoveryPut({ member: M, nonce: 'n', signature: 'ff', kind: 'passkey', lookupId: LOOKUP, blob: BLOB })
  const remove = () => a.recoveryRemove({ member: M, nonce: 'n', signature: 'ff', kind: 'passkey', lookupId: LOOKUP })
  for (const [name, res] of [
    ['no answer', () => { throw new Error('rede') }],
    ['503 indisponivel', () => json(503, { error: 'indisponivel' })],
    ['503 limite-recuperacao', () => json(503, { error: 'limite-recuperacao' })],
    ['500 html', () => json(500, {}, 'text/html')],
    ['200 html', () => json(200, {}, 'text/html')]
  ]) {
    for (const fn of [put, remove]) {
      stub(t, res)
      try { await fn(); t.fail(name) } catch (e) { t.is(e.uncertain, true, name) }
    }
  }
  for (const token of ['nao-vinculado', 'expirado', 'assinatura-invalida', 'pedido-invalido']) {
    stub(t, json(token === 'expirado' ? 404 : 400, { error: token }))
    try { await put(); t.fail() } catch (e) {
      t.is(e.code, token)
      t.absent(e.uncertain, token + ' is a refusal')
    }
  }
  stub(t, () => { throw new Error('rede') })
  try { await a.recoveryStart({ member: M }); t.fail() } catch (e) { t.absent(e.uncertain, 'start changes nothing') }
  stub(t, () => { throw new Error('rede') })
  try { await a.recoveryList({ member: M, nonce: 'n', signature: 'ff' }); t.fail() } catch (e) { t.absent(e.uncertain, 'list changes nothing') }
})

const SEEN_HASH = 'cd'.repeat(32)
const SEEN_BLOB = 'A'.repeat(43744)
const SEEN_SIG = 'ef'.repeat(64)
const seenFinish = (a, action, extra = {}) =>
  a.seenFinish({ member: M, nonce: 'n'.repeat(54), action, signature: SEEN_SIG, prevHash: SEEN_HASH, blob: SEEN_BLOB, ...extra })

test('seenStart: POST with member and action, nonce or a definite refusal', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { nonce: 'n1' }))
  t.alike(await a.seenStart({ member: M, action: 'write' }), { nonce: 'n1' })
  t.is(calls[0].init.method + ' ' + calls[0].url, 'POST /account/seen/start')
  t.alike(JSON.parse(calls[0].init.body), { member: M, action: 'write' })
  stub(t, () => { throw new Error('rede') })
  try { await a.seenStart({ member: M, action: 'write' }); t.fail() } catch (e) {
    t.is(e.code, 'indisponivel')
    t.absent(e.uncertain, 'start changes nothing')
  }
  stub(t, json(403, { error: 'nao-vinculado' }))
  try { await a.seenStart({ member: M, action: 'read' }); t.fail() } catch (e) { t.is(e.code, 'nao-vinculado') }
  stub(t, json(200, { nonce: 7 }))
  try { await a.seenStart({ member: M, action: 'read' }); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
})

test('seenFinish: read shapes, and the blob only goes in a write', async (t) => {
  const a = await load()
  let calls = stub(t, json(200, { hash: SEEN_HASH, blob: SEEN_BLOB }))
  t.alike(await seenFinish(a, 'read'), { hash: SEEN_HASH, blob: SEEN_BLOB, unchanged: false })
  t.is(calls[0].url, '/account/seen/finish')
  t.alike(JSON.parse(calls[0].init.body), { member: M, nonce: 'n'.repeat(54), action: 'read', signature: SEEN_SIG, prevHash: SEEN_HASH })
  stub(t, json(200, { hash: null, blob: null }))
  t.alike(await seenFinish(a, 'read'), { hash: null, blob: null, unchanged: false })
  stub(t, json(200, { hash: SEEN_HASH, blob: null, unchanged: true }))
  t.alike(await seenFinish(a, 'read'), { hash: SEEN_HASH, blob: null, unchanged: true })
  for (const bad of [{ hash: 'zz', blob: SEEN_BLOB }, { hash: SEEN_HASH, blob: 'abc' }, { hash: SEEN_HASH, blob: null }, { hash: null, blob: SEEN_BLOB }]) {
    stub(t, json(200, bad))
    try { await seenFinish(a, 'read'); t.fail() } catch (e) {
      t.is(e.code, 'indisponivel')
      t.absent(e.uncertain, 'a read changes nothing')
    }
  }
  calls = stub(t, () => { throw new Error('rede') })
  try { await seenFinish(a, 'read'); t.fail() } catch (e) {
    t.is(e.code, 'indisponivel')
    t.absent(e.uncertain, 'a lost read is not uncertain')
  }
  t.is(calls.length, 1)
})

test('seenFinish: a read accepts a 44 KB body', async (t) => {
  const a = await load()
  const res = json(200, { hash: SEEN_HASH, blob: SEEN_BLOB })
  t.ok(JSON.stringify({ hash: SEEN_HASH, blob: SEEN_BLOB }).length > 4096 * 10)
  stub(t, res)
  t.alike(await seenFinish(a, 'read'), { hash: SEEN_HASH, blob: SEEN_BLOB, unchanged: false })
})

test('seenFinish: write and delete success shapes', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { ok: true, hash: SEEN_HASH }))
  t.alike(await seenFinish(a, 'write'), { ok: true, hash: SEEN_HASH })
  t.alike(JSON.parse(calls[0].init.body), { member: M, nonce: 'n'.repeat(54), action: 'write', signature: SEEN_SIG, prevHash: SEEN_HASH, blob: SEEN_BLOB })
  stub(t, json(200, { ok: true, changed: false }))
  t.alike(await seenFinish(a, 'delete'), { ok: true, changed: false })
  const del = stub(t, json(200, { ok: true, changed: true }))
  t.alike(await seenFinish(a, 'delete'), { ok: true, changed: true })
  t.absent('blob' in JSON.parse(del[0].init.body), 'no blob in a delete')
})

test('seenFinish: a 409 conflito is definite and carries hash and blob', async (t) => {
  const a = await load()
  let calls = stub(t, json(409, { error: 'conflito', hash: SEEN_HASH, blob: SEEN_BLOB }))
  try { await seenFinish(a, 'write'); t.fail() } catch (e) {
    t.is(e.code, 'conflito')
    t.is(e.message, 'Outro aparelho gravou antes.')
    t.absent(e.uncertain, 'nothing was written')
    t.is(e.hash, SEEN_HASH)
    t.is(e.blob, SEEN_BLOB)
    t.absent(e.body)
  }
  t.is(calls.length, 1, 'never a second fetch')
  stub(t, json(409, { error: 'conflito', hash: '0'.repeat(64), blob: null }))
  try { await seenFinish(a, 'write'); t.fail() } catch (e) {
    t.is(e.code, 'conflito')
    t.is(e.hash, '0'.repeat(64))
    t.is(e.blob, null)
  }
  stub(t, json(409, { error: 'conflito', hash: SEEN_HASH }))
  try { await seenFinish(a, 'delete'); t.fail() } catch (e) {
    t.is(e.code, 'conflito')
    t.absent(e.uncertain)
    t.is(e.hash, SEEN_HASH)
    t.is(e.blob, null)
  }
  for (const bad of [{ error: 'conflito' }, { error: 'conflito', hash: 'x', blob: null }, { error: 'conflito', hash: SEEN_HASH, blob: 'short' }]) {
    calls = stub(t, json(409, bad))
    try { await seenFinish(a, 'write'); t.fail() } catch (e) {
      t.is(e.code, 'indisponivel', 'a malformed conflict is unavailable')
      t.absent(e.uncertain, 'a 409 wrote nothing')
      t.absent(e.hash)
    }
    t.is(calls.length, 1)
  }
})

test('seenFinish: refusals are definite and carry no body', async (t) => {
  const a = await load()
  for (const [status, token] of [[400, 'expirado'], [400, 'assinatura-invalida'], [403, 'termos-pendentes'], [403, 'nao-vinculado'], [400, 'pedido-invalido']]) {
    stub(t, json(status, { error: token, hash: SEEN_HASH }))
    try { await seenFinish(a, 'write'); t.fail() } catch (e) {
      t.is(e.code, token)
      t.absent(e.uncertain, token + ' is a refusal')
      t.absent(e.body)
      t.absent(e.hash)
    }
  }
})

test('seenFinish: a lost answer on write or delete is uncertain and never resent', async (t) => {
  const a = await load()
  const cases = [
    ['transport', () => { throw new Error('rede') }],
    ['5xx', json(502, {}, 'text/html')],
    ['5xx token', json(503, { error: 'indisponivel' })],
    ['bad body', json(200, { ok: true, hash: 'zz' })],
    ['not JSON', json(200, { ok: true, hash: SEEN_HASH }, 'text/plain')]
  ]
  for (const action of ['write', 'delete']) {
    for (const [name, res] of cases) {
      const calls = stub(t, res)
      try { await seenFinish(a, action); t.fail() } catch (e) {
        t.is(e.code, 'indisponivel', action + ' ' + name)
        t.is(e.uncertain, true, action + ' ' + name)
      }
      t.is(calls.length, 1, action + ' ' + name + ': sent once, never retried')
    }
  }
})

test('readJson refuses an answer over the cap without buffering it whole', async (t) => {
  const { readJson } = await load()
  const headers = (extra = {}) => ({ get: (k) => ({ 'content-type': 'application/json', ...extra })[k.toLowerCase()] ?? null })
  let textCalled = false
  const declared = { headers: headers({ 'content-length': '999999' }), text: async () => { textCalled = true; return '{}' } }
  t.is(await readJson(declared, 100), null, 'a declared length over the cap')
  t.is(textCalled, false, 'nothing read')
  let pulls = 0
  let cancelled = false
  const big = new Uint8Array(64).fill(0x20)
  const streamed = {
    headers: headers(),
    body: {
      getReader: () => ({
        read: async () => { pulls++; return pulls > 1000 ? { done: true } : { done: false, value: big } },
        cancel: async () => { cancelled = true }
      })
    }
  }
  t.is(await readJson(streamed, 100), null, 'a streamed body over the cap')
  t.ok(pulls <= 3, 'stops reading at the cap')
  t.ok(cancelled, 'the stream is cancelled')
  const ok = { headers: headers(), body: { getReader: () => { let sent = false; return { read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: new TextEncoder().encode('{"a":1}') } } } } } }
  t.alike(await readJson(ok, 100), { a: 1 }, 'a small streamed body still parses')
})
