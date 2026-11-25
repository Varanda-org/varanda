'use strict'

// The member's own mute list on the browser node (docs/rpc.md 5.178, 5.179),
// through lib/session.js, lib/node.js and an in-memory client, against the
// loopback seeder stand-ins: the list itself, the reads it filters (feed.read,
// notices.list) and what it leaves alone (follows, diary.peek). Loopback only.
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket } = require('ws')
const { MUTE_MAX } = require('@varanda/rpc')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord, repostRecord, followRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const store = require('../lib/node-store')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { noticesSeeder, webNode: noticesNode, diary: noticesDiary, certOf } = require('./helpers/notices')

const OFFLINE_URL = 'ws://127.0.0.1:9/seeder'
const LOCKED = 'identidade bloqueada: entre com a passkey'
const HOUR = 3600000

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function iso (ms) {
  return new Date(ms).toISOString()
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

async function diary (t, records) {
  const core = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  for (const make of records) await core.append(make(hex(core.key)))
  return core
}

function head (assoc, name) {
  return [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => profileRecord({ name, bio: '' })
  ]
}

// Role 'seeder' certified by `signer`, replicating and advertising `cores`.
async function fakeSeeder (t, { signer, cores }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const s of wss.clients) s.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', noop)
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      for (const core of cores) core.replicate(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: cores.map((core) => ({ key: hex(core.key), length: core.length })),
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

async function webNode (t, assoc, url, { storage = memoryNodeStorage(), keyPair = crypto.keyPair(), certify = true } = {}) {
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 300 },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  if (certify) await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, storage, key: publicKey, keyPair, internal }
}

async function onceRun (web, timeoutMs = 10000) {
  const { runId } = await web.request('sync.start', { once: true, timeoutMs })
  return stoppedOf(web.events, runId)
}

test('mute.set and mute.list: the list, the same state again, the own key, the limit', async (t) => {
  const assoc = association()
  const { web, key: me, storage, internal } = await webNode(t, assoc, OFFLINE_URL)
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  t.alike(await web.request('mute.list'), { keys: [] })
  t.alike(await web.request('mute.set', { key: A, on: true }), { changed: true, total: 1 })
  t.alike(await web.request('mute.set', { key: A, on: true }), { changed: false, total: 1 }, 'the same state again')
  t.alike(await web.request('mute.set', { key: B, on: false }), { changed: false, total: 1 }, 'never muted')
  await web.request('mute.set', { key: B, on: true })
  t.alike((await web.request('mute.list')).keys.sort(), [A, B])
  t.alike(await web.request('mute.set', { key: A, on: false }), { changed: true, total: 1 })
  t.alike((await web.request('mute.list')).keys, [B])
  t.alike((await web.request('block.list')).keys, [], 'a mute is not a block')

  const own = await errorOf(web.request('mute.set', { key: me, on: true }))
  t.is(own.code, 'USAGE')
  t.is(own.message, 'não é possível silenciar a própria chave')

  const entries = []
  for (let i = 0; i < MUTE_MAX; i++) entries.push({ key: i.toString(16).padStart(64, '0'), on: true, t: i })
  await store.writeMemberMutes(storage, entries)
  const full = await errorOf(web.request('mute.set', { key: 'f'.repeat(64), on: true }))
  t.is(full.code, 'USAGE')
  t.is(full.message, 'limite de pessoas silenciadas atingido')
  t.is((await web.request('mute.list')).keys.length, MUTE_MAX)
  t.alike(internal, [])
})

test('the mute list survives a restart, works locked, changes only unlocked, and reset clears it', async (t) => {
  const assoc = association()
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const A = 'a'.repeat(64)
  const first = await webNode(t, assoc, OFFLINE_URL, { storage, keyPair })
  await first.web.request('mute.set', { key: A, on: true })
  await first.node.close()

  const again = createBrowserNode({ storage, association: assoc.hex, seederUrl: OFFLINE_URL, createSocket: (u) => { const ws = new WebSocket(u); ws.on('error', noop); return ws }, writeGate: false })
  t.teardown(() => again.close(), { force: true })
  const web = await connectClient(again, { timeoutMs: 60000 })
  t.alike((await web.request('mute.list')).keys, [A], 'read while locked, after a restart')
  const locked = await errorOf(web.request('mute.set', { key: 'b'.repeat(64), on: true }))
  t.is(locked.message, LOCKED)
  t.alike((await web.request('mute.list')).keys, [A], 'a locked change writes nothing')

  await again.setKeyPair(keyPair)
  await again.reset()
  t.alike((await web.request('mute.list')).keys, [], 'reset: the list belonged to that account')
})

test('muting a followed key keeps the follow', async (t) => {
  const assoc = association()
  const { web } = await webNode(t, assoc, OFFLINE_URL)
  const A = 'a'.repeat(64)
  await web.request('follow.add', { key: A })
  await web.request('mute.set', { key: A, on: true })
  t.alike((await web.request('follow.list')).follows, [A], 'still followed')
})

test('feed.read: no posts and no reposts of a muted author; diary.peek still reads it', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const X = await diary(t, [...head(assoc, 'Xis'), () => postRecord({ text: 'de xis', at: iso(now - 5 * HOUR) })])
  const x = hex(X.key)
  const Y = await diary(t, [
    ...head(assoc, 'Ypsilon'),
    () => postRecord({ text: 'de ypsilon', at: iso(now - 4 * HOUR) }),
    () => repostRecord({ to: { author: x, seq: 2 }, on: true, at: iso(now - 3 * HOUR) })
  ])
  const y = hex(Y.key)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [X, Y] })
  const { web, storage, internal } = await webNode(t, assoc, seeder.url)
  await store.writeFollows(storage, [x, y])
  t.is((await onceRun(web)).reason, 'done')

  const rows = (r) => r.items.map((i) => [i.kind, i.author, i.seq])
  t.alike(rows(await web.request('feed.read', { limit: 20 })), [['post', x, 2], ['post', y, 2], ['repost', y, 3]])

  await web.request('mute.set', { key: x, on: true })
  const after = await web.request('feed.read', { limit: 20 })
  t.alike(rows(after), [['post', y, 2]], 'neither the post nor the repost of it')
  t.alike(after.skipped, [], 'the member chose this: nothing to report')
  t.alike((await web.request('follow.list')).follows.sort(), [x, y].sort(), 'still followed')

  await web.request('sync.start', {})
  const open = await web.request('diary.peek', { author: x, seqs: [2], profileSeq: 1 })
  t.alike(open.entries.map((e) => e.seq), [2], 'the profile still shows the posts')
  await web.request('sync.stop', {})

  await web.request('mute.set', { key: x, on: false })
  t.alike(rows(await web.request('feed.read', { limit: 20 })), [['post', x, 2], ['post', y, 2], ['repost', y, 3]], 'undone')
  t.alike(internal, [])
})

test('notices.list: a muted actor gives no row', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: () => ({ items: [], next: null, incomplete: false }) }
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  const { web, key: me, internal } = await noticesNode(t, assoc, seeder.url)
  const from = (at) => followRecord({ key: me, on: true, at })
  const aAt = iso(now - HOUR)
  const bAt = iso(now - 2 * HOUR)
  const A = await noticesDiary(t, [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' }), () => from(aAt)])
  const B = await noticesDiary(t, [certOf(assoc), () => profileRecord({ name: 'Bia', bio: '' }), () => from(bAt)])
  state.cores = [A, B]
  const items = [{ key: hex(A.key), seq: 2, at: aAt }, { key: hex(B.key), seq: 2, at: bAt }]
  state.page = (target) => ({ items: target === me ? items : [], next: null, incomplete: false })

  t.alike((await web.request('notices.list', {})).notices.map((n) => n.key), [hex(A.key), hex(B.key)])
  await web.request('mute.set', { key: hex(A.key), on: true })
  t.alike((await web.request('notices.list', {})).notices.map((n) => n.key), [hex(B.key)])
  await web.request('mute.set', { key: hex(A.key), on: false })
  t.alike((await web.request('notices.list', {})).notices.map((n) => n.key), [hex(A.key), hex(B.key)], 'undone')
  t.alike(internal, [])
})
