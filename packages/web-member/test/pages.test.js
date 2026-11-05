// Páginas on the browser node (docs/rpc.md 5.84, 5.85, 5.87): page.sign
// signs statements and records with the in-memory key (no append, no run
// preempted), page.read reads a page diary a real in-process Seeder serves
// through the running sync's diary.peek (bounded windows), and page.register
// is refused. Loopback only (local DHT, memory storage).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { postRecord, followRecord, profileRecord, deleteRecord } = require('@varanda/core/lib/records')
const { verifyPage, opHash } = require('@varanda/core/lib/page-proof')
const { signRoster, signClose, signMoved, signOrigin, issuerCountersign, verifyRoster, verifyAccept, verifyOffer, verifyOrigin, pendingOffer } = require('@varanda/core/lib/page')
const { verifyClose, verifyMoved } = require('@varanda/core/lib/page-lifecycle')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')

const LOCKED = 'identidade bloqueada: entre com a passkey'
const MISMATCH = 'passkey não corresponde ao diário guardado'
const BAD_PAGE = 'operação de página inválida'
const NONCE = 'A-_9'.repeat(11)
const RNONCE = 'r'.repeat(43)
const AT = '2026-11-03T12:00:00.000Z'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function issuerOf (assoc) {
  const kp = crypto.keyPair()
  return { kp, cert: createIssuerCert({ issuer: hex(kp.publicKey) }, assoc.kp) }
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function browserNode (t, { assoc, seederUrl = null, keyPair = crypto.keyPair(), storage = memoryNodeStorage(), withCert = true, peekTimeoutMs = 8000 }) {
  const internal = []
  const url = seederUrl || 'ws://127.0.0.1:' + (await deadPort()) + '/seeder'
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
    peekTimeoutMs
  })
  t.teardown(() => node.close(), { force: true })
  if (keyPair !== null) await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 60000 })
  let key = null
  if (withCert) {
    key = (await web.request('identity.create')).publicKey
    await web.request('cert.add', { cert: createCert({ member: key }, assoc.kp) })
  }
  return { node, web, key, keyPair, internal }
}

// The in-process seeder with a WebSocket entry (diary-peek.test.js).
async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-pages-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-pages-sc-'), 'seeder-cert.json')
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
  return { publicKey, url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// A diary (memory) with its certificate and `records` (a function gets the
// key), served whole by the seeder, whose link is closed afterwards.
// cleared: seqs the diary no longer holds (a tombstoned post), so the
// seeder never gets them.
async function served (t, { assoc, stack, records, keyPair = null, cleared = [] }) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex, keyPair })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assoc.kp))
  for (const record of records) await m.core.append(typeof record === 'function' ? record(m.key) : record)
  for (const seq of cleared) await m.core.clear(seq)
  const link = connectSeeder({ member: m, socket: new WebSocket(stack.url), association: assoc.hex, seederPublicKey: stack.publicKey, timeoutMs: 30000 })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await link.waitServed(m.core.length)
  link.close()
  return m
}

function signed (type, fields, kp, issuer) {
  const sign = { 'page-roster': signRoster, 'page-close': signClose, 'page-moved': signMoved, 'page-origin': signOrigin }[type]
  return issuerCountersign({ type, ...fields, signature: sign(fields, kp) }, issuer.kp, issuer.cert)
}

test('page.sign: statements and records signed by the own key verify, refusals, nothing written, no run preempted', async (t) => {
  await testnet(t)
  const assoc = association()
  const issuer = issuerOf(assoc)
  const P = hex(crypto.keyPair().publicKey)
  const K2 = hex(crypto.keyPair().publicKey)
  const other = hex(crypto.keyPair().publicKey)

  const none = await browserNode(t, { assoc, withCert: false })
  const missing = await errorOf(none.web.request('page.sign', { action: 'post', nonce: NONCE, page: P, op: { text: 'oi' } }))
  t.alike([missing.code, missing.message], ['NOT_FOUND', 'identidade não encontrada'], 'no identity')

  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const s = await browserNode(t, { assoc, storage })
  const own = s.key
  const before = await s.web.request('log.read', {})
  const { runId } = await s.web.request('sync.start', {})
  const sign = (action, op, page = P) => s.web.request('page.sign', { action, nonce: NONCE, page, op })
  const fields = (action, op, page = P) => ({ action, nonce: NONCE, member: own, page, association: assoc.hex, opHash: opHash(op) })

  const post = await sign('post', { text: 'Abrimos às 7h' })
  t.alike(Object.keys(post), ['signature'])
  t.alike(verifyPage(fields('post', { text: 'Abrimos às 7h' }), post.signature), { ok: true }, 'statement verifies')
  const list = await sign('list', {}, '')
  t.alike(verifyPage(fields('list', {}, ''), list.signature), { ok: true }, 'pageless statement')

  const createOp = { username: 'padaria', name: 'Padaria', bio: '', roster: { gen: 1, admins: [], prev: null, at: AT, nonce: RNONCE } }
  const created = await sign('create', createOp)
  t.alike(verifyPage(fields('create', createOp), created.signature), { ok: true }, 'create statement over the op as sent')
  t.is(created.record.owner, own)
  t.is(created.record.association, assoc.hex, 'the node fills the association')
  t.ok(verifyRoster(issuerCountersign(created.record, issuer.kp, issuer.cert), P, assoc.hex).ok, 'genesis roster verifies')

  const inviteOp = { member: other, gen: 2, rosterSignature: '', roster: { owner: own, admins: [other], prev: 1, at: AT, nonce: RNONCE } }
  const invited = await sign('invite', inviteOp)
  t.ok(verifyRoster(issuerCountersign(invited.record, issuer.kp, issuer.cert), P, assoc.hex).ok, 'invite roster verifies')
  t.alike(verifyPage(fields('invite', { ...inviteOp, rosterSignature: invited.record.signature }), invited.signature), { ok: true }, 'invite statement over the completed op')

  const accepted = await sign('accept', { gen: 2, rosterSignature: invited.record.signature, at: AT, nonce: RNONCE })
  t.is(accepted.record.actor, own)
  t.ok(verifyAccept(accepted.record, P).ok, 'accept verifies')
  const offered = await sign('offer', { to: other, exp: '2026-11-10T12:00:00.000Z', gen: 2, at: AT, nonce: RNONCE })
  t.ok(verifyOffer(offered.record, P).ok, 'offer verifies')
  const cancelled = await sign('offer', { to: null, exp: null, gen: 2, at: AT, nonce: RNONCE })
  t.alike([cancelled.record.to, cancelled.record.exp, cancelled.record.actor], [null, null, own])
  t.ok(verifyOffer(cancelled.record, P).ok, 'the cancel verifies')
  const state = { page: true, owner: own, admins: [], gen: 2, seq: 1, follows: 0, key: P }
  t.is(pendingOffer([{ seq: 5, record: offered.record }], state).to, other, 'the offer is pending')
  t.is(pendingOffer([{ seq: 5, record: offered.record }, { seq: 6, record: cancelled.record }], state), null, 'the cancel closes it')
  const mixed = await errorOf(sign('offer', { to: null, exp: '2026-11-10T12:00:00.000Z', gen: 2, at: AT, nonce: RNONCE }))
  t.is(mixed.code, 'USAGE', 'a cancel with an exp')
  const gone = await errorOf(sign('offer-cancel', {}))
  t.is(gone.code, 'USAGE', 'the unsigned offer-cancel is refused')
  const removed = await sign('remove', { gen: 3, owner: own, admins: [], prev: 2, at: AT, nonce: RNONCE })
  t.ok(verifyRoster(issuerCountersign(removed.record, issuer.kp, issuer.cert), P, assoc.hex).ok, 'remove roster verifies')
  const closed = await sign('close', { gen: 4, at: AT, nonce: RNONCE })
  t.ok(verifyClose(issuerCountersign(closed.record, issuer.kp, issuer.cert), P, assoc.hex, {}).ok, 'close verifies')

  const moved = await sign('move', { to: K2, gen: 4, fromSeq: 9, owner: own, admins: [], at: AT, nonce: RNONCE })
  t.alike(Object.keys(moved), ['record', 'origin', 'roster'])
  t.ok(verifyMoved(issuerCountersign(moved.record, issuer.kp, issuer.cert), P, assoc.hex, {}).ok, 'moved verifies for K1')
  t.ok(verifyOrigin(issuerCountersign(moved.origin, issuer.kp, issuer.cert), K2, assoc.hex).ok, 'origin verifies for K2')
  t.ok(verifyRoster(issuerCountersign(moved.roster, issuer.kp, issuer.cert), K2, assoc.hex).ok, 'K2 genesis verifies')
  t.alike([moved.roster.gen, moved.roster.prev, moved.origin.from], [1, null, P])

  const foreign = await errorOf(sign('remove', { gen: 3, owner: other, admins: [], prev: 2, at: AT, nonce: RNONCE }))
  t.alike([foreign.code, foreign.message], ['USAGE', BAD_PAGE], 'a roster for another owner')
  const extra = await errorOf(sign('close', { gen: 4, at: AT, nonce: RNONCE, actor: other }))
  t.alike([extra.code, extra.message], ['USAGE', BAD_PAGE], 'an actor in the op')
  const assocOp = await errorOf(sign('close', { gen: 4, at: AT, nonce: RNONCE, association: assoc.hex }))
  t.is(assocOp.code, 'USAGE', 'an association in the op')
  const member = await errorOf(s.web.request('page.sign', { action: 'post', nonce: NONCE, page: P, op: {}, member: other }))
  t.is(member.code, 'USAGE', 'the caller cannot hand in a member')

  t.absent(s.web.events.some((e) => e.name === 'sync.stopped' && e.data.runId === runId), 'the run was not stopped')
  t.alike(await s.web.request('sync.status'), { state: 'running', runId, once: false }, 'the same run')
  await s.web.request('sync.stop')
  t.alike(await s.web.request('log.read', {}), before, 'nothing written')

  await s.node.clearKeyPair()
  const locked = await errorOf(sign('post', { text: 'x' }))
  t.alike([locked.code, locked.message], ['USAGE', LOCKED])
  t.alike(s.internal, [], 'no internal error')
  await s.node.close()
  const mismatch = await browserNode(t, { assoc, storage, withCert: false })
  const m = await errorOf(mismatch.web.request('page.sign', { action: 'post', nonce: NONCE, page: P, op: {} }))
  t.is(m && m.message, MISMATCH)
})

test('page.register is refused on the browser node', async (t) => {
  await testnet(t)
  const s = await browserNode(t, { assoc: association() })
  const err = await errorOf(s.web.request('page.register', {}))
  t.alike([err.code, err.message], ['USAGE', 'registro de página disponível só no nó core'])
})

test('page.read: bounded windows find the roster, person diary, closed and moved pages', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = association()
  const issuer = issuerOf(assoc)
  const stack = await seederStack(t, bootstrap, assoc)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  const follow = hex(crypto.keyPair().publicKey)
  const roster = (page, gen, prev) => signed('page-roster', { page, gen, owner, admins: [], prev, at: AT, nonce: RNONCE, association: assoc.hex }, ownerKp, issuer)

  // P: genesis at 1, gen 2 at 4, 150 posts, a follow: the gen 2 roster
  // lies 152 blocks back, outside the head and the newest window.
  const filler = Array.from({ length: 150 }, (_, i) => postRecord({ text: 'poste ' + i }))
  const P = await served(t, {
    assoc,
    stack,
    records: [(k) => roster(k, 1, null), postRecord({ text: 'a' }), postRecord({ text: 'b' }), (k) => roster(k, 2, 1), ...filler, followRecord({ key: follow, on: true })]
  })
  const S = await served(t, { assoc, stack, records: [profileRecord({ name: 'Sofia', bio: '' }), postRecord({ text: 'pessoa' })] })
  const C = await served(t, {
    assoc,
    stack,
    records: [(k) => roster(k, 1, null), postRecord({ text: 'fim' }), (k) => signed('page-close', { page: k, gen: 2, at: AT, nonce: RNONCE, actor: owner, association: assoc.hex }, ownerKp, issuer)]
  })
  const k2Kp = crypto.keyPair()
  const K2hex = hex(k2Kp.publicKey)
  const K1 = await served(t, {
    assoc,
    stack,
    records: [(k) => roster(k, 1, null), (k) => signed('page-moved', { page: k, to: K2hex, gen: 2, at: AT, nonce: RNONCE, actor: owner, association: assoc.hex }, ownerKp, issuer)]
  })
  const K2 = await served(t, {
    assoc,
    stack,
    keyPair: k2Kp,
    records: [postRecord({ text: 'nome' }), roster(K2hex, 1, null), signed('page-origin', { page: K2hex, from: K1.key, fromSeq: 2, gen: 2, owner, admins: [], at: AT, nonce: RNONCE, actor: owner, association: assoc.hex }, ownerKp, issuer)]
  })

  const { web, internal } = await browserNode(t, { assoc, seederUrl: stack.url, keyPair: ownerKp })
  await web.request('sync.start', {})

  const r = await web.request('page.read', { key: P.key })
  t.is(r.page, P.key)
  t.alike([r.owner, r.admins, r.gen, r.seq], [owner, [], 2, 4], 'the gen 2 roster 152 blocks back')
  t.alike([r.isOwner, r.isAdmin, r.complete, r.closed, r.movedTo, r.movedFrom], [true, false, true, false, null, null])
  t.alike(r.follows, [{ key: follow, seq: 155 }])
  t.alike([r.followsCount, r.followsTruncated], [1, false])

  const person = await web.request('page.read', { key: S.key })
  t.alike([person.owner, person.gen, person.isOwner, person.closed], [null, null, false, false], 'a person diary is no page')

  const c = await web.request('page.read', { key: C.key })
  t.is(c.closed, true, 'closed')
  t.is(c.gen, 1)

  const m1 = await web.request('page.read', { key: K1.key })
  t.alike(m1.movedTo, { to: K2hex, seq: 2 }, 'moved to K2')
  const m2 = await web.request('page.read', { key: K2.key })
  t.alike(m2.movedFrom, { from: K1.key, fromSeq: 2 }, 'K2 knows its origin')
  t.is(m2.owner, owner)
  t.alike(internal, [], 'no internal error')
})

// A diary (memory) with its certificate and `records`, copied whole into
// `storage` as a held replica, in process: every block stored, as a replica
// that has not cleared a tombstoned block holds it.
// ranges: [start, end) pairs to store instead (a newest-first download).
async function held (t, { assoc, storage, records, ranges = null }) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assoc.kp))
  for (const record of records) await m.core.append(typeof record === 'function' ? record(m.key) : record)
  const dst = await store.openReplica(storage, m.key)
  const a = m.core.replicate(true, { keepAlive: false })
  const b = dst.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await dst.update({ wait: true })
    for (const [start, end] of ranges || [[0, m.core.length]]) await dst.download({ start, end }).done()
  } finally {
    a.destroy()
    b.destroy()
    await dst.close()
  }
  return m
}

test('page.read: a held page diary folds RAW entries, a delete never reopens a close nor undoes a move', async (t) => {
  t.timeout(120000)
  const assoc = association()
  const issuer = issuerOf(assoc)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  const roster = (page) => signed('page-roster', { page, gen: 1, owner, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }, ownerKp, issuer)
  const storage = memoryNodeStorage()

  // What a leaked page key appends: a tombstone of the close (seq 3) and of
  // the move (seq 2).
  const C = await held(t, {
    assoc,
    storage,
    records: [roster, postRecord({ text: 'fim' }), (k) => signed('page-close', { page: k, gen: 2, at: AT, nonce: RNONCE, actor: owner, association: assoc.hex }, ownerKp, issuer), deleteRecord({ seq: 3, at: AT })]
  })
  const K2hex = hex(crypto.keyPair().publicKey)
  const K1 = await held(t, {
    assoc,
    storage,
    records: [roster, (k) => signed('page-moved', { page: k, to: K2hex, gen: 2, at: AT, nonce: RNONCE, actor: owner, association: assoc.hex }, ownerKp, issuer), deleteRecord({ seq: 2, at: AT })]
  })

  const { web, internal } = await browserNode(t, { assoc, keyPair: ownerKp, storage })
  const c = await web.request('page.read', { key: C.key })
  t.is(c.complete, true, 'read from the held diary')
  t.is(c.closed, true, 'the tombstoned close still closes the page')
  const m = await web.request('page.read', { key: K1.key })
  t.is(m.complete, true)
  t.alike(m.movedTo, { to: K2hex, seq: 2 }, 'the tombstoned move still moves the page')
  t.alike(internal, [], 'no internal error')
})

test('page.read: a held diary stored newest-first reads its tail past the gap, complete by the roster rule', async (t) => {
  t.timeout(120000)
  const assoc = association()
  const issuer = issuerOf(assoc)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  const roster = (gen, prev) => (page) => signed('page-roster', { page, gen, owner, admins: [], prev, at: AT, nonce: RNONCE, association: assoc.hex }, ownerKp, issuer)
  const close = (gen) => (page) => signed('page-close', { page, gen, at: AT, nonce: RNONCE, actor: owner, association: assoc.hex }, ownerKp, issuer)
  const filler = Array.from({ length: 300 }, (_, i) => postRecord({ text: 'poste ' + i }))
  const storage = memoryNodeStorage()

  // Blocks 0-2 and the tail stored, 299 blocks between them not yet.
  // N: a gen 2 roster and a close in the tail, inside the newest 256.
  const N = await held(t, { assoc, storage, ranges: [[0, 3], [302, 304]], records: [roster(1, null), ...filler, roster(2, 1), close(3)] })
  // O: only the close in the tail; the newest roster is 302 blocks back.
  const O = await held(t, { assoc, storage, ranges: [[0, 3], [302, 303]], records: [roster(1, null), ...filler, close(2)] })

  const { web, internal } = await browserNode(t, { assoc, keyPair: ownerKp, storage })
  const n = await web.request('page.read', { key: N.key })
  t.alike([n.gen, n.seq, n.closed, n.complete], [2, 302, true, true], 'the stored tail decides: gen 2 roster and the close')
  const o = await web.request('page.read', { key: O.key })
  t.alike([o.gen, o.closed, o.complete], [1, true, false], 'the close is seen; a roster older than 256 blocks is not complete')
  t.alike(internal, [], 'no internal error')
})

test('page.read: the bounded peek never asks for a block a newer window deleted', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association()
  const issuer = issuerOf(assoc)
  const stack = await seederStack(t, bootstrap, assoc)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  // The post at 4 is deleted by the tombstone at 45, one window newer, and
  // cleared, so asking for it would wait for the peek deadline.
  const filler = Array.from({ length: 40 }, (_, i) => postRecord({ text: 'poste ' + i }))
  const P = await served(t, {
    assoc,
    stack,
    cleared: [4],
    records: [(k) => signed('page-roster', { page: k, gen: 1, owner, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }, ownerKp, issuer), postRecord({ text: 'a' }), postRecord({ text: 'b' }), postRecord({ text: 'apagado' }), ...filler, deleteRecord({ seq: 4, at: AT })]
  })
  const { web, internal } = await browserNode(t, { assoc, seederUrl: stack.url, keyPair: ownerKp })
  await web.request('sync.start', {})
  const r = await web.request('page.read', { key: P.key })
  t.alike([r.gen, r.seq, r.complete], [1, 1, true], 'nothing missing asked for, complete by the roster rule')
  t.alike(internal, [], 'no internal error')
})

test('page.read: a held page diary applies the tombstone of a follow', async (t) => {
  t.timeout(120000)
  const assoc = association()
  const issuer = issuerOf(assoc)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  const gone = hex(crypto.keyPair().publicKey)
  const kept = hex(crypto.keyPair().publicKey)
  const storage = memoryNodeStorage()
  const P = await held(t, {
    assoc,
    storage,
    records: [(k) => signed('page-roster', { page: k, gen: 1, owner, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }, ownerKp, issuer), followRecord({ key: gone, on: true }), deleteRecord({ seq: 2, at: AT }), followRecord({ key: kept, on: true })]
  })
  const { web, internal } = await browserNode(t, { assoc, keyPair: ownerKp, storage })
  const r = await web.request('page.read', { key: P.key })
  t.alike([r.gen, r.complete], [1, true])
  t.alike(r.follows, [{ key: kept, seq: 4 }], 'the deleted follow is gone')
  t.alike([r.followsCount, r.followsTruncated], [1, false])
  t.alike(internal, [], 'no internal error')
})

test('page.read: a forked held replica answers as no local data, never a page', async (t) => {
  t.timeout(120000)
  const assoc = association()
  const issuer = issuerOf(assoc)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  const storage = memoryNodeStorage()
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assoc.kp))
  await m.core.append(signed('page-roster', { page: m.key, gen: 1, owner, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }, ownerKp, issuer))
  await m.core.append(postRecord({ text: 'antes' }))
  const dst = await store.openReplica(storage, m.key)
  const copy = async () => {
    const a = m.core.replicate(true, { keepAlive: false })
    const b = dst.replicate(false, { keepAlive: false })
    a.pipe(b).pipe(a)
    try {
      await dst.update({ wait: true })
      await dst.download({ start: 0, end: m.core.length }).done()
    } finally {
      a.destroy()
      b.destroy()
    }
  }
  try {
    await copy()
    await m.core.truncate(2)
    await m.core.append(postRecord({ text: 'reescrito' }))
    await m.core.append(postRecord({ text: 'de novo' }))
    await copy()
    t.is(dst.fork, 1, 'the replica took the fork')
  } finally {
    await dst.close()
  }
  const { web, internal } = await browserNode(t, { assoc, keyPair: ownerKp, storage })
  const err = await errorOf(web.request('page.read', { key: m.key }))
  t.alike([err && err.code, err && err.message], ['NOT_FOUND', 'sem dados locais para este diário'], 'no page from a forked replica')
  t.alike(internal, [], 'no internal error')
})

test('page.read: a tombstone in the same window as its cleared target never stalls the read', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association()
  const issuer = issuerOf(assoc)
  const stack = await seederStack(t, bootstrap, assoc)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  // One window (4..18): the post at 14 and its tombstone at 18, cleared.
  const filler = (n) => Array.from({ length: n }, (_, i) => postRecord({ text: 'poste ' + i }))
  const P = await served(t, {
    assoc,
    stack,
    cleared: [14],
    records: [(k) => signed('page-roster', { page: k, gen: 1, owner, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }, ownerKp, issuer), postRecord({ text: 'a' }), postRecord({ text: 'b' }), ...filler(10), postRecord({ text: 'apagado' }), ...filler(3), deleteRecord({ seq: 14, at: AT })]
  })
  const peekTimeoutMs = 20000
  const { web, internal } = await browserNode(t, { assoc, seederUrl: stack.url, keyPair: ownerKp, peekTimeoutMs })
  await web.request('sync.start', {})
  const started = Date.now()
  const r = await web.request('page.read', { key: P.key })
  const elapsed = Date.now() - started
  t.alike([r.gen, r.seq, r.complete], [1, 1, true], 'complete by the roster rule')
  t.ok(elapsed < peekTimeoutMs / 2, 'no wait for the peek deadline (' + elapsed + ' ms)')
  t.alike(internal, [], 'no internal error')
})
