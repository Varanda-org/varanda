// The browser node session's RPC handlers (lib/session.js through lib/node.js
// and an in-memory client), on memory storage. No seeder here: the sync runs
// dial a loopback port nothing listens on (session-e2e.test.js and
// sync-gate.test.js cover a seeder).
const test = require('brittle')
const net = require('node:net')
const b4a = require('b4a')
const { WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { createBrowserSession } = require('../lib/session')
const { memoryNodeStorage } = require('../lib/node-storage')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

// A loopback port with nothing listening (bound, then released).
async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function setup (t, { storage = memoryNodeStorage(), assoc = association(), ...options } = {}) {
  const port = await deadPort()
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  const web = await connectClient(node)
  return { node, web, assoc, storage, internal }
}

async function certified (t, options) {
  const s = await setup(t, options)
  const { publicKey } = await s.web.request('identity.create')
  await s.web.request('cert.add', { cert: createCert({ member: publicKey }, s.assoc.kp) })
  return { ...s, key: publicKey }
}

test('configuration is checked before anything starts', async (t) => {
  await testnet(t)
  const base = { storage: memoryNodeStorage(), association: association().hex, seederUrl: 'wss://semeador.example/seeder', createSocket: () => null }
  t.ok(createBrowserSession(base))
  t.exception(() => createBrowserSession({ ...base, association: 'xyz' }), /chave da associação inválida/)
  for (const seederUrl of ['http://semeador.example/seeder', 'ws://user:pw@semeador.example/', 'ws://semeador.example/?a=1', 'ws://semeador.example/#x', 'ws://', '', 42]) {
    t.exception(() => createBrowserSession({ ...base, seederUrl }), /endereço do semeador inválido/, String(seederUrl))
  }
  t.exception.all(() => createBrowserSession({ ...base, createSocket: null }), /createSocket required/)
  t.exception.all(() => createBrowserSession({ ...base, storage: null }), /storage required/)
})

test('before an identity exists', async (t) => {
  await testnet(t)
  const { web, storage } = await setup(t)
  t.alike(await web.request('node.info'), {
    publicKey: null,
    memberCert: false,
    followCount: 0,
    sync: { state: 'idle' },
    publicDht: false
  })
  for (const [method, params] of [['identity.show', {}], ['post.create', { text: 'x' }], ['follow.list', {}], ['sync.start', {}], ['feed.read', {}]]) {
    const err = await errorOf(web.request(method, params))
    t.is(err && err.code, 'NOT_FOUND', method)
    t.is(err && err.message, 'identidade não encontrada', method)
  }
  t.absent(await storage.hasCore('diary'), 'nothing was created')
  t.is(await storage.readJson('config'), null)
})

test('identity and member certificate', async (t) => {
  await testnet(t)
  const { web, assoc } = await setup(t)
  const created = await web.request('identity.create')
  t.is(created.association, assoc.hex)
  t.alike(await web.request('identity.create'), created, 'idempotent')
  t.alike(await web.request('identity.show'), created)
  const key = created.publicKey

  const genesis = await errorOf(web.request('post.create', { text: 'cedo demais' }))
  t.is(genesis.code, 'USAGE')
  t.is(genesis.message, 'grave o certificado de membro antes de publicar')

  const other = generateAssociationKeyPair()
  const foreign = await errorOf(web.request('cert.add', { cert: createCert({ member: key }, other) }))
  t.is(foreign.message, 'certificado inválido (untrusted-association)')
  const someoneElse = await errorOf(web.request('cert.add', { cert: createCert({ member: 'ab'.repeat(32) }, assoc.kp) }))
  t.is(someoneElse.code, 'USAGE')
  t.ok(/^certificado inválido \(/.test(someoneElse.message))

  const cert = createCert({ member: key }, assoc.kp)
  t.alike(await web.request('cert.add', { cert }), { seq: 0 })
  t.alike(await web.request('cert.add', { cert }), { seq: 0 }, 'the same certificate again is ok')
  const second = await errorOf(web.request('cert.add', { cert: createCert({ member: key, ageBand: '60+' }, assoc.kp) }))
  t.is(second.message, 'certificado já gravado')
  const info = await web.request('node.info')
  t.is(info.publicKey, key)
  t.is(info.memberCert, true)
})

test('profile, posts, replies, log and feed of the own diary', async (t) => {
  await testnet(t)
  const { web, key } = await certified(t)
  t.alike(await web.request('profile.set', { name: 'Bia', bio: 'oi' }), { seq: 1, ref: key + ':1' })
  t.alike(await web.request('post.create', { text: 'primeira' }), { seq: 2, ref: key + ':2' })
  t.alike(await web.request('post.reply', { to: key + ':2', text: 'resposta' }), { seq: 3, ref: key + ':3' })
  const badRecord = await errorOf(web.request('post.create', { text: 'a\u0000b' }))
  t.is(badRecord.message, 'registro inválido: control-chars')

  const log = await web.request('log.read', {})
  t.is(log.key, key)
  t.alike(log.entries.map((e) => e.seq), [0, 1, 2, 3])
  t.is(log.entries[1].record.name, 'Bia')
  t.alike(log.invalid, [])
  t.is(log.entriesTruncated, 0)
  const page = await web.request('log.read', { limit: 2 })
  t.alike(page.entries.map((e) => e.seq), [2, 3])
  t.is(page.entriesTruncated, 2)
  t.alike(await web.request('log.read', { author: key }), log, 'author = own key reads the own diary')

  const feed = await web.request('feed.read', {})
  t.alike(feed.items.map((i) => [i.seq, i.text, i.name]), [[2, 'primeira', 'Bia'], [3, 'resposta', 'Bia']])
  t.alike(feed.items[1].replyTo, { author: key, seq: 2 })
  t.alike(feed.skipped, [])
  t.is(feed.skippedTruncated, 0)
})

test('follows, and reads of diaries with no local data', async (t) => {
  await testnet(t)
  const { web, key, storage } = await certified(t)
  const other = 'cd'.repeat(32)
  const own = await errorOf(web.request('follow.add', { key }))
  t.is(own.message, 'não é possível seguir a própria chave')
  t.alike(await web.request('follow.add', { key: other }), { changed: true, followCount: 1 })
  t.alike(await web.request('follow.add', { key: other }), { changed: false, followCount: 1 })
  t.alike(await web.request('follow.list'), { follows: [other], total: 1 })
  t.alike(await web.request('follow.list', { offset: 1 }), { follows: [], total: 1 })
  t.is((await web.request('node.info')).followCount, 1)

  const feed = await web.request('feed.read', {})
  t.alike(feed.skipped, [{ key: other, reason: 'no-cert' }])
  const missing = await errorOf(web.request('log.read', { author: other }))
  t.is(missing.code, 'NOT_FOUND')
  t.is(missing.message, 'sem dados locais para este diário')
  t.absent(await storage.hasCore('replica/' + other), 'no core created by a read')

  t.alike(await web.request('follow.remove', { key: other }), { changed: true, followCount: 0 })
  t.alike(await web.request('follow.remove', { key: other }), { changed: false, followCount: 0 })
})

test('the own diary quota is enforced', async (t) => {
  await testnet(t)
  const { web } = await certified(t, { limits: { maxLogBlocks: 3 } })
  await web.request('post.create', { text: 'um' })
  await web.request('post.create', { text: 'dois' })
  const full = await errorOf(web.request('post.create', { text: 'três' }))
  t.is(full.code, 'USAGE')
  t.is(full.message, 'limite do diário atingido')
  const bytes = await certified(t, { limits: { maxBlockBytes: 700 } })
  const big = await errorOf(bytes.web.request('post.create', { text: 'x'.repeat(900) }))
  t.is(big.message, 'limite do diário atingido')
})

test('the storage outlives the node: same identity and diary after a restart', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {} // shared by both nodes below
  const assoc = association()
  const first = await certified(t, { storage, assoc })
  await first.web.request('post.create', { text: 'antes' })
  await first.node.close()
  const err = await errorOf(first.web.request('node.info'))
  t.is(err.code, 'CLOSED', 'the old client is closed with its node')

  const second = await setup(t, { storage, assoc })
  t.alike(await second.web.request('identity.create'), { publicKey: first.key, association: assoc.hex })
  const log = await second.web.request('log.read', {})
  t.is(log.entries[1].record.text, 'antes')

  const changed = await setup(t, { storage })
  const mismatch = await errorOf(changed.web.request('identity.show'))
  t.is(mismatch.message, 'associação diferente da configurada')
})

test('a once run with no seeder ends in timeout, naming no address', async (t) => {
  await testnet(t)
  const { web, internal } = await certified(t, { syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const { runId } = await web.request('sync.start', { once: true, timeoutMs: 1000 })
  t.ok(web.events.some((e) => e.name === 'sync.started' && e.data.runId === runId && e.data.once === true), 'sync.started first')
  const stopped = await stoppedOf(web.events, runId)
  t.is(stopped.reason, 'timeout')
  t.is(stopped.result.ok, false)
  t.alike(stopped.result.errors, ['sem pares'])
  t.is(stopped.result.peers, 0)
  const warnings = web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
  t.ok(warnings.some((l) => /^aviso: sem conexão com o semeador; nova tentativa em \d+ s$/.test(l)), 'retry warning')
  t.absent(JSON.stringify(web.events).includes('127.0.0.1'), 'no address in any event')
  t.is(internal.length, 0)
  t.alike(await web.request('sync.status'), { state: 'idle' })
})

test('a continuous run is preempted by a member request and restarted', async (t) => {
  await testnet(t)
  const { web } = await certified(t, { syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const { runId } = await web.request('sync.start', {})
  t.alike(await web.request('sync.status'), { state: 'running', runId, once: false })
  const busy = await errorOf(web.request('sync.start', { once: true }))
  t.is(busy.message, 'sincronização já em andamento')
  const usage = await errorOf(web.request('sync.start', { timeoutMs: 5000 }))
  t.is(usage.message, 'timeoutMs só com once')

  await web.request('post.create', { text: 'durante a sincronização' })
  const names = web.events.filter((e) => e.name !== 'warning' && e.name !== 'sync.event').map((e) => e.name + ' ' + e.data.runId + (e.data.reason ? ' ' + e.data.reason : ''))
  t.alike(names, ['sync.started ' + runId, 'sync.stopped ' + runId + ' preempted', 'sync.started ' + (runId + 1)])
  const info = await web.request('node.info')
  t.alike(info.sync, { state: 'running', runId: runId + 1, once: false }, 'a cached node.info does not preempt')

  t.alike(await web.request('sync.stop'), { stopped: true })
  t.ok(web.events.some((e) => e.name === 'sync.stopped' && e.data.runId === runId + 1 && e.data.reason === 'stopped'))
  t.alike(await web.request('sync.stop'), { stopped: false })
  t.alike(await web.request('sync.status'), { state: 'idle' })
  await web.request('post.create', { text: 'depois de parar' })
  t.alike(await web.request('sync.status'), { state: 'idle' }, 'a stopped run is not restarted')
})

test('connections: one at a time, protocol errors close, a closed session refuses', async (t) => {
  await testnet(t)
  const { node, web } = await certified(t)
  const second = await connectClient(node)
  t.ok(web.client.closed, 'the first client was replaced')
  t.is((await second.request('identity.show')).association.length, 64)

  second.port.receive('{ not json')
  t.ok(second.port.closed, 'a bad frame closes the connection')
  const third = await connectClient(node)
  third.port.receive(JSON.stringify({ v: 1, method: 'node.info', params: {} }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.ok(third.port.closed, 'an envelope without a usable id closes it too')

  const assoc = association()
  const session = createBrowserSession({ storage: memoryNodeStorage(), association: assoc.hex, seederUrl: 'ws://127.0.0.1:9/seeder', createSocket: () => null })
  await session.close()
  const closed = await errorOf(session.handlers['node.info']({}))
  t.is(closed.code, 'LOCKED')
  t.is(closed.message, 'sessão encerrada')
})
