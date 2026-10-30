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

const NONCE = 'N'.repeat(43)
const SIG = 'f'.repeat(128)
const ADDR = '0x' + 'a1'.repeat(20)
const ACCOUNT = {
  kyc: { state: 'aprovado', attempt: 1 },
  network: 'polygon',
  address: ADDR,
  wallet: { address: ADDR },
  subaccountUncertain: false,
  walletUncertain: false,
  documentReady: true,
  selfieReady: true
}
const UP_FRONT = 'https://uploads.hodle.com.br/u/front?sig=1'
const UP_BACK = 'https://uploads.hodle.com.br/u/back?sig=2'
const LIVE = 'https://app.hodle.com.br/liveness/abc'
const expectError = async (t, p, code, uncertain, msg) => {
  try { await p; t.fail(msg) } catch (e) {
    t.is(e.code, code, msg)
    if (uncertain) t.is(e.uncertain, true, msg)
    else t.absent(e.uncertain, msg)
    return e
  }
}

test('wallet error tokens map to fixed pt-BR messages', async (t) => {
  const { toError } = await load()
  const table = {
    'carteira-pendente': 'Abra a conta de pagamentos antes.',
    'kyc-pendente': 'A verificação de identidade ainda não terminou.',
    'kyc-recusado': 'A verificação de identidade não foi aprovada.',
    'documentos-pendentes': 'Envie o documento e a selfie antes.',
    'pin-invalido': 'PIN incorreto.',
    'pin-bloqueado': 'PIN bloqueado por 24 horas após três erros.',
    'limite-carteira': 'Muitas operações. Tente de novo mais tarde.',
    'valor-invalido': 'Valor inválido.',
    'destino-invalido': 'Destino inválido.',
    'saldo-insuficiente': 'Saldo insuficiente.',
    'carteira-incerta': 'A criação da carteira ainda não foi confirmada.',
    'taxa-mudou': 'A taxa mudou. Confira de novo antes de confirmar.',
    'idade-minima': 'Por enquanto a conta de pagamentos só pode ser aberta por quem tem 18 anos ou mais.',
    'operacao-pendente': 'Uma operação anterior ainda não foi confirmada. Aguarde a confirmação antes de fazer outra.',
    'aguardando-carteira': 'Verificação aprovada. A carteira será liberada em breve.'
  }
  for (const [code, message] of Object.entries(table)) {
    t.is(toError(code).code, code)
    t.is(toError(code).message, message)
  }
  t.is(toError('resultado-incerto').code, 'indisponivel', 'resultado-incerto stays an unknown token')
})

test('walletPolicy: { available, network, mode } or null on any failure', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { available: true, network: 'polygon', mode: 'cadastro' }))
  t.alike(await a.walletPolicy(), { available: true, network: 'polygon', mode: 'cadastro' })
  t.is(calls[0].init.method + ' ' + calls[0].url, 'GET /account/wallet/policy')
  t.is(calls[0].init.body, undefined)
  stub(t, json(200, { available: false, mode: 'cadastro' }))
  t.alike(await a.walletPolicy(), { available: false, network: null, mode: 'cadastro' })
  for (const mode of ['carteira', 'pix', 'completo']) {
    stub(t, json(200, { available: true, network: 'base', mode }))
    t.is((await a.walletPolicy()).mode, mode)
  }
  for (const body of [{ available: 'true', network: 'polygon', mode: 'cadastro' }, { available: true, network: 'polygon', mode: 'tudo' },
    { available: true, network: 5, mode: 'cadastro' }, { available: true, network: 'Poly gon', mode: 'cadastro' }, [], {}]) {
    stub(t, json(200, body))
    t.is(await a.walletPolicy(), null, JSON.stringify(body))
  }
  stub(t, json(404, { error: 'nao-encontrado' }))
  t.is(await a.walletPolicy(), null, '404')
  stub(t, json(503, { error: 'indisponivel' }))
  t.is(await a.walletPolicy(), null, '503')
  stub(t, () => { throw new Error('rede') })
  t.is(await a.walletPolicy(), null, 'network')
})

test('walletStart: nonce for the action; 404 on wallet-create is the cadastro mode (C11)', async (t) => {
  const a = await load()
  const calls = stub(t, json(200, { nonce: NONCE }))
  t.alike(await a.walletStart({ member: M, action: 'optin' }), { nonce: NONCE })
  t.is(calls[0].init.method + ' ' + calls[0].url, 'POST /account/wallet/start')
  t.alike(JSON.parse(calls[0].init.body), { member: M, action: 'optin' })
  t.is(calls[0].init.credentials, 'same-origin')
  stub(t, json(200, { nonce: 5 }))
  await expectError(t, a.walletStart({ member: M, action: 'optin' }), 'indisponivel', false)
  stub(t, json(404, { error: 'nao-encontrado' }))
  const e = await expectError(t, a.walletStart({ member: M, action: 'wallet-create' }), 'aguardando-carteira', false)
  t.is(e.message, 'Verificação aprovada. A carteira será liberada em breve.')
  stub(t, json(404, { error: 'nao-encontrado' }))
  await expectError(t, a.walletStart({ member: M, action: 'status' }), 'indisponivel', false)
  stub(t, json(503, { error: 'indisponivel' }))
  await expectError(t, a.walletStart({ member: M, action: 'optin' }), 'indisponivel', false, 'start is never uncertain')
})

test('wallet signed calls: path, action, the exact op and the signature', async (t) => {
  const a = await load()
  const cases = [
    ['optin', a.walletOptin, {}, {}, { ok: true }],
    ['kyc-document', a.walletKycDocument, { documentType: 'ID', isDoubleSided: 0 }, {}, { uploadUrlFront: UP_FRONT }],
    ['kyc-submit', a.walletKycSubmit, { kycHash: 'c'.repeat(64) }, { kyc: { fullName: 'Ana' } }, { ok: true }],
    ['status', a.walletStatus, {}, {}, { account: ACCOUNT }],
    ['wallet-create', a.walletCreate, {}, { pin: '135790' }, { address: ADDR }]
  ]
  for (const [action, fn, op, extra, answer] of cases) {
    const calls = stub(t, json(200, answer))
    await fn({ member: M, nonce: NONCE, signature: SIG, op, ...extra })
    t.is(calls.length, 1, action)
    t.is(calls[0].init.method + ' ' + calls[0].url, 'POST /account/wallet/' + action)
    t.is(calls[0].init.credentials, 'same-origin')
    t.alike(JSON.parse(calls[0].init.body), { member: M, nonce: NONCE, action, op, signature: SIG, ...extra }, action)
  }
})

test('walletOptin/walletKycDocument/walletKycSubmit/walletCreate: unknown outcomes are uncertain, the 503 token is definite', async (t) => {
  const a = await load()
  const args = { member: M, nonce: NONCE, signature: SIG, op: {} }
  const calls = [
    (x) => a.walletOptin(x),
    (x) => a.walletKycDocument({ ...x, op: { documentType: 'ID', isDoubleSided: 0 } }),
    (x) => a.walletKycSubmit({ ...x, op: { kycHash: 'c'.repeat(64) }, kyc: { fullName: 'Ana' } }),
    (x) => a.walletCreate({ ...x, pin: '135790' })
  ]
  for (const fn of calls) {
    stub(t, json(503, { error: 'indisponivel' }))
    await expectError(t, fn(args), 'indisponivel', false, 'service 503 token')
    stub(t, json(502, null, 'text/html'))
    await expectError(t, fn(args), 'indisponivel', true, 'proxy page')
    stub(t, json(500, { error: 'algo' }))
    await expectError(t, fn(args), 'indisponivel', true, 'unknown token')
    stub(t, json(503, { error: 'resultado-incerto' }))
    await expectError(t, fn(args), 'indisponivel', true, 'resultado-incerto')
    stub(t, json(503, { error: 'carteira-incerta' }))
    await expectError(t, fn(args), 'carteira-incerta', false, 'frozen member: a known refusal')
    const sent = stub(t, () => { throw new Error('rede') })
    await expectError(t, fn(args), 'indisponivel', true, 'no answer')
    t.is(sent.length, 1, 'never retried')
    stub(t, json(200, null, 'text/html'))
    await expectError(t, fn(args), 'indisponivel', true, 'unreadable success')
    stub(t, json(400, { error: 'assinatura-invalida' }))
    await expectError(t, fn(args), 'assinatura-invalida', false)
    stub(t, json(403, { error: 'idade-minima' }))
    await expectError(t, fn(args), 'idade-minima', false)
    stub(t, json(409, { error: 'operacao-pendente' }))
    await expectError(t, fn(args), 'operacao-pendente', false, 'C9 refusal is definite')
  }
})

test('walletOptin/walletKycSubmit: an account view in the answer is shape-checked', async (t) => {
  const a = await load()
  const args = { member: M, nonce: NONCE, signature: SIG, op: {} }
  stub(t, json(200, { account: ACCOUNT }))
  t.alike(await a.walletOptin(args), { ok: true, account: ACCOUNT })
  stub(t, json(200, { account: { kyc: 'x' } }))
  t.alike(await a.walletOptin(args), { ok: true })
  const pending = { ...ACCOUNT, kyc: { state: 'pendente', attempt: 2 } }
  stub(t, json(200, { account: pending }))
  t.alike(await a.walletKycSubmit({ ...args, kyc: {} }), { ok: true, account: pending })
})

test('walletCreate: address only; 404 in cadastro is definite; the PIN is not kept (C11)', async (t) => {
  const a = await load()
  const args = { member: M, nonce: NONCE, signature: SIG, op: {}, pin: '135790' }
  stub(t, json(200, { address: ADDR, extra: 1 }))
  t.alike(await a.walletCreate(args), { address: ADDR })
  for (const body of [{}, { address: '0x' + 'A1'.repeat(20) }, { address: '0x12' }, { address: 5 }]) {
    stub(t, json(200, body))
    await expectError(t, a.walletCreate(args), 'indisponivel', true, JSON.stringify(body))
  }
  stub(t, json(404, { error: 'nao-encontrado' }))
  const e = await expectError(t, a.walletCreate(args), 'aguardando-carteira', false)
  t.absent(JSON.stringify(e).includes('135790'))
  t.absent(e.message.includes('135790'))
  for (const [status, token] of [[400, 'pin-invalido'], [429, 'pin-bloqueado'], [409, 'kyc-pendente'], [403, 'kyc-recusado']]) {
    stub(t, json(status, { error: token }))
    await expectError(t, a.walletCreate(args), token, false)
  }
  const calls = stub(t, json(200, { account: ACCOUNT }))
  await a.walletStatus({ member: M, nonce: NONCE, signature: SIG, op: {} })
  t.absent(calls[0].init.body.includes('135790'), 'a later call carries no PIN')
  t.absent(calls[0].init.body.includes('"kyc":{"fullName'), 'nor KYC fields')
})

test('walletStatus: the binding account shape, anything else refused (C14)', async (t) => {
  const a = await load()
  const args = { member: M, nonce: NONCE, signature: SIG, op: {} }
  stub(t, json(200, { account: null }))
  t.alike(await a.walletStatus(args), { account: null })
  stub(t, json(200, { account: { ...ACCOUNT, extra: 'x' } }))
  t.alike(await a.walletStatus(args), { account: ACCOUNT }, 'only known keys kept')
  const early = { ...ACCOUNT, kyc: { state: 'documentos', attempt: 2 }, address: null, wallet: null, documentReady: true, selfieReady: false }
  stub(t, json(200, { account: early }))
  t.alike(await a.walletStatus(args), { account: early })
  const lost = { ...early, kyc: { state: 'documentos', attempt: 0 }, subaccountUncertain: true }
  stub(t, json(200, { account: lost }))
  t.is((await a.walletStatus(args)).account.subaccountUncertain, true, 'a lost subaccount create is reported')
  for (const state of ['pendente', 'recusado', 'expirado']) {
    stub(t, json(200, { account: { ...early, kyc: { state, attempt: 0 } } }))
    t.is((await a.walletStatus(args)).account.kyc.state, state)
  }
  const { subaccountUncertain, ...noMarker } = ACCOUNT
  t.is(subaccountUncertain, false)
  const bad = [
    {},
    { account: undefined },
    { account: noMarker },
    { account: { ...ACCOUNT, subaccountUncertain: 'true' } },
    { account: { ...ACCOUNT, kyc: { state: 'nenhum', attempt: 1 } } },
    { account: { ...ACCOUNT, kyc: { state: 'aprovado' } } },
    { account: { ...ACCOUNT, kyc: { state: 'aprovado', attempt: -1 } } },
    { account: { ...ACCOUNT, kyc: { state: 'aprovado', attempt: 1.5 } } },
    { account: { ...ACCOUNT, kyc: 'aprovado' } },
    { account: { ...ACCOUNT, address: '0x' + 'A1'.repeat(20) } },
    { account: { ...ACCOUNT, address: '0x12' } },
    { account: { ...ACCOUNT, wallet: { address: 'x' } } },
    { account: { ...ACCOUNT, wallet: true } },
    { account: { ...ACCOUNT, walletUncertain: 'false' } },
    { account: { ...ACCOUNT, documentReady: 1 } },
    { account: { ...ACCOUNT, selfieReady: undefined } },
    { account: { ...ACCOUNT, network: 5 } },
    { account: [] }
  ]
  for (const body of bad) {
    stub(t, json(200, body))
    await expectError(t, a.walletStatus(args), 'indisponivel', false, JSON.stringify(body))
  }
  stub(t, json(400, { error: 'nao-vinculado' }))
  await expectError(t, a.walletStatus(args), 'nao-vinculado', false)
  stub(t, json(403, { error: 'termos-pendentes' }))
  await expectError(t, a.walletStatus(args), 'termos-pendentes', false)
})

test('walletKycDocument: exact Hodle hosts only, the back URL when double sided', async (t) => {
  const a = await load()
  const args = { member: M, nonce: NONCE, signature: SIG }
  stub(t, json(200, { documentId: 'd1', uploadUrlFront: UP_FRONT }))
  t.alike(await a.walletKycDocument({ ...args, op: { documentType: 'ID', isDoubleSided: 0 } }), { uploadUrlFront: UP_FRONT })
  stub(t, json(200, { uploadUrlFront: UP_FRONT, uploadUrlBack: UP_BACK }))
  t.alike(await a.walletKycDocument({ ...args, op: { documentType: 'ID', isDoubleSided: 1 } }), { uploadUrlFront: UP_FRONT, uploadUrlBack: UP_BACK })
  stub(t, json(200, { uploadUrlFront: UP_FRONT }))
  await expectError(t, a.walletKycDocument({ ...args, op: { documentType: 'ID', isDoubleSided: 1 } }), 'indisponivel', true, 'missing back')
  stub(t, json(200, { livenessUrl: LIVE }))
  t.alike(await a.walletKycDocument({ ...args, op: { documentType: 'SELFIE-FROM-LIVENESS' } }), { livenessUrl: LIVE })
  const badUploads = [
    'http://uploads.hodle.com.br/u', 'https://uploads.hodle.com.br.evil.test/u', 'https://evil.uploads.hodle.com.br/u',
    'https://user@uploads.hodle.com.br/u', 'https://uploads.hodle.com.br:8443/u', 'https://app.hodle.com.br/u', 5, null
  ]
  for (const url of badUploads) {
    stub(t, json(200, { uploadUrlFront: url }))
    await expectError(t, a.walletKycDocument({ ...args, op: { documentType: 'ID' } }), 'indisponivel', true, String(url))
  }
  for (const url of [UP_FRONT, 'http://app.hodle.com.br/l', 'https://app.hodle.com.br.evil.test/l', 'javascript:alert(1)']) {
    stub(t, json(200, { livenessUrl: url }))
    await expectError(t, a.walletKycDocument({ ...args, op: { documentType: 'SELFIE-FROM-LIVENESS' } }), 'indisponivel', true, String(url))
  }
  stub(t, json(429, { error: 'limite-carteira' }))
  await expectError(t, a.walletKycDocument({ ...args, op: { documentType: 'ID' } }), 'limite-carteira', false)
})

test('wallet errors never echo the response body', async (t) => {
  const a = await load()
  const args = { member: M, nonce: NONCE, signature: SIG, op: {} }
  const secret = 'segredo-no-corpo'
  for (const fn of [a.walletOptin, a.walletStatus, a.walletKycDocument, a.walletKycSubmit, a.walletCreate]) {
    stub(t, json(500, { error: secret, detail: secret }))
    try { await fn(args); t.fail() } catch (e) {
      t.absent(e.message.includes(secret))
      t.absent(JSON.stringify(e).includes(secret))
    }
  }
})

test('kycHash: SHA-256 of the canonical JSON, the pinned C16 vector', async (t) => {
  const { kycHash } = await load()
  const { createHash } = require('crypto')
  const input = Object.freeze({ z: 'fim', á: 'ação', a: 'linha\n"aspas"', 2: 'dois', 10: 'dez', '😀': 'rosto', '': 'privado' })
  t.is(await kycHash(input), '000885f86d0a62f19f7a29a0d3ab17994d8316253310494a9fd57f7780717333')
  t.is(await kycHash({ b: '2', a: '1' }), createHash('sha256').update('{"a":"1","b":"2"}', 'utf8').digest('hex'))
  await t.exception.all(kycHash({ a: 1 }), TypeError)
})

test('uploadDocument: PUT raw bytes to the exact upload host, no credentials, no redirects', async (t) => {
  const { uploadDocument } = await load()
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' })
  const calls = stub(t, { ok: true, status: 200, headers: { get: () => '' }, text: async () => '' })
  await uploadDocument(UP_FRONT, blob)
  t.is(calls.length, 1)
  t.is(calls[0].url, UP_FRONT)
  t.is(calls[0].init.method, 'PUT')
  t.is(calls[0].init.body, blob)
  t.is(calls[0].init.headers['content-type'], 'image/jpeg')
  t.is(calls[0].init.credentials, 'omit')
  t.is(calls[0].init.redirect, 'error')
  t.ok(calls[0].init.signal)
  const png = new Blob([new Uint8Array([0x89])], { type: 'image/png' })
  await uploadDocument(UP_FRONT, png)
  t.is(calls[1].init.headers['content-type'], 'image/png')
})

test('uploadDocument: refuses types, sizes and hosts without calling fetch; non-2xx fails', async (t) => {
  const { uploadDocument } = await load()
  const calls = stub(t, { ok: true, status: 200, headers: { get: () => '' }, text: async () => '' })
  const jpeg = new Blob([new Uint8Array([1])], { type: 'image/jpeg' })
  for (const blob of [new Blob([new Uint8Array([1])], { type: 'image/gif' }), new Blob([new Uint8Array([1])]),
    new Blob([], { type: 'image/jpeg' }), { type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 }, null, 'x']) {
    await t.exception(uploadDocument(UP_FRONT, blob), /arquivo inválido/)
  }
  for (const url of ['http://uploads.hodle.com.br/u', 'https://uploads.hodle.com.br.evil.test/u', 'https://x.uploads.hodle.com.br/u',
    'https://app.hodle.com.br/u', 'https://u:p@uploads.hodle.com.br/u', 'https://uploads.hodle.com.br:444/u', '/account/x', 5]) {
    await t.exception(uploadDocument(url, jpeg), String(url))
  }
  t.is(calls.length, 0, 'fetch never called')
  for (const status of [301, 403, 500]) {
    stub(t, { ok: status < 400, status, headers: { get: () => '' }, text: async () => 'corpo' })
    try { await uploadDocument(UP_FRONT, jpeg); t.fail() } catch (e) {
      t.is(e.code, 'indisponivel')
      t.absent(e.message.includes('corpo'))
    }
  }
  stub(t, () => { throw new Error('rede') })
  try { await uploadDocument(UP_FRONT, jpeg); t.fail() } catch (e) { t.is(e.code, 'indisponivel') }
})

test('wallet 404s: only nao-encontrado on wallet-create means cadastro; expirado stays expirado', async (t) => {
  const a = await load()
  const args = { member: M, nonce: NONCE, signature: SIG, op: {} }
  stub(t, json(404, { error: 'expirado' }))
  await expectError(t, a.walletCreate({ ...args, pin: '135790' }), 'expirado', false, 'expired nonce on create')
  stub(t, json(404, { error: 'expirado' }))
  await expectError(t, a.walletStart({ member: M, action: 'wallet-create' }), 'expirado', false, 'expired on start')
  for (const fn of [a.walletOptin, a.walletKycDocument, a.walletKycSubmit, a.walletStatus]) {
    stub(t, json(404, { error: 'expirado' }))
    await expectError(t, fn(args), 'expirado', false, 'expired nonce')
    stub(t, json(404, { error: 'nao-encontrado' }))
    await expectError(t, fn(args), 'indisponivel', false, 'not mounted elsewhere')
  }
  for (const body of [{ error: 'outro' }, {}, null]) {
    stub(t, json(404, body))
    await expectError(t, a.walletCreate({ ...args, pin: '135790' }), 'indisponivel', false, JSON.stringify(body))
  }
  stub(t, json(404, null, 'text/html'))
  await expectError(t, a.walletCreate({ ...args, pin: '135790' }), 'indisponivel', false, 'an HTML 404')
  stub(t, json(404, { error: 'nao-encontrado' }))
  await expectError(t, a.walletCreate({ ...args, pin: '135790' }), 'aguardando-carteira', false)
  stub(t, json(404, { error: 'expirado' }))
  t.is(await a.readPending(), null, 'non-wallet allow404 unchanged')
})

test('wallet bodies may reach 16 KiB; other calls keep the 4 KiB limit', async (t) => {
  const a = await load()
  const front = 'https://uploads.hodle.com.br/u/front?sig=' + 'a'.repeat(4000)
  const back = 'https://uploads.hodle.com.br/u/back?sig=' + 'b'.repeat(4000)
  const body = { documentId: 'd1', uploadUrlFront: front, uploadUrlBack: back, pad: 'x'.repeat(2200) }
  t.ok(JSON.stringify(body).length > 10 * 1024)
  stub(t, json(200, body))
  t.alike(await a.walletKycDocument({ member: M, nonce: NONCE, signature: SIG, op: { documentType: 'ID', isDoubleSided: 1 } }), { uploadUrlFront: front, uploadUrlBack: back })
  stub(t, json(200, { nonce: 'n1', pad: 'x'.repeat(10 * 1024) }))
  await expectError(t, a.termsStart({ member: M, version: 1 }), 'indisponivel', false, 'non-wallet 10 KiB body refused')
  stub(t, json(200, { documentId: 'd1', uploadUrlFront: front, pad: 'x'.repeat(16 * 1024) }))
  await expectError(t, a.walletKycDocument({ member: M, nonce: NONCE, signature: SIG, op: { documentType: 'ID' } }), 'indisponivel', true, 'over 16 KiB')
})
