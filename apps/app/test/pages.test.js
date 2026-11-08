// The pages client (src/pages.js). ES module loaded through import(); fetch
// and the node are stubbed, nothing touches the network.
'use strict'

const test = require('brittle')

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

test('post, reply and quote carry 1..4 media descriptors, never more', async (t) => {
  const { actAs } = await load()
  const d = { sha256: 'a'.repeat(64), mime: 'image/png', width: 1, height: 1, bytes: 10 }
  const calls = stub(t, flow(() => json(200, { seq: 1, length: 2, pushed: true })))
  await actAs(fakeNode(), { member: M, action: 'reply', page: P, op: { to: M + ':1', text: 'ok', media: [d] } })
  t.alike(body(calls[1]).op.media, [d])
  for (const media of [[], [d, d, d, d, d], 'x']) {
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
    for (const media of [[], [d, d, d, d, d], 'x']) {
      const n = calls.length
      const err = await caught(t, actAs(fakeNode(), { member: M, action, page: P, op: { title: 'x', media } }))
      t.is(err.code, 'pedido-invalido')
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

  for (const action of ['community-join', 'community-leave', 'group-join', 'group-leave', 'group-post', 'group-read']) {
    calls = stub(t, flow(() => json(200, {})))
    await pagesGroup(fakeNode(), { member: M, page: P, action, op: { group: K2 } })
    t.ok(calls[1].url.endsWith('/account/pages/' + action), action)
    t.alike(body(calls[1]).op, { group: K2 })
  }
  const err = await caught(t, pagesGroup(fakeNode(), { member: M, page: P, action: 'post', op: {} }))
  t.is(err.code, 'pedido-invalido')
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

test('dm drop observer runs once before each send fetch and never for other dm actions', async (t) => {
  const { pagesDm, setDmDropObserver } = await load()
  let drops = 0
  setDmDropObserver(() => { drops++ })
  t.teardown(() => setDmDropObserver(() => {}))
  const observed = []
  const calls = stub(t, (n, url) => {
    observed.push(drops)
    return url.endsWith('/start') ? json(200, { nonce: NONCE }) : json(200, { ok: true })
  })
  const node = fakeNode()
  for (const action of ['dm-send', 'dm-set', 'dm-seen', 'dm-list', 'dm-thread', 'dm-send']) {
    await pagesDm(node, { member: M, page: P, action })
  }
  t.alike(observed, [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2], 'only send fetches see a new marker')
  t.is(drops, 2, 'once per send run')
  t.ok(calls.every((call) => !Object.hasOwn(body(call), 'drops')), 'drops never enters an HTTP body')
})

test('dm drop observer marks every explicit retry after an uncertain send failure', async (t) => {
  const { pagesDmSend, setDmDropObserver } = await load()
  let drops = 0
  setDmDropObserver(() => { drops++ })
  t.teardown(() => setDmDropObserver(() => {}))
  const observed = []
  const calls = stub(t, (n, url) => {
    observed.push(drops)
    if (url.endsWith('/start')) return json(200, { nonce: NONCE })
    return n < 4 ? new Error('offline') : json(200, { ok: true })
  })
  const node = fakeNode()
  const err = await caught(t, pagesDmSend(node, { member: M, page: P, to: K2, text: 'Oi' }))
  t.is(err.uncertain, true)
  t.is(drops, 1, 'initial attempt is marked once')
  t.is(calls.length, 2, 'no automatic resend')
  const again = await caught(t, err.retry())
  t.is(again.uncertain, true)
  t.is(drops, 2, 'failed explicit retry is marked once more')
  t.alike(await again.retry(), { ok: true })
  t.is(drops, 3, 'successful explicit retry is marked once more')
  t.alike(observed, [0, 1, 2, 3], 'each marker precedes its fetch')
  t.is(node.signs.length, 1, 'retry never signs again')
  t.ok(calls.slice(1).every((call) => call.init.body === calls[1].init.body), 'retries preserve the signed body')
  t.ok(calls.every((call) => !Object.hasOwn(body(call), 'drops')), 'drops never enters an HTTP body')
})

test('dm builders sign and send the params of dm.list, dm.thread, dm.send, dm.set and dm.seen', async (t) => {
  const { pagesDmList, pagesDmThread, pagesDmSend, pagesDmSet, pagesDmSeen, pagesDm } = await load()
  const cases = [
    ['dm-list', pagesDmList, { folder: 'request', limit: 10 }],
    ['dm-thread', pagesDmThread, { peer: K2, before: 'f'.repeat(32) }],
    ['dm-send', pagesDmSend, { to: K2, text: 'Oi', replyTo: 'e'.repeat(32) }],
    ['dm-set', pagesDmSet, { peer: K2, state: 'blocked' }],
    ['dm-seen', pagesDmSeen, { peer: K2 }]
  ]
  for (const [action, build, op] of cases) {
    const calls = stub(t, flow(() => json(200, { ok: true })))
    const node = fakeNode()
    await build(node, { member: M, page: P, ...op })
    t.ok(calls[1].url.endsWith('/account/pages/' + action), action)
    t.alike(body(calls[1]).op, op, action)
    t.is(body(calls[1]).page, P)
    t.alike(node.signs[0].params, { action, nonce: NONCE, page: P, op })
  }
  await caught(t, pagesDm(fakeNode(), { member: M, page: P, action: 'dm-nope' }))
})

test('dm-list and dm-thread are reads: a lost answer is plain and retry signs again', async (t) => {
  const { pagesDmList, pagesDmThread } = await load()
  for (const [build, extra] of [[pagesDmList, {}], [pagesDmThread, { peer: K2 }]]) {
    let posts = 0
    const calls = stub(t, fresh(() => ++posts === 1 ? json(500, {}) : json(200, { conversations: [], messages: [] })))
    const node = fakeNode()
    const err = await caught(t, build(node, { member: M, page: P, ...extra }))
    t.absent(err.uncertain)
    await err.retry()
    t.is(node.signs.length, 2, 'signed again')
    const sent = calls.filter((c) => !c.url.endsWith('/start')).map((c) => body(c).nonce)
    t.not(sent[0], sent[1])
  }
})

test('dm-send after a lost answer is uncertain and retry resends the same signed bytes', async (t) => {
  const { pagesDmSend } = await load()
  let posts = 0
  const calls = stub(t, flow(() => ++posts === 1 ? json(500, {}) : json(200, { id: 'a'.repeat(32), at: '2026-01-01T00:00:00.000Z' })))
  const node = fakeNode()
  const err = await caught(t, pagesDmSend(node, { member: M, page: P, to: K2, text: 'Oi' }))
  t.is(err.uncertain, true)
  const res = await err.retry()
  t.is(res.id, 'a'.repeat(32))
  t.is(node.signs.length, 1, 'never signs a second message')
  t.is(calls.filter((c) => c.url.endsWith('/start')).length, 1)
  t.alike(calls[1].init.body, calls[2].init.body)
})

test('page dm request maps dm.* names, skips pull and enable, and softens unknown actions', async (t) => {
  const { pageDmRequest, pageInboxTitle, PAGE_DM_SOON, PAGE_DM_CUSTODY } = await import('../src/dm-screen.js')
  const seen = []
  const request = pageDmRequest(async (action, op) => { seen.push([action, op]); return { ok: true } })
  await request('dm.list', { folder: 'inbox' })
  await request('dm.thread', { peer: K2 })
  await request('dm.send', { to: K2, text: 'x' })
  await request('dm.set', { peer: K2, state: 'accepted' })
  await request('dm.seen', { peer: K2 })
  t.alike(seen.map((s) => s[0]), ['dm-list', 'dm-thread', 'dm-send', 'dm-set', 'dm-seen'])
  t.alike(await request('dm.pull', {}), {})
  t.alike(await request('dm.enable', {}), {})
  t.is(seen.length, 5)
  const { pageError } = await load()
  for (const code of ['pedido-invalido', 'nao-encontrado']) {
    const soon = pageDmRequest(async () => { throw pageError(code) })
    const err = await caught(t, soon('dm.list', {}))
    t.is(err.message, PAGE_DM_SOON)
  }
  const uncertain = Object.assign(new Error('x'), { uncertain: true, retry: () => {} })
  const err = await caught(t, pageDmRequest(async () => { throw uncertain })('dm.send', {}))
  t.is(err, uncertain, 'an uncertain write passes through with its retry')
  t.is(pageInboxTitle('Padaria'), 'Conversas da página Padaria')
  t.is(PAGE_DM_CUSTODY, 'A associação pode ler as mensagens desta página')
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
