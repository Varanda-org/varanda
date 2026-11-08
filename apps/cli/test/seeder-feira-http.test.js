// The Feira's public HTTP surface of apps/cli/lib/seed-ws.js over a real
// Seeder on a local testnet: the /f/ page (escaping, canonical link, robots),
// the photos checked against their descriptors, the sitemap, the
// /index/feira routes and the slot of a slow photo client.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { feira } = require('@varanda/rpc')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const {
  memberCertRecord, postRecord, deleteRecord, mediaCoreRecord, MEDIA_BLOCK_BYTES,
  listingRecord, listingEditRecord, listingStatusRecord, listingRateRecord
} = require('@varanda/core/lib/records')
const { mediaHeader } = require('@varanda/core/lib/media')
const { startSeedWs } = require('../lib/seed-ws')

const ORIGIN = 'https://varanda.test'

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

const SP = { uf: 'SP', city: 'São Paulo', bairro: null }

const sha = (bytes) => nodeCrypto.createHash('sha256').update(bytes).digest('hex')

function jpeg (size, fill) {
  const b = b4a.alloc(size, fill)
  b[0] = 0xff
  b[1] = 0xd8
  b[2] = 0xff
  return b
}

// Media blocks: 1 a JPEG, 2 PNG bytes (declared JPEG below), 3 a JPEG whose
// descriptor carries another hash, 4 the JPEG an edit shows, 5.. one big
// JPEG over BIG_BLOCKS blocks.
const BIG_BLOCKS = 128
const SMALL = [jpeg(300, 1), b4a.concat([b4a.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), b4a.alloc(200, 2)]), jpeg(300, 3), jpeg(300, 4)]
const BIG = jpeg(BIG_BLOCKS * MEDIA_BLOCK_BYTES, 5)

function descriptor (core, start, bytes, hash = sha(bytes)) {
  const blocks = Math.ceil(bytes.byteLength / MEDIA_BLOCK_BYTES)
  return { core, mime: 'image/jpeg', start, blocks, bytes: bytes.byteLength, sha256: hash, width: 100, height: 100 }
}

function listing (kind, title, i, extra = {}) {
  return listingRecord({ kind, title, text: 'Pouco usada.', price: 35000, cat: 'esporte', place: SP, at: at(i), ...extra })
}

async function member (t, bootstrap, assoc, { records = () => [], media = false, keyPair = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = keyPair === null
    ? store.get({ name: 'diary', valueEncoding: 'json' })
    : store.get({ key: keyPair.publicKey, keyPair, compat: true, valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  let mediaKey = null
  let mediaCore = null
  if (media) {
    mediaCore = store.get({ name: 'media-0' })
    await mediaCore.ready()
    await mediaCore.append(b4a.from(JSON.stringify(mediaHeader({ diary: key }))))
    for (const block of SMALL) await mediaCore.append(block)
    for (let i = 0; i < BIG_BLOCKS; i++) await mediaCore.append(BIG.subarray(i * MEDIA_BLOCK_BYTES, (i + 1) * MEDIA_BLOCK_BYTES))
    mediaKey = hex(mediaCore.key)
  }
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

async function append (m, records) {
  for (const r of records) await m.diary.append(r)
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

function settled (seeder, m) {
  return until(() => {
    const entry = seeder._served.get(m.key)
    const length = m.diary.length
    return entry && entry.scanned >= length && entry.indexed >= length && entry.feiraIndexed >= length && !entry.feiraQueued
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

const HOSTILE = '<script>alert(1)</script> "Bici" & \'aro\''

test('Feira over a real Seeder: page, photos, edit, status, deletion, block, sitemap, index and the photo slot', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), associationKey: assoc.hex })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const server = await startSeedWs({ port: 0, seeder, publicOrigin: ORIGIN, feiraLimits: { photoMaxInFlight: 1, photoDeadlineMs: 1000 } })
  t.teardown(() => server.close(), { force: true })
  const port = server.port

  const seller = crypto.keyPair()
  const A = await member(t, bootstrap, assoc, {
    media: true,
    keyPair: seller,
    records: (key, K) => [
      mediaCoreRecord({ key: K, at: at(0) }),
      listing('produto', HOSTILE, 2, { media: [descriptor(K, 1, SMALL[0]), descriptor(K, 2, SMALL[1]), descriptor(K, 3, SMALL[2], sha(SMALL[0]))] }),
      listing('produto', 'Mesa de madeira', 3),
      postRecord({ text: 'oi', at: at(4) }),
      listing('produto', 'Cadeira', 5),
      listing('produto', 'Sofá', 6, { media: [descriptor(K, 5, BIG)] })
    ]
  })
  const K = A.mediaKey
  await admit(A, assoc)
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === K), { name: 'mídia admitida', timeoutMs: 30000 })
  await until(() => seeder._mediaServed.get(K)?.core.contiguousLength === A.mediaCore.length, { name: 'mídia baixada', timeoutMs: 60000 })
  await settled(seeder, A)
  const base = '/f/' + A.key + '/2'

  const page = await get(port, base)
  t.is(page.status, 200)
  t.is(page.headers['content-type'], 'text/html; charset=utf-8')
  t.is(page.headers['referrer-policy'], 'no-referrer')
  t.is(page.headers['x-robots-tag'], undefined, 'a live listing has no X-Robots-Tag')
  const html = page.body.toString()
  t.absent(html.includes('<script>'), 'the hostile title is escaped')
  t.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;Bici&quot; &amp; &#39;aro&#39;'))
  t.ok(html.includes('<link rel="canonical" href="' + ORIGIN + base + '">'), 'canonical link')
  t.ok(html.includes('<meta name="robots" content="index,follow">'))
  t.ok(html.includes('<meta property="og:image" content="' + ORIGIN + base + '/foto/1">'), 'og:image')
  t.ok(html.includes('href="' + ORIGIN + '/anuncio/' + A.key + '/2"'), 'enter link')

  const foto = await get(port, base + '/foto/1')
  t.is(foto.status, 200)
  t.is(foto.headers['content-type'], 'image/jpeg')
  t.is(foto.headers['content-length'], String(SMALL[0].byteLength))
  t.alike(foto.body, SMALL[0])
  const capa = await get(port, base + '/capa')
  t.is(capa.status, 200)
  t.alike(capa.body, foto.body, 'capa is foto 1')
  const head = await get(port, base + '/foto/1', { method: 'HEAD' })
  t.is(head.status, 200)
  t.is(head.body.byteLength, 0)
  t.is((await get(port, base + '/foto/2')).status, 404, 'PNG bytes declared as JPEG')
  t.is((await get(port, base + '/foto/3')).status, 404, 'a hash mismatch')
  t.is((await get(port, base + '/foto/4')).status, 404, 'no fourth photo')

  t.is((await get(port, '/f/' + A.key + '/4')).status, 404, 'a post seq')
  const index = await get(port, '/index/feira/sp/sao-paulo/todos/todas')
  t.is(index.status, 200)
  t.ok(JSON.parse(index.body.toString()).items.some((i) => i.ref === A.key + ':2'), 'the city index pages')
  const own = await get(port, '/index/feira/autor/' + A.key)
  t.is(own.status, 200)
  t.is(JSON.parse(own.body.toString()).items.length, 4)

  // The photo slot (cap 1) is held by a client that reads nothing, and
  // freed by the deadline.
  const slow = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/f/' + A.key + '/6/foto/1', headers: { Host: '127.0.0.1:' + port }, agent: false }, (res) => {
      res.pause()
      resolve({ req, res })
    })
    req.on('error', () => {})
    req.end()
    setTimeout(() => reject(new Error('sem resposta')), 10000).unref()
  })
  t.is(slow.res.statusCode, 200)
  t.is(slow.res.headers['content-length'], String(BIG.byteLength))
  t.is((await get(port, base + '/foto/1')).status, 503, 'the slot is held while the slow client reads nothing')
  // A paused client never reads the server's close, so the release is
  // observed from the server: the deadline frees the slot.
  await until(async () => (await get(port, base + '/foto/1')).status === 200, { name: 'vaga liberada', timeoutMs: 10000 })
  t.pass('a slow client releases the slot')
  slow.req.destroy()

  const B = await member(t, bootstrap, assoc, {
    records: (key) => {
      const offer = 'ab'.repeat(16)
      const consent = hex(crypto.sign(b4a.from(feira.dealPayload({ listingAuthor: A.key, listingSeq: 2, rater: key, offerId: offer })), seller.secretKey))
      return [listingRateRecord({ to: { author: A.key, seq: 2 }, offer, consent, stars: 5, text: 'ótimo', at: at(10) })]
    }
  })
  await admit(B, assoc)
  await settled(seeder, B)
  const rated = await get(port, '/index/feira/avaliacoes/' + A.key)
  t.is(rated.status, 200)
  t.alike(JSON.parse(rated.body.toString()).items, [{ ref: B.key + ':1' }], 'ratings answer refs only')

  await append(A, [
    listingStatusRecord({ seq: 3, status: 'vendido', at: at(11) }),
    deleteRecord({ seq: 5, at: at(12) }),
    listingEditRecord({ seq: 2, title: 'Bicicleta nova', text: '', price: null, cat: 'esporte', place: SP, at: at(13), media: [descriptor(K, 4, SMALL[3])] })
  ])
  await settled(seeder, A)
  const sold = await get(port, '/f/' + A.key + '/3')
  t.is(sold.status, 200)
  t.is(sold.headers['x-robots-tag'], 'noindex', 'vendido is noindex')
  t.ok(sold.body.toString().includes('<meta name="robots" content="noindex,follow">'))
  t.is((await get(port, '/f/' + A.key + '/5')).status, 404, 'a deleted listing')
  const edited = await get(port, base)
  t.ok(edited.body.toString().includes('Bicicleta nova'), 'the edit title at the same URL')
  t.absent(edited.body.toString().includes('alert'), 'the old title is gone')
  const newFoto = await get(port, base + '/foto/1')
  t.is(newFoto.status, 200)
  t.alike(newFoto.body, SMALL[3], 'the edit photo at the same URL')
  t.is((await get(port, base + '/foto/2')).status, 404, 'the edit has one photo')

  const map = await get(port, '/f/sitemap.xml')
  t.is(map.status, 200)
  const locs = [...map.body.toString().matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort()
  t.alike(locs, [ORIGIN + '/f/' + A.key + '/2', ORIGIN + '/f/' + A.key + '/6'].sort(), 'only live, non-vendido listings')

  const isBlocked = seeder._isBlocked
  seeder._isBlocked = (k) => k === A.key || isBlocked.call(seeder, k)
  t.is((await get(port, base)).status, 404, 'a blocked diary')
  t.is((await get(port, base + '/foto/1')).status, 404, 'nor its photos')
  t.absent((await get(port, '/f/sitemap.xml')).body.toString().includes(A.key), 'nor in the sitemap')
  seeder._isBlocked = isBlocked
})
