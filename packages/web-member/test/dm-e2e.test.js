'use strict'

// Direct messages end to end: the real Seeder with the dm option (its pool
// on disk, the stamp channel with a test postage key generated here) behind
// a WebSocket server, and real browser nodes (lib/node.js over in-memory
// storage) with fixed PRFs. Local DHT and tmp dirs only.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { generateNoiseKeyPair, attachAdmission } = require('@varanda/core/lib/net')
const { attachDm } = require('@varanda/core/lib/dm-net')
const dmCore = require('@varanda/core/lib/dm')
const postage = require('@varanda/core/lib/dm-postage')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { dmBoxKeyPairFromPrf, dmLocalKeyFromPrf } = require('../lib/passkey')
const gc = require('@varanda/core/lib/group-crypto')
const { wsStream } = require('../lib/ws-stream')
const store = require('../lib/node-store')

const HEX64 = /[0-9a-f]{64}/

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

// The postage key as the operator's file holds it (decimal strings).
function rsaKey () {
  const { privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  const n = fromBase64url(jwk.n)
  return { kid: postage.kidOf(n), n: n.toString(10), e: '65537', d: fromBase64url(jwk.d).toString(10) }
}

// One WebSocket entry whose connections go to the seeder of the moment, so
// the nodes keep their seederUrl across a restart.
// blob: also a blob postage key (the blob pool and channel), and GET
// /blob/<id>/<index> on the same port, answered from Seeder#blobChunk unless
// host.blobGone (the pool swept); host.blobShort cuts every frame body
// short, with no Content-Length (a body that ended early).
async function seederHost (t, bootstrap, assoc, { blob = false } = {}) {
  const dataDir = tmpDir(t, 'varanda-dm-e2e-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-dm-e2e-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const key = rsaKey()
  const blobKey = blob ? rsaKey() : null
  // blobDelayMs > 0 holds every blob answer that long, so blobPeak (the most
  // GETs in flight at once) shows how many opens run together.
  const host = { dataDir, events: [], current: null, blobGone: false, blobShort: false, blobGets: 0, blobDelayMs: 0, blobActive: 0, blobPeak: 0 }
  host.start = async () => {
    const seeder = new Seeder({
      dataDir,
      associationKey: assoc.hex,
      ...localSwarmOptions(bootstrap),
      log: (e) => host.events.push(e),
      dm: { postage: { get: async () => ({ keys: [key] }) }, ...(blob ? { blobPostage: { get: async () => ({ keys: [blobKey] }) } } : {}) }
    })
    t.teardown(() => seeder.close(), { force: true })
    await seeder.start()
    host.current = seeder
    return seeder
  }
  const server = http.createServer(async (req, res) => {
    host.blobGets++
    if (host.blobDelayMs > 0 && req.url.startsWith('/blob/')) {
      host.blobActive++
      host.blobPeak = Math.max(host.blobPeak, host.blobActive)
      await new Promise((resolve) => setTimeout(resolve, host.blobDelayMs))
      host.blobActive--
    }
    const m = /^\/blob\/([0-9a-f]{64})\/(0|[1-9][0-9]{0,2})$/.exec(req.url)
    const frame = m && !host.blobGone && host.current !== null ? host.current.blobChunk(m[1], Number(m[2])) : null
    if (frame === null) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('não encontrado')
      return
    }
    if (host.blobShort) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(frame.subarray(0, frame.byteLength - 100))
      return
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
    if (host.current === null) raw.destroy()
    else host.current.acceptStream(raw)
  })
  host.url = 'ws://127.0.0.1:' + server.address().port + '/seeder'
  await host.start()
  return host
}

async function wallet (storage) {
  const w = await storage.readJson('dmStamps')
  return w && Array.isArray(w.items) ? w.items.length : 0
}

// A confirmed push: the seeder admits and serves the diary, which is what
// its stamp channel asks before issuing (an unknown diary gets 'teto').
async function push (t, n, host) {
  let stopped = null
  for (let i = 0; i < 5; i++) {
    const { runId } = await n.web.request('sync.start', { once: true, timeoutMs: 30000 })
    stopped = await stoppedOf(n.web.events, runId)
    if (stopped.reason === 'done' && stopped.result && stopped.result.ok === true && stopped.result.seederConfirmed === true) break
    t.comment('push attempt ' + (i + 1) + ' not confirmed: ' + JSON.stringify(stopped))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  t.is(stopped.result && stopped.result.seederConfirmed, true, 'the seeder holds the diary')
  await until(() => host.current._served.has(n.key) || host.current._admitted.has(n.key), { name: 'served', timeoutMs: 30000 })
}

// offline(): true -> every new socket goes to a closed port.
async function memberNode (t, assoc, host, { keyPair = crypto.keyPair(), prf = crypto.randomBytes(32), enable = true, blob = {}, storage = memoryNodeStorage(), offline = () => false } = {}) {
  const url = host.url
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(offline() ? 'ws://127.0.0.1:1/seeder' : u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, dm: { topUpRetryMs: 100, blob } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  const cert = createCert({ member: publicKey }, assoc.kp)
  await web.request('cert.add', { cert })
  const n = { node, web, storage, key: publicKey, keyPair, prf, cert, enabled: null }
  if (enable) {
    await push(t, n, host)
    n.enabled = await web.request('dm.enable')
    await until(async () => (await wallet(storage)) >= dmCore.DM_STAMP_WALLET, { name: 'wallet', timeoutMs: 60000 })
  }
  return n
}

// Copies `from`'s diary into `to`'s storage as a stored replica (what a
// follow or a peek would have read), in process.
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

// An anonymous dm link as a member opens one: fresh Noise key, empty
// inventory, the drop channel.
async function rawDm (t, url) {
  const ws = new WebSocket(url)
  ws.on('error', noop)
  const noise = new NoiseSecretStream(true, wsStream(ws), { keyPair: generateNoiseKeyPair() })
  noise.on('error', noop)
  t.teardown(() => noise.destroy(), { force: true })
  await new Promise((resolve, reject) => {
    noise.once('connect', resolve)
    noise.once('close', () => reject(new Error('link fechado')))
  })
  Hypercore.createProtocolStream(noise)
  const ch = attachDm(noise, { role: 'member' })
  attachAdmission(noise, { role: 'member', have: [] })
  t.is(await ch.supported, true, 'the seeder serves the dm channel')
  return ch
}

// Takes `n` stamps out of a node's wallet (spent here, never by the node).
// The wallet is sealed under the local key of the node's PRF.
async function takeStamps (node, n) {
  const storage = node.storage
  const key = await dmLocalKeyFromPrf(node.prf)
  const w = await store.readDmStamps(storage)
  const taken = w.items.slice(0, n).map((s) => ({ kid: s.kid, ...gc.openRecord({ nonce: s.nonce, box: s.box }, key) }))
  await store.writeDmStamps(storage, { items: w.items.slice(n), kids: w.kids })
  return taken
}

function dropOf (sealed, stamp) {
  return dmCore.encodeDrop({
    dropId: dmCore.newDropId(),
    kid: b4a.from(stamp.kid, 'hex'),
    rsaSig: b4a.from(stamp.sig, 'base64'),
    token: b4a.from(stamp.token, 'hex'),
    sealed
  })
}

function filesUnder (dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

// Neither the pool on disk nor the seeder log names a member: the raw key
// bytes and the hex form are both searched for.
function assertNoMemberKey (t, host, members, label) {
  const poolDir = path.join(host.dataDir, 'dm-pool')
  t.ok(fs.existsSync(poolDir), label + ': pool dir exists')
  const files = filesUnder(poolDir)
  t.ok(files.length > 0, label + ': pool has files')
  for (const f of files) {
    const bytes = fs.readFileSync(f)
    for (const m of members) {
      t.is(b4a.indexOf(bytes, b4a.from(m.key, 'hex')), -1, label + ': no raw member key in ' + path.basename(f))
      t.is(b4a.indexOf(bytes, b4a.from(m.key)), -1, label + ': no hex member key in ' + path.basename(f))
    }
  }
  const dmLines = host.events.filter((e) => e && typeof e.event === 'string' && e.event.startsWith('dm'))
  t.ok(dmLines.length > 0, label + ': the dm channel logged')
  for (const e of dmLines) t.absent(HEX64.test(JSON.stringify(e)), label + ': no hex64 on a dm log line')
  const log = JSON.stringify(dmLines)
  for (const m of members) t.absent(log.includes(m.key), label + ': no member key on the dm channel log')
}

test('dm end to end against the real seeder', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc)

  // Enable: the box published comes from the PRF; stamps from the top-up.
  const A = await memberNode(t, assoc, host)
  const B = await memberNode(t, assoc, host)
  const boxB = await dmBoxKeyPairFromPrf(B.prf, 1)
  t.alike(B.enabled, { box: hex(boxB.publicKey), gen: 1, seq: 1 }, 'dm.enable publishes the PRF box')
  const budget = JSON.parse(fs.readFileSync(path.join(host.dataDir, 'dm-stamps.json'), 'utf8'))
  // v2 file: { days: { diary: { 'YYYY-MM-DD': count } } } (protocol section 11).
  for (const n of [A, B]) {
    const days = budget.days[n.key] || {}
    const issued = Object.values(days).reduce((sum, count) => sum + count, 0)
    t.ok(issued >= dmCore.DM_STAMP_WALLET, 'the seeder issued the wallet top-up')
  }

  // Lookup: A reads B's dm-key from B's diary.
  await copyDiary(B, A)
  await copyDiary(A, B)
  t.alike(await A.web.request('dm.lookup', { member: B.key }), { box: hex(boxB.publicKey), gen: 1 }, 'lookup answers the box')

  // Send and pull as a request (B follows nobody).
  const sent = await A.web.request('dm.send', { to: B.key, text: 'oi' })
  t.ok(/^[0-9a-f]{32}$/.test(sent.id))
  const p1 = await B.web.request('dm.pull')
  t.is(p1.added, 1, 'B files one message')
  t.is((await B.web.request('dm.list', {})).conversations.length, 0, 'not in the inbox')
  const req = await B.web.request('dm.list', { folder: 'request' })
  t.is(req.conversations.length, 1)
  t.is(req.conversations[0].peer, A.key)
  t.is(req.conversations[0].preview, 'oi')
  t.is((await B.web.request('dm.thread', { peer: A.key })).folder, 'request')

  // Accept, then reply with replyTo.
  await B.web.request('dm.set', { peer: A.key, state: 'accepted' })
  const inbox = await B.web.request('dm.list', {})
  t.is(inbox.conversations.length, 1, 'accepted: in the inbox')
  t.is(inbox.conversations[0].peer, A.key)
  const reply = await B.web.request('dm.send', { to: A.key, text: 'olá', replyTo: sent.id })
  t.is((await A.web.request('dm.pull')).added, 1, 'A files the reply')
  const ta = await A.web.request('dm.thread', { peer: B.key })
  const got = ta.messages.find((m) => m.id === reply.id)
  t.ok(got, 'the reply is in A\'s thread')
  t.is(got.text, 'olá')
  t.is(got.replyTo, sent.id, 'replyTo crossed')
  t.is(got.from, B.key)
  t.ok(typeof got.at === 'string' && got.at <= new Date().toISOString(), 'at is the effective time')

  // A third identity reads the same pool and opens nothing.
  const C = await memberNode(t, assoc, host)
  t.is((await C.web.request('dm.pull')).added, 0, 'C adds nothing')
  t.is((await C.web.request('dm.list', { folder: 'request' })).conversations.length, 0)

  // A put without a valid stamp is refused; a stamp from the wallet is kept.
  const ch = await rawDm(t, host.url)
  const forged = dropOf(crypto.randomBytes(dmCore.DM_SEALED_BYTES), { kid: (await store.readDmStamps(C.storage)).kids[0], sig: b4a.toString(crypto.randomBytes(256), 'base64'), token: hex(crypto.randomBytes(32)) })
  t.alike(await ch.put(forged), { ok: false, reason: 'invalido' }, 'no valid stamp: invalido')

  // A throwaway key, without a certificate or with one of another
  // association, stamps and puts a message to B: the seeder stores it (it
  // never sees the sender), B opens and files nothing.
  const throwaway = crypto.keyPair()
  const otherAssoc = generateAssociationKeyPair()
  for (const cert of [undefined, createCert({ member: hex(throwaway.publicKey) }, otherAssoc)]) {
    const junk = dmCore.sealInner(dmCore.buildInner({ kind: 'msg', to: B.key, text: 'descartável', cert }, throwaway), hex(boxB.publicKey))
    const [s] = await takeStamps(C, 1)
    t.alike(await ch.put(dropOf(junk, s)), { ok: true, reason: null }, 'the pool takes the drop')
  }
  t.is((await B.web.request('dm.pull')).added, 0, 'a throwaway key without a valid certificate adds 0')

  // A future-dated message from C, filed before B declines, stays hidden:
  // the decline cuts on filedAt, not on the sender's at.
  await copyDiary(B, C)
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
  const inner = dmCore.buildInner({ kind: 'msg', id: dmCore.newMessageId(), at: future, to: B.key, text: 'do futuro', replyTo: null, cert: C.cert }, C.keyPair)
  const sealed = dmCore.sealInner(inner, hex(boxB.publicKey))
  const [stamp] = await takeStamps(C, 1)
  t.alike(await ch.put(dropOf(sealed, stamp)), { ok: true, reason: null }, 'a wallet stamp is accepted')
  t.is((await B.web.request('dm.pull')).added, 1, 'B files the request from C')
  const cRow = (await B.web.request('dm.list', { folder: 'request' })).conversations.find((c) => c.peer === C.key)
  t.ok(cRow, 'C is a request')
  t.ok(cRow.at < future, 'the listed time is the effective time, not the future at')
  await B.web.request('dm.set', { peer: C.key, state: 'declined' })
  t.absent((await B.web.request('dm.list', { folder: 'request' })).conversations.some((c) => c.peer === C.key), 'declined: the future-dated request is hidden')
  t.is((await B.web.request('dm.thread', { peer: C.key })).messages.length, 0, 'and its thread is empty')

  assertNoMemberKey(t, host, [A, B, C], 'before restart')

  // Restart: the pool and B's cursor survive.
  await host.current.close()
  host.current = null
  await host.start()
  t.is((await B.web.request('dm.pull')).added, 0, 'after restart the cursor holds: nothing new')

  // A fresh device of B (same passkey PRF) reads everything again.
  const B2 = await memberNode(t, assoc, host, { keyPair: B.keyPair, prf: B.prf, enable: false })
  // C's future-dated message files too; the decline after it in the pool
  // hides it again.
  t.is((await B2.web.request('dm.pull')).added, 3, 'A\'s message, B\'s sent copy and C\'s request')
  const t2 = await B2.web.request('dm.thread', { peer: A.key })
  t.alike(t2.messages.map((m) => [m.text, m.mine]).sort(), [['oi', false], ['olá', true]], 'the sent copy is mine under peer A')
  t.is(t2.folder, 'inbox', 'the accepted ctl reached the new device')
  t.is((await B2.web.request('dm.thread', { peer: C.key })).messages.length, 0, 'the decline reached it too')

  // Delete on B propagates to B2 after a pull; A keeps its copy.
  await B.web.request('dm.set', { peer: A.key, state: 'deleted' })
  t.is((await B.web.request('dm.list', {})).conversations.length, 0, 'deleted on this device')
  await B2.web.request('dm.pull')
  t.is((await B2.web.request('dm.list', {})).conversations.length, 0, 'deleted on the other device')
  t.is((await B2.web.request('dm.thread', { peer: A.key })).messages.length, 0)
  t.is((await A.web.request('dm.thread', { peer: B.key })).messages.length, 2, 'A keeps the thread')

  // Block: the seeder takes A's next message, B files nothing.
  await B.web.request('dm.set', { peer: A.key, state: 'blocked' })
  const kept = host.events.filter((e) => e.event === 'dm' && e.reason === 'guardada').length
  await A.web.request('dm.send', { to: B.key, text: 'de novo' })
  t.is(host.events.filter((e) => e.event === 'dm' && e.reason === 'guardada').length, kept + 2, 'the seeder stored both drops')
  t.is((await B.web.request('dm.pull')).added, 0, 'blocked: nothing added')
  await B2.web.request('dm.pull')
  t.is((await B2.web.request('dm.thread', { peer: A.key })).messages.length, 0, 'nor shown on the other device')
  t.is((await B2.web.request('dm.list', {})).conversations.length, 0)
  t.is((await B2.web.request('dm.list', { folder: 'request' })).conversations.length, 0)

  assertNoMemberKey(t, host, [A, B, C], 'after restart')
})

// A PNG header the media bounds accept, then `size` random IDAT bytes.
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

async function rejection (p) {
  try {
    await p
  } catch (err) {
    return err
  }
  return null
}

test('dm media end to end: photo with caption and photo only, the sealed cache outlives the pool, a lock wipes it', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const blob = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
  const A = await memberNode(t, assoc, host, { blob })
  const B = await memberNode(t, assoc, host, { blob })
  await copyDiary(B, A)
  await copyDiary(A, B)

  // A photo of two chunks with a caption, and a photo-only message.
  const photo = png(40000)
  const item = await A.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: B.key })
  t.alike(Object.keys(item), ['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms'], 'the media item, nonce included')
  t.is(item.chunks, 2)
  t.alike([item.mime, item.w, item.h, item.ms], ['image/png', 64, 48, 0])
  t.is(fs.readdirSync(path.join(host.dataDir, 'blobs')).length > 0, true, 'the seeder holds the blob')
  const again = await A.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: B.key })
  t.alike(again, item, 'the same photo again reuses its sealed blob')
  const sent = await A.web.request('dm.send', { to: B.key, text: 'legenda', media: [item] })
  const small = png(1000)
  const item2 = await A.node.dmPutMedia({ bytes: small, mime: 'image/png', width: 64, height: 48, to: B.key })
  const sent2 = await A.web.request('dm.send', { to: B.key, text: '', media: [item2] })
  const la = await A.web.request('dm.list', {})
  t.is(la.conversations[0].preview, 'Foto', 'a photo-only message previews as Foto, never a key')

  // The same caption with other photos is another message, never the first.
  const p1 = await A.node.dmPutMedia({ bytes: png(300), mime: 'image/png', width: 64, height: 48, to: B.key })
  const p2 = await A.node.dmPutMedia({ bytes: png(301), mime: 'image/png', width: 64, height: 48, to: B.key })
  const [s1, s2] = await Promise.all([
    A.web.request('dm.send', { to: B.key, text: 'mesma', media: [p1] }),
    A.web.request('dm.send', { to: B.key, text: 'mesma', media: [p2] })
  ])
  t.not(s1.id, s2.id, 'two sends with one caption and different media are two messages')

  // An item this node did not put, or one already sent, is refused.
  const forged = { ...item2, key: 'ab'.repeat(32) }
  t.is((await rejection(A.web.request('dm.send', { to: B.key, text: 'x', media: [forged] }))).message, 'prepare a mídia de novo')
  t.is((await rejection(A.web.request('dm.send', { to: B.key, text: 'x', media: [item] }))).message, 'prepare a mídia de novo', 'a sent blob is forgotten')

  // The sender's thread: the descriptors, and its own bytes cached at send.
  const ta = await A.web.request('dm.thread', { peer: B.key })
  t.alike(ta.messages.map((m) => [m.text, m.media]), [['legenda', [item]], ['', [item2]], ['mesma', [p1]], ['mesma', [p2]]])
  const gets = host.blobGets
  const own = await A.node.dmReadMedia({ from: A.key, id: sent.id, index: 0 })
  t.ok(b4a.equals(own.bytes, photo), 'the sender reads its photo')
  t.is(own.mime, 'image/png')
  t.is(host.blobGets, gets, 'from its cache, without a download')

  // The recipient files the descriptors; previews name the photo, not a key.
  t.is((await B.web.request('dm.pull')).added, 4)
  const list = await B.web.request('dm.list', { folder: 'request' })
  t.is(list.conversations[0].preview, 'mesma')
  const tb = await B.web.request('dm.thread', { peer: A.key })
  t.alike(tb.messages.slice(0, 2).map((m) => [m.id, m.text, m.media]), [[sent.id, 'legenda', [item]], [sent2.id, '', [item2]]], 'the stored rows keep the media items')
  const got = await B.node.dmReadMedia({ from: A.key, id: sent.id, index: 0 })
  t.ok(b4a.equals(got.bytes, photo), 'the recipient opens the photo')

  // The pool sweeps: both photos were opened (a request thread fetches
  // nothing by itself, so by an explicit read) and still read; a photo never
  // opened before is unavailable.
  await B.node.dmReadMedia({ from: A.key, id: sent2.id, index: 0 })
  host.blobGone = true
  t.ok(b4a.equals((await B.node.dmReadMedia({ from: A.key, id: sent.id, index: 0 })).bytes, photo), 'the cache outlives the pool')
  t.ok(b4a.equals((await B.node.dmReadMedia({ from: A.key, id: sent2.id, index: 0 })).bytes, small), 'the lazily opened photo too')
  const item3 = await A.node.dmPutMedia({ bytes: png(500), mime: 'image/png', width: 64, height: 48, to: B.key })
  const sent3 = await A.web.request('dm.send', { to: B.key, text: 'tarde demais', media: [item3] })
  t.is((await B.web.request('dm.pull')).added, 1)
  t.is((await rejection(B.node.dmReadMedia({ from: A.key, id: sent3.id, index: 0 }))).message, 'mídia indisponível')
  const tc = await B.web.request('dm.thread', { peer: A.key })
  const tcRows = tc.messages.map((m) => [m.text, m.media])
  t.alike(tcRows[0], ['legenda', [item]])
  t.alike(tcRows[1], ['', [item2]])
  t.alike(tcRows[tcRows.length - 1], ['tarde demais', { unavailable: true }], 'a gone blob is unavailable, the text still returns')

  // At rest the cache is ciphertext under opaque names.
  const index = await B.storage.readJson('dmMediaIndex')
  t.ok(index.items.length >= 2)
  const entry = JSON.stringify(await B.storage.readJson('dmMedia/' + index.items[0].n + '/0'))
  t.absent(entry.includes(b4a.toString(photo.subarray(0, 300), 'base64').slice(0, 40)), 'no plaintext at rest')
  t.absent(JSON.stringify(index).includes(sent.id) || JSON.stringify(index).includes(A.key), 'no id or sender in kv names')

  // A lock wipes the cache: after the next unlock the swept photo is gone.
  await B.node.clearKeyPair()
  t.is(await B.storage.readJson('dmMediaIndex'), null, 'the lock wiped the index')
  t.is(await B.storage.readJson('dmMedia/' + index.items[0].n + '/0'), null, 'and the entry')
  await B.node.setKeyPair(B.keyPair, { prf: B.prf })
  t.is((await rejection(B.node.dmReadMedia({ from: A.key, id: sent.id, index: 0 }))).message, 'mídia indisponível')
  const td = await B.web.request('dm.thread', { peer: A.key })
  t.alike(td.messages[0].media, { unavailable: true })
  t.is(td.messages[0].text, 'legenda')
})

test('dm media from a stranger: a request fetches nothing until a tap, an accepted thread opens lazily, at most two opens at once', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const blob = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
  const A = await memberNode(t, assoc, host, { blob })
  const B = await memberNode(t, assoc, host, { blob })
  await copyDiary(B, A)
  await copyDiary(A, B)

  const photos = []
  const sent = []
  for (let i = 0; i < 6; i++) {
    photos.push(png(1000 + i))
    const item = await A.node.dmPutMedia({ bytes: photos[i], mime: 'image/png', width: 64, height: 48, to: B.key })
    sent.push(await A.web.request('dm.send', { to: B.key, text: 'foto ' + i, media: [item] }))
  }
  t.is((await B.web.request('dm.pull')).added, 6)

  // Opening the request shows every item and downloads none of them.
  const gets = host.blobGets
  const tr = await B.web.request('dm.thread', { peer: A.key })
  t.is(tr.folder, 'request')
  t.is(tr.messages.length, 6)
  t.ok(tr.messages.every((m) => Array.isArray(m.media) && m.media.length === 1), 'the items are listed')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await B.web.request('dm.thread', { peer: A.key })
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(host.blobGets, gets, 'no blob fetched for a request')

  // A tap opens that one photo only.
  const tapped = await B.node.dmReadMedia({ from: A.key, id: sent[0].id, index: 0 })
  t.ok(b4a.equals(tapped.bytes, photos[0]), 'the tapped photo opens')
  t.is(host.blobGets, gets + 1, 'one frame, one photo')

  // Accepted: the thread opens the rest lazily, never more than two at once.
  await B.web.request('dm.set', { peer: A.key, state: 'accepted' })
  host.blobDelayMs = 300
  const ta = await B.web.request('dm.thread', { peer: A.key })
  t.is(ta.folder, 'inbox')
  await until(() => host.blobGets >= gets + 6 && host.blobActive === 0, { name: 'lazy opens', timeoutMs: 60000 })
  t.is(host.blobPeak, 2, 'at most two opens run at once, and two do')
  host.blobDelayMs = 0
  host.blobGone = true
  for (let i = 1; i < 6; i++) {
    t.ok(b4a.equals((await B.node.dmReadMedia({ from: A.key, id: sent[i].id, index: 0 })).bytes, photos[i]), 'opened by the thread read, now from the cache')
  }
  t.is(host.blobGets, gets + 6, 'nothing fetched twice')

  // Lock still wipes what the lazy opens cached.
  await B.node.clearKeyPair()
  t.is(await B.storage.readJson('dmMediaIndex'), null, 'the lock wiped the cache')
})

test('dm media failures: a failed put keeps the photo for its retry, a short read stays retryable, a lock while caching returns no bytes', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const blob = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
  let offline = false
  const A = await memberNode(t, assoc, host, { blob, offline: () => offline })
  // B's first media cache write of a message runs onCache first, once.
  let onCache = null
  const base = memoryNodeStorage()
  const storage = {
    ...base,
    async writeJson (k, v) {
      if (onCache !== null && k.startsWith('dmMedia') && v !== null) {
        const f = onCache
        onCache = null
        await f()
      }
      return base.writeJson(k, v)
    }
  }
  const B = await memberNode(t, assoc, host, { blob, storage })
  await copyDiary(B, A)
  await copyDiary(A, B)

  // A put that fails after the photo was sealed, then the user's retry.
  const photo = png(40000)
  offline = true
  t.ok((await rejection(A.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: B.key }))) !== null, 'the put fails with the seeder unreachable')
  offline = false
  const item = await A.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: B.key })
  const sentLock = await A.web.request('dm.send', { to: B.key, text: 'trancar', media: [item] })
  const gets = host.blobGets
  const own = await A.node.dmReadMedia({ from: A.key, id: sentLock.id, index: 0 })
  t.ok(b4a.equals(own.bytes, photo), 'the sender cached its real photo, not zeros')
  t.is(host.blobGets, gets, 'without a download')
  const photo2 = png(2000)
  const item2 = await A.node.dmPutMedia({ bytes: photo2, mime: 'image/png', width: 64, height: 48, to: B.key })
  const sentShort = await A.web.request('dm.send', { to: B.key, text: 'curto', media: [item2] })
  t.is((await B.web.request('dm.pull')).added, 2)

  // A frame body that ended early is a transient error, never a gone blob.
  host.blobShort = true
  const short = await rejection(B.node.dmReadMedia({ from: A.key, id: sentShort.id, index: 0 }))
  t.ok(short !== null, 'the short read fails')
  t.not(short && short.message, 'mídia indisponível', 'not as a gone blob')
  host.blobShort = false
  const th = await B.web.request('dm.thread', { peer: A.key, limit: 1 })
  t.alike(th.messages.map((m) => m.media), [[item2]], 'the media stays retryable, not unavailable')
  t.ok(b4a.equals((await B.node.dmReadMedia({ from: A.key, id: sentShort.id, index: 0 })).bytes, photo2), 'the next read opens it')

  // A lock while the opened photo is being cached: no bytes come back.
  let locking = null
  onCache = async () => {
    locking = B.node.clearKeyPair()
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const locked = await rejection(B.node.dmReadMedia({ from: A.key, id: sentLock.id, index: 0 }))
  t.ok(locking !== null, 'the lock ran during the cache write')
  t.ok(locked !== null, 'the read returns no plaintext')
  await locking
  t.is(await B.storage.readJson('dmMediaIndex'), null, 'and the lock wiped the cache')
})
