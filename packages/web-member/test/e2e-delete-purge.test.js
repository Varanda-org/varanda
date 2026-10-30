// Byte clearing end to end with a browser node, loopback only: the node
// (Hypercore 10 over the IndexedDB stand-in, the RPC client wired in memory)
// deletes a photo post it synced to a REAL in-process Seeder behind the
// WebSocket entry of apps/cli/lib/seed-ws.js. The seeder clears the post
// block and the photo blocks, mediaRead refuses the range and every range
// that overlaps it, GET and HEAD /media answer 404, the Espiadinha page
// omits the post, and after a reload of the browser node (storage closed
// and reopened, sync run again) the holes are still there on both sides.
require('fake-indexeddb/auto')
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { MEDIA_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { startSeedWs } = require('../../../apps/cli/lib/seed-ws')
const { createBrowserNode } = require('../lib/node')
const { idbNodeStorage, memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-edp-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-edp-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  return { seeder, port: ws.port, url: 'ws://127.0.0.1:' + ws.port + '/seeder' }
}

// A browser node over `storage`, unlocked with `keys` (the same keys after a
// reload, as the passkey gives them back).
async function webNode (t, assoc, url, storage, keys) {
  const internal = []
  const node = createBrowserNode({
    storage,
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
  await node.setKeyPair(keys.diary, keys.media ? { media: keys.media } : {})
  const web = await connectClient(node, { timeoutMs: 60000 })
  return { node, web, internal }
}

function request (port, method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: '127.0.0.1:' + port }, agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function heldIn (core, start, end) {
  const out = []
  for (let i = start; i < end; i++) out.push(await core.has(i))
  return out
}

// What the browser storage holds: the diary block `seq` and the media blocks.
async function browserHolds (storage, seq, media) {
  const diary = await store.openDiary(storage)
  let block
  try {
    block = await diary.has(seq)
  } finally {
    await diary.close()
  }
  const core = await store.openMediaCoreReadOnly(storage, media.core)
  try {
    return { block, media: await heldIn(core, media.start, media.end), header: await core.has(0) }
  } finally {
    await core.close()
  }
}

let dbCount = 0
function dbName () {
  return 'varanda-e2e-delete-purge-' + process.pid + '-' + (++dbCount)
}

test('a deleted photo post is cleared on the seeder and in the browser, stays cleared after a reload', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const { seeder, port, url } = await seederStack(t, bootstrap, assoc)

  const keys = { diary: crypto.keyPair(), media: crypto.keyPair() }
  const name = dbName()
  let a = await webNode(t, assoc, url, await idbNodeStorage(name), keys)
  const { publicKey: key } = await a.web.request('identity.create')
  await a.web.request('cert.add', { cert: createCert({ member: key }, kp) })
  const gone = await a.node.mediaUpload({ bytes: randomBytes(2 * MEDIA_BLOCK_BYTES + 100), mime: 'image/jpeg', width: 800, height: 600 })
  const kept = await a.node.mediaUpload({ bytes: randomBytes(500), mime: 'image/jpeg', width: 10, height: 10 })
  t.is(gone.blocks, 3, 'fixture: the deleted photo spans three blocks')
  t.is(kept.start, gone.start + gone.blocks, 'fixture: the kept photo follows it in the same core')
  const photo = await a.web.request('post.create', { text: 'foto apagavel', media: [gone] })
  const keep = await a.web.request('post.create', { text: 'fica', media: [kept] })
  t.alike([photo.seq, keep.seq], [2, 3], 'after the media-core declaration (seq 1)')
  await a.web.request('sync.start', {})

  const K = gone.core
  const mediaPath = (start, blocks) => '/media/' + key + '/' + K + '/' + start + '/' + blocks
  await until(async () => {
    const m = seeder.indexMember(key)
    return m !== null && m.posts.includes(3) &&
      (await request(port, 'GET', mediaPath(gone.start, gone.blocks))) === 200 &&
      (await request(port, 'GET', mediaPath(kept.start, kept.blocks))) === 200
  }, { timeoutMs: 60000, name: 'the seeder holds the diary and both photos' })
  t.is(await request(port, 'HEAD', mediaPath(gone.start, gone.blocks)), 200, 'HEAD /media answers 200 before')
  const served = () => seeder._served.get(key).core
  const mediaCore = () => seeder._mediaServed.get(K).core
  t.ok(await served().has(2), 'the seeder holds the post block before')
  t.alike(await heldIn(mediaCore(), gone.start, gone.start + gone.blocks), [true, true, true], 'and the photo blocks')

  const viewer = await webNode(t, assoc, url, memoryNodeStorage(), { diary: crypto.keyPair() })
  const { publicKey: viewerKey } = await viewer.web.request('identity.create')
  await viewer.web.request('cert.add', { cert: createCert({ member: viewerKey }, kp) })

  const d = await a.web.request('post.delete', { to: key + ':2' })
  t.alike([d.seq, d.changed, d.deleted], [4, true, [2]])
  const tomb = (await a.web.request('log.read', {})).entries.find((e) => e.seq === 4).record
  t.alike(tomb.media, [{ core: K, start: gone.start, blocks: gone.blocks }], 'the photo range is on the tombstone')

  await until(async () => !(await served().has(2)) && !(await mediaCore().has(gone.start)), { timeoutMs: 60000, name: 'the seeder cleared the post and the photo' })
  t.alike(await heldIn(mediaCore(), gone.start, gone.start + gone.blocks), [false, false, false], 'every photo block is cleared on the seeder')
  t.ok(await mediaCore().has(0), 'the media header stays')
  t.ok(await mediaCore().has(kept.start), 'the kept photo stays')
  t.is(await seeder.mediaRead(key, K, gone.start, gone.blocks), null, 'mediaRead refuses the deleted range')
  t.is(await seeder.mediaRead(key, K, gone.start + 1, 1), null, 'and a block inside it')
  t.is(await seeder.mediaRead(key, K, gone.start + 2, 2), null, 'and a range overlapping its end')
  t.is(await seeder.mediaRead(key, K, gone.start, gone.blocks + kept.blocks), null, 'and a range covering it and the kept photo')
  t.ok(await seeder.mediaRead(key, K, kept.start, kept.blocks), 'the kept photo is still read')
  t.is(await request(port, 'GET', mediaPath(gone.start, gone.blocks)), 404, 'GET /media answers 404')
  t.is(await request(port, 'HEAD', mediaPath(gone.start, gone.blocks)), 404, 'HEAD /media answers 404')
  t.is(await request(port, 'GET', mediaPath(gone.start + 1, 1)), 404, 'GET /media of a block inside answers 404')
  t.is(await request(port, 'HEAD', mediaPath(gone.start + 2, 2)), 404, 'HEAD /media of an overlapping range answers 404')
  t.is(await request(port, 'GET', mediaPath(kept.start, kept.blocks)), 200, 'the kept photo is still served')

  const page = await until(async () => {
    const p = await viewer.web.request('peek.read', {})
    return p.items.some((i) => i.author === key) ? p : null
  }, { timeoutMs: 60000, name: 'the Espiadinha reads the author' })
  t.alike(page.items.filter((i) => i.author === key).map((i) => i.seq), [3], 'the Espiadinha page omits the deleted post')

  // Reload: the node closes its storage; a new node opens it again and
  // syncs with the seeder.
  await a.web.request('sync.stop')
  t.alike(a.internal, [], 'no internal error before the reload')
  await a.node.close()
  const range = { core: K, start: gone.start, end: gone.start + gone.blocks }
  {
    const storage = await idbNodeStorage(name)
    const held = await browserHolds(storage, 2, range)
    await storage.close()
    t.alike(held, { block: false, media: [false, false, false], header: true }, 'the browser storage lacks the post and the photo after the reopen')
  }
  a = await webNode(t, assoc, url, await idbNodeStorage(name), keys)
  const log = await a.web.request('log.read', {})
  t.ok(log.invalid.some((e) => e.seq === 2 && e.reason === 'deleted'), 'the reloaded node reads the hole as deleted')
  t.ok(log.entries.some((e) => e.seq === 3), 'and reads past it')
  const { runId } = await a.web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped = await stoppedOf(a.web.events, runId)
  t.is(stopped.reason, 'done', 'the reloaded node synced with the seeder')
  t.is(stopped.result.ok, true)
  t.absent(await served().has(2), 'the seeder still lacks the post block')
  t.alike(await heldIn(mediaCore(), gone.start, gone.start + gone.blocks), [false, false, false], 'and the photo blocks')
  t.is(await request(port, 'GET', mediaPath(gone.start, gone.blocks)), 404, '/media still answers 404')
  t.alike(a.internal, [], 'no internal error after the reload')
  await a.node.close()
  {
    const storage = await idbNodeStorage(name)
    const held = await browserHolds(storage, 2, range)
    await storage.close()
    t.alike(held, { block: false, media: [false, false, false], header: true }, 'the browser never refilled the holes')
  }
  t.alike(viewer.internal, [], 'no internal error on the viewer node')
})
