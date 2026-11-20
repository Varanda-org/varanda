'use strict'

// The sealed outbox rules of the app (src/outboxSeal.js): open pass outcomes
// per node answer, the v1 migration, the approval fingerprint and what the
// drain may send, against a fake node whose box is plain base64url JSON (the
// real one is a secretbox; only its binding to the item matters here). The
// module imports ./outbox without an extension, as Metro resolves it, so a
// module hook adds '.js' for relative imports under src/.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const hooks = `
export async function resolve (specifier, context, next) {
  if (/^\\.\\.?\\/[^.]*$/.test(specifier) && context.parentURL && context.parentURL.includes('/src/')) {
    return next(specifier + '.js', context)
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const load = async () => ({ o: await import('../src/outbox.js'), s: await import('../src/outboxSeal.js') })

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const ASSOC = 'c'.repeat(64)
const T0 = Date.parse('2026-11-15T12:00:00.000Z')
const idOf = (n) => n.toString(16).padStart(16, '0')

// A fake node unlocked as `unlocked`, answering like the web-member session
// (USAGE with a message): seal refuses another author; open refuses another
// author and a box that does not decode or whose sealed fields differ from
// the params.
const WRONG_AUTHOR = 'item da fila de saída de outra identidade'
const BAD_BOX = 'item da fila de saída inválido'
function fakeNode ({ unlocked = A, locked = false, fail = null } = {}) {
  const calls = []
  const refuse = (message) => Object.assign(new Error(message), { code: 'USAGE' })
  const call = async (method, params) => {
    calls.push([method, params])
    if (fail) {
      const err = fail(method, params)
      if (err) throw err
    }
    if (locked) throw Object.assign(new Error('identidade bloqueada: entre com a passkey'), { code: 'USAGE' })
    if (params.author !== unlocked) throw refuse(WRONG_AUTHOR)
    if (method === 'outbox.seal') {
      const sealed = [1, params.id, params.author, params.association, params.kind, params.to, params.text, params.writtenAt]
      return { box: Buffer.from(JSON.stringify(sealed)).toString('base64url') }
    }
    let sealed
    try {
      sealed = JSON.parse(Buffer.from(params.box, 'base64url').toString())
    } catch {
      throw refuse(BAD_BOX)
    }
    if (!Array.isArray(sealed) || sealed[0] !== 1) throw refuse(BAD_BOX)
    const [, id, author, association, kind, to, text, writtenAt] = sealed
    if (id !== params.id || author !== params.author || association !== params.association || kind !== params.kind || writtenAt !== params.writtenAt) throw refuse(BAD_BOX)
    return { to, text }
  }
  return { calls, call }
}

// The stored queue as the app keeps it: serialized text, read-modify-write.
function storeOf (o, items) {
  let raw = o.serializeOutbox(items)
  return {
    raw: () => raw,
    plant: (text) => { raw = text },
    load: () => o.parseOutbox(raw),
    mutate: (op) => {
      const fresh = o.parseOutbox(raw)
      const next = op(fresh)
      if (next !== fresh) raw = o.serializeOutbox(next)
      return true
    }
  }
}

// A v2 item sealed by `node`, as `add` stores it.
async function sealedItem (o, node, items, fields) {
  const f = { author: A, association: ASSOC, kind: 'post', to: null, text: 'olá', now: T0, id: idOf(1), ...fields }
  const { box } = await node.call('outbox.seal', { id: f.id, author: f.author, association: f.association, kind: f.kind, to: f.to, text: f.text, writtenAt: o.writtenAtOf(f.now) })
  return o.enqueue(items, { ...f, box })
}

// A v1 item as stored before the seal.
function legacyItem (o, fields) {
  const [v2] = o.enqueue([], { author: A, association: ASSOC, kind: 'post', to: null, text: 'antigo', now: T0, id: idOf(9), box: 'Q'.repeat(60) })
  const { box, ...rest } = o.storedItem(v2)
  return { ...rest, v: 1, to: null, text: 'antigo', ...fields }
}

const always = () => true

test('failureAction: BAD_BOX drops, WRONG_AUTHOR skips, LOCKED stops, the rest retries', async (t) => {
  const { s } = await load()
  const err = (code, message = 'x') => Object.assign(new Error(message), { code })
  t.is(s.failureAction(err('USAGE', BAD_BOX), 'outbox.open'), 'drop', 'the session BAD_BOX message')
  t.is(s.failureAction(err('USAGE', 'parâmetro inválido: box'), 'outbox.open'), 'drop', 'a stored field the node refuses')
  t.is(s.failureAction(err('USAGE', 'parâmetro inválido: text'), 'outbox.seal'), 'skip', 'a v1 item the node refuses stays')
  t.is(s.failureAction(err('USAGE', WRONG_AUTHOR), 'outbox.open'), 'skip', 'the session WRONG_AUTHOR message')
  t.is(s.failureAction(err('USAGE', 'x ' + BAD_BOX), 'outbox.open'), 'skip', 'the whole message, not a substring')
  t.is(s.failureAction(err('BAD_BOX'), 'outbox.open'), 'drop')
  t.is(s.failureAction(err('BAD_BOX'), 'outbox.seal'), 'skip', 'seal never drops')
  t.is(s.failureAction(err('WRONG_AUTHOR'), 'outbox.open'), 'skip')
  t.is(s.failureAction(err('LOCKED'), 'outbox.open'), 'stop')
  t.is(s.failureAction(err('USAGE', 'identidade bloqueada: entre com a passkey'), 'outbox.open'), 'stop', 'the session locked message')
  t.is(s.failureAction(err('CLOSED'), 'outbox.open'), 'stop')
  t.is(s.failureAction(new Error('sem conexão com o nó'), 'outbox.seal'), 'stop')
  t.is(s.failureAction(err('USAGE', 'método desconhecido'), 'outbox.open'), 'skip', 'an older node: kept, never dropped')
  t.is(s.failureAction(err('INTERNAL', 'erro interno'), 'outbox.open'), 'retry', 'INTERNAL may pass')
  t.is(s.failureAction(err('INTERNAL', 'erro interno'), 'outbox.seal'), 'retry')
  t.is(s.failureAction(err('UNAUTHORIZED', 'não autorizado'), 'outbox.open'), 'retry')
  t.is(s.failureAction(new Error('algo falhou'), 'outbox.open'), 'retry', 'no code, unknown message')
  t.is(s.failureAction(null, 'outbox.open'), 'retry')
  t.is(s.failureAction(err('USAGE', 'pedidos demais em andamento'), 'outbox.open'), 'stop', 'too many requests: the pass stops')
  t.is(s.failureAction(new Error('pedidos demais em andamento'), 'outbox.seal'), 'stop')
  t.is(s.failureAction(err('TIMEOUT', 'tempo esgotado'), 'outbox.open'), 'stop')
  t.is(s.failureAction(err('USAGE', 'parâmetro inválido: writtenAt'), 'outbox.open'), 'skip', 'another field the validator refuses: kept')
  t.is(s.failureAction(err('USAGE', 'parâmetro obrigatório: box'), 'outbox.open'), 'skip')
  t.is(s.failureAction(new Error('parâmetro inválido: writtenAt'), 'outbox.open'), 'skip', 'the validator message without a code')
  t.is(s.failureAction(err('USAGE', 'parâmetro inválido: box'), 'outbox.seal'), 'skip', 'seal never drops')
  t.is(s.failureAction(err('USAGE', 'pedido inválido'), 'outbox.open'), 'skip', 'any other USAGE is definitive')
  t.alike(Object.keys(s.SEAL_ERRORS).sort(), ['badBox', 'locked', 'wrongAuthor'])
})

test('open pass: INTERNAL leaves the item, goes on and ends retry', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1), text: 'primeiro' })
  items = await sealedItem(o, node, items, { id: idOf(2), text: 'segundo', now: T0 + 1 })
  items = [...items, legacyItem(o, { id: idOf(3) })]
  const store = storeOf(o, items)
  const opened = new Map()
  const fail = (method, params) => params.id === idOf(1) || method === 'outbox.seal' ? Object.assign(new Error('erro interno'), { code: 'INTERNAL' }) : null
  const flaky = fakeNode({ fail })
  const result = await s.openPass({ items: store.load(), author: A, opened, call: flaky.call, mutate: store.mutate, current: always })
  t.is(result, 'retry')
  t.is(flaky.calls.length, 3, 'every item was tried')
  t.alike(store.load().map((i) => [i.id, i.v]), [[idOf(1), 2], [idOf(2), 2], [idOf(3), 1]], 'nothing dropped, the v1 item not sealed yet')
  t.is(s.openedOf(opened, store.load()[0]), null)
  t.alike(s.openedOf(opened, store.load()[1]), { to: null, text: 'segundo' })
  t.ok(s.passAgainLater(result), 'the provider runs it again later')
  const again = await s.openPass({ items: store.load(), author: A, opened, call: node.call, mutate: store.mutate, current: always })
  t.is(again, 'done', 'once the node answers, the pass is done')
  t.alike(s.openedOf(opened, store.load()[0]), { to: null, text: 'primeiro' })
  t.is(store.load()[2].v, 2, 'the v1 item sealed on the next pass')
  t.absent(s.passAgainLater(again))
})

test('open pass: a stop after a retry still ends stopped', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1) })
  items = await sealedItem(o, node, items, { id: idOf(2), now: T0 + 1 })
  const store = storeOf(o, items)
  const fail = (method, params) => params.id === idOf(1)
    ? Object.assign(new Error('erro interno'), { code: 'INTERNAL' })
    : Object.assign(new Error('pedidos demais em andamento'), { code: 'USAGE' })
  const result = await s.openPass({ items: store.load(), author: A, opened: new Map(), call: fakeNode({ fail }).call, mutate: store.mutate, current: always })
  t.is(result, 'stopped')
  t.is(store.load().length, 2)
})

test('passAgainLater: stopped and retry run again, done and stale do not', async (t) => {
  const { s } = await load()
  t.ok(s.passAgainLater('stopped'))
  t.ok(s.passAgainLater('retry'))
  t.absent(s.passAgainLater('done'))
  t.absent(s.passAgainLater('stale'))
})

test('open pass: only a refused box drops; another refused field keeps the item', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1), text: 'campo recusado' })
  items = await sealedItem(o, node, items, { id: idOf(2), text: 'caixa recusada', now: T0 + 1 })
  const store = storeOf(o, items)
  const refuse = (message) => Object.assign(new Error(message), { code: 'USAGE' })
  const fail = (method, params) => params.id === idOf(1) ? refuse('parâmetro inválido: writtenAt') : refuse('parâmetro inválido: box')
  const result = await s.openPass({ items: store.load(), author: A, opened: new Map(), call: fakeNode({ fail }).call, mutate: store.mutate, current: always })
  t.is(result, 'done')
  t.alike(store.load().map((i) => i.id), [idOf(1)], 'the refused box is gone, the other item stays')
})

test('keepsClearText: only for the identity still unlocked at the save', async (t) => {
  const { s } = await load()
  const identity = { key: A, generation: 1 }
  t.ok(s.keepsClearText(identity, identity, A))
  t.absent(s.keepsClearText(identity, null, A), 'locked during the seal')
  t.absent(s.keepsClearText(identity, { key: A, generation: 1 }, A), 'locked and unlocked again: another identity value')
  t.absent(s.keepsClearText(identity, { key: B, generation: 2 }, A), 'switched to another identity')
  t.absent(s.keepsClearText(identity, identity, B), 'not the item\'s author')
  t.absent(s.keepsClearText(null, null, A), 'nothing unlocked when it began')
})

test('the drain\'s view: an item not open never holds the pair', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1), text: 'fechado' })
  items = await sealedItem(o, node, items, { id: idOf(2), text: 'aberto', now: T0 + 1 })
  items = o.claim(items, idOf(1), { now: T0, floorSeq: 5 })
  items = o.claim(items, idOf(2), { now: T0, floorSeq: 5 })
  const opened = new Map()
  s.remember(opened, items[1], { to: null, text: 'aberto' })
  t.alike(s.openedOnly(items, opened).map((i) => [i.id, i.text]), [[idOf(2), 'aberto']])
  t.is(o.sendingOf(s.openedOnly(items, opened), A, ASSOC).id, idOf(2), 'the open sending item, not the sealed one before it')
  t.is(o.sendingOf(s.openedOnly(items.slice(0, 1), opened), A, ASSOC), null, 'a sending item not open: nothing holds the pair')
  const page = { entries: [{ seq: 6, record: { type: 'post', text: 'aberto', replyTo: null, at: new Date(T0).toISOString() } }], entriesTruncated: 6 }
  const r = s.reconcileOpened(items, opened, A, ASSOC, page, T0)
  t.is(r.status, 'sent')
  t.is(r.sent.item.id, idOf(2))
  t.alike(r.items, [items[0]], 'the open item is settled, the sealed one stays as stored')
  t.absent(o.serializeOutbox(r.items).includes('aberto'))
  const absent = s.reconcileOpened(items, opened, A, ASSOC, { entries: [], entriesTruncated: 0 }, T0)
  t.is(absent.status, 'absent')
  t.alike(absent.items.map((i) => [i.id, i.state]), [[idOf(1), 'sending'], [idOf(2), 'queued']])
  t.absent('text' in absent.items[1], 'the stored form')
  const none = s.reconcileOpened(items.slice(0, 1), opened, A, ASSOC, page, T0)
  t.is(none.status, 'none')
  t.is(none.items.length, 1)
})

test('apagar: an item not open goes whatever its state; an open sending one stays', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1) })
  items = await sealedItem(o, node, items, { id: idOf(2), now: T0 + 1 })
  items = o.claim(items, idOf(1), { now: T0, floorSeq: 5 })
  items = o.claim(items, idOf(2), { now: T0, floorSeq: 5 })
  const opened = new Map()
  s.remember(opened, items[1], { to: null, text: 'olá' })
  t.alike(s.discardItem(items, idOf(1), opened).map((i) => i.id), [idOf(2)], 'not open: removed though sending')
  t.is(s.discardItem(items, idOf(2), opened), items, 'open and sending: left to reconcile')
  t.is(s.discardItem(items, idOf(7), opened), items, 'unknown id')
  const queued = o.markQueued(o.markUncertain(items, idOf(2)), idOf(2))
  t.alike(s.discardItem(queued, idOf(2), opened).map((i) => i.id), [idOf(1)], 'open and not sending: removed')
  const legacySending = { ...legacyItem(o, { id: idOf(3) }), state: 'sending', floorSeq: 1, attemptAt: T0 }
  t.alike(s.discardItem([legacySending], idOf(3), opened), [], 'a v1 item is never open here')
  const shown = s.shownItems(items, opened)
  t.alike(shown.map((i) => s.canDiscard(i)), [true, false], 'Diário: apagar for the sealed sending item only')
  t.ok(s.canDiscard({ state: 'queued', opened: true }))
})

test('open pass: a v1 item of the unlocked identity is sealed once, another identity\'s stays', async (t) => {
  const { o, s } = await load()
  const mine = legacyItem(o, { id: idOf(1), text: 'meu antigo' })
  const theirs = legacyItem(o, { id: idOf(2), author: B, text: 'de outra pessoa' })
  const store = storeOf(o, [mine, theirs])
  t.ok(store.raw().includes('meu antigo'), 'v1 is in the clear before the pass')
  const node = fakeNode()
  const opened = new Map()
  const result = await s.openPass({ items: store.load(), author: A, opened, call: node.call, mutate: store.mutate, current: always })
  t.is(result, 'done')
  t.alike(node.calls.map(([m, p]) => [m, p.id]), [['outbox.seal', idOf(1)]], 'only the unlocked identity\'s item')
  const [a, b] = store.load()
  t.is(a.v, 2)
  t.ok(o.validBox(a.box))
  t.absent('text' in a)
  t.absent('to' in a)
  t.is(a.writtenAt, mine.writtenAt)
  t.absent(store.raw().includes('meu antigo'), 'the text left the stored value')
  t.alike(s.openedOf(opened, a), { to: null, text: 'meu antigo' }, 'open in memory')
  t.alike(b, theirs, 'another identity: untouched v1')
  const again = await s.openPass({ items: store.load(), author: A, opened, call: node.call, mutate: store.mutate, current: always })
  t.is(again, 'done')
  t.is(node.calls.length, 1, 'nothing more to seal or open')
})

test('open pass: v1 changed in storage while sealing is not overwritten', async (t) => {
  const { o, s } = await load()
  const mine = legacyItem(o, { id: idOf(1), text: 'primeiro' })
  const store = storeOf(o, [mine])
  const node = fakeNode()
  const call = async (method, params) => {
    const answer = await node.call(method, params)
    store.plant(o.serializeOutbox([{ ...mine, text: 'trocado' }]))
    return answer
  }
  const opened = new Map()
  await s.openPass({ items: store.load(), author: A, opened, call, mutate: store.mutate, current: always })
  const [item] = store.load()
  t.is(item.v, 1, 'still v1: the sealed text is not the stored one')
  t.is(item.text, 'trocado')
  t.is(opened.size, 0)
})

test('open pass: BAD_BOX removes the item, WRONG_AUTHOR leaves it, the rest is opened', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1), text: 'primeiro', now: T0 })
  items = await sealedItem(o, node, items, { id: idOf(2), text: 'segundo', now: T0 + 1 })
  items = await sealedItem(o, node, items, { id: idOf(3), text: 'terceiro', now: T0 + 2 })
  // Item 2 altered in storage: another writtenAt under the same box.
  items = items.map((item) => item.id === idOf(2) ? { ...item, writtenAt: new Date(T0 + 5000).toISOString() } : item)
  const store = storeOf(o, items)
  const opened = new Map()
  const fail = (method, params) => params.id === idOf(1) ? Object.assign(new Error(WRONG_AUTHOR), { code: 'USAGE' }) : null
  const result = await s.openPass({ items: store.load(), author: A, opened, call: fakeNode({ fail }).call, mutate: store.mutate, current: always })
  t.is(result, 'done')
  t.alike(store.load().map((i) => i.id), [idOf(1), idOf(3)], 'the altered item is gone')
  t.is(s.openedOf(opened, store.load()[0]), null, 'WRONG_AUTHOR: kept, not open')
  t.alike(s.openedOf(opened, store.load()[1]), { to: null, text: 'terceiro' })
})

test('open pass: LOCKED stops at once and changes nothing', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1) })
  items = await sealedItem(o, node, items, { id: idOf(2), now: T0 + 1 })
  items = [...items, legacyItem(o, { id: idOf(3) })]
  const store = storeOf(o, items)
  const before = store.raw()
  const lockedNode = fakeNode({ locked: true })
  const opened = new Map()
  const result = await s.openPass({ items: store.load(), author: A, opened, call: lockedNode.call, mutate: store.mutate, current: always })
  t.is(result, 'stopped')
  t.is(lockedNode.calls.length, 1, 'no call after the first LOCKED')
  t.is(store.raw(), before)
  t.is(opened.size, 0)
})

test('open pass: an identity change mid-pass caches nothing', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  const items = await sealedItem(o, node, [], { id: idOf(1) })
  const store = storeOf(o, items)
  let unlocked = true
  const call = async (method, params) => {
    const answer = await node.call(method, params)
    unlocked = false
    return answer
  }
  const opened = new Map()
  const result = await s.openPass({ items: store.load(), author: A, opened, call, mutate: store.mutate, current: () => unlocked })
  t.is(result, 'stale')
  t.is(opened.size, 0)
})

test('open pass: an answer that is not a valid target and text is not cached', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  const items = await sealedItem(o, node, [], { id: idOf(1) })
  const store = storeOf(o, items)
  for (const answer of [{ to: null, text: '' }, { to: B + ':1', text: 'ok' }, { to: null, text: 'a‮b' }, null, 'olá']) {
    const opened = new Map()
    await s.openPass({ items: store.load(), author: A, opened, call: async () => answer, mutate: store.mutate, current: always })
    t.is(opened.size, 0, JSON.stringify(answer))
  }
  t.is(store.load().length, 1, 'never dropped for a bad answer')
})

test('the approval fingerprint covers the box', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  const [item] = await sealedItem(o, node, [], { text: 'um' })
  const [other] = await sealedItem(o, node, [], { text: 'dois' })
  t.is(s.fingerprintOf(item), JSON.stringify([A, ASSOC, 'post', item.box]))
  const allowed = new Map([[item.id, s.fingerprintOf(item)]])
  t.ok(s.approved(allowed, item))
  t.absent(s.approved(allowed, { ...item, box: other.box }), 'same id, another box: not approved')
  t.absent(s.approved(allowed, { ...item, association: B }))
  t.is(s.fingerprintOf(legacyItem(o, {})), null, 'a v1 item is never approved')
  t.absent(s.approved(new Map([[idOf(9), null]]), legacyItem(o, {})))
})

test('the drain sends only approved items that are open, with the opened text', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1), text: 'aprovado e aberto' })
  items = await sealedItem(o, node, items, { id: idOf(2), text: 'aberto', now: T0 + 1 })
  items = await sealedItem(o, node, items, { id: idOf(3), text: 'aprovado', now: T0 + 2 })
  const allowed = new Map(items.filter((i) => i.id !== idOf(2)).map((i) => [i.id, s.fingerprintOf(i)]))
  const opened = new Map()
  for (const item of items.slice(0, 2)) s.remember(opened, item, (await node.call('outbox.open', o.openParams(item))))
  const out = s.sendable(items, allowed, opened)
  t.alike(out.map((i) => [i.id, i.text]), [[idOf(1), 'aprovado e aberto']])
  t.alike(o.rpcParams(out[0]), { text: 'aprovado e aberto' })
  // The box replaced in storage (same id): the cached text is not this item's.
  const swapped = items.map((i) => i.id === idOf(1) ? { ...i, box: items[2].box } : i)
  t.alike(s.sendable(swapped, allowed, opened), [], 'another box: neither approved nor open')
  t.alike(s.sendable(items.map((i) => ({ ...i, writtenAt: new Date(T0 + 9000).toISOString() })), allowed, opened), [], 'another sealed field: not open')
})

test('an item planted in storage without a valid box is never sent and is dropped by the pass', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  const real = await sealedItem(o, node, [], { id: idOf(1), text: 'meu' })
  const planted = { ...real[0], id: idOf(2), box: Buffer.from(JSON.stringify([1, idOf(2), A, ASSOC, 'post', null, 'plantado', real[0].writtenAt + 'x'])).toString('base64url') }
  const malformed = { ...real[0], id: idOf(3), box: 'curta' }
  const clear = { ...real[0], id: idOf(4), box: undefined, to: null, text: 'em claro' }
  const store = storeOf(o, [])
  store.plant(JSON.stringify({ v: 2, items: [...real, planted, malformed, clear] }))
  t.alike(store.load().map((i) => i.id), [idOf(1), idOf(2)], 'a malformed box or a v2 without box never loads')
  // Even with an approval for its exact content, a planted item is not open.
  const allowed = new Map(store.load().map((i) => [i.id, s.fingerprintOf(i)]))
  const opened = new Map()
  t.alike(s.sendable(store.load(), allowed, opened), [], 'nothing open: nothing sendable')
  const result = await s.openPass({ items: store.load(), author: A, opened, call: node.call, mutate: store.mutate, current: always })
  t.is(result, 'done')
  t.alike(store.load().map((i) => i.id), [idOf(1)], 'the planted item was dropped')
  t.absent(store.raw().includes('curta'), 'the rewrite left the malformed one out too')
  t.alike(s.sendable(store.load(), allowed, opened).map((i) => [i.id, i.text]), [[idOf(1), 'meu']])
})

test('the text is never in the serialized storage value', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1), text: 'segredo do post' })
  items = await sealedItem(o, node, items, { id: idOf(2), kind: 'reply', to: B + ':7', text: 'segredo da resposta', now: T0 + 1 })
  const opened = new Map()
  for (const item of items) s.remember(opened, item, await node.call('outbox.open', o.openParams(item)))
  const open = s.withOpened(items, opened)
  t.is(open[1].text, 'segredo da resposta', 'open in memory')
  t.is(open[1].to, B + ':7')
  for (const value of [o.serializeOutbox(items), o.serializeOutbox(open), o.serializeOutbox(s.withoutOpened(open)), o.serializeOutbox(s.shownItems(items, opened))]) {
    t.absent(value.includes('segredo'), 'no text')
    t.absent(value.includes(B + ':7'), 'no target')
  }
  t.alike(s.withoutOpened(open), items)
})

test('shownItems: open items carry the text, the others none', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1), text: 'aberto' })
  items = await sealedItem(o, node, items, { id: idOf(2), text: 'fechado', now: T0 + 1 })
  items = [...items, legacyItem(o, { id: idOf(3) })]
  const opened = new Map()
  s.remember(opened, items[0], { to: null, text: 'aberto' })
  const shown = s.shownItems(items, opened)
  t.alike(shown.map((i) => [i.id, i.opened, i.text]), [[idOf(1), true, 'aberto'], [idOf(2), false, null], [idOf(3), false, null]])
})

test('reconcile on open items settles a sending item, and waits while it is sealed', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  let items = await sealedItem(o, node, [], { id: idOf(1), text: 'oi' })
  items = o.claim(items, idOf(1), { now: T0, floorSeq: 5 })
  const page = { entries: [{ seq: 6, record: { type: 'post', text: 'oi', replyTo: null, at: new Date(T0).toISOString() } }], entriesTruncated: 6 }
  const sealed = o.reconcile(items, A, ASSOC, page, T0)
  t.is(sealed.status, 'sealed')
  t.is(sealed.items, items, 'nothing changes')
  const opened = new Map()
  s.remember(opened, items[0], { to: null, text: 'oi' })
  const r = o.reconcile(s.withOpened(items, opened), A, ASSOC, page, T0)
  t.is(r.status, 'sent')
  t.alike(r.items, [])
})

test('dropSealed and migrate leave an unrelated queue as the same array', async (t) => {
  const { o, s } = await load()
  const node = fakeNode()
  const items = await sealedItem(o, node, [], { id: idOf(1) })
  t.is(s.dropSealed(items, { ...items[0], id: idOf(2) }), items)
  t.is(s.dropSealed(items, { ...items[0], box: 'Q'.repeat(60) }), items, 'another box: not that item')
  t.alike(s.dropSealed(items, items[0]), [])
  t.is(s.migrate(items, legacyItem(o, { id: idOf(1) }), 'Q'.repeat(60)), items, 'already v2')
})
