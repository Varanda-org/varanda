// The pages client (src/pages.js). ES module loaded through import(); fetch
// and the node are stubbed, nothing touches the network.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

test('page settings stack every confirmation above cancellation', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/PaginaAjustes.js'), 'utf8')
  const stacks = [...src.matchAll(/<ConfirmStack\s+confirm=\{([\s\S]*?)\s+cancel=\{(<Btn[^\n]+)\n\s+\/>/g)]
  t.is(stacks.length, 4, 'remove, transfer, move and close each have a stack')
  for (const [label, action, pending] of [
    ['Remover', '() => remove(confirm.key)', 'removeAct.pending'],
    ['Transferir', 'transfer', 'transferAct.pending'],
    ['Mudar a chave', 'movePage', 'lifeAct.pending'],
    ['Encerrar de vez', 'closePage', 'lifeAct.pending']
  ]) {
    const stack = stacks.find((m) => m[1].includes("label='" + label + "'"))
    t.ok(stack && stack[1].includes('onPress={' + action + '} pending={' + pending + '}'), label + ' retains its action and pending state')
    t.ok(stack && stack[2].includes("label='Cancelar' secondary") && stack[2].includes('disabled={' + pending + '}'), label + ' keeps cancellation below and disabled while pending')
  }
  const close = stacks.find((m) => m[1].includes("label='Encerrar de vez'"))
  t.ok(close && close[1].includes("life.step === 1\n                              ? <Btn label='Continuar'"), 'closing still asks twice in the same stack')
})

const load = () => import('../src/pages.js')
const loadAccount = () => import('../src/account.js')
// A core node counts only where the bundle can reach the account origin
// (src/pageReach.*.js): on for the test, off again after it.
const reachOn = async (t) => {
  const { setCoreReach } = await import('../src/pageGate.js')
  setCoreReach(true)
  t.teardown(() => setCoreReach(false))
}
const M = 'ab'.repeat(32)
const P = 'cd'.repeat(32)
const K2 = 'ef'.repeat(32)
const NONCE = 'n'.repeat(43)
const SIG = 'a1'.repeat(64)

function stub (t, res) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const r = typeof res === 'function' ? res(calls.length, url, init) : res
    if (r instanceof Error) throw r
    return r
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
const body = (call) => JSON.parse(call.init.body)

// brittle's t.exception resolves to nothing; these tests read the error.
async function caught (t, promise) {
  try { await promise } catch (err) { t.pass('rejected'); return err }
  t.fail('did not reject')
  return {}
}

// A node whose page.sign answers by action, recording every call.
function fakeNode (answers = {}) {
  const signs = []
  return {
    signs,
    request: async (method, params) => {
      signs.push({ method, params })
      const a = answers[params.action]
      if (a instanceof Error) throw a
      return a || { signature: SIG }
    }
  }
}

// start answers { nonce }; every other call answers what `then` says.
const flow = (then, extra = {}) => (n) => n === 1 ? json(200, { nonce: NONCE, ...extra }) : then(n)

test('lookupUsername keeps kind, closed and movedTo', async (t) => {
  const { lookupUsername } = await loadAccount()
  stub(t, json(200, { member: P, username: 'padaria', kind: 'page', closed: true, movedTo: K2 }))
  const found = await lookupUsername('padaria')
  t.is(found.kind, 'page')
  t.is(found.closed, true)
  t.is(found.movedTo, K2)
})

test('pageError maps tokens to pt-BR and everything else to unavailable', async (t) => {
  const { pageError, TEXTS } = await load()
  t.is(pageError('sem-permissao').message, 'Só o dono pode fazer isso')
  t.is(pageError('nome-em-uso').message, 'Esse @nome já está em uso')
  t.is(pageError('expirado').message, 'Convite ou oferta expirada')
  t.is(pageError('pausada').message, 'Página pausada; fale com a associação')
  t.is(pageError('encerrada').message, 'Esta página foi encerrada')
  t.is(pageError('midia-invalida').message, 'Foto não aceita')
  t.is(pageError('limite').message, 'Limite atingido')
  t.is(pageError('termos-pendentes').message, 'Aceite os Termos para continuar')
  t.is(pageError('<script>').code, 'indisponivel')
  t.is(pageError('__proto__').code, 'indisponivel')
  t.is(pageError('troca-bloqueada', '2026-01-02T12:00:00.000Z').code, 'troca-bloqueada')
  t.ok(pageError('troca-bloqueada', '2026-01-02T12:00:00.000Z').message.startsWith('Você poderá trocar de novo em '))
  for (const text of Object.values(TEXTS)) t.absent(text.includes(String.fromCharCode(0x2014)), text)
  t.is(TEXTS['nao-vinculado'], 'Termine o cadastro em Ajustes → Conta e @nome.')
  t.absent(TEXTS['nao-vinculado'].includes('Google'))
})

test('policy: available, off, older service and failure all answer a plain object', async (t) => {
  const { pagesPolicy } = await load()
  const calls = stub(t, json(200, { available: true, maxOwned: 8, maxAdmins: 16, junk: 1 }))
  t.alike(await pagesPolicy(), { available: true, maxOwned: 8, maxAdmins: 16 })
  t.is(calls[0].init.method, 'GET')
  t.ok(calls[0].url.endsWith('/account/pages/policy'))
  stub(t, json(200, { available: false }))
  t.alike(await pagesPolicy(), { available: false })
  stub(t, json(404, { error: 'nao-encontrado' }))
  t.alike(await pagesPolicy(), { available: false })
  stub(t, new Error('offline'))
  t.alike(await pagesPolicy(), { available: false })
})

test('start posts member and action; create reads back the new page key', async (t) => {
  const { pagesStart } = await load()
  const calls = stub(t, json(200, { nonce: NONCE, page: P }))
  t.alike(await pagesStart({ member: M, action: 'create' }), { nonce: NONCE, page: P })
  t.ok(calls[0].url.endsWith('/account/pages/start'))
  t.alike(body(calls[0]), { member: M, action: 'create' })
  stub(t, json(200, {}))
  await caught(t, pagesStart({ member: M, action: 'post', page: P }))
})

test('statement: start, page.sign, POST with member, nonce, page, op and signature', async (t) => {
  const { actAs } = await load()
  const calls = stub(t, flow(() => json(200, { seq: 3, length: 4, pushed: true })))
  const node = fakeNode()
  const res = await actAs(node, { member: M, action: 'post', page: P, op: { text: 'Abrimos às 7h' } })
  t.alike(res, { seq: 3, length: 4, pushed: true })
  t.is(calls.length, 2)
  t.alike(body(calls[0]), { member: M, action: 'post', page: P })
  t.ok(calls[1].url.endsWith('/account/pages/post'))
  t.is(calls[1].init.method, 'POST')
  t.alike(body(calls[1]), { member: M, nonce: NONCE, page: P, op: { text: 'Abrimos às 7h' }, signature: SIG })
  t.alike(node.signs[0], { method: 'page.sign', params: { action: 'post', nonce: NONCE, page: P, op: { text: 'Abrimos às 7h' } } })
})

test('post, reply and quote carry 1..10 media descriptors, never more', async (t) => {
  const { actAs, MAX_MEDIA_PER_POST } = await load()
  t.is(MAX_MEDIA_PER_POST, 10)
  const d = { sha256: 'a'.repeat(64), mime: 'image/png', width: 1, height: 1, bytes: 10 }
  const ten = Array(10).fill(d)
  const calls = stub(t, (n, url) => url.endsWith('/start') ? json(200, { nonce: NONCE }) : json(200, { seq: 1, length: 2, pushed: true }))
  await actAs(fakeNode(), { member: M, action: 'reply', page: P, op: { to: M + ':1', text: 'ok', media: [d] } })
  t.alike(body(calls[1]).op.media, [d])
  for (const action of ['post', 'reply', 'quote']) {
    const before = calls.length
    await actAs(fakeNode(), { member: M, action, page: P, op: { text: 'x', media: ten } })
    t.is(body(calls[before + 1]).op.media.length, 10, action + ' accepts 10')
  }
  for (const media of [[], [...ten, d], 'x']) {
    const before = calls.length
    const err = await caught(t, actAs(fakeNode(), { member: M, action: 'post', page: P, op: { text: 'x', media } }))
    t.is(err.code, 'pedido-invalido')
    t.is(calls.length, before, 'nothing is sent')
  }
})

test('listing actions reach the signer and post to their own route', async (t) => {
  const { actAs } = await load()
  const place = { uf: 'SP', city: 'Campinas', bairro: null }
  const ops = {
    listing: { kind: 'produto', title: 'Bicicleta', text: '', price: 10000, unit: null, cat: 'esporte', place },
    'listing-edit': { to: P + ':3', expectedRevision: 0, title: 'Bicicleta', text: '', price: 9000, unit: null, cat: 'esporte', place, media: null },
    'listing-status': { to: P + ':3', status: 'reservado' },
    'listing-consent': { to: P + ':3', rater: M, offer: 'f'.repeat(32) }
  }
  for (const action of Object.keys(ops)) {
    const calls = stub(t, flow(() => json(200, action === 'listing-consent' ? { consent: 'c'.repeat(128) } : { seq: 4, length: 5, pushed: true })))
    const node = fakeNode()
    const res = await actAs(node, { member: M, action, page: P, op: ops[action] })
    t.alike(body(calls[0]), { member: M, action, page: P })
    t.ok(calls[1].url.endsWith('/account/pages/' + action), action + ' route')
    t.alike(body(calls[1]).op, ops[action])
    t.alike(node.signs[0], { method: 'page.sign', params: { action, nonce: NONCE, page: P, op: ops[action] } })
    t.alike(res, action === 'listing-consent' ? { consent: 'c'.repeat(128) } : { seq: 4, length: 5, pushed: true })
  }
})

test('listing and listing-edit carry 1..4 media descriptors; listing-edit may clear them with null', async (t) => {
  const { actAs } = await load()
  const d = { sha256: 'a'.repeat(64), mime: 'image/png', width: 1, height: 1, bytes: 10 }
  const calls = stub(t, (n, url) => url.endsWith('/start') ? json(200, { nonce: NONCE }) : json(200, { seq: 1, length: 2, pushed: true }))
  for (const action of ['listing', 'listing-edit']) {
    const before = calls.length
    await actAs(fakeNode(), { member: M, action, page: P, op: { title: 'x', media: [d, d] } })
    t.alike(body(calls[before + 1]).op.media, [d, d], action + ' sends its media')
    const fourAt = calls.length
    await actAs(fakeNode(), { member: M, action, page: P, op: { title: 'x', media: [d, d, d, d] } })
    t.is(body(calls[fourAt + 1]).op.media.length, 4, action + ' accepts 4')
    for (const media of [[], [d, d, d, d, d], 'x']) {
      const n = calls.length
      const err = await caught(t, actAs(fakeNode(), { member: M, action, page: P, op: { title: 'x', media } }))
      t.is(err.code, 'pedido-invalido', Array.isArray(media) && media.length === 5 ? '5 photos are refused' : 'nothing valid')
      t.is(calls.length, n, 'nothing is sent')
    }
  }
  const n = calls.length
  await actAs(fakeNode(), { member: M, action: 'listing-edit', page: P, op: { title: 'x', media: null } })
  t.is(body(calls[n + 1]).op.media, null)
  const err = await caught(t, actAs(fakeNode(), { member: M, action: 'listing', page: P, op: { title: 'x', media: null } }))
  t.is(err.code, 'pedido-invalido', 'a new listing never takes null media')
})

test('a listing write with an unknown outcome is uncertain and never resent by itself', async (t) => {
  const { actAs } = await load()
  for (const action of ['listing', 'listing-edit', 'listing-status', 'listing-consent']) {
    const calls = stub(t, flow(() => json(500, {})))
    const node = fakeNode()
    const err = await caught(t, actAs(node, { member: M, action, page: P, op: { to: P + ':3' } }))
    t.is(err.uncertain, true, action + ' is uncertain')
    t.is(calls.length, 2, 'one start and one POST, no automatic resend')
    t.is(node.signs.length, 1, 'signed once')
  }
})

test('op shapes of like, delete, profile, rename, follow and the reads are sent as given', async (t) => {
  const { actAs } = await load()
  const cases = [
    ['like', { to: M + ':2', on: true }],
    ['repost', { to: M + ':2', on: false }],
    ['delete', { to: '5' }],
    ['profile', { name: 'Padaria', bio: 'Pão', avatar: undefined }],
    ['rename', { username: 'padaria' }],
    ['follow', { key: K2, on: true }],
    ['status', {}]
  ]
  for (const [action, op] of cases) {
    const calls = stub(t, flow(() => json(200, {})))
    await actAs(fakeNode(), { member: M, action, page: P, op })
    t.ok(calls[1].url.endsWith('/account/pages/' + action), action)
    t.alike(body(calls[1]).op, JSON.parse(JSON.stringify(op)), action)
  }
})

test('offer-cancel is no action: the cancel is the signed offer record', async (t) => {
  const { actAs } = await load()
  const calls = stub(t, flow(() => json(200, {})))
  const err = await caught(t, actAs(fakeNode(), { member: M, action: 'offer-cancel', page: P, op: {} }))
  t.is(err.code, 'pedido-invalido')
  t.is(calls.length, 0, 'nothing is sent')
})

test('list and terms are pageless: no page in the POST, sign gets an empty page', async (t) => {
  const { actAs } = await load()
  const calls = stub(t, flow(() => json(200, { pages: [] })))
  const node = fakeNode()
  await actAs(node, { member: M, action: 'list' })
  t.is(Object.hasOwn(body(calls[1]), 'page'), false)
  t.is(node.signs[0].params.page, '')
  await caught(t, actAs(node, { member: M, action: 'post', page: '', op: { text: 'x' } }))
})

test('create: start returns the page key, POST carries op, signature and the genesis record', async (t) => {
  const { actAs } = await load()
  const record = { type: 'page-roster', gen: 1, signature: 'b'.repeat(128) }
  const calls = stub(t, flow(() => json(200, { page: P }), { page: P }))
  const node = fakeNode({ create: { signature: SIG, record } })
  const op = { username: 'padaria', name: 'Padaria', bio: '', roster: { gen: 1, admins: [], prev: null, at: 'x', nonce: NONCE } }
  await actAs(node, { member: M, action: 'create', op })
  t.is(node.signs[0].params.page, P)
  t.alike(body(calls[1]), { member: M, nonce: NONCE, page: P, op, signature: SIG, record })
})

test('create without a page key from start does not sign', async (t) => {
  const { actAs } = await load()
  stub(t, flow(() => json(200, {})))
  const node = fakeNode()
  const err = await caught(t, actAs(node, { member: M, action: 'create', op: {} }))
  t.is(err.code, 'indisponivel')
  t.is(node.signs.length, 0)
})

test('invite sends the roster signature the node computed inside the op', async (t) => {
  const { actAs } = await load()
  const rs = 'c'.repeat(128)
  const record = { type: 'page-roster', signature: rs }
  const calls = stub(t, flow(() => json(200, { seq: 1 })))
  const node = fakeNode({ invite: { signature: SIG, record } })
  const op = { member: K2, gen: 2, rosterSignature: '', roster: { owner: M, admins: [K2], prev: 1, at: 'x', nonce: NONCE } }
  await actAs(node, { member: M, action: 'invite', page: P, op })
  t.is(node.signs[0].params.op.rosterSignature, '', 'the node gets the op as built')
  t.alike(body(calls[1]), { member: M, nonce: NONCE, page: P, record, op: { ...op, rosterSignature: rs }, signature: SIG })
})

test('record actions send the signed record', async (t) => {
  const { actAs } = await load()
  for (const action of ['accept', 'remove', 'offer', 'transfer-accept', 'close']) {
    const record = { type: 'page-' + action, signature: 'd'.repeat(128) }
    const calls = stub(t, flow(() => json(200, { seq: 2 })))
    const node = fakeNode({ [action]: { record } })
    await actAs(node, { member: M, action, page: P, op: ({ nonce }) => ({ gen: 2, nonce }) })
    t.ok(calls[1].url.endsWith('/account/pages/' + action), action)
    t.alike(body(calls[1]), { member: M, nonce: NONCE, page: P, record }, action)
    t.alike(node.signs[0].params.op, { gen: 2, nonce: NONCE }, 'op built from the minted nonce')
  }
})

test('pagesClose builds the op from the nonce; pagesMove returns the new key', async (t) => {
  const { pagesClose, pagesMove } = await load()
  let calls = stub(t, flow(() => json(200, { seq: 9 })))
  let node = fakeNode({ close: { record: { type: 'page-close' } } })
  await pagesClose(node, { member: M, page: P, gen: 4, at: '2026-01-01T00:00:00.000Z' })
  t.alike(node.signs[0].params.op, { gen: 4, at: '2026-01-01T00:00:00.000Z', nonce: NONCE })
  t.ok(calls[1].url.endsWith('/account/pages/close'))

  const moved = { record: { type: 'page-moved' }, origin: { type: 'page-origin' }, roster: { type: 'page-roster' } }
  calls = stub(t, flow(() => json(200, { seq: 9 }), { page: K2 }))
  node = fakeNode({ move: moved })
  const key = await pagesMove(node, { member: M, page: P, op: ({ nonce, to }) => ({ to, gen: 3, fromSeq: 7, owner: M, admins: [], at: 'x', nonce }) })
  t.is(key, K2)
  t.is(node.signs[0].params.op.to, K2)
  t.ok(calls[1].url.endsWith('/account/pages/move'))
  t.alike(body(calls[1]), { member: M, nonce: NONCE, page: P, record: moved.record, origin: moved.origin, roster: moved.roster })
})

test('close and move: encerrada, movida and the daily limit in pt-BR', async (t) => {
  const { pagesClose, pagesMove, pageError, TEXTS, LIFECYCLE_LIMIT } = await load()
  t.is(TEXTS.movida, 'Esta página mudou para uma nova chave')
  t.is(pageError('movida').message, 'Esta página mudou para uma nova chave')
  t.is(pageError('encerrada').code, 'encerrada')
  t.is(LIFECYCLE_LIMIT, 'Limite de mudanças atingido, tente amanhã')
  t.absent(LIFECYCLE_LIMIT.includes(String.fromCharCode(0x2014)))

  stub(t, flow(() => json(429, { error: 'limite' })))
  let err = await caught(t, pagesClose(fakeNode({ close: { record: { type: 'page-close' } } }), { member: M, page: P, gen: 4 }))
  t.is(err.code, 'limite')
  t.is(err.message, LIFECYCLE_LIMIT)
  t.absent(err.uncertain)

  const moved = { record: { type: 'page-moved' }, origin: { type: 'page-origin' }, roster: { type: 'page-roster' } }
  stub(t, flow(() => json(429, { error: 'limite' }), { page: K2 }))
  err = await caught(t, pagesMove(fakeNode({ move: moved }), { member: M, page: P, op: ({ nonce, to }) => ({ to, nonce }) }))
  t.is(err.message, LIFECYCLE_LIMIT)

  stub(t, flow(() => json(409, { error: 'movida' })))
  err = await caught(t, pagesClose(fakeNode({ close: { record: { type: 'page-close' } } }), { member: M, page: P, gen: 4 }))
  t.is(err.code, 'movida')
  t.is(err.message, 'Esta página mudou para uma nova chave')
  // Elsewhere 'limite' keeps its generic text.
  t.is(pageError('limite').message, 'Limite atingido')
})

test('follow, follows, notices, terms and group ops', async (t) => {
  const { pagesFollow, pagesFollows, pagesNotices, pagesTerms, pagesGroup } = await load()
  let calls = stub(t, flow(() => json(200, { seq: 1 })))
  await pagesFollow(fakeNode(), { member: M, page: P, key: K2, on: true })
  t.ok(calls[1].url.endsWith('/account/pages/follow'))
  t.alike(body(calls[1]).op, { key: K2, on: true })

  calls = stub(t, flow(() => json(200, { follows: [{ key: K2, seq: 4 }] })))
  t.alike(await pagesFollows(fakeNode(), { member: M, page: P }), [{ key: K2, seq: 4 }])
  t.ok(calls[1].url.endsWith('/account/pages/follows'))
  t.alike(body(calls[1]).op, {})

  calls = stub(t, flow(() => json(200, { items: [] })))
  await pagesNotices(fakeNode(), { member: M, page: P, limit: 20 })
  t.ok(calls[1].url.endsWith('/account/pages/notices'))
  t.alike(body(calls[1]).op, { limit: 20 })

  calls = stub(t, flow(() => json(200, { version: 11 })))
  await pagesTerms(fakeNode(), { member: M })
  t.is(Object.hasOwn(body(calls[1]), 'page'), false)

  for (const action of ['community-join', 'community-leave', 'group-join', 'group-leave', 'group-post', 'group-read', 'group-seal', 'group-rebox']) {
    calls = stub(t, flow(() => json(200, {})))
    await pagesGroup(fakeNode(), { member: M, page: P, action, op: { group: K2 } })
    t.ok(calls[1].url.endsWith('/account/pages/' + action), action)
    t.alike(body(calls[1]).op, { group: K2 })
  }
  const err = await caught(t, pagesGroup(fakeNode(), { member: M, page: P, action: 'post', op: {} }))
  t.is(err.code, 'pedido-invalido')
})

test('group-seal sends the sealed envelope as is; its refusals keep their codes', async (t) => {
  const { pagesGroup } = await load()
  const op = { group: K2, kid: { writer: K2, seq: 3 }, nonce: 'n'.repeat(32), box: 'b'.repeat(64), at: '2026-11-09T12:00:00.000Z', writer: K2, seq: 7 }
  const calls = stub(t, flow(() => json(200, { seq: 7 })))
  t.alike(await pagesGroup(fakeNode(), { member: M, page: P, action: 'group-seal', op }), { seq: 7 })
  t.ok(calls[1].url.endsWith('/account/pages/group-seal'))
  t.alike(body(calls[1]).op, op)
  for (const [code, message] of [
    ['sequencia', 'Alguém publicou antes; toque para enviar de novo'],
    ['aguardando-chave', 'aguardando nova chave'],
    ['privado', 'Este grupo é privado: a mensagem precisa ser cifrada neste aparelho']
  ]) {
    stub(t, flow(() => json(409, { error: code })))
    const err = await caught(t, pagesGroup(fakeNode(), { member: M, page: P, action: 'group-seal', op }))
    t.is(err.code, code)
    t.is(err.message, message)
    t.is(err.uncertain === true, false, code + ' is a refusal')
  }
})

test('successor is a plain GET with no body and null when there is none', async (t) => {
  const { pagesSuccessor } = await load()
  let calls = stub(t, json(200, { to: K2 }))
  t.alike(await pagesSuccessor(P), { to: K2 })
  t.is(calls[0].init.method, 'GET')
  t.is(calls[0].init.body, undefined)
  t.ok(calls[0].url.endsWith('/account/pages/successor/' + P))
  calls = stub(t, json(404, { error: 'nao-encontrado' }))
  t.is(await pagesSuccessor(P), null)
  const err = await caught(t, pagesSuccessor('../x'))
  t.is(err.code, 'pedido-invalido')
  t.is(calls.length, 1, 'a bad key sends nothing')
})

test('media: raw body, octet-stream, statement in x-varanda-page-* headers', async (t) => {
  const { pagesMedia } = await load()
  const bytes = new Uint8Array([1, 2, 3])
  const op = { sha256: 'a'.repeat(64), mime: 'image/png', width: 1, height: 1, bytes: 3 }
  const calls = stub(t, json(200, { descriptor: { sha256: op.sha256 } }))
  const res = await pagesMedia({ member: M, nonce: NONCE, page: P, op, signature: SIG, bytes })
  t.alike(res, { descriptor: { sha256: op.sha256 } })
  const { init, url } = calls[0]
  t.ok(url.endsWith('/account/pages/media'))
  t.is(init.body, bytes)
  t.is(init.headers['content-type'], 'application/octet-stream')
  t.is(init.headers['x-varanda-page-member'], M)
  t.is(init.headers['x-varanda-page-nonce'], NONCE)
  t.is(init.headers['x-varanda-page-page'], P)
  t.is(init.headers['x-varanda-page-signature'], SIG)
  t.alike(JSON.parse(init.headers['x-varanda-page-op']), op)
})

test('media over 256 blocks is refused before anything is sent', async (t) => {
  const { pagesMedia, pagesAvatar, MAX_MEDIA_BYTES, MAX_AVATAR_BYTES } = await load()
  const calls = stub(t, json(200, {}))
  const args = { member: M, nonce: NONCE, page: P, op: {}, signature: SIG }
  t.is(MAX_MEDIA_BYTES, 256 * 32768)
  const a = await caught(t, pagesMedia({ ...args, bytes: new Uint8Array(MAX_MEDIA_BYTES + 1) }))
  t.is(a.code, 'midia-invalida')
  const b = await caught(t, pagesAvatar({ ...args, bytes: new Uint8Array(MAX_AVATAR_BYTES + 1) }))
  t.is(b.code, 'midia-invalida')
  const c = await caught(t, pagesMedia({ ...args, bytes: new Uint8Array(0) }))
  t.is(c.code, 'midia-invalida')
  t.is(calls.length, 0)
})

test('avatar header op stays valid JSON with accents and parses back to the same op', async (t) => {
  const { pagesAvatar } = await load()
  const op = { sha256: 'a'.repeat(64), mime: 'image/jpeg', bytes: 3, name: 'Pão de Açúcar \u{1F35E}', bio: 'Padaria' }
  const calls = stub(t, json(200, { seq: 1 }))
  await pagesAvatar({ member: M, nonce: NONCE, page: P, op, signature: SIG, bytes: new Uint8Array(3) })
  const header = calls[0].init.headers['x-varanda-page-op']
  t.ok(/^[ -~]*$/.test(header), 'ASCII only on the wire')
  t.alike(JSON.parse(header), op)
})

test('a refusal token maps to its pt-BR text and is never uncertain', async (t) => {
  const { actAs } = await load()
  for (const [status, token, text] of [
    [403, 'sem-permissao', 'Só o dono pode fazer isso'],
    [409, 'nome-em-uso', 'Esse @nome já está em uso'],
    [403, 'pausada', 'Página pausada; fale com a associação'],
    [403, 'encerrada', 'Esta página foi encerrada'],
    [400, 'midia-invalida', 'Foto não aceita'],
    [403, 'termos-pendentes', 'Aceite os Termos para continuar'],
    [503, 'indisponivel', 'Serviço indisponível']
  ]) {
    stub(t, flow(() => json(status, { error: token })))
    const err = await caught(t, actAs(fakeNode(), { member: M, action: 'post', page: P, op: { text: 'x' } }))
    t.is(err.code, token)
    t.is(err.message, text)
    t.absent(err.uncertain, token + ' is a refusal')
    t.absent(err.retry)
  }
})

test('uncertain only after a signature: start and sign failures are plain errors', async (t) => {
  const { actAs } = await load()
  stub(t, new Error('offline'))
  const node = fakeNode()
  const a = await caught(t, actAs(node, { member: M, action: 'post', page: P, op: { text: 'x' } }))
  t.absent(a.uncertain)
  t.is(node.signs.length, 0)

  stub(t, flow(() => json(200, {})))
  const boom = new Error('identidade bloqueada: entre com a passkey')
  const b = await caught(t, actAs(fakeNode({ post: boom }), { member: M, action: 'post', page: P, op: { text: 'x' } }))
  t.is(b, boom)
  t.absent(b.uncertain)
})

test('after a signature: no answer, 5xx, 202 and an unreadable success are uncertain with retry', async (t) => {
  const { actAs } = await load()
  const outcomes = [
    () => new Error('offline'),
    () => json(500, {}),
    () => json(502, { error: 'whatever' }),
    () => json(202, { uncertain: true }),
    () => json(200, { uncertain: true }),
    () => json(200, {}, 'text/html')
  ]
  for (const out of outcomes) {
    stub(t, flow(out))
    const err = await caught(t, actAs(fakeNode(), { member: M, action: 'post', page: P, op: { text: 'x' } }))
    t.is(err.uncertain, true)
    t.is(typeof err.retry, 'function')
  }
})

test('retry resends the same nonce, signed bytes and body, and never signs or starts again', async (t) => {
  const { actAs } = await load()
  const calls = stub(t, flow((n) => n === 2 ? json(500, {}) : json(200, { seq: 5, length: 6, pushed: true })))
  const node = fakeNode()
  const err = await caught(t, actAs(node, { member: M, action: 'post', page: P, op: { text: 'x' } }))
  t.is(err.uncertain, true)
  const res = await err.retry()
  t.alike(res, { seq: 5, length: 6, pushed: true })
  t.is(calls.length, 3)
  t.is(calls[2].url, calls[1].url)
  t.is(calls[2].init.body, calls[1].init.body, 'identical body string')
  t.is(node.signs.length, 1, 'signed once')
  t.is(calls.filter((c) => c.url.endsWith('/start')).length, 1, 'one start')
})

test('retry of an upload resends the same bytes and headers', async (t) => {
  const { pagesMedia } = await load()
  const calls = stub(t, (n) => n === 1 ? json(500, {}) : json(200, { descriptor: {} }))
  const bytes = new Uint8Array([9])
  const err = await caught(t, pagesMedia({ member: M, nonce: NONCE, page: P, op: { a: 1 }, signature: SIG, bytes }))
  t.is(err.uncertain, true)
  await err.retry()
  t.is(calls[1].init.body, bytes)
  t.alike(calls[1].init.headers, calls[0].init.headers)
})

test('same nonce with another body answers expirado, a definite refusal', async (t) => {
  const { actAs } = await load()
  stub(t, flow(() => json(404, { error: 'expirado' })))
  const err = await caught(t, actAs(fakeNode(), { member: M, action: 'post', page: P, op: { text: 'x' } }))
  t.is(err.code, 'expirado')
  t.absent(err.uncertain)
})

test('a bad member, page, action or node sends nothing', async (t) => {
  const { actAs } = await load()
  const calls = stub(t, json(200, {}))
  for (const args of [
    { member: 'x', action: 'post', page: P },
    { member: M, action: 'post', page: 'nope' },
    { member: M, action: 'dm-nope', page: P },
    { member: M, action: 'dm-send', page: '' },
    { member: M, action: 'media', page: P }
  ]) {
    const err = await caught(t, actAs(fakeNode(), args))
    t.is(err.code, 'pedido-invalido')
  }
  const err = await caught(t, actAs(null, { member: M, action: 'post', page: P }))
  t.is(err.code, 'pedido-invalido')
  t.is(calls.length, 0)
})

test('pagesFeedKeys keeps the newest 64 by seq, once each, lowercase hex only', async (t) => {
  const { pagesFeedKeys } = await load()
  const key = (i) => i.toString(16).padStart(64, '0')
  const follows = []
  for (let i = 1; i <= 100; i++) follows.push({ key: key(i), seq: i })
  const keys = pagesFeedKeys(follows, 64)
  t.is(keys.length, 64)
  t.is(keys[0], key(100), 'newest first')
  t.is(keys[63], key(37))
  t.absent(keys.includes(key(36)))
  t.is(pagesFeedKeys(follows).length, 64, 'the default is 64')
  t.is(pagesFeedKeys(follows, 500).length, 64, 'never past 64')
  t.is(pagesFeedKeys(follows, 3).length, 3)
  t.alike(pagesFeedKeys([{ key: key(1), seq: 5 }, { key: key(1), seq: 4 }, { key: 'ZZ', seq: 9 }, { key: key(2) }, null]), [key(1)])
  t.alike(pagesFeedKeys(null), [])
})

// A fresh nonce per start, so a test can tell a resend from a new request.
const fresh = (then) => {
  let starts = 0
  return (n, url) => url.endsWith('/start') ? json(200, { nonce: String(++starts).padStart(43, 'n') }) : then(n, url)
}

test('signed reads take answers up to 1 MiB; writes keep 64 KiB', async (t) => {
  const { actAs } = await load()
  const ref = (i) => 'ab'.repeat(32) + ':' + i
  const liked = []
  for (let i = 1; i <= 4096; i++) liked.push(ref(i))
  const big = { owner: M, admins: [], invites: [], engagement: { liked, reposted: liked, truncated: false } }
  t.ok(JSON.stringify(big).length > 65536 && JSON.stringify(big).length < 1024 * 1024)
  for (const action of ['status', 'list', 'follows']) {
    stub(t, flow(() => json(200, big)))
    const res = await actAs(fakeNode(), { member: M, action, page: action === 'list' ? '' : P })
    t.is(res.engagement.liked.length, 4096, action)
  }
  stub(t, flow(() => json(200, big)))
  const err = await caught(t, actAs(fakeNode(), { member: M, action: 'post', page: P, op: { text: 'x' } }))
  t.is(err.uncertain, true, 'an oversized write answer is still unreadable')
})

test('a lost read answer is plain; retry starts and signs again with a new nonce', async (t) => {
  const { actAs } = await load()
  let posts = 0
  const calls = stub(t, fresh(() => ++posts === 1 ? json(500, {}) : json(200, { owner: M })))
  const node = fakeNode()
  const err = await caught(t, actAs(node, { member: M, action: 'status', page: P }))
  t.absent(err.uncertain, 'a read has nothing to be uncertain about')
  t.is(err.code, 'indisponivel')
  t.is(typeof err.retry, 'function')
  t.alike(await err.retry(), { owner: M })
  t.is(calls.filter((c) => c.url.endsWith('/start')).length, 2, 'a fresh start')
  t.is(node.signs.length, 2, 'signed again')
  const sent = calls.filter((c) => c.url.endsWith('/status')).map((c) => body(c).nonce)
  t.not(sent[0], sent[1], 'never the same nonce')
})

test('a read answered expirado is retryable, never a definite refusal', async (t) => {
  const { actAs } = await load()
  let posts = 0
  stub(t, fresh(() => ++posts === 1 ? json(404, { error: 'expirado' }) : json(200, { follows: [] })))
  const err = await caught(t, actAs(fakeNode(), { member: M, action: 'follows', page: P }))
  t.not(err.code, 'expirado')
  t.absent(err.uncertain)
  t.alike(await err.retry(), { follows: [] })
})

test('a write retry while the first use is in flight stays uncertain; a later retry answers the stored seq', async (t) => {
  const { actAs } = await load()
  const answers = [json(500, {}), json(409, { error: 'em-andamento' }), json(404, { error: 'expirado' }), json(200, { seq: 7, length: 8, pushed: true })]
  const calls = stub(t, flow((n) => answers[n - 2]))
  const node = fakeNode()
  const first = await caught(t, actAs(node, { member: M, action: 'post', page: P, op: { text: 'x' } }))
  t.is(first.uncertain, true)
  const busy = await caught(t, first.retry())
  t.is(busy.code, 'em-andamento')
  t.is(busy.uncertain, true, 'in flight is not a refusal')
  t.is(typeof busy.retry, 'function')
  const lapsed = await caught(t, busy.retry())
  t.is(lapsed.uncertain, true, 'expirado on a retry proves nothing')
  t.is(typeof lapsed.retry, 'function')
  t.alike(await lapsed.retry(), { seq: 7, length: 8, pushed: true })
  t.is(node.signs.length, 1, 'signed once')
  const posts = calls.filter((c) => c.url.endsWith('/post'))
  t.is(posts.length, 4)
  t.ok(posts.every((c) => c.init.body === posts[0].init.body), 'the same bytes every time')
})

test('a retry refused for its bytes is definite', async (t) => {
  const { actAs } = await load()
  for (const token of ['assinatura-invalida', 'pedido-invalido']) {
    stub(t, flow((n) => n === 2 ? json(500, {}) : json(400, { error: token })))
    const first = await caught(t, actAs(fakeNode(), { member: M, action: 'post', page: P, op: { text: 'x' } }))
    const err = await caught(t, first.retry())
    t.is(err.code, token)
    t.absent(err.uncertain, token)
    t.absent(err.retry, token)
  }
})

// ---- Conversas as the page ----------------------------------------------------

const DIGEST = 'd1'.repeat(32)
const BOX = 'b0'.repeat(32)
const GBOX = 'b1'.repeat(32)
const OWN_BOX = 'b2'.repeat(32)
const ADMIN = '11'.repeat(32)
const EXPIRES = 1767225600000
const CERT = { member: P }

// A node that signs page statements and answers dm.* from `answers`
// (a value or a function of params), recording every call in order.
function dmNode (answers = {}) {
  const calls = []
  return {
    calls,
    signs: calls,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'page.sign') return { signature: SIG }
      if (method === 'dm.enable' && !Object.hasOwn(answers, method)) return { box: OWN_BOX, gen: 1, seq: null }
      const a = answers[method]
      const r = typeof a === 'function' ? a(params) : a
      if (r instanceof Error) throw r
      return r === undefined ? {} : r
    }
  }
}

test('pagesDm takes the page statements and refuses the removed dm-send, dm-set, dm-seen, dm-list and dm-thread', async (t) => {
  const { pagesDm } = await load()
  for (const action of ['dm-send', 'dm-set', 'dm-seen', 'dm-list', 'dm-thread', 'dm-nope']) {
    const err = await caught(t, pagesDm(fakeNode(), { member: M, page: P, action }))
    t.is(err.code, 'pedido-invalido', action)
  }
  const cases = [
    ['dm-legacy-read', { from: 8 }],
    ['dm-legacy-done', { id: DIGEST }],
    ['dm-sign', { digest: DIGEST }],
    ['dm-box-read', {}],
    ['dm-box-share', { member: ADMIN, gen: 2, sealed: 'x', sig: SIG }]
  ]
  for (const [action, op] of cases) {
    const calls = stub(t, flow(() => json(200, { ok: true })))
    const node = fakeNode()
    await pagesDm(node, { member: M, page: P, action, op })
    t.ok(calls[1].url.endsWith('/account/pages/' + action), action)
    t.alike(body(calls[1]).op, op, action)
    t.alike(node.signs[0].params, { action, nonce: NONCE, page: P, op })
  }
})

test('dm-sign, dm-box-read and dm-legacy-read are reads: a lost answer is plain and retry signs again', async (t) => {
  const { pagesDm } = await load()
  for (const [action, op] of [['dm-sign', { digest: DIGEST }], ['dm-box-read', {}], ['dm-legacy-read', { from: 0 }]]) {
    let posts = 0
    const calls = stub(t, fresh(() => ++posts === 1 ? json(500, {}) : json(200, { signature: SIG })))
    const node = fakeNode()
    const err = await caught(t, pagesDm(node, { member: M, page: P, action, op }))
    t.absent(err.uncertain, action)
    await err.retry()
    t.is(node.signs.length, 2, action + ' signed again')
    const sent = calls.filter((c) => !c.url.endsWith('/start')).map((c) => body(c).nonce)
    t.not(sent[0], sent[1])
  }
})

test('the dm-sign answer hands the service expiry to the page send', async (t) => {
  const { pagesDm } = await load()
  stub(t, flow(() => json(200, { signature: SIG, expiresAt: EXPIRES })))
  const signed = await pagesDm(fakeNode(), { member: M, page: P, action: 'dm-sign', op: { digest: DIGEST } })
  t.alike(signed, { signature: SIG, expiresAt: EXPIRES })
})

test('dm-box after a lost answer is uncertain and retry resends the same signed bytes', async (t) => {
  const { pagesDm } = await load()
  let posts = 0
  const calls = stub(t, flow(() => ++posts === 1 ? json(500, {}) : json(200, { seq: 3, gen: 1 })))
  const node = fakeNode()
  const op = { expectedGen: 0, box: BOX, groupBox: GBOX, ownBox: OWN_BOX, shares: [] }
  const err = await caught(t, pagesDm(node, { member: M, page: P, action: 'dm-box', op }))
  t.is(err.uncertain, true)
  t.is((await err.retry()).seq, 3)
  t.is(node.signs.length, 1, 'never signs again')
  t.alike(calls[1].init.body, calls[2].init.body)
})

test('the key tokens of the service read as pt-BR', async (t) => {
  const { pageError } = await load()
  t.is(pageError('rotacao-necessaria').message, 'A chave da página está sendo trocada; tente de novo em instantes')
  t.is(pageError('conflito').code, 'conflito')
})

test('page dm client reads the node with page and sends through draft, dm-sign and dm.pageSend', async (t) => {
  const { pageDmClient, pageInboxTitle, PAGE_DM_CUSTODY } = await import('../src/dm-screen.js')
  const calls = []
  const signed = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (method === 'dm.pageDraft') return { id: 'a'.repeat(32), digest: DIGEST, at: '2026-01-01T00:00:00.000Z' }
    if (method === 'dm.pageSend') return { id: 'a'.repeat(32), at: '2026-01-01T00:00:00.000Z' }
    return { ok: true }
  }
  const sign = async (digest) => { signed.push(digest); return { signature: SIG, expiresAt: EXPIRES } }
  const dm = pageDmClient({ request, sign, page: P })
  await dm('dm.list', { folder: 'inbox' })
  await dm('dm.thread', { peer: K2 })
  await dm('dm.seen', { peer: K2 })
  t.alike(calls.map((c) => c[1].page), [P, P, P], 'reads carry the page')
  calls.length = 0
  const sent = await dm('dm.send', { to: K2, text: 'Oi', replyTo: 'e'.repeat(32) })
  t.is(sent.id, 'a'.repeat(32))
  t.alike(calls, [
    ['dm.pageDraft', { page: P, kind: 'msg', to: K2, text: 'Oi', replyTo: 'e'.repeat(32) }],
    ['dm.pageSend', { page: P, id: 'a'.repeat(32), signature: SIG, expiresAt: EXPIRES }]
  ])
  t.alike(signed, [DIGEST], 'the page signs the digest only')
  calls.length = 0
  t.alike(await dm('dm.set', { peer: K2, state: 'blocked' }), { ok: true })
  t.alike(calls[0], ['dm.pageDraft', { page: P, kind: 'ctl', peer: K2, op: 'blocked' }])
  t.is(calls[1][0], 'dm.pageSend')
  calls.length = 0
  await dm('dm.pull', {})
  t.alike(calls, [['dm.pull', {}]], 'the pull is the node\'s own')
  t.alike(await dm('dm.enable', {}), {})
  t.is(pageInboxTitle('Padaria'), 'Conversas da página Padaria')
  t.is(PAGE_DM_CUSTODY, 'Só quem administra a página lê estas mensagens')
})

test('an uncertain dm.pageSend keeps a retry of the exact request and never drafts or signs again', async (t) => {
  const { pageDmClient } = await import('../src/dm-screen.js')
  const calls = []
  let sends = 0
  const request = async (method, params) => {
    calls.push([method, params])
    if (method === 'dm.pageDraft') return { id: 'a'.repeat(32), digest: DIGEST, at: 'x' }
    if (++sends === 1) throw new Error('não deu para confirmar o envio')
    return { id: 'a'.repeat(32), at: 'x' }
  }
  let signs = 0
  const dm = pageDmClient({ request, sign: async () => { signs++; return { signature: SIG, expiresAt: EXPIRES } }, page: P })
  const err = await caught(t, dm('dm.send', { to: K2, text: 'Oi' }))
  t.is(err.uncertain, true)
  t.is(sends, 1, 'no automatic resend')
  await err.retry()
  t.is(signs, 1)
  t.is(calls.filter((c) => c[0] === 'dm.pageDraft').length, 1)
  const puts = calls.filter((c) => c[0] === 'dm.pageSend').map((c) => c[1])
  t.is(puts.length, 2)
  t.alike(puts[0], { page: P, id: 'a'.repeat(32), signature: SIG, expiresAt: EXPIRES })
  t.alike(puts[1], puts[0], 'the retry resends identical params, expiresAt included')
  const plain = pageDmClient({ request: async () => { throw new Error('chave da página não confere') }, sign: async () => ({ signature: SIG }), page: P })
  const refused = await caught(t, plain('dm.send', { to: K2, text: 'Oi' }))
  t.absent(refused.uncertain, 'a refusal is not uncertain')
})

test('an activation retried after two uncertain failures adopts the own share exactly once', async (t) => {
  const { pagesDmActivate } = await load()
  let posts = 0
  stub(t, flow(() => ++posts <= 3 ? json(500, {}) : json(200, { seq: 1, gen: 1 })))
  const node = dmNode({
    'dm.lookup': () => ({ box: OWN_BOX, gen: 1 }),
    'dm.pageGenerate': ({ recipients }) => ({ box: BOX, groupBox: GBOX, shares: recipients.map((r) => ({ member: r.member, sealed: 's', sig: SIG })) }),
    'dm.pageSecrets': () => ({ ok: true })
  })
  const status = { gen: 0, box: null, groupBox: null, share: null, cert: CERT, legacy: false, rotatePending: false }
  const first = await caught(t, pagesDmActivate(node, { member: M, page: P, status, roster: { owner: M, admins: [] } }))
  t.is(first.uncertain, true)
  const second = await caught(t, first.retry())
  t.is(second.uncertain, true)
  const third = await caught(t, second.retry())
  t.is(third.uncertain, true)
  t.is(node.calls.filter((c) => c.method === 'dm.pageSecrets').length, 0, 'nothing adopted before a success')
  t.alike(await third.retry(), { gen: 1, missing: [] })
  t.is(node.calls.filter((c) => c.method === 'dm.pageSecrets').length, 1, 'exactly one adoption')
  t.is(node.calls.filter((c) => c.method === 'page.sign').length, 1, 'never signed again')
})

test('page keys: refreshes re-read, a held activation keeps its resend, Enviar chave adopts first', (t) => {
  const inbox = fs.readFileSync(path.join(__dirname, '../src/screens/Mensagens.js'), 'utf8')
  t.ok(inbox.includes('}, [dmVersion, pageKey, unlocked, read])'), 'the dmVersion bump reads the keys again')
  t.ok(inbox.includes('adopted.get(pageKey) !== held'), 'an adopted share is not stored again')
  t.absent(/setInterval|setTimeout/.test(inbox), 'no timer of its own')
  t.ok(inbox.includes("{keys.hold\n          ? <Btn label='Tentar de novo' onPress={retry}") || /keys\.hold\s*\?\s*<Btn label='Tentar de novo' onPress=\{retry\}[\s\S]*PAGE_DM_ROTATING|PAGE_DM_ROTATING[\s\S]*keys\.hold\s*\?\s*<Btn label='Tentar de novo' onPress=\{retry\}/.test(inbox), 'mid-rotation the held request can be resent')
  const ajustes = fs.readFileSync(path.join(__dirname, '../src/screens/PaginaAjustes.js'), 'utf8')
  t.ok(/if \(dmStatus && dmStatus\.share\) await pagesDmAdopt\(node, \{ page, status: dmStatus \}\)\s*return pagesDmShareTo/.test(ajustes), 'the own share is adopted before sharing')
})

test('remove carries dmBox in the body, outside the signed op', async (t) => {
  const { actAs } = await load()
  const calls = stub(t, flow(() => json(200, { ok: true, dmGen: 3 })))
  const node = fakeNode()
  const dmBox = { expectedGen: 2, box: BOX, groupBox: GBOX, ownBox: OWN_BOX, shares: [] }
  await actAs(node, { member: M, action: 'remove', page: P, op: { gen: 2 }, dmBox })
  t.alike(body(calls[1]).dmBox, dmBox)
  t.absent(Object.hasOwn(node.signs[0].params.op, 'dmBox'), 'the node never signs dmBox')
  const plain = stub(t, flow(() => json(200, { ok: true })))
  await actAs(fakeNode(), { member: M, action: 'remove', page: P, op: { gen: 2 } })
  t.absent(Object.hasOwn(body(plain[1]), 'dmBox'), 'no dmBox without device-held keys')
})

test('move builds dmBox for K2 after start', async (t) => {
  const { pagesMove } = await load()
  const calls = stub(t, flow(() => json(200, { ok: true }), { to: K2 }))
  const seen = []
  const to = await pagesMove(fakeNode(), {
    member: M,
    page: P,
    op: ({ nonce, to }) => ({ to, nonce }),
    dmBox: async ({ to }) => { seen.push(to); return { expectedGen: 0, box: BOX, groupBox: GBOX, ownBox: OWN_BOX, shares: [] } }
  })
  t.is(to, K2)
  t.alike(seen, [K2])
  t.is(body(calls[1]).dmBox.expectedGen, 0)
})

test('Enviar chave seals for the member\'s dm-key and files the share', async (t) => {
  const { pagesDmShareTo, pagesDmInviteShare, PAGE_DM_NO_BOX } = await load()
  const calls = stub(t, flow(() => json(200, { ok: true })))
  const node = dmNode({ 'dm.lookup': ({ member }) => ({ box: member === ADMIN ? BOX : null, gen: 1 }), 'dm.pageShare': () => ({ gen: 4, sealed: 'S', sig: SIG }) })
  await pagesDmShareTo(node, { member: M, page: P, to: ADMIN })
  t.alike(node.calls.find((c) => c.method === 'dm.pageShare').params, { page: P, member: ADMIN, box: BOX })
  t.alike(body(calls[1]).op, { member: ADMIN, gen: 4, sealed: 'S', sig: SIG })
  const err = await caught(t, pagesDmShareTo(node, { member: M, page: P, to: K2 }))
  t.is(err.message, PAGE_DM_NO_BOX)
  t.alike(await pagesDmInviteShare(node, { page: P, to: ADMIN, status: { gen: 4 } }), { sealed: 'S', sig: SIG })
  t.is(await pagesDmInviteShare(node, { page: P, to: K2, status: { gen: 4 } }), null, 'no dm-key, no share')
})

test('a core node with an https account origin sends every page request there', async (t) => {
  await reachOn(t)
  const { actAs, pagesOrigin } = await load()
  const calls = stub(t, flow(() => json(200, { seq: 1 })))
  const node = { ...fakeNode(), hosted: false, accountOrigin: 'https://varanda.example' }
  t.is(pagesOrigin(node), 'https://varanda.example')
  await actAs(node, { member: M, action: 'post', page: P, op: { text: 'oi' } })
  t.is(calls[0].url, 'https://varanda.example/account/pages/start')
  t.is(calls[1].url, 'https://varanda.example/account/pages/post')
})

test('the hosted node and a core node without an https origin keep the relative path', async (t) => {
  const { actAs, pagesOrigin } = await load()
  const calls = stub(t, flow(() => json(200, { seq: 1 })))
  const hosted = { ...fakeNode(), hosted: true, accountOrigin: 'https://varanda.example' }
  t.is(pagesOrigin(hosted), undefined)
  t.is(pagesOrigin({ hosted: false, accountOrigin: 'http://varanda.example' }), undefined)
  await actAs(hosted, { member: M, action: 'post', page: P, op: { text: 'oi' } })
  t.is(calls[0].url, '/account/pages/start')
  t.is(calls[1].url, '/account/pages/post')
})

test('terms carries the termsSignature page.sign answered', async (t) => {
  const { pagesTerms } = await load()
  const TS = 'd'.repeat(128)
  const calls = stub(t, flow(() => json(200, { ok: true })))
  const node = fakeNode({ terms: { signature: SIG, termsSignature: TS } })
  const op = { version: 15, diary: K2 }
  await pagesTerms(node, { member: M, op })
  t.alike(body(calls[1]), { member: M, nonce: NONCE, op, signature: SIG, termsSignature: TS })
})

function coreNode (epoch, register) {
  const methods = []
  return {
    methods,
    hosted: false,
    accountOrigin: 'https://varanda.example',
    epoch,
    request: async (method) => {
      methods.push(method)
      if (method === 'node.info') return { publicKey: K2 }
      if (method === 'page.register') return register()
      return { signature: SIG, termsSignature: 'd'.repeat(128) }
    }
  }
}

test('coreActor: node.info, page.register, then the Terms, once per origin and epoch', async (t) => {
  await reachOn(t)
  const { coreActor, forgetCoreActors } = await import('../src/pageCore.js')
  const { LEGAL_VERSION } = await import('../src/legal.js')
  forgetCoreActors()
  t.teardown(forgetCoreActors)
  const calls = stub(t, flow(() => json(200, { ok: true })))
  const node = coreNode(1, () => ({ actor: M }))
  t.is((await coreActor(node)).actor, M)
  t.alike(node.methods, ['node.info', 'page.register', 'page.sign'])
  t.is(calls[1].url, 'https://varanda.example/account/pages/terms')
  t.alike(body(calls[1]).op, { version: LEGAL_VERSION, diary: K2 })
  t.is(body(calls[1]).member, M)
  await coreActor(node)
  t.is(node.methods.length, 3, 'cached')
})

test('coreActor forgets a failure', async (t) => {
  await reachOn(t)
  const { coreActor, forgetCoreActors } = await import('../src/pageCore.js')
  forgetCoreActors()
  t.teardown(forgetCoreActors)
  stub(t, flow(() => json(200, { ok: true })))
  let fail = true
  const node = coreNode(2, () => {
    if (fail) throw new Error('falhou')
    return { actor: M }
  })
  await caught(t, coreActor(node))
  fail = false
  t.is((await coreActor(node)).actor, M)
})

// ---- the legacy bundle and the old sender blocks ---------------------------------

const B1 = '21'.repeat(32)
const B2 = '22'.repeat(32)
const BUNDLE = 'be'.repeat(32)

// A fake service and node for a legacy page: 'dm-box-read' names a 3 chunk
// bundle (served 2 per read, so the import pages), the node files it on the
// last chunk and lists B1 and B2 as pending blocks until each send succeeds.
function legacySetup (t, { sendFails = () => null, chunkFails = () => null, doneFails = () => null, bundle = { id: BUNDLE, count: 3 } } = {}) {
  const real = globalThis.fetch
  let starts = 0
  let dones = 0
  const posted = []
  let held = bundle
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/start')) return json(200, { nonce: String(++starts).padStart(43, 'n') })
    const action = url.split('/').pop()
    const op = JSON.parse(init.body).op
    posted.push([action, op])
    if (action === 'dm-box') return json(200, { seq: 9, gen: 2 })
    if (action === 'dm-box-read') return json(200, { gen: 2, cert: CERT, legacyBundle: held })
    if (action === 'dm-legacy-read') {
      if (held === null) return json(404, { error: 'nao-encontrado' })
      const chunks = []
      for (let i = op.from; i < Math.min(op.from + 2, held.count); i++) chunks.push({ index: i, sealed: 'c' + i })
      return json(200, { id: held.id, count: held.count, chunks })
    }
    if (action === 'dm-legacy-done') {
      const f = doneFails(++dones)
      if (f) return f
      held = null
      return json(200, { ok: true })
    }
    if (action === 'dm-sign') return json(200, { signature: SIG, expiresAt: '2026-01-01T00:05:00.000Z' })
    return json(500, {})
  }
  t.teardown(() => { globalThis.fetch = real })
  let sends = 0
  let chunkCalls = 0
  const got = new Set()
  let pending = []
  const node = dmNode({
    'dm.lookup': () => ({ box: OWN_BOX, gen: 1 }),
    'dm.pageGenerate': ({ recipients }) => ({ box: BOX, groupBox: GBOX, shares: recipients.map((r) => ({ member: r.member, sealed: 's', sig: SIG })) }),
    'dm.pageSecrets': () => ({ ok: true }),
    'dm.pageLegacyChunk': (params) => {
      const f = chunkFails(++chunkCalls, params)
      if (f) return f
      got.add(params.index)
      if (got.size < params.count) return { complete: false, added: 0, blocked: 0 }
      pending = [B1, B2]
      return { complete: true, added: 5, blocked: 2 }
    },
    'dm.pageLegacyBlocks': () => ({ pending: [...pending] }),
    'dm.pageDraft': ({ peer }) => ({ id: peer.slice(0, 32), digest: DIGEST, at: 'x' }),
    'dm.pageSend': (params) => {
      const f = sendFails(++sends, params)
      if (f) return f
      pending = pending.filter((p) => p.slice(0, 32) !== params.id)
      return { id: params.id, at: 'x' }
    }
  })
  const status = { gen: 1, box: 'aa'.repeat(32), groupBox: null, share: null, cert: CERT, legacy: true, rotatePending: false, shared: [] }
  return { node, posted, status, setPending: (p) => { pending = p } }
}

const ctlPeers = (node) => node.calls.filter((c) => c.method === 'dm.pageDraft').map((c) => c.params)
const sendsOf = (node) => node.calls.filter((c) => c.method === 'dm.pageSend').map((c) => c.params)
const chunksOf = (node) => node.calls.filter((c) => c.method === 'dm.pageLegacyChunk').map((c) => c.params)
const actionsOf = (posted, action) => posted.filter((p) => p[0] === action).map((p) => p[1])

test('activation of a legacy page imports the 3 chunk bundle, calls done, then re-applies 2 blocks', async (t) => {
  const { pagesDmActivate } = await load()
  const { node, posted, status } = legacySetup(t)
  const r = await pagesDmActivate(node, { member: M, page: P, status, roster: { owner: M, admins: [] } })
  t.alike(r, { gen: 2, missing: [] })
  const box = actionsOf(posted, 'dm-box')[0]
  t.alike(box, { expectedGen: 1, box: BOX, groupBox: GBOX, ownBox: OWN_BOX, shares: [{ member: M, sealed: 's', sig: SIG }] }, 'no imported')
  t.absent(posted.some((p) => p[0] === 'dm-list' || p[0] === 'dm-thread'), 'no paged import')
  t.absent(node.calls.some((c) => c.method === 'dm.pageImport'))
  const secrets = node.calls.find((c) => c.method === 'dm.pageSecrets').params
  t.alike(secrets, { page: P, gen: 2, sealed: 's', by: M, sig: SIG, box: BOX, groupBox: GBOX, cert: CERT }, 'no legacy envelope')
  t.alike(actionsOf(posted, 'dm-legacy-read'), [{ from: 0 }, { from: 2 }], '8 at most per read, from the next index')
  t.alike(chunksOf(node), [0, 1, 2].map((i) => ({ page: P, id: BUNDLE, index: i, count: 3, sealed: 'c' + i })))
  t.alike(actionsOf(posted, 'dm-legacy-done'), [{ id: BUNDLE }], 'done once, after the node filed it')
  const methods = node.calls.map((c) => c.method)
  t.ok(methods.indexOf('dm.pageSecrets') < methods.indexOf('dm.pageLegacyChunk'), 'chunks after the adoption')
  const order = posted.map((p) => p[0])
  t.ok(order.indexOf('dm-legacy-done') < order.indexOf('dm-sign'), 'blocks after done')
  t.alike(ctlPeers(node), [{ page: P, kind: 'ctl', op: 'blocked', peer: B1 }, { page: P, kind: 'ctl', op: 'blocked', peer: B2 }])
  t.ok(sendsOf(node).every((p) => p.expiresAt === '2026-01-01T00:05:00.000Z'), 'with the expiry dm-sign answered')
})

test('a page that is not legacy reads no bundle and re-applies nothing', async (t) => {
  const { pagesDmActivate } = await load()
  const { node, posted } = legacySetup(t)
  const status = { gen: 0, box: null, groupBox: null, share: null, cert: CERT, legacy: false, rotatePending: false }
  t.alike(await pagesDmActivate(node, { member: M, page: P, status, roster: { owner: M, admins: [] } }), { gen: 1, missing: [] })
  t.alike(posted.map((p) => p[0]), ['dm-box'])
  t.absent(node.calls.some((c) => c.method === 'dm.pageLegacyBlocks' || c.method === 'dm.pageLegacyChunk'))
})

test('an interrupted import stands as blocksError; the tap goes on with the same bundle', async (t) => {
  const { pagesDmActivate, pagesDmLegacyFinish } = await load()
  const { node, posted, status } = legacySetup(t, { chunkFails: (n) => n === 2 ? new Error('falhou') : null })
  const r = await pagesDmActivate(node, { member: M, page: P, status, roster: { owner: M, admins: [] } })
  t.ok(r.blocksError, 'the activation stands')
  t.is(r.blocksError.step, 'import')
  t.is(actionsOf(posted, 'dm-legacy-done').length, 0, 'no done for a partial import')
  t.is(sendsOf(node).length, 0, 'no blocks before the import')
  const reads = actionsOf(posted, 'dm-legacy-read').length
  await r.blocksError.retry()
  t.ok(actionsOf(posted, 'dm-legacy-read').length > reads, 'read again from the first chunk')
  t.alike(actionsOf(posted, 'dm-legacy-done'), [{ id: BUNDLE }])
  t.is(sendsOf(node).length, 2)
  // A later tap on the card (the bundle 'dm-box-read' still names) runs the same steps.
  const again = await pagesDmLegacyFinish(node, { member: M, page: P, bundle: null })
  t.alike(again, { done: 0 }, 'nothing left')
})

test('the inbox card completes an interrupted import on tap', async (t) => {
  const { pagesDmBoxRead, pagesDmLegacyFinish, pagesDmLegacyPending } = await load()
  const { legacyBundleOf, legacyCardLabel } = await import('../src/pageSecrets.js')
  const { node, posted } = legacySetup(t)
  const status = await pagesDmBoxRead(node, { member: M, page: P })
  t.is(legacyCardLabel({ bundle: legacyBundleOf(status), pending: await pagesDmLegacyPending(node, { page: P }) }), 'Concluir a importação das conversas antigas')
  t.is(chunksOf(node).length, 0, 'reading the card label writes nothing')
  t.alike(await pagesDmLegacyFinish(node, { member: M, page: P, bundle: legacyBundleOf(status) }), { done: 2 })
  t.alike(actionsOf(posted, 'dm-legacy-done'), [{ id: BUNDLE }])
  const after = await pagesDmBoxRead(node, { member: M, page: P })
  t.is(legacyCardLabel({ bundle: legacyBundleOf(after), pending: await pagesDmLegacyPending(node, { page: P }) }), null, 'no card once done')
})

test('an uncertain dm-legacy-done keeps its retry, then re-applies the blocks', async (t) => {
  const { pagesDmLegacyFinish } = await load()
  const { node, posted } = legacySetup(t, { doneFails: (n) => n === 1 ? json(500, {}) : null })
  const err = await caught(t, pagesDmLegacyFinish(node, { member: M, page: P, bundle: { id: BUNDLE, count: 3 } }))
  t.is(err.uncertain, true)
  t.is(err.step, 'import')
  t.is(sendsOf(node).length, 0)
  const dones = posted.filter((p) => p[0] === 'dm-legacy-done')
  t.alike(await err.retry(), { done: 2 })
  t.is(posted.filter((p) => p[0] === 'dm-legacy-done').length, dones.length + 1, 'done resent once')
  t.is(chunksOf(node).length, 3, 'no chunk fed again')
})

test('a failed block stops there; the retry resends the exact request for that peer only', async (t) => {
  const { pagesDmActivate, pagesDmReapplyBlocks } = await load()
  const { node, status } = legacySetup(t, { sendFails: (n) => n === 2 ? new Error('não deu para confirmar o envio') : null })
  const r = await pagesDmActivate(node, { member: M, page: P, status, roster: { owner: M, admins: [] } })
  t.ok(r.blocksError, 'the activation stands, the blocks report the failure')
  t.is(r.blocksError.peer, B2)
  t.is(r.blocksError.step, 'blocks')
  t.is(r.blocksError.uncertain, true)
  t.is(sendsOf(node).length, 2, 'stopped at the failure, no automatic resend')
  await r.blocksError.retry()
  const sends = sendsOf(node)
  t.is(sends.length, 3)
  t.alike(sends[2], sends[1], 'the same uncertain request')
  t.alike(ctlPeers(node).map((p) => p.peer), [B1, B2], 'B1 is never drafted again')
  t.alike(await pagesDmReapplyBlocks(node, { member: M, page: P }), { done: 0 }, 'the node lists nothing left')
})

test('a refused block retries from that peer with a new draft', async (t) => {
  const { pagesDmReapplyBlocks } = await load()
  const { node, setPending } = legacySetup(t, { sendFails: (n) => n === 2 ? new Error('rascunho expirado') : null })
  setPending([B1, B2])
  const err = await caught(t, pagesDmReapplyBlocks(node, { member: M, page: P }))
  t.is(err.peer, B2)
  t.absent(err.uncertain)
  await err.retry()
  t.alike(ctlPeers(node).map((p) => p.peer), [B1, B2, B2], 'only B2 again')
})

test('an activation retry that succeeds surfaces the blocks failure like the first attempt', async (t) => {
  const { pagesDmActivate } = await load()
  let boxes = 0
  const { node, status } = legacySetup(t, { sendFails: () => new Error('rascunho expirado') })
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => url.endsWith('/dm-box') && ++boxes === 1 ? json(500, {}) : real(url, init)
  t.teardown(() => { globalThis.fetch = real })
  const err = await caught(t, pagesDmActivate(node, { member: M, page: P, status, roster: { owner: M, admins: [] } }))
  t.is(err.uncertain, true)
  const r = await err.retry()
  t.ok(r.blocksError, 'the retry reports it too')
  t.is(r.blocksError.step, 'blocks')
  const inbox = fs.readFileSync(path.join(__dirname, '../src/screens/Mensagens.js'), 'utf8')
  const retryFn = inbox.slice(inbox.indexOf('const retry = async'), inbox.indexOf('const reapply = async'))
  t.ok(retryFn.includes('setBlocksHold(out && out.blocksError'), 'the screen holds it after a retry')
})

test('the legacy steps run only from a tap: the screen read writes nothing', (t) => {
  const inbox = fs.readFileSync(path.join(__dirname, '../src/screens/Mensagens.js'), 'utf8')
  const readFn = inbox.slice(inbox.indexOf('const read = useCallback'), inbox.indexOf('}, [pageKey])'))
  t.absent(/pagesDmLegacyFinish|pagesDmReapplyBlocks|pagesDmActivate|dm\.pageLegacyChunk/.test(readFn), 'no write on open')
  t.ok(readFn.includes('pagesDmLegacyPeers'), 'the card reads the pending peers')
  t.is(inbox.split('pagesDmLegacyFinish(').length - 1, 1, 'one call, in reapply')
  t.absent(inbox.includes('pageNoticeStore'), 'no per-device done list')
})

test('pagesDmPrepare takes ownBox from the node and refuses a published box that is not its own', async (t) => {
  const { pagesDmPrepare, PAGE_DM_OWN_BOX_PENDING, PAGE_DM_NO_OWN_BOX } = await load()
  const gen = ({ recipients }) => ({ box: BOX, groupBox: GBOX, shares: recipients.map((r) => ({ member: r.member, sealed: 's', sig: SIG })) })
  const roster = { owner: M, admins: [ADMIN] }
  const good = dmNode({ 'dm.enable': { box: OWN_BOX, gen: 1, seq: null }, 'dm.lookup': ({ member }) => ({ box: member === M ? OWN_BOX : BOX, gen: 1 }), 'dm.pageGenerate': gen })
  const prep = await pagesDmPrepare(good, { member: M, page: P, status: { gen: 0 }, roster })
  t.is(prep.dmBox.ownBox, OWN_BOX)
  t.is(good.calls[0].method, 'dm.enable', 'the node is asked first')
  const stale = dmNode({ 'dm.enable': { box: OWN_BOX, gen: 2, seq: 5 }, 'dm.lookup': () => ({ box: BOX, gen: 1 }), 'dm.pageGenerate': gen })
  const err = await caught(t, pagesDmPrepare(stale, { member: M, page: P, status: { gen: 0 }, roster }))
  t.is(err.message, PAGE_DM_OWN_BOX_PENDING)
  t.absent(stale.calls.some((c) => c.method === 'dm.pageGenerate'), 'nothing generated for a box the node does not derive')
  const none = dmNode({ 'dm.enable': new Error('identidade bloqueada: entre com a passkey'), 'dm.lookup': () => ({ box: OWN_BOX, gen: 1 }) })
  t.is((await caught(t, pagesDmPrepare(none, { member: M, page: P, status: { gen: 0 }, roster }))).message, PAGE_DM_NO_OWN_BOX)
  t.is(none.calls.filter((c) => c.method === 'dm.enable').length, 1, 'never asked again by itself')
})

test('a new owner without a share rotates through dm-box with expectedGen the current gen', async (t) => {
  const { pagesDmActivate } = await load()
  const calls = stub(t, flow(() => json(200, { seq: 7, gen: 4 })))
  const node = dmNode({
    'dm.lookup': ({ member }) => ({ box: member === M ? OWN_BOX : BOX, gen: 1 }),
    'dm.pageGenerate': ({ gen, recipients }) => ({ box: BOX, groupBox: GBOX, shares: recipients.map((r) => ({ member: r.member, sealed: 's' + gen, sig: SIG })) }),
    'dm.pageSecrets': () => ({ ok: true })
  })
  const status = { gen: 3, box: BOX, groupBox: GBOX, share: null, cert: CERT, legacy: false, rotatePending: false, shared: [ADMIN] }
  t.alike(await pagesDmActivate(node, { member: M, page: P, status, roster: { owner: M, admins: [ADMIN] } }), { gen: 4, missing: [] })
  const op = body(calls[1]).op
  t.is(op.expectedGen, 3)
  t.alike(op.shares.map((s) => s.member), [M, ADMIN], 'a new gen for the whole roster')
  t.is(node.calls.find((c) => c.method === 'dm.pageSecrets').params.gen, 4)
})

test('the inbox keys are per page: a page change resets them and the actions check the page', (t) => {
  const inbox = fs.readFileSync(path.join(__dirname, '../src/screens/Mensagens.js'), 'utf8')
  t.ok(inbox.includes('const state = pageKeysOf(stored, pageKey)'), 'a read for another page counts as none')
  t.ok(inbox.includes('setState({ ...PAGE_KEYS_IDLE, page: pageKey })'), 'the page change resets status, roster and phase')
  const activateFn = inbox.slice(inbox.indexOf('const activate = async'), inbox.indexOf('const retry = async'))
  t.ok(activateFn.includes('page !== pageKey'), 'no activation with another page\'s read')
  t.ok(activateFn.includes('pagesDmActivate(nodeRef.current, { member, page, status, roster })'), 'the page of the read, never the current key with an old roster')
  const reapplyFn = inbox.slice(inbox.indexOf('const reapply = async'), inbox.indexOf('const legacyLabel'))
  t.ok(reapplyFn.includes('page !== pageKey'))
  t.ok(inbox.includes("keys.phase === 'rotate'"), 'the owner without a share gets the new gen')
  t.ok(inbox.includes('blockPeersLine(keys.peers'), 'the re-apply card names the peers before the tap')
})

test('the move carries dmBox only with a promoted device gen; an owner without a share offers no Enviar chave', (t) => {
  const ajustes = fs.readFileSync(path.join(__dirname, '../src/screens/PaginaAjustes.js'), 'utf8')
  const moveFn = ajustes.slice(ajustes.indexOf('const movePage = () =>'), ajustes.indexOf('const retryLifecycle'))
  t.ok(moveFn.includes('const dmBox = hasDeviceKeys(dmStatus)'), 'gen 0 with a pending first rotation sends none')
  t.ok(/const missingKeys = [^\n]*dmStatus\.share \? missingShares/.test(ajustes))
})

test('pagesDmLegacyPeers lists each pending peer once; a failed read is empty', async (t) => {
  const { pagesDmLegacyPeers, pagesDmLegacyPending } = await load()
  const node = dmNode({ 'dm.pageLegacyBlocks': { pending: [B1, B2, B1, 'x'] } })
  t.alike(await pagesDmLegacyPeers(node, { page: P }), [B1, B2])
  t.is(await pagesDmLegacyPending(node, { page: P }), 2)
  t.alike(await pagesDmLegacyPeers(dmNode({ 'dm.pageLegacyBlocks': new Error('x') }), { page: P }), [])
})

// A service whose remove rotates the page to dmBox's gen and whose
// 'dm-box-read' then hands back the caller's share of that gen.
function rotatingService (t, { gen = 2, pending = () => false } = {}) {
  const real = globalThis.fetch
  let starts = 0
  const state = { gen, posted: [] }
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/start')) return json(200, { nonce: String(++starts).padStart(43, 'r') })
    const action = url.split('/').pop()
    const b = JSON.parse(init.body)
    state.posted.push([action, b])
    if (action === 'remove') {
      if (b.dmBox.expectedGen !== state.gen) return json(409, { error: 'conflito' })
      state.gen = b.dmBox.expectedGen + 1
      return json(200, { ok: true, dmGen: state.gen })
    }
    if (action === 'dm-box-read') {
      if (pending()) return json(200, { gen: state.gen, box: BOX, groupBox: GBOX, share: null, cert: CERT, rotatePending: true })
      return json(200, { gen: state.gen, box: BOX, groupBox: GBOX, share: { gen: state.gen, sealed: 's' + state.gen, by: M, sig: SIG }, cert: CERT, rotatePending: false })
    }
    return json(500, {})
  }
  t.teardown(() => { globalThis.fetch = real })
  return state
}

const keysNode = () => dmNode({
  'dm.lookup': ({ member }) => ({ box: member === M ? OWN_BOX : BOX, gen: 1 }),
  'dm.pageGenerate': ({ gen, recipients }) => ({ box: BOX, groupBox: GBOX, shares: recipients.map((r) => ({ member: r.member, sealed: 's' + gen, sig: SIG })) }),
  'dm.pageSecrets': () => ({ ok: true })
})

test('remove A then remove B: gen N+1 is adopted on this device before gen N+2 is generated', async (t) => {
  const { actAs, pagesDmPrepare, pagesDmExpectAdopt, pagesDmAdoptNew, pagesDmAwaitsAdopt } = await load()
  const page = '71'.repeat(32)
  const A = '72'.repeat(32)
  const B = '73'.repeat(32)
  const svc = rotatingService(t, { gen: 2 })
  const node = keysNode()
  const removeOne = async (who, status, admins) => {
    const prep = await pagesDmPrepare(node, { member: M, page, status, roster: { owner: M, admins } })
    pagesDmExpectAdopt(page, prep.gen)
    await actAs(node, { member: M, action: 'remove', page, op: { remove: who }, dmBox: prep.dmBox })
    return prep.gen
  }
  const g1 = await removeOne(A, { gen: 2, groupBox: GBOX }, [B])
  t.is(g1, 3)
  t.ok(pagesDmAwaitsAdopt(page), 'the new gen waits for its adoption')
  const early = await caught(t, pagesDmPrepare(node, { member: M, page, status: { gen: 3, groupBox: GBOX }, roster: { owner: M, admins: [] } }))
  t.is(early.code, 'rotacao-necessaria', 'no second rotation before the first is held here')
  t.is(early.message, 'A chave da página está sendo trocada; tente de novo em instantes')
  await pagesDmAdoptNew(node, { member: M, page, gen: g1 })
  t.absent(pagesDmAwaitsAdopt(page))
  const g2 = await removeOne(B, { gen: 3, groupBox: GBOX }, [])
  t.is(g2, 4)
  await pagesDmAdoptNew(node, { member: M, page, gen: g2 })
  const methods = node.calls.map((c) => c.method + (c.params && Number.isInteger(c.params.gen) ? ':' + c.params.gen : ''))
  t.ok(methods.indexOf('dm.pageSecrets:3') < methods.indexOf('dm.pageGenerate:4'), 'gen 3 adopted before gen 4 is made')
  t.alike(node.calls.filter((c) => c.method === 'dm.pageSecrets').map((c) => c.params.gen), [3, 4], 'both gens went into the node')
  t.is(svc.gen, 4)
})

test('a new gen still pending on the service: the adoption throws the rotating text and keeps the guard', async (t) => {
  const { pagesDmAdoptNew, pagesDmExpectAdopt, pagesDmForgetAdopt, pagesDmAwaitsAdopt } = await load()
  const page = '74'.repeat(32)
  let pending = true
  rotatingService(t, { gen: 1, pending: () => pending })
  const node = keysNode()
  pagesDmExpectAdopt(page, 1)
  const err = await caught(t, pagesDmAdoptNew(node, { member: M, page, gen: 1 }))
  t.is(err.code, 'rotacao-necessaria')
  t.ok(pagesDmAwaitsAdopt(page))
  t.absent(node.calls.some((c) => c.method === 'dm.pageSecrets'))
  pending = false
  await pagesDmAdoptNew(node, { member: M, page, gen: 1 })
  t.absent(pagesDmAwaitsAdopt(page), 'the manual retry adopts and lifts the guard')
  pagesDmExpectAdopt(page, 5)
  pagesDmForgetAdopt(page, 5)
  t.absent(pagesDmAwaitsAdopt(page), 'a definite refusal sent no gen')
})

test('the invite share: a device behind adopts first; a gen that still differs attaches none', async (t) => {
  const { pagesDmInviteShare } = await load()
  const page = '75'.repeat(32)
  let held = 2
  const node = dmNode({
    'dm.lookup': () => ({ box: BOX, gen: 1 }),
    'dm.pageSecrets': (params) => { held = params.gen; return { ok: true } },
    'dm.pageShare': () => ({ gen: held, sealed: 'S' + held, sig: SIG })
  })
  const status = { gen: 3, box: BOX, groupBox: GBOX, cert: CERT, share: { gen: 3, sealed: 's3', by: M, sig: SIG } }
  t.alike(await pagesDmInviteShare(node, { page, to: ADMIN, status }), { sealed: 'S3', sig: SIG }, 'sealed with the current gen after adopting it')
  const methods = node.calls.map((c) => c.method)
  t.ok(methods.indexOf('dm.pageSecrets') < methods.lastIndexOf('dm.pageShare'))
  held = 2
  t.is(await pagesDmInviteShare(node, { page, to: ADMIN, status: { ...status, share: null } }), null, 'no own share to adopt: no share, the invite goes out without one')
  held = 4
  t.is(await pagesDmInviteShare(node, { page, to: ADMIN, status }), null, 'a held gen ahead of the read is not attached either')
  t.is(await pagesDmInviteShare(node, { page, to: ADMIN }), null, 'no read, no share')
})

test('Ajustes adopts the new gen as the last step of a remove and a move, with a manual retry', (t) => {
  const ajustes = fs.readFileSync(path.join(__dirname, '../src/screens/PaginaAjustes.js'), 'utf8')
  const removeFn = ajustes.slice(ajustes.indexOf('const remove = (key) =>'), ajustes.indexOf('const missingKeys'))
  t.ok(removeFn.includes('pagesDmExpectAdopt(page, gen)'), 'the guard goes up before the remove is sent')
  t.ok(removeFn.includes('if (gen !== null) await adoptNew(page, gen)'), 'adopted after the service took it')
  t.is(removeFn.split('await adoptNew(page, gen)').length - 1, 2, 'the held retry adopts too')
  const moveFn = ajustes.slice(ajustes.indexOf('const movePage = () =>'), ajustes.indexOf('// ---- view'))
  t.ok(moveFn.includes('pagesDmExpectAdopt(to, 1)'))
  t.ok(moveFn.includes('if (dmBox) await adoptNew(moved, 1)'))
  t.ok(ajustes.includes("<Pill label='Tentar de novo' onPress={retryAdopt}"), 'a failed adoption keeps a manual retry')
  t.ok(ajustes.includes('pagesDmInviteShare(node, { page, to: who, status: dmStatus })'), 'the invite seals for the read gen')
})

test('a fresh device adopts the current share before generating the next gen', async (t) => {
  const { actAs, pagesDmPrepare, pagesDmExpectAdopt, pagesDmAdoptNew } = await load()
  const page = '76'.repeat(32)
  const A = '77'.repeat(32)
  rotatingService(t, { gen: 2 })
  const node = keysNode()
  const status = { gen: 2, box: BOX, groupBox: GBOX, cert: CERT, rotatePending: false, share: { gen: 2, sealed: 's2', by: M, sig: SIG } }
  const prep = await pagesDmPrepare(node, { member: M, page, status, roster: { owner: M, admins: [] } })
  pagesDmExpectAdopt(page, prep.gen)
  await actAs(node, { member: M, action: 'remove', page, op: { remove: A }, dmBox: prep.dmBox })
  await pagesDmAdoptNew(node, { member: M, page, gen: prep.gen })
  const methods = node.calls.map((c) => c.method + (c.params && Number.isInteger(c.params.gen) ? ':' + c.params.gen : ''))
  t.ok(methods.indexOf('dm.pageSecrets:2') >= 0 && methods.indexOf('dm.pageSecrets:2') < methods.indexOf('dm.pageGenerate:3'), 'the current gen is held before the next is made')
  t.alike(node.calls.filter((c) => c.method === 'dm.pageSecrets').map((c) => c.params.gen), [2, 3], 'then the new gen is adopted')
  const none = keysNode()
  await pagesDmPrepare(none, { member: M, page: '78'.repeat(32), status: { gen: 0 }, roster: { owner: M, admins: [] }, gen: 1 })
  t.absent(none.calls.some((c) => c.method === 'dm.pageSecrets'), 'nothing to adopt without a share')
  const ajustes = fs.readFileSync(path.join(__dirname, '../src/screens/PaginaAjustes.js'), 'utf8')
  const moveFn = ajustes.slice(ajustes.indexOf('const movePage = () =>'), ajustes.indexOf('// ---- view'))
  t.ok(moveFn.includes('if (dmStatus.share) await pagesDmAdopt(node, { page, status: dmStatus })'), 'a move keeps the old page\'s gen too')
})

test('a core node cannot rotate: remove and move refuse plainly with the app text, never a retry', async (t) => {
  const { pagesDmPrepare, PAGE_DM_CORE_ONLY } = await load()
  t.is(PAGE_DM_CORE_ONLY, 'Para remover administradores ou mudar a chave desta página, use o app no celular ou na web.')
  const status = { gen: 2, groupBox: GBOX }
  const core = { ...dmNode(), hosted: false }
  const a = await caught(t, pagesDmPrepare(core, { member: M, page: '79'.repeat(32), status, roster: { owner: M, admins: [] } }))
  t.is(a.message, PAGE_DM_CORE_ONLY)
  t.absent(a.uncertain)
  t.absent(typeof a.retry === 'function', 'no retry loop')
  t.is(core.calls.length, 0, 'nothing asked of the node')
  const usage = dmNode({ 'dm.enable': new Error('mensagens diretas disponíveis só no navegador') })
  const b = await caught(t, pagesDmPrepare(usage, { member: M, page: '7a'.repeat(32), status, roster: { owner: M, admins: [] } }))
  t.is(b.message, PAGE_DM_CORE_ONLY, 'the node\'s USAGE refusal reads the same')
  t.absent(usage.calls.some((c) => c.method === 'dm.pageGenerate'))
  const ajustes = fs.readFileSync(path.join(__dirname, '../src/screens/PaginaAjustes.js'), 'utf8')
  const removeFn = ajustes.slice(ajustes.indexOf('const remove = (key) =>'), ajustes.indexOf('const missingKeys'))
  t.ok(removeFn.includes('if (pagesDmCoreOnly(node)) throw new Error(PAGE_DM_CORE_ONLY)'), 'no remove without rotation')
  const moveFn = ajustes.slice(ajustes.indexOf('const movePage = () =>'), ajustes.indexOf('// ---- view'))
  t.ok(moveFn.includes('if (hasDeviceKeys(dmStatus) && pagesDmCoreOnly(node)) throw new Error(PAGE_DM_CORE_ONLY)'))
})

test('a guard left by a publication that never reached the service goes with a fresh read of the gen before it', async (t) => {
  const { pagesDmActivate, pagesDmAwaitsAdopt, pagesDmPrepare, pagesDmExpectAdopt } = await load()
  const page = '7b'.repeat(32)
  stub(t, flow(() => new Error('rede caiu')))
  const node = keysNode()
  const status = { gen: 0, box: null, groupBox: null, share: null, cert: CERT, legacy: false, rotatePending: false }
  const err = await caught(t, pagesDmActivate(node, { member: M, page, status, roster: { owner: M, admins: [] } }))
  t.is(err.uncertain, true)
  t.ok(pagesDmAwaitsAdopt(page), 'the uncertain publication keeps the guard')
  // The retry callback is lost with the screen; a fresh read shows gen 0, nothing pending.
  const prep = await pagesDmPrepare(node, { member: M, page, status, roster: { owner: M, admins: [] } })
  t.is(prep.gen, 1, 'the new attempt proceeds')
  pagesDmExpectAdopt(page, 1)
  const pending = await caught(t, pagesDmPrepare(node, { member: M, page, status: { ...status, rotatePending: true }, roster: { owner: M, admins: [] } }))
  t.is(pending.code, 'rotacao-necessaria', 'a pending rotation still refuses')
  const published = await caught(t, pagesDmPrepare(node, { member: M, page, status: { ...status, gen: 1, groupBox: GBOX }, roster: { owner: M, admins: [] } }))
  t.is(published.code, 'rotacao-necessaria', 'a published gen not adopted here still refuses')
})

test('Páginas: Nova página is a plus in the top bar and openable rows end in a chevron', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Paginas.js'), 'utf8')
  t.ok(src.includes("{ icon: 'plus', label: 'Nova página', onPress: onNewPage }"), 'the plus keeps the onNewPage press and its label')
  t.absent(src.includes("<Btn label='Nova página'"), 'no body button')
  t.ok(src.includes("{onOpen ? <Icon name='seta' size={20} color={colors.soft} /> : null}"), 'a chevron only on rows that open')
})
