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
const { memberCertRecord, profileRecord, postRecord, followRecord } = require('@varanda/core/lib/records')
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
  t.alike(withoutSeen(t, first), { notices: [{ key: A.key, seq, at: follow.at, name: 'Ana', username: 'ana' }], next: null, incomplete: false, supported: true })

  // Already followed: omitted.
  await writeFollows(storage, [A.key])
  t.alike(await read(), { notices: [], next: null, incomplete: false, supported: true }, 'a followed diary is omitted')
  await writeFollows(storage, [])

  // Blocked in the stored blocklist: dropped, and back when unblocked.
  await writeBlocklist(storage, snapshot(mod, { blocked: [A.key] }))
  t.alike(keysOf(await read()), [], 'a blocked diary is dropped')
  await writeBlocklist(storage, snapshot(mod, { seq: 2, blocked: [] }))
  t.alike(keysOf(await read()), [A.key])

  // Nothing was stored by the reads (the test's own kv writes aside).
  const own = spy.writes.filter((k) => k !== 'follows' && k !== 'blocklist')
  t.alike(spy.cores, [], 'no core of the node storage was opened')
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
  t.alike(after, { notices: [], next: null, incomplete: false, supported: true })
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
  t.alike(withoutSeen(t, r), { notices: [{ key: hex(G.key), seq: 2, at: good.at, name: 'Gil', username: null }], next: null, incomplete: false, supported: true })
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
  t.alike(p1, { notices: [], next: { at: rows[511].at, key: rows[511].key }, incomplete: true, supported: true }, 'empty, with the cursor past the gap')
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
  const expected = { notices: [], next: null, incomplete: false, supported: false }
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
