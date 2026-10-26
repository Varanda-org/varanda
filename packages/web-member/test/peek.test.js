// The Espiadinha of the browser node (lib/peek.js through lib/session.js,
// lib/node.js and an in-memory client), loopback only. The first test runs
// against the real seeder (@varanda/core lib/seeder, Hypercore 11) behind a
// WebSocket server as g1-seeder-ws.test.js does, with three Hypercore 10
// authors admitted through lib/seeder-link; the others use a seeder
// stand-in (blocklist.test.js's pattern: role 'seeder' certified by the
// association, replicating and advertising Hypercore 10 cores) so they can
// advertise forks, short lengths, hostile certificates and a hello whose
// count exceeds its entries.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, createIssuerCert, createIssuedCert, createUsernameRecord, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord, likeRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { PEEK_MAX_ROUNDS } = require('@varanda/core/lib/peek')
const { createBrowserNode } = require('../lib/node')
const { createMember } = require('../lib/member')
const { connectSeeder } = require('../lib/seeder-link')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const { writeBlocklist, writeFollows, replicaExists } = require('../lib/node-store')
const { PEEK_CORE_PAGE_SIZE, createPeeker } = require('../lib/peek')

const NO_SEEDER = 'sem conexão com o semeador'
const BUSY = 'espiadinha já em andamento'
const HOUR = 3600000

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function moderator (assocKp) {
  const keyPair = crypto.keyPair()
  return { keyPair, cert: createModeratorCert({ moderator: hex(keyPair.publicKey) }, assocKp) }
}

function snapshot (mod, { seq = 1, blocked = [], revokedIssuers = [] }) {
  return createSnapshot({ seq, blocked, revokedIssuers }, mod.keyPair, mod.cert)
}

function issuer (assoc) {
  const keyPair = crypto.keyPair()
  return { keyPair, hex: hex(keyPair.publicKey), cert: createIssuerCert({ issuer: hex(keyPair.publicKey) }, assoc.kp) }
}

function iso (ms) {
  return new Date(ms).toISOString()
}

// A Hypercore 10 diary with the given records (block 0 first); each maker
// receives the diary key.
async function diary (t, records, keyPair = null) {
  const core = new Hypercore(memoryStorage(), { valueEncoding: 'json', ...(keyPair ? { keyPair } : {}) })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  for (const make of records) await core.append(make(hex(core.key)))
  return core
}

// cert (v1 by the association), profile, then `posts` top-level posts with
// the given `at` values (ms).
function author (assoc, name, ats) {
  return [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => profileRecord({ name, bio: '' }),
    ...ats.map((ms, i) => () => postRecord({ text: name + ' ' + (i + 1), at: iso(ms) }))
  ]
}

// A seeder stand-in over a WebSocket: role 'seeder' certified by `signer`,
// replicating `cores` and advertising them with their length at connection
// time (or `lengthOf(core)`); admits whatever is announced. `ghosts` are
// extra have entries ({ key, length }) it advertises but never serves.
// `coresOf(connectionIndex)` picks the cores of a given connection (a
// seeder that changes its story between links). `delayOf(core,
// connectionIndex)` (ms) delays replicating that core on that connection
// while its have entry goes out at once (a slow diary).
async function fakeSeeder (t, { signer, cores = [], lengthOf = (core) => core.length, ghosts = [], coresOf = () => cores, delayOf = () => 0 }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const seeder = {
    url: 'ws://127.0.0.1:' + wss.address().port + '/seeder',
    publicKey: hex(keyPair.publicKey),
    connections: 0,
    closed: false,
    async close () {
      if (seeder.closed) return
      seeder.closed = true
      for (const s of wss.clients) s.terminate()
      await new Promise((resolve) => wss.close(() => resolve()))
    }
  }
  t.teardown(() => seeder.close(), { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      const index = seeder.connections
      const served = coresOf(index)
      seeder.connections++
      Hypercore.createProtocolStream(noise)
      for (const core of served) {
        const delay = delayOf(core, index)
        if (delay > 0) {
          const timer = setTimeout(() => { if (!noise.destroyed) core.replicate(noise) }, delay)
          t.teardown(() => clearTimeout(timer))
        } else {
          core.replicate(noise)
        }
      }
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: [...served.map((core) => ({ key: hex(core.key), length: lengthOf(core) })), ...ghosts],
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return seeder
}

// A seeder stand-in speaking the admission channel by hand: its hello
// advertises `cores` but claims `extra` more entries that never come, so the
// member's inventory completes only by its 5 s timeout (incomplete).
async function overclaimingSeeder (t, { signer, cores = [], extra = 1 }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const s of wss.clients) s.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      const mux = Hypercore.createProtocolStream(noise).userData
      for (const core of cores) core.replicate(noise)
      let message = null
      const send = (msg) => message.send(b4a.from(JSON.stringify(msg), 'utf8'))
      const have = cores.map((core) => ({ key: hex(core.key), length: core.length }))
      const channel = mux.createChannel({
        protocol: 'varanda/admission/1',
        onopen: () => send({ type: 'hello', v: 1, role: 'seeder', count: have.length + extra, have, cert })
      })
      message = channel.addMessage({ encoding: c.buffer, onmessage: () => {} })
      channel.open()
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// The web node with its client in memory, identity created (and certified
// when `certify`), the write gate off. `sockets` records every client
// WebSocket the node dials (sync and peek links alike).
async function webNode (t, assoc, url, { storage = memoryNodeStorage(), keyPair = crypto.keyPair(), certify = false, peek = {} } = {}) {
  const sockets = []
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      sockets.push(ws)
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, peek },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  if (certify) await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, storage, key: publicKey, sockets, internal }
}

// Every page from the first one, with `limit`: [{ items, next, ... }].
async function allPages (web, limit) {
  const pages = []
  let after
  while (true) {
    const page = await web.request('peek.read', after === undefined ? { limit } : { limit, after })
    pages.push(page)
    if (page.next === null) return pages
    after = page.next
  }
}

function warningsOf (web) {
  return web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
}

function perAuthor (items) {
  const counts = {}
  for (const i of items) counts[i.author] = (counts[i.author] || 0) + 1
  return counts
}

test('(1) against the real seeder: the newest post of every unfollowed diary, round by round, paged', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = association()

  // The seeder: in-process, its WebSocket entry handing streams to acceptStream.
  const seederDir = tmpDir(t, 'varanda-peek-seed-')
  Seeder.ensureConfig(seederDir, assoc.hex)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-peek-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assoc.kp)))
  Seeder.addCert(seederDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const s of wss.clients) s.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  const url = 'ws://127.0.0.1:' + wss.address().port + '/seeder'

  // Three Hypercore 10 authors, certified by the association and admitted
  // through the member link, each with a profile at block 1.
  const now = Date.now()
  async function seed (name, records) {
    const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
    t.teardown(() => m.close(), { force: true })
    await m.setCert(createCert({ member: m.key }, assoc.kp))
    await m.core.append(profileRecord({ name, bio: '' }))
    for (const make of records) await m.core.append(make(m.key))
    const link = connectSeeder({ member: m, socket: new WebSocket(url), association: assoc.hex, seederPublicKey: seederKey, timeoutMs: 60000 })
    t.teardown(() => link.close(), { force: true })
    const admitted = await link.admitted
    t.is(admitted.key, m.key, name + ' admitted')
    await link.waitServed(m.core.length)
    link.close()
    return m
  }
  const A = await seed('Ana', [1, 2, 3, 4, 5, 6].map((i) => () => postRecord({ text: 'ana ' + i, at: iso(now - 10 * HOUR + i * 1000) })))
  const B = await seed('Bia', [
    () => postRecord({ text: 'bia 1', at: iso(now - 5 * HOUR) }),
    () => postRecord({ text: 'bia 2', at: iso(now - 4 * HOUR) })
  ])
  const C = await seed('Caio', [
    () => postRecord({ text: 'caio 1', at: iso(now - 3 * HOUR) }),
    () => postRecord({ text: 'caio futuro', at: iso(now + 48 * HOUR) }),
    (key) => postRecord({ text: 'caio responde', at: iso(now - 1 * HOUR), replyTo: { author: key, seq: 2 } })
  ])
  t.is(A.core.length, 8)
  t.is(B.core.length, 4)
  t.is(C.core.length, 5)

  // The member follows A: the Espiadinha shows B and C only.
  const { web, internal } = await webNode(t, assoc, url, { certify: true })
  await web.request('follow.add', { key: A.key })
  const page = await web.request('peek.read', {})
  t.alike(internal, [], 'no internal error')
  t.is(page.diaries, 2, 'two candidates')
  t.is(page.skipped, 0)
  t.is(page.incomplete, false)
  t.is(page.next, null)
  // A reply is a publication: Caio's reply is his newest.
  const expected = [
    { author: C.key, name: 'Caio', seq: 4, text: 'caio responde', round: 0 },
    { author: B.key, name: 'Bia', seq: 3, text: 'bia 2', round: 0 },
    { author: C.key, name: 'Caio', seq: 2, text: 'caio 1', round: 1 },
    { author: B.key, name: 'Bia', seq: 2, text: 'bia 1', round: 1 }
  ]
  t.alike(page.items.map(({ author, name, seq, text, round }) => ({ author, name, seq, text, round })), expected)
  for (const item of page.items) {
    t.alike(item.replyTo, item.seq === 4 ? { author: C.key, seq: 2 } : null)
    t.is(item.kind, 'post')
    t.is(item.username, null)
    t.is(item.media, null)
  }
  t.absent(page.items.some((i) => i.author === A.key), 'the followed diary is absent')
  t.absent(page.items.some((i) => i.text === 'caio futuro'), 'the future post is absent')

  // limit 1: disjoint pages that concatenate to the full order and end with next null.
  const pages = await allPages(web, 1)
  t.is(pages.length, 5)
  t.alike(pages.map((p) => p.items.length), [1, 1, 1, 1, 0])
  t.alike(pages.flatMap((p) => p.items), page.items, 'the pages concatenate to the full order')
  t.is(pages[4].next, null)
  for (const p of pages.slice(0, 4)) t.alike(p.next, { round: p.items[0].round, at: p.items[0].at, author: p.items[0].author, seq: p.items[0].seq })
  t.alike(internal, [])
})

test('(2)(16) one slot per diary per round, the tail window extends past likes, at most 3 per diary', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  // 50 posts then 8 likes: the first tail window holds likes only (never shown).
  const big = await diary(t, [
    ...author(assoc, 'Grande', Array.from({ length: 50 }, (_, i) => now - 20 * HOUR + i * 1000)),
    ...Array.from({ length: 8 }, (_, i) => (key) => likeRecord({ to: { author: key, seq: 2 + i }, on: true, at: iso(now - HOUR + i * 1000) }))
  ])
  t.is(big.length, 60)
  const s1 = await diary(t, author(assoc, 'Um', [now - 2 * HOUR]))
  const s2 = await diary(t, author(assoc, 'Dois', [now - 3 * HOUR]))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [big, s1, s2] })
  const { web, internal } = await webNode(t, assoc, seeder.url)

  // PEEK_LIMIT_MAX (31): the page has room for every round of every diary.
  const page = await web.request('peek.read', { limit: 31 })
  t.alike(internal, [])
  t.is(page.diaries, 3)
  t.is(page.skipped, 0)
  t.is(page.incomplete, false)
  t.is(page.next, null)
  t.is(page.items.length, 5, 'three in round 0, the big diary alone in rounds 1 and 2')
  const bigItems = page.items.filter((i) => i.author === hex(big.key))
  t.alike(bigItems.map((i) => i.seq), [51, 50, 49], 'the newest posts, behind the likes')
  t.alike(bigItems.map((i) => i.round), [0, 1, 2])
  const secondBig = page.items.indexOf(bigItems[1])
  for (const key of [hex(s1.key), hex(s2.key)]) {
    t.ok(page.items.findIndex((i) => i.author === key) < secondBig, 'every other diary had one before the big one had two')
  }
  // The big diary's newest post is the oldest `at` of the three.
  t.alike(page.items.slice(0, 3).map((i) => i.author), [hex(s1.key), hex(s2.key), hex(big.key)], 'round 0 by at desc')

  // (16) across all pages no diary shows more than PEEK_MAX_ROUNDS posts.
  const pages = await allPages(web, 2)
  const all = pages.flatMap((p) => p.items)
  t.is(all.length, 5)
  for (const n of Object.values(perAuthor(all))) t.ok(n <= PEEK_MAX_ROUNDS)
  t.alike(all, page.items, 'paging reproduces the full order')
})

test('(3) the stored blocklist hides a blocked diary and skips a revoked issuer, without any sync', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const iss = issuer(assoc)
  const now = Date.now()
  const A = await diary(t, author(assoc, 'A', [now - 1000]))
  const B = await diary(t, author(assoc, 'B', [now - 2000]))
  const C = await diary(t, [
    (key) => memberCertRecord(createIssuedCert({ member: key }, iss.keyPair, iss.cert)),
    () => profileRecord({ name: 'C', bio: '' }),
    () => postRecord({ text: 'c 1', at: iso(now - 3000) })
  ])
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [A, B, C] })
  const { web, storage, internal } = await webNode(t, assoc, seeder.url)

  const first = await web.request('peek.read', { limit: 1 })
  t.alike(first.items.map((i) => i.author), [hex(A.key)])
  t.is(first.diaries, 3)
  // A snapshot blocking B arrives (stored by whoever stores it): the
  // continuation page of the EXISTING snapshot hides B.
  await writeBlocklist(storage, snapshot(mod, { blocked: [hex(B.key)] }))
  const connections = seeder.connections
  const second = await web.request('peek.read', { limit: 1, after: first.next })
  t.alike(second.items.map((i) => i.author), [hex(C.key)], 'B is hidden on the continuation page')
  t.is(second.skipped, 1, 'B stays a candidate of this snapshot, now skipped')
  t.is(seeder.connections, connections, 'no fetch was needed')
  const third = await web.request('peek.read', { limit: 1, after: second.next })
  t.alike(third, { items: [], next: null, diaries: 3, skipped: 1, incomplete: false })
  // A fresh first page: B is not even a candidate.
  const fresh = await web.request('peek.read', {})
  t.alike(fresh.items.map((i) => i.author), [hex(A.key), hex(C.key)])
  t.is(fresh.diaries, 2)
  t.is(fresh.skipped, 0)

  // A snapshot revoking C's issuer: C is skipped.
  await writeBlocklist(storage, snapshot(mod, { seq: 2, blocked: [hex(B.key)], revokedIssuers: [iss.hex] }))
  const revoked = await web.request('peek.read', {})
  t.alike(revoked.items.map((i) => i.author), [hex(A.key)])
  t.is(revoked.diaries, 2)
  t.is(revoked.skipped, 1, 'C counts as skipped')
  t.is(revoked.incomplete, false)
  t.alike(internal, [])
  t.is(web.events.filter((e) => e.name === 'sync.started').length, 0, 'no sync ran')
})

test('(4) no seeder, or an endpoint that is not a verified seeder', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const other = association()
  const now = Date.now()

  // Stopped seeder.
  const stopped = await fakeSeeder(t, { signer: assoc.kp })
  await stopped.close()
  const gone = await webNode(t, assoc, stopped.url)
  const err = await errorOf(gone.web.request('peek.read', {}))
  t.is(err && err.code, 'USAGE')
  t.is(err && err.message, NO_SEEDER)

  // An endpoint whose hello is not a verified seeder: same message, and the
  // diary it offers is never replicated (no peer ever opens its channel).
  const D = await diary(t, author(assoc, 'D', [now]))
  let peerAdds = 0
  D.on('peer-add', () => { peerAdds++ })
  const impostor = await fakeSeeder(t, { signer: other.kp, cores: [D] })
  const { web, internal } = await webNode(t, assoc, impostor.url)
  const err2 = await errorOf(web.request('peek.read', {}))
  t.is(err2 && err2.code, 'USAGE')
  t.is(err2 && err2.message, NO_SEEDER)
  t.is(impostor.connections, 1, 'the endpoint was dialled')
  t.is(peerAdds, 0, 'no core was replicated')
  t.is(D.peers.length, 0)
  t.ok(warningsOf(web).some((l) => l.startsWith('aviso: o endereço configurado não respondeu como um semeador verificado')), 'warned')
  t.alike(internal, [])
})

test('(5) a running continuous sync is not preempted and nothing is stored', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const A = await diary(t, author(assoc, 'A', [now - 1000]))
  const B = await diary(t, author(assoc, 'B', [now - 2000]))
  const C = await diary(t, author(assoc, 'C', [now - 3000]))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [A, B, C] })
  const storage = memoryNodeStorage()
  const { web, internal } = await webNode(t, assoc, seeder.url, { storage, certify: true })
  // The member follows A (kv follows, as a synced device would hold it).
  await writeFollows(storage, [hex(A.key)])

  const { runId } = await web.request('sync.start', { once: false })
  await until(() => web.events.some((e) => e.name === 'sync.event' && e.data.runId === runId && e.data.line.startsWith('downloaded ' + hex(A.key))), { name: 'A downloaded', timeoutMs: 30000 })
  const before = web.events.length
  const page = await web.request('peek.read', {})
  t.alike(page.items.map((i) => i.author), [hex(B.key), hex(C.key)])
  t.is(page.diaries, 2)
  const stoppedDuring = web.events.slice(before).filter((e) => e.name === 'sync.stopped')
  t.alike(stoppedDuring, [], 'the continuous run was not stopped (no preemption)')
  t.alike(await web.request('sync.status', {}), { state: 'running', runId, once: false })
  t.is(await replicaExists(storage, hex(B.key)), false, 'B was not stored')
  t.is(await replicaExists(storage, hex(C.key)), false, 'C was not stored')
  t.is(await replicaExists(storage, hex(A.key)), true, 'the followed diary is')
  await web.request('sync.stop', {})
  t.alike(internal, [])
})

test('(6) a fresh first page sees a new post first; a cursor past the end answers an empty last page', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const B = await diary(t, author(assoc, 'B', [now - 2000]))
  const C = await diary(t, author(assoc, 'C', [now - 3000]))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [B, C] })
  const { web, internal } = await webNode(t, assoc, seeder.url)

  const first = await web.request('peek.read', {})
  t.alike(first.items.map((i) => [i.author, i.seq]), [[hex(B.key), 2], [hex(C.key), 2]])
  await C.append(postRecord({ text: 'c novo', at: iso(now - 1000) }))
  const second = await web.request('peek.read', {})
  t.alike(second.items.map((i) => [i.author, i.seq, i.round]), [[hex(C.key), 3, 0], [hex(B.key), 2, 0], [hex(C.key), 2, 1]], 'the new post first, the old one in round 1')

  const pages = await allPages(web, 1)
  t.alike(pages[pages.length - 1], { items: [], next: null, diaries: 2, skipped: 0, incomplete: false })
  const beyond = await web.request('peek.read', { after: { round: 2, at: '1970-01-01T00:00:00.000Z', author: 'f'.repeat(64), seq: 1 } })
  t.alike(beyond, { items: [], next: null, diaries: 2, skipped: 0, incomplete: false })
  t.alike(internal, [])
})

test('(7) a hello whose count exceeds its entries makes the page incomplete', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const D = await diary(t, author(assoc, 'D', [Date.now() - 1000]))
  const seeder = await overclaimingSeeder(t, { signer: assoc.kp, cores: [D], extra: 1 })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  t.is(page.incomplete, true)
  t.alike(page.items.map((i) => i.author), [hex(D.key)], 'what was advertised still shows')
  t.ok(warningsOf(web).some((l) => l.startsWith('aviso: inventário incompleto')), 'warned')
  t.alike(internal, [])
})

test('(8) close() during a read resolves and the socket is closed', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const D = await diary(t, author(assoc, 'D', [Date.now() - 1000]))
  // The inventory only completes by its timeout: the read is in flight.
  const seeder = await overclaimingSeeder(t, { signer: assoc.kp, cores: [D], extra: 1 })
  const { node, web, sockets } = await webNode(t, assoc, seeder.url)
  const reading = errorOf(web.request('peek.read', {}))
  await until(() => sockets.length === 1 && sockets[0].readyState === WebSocket.OPEN, { name: 'peek link open' })
  const started = Date.now()
  await node.close()
  t.ok(Date.now() - started < 4000, 'close did not wait for the inventory timeout')
  t.ok(await reading, 'the read ended with an error')
  await until(() => sockets[0].readyState === WebSocket.CLOSED, { name: 'socket closed' })
  t.is(sockets[0].readyState, WebSocket.CLOSED)
})

test('(9)(10) a forked diary is skipped; a block 0 failing the gate never gets a second request', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const other = association()
  const now = Date.now()
  const forked = await diary(t, author(assoc, 'F', [now - 1000, now - 900]))
  await forked.truncate(2)
  await forked.append(postRecord({ text: 'reescrito', at: iso(now - 800) }))
  t.is(forked.fork, 1)
  t.is(forked.length, 3)
  const foreign = await diary(t, author(other, 'X', [now - 1000]))
  const uploads = []
  foreign.on('upload', (index) => uploads.push(index))
  const good = await diary(t, author(assoc, 'G', [now - 2000]))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [forked, foreign, good] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  t.alike(page.items.map((i) => i.author), [hex(good.key)])
  t.is(page.diaries, 3)
  t.is(page.skipped, 2, 'the fork and the foreign certificate')
  t.is(page.incomplete, false)
  t.alike(uploads, [0], 'only block 0 of the foreign diary was ever served')
  t.alike(internal, [])
})

test('(11) a seeder advertising a shorter length than the signed diary still yields the newest post', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const D = await diary(t, author(assoc, 'D', [now - 3000, now - 2000, now - 1000]))
  t.is(D.length, 5)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [D], lengthOf: () => 2 })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  t.alike(page.items.map((i) => [i.seq, i.round]), [[4, 0], [3, 1], [2, 2]], 'the window comes from the verified length')
  t.is(page.incomplete, false)
  t.alike(internal, [])
})

test('(12) an issuer revoked after the first page nulls the username on a continuation page served without a fetch', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const iss = issuer(assoc)
  const now = Date.now()
  const U = await diary(t, [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => profileRecord({ name: 'U', bio: '' }),
    (key) => createUsernameRecord({ member: key, username: 'ulisses' }, iss.keyPair, iss.cert),
    () => postRecord({ text: 'u 1', at: iso(now - 6000) }),
    () => postRecord({ text: 'u 2', at: iso(now - 4000) })
  ])
  const V = await diary(t, author(assoc, 'V', [now - 5000, now - 3000]))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [U, V] })
  const { web, storage, sockets, internal } = await webNode(t, assoc, seeder.url)

  // Order: round 0 = V (u 2 is older than v 2) then U; round 1 = V then U.
  const p1 = await web.request('peek.read', { limit: 1 })
  t.alike(p1.items.map((i) => i.author), [hex(V.key)])
  const p2 = await web.request('peek.read', { limit: 1, after: p1.next })
  t.alike(p2.items.map((i) => [i.author, i.username]), [[hex(U.key), 'ulisses']])
  const dialled = sockets.length
  await writeBlocklist(storage, snapshot(mod, { revokedIssuers: [iss.hex] }))
  const p3 = await web.request('peek.read', { limit: 1, after: p2.next })
  t.alike(p3.items.map((i) => i.author), [hex(V.key)])
  const p4 = await web.request('peek.read', { limit: 1, after: p3.next })
  t.alike(p4.items.map((i) => [i.author, i.username, i.seq]), [[hex(U.key), null, 3]], 'v1-certified diary still shown, username null')
  t.is(sockets.length, dialled, 'the continuation pages needed no link')
  t.alike(internal, [])
})

test('(13) a concurrent peek.read is refused; close() during the first awaits it', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const D = await diary(t, author(assoc, 'D', [Date.now() - 1000]))
  const seeder = await overclaimingSeeder(t, { signer: assoc.kp, cores: [D], extra: 1 })
  const { node, web, sockets } = await webNode(t, assoc, seeder.url)
  let settled = false
  const first = errorOf(web.request('peek.read', {}))
  first.then(() => { settled = true })
  await until(() => sockets.length === 1 && sockets[0].readyState === WebSocket.OPEN, { name: 'peek link open' })
  const second = await errorOf(web.request('peek.read', {}))
  t.is(second && second.code, 'USAGE')
  t.is(second && second.message, BUSY)
  t.is(settled, false, 'the first is still running')
  await node.close()
  await first
  t.is(settled, true)
  t.is(sockets.length, 1, 'the refused call opened nothing')
})

test('(14) a diary burying its post under profile records is capped and marks the page incomplete', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const spam = await diary(t, [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => profileRecord({ name: 'S', bio: '' }),
    () => profileRecord({ name: 'S2', bio: '' }),
    () => postRecord({ text: 'enterrado', at: iso(now - 1000) }),
    ...Array.from({ length: 70 }, (_, i) => () => profileRecord({ name: 'S' + i, bio: '' }))
  ])
  t.is(spam.length, 74)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [spam] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  t.alike(page, { items: [], next: null, diaries: 1, skipped: 1, incomplete: true })
  t.alike(internal, [])
})

test('(15) memoryStorage page size: the default is unchanged, the peeker asks for 64 KiB', (t) => {
  t.is(memoryStorage()('data').pageSize, 1048576)
  t.is(memoryStorage({ pageSize: 65536 })('data').pageSize, 65536)
  t.is(PEEK_CORE_PAGE_SIZE, 65536)
  const factory = memoryStorage({ pageSize: 65536 })
  const first = factory('tree')
  first.close()
  t.is(factory('tree').pageSize, 65536, 'carried over on reopen')
})

test('a page over 50 seeded diaries completes well within the page deadline', async (t) => {
  t.timeout(120000)
  const assoc = association()
  const now = Date.now()
  const cores = []
  for (let i = 0; i < 50; i++) cores.push(await diary(t, author(assoc, 'D' + i, [now - (i + 1) * 1000])))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const started = Date.now()
  const page = await web.request('peek.read', {})
  const elapsed = Date.now() - started
  t.comment('50 diários em ' + elapsed + ' ms')
  t.ok(elapsed < 25000, 'under the page deadline')
  t.is(page.items.length, 30, 'the default limit')
  t.is(page.diaries, 50)
  t.is(page.skipped, 0)
  t.is(page.incomplete, false)
  t.ok(page.next !== null)
  t.alike(page.items.map((i) => i.author), cores.slice(0, 30).map((core) => hex(core.key)), 'by at desc')
  const rest = await web.request('peek.read', { after: page.next })
  t.is(rest.items.length, 20)
  t.is(rest.next, null)
  t.alike(internal, [])
})

test('regression: the page byte budget holds under parallel fetches and marks the page incomplete', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const cores = []
  let uploaded = 0
  let largest = 0
  for (let i = 0; i < 40; i++) {
    const core = await diary(t, author(assoc, 'B' + i, [now - (i + 1) * 1000]))
    core.on('upload', (index, byteLength) => { uploaded += byteLength })
    largest = Math.max(largest, core.byteLength)
    cores.push(core)
  }
  const pageMaxBytes = 10000
  const parallel = 4
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores })
  const { web, internal } = await webNode(t, assoc, seeder.url, { peek: { pageMaxBytes, parallel } })
  const page = await web.request('peek.read', {})
  t.is(page.incomplete, true, 'the budget stopped the fetching')
  t.is(page.diaries, 40)
  t.ok(page.items.length >= 1 && page.items.length < 40, 'some diaries were fetched, not all')
  t.comment('bytes served ' + uploaded + ', largest diary ' + largest)
  t.ok(uploaded <= pageMaxBytes + parallel * largest, 'overshoot of at most one window per worker')
  t.ok(uploaded > pageMaxBytes / 2, 'the budget was actually used')
  t.alike(internal, [])
})

test('regression: a diary with nothing to show is not counted as skipped', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const now = Date.now()
  const A = await diary(t, author(assoc, 'A', [now - 2000, now - 1000]))
  const P = await diary(t, author(assoc, 'P', []))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [A, P] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  t.is(page.diaries, 2, 'both are candidates')
  t.alike(page.items.map((i) => i.author), [hex(A.key), hex(A.key)], 'only A has posts to show')
  t.is(page.skipped, 0, 'a diary holding only its profile is not a problem')
  t.is(page.incomplete, false)
  t.alike(internal, [])
})

test('regression: a page cut by the budget with diaries still pending keeps a cursor', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const cores = []
  for (let i = 0; i < 12; i++) cores.push(await diary(t, author(assoc, 'C' + i, [now - (i + 1) * 1000])))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores })
  const { web, internal } = await webNode(t, assoc, seeder.url, { peek: { pageMaxBytes: 1500, parallel: 2 } })
  const first = await web.request('peek.read', { limit: 1 })
  t.is(first.incomplete, true, 'the budget cut the fetching')
  t.is(first.items.length, 1)
  t.ok(first.next !== null, 'a cut page is not the end of the Espiadinha')
  const rest = []
  let after = first.next
  while (after !== null) {
    const page = await web.request('peek.read', { limit: 1, after })
    rest.push(page)
    after = page.next
  }
  const items = [first, ...rest].flatMap((p) => p.items)
  t.ok(items.length > 1, 'paging continued past the cut page')
  t.is(new Set(items.map((i) => i.author)).size, items.length, 'no author repeats (one post each)')
  for (const p of [first, ...rest].slice(0, -1)) t.is(p.items.length, 1)
  t.alike(internal, [])
})

test('regression: a diary whose block 0 never arrives is terminal, paging continues over the others', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const A = await diary(t, author(assoc, 'A', [now - 6000, now - 4000, now - 2000]))
  const B = await diary(t, author(assoc, 'B', [now - 5000, now - 3000, now - 1000]))
  const ghost = { key: hex(crypto.keyPair().publicKey), length: 3 }
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [A, B], ghosts: [ghost] })
  const { web, internal } = await webNode(t, assoc, seeder.url, { peek: { fetchTimeoutMs: 1000 } })
  const started = Date.now()
  const pages = await allPages(web, 1)
  t.ok(Date.now() - started < 15000, 'no page waited for the page deadline')
  const items = pages.flatMap((p) => p.items)
  t.is(items.length, 6, 'every available post is reachable through continuation pages')
  t.alike(items.map((i) => [i.author, i.seq]), [[hex(B.key), 4], [hex(A.key), 4], [hex(B.key), 3], [hex(A.key), 3], [hex(B.key), 2], [hex(A.key), 2]])
  t.alike(pages.map((p) => p.items.length), [1, 1, 1, 1, 1, 1, 0])
  for (const p of pages) {
    t.is(p.incomplete, true)
    t.is(p.diaries, 3)
    t.is(p.skipped, 1, 'the unavailable diary is skipped')
  }
  t.alike(internal, [])
})

test('regression: a detach while the own-key lookup is queued opens no link and frees the slot', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const D = await diary(t, author(assoc, 'D', [Date.now() - 1000]))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [D] })
  const keyPair = crypto.keyPair()
  // The identity is created by a first node; a second node over the same
  // storage has no cached own key, so its lookup reads the (slowed) storage.
  const base = memoryNodeStorage()
  base.close = async () => {}
  const first = await webNode(t, assoc, seeder.url, { storage: base, keyPair })
  await first.node.close()
  const storage = new Proxy(base, {
    get (target, prop) {
      if (prop === 'readJson') {
        return async (...args) => {
          await new Promise((resolve) => setTimeout(resolve, 300))
          return target.readJson(...args)
        }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  const sockets = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: seeder.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      sockets.push(ws)
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 60000 })
  const pending = errorOf(web.request('peek.read', {}))
  // The handler has queued its lookup (it is awaiting the slow storage).
  await new Promise((resolve) => setImmediate(resolve))
  web.port.close()
  t.ok(await pending, 'the detached client\'s request ended with an error')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  t.is(sockets.length, 0, 'no link was opened for the disconnected client')
  const again = await connectClient(node, { timeoutMs: 60000 })
  const page = await again.request('peek.read', {})
  t.alike(page.items.map((i) => i.author), [hex(D.key)], 'a new client peeks at once')
  t.is(sockets.length, 1)
})

// Two fork-0 histories signed by the SAME key: H1 (certified by the
// association) and H2 (certified by another one), both 13 blocks: posts at
// seqs 2..4, 7 likes, one post at the tail (seq 12). The first window
// (0, 1, 2, 5..12) yields exactly one post (seq 12; seq 2 sits below the
// floor), so with limit 1 the first two pages need no more and the second
// window (seqs 4, 3) is requested only by the page that reaches round 1:
// a later read, over a fresh link.
async function twoHistories (t, assoc, other, now) {
  const keyPair = crypto.keyPair()
  const history = (signer, label) => [
    (key) => memberCertRecord(createCert({ member: key }, signer.kp)),
    () => profileRecord({ name: label, bio: '' }),
    ...[2, 3, 4].map((seq) => () => postRecord({ text: label + ' ' + seq, at: iso(now - 10 * HOUR + seq * 1000) })),
    ...Array.from({ length: 7 }, (_, i) => (key) => likeRecord({ to: { author: key, seq: 2 }, on: i % 2 === 0, at: iso(now - HOUR + i * 1000) })),
    () => postRecord({ text: label + ' 12', at: iso(now - 9 * HOUR) })
  ]
  const H1 = await diary(t, history(assoc, 'h1'), keyPair)
  const H2 = await diary(t, history(other, 'h2'), keyPair)
  t.is(hex(H1.key), hex(H2.key), 'the same author key')
  t.is(H1.length, 13)
  t.is(H2.length, 13)
  t.is(H1.fork, 0)
  t.is(H2.fork, 0)
  const G = await diary(t, author(assoc, 'G', [now - 2 * HOUR]))
  return { H1, H2, G }
}

test('regression: a later window served from another signed history of the same key is discarded', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const other = association()
  const now = Date.now()
  const { H1, H2, G } = await twoHistories(t, assoc, other, now)
  // The mechanism: equal states hash equal, the two histories do not.
  t.ok(b4a.equals(await H1.treeHash(), await H1.treeHash(H1.length)), 'the same state hashes the same')
  t.absent(b4a.equals(await H1.treeHash(), await H2.treeHash()), 'the histories differ in their roots')

  // H1 on the first link, H2 on every later one.
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [G, H1], coresOf: (i) => (i === 0 ? [G, H1] : [G, H2]) })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const pages = await allPages(web, 1)
  t.is(seeder.connections, 2, 'the second window ran over a fresh link')
  const items = pages.flatMap((p) => p.items)
  t.absent(items.some((i) => i.text.startsWith('h2')), 'no post of the other history is ever returned')
  t.alike(items.map((i) => [i.author, i.seq, i.text, i.round]), [
    [hex(G.key), 2, 'G 1', 0],
    [hex(H1.key), 12, 'h1 12', 0]
  ], 'only what the verified first window held')
  t.alike(pages.map((p) => p.incomplete), [false, false, true], 'the page whose window was discarded is incomplete')
  t.alike(internal, [])
})

test('regression: an honest seeder still extends the window on a later link (equal length and roots accepted)', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const other = association()
  const now = Date.now()
  const { H1, G } = await twoHistories(t, assoc, other, now)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [G, H1] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const pages = await allPages(web, 1)
  t.is(seeder.connections, 2, 'the second window ran over a fresh link')
  const items = pages.flatMap((p) => p.items)
  t.alike(items.map((i) => [i.author, i.seq, i.text, i.round]), [
    [hex(G.key), 2, 'G 1', 0],
    [hex(H1.key), 12, 'h1 12', 0],
    [hex(H1.key), 4, 'h1 4', 1],
    [hex(H1.key), 3, 'h1 3', 2]
  ], 'the older posts arrived through the second window, accepted')
  t.alike(pages.map((p) => p.items.length), [1, 1, 1, 1, 0])
  for (const p of pages) t.is(p.incomplete, false, 'every page is complete')
  t.alike(internal, [])
})

// cert, profile, a post, then one raw block over MAX_BLOCK_BYTES (appended
// by the author outside the record builders, which refuse it).
function oversizedAuthor (assoc, name, at) {
  return [
    ...author(assoc, name, [at]),
    () => ({ type: 'post', text: 'x'.repeat(20000), at: iso(at + 1), replyTo: null })
  ]
}

test('regression: an oversized block ends its diary after that block and the budget bounds the bytes received', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()

  // Mixed: the oversized diaries are skipped after their oversized block,
  // the healthy ones are shown.
  const uploads = new Map() // key -> [index]
  const cores = []
  for (let i = 0; i < 6; i++) {
    const core = await diary(t, oversizedAuthor(assoc, 'O' + i, now - (i + 1) * 1000))
    core.on('upload', (index) => uploads.get(hex(core.key)).push(index))
    uploads.set(hex(core.key), [])
    cores.push(core)
  }
  const healthy = []
  for (let i = 0; i < 4; i++) healthy.push(await diary(t, author(assoc, 'H' + i, [now - (i + 10) * 1000])))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [...cores, ...healthy] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  t.alike(page.items.map((i) => i.author), healthy.map((c) => hex(c.key)), 'only the healthy diaries')
  t.is(page.diaries, 10)
  t.is(page.skipped, 6)
  t.is(page.incomplete, true)
  for (const [, served] of uploads) {
    t.ok(served.includes(0) && served.includes(3), 'block 0 and the oversized tail block were requested')
    t.absent(served.includes(1) || served.includes(2), 'nothing after the oversized block')
  }
  t.alike(internal, [])

  // Bounded: with a small budget the bytes received stay within
  // pageMaxBytes + parallel * (one block).
  let received = 0
  let largestBlock = 0
  const many = []
  for (let i = 0; i < 30; i++) {
    const core = await diary(t, oversizedAuthor(assoc, 'B' + i, now - (i + 1) * 1000))
    core.on('upload', (index, byteLength) => {
      received += byteLength
      largestBlock = Math.max(largestBlock, byteLength)
    })
    many.push(core)
  }
  const pageMaxBytes = 30000
  const parallel = 4
  const seeder2 = await fakeSeeder(t, { signer: assoc.kp, cores: many })
  const node2 = await webNode(t, assoc, seeder2.url, { peek: { pageMaxBytes, parallel } })
  const cut = await node2.web.request('peek.read', {})
  t.is(cut.incomplete, true)
  t.comment('bytes served ' + received + ', largest block ' + largestBlock)
  t.ok(largestBlock > 16384, 'the oversized block was served')
  t.ok(received <= pageMaxBytes + parallel * largestBlock, 'at most one block in flight per worker past the budget')
  t.ok(received < 30 * 2 * largestBlock, 'far from every diary')
  t.alike(node2.internal, [])
})

test('regression: a detach while a read awaits the storage frees the slot for a new client at once', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const D = await diary(t, author(assoc, 'D', [Date.now() - 1000]))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [D] })
  const base = memoryNodeStorage()
  // Every key-value read takes 300 ms: the read sits in readFollows.
  const storage = new Proxy(base, {
    get (target, prop) {
      if (prop === 'readJson') {
        return async (...args) => {
          await new Promise((resolve) => setTimeout(resolve, 300))
          return target.readJson(...args)
        }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  const { node, web, sockets } = await webNode(t, assoc, seeder.url, { storage })
  const pending = errorOf(web.request('peek.read', {}))
  await new Promise((resolve) => setImmediate(resolve))
  web.port.close()
  const again = await connectClient(node, { timeoutMs: 60000 })
  const started = Date.now()
  const page = await again.request('peek.read', {})
  t.alike(page.items.map((i) => i.author), [hex(D.key)], 'the new client\'s read ran at once')
  t.ok(Date.now() - started < 5000)
  t.ok(await pending, 'the detached client\'s read ended with an error')
  t.is(sockets.length, 1, 'only the new client opened a link')
})

test('regression: an idle snapshot is released after its TTL and the next continuation rebuilds it', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const A = await diary(t, author(assoc, 'A', [now - 1000]))
  const B = await diary(t, author(assoc, 'B', [now - 2000]))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [A, B] })
  const peeker = createPeeker({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: seeder.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    ownKey: async () => 'c'.repeat(64),
    limits: { snapshotTtlMs: 300 }
  })
  t.teardown(() => peeker.close(), { force: true })
  const first = await peeker.read({ limit: 1 })
  t.alike(first.items.map((i) => i.author), [hex(A.key)])
  t.ok(first.next !== null)
  t.is(peeker.hasSnapshot(), true, 'retained right after the read')
  t.is(seeder.connections, 1)
  await new Promise((resolve) => setTimeout(resolve, 700))
  t.is(peeker.hasSnapshot(), false, 'released by the timer with no further read')
  const second = await peeker.read({ limit: 1, after: first.next })
  t.alike(second.items.map((i) => i.author), [hex(B.key)], 'the continuation rebuilt the snapshot and went on from the cursor')
  t.is(seeder.connections, 2, 'rebuilt over a fresh link')
  t.is(peeker.hasSnapshot(), true)
  peeker.close()
  t.is(peeker.hasSnapshot(), false, 'close drops it')
})

test('regression: node.close() during a read awaiting the storage waits for it; no internal error, no access after close', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const D = await diary(t, author(assoc, 'D', [Date.now() - 1000]))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [D] })
  const base = memoryNodeStorage()
  // Every key-value read takes 300 ms (the read sits in readFollows), and
  // every storage call made after close() resolved is counted.
  let closedAt = null
  let afterClose = 0
  const storage = new Proxy(base, {
    get (target, prop) {
      const v = target[prop]
      if (typeof v !== 'function') return v
      return (...args) => {
        if (closedAt !== null) afterClose++
        if (prop === 'readJson') {
          return new Promise((resolve) => setTimeout(resolve, 300)).then(() => target.readJson(...args))
        }
        return v.apply(target, args)
      }
    }
  })
  const { node, web, internal } = await webNode(t, assoc, seeder.url, { storage })
  let settled = false
  const pending = errorOf(web.request('peek.read', {}))
  pending.then(() => { settled = true })
  await new Promise((resolve) => setImmediate(resolve))
  await node.close()
  closedAt = Date.now()
  t.is(settled, true, 'close resolved only after the read settled')
  t.ok(await pending, 'the read ended with an error')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  t.is(afterClose, 0, 'no storage access after close resolved')
  t.alike(internal, [], 'no internal error reported')
})

test('regression: a get cut by the page deadline is no verdict: the delayed diary shows on a continuation page of the same snapshot', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const A = await diary(t, author(assoc, 'A', [now - 1000]))
  const B = await diary(t, author(assoc, 'B', [now - 2000]))
  // On the first link B is served only after 2.5 s: longer than the page
  // deadline (1.5 s), shorter than the fetch timeout (10 s).
  const seeder = await fakeSeeder(t, {
    signer: assoc.kp,
    cores: [A, B],
    delayOf: (core, index) => (core === B && index === 0 ? 2500 : 0)
  })
  const { web, internal } = await webNode(t, assoc, seeder.url, { peek: { pageTimeoutMs: 1500, fetchTimeoutMs: 10000 } })
  const started = Date.now()
  const first = await web.request('peek.read', { limit: 1 })
  t.ok(Date.now() - started < 3000, 'the first page ended at its deadline')
  t.alike(first.items.map((i) => i.author), [hex(A.key)])
  t.is(first.incomplete, true)
  t.ok(first.next !== null, 'the cut page keeps a cursor')
  t.is(first.diaries, 2)
  const second = await web.request('peek.read', { limit: 1, after: first.next })
  t.alike(second.items.map((i) => i.author), [hex(B.key)], 'the delayed diary was retried on the same snapshot')
  t.is(second.incomplete, false)
  t.is(second.skipped, 0, 'B was never marked unavailable')
  t.is(seeder.connections, 2, 'the continuation fetched over a fresh link')
  t.alike(internal, [])
})
