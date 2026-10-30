// Member reads while a sync run is live (lib/session.js withCores, docs/rpc.md
// 6.1): feed.read, log.read, profile.read and engagement.read are served on
// the run's own cores, so the run is not preempted and its runId stays; a
// read the run cannot serve (a stored replica it does not hold) falls back
// to the exclusive path and preempts once; a borrowed read holds the chain
// (serial) but not the Espiadinha, and a close waits for it. The runs dial a
// loopback port nothing listens on: the run opens its cores and keeps
// retrying, which is all a borrowed read needs.
const test = require('brittle')
const assert = require('node:assert/strict')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const { WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord } = require('@varanda/core/lib/records')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { createBrowserNode } = require('../lib/node')
const { createBrowserSession } = require('../lib/session')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const store = require('../lib/node-store')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// A local replica of `source` in the node storage, replicated in memory and
// closed again before the node opens it (as session.test.js).
async function storeReplica (storage, source) {
  const key = hex(source.key)
  const replica = new Hypercore(storage.core('replica/' + key), source.key, { valueEncoding: 'binary' })
  await replica.ready()
  const a = source.replicate(true)
  const b = replica.replicate(false)
  a.pipe(b).pipe(a)
  await replica.download({ start: 0, end: source.length }).done()
  if (replica.length !== source.length) await replica.update()
  assert.equal(replica.length, source.length)
  a.destroy()
  b.destroy()
  await replica.close()
  return key
}

// Another member's diary (Hypercore 10, memory) with a profile and a post.
async function otherDiary (t, assoc, name) {
  const source = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await source.ready()
  t.teardown(() => source.close(), { force: true })
  await source.append(memberCertRecord(createCert({ member: hex(source.key) }, assoc.kp)))
  await source.append(profileRecord({ name, bio: 'de longe' }))
  await source.append(postRecord({ text: 'poste de ' + name, at: '2026-01-01T00:00:01.000Z' }))
  return source
}

// A certified member with two posts, following F (stored replica), with a
// stored replica of an unfollowed U too; the write gate is off.
async function fixture (t, { blockFollowed = false } = {}) {
  const storage = memoryNodeStorage()
  const assoc = association()
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
    writeGate: false,
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 }
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node)
  const { publicKey: own } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: own }, assoc.kp) })
  await web.request('post.create', { text: 'primeiro' })
  await web.request('post.create', { text: 'segundo' })
  const F = await storeReplica(storage, await otherDiary(t, assoc, 'Seguida'))
  const U = await storeReplica(storage, await otherDiary(t, assoc, 'Avulsa'))
  await web.request('follow.add', { key: F })
  if (blockFollowed) {
    const mod = crypto.keyPair()
    const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, assoc.kp)
    await store.writeBlocklist(storage, createSnapshot({ seq: 1, blocked: [F], revokedIssuers: [] }, mod, cert))
  }
  return { node, web, storage, assoc, own, F, U, internal }
}

function preempted (web, from = 0) {
  return web.events.slice(from).filter((e) => e.name === 'sync.stopped' && e.data.reason === 'preempted')
}

// node-store readAll, made to wait at its next call once armed: `entered`
// resolves when a read is held there, release() lets it go on.
function hangNextReadAll (t) {
  const original = store.readAll
  let armed = false
  let entered
  const reached = new Promise((resolve) => { entered = resolve })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  store.readAll = async function (...args) {
    if (armed) {
      armed = false
      entered()
      await gate
    }
    return original.apply(this, args)
  }
  t.teardown(() => { store.readAll = original })
  return {
    arm () { armed = true },
    entered: reached,
    release: () => release()
  }
}

test('feed, log, profile and engagement reads are served on the live run without preempting it', async (t) => {
  await testnet(t)
  const { web, own, F, internal } = await fixture(t)
  const F0 = await web.request('feed.read', {})
  t.ok(F0.items.some((i) => i.author === F), 'the followed diary is in the feed')
  t.is(F0.items.filter((i) => i.author === own).length, 2, 'both own posts')
  const L0 = await web.request('log.read', { author: F })
  const P0 = await web.request('profile.read', { authors: [own, F] })

  const { runId } = await web.request('sync.start', {})
  const from = web.events.length
  t.alike(await web.request('feed.read', {}), F0, 'the same feed under the run')
  t.is((await web.request('log.read', {})).entries.length, 4, 'the own log')
  t.alike(await web.request('log.read', { author: F }), L0, 'the followed log')
  t.alike(await web.request('profile.read', { authors: [own, F] }), P0, 'the same profiles')
  t.alike(await web.request('engagement.read', { refs: [F + ':2'] }), { liked: [], reposted: [] })
  t.alike(await web.request('sync.status'), { state: 'running', runId, once: false }, 'the same run is live')
  t.is(preempted(web, from).length, 0, 'no read preempted the run')
  t.absent(web.events.slice(from).some((e) => e.name === 'sync.started'), 'no run was started')
  await web.request('sync.stop')
  t.alike(internal, [])
})

test('a blocked followed diary stays hidden on the borrowed path', async (t) => {
  await testnet(t)
  const { web, own, F } = await fixture(t, { blockFollowed: true })
  const { runId } = await web.request('sync.start', {})
  const from = web.events.length
  const feed = await web.request('feed.read', {})
  t.ok(feed.skipped.some((s) => s.key === F && s.reason === 'blocked'), 'skipped as blocked')
  t.absent(feed.items.some((i) => i.author === F))
  const profiles = await web.request('profile.read', { authors: [own, F] })
  t.alike(profiles.missing, [F], 'missing from profile.read')
  t.alike(await web.request('sync.status'), { state: 'running', runId, once: false })
  t.is(preempted(web, from).length, 0)
  await web.request('sync.stop')
})

test('a borrowed read holds the chain, not the Espiadinha', async (t) => {
  await testnet(t)
  const { web, F } = await fixture(t)
  const F0 = await web.request('feed.read', {})
  const { runId } = await web.request('sync.start', {})
  // The run published its cores once a borrowed read went through.
  await web.request('profile.read', { authors: [F] })
  const hang = hangNextReadAll(t)
  const order = []
  hang.arm()
  const feed = web.request('feed.read', {}).then((r) => { order.push('feed.read'); return r })
  await hang.entered
  const list = web.request('follow.list', {}).then((r) => { order.push('follow.list'); return r })
  const peekErr = await errorOf(web.request('peek.read', {}))
  order.push('peek.read')
  t.is(peekErr && peekErr.message, 'sem conexão com o semeador', 'the peek reached the dead port')
  t.alike(order, ['peek.read'], 'the peek settled while the feed read and follow.list waited')
  hang.release()
  t.alike(await feed, F0)
  t.alike(await list, { follows: [F], total: 1 })
  t.alike(order, ['peek.read', 'feed.read', 'follow.list'], 'follow.list ran after the feed read')
  t.alike(await web.request('sync.status'), { state: 'running', runId, once: false })
  t.is(preempted(web).length, 0)
  await web.request('sync.stop')
})

test('close waits for a borrowed read in flight, which completes on open cores', async (t) => {
  await testnet(t)
  const { node, storage, assoc, F } = await fixture(t)
  await node.close()
  // On the session itself: the node closes the client's port before the
  // session, so the read's own answer is only visible here.
  const port = await deadPort()
  const session = createBrowserSession({
    storage,
    association: assoc.hex,
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    writeGate: false,
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 }
  })
  t.teardown(() => session.close(), { force: true })
  const events = []
  session.attach((name, data) => events.push({ name, data }))
  const h = session.handlers
  const F0 = await h['feed.read']({})
  t.ok(F0.items.some((i) => i.author === F))
  const { runId } = await h['sync.start']({ once: false })
  await h['profile.read']({ authors: [F] })
  const hang = hangNextReadAll(t)
  const order = []
  hang.arm()
  const feed = h['feed.read']({}).then((r) => { order.push('feed.read'); return r }, (err) => { order.push('feed.read failed'); throw err })
  await hang.entered
  const closing = session.close().then(() => { order.push('close') })
  // Let close run as far as it can while the read is held.
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.alike(order, [], 'close has not resolved while the read is held')
  hang.release()
  await closing
  t.alike(await feed, F0, 'the read finished with its answer, not a closed-core error')
  t.alike(order, ['feed.read', 'close'])
  const stops = events.filter((e) => e.name === 'sync.stopped').map((e) => [e.data.runId, e.data.reason])
  t.alike(stops, [[runId, 'stopped']], 'the run served the read and was ended by close only')
})

test('a stored replica the run does not hold falls back to the exclusive path and preempts once', async (t) => {
  await testnet(t)
  const { web, own, U } = await fixture(t)
  const P0 = await web.request('profile.read', { authors: [U] })
  t.is(P0.profiles.length, 1, 'the unfollowed replica is named')
  const { runId } = await web.request('sync.start', {})
  await web.request('profile.read', { authors: [own] })
  const from = web.events.length
  t.alike(await web.request('profile.read', { authors: [U] }), P0, 'the same answer')
  const stops = preempted(web, from)
  t.is(stops.length, 1, 'one preemption')
  t.is(stops[0].data.runId, runId)
  await web.request('sync.stop')
})
