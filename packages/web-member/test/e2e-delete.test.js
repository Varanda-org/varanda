// Deletion end to end, loopback only: a browser node (Hypercore 10, memory
// storage, the RPC client wired in memory) deletes a photo post it synced to a
// REAL in-process Seeder reached over the WebSocket entry of
// apps/cli/lib/seed-ws.js (startSeedWs, which also serves /index, /media and
// the token-gated /moderation-post). After the tombstone reaches the seeder:
// /index/counts and /index/member omit the post, /media and /moderation-post
// answer the generic 404, Seeder#postBlock is null, and another browser
// node's Espiadinha (peek.read) no longer shows it. The app worklet runs the
// core node session, covered by packages/core/test/delete-e2e.test.js.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { connectClient } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { startSeedWs } = require('../../../apps/cli/lib/seed-ws')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')

const TOKEN = 'c3'.repeat(32)
const PHOTO_BYTES = 40 * 1024

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-ed-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-ed-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder, triageToken: TOKEN })
  t.teardown(() => ws.close(), { force: true })
  return { seeder, port: ws.port, url: 'ws://127.0.0.1:' + ws.port + '/seeder' }
}

async function webNode (t, assoc, url, { media = false } = {}) {
  const internal = []
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), media ? { media: crypto.keyPair() } : {})
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, key: publicKey, internal }
}

function get (port, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { Host: '127.0.0.1:' + port, ...headers }, agent: false }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode, body: b4a.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function getJson (port, url) {
  const r = await get(port, url)
  return { status: r.status, json: r.status === 200 ? JSON.parse(b4a.toString(r.body)) : null }
}

function peekSeqs (page, author) {
  return page.items.filter((i) => i.author === author).map((i) => i.seq).sort((a, b) => a - b)
}

test('a deleted photo post leaves the seeder index, /media, /moderation-post, postBlock and the Espiadinha', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const { seeder, port, url } = await seederStack(t, bootstrap, assoc)

  const a = await webNode(t, assoc, url, { media: true })
  const descriptor = await a.node.mediaUpload({ bytes: randomBytes(PHOTO_BYTES), mime: 'image/jpeg', width: 800, height: 600 })
  const photo = await a.web.request('post.create', { text: 'foto apagavel', media: [descriptor] })
  const keep = await a.web.request('post.create', { text: 'fica' })
  t.alike([photo.seq, keep.seq], [2, 3], 'after the media-core declaration (seq 1)')
  await a.web.request('sync.start', {})

  const ref = (seq) => a.key + ':' + seq
  const mediaPath = '/media/' + a.key + '/' + descriptor.core + '/' + descriptor.start + '/' + descriptor.blocks
  const auth = { Authorization: 'Bearer ' + TOKEN }
  await until(async () => {
    const m = seeder.indexMember(a.key)
    return m !== null && m.posts.includes(3) && (await get(port, mediaPath)).status === 200
  }, { timeoutMs: 60000, name: 'the seeder holds the diary and the photo' })
  const before = await getJson(port, '/index/counts/' + ref(2) + ',' + ref(3))
  t.is(before.status, 200)
  t.ok(ref(2) in before.json.counts, 'counted before the tombstone')
  t.alike((await getJson(port, '/index/member/' + a.key)).json.posts, [3, 2])
  t.is((await get(port, '/moderation-post/' + a.key + '/2', auth)).status, 200, '/moderation-post serves it before')
  t.ok(await seeder.postBlock(a.key, 2), 'postBlock serves it before')

  const viewer = await webNode(t, assoc, url)
  t.alike(peekSeqs(await viewer.web.request('peek.read', {}), a.key), [2, 3], 'the Espiadinha shows both before')

  const d = await a.web.request('post.delete', { to: ref(2) })
  t.alike([d.seq, d.changed, d.deleted], [4, true, [2]])
  const tomb = (await a.web.request('log.read', {})).entries.find((e) => e.seq === 4).record
  t.alike(tomb.media, [{ core: descriptor.core, start: descriptor.start, blocks: descriptor.blocks }], 'the photo range is on the tombstone')

  await until(() => {
    const m = seeder.indexMember(a.key)
    return m !== null && !m.posts.includes(2)
  }, { timeoutMs: 60000, name: 'the tombstone reached the seeder index' })
  const after = await getJson(port, '/index/counts/' + ref(2) + ',' + ref(3))
  t.is(after.status, 200)
  t.absent(ref(2) in after.json.counts, 'counts omit the deleted post')
  t.ok(ref(3) in after.json.counts, 'the kept post is still counted')
  t.alike((await getJson(port, '/index/member/' + a.key)).json.posts, [3], 'the member timeline omits it')
  await until(async () => (await get(port, mediaPath)).status === 404, { timeoutMs: 30000, name: '/media 404' })
  t.pass('/media answers 404 for the deleted range')
  t.is((await get(port, '/moderation-post/' + a.key + '/2', auth)).status, 404, '/moderation-post answers 404')
  t.is((await get(port, '/moderation-post/' + a.key + '/3', auth)).status, 200, 'the kept post is still served')
  t.is(await seeder.postBlock(a.key, 2), null, 'postBlock is null')

  const page = await until(async () => {
    const p = await viewer.web.request('peek.read', {})
    return p.items.some((i) => i.author === a.key) ? p : null
  }, { timeoutMs: 60000, name: 'the Espiadinha reads the author again' })
  t.alike(peekSeqs(page, a.key), [3], 'the Espiadinha page omits the deleted post')
  t.alike(a.internal, [], 'no internal error on the author node')
  t.alike(viewer.internal, [], 'no internal error on the viewer node')
})
