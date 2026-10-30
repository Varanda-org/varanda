// post.delete and profile.delete on the browser node (lib/session.js through
// lib/node.js and an in-memory client, member-ops recordDelete, node-store
// readAll's fold), on memory storage: the refusals, the idempotent repeat,
// the compat pair as one atomic append, the media ranges, log.read's
// 'deleted' slots, the feed and profile.read after a deletion, a locked
// identity and a failed catch-up. No seeder: the sync runs dial a loopback
// port nothing listens on, so the fixtures turn the write gate off except
// where the test is about the gate.
const test = require('brittle')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createHash } = require('node:crypto')
const { WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { profileRecord, likeRecord, followRecord, nowIso } = require('@varanda/core/lib/records')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')
const { createBrowserNode } = require('../lib/node')

const LOCKED = 'identidade bloqueada: entre com a passkey'
const BAD_REF = 'referência inválida'
const NOT_POST = 'o registro não é uma publicação'
const NOT_PROFILE = 'o registro não é um perfil'
const NOT_DELETABLE = 'não é possível apagar este registro'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function setup (t, { storage = memoryNodeStorage(), assoc = association(), keyPair = crypto.keyPair(), mediaKeyPair = crypto.keyPair(), ...options } = {}) {
  const port = await deadPort()
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false,
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  if (keyPair !== null) await node.setKeyPair(keyPair, mediaKeyPair === null ? {} : { media: mediaKeyPair })
  const web = await connectClient(node)
  return { node, web, assoc, storage, keyPair, mediaKeyPair, internal }
}

async function certified (t, options) {
  const s = await setup(t, options)
  const { publicKey } = await s.web.request('identity.create')
  await s.web.request('cert.add', { cert: createCert({ member: publicKey }, s.assoc.kp) })
  return { ...s, key: publicKey }
}

// A certified diary written straight through member-ops before any node
// opens the storage; make(key) -> the records appended after block 0 (one
// atomic append, at most 8).
async function prepared (make) {
  const assoc = association()
  const keyPair = crypto.keyPair()
  const storage = memoryNodeStorage()
  const ctx = { storage, association: assoc.hex, keyPair }
  const { publicKey } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: publicKey }, assoc.kp))
  const records = make(publicKey)
  if (records.length > 0) await member.withIdentity(ctx, ({ diary }) => store.appendRecords(diary, records))
  return { assoc, keyPair, storage, key: publicKey }
}

// A synthetic still WebP: one VP8L chunk with a 512x512 header, then filler.
function webp512 () {
  const bytes = b4a.alloc(2000)
  bytes.write('RIFF', 0, 'latin1')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WEBPVP8L', 8, 'latin1')
  bytes.writeUInt32LE(bytes.length - 20, 16)
  bytes[20] = 0x2f
  bytes.writeUInt32LE((511 | (511 << 14)) >>> 0, 21)
  for (let i = 25; i < bytes.length; i++) bytes[i] = (i * 13) & 0xff
  return bytes
}

function avatarOf (core, start = 1) {
  const bytes = webp512()
  return { core, mime: 'image/webp', start, blocks: 1, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 512, height: 512 }
}

async function errorPair (p) {
  const err = await errorOf(p)
  return [err && err.code, err && err.message]
}

test('post.delete: own posts, replies and quotes; the repeat writes nothing; log.read and feed.read', async (t) => {
  await testnet(t)
  const { web, key, internal } = await certified(t)
  await web.request('profile.set', { name: 'Bia' })
  await web.request('post.create', { text: 'primeira' })
  await web.request('post.reply', { to: key + ':2', text: 'resposta' })
  await web.request('post.quote', { to: key + ':2', text: 'citação' })
  t.is((await web.request('feed.read', {})).items.length, 3)

  t.alike(await web.request('post.delete', { to: key + ':2' }), { seq: 5, ref: key + ':5', changed: true, deleted: [2] })
  const log = await web.request('log.read', {})
  t.alike(log.entries.map((e) => e.seq), [0, 1, 3, 4, 5])
  t.alike(log.invalid, [{ seq: 2, reason: 'deleted' }])
  t.alike(log.entries[4].record, { type: 'delete', seq: 2, at: log.entries[4].record.at }, 'no media on a post without any')
  t.alike((await web.request('feed.read', {})).items.map((i) => i.seq), [3, 4], 'the deleted post is gone from the feed')

  t.alike(await web.request('post.delete', { to: key + ':2' }), { seq: 5, ref: key + ':5', changed: false, deleted: [2] }, 'the repeat names the existing tombstone')
  t.is((await web.request('log.read', {})).entries.length, 5, 'nothing appended')

  t.alike(await web.request('post.delete', { to: key + ':3' }), { seq: 6, ref: key + ':6', changed: true, deleted: [3] }, 'a reply')
  t.alike(await web.request('post.delete', { to: key + ':4' }), { seq: 7, ref: key + ':7', changed: true, deleted: [4] }, 'a quote')
  t.alike((await web.request('feed.read', {})).items, [])
  t.alike(internal, [], 'no internal error')
})

test('post.delete and profile.delete refusals: nothing is written', async (t) => {
  await testnet(t)
  const other = 'ab'.repeat(32)
  const p = await prepared(() => [
    profileRecord({ name: 'Bia', bio: '' }),
    likeRecord({ to: { author: other, seq: 1 }, on: true }),
    followRecord({ key: other, on: true })
  ])
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair })
  const key = p.key
  await web.request('post.create', { text: 'oi' })
  t.alike((await web.request('post.delete', { to: key + ':4' })).deleted, [4])
  const length = (await web.request('log.read', {})).entries.length + (await web.request('log.read', {})).invalid.length

  for (const method of ['post.delete', 'profile.delete']) {
    t.alike(await errorPair(web.request(method, { to: other + ':1' })), ['USAGE', BAD_REF], method + ': another author')
    t.alike(await errorPair(web.request(method, { to: key + ':' + length })), ['USAGE', BAD_REF], method + ': at the length')
    t.alike(await errorPair(web.request(method, { to: key + ':999' })), ['USAGE', BAD_REF], method + ': past the length')
    t.alike(await errorPair(web.request(method, { to: key + ':2' })), ['USAGE', NOT_DELETABLE], method + ': a like')
    t.alike(await errorPair(web.request(method, { to: key + ':3' })), ['USAGE', NOT_DELETABLE], method + ': a follow')
    t.alike(await errorPair(web.request(method, { to: key + ':5' })), ['USAGE', NOT_DELETABLE], method + ': a tombstone')
    const zero = await errorOf(web.request(method, { to: key + ':0' }))
    t.is(zero && zero.code, 'USAGE', method + ': block 0')
  }
  t.alike(await errorPair(web.request('post.delete', { to: key + ':1' })), ['USAGE', NOT_POST], 'a profile to post.delete')
  t.alike(await errorPair(web.request('profile.delete', { to: key + ':4' })), ['USAGE', NOT_PROFILE], 'a post to profile.delete')
  const log = await web.request('log.read', {})
  t.is(log.entries.length + log.invalid.length, length, 'nothing appended')
})

test('profile.delete: the compat pair is one version in one append; the older version is in effect again', async (t) => {
  await testnet(t)
  const s = await certified(t)
  const avatar = await s.node.mediaUpload({ bytes: webp512(), mime: 'image/webp', width: 512, height: 512 })
  // 1: media-core declaration
  t.is((await s.web.request('profile.set', { name: 'Ana', bio: 'antes' })).seq, 2)
  t.is((await s.web.request('profile.set', { name: 'Bia', avatar })).seq, 4, 'the pair is 3, 4')
  t.alike((await s.web.request('profile.read', { authors: [s.key] })).profiles[0].avatar, avatar)

  t.alike(await s.web.request('profile.delete', { to: s.key + ':3' }), { seq: 6, ref: s.key + ':6', changed: true, deleted: [3, 4] }, 'naming the plain block')
  const log = await s.web.request('log.read', {})
  t.alike(log.invalid, [{ seq: 3, reason: 'deleted' }, { seq: 4, reason: 'deleted' }])
  const [t5, t6] = log.entries.slice(-2).map((e) => e.record)
  t.alike([t5.type, t5.seq, 'media' in t5], ['delete', 3, false], 'the plain block carries no media')
  t.alike([t6.type, t6.seq, t6.media], ['delete', 4, [{ core: avatar.core, start: avatar.start, blocks: avatar.blocks }]], 'the avatar range on the second tombstone')
  t.is(t5.at <= t6.at, true)

  const read = (await s.web.request('profile.read', { authors: [s.key] })).profiles[0]
  t.alike([read.name, read.bio, read.avatar], ['Ana', 'antes', null], 'no current avatar; the surviving older version is in effect')

  t.alike(await s.web.request('profile.delete', { to: s.key + ':4' }), { seq: 6, ref: s.key + ':6', changed: false, deleted: [3, 4] }, 'the repeat, naming the avatar block')
  t.alike(s.internal, [], 'no internal error')
})

test('profile.delete: a range a surviving post still shows is not on the tombstone', async (t) => {
  await testnet(t)
  const s = await certified(t)
  const avatar = await s.node.mediaUpload({ bytes: webp512(), mime: 'image/webp', width: 512, height: 512 })
  await s.web.request('profile.set', { name: 'Bia', avatar })
  await s.web.request('post.create', { text: 'foto', media: [avatar] })
  t.alike((await s.web.request('profile.delete', { to: s.key + ':3' })).deleted, [2, 3])
  const log = await s.web.request('log.read', {})
  t.alike(log.entries.slice(-2).map((e) => 'media' in e.record), [false, false], 'the post keeps the range alive')

  t.alike((await s.web.request('post.delete', { to: s.key + ':4' })).deleted, [4])
  const last = (await s.web.request('log.read', {})).entries.slice(-1)[0].record
  t.alike(last.media, [{ core: avatar.core, start: avatar.start, blocks: avatar.blocks }], 'the last reference goes with the post')
})

test('profile.delete pairs only a plain block with the avatar block after it', async (t) => {
  await testnet(t)
  const core = hex(crypto.keyPair().publicKey)
  const at = nowIso()
  const p = await prepared(() => [
    profileRecord({ name: 'A', bio: '', at }),
    profileRecord({ name: 'A', bio: '', at, avatar: avatarOf(core) }),
    profileRecord({ name: 'B', bio: '', at }),
    profileRecord({ name: 'B', bio: '', at, avatar: avatarOf(core, 2) })
  ])
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair, mediaKeyPair: null })
  const key = p.key
  const b = await web.request('profile.delete', { to: key + ':3' })
  t.alike([b.deleted, b.seq, b.changed], [[3, 4], 6, true], 'plainB takes avatarB, never avatarA')
  const a = await web.request('profile.delete', { to: key + ':2' })
  t.alike([a.deleted, a.seq], [[1, 2], 8], 'avatarA takes plainA, never plainB')
  const log = await web.request('log.read', {})
  t.alike(log.entries.slice(-4).map((e) => 'media' in e.record), [false, false, false, false], 'an undeclared core is never named, and no media key was needed')
  t.alike(log.invalid.map((i) => i.seq), [1, 2, 3, 4])
})

test('profile.delete of a pair is atomic at the diary limit', async (t) => {
  await testnet(t)
  const core = hex(crypto.keyPair().publicKey)
  const at = nowIso()
  const p = await prepared(() => [
    profileRecord({ name: 'A', bio: '', at }),
    profileRecord({ name: 'A', bio: '', at, avatar: avatarOf(core) })
  ])
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair, limits: { maxLogBlocks: 4 } })
  const key = p.key
  t.alike(await errorPair(web.request('profile.delete', { to: key + ':1' })), ['USAGE', 'limite do diário atingido'])
  const log = await web.request('log.read', {})
  t.alike([log.entries.length, log.invalid], [3, []], 'neither tombstone was written')
})

test('post.delete and profile.delete: locked refused, a failed catch-up appends nothing', async (t) => {
  await testnet(t)
  const p = await prepared(() => [profileRecord({ name: 'Bia', bio: '' })])
  const locked = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: null })
  for (const method of ['post.delete', 'profile.delete']) {
    t.alike(await errorPair(locked.web.request(method, { to: p.key + ':1' })), ['USAGE', LOCKED], method + ' locked')
  }
  t.is((await locked.web.request('log.read', {})).entries.length, 2)
  t.absent(locked.web.events.some((e) => e.name === 'sync.started'), 'no run for a locked identity')

  const q = await prepared(() => [profileRecord({ name: 'Bia', bio: '' })])
  const gated = await setup(t, { storage: q.storage, assoc: q.assoc, keyPair: q.keyPair, writeGate: true, writeGateTimeoutMs: 1500, syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  t.alike(await errorPair(gated.web.request('profile.delete', { to: q.key + ':1' })), ['USAGE', 'sincronize com o semeador antes de publicar'])
  const log = await gated.web.request('log.read', {})
  t.alike([log.entries.length, log.invalid], [2, []], 'nothing appended')
  t.is((await gated.web.request('profile.read', { authors: [q.key] })).profiles[0].name, 'Bia')
})

test('readAll folds tombstones and keeps every index', async (t) => {
  await testnet(t)
  const p = await prepared(() => [profileRecord({ name: 'Bia', bio: '' })])
  const ctx = { storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair }
  await member.postCreate(ctx, { text: 'um' })
  await member.postDelete(ctx, { to: { author: p.key, seq: 2 } })
  const folded = await member.withIdentity(ctx, async ({ diary }) => ({ all: await store.readAll(diary), raw: await store.readRaw(diary) }))
  t.alike(folded.all.map((e) => e.seq), [0, 1, 2, 3])
  t.alike(folded.all[2], { seq: 2, record: null, deleted: true })
  t.is(folded.raw[2].record.text, 'um', 'readRaw leaves the block as written')
})
