'use strict'

// The public page of a shared post in apps/cli/lib/seed-ws.js over a real
// Seeder on a local testnet (docs/protocol.md section 16): /p/policy, the
// page behind the operator switch, the one uniform 302 for every case that
// shows nothing, the photos checked against their descriptors and the
// re-check of the share after the bytes are read, the page's JSON twin
// (/previa) with its one uniform {"post":null}, the share cover (/capa)
// with its frame size and its own re-check, and the switch being
// independent of the Feira's.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const cert = require('@varanda/core/lib/cert')
const { createCert, createSeederCert, generateAssociationKeyPair } = cert
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { signClose } = require('@varanda/core/lib/page-lifecycle')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const {
  memberCertRecord, postRecord, profileRecord, deleteRecord, mediaCoreRecord, postShareRecord, postCoverRecord, listingRecord, MEDIA_BLOCK_BYTES
} = require('@varanda/core/lib/records')
const { mediaHeader } = require('@varanda/core/lib/media')
const { startSeedWs } = require('../lib/seed-ws')
const avifSamples = require('../../../packages/rpc/test/helpers/avif-samples')
const { mediaBounds } = require('@varanda/rpc')
const { createFakeOgTranscoder, jpegHeader } = require('./helpers/fake-og-transcode')

const ORIGIN = 'https://varanda.test'
const ROBOTS = 'noindex, nofollow, noarchive'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function validCert (assoc, key) {
  return createCert({ member: key }, assoc.kp)
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

const BASE_MS = Date.parse('2026-03-01T12:00:00.000Z')
function at (i) {
  return new Date(BASE_MS + i * 1000).toISOString()
}

const sha = (bytes) => nodeCrypto.createHash('sha256').update(bytes).digest('hex')

function jpeg (size, fill) {
  const b = b4a.alloc(size, fill)
  b[0] = 0xff
  b[1] = 0xd8
  b[2] = 0xff
  return b
}

// A JPEG whose baseline frame header (SOF0, three components) says
// width x height, so stillImageSize reads that size.
function jpegFrame (width, height) {
  return b4a.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9
  ])
}

// Media core blocks 1..6 are JPEGs (IMG[0..5]), block 7 the video bytes,
// block 8 a real AVIF, block 9 an AVIF cut short (its ftyp still there) and
// block 10 a share cover, a JPEG framed 120 x 80.
const IMG = [0, 1, 2, 3, 4, 5].map((i) => jpeg(300 + i, i + 1))
const VIDEO = b4a.concat([b4a.from([0, 0, 0, 0x18]), b4a.from('ftypmp42'), b4a.alloc(500, 9)])
const AVIF = b4a.from(avifSamples.ios.opaque)
const BAD_AVIF = b4a.from(AVIF.subarray(0, 100))
const COVER = jpegFrame(120, 80)

function descriptor (core, start, bytes, hash = sha(bytes)) {
  const blocks = Math.ceil(bytes.byteLength / MEDIA_BLOCK_BYTES)
  return { core, mime: 'image/jpeg', start, blocks, bytes: bytes.byteLength, sha256: hash, width: 100, height: 100 }
}

function avifDescriptor (core, start, bytes) {
  return { core, mime: 'image/avif', start, blocks: 1, bytes: bytes.byteLength, sha256: sha(bytes), width: 16, height: 16 }
}

function videoDescriptor (core, start, bytes) {
  return { core, mime: 'video/mp4', start, blocks: 1, bytes: bytes.byteLength, sha256: sha(bytes), width: 640, height: 360, ms: 5000 }
}

function coverDescriptor (core, start, bytes, over = {}) {
  return { ...descriptor(core, start, bytes), width: 120, height: 80, ...over }
}

const share = (seq, i) => postShareRecord({ seq, at: at(i) })
const coverOf = (seq, image, i) => postCoverRecord({ seq, image, at: at(i) })
const del = (seq, i) => deleteRecord({ seq, at: at(i) })

const HOSTILE = '<script>alert(1)</script> "oi" & \'tchau\''

async function member (t, bootstrap, assoc, records) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  const mediaCore = store.get({ name: 'media-0' })
  await mediaCore.ready()
  await mediaCore.append(b4a.from(JSON.stringify(mediaHeader({ diary: key }))))
  for (const block of IMG) await mediaCore.append(block)
  await mediaCore.append(VIDEO)
  await mediaCore.append(AVIF)
  await mediaCore.append(BAD_AVIF)
  await mediaCore.append(COVER)
  const mediaKey = hex(mediaCore.key)
  await diary.append(memberCertRecord(validCert(assoc, key)))
  for (const r of records(key, mediaKey)) await diary.append(r)

  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const message = (pred, name, timeoutMs = 30000) => until(() => messages.find(pred), { name, timeoutMs })
  return { store, diary, key, mediaKey, mediaCore, seederPeer, message }
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

function settled (seeder, m) {
  return until(() => {
    const entry = seeder._served.get(m.key)
    const length = m.diary.length
    return entry && !entry.scanQueued && entry.scanned >= length && entry.indexed >= length && !entry.indexPaused &&
      entry.feiraIndexed >= length && !entry.feiraQueued
  }, { name: 'diário processado até ' + m.diary.length, timeoutMs: 30000 })
}

function get (port, url, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: '127.0.0.1:' + port }, agent: false }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b4a.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

// A 302 with its Location and Date set aside, for comparing two of them.
function shape (res) {
  const headers = { ...res.headers }
  delete headers.location
  delete headers.date
  return { status: res.status, headers, body: res.body.toString('hex') }
}

const AWAY = {
  status: 302,
  headers: { 'x-robots-tag': ROBOTS, 'cache-control': 'no-store', 'content-length': '0', connection: 'close' },
  body: ''
}

const PREVIA_KEYS = ['v', 'name', 'username', 'date', 'text', 'photoCount', 'morePhotos', 'video', 'relation', 'card']
const PREVIA_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': ROBOTS,
  'cache-control': 'no-store',
  connection: 'close'
}

// Every preview that shows nothing, Date set aside.
function noPreview (method) {
  const body = method === 'HEAD' ? '' : b4a.from('{"post":null}').toString('hex')
  return { status: 200, headers: { ...PREVIA_HEADERS, 'content-length': '13' }, body }
}

function previaShape (res) {
  const headers = { ...res.headers }
  delete headers.date
  return { status: res.status, headers, body: res.body.toString('hex') }
}

test('post pages over a real Seeder: policy, page, the uniform 302, photos, the re-check and the switch', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), associationKey: assoc.hex })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  // A bucket wide enough for this test's burst of page requests (the
  // budget itself is checked in the next test).
  const wide = { pageRate: 1000, pageBurst: 1000, previewRate: 1000, previewBurst: 1000 }
  const on = await startSeedWs({ port: 0, seeder, postsOrigin: ORIGIN, postsLimits: wide })
  t.teardown(() => on.close(), { force: true })
  const off = await startSeedWs({ port: 0, seeder, postsLimits: wide })
  t.teardown(() => off.close(), { force: true })
  const feiraOnly = await startSeedWs({ port: 0, seeder, publicOrigin: ORIGIN, postsLimits: wide })
  t.teardown(() => feiraOnly.close(), { force: true })

  const A = await member(t, bootstrap, assoc, (key, K) => [
    mediaCoreRecord({ key: K, at: at(0) }), // 1
    profileRecord({ name: 'Ana <b>', at: at(1) }), // 2
    postRecord({ text: HOSTILE, at: at(2), media: [0, 1, 2, 3, 4].map((i) => descriptor(K, i + 1, IMG[i])) }), // 3
    share(3, 3), // 4
    postRecord({ text: 'sem share', at: at(4) }), // 5
    postRecord({ text: 'retirado', at: at(5) }), // 6
    share(6, 6), // 7
    del(7, 7), // 8: the share tombstoned
    postRecord({ text: 'apagado', at: at(8) }), // 9
    share(9, 9), // 10
    del(9, 10), // 11: the post tombstoned under a live share
    postRecord({ text: 'vídeo', at: at(11), media: [descriptor(K, 6, IMG[5]), videoDescriptor(K, 7, VIDEO)] }), // 12
    share(12, 12), // 13
    postRecord({ text: 'hash errado', at: at(13), media: [descriptor(K, 1, IMG[0], sha(IMG[1]))] }), // 14
    share(14, 14), // 15
    listingRecord({ kind: 'produto', title: 'Bicicleta', text: 'Pouco usada.', price: 35000, cat: 'esporte', place: { uf: 'SP', city: 'São Paulo', bairro: null }, at: at(15) }), // 16
    postRecord({ text: 'avif', at: at(16), media: [avifDescriptor(K, 8, AVIF), descriptor(K, 1, IMG[0])] }), // 17
    share(17, 17), // 18
    postRecord({ text: 'avif cortado', at: at(18), media: [avifDescriptor(K, 9, BAD_AVIF)] }), // 19
    share(19, 19) // 20
  ])
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === A.mediaCore.length, { name: 'mídia baixada', timeoutMs: 60000 })
  await settled(seeder, A)
  // postPublic also waits for the name index to read the whole diary.
  await until(async () => (await seeder.postPublic(A.key, 3)) !== null, { name: 'publicação 3 visível', timeoutMs: 30000 })
  t.pass('the seeder shows post 3')

  // /p/policy
  for (const [server, enabled] of [[on, true], [off, false], [feiraOnly, false]]) {
    const policy = await get(server.port, '/p/policy')
    t.is(policy.status, 200)
    t.is(policy.body.toString(), JSON.stringify({ enabled }))
    t.is(policy.headers['cache-control'], 'no-store')
    t.is(policy.headers['content-type'], 'application/json; charset=utf-8')
  }

  // The page, switch on.
  const base = '/p/' + A.key + '/3'
  const page = await get(on.port, base)
  t.is(page.status, 200)
  t.is(page.headers['content-type'], 'text/html; charset=utf-8')
  t.is(page.headers['x-robots-tag'], ROBOTS)
  t.is(page.headers['cache-control'], 'no-store')
  t.is(page.headers['referrer-policy'], 'no-referrer')
  t.is(page.headers['x-content-type-options'], 'nosniff')
  t.is(page.headers.location, undefined)
  const html = page.body.toString()
  t.is(page.headers['content-length'], String(page.body.byteLength))
  t.absent(html.includes('<script>'), 'the hostile text is escaped')
  t.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;oi&quot; &amp; &#39;tchau&#39;'), 'the post text')
  t.ok(html.includes('Ana &lt;b&gt;'), 'the author name, escaped')
  t.ok(html.includes('<meta name="robots" content="noindex, nofollow, noarchive">'))
  t.ok(html.includes('<meta property="og:image" content="' + ORIGIN + base + '/foto/1">'), 'og:image on the posts origin')
  t.ok(html.includes('<meta property="og:url" content="' + ORIGIN + base + '">'), 'og:url on the posts origin')
  t.is((html.match(/<meta property="og:image" /g) || []).length, 1, 'exactly one og:image')
  t.ok(html.includes('Mais 1 foto na Varanda'), 'the fifth photo is only counted')
  t.ok(html.includes('href="/publicacao/' + A.key + '/3"'), 'the way into the app')
  const headPage = await get(on.port, base, { method: 'HEAD' })
  t.is(headPage.status, 200)
  t.is(headPage.body.byteLength, 0, 'HEAD has no body')
  t.is(headPage.headers['content-length'], page.headers['content-length'], 'HEAD has the same headers')
  t.is((await get(on.port, base + '?fbclid=x')).status, 200, 'a decorated link still lands on the page')

  // Every case that shows nothing: the same 302, Location aside.
  const cases = [
    ['switch off, a published post', off, A.key, '3'],
    ['only the Feira origin, a published post', feiraOnly, A.key, '3'],
    ['not published', on, A.key, '5'],
    ['the share withdrawn', on, A.key, '6'],
    ['the post deleted', on, A.key, '9'],
    ['a share block', on, A.key, '4'],
    ['a profile block', on, A.key, '2'],
    ['a seq past the log', on, A.key, '99'],
    ['an unknown diary', on, 'f'.repeat(64), '3'],
    ['seq 0', on, A.key, '0'],
    ['a leading zero', on, A.key, '03'],
    ['above MAX_SAFE_INTEGER', on, A.key, String(Number.MAX_SAFE_INTEGER + 2)],
    ['a huge digit string', on, A.key, '9'.repeat(40)]
  ]
  for (const [name, server, h, digits] of cases) {
    for (const method of ['GET', 'HEAD']) {
      const res = await get(server.port, '/p/' + h + '/' + digits, { method })
      t.alike(shape(res), AWAY, name + ' (' + method + ')')
      t.is(res.headers.location, '/publicacao/' + h + '/' + digits, name + ': Location from the path')
    }
  }
  // A page diary is shown like a person's (packages/core/test/
  // seeder-post-page.test.js); a closed or moved one is not.
  const endSeq = seeder._names.endSeq
  seeder._names.endSeq = (k) => k === A.key ? 1 : endSeq(k)
  const closedPage = await get(on.port, base)
  seeder._names.endSeq = endSeq
  t.alike(shape(closedPage), AWAY, 'a closed or moved page')
  t.is((await get(on.port, base)).status, 200, 'shown again once it is open')

  // The preview: what the page shows, as JSON, and the photos it counts are
  // the ones /foto/<n> serves.
  async function served (port, h, seq) {
    let n = 0
    for (let i = 1; i <= 4; i++) if ((await get(port, '/p/' + h + '/' + seq + '/foto/' + i)).status === 200) n++
    return n
  }
  const previa = await get(on.port, base + '/previa')
  t.is(previa.status, 200)
  t.alike(Object.keys(previa.headers).filter((k) => k !== 'date' && k !== 'content-length').sort(), Object.keys(PREVIA_HEADERS).sort(), 'exactly the preview headers')
  for (const [k, v] of Object.entries(PREVIA_HEADERS)) t.is(previa.headers[k], v, k)
  t.is(previa.headers['content-length'], String(previa.body.byteLength))
  t.is(previa.headers['access-control-allow-origin'], undefined, 'no CORS')
  const shownPreview = JSON.parse(previa.body.toString())
  t.alike(Object.keys(shownPreview), ['post'])
  t.alike(Object.keys(shownPreview.post), PREVIA_KEYS)
  t.alike(shownPreview.post, {
    v: 1,
    name: 'Ana <b>',
    username: null,
    date: '01/03/2026',
    text: HOSTILE,
    photoCount: 4,
    morePhotos: 1,
    video: false,
    relation: null,
    card: null
  }, 'the post as the page shows it, not HTML-escaped')
  t.is(shownPreview.post.photoCount, await served(on.port, A.key, '3'), 'photoCount is what /foto/<n> serves')
  t.absent(previa.body.toString().includes(A.key), 'no diary key')
  t.absent(previa.body.toString().includes(K), 'no media key')
  t.absent(/https?:|\/foto\/|sha256|\d{4}-\d{2}-\d{2}T/.test(previa.body.toString()), 'no URL, descriptor or timestamp')
  const headPrevia = await get(on.port, base + '/previa', { method: 'HEAD' })
  t.is(headPrevia.status, 200)
  t.is(headPrevia.body.byteLength, 0, 'HEAD has no body')
  t.is(headPrevia.headers['content-length'], previa.headers['content-length'], 'HEAD has the same length')
  const videoPreview = JSON.parse((await get(on.port, '/p/' + A.key + '/12/previa')).body.toString()).post
  t.is(videoPreview.video, true)
  t.is(videoPreview.photoCount, 1, 'a video post counts only its cover')
  t.is(videoPreview.morePhotos, 0)
  t.is(videoPreview.photoCount, await served(on.port, A.key, '12'), 'the video photoCount is what /foto/<n> serves')

  // Every preview that shows nothing: the same 200, byte for byte.
  for (const [name, server, h, digits] of cases) {
    for (const method of ['GET', 'HEAD']) {
      const res = await get(server.port, '/p/' + h + '/' + digits + '/previa', { method })
      t.alike(previaShape(res), noPreview(method), 'preview: ' + name + ' (' + method + ')')
    }
  }
  seeder._names.endSeq = (k) => k === A.key ? 1 : endSeq(k)
  const closedPreview = await get(on.port, base + '/previa')
  seeder._names.endSeq = endSeq
  t.alike(previaShape(closedPreview), noPreview('GET'), 'preview: a closed or moved page')
  for (const server of [on, off]) {
    for (const url of [base + '/previa?x=1', base + '/previa/x', base + '/previa/', '/p/' + A.key + '/previa']) {
      const res = await get(server.port, url)
      t.is(res.status, 404, 'not the preview: ' + url.slice(67))
      t.is(res.body.toString(), 'não encontrado\n')
    }
    const post = await get(server.port, base + '/previa', { method: 'POST' })
    t.is(post.status, 405, 'POST /previa')
    t.is(post.headers.allow, 'GET, HEAD')
  }

  // Photos: the first four images of post 3, checked.
  for (let n = 1; n <= 4; n++) {
    const foto = await get(on.port, base + '/foto/' + n)
    t.is(foto.status, 200, 'foto ' + n)
    t.is(foto.headers['content-type'], 'image/jpeg')
    t.is(foto.headers['content-length'], String(IMG[n - 1].byteLength))
    t.is(foto.headers['cache-control'], 'no-store')
    t.is(foto.headers['x-robots-tag'], ROBOTS)
    t.alike(foto.body, IMG[n - 1], 'foto ' + n + ' bytes')
  }
  const headFoto = await get(on.port, base + '/foto/1', { method: 'HEAD' })
  t.is(headFoto.status, 200)
  t.is(headFoto.body.byteLength, 0)
  t.is((await get(on.port, base + '/foto/5')).status, 404, 'foto 5 is no route')
  t.is((await get(on.port, base + '/foto/0')).status, 404, 'foto 0 is no route')
  t.is((await get(on.port, base + '/foto/1?x=1')).status, 404, 'a photo with a query string')
  t.is((await get(on.port, '/p/' + A.key + '/14/foto/1')).status, 404, 'a hash mismatch')
  t.is((await get(on.port, '/p/' + A.key + '/14/foto/2')).status, 404, 'past the items')
  t.is((await get(on.port, '/p/' + A.key + '/5/foto/1')).status, 404, 'an unpublished post has no photos')
  t.is((await get(on.port, '/p/' + A.key + '/6/foto/1')).status, 404, 'nor a withdrawn one')
  t.is((await get(off.port, base + '/foto/1')).status, 404, 'switch off: no photos')
  t.is((await get(feiraOnly.port, base + '/foto/1')).status, 404, 'the Feira origin alone: no photos')

  // A video post: its cover is foto 1, and the video bytes never leave.
  const video = await get(on.port, '/p/' + A.key + '/12')
  t.is(video.status, 200)
  t.ok(video.body.toString().includes('Vídeo disponível na Varanda'))
  const cover = await get(on.port, '/p/' + A.key + '/12/foto/1')
  t.is(cover.status, 200)
  t.alike(cover.body, IMG[5], 'foto 1 is the cover')
  for (const n of [2, 3, 4]) {
    const res = await get(on.port, '/p/' + A.key + '/12/foto/' + n)
    t.is(res.status, 404, 'video post foto ' + n)
    t.absent(res.body.includes(VIDEO.subarray(0, 12)), 'no video bytes')
  }

  // An AVIF post: the AVIF counts as a photo and is served as image/avif,
  // og:image names the JPEG after it, and AVIF bytes that fail the parser
  // are a 404.
  const avifPage = await get(on.port, '/p/' + A.key + '/17')
  t.is(avifPage.status, 200)
  const avifHtml = avifPage.body.toString()
  t.is((avifHtml.match(/<img /g) || []).length, 2, 'the AVIF is a photo on the page')
  t.ok(avifHtml.includes('<meta property="og:image" content="' + ORIGIN + '/p/' + A.key + '/17/foto/2">\n<meta property="og:image:type" content="image/jpeg">'), 'og:image skips the AVIF first photo')
  t.absent(avifHtml.includes(AVIF.subarray(0, 32).toString('latin1')), 'no peer bytes in the HTML')
  const avifFoto = await get(on.port, '/p/' + A.key + '/17/foto/1')
  t.is(avifFoto.status, 200, 'the AVIF photo')
  t.is(avifFoto.headers['content-type'], 'image/avif')
  t.alike(avifFoto.body, AVIF, 'the AVIF bytes')
  t.is((await get(on.port, '/p/' + A.key + '/17/foto/2')).headers['content-type'], 'image/jpeg', 'the JPEG after it')
  t.is(JSON.parse((await get(on.port, '/p/' + A.key + '/17/previa')).body.toString()).post.photoCount, 2, 'the preview counts the AVIF')
  t.is((await get(on.port, '/p/' + A.key + '/19/foto/1')).status, 404, 'AVIF bytes that fail the parser')
  const avifOnly = (await get(on.port, '/p/' + A.key + '/19')).body.toString()
  t.ok(avifOnly.includes('<meta property="og:image" content="' + ORIGIN + '/og/convite.png">\n<meta property="og:image:type" content="image/png">\n' +
    '<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">'), 'the brand card when the only photo is AVIF')
  t.is((avifOnly.match(/<meta property="og:image" /g) || []).length, 1, 'exactly one og:image')

  // The share tombstoned while the photo bytes are read: the second
  // postPublic sees it and nothing is written.
  const entry = seeder._served.get(A.key)
  const mediaRead = seeder.mediaRead
  seeder.mediaRead = async function (...args) {
    const read = await mediaRead.apply(this, args)
    entry.tombstones.set(999, 4)
    entry.effective = null
    return read
  }
  const withdrawn = await get(on.port, base + '/foto/1')
  seeder.mediaRead = mediaRead
  entry.tombstones.delete(999)
  entry.effective = null
  t.is(withdrawn.status, 404, 'withdrawn during the read: 404')
  t.is(withdrawn.body.toString(), 'não encontrado\n', 'the generic 404')
  t.is((await get(on.port, base + '/foto/1')).status, 200, 'served again once the stub is gone')

  // A second answer naming another share is not the same permission.
  const postPublic = seeder.postPublic
  let calls = 0
  seeder.postPublic = async function (...args) {
    const got = await postPublic.apply(this, args)
    calls++
    return calls === 2 && got ? { ...got, shareSeq: got.shareSeq + 1 } : got
  }
  const reshared = await get(on.port, base + '/foto/1')
  seeder.postPublic = postPublic
  t.is(calls, 2, 'postPublic asked twice')
  t.is(reshared.status, 404, 'another shareSeq after the read: 404')

  // Methods and other /p/ paths.
  for (const url of [base, base + '/foto/1', '/p/policy', '/p/nada']) {
    const res = await get(on.port, url, { method: 'POST' })
    t.is(res.status, 405, 'POST ' + url.slice(0, 12))
    t.is(res.headers.allow, 'GET, HEAD')
  }
  for (const url of ['/p', '/p/', '/p/' + A.key, '/p/' + A.key.toUpperCase() + '/3', '/p/' + A.key + '/3/foto', '/p/' + A.key + '/3/x', '/p/policy/x']) {
    for (const server of [on, off]) {
      const res = await get(server.port, url)
      t.is(res.status, 404, 'other /p/ path ' + url.slice(0, 12))
      t.is(res.body.toString(), 'não encontrado\n')
    }
  }

  // The two switches are independent.
  const feira = '/f/' + A.key + '/16'
  t.is((await get(feiraOnly.port, feira)).status, 200, 'the Feira origin serves its page')
  const neither = await get(off.port, feira)
  const postsOnly = await get(on.port, feira)
  t.is(neither.status, 404)
  t.is(postsOnly.status, neither.status, 'the posts origin alone leaves the Feira off')
  t.alike(postsOnly.body, neither.body)
  t.is(postsOnly.headers['content-type'], neither.headers['content-type'])
  t.is((await get(on.port, feira + '/foto/1')).status, 404)
  t.is((await get(on.port, '/f/sitemap.xml')).status, 404)
})

test('post page budget: a full slot, a missed deadline and a throw are the same 302; postsOrigin is validated', async (t) => {
  await testnet(t)
  for (const postsOrigin of ['http://varanda.test', 'https://varanda.test/', 'https://Varanda.test', 7, {}]) {
    let error = null
    try {
      startSeedWs({ port: 0, seeder: {}, postsOrigin })
    } catch (err) {
      error = err
    }
    t.ok(error instanceof TypeError && error.message === 'postsOrigin inválido', 'refused: ' + String(postsOrigin))
  }

  const hex = 'ab'.repeat(32)
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  let asked = 0
  const seeder = {
    postPublic: async (h, seq) => {
      asked++
      if (seq === 1) {
        await gate
        return null
      }
      if (seq === 2) throw new Error('boom')
      return { record: { type: 'post', text: 'oi', at: at(1), replyTo: null }, name: null, username: null, shareSeq: seq + 1 }
    }
  }
  const server = await startSeedWs({ port: 0, seeder, postsOrigin: ORIGIN, postsLimits: { pageMaxInFlight: 1, pageDeadlineMs: 300 } })
  t.teardown(() => server.close(), { force: true })
  t.teardown(() => release(), { force: true })

  const started = Date.now()
  const slow = get(server.port, '/p/' + hex + '/1')
  await until(() => asked === 1, { name: 'busca iniciada' })
  const full = await get(server.port, '/p/' + hex + '/3')
  t.alike(shape(full), AWAY, 'no free slot')
  const late = await slow
  t.ok(Date.now() - started >= 250, 'answered at the deadline')
  t.alike(shape(late), AWAY, 'the deadline passed')
  t.is(late.headers.location, '/publicacao/' + hex + '/1')
  t.alike(shape(await get(server.port, '/p/' + hex + '/3')), AWAY, 'the slot is still held while the lookup runs')
  release()
  await until(async () => (await get(server.port, '/p/' + hex + '/3')).status === 200, { name: 'vaga liberada' })
  t.pass('the slot is freed once the lookup settles')
  t.alike(shape(await get(server.port, '/p/' + hex + '/2')), AWAY, 'a throwing lookup')

  const flood = await startSeedWs({ port: 0, seeder, postsOrigin: ORIGIN, postsLimits: { pageRate: 0.001, pageBurst: 2 } })
  t.teardown(() => flood.close(), { force: true })
  t.is((await get(flood.port, '/p/' + hex + '/3')).status, 200)
  t.is((await get(flood.port, '/p/' + hex + '/3')).status, 200)
  t.alike(shape(await get(flood.port, '/p/' + hex + '/3')), AWAY, 'the bucket is empty')
  t.is((await get(flood.port, '/f/' + hex + '/3')).status, 404, 'the page bucket is not the Feira')
  t.is((await get(flood.port, '/p/' + hex + '/3/previa')).status, 200, 'the page bucket is not the preview')
  t.ok(JSON.parse((await get(flood.port, '/p/' + hex + '/3/previa')).body.toString()).post, 'the preview still shows the post')
})

test('preview budget: its own slot, deadline and bucket, every refusal the same {"post":null}', async (t) => {
  await testnet(t)
  const hex = 'ab'.repeat(32)
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  let asked = 0
  const seeder = {
    postPublic: async (h, seq) => {
      asked++
      if (seq === 1) {
        await gate
        return null
      }
      if (seq === 2) throw new Error('boom')
      return { record: { type: 'post', text: 'oi', at: at(1), replyTo: null }, name: null, username: null, shareSeq: seq + 1 }
    }
  }
  const server = await startSeedWs({ port: 0, seeder, postsOrigin: ORIGIN, postsLimits: { previewMaxInFlight: 1, previewDeadlineMs: 300 } })
  t.teardown(() => server.close(), { force: true })
  t.teardown(() => release(), { force: true })
  const previa = (seq, method) => get(server.port, '/p/' + hex + '/' + seq + '/previa', { method })

  const shown = await previa(3)
  t.is(shown.status, 200)
  t.alike(JSON.parse(shown.body.toString()).post, {
    v: 1, name: null, username: null, date: '01/03/2026', text: 'oi', photoCount: 0, morePhotos: 0, video: false, relation: null, card: null
  })

  const started = Date.now()
  const slow = previa(1)
  await until(() => asked === 2, { name: 'busca iniciada' })
  t.alike(previaShape(await previa(3)), noPreview('GET'), 'no free slot')
  t.alike(previaShape(await previa(3, 'HEAD')), noPreview('HEAD'), 'no free slot (HEAD)')
  t.is((await get(server.port, '/p/' + hex + '/3')).status, 200, 'a full preview slot leaves the page serving')
  const late = await slow
  t.ok(Date.now() - started >= 250, 'answered at the deadline')
  t.alike(previaShape(late), noPreview('GET'), 'the deadline passed')
  t.alike(previaShape(await previa(3)), noPreview('GET'), 'the slot is still held while the lookup runs')
  release()
  await until(async () => (await previa(3)).body.toString() !== '{"post":null}', { name: 'vaga liberada' })
  t.pass('the slot is freed once the lookup settles')
  t.alike(previaShape(await previa(2)), noPreview('GET'), 'a throwing lookup')
  t.alike(previaShape(await previa(2, 'HEAD')), noPreview('HEAD'), 'a throwing lookup (HEAD)')

  const flood = await startSeedWs({ port: 0, seeder, postsOrigin: ORIGIN, postsLimits: { previewRate: 0.001, previewBurst: 2 } })
  t.teardown(() => flood.close(), { force: true })
  t.is((await get(flood.port, '/p/' + hex + '/3/previa')).body.toString().startsWith('{"post":{'), true)
  t.is((await get(flood.port, '/p/' + hex + '/3/previa')).body.toString().startsWith('{"post":{'), true)
  t.alike(previaShape(await get(flood.port, '/p/' + hex + '/3/previa')), noPreview('GET'), 'the preview bucket is empty')
  t.is((await get(flood.port, '/p/' + hex + '/3')).status, 200, 'an empty preview bucket leaves the page serving')
})

test('a page diary over a real Seeder: its shared post, preview and photo are served, then the uniform 302 once it is closed', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), associationKey: assoc.hex })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const on = await startSeedWs({ port: 0, seeder, postsOrigin: ORIGIN })
  t.teardown(() => on.close(), { force: true })

  // The page layout of docs/protocol.md section 12: the @nome at seq 1 and
  // the genesis roster at seq 2, both from an issuer of the association.
  const issuerKp = crypto.keyPair()
  const issuerCert = cert.createIssuerCert({ issuer: hex(issuerKp.publicKey), date: at(0) }, assoc.kp)
  const ownerKp = crypto.keyPair()
  const owner = hex(ownerKp.publicKey)
  const nonce = (c) => c.repeat(43)
  const P = await member(t, bootstrap, assoc, (key, K) => {
    const rosterFields = { type: 'page-roster', page: key, gen: 1, owner, admins: [], prev: null, at: at(1), nonce: nonce('r'), association: assoc.hex }
    return [
      cert.createUsernameRecord({ member: key, username: 'padaria', date: at(0) }, issuerKp, issuerCert), // 1
      issuerCountersign({ ...rosterFields, signature: signRoster(rosterFields, ownerKp) }, issuerKp, issuerCert), // 2
      mediaCoreRecord({ key: K, at: at(2) }), // 3
      profileRecord({ name: 'Padaria', at: at(3) }), // 4
      postRecord({ text: 'pão quente', at: at(4), media: [descriptor(K, 1, IMG[0])] }), // 5
      share(5, 5) // 6
    ]
  })
  const K = P.mediaKey
  await admit(P, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === P.mediaCore.length, { name: 'mídia baixada', timeoutMs: 60000 })
  await settled(seeder, P)
  t.is(seeder._names.hint(P.key).page, true, 'the seeder knows the diary as a page')

  const base = '/p/' + P.key + '/5'
  const page = await get(on.port, base)
  t.is(page.status, 200, 'the page post is served')
  t.ok(page.body.toString().includes('pão quente'))
  t.ok(page.body.toString().includes('Padaria'))
  const previa = JSON.parse((await get(on.port, base + '/previa')).body.toString()).post
  t.ok(previa, 'its preview is served')
  t.is(previa.name, 'Padaria')
  t.is(previa.username, 'padaria', 'with the page @nome')
  t.is(previa.photoCount, 1)
  const foto = await get(on.port, base + '/foto/1')
  t.is(foto.status, 200, 'its photo is served')
  t.alike(foto.body, IMG[0])

  const closeFields = { type: 'page-close', page: P.key, gen: 2, at: at(6), nonce: nonce('c'), actor: owner, association: assoc.hex }
  await P.diary.append(issuerCountersign({ ...closeFields, signature: signClose(closeFields, ownerKp) }, issuerKp, issuerCert)) // 7
  await P.message((x) => x.type === 'have' && x.key === P.key && x.length === P.diary.length, 'have ' + P.diary.length)
  await settled(seeder, P)
  t.is(seeder._names.hint(P.key).closed, true, 'the close was indexed')
  const closed = await get(on.port, base)
  t.alike(shape(closed), AWAY, 'a closed page: the uniform 302')
  t.is(closed.headers.location, '/publicacao/' + P.key + '/5')
  t.alike(previaShape(await get(on.port, base + '/previa')), noPreview('GET'), 'and no preview')
  t.is((await get(on.port, base + '/foto/1')).status, 404, 'and no photo')
})

test('the share cover over a real Seeder: /capa serves the checked JPEG, the page names it, and every miss is the same 404', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), associationKey: assoc.hex })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const on = await startSeedWs({ port: 0, seeder, postsOrigin: ORIGIN })
  t.teardown(() => on.close(), { force: true })
  const off = await startSeedWs({ port: 0, seeder })
  t.teardown(() => off.close(), { force: true })

  const C = await member(t, bootstrap, assoc, (key, K) => [
    mediaCoreRecord({ key: K, at: at(0) }), // 1
    postRecord({ text: 'avif com capa', at: at(1), media: [avifDescriptor(K, 8, AVIF)] }), // 2
    share(2, 2), // 3
    coverOf(2, coverDescriptor(K, 10, COVER), 3), // 4
    postRecord({ text: 'sem share', at: at(4), media: [avifDescriptor(K, 8, AVIF)] }), // 5
    coverOf(5, coverDescriptor(K, 10, COVER), 5), // 6: a cover is not consent
    postRecord({ text: 'capa apagada', at: at(6), media: [avifDescriptor(K, 8, AVIF)] }), // 7
    share(7, 7), // 8
    coverOf(7, coverDescriptor(K, 10, COVER), 8), // 9
    del(9, 9), // 10: the cover tombstoned
    postRecord({ text: 'hash errado', at: at(10), media: [descriptor(K, 1, IMG[0])] }), // 11
    share(11, 11), // 12
    coverOf(11, coverDescriptor(K, 10, COVER, { sha256: sha(IMG[0]) }), 12), // 13
    postRecord({ text: 'quadro errado', at: at(13), media: [descriptor(K, 1, IMG[0])] }), // 14
    share(14, 14), // 15
    coverOf(14, coverDescriptor(K, 10, COVER, { width: 121 }), 15), // 16: the bytes say 120 x 80
    postRecord({ text: 'sem capa', at: at(16), media: [descriptor(K, 1, IMG[0])] }), // 17
    share(17, 17), // 18
    postRecord({ text: 'texto sem foto', at: at(18) }), // 19
    share(19, 19), // 20
    coverOf(19, coverDescriptor(K, 10, COVER), 20) // 21
  ])
  const K = C.mediaKey
  await admit(C, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === C.mediaCore.length, { name: 'mídia baixada', timeoutMs: 60000 })
  await settled(seeder, C)
  await until(async () => (await seeder.postPublic(C.key, 2))?.cover != null, { name: 'capa da publicação 2 visível', timeoutMs: 30000 })
  t.pass('the seeder shows post 2 with its cover')

  const base = '/p/' + C.key + '/2'
  const capa = await get(on.port, base + '/capa')
  t.is(capa.status, 200, 'the cover')
  t.is(capa.headers['content-type'], 'image/jpeg')
  t.is(capa.headers['content-length'], String(COVER.byteLength), 'the exact length')
  t.is(capa.headers['cache-control'], 'no-store')
  t.is(capa.headers['x-content-type-options'], 'nosniff')
  t.is(capa.headers['referrer-policy'], 'no-referrer')
  t.is(capa.headers['x-robots-tag'], ROBOTS)
  t.alike(capa.body, COVER, 'the exact bytes')
  const headCapa = await get(on.port, base + '/capa', { method: 'HEAD' })
  t.is(headCapa.status, 200)
  t.is(headCapa.body.byteLength, 0, 'HEAD has no body')
  t.is(headCapa.headers['content-length'], capa.headers['content-length'], 'HEAD has the same length')

  // The page names the cover ahead of the brand card its AVIF photo would
  // give, and its body is the same as without one.
  const page = (await get(on.port, base)).body.toString()
  t.ok(page.includes('<meta property="og:image" content="' + ORIGIN + base + '/capa">\n<meta property="og:image:type" content="image/jpeg">\n' +
    '<meta property="og:image:width" content="120">\n<meta property="og:image:height" content="80">'), 'og:image is the cover with its sizes')
  t.is((page.match(/<meta property="og:image" /g) || []).length, 1, 'exactly one og:image')
  t.absent(page.includes('src="' + base + '/capa"'), 'the body never shows the cover')
  const tombstoned = (await get(on.port, '/p/' + C.key + '/7')).body.toString()
  t.ok(tombstoned.includes('<meta property="og:image" content="' + ORIGIN + '/og/convite.png">'), 'a tombstoned cover: the brand card')
  const textOnly = (await get(on.port, '/p/' + C.key + '/19')).body.toString()
  t.ok(textOnly.includes('<meta property="og:image" content="' + ORIGIN + '/og/convite.png">'), 'a text-only post ignores its cover and uses the brand card')
  const noCover = (await get(on.port, '/p/' + C.key + '/17')).body.toString()
  t.ok(noCover.includes('<meta property="og:image" content="' + ORIGIN + '/p/' + C.key + '/17/foto/1">'), 'no cover: the first photo, as before')

  const misses = [
    ['not shared', on, '/p/' + C.key + '/5/capa'],
    ['the cover tombstoned', on, '/p/' + C.key + '/7/capa'],
    ['a hash mismatch', on, '/p/' + C.key + '/11/capa'],
    ['a frame size mismatch', on, '/p/' + C.key + '/14/capa'],
    ['a post with no cover', on, '/p/' + C.key + '/17/capa'],
    ['a text-only post with a cover', on, '/p/' + C.key + '/19/capa'],
    ['a seq past the log', on, '/p/' + C.key + '/99/capa'],
    ['an unknown diary', on, '/p/' + 'f'.repeat(64) + '/2/capa'],
    ['posts origin unset', off, base + '/capa'],
    ['a query string', on, base + '/capa?x=1'],
    ['a path after it', on, base + '/capa/1'],
    ['seq 0', on, '/p/' + C.key + '/0/capa'],
    ['a leading zero', on, '/p/' + C.key + '/02/capa']
  ]
  for (const [name, server, url] of misses) {
    const res = await get(server.port, url)
    t.is(res.status, 404, name)
    t.is(res.body.toString(), 'não encontrado\n', name + ': the generic 404')
  }
  const post = await get(on.port, base + '/capa', { method: 'POST' })
  t.is(post.status, 405, 'POST /capa')
  t.is(post.headers.allow, 'GET, HEAD')

  // The share tombstoned while the cover bytes are read.
  const entry = seeder._served.get(C.key)
  const mediaRead = seeder.mediaRead
  seeder.mediaRead = async function (...args) {
    const read = await mediaRead.apply(this, args)
    entry.tombstones.set(999, 3)
    entry.effective = null
    return read
  }
  const withdrawn = await get(on.port, base + '/capa')
  seeder.mediaRead = mediaRead
  entry.tombstones.delete(999)
  entry.effective = null
  t.is(withdrawn.status, 404, 'withdrawn during the read: 404')
  t.is(withdrawn.body.toString(), 'não encontrado\n', 'the generic 404')
  t.is((await get(on.port, base + '/capa')).status, 200, 'served again once the stub is gone')

  // A second answer naming another share, or another cover, is not the
  // same permission.
  for (const [name, field] of [['another shareSeq', 'shareSeq'], ['another coverSeq', 'coverSeq']]) {
    const postPublic = seeder.postPublic
    let calls = 0
    seeder.postPublic = async function (...args) {
      const got = await postPublic.apply(this, args)
      calls++
      return calls === 2 && got ? { ...got, [field]: got[field] + 1 } : got
    }
    const res = await get(on.port, base + '/capa')
    seeder.postPublic = postPublic
    t.is(calls, 2, name + ': postPublic asked twice')
    t.is(res.status, 404, name + ' after the read: 404')
  }
})

test('the share cover from a stub seeder: an answer without a cover, or with one that is not a share cover, names no /capa and serves none', async (t) => {
  await testnet(t)
  const hex = 'ab'.repeat(32)
  const core = 'cd'.repeat(32)
  const good = { core, mime: 'image/jpeg', start: 1, blocks: 1, bytes: COVER.byteLength, sha256: sha(COVER), width: 120, height: 80 }
  const covers = {
    1: {}, // a seeder from before the cover: no cover, no coverSeq
    2: { cover: { ...good, mime: 'image/png' }, coverSeq: 9 },
    3: { cover: { ...good, width: 1201 }, coverSeq: 9 },
    4: { cover: good, coverSeq: null },
    5: { cover: good, coverSeq: 9 }
  }
  let reads = 0
  const seeder = {
    postPublic: async (h, seq) => ({ record: { type: 'post', text: 'oi', at: at(1), replyTo: null }, name: null, username: null, shareSeq: 20, ...covers[seq] }),
    mediaRead: async () => {
      reads++
      return { bytes: COVER.byteLength, blocks: (async function * () { yield COVER })() }
    }
  }
  const server = await startSeedWs({ port: 0, seeder, postsOrigin: ORIGIN })
  t.teardown(() => server.close(), { force: true })
  for (const seq of [1, 2, 3, 4]) {
    const page = (await get(server.port, '/p/' + hex + '/' + seq)).body.toString()
    t.ok(page.includes('<meta property="og:image" content="' + ORIGIN + '/og/convite.png">'), 'seq ' + seq + ': the brand card')
    const res = await get(server.port, '/p/' + hex + '/' + seq + '/capa')
    t.is(res.status, 404, 'seq ' + seq + ': no cover served')
  }
  t.is(reads, 0, 'nothing is read for a cover that is not a share cover')
  const shown = await get(server.port, '/p/' + hex + '/5/capa')
  t.is(shown.status, 200, 'a share cover is served')
  t.alike(shown.body, COVER)
  t.ok((await get(server.port, '/p/' + hex + '/5')).body.toString().includes('content="' + ORIGIN + '/p/' + hex + '/5/capa"'), 'and named')
})

function transcodeFixture () {
  const hex = 'ab'.repeat(32)
  const core = 'cd'.repeat(32)
  const first = avifDescriptor(core, 1, AVIF)
  const original = { record: { type: 'post', text: 'foto', at: at(1), media: [first] }, shareSeq: 3 }
  const state = { shown: original, source: AVIF, lookups: 0, reads: 0 }
  const seeder = {
    async postPublic () { state.lookups++; return state.shown },
    async mediaRead () {
      state.reads++
      const bytes = state.source
      return { bytes: bytes.length, blocks: (async function * () { yield bytes })() }
    }
  }
  return { hex, core, first, original, state, seeder, base: '/p/' + hex + '/2' }
}

test('post page passes descriptions through and keeps preview and legacy answers unchanged', async (t) => {
  await testnet(t)
  const fixture = transcodeFixture()
  const request = await transcodeServer(t, fixture)
  const baseline = await request()
  const preview = await request('/previa')
  fixture.state.shown = { ...fixture.original, alt: ['Uma árvore & flores'] }
  const described = await request()
  t.is(described.status, 200)
  t.ok(described.body.toString().includes('alt="Uma árvore &amp; flores"'), 'shownPost and servePostPage preserve descriptions')
  t.alike((await request('/previa')).body, preview.body, 'preview JSON is unchanged')
  fixture.state.shown = { ...fixture.original, alt: null }
  t.alike((await request()).body, baseline.body, 'null and absent descriptions render identically')
})

const TRANSCODE_WIDE = { transcodeRate: 1000, transcodeBurst: 1000, pageRate: 1000, pageBurst: 1000 }

async function transcodeServer (t, fixture, transcoder, over = {}) {
  const server = await startSeedWs({ port: 0, seeder: fixture.seeder, postsOrigin: ORIGIN, postsLimits: TRANSCODE_WIDE, transcoder, ...over })
  t.teardown(() => server.close(), { force: true })
  if (transcoder) t.teardown(() => transcoder.close(), { force: true })
  return (suffix = '', method = 'GET') => get(server.port, fixture.base + suffix, { method })
}

test('automatic cover: AVIF GET and HEAD re-read the source even when conversion is cached; preview stays JSON', async (t) => {
  await testnet(t)
  const fixture = transcodeFixture()
  const { state, first } = fixture
  let conversions = 0
  const cache = new Map()
  const transcoder = createFakeOgTranscoder({
    convert (input) {
      if (!cache.has(input.sha256)) {
        conversions++
        cache.set(input.sha256, jpegHeader(input.width, input.height))
      }
      return cache.get(input.sha256)
    }
  })
  const request = await transcodeServer(t, fixture, transcoder)
  const page = (await request()).body.toString()
  t.ok(page.includes('<meta property="og:image" content="' + ORIGIN + fixture.base + '/capa">'))
  t.is(transcoder.calls.length, 0, 'rendering never transcodes')
  t.is(state.reads, 0, 'rendering never reads media')
  const beforePreview = (await request('/previa')).body
  const firstGet = await request('/capa')
  t.is(firstGet.status, 200)
  t.alike(firstGet.body, jpegHeader(16, 16))
  t.is(firstGet.headers['content-type'], 'image/jpeg')
  t.is(firstGet.headers['cache-control'], 'no-store')
  t.is(firstGet.headers['x-content-type-options'], 'nosniff')
  t.is(firstGet.headers['referrer-policy'], 'no-referrer')
  t.is(firstGet.headers['x-robots-tag'], ROBOTS)
  t.alike(transcoder.calls[0], { bytes: AVIF, mime: first.mime, sha256: first.sha256, srcWidth: 16, srcHeight: 16, width: 16, height: 16 })
  t.alike(shape(await request('/capa')), shape(firstGet), 'cached GET')
  const head = await request('/capa', 'HEAD')
  t.is(head.status, 200)
  t.is(head.body.length, 0)
  t.alike(shape(head).headers, shape(firstGet).headers, 'HEAD keeps the headers')
  t.is(conversions, 1, 'only one conversion')
  t.is(state.reads, 3, 'source read on both GETs and HEAD')
  t.is(state.lookups, 8, 'page, preview and two lookups per cover request')
  t.ok((await request()).body.toString().includes('content="' + ORIGIN + fixture.base + '/capa"'), 'known success remains eligible')
  const preview = await request('/previa')
  t.is(preview.headers['content-type'], 'application/json; charset=utf-8')
  t.alike(preview.body, beforePreview)
  t.is(JSON.parse(preview.body).post.photoCount, 1)
  state.source = Buffer.from(AVIF)
  state.source[state.source.length - 1] ^= 1
  t.is((await request('/capa')).status, 404, 'cached JPEG cannot bypass source hash')
  t.is(transcoder.calls.length, 3, 'bad hash never reaches the transcoder')
  t.absent(transcoder.refused(first.sha256), 'bad source hash does not poison the descriptor')
  state.shown = null
  t.is((await request('/capa')).status, 404, 'cached JPEG cannot outlive the share')
  state.shown = { ...fixture.original, cover: coverDescriptor(fixture.core, 2, COVER), coverSeq: 4 }
  state.source = COVER
  const device = await request('/capa')
  t.alike(device.body, COVER, 'device cover wins after a cached automatic cover')
  t.is(transcoder.calls.length, 3, 'device cover never transcodes')
  t.ok((await request()).body.toString().includes('<meta property="og:image:width" content="120">'))
})

test('automatic cover: every miss and every change during conversion is the same 404', async (t) => {
  await testnet(t)
  const fixture = transcodeFixture()
  const { state, original, first } = fixture
  let during = () => {}
  let refused = false
  const transcoder = createFakeOgTranscoder({ convert () { during(); return refused ? null : jpegHeader(16, 16) } })
  const request = await transcodeServer(t, fixture, transcoder)
  state.shown = null
  const missing = shape(await request('/capa'))
  t.is(missing.status, 404)
  t.is(Buffer.from(missing.body, 'hex').toString(), 'não encontrado\n')
  t.is(state.reads, 0, 'not shared: no source lookup')
  const changes = {
    withdrawn: () => { state.shown = null },
    deleted: () => { state.shown = null },
    blocked: () => { state.shown = null },
    reshared: () => { state.shown = { ...original, shareSeq: 5 } },
    'different first descriptor': () => { state.shown = { ...original, record: { ...original.record, media: [{ ...first, start: 2 }] } } },
    'new device cover': () => { state.shown = { ...original, cover: coverDescriptor(fixture.core, 2, COVER), coverSeq: 4 } }
  }
  for (const [label, change] of Object.entries(changes)) {
    state.shown = original
    during = change
    t.alike(shape(await request('/capa')), missing, label)
  }
  during = () => {}
  state.source = avifSamples.libavif.opaque
  const mismatch = avifDescriptor(fixture.core, 1, state.source)
  mismatch.width = mediaBounds(state.source, mismatch.mime).width + 1
  state.shown = { ...original, record: { ...original.record, media: [mismatch] } }
  const calls = transcoder.calls.length
  t.alike(shape(await request('/capa')), missing, 'size mismatch')
  t.is(transcoder.calls.length, calls, 'size mismatch checked before conversion')
  state.shown = { ...original, record: { ...original.record, media: [descriptor(fixture.core, 1, COVER), first] } }
  const reads = state.reads
  t.alike(shape(await request('/capa')), missing, 'small JPEG first photo, even with AVIF second')
  t.is(state.reads, reads, 'small JPEG never read for conversion')
  state.shown = original
  state.source = AVIF
  refused = true
  t.alike(shape(await request('/capa')), missing, 'refused hash')
  t.absent((await request()).body.toString().includes('content="' + ORIGIN + fixture.base + '/capa"'), 'a known refusal is not advertised')
  for (const over of [{ postsOrigin: null }, { postsOrigin: null, publicOrigin: ORIGIN }]) {
    const off = await transcodeServer(t, fixture, transcoder, over)
    const lookups = state.lookups
    t.alike(shape(await off('/capa')), missing, 'posts origin unset')
    t.is(state.lookups, lookups, 'origin checked before lookup')
  }
  const legacy = await transcodeServer(t, fixture, null)
  t.alike(shape(await legacy('/capa')), missing, 'null transcoder')
  t.absent((await legacy()).body.toString().includes('content="' + ORIGIN + fixture.base + '/capa"'), 'legacy page')
})

test('automatic cover page waits for AVIF readiness and capability, safe sizes and no known refusal', async (t) => {
  await testnet(t)
  const fixture = transcodeFixture()
  let ready
  const gate = new Promise((resolve) => { ready = resolve })
  t.teardown(() => ready({ avif: false }), { force: true })
  const transcoder = createFakeOgTranscoder({ bytes: jpegHeader(16, 16), probe: () => gate })
  const request = await transcodeServer(t, fixture, transcoder)
  const advertises = async () => (await request()).body.toString().includes('content="' + ORIGIN + fixture.base + '/capa"')
  t.absent(await advertises(), 'not ready')
  ready({ avif: true })
  t.ok(await advertises(), 'ready')
  const canDo = transcoder.canDo
  transcoder.canDo = () => false
  t.absent(await advertises(), 'unsupported MIME')
  transcoder.canDo = canDo
  const refused = transcoder.refused
  transcoder.refused = () => true
  t.absent(await advertises(), 'known refusal')
  transcoder.refused = refused
  fixture.state.shown = { ...fixture.original, record: { ...fixture.original.record, media: [{ ...fixture.first, width: 1.5 }] } }
  t.absent(await advertises(), 'unsafe width')
  fixture.state.shown = fixture.original
  const unavailable = await transcodeServer(t, fixture, createFakeOgTranscoder({ avif: false }))
  t.absent((await unavailable()).body.toString().includes('content="' + ORIGIN + fixture.base + '/capa"'), 'avif false')
  t.is(transcoder.calls.length, 0, 'no page transcodes')
  t.is(fixture.state.reads, 0, 'no page reads media')
})

test('automatic cover page recovers after a failed startup and a later background probe', async (t) => {
  await testnet(t)
  const fixture = transcodeFixture()
  let time = 0
  let probes = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  t.teardown(() => release({ avif: false }), { force: true })
  const transcoder = createFakeOgTranscoder({
    now: () => time,
    probe () { return ++probes === 1 ? null : gate }
  })
  const request = await transcodeServer(t, fixture, transcoder)
  const advertises = async () => (await request()).body.toString().includes('content="' + ORIGIN + fixture.base + '/capa"')
  t.absent(await advertises(), 'startup failed')
  t.is(probes, 1, 'backoff suppresses a new probe')
  time += 1000
  t.absent(await advertises(), 'page returns while the next probe is pending')
  t.is(probes, 2, 'page triggered a background probe')
  t.absent(await advertises(), 'another page also returns without waiting')
  t.is(probes, 2, 'only one probe in flight')
  release({ avif: true })
  await until(() => transcoder.canDo('image/avif'), { name: 'AVIF pronto' })
  t.ok(await advertises(), 'later success is visible without restarting the seeder')
  t.is(transcoder.calls.length, 0, 'no page converts a photo')
  t.is(fixture.state.reads, 0, 'no page reads media')
})

test('automatic cover: pre-check refusals stop naming an animated or mismatched first photo', async (t) => {
  await testnet(t)
  const chunk = (name, data) => {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(data.length)
    header.write(name, 4)
    return Buffer.concat([header, data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(16, 0)
  ihdr.writeUInt32BE(16, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const actl = Buffer.alloc(8)
  actl.writeUInt32BE(2)
  const frame = (seq) => {
    const data = Buffer.alloc(26)
    data.writeUInt32BE(seq)
    data.writeUInt32BE(16, 4)
    data.writeUInt32BE(16, 8)
    return chunk('fcTL', data)
  }
  const animated = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('acTL', actl), frame(0),
    chunk('IDAT', Buffer.alloc(262144)), frame(1),
    chunk('fdAT', Buffer.from([0, 0, 0, 2, 1])), chunk('IEND', Buffer.alloc(0))
  ])
  t.alike(mediaBounds(animated, 'image/png'), { width: 16, height: 16, frames: 2 })
  const oversized = Buffer.concat([jpegHeader(16, 16), Buffer.alloc(262144)])
  for (const [label, source, mime, width, extraBytes = 0] of [
    ['animated PNG', animated, 'image/png', 16],
    ['declared size mismatch', oversized, 'image/jpeg', 32],
    ['declared byte count mismatch', oversized, 'image/jpeg', 16, 1],
    ['declared MIME mismatch', animated, 'image/jpeg', 16]
  ]) {
    const fixture = transcodeFixture()
    const first = { ...descriptor(fixture.core, 1, source), mime, width, height: 16, bytes: source.length + extraBytes }
    fixture.state.source = source
    fixture.state.shown = { ...fixture.original, record: { ...fixture.original.record, media: [first] } }
    const transcoder = createFakeOgTranscoder({ bytes: jpegHeader(16, 16) })
    const request = await transcodeServer(t, fixture, transcoder)
    t.ok((await request()).body.toString().includes('content="' + ORIGIN + fixture.base + '/capa"'), label + ': initially eligible')
    t.is((await request('/capa')).status, 404, label + ': first cover rejected')
    t.absent(transcoder.refused(first.sha256), label + ': the bytes themselves are not refused')
    const page = (await request()).body.toString()
    t.absent(page.includes('content="' + ORIGIN + fixture.base + '/capa"'), label + ': no longer names a cover')
    t.ok(page.includes('<meta property="og:image" content="' + ORIGIN + fixture.base + '/foto/1">'), label + ': previous image picker')
    t.is(transcoder.calls.length, 0, label + ': rejected before conversion')
  }

  const victim = transcodeFixture()
  const transcoder = createFakeOgTranscoder({ bytes: jpegHeader(16, 16) })
  const right = { ...descriptor(victim.core, 1, oversized), mime: 'image/jpeg', width: 16, height: 16 }
  for (const [label, declared, source] of [
    ['a wrong size', { ...right, width: 32 }, oversized],
    ['other bytes', right, Buffer.concat([oversized, Buffer.alloc(1)])]
  ]) {
    const liar = { ...transcodeFixture(), hex: 'ef'.repeat(32), base: '/p/' + 'ef'.repeat(32) + '/2' }
    liar.state.source = source
    liar.state.shown = { ...liar.original, record: { ...liar.original.record, media: [declared] } }
    t.is((await (await transcodeServer(t, liar, transcoder))('/capa')).status, 404, 'another diary declaring ' + label + ' is refused')
  }
  victim.state.source = oversized
  victim.state.shown = { ...victim.original, record: { ...victim.original.record, media: [right] } }
  const request = await transcodeServer(t, victim, transcoder)
  t.ok((await request()).body.toString().includes('content="' + ORIGIN + victim.base + '/capa"'), 'the same bytes declared right keep their cover')
  t.is((await request('/capa')).status, 200, 'and it is served')
})

test('automatic cover: a cached success before listener startup keeps being named', async (t) => {
  await testnet(t)
  const fixture = transcodeFixture()
  const transcoder = createFakeOgTranscoder({ bytes: jpegHeader(16, 16) })
  await transcoder.transcode({ ...fixture.first, bytes: AVIF, srcWidth: 16, srcHeight: 16, width: 16, height: 16 })
  t.ok(transcoder.known(fixture.first.sha256))
  t.absent(transcoder.refused(fixture.first.sha256))
  const request = await transcodeServer(t, fixture, transcoder)
  const advertises = async () => (await request()).body.toString().includes('content="' + ORIGIN + fixture.base + '/capa"')
  t.ok(await advertises(), 'existing cached success is eligible')
  t.is((await request('/capa')).status, 200)
  t.ok(await advertises(), 'converted cover keeps being named')
})

test('automatic cover budgets refuse before lookup and keep pending work in its slot', async (t) => {
  await testnet(t)
  const fixture = transcodeFixture()
  const transcoder = createFakeOgTranscoder({ bytes: jpegHeader(16, 16) })
  const limited = await transcodeServer(t, fixture, transcoder, { postsLimits: { transcodeRate: 0.001, transcodeBurst: 1 } })
  t.is((await limited('/capa')).status, 200)
  const lookups = fixture.state.lookups
  const exhausted = shape(await limited('/capa'))
  t.is(exhausted.status, 404)
  t.is(fixture.state.lookups, lookups, 'empty bucket checked before lookup')
  t.is((await limited()).status, 200, 'page budget independent')
  t.ok(JSON.parse((await limited('/previa')).body).post, 'preview budget independent')
  let release
  const gate = new Promise((resolve) => { release = resolve })
  t.teardown(() => release(), { force: true })
  const slowTranscoder = createFakeOgTranscoder({ convert: async () => { await gate; return jpegHeader(16, 16) } })
  const slow = await transcodeServer(t, fixture, slowTranscoder, { postsLimits: { ...TRANSCODE_WIDE, transcodeMaxInFlight: 1, photoDeadlineMs: 100 } })
  const pending = slow('/capa')
  await until(() => slowTranscoder.calls.length === 1, { name: 'conversão iniciada' })
  const beforeFull = fixture.state.lookups
  t.alike(shape(await slow('/capa')), exhausted, 'full slot')
  t.is(fixture.state.lookups, beforeFull, 'full slot checked before lookup')
  t.alike(shape(await pending), exhausted, 'deadline')
  t.alike(shape(await slow('/capa')), exhausted, 'slot stays held after deadline')
  t.is(fixture.state.lookups, beforeFull, 'pending conversion still owns the slot')
  release()
  await until(async () => (await slow('/capa')).status === 200, { name: 'vaga de conversão liberada' })
  fixture.seeder.postPublic = async () => { throw new Error('lookup') }
  t.alike(shape(await slow('/capa')), exhausted, 'lookup exception')
})

test('automatic cover: an oversized JPEG and video poster use coverSize without changing body photos', async (t) => {
  await testnet(t)
  const fixture = transcodeFixture()
  const source = Buffer.concat([jpegHeader(2048, 1536), Buffer.alloc(262144)])
  const first = { ...descriptor(fixture.core, 1, source), width: 2048, height: 1536 }
  fixture.state.source = source
  const transcoder = createFakeOgTranscoder({ convert: (input) => jpegHeader(input.width, input.height) })
  const request = await transcodeServer(t, fixture, transcoder)
  for (const media of [[first], [first, videoDescriptor(fixture.core, 10, VIDEO)]]) {
    fixture.state.shown = { ...fixture.original, record: { ...fixture.original.record, media } }
    const page = (await request()).body.toString()
    t.ok(page.includes('<meta property="og:image" content="' + ORIGIN + fixture.base + '/capa">'))
    t.ok(page.includes('<meta property="og:image:width" content="1200">'))
    t.ok(page.includes('<meta property="og:image:height" content="900">'))
    t.ok(page.includes('src="' + fixture.base + '/foto/1"'), 'body still names the original photo')
    const cover = await request('/capa')
    t.is(cover.status, 200)
    t.alike(cover.body, jpegHeader(1200, 900))
    const call = transcoder.calls[transcoder.calls.length - 1]
    t.is(call.srcWidth, 2048)
    t.is(call.srcHeight, 1536)
    t.is(call.width, 1200)
    t.is(call.height, 900)
  }
})
