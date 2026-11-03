// Follow notices of the browser node (lib/notices.js through lib/session.js,
// lib/node.js and an in-memory client), loopback only. The first test runs
// against the real seeder (@varanda/core lib/seeder) behind a WebSocket
// server, as peek.test.js does; the others use a seeder stand-in that speaks
// admission and 'varanda/notices/1' (attachNotices, seeder role) and serves
// hand-made candidate pages, so it can lie about follows.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, createIssuerCert, createIssuedCert, createUsernameRecord, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, profileRecords, postRecord, followRecord, deleteRecord, likeRecord, repostRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachNotices, PROTOCOL } = require('@varanda/core/lib/notices-net')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { createBrowserNode } = require('../lib/node')
const { createMember } = require('../lib/member')
const { connectSeeder } = require('../lib/seeder-link')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const { writeBlocklist, writeFollows, replicaExists, LOCKED } = require('../lib/node-store')
// The stand-in that also speaks 'varanda/notices/2' and 'varanda/notices/3'.
const { noticesSeeder: kindedSeeder } = require('./helpers/notices')

const BUSY = 'avisos já em andamento'
const NO_SEEDER = 'sem conexão com o semeador'
const UNSUPPORTED = 'aviso: o semeador ainda não envia avisos'
const HOUR = 3600000

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

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
// receives the diary key. Every block it uploads is counted in `uploads`.
async function diary (t, records) {
  const core = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  for (const make of records) await core.append(make(hex(core.key)))
  core.uploads = 0
  core.on('upload', () => { core.uploads++ })
  return core
}

function certOf (assoc) {
  return (key) => memberCertRecord(createCert({ member: key }, assoc.kp))
}

// The seeder stand-in: role 'seeder' certified by `signer`, replicating
// state.cores, an empty inventory, and (unless notices is false) the
// notices channel answering state.page(target, after, limit, noise) for the
// key the connection proved. hang(connectionIndex) -> true leaves that
// connection's pages unanswered. mute: a bare channel on the protocol that
// never challenges and drops the link 100 ms after its open (the member is
// left waiting for `proved`).
async function noticesSeeder (t, { signer, state, notices = true, hang = () => false, mute = false }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const seeder = {
    url: 'ws://127.0.0.1:' + wss.address().port + '/seeder',
    connections: 0,
    pages: [],
    async close () {
      for (const s of wss.clients) s.terminate()
      await new Promise((resolve) => wss.close(() => resolve()))
    }
  }
  t.teardown(() => seeder.close(), { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', noop)
    noise.once('connect', () => {
      const index = seeder.connections++
      Hypercore.createProtocolStream(noise)
      for (const core of state.cores) core.replicate(noise)
      if (mute) {
        // The hello first, so the member sees a verified seeder, then an
        // open with no challenge behind it.
        attachAdmission(noise, { role: 'seeder', cert, have: [] })
        const mux = noise.noiseStream.userData
        mux.pair({ protocol: PROTOCOL }, () => {
          const ch = mux.createChannel({ protocol: PROTOCOL, onopen: () => setTimeout(() => noise.destroy(), 100) })
          ch.open()
        })
        return
      }
      if (notices) {
        attachNotices(noise, {
          role: 'seeder',
          page: ({ target, after, limit }) => {
            seeder.pages.push({ target, after, limit })
            if (hang(index)) return new Promise(noop)
            return state.page(target, after, limit, noise)
          }
        })
      }
      attachAdmission(noise, { role: 'seeder', cert, have: [] })
    })
  })
  return seeder
}

// A storage that records every core opened and every kv key written while
// `recording` is set.
function spyStorage () {
  const base = memoryNodeStorage()
  const spy = { recording: false, cores: [], writes: [] }
  const storage = new Proxy(base, {
    get (target, prop) {
      if (prop === 'core') {
        return (name, opts) => {
          if (spy.recording) spy.cores.push(name)
          return target.core(name, opts)
        }
      }
      if (prop === 'writeJson') {
        return (key, value) => {
          if (spy.recording) spy.writes.push(key)
          return target.writeJson(key, value)
        }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  return { storage, spy }
}

// The web node with its client in memory, identity created (and certified
// when `certify`), the write gate off. `sockets` records every WebSocket.
async function webNode (t, assoc, url, { storage = memoryNodeStorage(), keyPair = crypto.keyPair(), certify = false, notices = {} } = {}) {
  const sockets = []
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      sockets.push(ws)
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, notices },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  if (certify) await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, storage, key: publicKey, sockets, internal }
}

function warningsOf (web) {
  return web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
}

function keysOf (r) {
  return r.notices.map((n) => n.key)
}

const HEX32 = /^[0-9a-f]{32}$/

// The page with every row's `seen` token checked (32 lowercase hex) and
// removed, so the rest of the shape compares exactly.
function withoutSeen (t, r) {
  return {
    ...r,
    notices: r.notices.map(({ seen, ...row }) => {
      t.ok(HEX32.test(seen), 'seen is 32 lowercase hex')
      return row
    })
  }
}

// The token lib/session.js computes: BLAKE2b over a domain tag, the identity
// seed and own + key + seq, first 32 hex.
function seenOf (seed, own, key, seq) {
  const digest = crypto.hash([b4a.from('varanda-notices-seen-v1\n'), seed, b4a.from(own + '\n' + key + ':' + seq)])
  return hex(digest).slice(0, 32)
}

test('against the real seeder: a verified follower shows, then follows, blocks and an unfollow remove it; nothing stored', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = association()
  const iss = issuer(assoc)
  const mod = moderator(assoc.kp)

  const seederDir = tmpDir(t, 'varanda-notices-seed-')
  Seeder.ensureConfig(seederDir, assoc.hex)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-notices-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assoc.kp)))
  Seeder.addCert(seederDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), log: noop })
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
    raw.on('error', noop)
    seeder.acceptStream(raw)
  })
  const url = 'ws://127.0.0.1:' + wss.address().port + '/seeder'

  // B: the web node, certified and served by the seeder (notices are only
  // served for a served, gated diary).
  const { storage, spy } = spyStorage()
  const B = await webNode(t, assoc, url, { storage, certify: true })
  const { runId } = await B.web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped = await stoppedOf(B.web.events, runId)
  t.is(stopped.reason, 'done', 'B pushed to the seeder')
  await until(() => { const e = seeder._served.get(B.key); return e && e.gated }, { name: 'B served', timeoutMs: 30000 })

  // A: certified, profile 'Ana', a username, then follow(B).
  const A = await createMember({ storage: memoryStorage(), association: assoc.hex })
  t.teardown(() => A.close(), { force: true })
  await A.setCert(createCert({ member: A.key }, assoc.kp))
  await A.core.append(profileRecord({ name: 'Ana', bio: '' }))
  await A.core.append(createUsernameRecord({ member: A.key, username: 'ana' }, iss.keyPair, iss.cert))
  const follow = followRecord({ key: B.key, on: true })
  await A.core.append(follow)
  const seq = A.core.length - 1
  async function push () {
    const link = connectSeeder({ member: A, socket: new WebSocket(url), association: assoc.hex, seederPublicKey: seederKey, timeoutMs: 60000 })
    t.teardown(() => link.close(), { force: true })
    await link.admitted
    await link.waitServed(A.core.length)
    link.close()
  }
  await push()

  const read = (params = {}) => B.web.request('notices.list', params)
  spy.recording = true
  const first = await until(async () => {
    const r = await read()
    return r.notices.length === 1 && !r.incomplete ? r : null
  }, { name: 'A listed', intervalMs: 250, timeoutMs: 30000 })
  t.alike(withoutSeen(t, first), { notices: [{ key: A.key, seq, at: follow.at, kind: 'follow', name: 'Ana', avatar: null, username: 'ana' }], next: null, incomplete: false, supported: true, activity: true })

  // Already followed: omitted.
  await writeFollows(storage, [A.key])
  t.alike(await read(), { notices: [], next: null, incomplete: false, supported: true, activity: true }, 'a followed diary is omitted')
  await writeFollows(storage, [])

  // Blocked in the stored blocklist: dropped, and back when unblocked.
  await writeBlocklist(storage, snapshot(mod, { blocked: [A.key] }))
  t.alike(keysOf(await read()), [], 'a blocked diary is dropped')
  await writeBlocklist(storage, snapshot(mod, { seq: 2, blocked: [] }))
  t.alike(keysOf(await read()), [A.key])

  // Nothing was stored by the reads (the test's own kv writes aside).
  const own = spy.writes.filter((k) => k !== 'follows' && k !== 'blocklist')
  // A v2 read loads this node's own-diary context, read-only.
  t.ok(spy.cores.every((name) => name === 'diary'), 'no core but the own diary was opened: ' + spy.cores.join(','))
  t.alike(own, [], 'no kv entry was written')
  t.is(await replicaExists(storage, A.key), false, 'no replica of A')
  spy.recording = false

  // A unfollows B: gone after the seeder's next scan.
  await A.core.append(followRecord({ key: B.key, on: false }))
  await push()
  const after = await until(async () => {
    const r = await read()
    return r.notices.length === 0 && !r.incomplete ? r : null
  }, { name: 'A gone', intervalMs: 250, timeoutMs: 30000 })
  t.alike(after, { notices: [], next: null, incomplete: false, supported: true, activity: true })
  t.alike(B.internal, [], 'no internal error')
})

test('a lying seeder: only author-signed follows of this node at the claimed at, with no later unfollow, are listed', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  const { web, key: me, internal } = await webNode(t, assoc, seeder.url)
  const other = hex(crypto.keyPair().publicKey)

  const good = followRecord({ key: me, on: true, at: iso(now - HOUR) })
  const G = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Gil', bio: '' }), () => good])
  const elsewhere = followRecord({ key: other, on: true, at: iso(now - 2 * HOUR) })
  const D1 = await diary(t, [certOf(assoc), () => elsewhere])
  const post = postRecord({ text: 'oi', at: iso(now - 3 * HOUR) })
  const D2 = await diary(t, [certOf(assoc), () => post])
  const off = followRecord({ key: me, on: false, at: iso(now - 4 * HOUR) })
  const D3 = await diary(t, [certOf(assoc), () => off])
  const atMismatch = followRecord({ key: me, on: true, at: iso(now - 5 * HOUR) })
  const D4 = await diary(t, [certOf(assoc), () => atMismatch])
  const early = followRecord({ key: me, on: true, at: iso(now - 7 * HOUR) })
  const D5 = await diary(t, [certOf(assoc), () => early, () => followRecord({ key: me, on: false, at: iso(now - 6 * HOUR) })])
  const D6 = await diary(t, [certOf(assoc), () => followRecord({ key: me, on: true, at: iso(now - 8 * HOUR) })])
  state.cores = [G, D1, D2, D3, D4, D5, D6]
  const items = [
    { key: hex(G.key), seq: 2, at: good.at },
    { key: hex(D1.key), seq: 1, at: elsewhere.at },
    { key: hex(D2.key), seq: 1, at: post.at },
    { key: hex(D3.key), seq: 1, at: off.at },
    { key: hex(D4.key), seq: 1, at: iso(now - 90 * 60000) }, // not the block's at
    { key: hex(D5.key), seq: 1, at: early.at }, // unfollowed at seq 2
    { key: hex(D6.key), seq: 5, at: iso(now - 9 * HOUR) } // past the signed length
  ]
  state.page = (target) => ({ items: target === me ? items : [], next: null, incomplete: false })

  const r = await web.request('notices.list', {})
  t.alike(withoutSeen(t, r), { notices: [{ key: hex(G.key), seq: 2, at: good.at, kind: 'follow', name: 'Gil', avatar: null, username: null }], next: null, incomplete: false, supported: true, activity: false })
  t.is(seeder.pages.length, 1)
  t.alike(seeder.pages[0], { target: me, after: null, limit: 64 }, 'the proved key, the first page')
  t.alike(internal, [])
})

test('cursor: the page is cut at limit and next continues after the last returned row', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  const { web, key: me, internal } = await webNode(t, assoc, seeder.url)
  const rows = []
  for (let i = 0; i < 3; i++) {
    const f = followRecord({ key: me, on: true, at: iso(now - (i + 1) * HOUR) })
    const d = await diary(t, [certOf(assoc), () => f])
    state.cores.push(d)
    rows.push({ key: hex(d.key), seq: 1, at: f.at })
  }
  state.page = (target, after) => {
    const from = after === null ? 0 : rows.findIndex((r) => r.key === after.key) + 1
    return { items: rows.slice(from), next: null, incomplete: false }
  }
  const p1 = await web.request('notices.list', { limit: 2 })
  t.alike(keysOf(p1), [rows[0].key, rows[1].key])
  t.alike(p1.next, { at: rows[1].at, key: rows[1].key })
  const p2 = await web.request('notices.list', { limit: 2, after: p1.next })
  t.alike(keysOf(p2), [rows[2].key])
  t.is(p2.next, null)
  t.alike(seeder.pages[1].after, p1.next, 'the cursor reached the seeder')
  t.alike(internal, [])
})

test('a gap of 512 filtered candidates: an empty page with a cursor, and the follower behind it comes from the next page', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  const { web, key: me, storage, internal } = await webNode(t, assoc, seeder.url)
  // 512 followers already followed (8 seeder pages of 64), then D.
  const followed = []
  for (let i = 0; i < 512; i++) followed.push(hex(crypto.randomBytes(32)))
  await writeFollows(storage, followed)
  const f = followRecord({ key: me, on: true, at: iso(now - 600 * HOUR) })
  const D = await diary(t, [certOf(assoc), () => f])
  state.cores = [D]
  const rows = followed.map((key, i) => ({ key, seq: 1, at: iso(now - (i + 1) * HOUR) }))
  rows.push({ key: hex(D.key), seq: 1, at: f.at })
  state.page = (target, after, limit) => {
    const from = after === null ? 0 : rows.findIndex((r) => r.key === after.key) + 1
    const items = rows.slice(from, from + limit)
    const last = items[items.length - 1]
    return { items, next: from + limit < rows.length ? { at: last.at, key: last.key } : null, incomplete: false }
  }

  const p1 = await web.request('notices.list', {})
  t.alike(p1, { notices: [], next: { at: rows[511].at, key: rows[511].key }, incomplete: true, supported: true, activity: false }, 'empty, with the cursor past the gap')
  t.is(seeder.pages.length, 8, 'eight pages per read')
  t.is(D.uploads, 0, 'D was not reached')
  const p2 = await web.request('notices.list', { after: p1.next })
  t.alike(keysOf(p2), [hex(D.key)], 'the follower behind the gap')
  t.is(p2.next, null)
  t.is(p2.incomplete, false)
  t.is(seeder.pages.length, 9)
  t.alike(seeder.pages[8].after, p1.next, 'read from the cursor')
  t.alike(internal, [])
})

test('seen: an opaque token keyed by the identity secret, stable across reads, distinct per row and per identity', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  const keyPair = crypto.keyPair()
  const seed = b4a.from(keyPair.secretKey.subarray(0, 32)) // copied: a lock zeroes the pair
  const { web, key: me, internal } = await webNode(t, assoc, seeder.url, { keyPair })
  const fd = followRecord({ key: me, on: true, at: iso(now - HOUR) })
  const D = await diary(t, [certOf(assoc), () => fd])
  const fe = followRecord({ key: me, on: true, at: iso(now - 2 * HOUR) })
  const E = await diary(t, [certOf(assoc), () => postRecord({ text: 'oi', at: iso(now - 3 * HOUR) }), () => fe])
  state.cores = [D, E]
  state.page = () => ({ items: [{ key: hex(D.key), seq: 1, at: fd.at }, { key: hex(E.key), seq: 2, at: fe.at }], next: null, incomplete: false })

  const first = await web.request('notices.list', {})
  t.alike(keysOf(first), [hex(D.key), hex(E.key)])
  const [d, e] = first.notices
  for (const row of first.notices) {
    t.ok(HEX32.test(row.seen), 'seen is 32 lowercase hex')
    t.absent(row.key.includes(row.seen), 'the token is not a slice of the follower key')
    t.absent(row.seen.includes(row.key.slice(0, 8)), 'the token does not carry the follower key')
  }
  t.not(d.seen, e.seen, 'another (key, seq) gives another token')
  t.is(d.seen, seenOf(seed, me, d.key, 1), 'keyed by the identity secret')
  t.is(e.seen, seenOf(seed, me, e.key, 2))
  t.not(d.seen, seenOf(seed, me, d.key, 2), 'another seq gives another token')
  const other = crypto.keyPair()
  t.not(d.seen, seenOf(other.secretKey.subarray(0, 32), hex(other.publicKey), d.key, 1), 'another identity gives another token')
  t.not(d.seen, seenOf(other.secretKey.subarray(0, 32), me, d.key, 1), 'another secret gives another token for the same row')

  const second = await web.request('notices.list', {})
  t.alike(second.notices.map((n) => n.seen), [d.seen, e.seen], 'the same identity gets the same tokens on a later read')
  t.alike(internal, [])
})

test('a lock during a read aborts it and frees the slot; while locked no socket is opened', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  // The first connection's pages are never answered.
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state, hang: (i) => i === 0 })
  const keyPair = crypto.keyPair()
  const { node, web, key: me, sockets, internal } = await webNode(t, assoc, seeder.url, { keyPair })
  const f = followRecord({ key: me, on: true, at: iso(now - HOUR) })
  const D = await diary(t, [certOf(assoc), () => f])
  state.cores = [D]
  state.page = () => ({ items: [{ key: hex(D.key), seq: 1, at: f.at }], next: null, incomplete: false })

  const first = errorOf(web.request('notices.list', {}))
  await until(() => seeder.pages.length === 1, { name: 'first page asked' })
  await node.clearKeyPair()
  const err = await first
  t.is(err && err.code, 'USAGE')
  t.is(err && err.message, NO_SEEDER, 'the read in flight was aborted')
  await until(() => sockets[0].readyState === WebSocket.CLOSED, { name: 'link closed' })

  const locked = await errorOf(web.request('notices.list', {}))
  t.is(locked && locked.code, 'USAGE')
  t.is(locked && locked.message, LOCKED)
  t.is(sockets.length, 1, 'nothing was opened while locked')
  t.is(seeder.pages.length, 1)

  await node.setKeyPair(keyPair)
  const r = await web.request('notices.list', {})
  t.alike(keysOf(r), [hex(D.key)], 'the slot is free after the unlock')
  t.is(sockets.length, 2)
  t.alike(internal, [])
})

test('a link lost after the hello fails the read with USAGE sem conexão, never a partial success', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()

  // Waiting for `proved`: the seeder opens the channel and drops the link.
  {
    const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
    const seeder = await noticesSeeder(t, { signer: assoc.kp, state, mute: true })
    const { web, sockets, internal } = await webNode(t, assoc, seeder.url)
    const err = await errorOf(web.request('notices.list', {}))
    t.is(err && err.code, 'USAGE', 'proved')
    t.is(err && err.message, NO_SEEDER, 'proved')
    t.is(sockets.length, 1)
    t.alike(internal, [])
  }

  // During a page request: the seeder drops the link instead of answering.
  {
    const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
    const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
    const { web, internal } = await webNode(t, assoc, seeder.url)
    state.page = (target, after, limit, noise) => {
      noise.destroy()
      return new Promise(noop)
    }
    const err = await errorOf(web.request('notices.list', {}))
    t.is(err && err.code, 'USAGE', 'page')
    t.is(err && err.message, NO_SEEDER, 'page')
    t.is(seeder.pages.length, 1)
    t.alike(internal, [])
  }

  // Mid block fetch: a page names a diary the seeder never serves, then the
  // link drops while its block 0 is awaited.
  {
    const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
    const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
    const { web, key: me, internal } = await webNode(t, assoc, seeder.url)
    const f = followRecord({ key: me, on: true, at: iso(now - HOUR) })
    const D = await diary(t, [certOf(assoc), () => f])
    state.page = (target, after, limit, noise) => {
      setTimeout(() => noise.destroy(), 300)
      return { items: [{ key: hex(D.key), seq: 1, at: f.at }], next: null, incomplete: false }
    }
    const err = await errorOf(web.request('notices.list', {}))
    t.is(err && err.code, 'USAGE', 'block')
    t.is(err && err.message, NO_SEEDER, 'block')
    t.is(seeder.pages.length, 1)
    t.alike(internal, [])
  }
})

test('an issuer revoked after a first read: the cached rows are re-judged without refetching', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const iss = issuer(assoc)
  const now = Date.now()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  const { web, key: me, storage, internal } = await webNode(t, assoc, seeder.url)

  // U: v1-certified, username by the issuer. V: certified BY the issuer (v2).
  const fu = followRecord({ key: me, on: true, at: iso(now - HOUR) })
  const U = await diary(t, [
    certOf(assoc),
    () => profileRecord({ name: 'U', bio: '' }),
    (key) => createUsernameRecord({ member: key, username: 'ulisses' }, iss.keyPair, iss.cert),
    () => fu
  ])
  const fv = followRecord({ key: me, on: true, at: iso(now - 2 * HOUR) })
  const V = await diary(t, [
    (key) => memberCertRecord(createIssuedCert({ member: key }, iss.keyPair, iss.cert)),
    () => profileRecord({ name: 'V', bio: '' }),
    () => fv
  ])
  state.cores = [U, V]
  state.page = () => ({ items: [{ key: hex(U.key), seq: 3, at: fu.at }, { key: hex(V.key), seq: 2, at: fv.at }], next: null, incomplete: false })

  const first = await web.request('notices.list', {})
  t.alike(first.notices.map((n) => [n.key, n.name, n.username]), [[hex(U.key), 'U', 'ulisses'], [hex(V.key), 'V', null]])
  const uploads = U.uploads + V.uploads
  t.ok(uploads > 0, 'the first read fetched blocks')

  await writeBlocklist(storage, snapshot(mod, { revokedIssuers: [iss.hex] }))
  const second = await web.request('notices.list', {})
  t.alike(second.notices.map((n) => [n.key, n.username]), [[hex(U.key), null]], 'V dropped, U without its username')
  t.is(second.incomplete, false)
  t.is(U.uploads + V.uploads, uploads, 'no block was fetched again')
  t.alike(internal, [])
})

test('a locked node gets USAGE identidade bloqueada', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  const { node, web, internal } = await webNode(t, assoc, seeder.url)
  await node.clearKeyPair()
  const err = await errorOf(web.request('notices.list', {}))
  t.is(err && err.code, 'USAGE')
  t.is(err && err.message, LOCKED)
  t.is(seeder.pages.length, 0, 'no page was asked without a proof')
  t.alike(internal, [])
})

test('a seeder that does not speak the channel: supported false, one warning', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state, notices: false })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const expected = { notices: [], next: null, incomplete: false, supported: false, activity: true }
  t.alike(await web.request('notices.list', {}), expected)
  t.alike(await web.request('notices.list', {}), expected)
  t.is(warningsOf(web).filter((l) => l === UNSUPPORTED).length, 1, 'warned once')
  t.alike(internal, [])
})

test('a concurrent notices.list is refused; a detach aborts the read and frees the slot', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  // The first connection's pages are never answered.
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state, hang: (i) => i === 0 })
  const { node, web, key: me, sockets, internal } = await webNode(t, assoc, seeder.url)
  const f = followRecord({ key: me, on: true, at: iso(now - HOUR) })
  const D = await diary(t, [certOf(assoc), () => f])
  state.cores = [D]
  state.page = () => ({ items: [{ key: hex(D.key), seq: 1, at: f.at }], next: null, incomplete: false })

  const first = errorOf(web.request('notices.list', {}))
  await until(() => seeder.pages.length === 1, { name: 'first page asked' })
  const second = await errorOf(web.request('notices.list', {}))
  t.is(second && second.code, 'USAGE')
  t.is(second && second.message, BUSY)
  t.is(sockets.length, 1, 'the refused call opened nothing')

  web.port.close()
  t.ok(await first, 'the detached read ended with an error')
  await until(() => sockets[0].readyState === WebSocket.CLOSED, { name: 'link closed' })

  const again = await connectClient(node, { timeoutMs: 60000 })
  const r = await again.request('notices.list', {})
  t.alike(keysOf(r), [hex(D.key)], 'a new client reads at once')
  t.alike(internal, [])
})

test('avatar: notices carry the retained profile and preserve the block 2 name when the pair is outside the window', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  const { web, key: me, internal } = await webNode(t, assoc, seeder.url)
  const avatar = { core: 'dd'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 10, sha256: 'ee'.repeat(32), width: 512, height: 512 }
  const pair = profileRecords({ name: 'New name', avatar })
  const follow = followRecord({ key: me, on: true })
  const olderFollow = followRecord({ key: me, on: true, at: iso(Date.parse(follow.at) - 1000) })
  const retained = await diary(t, [certOf(assoc), ...pair.map((record) => () => record), () => follow])
  const outside = await diary(t, [
    certOf(assoc),
    () => postRecord({ text: 'old' }),
    () => profileRecord({ name: 'Block 2', bio: '' }),
    ...pair.map((record) => () => record),
    ...Array.from({ length: 14 }, () => () => postRecord({ text: 'oi' })),
    () => olderFollow
  ])
  state.cores = [retained, outside]
  const items = state.cores.map((core, i) => ({ key: hex(core.key), seq: core.length - 1, at: i === 0 ? follow.at : olderFollow.at }))
  state.page = () => ({ items, next: null, incomplete: false })
  const expected = {
    notices: items.map((item, i) => ({ ...item, kind: 'follow', name: i === 0 ? 'New name' : 'Block 2', avatar: i === 0 ? avatar : null, username: null })),
    next: null,
    incomplete: false,
    supported: true,
    activity: false
  }
  const first = await web.request('notices.list', {})
  t.alike(withoutSeen(t, first), expected)
  const uploads = state.cores.map((core) => core.uploads)
  first.notices[0].avatar.start = 99
  t.alike(withoutSeen(t, await web.request('notices.list', {})), expected, 'cached evidence produces a fresh avatar')
  t.alike(state.cores.map((core) => core.uploads), uploads, 'the second read uses cached evidence')
  t.alike(internal, [])
})

test('regression: a head tombstone that times out never lets the profile it deletes name the row, and is never cached', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  const { web, key: me, internal } = await webNode(t, assoc, seeder.url, { notices: { blockTimeoutMs: 1000 } })
  const follow = followRecord({ key: me, on: true })
  const A = await diary(t, [
    certOf(assoc),
    () => profileRecord({ name: 'Antigo', bio: '' }),
    () => deleteRecord({ seq: 1 }),
    () => follow
  ])
  // The seeder no longer holds the tombstone: its get times out.
  await A.clear(2)
  state.cores = [A]
  state.page = () => ({ items: [{ key: hex(A.key), seq: 3, at: follow.at }], next: null, incomplete: false })
  const first = await web.request('notices.list', {})
  t.alike(first.notices.map((n) => [n.key, n.name]), [[hex(A.key), null]], 'the row stands without the deleted profile')
  t.is(first.incomplete, true, 'the unread head block leaves the read incomplete')
  const uploads = A.uploads
  const second = await web.request('notices.list', {})
  t.alike(second.notices.map((n) => [n.key, n.name]), [[hex(A.key), null]])
  t.ok(A.uploads > uploads, 'the evidence was not cached: the second read fetched again')
  t.alike(internal, [])
})

function order (a, b) {
  return (Date.parse(b.at) - Date.parse(a.at)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (b.seq - a.seq)
}

function empty () {
  return { items: [], next: null, incomplete: false }
}

// A v2 / v3 page callback over `items` for `target` only, in notices order,
// continuing strictly after the cursor.
function kindedPages (target, items) {
  const sorted = [...items].sort(order)
  return (t, after, limit) => {
    if (t !== target) return empty()
    const from = after === null ? 0 : sorted.findIndex((it) => order(it, after) > 0)
    const page = from < 0 ? [] : sorted.slice(from, from + limit)
    const last = page[page.length - 1]
    const next = from >= 0 && from + limit < sorted.length ? { at: last.at, key: last.key, seq: last.seq } : null
    return { items: page, next, incomplete: false }
  }
}

test('v3: likes and reposts of own posts are rows naming the post; foreign, off, shifted, toggled and forged ones drop', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const seeder = await kindedSeeder(t, { signer: assoc.kp, state })
  const keyPair = crypto.keyPair()
  const seed = b4a.from(keyPair.secretKey.subarray(0, 32)) // copied: a lock zeroes the pair
  const { web, key: me, internal } = await webNode(t, assoc, seeder.url, { keyPair, certify: true })
  const p1 = await web.request('post.create', { text: 'primeiro' })
  const p2 = await web.request('post.create', { text: 'segundo' })
  const to1 = { author: me, seq: p1.seq }
  const to2 = { author: me, seq: p2.seq }
  const other = hex(crypto.keyPair().publicKey)
  const at = (h) => iso(now - h * HOUR)

  const like = likeRecord({ to: to1, on: true, at: at(1) })
  const L = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Lia', bio: '' }), () => like])
  const repost = repostRecord({ to: to2, on: true, at: at(2) })
  const P = await diary(t, [certOf(assoc), () => repost])
  const notPost = likeRecord({ to: { author: me, seq: 999 }, on: true, at: at(3) })
  const X = await diary(t, [certOf(assoc), () => notPost])
  const off = likeRecord({ to: to1, on: false, at: at(4) })
  const O = await diary(t, [certOf(assoc), () => off])
  const shifted = likeRecord({ to: to1, on: true, at: at(5) })
  const M = await diary(t, [certOf(assoc), () => shifted])
  const unliked = likeRecord({ to: to1, on: true, at: at(8) })
  const U = await diary(t, [certOf(assoc), () => unliked, () => likeRecord({ to: to1, on: false, at: at(7) })])
  const reply = postRecord({ text: 'resposta', replyTo: to1, at: at(9) })
  const R = await diary(t, [certOf(assoc), () => reply])
  const hintedReply = likeRecord({ to: to2, on: true, at: at(10) })
  const K = await diary(t, [certOf(assoc), () => hintedReply])
  const plain = postRecord({ text: 'nada a ver', at: at(11) })
  const Z = await diary(t, [certOf(assoc), () => plain])
  const foreign = likeRecord({ to: { author: other, seq: p1.seq }, on: true, at: at(12) })
  const F = await diary(t, [certOf(assoc), () => foreign])
  const older = likeRecord({ to: to2, on: true, at: at(14) })
  const newer = likeRecord({ to: to2, on: true, at: at(13) })
  const V = await diary(t, [certOf(assoc), () => older, () => newer])
  state.cores = [L, P, X, O, M, U, R, K, Z, F, V]
  state.pageV3 = kindedPages(me, [
    { key: hex(L.key), seq: 2, at: like.at, kind: 'like' },
    { key: hex(P.key), seq: 1, at: repost.at, kind: 'repost' },
    { key: hex(X.key), seq: 1, at: notPost.at, kind: 'like' }, // not an own post
    { key: hex(O.key), seq: 1, at: off.at, kind: 'like' },
    { key: hex(M.key), seq: 1, at: at(6), kind: 'like' }, // not the block's at
    { key: hex(U.key), seq: 1, at: unliked.at, kind: 'like' }, // unliked at seq 2
    { key: hex(R.key), seq: 1, at: reply.at, kind: 'like' }, // the hint lies: a reply
    { key: hex(K.key), seq: 1, at: hintedReply.at, kind: 'reply' }, // the hint lies: a like
    { key: hex(Z.key), seq: 1, at: plain.at, kind: 'like' },
    { key: hex(F.key), seq: 1, at: foreign.at, kind: 'like' }, // another diary's post
    { key: hex(V.key), seq: 2, at: newer.at, kind: 'like' },
    { key: hex(V.key), seq: 1, at: older.at, kind: 'like' }, // liked again at seq 2
    { key: me, seq: 1, at: at(15), kind: 'like' } // a self-like
  ])

  const r = await web.request('notices.list', {})
  t.alike(withoutSeen(t, r), {
    notices: [
      { key: hex(L.key), seq: 2, at: like.at, kind: 'like', name: 'Lia', avatar: null, username: null, post: me + ':' + p1.seq },
      { key: hex(P.key), seq: 1, at: repost.at, kind: 'repost', name: null, avatar: null, username: null, post: me + ':' + p2.seq },
      { key: hex(R.key), seq: 1, at: reply.at, kind: 'reply', name: null, avatar: null, username: null },
      { key: hex(K.key), seq: 1, at: hintedReply.at, kind: 'like', name: null, avatar: null, username: null, post: me + ':' + p2.seq },
      { key: hex(V.key), seq: 2, at: newer.at, kind: 'like', name: null, avatar: null, username: null, post: me + ':' + p2.seq }
    ],
    next: null,
    incomplete: false,
    supported: true,
    activity: true
  })
  t.is(r.notices[0].seen, seenOf(seed, me, hex(L.key), 2), 'seen is the token of (own, key, seq)')
  t.is(seeder.pagesV2.length, 0, 'the v2 channel was not read')
  t.is(seeder.pages.length, 0, 'the v1 channel was not read')
  t.alike(seeder.pagesV3[0], { target: me, after: null, limit: 64 })
  const cached = await web.request('notices.list', {})
  t.alike(cached.notices.map((n) => [n.key, n.seq, n.kind]), r.notices.map((n) => [n.key, n.seq, n.kind]), 'the kinds come back the same from cached facts')
  t.alike(internal, [])
})

test('v3: one row per author, post and kind, the higher seq, when the tail is not read', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const seeder = await kindedSeeder(t, { signer: assoc.kp, state })
  // Block 0 and `seq` only: no tail, so no later toggle is seen.
  const { web, key: me, internal } = await webNode(t, assoc, seeder.url, { certify: true, notices: { maxBlocksPerRow: 2 } })
  const p1 = await web.request('post.create', { text: 'primeiro' })
  const to = { author: me, seq: p1.seq }
  const a = likeRecord({ to, on: true, at: iso(now - 3 * HOUR) })
  const b = likeRecord({ to, on: true, at: iso(now - 2 * HOUR) })
  const c = repostRecord({ to, on: true, at: iso(now - HOUR) })
  const D = await diary(t, [certOf(assoc), () => a, () => b, () => c])
  state.cores = [D]
  state.pageV3 = kindedPages(me, [
    { key: hex(D.key), seq: 1, at: a.at, kind: 'like' },
    { key: hex(D.key), seq: 2, at: b.at, kind: 'like' },
    { key: hex(D.key), seq: 3, at: c.at, kind: 'repost' }
  ])
  const r = await web.request('notices.list', {})
  t.alike(r.notices.map((n) => [n.seq, n.kind, n.post]), [[3, 'repost', me + ':' + p1.seq], [2, 'like', me + ':' + p1.seq]])
  t.alike(internal, [])
})

test('a seeder that rejects v3 is read over v2 at once (no likes, activity true), and one that takes neither over v1', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  // A long request timeout: a fallback that waited it out would show.
  const notices = { requestTimeoutMs: 20000 }

  for (const v2 of [true, false]) {
    const state = { cores: [], page: empty }
    if (v2) state.pageV2 = empty
    const seeder = await kindedSeeder(t, { signer: assoc.kp, state })
    const { web, key: me, internal } = await webNode(t, assoc, seeder.url, { certify: true, notices })
    const p1 = await web.request('post.create', { text: 'primeiro' })
    const f = followRecord({ key: me, on: true, at: iso(now - HOUR) })
    const Fo = await diary(t, [certOf(assoc), () => f])
    const like = likeRecord({ to: { author: me, seq: p1.seq }, on: true, at: iso(now - 2 * HOUR) })
    const K = await diary(t, [certOf(assoc), () => like])
    state.cores = [Fo, K]
    const items = [
      { key: hex(Fo.key), seq: 1, at: f.at, kind: 'follow' },
      { key: hex(K.key), seq: 1, at: like.at, kind: 'reply' } // a like block under a v2 kind
    ]
    if (v2) state.pageV2 = kindedPages(me, items)
    else state.page = (target) => target === me ? { items: items.map(({ kind, ...it }) => it), next: null, incomplete: false } : empty()

    const started = Date.now()
    const r = await web.request('notices.list', {})
    t.ok(Date.now() - started < 10000, 'the rejected channels were not waited for')
    t.alike(withoutSeen(t, r), {
      notices: [{ key: hex(Fo.key), seq: 1, at: f.at, kind: 'follow', name: null, avatar: null, username: null }],
      next: null,
      incomplete: false,
      supported: true,
      activity: v2
    }, v2 ? 'v2: the like is dropped' : 'v1: follows only')
    t.is(seeder.pagesV3.length, 0)
    t.is(seeder.pagesV2.length, v2 ? 1 : 0)
    t.is(seeder.pages.length, v2 ? 0 : 1)
    t.alike(internal, [])
  }
})

test('a silent v3 is waited for, then v2 is read', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty }
  const seeder = await kindedSeeder(t, { signer: assoc.kp, state, v3Silent: true })
  const { web, key: me, internal } = await webNode(t, assoc, seeder.url, { notices: { requestTimeoutMs: 1000 } })
  const f = followRecord({ key: me, on: true, at: iso(now - HOUR) })
  const Fo = await diary(t, [certOf(assoc), () => f])
  state.cores = [Fo]
  state.pageV2 = kindedPages(me, [{ key: hex(Fo.key), seq: 1, at: f.at, kind: 'follow' }])
  const r = await web.request('notices.list', {})
  t.alike(keysOf(r), [hex(Fo.key)])
  t.is(r.activity, true)
  t.is(seeder.pagesV2.length, 1)
  t.alike(internal, [])
})

test('a v2 page carrying kind like is never delivered', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty }
  const seeder = await kindedSeeder(t, { signer: assoc.kp, state })
  const { web, key: me, internal } = await webNode(t, assoc, seeder.url, { certify: true, notices: { requestTimeoutMs: 1000 } })
  const p1 = await web.request('post.create', { text: 'primeiro' })
  const like = likeRecord({ to: { author: me, seq: p1.seq }, on: true, at: iso(now - HOUR) })
  const K = await diary(t, [certOf(assoc), () => like])
  state.cores = [K]
  state.pageV2 = kindedPages(me, [{ key: hex(K.key), seq: 1, at: like.at, kind: 'like' }])
  const r = await web.request('notices.list', {})
  t.alike(r, { notices: [], next: null, incomplete: true, supported: true, activity: true })
  t.is(seeder.pagesV2.length, 1, 'asked, never answered')
  t.alike(internal, [])
})
