'use strict'

// End to end, loopback only: testimonial.decide (docs/rpc.md 5.100) keeps a
// depoimento privately or declines it. The decision lives in kv and writes
// nothing to the owner's diary, opens no core and makes no network request;
// testimonial.pending lists kept rows apart, reopening each against the live
// writer block, so a revoked one drops out. Its reads do not depend on the
// decisions, and one deadline bounds them. Two browser nodes, a real seeder
// on the local DHT behind a loopback WebSocket entry, and the seeder's
// /index/testimonials route stubbed.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const { WebSocket, WebSocketServer, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { connectClient } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-tde-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-tde-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const client of wss.clients) client.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// The seeder's /index/testimonials route, stubbed: `pointers` maps an owner
// to its pending list; every URL asked is recorded.
function indexStub (pointers, asked) {
  return async (url) => {
    asked.push(url)
    const m = /\/index\/testimonials\/([0-9a-f]{64})$/.exec(url)
    if (m === null) return new Response('não encontrado', { status: 404 })
    return new Response(JSON.stringify({ shown: [], pending: pointers[m[1]] || [], indexing: false, complete: true }), { status: 200 })
  }
}

// A browser node with a PRF (so its DM box key is held), certified, in a
// continuous run (diary.peek needs it).
async function testimonialNode (t, { assoc, url, fetchMedia, name, peekTimeoutMs = 3000, testimonialTimeoutMs }) {
  const internal = []
  const prf = crypto.randomBytes(32)
  const keyPair = crypto.keyPair()
  const storage = memoryNodeStorage()
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 300 },
    writeGate: false,
    peekTimeoutMs,
    testimonialTimeoutMs,
    fetchMedia
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  await web.request('profile.set', { name, bio: '' })
  await web.request('sync.start', {})
  return { node, web, storage, key: publicKey, keyPair, prf, internal }
}

async function failureOf (p) {
  try {
    await p
    return null
  } catch (err) {
    return { code: err.code, message: err.message }
  }
}

async function eventually (fn, check, name) {
  let last = null
  try {
    return await until(async () => {
      try {
        last = await fn()
      } catch (err) {
        last = { error: err.message }
        return false
      }
      return check(last) ? last : false
    }, { name, timeoutMs: 90000, intervalMs: 200 })
  } catch (err) {
    throw new Error(err.message + ': ' + JSON.stringify(last))
  }
}

// The names of every storage core opened from now on.
function spyCores (storage) {
  const names = []
  const core = storage.core.bind(storage)
  storage.core = (name, opts) => { names.push(name); return core(name, opts) }
  return names
}

const ids = (list) => list.map((r) => [r.from, r.seq])

// The 'author:seq' blocks of the watched diaries read for a diary.peek (a
// raw read under a deadline, the gate's block 0 included) while fn runs,
// sorted. Test only: wraps the Hypercore class the browser node uses, in
// this process, and restores it.
async function readsDuring (keys, fn) {
  const watched = new Set(keys)
  const reads = new Set()
  const get = Hypercore.prototype.get
  Hypercore.prototype.get = function (index, opts) {
    if (opts && opts.raw === true && opts.timeout !== undefined && this.key) {
      const key = hex(this.key)
      if (watched.has(key)) reads.add(key + ':' + index)
    }
    return get.call(this, index, opts)
  }
  try {
    const result = await fn()
    return { result, reads: [...reads].sort() }
  } finally {
    Hypercore.prototype.get = get
  }
}

// As readsDuring, but every read in the order it was asked, repeats kept.
async function orderedReadsDuring (keys, fn) {
  const watched = new Set(keys)
  const reads = []
  const at = []
  const get = Hypercore.prototype.get
  Hypercore.prototype.get = function (index, opts) {
    if (opts && opts.raw === true && opts.timeout !== undefined && this.key) {
      const key = hex(this.key)
      if (watched.has(key)) {
        reads.push(key + ':' + index)
        at.push(Date.now())
      }
    }
    return get.call(this, index, opts)
  }
  try {
    const result = await fn()
    return { result, reads, at }
  } finally {
    Hypercore.prototype.get = get
  }
}

// A member key no seeder serves: a peek of it waits out its deadline.
function unknownKey (below = null) {
  for (;;) {
    const key = hex(crypto.keyPair().publicKey)
    if (below === null || key < below) return key
  }
}

test('testimonial.decide: kept and declined stay private, kept rows are reopened live', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const { url } = await seederStack(t, bootstrap, assoc)
  const pointers = {}
  const asked = []
  const fetchMedia = indexStub(pointers, asked)
  const A = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Ana' })
  const B = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Bia' })

  const enabled = await B.web.request('dm.enable')
  await eventually(() => A.web.request('dm.lookup', { member: B.key }), (r) => r.box === enabled.box, 'A sees the dm-key of B')

  const T1 = 'a Bia cuida de todo mundo'
  const w1 = await A.web.request('testimonial.write', { to: B.key, text: T1 })
  pointers[B.key] = [{ from: A.key, seq: w1.seq }]
  const first = await eventually(() => B.web.request('testimonial.pending', {}), (r) => r.items.length === 1 && !r.incomplete, 'w1 pending')
  t.alike(Object.keys(first).sort(), ['incomplete', 'items', 'kept'])
  t.alike(ids(first.items), [[A.key, w1.seq]])
  t.is(first.items[0].text, T1)
  t.alike(first.kept, [], 'nothing kept yet')

  // Keep: kv only. The owner's diary gains no block, no core is opened and
  // nothing is asked of the seeder index.
  const lengthBefore = (await B.web.request('log.read', {})).entries.length
  const askedBefore = asked.length
  const cores = spyCores(B.storage)
  t.alike(await B.web.request('testimonial.decide', { from: A.key, seq: w1.seq, state: 'kept' }), { changed: true })
  t.alike(await B.web.request('testimonial.decide', { from: A.key, seq: w1.seq, state: 'kept' }), { changed: false }, 'a repeat changes nothing')
  t.alike(await B.web.request('testimonial.decide', { from: A.key, seq: w1.seq, state: 'declined', ifNew: true }), { changed: false }, 'ifNew never overrides a held decision')
  t.alike(cores, [], 'no core opened, the diary included')
  t.is(asked.length, askedBefore, 'no index request because of decide')
  t.is((await B.web.request('log.read', {})).entries.length, lengthBefore, 'the diary gains no block on kept')
  t.alike((await store.readTestimonialDecisions(B.storage, B.key)).map((e) => [e.from, e.seq, e.state]), [[A.key, w1.seq, 'kept']])

  const keptOne = await B.web.request('testimonial.pending', {})
  t.alike(keptOne.items, [], 'a kept one leaves the inbox')
  t.alike(ids(keptOne.kept), [[A.key, w1.seq]])
  t.is(keptOne.kept[0].text, T1, 'the kept row carries the text')
  t.is(keptOne.incomplete, false)

  // Decline: listed nowhere, and still no block or index request.
  const askedDecline = asked.length
  t.alike(await B.web.request('testimonial.decide', { from: A.key, seq: w1.seq, state: 'declined' }), { changed: true })
  t.is(asked.length, askedDecline, 'no index request because of decline')
  t.is((await B.web.request('log.read', {})).entries.length, lengthBefore, 'the diary gains no block on declined')
  const declined = await B.web.request('testimonial.pending', {})
  t.alike([declined.items, declined.kept], [[], []], 'a declined one is in neither list')

  // With no pointer left, the decided block is read exactly the same way
  // kept or declined: the reads never tell which.
  pointers[B.key] = []
  t.alike(await B.web.request('testimonial.decide', { from: A.key, seq: w1.seq, state: 'kept' }), { changed: true })
  const keptReads = await readsDuring([A.key], () => B.web.request('testimonial.pending', {}))
  t.alike(ids(keptReads.result.kept), [[A.key, w1.seq]], 'kept without a pointer')
  t.alike(await B.web.request('testimonial.decide', { from: A.key, seq: w1.seq, state: 'declined' }), { changed: true })
  const declinedReads = await readsDuring([A.key], () => B.web.request('testimonial.pending', {}))
  t.alike([declinedReads.result.items, declinedReads.result.kept, declinedReads.result.incomplete], [[], [], false], 'declined without a pointer: in neither list')
  t.ok(keptReads.reads.includes(A.key + ':' + w1.seq), 'the kept block is read')
  t.alike(declinedReads.reads, keptReads.reads, 'the declined block is read the same way')

  // Kept again; a second block from Ana replaces the first in the index, and
  // the kept one is still listed.
  t.alike(await B.web.request('testimonial.decide', { from: A.key, seq: w1.seq, state: 'kept' }), { changed: true })
  const T2 = 'e ainda faz o melhor café'
  const w2 = await A.web.request('testimonial.write', { to: B.key, text: T2 })
  pointers[B.key] = [{ from: A.key, seq: w2.seq }]
  const both = await eventually(() => B.web.request('testimonial.pending', {}), (r) => r.items.length === 1 && r.kept.length === 1, 'w2 pending, w1 kept')
  t.alike(ids(both.items), [[A.key, w2.seq]])
  t.alike(ids(both.kept), [[A.key, w1.seq]], 'kept without a pointer')
  t.is(both.kept[0].text, T1)

  t.alike(await failureOf(B.web.request('testimonial.decide', { from: B.key, seq: 1, state: 'kept' })), { code: 'USAGE', message: 'referência inválida' }, 'own key refused')

  // Ana revokes the kept block: it drops out of kept, never cached.
  await A.web.request('testimonial.delete', { to: A.key + ':' + w1.seq, about: B.key })
  const revoked = await eventually(() => B.web.request('testimonial.pending', {}), (r) => r.kept.length === 0 && r.items.length === 1, 'revoked one gone from kept')
  t.alike(ids(revoked.items), [[A.key, w2.seq]])
  t.is(revoked.incomplete, false, 'a revoked block is read, not a failure')
  t.alike((await store.readTestimonialDecisions(B.storage, B.key)).map((e) => [e.from, e.seq, e.state]), [[A.key, w1.seq, 'kept']], 'the decision itself stays')

  // An own-key entry (decide refuses it; a buggy device could sync one) is
  // never read: no peek of the own diary.
  const held = await store.readTestimonialDecisions(B.storage, B.key)
  await store.writeTestimonialDecisions(B.storage, B.key, [...held, { from: B.key, seq: 1, state: 'kept', t: 1 }])
  const ownReads = await readsDuring([B.key], () => B.web.request('testimonial.pending', {}))
  t.alike(ownReads.reads, [], 'the own diary is not peeked')
  t.alike([ids(ownReads.result.items), ownReads.result.kept, ownReads.result.incomplete], [[[A.key, w2.seq]], [], false])
  await store.writeTestimonialDecisions(B.storage, B.key, held)

  // A decided block whose writer cannot be read makes the answer incomplete
  // on its first failure, kept or declined alike: the app retries on the
  // flag, so the seeder must not learn the decision from it. Two fresh
  // writers, each the only one held in its call, so both have the same
  // (empty) memo history.
  const beforeFail = await store.readTestimonialDecisions(B.storage, B.key)
  const X = unknownKey()
  const Z = unknownKey()
  const shape = (key, reads) => reads.map((r) => r.slice(key.length))
  t.alike(await B.web.request('testimonial.decide', { from: X, seq: 2, state: 'kept' }), { changed: true })
  const keptFail = await readsDuring([X], () => B.web.request('testimonial.pending', {}))
  t.is(keptFail.result.incomplete, true, 'a kept block not read: incomplete')
  t.alike([ids(keptFail.result.items), keptFail.result.kept], [[[A.key, w2.seq]], []], 'and the kept row absent')
  await store.writeTestimonialDecisions(B.storage, B.key, beforeFail)
  t.alike(await B.web.request('testimonial.decide', { from: Z, seq: 2, state: 'declined' }), { changed: true })
  const declinedFail = await readsDuring([Z], () => B.web.request('testimonial.pending', {}))
  t.is(declinedFail.result.incomplete, true, 'a declined block not read: incomplete as well')
  t.alike(ids(declinedFail.result.items), [[A.key, w2.seq]])
  t.ok(keptFail.reads.length > 0, 'the writer is asked')
  t.alike(shape(Z, declinedFail.reads), shape(X, keptFail.reads), 'kept or declined, the same reads')
  await store.writeTestimonialDecisions(B.storage, B.key, beforeFail)

  // Locked: refused, nothing written.
  const beforeLock = await store.readTestimonialDecisions(B.storage, B.key)
  await B.node.clearKeyPair()
  t.alike(await failureOf(B.web.request('testimonial.decide', { from: A.key, seq: w2.seq, state: 'kept' })), { code: 'USAGE', message: store.LOCKED })
  t.alike(await store.readTestimonialDecisions(B.storage, B.key), beforeLock, 'nothing written while locked')

  t.alike([A.internal, B.internal], [[], []], 'no internal error')
})

test('testimonial.pending: one deadline for all its peeks, pointers first', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const { url } = await seederStack(t, bootstrap, assoc)
  const pointers = {}
  const fetchMedia = indexStub(pointers, [])
  const BUDGET = 4000
  const A = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Ana' })
  // Each peek may take longer than the whole budget: only the deadline
  // bounds the call.
  const B = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Bia', peekTimeoutMs: 8000, testimonialTimeoutMs: BUDGET })

  const enabled = await B.web.request('dm.enable')
  await eventually(() => A.web.request('dm.lookup', { member: B.key }), (r) => r.box === enabled.box, 'A sees the dm-key of B')
  const w = await A.web.request('testimonial.write', { to: B.key, text: 'a Bia sabe ouvir' })
  pointers[B.key] = [{ from: A.key, seq: w.seq }]
  await eventually(() => B.web.request('testimonial.pending', {}), (r) => r.items.length === 1 && !r.incomplete, 'w pending')

  // X sorts before every other writer, declined; Y, kept, comes after it.
  // Whether X's peek waits out the deadline or fails at once depends on the
  // host, so the check is that no read starts once the deadline passed.
  const X = unknownKey(A.key)
  const Y = (() => {
    for (;;) {
      const key = unknownKey()
      if (key > X) return key
    }
  })()
  t.alike(await B.web.request('testimonial.decide', { from: X, seq: 1, state: 'declined' }), { changed: true })
  t.alike(await B.web.request('testimonial.decide', { from: Y, seq: 1, state: 'kept' }), { changed: true })
  const started = Date.now()
  const { result, reads, at } = await orderedReadsDuring([A.key, X, Y], () => B.web.request('testimonial.pending', {}))
  const took = Date.now() - started
  t.ok(took < BUDGET + 3000, 'answered within the deadline (' + took + ' ms)')
  t.alike(ids(result.items), [[A.key, w.seq]], 'the pointed writer is read first')
  t.ok(reads.includes(A.key + ':' + w.seq) && reads.some((r) => r.startsWith(X + ':')), 'then the decided-only writers by key')
  // A peek begun just before the deadline may issue its block gets a little
  // later (TESTIMONIAL_LATE_GRACE_MS): no read starts past that.
  t.alike(reads.filter((r, i) => at[i] > started + BUDGET + 1500), [], 'no chunk is read past the deadline')
  const firstOf = (k) => reads.findIndex((r) => r.startsWith(k + ':'))
  t.ok(firstOf(Y) === -1 || firstOf(X) < firstOf(Y), 'X is asked before Y')
  t.is(result.incomplete, true, 'a decided block not read: incomplete')
  t.alike([A.internal, B.internal], [[], []], 'no internal error')
})

test('testimonial.pending: a revoked decided block is read after the pointers, then no longer', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const { url } = await seederStack(t, bootstrap, assoc)
  const pointers = {}
  const fetchMedia = indexStub(pointers, [])
  const PEEK = 2500
  const A = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Ana' })
  const C = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Caio' })
  const B = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Bia', peekTimeoutMs: PEEK, testimonialTimeoutMs: 12000 })

  const enabled = await B.web.request('dm.enable')
  await eventually(() => A.web.request('dm.lookup', { member: B.key }), (r) => r.box === enabled.box, 'A sees the dm-key of B')
  await eventually(() => C.web.request('dm.lookup', { member: B.key }), (r) => r.box === enabled.box, 'C sees the dm-key of B')

  // Ana's w1 is kept and then revoked; her w2 and Caio's wc are pointers.
  const w1 = await A.web.request('testimonial.write', { to: B.key, text: 'a Bia guarda segredo' })
  const w2 = await A.web.request('testimonial.write', { to: B.key, text: 'e empresta livros' })
  const wc = await C.web.request('testimonial.write', { to: B.key, text: 'a Bia rega as plantas da rua' })
  t.ok(w1.seq < w2.seq)
  pointers[B.key] = [{ from: A.key, seq: w2.seq }, { from: C.key, seq: wc.seq }]
  t.alike(await B.web.request('testimonial.decide', { from: A.key, seq: w1.seq, state: 'kept' }), { changed: true })
  const pointed = [[A.key, w2.seq], [C.key, wc.seq]].sort()
  await eventually(() => B.web.request('testimonial.pending', {}), (r) => r.items.length === 2 && r.kept.length === 1 && !r.incomplete, 'two pending, w1 kept')

  await A.web.request('testimonial.delete', { to: A.key + ':' + w1.seq, about: B.key })
  const gone = await eventually(() => B.web.request('diary.peek', { author: A.key, seqs: [w1.seq] }), (r) => r.missing.includes(w1.seq), 'w1 cleared at the seeder')
  t.ok(gone.length > w1.seq, 'the cleared block is below the length')

  // Two calls read it (it waits out its peek both times) and find it
  // missing; the first one reads it only after every pointer seq.
  const watched = [A.key, C.key]
  for (const n of [1, 2]) {
    const { result, reads } = await orderedReadsDuring(watched, () => B.web.request('testimonial.pending', {}))
    t.alike(ids(result.items).sort(), pointed, 'call ' + n + ': both pointers listed')
    t.alike(result.kept, [], 'call ' + n + ': the revoked one is not kept')
    t.is(result.incomplete, false, 'call ' + n + ': a missing block is no failure')
    const at = reads.indexOf(A.key + ':' + w1.seq)
    t.ok(at !== -1, 'call ' + n + ': the revoked block is read')
    t.ok(at > reads.indexOf(A.key + ':' + w2.seq) && at > reads.indexOf(C.key + ':' + wc.seq), 'call ' + n + ': after the pointer seqs')
  }

  // The third call does not wait for it again.
  const third = await orderedReadsDuring(watched, () => B.web.request('testimonial.pending', {}))
  t.absent(third.reads.includes(A.key + ':' + w1.seq), 'a block missing twice is not read again')
  t.ok(third.reads.includes(A.key + ':' + w2.seq) && third.reads.includes(C.key + ':' + wc.seq), 'the pointers are still read')
  t.alike(ids(third.result.items).sort(), pointed, 'both pointers listed')
  t.alike(third.result.kept, [], 'the revoked one is in neither list')
  t.is(third.result.incomplete, false, 'a skipped dead block is no failure')
  t.alike([A.internal, B.internal, C.internal], [[], [], []], 'no internal error')
})

test('testimonial.pending: an unserved decided writer stops costing the deadline', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const { url } = await seederStack(t, bootstrap, assoc)
  const pointers = {}
  const fetchMedia = indexStub(pointers, [])
  const PEEK = 1500
  const B = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Bia', peekTimeoutMs: PEEK, testimonialTimeoutMs: 5000 })
  await B.web.request('dm.enable')

  // Two writers no seeder serves, U1 before U2: each peek fails after its
  // whole budget, and the deadline fits both.
  const U2 = unknownKey()
  const U1 = unknownKey(U2)
  t.alike(await B.web.request('testimonial.decide', { from: U1, seq: 1, state: 'declined' }), { changed: true })
  t.alike(await B.web.request('testimonial.decide', { from: U2, seq: 1, state: 'kept' }), { changed: true })
  const read = (reads, key) => reads.some((r) => r.startsWith(key + ':'))

  const first = await orderedReadsDuring([U1, U2], () => B.web.request('testimonial.pending', {}))
  t.ok(read(first.reads, U1) && read(first.reads, U2), 'call 1: both writers read, the first does not eat the deadline')
  t.ok(first.reads.findIndex((r) => r.startsWith(U1 + ':')) < first.reads.findIndex((r) => r.startsWith(U2 + ':')), 'call 1: by key')
  t.is(first.result.incomplete, true, 'call 1: a first failure is incomplete')

  const second = await orderedReadsDuring([U1, U2], () => B.web.request('testimonial.pending', {}))
  t.ok(read(second.reads, U1) && read(second.reads, U2), 'call 2: both read again')
  t.is(second.result.incomplete, false, 'call 2: a suspected dead writer is no failure')

  const started = Date.now()
  const third = await orderedReadsDuring([U1, U2], () => B.web.request('testimonial.pending', {}))
  const took = Date.now() - started
  t.alike(third.reads, [], 'call 3: neither writer is peeked')
  t.ok(took < PEEK, 'call 3: answered without waiting (' + took + ' ms)')
  t.alike([third.result.items, third.result.kept, third.result.incomplete], [[], [], false], 'call 3: complete and empty')
  t.alike(B.internal, [], 'no internal error')
})
