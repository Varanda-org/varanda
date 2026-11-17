'use strict'

// A hosted page's post, reply and quote with a short video ([JPEG poster,
// video/mp4]) or a link card (the music card included), as a person's post
// carries them (apps/cli/lib/account/pages-routes.js media, post, reply,
// quote, delete and close; pages-writer.js mediaItem), end to end over
// loopback with the same account service and real pages writer as
// pages-listing.test.js.

const nodeCrypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signClose } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { postRecord, validateRecord } = require('@varanda/core/lib/records')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { stripVideoMetadata, videoBounds, BLOCKED_TERMS } = require('@varanda/rpc')
const { startSeedWs } = require('../lib/seed-ws')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createAccountServer } = require('../lib/account/server')
const { MAX_MEDIA_BODY } = require('../lib/account/pages-routes')

const ORIGIN = 'https://varanda.test'
const PAGE_KEYS = 'cd'.repeat(32)
const MUSIC_URL = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC#varanda-musica'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function member () {
  const kp = crypto.keyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function googleStub () {
  return { authorizeUrl: () => 'http://127.0.0.1:1/auth', exchange: async () => { throw new Error('unused') } }
}

let subSeq = 300
async function linkDirect (store, ctx, m, username) {
  const row = store.start({ member: m.hex, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: '40000000000000000' + String(subSeq++).padStart(5, '0'), email: 'p@example.test' })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, ctx.issuerKp, ctx.issuerCert, ctx.association)
}

function be16 (n) {
  return [(n >> 8) & 0xff, n & 0xff]
}

function jpeg (width, height, size, fill = 0x5a) {
  const head = b4a.from([0xff, 0xd8, 0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
  const out = b4a.alloc(size, fill)
  head.copy(out, 0)
  out[size - 2] = 0xff
  out[size - 1] = 0xd9
  return out
}

// A synthetic short video (packages/web-member/test/session-media.test.js
// builder): ftyp, moov (mvhd, one H.264 avc1 track), mdat. Raw, it carries
// the encoder's compressorname (and a camera place tag with udta), which
// stripVideoMetadata clears; the app uploads the stripped copy.
function mp4 ({ ms = 3000, width = 640, height = 360, udta = false } = {}) {
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const ascii = (str) => Array.from(str, (c) => c.charCodeAt(0))
  const zeros = (n) => new Array(n).fill(0)
  const box = (kind, ...parts) => { const body = parts.flat(); return [...be32(8 + body.length), ...ascii(kind), ...body] }
  const full = (kind, ...parts) => box(kind, [0, 0, 0, 0], ...parts)
  const n = 30
  const q = Math.floor(ms / n)
  const runs = [[n - 1, q], [1, ms - (n - 1) * q]]
  const one = 0x10000
  const avcC = box('avcC', [1, 100, 0, 40, 0xff, 0xe1], be16(6), [0x67, 100, 0, 40, 0xac, 0xd9], [1], be16(4), [0x68, 0xeb, 0xe3, 0xcb])
  const entry = box('avc1', zeros(6), be16(1), zeros(16), be16(width), be16(height), be32(0x480000), be32(0x480000), be32(0), be16(1),
    [4, ...ascii('x264'), ...zeros(27)], be16(0x18), be16(0xffff), avcC, box('pasp', be32(1), be32(1)))
  const moovOf = (offset) => box('moov',
    full('mvhd', be32(0), be32(0), be32(1000), be32(ms), zeros(16), ...[one, 0, 0, 0, one, 0, 0, 0, 0x40000000].map(be32), zeros(28)),
    box('trak',
      box('tkhd', [0, 0, 0, 7], be32(0), be32(0), be32(1), be32(0), be32(ms), zeros(16),
        ...[one, 0, 0, 0, one, 0, 0, 0, 0x40000000].map(be32), be32(width * one), be32(height * one)),
      box('mdia',
        full('mdhd', be32(0), be32(0), be32(1000), be32(ms), [0x55, 0xc4, 0, 0]),
        full('hdlr', be32(0), ascii('vide'), zeros(12), [0]),
        box('minf', box('vmhd', [0, 0, 0, 1], zeros(8)), box('dinf', full('dref', be32(1), box('url ', [0, 0, 0, 1]))),
          box('stbl', full('stsd', be32(1), entry), full('stts', be32(runs.length), ...runs.map(([c, d]) => [...be32(c), ...be32(d)])),
            full('stsc', be32(1), be32(1), be32(n), be32(1)), full('stsz', be32(0), be32(n), ...new Array(n).fill(be32(10))),
            full('stco', be32(1), be32(offset)))))),
    ...(udta ? [box('udta', box('©xyz', be16(18), be16(0x15c7), ascii('+12.3456-045.6789/')))] : []))
  const head = box('ftyp', ascii('isom'), be32(0x200), ascii('isom'), ascii('avc1'))
  const offset = head.length + moovOf(0).length + 8
  return b4a.from([...head, ...moovOf(offset), ...box('mdat', new Array(n * 10).fill(1))])
}

function clean (opts) {
  return b4a.from(stripVideoMetadata(mp4(opts)))
}

function sha (bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
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

async function setup (t) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  const ctx = { assocKp, association, issuerKp, issuerCert, bootstrap }

  const dir = tmpDir(t, 'varanda-account-')
  const store = openAccountStore(dir)
  const terms = openTermsStore(dir)
  const opts = {
    association,
    origin: ORIGIN,
    google: googleStub(),
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log: () => {},
    // About 80 requests: past the default global bucket of 100 with starts.
    ratePerSecond: 1000,
    burst: 1000
  }
  const seederDir = prepareSeederDir(t, assocKp)
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), associationKey: association, log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })

  let listener = null
  let base = null
  async function boot () {
    const writer = createPagesWriter({ dir, keys, association, seederWs: 'http://127.0.0.1:' + ws.port, log: () => {} })
    t.teardown(() => writer.close(), { force: true })
    await writer.ready()
    await until(() => writer.connected(), { name: 'link up', timeoutMs: 20000 })
    ctx.writer = writer
    ctx.pagesStore = openPagesStore(dir)
    opts.pages = { keys, writer, pagesStore: ctx.pagesStore, dir, blocklist: { has: () => false } }
    const server = createAccountServer(opts)
    listener = await server.listen({ host: '127.0.0.1', port: 0 })
    t.teardown(() => listener.close(), { force: true })
    base = 'http://127.0.0.1:' + listener.port
  }
  await boot()

  async function restart () {
    await listener.close()
    await ctx.writer.close()
    await boot()
  }

  async function api (method, pathname, body, headers = {}) {
    const init = { method, headers: { ...headers } }
    if (body !== undefined) {
      init.headers.origin = ORIGIN
      if (b4a.isBuffer(body)) {
        init.headers['content-type'] = 'application/octet-stream'
        init.body = body
      } else {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  let termsCount = 0
  async function newMember (username) {
    const m = member()
    await linkDirect(store, ctx, m, username)
    termsCount++
    await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: (String(termsCount) + 'T'.repeat(43)).slice(0, 43), signature: 'a'.repeat(128) })
    return m
  }

  async function start (m, action) {
    const r = await api('POST', '/account/pages/start', { member: m.hex, action })
    if (r.status !== 200) throw new Error('start ' + action + ' ' + r.status + ' ' + JSON.stringify(r.body))
    return r.body
  }

  function sign (m, action, nonce, page, op) {
    return signPage({ action, nonce, member: m.hex, page, association, opHash: opHash(op) }, m.kp)
  }

  async function act (m, action, page, op) {
    const { nonce } = await start(m, action)
    const body = { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op) }
    return api('POST', '/account/pages/' + action, body)
  }

  async function create (m, username) {
    const { nonce, page } = await start(m, 'create')
    const f = { page, gen: 1, owner: m.hex, admins: [], prev: null, at: new Date().toISOString(), nonce, association }
    const record = { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
    const op = { username, name: 'Página ' + username, bio: '', roster: { gen: 1, admins: [], prev: null, at: record.at, nonce } }
    const r = await api('POST', '/account/pages/create', { member: m.hex, nonce, page, op, signature: sign(m, 'create', nonce, page, op), record })
    return { ...r, page }
  }

  async function upload (m, page, bytes, op) {
    const { nonce } = await start(m, 'media')
    return api('POST', '/account/pages/media', bytes, {
      'x-varanda-page-member': m.hex,
      'x-varanda-page-nonce': nonce,
      'x-varanda-page-page': page,
      'x-varanda-page-signature': sign(m, 'media', nonce, page, op),
      'x-varanda-page-op': JSON.stringify(op)
    })
  }

  async function close (m, page) {
    const { nonce } = await start(m, 'close')
    const f = { page, gen: ctx.pagesStore.get(page).gen + 1, at: new Date().toISOString(), nonce, actor: m.hex, association }
    return api('POST', '/account/pages/close', { member: m.hex, nonce, page, record: { type: 'page-close', ...f, signature: signClose(f, m.kp) } })
  }

  return { ctx, api, newMember, act, create, upload, close, restart }
}

function photoOp (bytes, width, height, extra = {}) {
  return { sha256: sha(bytes), mime: 'image/jpeg', width, height, bytes: bytes.length, ...extra }
}

function videoOp (bytes, extra = {}) {
  return { sha256: sha(bytes), mime: 'video/mp4', width: 640, height: 360, bytes: bytes.length, ms: 3000, ...extra }
}

async function recordAt (ctx, page, seq) {
  const e = (await ctx.writer.readEntries(page)).find((x) => x.seq === seq)
  return e ? e.record : null
}

async function deletesOf (ctx, page) {
  return (await ctx.writer.readEntries(page)).filter((e) => e.record && e.record.type === 'delete').map((e) => e.record)
}

function freed (dels, seq, d) {
  return dels.some((r) => r.seq === seq && Array.isArray(r.media) && r.media.some((m) => m.core === d.core && m.start === d.start && m.blocks === d.blocks))
}

test('page media: a video pair and a link card as a person posts them, refusals, restart, delete and close', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const caio = await s.newMember('caio')

  const made = await s.create(ana, 'cineclube')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  const other = await s.create(caio, 'outra')
  t.is(other.status, 200, JSON.stringify(other.body))

  // Uploads: a poster, the stripped video, a thumbnail of a card.
  const posterBytes = jpeg(640, 360, 20 * 1024)
  const poster = await s.upload(ana, K, posterBytes, photoOp(posterBytes, 640, 360))
  t.is(poster.status, 200, JSON.stringify(poster.body))
  const P = poster.body.descriptor
  const videoBytes = clean()
  t.ok(videoBytes.equals(b4a.from(stripVideoMetadata(videoBytes))), 'the fixture is already stripped')
  // The app's own ms is within the tolerance; the container's is stored.
  const video = await s.upload(ana, K, videoBytes, videoOp(videoBytes, { ms: 3400 }))
  t.is(video.status, 200, JSON.stringify(video.body))
  const V = video.body.descriptor
  t.is(V.mime, 'video/mp4')
  t.is(V.ms, videoBounds(videoBytes).ms, 'the stored duration is the container\'s')
  t.is(V.sha256, sha(videoBytes), 'the bytes are stored as uploaded')
  const thumbBytes = jpeg(320, 180, 12 * 1024, 0x33)
  const thumb = await s.upload(ana, K, thumbBytes, photoOp(thumbBytes, 320, 180))
  t.is(thumb.status, 200, JSON.stringify(thumb.body))
  const T = thumb.body.descriptor

  // Upload refusals store nothing.
  const items = ctx.writer.items(K).length
  let length = ctx.writer.info(K).length
  const raw = mp4()
  t.is((await s.upload(ana, K, raw, videoOp(raw))).body.error, 'midia-invalida', 'an mp4 the strip would change (encoder name)')
  const tagged = mp4({ udta: true })
  t.is((await s.upload(ana, K, tagged, videoOp(tagged))).body.error, 'midia-invalida', 'an mp4 with a place tag')
  const long = mp4({ ms: 30001 })
  t.is((await s.upload(ana, K, long, videoOp(long, { ms: 30000 }))).body.error, 'midia-invalida', 'a container past 30 s')
  t.is((await s.upload(ana, K, videoBytes, videoOp(videoBytes, { ms: 30001 }))).body.error, 'midia-invalida', 'ms past 30 s')
  t.is((await s.upload(ana, K, videoBytes, videoOp(videoBytes, { ms: 5000 }))).body.error, 'midia-invalida', 'ms far from the container')
  t.is((await s.upload(ana, K, videoBytes, videoOp(videoBytes, { width: 360, height: 640 }))).body.error, 'midia-invalida', 'sides not the container\'s')
  const noMs = videoOp(videoBytes)
  delete noMs.ms
  t.is((await s.upload(ana, K, videoBytes, noMs)).body.error, 'midia-invalida', 'a video without ms')
  t.is((await s.upload(ana, K, posterBytes, photoOp(posterBytes, 640, 360, { ms: 3000 }))).body.error, 'midia-invalida', 'ms on a photo')
  t.is((await s.upload(ana, K, posterBytes, videoOp(posterBytes))).body.error, 'midia-invalida', 'a jpeg labelled video')
  const huge = await s.upload(ana, K, videoBytes, videoOp(videoBytes, { bytes: MAX_MEDIA_BODY + 1 }))
  t.is(huge.body.error, 'midia-invalida', 'past the item cap')
  t.is((await s.upload(caio, K, videoBytes, videoOp(videoBytes))).body.error, 'sem-permissao', 'a stranger')
  t.is(ctx.writer.items(K).length, items, 'no item stored')
  t.is(ctx.writer.info(K).length, length, 'nothing appended')

  // A video post: the same record a person's post would be.
  const vpost = await s.act(ana, 'post', K, { text: 'trailer', media: [P, V] })
  t.is(vpost.status, 200, JSON.stringify(vpost.body))
  let rec = await recordAt(ctx, K, vpost.body.seq)
  t.alike(rec, postRecord({ text: 'trailer', media: [P, V], at: rec.at }))
  t.is(validateRecord(rec, vpost.body.seq), null)
  t.alike(rec.media[1].ms, V.ms)
  const vreply = await s.act(ana, 'reply', K, { to: K + ':' + vpost.body.seq, text: '', media: [P, V] })
  t.is(vreply.status, 200, JSON.stringify(vreply.body))
  rec = await recordAt(ctx, K, vreply.body.seq)
  t.alike(rec, postRecord({ text: '', replyTo: { author: K, seq: vpost.body.seq }, media: [P, V], at: rec.at }))
  const vquote = await s.act(ana, 'quote', K, { to: K + ':' + vpost.body.seq, text: 'olhem', media: [P, V] })
  t.is(vquote.status, 200, JSON.stringify(vquote.body))
  rec = await recordAt(ctx, K, vquote.body.seq)
  t.alike(rec, postRecord({ text: 'olhem', quote: { author: K, seq: vpost.body.seq }, media: [P, V], at: rec.at }))

  // A link card and the music card.
  const card = { url: 'https://example.com/filme?id=7', title: 'Filme da semana', desc: 'Sessão às 20h', image: T }
  const lpost = await s.act(ana, 'post', K, { text: 'sessão hoje', preview: card })
  t.is(lpost.status, 200, JSON.stringify(lpost.body))
  rec = await recordAt(ctx, K, lpost.body.seq)
  t.alike(rec, postRecord({ text: 'sessão hoje', preview: { ...card, host: 'example.com' }, at: rec.at }))
  t.is(validateRecord(rec, lpost.body.seq), null)
  const music = await s.act(ana, 'quote', K, { to: K + ':' + lpost.body.seq, text: 'trilha', preview: { url: MUSIC_URL, host: 'open.spotify.com', title: 'Trilha', image: T } })
  t.is(music.status, 200, JSON.stringify(music.body))
  rec = await recordAt(ctx, K, music.body.seq)
  t.alike(rec, postRecord({ text: 'trilha', quote: { author: K, seq: lpost.body.seq }, preview: { url: MUSIC_URL, host: 'open.spotify.com', title: 'Trilha', desc: '', image: T }, at: rec.at }))
  const bare = await s.act(ana, 'reply', K, { to: K + ':' + lpost.body.seq, text: 'link', preview: { url: 'https://example.org/' } })
  t.is(bare.status, 200, JSON.stringify(bare.body))
  rec = await recordAt(ctx, K, bare.body.seq)
  t.alike(rec.preview, { url: 'https://example.org/', host: 'example.org', title: '', desc: '', image: null })

  // Post refusals append nothing.
  length = ctx.writer.info(K).length
  const otherPoster = jpeg(640, 360, 20 * 1024, 0x44)
  const foreignUp = await s.upload(caio, other.page, otherPoster, photoOp(otherPoster, 640, 360))
  t.is(foreignUp.status, 200, JSON.stringify(foreignUp.body))
  const F = foreignUp.body.descriptor
  const big = jpeg(640, 360, 40 * 1024, 0x22)
  const bigUp = await s.upload(ana, K, big, photoOp(big, 640, 360))
  t.is(bigUp.status, 200, JSON.stringify(bigUp.body))
  const B = bigUp.body.descriptor
  length = ctx.writer.info(K).length
  const refusals = [
    [{ text: 'x', media: [F, V] }, 'midia-invalida', 'a poster of another page'],
    [{ text: 'x', media: [P, { ...V, sha256: 'ab'.repeat(32) }] }, 'midia-invalida', 'a video the page never stored'],
    [{ text: 'x', media: [P, { ...V, ms: V.ms - 1 }] }, 'midia-invalida', 'another ms'],
    [{ text: 'x', media: [V, P] }, 'midia-invalida', 'the video first'],
    [{ text: 'x', media: [P, V, T] }, 'midia-invalida', 'three items with a video'],
    [{ text: 'x', media: [V] }, 'midia-invalida', 'a video alone'],
    [{ text: 'x', media: [{ ...P, ms: 3000 }] }, 'midia-invalida', 'ms on a photo descriptor'],
    [{ text: 'x', media: [P, V], preview: card }, 'pedido-invalido', 'a video and a card'],
    [{ text: 'x', media: [P], preview: card }, 'pedido-invalido', 'a photo and a card'],
    [{ text: 'x', preview: { ...card, image: B } }, 'midia-invalida', 'a thumbnail past 32 KiB'],
    [{ text: 'x', preview: { ...card, image: V } }, 'midia-invalida', 'a video thumbnail'],
    [{ text: 'x', preview: { ...card, image: { ...T, core: F.core } } }, 'midia-invalida', 'a thumbnail of another page'],
    [{ text: 'x', preview: { ...card, image: F } }, 'midia-invalida', 'another page\'s thumbnail'],
    [{ text: 'x', preview: { ...card, host: 'evil.example' } }, 'pedido-invalido', 'a host that is not the URL\'s'],
    [{ text: 'x', preview: { ...card, url: 'http://example.com/' } }, 'pedido-invalido', 'not https'],
    [{ text: 'x', preview: { ...card, extra: 1 } }, 'pedido-invalido', 'an unknown card key'],
    [{ text: 'x', preview: { ...card, title: 'a'.repeat(81) } }, 'pedido-invalido', 'a title past 80'],
    [{ text: 'x', preview: { ...card, title: BLOCKED_TERMS[0] } }, 'termo-recusado', 'a blocked term in the title'],
    [{ text: 'x', preview: { ...card, desc: BLOCKED_TERMS[0] } }, 'termo-recusado', 'a blocked term in the desc'],
    [{ text: 'x', preview: { ...card, url: 'https://example.com/' + BLOCKED_TERMS[0] } }, 'termo-recusado', 'a blocked term in the url'],
    [{ text: 'x', preview: 'https://example.com/' }, 'pedido-invalido', 'a card that is not an object']
  ]
  for (const [op, error, name] of refusals) {
    const r = await s.act(ana, 'post', K, op)
    t.is(r.body.error, error, name)
  }
  t.is(ctx.writer.info(K).length, length, 'no refusal appends')

  // After a restart the writer loads the video item and the page is not
  // paused: the same pair still posts.
  await s.restart()
  t.absent(ctx.writer.info(K).paused, 'not paused after a restart')
  t.ok(ctx.writer.items(K).some((it) => it.mime === 'video/mp4' && it.ms === V.ms && it.sha256 === V.sha256), 'the video item reloads')
  const again = await s.act(ana, 'post', K, { text: 'reprise', media: [P, V] })
  t.is(again.status, 200, JSON.stringify(again.body))

  // Delete frees the poster and the video, and a card's thumbnail.
  const delV = await s.act(ana, 'delete', K, { to: K + ':' + vpost.body.seq })
  t.is(delV.status, 200, JSON.stringify(delV.body))
  const delL = await s.act(ana, 'delete', K, { to: K + ':' + lpost.body.seq })
  t.is(delL.status, 200, JSON.stringify(delL.body))
  let dels = await deletesOf(ctx, K)
  t.ok(freed(dels, vpost.body.seq, P), 'the poster range')
  t.ok(freed(dels, vpost.body.seq, V), 'the video range')
  t.ok(freed(dels, lpost.body.seq, T), 'the thumbnail range')

  // Close frees what the page still shows: a new pair and a new card.
  const p2Bytes = jpeg(640, 360, 20 * 1024, 0x66)
  const P2 = (await s.upload(ana, K, p2Bytes, photoOp(p2Bytes, 640, 360))).body.descriptor
  const v2Bytes = clean({ ms: 4000 })
  const V2 = (await s.upload(ana, K, v2Bytes, videoOp(v2Bytes, { ms: 4000 }))).body.descriptor
  const t2Bytes = jpeg(320, 180, 10 * 1024, 0x77)
  const T2 = (await s.upload(ana, K, t2Bytes, photoOp(t2Bytes, 320, 180))).body.descriptor
  t.ok(P2 && V2 && T2, 'uploaded')
  const last = await s.act(ana, 'post', K, { text: 'última', media: [P2, V2] })
  t.is(last.status, 200, JSON.stringify(last.body))
  const lastCard = await s.act(ana, 'post', K, { text: 'último link', preview: { url: MUSIC_URL, image: T2 } })
  t.is(lastCard.status, 200, JSON.stringify(lastCard.body))
  const closed = await s.close(ana, K)
  t.is(closed.status, 200, JSON.stringify(closed.body))
  dels = await deletesOf(ctx, K)
  t.ok(freed(dels, last.body.seq, P2), 'close frees the poster')
  t.ok(freed(dels, last.body.seq, V2), 'close frees the video')
  t.ok(freed(dels, lastCard.body.seq, T2), 'close frees the card thumbnail')
})
