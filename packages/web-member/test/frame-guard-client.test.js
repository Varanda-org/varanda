// The browser node's initiator links behind the frame guard (issue #130):
// lib/ws-stream.js guardedWsStream puts @varanda/core lib/frame-guard in
// front of the Noise secret stream of the peek, notices, sync and seeder
// links. Loopback only:
// - hostile but VERIFIED seeder stand-ins (peek.test.js fakeSeeder pattern)
//   that answer the hello honestly and then push oversized frames: the peek
//   link (bound PEEK_MAX_FRAME, 1 MiB) is cut at the first 2 MiB header and
//   the page answers incomplete with the warning; the sync and seeder links
//   (bound MAX_EXTERNAL_FRAME) are cut at a 9 MiB header;
// - a seeder closing with 1013 (at its connection cap) yields 'Semeador
//   ocupado; tente novamente em instantes.' on peek and notices and a
//   'seeder-busy' warning on sync; an older seeder's 1006 keeps 'sem conexão
//   com o semeador';
// - the peek bound against legitimate traffic: the largest frame a full
//   multi-page read receives from a REAL seeder holding 64 long diaries and
//   a media core, and from the real admission code advertising a full
//   4096-key inventory, both measured and asserted well under the bound.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord, mediaCoreRecord, MEDIA_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { mediaHeader } = require('@varanda/core/lib/media')
const { attachAdmission, MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { MAX_EXTERNAL_FRAME } = require('@varanda/core/lib/frame-guard')
const { signNoticeProof } = require('@varanda/core/lib/notices')
const { createBrowserNode } = require('../lib/node')
const { createMember } = require('../lib/member')
const { connectSeeder } = require('../lib/seeder-link')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const { createPeeker, PEEK_MAX_FRAME, SEEDER_BUSY } = require('../lib/peek')
const { createNoticer } = require('../lib/notices')

const NO_SEEDER = 'sem conexão com o semeador'
const FRAME_WARNING = 'aviso: quadro grande demais do semeador'
const MiB = 1048576
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

function toBytes (data) {
  if (Array.isArray(data)) return b4a.concat(data.map(toBytes))
  if (data instanceof ArrayBuffer) return b4a.from(new Uint8Array(data))
  if (ArrayBuffer.isView(data)) return b4a.from(data.buffer, data.byteOffset, data.byteLength)
  return b4a.from(String(data))
}

// A raw secret-stream frame declaring `declared` bytes (3-byte little-endian
// header) followed by `body` bytes: garbage the guard must cut at the header.
function rawFrame (declared, body = declared) {
  const frame = b4a.alloc(3 + body)
  frame[0] = declared & 0xff
  frame[1] = (declared >>> 8) & 0xff
  frame[2] = (declared >>> 16) & 0xff
  return frame
}

// Parses the secret-stream framing of every byte a client socket receives
// and keeps the largest declared frame length (the quantity FrameGuard
// bounds), across WebSocket messages.
function frameMeter () {
  const m = { max: 0, frames: 0, header: 0, len: 0, remaining: 0 }
  m.feed = (chunk) => {
    let offset = 0
    while (offset < chunk.byteLength) {
      if (m.remaining > 0) {
        const n = Math.min(m.remaining, chunk.byteLength - offset)
        m.remaining -= n
        offset += n
        continue
      }
      m.len += chunk[offset++] * [1, 256, 65536][m.header]
      if (++m.header < 3) continue
      m.frames++
      if (m.len > m.max) m.max = m.len
      m.remaining = m.len
      m.header = 0
      m.len = 0
    }
  }
  return m
}

// createSocket for the browser links: every client WebSocket is recorded
// and, with `meters`, metered (one meter per socket).
function sockets (t, { meters = null } = {}) {
  const list = []
  const create = (url) => {
    const ws = new WebSocket(url)
    ws.on('error', () => {})
    if (meters !== null) {
      const meter = frameMeter()
      meters.push(meter)
      ws.on('message', (data) => meter.feed(toBytes(data)))
    }
    t.teardown(() => ws.terminate(), { force: true })
    list.push(ws)
    return ws
  }
  return { list, create }
}

// A Hypercore 10 diary with the given records (block 0 first).
async function diary (t, records) {
  const core = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  for (const make of records) await core.append(make(hex(core.key)))
  return core
}

function author (assoc, name, ats) {
  return [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => profileRecord({ name, bio: '' }),
    ...ats.map((ms, i) => () => postRecord({ text: name + ' ' + (i + 1), at: iso(ms) }))
  ]
}

async function wsServer (t, onConnection) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const s of wss.clients) s.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', onConnection)
  return 'ws://127.0.0.1:' + wss.address().port + '/seeder'
}

// A VERIFIED seeder stand-in (role 'seeder' certified by `signer`, honest
// hello and inventory advertising `cores` and `ghosts`) that never serves a
// block. `onOpen({ ws, noise, mux, index })` runs once the muxer exists;
// `onCore` runs when the client opens the replication channel of one of
// `cores` (its first block request follows); `onHello` when the client's
// hello arrives. Each hook may push raw frames with ws.send.
async function standIn (t, { signer, cores = [], ghosts = [], onCore = null, onHello = null, serve = false }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const state = { connections: 0, closed: 0, blasts: 0 }
  const url = await wsServer(t, (ws) => {
    const index = state.connections++
    ws.on('close', () => state.closed++)
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      const mux = Hypercore.createProtocolStream(noise).userData
      for (const core of cores) {
        if (serve) core.replicate(noise)
        else if (onCore) mux.pair({ protocol: 'hypercore/alpha', id: core.discoveryKey }, () => onCore({ ws, index, state }))
      }
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: [...cores.map((core) => ({ key: hex(core.key), length: core.length })), ...ghosts],
        onmessage: (msg) => {
          if (msg.type === 'hello' && onHello) onHello({ ws, index, state })
        }
      })
    })
  })
  return { url, state }
}

// ---- the peek link ----

test('peek: a verified seeder pushing 16 frames of 2 MiB after the inventory is cut at the first header; the page is incomplete with the warning', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const now = Date.now()
  const cores = []
  for (let i = 0; i < 3; i++) cores.push(await diary(t, author(assoc, 'D' + i, [now - (i + 1) * HOUR])))
  let blasted = false
  const seeder = await standIn(t, {
    signer: assoc.kp,
    cores,
    onCore: ({ ws, state }) => {
      if (blasted) return
      blasted = true
      // One block request per worker is in flight; answer with 16 frames
      // that each declare (and carry) 2 MiB, twice the peek bound.
      for (let i = 0; i < 16; i++) {
        ws.send(rawFrame(2 * MiB))
        state.blasts++
      }
    }
  })
  t.is(PEEK_MAX_FRAME, MiB, 'the peek bound is 1 MiB')
  const warnings = []
  const s = sockets(t)
  const peeker = createPeeker({
    ownKey: async () => '00'.repeat(32),
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: seeder.url,
    createSocket: s.create,
    log: (line) => warnings.push(line),
    // A budget far above what was pushed: only the guard can cut this link.
    limits: { pageMaxBytes: 256 * MiB, fetchTimeoutMs: 20000 }
  })
  t.teardown(() => peeker.close(), { force: true })
  const started = Date.now()
  const page = await peeker.read({ limit: 10 })
  const ms = Date.now() - started
  t.ok(blasted, 'the stand-in pushed its frames')
  t.ok(warnings.includes(FRAME_WARNING), 'warning: ' + FRAME_WARNING)
  t.is(warnings.filter((w) => w === FRAME_WARNING).length, 1, 'one cut, one warning')
  t.is(page.incomplete, true, 'the page is incomplete')
  t.alike(page.items, [], 'no memory core accepted a block: nothing to show')
  t.is(page.diaries, 3, 'the inventory was read before the cut')
  t.is(page.skipped, 0, 'a cut link is no verdict on any diary')
  t.ok(ms < 15000, 'cut long before the fetch timeout (' + ms + ' ms)')
  await until(() => seeder.state.closed === seeder.state.connections, { name: 'socket closed by the client' })
  t.comment('peek cut after ' + ms + ' ms; ' + seeder.state.blasts + ' frames of 2 MiB pushed')
})

test('peek and notices: a seeder closing with 1013 is busy; an older seeder (1006) keeps sem conexão', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const busyUrl = await wsServer(t, (ws) => ws.close(1013, 'lotado'))
  const oldUrl = await wsServer(t, (ws) => ws.terminate())
  const member = crypto.keyPair()
  const own = hex(member.publicKey)

  function peeker (url) {
    const p = createPeeker({ ownKey: async () => '00'.repeat(32), storage: memoryNodeStorage(), association: assoc.hex, seederUrl: url, createSocket: sockets(t).create })
    t.teardown(() => p.close(), { force: true })
    return p
  }
  function noticer (url) {
    const n = createNoticer({
      storage: memoryNodeStorage(),
      association: assoc.hex,
      seederUrl: url,
      createSocket: sockets(t).create,
      ownKey: async () => own,
      sign: (payload) => signNoticeProof(payload, member),
      seenToken: () => '0'.repeat(32)
    })
    t.teardown(() => n.close(), { force: true })
    return n
  }
  const failure = (p) => p.then(() => null, (err) => err)

  const busyPeek = await failure(peeker(busyUrl).read({ limit: 10 }))
  t.is(busyPeek && busyPeek.message, SEEDER_BUSY, 'peek, 1013: ' + SEEDER_BUSY)
  t.is(busyPeek && busyPeek.code, 'USAGE', 'a UsageError')
  const oldPeek = await failure(peeker(oldUrl).read({ limit: 10 }))
  t.is(oldPeek && oldPeek.message, NO_SEEDER, 'peek, 1006: ' + NO_SEEDER)

  const busyNotices = await failure(noticer(busyUrl).read({ limit: 10 }))
  t.is(busyNotices && busyNotices.message, SEEDER_BUSY, 'notices, 1013: ' + SEEDER_BUSY)
  t.is(busyNotices && busyNotices.code, 'USAGE', 'a UsageError')
  const oldNotices = await failure(noticer(oldUrl).read({ limit: 10 }))
  t.is(oldNotices && oldNotices.message, NO_SEEDER, 'notices, 1006: ' + NO_SEEDER)
})

test('peek: through the session RPC, 1013 reaches the page as USAGE Semeador ocupado', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const url = await wsServer(t, (ws) => ws.close(1013, 'lotado'))
  const { web } = await webNode(t, assoc, url)
  const err = await web.request('peek.read', {}).then(() => null, (e) => e)
  t.is(err && err.code, 'USAGE')
  t.is(err && err.message, SEEDER_BUSY)
})

// ---- the sync and seeder links ----

// The web node with its client in memory and an identity (peek.test.js).
async function webNode (t, assoc, url) {
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: url,
    createSocket: sockets(t).create,
    onInternalError: () => {},
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  await web.request('identity.create')
  return { node, web }
}

function warningLines (web) {
  return web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
}

test('sync: a verified seeder pushing a 9 MiB frame is cut at its header and the node reconnects', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await standIn(t, {
    signer: assoc.kp,
    onHello: ({ ws, index, state }) => {
      if (index !== 0) return
      // Over MAX_EXTERNAL_FRAME (8 MiB + 64 KiB): only the header and 64 KiB
      // of body go out, the guard never needs more than the header.
      ws.send(rawFrame(9 * MiB, 65536))
      state.blasts++
    }
  })
  t.ok(9 * MiB > MAX_EXTERNAL_FRAME)
  const { web } = await webNode(t, assoc, seeder.url)
  await web.request('sync.start', { once: false })
  await until(() => seeder.state.blasts === 1, { name: 'frame pushed' })
  await until(() => warningLines(web).some((l) => l.includes(FRAME_WARNING)), { name: 'aviso de quadro', timeoutMs: 20000 })
  await until(() => seeder.state.closed >= 1 && seeder.state.connections >= 2, { name: 'cut, then a new link', timeoutMs: 20000 })
  t.pass('the sync link was cut and a new one dialed')
  await web.request('sync.stop').catch(() => {})
})

test('sync: a seeder closing with 1013 logs a distinct seeder-busy warning', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const url = await wsServer(t, (ws) => ws.close(1013, 'lotado'))
  const { web } = await webNode(t, assoc, url)
  await web.request('sync.start', { once: false })
  await until(() => warningLines(web).some((l) => l.includes('semeador ocupado')), { name: 'aviso de semeador ocupado', timeoutMs: 20000 })
  t.pass('busy warning logged')
  await web.request('sync.stop').catch(() => {})
})

test('seeder-link: a verified seeder pushing a 9 MiB frame fails the admission through the close path', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await standIn(t, {
    signer: assoc.kp,
    onHello: ({ ws, state }) => {
      ws.send(rawFrame(9 * MiB, 65536))
      state.blasts++
    }
  })
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assoc.kp))
  const s = sockets(t)
  const link = connectSeeder({ member: m, socket: s.create(seeder.url), association: assoc.hex, timeoutMs: 20000 })
  t.teardown(() => link.close(), { force: true })
  const err = await link.admitted.then(() => null, (e) => e)
  t.is(seeder.state.blasts, 1, 'frame pushed')
  t.is(err && err.message, 'conexão com o semeador encerrada', 'the link closed')
  await until(() => seeder.state.closed === 1, { name: 'socket closed by the client' })
})

// ---- the peek bound against legitimate traffic ----

const DIARIES = 64
const POSTS = 200 // per diary, after cert and profile (and the media declaration)
const SEED_CONCURRENCY = 8

test('measured: the largest frame of a full multi-page read from a real seeder with 64 long diaries and a media core', async (t) => {
  t.timeout(175000)
  const { bootstrap } = await testnet(t)
  const assoc = association()

  const seederDir = tmpDir(t, 'varanda-fg-seed-')
  Seeder.ensureConfig(seederDir, assoc.hex)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-fg-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assoc.kp)))
  Seeder.addCert(seederDir, certFile, assoc.hex)
  const events = []
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const url = await wsServer(t, (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })

  // Near-4 KiB posts: 1000 four-byte characters (MAX_TEXT counts code points).
  const text = '\u{1F600}'.repeat(1000)
  const now = Date.now()
  const seededAt = Date.now()
  let next = 0
  let mediaKey = null
  async function seedOne (i) {
    const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
    t.teardown(() => m.close(), { force: true })
    await m.setCert(createCert({ member: m.key }, assoc.kp))
    await m.core.append(profileRecord({ name: 'membro ' + i, bio: '' }))
    let media = null
    if (i === 0) {
      // A Hypercore 10 compat media core (key = media public key) declared
      // by the diary and admitted by the seeder over the same link.
      media = new Hypercore(memoryStorage(), { keyPair: crypto.keyPair() })
      await media.ready()
      t.teardown(() => media.close(), { force: true })
      await media.append(b4a.from(JSON.stringify(mediaHeader({ diary: m.key }))))
      for (let b = 0; b < 3; b++) await media.append(b4a.alloc(b === 2 ? 1000 : MEDIA_BLOCK_BYTES, b + 1))
      mediaKey = hex(media.key)
      await m.core.append(mediaCoreRecord({ key: mediaKey }))
    }
    const batch = []
    for (let p = 0; p < POSTS; p++) batch.push(postRecord({ text, at: iso(now - HOUR - (POSTS - p) * 1000 - i) }))
    await m.core.append(batch)
    const link = connectSeeder({ member: m, socket: new WebSocket(url), association: assoc.hex, seederPublicKey: seederKey, timeoutMs: 60000 })
    t.teardown(() => link.close(), { force: true })
    await link.admitted
    if (media !== null) {
      media.replicate(link.noise)
      await until(() => events.some((e) => e.event === 'media-admitted' && e.key === mediaKey), { name: 'media-admitted', timeoutMs: 60000 })
    }
    await link.waitServed(m.core.length)
    link.close()
  }
  await Promise.all(Array.from({ length: SEED_CONCURRENCY }, async () => {
    while (next < DIARIES) await seedOne(next++)
  }))
  t.comment('seeded ' + DIARIES + ' diaries of ' + (POSTS + 2) + '+ blocks in ' + (Date.now() - seededAt) + ' ms')
  t.ok(events.some((e) => e.event === 'media-admitted' && e.key === mediaKey), 'the seeder holds the media core')

  const meters = []
  const s = sockets(t, { meters })
  const warnings = []
  const peeker = createPeeker({ ownKey: async () => '00'.repeat(32), storage: memoryNodeStorage(), association: assoc.hex, seederUrl: url, createSocket: s.create, log: (line) => warnings.push(line) })
  t.teardown(() => peeker.close(), { force: true })
  const pages = []
  let after
  while (true) {
    const page = await peeker.read(after === undefined ? { limit: 31 } : { limit: 31, after })
    pages.push(page)
    if (page.next === null) break
    after = page.next
  }
  const items = pages.flatMap((p) => p.items)
  const max = Math.max(...meters.map((m) => m.max))
  const frames = meters.reduce((n, m) => n + m.frames, 0)
  t.comment('measured: ' + pages.length + ' pages, ' + items.length + ' items, ' + meters.length + ' links, ' + frames + ' frames, largest frame ' + max + ' bytes')
  t.absent(warnings.includes(FRAME_WARNING), 'the honest seeder is never cut')
  t.is(pages[0].diaries, DIARIES, 'every diary is a candidate')
  t.is(items.length, DIARIES * 3, 'three rounds of every diary across the pages')
  t.ok(pages.every((p) => p.incomplete === false), 'every page complete')
  t.ok(max < 512 * 1024, 'the largest legitimate frame is under 512 KiB (' + max + ')')
  t.ok(max * 2 < PEEK_MAX_FRAME, 'and under half the peek bound')
})

test('measured: a full 4096-key inventory from the real admission code fits the peek bound with margin', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const now = Date.now()
  const cores = []
  for (let i = 0; i < 4; i++) cores.push(await diary(t, author(assoc, 'R' + i, [now - (i + 1) * HOUR])))
  // Length-1 ghosts: advertised (counted against MAX_INVENTORY) but never
  // candidates, so the read fetches the real diaries only.
  const ghosts = []
  while (cores.length + ghosts.length < MAX_INVENTORY) ghosts.push({ key: hex(crypto.randomBytes(32)), length: 1 })
  const seeder = await standIn(t, { signer: assoc.kp, cores, ghosts, serve: true })
  const meters = []
  const s = sockets(t, { meters })
  const warnings = []
  const peeker = createPeeker({ ownKey: async () => '00'.repeat(32), storage: memoryNodeStorage(), association: assoc.hex, seederUrl: seeder.url, createSocket: s.create, log: (line) => warnings.push(line) })
  t.teardown(() => peeker.close(), { force: true })
  const page = await peeker.read({ limit: 31 })
  const max = Math.max(...meters.map((m) => m.max))
  t.comment('4096-key inventory: ' + meters[0].frames + ' frames, largest ' + max + ' bytes')
  t.absent(warnings.includes(FRAME_WARNING), 'never cut')
  t.is(page.diaries, cores.length, 'the real diaries are the candidates')
  t.is(page.items.length, cores.length, 'each shows its post')
  t.is(page.incomplete, false)
  t.ok(max * 16 < PEEK_MAX_FRAME, 'the inventory frames fit the bound 16 times over (' + max + ')')
})
