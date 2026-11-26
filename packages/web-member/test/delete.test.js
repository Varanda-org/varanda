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
const { profileRecord, likeRecord, followRecord, postRecord, postThumbsRecord, postAltRecord, postShareRecord, postCoverRecord, deleteRecord, nowIso, validateRecord, MAX_DELETE_RANGES } = require('@varanda/core/lib/records')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')
const { createBrowserNode } = require('../lib/node')
const { jpegHead } = require('./helpers/photo')

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
  t.is((await web.request('post.create', { text: 'fica' })).seq, 6)
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
  t.alike(await errorPair(web.request('profile.delete', { to: key + ':6' })), ['USAGE', NOT_PROFILE], 'a post to profile.delete')
  // Block 4's bytes are cleared, so its type is unknown: the existing
  // tombstone answers, as for any already-deleted target, and writes nothing.
  t.alike(await web.request('profile.delete', { to: key + ':4' }), { seq: 5, ref: key + ':5', changed: false, deleted: [4] }, 'a deleted and cleared post to profile.delete')
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

test('post.delete of a 10-photo post: three tombstones of at most 4 ranges in one append', async (t) => {
  await testnet(t)
  const s = await certified(t)
  const photos = []
  for (let i = 0; i < 14; i++) {
    const bytes = webp512()
    bytes[bytes.length - 1] ^= i + 1
    photos.push(await s.node.mediaUpload({ bytes, mime: 'image/webp', width: 512, height: 512 }))
  }
  const ten = photos.slice(0, 10)
  // 1: media-core declaration
  t.is((await s.web.request('post.create', { text: 'dez', media: ten })).seq, 2)
  t.is((await s.web.request('post.create', { text: 'quatro', media: photos.slice(10) })).seq, 3)

  t.alike(await s.web.request('post.delete', { to: s.key + ':2' }), { seq: 6, ref: s.key + ':6', changed: true, deleted: [2] })
  const log = await s.web.request('log.read', {})
  const tombs = log.entries.filter((e) => e.seq >= 4)
  t.alike(tombs.map((e) => e.seq), [4, 5, 6], 'three tombstones')
  for (const { seq, record } of tombs) {
    t.alike([record.type, record.seq, record.at], ['delete', 2, tombs[0].record.at], 'same target and at')
    t.ok(record.media.length <= MAX_DELETE_RANGES, 'at most 4 ranges')
    t.is(validateRecord(record, seq), null, 'valid at its seq')
  }
  t.alike(tombs.flatMap((e) => e.record.media), ten.map((d) => ({ core: d.core, start: d.start, blocks: d.blocks })), 'together the ten ranges')

  t.alike(await s.web.request('post.delete', { to: s.key + ':2' }), { seq: 6, ref: s.key + ':6', changed: false, deleted: [2] }, 'the repeat writes nothing')
  t.is((await s.web.request('log.read', {})).entries.length, log.entries.length, 'nothing appended')

  t.alike(await s.web.request('post.delete', { to: s.key + ':3' }), { seq: 7, ref: s.key + ':7', changed: true, deleted: [3] }, 'a 4-photo post still gets one tombstone')
  const last = (await s.web.request('log.read', {})).entries.slice(-1)[0].record
  t.alike([last.seq, last.media.length], [3, 4])
  t.alike(s.internal, [], 'no internal error')
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
  for (const noClear of [false, true]) {
    const p = await prepared(() => [profileRecord({ name: 'Bia', bio: '' })])
    const ctx = { storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair, noClear }
    await member.postCreate(ctx, { text: 'um' })
    await member.postDelete(ctx, { to: { author: p.key, seq: 2 } })
    const folded = await member.withIdentity(ctx, async ({ diary }) => ({ all: await store.readAll(diary), raw: await store.readRaw(diary) }))
    t.alike(folded.all.map((e) => e.seq), [0, 1, 2, 3])
    t.alike(folded.all[2], { seq: 2, record: null, deleted: true })
    if (noClear) t.is(folded.raw[2].record.text, 'um', 'with noClear readRaw leaves the block as written')
    else t.alike(folded.raw[2], { seq: 2, record: null }, 'by default the deleted bytes are cleared, so readRaw has no record')
    t.is(folded.raw[3].record.type, 'delete', 'the tombstone is kept')
  }
})

test('post.delete of a shared post tombstones its cover with the cover\'s range', async (t) => {
  await testnet(t)
  const s = await certified(t)
  const bytes = b4a.alloc(3000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff
  const cover = await s.node.mediaUpload({ bytes: jpegHead(bytes, 1200, 630), mime: 'image/jpeg', width: 1200, height: 630 })
  const photo = await s.node.mediaUpload({ bytes: jpegHead(b4a.alloc(3100), 640, 480), mime: 'image/jpeg', width: 640, height: 480 })
  // 1: media-core declaration
  t.is((await s.web.request('post.create', { text: 'pública', media: [photo] })).seq, 2)
  const to = s.key + ':2'
  t.alike(await s.web.request('post.share', { to }), { shareSeq: 3, created: true })
  t.alike(await s.web.request('post.cover', { to, image: cover }), { coverSeq: 4, created: true })

  t.alike(await s.web.request('post.delete', { to }), { seq: 6, ref: s.key + ':6', changed: true, deleted: [2] }, 'the answer names the post only')
  const log = await s.web.request('log.read', {})
  const tombs = log.entries.filter((e) => e.seq >= 5).map((e) => e.record)
  t.alike(tombs.map((r) => [r.type, r.seq, r.media]), [['delete', 2, [{ core: photo.core, start: photo.start, blocks: photo.blocks }]], ['delete', 4, [{ core: cover.core, start: cover.start, blocks: cover.blocks }]]], 'the post, then its cover with its range, in one append')
  t.is(tombs[0].at, tombs[1].at, 'one deletion')
  t.alike(log.invalid.filter((i) => i.seq === 4), [{ seq: 4, reason: 'deleted' }], 'the cover block is cleared')
  t.alike(await s.web.request('post.delete', { to }), { seq: 5, ref: s.key + ':5', changed: false, deleted: [2] }, 'the repeat writes nothing')
  t.alike(s.internal, [], 'no internal error')
})

test('a repeat post.delete of a cleared post tombstones the covers an older writer left live', async (t) => {
  await testnet(t)
  const image = { core: 'ab'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 3000, sha256: 'cd'.repeat(32), width: 1200, height: 630 }
  const p = await prepared(() => [postRecord({ text: 'pública' }), postShareRecord({ seq: 1 }), postCoverRecord({ seq: 1, image }), deleteRecord({ seq: 1 })])
  await member.withIdentity({ storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair }, ({ diary }) => diary.clear(1, 2))
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair, mediaKeyPair: null })
  const to = p.key + ':1'
  t.alike(await web.request('post.delete', { to }), { seq: 5, ref: p.key + ':5', changed: true, deleted: [1] })
  const tomb = (await web.request('log.read', {})).entries.find((e) => e.seq === 5).record
  t.alike([tomb.type, tomb.seq, 'media' in tomb], ['delete', 3, false], 'the leftover cover, no range in an undeclared core')
  t.alike(await web.request('post.delete', { to }), { seq: 4, ref: p.key + ':4', changed: false, deleted: [1] }, 'with no cover left the repeat writes nothing')
})

test('post.delete past one append: the post\'s tombstones go first, together; a failed later chunk is finished by a repeat', async (t) => {
  await testnet(t)
  const core = 'ab'.repeat(32)
  const image = (start) => ({ core, mime: 'image/jpeg', start, blocks: 1, bytes: 3000, sha256: 'cd'.repeat(32), width: 1200, height: 630 })
  // 1 media-core, 2 the post (10 photos: 3 tombstones), 3 its share, 4 to 9
  // six live covers another writer left: 9 tombstones, two appends.
  const p = await prepared(() => [
    { type: 'media-core', key: core, at: nowIso() },
    postRecord({ text: 'dez fotos', media: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(image) }),
    postShareRecord({ seq: 2 }),
    ...[11, 12, 13, 14, 15].map((start) => postCoverRecord({ seq: 2, image: image(start) }))
  ])
  await member.withIdentity({ storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair }, ({ diary }) => store.appendRecords(diary, [postCoverRecord({ seq: 2, image: image(16) })]))
  const to = p.key + ':2'
  // 10 to 17 the first append; 18 is refused.
  const first = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair, mediaKeyPair: null, limits: { maxLogBlocks: 18 } })
  const err = await errorOf(first.web.request('post.delete', { to }))
  t.is(err && err.message, 'limite do diário atingido', 'the second append fails')
  const landed = (await first.web.request('log.read', {})).entries.filter((e) => e.seq >= 10).map((e) => e.record.seq)
  t.alike(landed, [2, 2, 2, 4, 5, 6, 7, 8], 'the post\'s three tombstones in the first append, then the oldest covers')
  await first.node.close()

  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair, mediaKeyPair: null })
  t.alike(await web.request('post.delete', { to }), { seq: 18, ref: p.key + ':18', changed: true, deleted: [2] }, 'the repeat tombstones the cover left')
  const log = await web.request('log.read', {})
  const tombs = log.entries.filter((e) => e.seq >= 10).map((e) => e.record)
  t.alike(tombs.map((r) => r.seq), [2, 2, 2, 4, 5, 6, 7, 8, 9], 'every block of the post tombstoned')
  const freed = tombs.filter((r) => r.seq === 2).flatMap((r) => r.media.map((m) => m.start)).sort((a, b) => a - b)
  t.alike(freed, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'no range of the post left live')
  t.alike(tombs[8].media, [{ core, start: 16, blocks: 1 }], 'the last cover with its range')
  t.alike(log.entries.filter((e) => e.record.type === 'post-cover'), [], 'no live cover')
  t.alike(await web.request('post.delete', { to }), { seq: 12, ref: p.key + ':12', changed: false, deleted: [2] }, 'nothing left: the post\'s tombstone answers')
})

test('D-FIX: post delete prefixes keep ranges shared with later covers', async (t) => {
  const image = { core: 'ab'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 3000, sha256: 'cd'.repeat(32), width: 1200, height: 630 }
  const p = await prepared(() => [
    { type: 'media-core', key: image.core, at: nowIso() },
    postRecord({ text: 'foto', media: [image] }),
    ...Array.from({ length: 6 }, () => postCoverRecord({ seq: 2, image }))
  ])
  const ctx = { storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair }
  await member.withIdentity(ctx, ({ diary }) => store.appendRecords(diary, Array.from({ length: 3 }, () => postCoverRecord({ seq: 2, image }))))
  ctx.limits = { maxLogBlocks: 20 }
  const to = { author: p.key, seq: 2 }
  const err = await errorOf(member.postDelete(ctx, { to }))
  t.is(err && err.message, 'limite do diário atingido', 'the second append fails')
  const raw = () => member.withIdentity(ctx, async ({ diary }) => (await store.readHeld(diary)).entries)
  const first = (await raw()).filter((e) => e.record && e.record.type === 'delete')
  t.is(first.length, 8)
  t.ok(first.every((e) => e.record.media === undefined), 'neither the post nor an early cover releases the range')
  delete ctx.limits
  await member.postDelete(ctx, { to })
  const tombs = (await raw()).filter((e) => e.record && e.record.type === 'delete')
  t.alike(tombs.filter((e) => e.record.media).map((e) => [e.record.seq, e.record.media]), [[11, [{ core: image.core, start: 1, blocks: 1 }]]], 'only the last cover releases it')
})

test('post.delete of a 10-photo post with 10 thumbnails: both records go in one append with every range', async (t) => {
  await testnet(t)
  const s = await certified(t)
  const photos = []
  const previews = []
  for (let i = 0; i < 10; i++) {
    const bytes = webp512()
    bytes[bytes.length - 1] ^= i + 1
    photos.push(await s.node.mediaUpload({ bytes, mime: 'image/webp', width: 512, height: 512 }))
    const small = jpegHead(b4a.alloc(300 + i), 64, 48)
    previews.push(await s.node.mediaUpload({ bytes: small, mime: 'image/jpeg', width: 64, height: 48 }))
  }
  // 1: media-core declaration
  t.alike(await s.web.request('post.create', { text: 'dez', media: photos, thumbs: previews }), { seq: 2, ref: s.key + ':2' })
  t.alike(await s.web.request('post.delete', { to: s.key + ':2' }), { seq: 9, ref: s.key + ':9', changed: true, deleted: [2] })
  const log = await s.web.request('log.read', {})
  const tombs = log.entries.filter((e) => e.seq >= 4)
  t.alike(tombs.map((e) => e.record.seq), [2, 2, 2, 3, 3, 3], 'three tombstones of the post, three of its thumbnails record')
  for (const { seq, record } of tombs) {
    t.ok(record.media.length <= MAX_DELETE_RANGES, 'at most 4 ranges')
    t.is(validateRecord(record, seq), null, 'valid at its seq')
  }
  const range = (d) => ({ core: d.core, start: d.start, blocks: d.blocks })
  t.alike(tombs.slice(0, 3).flatMap((e) => e.record.media), photos.map(range), 'the ten photos')
  t.alike(tombs.slice(3).flatMap((e) => e.record.media), previews.map(range), 'the ten thumbnails')
  t.alike(await s.web.request('post.delete', { to: s.key + ':2' }), { seq: 6, ref: s.key + ':6', changed: false, deleted: [2] }, 'the repeat writes nothing')
  t.alike(s.internal, [], 'no internal error')
})

test('post.delete also tombstones the orphaned thumbnails of an earlier delete, at most four per delete', async (t) => {
  await testnet(t)
  const preview = { core: 'ab'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 300, sha256: 'cd'.repeat(32), width: 64, height: 48 }
  const full = { ...preview, start: 2, bytes: 900, width: 640, height: 480 }
  // Six posts an older writer deleted without their previews records (each
  // pair 1+2, 3+4, ... then its tombstone), then a live post.
  const records = []
  for (let i = 0; i < 6; i++) {
    records.push(postRecord({ text: 'p' + i, media: [full] }), postThumbsRecord({ seq: records.length + 1, thumbs: [preview] }))
  }
  for (let i = 0; i < 6; i++) records.push(deleteRecord({ seq: 1 + 2 * i }))
  records.push(postRecord({ text: 'viva' }))
  const p = await prepared(() => [])
  await member.withIdentity({ storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair }, async ({ diary }) => {
    for (let i = 0; i < records.length; i += 8) await store.appendRecords(diary, records.slice(i, i + 8))
    for (let i = 0; i < 6; i++) await diary.clear(1 + 2 * i, 2 + 2 * i)
  })
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair, mediaKeyPair: null })
  const live = records.length
  const first = await web.request('post.delete', { to: p.key + ':' + live })
  t.is(first.changed, true)
  const orphanTombs = async () => (await web.request('log.read', {})).entries.filter((e) => e.seq > live && e.record && e.record.type === 'delete').map((e) => e.record.seq)
  t.alike(await orphanTombs(), [live, 2, 4, 6, 8], 'the post and the first four orphaned records')
  const next = await web.request('post.create', { text: 'outra' })
  await web.request('post.delete', { to: next.ref })
  t.alike((await orphanTombs()).slice(5), [next.seq, 10, 12], 'a later delete sweeps the rest')
})

test('a repeat post.delete of a cleared post tombstones the thumbnails an older writer left live', async (t) => {
  await testnet(t)
  const preview = { core: 'ab'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 300, sha256: 'cd'.repeat(32), width: 64, height: 48 }
  const full = { ...preview, start: 2, bytes: 900, width: 640, height: 480 }
  const p = await prepared(() => [postRecord({ text: 'foto', media: [full] }), postThumbsRecord({ seq: 1, thumbs: [preview] }), deleteRecord({ seq: 1 })])
  await member.withIdentity({ storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair }, ({ diary }) => diary.clear(1, 2))
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair, mediaKeyPair: null })
  const to = p.key + ':1'
  t.alike(await web.request('post.delete', { to }), { seq: 4, ref: p.key + ':4', changed: true, deleted: [1] })
  const tomb = (await web.request('log.read', {})).entries.find((e) => e.seq === 4).record
  t.alike([tomb.type, tomb.seq], ['delete', 2], 'the leftover thumbnails record')
  t.alike(await web.request('post.delete', { to }), { seq: 3, ref: p.key + ':3', changed: false, deleted: [1] }, 'with nothing left the repeat writes nothing')
})

test('post.delete tombstones descriptions after previews in the same append', async (t) => {
  const full = { core: 'ab'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 900, sha256: 'cd'.repeat(32), width: 640, height: 480 }
  for (const thumbs of [false, true]) {
    const records = [postRecord({ text: 'foto', media: [full] })]
    if (thumbs) records.push(postThumbsRecord({ seq: 1, thumbs: [{ ...full, start: 2 }] }))
    records.push(postAltRecord({ seq: 1, alt: ['Uma árvore'], gap: thumbs ? 1 : 0 }))
    const p = await prepared(() => records)
    const ctx = { storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair }
    const realAppend = store.appendRecords
    const calls = []
    store.appendRecords = (diary, records, limits) => {
      calls.push(records)
      return realAppend(diary, records, limits)
    }
    try {
      await member.postDelete(ctx, { to: { author: p.key, seq: 1 } })
    } finally {
      store.appendRecords = realAppend
    }
    t.is(calls.length, 1)
    t.alike(calls[0].map((r) => [r.type, r.seq]), thumbs ? [['delete', 1], ['delete', 2], ['delete', 3]] : [['delete', 1], ['delete', 2]])
    t.absent('media' in calls[0].at(-1), 'the description tombstone has no ranges')
  }
})

test('post.delete sweeps orphaned descriptions with the same four-record budget as previews', async (t) => {
  const full = { core: 'ab'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 900, sha256: 'cd'.repeat(32), width: 640, height: 480 }
  const records = []
  for (let i = 0; i < 5; i++) {
    const seq = records.length + 1
    const companion = i % 2 === 0 ? postAltRecord({ seq, alt: ['Uma árvore'] }) : postThumbsRecord({ seq, thumbs: [{ ...full, start: 2 }] })
    records.push(postRecord({ text: 'foto', media: [full] }), companion, deleteRecord({ seq }))
  }
  records.push(postRecord({ text: 'viva' }))
  const p = await prepared(() => [])
  const ctx = { storage: p.storage, association: p.assoc.hex, keyPair: p.keyPair }
  await member.withIdentity(ctx, async ({ diary }) => {
    for (let i = 0; i < records.length; i += 8) await store.appendRecords(diary, records.slice(i, i + 8))
  })
  await member.postDelete(ctx, { to: { author: p.key, seq: records.length } })
  const entries = await member.withIdentity(ctx, ({ diary }) => store.readAll(diary))
  t.alike(entries.filter((e) => e.seq > records.length).map((e) => e.record.seq), [16, 2, 5, 8, 11])
})
