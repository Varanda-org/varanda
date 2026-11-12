'use strict'

// apps/cli/lib/account/pages-writer.js: page diaries written by the service,
// pushed over a loopback WebSocket link to a real Seeder (local DHT only).

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const { videoBounds } = require('@varanda/rpc')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createIssuerCert, createIssuedCert, createUsernameRecord, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const { execFileSync } = require('node:child_process')
const { WebSocketServer, createWebSocketStream } = require('ws')
const { postRecord, followRecord, profileRecord, mediaCoreRecord, deleteRecord, deleteRecords } = require('@varanda/core/lib/records')
const { signRoster, signClose, signMoved, signOrigin, issuerCountersign } = require('@varanda/core/lib/page')
const { pageLifecycle, originOf } = require('@varanda/core/lib/page-lifecycle')
const { applyDeletes } = require('@varanda/core/lib/deletion')
const { readRaw } = require('@varanda/core/lib/store')
const { PROTOCOL: ADMISSION_PROTOCOL } = require('@varanda/core/lib/admission')
const { startSeedWs } = require('../lib/seed-ws')
const { openPageKeys } = require('../lib/account/page-keys')
const { createPagesWriter } = require('../lib/account/pages-writer')

const NoiseSecretStream = require(require.resolve('@hyperswarm/secret-stream', {
  paths: [path.dirname(require.resolve('@varanda/core/lib/seeder'))]
}))

const PAGE_KEYS = 'ab'.repeat(32)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function setup () {
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  return { assocKp, association, issuerKp, issuerCert }
}

let nonceCount = 0
function nonce () {
  nonceCount++
  return (String(nonceCount) + 'n'.repeat(43)).slice(0, 43)
}

// A pending pair put into page-keys, and the three genesis records.
function newPage (ctx, keys, username, owner = crypto.keyPair()) {
  const { key, row } = keys.pending(nonce())
  keys.put(key, row)
  const cert = createIssuedCert({ member: key }, ctx.issuerKp, ctx.issuerCert)
  const usernameRecord = createUsernameRecord({ member: key, username }, ctx.issuerKp, ctx.issuerCert)
  const fields = { page: key, gen: 1, owner: hex(owner.publicKey), admins: [], prev: null, at: new Date().toISOString(), nonce: nonce(), association: ctx.association }
  const signature = signRoster(fields, owner)
  const rosterRecord = issuerCountersign({ type: 'page-roster', ...fields, signature }, ctx.issuerKp, ctx.issuerCert)
  return { key, row, owner, args: { cert, usernameRecord, rosterRecord } }
}

function prepareSeederDir (t, assocKp) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp)))
  Seeder.addCert(dataDir, certFile, association)
  return dataDir
}

function walk (dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
}

function holdsSecret (buf, secret) {
  const s = b4a.from(secret)
  return buf.includes(s) || buf.includes(s.subarray(0, 32)) || buf.includes(b4a.from(hex(s))) || buf.includes(b4a.from(hex(s.subarray(0, 32))))
}

function mediaGet (port, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

function be16 (n) {
  return [(n >> 8) & 0xff, n & 0xff]
}

// SOI, a baseline SOF0 frame header, then filler up to `size` bytes.
function jpeg (width, height, size) {
  const head = b4a.from([0xff, 0xd8, 0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
  const out = b4a.alloc(size, 0x5a)
  head.copy(out, 0)
  out[size - 2] = 0xff
  out[size - 1] = 0xd9
  return out
}

// One video sample with complete container tables, so refusal cannot be
// explained by an invalid MPEG-4 container.
function mp4 (width, height) {
  const u32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts)
    return Buffer.concat([u32(body.length + 8), Buffer.from(type), body])
  }
  const time = (size) => {
    const b = Buffer.alloc(size)
    b.writeUInt32BE(1000, 12)
    b.writeUInt32BE(3000, 16)
    return b
  }
  const tkhd = Buffer.alloc(84)
  tkhd.writeUInt32BE(7, 0)
  tkhd.writeUInt32BE(1, 12)
  tkhd.writeUInt32BE(3000, 20)
  for (const offset of [40, 56]) tkhd.writeUInt32BE(0x10000, offset)
  tkhd.writeUInt32BE(0x40000000, 72)
  tkhd.writeUInt32BE(width * 0x10000, 76)
  tkhd.writeUInt32BE(height * 0x10000, 80)
  const entry = Buffer.alloc(78)
  entry.writeUInt16BE(1, 6)
  entry.writeUInt16BE(width, 24)
  entry.writeUInt16BE(height, 26)
  const avcC = box('avcC', Buffer.from([1, 100, 0, 40, 255, 225, 0, 4, 103, 100, 0, 40, 1, 0, 1, 104]))
  const ftyp = box('ftyp', Buffer.from('isom'), u32(0), Buffer.from('isommp41'))
  const stbl = box('stbl',
    box('stsd', u32(0), u32(1), box('avc1', entry, avcC)),
    box('stts', u32(0), u32(1), u32(1), u32(3000)),
    box('stsz', u32(0), u32(10), u32(1)),
    box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1)),
    box('stco', u32(0), u32(1), u32(ftyp.length + 8)))
  const minf = box('minf', box('vmhd', u32(1), Buffer.alloc(8)),
    box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1)))), stbl)
  const mdia = box('mdia', box('mdhd', time(24)),
    box('hdlr', Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(13)), minf)
  return Buffer.concat([ftyp, box('mdat', Buffer.alloc(10, 1)),
    box('moov', box('mvhd', time(100)), box('trak', box('tkhd', tkhd), mdia))])
}

function sha (bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

async function startSeeder (t, bootstrap, ctx) {
  const dataDir = prepareSeederDir(t, ctx.assocKp)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: ctx.association, log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, dataDir, events }
}

// A reader on the association topic that never announces anything.
async function thirdMember (t, bootstrap, association) {
  const store = new Corestore(tmpDir(t, 'varanda-reader-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    attachAdmission(socket, { role: 'member', have: [], onmessage: () => {} })
  })
  await joinAndFlush(swarm, [topicFor(association)])
  return {
    async read (key, seq) {
      const core = store.get({ key: b4a.from(key, 'hex'), valueEncoding: 'json' })
      await core.ready()
      try {
        return await core.get(seq, { timeout: 3000 })
      } catch {
        return null
      } finally {
        await core.close().catch(() => {})
      }
    }
  }
}

test('pages-writer: a page is created, pushed, admitted and served; media, follows and the link', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const ctx = setup()
  const { seeder, dataDir: seedDir, events } = await startSeeder(t, bootstrap, ctx)
  let server = await startSeedWs({ port: 0, seeder })
  const port = server.port
  t.teardown(() => server.close(), { force: true })

  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const logs = []
  const writer = createPagesWriter({ dir, keys, association: ctx.association, seederWs: 'http://127.0.0.1:' + port, log: (e) => logs.push(e) })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await until(() => writer.connected(), { name: 'link up', timeoutMs: 20000 })

  const page = newPage(ctx, keys, 'padaria')
  const other = newPage(ctx, keys, 'feira')
  t.is((await writer.createPage(page.args)).key, page.key)
  await writer.createPage(other.args)
  const entries = await writer.readEntries(page.key)
  t.alike(entries.map((e) => e.record.type), ['member-cert', 'username', 'page-roster'])
  t.is(writer.info(page.key).length, 3)

  // Seeder admission and a reader that is neither the writer nor the seeder.
  const readAdmitted = () => JSON.parse(fs.readFileSync(path.join(seedDir, 'admitted.json'), 'utf8')).admitted
  await until(() => { try { return page.key in readAdmitted() } catch { return false } }, { name: 'admitted.json', timeoutMs: 30000 })
  const reader = await thirdMember(t, bootstrap, ctx.association)
  const r2 = await until(() => reader.read(page.key, 2), { name: 'served roster', timeoutMs: 30000 })
  t.is(r2.type, 'page-roster', 'a third member reads the page from the seeder')

  const posted = await writer.append(page.key, [postRecord({ text: 'pão quente' })])
  t.is(posted.seq, 3)
  t.is(posted.length, 4)
  t.is(posted.pushed, true, 'the seeder advertised the new length')

  // Media: a 1 MiB jpeg.
  const big = jpeg(1200, 800, 1024 * 1024)
  const item = await writer.mediaItem(page.key, { bytes: big, mime: 'image/jpeg', width: 1200, height: 800, sha256: sha(big) })
  t.is(item.blocks, 32)
  t.is(item.start, 1)
  t.not(item.core, page.key)
  t.alike(writer.items(page.key), [item])
  const lengthBefore = writer.info(page.key).length
  await t.exception(writer.mediaItem(page.key, { bytes: big, mime: 'image/jpeg', width: 1200, height: 800, sha256: 'ab'.repeat(32) }), /midia-invalida/, 'wrong sha256')
  const truncated = big.subarray(0, 12)
  await t.exception(writer.mediaItem(page.key, { bytes: truncated, mime: 'image/jpeg', width: 1200, height: 800, sha256: sha(truncated) }), /midia-invalida/, 'truncated jpeg')
  await t.exception(writer.mediaItem(page.key, { bytes: big, mime: 'image/jpeg', width: 10, height: 800, sha256: sha(big) }), /midia-invalida/, 'size mismatch')
  const video = mp4(1200, 800)
  t.alike(videoBounds(video), { width: 1200, height: 800, ms: 3000, audio: false }, 'a valid short video container')
  const beforeVideo = writer.info(page.key).length
  const beforeItems = writer.items(page.key)
  for (const bytes of [video, big]) {
    await t.exception(writer.mediaItem(page.key, { bytes, mime: 'video/mp4', width: 1200, height: 800, sha256: sha(bytes) }), /midia-invalida/, 'video MIME is refused even with image bytes')
  }
  t.is(writer.info(page.key).length, beforeVideo, 'a refused video appends no record')
  t.alike(writer.items(page.key), beforeItems, 'a refused video stores no media item')
  const notPng = b4a.from('not a png at all')
  await t.exception(writer.mediaItem(page.key, { bytes: notPng, mime: 'image/png', width: 1, height: 1, sha256: sha(notPng) }), /midia-invalida/, 'png magic mismatch')
  t.is(writer.info(page.key).length, lengthBefore, 'refusals append nothing')
  t.is(writer.items(page.key).length, 1)
  const png = b4a.concat([b4a.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), b4a.alloc(100, 1)])
  const pngItem = await writer.mediaItem(page.key, { bytes: png, mime: 'image/png', width: 10, height: 20, sha256: sha(png) })
  t.is(pngItem.start, 33)
  t.is(pngItem.mime, 'image/png')

  const post = await writer.append(page.key, [postRecord({ text: 'foto', media: [item] })])
  t.is(post.pushed, true)
  const mediaUrl = '/media/' + page.key + '/' + item.core + '/' + item.start + '/' + item.blocks
  const got = await until(async () => {
    const r = await mediaGet(port, mediaUrl)
    return r.status === 200 ? r : null
  }, { name: 'media served', timeoutMs: 30000 })
  t.alike(got.body, big, 'the seeder media route serves the item')
  for (const peer of seeder._peers) t.absent(peer.remoteHave && peer.remoteHave.has(item.core), 'media key never in a have')
  t.ok([...seeder._peers].some((peer) => peer.remoteHave && peer.remoteHave.has(page.key)), 'the diary key is in the have')

  // Follows.
  const target = hex(crypto.keyPair().publicKey)
  await t.exception(writer.setFollow(page.key, page.key, true), /propria-pagina/)
  const on = await writer.setFollow(page.key, target, true)
  t.alike(on.follows, [{ key: target, seq: on.seq }])
  const pageFollow = await writer.setFollow(page.key, other.key, true)
  const off = await writer.setFollow(page.key, target, false)
  t.is(off.pushed, true)
  t.alike(off.follows, [{ key: other.key, seq: pageFollow.seq }], 'unfollowed key out, another page kept')
  t.alike(writer.follows(page.key), off.follows)

  // The link goes down: an append is not pushed, then served after reconnect.
  await server.close()
  await until(() => !writer.connected(), { name: 'link down', timeoutMs: 20000 })
  const offline = await writer.append(page.key, [postRecord({ text: 'sem rede' })])
  t.is(offline.pushed, false)
  server = await startSeedWs({ port, seeder })
  await until(() => writer.connected(), { name: 'link back', timeoutMs: 30000 })
  const served = await until(() => reader.read(page.key, offline.seq), { name: 'served after reconnect', timeoutMs: 30000 })
  t.is(served.text, 'sem rede')

  // No secret in storage or logs.
  const rows = [page.row, other.row]
  for (const file of walk(dir)) {
    const buf = fs.readFileSync(file)
    for (const row of rows) {
      t.absent(holdsSecret(buf, row.secretKey) || holdsSecret(buf, row.mediaSecretKey), path.relative(dir, file) + ' holds no page secret')
    }
  }
  const logText = JSON.stringify(logs)
  t.absent(logText.includes(page.key) || logText.includes(item.core), 'logs name no key')
  for (const row of rows) t.absent(logText.includes(hex(row.secretKey)), 'logs hold no secret')
  t.ok(events.length > 0)
})

test('pages-writer: keys, reopen, external append pauses, wipe stops appends', async (t) => {
  t.timeout(120000)
  await testnet(t)
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  t.exception.all(() => createPagesWriter({ dir, keys, association: ctx.association, seederWs: 'http://example.com:80' }), /loopback/)

  let writer = createPagesWriter({ dir, keys, association: ctx.association })
  const page = newPage(ctx, keys, 'oficina')
  await writer.createPage(page.args)
  await t.exception(writer.createPage(page.args), /existe/)
  const small = jpeg(512, 512, 5000)
  const avatar = await writer.avatarItem(page.key, small, 'image/jpeg')
  t.is(avatar.width, 512)
  await t.exception(writer.avatarItem(page.key, jpeg(500, 512, 5000), 'image/jpeg'), /midia-invalida/)
  const r = await writer.append(page.key, [postRecord({ text: 'oi' })])
  t.is(r.pushed, false, 'no link, not pushed')
  await writer.close()

  // The core on disk: key === public key, the secret appends after
  // setKeyPair, and no storage file holds it.
  const location = path.join(dir, 'pages-store', page.key)
  const publicKey = page.row.secretKey.subarray(32)
  const core = new Hypercore(location, { keyPair: { publicKey }, compat: true, valueEncoding: 'json' })
  await core.ready()
  t.is(hex(core.key), page.key, 'core.key === publicKey')
  for (const file of walk(path.join(dir, 'pages-store'))) {
    const buf = fs.readFileSync(file)
    t.absent(holdsSecret(buf, page.row.secretKey) || holdsSecret(buf, page.row.mediaSecretKey), 'no secret in ' + path.basename(file))
  }

  await core.close()
  writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  t.alike(writer.items(page.key), [avatar], 'the item table survives a reopen')
  const again = await writer.append(page.key, [postRecord({ text: 'de novo' })])
  t.is(again.length, 6, 'genesis 3, media-core, post, this one')
  await writer.close()

  // An append from elsewhere pauses the page.
  const rogue = new Hypercore(location, { keyPair: { publicKey }, compat: true, valueEncoding: 'json' })
  await rogue.ready()
  rogue.setKeyPair({ publicKey, secretKey: page.row.secretKey })
  await rogue.append(postRecord({ text: 'vazada' }))
  await rogue.close()
  writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await t.exception(writer.append(page.key, [postRecord({ text: 'x' })]), /pausada/)
  t.is(writer.info(page.key).paused, true)
  await t.exception(writer.setFollow(page.key, hex(crypto.keyPair().publicKey), true), /pausada/)

  // Wipe: appends stop.
  const second = newPage(ctx, keys, 'mercado')
  await writer.createPage(second.args)
  keys.wipe(second.key)
  await t.exception(writer.append(second.key, [postRecord({ text: 'x' })]), /chave-ausente/)
  await t.exception(writer.append(second.key, [postRecord({ text: 'x' })]), /nao-encontrada/)
})

test('pages-writer: a page follows at most MAX_PAGE_FOLLOWS keys', async (t) => {
  t.timeout(180000)
  await testnet(t)
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let writer = createPagesWriter({ dir, keys, association: ctx.association })
  const page = newPage(ctx, keys, 'livraria')
  await writer.createPage(page.args)
  await writer.close()

  // 4094 follows written straight into the diary (setFollow one by one is
  // too slow for a test), with the state saying this writer wrote them.
  const publicKey = page.row.secretKey.subarray(32)
  const core = new Hypercore(path.join(dir, 'pages-store', page.key), { keyPair: { publicKey }, compat: true, valueEncoding: 'json' })
  await core.ready()
  core.setKeyPair({ publicKey, secretKey: page.row.secretKey })
  const at = new Date().toISOString()
  const all = []
  for (let i = 0; i < 4094; i++) all.push(followRecord({ key: nodeCrypto.createHash('sha256').update('k' + i).digest('hex'), on: true, at }))
  for (let i = 0; i < all.length; i += 512) await core.append(all.slice(i, i + 512))
  const stateFile = path.join(dir, 'pages-store', page.key + '.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.length = core.length
  fs.writeFileSync(stateFile, JSON.stringify(state))
  await core.close()

  writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  t.is(writer.follows(page.key).length, 4094)
  const last = await writer.setFollow(page.key, 'f'.repeat(64), true)
  t.is(last.follows.length, 4095)
  const length = writer.info(page.key).length
  await t.exception(writer.setFollow(page.key, 'e'.repeat(64), true), /limite/, 'the 4096th is refused')
  t.is(writer.info(page.key).length, length, 'nothing appended')
  const unf = await writer.setFollow(page.key, 'f'.repeat(64), false)
  t.is(unf.follows.length, 4094)
})

test('pages-writer: append takes no media-core or follow record and only media of the item table', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'quitanda')
  await writer.createPage(page.args)
  const small = jpeg(512, 512, 5000)
  const item = await writer.avatarItem(page.key, small, 'image/jpeg')
  const length = writer.info(page.key).length
  const stranger = hex(crypto.keyPair().publicKey)
  await t.exception(writer.append(page.key, [followRecord({ key: stranger, on: true })]), /invalido/, 'follow only through setFollow')
  await t.exception(writer.append(page.key, [mediaCoreRecord({ key: stranger })]), /invalido/, 'media-core only through mediaItem')
  await t.exception(writer.append(page.key, [postRecord({ text: 'x', media: [{ ...item, sha256: 'cd'.repeat(32) }] })]), /midia-invalida/, 'another sha256')
  await t.exception(writer.append(page.key, [postRecord({ text: 'x', media: [{ ...item, core: stranger }] })]), /midia-invalida/, 'another core')
  await t.exception(writer.append(page.key, [postRecord({ text: 'x', media: [{ ...item, start: item.start + 1 }] })]), /midia-invalida/, 'another start')
  await t.exception(writer.append(page.key, [profileRecord({ name: 'Quitanda', avatar: { ...item, sha256: 'ef'.repeat(32) } })]), /midia-invalida/, 'a profile avatar not in the table')
  t.is(writer.info(page.key).length, length, 'refusals append nothing')
  const ok = await writer.append(page.key, [profileRecord({ name: 'Quitanda', avatar: item }), postRecord({ text: 'foto', media: [item] })])
  t.is(ok.length, length + 2)
})

test('pages-writer: an unexpected diary length, a foreign media append or a fork pauses the page', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  const extra = newPage(ctx, keys, 'extra')
  const media = newPage(ctx, keys, 'midia')
  const forked = newPage(ctx, keys, 'garfo')
  for (const p of [extra, media, forked]) await writer.createPage(p.args)
  await writer.mediaItem(media.key, { bytes: jpeg(64, 64, 3000), mime: 'image/jpeg', width: 64, height: 64, sha256: sha(jpeg(64, 64, 3000)) })

  // An append that lands one block more than this writer asked for.
  const original = Hypercore.prototype.append
  let once = true
  Hypercore.prototype.append = function (blocks, opts) {
    if (once && Array.isArray(blocks)) {
      once = false
      return original.call(this, [...blocks, blocks[0]], opts)
    }
    return original.apply(this, arguments)
  }
  try {
    await t.exception(writer.append(extra.key, [postRecord({ text: 'a' })]), /pausada/)
  } finally {
    Hypercore.prototype.append = original
  }
  await t.exception(writer.append(extra.key, [postRecord({ text: 'b' })]), /pausada/, 'the foreign length was not taken as ours')
  await writer.close()

  const mediaPublic = media.row.mediaSecretKey.subarray(32)
  const rogueMedia = new Hypercore(path.join(dir, 'pages-store', media.key + '-media'), { keyPair: { publicKey: mediaPublic }, compat: true })
  await rogueMedia.ready()
  rogueMedia.setKeyPair({ publicKey: mediaPublic, secretKey: media.row.mediaSecretKey })
  await rogueMedia.append(b4a.from('vazada'))
  await rogueMedia.close()

  const forkPublic = forked.row.secretKey.subarray(32)
  const rogue = new Hypercore(path.join(dir, 'pages-store', forked.key), { keyPair: { publicKey: forkPublic }, compat: true, valueEncoding: 'json' })
  await rogue.ready()
  rogue.setKeyPair({ publicKey: forkPublic, secretKey: forked.row.secretKey })
  const len = rogue.length
  await rogue.truncate(len - 1)
  await rogue.append(postRecord({ text: 'outra' }))
  t.is(rogue.length, len, 'same length')
  t.not(rogue.fork, 0, 'another fork')
  await rogue.close()

  writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await t.exception(writer.append(media.key, [postRecord({ text: 'c' })]), /pausada/, 'foreign media append')
  await t.exception(writer.append(forked.key, [postRecord({ text: 'd' })]), /pausada/, 'fork')
})

test('pages-writer: concurrent creations are serialized', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const writer = createPagesWriter({ dir, keys, association: ctx.association, maxPages: 2 })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'dupla')
  const same = await Promise.allSettled([writer.createPage(page.args), writer.createPage(page.args)])
  t.is(same.filter((r) => r.status === 'fulfilled').length, 1, 'one wins')
  t.ok(same.some((r) => r.status === 'rejected' && r.reason.code === 'existe'), 'the other is existe')
  t.is((await writer.readEntries(page.key)).length, 3, 'the winner is intact')
  t.is((await writer.append(page.key, [postRecord({ text: 'ok' })])).length, 4)

  const a = newPage(ctx, keys, 'ultima')
  const b = newPage(ctx, keys, 'demais')
  const last = await Promise.allSettled([writer.createPage(a.args), writer.createPage(b.args)])
  t.is(last.filter((r) => r.status === 'fulfilled').length, 1, 'only one fits under the cap')
  t.ok(last.some((r) => r.status === 'rejected' && r.reason.code === 'limite'))
})

test('pages-writer: a closed page frees its slot under the host cap', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const writer = createPagesWriter({ dir, keys, association: ctx.association, maxPages: 1 })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'primeira')
  await writer.createPage(page.args)
  await writer.closePage(page.key, { closeRecord: closeRecordFor(ctx, page) })
  t.ok(writer.info(page.key), 'the closed page is still served read only')
  const next = newPage(ctx, keys, 'segunda')
  await writer.createPage(next.args)
  t.is(writer.info(next.key).length, 3, 'a new page fits: the closed one does not count')
  await t.exception(writer.createPage(newPage(ctx, keys, 'terceira').args), /limite/, 'two live pages do not fit')
})

test('pages-writer: nothing is replicated before the seeder hello verifies', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const page = newPage(ctx, keys, 'muda')
  let writer = createPagesWriter({ dir, keys, association: ctx.association })
  await writer.createPage(page.args)
  await writer.close()

  // Completes Noise, opens the admission channel, replicates, never says
  // hello.
  const store = new Corestore(tmpDir(t, 'varanda-fake-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const sockets = []
  const server = http.createServer()
  const wss = new WebSocketServer({ server, path: '/seeder' })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, createWebSocketStream(ws))
    noise.on('error', () => {})
    sockets.push(noise)
    store.replicate(noise)
    noise.userData.createChannel({ protocol: ADMISSION_PROTOCOL }).open()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => {
    for (const s of sockets) s.destroy()
    wss.close()
    server.close()
  }, { force: true })

  writer = createPagesWriter({ dir, keys, association: ctx.association, seederWs: 'http://127.0.0.1:' + server.address().port })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await until(() => sockets.some((s) => s.handshakeHash !== null), { name: 'noise up', timeoutMs: 10000 })
  const core = store.get({ key: b4a.from(page.key, 'hex'), valueEncoding: 'json' })
  await core.ready()
  let block = null
  try {
    block = await core.get(0, { timeout: 3000 })
  } catch {}
  t.is(block, null, 'zero blocks reach an unverified peer')
  t.ok(sockets.some((s) => !s.destroyed), 'the link stayed open while the block was asked for')
  t.is(writer.connected(), false)
})

test('pages-writer: state and noise files are never read through a link or a FIFO', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const page = newPage(ctx, keys, 'cano')
  let writer = createPagesWriter({ dir, keys, association: ctx.association })
  await writer.createPage(page.args)
  await writer.close()

  const storeDir = path.join(dir, 'pages-store')
  fs.rmSync(path.join(storeDir, page.key + '.json'))
  execFileSync('mkfifo', [path.join(storeDir, page.key + '.json')])
  const elsewhere = path.join(tmpDir(t, 'varanda-elsewhere-'), 'noise.json')
  const kp = crypto.keyPair()
  fs.writeFileSync(elsewhere, JSON.stringify({ publicKey: hex(kp.publicKey), secretKey: hex(kp.secretKey) }))
  fs.symlinkSync(elsewhere, path.join(storeDir, 'noise-key.json'))

  const logs = []
  writer = createPagesWriter({ dir, keys, association: ctx.association, seederWs: 'http://127.0.0.1:9', log: (e) => logs.push(e) })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  t.is(writer.info(page.key).paused, true, 'a state that is not a regular file pauses the page')
  t.ok(logs.some((e) => e.event === 'pages-link' && e.state === 'indisponivel'), 'a linked noise key is refused')
  t.ok(fs.lstatSync(path.join(storeDir, 'noise-key.json')).isSymbolicLink(), 'the link was not replaced')
  t.ok(fs.lstatSync(path.join(storeDir, page.key + '.json')).isFIFO(), 'the state FIFO was not replaced')
})

function stateBytes (dir, key) {
  return fs.readFileSync(path.join(dir, 'pages-store', key + '.json'))
}

test('pages-writer: a false guard or fail() refuses every write and writes nothing', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let owned = true
  const writer = createPagesWriter({ dir, keys, association: ctx.association, guard: () => owned })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'trava')
  await writer.createPage(page.args)
  const pic = jpeg(64, 64, 3000)
  const length = writer.info(page.key).length
  const state = stateBytes(dir, page.key)
  const later = newPage(ctx, keys, 'tarde')

  const tryAll = async (why) => {
    await t.exception(writer.append(page.key, [postRecord({ text: 'x' })]), /indisponivel/, 'append ' + why)
    await t.exception(writer.mediaItem(page.key, { bytes: pic, mime: 'image/jpeg', width: 64, height: 64, sha256: sha(pic) }), /indisponivel/, 'mediaItem ' + why)
    await t.exception(writer.setFollow(page.key, hex(crypto.keyPair().publicKey), true), /indisponivel/, 'setFollow ' + why)
    await t.exception(writer.createPage(later.args), /indisponivel/, 'createPage ' + why)
    await t.exception(writer.wipe(page.key), /indisponivel/, 'wipe ' + why)
    t.is(writer.info(page.key).length, length, 'diary length unchanged ' + why)
    t.alike(stateBytes(dir, page.key), state, 'state bytes unchanged ' + why)
    t.absent(fs.existsSync(path.join(dir, 'pages-store', later.key)), 'no new page ' + why)
    t.absent(fs.existsSync(path.join(dir, 'pages-store', page.key + '-media')), 'no media core ' + why)
  }
  owned = false
  await tryAll('with the lock gone')
  owned = true
  writer.fail()
  await tryAll('after fail()')
  t.ok(keys.get(page.key) !== null, 'the key row is kept')
})

test('pages-writer: a committed append whose state save fails pauses the page', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let owned = true
  const writer = createPagesWriter({ dir, keys, association: ctx.association, guard: () => owned })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'salva')
  await writer.createPage(page.args)
  const original = Hypercore.prototype.append
  Hypercore.prototype.append = async function () {
    const res = await original.apply(this, arguments)
    owned = false
    return res
  }
  try {
    await t.exception(writer.append(page.key, [postRecord({ text: 'a' })]), /indisponivel/)
  } finally {
    Hypercore.prototype.append = original
  }
  owned = true
  t.is(writer.info(page.key).paused, true, 'paused in memory')
  await t.exception(writer.append(page.key, [postRecord({ text: 'b' })]), /pausada/, 'nothing more is appended')
})

test('pages-writer: media must match every descriptor field; inputs are copied at entry', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'copia')
  const originalName = page.args.usernameRecord.username
  const creating = writer.createPage(page.args)
  page.args.usernameRecord.username = 'trocado'
  await creating
  t.is((await writer.readEntries(page.key))[1].record.username, originalName, 'the username record is the one passed')

  const pic = jpeg(64, 64, 3000)
  const digest = sha(pic)
  const adding = writer.mediaItem(page.key, { bytes: pic, mime: 'image/jpeg', width: 64, height: 64, sha256: digest })
  pic.fill(0)
  const item = await adding
  for (const [field, value] of [['mime', 'image/png'], ['bytes', item.bytes + 1], ['width', 65], ['height', 65]]) {
    await t.exception(writer.append(page.key, [postRecord({ text: 'x', media: [{ ...item, [field]: value }] })]), /midia-invalida/, 'another ' + field)
  }
  const record = postRecord({ text: 'original' })
  const appending = writer.append(page.key, [record])
  record.text = 'trocado'
  const { seq } = await appending
  t.is((await writer.readEntries(page.key)).find((e) => e.seq === seq).record.text, 'original', 'the record is the one passed')
  await writer.close()

  const mediaPublic = page.row.mediaSecretKey.subarray(32)
  const core = new Hypercore(path.join(dir, 'pages-store', page.key + '-media'), { keyPair: { publicKey: mediaPublic }, compat: true })
  await core.ready()
  const blocks = []
  for (let i = item.start; i < item.start + item.blocks; i++) blocks.push(await core.get(i))
  await core.close()
  t.is(sha(b4a.concat(blocks)), digest, 'the stored bytes are the ones hashed')
})

test('pages-writer: delete only targets a post, like, repost or profile of the page', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'apaga')
  await writer.createPage(page.args)
  const follow = await writer.setFollow(page.key, hex(crypto.keyPair().publicKey), true)
  const pic = jpeg(64, 64, 3000)
  await writer.mediaItem(page.key, { bytes: pic, mime: 'image/jpeg', width: 64, height: 64, sha256: sha(pic) })
  const mediaSeq = (await writer.readEntries(page.key)).find((e) => e.record.type === 'media-core').seq
  const length = writer.info(page.key).length
  for (const [seq, what] of [[1, 'username'], [2, 'page-roster'], [follow.seq, 'follow'], [mediaSeq, 'media-core'], [length, 'beyond the end']]) {
    await t.exception(writer.append(page.key, [deleteRecord({ seq })]), /invalido/, what)
  }
  t.is(writer.info(page.key).length, length, 'refusals append nothing')
  const post = await writer.append(page.key, [postRecord({ text: 'some' })])
  const profile = await writer.append(page.key, [profileRecord({ name: 'Apaga' })])
  t.ok(await writer.append(page.key, [deleteRecord({ seq: post.seq })]), 'a post is deleted')
  t.ok(await writer.append(page.key, [deleteRecord({ seq: profile.seq })]), 'a profile is deleted')
})

test('pages-writer: wipe waits for in-flight writes, then nothing more is signed', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'limpa')
  await writer.createPage(page.args)
  const inFlight = writer.append(page.key, [postRecord({ text: 'antes' })])
  const wiping = writer.wipe(page.key)
  t.is((await inFlight).length, 4, 'the in-flight append lands')
  t.is(await wiping, true)
  t.is(keys.get(page.key), null)
  await t.exception(writer.append(page.key, [postRecord({ text: 'depois' })]), /nao-encontrada/)
})

test('pages-writer: a media core written elsewhere is never declared', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'alheia')
  await writer.createPage(page.args)
  const mediaPublic = page.row.mediaSecretKey.subarray(32)
  const rogue = new Hypercore(path.join(dir, 'pages-store', page.key + '-media'), { keyPair: { publicKey: mediaPublic }, compat: true })
  await rogue.ready()
  rogue.setKeyPair({ publicKey: mediaPublic, secretKey: page.row.mediaSecretKey })
  await rogue.append(b4a.from('vazada'))
  await rogue.close()
  const pic = jpeg(64, 64, 3000)
  await t.exception(writer.mediaItem(page.key, { bytes: pic, mime: 'image/jpeg', width: 64, height: 64, sha256: sha(pic) }), /pausada/)
  t.is(writer.info(page.key).paused, true)
  t.is(JSON.parse(stateBytes(dir, page.key)).media, null, 'the media key was never saved')
  t.is(writer.info(page.key).length, 3, 'no media-core record')
})

test('pages-writer: an unreadable state opens paused, unannounced, untouched; startup stops at maxPages', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let writer = createPagesWriter({ dir, keys, association: ctx.association })
  const page = newPage(ctx, keys, 'estado')
  const other = newPage(ctx, keys, 'segunda')
  await writer.createPage(page.args)
  await writer.createPage(other.args)
  await writer.close()

  const file = path.join(dir, 'pages-store', page.key + '.json')
  fs.writeFileSync(file, '{')
  writer = createPagesWriter({ dir, keys, association: ctx.association })
  await writer.ready()
  t.alike(writer.info(page.key), { length: 3, paused: true, announced: false, movedTo: null })
  t.is(await writer.unannounce(page.key), false)
  await t.exception(writer.append(page.key, [postRecord({ text: 'x' })]), /pausada/)
  t.alike(fs.readFileSync(file), b4a.from('{'), 'the state file is untouched')
  await writer.close()

  writer = createPagesWriter({ dir, keys, association: ctx.association, maxPages: 1 })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  let open = 0
  for (const k of [page.key, other.key]) {
    try {
      writer.info(k)
      open++
    } catch {}
  }
  t.is(open, 1, 'one page opened under maxPages 1')
})

test('pages-writer: a write with the same member and nonce happens once, across a reopen, for 10 minutes', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let clock = Date.now()
  let writer = createPagesWriter({ dir, keys, association: ctx.association, now: () => clock })
  const page = newPage(ctx, keys, 'unica')
  await writer.createPage(page.args)
  const idem = { member: 'ef'.repeat(32), nonce: 'N'.repeat(43) }
  const a = await writer.append(page.key, [postRecord({ text: 'uma' })], idem)
  const b = await writer.append(page.key, [postRecord({ text: 'uma' })], idem)
  t.is(b.seq, a.seq)
  t.is(b.replay, true)
  t.is(writer.info(page.key).length, a.length, 'the repeat appended nothing')
  t.alike(writer.nonceRecord(page.key, idem.member, idem.nonce).append, { seq: a.seq, length: a.length })
  const other = await writer.append(page.key, [postRecord({ text: 'outra' })], { ...idem, member: '12'.repeat(32) })
  t.is(other.seq, a.seq + 1, 'another member is another write')
  const target = hex(crypto.keyPair().publicKey)
  const f1 = await writer.setFollow(page.key, target, true, idem)
  const f2 = await writer.setFollow(page.key, target, true, idem)
  t.is(f2.seq, f1.seq, 'a follow with the same nonce happens once')
  const img = jpeg(64, 48, 3000)
  const m1 = await writer.mediaItem(page.key, { bytes: img, mime: 'image/jpeg', width: 64, height: 48, sha256: sha(img) }, idem)
  const m2 = await writer.mediaItem(page.key, { bytes: img, mime: 'image/jpeg', width: 64, height: 48, sha256: sha(img) }, idem)
  t.alike(m2, m1)
  t.is(writer.items(page.key).length, 1, 'one media item')
  await t.exception(writer.append(page.key, [postRecord({ text: 'x' })], { member: 'x', nonce: 'y' }), /invalido/)
  const length = writer.info(page.key).length
  await writer.close()

  writer = createPagesWriter({ dir, keys, association: ctx.association, now: () => clock })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  const c = await writer.append(page.key, [postRecord({ text: 'uma' })], idem)
  t.is(c.seq, a.seq, 'the record survives a reopen')
  t.is(writer.info(page.key).length, length)

  clock += 11 * 60 * 1000
  const d = await writer.append(page.key, [postRecord({ text: 'uma' })], idem)
  t.is(d.seq, length, 'an expired record no longer answers')

  t.is(await writer.wipe(page.key), true)
  t.exception(() => writer.info(page.key), /nao-encontrada/, 'a wiped page leaves the table')
})

function closeRecordFor (ctx, page) {
  const fields = { page: page.key, gen: 2, at: new Date().toISOString(), nonce: nonce(), actor: hex(page.owner.publicKey), association: ctx.association }
  return issuerCountersign({ type: 'page-close', ...fields, signature: signClose(fields, page.owner) }, ctx.issuerKp, ctx.issuerCert)
}

// K2 under the same owner and @nome, its page-origin and K1's page-moved.
function moveFor (ctx, keys, from, username, fromSeq, depth) {
  const next = newPage(ctx, keys, username, from.owner)
  const owner = hex(from.owner.publicKey)
  const at = new Date().toISOString()
  const of = { page: next.key, from: from.key, fromSeq, gen: 1, owner, admins: [], at, nonce: nonce(), actor: owner, association: ctx.association }
  const originRecord = issuerCountersign({ type: 'page-origin', ...of, signature: signOrigin(of, from.owner) }, ctx.issuerKp, ctx.issuerCert)
  const mf = { page: from.key, to: next.key, gen: 1, at, nonce: nonce(), actor: owner, association: ctx.association }
  const movedRecord = issuerCountersign({ type: 'page-moved', ...mf, signature: signMoved(mf, from.owner) }, ctx.issuerKp, ctx.issuerCert)
  return { next, args: { from: from.key, to: next.key, ...next.args, originRecord, movedRecord, depth } }
}

async function openRaw (t, dir, key, publicKey) {
  const core = new Hypercore(path.join(dir, 'pages-store', key), { keyPair: { publicKey }, compat: true, valueEncoding: 'json' })
  await core.ready()
  t.teardown(() => core.close().catch(() => {}))
  return core
}

test('pages-writer: closePage unfollows, deletes, closes and clears; unpushed, the page stays served and keyed', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'encerra')
  await writer.createPage(page.args)
  const target = hex(crypto.keyPair().publicKey)
  await writer.setFollow(page.key, target, true)
  const pic = jpeg(64, 64, 3000)
  const item = await writer.mediaItem(page.key, { bytes: pic, mime: 'image/jpeg', width: 64, height: 64, sha256: sha(pic) })
  const profile = await writer.append(page.key, [profileRecord({ name: 'Encerra' })])
  const post = await writer.append(page.key, [postRecord({ text: 'adeus', media: [item] })])
  const dmFile = path.join(dir, 'pages-dm', page.key + '.json')
  fs.mkdirSync(path.dirname(dmFile), { recursive: true })
  fs.writeFileSync(dmFile, '{}')

  const closeRecord = closeRecordFor(ctx, page)
  const length = writer.info(page.key).length
  await t.exception(writer.closePage(page.key, { deletes: [deleteRecord({ seq: 2 })], closeRecord }), /invalido/, 'a roster is never a delete target')
  await t.exception(writer.closePage(page.key, { closeRecord: { ...closeRecord, page: target } }), /invalido/, 'a close of another page')
  t.is(writer.info(page.key).length, length, 'refusals append nothing')

  const unfollows = [followRecord({ key: target, on: false })]
  const deletes = [deleteRecord({ seq: profile.seq }), deleteRecord({ seq: post.seq, media: [item] })]
  const res = await writer.closePage(page.key, { unfollows, deletes, closeRecord })
  t.is(res.closed, true)
  t.is(res.length, length + 4, 'unfollow, two tombstones, page-close')
  t.is(res.cleared, 2)
  t.is(res.pushed, false, 'no link')
  t.is(res.wiped, false, 'the secrets wait for the close to reach the seeder')
  t.ok(keys.get(page.key))
  t.absent(fs.existsSync(dmFile), 'the sealed DM rows are removed')
  t.is(writer.info(page.key).announced, true, 'still announced, read only')
  t.is(JSON.parse(fs.readFileSync(path.join(dir, 'pages-store', page.key + '.json'), 'utf8')).closed, true)
  await t.exception(writer.append(page.key, [postRecord({ text: 'depois' })]), /encerrada/)
  const again = await writer.closePage(page.key, { closeRecord })
  t.alike([again.closed, again.length, again.wiped], [true, res.length, false], 'a retry finishes without appending')
  await writer.close()

  const reopened = createPagesWriter({ dir, keys, association: ctx.association })
  await reopened.ready()
  t.is(reopened.info(page.key).length, res.length, 'reopens closed, read only')
  await t.exception(reopened.append(page.key, [postRecord({ text: 'x' })]), /encerrada/)
  await reopened.close()

  const core = await openRaw(t, dir, page.key, b4a.from(page.key, 'hex'))
  const raw = await readRaw(core)
  t.is(applyDeletes(raw).filter((e) => e.record && e.record.type === 'post').length, 0, 'a follower fold hides the post')
  t.absent(await core.has(post.seq), 'the post block is cleared')
  t.ok(await core.has(0), 'block 0 stays')
  t.ok(pageLifecycle(raw, page.key, ctx.association).closed, 'the close verifies')
  const media = new Hypercore(path.join(dir, 'pages-store', page.key + '-media'), { keyPair: { publicKey: b4a.from(item.core, 'hex') }, compat: true })
  await media.ready()
  t.teardown(() => media.close().catch(() => {}))
  t.absent(await media.has(item.start), 'the media blocks are cleared')
})

// The close list the route builds (closeDeletes in ../lib/account/pages-routes.js).
async function routeCloseList (writer, key) {
  const unfollows = writer.follows(key).map((f) => followRecord({ key: f.key, on: false }))
  const deletes = []
  for (const e of applyDeletes(await writer.readEntries(key))) {
    if (!e || e.deleted || e.seq < 1 || !e.record || e.record.type !== 'post') continue
    const media = Array.isArray(e.record.media) ? e.record.media.map((d) => ({ core: d.core, start: d.start, blocks: d.blocks })) : undefined
    deletes.push(...deleteRecords({ seq: e.seq, media }))
  }
  return { unfollows, deletes }
}

test('pages-writer: a close cut short never splits the tombstones of one post, so its retry frees every photo', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let cutAfter = -1
  // Refuses once, after the first batch of the close is saved (a refusal
  // while it saves would pause the page instead), then lets the retry run.
  const guard = () => {
    if (cutAfter < 0 || JSON.parse(stateBytes(dir, page.key)).length <= cutAfter) return true
    cutAfter = -1
    return false
  }
  const writer = createPagesWriter({ dir, keys, association: ctx.association, guard })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'dezfotos')
  await writer.createPage(page.args)
  for (let i = 0; i < 7; i++) await writer.setFollow(page.key, hex(crypto.keyPair().publicKey), true)
  const items = []
  for (let i = 0; i < 10; i++) {
    const pic = jpeg(64, 64, 3000 + i)
    items.push(await writer.mediaItem(page.key, { bytes: pic, mime: 'image/jpeg', width: 64, height: 64, sha256: sha(pic) }))
  }
  const post = await writer.append(page.key, [postRecord({ text: 'dez fotos', media: items })])

  const first = await routeCloseList(writer, page.key)
  t.is(first.unfollows.length + first.deletes.length, 10, '7 unfollows and 3 tombstones of one post')
  cutAfter = writer.info(page.key).length
  await t.exception(writer.closePage(page.key, { ...first, closeRecord: closeRecordFor(ctx, page) }), /indisponivel/, 'the second batch fails')
  t.ok(writer.info(page.key).length > cutAfter, 'the first batch landed')

  const retry = await routeCloseList(writer, page.key)
  const res = await writer.closePage(page.key, { ...retry, closeRecord: closeRecordFor(ctx, page) })
  t.is(res.closed, true)
  await writer.close()

  const raw = await readRaw(await openRaw(t, dir, page.key, b4a.from(page.key, 'hex')))
  const freed = raw.filter((e) => e.record && e.record.type === 'delete' && e.record.seq === post.seq).flatMap((e) => e.record.media || [])
  for (const it of items) t.ok(freed.some((r) => r.core === it.core && r.start === it.start && r.blocks === it.blocks), 'photo at ' + it.start + ' is on a tombstone')
})

test('pages-writer: a paused page gets no close or page-moved; its move still creates K2', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let writer = createPagesWriter({ dir, keys, association: ctx.association })
  const page = newPage(ctx, keys, 'parada')
  await writer.createPage(page.args)
  await writer.close()
  const publicKey = page.row.secretKey.subarray(32)
  const rogue = await openRaw(t, dir, page.key, publicKey)
  rogue.setKeyPair({ publicKey, secretKey: page.row.secretKey })
  await rogue.append(postRecord({ text: 'vazada' }))
  await rogue.close()

  writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  const length = writer.info(page.key).length
  t.alike(await writer.closePage(page.key, { closeRecord: closeRecordFor(ctx, page) }), { paused: true })
  t.is(writer.info(page.key).length, length, 'no close appended')
  t.ok(keys.get(page.key), 'nothing wiped')

  const move = moveFor(ctx, keys, page, 'parada', length, 2)
  const res = await writer.movePage(move.args)
  t.is(res.paused, true)
  t.is(res.moved, null)
  t.alike(res.record, move.args.movedRecord, 'the record for a detached statement')
  t.is(res.key, move.next.key)
  t.is(writer.info(page.key).length, length, "K1's length is unchanged")
  const entries = await writer.readEntries(move.next.key)
  t.alike(entries.map((e) => e.record.type), ['member-cert', 'username', 'page-roster', 'page-origin'])
  t.ok(originOf(entries, move.next.key, ctx.association), 'the origin verifies')
  await t.exception(writer.movePage(moveFor(ctx, keys, page, 'parada', length, 2).args), /movida/, 'one move per page')
})

test('pages-writer: movePage on a live page appends page-moved, then K1 refuses appends; depth 5 refused', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let writer = createPagesWriter({ dir, keys, association: ctx.association })
  const page = newPage(ctx, keys, 'muda')
  await writer.createPage(page.args)
  await writer.append(page.key, [postRecord({ text: 'antes' })])
  const length = writer.info(page.key).length

  const deep = moveFor(ctx, keys, page, 'muda', length, 5)
  await t.exception(writer.movePage(deep.args), /limite/, 'depth 5')
  t.absent(fs.existsSync(path.join(dir, 'pages-store', deep.next.key)), 'no K2 for a refused depth')
  const bad = moveFor(ctx, keys, page, 'muda', length, 2)
  await t.exception(writer.movePage({ ...bad.args, movedRecord: { ...bad.args.movedRecord, to: page.key } }), /invalido/)
  t.absent(fs.existsSync(path.join(dir, 'pages-store', bad.next.key)), 'no K2 for a refused move')

  const move = moveFor(ctx, keys, page, 'muda', length, 4)
  const res = await writer.movePage(move.args)
  t.is(res.moved, length)
  t.absent(res.paused)
  t.is(res.pushed, false, 'no link')
  t.is(res.wiped, false, "K1's secrets wait for K2's push")
  t.ok(keys.get(page.key))
  const k1 = await writer.readEntries(page.key)
  t.is(k1[k1.length - 1].record.type, 'page-moved')
  t.alike(pageLifecycle(k1, page.key, ctx.association).movedTo, { to: move.next.key, seq: length })
  t.alike((await writer.readEntries(move.next.key)).map((e) => e.record.type), ['member-cert', 'username', 'page-roster', 'page-origin'])
  await t.exception(writer.append(page.key, [postRecord({ text: 'depois' })]), /movida/)
  t.is(writer.info(page.key).length, length + 1)
  t.ok(await writer.append(move.next.key, [postRecord({ text: 'nova casa' })]), 'K2 is writable')
  await writer.close()

  writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await t.exception(writer.append(page.key, [postRecord({ text: 'depois' })]), /movida/, 'still read only after a reopen')
})

test('pages-writer: a moved K1 is wiped once K2 is pushed and stays served read only', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const ctx = setup()
  const { seeder } = await startSeeder(t, bootstrap, ctx)
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const seederWs = 'http://127.0.0.1:' + server.port
  let writer = createPagesWriter({ dir, keys, association: ctx.association, seederWs })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await until(() => writer.connected(), { name: 'link up', timeoutMs: 20000 })
  const page = newPage(ctx, keys, 'viaja')
  await writer.createPage(page.args)
  const length = writer.info(page.key).length
  const move = moveFor(ctx, keys, page, 'viaja', length, 2)
  const res = await writer.movePage(move.args)
  t.is(res.pushed, true)
  t.is(res.wiped, true)
  t.is(keys.get(page.key), null, "K1's secrets are gone")
  t.ok(keys.get(move.next.key), "K2's are kept")
  t.alike(writer.info(page.key), { length: length + 1, paused: false, announced: true, movedTo: move.next.key }, 'K1 is still announced')
  await writer.close()

  writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  t.is(writer.info(page.key).length, length + 1, 'K1 reopens without its row')
  await t.exception(writer.append(page.key, [postRecord({ text: 'x' })]), /movida/)
})

test('pages-writer: a closed page is wiped at its later push, after a restart, and stays served', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let writer = createPagesWriter({ dir, keys, association: ctx.association })
  const page = newPage(ctx, keys, 'fecha')
  await writer.createPage(page.args)
  const pic = jpeg(64, 64, 3000)
  await writer.mediaItem(page.key, { bytes: pic, mime: 'image/jpeg', width: 64, height: 64, sha256: sha(pic) })
  const res = await writer.closePage(page.key, { closeRecord: closeRecordFor(ctx, page) })
  t.is(res.wiped, false)
  await writer.close()

  const { seeder } = await startSeeder(t, bootstrap, ctx)
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  writer = createPagesWriter({ dir, keys, association: ctx.association, seederWs: 'http://127.0.0.1:' + server.port })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await until(() => keys.get(page.key) === null, { name: 'wiped after the push', timeoutMs: 30000 })
  t.pass('the deferred wipe ran once the seeder held the close')
  t.is(writer.info(page.key).length, res.length, 'still served')
  const again = await writer.closePage(page.key, { closeRecord: closeRecordFor(ctx, page) })
  t.alike([again.closed, again.length, again.wiped], [true, res.length, true], 'a retry after the wipe still answers')
  await writer.close()
  for (const file of walk(dir)) {
    const buf = fs.readFileSync(file)
    t.absent(holdsSecret(buf, page.row.secretKey) || holdsSecret(buf, page.row.mediaSecretKey), 'no secret in ' + path.relative(dir, file))
  }

  writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  t.is(writer.info(page.key).announced, true, 'reopens without its row, announced')
})

test('pages-writer: a move whose K1 save failed is wiped after a restart; a keyless K1 still serves its media', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let writer = createPagesWriter({ dir, keys, association: ctx.association })
  const page = newPage(ctx, keys, 'migra')
  await writer.createPage(page.args)
  const pic = jpeg(64, 64, 3000)
  const item = await writer.mediaItem(page.key, { bytes: pic, mime: 'image/jpeg', width: 64, height: 64, sha256: sha(pic) })
  await writer.append(page.key, [postRecord({ text: 'foto', media: [item] })])
  const move = moveFor(ctx, keys, page, 'migra', writer.info(page.key).length, 2)
  const res = await writer.movePage(move.args)
  t.is(res.wiped, false)
  await writer.close()
  // The save after page-moved never landed.
  const file = path.join(dir, 'pages-store', page.key + '.json')
  const st = JSON.parse(fs.readFileSync(file, 'utf8'))
  st.movedTo = null
  fs.writeFileSync(file, JSON.stringify(st), { mode: 0o600 })

  const { seeder } = await startSeeder(t, bootstrap, ctx)
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const seederWs = 'http://127.0.0.1:' + server.port
  writer = createPagesWriter({ dir, keys, association: ctx.association, seederWs })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  t.is(JSON.parse(fs.readFileSync(file, 'utf8')).movedTo, move.next.key, 'movedTo restored from the log')
  let gone = false
  try {
    gone = await until(() => keys.get(page.key) === null, { name: 'K1 wiped', timeoutMs: 30000 })
  } catch {}
  t.ok(gone, "K1's secrets go once K2 is pushed")
  await writer.close()

  writer = createPagesWriter({ dir, keys, association: ctx.association, seederWs })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await until(() => writer.connected(), { name: 'link up', timeoutMs: 20000 })
  const mediaUrl = '/media/' + page.key + '/' + item.core + '/' + item.start + '/' + item.blocks
  let got = null
  try {
    got = await until(async () => {
      const r = await mediaGet(server.port, mediaUrl)
      return r.status === 200 ? r : null
    }, { name: 'media served', timeoutMs: 30000 })
  } catch {}
  t.ok(got !== null && b4a.equals(got.body, pic), "a keyless K1's media is still served")
})

test('pages-writer: K2 is announced only once page-moved landed on K1', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const real = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  let from = null
  let reads = 0
  const keys = {
    get enabled () { return real.enabled },
    get: (k) => {
      if (k === from && ++reads === 2) return null
      return real.get(k)
    },
    put: (k, r) => real.put(k, r),
    pending: (n) => real.pending(n),
    wipe: (k) => real.wipe(k)
  }
  const writer = createPagesWriter({ dir, keys: real, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, real, 'anuncia')
  await writer.createPage(page.args)
  await writer.close()

  const w2 = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => w2.close(), { force: true })
  await w2.ready()
  const move = moveFor(ctx, real, page, 'anuncia', w2.info(page.key).length, 2)
  from = page.key
  await t.exception(w2.movePage(move.args), /chave-ausente/, "K1's append fails")
  t.is(w2.info(move.next.key).announced, false, 'K2 is never announced')
  t.is(JSON.parse(fs.readFileSync(path.join(dir, 'pages-store', move.next.key + '.json'), 'utf8')).announced, false)

  const ok = moveFor(ctx, real, { ...page, key: move.next.key }, 'anuncia', 4, 2)
  from = null
  const res = await w2.movePage(ok.args)
  t.is(res.moved, 4)
  t.is(w2.info(ok.next.key).announced, true, 'announced after page-moved')
})

test('pages-writer: an unsigned page-moved from a leaked key pauses the page but never ends it', async (t) => {
  const ctx = setup()
  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const writer = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => writer.close(), { force: true })
  const page = newPage(ctx, keys, 'vazada')
  await writer.createPage(page.args)
  await writer.close()

  // The leaked key appends a bare page-moved, with no signatures.
  const pub = page.row.secretKey.subarray(32)
  const rogue = new Hypercore(path.join(dir, 'pages-store', page.key), { keyPair: { publicKey: pub }, compat: true })
  await rogue.ready()
  rogue.setKeyPair({ publicKey: pub, secretKey: page.row.secretKey })
  await rogue.append(b4a.from(JSON.stringify({ type: 'page-moved', page: page.key, to: 'cd'.repeat(32) })))
  await rogue.close()

  const w2 = createPagesWriter({ dir, keys, association: ctx.association })
  t.teardown(() => w2.close(), { force: true })
  await w2.ready()
  t.is(w2.info(page.key).paused, true, 'the foreign block pauses the page')
  t.is(w2.info(page.key).movedTo, null, 'an unsigned page-moved moves nothing')
  await t.exception(w2.append(page.key, [postRecord({ text: 'x' })]), /pausada/, 'paused, not movida: the owner can still close or move')
})
