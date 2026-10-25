// The browser node session's media and follow additions (lib/session.js
// through lib/node.js and an in-memory client), on memory storage: the
// mediaUpload host control (locked, validation, the descriptor, the blocks in
// the media core, one declaration per core, progress), posts carrying media
// (log.read and feed.read keep it intact; a forged descriptor is refused),
// the keys gone on clearKeyPair / reset, the local-first follows (refused
// locked with nothing queued; unlocked they are queued signed and
// coalesced, the drain appends the records and drops ops planted in the
// storage, a drain that cannot reach the seeder warns and keeps the change
// pending), the follows-changed relay with one restart per own length, and
// reset clearing the media cores and the pending follows. No seeder: the
// sync runs dial a loopback port nothing listens on, so the fixtures turn the
// write gate off except where the test is about the gate.
const test = require('brittle')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createHash } = require('node:crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocket, WebSocketServer } = require('ws')
const { testnet, until } = require('./helpers/net')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { wsStream } = require('../lib/ws-stream')
const { MEDIA_BLOCK_BYTES, MAX_MEDIA_ITEM_BLOCKS } = require('@varanda/core/lib/records')
const { validateDescriptor } = require('@varanda/core/lib/media')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')

// lib/session.js takes runSync from lib/sync.js when it loads: wrapped here
// (before lib/node.js loads it) so a test can hand a run's onEvent the sync
// events the fold emits ('follows-changed'); everything else is the real sync.
const sync = require('../lib/sync')
const realRunSync = sync.runSync
const liveRuns = [] // onEvent of the runs in flight, oldest first
sync.runSync = (options) => {
  liveRuns.push(options.onEvent)
  return realRunSync(options).finally(() => {
    const i = liveRuns.indexOf(options.onEvent)
    if (i !== -1) liveRuns.splice(i, 1)
  })
}
const { createBrowserNode } = require('../lib/node')

const LOCKED = 'identidade bloqueada: entre com a passkey'
const BAD_MEDIA = 'mídia inválida'
const DRAIN_WARNING = 'aviso: seguidos ainda não enviados'
const DESCRIPTOR_KEYS = ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height']

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

// A loopback port with nothing listening (bound, then released).
async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// n deterministic bytes and their SHA-256.
function image (n, seed = 1) {
  const bytes = new Uint8Array(n)
  for (let i = 0; i < n; i++) bytes[i] = (i * 13 + seed) & 0xff
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function upload (node, bytes, extra = {}) {
  return node.mediaUpload({ bytes, mime: 'image/jpeg', width: 640, height: 480, ...extra })
}

// The item's bytes as the media core holds them (the core is opened and
// closed here, between session operations).
async function readItem (storage, descriptor) {
  const core = await store.openMediaCoreReadOnly(storage, descriptor.core)
  if (core === null) return null
  try {
    const chunks = []
    for (let i = descriptor.start; i < descriptor.start + descriptor.blocks; i++) chunks.push(await core.get(i, { wait: false }))
    return { bytes: b4a.concat(chunks), length: core.length }
  } finally {
    await core.close()
  }
}

// A seeder stand-in (session.test.js, sync-gate.test.js): role 'seeder'
// with a certificate signed by `signer`, on `port` (0 = any); it admits an
// announced diary at the length the member advertised.
async function fakeSeeder (t, { signer, port = 0 }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: [],
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', port: wss.address().port }
}

// keyPair / mediaKeyPair: handed to the node before anything else (null =
// the node stays locked / has no media key). port: the seeder port (default
// a dead one).
async function setup (t, { storage = memoryNodeStorage(), assoc = association(), keyPair = crypto.keyPair(), mediaKeyPair = crypto.keyPair(), port = null, ...options } = {}) {
  if (port === null) port = await deadPort()
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false,
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  if (keyPair !== null) await node.setKeyPair(keyPair, mediaKeyPair === null ? {} : { media: mediaKeyPair })
  const web = await connectClient(node)
  return { node, web, assoc, storage, keyPair, mediaKeyPair, internal, port }
}

async function certified (t, options) {
  const s = await setup(t, options)
  const { publicKey } = await s.web.request('identity.create')
  await s.web.request('cert.add', { cert: createCert({ member: publicKey }, s.assoc.kp) })
  return { ...s, key: publicKey }
}

function warningsOf (web) {
  return web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
}

test('mediaUpload: refused locked or without a media key; arguments checked before anything runs', async (t) => {
  await testnet(t, 1)
  const { bytes } = image(100)
  const noMedia = await certified(t, { mediaKeyPair: null })
  const missing = await errorOf(upload(noMedia.node, bytes))
  t.alike([missing.code, missing.message], ['USAGE', LOCKED], 'unlocked identity but no media key')
  await noMedia.node.clearKeyPair()
  const locked = await errorOf(upload(noMedia.node, bytes))
  t.alike([locked.code, locked.message], ['USAGE', LOCKED], 'locked')
  t.alike(await store.readMediaCores(noMedia.storage), [], 'no core was created')

  const s = await certified(t)
  for (const [label, args] of [
    ['no bytes', { bytes: undefined }],
    ['empty', { bytes: new Uint8Array(0) }],
    ['oversize', { bytes: new Uint8Array(MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES + 1) }],
    ['not bytes', { bytes: 'abc' }],
    ['bad mime', { bytes, mime: 'video/mp4' }],
    ['no mime', { bytes, mime: undefined }],
    ['zero width', { bytes, width: 0 }],
    ['fractional height', { bytes, height: 1.5 }],
    ['huge width', { bytes, width: 16385 }],
    ['string height', { bytes, height: '480' }]
  ]) {
    t.exception.all(() => upload(s.node, bytes, args), /mídia inválida/, label)
  }
  t.exception.all(() => s.node.mediaUpload(), /mídia inválida/, 'no arguments')
  t.alike(await store.readMediaCores(s.storage), [], 'nothing stored by a refused call')
  t.is((await s.web.request('log.read', {})).entries.length, 1, 'nothing declared')
  t.alike(s.internal, [], 'no internal error')
})

test('mediaUpload stores the item, declares the core once, and a post carries the descriptor', async (t) => {
  await testnet(t, 1)
  const s = await certified(t)
  const a = image(MEDIA_BLOCK_BYTES * 2 + 100, 3)
  const seen = []
  const d1 = await upload(s.node, a.bytes, { onProgress: (f) => { seen.push(f); if (f === 0.25) throw new Error('ignored') } })
  t.alike(seen, [0.25, 0.75, 1], 'progress at hashed, stored, done; a throwing callback is ignored')
  t.alike(Object.keys(d1).sort(), [...DESCRIPTOR_KEYS].sort(), 'the 8 descriptor keys')
  t.is(validateDescriptor(d1), null, 'a valid descriptor')
  t.is(d1.core, hex(s.mediaKeyPair.publicKey), 'the core is this device\'s media key')
  t.not(d1.core, s.key, 'never the diary key')
  t.alike([d1.mime, d1.start, d1.blocks, d1.bytes, d1.sha256, d1.width, d1.height], ['image/jpeg', 1, 3, a.bytes.byteLength, a.sha256, 640, 480])
  const stored = await readItem(s.storage, d1)
  t.alike(stored.bytes, b4a.from(a.bytes), 'the blocks read back from the media core')
  t.is(stored.length, 4, 'header + 3 blocks')
  t.alike(await store.readMediaCores(s.storage), [d1.core], 'kv mediaCores lists it')

  const log1 = await s.web.request('log.read', {})
  t.alike(log1.entries.map((e) => e.seq), [0, 1])
  t.alike([log1.entries[1].record.type, log1.entries[1].record.key], ['media-core', d1.core], 'the declaration was appended')

  const b = image(500, 9)
  const d2 = await upload(s.node, b.bytes, { mime: 'image/png', width: 20, height: 25 })
  t.alike([d2.core, d2.start, d2.blocks, d2.bytes, d2.mime], [d1.core, 4, 1, 500, 'image/png'], 'the second item follows the first in the same core')
  t.alike((await readItem(s.storage, d2)).bytes, b4a.from(b.bytes))
  t.alike((await s.web.request('log.read', {})).entries.map((e) => e.seq), [0, 1], 'no second declaration')

  // The caller's bytes may change afterwards: the session hashed its copy.
  const c = image(10, 5)
  const bytesC = b4a.from(c.bytes)
  const d3 = await upload(s.node, bytesC)
  bytesC.fill(0)
  t.is(d3.sha256, c.sha256)
  t.alike((await readItem(s.storage, d3)).bytes, b4a.from(c.bytes), 'a copy was stored, not the caller\'s buffer')

  // Posts with media: text may be empty with media; the records keep the
  // descriptors; the feed shows them.
  t.alike(await s.web.request('post.create', { text: 'foto', media: [d1, d2] }), { seq: 2, ref: s.key + ':2' })
  t.alike(await s.web.request('post.create', { text: '', media: [d3] }), { seq: 3, ref: s.key + ':3' })
  t.alike(await s.web.request('post.reply', { to: s.key + ':2', text: 'resposta', media: [d2] }), { seq: 4, ref: s.key + ':4' })
  const log = await s.web.request('log.read', {})
  t.alike(log.invalid, [], 'every record valid')
  t.alike(log.entries[2].record.media, [d1, d2], 'media intact in the post record')
  t.alike(log.entries[3].record.media, [d3])
  t.is(log.entries[3].record.text, '')
  t.alike(log.entries[4].record.media, [d2])
  t.alike(log.entries[4].record.replyTo, { author: s.key, seq: 2 })
  const feed = await s.web.request('feed.read', {})
  t.alike(feed.items.map((i) => [i.seq, i.text, i.media]), [[2, 'foto', [d1, d2]], [3, '', [d3]], [4, 'resposta', [d2]]], 'the feed carries the descriptors')
  t.alike(await s.web.request('post.create', { text: 'sem foto' }), { seq: 5, ref: s.key + ':5' })
  const plain = (await s.web.request('feed.read', { limit: 1 })).items[0]
  t.is(plain.media, null, 'a post without media reads media null')

  // Forged descriptors: a wrong hash, bytes, a foreign core, the diary key.
  for (const [label, forged] of [
    ['wrong sha256', { ...d1, sha256: 'ab'.repeat(32) }],
    ['wrong bytes', { ...d1, bytes: d1.bytes - 1 }],
    ['blocks past the core', { ...d2, blocks: 2, bytes: MEDIA_BLOCK_BYTES + 1 }],
    ['foreign core', { ...d1, core: hex(crypto.keyPair().publicKey) }],
    ['the diary key as core', { ...d1, core: s.key }]
  ]) {
    const err = await errorOf(s.web.request('post.create', { text: 'x', media: [forged] }))
    t.alike([err && err.code, err && err.message], ['USAGE', BAD_MEDIA], label)
  }
  t.is((await s.web.request('log.read', {})).entries.length, 6, 'nothing appended for a forged descriptor')
  t.alike(s.internal, [], 'no internal error')
})

test('an upload the write gate refuses stores nothing; the retry declares once and appends once', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const mediaKeyPair = crypto.keyPair()
  const coreHex = hex(mediaKeyPair.publicKey)
  const first = await certified(t, { storage, assoc, keyPair, mediaKeyPair })
  await first.node.close()

  const gated = await setup(t, { storage, assoc, keyPair, mediaKeyPair, writeGate: true, writeGateTimeoutMs: 1500, syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const a = image(MEDIA_BLOCK_BYTES + 7, 4)
  const seen = []
  const refused = await errorOf(upload(gated.node, a.bytes, { onProgress: (f) => seen.push(f) }))
  t.alike([refused.code, refused.message], ['USAGE', 'sincronize com o semeador antes de publicar'], 'no seeder: the declaration is refused')
  t.alike(seen, [0.25], 'hashed, nothing stored')
  const startedCount = () => gated.web.events.filter((e) => e.name === 'sync.started').length
  t.is(startedCount(), 1, 'the gate run only')
  t.alike(await store.readMediaCores(storage), [coreHex], 'the core is readied')
  let core = await store.openMediaCoreReadOnly(storage, coreHex)
  t.is(core.length, 1, 'header only: no byte of the item was appended')
  await core.close()
  t.alike((await gated.web.request('log.read', {})).entries.map((e) => e.seq), [0], 'nothing declared')

  // The seeder comes back on the same address: the retry declares the core
  // (gate + push) and appends the item once.
  const seeder = await fakeSeeder(t, { signer: assoc.kp, port: gated.port })
  t.is(seeder.port, gated.port)
  const d = await upload(gated.node, a.bytes)
  t.alike([d.core, d.start, d.blocks, d.bytes, d.sha256], [coreHex, 1, 2, a.bytes.byteLength, a.sha256])
  t.is(startedCount(), 3, 'the gate run and the push run of the declaration')
  const log = await gated.web.request('log.read', {})
  t.alike(log.entries.map((e) => [e.seq, e.record.type]), [[0, 'member-cert'], [1, 'media-core']], 'declared once')
  t.is(log.entries[1].record.key, coreHex)
  core = await store.openMediaCoreReadOnly(storage, coreHex)
  t.is(core.length, 3, 'header + the item\'s two blocks, once')
  await core.close()
  t.alike((await readItem(storage, d)).bytes, b4a.from(a.bytes))

  // Later uploads into the declared core need no network at all.
  const b = image(99, 8)
  const d2 = await upload(gated.node, b.bytes)
  t.alike([d2.core, d2.start, d2.blocks], [coreHex, 3, 1])
  t.is(startedCount(), 3, 'no run for an upload into a declared core')
  t.is((await gated.web.request('log.read', {})).entries.length, 2, 'no second declaration')
  t.alike(gated.internal, [], 'no internal error')
})

test('the media key goes with the identity key: clearKeyPair, reset and close', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const mediaKeyPair = crypto.keyPair()
  const s = await certified(t, { storage, assoc, keyPair, mediaKeyPair })
  const a = image(300)
  const d = await upload(s.node, a.bytes)
  t.ok(crypto.validateKeyPair(keyPair), 'the caller\'s identity buffers were copied, not taken')
  t.ok(crypto.validateKeyPair(mediaKeyPair), 'the caller\'s media buffers too')

  await s.node.clearKeyPair()
  const locked = await errorOf(upload(s.node, a.bytes))
  t.alike([locked.code, locked.message], ['USAGE', LOCKED], 'no media key after clearKeyPair')
  const post = await errorOf(s.web.request('post.create', { text: 'x', media: [d] }))
  t.alike([post.code, post.message], ['USAGE', LOCKED])
  t.alike((await s.web.request('log.read', {})).entries[1].record.type, 'media-core', 'reads still work')

  // Unlocking the identity alone leaves uploads refused; with the media key
  // they work again, in the same core.
  await s.node.setKeyPair(keyPair)
  t.is((await errorOf(upload(s.node, a.bytes))).message, LOCKED, 'identity only: no media key')
  await s.node.setKeyPair(keyPair, { media: mediaKeyPair })
  const again = await upload(s.node, a.bytes)
  t.alike([again.core, again.start], [d.core, d.start + d.blocks], 'the same device core continues')

  await s.node.reset()
  t.absent(await storage.hasCore(store.mediaName(d.core)), 'the old media core is gone')
  t.is((await errorOf(upload(s.node, a.bytes))).code, 'NOT_FOUND', 'no identity after reset')
  await s.node.setKeyPair(keyPair, { media: mediaKeyPair })
  await s.web.request('identity.create')
  t.is((await errorOf(upload(s.node, a.bytes))).message, 'grave o certificado de membro antes de publicar', 'the new diary needs block 0 before a declaration')
  t.absent(await storage.hasCore(store.mediaName(d.core)), 'and no byte was stored before that check')

  await s.node.close()
  const closed = await errorOf(upload(s.node, a.bytes))
  t.alike([closed.code, closed.message], ['LOCKED', 'sessão encerrada'])
  t.alike(s.internal, [], 'no internal error')
})

test('follows: refused locked and nothing queued; unlocked they are signed, coalesced offline and drained in order', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const first = await certified(t, { storage, assoc, keyPair })
  t.absent(first.web.events.some((e) => e.name === 'sync.started' || e.name === 'warning'), 'no follows: the drain runs nothing')
  t.is(await storage.readJson('followsMigrated'), null, 'and marks nothing')
  await first.node.close()

  const A = 'ab'.repeat(32)
  const B = 'cd'.repeat(32)
  const C = 'ef'.repeat(32)
  // A follow from before `follow` records existed: kv follows only, no
  // pending op, no migration marker (a pre-upgrade device).
  await store.writeFollows(storage, [C])

  // Locked (signed out): a follow change is refused and nothing waits for
  // the next sign-in, whoever has the browser.
  const locked = await setup(t, { storage, assoc, keyPair: null })
  const from = locked.web.events.length
  for (const method of ['follow.add', 'follow.remove']) {
    const err = await errorOf(locked.web.request(method, { key: A }))
    t.alike([err && err.code, err && err.message], ['USAGE', LOCKED], method + ' locked')
  }
  t.alike(await locked.web.request('follow.list'), { follows: [C], total: 1 }, 'kv follows untouched')
  t.is(await storage.readJson('followsPending'), null, 'nothing queued')
  t.is((await locked.web.request('log.read', {})).entries.length, 1, 'nothing appended while locked')
  t.absent(locked.web.events.slice(from).some((e) => e.name === 'sync.started' || e.name === 'warning'), 'no run and no warning while locked')
  await locked.node.close()

  // Unlocked but offline (the gate cannot reach the seeder): changes are
  // answered at once, queued signed, one op per key, and the diary waits.
  const offline = await setup(t, { storage, assoc, keyPair, writeGate: true, writeGateTimeoutMs: 500, syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  t.alike(await offline.web.request('follow.add', { key: A }), { changed: true, followCount: 2 })
  t.alike(await offline.web.request('follow.add', { key: B }), { changed: true, followCount: 3 })
  t.alike(await offline.web.request('follow.remove', { key: A }), { changed: true, followCount: 2 })
  t.alike(await offline.web.request('follow.add', { key: A }), { changed: true, followCount: 3 })
  t.alike(await offline.web.request('follow.remove', { key: A }), { changed: true, followCount: 2 })
  t.alike(await offline.web.request('follow.add', { key: B }), { changed: false, followCount: 2 }, 'no change: nothing queued')
  t.alike(await offline.web.request('follow.list'), { follows: [B, C], total: 2 }, 'kv follows changed at once')
  await until(() => warningsOf(offline.web).includes(DRAIN_WARNING), { name: 'aviso do drain', timeoutMs: 10000 })
  const pending = await store.readFollowsPending(storage)
  t.alike(pending.map((op) => [op.key, op.on]), [[B, true], [A, false]], 'one op per key, the last change of A last')
  t.ok(pending.every((op) => /^[0-9a-f]{128}$/.test(op.sig)), 'every op signed')
  t.is((await offline.web.request('log.read', {})).entries.length, 1, 'nothing appended offline')
  // The warnings stop with the chain: wait for the last drain to settle.
  await until(async () => (await offline.web.request('sync.status')).state === 'idle', { name: 'drain parado', timeoutMs: 10000 })
  await offline.node.close()

  // Back online (gate off here): the drain on unlock appends the pending
  // ops in order, one record per key. The pre-existing follow C is NOT
  // published on its own: it waits for the person's confirmation.
  const online = await setup(t, { storage, assoc, keyPair })
  const log = await online.web.request('log.read', {})
  t.alike(log.entries.map((e) => e.seq), [0, 1, 2], 'two follow records')
  t.alike(log.entries.slice(1).map((e) => [e.record.type, e.record.key, e.record.on]), [['follow', B, true], ['follow', A, false]], 'one record per changed key, nothing for C')
  t.alike(log.invalid, [])
  t.is(await storage.readJson('followsMigrated'), null, 'no decision yet')
  t.alike(await store.readFollowsPending(storage), [], 'nothing pending')
  t.alike(await online.web.request('follow.list'), { follows: [B, C], total: 2 }, 'C stays in the local list meanwhile')
  t.absent(warningsOf(online.web).includes(DRAIN_WARNING), 'no warning')

  // The person confirms the legacy list: C reaches the diary, signed.
  t.alike(await online.node.legacyFollows(), { keys: [C] }, 'only C awaits a decision (B is the diary\'s)')
  t.alike(await online.node.confirmLegacyFollows([C]), { published: 1 })
  const confirmed = await online.web.request('log.read', {})
  t.alike(confirmed.entries.slice(3).map((e) => [e.record.type, e.record.key, e.record.on]), [['follow', C, true]], 'the confirmed follow was drained')
  t.ok(await storage.readJson('followsMigrated'), 'decided')
  t.alike(await online.node.legacyFollows(), { keys: [] })

  // Unlocked and online: a change is appended right after the answer.
  t.alike(await online.web.request('follow.remove', { key: B }), { changed: true, followCount: 1 })
  const after = await online.web.request('log.read', {})
  t.alike([after.entries.length, after.entries[4].record.key, after.entries[4].record.on], [5, B, false])
  t.alike(await store.readFollowsPending(storage), [])
  t.alike(online.internal, [], 'no internal error')
})

test('legacy follows: listed and published only once confirmed; a planted key never reaches the diary unless confirmed', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const [P, Q, R] = ['ab'.repeat(32), 'cd'.repeat(32), 'ef'.repeat(32)]
  // A pre-upgrade device: P and Q in kv follows, no records, no marker.
  await store.writeFollows(storage, [P, Q])
  const first = await certified(t, { storage, assoc, keyPair })
  t.is((await first.web.request('log.read', {})).entries.length, 1, 'nothing published automatically')
  t.alike(await first.node.legacyFollows(), { keys: [P, Q] })
  for (const bad of [null, 'x', [1], ['ab'.repeat(31)], ['AB'.repeat(32)], Array.from({ length: MAX_INVENTORY }, () => P)]) {
    t.exception.all(() => first.node.confirmLegacyFollows(bad), /chaves inválidas/, 'bad keys: ' + JSON.stringify(bad).slice(0, 20))
  }
  await first.node.clearKeyPair()
  const lockedList = await errorOf(first.node.legacyFollows())
  t.alike([lockedList.code, lockedList.message], ['USAGE', LOCKED], 'listing needs the key')
  const lockedConfirm = await errorOf(first.node.confirmLegacyFollows([P]))
  t.alike([lockedConfirm.code, lockedConfirm.message], ['USAGE', LOCKED], 'confirming needs the key')
  t.is(await storage.readJson('followsMigrated'), null)
  await first.node.close()

  // Someone with the signed-out profile plants R in kv follows.
  await store.writeFollows(storage, [P, Q, R])
  const again = await setup(t, { storage, assoc, keyPair })
  t.is((await again.web.request('log.read', {})).entries.length, 1, 'still nothing published at sign-in')
  t.alike(await again.node.legacyFollows(), { keys: [P, Q, R] }, 'the planted key is only offered for a decision')
  t.alike(await again.web.request('follow.list'), { follows: [P, Q, R], total: 3 }, 'the local list meanwhile')

  // The person confirms P only: P is published, Q and R leave the list.
  t.alike(await again.node.confirmLegacyFollows([P]), { published: 1 })
  const log = await again.web.request('log.read', {})
  t.alike(log.entries.slice(1).map((e) => [e.record.type, e.record.key, e.record.on]), [['follow', P, true]], 'exactly the confirmed key, drained')
  t.alike(await again.web.request('follow.list'), { follows: [P], total: 1 }, 'the unconfirmed keys are gone')
  t.ok(await storage.readJson('followsMigrated'), 'decided')
  t.alike(await again.node.legacyFollows(), { keys: [] })
  t.alike(await again.node.confirmLegacyFollows([Q]), { published: 0 }, 'nothing to confirm any more')

  // Deleting the marker and planting again republishes nothing by itself.
  await store.clearFollowsMigrated(storage)
  await store.writeFollows(storage, [P, R])
  await again.node.setKeyPair(keyPair)
  await again.web.request('follow.list')
  t.is((await again.web.request('log.read', {})).entries.length, 2, 'no automatic publication after the marker is deleted')
  t.alike(await again.node.legacyFollows(), { keys: [R] }, 'the planted key waits again')
  t.alike(await again.node.confirmLegacyFollows([]), { published: 0 }, 'declined')
  t.alike(await again.web.request('follow.list'), { follows: [P], total: 1 })
  t.is((await again.web.request('log.read', {})).entries.length, 2, 'the diary never saw it')
  t.absent(warningsOf(again.web).includes(DRAIN_WARNING), 'no warning')
  t.alike(again.internal, [], 'no internal error')
})

test('follows: an op planted in the storage while signed out is dropped at the next drain, never appended', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const first = await certified(t, { storage, assoc, keyPair })
  const X = 'ab'.repeat(32)
  t.alike(await first.web.request('follow.add', { key: X }), { changed: true, followCount: 1 })
  t.is((await first.web.request('log.read', {})).entries.length, 2, 'X followed and drained')
  await first.node.close()

  // Someone with the signed-out profile writes ops straight into IndexedDB:
  // an unfollow of X with no signature, one with a bad signature, one signed
  // by another key, and a follow of Y signed for another diary.
  const Y = 'cd'.repeat(32)
  const at = new Date().toISOString()
  const other = crypto.keyPair()
  await store.writeFollowsPending(storage, [
    { key: X, on: false, at },
    { key: X, on: false, at, sig: 'ab'.repeat(64) },
    member.signFollowOp({ key: X, on: false, at }, first.key, other),
    member.signFollowOp({ key: Y, on: true, at }, hex(other.publicKey), other)
  ])
  t.is((await store.readFollowsPending(storage)).length, 4, 'planted')

  // The owner signs in: the drain drops them all.
  const again = await setup(t, { storage, assoc, keyPair })
  const log = await again.web.request('log.read', {})
  t.is(log.entries.length, 2, 'nothing appended')
  t.alike(await store.readFollowsPending(storage), [], 'the planted ops are gone')
  t.alike(await again.web.request('follow.list'), { follows: [X], total: 1 }, 'X still followed')
  t.absent(warningsOf(again.web).includes(DRAIN_WARNING), 'no warning')
  t.alike(again.internal, [], 'no internal error')
})

test('a drain that cannot reach the seeder warns, fails no request and keeps the change pending', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const first = await certified(t, { storage, assoc, keyPair })
  await first.node.close()

  const gated = await setup(t, { storage, assoc, keyPair, writeGate: true, writeGateTimeoutMs: 1500, syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const A = 'ef'.repeat(32)
  t.alike(await gated.web.request('follow.add', { key: A }), { changed: true, followCount: 1 }, 'the answer does not wait for the seeder')
  t.alike(await gated.web.request('follow.list'), { follows: [A], total: 1 }, 'local-first')
  await until(() => warningsOf(gated.web).includes(DRAIN_WARNING), { name: 'aviso do drain', timeoutMs: 10000 })
  const started = gated.web.events.filter((e) => e.name === 'sync.started')
  t.is(started.length, 1, 'one internal gate run')
  const stopped = await stoppedOf(gated.web.events, started[0].data.runId)
  t.is(stopped.reason, 'timeout')
  t.ok(gated.web.events.some((e) => e.name === 'sync.event' && e.data.runId === started[0].data.runId && e.data.line === 'sincronizando antes de publicar'), 'the gate run names itself')
  t.alike((await store.readFollowsPending(storage)).map((op) => [op.key, op.on]), [[A, true]], 'the change stays pending')
  t.is((await gated.web.request('log.read', {})).entries.length, 1, 'nothing appended')
  t.alike(await gated.web.request('sync.status'), { state: 'idle' }, 'no run left behind')
  t.absent(JSON.stringify(gated.web.events).includes('127.0.0.1'), 'no address in any event')
  t.alike(gated.internal, [], 'no internal error')
})

test('follows-changed from the sync is relayed as follows.changed and restarts the continuous run once per length', async (t) => {
  await testnet(t, 1)
  const { web } = await certified(t, { syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const { runId } = await web.request('sync.start', {})
  t.alike(await web.request('sync.status'), { state: 'running', runId, once: false })
  const changes = () => web.events.filter((e) => e.name === 'follows.changed').map((e) => e.data)
  const startedCount = () => web.events.filter((e) => e.name === 'sync.started').length

  let onEvent = liveRuns[liveRuns.length - 1]
  onEvent({ event: 'follows-changed', count: 2, length: 7 })
  await until(() => startedCount() === 2, { name: 'reinício', timeoutMs: 5000 })
  t.alike(changes(), [{ count: 2 }], 'the count reached the page')
  t.ok(web.events.some((e) => e.name === 'sync.stopped' && e.data.runId === runId && e.data.reason === 'preempted'), 'the run was stopped as preempted')
  const second = await web.request('sync.status')
  t.alike(second, { state: 'running', runId: runId + 1, once: false }, 'and restarted')

  // The same length again (the restarted run folds the same diary): the
  // count is relayed, nothing restarts.
  onEvent = liveRuns[liveRuns.length - 1]
  onEvent({ event: 'follows-changed', count: 2, length: 7 })
  onEvent({ event: 'follows-changed', count: 3, length: 7 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.alike(changes(), [{ count: 2 }, { count: 2 }, { count: 3 }])
  t.is(startedCount(), 2, 'no restart for a length already restarted for')
  t.alike(await web.request('sync.status'), second, 'the same run')

  // New lengths in a burst: every count is relayed, one restart (for the
  // last length); a diagnostic media-pushed event makes no line.
  const linesBefore = web.events.filter((e) => e.name === 'sync.event').length
  onEvent({ event: 'media-pushed', key: 'ab'.repeat(32), length: 5 })
  onEvent({ event: 'follows-changed', count: 3, length: 8 })
  onEvent({ event: 'follows-changed', count: 3, length: 9 })
  await until(() => startedCount() === 3, { name: 'segundo reinício', timeoutMs: 5000 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(startedCount(), 3, 'one restart for the burst')
  t.is(web.events.filter((e) => e.name === 'sync.event').length, linesBefore, 'no line for media-pushed')
  t.alike(changes(), [{ count: 2 }, { count: 2 }, { count: 3 }, { count: 3 }, { count: 3 }])
  const third = await web.request('sync.status')
  t.alike(third, { state: 'running', runId: runId + 2, once: false })
  // A malformed event is dropped whole: neither relayed nor a restart.
  onEvent = liveRuns[liveRuns.length - 1]
  onEvent({ event: 'follows-changed', count: -1, length: 10 })
  onEvent({ event: 'follows-changed', count: 1, length: 'x' })
  onEvent({ event: 'follows-changed', count: '1', length: 11 })
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.is(changes().length, 5, 'nothing relayed')
  t.is(startedCount(), 3, 'no restart')
  t.alike(await web.request('sync.status'), third, 'the same run')
  t.alike(await web.request('sync.stop'), { stopped: true })

  // A once run relays the count and is never restarted.
  const once = await web.request('sync.start', { once: true, timeoutMs: 2000 })
  onEvent = liveRuns[liveRuns.length - 1]
  onEvent({ event: 'follows-changed', count: 1, length: 11 })
  const stopped = await stoppedOf(web.events, once.runId)
  t.is(stopped.reason, 'timeout', 'the once run ran to its end')
  t.alike(changes().slice(-1), [{ count: 1 }])
  t.is(startedCount(), 4, 'no run started by the fold')
  t.alike(await web.request('sync.status'), { state: 'idle' })
})

test('reset removes the media cores, the pending follows and the migration marker; follows stay', async (t) => {
  await testnet(t, 1)
  const s = await certified(t)
  const d = await upload(s.node, image(2000).bytes)
  const coreName = store.mediaName(d.core)
  t.ok(await s.storage.hasCore(coreName))
  t.alike(await s.web.request('follow.add', { key: 'ab'.repeat(32) }), { changed: true, followCount: 1 })
  t.is((await s.web.request('log.read', {})).entries.length, 3, 'the drain appended the follow once (cert, media-core, follow)')
  t.alike(await store.readFollowsPending(s.storage), [])
  t.alike(await s.node.confirmLegacyFollows([]), { published: 0 }, 'nothing legacy: the decision only sets the marker')
  t.ok(await s.storage.readJson('followsMigrated'), 'decided on this device')
  // A change that could not drain yet (a signed op left in the queue).
  await store.writeFollows(s.storage, ['ab'.repeat(32), 'cd'.repeat(32)])
  await store.writeFollowsPending(s.storage, [member.signFollowOp({ key: 'cd'.repeat(32), on: true, at: new Date().toISOString() }, s.key, s.keyPair)])
  t.is((await store.readFollowsPending(s.storage)).length, 1, 'one change pending')

  await s.node.reset()
  t.absent(await s.storage.hasCore('diary'), 'the diary is gone')
  t.absent(await s.storage.hasCore(coreName), 'the media core is gone')
  t.is(await s.storage.readJson('mediaCores'), null)
  t.alike(await store.readMediaCores(s.storage), [])
  t.alike(await store.readFollowsPending(s.storage), [], 'no pending change survives')
  t.is(await s.storage.readJson('followsMigrated'), null, 'the next identity is offered this device\'s follows again')
  t.alike(await store.readFollows(s.storage), ['ab'.repeat(32), 'cd'.repeat(32)], 'follows stay')
  t.ok(await s.storage.readJson('config'), 'config stays')
  t.alike(await s.node.identityStatus(), { exists: false, publicKey: null, legacy: false, unlocked: false, synced: false })

  // The same pair again: a new diary; the kept follows reach it only once
  // the person confirms them (the dropped pending change is covered by the
  // legacy list).
  await s.node.setKeyPair(s.keyPair, { media: s.mediaKeyPair })
  t.is((await s.web.request('identity.create')).publicKey, s.key)
  await s.web.request('cert.add', { cert: createCert({ member: s.key }, s.assoc.kp) })
  t.alike((await s.web.request('log.read', {})).entries.map((e) => e.seq), [0], 'nothing published automatically')
  t.alike(await s.node.legacyFollows(), { keys: ['ab'.repeat(32), 'cd'.repeat(32)] }, 'offered for confirmation')
  t.alike(await s.node.confirmLegacyFollows(['ab'.repeat(32), 'cd'.repeat(32)]), { published: 2 })
  const log = await s.web.request('log.read', {})
  t.alike(log.entries.map((e) => [e.seq, e.record.type]), [[0, 'member-cert'], [1, 'follow'], [2, 'follow']], 'the confirmed follows reached the new diary')
  t.alike(log.entries.slice(1).map((e) => [e.record.key, e.record.on]), [['ab'.repeat(32), true], ['cd'.repeat(32), true]])
  t.ok(await s.storage.readJson('followsMigrated'))
  const again = await upload(s.node, image(10).bytes)
  t.alike([again.core, again.start], [d.core, 1], 'a fresh media core for the same device key')
  t.alike(s.internal, [], 'no internal error')
})
