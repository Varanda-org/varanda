'use strict'

const test = require('brittle')
const { createServerDispatcher, MAX_PENDING, MAX_MESSAGE } = require('..')

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

function setup ({ handlers = {}, token = null } = {}) {
  const sent = []
  const texts = []
  const protocolErrors = []
  const d = createServerDispatcher({
    handlers,
    token,
    send: (m, text) => { sent.push(m); texts.push(text) },
    onProtocolError: (e) => protocolErrors.push(e)
  })
  let id = 0
  const call = (method, params = {}) => {
    id++
    d.receive({ v: 1, id, method, params })
    return id
  }
  const byId = (i) => sent.find((m) => m.id === i)
  return { d, sent, texts, protocolErrors, call, byId }
}

test('session.open must come first', async (t) => {
  const s = setup({ handlers: { 'node.info': async () => ({ publicKey: null }) } })
  const a = s.call('node.info')
  t.alike(s.byId(a).error.code, 'UNAUTHORIZED')
  const b = s.call('session.open')
  t.alike(s.byId(b), { v: 1, id: b, ok: true, result: { protocol: 1 } })
  t.ok(s.d.opened)
  const c = s.call('node.info')
  await flush()
  t.alike(s.byId(c).result, { publicKey: null })
  const e = s.call('session.open')
  t.is(s.byId(e).error.code, 'USAGE', 'second open')
})

test('null-token mode rejects any token', async (t) => {
  const s = setup()
  const a = s.call('session.open', { token: 'x' })
  t.is(s.byId(a).error.code, 'UNAUTHORIZED')
  t.is(s.protocolErrors.length, 1)
  t.ok(s.d.closed, 'failed open closes the dispatcher')
  s.call('session.open')
  t.is(s.sent.length, 1, 'nothing sent after close')
})

test('token mode: missing, wrong, right', (t) => {
  let s = setup({ token: 'secret-token' })
  t.is(s.byId(s.call('session.open')).error.code, 'UNAUTHORIZED')
  s = setup({ token: 'secret-token' })
  t.is(s.byId(s.call('session.open', { token: 'secret-tokem' })).error.code, 'UNAUTHORIZED')
  s = setup({ token: 'secret-token' })
  t.is(s.byId(s.call('session.open', { token: 'secret-token-longer' })).error.code, 'UNAUTHORIZED')
  s = setup({ token: 'secret-token' })
  t.ok(s.byId(s.call('session.open', { token: 'secret-token' })).ok)
})

test('constructor arguments', async (t) => {
  await t.exception.all(() => createServerDispatcher({ send () {} }), /handlers/)
  await t.exception.all(() => createServerDispatcher({ handlers: {} }), /send/)
  await t.exception.all(() => createServerDispatcher({ handlers: {}, send () {}, token: '' }), /token/)
})

test('invalid envelopes: with an id -> USAGE, without -> protocol error', (t) => {
  const s = setup()
  s.d.receive({ v: 1, id: 7, method: 'nope', params: {} })
  t.is(s.byId(7).error.code, 'USAGE')
  s.d.receive({ v: 1, id: 8, method: 'session.open', params: { extra: 1 } })
  t.is(s.byId(8).error.code, 'USAGE')
  s.d.receive({ v: 1, method: 'node.info', params: {} })
  s.d.receive('garbage')
  t.is(s.protocolErrors.length, 2)
  t.is(s.sent.length, 2)
})

test('duplicate pending id is rejected', async (t) => {
  let release
  const s = setup({ handlers: { 'node.info': () => new Promise((resolve) => { release = resolve }) } })
  s.call('session.open')
  s.d.receive({ v: 1, id: 50, method: 'node.info', params: {} })
  s.d.receive({ v: 1, id: 50, method: 'node.info', params: {} })
  t.is(s.sent.length, 2)
  t.is(s.sent[1].error.code, 'USAGE')
  t.is(s.sent[1].error.message, 'id repetido')
  await flush()
  release({ a: 1 })
  await flush()
  t.alike(s.sent[2], { v: 1, id: 50, ok: true, result: { a: 1 } })
  // Reusing an id after completion is fine.
  s.d.receive({ v: 1, id: 50, method: 'node.info', params: {} })
  t.is(s.d.pending, 1)
})

test('pending cap: excess -> USAGE immediately', async (t) => {
  const releases = []
  const s = setup({ handlers: { 'node.info': () => new Promise((resolve) => releases.push(resolve)) } })
  s.call('session.open')
  const ids = []
  for (let i = 0; i < MAX_PENDING; i++) ids.push(s.call('node.info'))
  await flush()
  t.is(releases.length, MAX_PENDING)
  const extra = s.call('node.info')
  t.is(s.byId(extra).error.code, 'USAGE')
  t.is(releases.length, MAX_PENDING, 'handler not called for the excess')
  releases[0]({})
  await flush()
  const next = s.call('node.info')
  await flush()
  t.absent(s.byId(next), 'accepted again once a slot is free')
  t.is(releases.length, MAX_PENDING + 1)
})

test('handlers get normalized params', async (t) => {
  let got = null
  const s = setup({ handlers: { 'feed.read': async (p) => { got = p; return { items: [] } } } })
  s.call('session.open')
  s.call('feed.read', {})
  await flush()
  t.alike(got, { limit: 30 })
})

test('error mapping', async (t) => {
  const err = (code, message) => Object.assign(new Error(message), code ? { code } : {})
  const s = setup({
    handlers: {
      'identity.show': async () => { throw err('NOT_FOUND', 'identidade não encontrada') },
      'post.create': async () => { throw err('LOCKED', 'diretório de dados em uso') },
      'node.info': async () => { throw err(null, 'ENOENT: /home/ana/.varanda/config.json') },
      'follow.list': async () => { throw err('EACCES', 'permission denied /x') },
      'feed.read': async () => { throw err('USAGE', 'falhou em /home/ana/data') },
      'log.read': async () => { throw err('USAGE', 'chave ' + 'ab'.repeat(32)) },
      'sync.status': async () => { throw err('INTERNAL', 'detalhe interno') },
      'sync.stop': () => { throw err('TIMEOUT', 'x') },
      'cert.add': async () => { throw 'string' } // eslint-disable-line no-throw-literal
    }
  })
  s.call('session.open')
  const ids = {
    show: s.call('identity.show'),
    post: s.call('post.create', { text: 'x' }),
    info: s.call('node.info'),
    list: s.call('follow.list'),
    feed: s.call('feed.read'),
    log: s.call('log.read')
  }
  await flush()
  const ids2 = {
    status: s.call('sync.status'),
    stop: s.call('sync.stop'),
    cert: s.call('cert.add', { cert: {} })
  }
  await flush()
  t.alike(s.byId(ids.show).error, { code: 'NOT_FOUND', message: 'identidade não encontrada' })
  t.alike(s.byId(ids.post).error, { code: 'LOCKED', message: 'diretório de dados em uso' })
  t.alike(s.byId(ids.info).error, { code: 'INTERNAL', message: 'erro interno' }, 'INTERNAL hides the message')
  t.alike(s.byId(ids.list).error, { code: 'INTERNAL', message: 'erro interno' }, 'unknown code -> INTERNAL')
  t.alike(s.byId(ids.feed).error, { code: 'USAGE', message: 'pedido inválido' }, 'path-like message replaced')
  t.alike(s.byId(ids.log).error, { code: 'USAGE', message: 'pedido inválido' }, 'key-like message replaced')
  t.alike(s.byId(ids2.status).error, { code: 'INTERNAL', message: 'erro interno' })
  t.alike(s.byId(ids2.stop).error, { code: 'INTERNAL', message: 'erro interno' }, 'client-only code is not sent')
  t.alike(s.byId(ids2.cert).error, { code: 'INTERNAL', message: 'erro interno' })
})

test('missing handler, bad results', async (t) => {
  const cyclic = {}
  cyclic.self = cyclic
  const s = setup({ handlers: { 'follow.list': async () => [1], 'feed.read': async () => cyclic, 'sync.status': async () => 1n } })
  s.call('session.open')
  const a = s.call('node.info')
  const b = s.call('follow.list')
  const c = s.call('feed.read')
  const d = s.call('sync.status')
  await flush()
  for (const id of [a, b, c, d]) t.is(s.byId(id).error.code, 'INTERNAL')
})

test('node.close: answered only where a handler is registered (IPC worklet)', async (t) => {
  const plain = setup({ handlers: {} })
  plain.call('session.open')
  const a = plain.call('node.close')
  await flush()
  t.alike(plain.byId(a).error, { code: 'INTERNAL', message: 'erro interno' }, 'no handler (varanda-serve) -> INTERNAL')
  const ipc = setup({ handlers: { 'node.close': async () => ({ closed: true }) } })
  ipc.call('session.open')
  const b = ipc.call('node.close')
  const c = ipc.call('node.close', { x: 1 })
  await flush()
  t.alike(ipc.byId(b).result, { closed: true })
  t.is(ipc.byId(c).error.code, 'USAGE', 'params must be {}')
})

test('web-node host controls: INTERNAL without a handler, as node.close', async (t) => {
  const calls = [
    ['identity.install', { prf: 'cd'.repeat(32), credentialId: 'abc', userId: '', rpId: 'varanda.org', resumed: false }],
    ['identity.clear', {}],
    ['identity.status', {}],
    ['identity.reset', {}],
    ['identity.forget', {}],
    ['identity.sessionSaved', {}],
    ['media.uploadFile', { name: '0123456789abcdef0123456789abcdef.bin', mime: 'image/jpeg', width: 10, height: 10 }]
  ]
  const plain = setup({ handlers: {} })
  plain.call('session.open')
  const ids = calls.map(([m, p]) => plain.call(m, p))
  await flush()
  for (let i = 0; i < ids.length; i++) {
    t.alike(plain.byId(ids[i]).error, { code: 'INTERNAL', message: 'erro interno' }, calls[i][0] + ' without a handler -> INTERNAL')
  }
})

test('a result whose traps throw becomes INTERNAL', async (t) => {
  const hostile = new Proxy({}, { getPrototypeOf () { throw new Error('trap') } })
  const s = setup({ handlers: { 'node.info': async () => hostile } })
  s.call('session.open')
  const id = s.call('node.info')
  await flush()
  t.is(s.byId(id).error.code, 'INTERNAL')
})

test('a request queued before close never runs its handler', async (t) => {
  let ran = false
  const s = setup({ handlers: { 'sync.start': async () => { ran = true; return { runId: 1 } } } })
  s.call('session.open')
  s.call('sync.start')
  s.d.close()
  await flush()
  t.absent(ran, 'handler not called')
  t.is(s.sent.length, 1, 'only the open response was sent')
})

test('oversized response -> USAGE resposta grande demais', async (t) => {
  const s = setup({ handlers: { 'feed.read': async () => ({ items: ['x'.repeat(MAX_MESSAGE)] }) } })
  s.call('session.open')
  const id = s.call('feed.read')
  await flush()
  t.alike(s.byId(id).error, { code: 'USAGE', message: 'resposta grande demais' })
  t.ok(s.texts.every((x) => x.length <= MAX_MESSAGE))
})

test('events: only after open, seq from 1, oversized replaced', (t) => {
  const s = setup()
  t.absent(s.d.emit('warning', { line: 'antes' }), 'no event before open')
  t.is(s.sent.length, 0)
  s.call('session.open')
  t.ok(s.d.emit('sync.event', { runId: 1, line: 'sync ready' }))
  t.absent(s.d.emit('sync.event', { runId: 1, line: 'x', extra: 1 }), 'invalid event dropped')
  t.absent(s.d.emit('nope', {}))
  t.absent(s.d.emit('sync.stopped', { runId: 1, reason: 'done', result: { big: 'x'.repeat(MAX_MESSAGE) } }))
  t.ok(s.d.emit('warning', { line: 'aviso' }))
  const events = s.sent.filter((m) => m.event)
  t.alike(events.map((e) => [e.seq, e.event, e.data]), [
    [1, 'sync.event', { runId: 1, line: 'sync ready' }],
    [2, 'warning', { line: 'evento grande demais' }],
    [3, 'warning', { line: 'aviso' }]
  ])
})

test('close stops everything', async (t) => {
  let release
  const s = setup({ handlers: { 'node.info': () => new Promise((resolve) => { release = resolve }) } })
  s.call('session.open')
  s.call('node.info')
  await flush()
  s.d.close()
  release({})
  await flush()
  t.absent(s.d.emit('warning', { line: 'x' }))
  s.call('node.info')
  t.is(s.sent.length, 1, 'only the open response was sent')
})

test('a throwing send never breaks the dispatcher', async (t) => {
  const d = createServerDispatcher({ handlers: {}, send () { throw new Error('socket gone') } })
  d.receive({ v: 1, id: 1, method: 'session.open', params: {} })
  t.ok(d.opened)
  t.ok(d.emit('warning', { line: 'x' }))
})
