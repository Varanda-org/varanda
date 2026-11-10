'use strict'

// The seeder side of 'varanda/discovery/1' (docs/protocol.md "Discovery
// channel"): pages of the served inventory cut from frozen views, the lean
// hello for a member that asks for no inventory, the full inventory for a
// member from before discovery, and `discovery: false` as the rollback.
// Members connect over loopback TCP through acceptStream; the seeder's swarm
// uses the local testnet only.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder, DISCOVERY_REBUILD_MS, DISCOVERY_VIEWS_KEPT, DISCOVERY_VIEW_TTL_MS } = require('../lib/seeder')

// Views are rebuilt every REBUILD_MS here (the default is far longer), so a
// new order shows within a test's patience.
const REBUILD_MS = 200
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('../lib/cert')
const { attachAdmission, generateNoiseKeyPair, CAP_NO_INVENTORY, CAP_DISCOVERY } = require('../lib/net')
const { attachDiscovery } = require('../lib/discovery-net')
const { createSnapshot } = require('../lib/blocklist')
const { writeBlocklist } = require('../lib/store')
const { memberCertRecord, postRecord, repostRecord } = require('../lib/records')

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function prepareSeederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return { dataDir, publicKey }
}

async function startSeeder (t, bootstrap, dataDir, opts = {}) {
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), ...opts })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events }
}

// A loopback TCP server whose connections go to the seeder's acceptStream;
// `holder.current` may be swapped after a restart. Its sockets are
// destroyed at teardown (a closed seeder leaves the raw socket open).
async function streamServer (t, holder) {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    holder.current.acceptStream(socket)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy()
    server.close(() => resolve())
  }), { force: true })
  return server.address().port
}

// One store holding several diaries: each is [member cert] plus one post
// at T0 + i minutes, unless posts[i] is 0 (certificate only).
async function authorStore (t, assoc, posts) {
  const store = new Corestore(tmpDir(t, 'varanda-author-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diaries = []
  for (let i = 0; i < posts.length; i++) {
    const core = store.get({ name: 'diary-' + i, valueEncoding: 'json' })
    await core.ready()
    const key = hex(core.key)
    await core.append(memberCertRecord(createCert({ member: key }, assoc.kp)))
    if (posts[i] > 0) await core.append(postRecord({ text: 'oi ' + i, at: new Date(T0 + posts[i] * 60000).toISOString() }))
    diaries.push({ core, key })
  }
  return { store, diaries }
}

// A member over the external transport: admission (with `caps`), and the
// discovery channel unless `discovery` is false. With `store` its cores
// replicate, so it can announce them.
async function connectMember (t, port, { store = null, caps = 0, discovery = true } = {}) {
  const tcp = net.connect(port, '127.0.0.1')
  tcp.on('error', () => {})
  t.teardown(() => tcp.destroy(), { force: true })
  const noise = new NoiseSecretStream(true, tcp, { keyPair: generateNoiseKeyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  await new Promise((resolve, reject) => {
    noise.once('close', () => reject(new Error('stream fechado antes do handshake')))
    noise.once('connect', resolve)
  })
  if (store) store.replicate(noise)
  else {
    const scratch = new Corestore(tmpDir(t, 'varanda-reader-'))
    await scratch.ready()
    t.teardown(() => scratch.close(), { force: true })
    scratch.replicate(noise)
  }
  const disc = discovery ? attachDiscovery(noise, { role: 'member' }) : null
  const messages = []
  const peer = attachAdmission(noise, { role: 'member', have: [], caps, onmessage: (msg) => messages.push(msg) })
  const message = (pred, name) => until(() => messages.find(pred), { name, timeoutMs: 30000 })
  return { noise, peer, disc, messages, message }
}

async function announceAll (assoc, member, diaries) {
  for (const { key } of diaries) {
    member.peer.send({ type: 'announce', key, cert: createCert({ member: key }, assoc.kp) })
  }
  for (const { key } of diaries) {
    await member.message((m) => m.type === 'admitted' && m.key === key, 'admitted ' + key.slice(0, 8))
  }
}

// Every page of one traversal, following the view, straight on the seeder.
function traverse (seeder, limit) {
  const keys = []
  let after = null
  let view = null
  for (let i = 0; i < 100; i++) {
    const page = seeder.discoveryPage({ after, limit, view })
    if (page.stale) return { stale: true, keys }
    view = page.view
    for (const it of page.items) keys.push(it.key)
    if (page.next === null) return { view, keys, total: page.total }
    after = page.next
  }
  throw new Error('traversal did not end')
}

test('pages cover every eligible diary once in recentAt order; lean and legacy hellos', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const holder = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, discoveryRebuildMs: REBUILD_MS })
  const { seeder } = holder
  const port = await streamServer(t, { current: seeder })

  // Minutes after T0 of each diary's post; the last is certificate only.
  const author = await authorStore(t, assoc, [3, 1, 5, 2, 4, 0])
  const lean = await connectMember(t, port, { store: author.store, caps: CAP_NO_INVENTORY })
  const hello = await lean.peer.hello
  t.is(hello.role, 'seeder')
  t.is(hello.count, 0, 'a lean member gets count 0')
  t.alike(hello.have, [])
  t.ok(lean.peer.remoteCaps & CAP_DISCOVERY, 'the seeder offers discovery')
  t.ok(await lean.disc.supported, 'the discovery channel opens')

  await announceAll(assoc, lean, author.diaries)
  const k = author.diaries.map((d) => d.key)
  const expected = [k[2], k[4], k[0], k[3], k[1]]
  await until(() => {
    const r = traverse(seeder, 64)
    return r.keys.length === 5 && r.keys.every((key, i) => key === expected[i])
  }, { name: 'five eligible diaries in recentAt order', timeoutMs: 30000 })
  t.absent(lean.messages.some((m) => m.type === 'have'), 'no inventory reaches a lean member')

  // Over the wire, two per page: every diary exactly once, newest first;
  // the certificate-only diary (present 1) is never offered.
  const read = await lean.disc.read({ limit: 2 })
  t.is(read.complete, true)
  t.is(read.total, 5)
  t.alike(read.items.map((it) => it.key), expected)
  t.ok(read.items.every((it) => it.length === 2), 'lengths are present lengths')
  t.absent(read.items.some((it) => it.key === k[5]))

  // A member from before discovery (no caps, no channel) gets the full
  // inventory, every served diary included.
  const legacy = await connectMember(t, port, { discovery: false })
  const legacyHello = await legacy.peer.hello
  t.is(legacyHello.count, 6, 'a legacy member gets the full inventory')
  t.alike(legacyHello.have.map((e) => e.key).sort(), [...k].sort())

  // Frozen view: page 1, then the oldest diary posts (and k[3] reposts it).
  // The traversal that started before still serves every diary exactly once
  // and in the old order.
  const page1 = await lean.disc.page({ after: null, limit: 2 })
  t.alike(page1.items.map((it) => it.key), expected.slice(0, 2))
  const before1 = seeder._served.get(k[1]).recentAt
  const before3 = seeder._served.get(k[3]).recentAt
  await author.diaries[1].core.append(postRecord({ text: 'de novo' }))
  await author.diaries[3].core.append(repostRecord({ to: { author: k[1], seq: 1 }, on: true }))
  await until(() => seeder._served.get(k[1]).recentAt > before1 && seeder._served.get(k[3]).recentAt > before3, { name: 'the new post and repost are indexed', timeoutMs: 30000 })
  // A first page in between builds a new view; the old one is still kept.
  await until(() => seeder.discoveryPage({ after: null, limit: 1 }).items[0].key !== expected[0], {
    name: 'the new order within ' + REBUILD_MS + ' ms of the index',
    timeoutMs: 30 * REBUILD_MS
  })
  const rest = []
  let after = page1.next
  while (after !== null) {
    const p = await lean.disc.page({ after, limit: 2, view: page1.view })
    t.absent(p.stale, 'the old view is still served')
    t.is(p.view, page1.view)
    t.is(p.total, 5)
    rest.push(...p.items.map((it) => it.key))
    after = p.next
  }
  const traversal = [...page1.items.map((it) => it.key), ...rest]
  t.alike(traversal, expected, 'the frozen order, each diary exactly once')

  // A fresh read starts at the newest view: the diaries that just published
  // come first.
  const fresh = await lean.disc.read({ limit: 64 })
  t.not(fresh.view, page1.view)
  t.alike(fresh.items.slice(0, 2).map((it) => it.key).sort(), [k[1], k[3]].sort())
  t.is(fresh.items.length, 5)
})

test('discovery: false offers no capability, rejects the channel and keeps the full hello', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, discovery: false })
  const port = await streamServer(t, { current: seeder })

  const author = await authorStore(t, assoc, [1, 2])
  const member = await connectMember(t, port, { store: author.store, caps: CAP_NO_INVENTORY })
  await announceAll(assoc, member, author.diaries)

  const other = await connectMember(t, port, { caps: CAP_NO_INVENTORY })
  const hello = await other.peer.hello
  t.is(other.peer.remoteCaps, 0, 'no capability offered')
  t.is(hello.count, 2, 'the full inventory, even for a member asking for none')
  t.is(await other.disc.supported, false, 'the discovery open is rejected')
  t.alike(seeder.discoveryPage({ after: null, limit: 8 }), { stale: true })
  t.absent(other.noise.destroyed, 'the socket stays up')
})

test('restart: an old view is stale; blocked and ungated diaries are never offered', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, discoveryRebuildMs: REBUILD_MS })
  const holder = { current: first.seeder }
  const port = await streamServer(t, holder)

  const author = await authorStore(t, assoc, [1, 2, 3, 4, 5])
  const k = author.diaries.map((d) => d.key)
  const member = await connectMember(t, port, { store: author.store, caps: CAP_NO_INVENTORY })
  await announceAll(assoc, member, author.diaries.slice(0, 4))
  await until(() => traverse(first.seeder, 64).keys.length === 4, { name: 'four diaries', timeoutMs: 30000 })
  const page1 = first.seeder.discoveryPage({ after: null, limit: 2 })
  t.is(page1.items.length, 2)

  member.noise.destroy()
  await first.seeder.close()

  // Restart: k[0] is blocked by a moderation snapshot; k[4], announced
  // after the restart, is served but its gate is held until the test lets
  // it go.
  const date = '2026-06-01T00:00:00.000Z'
  const mod = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(mod.publicKey), date }, assoc.kp)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [k[0]], revokedIssuers: [] }, mod, modCert))
  let release
  const held = new Promise((resolve) => { release = resolve })
  t.teardown(() => release(), { order: -1 })
  const second = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    discoveryRebuildMs: REBUILD_MS,
    regateHook: async (key) => { if (key === k[4]) await held }
  })
  holder.current = second.seeder
  t.alike(second.seeder.discoveryPage({ after: page1.next, limit: 2, view: page1.view }), { stale: true }, 'a view from before the restart is stale')

  const again = await connectMember(t, port, { store: author.store, caps: CAP_NO_INVENTORY })
  t.alike(await again.disc.page({ after: page1.next, limit: 2, view: page1.view }), { stale: true }, 'stale over the wire too')
  await announceAll(assoc, again, author.diaries.slice(4))

  await until(() => {
    const r = traverse(second.seeder, 64)
    return r.keys.length === 3 && r.keys.join() === [k[3], k[2], k[1]].join()
  }, { name: 'only the gated, unblocked diaries', timeoutMs: 30000 })
  await until(() => {
    const e = second.seeder._served.get(k[4])
    return e && e.present >= 2
  }, { name: 'k[4] holds its post', timeoutMs: 30000 })
  const e4 = second.seeder._served.get(k[4])
  t.ok(e4 && !e4.gated && e4.present >= 2, 'k[4] is served with its post but not gated')
  t.absent(traverse(second.seeder, 64).keys.includes(k[4]), 'an ungated diary is not offered')
  t.absent(second.seeder._served.has(k[0]), 'the blocked diary is not served')

  release()
  await until(() => traverse(second.seeder, 64).keys[0] === k[4], { name: 'k[4] offered first once gated', timeoutMs: 30000 })
  t.absent(traverse(second.seeder, 64).keys.includes(k[0]), 'the blocked diary never appears')
})

test('views expire after the TTL and only the newest DISCOVERY_VIEWS_KEPT are kept', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const ttl = 1500
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, discoveryViewTtlMs: ttl, discoveryRebuildMs: 0 })
  const port = await streamServer(t, { current: seeder })

  const author = await authorStore(t, assoc, [1, 2])
  const member = await connectMember(t, port, { store: author.store, caps: CAP_NO_INVENTORY })
  await announceAll(assoc, member, author.diaries)
  const k = author.diaries.map((d) => d.key)
  await until(() => traverse(seeder, 64).keys.length === 2, { name: 'two diaries', timeoutMs: 30000 })

  // Same order: the newest view (and its id) is kept.
  const a = seeder.discoveryPage({ after: null, limit: 1 })
  t.is(seeder.discoveryPage({ after: null, limit: 1 }).view, a.view, 'an unchanged order keeps its view')

  // Each order change builds a new view (test-only: the times are set
  // directly; the scan sets them from posts in the other tests).
  const views = [a]
  const e0 = seeder._served.get(k[0])
  const e1 = seeder._served.get(k[1])
  for (let i = 1; i <= DISCOVERY_VIEWS_KEPT; i++) {
    if (i % 2 === 1) e0.recentAt = e1.recentAt + 1
    else e1.recentAt = e0.recentAt + 1
    const v = seeder.discoveryPage({ after: null, limit: 1 })
    t.not(v.view, views[views.length - 1].view)
    views.push(v)
  }
  t.is(new Set(views.map((v) => v.view)).size, DISCOVERY_VIEWS_KEPT + 1)
  t.alike(seeder.discoveryPage({ after: a.next, limit: 1, view: a.view }), { stale: true }, 'the oldest view was evicted')
  const kept = views[1]
  const page = seeder.discoveryPage({ after: kept.next, limit: 1, view: kept.view })
  t.is(page.view, kept.view, 'the other views are kept')
  t.is(page.items.length, 1)
  t.not(page.items[0].key, kept.items[0].key)

  await new Promise((resolve) => setTimeout(resolve, ttl + 100))
  for (const v of views) {
    t.alike(seeder.discoveryPage({ after: v.next, limit: 1, view: v.view }), { stale: true })
  }
  const fresh = seeder.discoveryPage({ after: null, limit: 1 })
  t.absent(views.some((v) => v.view === fresh.view), 'a first page after the TTL builds a new view')

  // A pending re-gate hold (every gated diary at once after an issuer
  // revocation) is skipped by pages but never shapes a view.
  e0.searchHold = 1
  e1.searchHold = 1
  e0.recentAt = e1.recentAt + 1
  const held = seeder.discoveryPage({ after: null, limit: 64 })
  t.is(held.total, 2, 'a view built during the hold still holds both diaries')
  t.is(held.items.length, 0, 'held diaries are not offered')
  e0.searchHold = 0
  t.alike(seeder.discoveryPage({ after: null, limit: 64, view: held.view }).items.map((it) => it.key), [k[0]], 'released: offered from the same view')
  e1.searchHold = 0
  t.is(seeder.discoveryPage({ after: null, limit: 64, view: held.view }).items.length, 2)
})

test('views live their whole TTL: the count cap is the TTL over the rebuild interval', (t) => {
  t.is(DISCOVERY_VIEWS_KEPT * DISCOVERY_REBUILD_MS, DISCOVERY_VIEW_TTL_MS)
  t.is(DISCOVERY_REBUILD_MS, 30000)
  t.is(DISCOVERY_VIEW_TTL_MS, 300000)
})
