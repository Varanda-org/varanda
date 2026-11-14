'use strict'

// The public page of a shared post in apps/cli/lib/seed-ws.js over a real
// Seeder on a local testnet (docs/protocol.md section 16): /p/policy, the
// page behind the operator switch, the one uniform 302 for every case that
// shows nothing, the photos checked against their descriptors and the
// re-check of the share after the bytes are read, and the switch being
// independent of the Feira's.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const Corestore = require('corestore')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const {
  memberCertRecord, postRecord, profileRecord, deleteRecord, mediaCoreRecord, postShareRecord, listingRecord, MEDIA_BLOCK_BYTES
} = require('@varanda/core/lib/records')
const { mediaHeader } = require('@varanda/core/lib/media')
const { startSeedWs } = require('../lib/seed-ws')

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

// Media core blocks 1..6 are JPEGs (IMG[0..5]) and block 7 the video bytes.
const IMG = [0, 1, 2, 3, 4, 5].map((i) => jpeg(300 + i, i + 1))
const VIDEO = b4a.concat([b4a.from([0, 0, 0, 0x18]), b4a.from('ftypmp42'), b4a.alloc(500, 9)])

function descriptor (core, start, bytes, hash = sha(bytes)) {
  const blocks = Math.ceil(bytes.byteLength / MEDIA_BLOCK_BYTES)
  return { core, mime: 'image/jpeg', start, blocks, bytes: bytes.byteLength, sha256: hash, width: 100, height: 100 }
}

function videoDescriptor (core, start, bytes) {
  return { core, mime: 'video/mp4', start, blocks: 1, bytes: bytes.byteLength, sha256: sha(bytes), width: 640, height: 360, ms: 5000 }
}

const share = (seq, i) => postShareRecord({ seq, at: at(i) })
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
  const wide = { pageRate: 1000, pageBurst: 1000 }
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
    listingRecord({ kind: 'produto', title: 'Bicicleta', text: 'Pouco usada.', price: 35000, cat: 'esporte', place: { uf: 'SP', city: 'São Paulo', bairro: null }, at: at(15) }) // 16
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
  const hint = seeder._names.hint
  seeder._names.hint = (k) => k === A.key ? { page: true, closed: false, moved: false } : hint(k)
  const pageDiary = await get(on.port, base)
  seeder._names.hint = hint
  t.alike(shape(pageDiary), AWAY, 'a page diary')
  t.is((await get(on.port, base)).status, 200, 'shown again once it is a person')

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
})
