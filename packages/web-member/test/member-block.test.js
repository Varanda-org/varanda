'use strict'

// The member's own block list on the browser node (docs/rpc.md 5.111, 5.112),
// through lib/session.js, lib/node.js and an in-memory client, against the
// loopback seeder stand-ins: the list itself, then each read it must filter
// (feed.read, peek.read, notices.list, diary.peek, the conversations). Loopback
// only.
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket } = require('ws')
const { BLOCK_MAX } = require('@varanda/rpc')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord, repostRecord, followRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { dmSeeder } = require('./helpers/dm-seeder')
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

test('block.set and block.list: the list, the same state again, the own key, the limit', async (t) => {
  const assoc = association()
  const { web, key: me, internal } = await webNode(t, assoc, OFFLINE_URL)
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  t.alike(await web.request('block.list'), { keys: [] })
  t.alike(await web.request('block.set', { key: A, on: true }), { changed: true, total: 1 })
  t.alike(await web.request('block.set', { key: A, on: true }), { changed: false, total: 1 }, 'the same state again')
  t.alike(await web.request('block.set', { key: B, on: false }), { changed: false, total: 1 }, 'never blocked')
  await web.request('block.set', { key: B, on: true })
  t.alike((await web.request('block.list')).keys.sort(), [A, B])
  t.alike(await web.request('block.set', { key: A, on: false }), { changed: true, total: 1 })
  t.alike((await web.request('block.list')).keys, [B])

  const own = await errorOf(web.request('block.set', { key: me, on: true }))
  t.is(own.code, 'USAGE')
  t.is(own.message, 'não é possível bloquear a própria chave')
  t.alike(internal, [])
})

test('past BLOCK_MAX a new block is refused and the list stays', async (t) => {
  const assoc = association()
  const { web, storage } = await webNode(t, assoc, OFFLINE_URL)
  const entries = []
  for (let i = 0; i < BLOCK_MAX; i++) entries.push({ key: i.toString(16).padStart(64, '0'), on: true, t: i })
  await store.writeMemberBlocks(storage, entries)
  const err = await errorOf(web.request('block.set', { key: 'f'.repeat(64), on: true }))
  t.is(err.code, 'USAGE')
  t.is(err.message, 'limite de bloqueios atingido')
  t.is((await web.request('block.list')).keys.length, BLOCK_MAX)
})

test('the list survives a restart, works locked, changes only unlocked, and reset clears it', async (t) => {
  const assoc = association()
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const A = 'a'.repeat(64)
  const first = await webNode(t, assoc, OFFLINE_URL, { storage, keyPair })
  await first.web.request('block.set', { key: A, on: true })
  await first.node.close()

  const again = createBrowserNode({ storage, association: assoc.hex, seederUrl: OFFLINE_URL, createSocket: (u) => { const ws = new WebSocket(u); ws.on('error', noop); return ws }, writeGate: false })
  t.teardown(() => again.close(), { force: true })
  const web = await connectClient(again, { timeoutMs: 60000 })
  t.alike((await web.request('block.list')).keys, [A], 'read while locked, after a restart')
  const locked = await errorOf(web.request('block.set', { key: 'b'.repeat(64), on: true }))
  t.is(locked.message, LOCKED)
  t.alike((await web.request('block.list')).keys, [A], 'a locked change writes nothing')

  await again.setKeyPair(keyPair)
  await again.reset()
  t.alike((await web.request('block.list')).keys, [], 'reset: the list belonged to that account')
})

test('blocking a followed key unfollows it, an unblock does not follow back, and follow.add refuses while blocked', async (t) => {
  const assoc = association()
  const { web } = await webNode(t, assoc, OFFLINE_URL)
  const A = 'a'.repeat(64)
  await web.request('follow.add', { key: A })
  await web.request('block.set', { key: A, on: true })
  t.alike((await web.request('follow.list')).follows, [], 'unfollowed')

  const refused = await errorOf(web.request('follow.add', { key: A }))
  t.is(refused.code, 'USAGE')
  t.is(refused.message, 'você bloqueou esta pessoa')

  await web.request('block.set', { key: A, on: false })
  t.alike((await web.request('follow.list')).follows, [], 'an unblock follows nobody back')
  await web.request('follow.add', { key: A })
  t.alike((await web.request('follow.list')).follows, [A], 'and following works again')
})

test('feed.read: no posts and no reposts of a blocked author, and no skipped row for it', async (t) => {
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
  const before = await web.request('feed.read', { limit: 20 })
  t.alike(rows(before), [['post', x, 2], ['post', y, 2], ['repost', y, 3]])

  await store.writeMemberBlocks(storage, [{ key: x, on: true, t: 1 }])
  const after = await web.request('feed.read', { limit: 20 })
  t.alike(rows(after), [['post', y, 2]], 'neither the post nor the repost of it')
  t.alike(after.skipped, [], 'the member chose this: nothing to report')

  // Pages are cut after the rule, so a hidden row never makes a page short.
  const one = await web.request('feed.read', { limit: 1 })
  t.alike(rows(one), [['post', y, 2]])

  await store.writeMemberBlocks(storage, [{ key: x, on: false, t: 2 }])
  t.alike(rows(await web.request('feed.read', { limit: 20 })), [['post', x, 2], ['post', y, 2], ['repost', y, 3]], 'undone')
  t.alike(internal, [])
})

test('peek.read: the blocked diary and the reposts of it leave the Espiadinha, and no skipped note counts them', async (t) => {
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
  const { web, internal } = await webNode(t, assoc, seeder.url)

  const rows = (r) => r.items.map((i) => [i.kind, i.author, i.seq]).sort()
  t.alike(rows(await web.request('peek.read', {})), [['post', x, 2], ['post', y, 2], ['repost', y, 3]])

  await web.request('block.set', { key: x, on: true })
  const after = await web.request('peek.read', {})
  t.alike(rows(after), [['post', y, 2]])
  t.is(after.skipped, 0)
  t.alike(internal, [])
})

test('peek.read: blocked while a snapshot is held, the next page drops it without a skipped note', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const X = await diary(t, [
    ...head(assoc, 'Xis'),
    () => postRecord({ text: 'x1', at: iso(now - 9 * HOUR) }),
    () => postRecord({ text: 'x2', at: iso(now - 8 * HOUR) })
  ])
  const x = hex(X.key)
  const Y = await diary(t, [
    ...head(assoc, 'Ypsilon'),
    () => postRecord({ text: 'y1', at: iso(now - 7 * HOUR) }),
    () => postRecord({ text: 'y2', at: iso(now - 6 * HOUR) })
  ])
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [X, Y] })
  const { web } = await webNode(t, assoc, seeder.url)
  const first = await web.request('peek.read', { limit: 2 })
  t.ok(first.next !== null, 'a next page exists')
  await web.request('block.set', { key: x, on: true })
  const next = await web.request('peek.read', { limit: 2, after: first.next })
  t.absent(next.items.some((i) => i.author === x))
  t.is(next.skipped, 0)
})

test('notices.list: a blocked actor gives no row', async (t) => {
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

  const before = await web.request('notices.list', {})
  t.alike(before.notices.map((n) => n.key), [hex(A.key), hex(B.key)])

  await web.request('block.set', { key: hex(A.key), on: true })
  const after = await web.request('notices.list', {})
  t.alike(after.notices.map((n) => n.key), [hex(B.key)])
  t.alike(internal, [])
})

test('diary.peek: a blocked author reads as unavailable, except its name and @nome', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const X = await diary(t, [...head(assoc, 'Xis'), () => postRecord({ text: 'de xis', at: iso(now - HOUR) })])
  const x = hex(X.key)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [X] })
  const { web, internal } = await webNode(t, assoc, seeder.url)
  await web.request('sync.start', {})

  const open = await web.request('diary.peek', { author: x, seqs: [2], profileSeq: 1 })
  t.alike(open.entries.map((e) => e.seq), [2])
  t.is(open.profile.name, 'Xis')

  await web.request('block.set', { key: x, on: true })
  const hidden = await errorOf(web.request('diary.peek', { author: x, seqs: [2], profileSeq: 1 }))
  t.is(hidden.code, 'NOT_FOUND')
  t.is(hidden.message, 'diário indisponível', 'the message every screen already treats as unavailable')

  const named = await web.request('diary.peek', { author: x, seqs: [2], profileSeq: 1, profileOnly: true })
  t.is(named.profile.name, 'Xis')
  t.alike(named.entries, [], 'no post, even with a seq asked')
  t.alike(named.invalid, [])
  t.alike(named.missing, [])

  await web.request('block.set', { key: x, on: false })
  const back = await web.request('diary.peek', { author: x, seqs: [2] })
  t.alike(back.entries.map((e) => e.seq), [2])
  t.alike(internal, [])
})

// A member node with its conversation keys unlocked.
async function dmNode (t, assoc, url) {
  const storage = memoryNodeStorage()
  const node = createBrowserNode({
    storage,
    association: hex(assoc.publicKey),
    seederUrl: url,
    createSocket: (u) => { const ws = new WebSocket(u); ws.on('error', noop); return ws },
    syncOptions: { dm: { issuePaceMs: 0 } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf: crypto.randomBytes(32) })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc) })
  await web.request('dm.enable')
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const w = await storage.readJson('dmStamps')
    if (w && Array.isArray(w.items) && w.items.length >= 2) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { node, web, storage, key: publicKey }
}

// Copies `from`'s diary into `to`'s storage, as a follow would have.
async function copyDiary (from, to) {
  const src = await store.openDiary(from.storage)
  const dst = await store.openReplica(to.storage, from.key)
  const a = src.replicate(true)
  const b = dst.replicate(false)
  a.pipe(b).pipe(a)
  await dst.update({ wait: true })
  await dst.download({ start: 0, end: src.length }).done()
  a.destroy()
  b.destroy()
  await src.close()
  await dst.close()
}

test('conversations: block.set files the message block, and a list reaching this device alone also drops the sender', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await dmNode(t, assoc, seeder.url)
  const B = await dmNode(t, assoc, seeder.url)

  await A.web.request('block.set', { key: B.key, on: true })
  const thread = await A.web.request('dm.thread', { peer: B.key })
  t.is(thread.blocked, true, 'dm.thread says blocked')
  const sent = await errorOf(A.web.request('dm.send', { to: B.key, text: 'oi' }))
  t.is(sent.code, 'USAGE')
  t.is(sent.message, 'você bloqueou esta pessoa')

  await A.web.request('block.set', { key: B.key, on: false })
  t.is((await A.web.request('dm.thread', { peer: B.key })).blocked, false, 'an unblock undoes the message block')

  // The list alone, with no message op (another device, or a device the op
  // never reached): the thread still reads blocked and a send is refused.
  await store.writeMemberBlocks(A.storage, [{ key: B.key, on: true, t: 4000000000 }])
  t.is((await A.web.request('dm.thread', { peer: B.key })).blocked, true)
  const again = await errorOf(A.web.request('dm.send', { to: B.key, text: 'oi' }))
  t.is(again.message, 'você bloqueou esta pessoa')
})

test('conversations: a pull drops a sender on the list alone', async (t) => {
  t.timeout(240000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await dmNode(t, assoc, seeder.url)
  const B = await dmNode(t, assoc, seeder.url)
  await copyDiary(A, B)
  await B.web.request('dm.send', { to: A.key, text: 'antes' })
  t.is((await A.web.request('dm.pull')).added, 1)
  await store.writeMemberBlocks(A.storage, [{ key: B.key, on: true, t: 1 }])
  await B.web.request('dm.send', { to: A.key, text: 'depois' })
  t.is((await A.web.request('dm.pull')).added, 0, 'nothing filed')
})

test('a group fold is not filtered: the reader helper alone holds the member\'s blocks', async (t) => {
  const assoc = association()
  const storage = memoryNodeStorage()
  await store.writeMemberBlocks(storage, [{ key: 'a'.repeat(64), on: true, t: 1 }])
  const plain = await member.moderation(storage, assoc.hex)
  t.is(plain.blocked.size, 0, 'moderation() feeds group folds and stays the association\'s list')
  const reader = await member.readerModeration(storage, assoc.hex)
  t.ok(reader.blocked.has('a'.repeat(64)))
  t.ok(reader.hidden.has('a'.repeat(64)))
})
