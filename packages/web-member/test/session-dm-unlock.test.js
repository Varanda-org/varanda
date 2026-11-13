'use strict'

// setKeyPair installs the identity without waiting for the direct message
// store, which reads and opens every local row: its unlock runs off the
// chain (lib/session.js runDmUnlock) while the DM requests wait for it and
// every other request goes ahead. The dmUnlockHook test option holds it.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { groupJoinRecord, testimonialRecord } = require('@varanda/core/lib/records')
const { sealOffer } = require('@varanda/core/lib/testimonials')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const dmCore = require('@varanda/core/lib/dm')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { memoryNodeStorage } = require('../lib/node-storage')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')
const { connectClient, errorOf } = require('./helpers/session')
const { dmSeeder } = require('./helpers/dm-seeder')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')

const LOCKED = 'identidade bloqueada: entre com a passkey'

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until (fn, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(20)
  }
  throw new Error('tempo esgotado')
}

function isZero (buf) {
  return buf.every((x) => x === 0)
}

// The unlock hook: passes through until held. Held, an unlock waits for
// release before it runs (mode 'before') or runs at once and only settles
// after release (mode 'after', an unlock under way). prfs: each unlock's
// PRF copy, as handed to the hook.
function unlockGate () {
  const g = { held: false, mode: 'before', prfs: [], waiters: [] }
  g.hook = async (unlock, prf) => {
    g.prfs.push(prf)
    if (!g.held) return unlock()
    const wait = new Promise((resolve) => g.waiters.push(resolve))
    if (g.mode === 'after') {
      const running = unlock()
      await wait
      return running
    }
    await wait
    return unlock()
  }
  g.release = () => {
    g.held = false
    for (const w of g.waiters.splice(0)) w()
  }
  return g
}

async function wallet (storage) {
  const w = await storage.readJson('dmStamps')
  return w && Array.isArray(w.items) ? w.items.length : 0
}

// createBrowserNode with each session it creates kept in `sessions`, so a
// test can call a handler and setKeyPair in the same tick (over the client a
// request reaches its handler a few microtasks later).
function capturingFactory () {
  const id = require.resolve('../lib/node')
  const sessionModule = require('../lib/session')
  const original = sessionModule.createBrowserSession
  const cached = require.cache[id]
  const sessions = []
  let factory
  try {
    sessionModule.createBrowserSession = (opts) => {
      const s = original(opts)
      sessions.push(s)
      return s
    }
    delete require.cache[id]
    factory = require('../lib/node').createBrowserNode
  } finally {
    sessionModule.createBrowserSession = original
    require.cache[id] = cached
  }
  return { factory, sessions }
}

const captured = capturingFactory()

// createBrowserNode with ../lib/sync runSync and ../lib/dm createDmEngine
// stubbed: each run records its pageRoots, publishes `peek` as its diary
// peeker, reports own-synced and lasts until aborted. heldPage: a page the
// engine holds once its store is unlocked.
function stubbedFactory ({ heldPage = null, peek = null } = {}) {
  const runs = []
  const sync = require('../lib/sync')
  const dm = require('../lib/dm')
  const original = { runSync: sync.runSync, createDmEngine: dm.createDmEngine }
  const ids = [require.resolve('../lib/node'), require.resolve('../lib/session')]
  const cached = ids.map((id) => require.cache[id])
  let factory
  try {
    sync.runSync = async ({ signal, onEvent, once, pageRoots, peeker }) => {
      runs.push({ once, pageRoots: [...pageRoots] })
      if (peek !== null) peeker.set(peek)
      onEvent({ event: 'own-synced', length: 2 })
      await new Promise((resolve) => {
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', resolve)
      })
      if (peek !== null) peeker.clear(peek)
      return { ok: true, errors: [], peers: 1, seederConfirmed: true }
    }
    if (heldPage !== null) {
      dm.createDmEngine = (opts) => {
        const engine = original.createDmEngine(opts)
        engine.heldPageBoxes = () => engine.unlocked() ? [{ page: heldPage, box: '34'.repeat(32), gen: 1 }] : []
        return engine
      }
    }
    for (const id of ids) delete require.cache[id]
    factory = require('../lib/node').createBrowserNode
  } finally {
    sync.runSync = original.runSync
    dm.createDmEngine = original.createDmEngine
    ids.forEach((id, i) => { require.cache[id] = cached[i] })
  }
  return { factory, runs }
}

async function memberNode (t, assoc, url, extra = {}) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const gate = unlockGate()
  const internal = []
  const node = captured.factory({
    storage,
    association: hex(assoc.publicKey),
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { dm: { issuePaceMs: 0 } },
    writeGate: false,
    onInternalError: (err) => internal.push(err),
    dmUnlockHook: (unlock, p) => gate.hook(unlock, p),
    ...extra
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc) })
  await web.request('dm.enable')
  await until(async () => (await wallet(storage)) >= dmCore.DM_STAMP_WALLET)
  return { node, session: captured.sessions[captured.sessions.length - 1], web, storage, gate, internal, key: publicKey, keyPair, prf }
}

// Copies a member's diary into another node's storage (what a follow would
// have downloaded), so dm.lookup finds its dm-key locally.
async function copyDiary (from, to) {
  const src = await store.openDiary(from.storage)
  const dst = await store.openReplica(to.storage, from.key)
  const a = src.replicate(true)
  const b = dst.replicate(false)
  a.pipe(b).pipe(a)
  await dst.update({ wait: true })
  await dst.download({ start: 0, end: src.length }).done()
  a.destroy()
  b.destroy()
  await src.close()
  await dst.close()
}

// A with a local DM store of `rows` sent messages to B.
async function withRows (t, rows = 5) {
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  await copyDiary(B, A)
  for (let i = 0; i < rows; i++) await A.web.request('dm.send', { to: B.key, text: 'oi ' + i })
  const listed = await A.web.request('dm.list', {})
  t.is(listed.conversations.length, 1, 'one conversation with B')
  t.is((await A.web.request('dm.thread', { peer: B.key })).messages.length, rows, 'its rows kept')
  return { assoc, A, B }
}

// Locks, then unlocks again with the store unlock held.
async function relockHeld (A, mode = 'before') {
  await A.node.clearKeyPair()
  A.gate.held = true
  A.gate.mode = mode
  return A.node.setKeyPair(A.keyPair, { prf: A.prf })
}

test('setKeyPair and the public reads answer while the DM store unlock is pending; the DM requests wait for it', async (t) => {
  t.timeout(240000)
  const { A, B } = await withRows(t)

  await relockHeld(A)
  // Fails where setKeyPair still unlocked the store on the chain: the
  // unlock is never held there.
  await until(() => A.gate.waiters.length === 1, 5000)
  t.ok((await A.node.identityStatus()).unlocked, 'the identity is installed')
  const feed = await A.web.request('feed.read', {})
  t.ok(Array.isArray(feed.items), 'feed.read answers')
  t.is(A.gate.waiters.length, 1, 'while the store unlock is still held')

  // dm.list first, then feed.read: the public read is not queued behind the
  // DM one.
  const order = []
  const list = A.web.request('dm.list', {}).then((r) => { order.push('dm.list'); return r })
  const read = A.web.request('feed.read', {}).then((r) => { order.push('feed.read'); return r })
  await read
  await sleep(100)
  t.alike(order, ['feed.read'], 'feed.read answers first, dm.list still waits')
  A.gate.release()
  const rows = await list
  t.alike(order, ['feed.read', 'dm.list'])
  t.is(rows.conversations.length, 1, 'dm.list answers with the rows after release')
  t.is(rows.conversations[0].peer, B.key)

  // The DM copy of the PRF is zeroed once its unlock settles; the group PRF
  // (a separate copy) still derives group keys.
  await until(() => A.gate.prfs.every(isZero))
  t.ok(A.gate.prfs.length >= 1 && A.gate.prfs.every(isZero), 'every DM unlock copy of the PRF is zero-filled')
  const made = await A.web.request('community.create', { name: 'Bairro', join: 'open' })
  t.ok(/^[0-9a-f]{64}$/.test(made.community), 'the group PRF is still usable')
  t.alike(A.internal, [])
})

test('a DM request issued right before a setKeyPair of the same identity answers its rows, never locked', async (t) => {
  t.timeout(240000)
  const { A, B } = await withRows(t)

  // Nothing pending: the request queues before the identity change.
  const listing = errorOf(A.session.handlers['dm.list']({}))
  const listed = A.session.handlers['dm.list']({})
  const again = A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await again
  t.is(await listing, null, 'not refused')
  const rows = await listed
  t.is(rows.conversations.length, 1, 'the rows')
  t.is(rows.conversations[0].peer, B.key)

  // An unlock pending, then released: the request still queues in the tick
  // its wait ends, ahead of an identity change called in that same tick.
  await relockHeld(A)
  await until(() => A.gate.waiters.length === 1, 5000)
  const waiting = A.session.handlers['dm.list']({})
  A.gate.release()
  await A.session.handlers['dm.list']({})
  const late = A.session.handlers['dm.list']({})
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  t.is((await waiting).conversations.length, 1, 'the waiting request answers its rows')
  t.is((await late).conversations.length, 1, 'and one issued after it, right before the change')
  t.alike(A.internal, [])
})

test('a dm.send whose second step queues while a same-identity unlock is pending waits for it, never locked', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  // A finds B's dm-key by peek (B's diary is not stored here), held below.
  let entered = false
  let answer = null
  let lookup = null
  const A = await memberNode(t, assoc, seeder.url, {
    dmKeyPeek: async () => {
      entered = true
      if (lookup !== null) await lookup
      if (answer === null) throw new Error('sem semeador')
      return answer
    }
  })
  const B = await memberNode(t, assoc, seeder.url)
  answer = { box: hex((await dmBoxKeyPairFromPrf(B.prf, 1)).publicKey), gen: 1 }
  let release
  lookup = new Promise((resolve) => { release = resolve })

  const sending = errorOf(A.web.request('dm.send', { to: B.key, text: 'oi' }))
  await until(() => entered, 5000)
  // A same-identity unlock starts while the send is off the chain, and is
  // still pending when the send's second step queues.
  A.gate.held = true
  A.gate.mode = 'before'
  const again = A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await until(() => A.gate.waiters.length === 1, 5000)
  release()
  await sleep(100)
  A.gate.release()
  await again
  t.is(await sending, null, 'the send completes, never locked')
  t.ok((await A.web.request('dm.thread', { peer: B.key })).messages.some((m) => m.text === 'oi'), 'and is kept')
  t.alike(A.internal, [])
})

test('a lock while the DM store unlock is pending leaves it locked', async (t) => {
  t.timeout(240000)
  const { A } = await withRows(t)

  await relockHeld(A)
  await until(() => A.gate.waiters.length === 1, 5000)
  const clearing = A.node.clearKeyPair()
  const listing = errorOf(A.web.request('dm.list', {}))
  A.gate.release()
  await clearing
  t.is((await listing).message, LOCKED, 'dm.list answers locked')
  await sleep(200)
  t.is((await errorOf(A.web.request('dm.list', {}))).message, LOCKED, 'and stays locked')

  // The same in mode 'after': the superseded unlock was already under way.
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  A.gate.held = true
  A.gate.mode = 'after'
  await A.node.clearKeyPair()
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await until(() => A.gate.waiters.length === 1, 5000)
  const clearing2 = A.node.clearKeyPair()
  A.gate.release()
  await clearing2
  await sleep(200)
  t.is((await errorOf(A.web.request('dm.list', {}))).message, LOCKED, 'an unlock under way is stopped too')
  t.alike(A.internal, [])
})

test('a second setKeyPair supersedes a pending one, whose lock never locks it', async (t) => {
  t.timeout(240000)
  const { A } = await withRows(t)

  for (const mode of ['before', 'after']) {
    const first = relockHeld(A, mode)
    await until(() => A.gate.waiters.length === 1, 5000)
    // Later unlocks pass; the first stays held until released below.
    A.gate.held = false
    const second = A.node.setKeyPair(A.keyPair, { prf: A.prf })
    const listing = A.web.request('dm.list', {})
    await first
    await sleep(100)
    for (const w of A.gate.waiters.splice(0)) w()
    await second
    t.is((await listing).conversations.length, 1, mode + ': dm.list answers once the second unlock settles')
    await sleep(300)
    t.is((await A.web.request('dm.list', {})).conversations.length, 1, mode + ': the first unlock never locked the second')
    t.is((await A.web.request('dm.thread', { peer: (await A.web.request('dm.list', {})).conversations[0].peer })).messages.length, 5)
  }
  await until(() => A.gate.prfs.every(isZero))
  t.ok(A.gate.prfs.every(isZero), 'every copy zero-filled, the superseded ones too')
  t.alike(A.internal, [])
})

test('block.set issued while the DM store unlock is pending still files the message block', async (t) => {
  t.timeout(240000)
  const { A } = await withRows(t, 1)
  const peer = hex(crypto.randomBytes(32))

  await relockHeld(A)
  await until(() => A.gate.waiters.length === 1, 5000)
  const blocking = A.web.request('block.set', { key: peer, on: true })
  await sleep(100)
  A.gate.release()
  t.alike(await blocking, { changed: true, total: 1 })
  // Without the list, only the conversation op says so.
  await store.writeMemberBlocks(A.storage, [])
  t.is((await A.web.request('dm.thread', { peer })).blocked, true, 'the message block op was filed')
  t.alike(A.internal, [])
})

// A member's own diary and a page diary stored here as a replica (its
// certificate, then a live group join of `root`).
async function heldPageStorage (t) {
  const assoc = generateAssociationKeyPair()
  const association = hex(assoc.publicKey)
  const pageKp = crypto.keyPair()
  const page = hex(pageKp.publicKey)
  const root = 'ef'.repeat(32)
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)

  const storage = memoryNodeStorage()
  const own = { storage, association, keyPair }
  await ops.idCreate(own)
  await ops.certAdd(own, createCert({ member: hex(keyPair.publicKey) }, assoc))
  const pm = await createMember({ storage: memoryStorage(), association, keyPair: pageKp })
  t.teardown(() => pm.close(), { force: true })
  await pm.setCert(createCert({ member: page }, assoc))
  await pm.core.append(groupJoinRecord({ group: root, writer: '12'.repeat(32), on: true }))
  const dst = await store.openReplica(storage, page)
  const a = pm.core.replicate(true, { keepAlive: false })
  const b = dst.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  await dst.update({ wait: true })
  await dst.download({ start: 0, end: pm.core.length }).done()
  a.destroy()
  b.destroy()
  await dst.close()
  t.alike(await ops.pageGroupRoots(own, [page]), [root], 'the stored page diary\'s root')

  return { assoc, association, storage, page, root, keyPair, prf }
}

test('a held page whose diary is stored here reaches the run\'s pageRoots once the DM store unlock settles', async (t) => {
  t.timeout(120000)
  const { association, storage, page, root, keyPair, prf } = await heldPageStorage(t)

  const { factory, runs } = stubbedFactory({ heldPage: page })

  const gate = unlockGate()
  const internal = []
  const node = factory({
    storage,
    association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate: false,
    readerWaitMs: 200,
    onInternalError: (err) => internal.push(err),
    dmUnlockHook: (unlock, p) => gate.hook(unlock, p)
  })
  t.teardown(() => node.close(), { force: true })
  gate.held = true
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node)
  await until(() => gate.waiters.length === 1, 5000)
  await web.request('sync.start')
  await until(() => runs.length >= 1, 5000)
  t.alike(runs[0].pageRoots, [], 'the first run starts while the store is locked')
  gate.release()
  await until(() => runs.length >= 2, 10000)
  await sleep(500)
  t.is(runs.length, 2, 'one restart, no loop')
  t.alike(runs[1].pageRoots, [root], 'the next run pages the held page\'s root')
  t.ok(runs.every((r) => r.once === false))
  await web.request('sync.stop')
  t.alike(internal, [])
})

test('testimonial.pending with a same-identity setKeyPair during its diary reads still opens the valid testimonial', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const association = hex(assoc.publicKey)
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const own = hex(keyPair.publicKey)
  const storage = memoryNodeStorage()
  const ctx = { storage, association, keyPair }
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: own }, assoc))

  // E's block 1: a testimonial sealed to this identity's gen 1 DM box.
  const E = hex(crypto.randomBytes(32))
  const TEXT = 'E escreveu de verdade'
  const offer = sealOffer({ from: E, text: TEXT, boxPk: (await dmBoxKeyPairFromPrf(prf, 1)).publicKey })
  const record = testimonialRecord({ to: own, gen: 1, hash: offer.hash, box: offer.box })
  let read = null
  let entered = false
  const peek = async (key, seqs) => {
    if (key === E) {
      entered = true
      if (read !== null) await read
    }
    return { length: 2, entries: key === E ? seqs.filter((q) => q === 1).map((q) => ({ seq: q, record })) : [], missing: [] }
  }
  const { factory } = stubbedFactory({ peek })
  const fetchMedia = async (url) => {
    if (!url.endsWith('/index/testimonials/' + own)) return new Response('não encontrado', { status: 404 })
    return new Response(JSON.stringify({ shown: [], pending: [{ from: E, seq: 1 }], indexing: false, complete: true }), { status: 200 })
  }
  const gate = unlockGate()
  const internal = []
  const node = factory({
    storage,
    association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate: false,
    fetchMedia,
    onInternalError: (err) => internal.push(err),
    dmUnlockHook: (unlock, p) => gate.hook(unlock, p)
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node)
  await web.request('sync.start')
  const before = await web.request('testimonial.pending')
  t.alike(before.items.map((i) => i.text), [TEXT], 'opened without an identity change')

  let release
  read = new Promise((resolve) => { release = resolve })
  entered = false
  const pending = web.request('testimonial.pending')
  await until(() => entered, 5000)
  gate.held = true
  await node.setKeyPair(keyPair, { prf })
  await until(() => gate.waiters.length === 1, 5000)
  release()
  await sleep(100)
  gate.release()
  const r = await pending
  t.alike(r.items.map((i) => [i.from, i.seq, i.text]), [[E, 1, TEXT]], 'the valid testimonial, opened after the new unlock')
  t.is(r.incomplete, false)
  await web.request('sync.stop')
  t.alike(internal, [])
})

// A page diary: block 0 its certificate, then a roster naming `owner` and a
// dm-key with `box` (as page-dm.test.js builds it).
async function pageDiary (t, { assoc, issuer, pageKp, ownerKp, box }) {
  const m = await createMember({ storage: memoryStorage(), association: hex(assoc.publicKey), keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  const page = hex(pageKp.publicKey)
  await m.setCert(createCert({ member: page }, assoc))
  const fields = { page, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: '2026-11-03T12:00:00.000Z', nonce: 'r'.repeat(43), association: hex(assoc.publicKey) }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, ownerKp) }, issuer.kp, issuer.cert))
  await m.core.append({ type: 'dm-key', box, gen: 1, at: '2026-11-03T12:00:00.000Z' })
  return m
}

test('dm.pageSecrets adopts after a same-identity setKeyPair resolved while it read the page', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const box = hex((await dmBoxKeyPairFromPrf(A.prf, 1)).publicKey)
  const pageKp = crypto.keyPair()
  const page = hex(pageKp.publicKey)
  const made = await A.web.request('dm.pageGenerate', { page, gen: 1, recipients: [{ member: A.key, box }] })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made.box })
  const dst = await store.openReplica(A.storage, page)
  const a = diary.core.replicate(true, { keepAlive: false })
  const b = dst.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  await dst.update({ wait: true })
  await dst.download({ start: 0, end: diary.core.length }).done()
  a.destroy()
  b.destroy()
  await dst.close()
  const s = made.shares[0]
  const params = { page, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc) }

  // The adoption queues first; the identity change (its unlock held) right
  // behind it, so the roster read runs while the new unlock is pending.
  A.gate.held = true
  A.gate.mode = 'before'
  const adopting = A.session.handlers['dm.pageSecrets'](params).then((r) => r, (err) => err)
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await until(() => A.gate.waiters.length === 1, 5000)
  await sleep(300)
  A.gate.release()
  const r = await adopting
  t.alike(r, { ok: true }, 'adopted, never locked')
  t.ok((await A.storage.readJson('pageSecrets')).pages[page], 'kept')
  t.alike(A.internal, [])
})

test('a dm.pull started under one identity never pulls for the identity a reset and setKeyPair install while it waits', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const bPair = crypto.keyPair()
  const bPrf = crypto.randomBytes(32)
  const B = hex(bPair.publicKey)
  const bBox = { box: hex((await dmBoxKeyPairFromPrf(bPrf, 1)).publicKey), gen: 1 }
  const N = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url, {
    dmKeyPeek: async (key) => {
      if (key !== B) throw new Error('sem semeador')
      return bBox
    }
  })
  // A valid message for B waits in the pool.
  await C.web.request('dm.send', { to: B, text: 'para B' })

  // The pull reads A's identity first; the reset and B's install queue right
  // behind it, B's unlock held, so the pull waits and resumes under B.
  N.gate.held = true
  N.gate.mode = 'before'
  const stale = N.session.handlers['dm.pull']({}).then((r) => ({ r }), (err) => ({ err }))
  const resetting = N.node.reset()
  const installing = N.node.setKeyPair(bPair, { prf: bPrf })
  await resetting
  await installing
  await until(() => N.gate.waiters.length === 1, 5000)
  const cursor = await N.storage.readJson('dmCursor')
  N.gate.release()
  const out = await stale
  t.is(out.err && out.err.message, LOCKED, 'the stale pull is locked')
  t.alike(await N.storage.readJson('dmCursor'), cursor, 'B\'s cursor is unchanged')

  // B's own pull, once its diary and dm-key are set up here, files it.
  await N.web.request('identity.create')
  await N.web.request('cert.add', { cert: createCert({ member: B }, assoc) })
  await N.web.request('dm.enable')
  t.is((await N.web.request('dm.pull')).added, 1, 'a fresh pull under B gets the message')
  t.alike(N.internal, [])
})

test('a request issued under one identity while its unlock is pending never runs for the identity a reset and setKeyPair install', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const N = await memberNode(t, assoc, seeder.url)
  const bPair = crypto.keyPair()
  const peer = hex(crypto.randomBytes(32))

  // A's unlock pending: block.set (issued for A) waits for it; the reset and
  // B's install are called meanwhile, and B's diary is created before the
  // unlocks are released.
  await relockHeld(N)
  await until(() => N.gate.waiters.length === 1, 5000)
  const blocking = N.session.handlers['block.set']({ key: peer, on: true }).then((r) => ({ r }), (err) => ({ err }))
  const resetting = N.node.reset()
  const installing = N.node.setKeyPair(bPair, { prf: crypto.randomBytes(32) })
  // A's superseded unlock settles (the reset waits for it); B's stays held.
  N.gate.waiters.shift()()
  await resetting
  await installing
  await N.web.request('identity.create')
  N.gate.release()
  const out = await blocking
  t.is(out.err && out.err.message, LOCKED, 'block.set issued for A is locked')
  t.alike(await store.readMemberBlocks(N.storage), [], 'B\'s block list is unchanged')
  t.alike((await N.web.request('block.list')).keys, [])
})

test('a request issued right after setKeyPair was called, before its chain entry ran, runs for that identity', async (t) => {
  t.timeout(240000)
  const { A, B } = await withRows(t)
  await A.node.clearKeyPair()
  const installing = A.node.setKeyPair(A.keyPair, { prf: A.prf })
  const listed = A.session.handlers['dm.list']({})
  const pulled = A.session.handlers['dm.pull']({})
  await installing
  const rows = await listed
  t.is(rows.conversations.length, 1, 'dm.list answers its rows')
  t.is(rows.conversations[0].peer, B.key)
  t.ok(Number.isSafeInteger((await pulled).added), 'dm.pull completes')

  // A same-key PRF refresh keeps a request issued during it.
  A.gate.held = true
  A.gate.mode = 'before'
  const refreshing = A.node.setKeyPair(A.keyPair, { prf: A.prf })
  const during = A.session.handlers['dm.list']({})
  const again = A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await refreshing
  await until(() => A.gate.waiters.length === 1, 5000)
  A.gate.release()
  await again
  t.is((await during).conversations.length, 1, 'answers through a same-key refresh')
  t.alike(A.internal, [])
})

test('a one-shot run started while the DM store unlock is pending waits for it and pages the held page\'s root', async (t) => {
  t.timeout(120000)
  const { association, storage, page, root, keyPair, prf } = await heldPageStorage(t)
  const { factory, runs } = stubbedFactory({ heldPage: page })
  const gate = unlockGate()
  const internal = []
  const node = factory({
    storage,
    association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate: false,
    onInternalError: (err) => internal.push(err),
    dmUnlockHook: (unlock, p) => gate.hook(unlock, p)
  })
  t.teardown(() => node.close(), { force: true })
  const web = await connectClient(node)
  gate.held = true
  await node.setKeyPair(keyPair, { prf })
  await until(() => gate.waiters.length === 1, 5000)
  const starting = web.request('sync.start', { once: true })
  await sleep(200)
  gate.release()
  await starting
  await until(() => runs.length >= 1, 5000)
  await sleep(300)
  t.is(runs.length, 1, 'one run')
  t.is(runs[0].once, true)
  t.alike(runs[0].pageRoots, [root], 'the once run pages the held page\'s root')
  await web.request('sync.stop')
  t.alike(internal, [])
})

// A node on a stubbed run with its DM store unlock held after setKeyPair.
async function heldUnlockNode (t) {
  const { association, storage, page, keyPair, prf } = await heldPageStorage(t)
  const { factory, runs } = stubbedFactory({ heldPage: page })
  const gate = unlockGate()
  const internal = []
  const node = factory({
    storage,
    association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate: false,
    onInternalError: (err) => internal.push(err),
    dmUnlockHook: (unlock, p) => gate.hook(unlock, p)
  })
  t.teardown(() => node.close(), { force: true })
  const web = await connectClient(node)
  gate.held = true
  await node.setKeyPair(keyPair, { prf })
  await until(() => gate.waiters.length === 1, 5000)
  return { node, web, gate, runs, internal }
}

test('a one-shot start waiting for the DM store unlock is cancelled by a sync.stop meanwhile', async (t) => {
  t.timeout(120000)
  const { web, gate, runs, internal } = await heldUnlockNode(t)
  const starting = errorOf(web.request('sync.start', { once: true }))
  await web.request('sync.stop')
  gate.release()
  const err = await starting
  t.is(err && err.message, 'sincronização interrompida', 'the start is refused')
  await sleep(300)
  t.is(runs.length, 0, 'no run starts')
  t.alike(internal, [])
})

test('a one-shot start waiting for the DM store unlock never starts after its connection closed', async (t) => {
  t.timeout(120000)
  const { node, web, gate, runs, internal } = await heldUnlockNode(t)
  const starting = errorOf(web.request('sync.start', { once: true }))
  await sleep(50)
  web.port.close()
  t.ok(await starting, 'the start is refused')
  const second = await connectClient(node)
  gate.release()
  await sleep(300)
  t.is(runs.length, 0, 'no run starts, also for the next connection')
  t.is((await second.request('sync.status')).state, 'idle')
  t.alike(internal, [])
})
