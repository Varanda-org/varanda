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
  t.is(waiting.message, 'A Varanda está cheia por enquanto. Nada sobre você foi guardado; volte daqui a alguns dias para tentar de novo. Quem já entrou continua usando a rede normalmente.')
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

test('404 gives null for pending and lookup, an error elsewhere', async (t) => {
  const a = await load()
  stub(t, json(404, { error: 'nao-encontrado' }))
  t.is(await a.readPending(), null)
  t.is(await a.lookupUsername('ana'), null)
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
    { required: true, perWeek: 5, x: 1 }, { required: 'true', perWeek: 5 }, {}, []
  ]
  for (const body of bad) {
    stub(t, json(200, body))
    try { await a.invitePolicy(); t.fail(JSON.stringify(body)) } catch (e) { t.is(e.code, 'indisponivel', JSON.stringify(body)) }
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
