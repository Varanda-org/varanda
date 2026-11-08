'use strict'

// Momentos end to end (docs/rpc.md 5.103): the real Seeder with the dm and
// blob options behind a WebSocket server (GET /blob/<id>/<index> on the same
// port), and real browser nodes (lib/node.js over in-memory storage) with
// fixed PRFs. moment.putMedia seals a fresh public blob, moment.create
// accepts only such an item, moments.read folds the own and followed
// diaries (24 h window), moment.delete tombstones, and momentReadMedia
// fetches and verifies the photo. Local DHT and tmp dirs only.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const dmCore = require('@varanda/core/lib/dm')
const postage = require('@varanda/core/lib/dm-postage')
const { MOMENT_TTL_MS } = require('@varanda/core/lib/moments')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')

const ITEM_KEYS = ['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms']
const STALE = { code: 'USAGE', message: 'prepare a mídia de novo' }
const GONE = { code: 'NOT_FOUND', message: 'foto indisponível' }
const BAD_REF = { code: 'USAGE', message: 'referência inválida' }

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

function rsaKey () {
  const { privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  const n = fromBase64url(jwk.n)
  return { kid: postage.kidOf(n), n: n.toString(10), e: '65537', d: fromBase64url(jwk.d).toString(10) }
}

// As dm-e2e.test.js: host.blobGone answers 404 (the pool swept),
// host.blobTamper flips one byte of every frame body (same length).
async function seederHost (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-moments-e2e-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-moments-e2e-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const key = rsaKey()
  const blobKey = rsaKey()
  const host = { dataDir, current: null, blobGone: false, blobTamper: false }
  const seeder = new Seeder({
    dataDir,
    associationKey: assoc.hex,
    ...localSwarmOptions(bootstrap),
    log: noop,
    dm: { postage: { get: async () => ({ keys: [key] }) }, blobPostage: { get: async () => ({ keys: [blobKey] }) } }
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  host.current = seeder
  const server = http.createServer((req, res) => {
    const m = /^\/blob\/([0-9a-f]{64})\/(0|[1-9][0-9]{0,2})$/.exec(req.url)
    let frame = m && !host.blobGone ? host.current.blobChunk(m[1], Number(m[2])) : null
    if (frame === null) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('não encontrado')
      return
    }
    if (host.blobTamper) {
      frame = b4a.from(frame)
      frame[frame.byteLength - 1] ^= 0xff
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': frame.byteLength })
    res.end(frame)
  })
  const wss = new WebSocketServer({ server })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(async () => {
    for (const s of wss.clients) s.terminate()
    await new Promise((resolve) => wss.close(() => resolve()))
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', noop)
    host.current.acceptStream(raw)
  })
  host.url = 'ws://127.0.0.1:' + server.address().port + '/seeder'
  return host
}

async function wallet (storage) {
  const w = await storage.readJson('dmStamps')
  return w && Array.isArray(w.items) ? w.items.length : 0
}

async function push (t, n, host) {
  let stopped = null
  for (let i = 0; i < 5; i++) {
    const { runId } = await n.web.request('sync.start', { once: true, timeoutMs: 30000 })
    stopped = await stoppedOf(n.web.events, runId)
    if (stopped.reason === 'done' && stopped.result && stopped.result.ok === true && stopped.result.seederConfirmed === true) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  t.is(stopped.result && stopped.result.seederConfirmed, true, 'the seeder holds the diary')
  await until(() => host.current._served.has(n.key) || host.current._admitted.has(n.key), { name: 'served', timeoutMs: 30000 })
}

async function memberNode (t, assoc, host, { enable = true } = {}) {
  const storage = memoryNodeStorage()
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: host.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, dm: { topUpRetryMs: 100, blob: { wallet: 16, walletLow: 8, issuePaceMs: 0 } } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf: crypto.randomBytes(32) })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  const n = { node, web, storage, key: publicKey }
  if (enable) {
    await push(t, n, host)
    await web.request('dm.enable')
    await until(async () => (await wallet(storage)) >= dmCore.DM_STAMP_WALLET, { name: 'wallet', timeoutMs: 60000 })
  }
  return n
}

// Copies `from`'s diary into `to`'s storage as a stored replica.
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

// A PNG header of 64 x 48 and `size` random IDAT bytes.
function png (size) {
  const out = b4a.alloc(8 + 25 + 12 + size)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  out.writeUInt32BE(13, 8)
  out.write('IHDR', 12, 'ascii')
  out.writeUInt32BE(64, 16)
  out.writeUInt32BE(48, 20)
  out[24] = 8
  out[25] = 6
  out.writeUInt32BE(size, 33)
  out.write('IDAT', 37, 'ascii')
  nodeCrypto.randomFillSync(out, 41, size)
  return out
}

async function failure (p) {
  try {
    await p
  } catch (err) {
    return { code: err.code, message: err.message }
  }
  return null
}

// Runs fn with Date.now moved `ms` ahead (the readers' clock only).
async function later (ms, fn) {
  const realNow = Date.now
  Date.now = () => realNow() + ms
  try {
    return await fn()
  } finally {
    Date.now = realNow
  }
}

test('momentos end to end: put, create, read, 24 h window, follower, photo, tampering, delete', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc)
  const A = await memberNode(t, assoc, host)
  const B = await memberNode(t, assoc, host, { enable: false })

  // Arguments are checked synchronously and the caller's buffer is wiped.
  t.exception.all(() => A.node.momentPutMedia({ bytes: png(10), mime: 'audio/mp4', width: 64, height: 48 }), /mídia inválida/)
  t.exception.all(() => A.node.momentPutMedia({ bytes: png(10), mime: 'image/png', width: 0, height: 48 }), /mídia inválida/)
  t.exception.all(() => A.node.momentReadMedia({ author: 'x', seq: 1 }), /mídia inválida/)
  const photo = png(40000)
  const plain = b4a.from(photo)
  const item = await A.node.momentPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48 })
  t.ok(photo.every((b) => b === 0), 'the caller copy is wiped')
  t.alike(Object.keys(item), ITEM_KEYS, 'the moment media item')
  t.alike([item.mime, item.w, item.h, item.ms, item.chunks], ['image/png', 64, 48, 0, 2])
  const again = await A.node.momentPutMedia({ bytes: b4a.from(plain), mime: 'image/png', width: 64, height: 48 })
  t.not(again.id, item.id, 'the same photo again is a fresh blob')
  t.not(again.key, item.key, 'with a fresh key')

  // Only an item this node's momentPutMedia answered in this unlock.
  t.alike(await failure(A.web.request('moment.create', { text: 'oi', media: { ...item, key: 'ab'.repeat(32) } })), STALE, 'a forged key')
  const dmItem = await A.node.dmPutMedia({ bytes: b4a.from(plain), mime: 'image/png', width: 64, height: 48, to: B.key })
  t.alike(await failure(A.web.request('moment.create', { text: 'oi', media: dmItem })), STALE, 'a DM item')
  t.alike(await failure(B.web.request('moment.create', { text: 'oi', media: item })), STALE, 'an item another node answered')

  const created = await A.web.request('moment.create', { text: 'agora', media: item })
  t.alike(Object.keys(created), ['seq', 'ref'])
  t.is(created.ref, A.key + ':' + created.seq)
  t.alike(await failure(A.web.request('moment.create', { text: 'de novo', media: item })), STALE, 'a published item is not offered twice')
  const post = await A.web.request('post.create', { text: 'publicação' })

  const r1 = await A.web.request('moments.read', {})
  t.alike(r1.authors, [], 'the own key is never in authors')
  t.is(r1.own.length, 1)
  t.alike(r1.own[0], { seq: created.seq, ref: created.ref, text: 'agora', at: r1.own[0].at, media: item })
  t.alike(r1.past, [])

  // The photo, from the record's public key and nonce.
  const got = await A.node.momentReadMedia({ author: A.key, seq: created.seq })
  t.alike([got.mime, got.w, got.h], ['image/png', 64, 48])
  t.ok(b4a.equals(b4a.from(got.bytes), plain), 'the plaintext')
  t.alike(await failure(A.node.momentReadMedia({ author: A.key, seq: post.seq })), GONE, 'a post is not a moment')

  // A follower reads it from its stored replica, no DM key needed for the photo.
  await B.web.request('follow.add', { key: A.key })
  await copyDiary(A, B)
  const r2 = await B.web.request('moments.read', {})
  t.alike(r2.authors.map((a) => a.author), [A.key])
  t.alike(r2.authors[0].items.map((i) => [i.seq, i.text]), [[created.seq, 'agora']])
  t.alike(r2.authors[0].items[0].media, item)
  t.alike([r2.own, r2.past], [[], []])
  const seen = await B.node.momentReadMedia({ author: A.key, seq: created.seq })
  t.ok(b4a.equals(b4a.from(seen.bytes), plain), 'the follower opens the photo')

  // A tampered blob (its sha256 no longer matches) and a swept one.
  host.blobTamper = true
  t.alike(await failure(B.node.momentReadMedia({ author: A.key, seq: created.seq })), GONE, 'tampered')
  host.blobTamper = false
  host.blobGone = true
  t.alike(await failure(B.node.momentReadMedia({ author: A.key, seq: created.seq })), GONE, 'gone from the pool')
  host.blobGone = false

  // After 24 h: hidden for every reader, listed in the author's past.
  await later(MOMENT_TTL_MS + 1000, async () => {
    const own = await A.web.request('moments.read', {})
    t.alike(own.own, [], 'expired for the author')
    t.alike(own.past, [{ seq: created.seq, ref: created.ref, text: 'agora', at: r1.own[0].at }], 'in the past, no media')
    t.alike((await B.web.request('moments.read', {})).authors, [], 'expired for the follower')
    t.alike(await failure(B.node.momentReadMedia({ author: A.key, seq: created.seq })), GONE, 'no photo once expired')
  })

  // Delete: only an own moment; a second delete answers the tombstone.
  t.alike(await failure(A.web.request('moment.delete', { to: post.ref })), BAD_REF, 'a post')
  t.alike(await failure(A.web.request('moment.delete', { to: B.key + ':1' })), BAD_REF, 'another author')
  const del = await A.web.request('moment.delete', { to: created.ref })
  t.alike(Object.keys(del), ['seq', 'deleted'])
  t.alike(del.deleted, [created.seq])
  t.alike(await A.web.request('moment.delete', { to: created.ref }), del, 'the second delete answers the tombstone')
  const r3 = await A.web.request('moments.read', {})
  t.alike([r3.own, r3.past], [[], []], 'gone after delete')
  await later(MOMENT_TTL_MS + 1000, async () => {
    t.alike((await A.web.request('moments.read', {})).past, [], 'not in the past either')
  })
  await copyDiary(A, B)
  t.alike((await B.web.request('moments.read', {})).authors, [], 'the follower sees the delete')
})
