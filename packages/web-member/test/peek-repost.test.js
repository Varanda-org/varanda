// Reposts in the Espiadinha of the browser node, end to end (loopback only):
// the user report is that reposts by diaries the member does NOT follow
// never show there, even after a pull-to-refresh. Every layer a repost goes
// through is exercised and every case asserts the exact peek.read item
// ({ kind: 'repost', author, seq, to, round } plus the FeedItem fields):
// the record (repostRecord / repost.set), engagementState and
// retainRecords / diaryPeek (@varanda/core lib/peek.js), fetchWindow and
// the window walk (lib/peek.js), buildPeekPage and its cursor, the session
// RPC (peek.read, repost.set, diary.peek) and the app's resolution of the
// original (apps/app/src/thread.js planPeeks + assembleMember, as
// apps/app/src/screens/ARua.js readAuthor runs them). The seeder is the
// stand-in of peek.test.js (role 'seeder' certified by the association,
// replicating and advertising Hypercore 10 cores) for the pure-shape cases
// and the REAL seeder (Hypercore 11, behind startSeedWs as `seed --ws-port`
// runs it) for the write-path cases.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord, likeRecord, repostRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { startSeedWs } = require('../../../apps/cli/lib/seed-ws')
const { createBrowserNode } = require('../lib/node')
const { createMember } = require('../lib/member')
const { connectSeeder } = require('../lib/seeder-link')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const { writeFollows } = require('../lib/node-store')

const APP_SRC = path.join(__dirname, '../../../apps/app/src')
const loadThread = () => import(path.join(APP_SRC, 'thread.js'))
const loadAppPeek = () => import(path.join(APP_SRC, 'peek.js'))
const HOUR = 3600000

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function iso (ms) {
  return new Date(ms).toISOString()
}

// The exact peek.read items (lib/peek.js buildPeekPage: a FeedItem plus round).
function repostItem ({ author, name = null, username = null, seq, at, to, round }) {
  return { kind: 'repost', author, name, username, seq, at, to: { author: to.author, seq: to.seq }, text: null, replyTo: null, quote: null, media: null, round }
}

function postItem ({ author, name = null, username = null, seq, at, text, replyTo = null, quote = null, round }) {
  return { kind: 'post', author, name, username, seq, at, text, replyTo, quote, media: null, round }
}

// A Hypercore 10 diary with the given records (block 0 first); each maker
// receives the diary key.
async function diary (t, records) {
  const core = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  for (const make of records) await core.append(make(hex(core.key)))
  return core
}

// cert (v1 by the association) and profile: blocks 0 and 1 of every diary.
function head (assoc, name) {
  return [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => profileRecord({ name, bio: '' })
  ]
}

// The seeder stand-in of peek.test.js: role 'seeder' certified by `signer`,
// replicating `cores` and advertising them with their length.
async function fakeSeeder (t, { signer, cores = [] }) {
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
      Hypercore.createProtocolStream(noise)
      for (const core of cores) core.replicate(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: cores.map((core) => ({ key: hex(core.key), length: core.length })),
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// The web node with its client in memory, identity created (and certified
// when `certify`), the write gate off.
async function webNode (t, assoc, url, { storage = memoryNodeStorage(), certify = false, internal = [] } = {}) {
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
    syncOptions: { retryMinMs: 100, retryMaxMs: 300, blocklistMinIntervalMs: 0 },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  if (certify) await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, storage, key: publicKey, internal }
}

// Every page from the first one, with `limit`.
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

function cursorOf (item) {
  return { round: item.round, at: item.at, author: item.author, seq: item.seq }
}

// ---- stand-in seeder: the shape of the diaries ----

test('(a) a repost behind 9 likes, and on/off/on of one target, are each one repost item (core diaryPeek + fetchWindow + buildPeekPage)', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const at = (h) => iso(now - h * HOUR)
  const target = { author: hex(crypto.keyPair().publicKey), seq: 2 }
  // L: 0 cert, 1 profile, 2 post, 3..11 likes, 12 repost(on).
  const L = await diary(t, [
    ...head(assoc, 'Lia'),
    () => postRecord({ text: 'lia 1', at: at(10) }),
    ...Array.from({ length: 9 }, (_, i) => () => likeRecord({ to: target, on: true, at: at(9 - i * 0.1) })),
    () => repostRecord({ to: target, on: true, at: at(1) })
  ])
  t.is(L.length, 13)
  // T: 0 cert, 1 profile, 2 post, 3 repost(on), 4 repost(off), 5 repost(on).
  const T = await diary(t, [
    ...head(assoc, 'Téo'),
    () => postRecord({ text: 'téo 1', at: at(11) }),
    () => repostRecord({ to: target, on: true, at: at(4) }),
    () => repostRecord({ to: target, on: false, at: at(3) }),
    () => repostRecord({ to: target, on: true, at: at(2) })
  ])
  t.is(T.length, 6)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [L, T] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  const l = hex(L.key)
  const tk = hex(T.key)
  t.alike(page.items, [
    repostItem({ author: l, name: 'Lia', seq: 12, at: at(1), to: target, round: 0 }),
    repostItem({ author: tk, name: 'Téo', seq: 5, at: at(2), to: target, round: 0 }),
    postItem({ author: l, name: 'Lia', seq: 2, at: at(10), text: 'lia 1', round: 1 }),
    postItem({ author: tk, name: 'Téo', seq: 2, at: at(11), text: 'téo 1', round: 1 })
  ], 'the repost first in each diary, the on/off/on toggle once at its last seq')
  t.is(page.diaries, 2)
  t.is(page.skipped, 0)
  t.is(page.incomplete, false)
  t.is(page.next, null)
  t.alike(internal, [])
})

test('(b) 60 blocks whose only publications are 3 reposts under 50 likes: the window walks back past the likes (peekWindow/fetchWindow loop)', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const at = (h) => iso(now - h * HOUR)
  const other = hex(crypto.keyPair().publicKey)
  const targets = [2, 3, 4].map((seq) => ({ author: other, seq }))
  // 0 cert, 1 profile, 2..6 likes, 7..9 reposts, 10..59 likes.
  const D = await diary(t, [
    ...head(assoc, 'Duda'),
    ...Array.from({ length: 5 }, (_, i) => () => likeRecord({ to: targets[0], on: i % 2 === 0, at: at(20 - i * 0.01) })),
    ...targets.map((to, i) => () => repostRecord({ to, on: true, at: at(10 - i) })),
    ...Array.from({ length: 50 }, (_, i) => () => likeRecord({ to: targets[1], on: i % 2 === 0, at: at(5 - i * 0.01) }))
  ])
  t.is(D.length, 60)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [D] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  const d = hex(D.key)
  t.alike(page.items, [
    repostItem({ author: d, name: 'Duda', seq: 9, at: at(8), to: targets[2], round: 0 }),
    repostItem({ author: d, name: 'Duda', seq: 8, at: at(9), to: targets[1], round: 1 }),
    repostItem({ author: d, name: 'Duda', seq: 7, at: at(10), to: targets[0], round: 2 })
  ], 'the three reposts, newest seq first, one per round')
  t.is(page.skipped, 0)
  t.is(page.incomplete, false, 'the walk stayed within PEEK_MAX_BLOCKS_PER_DIARY')
  t.alike(internal, [])
})

test('(e) a repost of a reply and of a quote: repost items whose originals resolve as posts in the app (assembleMember)', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const at = (h) => iso(now - h * HOUR)
  // Q: 2 post, 3 reply to Q:2, 4 quote of Q:2.
  const Q = await diary(t, [
    ...head(assoc, 'Quim'),
    () => postRecord({ text: 'quim 1', at: at(10) }),
    (key) => postRecord({ text: 'quim responde', at: at(9), replyTo: { author: key, seq: 2 } }),
    (key) => postRecord({ text: 'quim cita', at: at(8), quote: { author: key, seq: 2 } })
  ])
  const q = hex(Q.key)
  // R: 2 repost of the reply, 3 repost of the quote.
  const R = await diary(t, [
    ...head(assoc, 'Rui'),
    () => repostRecord({ to: { author: q, seq: 3 }, on: true, at: at(2) }),
    () => repostRecord({ to: { author: q, seq: 4 }, on: true, at: at(1) })
  ])
  const r = hex(R.key)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [Q, R] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  t.alike(page.items, [
    repostItem({ author: r, name: 'Rui', seq: 3, at: at(1), to: { author: q, seq: 4 }, round: 0 }),
    postItem({ author: q, name: 'Quim', seq: 4, at: at(8), text: 'quim cita', quote: { author: q, seq: 2 }, round: 0 }),
    repostItem({ author: r, name: 'Rui', seq: 2, at: at(2), to: { author: q, seq: 3 }, round: 1 }),
    postItem({ author: q, name: 'Quim', seq: 3, at: at(9), text: 'quim responde', replyTo: { author: q, seq: 2 }, round: 1 }),
    postItem({ author: q, name: 'Quim', seq: 2, at: at(10), text: 'quim 1', round: 2 })
  ])
  t.is(page.incomplete, false)
  // The app's readAuthor keeps only assembleMember items of kind 'post': a
  // reply and a quote must be posts there, or the repost row has no original.
  const { assembleMember } = await loadThread()
  const entries = []
  for (let seq = 1; seq < Q.length; seq++) entries.push({ seq, record: await Q.get(seq) })
  const { items } = assembleMember({ author: q, index: { posts: [4, 3] }, peeked: new Map([[q, { key: q, entries, profile: null, username: null }]]) })
  t.alike(items.map((i) => [i.kind, i.seq]), [['post', 4], ['post', 3]], 'the reply and the quote resolve as posts')
  t.alike(internal, [])
})

test('(f) two reposters of one original give two repost items with distinct author:seq keys', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const at = (h) => iso(now - h * HOUR)
  const O = await diary(t, [...head(assoc, 'Olga'), () => postRecord({ text: 'olga 1', at: at(10) })])
  const o = { author: hex(O.key), seq: 2 }
  const R1 = await diary(t, [...head(assoc, 'Um'), () => repostRecord({ to: o, on: true, at: at(2) })])
  const R2 = await diary(t, [...head(assoc, 'Dois'), () => repostRecord({ to: o, on: true, at: at(1) })])
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [O, R1, R2] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  t.alike(page.items, [
    repostItem({ author: hex(R2.key), name: 'Dois', seq: 2, at: at(1), to: o, round: 0 }),
    repostItem({ author: hex(R1.key), name: 'Um', seq: 2, at: at(2), to: o, round: 0 }),
    postItem({ author: o.author, name: 'Olga', seq: 2, at: at(10), text: 'olga 1', round: 0 })
  ])
  const keys = page.items.map((i) => i.author + ':' + i.seq)
  t.is(new Set(keys).size, keys.length, 'the app list keys (author:seq) never collide')
  t.alike(internal, [])
})

test('(g) a repost whose original is not on the seeder still yields the repost item', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const at = (h) => iso(now - h * HOUR)
  const gone = { author: hex(crypto.keyPair().publicKey), seq: 7 }
  const R = await diary(t, [...head(assoc, 'Rita'), () => repostRecord({ to: gone, on: true, at: at(1) })])
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [R] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  const page = await web.request('peek.read', {})
  t.alike(page, {
    items: [repostItem({ author: hex(R.key), name: 'Rita', seq: 2, at: at(1), to: gone, round: 0 })],
    next: null,
    diaries: 1,
    skipped: 0,
    incomplete: false
  })
  t.alike(internal, [])
})

test('(h) a followed reposter is excluded, an unfollowed one is listed', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const at = (h) => iso(now - h * HOUR)
  const to = { author: hex(crypto.keyPair().publicKey), seq: 2 }
  const F = await diary(t, [...head(assoc, 'Fê'), () => repostRecord({ to, on: true, at: at(1) })])
  const U = await diary(t, [...head(assoc, 'Ugo'), () => repostRecord({ to, on: true, at: at(2) })])
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [F, U] })
  const storage = memoryNodeStorage()
  const { web, internal } = await webNode(t, assoc, seeder.url, { storage })
  await writeFollows(storage, [hex(F.key)])
  const page = await web.request('peek.read', {})
  t.alike(page, {
    items: [repostItem({ author: hex(U.key), name: 'Ugo', seq: 2, at: at(2), to, round: 0 })],
    next: null,
    diaries: 1,
    skipped: 0,
    incomplete: false
  }, 'the followed reposter is not even a candidate')
  t.alike(internal, [])
})

// ---- the real seeder: the write path ----

// The seeder in this process with its WebSocket entry on a system port
// (startSeedWs, as `seed --ws-port` runs it in production).
async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-pr-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-pr-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  return { seeder, events, publicKey, url: 'ws://127.0.0.1:' + ws.port + '/seeder' }
}

// Links a Hypercore 10 member to the seeder until it serves `length`
// blocks, then closes the link: the seeder alone serves the diary.
async function serve (t, m, { url, seederKey }) {
  const link = connectSeeder({ member: m, socket: new WebSocket(url), association: m.association || null, seederPublicKey: seederKey, timeoutMs: 60000 })
  t.teardown(() => link.close(), { force: true })
  const admitted = await link.admitted
  t.is(admitted.key, m.key, 'admitted ' + m.key.slice(0, 8))
  await link.waitServed(m.core.length)
  link.close()
}

// A certified Hypercore 10 member: profile at block 1, then `records(key)`,
// admitted through lib/seeder-link and served whole.
async function servedMember (t, { assoc, url, seederKey, name, records = () => [] }) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
  t.teardown(() => m.close(), { force: true })
  m.association = assoc.hex
  await m.setCert(createCert({ member: m.key }, assoc.kp))
  await m.core.append(profileRecord({ name, bio: '' }))
  for (const record of records(m.key)) await m.core.append(record)
  await serve(t, m, { url, seederKey })
  return m
}

// Until the seeder has logged `key` at `length` (or more).
function seederHas (events, key, length) {
  return until(() => events.some((e) => e.event === 'have' && e.key === key && e.length >= length), { name: 'seeder has ' + key.slice(0, 8) + ' ' + length, timeoutMs: 60000 })
}

// A browser node's own records by seq (log.read of its own diary).
async function ownRecords (web) {
  const { entries } = await web.request('log.read', { limit: 36 })
  return new Map(entries.map((e) => [e.seq, e.record]))
}

// The app's resolution of repost originals, as ARua.js readAuthor runs it:
// planPeeks per author (with the /index/member hints readAuthor fetches on
// the hosted web for an unknown author), diary.peek per chunk, then
// assembleMember keeping the items of kind 'post'. -> Map ref -> item.
async function resolveOriginals (web, refs, authors = {}) {
  const { planPeeks, assembleMember } = await loadThread()
  const out = new Map()
  for (const chunk of planPeeks({ refs, authors })) {
    const peek = await web.request('diary.peek', chunk)
    const { items } = assembleMember({ author: chunk.author, index: { posts: chunk.seqs.slice().sort((a, b) => b - a) }, peeked: new Map([[chunk.author, peek]]) })
    for (const item of items) if (item.kind === 'post') out.set(chunk.author + ':' + item.seq, item)
  }
  return out
}

test('(c) real seeder: a member admitted through seeder-link whose last block is a repost; first page, continuation (limit 1) and pull-to-refresh', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = association()
  const { url, publicKey: seederKey } = await seederStack(t, bootstrap, assoc)
  const now = Date.now()
  const at = (h) => iso(now - h * HOUR)
  const A = await servedMember(t, { assoc, url, seederKey, name: 'Ana', records: () => [postRecord({ text: 'ana 1', at: at(2) })] })
  const original = { author: A.key, seq: 2 }
  // R: 1 profile, 2 post, 3 repost of A:2 (the last block).
  const R = await servedMember(t, {
    assoc,
    url,
    seederKey,
    name: 'Rui',
    records: () => [postRecord({ text: 'rui 1', at: at(5) }), repostRecord({ to: original, on: true, at: at(1) })]
  })
  t.is(R.core.length, 4)

  // The reader follows nobody.
  const { web, internal } = await webNode(t, assoc, url, { certify: true })
  const repost = repostItem({ author: R.key, name: 'Rui', seq: 3, at: at(1), to: original, round: 0 })
  const anaPost = postItem({ author: A.key, name: 'Ana', seq: 2, at: at(2), text: 'ana 1', round: 0 })
  const ruiPost = postItem({ author: R.key, name: 'Rui', seq: 2, at: at(5), text: 'rui 1', round: 1 })
  const page = await web.request('peek.read', {})
  t.alike(page, { items: [repost, anaPost, ruiPost], next: null, diaries: 2, skipped: 0, incomplete: false }, 'first page: the repost leads round 0')

  // Continuation with limit 1: the cursor is the repost, the next page excludes it.
  const p1 = await web.request('peek.read', { limit: 1 })
  t.alike(p1.items, [repost])
  t.alike(p1.next, cursorOf(repost), 'cursor seq = the repost seq')
  const p2 = await web.request('peek.read', { limit: 1, after: p1.next })
  t.alike(p2.items, [anaPost], 'the continuation excludes the repost')
  const pages = await allPages(web, 1)
  t.alike(pages.flatMap((p) => p.items), [repost, anaPost, ruiPost], 'limit-1 pages concatenate to the full order')
  // The screen's merge (apps/app/src/peek.js mergePage, rows keyed by
  // peekKey = author:seq): the repost row survives every page merge.
  const { mergePage, peekKey } = await loadAppPeek()
  let merged = []
  for (const p of pages) merged = mergePage(merged, p.items).items
  t.alike(merged, [repost, anaPost, ruiPost], 'the app list after merging every page')
  t.alike(mergePage([], page.items).items.map(peekKey), [R.key + ':3', A.key + ':2', R.key + ':2'])

  // Pull-to-refresh after R reposts again (the seeder learns it over a new
  // link): the after-less read sees the new repost first.
  const later = { author: A.key, seq: 1 }
  await R.core.append(repostRecord({ to: later, on: true, at: at(0.5) }))
  await serve(t, R, { url, seederKey })
  const refreshed = await web.request('peek.read', {})
  t.alike(refreshed.items, [
    repostItem({ author: R.key, name: 'Rui', seq: 4, at: at(0.5), to: later, round: 0 }),
    anaPost,
    repostItem({ author: R.key, name: 'Rui', seq: 3, at: at(1), to: original, round: 1 }),
    postItem({ author: R.key, name: 'Rui', seq: 2, at: at(5), text: 'rui 1', round: 2 })
  ], 'the refresh lists the new repost, the older one in round 1')
  t.is(refreshed.incomplete, false)
  t.alike(internal, [])
})

test('(d) two browser nodes: repost.set through the session, synced to the real seeder, listed by the other node\'s peek.read and resolved with diary.peek; then 9 likes push it out of the first tail window', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assoc = association()
  const { url, publicKey: seederKey, events } = await seederStack(t, bootstrap, assoc)
  const now = Date.now()
  // A: followed by the reader. X: nobody follows it.
  const A = await servedMember(t, { assoc, url, seederKey, name: 'Ana', records: () => [postRecord({ text: 'ana 1', at: iso(now - 3 * HOUR) })] })
  const X = await servedMember(t, { assoc, url, seederKey, name: 'Xavi', records: () => [postRecord({ text: 'xavi 1', at: iso(now - 2 * HOUR) })] })

  // Node 2, the reader: writes the original, follows A, runs a continuous
  // sync (diary.peek reads through the running sync).
  const internal = []
  const N2 = await webNode(t, assoc, url, { certify: true, internal })
  const created = await N2.web.request('post.create', { text: 'original de N2' })
  t.is(created.seq, 1)
  t.alike(await N2.web.request('follow.add', { key: A.key }), { changed: true, followCount: 1 })
  await N2.web.request('sync.start', {})
  await until(() => N2.web.events.some((e) => e.name === 'sync.event' && e.data.line === 'downloaded ' + A.key + ' ' + A.core.length), { name: 'A baixado', timeoutMs: 60000 })

  // Node 1, the reposter: a profile, then three reposts through the session
  // RPC (the app's write path), pushed by a once run.
  const N1 = await webNode(t, assoc, url, { certify: true, internal })
  await N1.web.request('profile.set', { name: 'Rui', bio: '' })
  const targets = [created.ref, A.key + ':2', X.key + ':2']
  const writes = []
  for (const to of targets) writes.push(await N1.web.request('repost.set', { to, on: true }))
  t.alike(writes.map((w) => [w.seq, w.on, w.changed]), [[2, true, true], [3, true, true], [4, true, true]])
  async function push (length) {
    const { runId } = await N1.web.request('sync.start', { once: true, timeoutMs: 30000 })
    await stoppedOf(N1.web.events, runId)
    await seederHas(events, N1.key, length)
  }
  await push(5)
  const own = await ownRecords(N1.web)
  const parse = (ref) => ({ author: ref.split(':')[0], seq: Number(ref.split(':')[1]) })
  const expected = [4, 3, 2].map((seq, round) => repostItem({ author: N1.key, name: 'Rui', seq, at: own.get(seq).at, to: parse(targets[seq - 2]), round }))
  t.alike(expected.map((i) => i.to), [parse(targets[2]), parse(targets[1]), parse(targets[0])])

  const page = await N2.web.request('peek.read', {})
  t.alike(page.items.filter((i) => i.author === N1.key), expected, 'node 1\'s three reposts, one per round (an unfollowed, a followed and the reader\'s own original)')
  t.alike(page.items.filter((i) => i.author === X.key), [postItem({ author: X.key, name: 'Xavi', seq: 2, at: iso(now - 2 * HOUR), text: 'xavi 1', round: 0 })])
  t.absent(page.items.some((i) => i.author === A.key), 'the followed diary is absent')
  t.is(page.incomplete, false)

  // The originals resolve through diary.peek as readAuthor resolves them:
  // the reader's own diary, the followed A (local replica) and X (seeder,
  // with the profile hint /index/member gives for an unknown author).
  const refs = page.items.filter((i) => i.kind === 'repost').map((i) => i.to.author + ':' + i.to.seq)
  const originals = await resolveOriginals(N2.web, refs, { [X.key]: { profileSeq: 1, usernameSeq: null } })
  t.alike([...originals.keys()].sort(), targets.slice().sort(), 'every original resolved')
  t.is(originals.get(created.ref).text, 'original de N2')
  t.is(originals.get(A.key + ':2').text, 'ana 1')
  t.is(originals.get(X.key + ':2').text, 'xavi 1')
  t.is(originals.get(X.key + ':2').name, 'Xavi', 'the profile came with the peek')

  // 9 likes after the reposts (5..13): the first tail window (6..13) holds
  // likes only and the reposts sit below its floor; the window must extend.
  for (let i = 0; i < 9; i++) {
    const w = await N1.web.request('like.set', { to: X.key + ':2', on: i % 2 === 0 })
    t.is(w.changed, true)
  }
  await push(14)
  const again = await N2.web.request('peek.read', {})
  t.alike(again.items.filter((i) => i.author === N1.key), expected, 'the same three reposts after the window walked back past the likes')
  t.is(again.incomplete, false)
  await N2.web.request('sync.stop')
  t.alike(internal, [])
})
