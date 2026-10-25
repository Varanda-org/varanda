// The browser sync (lib/sync.js) and this device's own data: an own media
// core is replicated to the verified seeder (a Hypercore peer on the
// seeder's side of a fake seeder over WebSocket) and confirmed with
// 'media-pushed' at its length, while its key never reaches the admission
// channel; the own diary's `follow` records are folded into kv follows
// (pending local ops on top) with 'follows-changed' once per change, at run
// start and as the diary is caught up from the seeder; a diary with no
// follow record leaves kv follows untouched.
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { createHash } = require('node:crypto')
const { WebSocketServer, WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { MEDIA_BLOCK_BYTES, memberCertRecord, followRecord, postRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { runSync } = require('../lib/sync')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

const NO_SEEDER = 'ws://127.0.0.1:9/seeder'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function randomKey () {
  return hex(crypto.keyPair().publicKey)
}

// An item of n bytes in MEDIA_BLOCK_BYTES blocks, with its SHA-256.
function item (n) {
  const bytes = b4a.alloc(n)
  for (let i = 0; i < n; i++) bytes[i] = (i * 13 + 5) & 0xff
  const blocks = []
  for (let at = 0; at < n; at += MEDIA_BLOCK_BYTES) blocks.push(bytes.subarray(at, Math.min(n, at + MEDIA_BLOCK_BYTES)))
  return { blocks, sha256: createHash('sha256').update(bytes).digest('hex') }
}

// A member with block 0 (its certificate) on a fresh storage.
async function member () {
  const assocKp = generateAssociationKeyPair()
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const ctx = { storage, association: hex(assocKp.publicKey), keyPair, mediaKeyPair: crypto.keyPair() }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
  return { storage, assocKp, keyPair, ownHex, ctx }
}

// Appends records to the own diary directly (the write path is not under test).
async function appendOwn (m, records) {
  const diary = await store.openDiary(m.storage, m.keyPair)
  try {
    for (const record of records) await store.appendRecord(diary, record)
  } finally {
    await diary.close()
  }
}

// A seeder stand-in (as test/sync-gate.test.js): role 'seeder' certified by
// `signer`, replicating and advertising `cores`, replicating `spy` cores
// without advertising them; it admits whatever is announced and records
// every admission message and the member's hello have.
async function fakeSeeder (t, { signer, cores = [], spy = [] }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const messages = []
  const remoteKeys = new Set()
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      for (const core of [...cores, ...spy]) core.replicate(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: cores.map((core) => ({ key: hex(core.key), length: core.length })),
        onmessage: (msg, peer) => {
          messages.push(msg)
          for (const key of peer.remoteHave.keys()) remoteKeys.add(key)
          if (msg.type !== 'announce') return
          // A diary it holds is admitted at the length it holds (not the
          // member's, which may still be catching up).
          const held = cores.find((core) => hex(core.key) === msg.key)
          const length = held ? held.length : (peer.remoteHave.get(msg.key) || 0)
          peer.send({ type: 'admitted', key: msg.key, length })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', messages, remoteKeys }
}

function sync (storage, seederUrl, events, opts = {}) {
  return runSync({
    storage,
    seederUrl,
    createSocket: (u) => new WebSocket(u),
    retryMinMs: 100,
    retryMaxMs: 200,
    onEvent: (ev) => events.push(ev),
    ...opts
  })
}

function named (events, name) {
  return events.filter((e) => e.event === name)
}

async function until (fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

test('an own media core is pushed to the verified seeder, confirmed, and never announced', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const m = await member()
  const prepared = await ops.mediaPrepare(m.ctx)
  t.absent(prepared.declared)
  await ops.declareMediaCore(m.ctx, prepared.core)
  const descriptor = await ops.mediaCommit(m.ctx, { ...item(2 * MEDIA_BLOCK_BYTES + 100), mime: 'image/png', width: 10, height: 10 })
  t.is(descriptor.core, prepared.core)
  const length = descriptor.start + descriptor.blocks
  t.is(length, 4, 'header + 3 blocks')

  // The seeder side opens the media core by key and downloads everything.
  const spy = new Hypercore(memoryStorage(), b4a.from(descriptor.core, 'hex'))
  await spy.ready()
  t.teardown(() => spy.close(), { force: true })
  spy.download({ start: 0, end: -1 })
  const seeder = await fakeSeeder(t, { signer: m.assocKp, spy: [spy] })

  const events = []
  const ac = new AbortController()
  const run = sync(m.storage, seeder.url, events, { signal: ac.signal, mediaPollMs: 50 })
  const pushed = await until(() => named(events, 'media-pushed').length > 0)
  // A few more polls: still one event for this length.
  await new Promise((resolve) => setTimeout(resolve, 300))
  ac.abort()
  const result = await run
  t.ok(pushed, 'media-pushed arrived')
  t.alike(named(events, 'media-pushed'), [{ event: 'media-pushed', key: descriptor.core, length }], 'once, at the core length')
  t.is(spy.contiguousLength, length, 'the seeder side holds every block')
  t.ok(result.ok)
  t.ok(seeder.messages.some((msg) => msg.type === 'announce' && msg.key === m.ownHex), 'the diary was announced')
  t.absent(seeder.messages.some((msg) => JSON.stringify(msg).includes(descriptor.core)), 'no admission message names the media core')
  t.ok(seeder.remoteKeys.has(m.ownHex))
  t.absent(seeder.remoteKeys.has(descriptor.core), 'never in the member inventory')
  t.absent(events.some((e) => e.event === 'have' && e.key === descriptor.core))

  // A later run: the seeder already holds it all, nothing is uploaded, and
  // its advertised length confirms the push.
  const second = []
  const ac2 = new AbortController()
  const run2 = sync(m.storage, seeder.url, second, { signal: ac2.signal, mediaPollMs: 50 })
  t.ok(await until(() => named(second, 'media-pushed').length > 0), 'confirmed from the advertised length')
  ac2.abort()
  await run2
  t.alike(named(second, 'media-pushed'), [{ event: 'media-pushed', key: descriptor.core, length }])
})

test('the own follow records fold into kv follows once; nothing new folds nothing', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const m = await member()
  const k1 = randomKey()
  const k2 = randomKey()
  await appendOwn(m, [
    followRecord({ key: k1, on: true }),
    followRecord({ key: k1, on: false }),
    followRecord({ key: k1, on: true }),
    followRecord({ key: k2, on: true }),
    followRecord({ key: m.ownHex, on: true }) // the own key is ignored
  ])
  await store.writeFollowsMigrated(m.storage)

  const events = []
  await sync(m.storage, NO_SEEDER, events, { once: true, timeoutMs: 1000 })
  t.alike(await store.readFollows(m.storage), [k1, k2].sort(), 'kv follows is the replay')
  t.alike(named(events, 'follows-changed'), [{ event: 'follows-changed', count: 2, length: 6 }])

  const again = []
  await sync(m.storage, NO_SEEDER, again, { once: true, timeoutMs: 1000 })
  t.is(named(again, 'follows-changed').length, 0, 'a second run emits nothing')
  t.alike(await store.readFollows(m.storage), [k1, k2].sort())
})

test('pending local follow changes win over the folded records and stay pending', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const m = await member()
  const k1 = randomKey()
  const k2 = randomKey()
  const k3 = randomKey()
  await appendOwn(m, [followRecord({ key: k1, on: true }), followRecord({ key: k2, on: true })])
  await store.writeFollowsMigrated(m.storage)
  const at = new Date().toISOString()
  const pending = [{ key: k2, on: false, at }, { key: k3, on: true, at }]
  await store.writeFollowsPending(m.storage, pending)

  const events = []
  await sync(m.storage, NO_SEEDER, events, { once: true, timeoutMs: 1000 })
  t.alike(await store.readFollows(m.storage), [k1, k3].sort(), 'k2 off and k3 on from the pending ops')
  t.alike(named(events, 'follows-changed'), [{ event: 'follows-changed', count: 2, length: 3 }])
  t.alike(await store.readFollowsPending(m.storage), pending, 'the pending ops survive the fold')
})

test('a diary with no follow record leaves kv follows untouched', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const m = await member()
  await appendOwn(m, [postRecord({ text: 'sem seguidos' })])
  const k1 = randomKey()
  await store.writeFollows(m.storage, [k1])
  await store.writeFollowsMigrated(m.storage)

  const events = []
  await sync(m.storage, NO_SEEDER, events, { once: true, timeoutMs: 1000 })
  t.alike(await store.readFollows(m.storage), [k1])
  t.is(named(events, 'follows-changed').length, 0)
})

test('follow records caught up from the seeder fold as the own diary grows', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const keyPair = crypto.keyPair()
  const ownHex = hex(keyPair.publicKey)
  const k1 = randomKey()
  const k2 = randomKey()
  // The diary as another device wrote it, held by the seeder.
  const full = new Hypercore(memoryStorage(), { keyPair, valueEncoding: 'json' })
  await full.ready()
  t.teardown(() => full.close(), { force: true })
  t.is(hex(full.key), ownHex)
  for (const record of [
    memberCertRecord(createCert({ member: ownHex }, assocKp)),
    followRecord({ key: k1, on: true }),
    followRecord({ key: k1, on: false }),
    followRecord({ key: k2, on: true }),
    postRecord({ text: 'do outro aparelho' })
  ]) await full.append(record)
  const seeder = await fakeSeeder(t, { signer: assocKp, cores: [full] })

  // A fresh device: the same identity, an empty diary.
  const storage = memoryNodeStorage()
  await ops.idCreate({ storage, association: hex(assocKp.publicKey), keyPair })
  await store.writeFollowsMigrated(storage)

  const events = []
  const result = await sync(storage, seeder.url, events, { once: true, timeoutMs: 15000 })
  if (!result.ok) t.comment(JSON.stringify(result))
  t.ok(result.ok, 'the once run caught up')
  t.alike(await store.readFollows(storage), [k2], 'kv follows is the replay of the downloaded records')
  // Folded once the diary is caught up, never per downloaded chunk.
  t.alike(named(events, 'follows-changed'), [{ event: 'follows-changed', count: 1, length: 5 }], 'exactly one, after the catch-up')

  const again = []
  await sync(storage, seeder.url, again, { once: true, timeoutMs: 15000 })
  t.is(named(again, 'follows-changed').length, 0, 'nothing new: nothing emitted')
})
