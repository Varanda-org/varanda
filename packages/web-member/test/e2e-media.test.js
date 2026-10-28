// End to end, loopback only: photos and follows across the browser node
// session (Hypercore 10, memory storage, the RPC client wired in memory), a
// REAL in-process Seeder (Hypercore 11) reached over the WebSocket entry of
// apps/cli/lib/seed-ws.js (startSeedWs, which also serves /media) and a CLI
// member (the varanda binary) on the local DHT.
// 1. A photo uploaded by the browser is admitted by the seeder (the media
//    core is a Hypercore 10 COMPAT core: its key is the media public key, as
//    the diary's is; the Hypercore 11 seeder opens it by that key, admits
//    it, downloads every block) and served byte-identical over /media.
// 2. A second device with the same identity rebuilds the follows from the
//    diary's `follow` records (and drops an unfollow on its next run).
// 3. The CLI member reads the photo post: `[foto]` in the text feed, the
//    descriptor intact in feed --json.
// 4. With 32 KiB media blocks the largest frame the browser sends the seeder
//    stays far below MAX_EXTERNAL_FRAME (measured on the WebSocket).
// 5. Old readers: a media post the current rules reject (empty media list,
//    unknown descriptor keys) is invalid and the feed skips it without
//    failing the diary.
// 6. Avatar: the profile compat pair reaches the seeder; /media serves the
//    avatar, the index points at the pair's second block, and the plain
//    block keeps name and bio for readers that know only 4-key profiles.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createHash, randomBytes } = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions, bootstrapFlags } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder, MAX_EXTERNAL_FRAME } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { MEDIA_BLOCK_BYTES, memberCertRecord, postRecord, followRecord, mediaCoreRecord, validateRecord } = require('@varanda/core/lib/records')
const { followSet } = require('@varanda/core/lib/media')
const { buildFeed } = require('@varanda/core/lib/feed')
const { startSeedWs } = require('../../../apps/cli/lib/seed-ws')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
// The seeder's Hypercore (11), not this package's (10).
const Hypercore11 = require(require.resolve('hypercore', { paths: [path.dirname(require.resolve('@varanda/core/lib/seeder'))] }))

const BIN = path.join(__dirname, '../../../apps/cli/bin/varanda.js')
const PHOTO_BYTES = 100 * 1024 // 4 blocks: 3 x 32 KiB and one of 4 KiB

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonLines (stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter((v) => v !== null)
}

// The CLI as a child process (never spawnSync: the seeder runs in this
// process and must keep serving), with the loopback testnet flags.
function varanda (t, bootstrap, args) {
  const child = spawn(process.execPath, [BIN, ...args, ...bootstrapFlags(bootstrap)], { env })
  const proc = { stdout: '', stderr: '', code: null }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  const exited = new Promise((resolve) => child.on('close', (code) => { proc.code = code; resolve(proc) }))
  t.teardown(async () => {
    if (proc.code === null) {
      child.kill('SIGKILL')
      await exited
    }
  }, { force: true })
  return exited
}

async function run (t, bootstrap, args) {
  const proc = await varanda(t, bootstrap, args)
  t.is(proc.code, 0, args.slice(0, 2).join(' ') + ' ' + proc.stderr)
  const lines = jsonLines(proc.stdout)
  return { proc, last: lines[lines.length - 1] }
}

// Parses the secret-stream framing (3-byte little-endian length, then the
// body) of every byte the browser writes to the seeder, across messages,
// and keeps the largest declared frame length: what the seeder's FrameGuard
// judges against MAX_EXTERNAL_FRAME.
function frameMeter () {
  const m = { frames: 0, largest: 0, largestMessage: 0, messages: 0, bytes: 0 }
  let header = 0
  let len = 0
  let remaining = 0
  m.feed = (chunk) => {
    m.messages++
    m.bytes += chunk.byteLength
    if (chunk.byteLength > m.largestMessage) m.largestMessage = chunk.byteLength
    let offset = 0
    while (offset < chunk.byteLength) {
      if (remaining > 0) {
        const n = Math.min(remaining, chunk.byteLength - offset)
        remaining -= n
        offset += n
        if (remaining === 0) m.frames++
        continue
      }
      len += chunk[offset++] * [1, 256, 65536][header]
      if (++header < 3) continue
      if (len > m.largest) m.largest = len
      remaining = len
      if (len === 0) m.frames++
      header = 0
      len = 0
    }
  }
  return m
}

function toBytes (data) {
  if (b4a.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return b4a.from(data)
  if (ArrayBuffer.isView(data)) return b4a.from(data.buffer, data.byteOffset, data.byteLength)
  return b4a.from(String(data))
}

// The seeder in this process, with its WebSocket entry and /media route on a
// system port (startSeedWs, as `seed --ws-port` runs it).
async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-em-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-em-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const events = []
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    log: (e) => {
      events.push(e)
      if (process.env.VARANDA_TEST_LOG) console.error('# seeder', JSON.stringify(e))
    }
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  return { seeder, events, publicKey, port: ws.port, url: 'ws://127.0.0.1:' + ws.port + '/seeder' }
}

// A browser node on `storage`; meter (optional) sees every byte it sends.
function browserNode (t, { storage, association, seederUrl, meter = null, internal }) {
  const node = createBrowserNode({
    storage,
    association,
    seederUrl,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      if (meter !== null) {
        const send = ws.send.bind(ws)
        ws.send = (data, ...rest) => {
          meter.feed(toBytes(data))
          return send(data, ...rest)
        }
      }
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  return node
}

async function once (t, web, label) {
  const { runId } = await web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped = await stoppedOf(web.events, runId)
  if (stopped.reason !== 'done') t.comment(label + ': ' + JSON.stringify(web.events.filter((e) => e.data && e.data.runId === runId)))
  t.is(stopped.reason, 'done', label + ' done')
  t.is(stopped.result.ok, true, label + ' ok')
  return stopped
}

function mediaRequest (port, url, { method = 'GET', host = '127.0.0.1:' + port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host }, agent: false }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b4a.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

test('photos: browser upload -> real seeder (compat media core) -> /media bytes, CLI feed, frame size', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { seeder, events, port, url } = await seederStack(t, bootstrap, assoc)

  // ---- scenario 1: the browser uploads a photo ----
  const internal = []
  const meter = frameMeter()
  const node = browserNode(t, { storage: memoryNodeStorage(), association: assoc.hex, seederUrl: url, meter, internal })
  const idPair = crypto.keyPair()
  const mediaPair = crypto.keyPair()
  const mediaKey = hex(mediaPair.publicKey)
  await node.setKeyPair(idPair, { media: mediaPair })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey: webKey } = await web.request('identity.create')
  t.is(webKey, hex(idPair.publicKey), 'compat diary: key === identity public key')
  t.alike(await web.request('cert.add', { cert: createCert({ member: webKey }, assoc.kp) }), { seq: 0 })

  const bytes = randomBytes(PHOTO_BYTES)
  const progress = []
  const uploadStarted = Date.now()
  const descriptor = await node.mediaUpload({ bytes, mime: 'image/jpeg', width: 800, height: 600, onProgress: (f) => progress.push(f) })
  t.alike(progress, [0.25, 0.75, 1], 'progress')
  t.alike(descriptor, {
    core: mediaKey,
    mime: 'image/jpeg',
    start: 1,
    blocks: Math.ceil(PHOTO_BYTES / MEDIA_BLOCK_BYTES),
    bytes: PHOTO_BYTES,
    sha256: sha256(bytes),
    width: 800,
    height: 600
  }, 'descriptor: the core key IS the media public key (Hypercore 10 compat)')
  t.is(descriptor.blocks, 4, 'several blocks, the last one shorter')
  t.is(PHOTO_BYTES - 3 * MEDIA_BLOCK_BYTES, 4096)

  const post = await web.request('post.create', { text: '', media: [descriptor] })
  t.alike(post, { seq: 2, ref: webKey + ':2' }, 'after the media-core declaration (seq 1)')
  const own = await web.request('log.read', {})
  t.alike(own.entries.map((e) => e.record.type), ['member-cert', 'media-core', 'post'])
  t.is(own.entries[1].record.key, mediaKey, 'the declaration names the media core')

  const { runId } = await web.request('sync.start', {})
  t.ok(runId, 'continuous run')
  const admittedEv = await until(() => events.find((e) => e.event === 'media-admitted' && e.key === mediaKey), { name: 'media-admitted', timeoutMs: 60000 })
  const admittedMs = Date.now() - uploadStarted
  t.is(admittedEv.diary, webKey, 'media-admitted for the diary')
  t.absent(events.some((e) => e.event === 'media-rejected'), 'nothing rejected')
  const total = descriptor.start + descriptor.blocks
  const read = await until(() => seeder.mediaRead(webKey, mediaKey, descriptor.start, descriptor.blocks), { name: 'every block at the seeder', timeoutMs: 60000 })
  const heldMs = Date.now() - uploadStarted
  t.is(read.bytes, PHOTO_BYTES, 'mediaRead: exact byte total')
  if (read.blocks.return) await read.blocks.return()
  const served = seeder._mediaServed.get(mediaKey)
  t.ok(served && served.core, 'the seeder holds the media core')
  t.is(hex(served.core.key), mediaKey, 'Hypercore 11 opened the compat core by the media public key')
  t.ok(served.core.length >= total, 'signed length covers the item')
  // Hypercore 11 normalises the compat manifest to { version: 1, one signer }
  // and treats the core as compat because its key equals that signer's key
  // (lib/verifier.js isCompat); a non-compat core with this manifest would
  // be keyed by the manifest hash instead.
  const manifest = served.core.manifest
  t.ok(manifest && manifest.signers.length === 1 && hex(manifest.signers[0].publicKey) === mediaKey, 'the seeder\'s manifest: one signer, the media public key')
  t.is(served.core.core.compat, true, 'the seeder\'s Hypercore 11 core is in compat mode')
  const manifestHashKey = hex(Hypercore11.key(manifest))
  t.not(manifestHashKey, mediaKey, 'not the manifest-hash key a Hypercore 11 default core would have')
  t.comment('seeder media core: key === media public key ' + (hex(served.core.key) === mediaKey) +
    '; compat ' + served.core.core.compat + '; manifest version ' + manifest.version + ', signers ' + manifest.signers.length +
    '; manifest-hash key would be ' + manifestHashKey.slice(0, 8) + ' (media key ' + mediaKey.slice(0, 8) + ')' +
    '; length ' + served.core.length + '; media-admitted length ' + admittedEv.length)
  t.comment('ms from upload to media-admitted: ' + admittedMs + '; to every block held: ' + heldMs)

  const mediaPath = '/media/' + webKey + '/' + mediaKey + '/' + descriptor.start + '/' + descriptor.blocks
  const got = await mediaRequest(port, mediaPath)
  t.is(got.status, 200, 'GET /media 200')
  t.is(got.headers['content-type'], 'application/octet-stream')
  t.is(got.headers['content-length'], String(PHOTO_BYTES))
  t.is(got.headers['x-content-type-options'], 'nosniff')
  t.is(got.headers['cache-control'], 'public, max-age=31536000, immutable')
  t.is(got.headers['accept-ranges'], 'none')
  t.ok(b4a.equals(got.body, bytes), 'body byte-identical to the upload')
  t.is(sha256(got.body), descriptor.sha256, 'SHA-256 equal to the descriptor')
  const head = await mediaRequest(port, mediaPath, { method: 'HEAD' })
  t.is(head.status, 200, 'HEAD 200')
  t.is(head.headers['content-length'], String(PHOTO_BYTES), 'HEAD: same Content-Length')
  t.is(head.body.byteLength, 0, 'HEAD: no body')
  const wrongCore = await mediaRequest(port, '/media/' + webKey + '/' + hex(crypto.keyPair().publicKey) + '/1/4')
  t.is(wrongCore.status, 404, 'a wrong core is 404')
  const wrongDiary = await mediaRequest(port, '/media/' + hex(crypto.keyPair().publicKey) + '/' + mediaKey + '/1/4')
  t.is(wrongDiary.status, 404, 'the right core under another diary is 404')
  const beyond = await mediaRequest(port, '/media/' + webKey + '/' + mediaKey + '/1/' + total)
  t.is(beyond.status, 404, 'a range past the core is 404')

  // ---- scenario 4: frame size ----
  t.ok(meter.frames > 0, 'frames measured')
  t.ok(meter.largest < MAX_EXTERNAL_FRAME, 'largest frame below MAX_EXTERNAL_FRAME')
  t.comment('frames browser -> seeder: ' + meter.frames + ' in ' + meter.messages + ' WebSocket messages (' + meter.bytes + ' bytes); largest declared frame ' +
    meter.largest + ' bytes, largest message ' + meter.largestMessage + ' bytes; MEDIA_BLOCK_BYTES ' + MEDIA_BLOCK_BYTES +
    '; MAX_EXTERNAL_FRAME ' + MAX_EXTERNAL_FRAME + ' (' + (meter.largest / MAX_EXTERNAL_FRAME * 100).toFixed(2) + '%)')
  t.ok(meter.largest >= MEDIA_BLOCK_BYTES, 'a whole media block travelled in one frame')

  // ---- scenario 3: the CLI member reads the media post ----
  const memberDir = tmpDir(t, 'varanda-em-member-')
  const cliKey = (await run(t, bootstrap, ['id', 'create', '--data', memberDir, '--association', assoc.hex, '--json'])).last.publicKey
  const certFile = path.join(tmpDir(t, 'varanda-em-mc-'), 'member-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createCert({ member: cliKey }, assoc.kp)))
  await run(t, bootstrap, ['cert', 'add', '--data', memberDir, '--cert-file', certFile, '--json'])
  await run(t, bootstrap, ['follow', '--data', memberDir, '--author', webKey, '--json'])
  const cliSync = await varanda(t, bootstrap, ['sync', '--data', memberDir, '--once', '--timeout-ms', '30000', '--json'])
  const cliLines = jsonLines(cliSync.stdout)
  const cliResult = cliLines[cliLines.length - 1]
  if (cliSync.code !== 0) t.comment('cli sync: ' + cliSync.stdout + cliSync.stderr)
  t.is(cliSync.code, 0, 'CLI sync --once exits 0')
  t.is(cliResult && cliResult.downloaded && cliResult.downloaded[webKey], 3, 'the CLI member downloaded the whole web diary')
  const text = await varanda(t, bootstrap, ['feed', '--data', memberDir])
  t.is(text.code, 0, 'feed ' + text.stderr)
  t.ok(text.stdout.includes('(' + webKey.slice(0, 8) + ') #2'), 'the text feed shows the post header')
  t.ok(text.stdout.split('\n').some((l) => l.trim() === '[foto]'), 'and [foto] for the photo-only post')
  const json = (await run(t, bootstrap, ['feed', '--data', memberDir, '--json'])).last
  const item = json.items.find((i) => i.author === webKey && i.seq === 2)
  t.ok(item, 'feed --json has the post')
  t.is(item && item.text, '')
  t.alike(item && item.media, [descriptor], 'the descriptor intact')
  t.alike(json.skipped, [], 'nothing skipped')

  // The browser feed agrees.
  const feed = await web.request('feed.read', { limit: 30 })
  t.alike(feed.items.find((i) => i.author === webKey && i.seq === 2).media, [descriptor], 'the web feed keeps the descriptor')

  await web.request('sync.stop')
  t.alike(internal, [], 'no internal error')
  t.absent(JSON.stringify(events).includes('127.0.0.1'), 'no address logged by the seeder')
})

// Device A follows X and Y while locked, unlocks (the drain appends the
// `follow` records) and pushes; device B (new storage, same identity,
// another media key) folds them on its first run.
async function twoDevices (t) {
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { url } = await seederStack(t, bootstrap, assoc)
  const idPair = crypto.keyPair()
  const keyHex = hex(idPair.publicKey)
  const X = hex(crypto.keyPair().publicKey)
  const Y = hex(crypto.keyPair().publicKey)
  const internal = []

  // Device A: identity and certificate, pushed; the storage outlives the node.
  const storageA = memoryNodeStorage()
  storageA.close = async () => {}
  const a0 = browserNode(t, { storage: storageA, association: assoc.hex, seederUrl: url, internal })
  await a0.setKeyPair(idPair, { media: crypto.keyPair() })
  const a0web = await connectClient(a0, { timeoutMs: 60000 })
  t.alike(await a0web.request('identity.create'), { publicKey: keyHex, association: assoc.hex })
  t.alike(await a0web.request('cert.add', { cert: createCert({ member: keyHex }, assoc.kp) }), { seq: 0 })
  await once(t, a0web, 'A first push')
  await a0.close()

  // Device A again: locked, a follow is refused (nothing is queued for the
  // next sign-in); unlocked, two follows are queued, signed, and drained.
  const a = browserNode(t, { storage: storageA, association: assoc.hex, seederUrl: url, internal })
  const aweb = await connectClient(a, { timeoutMs: 60000 })
  const refused = await aweb.request('follow.add', { key: X }).then(() => null, (err) => err)
  t.is(refused && refused.message, 'identidade bloqueada: entre com a passkey', 'locked: a follow is refused')
  t.is((await aweb.request('log.read', {})).entries.length, 1, 'nothing appended while locked')
  await a.setKeyPair(idPair, { media: crypto.keyPair() })
  t.alike(await aweb.request('follow.add', { key: X }), { changed: true, followCount: 1 })
  t.alike(await aweb.request('follow.add', { key: Y }), { changed: true, followCount: 2 })
  const drained = await aweb.request('log.read', {})
  const followEntries = drained.entries.filter((e) => e.record.type === 'follow')
  t.ok(followEntries.length >= 2, 'the drain appended the follows to the diary (' + followEntries.length + ' records)')
  t.alike(followSet(drained.entries, keyHex), [X, Y].sort(), 'the diary replays to the two follows')
  t.alike(await store.readFollowsPending(storageA), [], 'nothing pending on A')
  const aList = await aweb.request('follow.list')
  t.alike(aList, { follows: [X, Y].sort(), total: 2 })
  const aLength = drained.entries.length
  const pushA = await once(t, aweb, 'A pushes the follows')
  t.is(pushA.result.seederConfirmed, true, 'the seeder holds them')

  // Device B: a NEW storage, the SAME identity, another media nonce.
  const storageB = memoryNodeStorage()
  const b = browserNode(t, { storage: storageB, association: assoc.hex, seederUrl: url, internal })
  await b.setKeyPair(idPair, { media: crypto.keyPair() })
  const bweb = await connectClient(b, { timeoutMs: 60000 })
  t.alike(await bweb.request('identity.create'), { publicKey: keyHex, association: assoc.hex })
  t.alike(await bweb.request('follow.list'), { follows: [], total: 0 }, 'B starts with no follows')
  const started = Date.now()
  await once(t, bweb, 'B first run')
  t.is((await bweb.request('log.read', {})).entries.length, aLength, 'B recovered the diary')
  t.alike(await bweb.request('follow.list'), aList, 'B\'s follows equal A\'s')
  const changes = () => bweb.events.filter((e) => e.name === 'follows.changed').map((e) => e.data)
  t.alike(changes(), [{ count: 2 }], 'B emitted follows.changed { count: 2 }')
  t.comment('ms for B\'s first run to fold the follows: ' + (Date.now() - started))
  return { aweb, bweb, storageB, X, Y, aLength, changes, internal }
}

test('follows: a second device with the same identity rebuilds them from the diary', async (t) => {
  t.timeout(240000)
  const { internal } = await twoDevices(t)
  t.alike(internal, [], 'no internal error')
})

// Regression: a fresh device B has nothing local to migrate, so its first
// fold must mark it migrated (lib/node-store.js writeFoldedFollows); before
// that, every later fold kept B's first folded list and A's unfollow never
// reached B within the session.
test('follows: an unfollow on device A reaches device B on its next run', async (t) => {
  t.timeout(240000)
  const { aweb, bweb, storageB, X, Y, aLength, changes, internal } = await twoDevices(t)
  t.ok(await storageB.readJson('followsMigrated'), 'B counts as migrated after its first fold')
  t.alike(await aweb.request('follow.remove', { key: X }), { changed: true, followCount: 1 })
  const afterRemove = await aweb.request('log.read', {})
  t.is(afterRemove.entries.length, aLength + 1, 'the unfollow record')
  t.alike([afterRemove.entries[aLength].record.key, afterRemove.entries[aLength].record.on], [X, false])
  await once(t, aweb, 'A pushes the unfollow')
  await once(t, bweb, 'B second run')
  t.alike(await bweb.request('follow.list'), { follows: [Y], total: 1 }, 'B dropped X')
  t.alike(changes(), [{ count: 2 }, { count: 1 }], 'B emitted follows.changed { count: 1 }')
  t.alike((await bweb.request('log.read', {})).entries.length, aLength + 1, 'B no longer writes follows of its own')
  t.alike(internal, [], 'no internal error')
})

test('old readers: an invalid media post is skipped by the feed without failing the diary', async (t) => {
  const assoc = makeAssociation()
  const key = hex(crypto.keyPair().publicKey)
  const core = hex(crypto.keyPair().publicKey)
  const at = new Date().toISOString()
  const descriptor = { core, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 10, sha256: 'ab'.repeat(32), width: 1, height: 1 }
  const good = postRecord({ text: '', media: [descriptor] })
  t.is(validateRecord(good, 3), null, 'a valid media post')
  const emptyMedia = { type: 'post', text: 'x', at, replyTo: null, media: [] }
  const extraKey = { type: 'post', text: 'x', at, replyTo: null, media: [{ ...descriptor, alt: 'foto' }] }
  const extraPostKey = { type: 'post', text: 'x', at, replyTo: null, media: [descriptor], tags: [] }
  t.is(validateRecord(emptyMedia, 4), 'media-invalid', 'media: [] is invalid')
  t.is(validateRecord(extraKey, 5), 'media-invalid', 'an unknown descriptor key is invalid')
  t.is(validateRecord(extraPostKey, 6), 'malformed', 'an unknown post key is malformed')

  const entries = [
    { seq: 0, record: memberCertRecord(createCert({ member: key }, assoc.kp)) },
    { seq: 1, record: mediaCoreRecord({ key: core }) },
    { seq: 2, record: followRecord({ key: core, on: true }) },
    { seq: 3, record: good },
    { seq: 4, record: emptyMedia },
    { seq: 5, record: extraKey },
    { seq: 6, record: extraPostKey },
    { seq: 7, record: postRecord({ text: 'depois' }) }
  ]
  const feed = buildFeed({ logs: [{ key, entries }], association: assoc.hex })
  t.alike(feed.items.map((i) => i.seq), [3, 7], 'the invalid posts are skipped, the rest of the diary is read')
  t.alike(feed.items[0].media, [descriptor])
  t.is(feed.items[1].media, null)
})

// A synthetic still WebP: one VP8L chunk with a 512x512 header, then filler
// (n even, so the chunk needs no pad byte).
function webp512 (n) {
  const bytes = randomBytes(n)
  bytes.write('RIFF', 0, 'latin1')
  bytes.writeUInt32LE(n - 8, 4)
  bytes.write('WEBPVP8L', 8, 'latin1')
  bytes.writeUInt32LE(n - 20, 16)
  bytes[20] = 0x2f
  bytes.writeUInt32LE((511 | (511 << 14)) >>> 0, 21)
  return bytes
}

function indexGet (port, url) {
  return mediaRequest(port, url).then((r) => {
    let json = null
    try { json = JSON.parse(b4a.toString(r.body)) } catch {}
    return { status: r.status, json }
  })
}

test('avatar: profile.set pair -> real seeder: /media bytes, /index/member and /index/search, the plain block for old readers', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { seeder, events, port, url } = await seederStack(t, bootstrap, assoc)
  const internal = []
  const node = browserNode(t, { storage: memoryNodeStorage(), association: assoc.hex, seederUrl: url, internal })
  const mediaPair = crypto.keyPair()
  const mediaKey = hex(mediaPair.publicKey)
  await node.setKeyPair(crypto.keyPair(), { media: mediaPair })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey: webKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: webKey }, assoc.kp) })

  const bytes = webp512(40000)
  const avatar = await node.mediaUpload({ bytes, mime: 'image/webp', width: 512, height: 512 })
  t.is(avatar.blocks, 2)
  const set = await web.request('profile.set', { name: 'Bia Avatar', bio: 'oi', avatar })
  t.alike(set, { seq: 3, ref: webKey + ':3' }, 'the second block of the pair (cert, media-core, plain, avatar)')

  await web.request('sync.start', {})
  await until(() => events.find((e) => e.event === 'media-admitted' && e.key === mediaKey), { name: 'media-admitted', timeoutMs: 60000 })
  const read = await until(() => seeder.mediaRead(webKey, mediaKey, avatar.start, avatar.blocks), { name: 'every avatar block at the seeder', timeoutMs: 60000 })
  if (read.blocks.return) await read.blocks.return()
  const got = await mediaRequest(port, '/media/' + webKey + '/' + mediaKey + '/' + avatar.start + '/' + avatar.blocks)
  t.is(got.status, 200, 'GET /media 200')
  t.ok(b4a.equals(got.body, bytes), 'the avatar bytes')

  const member = await until(async () => {
    const r = await indexGet(port, '/index/member/' + webKey)
    return r.status === 200 && r.json.profileSeq === 3 ? r.json : null
  }, { name: 'index/member', timeoutMs: 60000 })
  t.is(member.profileSeq, set.seq, 'profileSeq is the second block of the pair')
  const search = await until(async () => {
    const r = await indexGet(port, '/index/search/bia')
    return r.status === 200 && r.json.members.some((m) => m.author === webKey) ? r.json : null
  }, { name: 'index/search', timeoutMs: 60000 })
  t.is(search.members.find((m) => m.author === webKey).profileSeq, 3, 'found by name')

  // The seeder's copy: a 4-key-only reader skips the avatar block and
  // reads the same name and bio from the plain one.
  const core = seeder._served.get(webKey).core
  const blocks = []
  for (let i = 0; i < core.length; i++) blocks.push(JSON.parse(b4a.toString(await core.get(i, { valueEncoding: 'binary' }))))
  t.is(blocks.length, 4)
  const oldProfiles = blocks.filter((r) => r.type === 'profile' && Object.keys(r).length === 4)
  t.is(oldProfiles.length, 1, 'one plain profile block')
  t.alike(Object.keys(oldProfiles[0]).sort(), ['at', 'bio', 'name', 'type'])
  t.alike([oldProfiles[0].name, oldProfiles[0].bio], ['Bia Avatar', 'oi'])
  t.alike(blocks[3].avatar, avatar)
  t.alike([blocks[3].name, blocks[3].bio], ['Bia Avatar', 'oi'])
  t.is(validateRecord(blocks[2], 2), null)
  t.is(validateRecord(blocks[3], 3), null)

  await web.request('sync.stop')
  t.alike(internal, [], 'no internal error')
})
