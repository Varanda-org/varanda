// page.feed on the browser node (docs/rpc.md 5.86, lib/page-feed.js): the
// newest rows of a page's follows read over a short-lived link of a real
// in-process Seeder into memory cores. Loopback only (local DHT).
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createIssuerCert, createIssuedCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { postRecord, deleteRecord, profileRecord } = require('@varanda/core/lib/records')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { signRoster, signMoved, signClose, issuerCountersign } = require('@varanda/core/lib/page')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')

const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function iso (minutes) {
  return new Date(Date.parse('2026-11-01T00:00:00.000Z') + minutes * 60000).toISOString()
}

// The listener serves /seeder (WebSocket) and, like seed-ws, GET
// /index/page-end/<key> from pageEnd(key, seeder) (null: 404); `requests`
// lists the keys asked for.
async function seederStack (t, bootstrap, assoc, { pageEnd = null } = {}) {
  const dataDir = tmpDir(t, 'varanda-pfeed-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-pfeed-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const requests = []
  const server = http.createServer((req, res) => {
    const m = /^\/index\/page-end\/([0-9a-f]{64})$/.exec(req.url)
    if (m) requests.push(m[1])
    const answer = m && pageEnd ? pageEnd(m[1], seeder) : null
    if (answer === null || answer === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const wss = new WebSocketServer({ server })
  t.teardown(() => {
    for (const client of wss.clients) client.terminate()
    server.closeAllConnections()
    return new Promise((resolve) => wss.close(() => server.close(() => resolve())))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  return { publicKey, seeder, requests, url: 'ws://127.0.0.1:' + server.address().port + '/seeder' }
}

async function served (t, { assoc, stack, records, cert = (key) => createCert({ member: key }, assoc.kp) }) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(cert(m.key))
  for (const record of records) await m.core.append(typeof record === 'function' ? record(m.key) : record)
  const link = connectSeeder({ member: m, socket: new WebSocket(stack.url), association: assoc.hex, seederPublicKey: stack.publicKey, timeoutMs: 30000 })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await link.waitServed(m.core.length)
  link.close()
  return m
}

test('page.feed: newest rows of the follows, blocked and deleted excluded, moved cut, unserved key incomplete', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const stack = await seederStack(t, bootstrap, assoc)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  const counter = (record) => issuerCountersign(record, issuerKp, issuerCert)

  // A: posts at 1, 2, 3; the one at 2 is deleted.
  const A = await served(t, {
    assoc,
    stack,
    records: [postRecord({ text: 'a1', at: iso(1) }), postRecord({ text: 'a2 apagado', at: iso(2) }), postRecord({ text: 'a3', at: iso(3) }), deleteRecord({ seq: 2, at: iso(4) })]
  })
  const B = await served(t, { assoc, stack, records: [postRecord({ text: 'b1', at: iso(5) }), postRecord({ text: 'b2', at: iso(6) })] })
  const X = await served(t, { assoc, stack, records: [postRecord({ text: 'bloqueado', at: iso(7) })] })
  // M: a page that moved at 3; its post at 4 is above the cut.
  const to = hex(crypto.keyPair().publicKey)
  const M = await served(t, {
    assoc,
    stack,
    records: [
      (k) => { const f = { page: k, gen: 1, owner, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }; return counter({ type: 'page-roster', ...f, signature: signRoster(f, ownerKp) }) },
      postRecord({ text: 'm antes', at: iso(8) }),
      (k) => { const f = { page: k, to, gen: 2, at: AT, nonce: RNONCE, actor: owner, association: assoc.hex }; return counter({ type: 'page-moved', ...f, signature: signMoved(f, ownerKp) }) },
      postRecord({ text: 'm depois', at: iso(9) })
    ]
  })

  const storage = memoryNodeStorage()
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, assoc.kp)
  await store.writeBlocklist(storage, createSnapshot({ seq: 1, blocked: [X.key] }, modKp, modCert))
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: stack.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { pageFeed: { fetchTimeoutMs: 1500 } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  const before = await web.request('log.read', {})
  const page = hex(crypto.keyPair().publicKey)

  const r = await web.request('page.feed', { page, keys: [A.key, B.key, X.key, M.key], limit: 30 })
  t.alike(r.items.map((i) => i.text), ['a1', 'a3', 'b1', 'b2', 'm antes'], 'feed order, deleted, blocked and post-move rows excluded')
  t.ok(r.items.every((i) => i.kind === 'post' && typeof i.author === 'string' && 'username' in i), 'feed.read rows')
  t.is(r.incomplete, false)

  const newest = await web.request('page.feed', { page, keys: [A.key, B.key], limit: 2 })
  t.alike(newest.items.map((i) => i.text), ['b1', 'b2'], 'the newest rows are kept')

  const unserved = await web.request('page.feed', { page, keys: [B.key, hex(crypto.keyPair().publicKey)], limit: 30 })
  t.alike(unserved.items.map((i) => i.text), ['b1', 'b2'])
  t.is(unserved.incomplete, true, 'a key the seeder does not serve')

  t.alike(await web.request('log.read', {}), before, 'nothing written')
  t.alike((await web.request('follow.list', { offset: 0, limit: 10 })).total, 0, 'no follow written')
  t.absent(await store.replicaExists(storage, A.key), 'no replica stored')
  t.alike(internal, [], 'no internal error')
})

test('page.feed: a block-0 issuer the final snapshot revokes drops the key', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const stack = await seederStack(t, bootstrap, assoc)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const R = await served(t, { assoc, stack, cert: (key) => createIssuedCert({ member: key }, issuerKp, issuerCert), records: [postRecord({ text: 'r1', at: iso(1) })] })
  const B = await served(t, { assoc, stack, records: [postRecord({ text: 'b1', at: iso(2) })] })

  const storage = memoryNodeStorage()
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, assoc.kp)
  const revoked = createSnapshot({ seq: 1, revokedIssuers: [hex(issuerKp.publicKey)] }, modKp, modCert)
  // The revocation lands right after the read's first snapshot, as another
  // tab's sync adopting it would.
  let armed = false
  const readJson = storage.readJson
  storage.readJson = async (key) => {
    const value = await readJson.call(storage, key)
    if (armed && key === 'blocklist') {
      armed = false
      await store.writeBlocklist(storage, revoked)
    }
    return value
  }
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: stack.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    syncOptions: { pageFeed: { fetchTimeoutMs: 1500 } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const page = hex(crypto.keyPair().publicKey)

  armed = true
  const r = await web.request('page.feed', { page, keys: [R.key, B.key], limit: 30 })
  t.absent(armed, 'the snapshot changed during the read')
  t.alike(r.items.map((i) => i.text), ['b1'], 'the revoked-issuer diary is dropped by the final snapshot')
  const again = await web.request('page.feed', { page, keys: [R.key, B.key], limit: 30 })
  t.alike(again.items.map((i) => i.text), ['b1'], 'and by the first one')
})

test('page.feed: no seeder answers sem conexão com o semeador', async (t) => {
  const kp = generateAssociationKeyPair()
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: hex(kp.publicKey),
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    syncOptions: { pageFeed: { connectTimeoutMs: 2000 } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  const web = await connectClient(node)
  const err = await errorOf(web.request('page.feed', { page: 'ab'.repeat(32), keys: ['cd'.repeat(32)], limit: 5 }))
  t.alike([err.code, err.message], ['USAGE', 'sem conexão com o semeador'])
})

test('page.feed: past a gap between the head and the tail only the tail run gives rows', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const stack = await seederStack(t, bootstrap, assoc)
  const posts = (prefix, from, n) => Array.from({ length: n }, (_, i) => postRecord({ text: prefix + (from + i), at: iso(from + i) }))
  // D: the head post at 1 is deleted by the tombstone at 3, in the gap
  // (3..7); the tail (8..15) ends with a newer profile.
  const D = await served(t, {
    assoc,
    stack,
    records: [postRecord({ text: 'd apagado', at: iso(1) }), profileRecord({ name: 'Velha', bio: '' }), deleteRecord({ seq: 1, at: iso(3) }), ...posts('dg', 4, 4), ...posts('d', 8, 7), profileRecord({ name: 'Nova', bio: '' })]
  })
  // F: a head post and profile, a gap, a tail without a profile. Unlike
  // D's (which the seeder clears), its head post is served: only the gap
  // rule keeps it out.
  const F = await served(t, {
    assoc,
    stack,
    records: [postRecord({ text: 'f cabeça', at: iso(1) }), profileRecord({ name: 'Velha', bio: '' }), ...posts('fg', 3, 5), ...posts('f', 8, 8)]
  })
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: stack.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    syncOptions: { pageFeed: { fetchTimeoutMs: 1500 } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const page = hex(crypto.keyPair().publicKey)
  const r = await web.request('page.feed', { page, keys: [D.key, F.key], limit: 30 })
  const of = (key) => r.items.filter((i) => i.author === key)
  t.alike(of(D.key).map((i) => i.text), ['d8', 'd9', 'd10', 'd11', 'd12', 'd13', 'd14'], 'the deleted head post is not shown')
  t.ok(of(D.key).every((i) => i.name === 'Nova'), 'the tail profile names the rows')
  t.alike(of(F.key).map((i) => i.text), ['f8', 'f9', 'f10', 'f11', 'f12', 'f13', 'f14', 'f15'], 'no head row past the gap')
  t.ok(of(F.key).every((i) => i.name === 'Velha'), 'the head profile lends the name')
})

test('page.feed: a tombstone over the page-close does not lift the cut (the target is fetched)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const stack = await seederStack(t, bootstrap, assoc)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  const counter = (record) => issuerCountersign(record, issuerKp, issuerCert)
  // P: the page genesis (roster at 2), closed at 3; a leaked key deletes
  // the close at 5 and posts above it.
  const P = await served(t, {
    assoc,
    stack,
    records: [
      postRecord({ text: 'p1', at: iso(1) }),
      (k) => { const f = { page: k, gen: 1, owner, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }; return counter({ type: 'page-roster', ...f, signature: signRoster(f, ownerKp) }) },
      (k) => { const f = { page: k, gen: 2, at: AT, nonce: 'c'.repeat(43), actor: owner, association: assoc.hex }; return counter({ type: 'page-close', ...f, signature: signClose(f, ownerKp) }) },
      postRecord({ text: 'p depois', at: iso(2) }),
      deleteRecord({ seq: 3, at: iso(3) }),
      postRecord({ text: 'p vazado', at: iso(4) })
    ]
  })
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: stack.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    syncOptions: { pageFeed: { fetchTimeoutMs: 1500 } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const page = hex(crypto.keyPair().publicKey)

  const r = await web.request('page.feed', { page, keys: [P.key], limit: 30 })
  t.alike(r.items.map((i) => i.text), ['p1'], 'the cut stays at the close: nothing above it shows')
  t.is(r.incomplete, false)
})

// A page closed at 3 whose leaked key appended `leaked` posts after it: with
// 8 or more, the close is outside the peek window.
async function closedPage (t, { assoc, stack, leaked }) {
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  const counter = (record) => issuerCountersign(record, issuerKp, issuerCert)
  return served(t, {
    assoc,
    stack,
    records: [
      postRecord({ text: 'p1', at: iso(1) }),
      (k) => { const f = { page: k, gen: 1, owner, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }; return counter({ type: 'page-roster', ...f, signature: signRoster(f, ownerKp) }) },
      (k) => { const f = { page: k, gen: 2, at: AT, nonce: 'c'.repeat(43), actor: owner, association: assoc.hex }; return counter({ type: 'page-close', ...f, signature: signClose(f, ownerKp) }) },
      ...Array.from({ length: leaked }, (_, i) => postRecord({ text: 'vazado' + (i + 4), at: iso(i + 4) }))
    ]
  })
}

function pageFeedNode (t, assoc, stack) {
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: stack.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    syncOptions: { pageFeed: { fetchTimeoutMs: 1500 } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  return node
}

async function indexedEnd (seeder, key) {
  for (let i = 0; i < 200; i++) {
    const r = seeder.indexPageEnd(key)
    if (r !== null && r.endSeq !== null) return r.endSeq
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

test('page.feed: a close outside the window is fetched from the seeder pointer and cuts the leaked tail', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const stack = await seederStack(t, bootstrap, assoc, { pageEnd: (key, seeder) => seeder.indexPageEnd(key) })
  const P = await closedPage(t, { assoc, stack, leaked: 10 })
  t.is(await indexedEnd(stack.seeder, P.key), 3, 'the name index points at the verified close')
  const node = pageFeedNode(t, assoc, stack)
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const page = hex(crypto.keyPair().publicKey)
  const r = await web.request('page.feed', { page, keys: [P.key], limit: 30 })
  t.alike(r.items.map((i) => i.text), [], 'nothing above the close shows')
  t.is(r.incomplete, false, 'the close verified')
  t.alike(stack.requests, [P.key])
})

test('page.feed: a pointer whose block is not a verified close leaves the page incomplete without its tail', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  let answer = null
  const stack = await seederStack(t, bootstrap, assoc, { pageEnd: () => answer })
  const P = await closedPage(t, { assoc, stack, leaked: 10 })
  const B = await served(t, { assoc, stack, records: [postRecord({ text: 'b1', at: iso(30) }), postRecord({ text: 'b2', at: iso(31) }), postRecord({ text: 'b3', at: iso(32) })] })
  const node = pageFeedNode(t, assoc, stack)
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const page = hex(crypto.keyPair().publicKey)
  const of = (r, key) => r.items.filter((i) => i.author === key).map((i) => i.text)

  // A leaked post (seq 5, outside the window) named as the end: unverifiable.
  answer = { endSeq: 5 }
  const lie = await web.request('page.feed', { page, keys: [P.key, B.key], limit: 30 })
  t.alike(of(lie, P.key), [], 'no tail row of the page')
  t.alike(of(lie, B.key), ['b1', 'b2', 'b3'], 'the other diary is unaffected')
  t.is(lie.incomplete, true)

  // A pointer past the log is no pointer: as without an answer.
  answer = { endSeq: 99 }
  const past = await web.request('page.feed', { page, keys: [P.key], limit: 30 })
  t.alike(of(past, P.key).length, 8, 'an out-of-range seq is ignored')
  t.is(past.incomplete, false)

  // The seeder withholds the pointer: as before this fix (accepted residual,
  // docs/protocol.md §12), the window alone decides.
  answer = null
  const withheld = await web.request('page.feed', { page, keys: [P.key], limit: 30 })
  t.alike(of(withheld, P.key).length, 8, 'withholding changes nothing compared with no pointer')
  t.is(withheld.incomplete, false)
  t.ok(stack.requests.every((k) => k === P.key), 'only the page diary was asked for its end')
})

test('page.feed: a personal diary asks the seeder for no end pointer', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const stack = await seederStack(t, bootstrap, assoc, { pageEnd: (key, seeder) => seeder.indexPageEnd(key) })
  const posts = Array.from({ length: 14 }, (_, i) => postRecord({ text: 'a' + (i + 1), at: iso(i + 1) }))
  const A = await served(t, { assoc, stack, records: posts })
  const node = pageFeedNode(t, assoc, stack)
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const page = hex(crypto.keyPair().publicKey)
  const r = await web.request('page.feed', { page, keys: [A.key], limit: 30 })
  t.alike(r.items.map((i) => i.text), ['a7', 'a8', 'a9', 'a10', 'a11', 'a12', 'a13', 'a14'])
  t.is(r.incomplete, false)
  t.alike(stack.requests, [], 'no request to the index')
})

test('page.feed: a person whose block 2 was deleted never shows it, even when a hostile seeder points at it', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  // A hostile index points at the deleted block 2.
  const stack = await seederStack(t, bootstrap, assoc, { pageEnd: () => ({ endSeq: 2 }) })
  const A = await served(t, {
    assoc,
    stack,
    records: [postRecord({ text: 'a1', at: iso(1) }), postRecord({ text: 'a2 apagado', at: iso(2) }), postRecord({ text: 'a3', at: iso(3) }), deleteRecord({ seq: 2, at: iso(4) })]
  })
  const node = pageFeedNode(t, assoc, stack)
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const page = hex(crypto.keyPair().publicKey)
  const r = await web.request('page.feed', { page, keys: [A.key], limit: 30 })
  t.absent(r.items.some((i) => i.text === 'a2 apagado'), 'the deleted post never shows')
  t.is(r.incomplete, true, 'an unverified pointer fails closed: the tail is hidden, never the deleted post shown')
  t.alike(stack.requests, [A.key], 'the pointer may be asked: block 2 is unread')
})

test('page.feed: a person whose block 2 was deleted and a pointer at another deleted post: no deleted post shows', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const stack = await seederStack(t, bootstrap, assoc, { pageEnd: () => ({ endSeq: 4 }) })
  const A = await served(t, {
    assoc,
    stack,
    records: [
      postRecord({ text: 'a1', at: iso(1) }),
      postRecord({ text: 'a2 apagado', at: iso(2) }),
      postRecord({ text: 'a3', at: iso(3) }),
      postRecord({ text: 'a4 apagado', at: iso(4) }),
      postRecord({ text: 'a5', at: iso(5) }),
      deleteRecord({ seq: 2, at: iso(6) }),
      deleteRecord({ seq: 4, at: iso(7) })
    ]
  })
  const node = pageFeedNode(t, assoc, stack)
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const page = hex(crypto.keyPair().publicKey)
  const r = await web.request('page.feed', { page, keys: [A.key], limit: 30 })
  t.absent(r.items.some((i) => /apagado/.test(i.text)), 'no deleted post shows')
  t.is(r.incomplete, true)
})

test('page.feed: a leaked key deleting the roster and the close cannot lift the cut (the pointer is still asked)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const stack = await seederStack(t, bootstrap, assoc, { pageEnd: () => ({ endSeq: 3 }) })
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  const counter = (record) => issuerCountersign(record, issuerKp, issuerCert)
  // Roster at 2, close at 3; the leaked key posts, deletes 2 and 3 inside
  // the tail window, and posts more, so the close is outside the window and
  // block 2 is unread because a tombstone names it.
  const leaked = (from, n) => Array.from({ length: n }, (_, i) => postRecord({ text: 'vazado' + (from + i), at: iso(from + i) }))
  const P = await served(t, {
    assoc,
    stack,
    records: [
      postRecord({ text: 'p1', at: iso(1) }),
      (k) => { const f = { page: k, gen: 1, owner, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }; return counter({ type: 'page-roster', ...f, signature: signRoster(f, ownerKp) }) },
      (k) => { const f = { page: k, gen: 2, at: AT, nonce: 'c'.repeat(43), actor: owner, association: assoc.hex }; return counter({ type: 'page-close', ...f, signature: signClose(f, ownerKp) }) },
      ...leaked(4, 8),
      deleteRecord({ seq: 2, at: iso(20) }),
      deleteRecord({ seq: 3, at: iso(21) }),
      ...leaked(14, 2)
    ]
  })
  const node = pageFeedNode(t, assoc, stack)
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const page = hex(crypto.keyPair().publicKey)
  const r = await web.request('page.feed', { page, keys: [P.key], limit: 30 })
  t.absent(r.items.some((i) => /vazado/.test(i.text)), 'nothing after the close shows')
  t.is(r.incomplete, false, 'the pointed close verified')
  t.alike(stack.requests, [P.key])
})
