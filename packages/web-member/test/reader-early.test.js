'use strict'

// Reads served early in a sync run's startup (lib/sync.js reader, lib/session.js
// withCores, docs/rpc.md 6.1): the run lends its cores before its follow
// pass, a read of the own diary answers then, and a read that needs a core
// not lent yet waits for the follows (opened) and the startup sweeps
// (settled) before it judges it, so no answer differs from a read made once
// the startup is over. The runs dial a loopback port nothing listens on; the
// startup is held with the test-only syncOptions.startupGate.
const test = require('brittle')
const assert = require('node:assert/strict')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const { WebSocket } = require('ws')
const { testnet, until } = require('./helpers/net')
const { connectClient, errorOf, stoppedOf } = require('./helpers/session')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord } = require('@varanda/core/lib/records')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { createBrowserNode } = require('../lib/node')
const { runSync } = require('../lib/sync')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

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

async function otherDiary (t, assoc, name) {
  const source = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await source.ready()
  t.teardown(() => source.close(), { force: true })
  await source.append(memberCertRecord(createCert({ member: hex(source.key) }, assoc.kp)))
  await source.append(profileRecord({ name, bio: 'de longe' }))
  await source.append(postRecord({ text: 'poste de ' + name, at: '2026-01-01T00:00:01.000Z' }))
  return source
}

// The startup gate: hold('follows' | 'sweeps') arms that point for the next
// run that reaches it; reached(point) resolves when a run waits there.
function startupGate () {
  const points = {}
  const point = (name) => {
    if (!points[name]) {
      let reach
      let release
      points[name] = {
        armed: false,
        reached: new Promise((resolve) => { reach = resolve }),
        gate: new Promise((resolve) => { release = resolve }),
        reach: () => reach(),
        release: () => release()
      }
    }
    return points[name]
  }
  return {
    hold (name) { point(name).armed = true },
    reached: (name) => point(name).reached,
    release: (name) => point(name).release(),
    releaseAll () { for (const p of Object.values(points)) p.release() },
    async fn (name) {
      const p = point(name)
      if (!p.armed) return
      p.armed = false
      p.reach()
      await p.gate
    }
  }
}

// A member with two posts following F (a stored replica); the write gate is
// off; U is a stored replica nobody follows. blockFollowed: F is blocked by
// a stored snapshot. deleteFirst: the first own post is deleted (its bytes
// kept: noClear).
async function fixture (t, { readerWaitMs = 20000, blockFollowed = false, deleteFirst = false } = {}) {
  const storage = memoryNodeStorage()
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const port = await deadPort()
  const gate = startupGate()
  t.teardown(() => gate.releaseAll())
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    writeGate: false,
    readerWaitMs,
    noClear: deleteFirst,
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, startupGate: gate.fn }
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node)
  const { publicKey: own } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: own }, assoc.kp) })
  const first = await web.request('post.create', { text: 'primeiro' })
  await web.request('post.create', { text: 'segundo' })
  if (deleteFirst) await web.request('post.delete', { to: own + ':' + first.seq })
  const F = await storeReplica(storage, await otherDiary(t, assoc, 'Seguida'))
  const U = await storeReplica(storage, await otherDiary(t, assoc, 'Avulsa'))
  await web.request('follow.add', { key: F })
  if (blockFollowed) {
    const mod = crypto.keyPair()
    const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, assoc.kp)
    await store.writeBlocklist(storage, createSnapshot({ seq: 1, blocked: [F], revokedIssuers: [] }, mod, cert))
  }
  return { node, web, storage, assoc, own, F, U, gate }
}

// The run's own store.readFollows call (the follow pass) held until
// release(), with no startup gate: a run without one is held there too.
function holdRunFollows (t) {
  const original = store.readFollows
  let armed = true
  let reach
  const reached = new Promise((resolve) => { reach = resolve })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  store.readFollows = async function (...args) {
    if (armed && /\bat syncRun \(/.test(new Error().stack)) {
      armed = false
      reach()
      await gate
    }
    return original.apply(this, args)
  }
  t.teardown(() => {
    store.readFollows = original
    release()
  })
  return { reached, release: () => release() }
}

function stops (web, from = 0) {
  return web.events.slice(from).filter((e) => e.name === 'sync.stopped')
}

// Within ms: 'done' when p settled, else 'pending'.
async function settledFirst (p, ms) {
  let timer = null
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, 'pending') })
  const out = await Promise.race([p.then(() => 'done', () => 'done'), late])
  clearTimeout(timer)
  return out
}

test('with the follow pass held, the own log and profile answer on the starting run', async (t) => {
  await testnet(t)
  const { web, own } = await fixture(t)
  const L0 = await web.request('log.read', {})
  const P0 = await web.request('profile.read', { authors: [own] })
  const held = holdRunFollows(t)
  const { runId } = await web.request('sync.start', {})
  await held.reached
  const from = web.events.length
  const own0 = web.request('log.read', {})
  t.is(await settledFirst(own0, 5000), 'done', 'log.read (own) answers while the follow pass is held')
  t.alike(await own0, L0, 'the same own log')
  const prof = web.request('profile.read', { authors: [own] })
  t.is(await settledFirst(prof, 5000), 'done', 'profile.read [own] answers while held')
  t.alike(await prof, P0, 'the same own profile')
  t.is(stops(web, from).length, 0, 'no sync.stopped')
  t.alike(await web.request('sync.status'), { state: 'running', runId, once: false })
  held.release()
  await web.request('sync.stop')
})

test('with the sweeps held, feed.read answers once the follows are open', async (t) => {
  await testnet(t)
  const { web, own, F, gate } = await fixture(t)
  const F0 = await web.request('feed.read', {})
  t.ok(F0.items.some((i) => i.author === F), 'the followed diary is in the feed')
  t.is(F0.items.filter((i) => i.author === own).length, 2)
  gate.hold('sweeps')
  const { runId } = await web.request('sync.start', {})
  await gate.reached('sweeps')
  const from = web.events.length
  const feed = web.request('feed.read', {})
  t.is(await settledFirst(feed, 5000), 'done', 'feed.read answers while the sweeps are held')
  t.alike(await feed, F0, 'the same feed')
  t.is(stops(web, from).length, 0, 'no sync.stopped')
  t.alike(await web.request('sync.status'), { state: 'running', runId, once: false })
  gate.release('sweeps')
  await web.request('sync.stop')
})

test('a blocked author\'s stored replica during the held sweeps answers as after the startup', async (t) => {
  await testnet(t)
  const { web, storage, F, U, gate } = await fixture(t, { blockFollowed: true })
  const B0 = await errorOf(web.request('log.read', { author: F }))
  const U0 = await web.request('log.read', { author: U })
  t.ok(await store.replicaExists(storage, F), 'the blocked replica is stored before the run')
  gate.hold('sweeps')
  const { runId } = await web.request('sync.start', {})
  await gate.reached('sweeps')
  const from = web.events.length
  // A stored replica the run does not lend: the read waits for the sweeps
  // (settled) before it judges it, then takes the exclusive path.
  const unlent = web.request('log.read', { author: U })
  t.is(await settledFirst(unlent, 300), 'pending', 'an unlent replica waits while the sweeps are held')
  const blocked = errorOf(web.request('log.read', { author: F }))
  gate.release('sweeps')
  t.alike(await unlent, U0, 'the same answer for the unlent replica')
  const B1 = await blocked
  t.ok(B0 !== null && B1 !== null, 'the blocked author reads as absent')
  t.is(B1 && B1.code, B0 && B0.code, 'the same code')
  t.is(B1 && B1.message, B0 && B0.message, 'the same message')
  t.is((await stoppedOf(web.events, runId)).reason, 'preempted', 'the unlent read preempted the run once settled')
  t.is(web.events.slice(from).filter((e) => e.name === 'warning' && /leitura sem esperar/.test(e.data.line)).length, 0, 'not as a late startup')
  await web.request('sync.stop')
  t.absent(await store.replicaExists(storage, F), 'the sweep purged the blocked replica')
  const B2 = await errorOf(web.request('log.read', { author: F }))
  t.is(B2 && B2.code, B0 && B0.code, 'the same answer after the run')
})

test('an own post deleted by a tombstone is never returned by an early read', async (t) => {
  await testnet(t)
  const { web, own, gate } = await fixture(t, { deleteFirst: true })
  const L0 = await web.request('log.read', {})
  t.absent(JSON.stringify(L0).includes('primeiro'), 'the deleted post is not in the log')
  gate.hold('follows')
  await web.request('sync.start', {})
  await gate.reached('follows')
  const L1 = await web.request('log.read', {})
  t.absent(JSON.stringify(L1).includes('primeiro'), 'nor in an early read')
  t.alike(L1, L0, 'the same log')
  const P1 = await web.request('profile.read', { authors: [own] })
  t.absent(JSON.stringify(P1).includes('primeiro'), 'nor in the early profile')
  gate.release('follows')
  await web.request('sync.stop')
})

test('a startup held past readerWaitMs still preempts with the warning', async (t) => {
  await testnet(t)
  const { web, own, gate } = await fixture(t, { readerWaitMs: 300 })
  const LINE = 'aviso: leitura sem esperar a partida da sincronização (300 ms)'
  const lines = () => web.events.filter((e) => e.name === 'warning' && e.data.line === LINE)
  gate.hold('follows')
  // The preemption's abort waits for the run to unwind, which a held step
  // never does: the gate opens once the read gave up on it.
  until(() => lines().length > 0, { timeoutMs: 10000 }).then(() => gate.release('follows'), () => gate.release('follows'))
  const { runId } = await web.request('sync.start', {})
  await gate.reached('follows')
  const read = web.request('feed.read', {})
  t.is(await settledFirst(read, 10000), 'done', 'feed.read answered')
  t.is((await read).items.filter((i) => i.author === own).length, 2, 'served on the exclusive path')
  t.is(lines().length, 1, 'one warning line')
  t.is((await stoppedOf(web.events, runId)).reason, 'preempted', 'the starting run was preempted')
  await web.request('sync.stop')
})

test('a run that ends before its startup is over settles both promises false and a read goes exclusive', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const storage = memoryNodeStorage()
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const ctx = { storage, association, keyPair: crypto.keyPair() }
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: hex(ctx.keyPair.publicKey) }, kp))
  const F = await storeReplica(storage, await otherDiary(t, { kp }, 'Seguida'))
  await ops.followAdd(ctx, F)
  const gate = startupGate()
  t.teardown(() => gate.releaseAll())
  gate.hold('follows')
  let published
  const api = new Promise((resolve) => { published = resolve })
  const ac = new AbortController()
  const done = runSync({
    storage,
    seederUrl: 'ws://127.0.0.1:1/seeder',
    createSocket: () => ({ readyState: 0, binaryType: 'arraybuffer', close () {}, send () {}, addEventListener () {}, removeEventListener () {} }),
    retryMinMs: 100,
    retryMaxMs: 200,
    socketCloseMs: 50,
    signal: ac.signal,
    startupGate: gate.fn,
    reader: { set: (a) => published(a), clear () {} }
  })
  const lent = await api
  await gate.reached('follows')
  t.is(lent.replica(F), null, 'the follow is not lent before the follow pass')
  const cores = { diary: lent.diary, replica: lent.replica, group: lent.group, opened: lent.opened, settled: lent.settled }
  t.is(lent.hold(), true)
  const read = errorOf(ops.logRead({ storage, association, cores }, { author: F }))
  t.is(await settledFirst(read, 300), 'pending', 'the read waits for the follow pass')
  ac.abort()
  gate.release('follows')
  t.is(await lent.opened, false, 'opened settles false')
  t.is(await lent.settled, false, 'settled settles false')
  const err = await read
  lent.release()
  await done
  t.ok(ops.isNeedsExclusive(err), 'the read takes the exclusive path')
})
