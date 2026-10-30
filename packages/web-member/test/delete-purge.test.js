// Deletion purge in the browser node: the writer (lib/member-ops.js
// recordDelete) clears the deleted block and the photo blocks of the own
// media core, and they stay cleared after the storage reopens (IndexedDB
// stand-in); the present length equals the length; a repeat after the clear
// writes nothing; noClear keeps the bytes. The sync (lib/sync.js) never
// refills a deleted own block from a seeder that still holds it, and the
// push of a surviving photo is confirmed although the deleted photo's blocks
// are gone everywhere, also on a new link where the seeder advertises its
// blocks as a bitfield past the cleared ones.
require('fake-indexeddb/auto')
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { WebSocketServer, WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { MEDIA_BLOCK_BYTES, profileRecords, followRecord, postRecord } = require('@varanda/core/lib/records')
const { presentLength, clearDeleted } = require('@varanda/core/lib/deletion')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { runSync, trackPresent, linearExcept, MAX_RANGES } = require('../lib/sync')
const { idbNodeStorage, memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

let dbCount = 0
function dbName () {
  return 'varanda-delete-purge-' + process.pid + '-' + (++dbCount)
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function item (n, seed = 1) {
  const bytes = b4a.alloc(n)
  for (let i = 0; i < n; i++) bytes[i] = (i * 13 + seed) & 0xff
  const blocks = []
  for (let at = 0; at < n; at += MEDIA_BLOCK_BYTES) blocks.push(bytes.subarray(at, Math.min(n, at + MEDIA_BLOCK_BYTES)))
  return { blocks, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function member (storage = memoryNodeStorage(), extra = {}) {
  const assocKp = generateAssociationKeyPair()
  const keyPair = crypto.keyPair()
  const ctx = { storage, association: hex(assocKp.publicKey), keyPair, mediaKeyPair: crypto.keyPair(), ...extra }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
  return { storage, assocKp, keyPair, ownHex, ctx }
}

// A declared and committed photo -> its descriptor.
async function photo (m, n, seed) {
  const { core, declared } = await ops.mediaPrepare(m.ctx)
  if (!declared) await ops.declareMediaCore(m.ctx, core)
  return ops.mediaCommit(m.ctx, { ...item(n, seed), mime: 'image/png', width: 10, height: 10 })
}

async function heldIn (core, start, end) {
  const out = []
  for (let i = start; i < end; i++) out.push(await core.has(i))
  return out
}

async function diaryState (storage, seq = 0) {
  const diary = await store.openDiary(storage)
  try {
    const all = await store.readAll(diary)
    const deleted = new Set(all.filter((e) => e.deleted).map((e) => e.seq))
    return { length: diary.length, all, present: await presentLength(diary, deleted), held: await diary.has(seq) }
  } finally {
    await diary.close()
  }
}

test('the writer clears the deleted post and its photo; they stay cleared after a reopen; the repeat writes nothing', async (t) => {
  await testnet(t, 1)
  const name = dbName()
  const storage = await idbNodeStorage(name)
  const m = await member(storage)
  const gone = await photo(m, MEDIA_BLOCK_BYTES + 100, 3)
  const kept = await photo(m, 500, 7)
  const { seq } = await ops.postCreate(m.ctx, { text: 'foto apagada', media: [gone] })
  await ops.postCreate(m.ctx, { text: 'fica', media: [kept] })
  const d = await ops.postDelete(m.ctx, { to: { author: m.ownHex, seq } })
  t.is(d.changed, true)

  const check = async (s, label) => {
    const diary = await store.openDiary(s)
    try {
      t.absent(await diary.has(seq), label + ': the deleted post block is cleared')
      const all = await store.readAll(diary)
      t.is(all.length, diary.length, label + ': the present length equals the length')
      t.alike(all[seq], { seq, record: null, deleted: true }, label + ': read as deleted')
    } finally {
      await diary.close()
    }
    const media = await store.openMediaCoreReadOnly(s, gone.core)
    try {
      t.alike(await heldIn(media, gone.start, gone.start + gone.blocks), new Array(gone.blocks).fill(false), label + ': the photo blocks are cleared')
      t.alike(await heldIn(media, kept.start, kept.start + kept.blocks), [true], label + ': the surviving photo stays')
      t.ok(await media.has(0), label + ': the media header stays')
    } finally {
      await media.close()
    }
  }
  await check(storage, 'now')
  await storage.close()
  const again = await idbNodeStorage(name)
  await check(again, 'after the reopen')

  const ctx = { ...m.ctx, storage: again }
  const repeat = await ops.postDelete(ctx, { to: { author: m.ownHex, seq } })
  t.alike(repeat, { seq: d.seq, ref: d.ref, changed: false, deleted: [seq] }, 'the repeat after the clear names the tombstone')
  const s = await diaryState(again)
  t.is(s.length, d.seq + 1, 'nothing appended')
  await again.close()
})

test('a cleared compatibility pair repeats as one version with the pair\'s last tombstone', async (t) => {
  const m = await member()
  const avatar = { core: 'ab'.repeat(32), mime: 'image/webp', start: 1, blocks: 1, bytes: 2000, sha256: 'e'.repeat(64), width: 512, height: 512 }
  const last = await ops.withIdentity(m.ctx, ({ diary }) => store.appendRecords(diary, profileRecords({ name: 'Ana', avatar })))
  const n = last - 1
  const d = await ops.profileDelete(m.ctx, { to: { author: m.ownHex, seq: last } })
  t.alike(d, { seq: last + 2, ref: m.ownHex + ':' + (last + 2), changed: true, deleted: [n, last] })
  const s = await diaryState(m.storage, n)
  t.absent(s.held, 'fixture: the pair is cleared')
  t.is(s.all[last + 1].record.at, s.all[last + 2].record.at, 'both tombstones of the pair carry one at')
  t.alike(await ops.profileDelete(m.ctx, { to: { author: m.ownHex, seq: n } }), { ...d, changed: false })
  t.alike(await ops.profileDelete(m.ctx, { to: { author: m.ownHex, seq: last } }), { ...d, changed: false })
})

test('two separate deletions of adjacent cleared profiles are never reported as one pair', async (t) => {
  const m = await member()
  const p1 = (await ops.profileSet(m.ctx, { name: 'Ana' })).seq
  const p2 = (await ops.profileSet(m.ctx, { name: 'Bia' })).seq
  t.is(p2, p1 + 1, 'fixture: adjacent profile versions')
  const first = await ops.profileDelete(m.ctx, { to: { author: m.ownHex, seq: p1 } })
  t.alike(first, { seq: p2 + 1, ref: m.ownHex + ':' + (p2 + 1), changed: true, deleted: [p1] })
  // A separate delete never shares the first one's `at`.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await ops.profileDelete(m.ctx, { to: { author: m.ownHex, seq: p2 } })
  t.alike(second, { seq: p2 + 2, ref: m.ownHex + ':' + (p2 + 2), changed: true, deleted: [p2] })
  t.absent((await diaryState(m.storage, p1)).held, 'fixture: the first target is cleared')
  t.absent((await diaryState(m.storage, p2)).held, 'fixture: the second target is cleared')
  t.alike(await ops.profileDelete(m.ctx, { to: { author: m.ownHex, seq: p1 } }), { ...first, changed: false })
  t.alike(await ops.profileDelete(m.ctx, { to: { author: m.ownHex, seq: p2 } }), { ...second, changed: false })
})

test('noClear keeps the bytes; the tombstone still hides the post', async (t) => {
  await testnet(t, 1)
  const m = await member(memoryNodeStorage(), { noClear: true })
  const { seq } = await ops.postCreate(m.ctx, { text: 'fica guardado' })
  await ops.postDelete(m.ctx, { to: { author: m.ownHex, seq } })
  const s = await diaryState(m.storage, seq)
  t.ok(s.held, 'the block is still held')
  t.alike(s.all[seq], { seq, record: null, deleted: true })
})

// A seeder stand-in (as test/sync-media.test.js).
async function fakeSeeder (t, { signer, cores = [], spy = [] }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
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
          if (msg.type !== 'announce') return
          const held = cores.find((core) => hex(core.key) === msg.key)
          peer.send({ type: 'admitted', key: msg.key, length: held ? held.length : (peer.remoteHave.get(msg.key) || 0) })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
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

async function until (fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

async function copyCore (from, to) {
  const a = from.replicate(true)
  const b = to.replicate(false)
  a.pipe(b).pipe(a)
  await to.download({ start: 0, end: from.length }).done()
  a.destroy()
  b.destroy()
}

test('the own diary never refills a deleted block from a seeder that still holds it', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const m = await member()
  const { seq } = await ops.postCreate(m.ctx, { text: 'vai sumir' })
  await ops.postCreate(m.ctx, { text: 'fica' })
  // An older seeder copy holding every block, the deleted one included.
  const older = new Hypercore(memoryStorage(), m.keyPair.publicKey, { valueEncoding: 'binary' })
  await older.ready()
  t.teardown(() => older.close(), { force: true })
  const diary = await store.openDiary(m.storage)
  await copyCore(diary, older)
  await diary.close()
  t.ok(await older.has(seq))

  await ops.postDelete(m.ctx, { to: { author: m.ownHex, seq } })
  const seeder = await fakeSeeder(t, { signer: m.assocKp, cores: [older] })
  const events = []
  const ac = new AbortController()
  const run = sync(m.storage, seeder.url, events, { signal: ac.signal })
  const synced = await until(() => events.some((e) => e.event === 'own-synced'))
  await new Promise((resolve) => setTimeout(resolve, 500))
  ac.abort()
  await run
  t.ok(synced, 'own-synced arrived')
  t.alike(events.filter((e) => e.event === 'own-behind'), [], 'never behind an older seeder copy')
  t.is(events.find((e) => e.event === 'own-synced').length, seq + 3, 'own-synced at the present length, the full length')
  const s = await diaryState(m.storage, seq)
  t.absent(s.held, 'the deleted block was not refilled')
  t.is(s.present, s.length, 'the present length equals the length')
})

test('the push of a surviving photo completes although the deleted photo is cleared, also on a new link', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const m = await member()
  const gone = await photo(m, MEDIA_BLOCK_BYTES + 100, 3)
  const kept = await photo(m, 500, 7)
  const { seq } = await ops.postCreate(m.ctx, { text: 'foto apagada', media: [gone] })
  await ops.postCreate(m.ctx, { text: 'fica', media: [kept] })
  await ops.postDelete(m.ctx, { to: { author: m.ownHex, seq } })
  const length = kept.start + kept.blocks

  // The seeder side holds the header and the surviving photo, never the
  // deleted one (cleared everywhere).
  const spy = new Hypercore(memoryStorage(), b4a.from(kept.core, 'hex'))
  await spy.ready()
  t.teardown(() => spy.close(), { force: true })
  spy.download({ start: 0, end: 1 })
  spy.download({ start: kept.start, end: length })
  const seeder = await fakeSeeder(t, { signer: m.assocKp, spy: [spy] })

  const events = []
  const ac = new AbortController()
  const run = sync(m.storage, seeder.url, events, { signal: ac.signal, mediaPollMs: 50 })
  const pushed = await until(() => events.some((e) => e.event === 'media-pushed'))
  ac.abort()
  await run
  t.ok(pushed, 'media-pushed on the first link')
  t.alike(await heldIn(spy, gone.start, gone.start + gone.blocks), new Array(gone.blocks).fill(false), 'the deleted photo never reached the seeder side')

  // A new link: nothing to upload; the seeder advertises its blocks past
  // the missing ones, and the revoked blocks count as held.
  const second = []
  const ac2 = new AbortController()
  const run2 = sync(m.storage, seeder.url, second, { signal: ac2.signal, mediaPollMs: 50 })
  const pushed2 = await until(() => second.some((e) => e.event === 'media-pushed'))
  ac2.abort()
  await run2
  t.ok(pushed2, 'media-pushed on the new link')
  t.alike(second.filter((e) => e.event === 'media-pushed'), [{ event: 'media-pushed', key: kept.core, length }])
})

test('a stored replica whose scan ends after the inventory settles a once run without waiting for the deadline', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const m = await member()
  await store.writeFollowsMigrated(m.storage)
  // A followed member of the same association, already fully stored here.
  const followed = { storage: memoryNodeStorage(), association: m.ctx.association, keyPair: crypto.keyPair() }
  await ops.idCreate(followed)
  const followedHex = hex(followed.keyPair.publicKey)
  await ops.certAdd(followed, createCert({ member: followedHex }, m.assocKp))
  await ops.postCreate(followed, { text: 'um' })
  await ops.postCreate(followed, { text: 'dois' })
  const source = await store.openDiary(followed.storage)
  t.teardown(() => source.close(), { force: true })
  const local = await store.openReplica(m.storage, followedHex)
  await copyCore(source, local)
  await local.close()
  await store.writeFollows(m.storage, [followedHex])

  // The seeder's copy, advertised in its inventory at the full length.
  const held = new Hypercore(memoryStorage(), followed.keyPair.publicKey, { valueEncoding: 'binary' })
  await held.ready()
  t.teardown(() => held.close(), { force: true })
  await copyCore(source, held)
  const seeder = await fakeSeeder(t, { signer: m.assocKp, cores: [held] })

  // The run's initial scan of the stored replica reads past block 0 only
  // after the inventory had time to arrive.
  const openReplica = store.openReplica
  t.teardown(() => { store.openReplica = openReplica }, { force: true })
  store.openReplica = async (...args) => {
    const core = await openReplica(...args)
    const late = new Promise((resolve) => setTimeout(resolve, 1500))
    const get = core.get.bind(core)
    core.get = async (index, opts) => {
      if (index >= 1) await late
      return get(index, opts)
    }
    return core
  }

  const events = []
  const started = Date.now()
  const result = await sync(m.storage, seeder.url, events, { once: true, timeoutMs: 8000 })
  const took = Date.now() - started
  store.openReplica = openReplica
  t.ok(result.ok, 'the once run ends done')
  t.ok(took < 6000, 'it ends before its deadline (' + took + ' ms)')
  t.is(result.downloaded[followedHex], source.length, 'the stored replica counts at its full length')
})

// A member of m's association with `posts` posts, each one then deleted.
// The writer keeps the bytes (noClear), as a stale holder would: a reader
// then fetches the deleted blocks too unless its ranges skip them.
async function deletedPosts (m, posts) {
  const other = { storage: memoryNodeStorage(), association: m.ctx.association, keyPair: crypto.keyPair(), noClear: true }
  await ops.idCreate(other)
  const otherHex = hex(other.keyPair.publicKey)
  await ops.certAdd(other, createCert({ member: otherHex }, m.assocKp))
  const seqs = []
  for (let i = 0; i < posts; i++) seqs.push((await ops.postCreate(other, { text: 'post ' + i })).seq)
  for (const seq of seqs) await ops.postDelete(other, { to: { author: otherHex, seq } })
  return { other, otherHex, seqs }
}

test('a burst of arriving tombstones runs a few merged present-length steps', async (t) => {
  t.timeout(60000)
  await testnet(t, 1)
  const N = 30
  const m = await member()
  const { other, seqs } = await deletedPosts(m, N)
  const source = await store.openDiary(other.storage)
  t.teardown(() => source.close(), { force: true })
  const reader = new Hypercore(memoryStorage(), other.keyPair.publicKey, { valueEncoding: 'binary' })
  await reader.ready()
  t.teardown(() => reader.close(), { force: true })
  const tracker = trackPresent(reader, {})
  t.teardown(() => tracker.destroy(), { force: true })
  await tracker.ready
  const a = source.replicate(true)
  const b = reader.replicate(false)
  a.pipe(b).pipe(a)
  t.teardown(() => { a.destroy(); b.destroy() }, { force: true })
  t.ok(await until(() => tracker.present() === source.length), 'the present length reaches the full length')
  await new Promise((resolve) => setTimeout(resolve, 200))
  const steps = tracker.steps()
  t.comment('steps for ' + (source.length - 1) + ' arriving blocks: ' + steps)
  t.ok(steps >= 1, 'the arrivals were handled')
  t.ok(steps <= N / 3, 'events during a step merge into one more (' + steps + ')')
  t.alike([...tracker.deleted()].sort((x, y) => x - y), seqs, 'every post is deleted')
  t.alike(await heldIn(reader, seqs[0], seqs[N - 1] + 1), seqs.map(() => false), 'no deleted post is held')
})

test('noClear keeps an unfollowed replica and its index entry; a later run purges it', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const m = await member()
  await store.writeFollowsMigrated(m.storage)
  const { other, otherHex } = await deletedPosts(m, 1)
  const source = await store.openDiary(other.storage)
  t.teardown(() => source.close(), { force: true })
  const local = await store.openReplica(m.storage, otherHex)
  await copyCore(source, local)
  await local.close()
  await store.writeFollows(m.storage, [])
  await m.storage.writeJson('replicas', { v: 1, keys: [otherHex] })
  const seeder = await fakeSeeder(t, { signer: m.assocKp })

  await sync(m.storage, seeder.url, [], { once: true, timeoutMs: 3000, noClear: true })
  t.ok(await store.replicaExists(m.storage, otherHex), 'kill switch: the unfollowed replica stays')
  t.alike((await m.storage.readJson('replicas')).keys, [otherHex], 'and stays indexed')

  await sync(m.storage, seeder.url, [], { once: true, timeoutMs: 3000 })
  t.absent(await store.replicaExists(m.storage, otherHex), 'without it the unfollowed replica is purged')
})

// Hypercore 10 keeps the oplog offset, tree and bitfield per instance: a
// clear through a core opened before later appends must not drop them.
test('a media core clear through a core opened before an upload keeps the blocks appended since', async (t) => {
  await testnet(t, 1)
  const name = dbName()
  const storage = await idbNodeStorage(name)
  const m = await member(storage)
  const gone = await photo(m, 500, 1)
  const early = await store.openMediaCoreReadOnly(storage, gone.core)
  const kept = await photo(m, MEDIA_BLOCK_BYTES + 10, 2)
  await store.clearMediaRanges(early, [{ start: gone.start, blocks: gone.blocks }])
  await early.close()
  await storage.close()
  const again = await idbNodeStorage(name)
  const media = await store.openMediaCoreReadOnly(again, gone.core)
  try {
    t.is(media.length, kept.start + kept.blocks, 'the length keeps the later upload')
    t.alike(await heldIn(media, kept.start, kept.start + kept.blocks), [true, true], 'the later photo survives the reopen')
    t.absent(await media.has(gone.start), 'the deleted photo is cleared')
  } finally {
    await media.close()
  }
  await again.close()
})

test('a diary clear through a core opened before an append keeps the records appended since', async (t) => {
  await testnet(t, 1)
  const name = dbName()
  const storage = await idbNodeStorage(name)
  const m = await member(storage)
  const first = await ops.postCreate(m.ctx, { text: 'apagado' })
  const early = await store.openDiary(storage)
  const second = await ops.postCreate(m.ctx, { text: 'fica' })
  const d = await ops.postDelete(m.ctx, { to: { author: m.ownHex, seq: first.seq } })
  await clearDeleted(early, [first.seq])
  await early.close()
  await storage.close()
  const again = await idbNodeStorage(name)
  const s = await diaryState(again, second.seq)
  t.is(s.length, d.seq + 1, 'the length keeps the later appends')
  t.ok(s.held, 'the later post survives the reopen')
  t.is(s.all[second.seq].record.text, 'fica', 'and reads back')
  t.ok(s.all[first.seq].deleted, 'the deleted post reads as deleted')
  await again.close()
})

// A core that counts download() calls and open ranges, holds the blocks in
// `local` and records what is cleared (any block that is not a tombstone).
function rangeCore (length) {
  const core = new EventEmitter()
  core.length = length
  core.local = new Set()
  core.downloads = 0
  core.open = 0
  core.cleared = []
  core.has = async (start, end = start + 1) => {
    for (let i = start; i < end; i++) if (!core.local.has(i)) return false
    return true
  }
  core.get = async () => b4a.from('x')
  core.clear = async (start, end) => {
    for (let i = start; i < end; i++) {
      core.local.delete(i)
      core.cleared.push(i)
    }
  }
  core.download = () => {
    core.downloads++
    core.open++
    let done = false
    return { destroy () { if (!done) { done = true; core.open-- } } }
  }
  return core
}

test('the download minus thousands of deleted seqs opens a bounded number of ranges, and one past the cap is still cleared', async (t) => {
  const deleted = new Set()
  for (let s = 2; s <= 60000; s += 2) deleted.add(s)
  const core = rangeCore(70000)
  core.local.add(4)
  const handle = linearExcept(core, deleted)
  t.teardown(() => handle.destroy())
  await handle.update(deleted)
  const atOpen = core.downloads
  t.is(atOpen, MAX_RANGES, 'MAX_RANGES download() calls at open, not one per gap')
  t.ok(core.open <= MAX_RANGES, 'at most MAX_RANGES ranges open')
  t.absent(core.cleared.includes(4), 'a seq the caller already cleared at creation is not cleared again')

  core.local.add(65001)
  const grown = new Set([...deleted, 65001])
  t.alike(await handle.update(grown), [65001], 'an update clears only the new seq')
  t.is(core.downloads, atOpen, 'a set grown inside the live range reopens nothing')
  await handle.update(grown)
  t.is(core.downloads, atOpen, 'a same-set update opens no range')

  core.local.add(50000)
  core.emit('download', 50000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.ok(core.cleared.includes(50000), 'a deleted seq inside the live range past the cap is cleared when it arrives')

  const localGaps = rangeCore(20)
  for (let i = 0; i < 20; i++) localGaps.local.add(i)
  const small = linearExcept(localGaps, new Set([3, 7]))
  t.teardown(() => small.destroy())
  await small.update(new Set([3, 7]))
  t.is(localGaps.downloads, 1, 'gaps already local get no range, only the live one')
})

test('a tombstone that lands while a step is in flight is applied before a length covering it is reported', async (t) => {
  t.timeout(60000)
  await testnet(t, 1)
  const m = await member()
  const { other, seqs } = await deletedPosts(m, 1)
  const target = seqs[0]
  const source = await store.openDiary(other.storage)
  t.teardown(() => source.close(), { force: true })
  const tomb = source.length - 1
  t.is(tomb, target + 1, 'fixture: the tombstone follows its post')
  const reader = new Hypercore(memoryStorage(), other.keyPair.publicKey, { valueEncoding: 'binary' })
  await reader.ready()
  t.teardown(() => reader.close(), { force: true })
  const a = source.replicate(true)
  const b = reader.replicate(false)
  a.pipe(b).pipe(a)
  t.teardown(() => { a.destroy(); b.destroy() }, { force: true })
  await reader.update({ wait: true })
  t.is(reader.length, source.length, 'fixture: the reader knows the full length')

  const reports = []
  const tracker = trackPresent(reader, {
    download: false,
    onGrow: (len) => {
      reports.push({ len, deleted: tracker.deleted().has(target), held: reader.has(target) })
    }
  })
  t.teardown(() => tracker.destroy(), { force: true })
  await tracker.ready
  await reader.download({ start: 0, end: target }).done()
  t.ok(await until(() => tracker.present() === target), 'fixture: the present length stops before the post')

  // The step the post's arrival starts fetches the tombstone in the middle
  // of its awaits, once.
  const has = reader.has.bind(reader)
  let armed = true
  reader.has = async (...args) => {
    if (armed) {
      armed = false
      await reader.get(tomb)
    }
    return has(...args)
  }
  await reader.get(target)
  t.ok(await until(() => tracker.present() === source.length), 'the present length reaches the full length')
  t.absent(armed, 'fixture: the tombstone arrived during a step')
  const first = reports.find((r) => r.len > tomb)
  t.ok(first, 'a length covering the tombstone was reported')
  t.ok(first && first.deleted, 'its target was already deleted when that length was reported')
  t.absent(first && await first.held, 'and already cleared')
  t.absent(await has(target), 'the post stays cleared')
})

test('a follow record whose read fails once during the fold is folded by the next fold of the run', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const m = await member()
  const followed = hex(crypto.keyPair().publicKey)
  await store.writeFollows(m.storage, [])
  await store.writeFollowsMigrated(m.storage)
  // The seeder's copy is writable (another device): it holds what this
  // device holds and later gains the follow record, which this device
  // only reads through the fold (the startup scan never saw it).
  const copy = new Hypercore(memoryStorage(), { keyPair: m.keyPair, valueEncoding: 'binary' })
  await copy.ready()
  t.teardown(() => copy.close(), { force: true })
  const diary = await store.openDiary(m.storage)
  for (let i = 0; i < diary.length; i++) await copy.append(await diary.get(i, { raw: true }))
  const seq = diary.length
  await diary.close()
  const seeder = await fakeSeeder(t, { signer: m.assocKp, cores: [copy] })

  // The fold's first read of the follow record throws; every other read of
  // it works.
  const openDiary = store.openDiary
  t.teardown(() => { store.openDiary = openDiary }, { force: true })
  let thrown = false
  store.openDiary = async (...args) => {
    const core = await openDiary(...args)
    const get = core.get.bind(core)
    core.get = async (index, opts) => {
      if (!thrown && index === seq && new Error().stack.includes('replayFollows')) {
        thrown = true
        throw new Error('read failed')
      }
      return get(index, opts)
    }
    return core
  }

  const events = []
  const ac = new AbortController()
  const run = sync(m.storage, seeder.url, events, { signal: ac.signal })
  const synced = (length) => events.some((e) => e.event === 'own-synced' && e.length === length)
  t.ok(await until(() => synced(seq), 5000), 'fixture: caught up before the follow record exists')
  await copy.append(b4a.from(JSON.stringify(followRecord({ key: followed, on: true }))))
  t.ok(await until(() => thrown, 5000), 'fixture: the fold of the new length failed on the follow record')
  await copy.append(b4a.from(JSON.stringify(postRecord({ text: 'depois' }))))
  const changed = await until(() => events.some((e) => e.event === 'follows-changed'), 5000)
  ac.abort()
  await run
  store.openDiary = openDiary
  t.ok(synced(seq + 2), 'fixture: a later fold ran on own-synced')
  t.ok(changed, 'follows-changed arrived')
  t.alike(events.filter((e) => e.event === 'follows-changed'), [{ event: 'follows-changed', count: 1, length: seq + 2 }])
  t.alike(await store.readFollows(m.storage), [followed], 'the follow is in the folded list')
})

test('under noClear the followed diary still downloads in block order', async (t) => {
  const core = new Hypercore(memoryStorage(), { valueEncoding: 'binary' })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  const ranges = []
  const download = core.download.bind(core)
  core.download = (opts) => {
    ranges.push(opts)
    return download(opts)
  }
  const tracker = trackPresent(core, { noClear: true })
  t.teardown(() => tracker.destroy(), { force: true })
  await tracker.ready
  t.is(ranges.length, 1, 'one range is open')
  t.is(ranges[0] && ranges[0].linear, true, 'it is linear')
})

test('a tombstone whose first read fails is learned on a retry, and no length covers it before', async (t) => {
  t.timeout(60000)
  await testnet(t, 1)
  const m = await member()
  const { other, seqs } = await deletedPosts(m, 1)
  const target = seqs[0]
  const source = await store.openDiary(other.storage)
  t.teardown(() => source.close(), { force: true })
  const tomb = source.length - 1
  t.is(tomb, target + 1, 'fixture: the tombstone follows its post')
  const reader = new Hypercore(memoryStorage(), other.keyPair.publicKey, { valueEncoding: 'binary' })
  await reader.ready()
  t.teardown(() => reader.close(), { force: true })
  const a = source.replicate(true)
  const b = reader.replicate(false)
  a.pipe(b).pipe(a)
  t.teardown(() => { a.destroy(); b.destroy() }, { force: true })
  await reader.update({ wait: true })
  t.is(reader.length, source.length, 'fixture: the reader knows the full length')

  const reports = []
  const tracker = trackPresent(reader, {
    download: false,
    onGrow: (len) => { reports.push({ len, deleted: tracker.deleted().has(target) }) }
  })
  t.teardown(() => tracker.destroy(), { force: true })
  await tracker.ready
  await reader.download({ start: 0, end: tomb }).done()
  t.ok(await until(() => tracker.present() === tomb), 'fixture: the present length stops before the tombstone')

  // Only the tracker's first read of the tombstone throws.
  const get = reader.get.bind(reader)
  let thrown = false
  reader.get = async (index, opts) => {
    if (!thrown && index === tomb && new Error().stack.includes('tombstoneTarget')) {
      thrown = true
      throw new Error('read failed')
    }
    return get(index, opts)
  }
  await get(tomb)
  t.ok(await until(() => tracker.deleted().has(target), 5000), 'the tombstone is learned on a retry')
  t.ok(thrown, 'fixture: its first read failed')
  t.ok(await until(async () => !(await reader.has(target)), 5000), 'its target is cleared')
  t.ok(await until(() => tracker.present() === source.length, 5000), 'the present length reaches the full length')
  t.absent(reports.some((r) => r.len > tomb && !r.deleted), 'no length covered the tombstone before it was learned')
})

test('a tombstone whose reads keep failing stays out of the length after the retries, and is learned once reads recover', async (t) => {
  t.timeout(60000)
  await testnet(t, 1)
  const m = await member()
  const { other, seqs } = await deletedPosts(m, 1)
  const target = seqs[0]
  const source = await store.openDiary(other.storage)
  t.teardown(() => source.close(), { force: true })
  const tomb = source.length - 1
  t.is(tomb, target + 1, 'fixture: the tombstone follows its post')
  const reader = new Hypercore(memoryStorage(), other.keyPair.publicKey, { valueEncoding: 'binary' })
  await reader.ready()
  t.teardown(() => reader.close(), { force: true })
  const a = source.replicate(true)
  const b = reader.replicate(false)
  a.pipe(b).pipe(a)
  t.teardown(() => { a.destroy(); b.destroy() }, { force: true })
  await reader.update({ wait: true })

  const reports = []
  const tracker = trackPresent(reader, {
    download: false,
    onGrow: (len) => { reports.push({ len, deleted: tracker.deleted().has(target) }) }
  })
  t.teardown(() => tracker.destroy(), { force: true })
  await tracker.ready
  await reader.download({ start: 0, end: tomb }).done()
  t.ok(await until(() => tracker.present() === tomb), 'fixture: the present length stops before the tombstone')

  const get = reader.get.bind(reader)
  let failing = true
  let thrown = 0
  reader.get = async (index, opts) => {
    if (failing && index === tomb && new Error().stack.includes('tombstoneTarget')) {
      thrown++
      throw new Error('read failed')
    }
    return get(index, opts)
  }
  await get(tomb)
  t.ok(await until(() => thrown >= 5, 5000), 'fixture: the timed retries ran')
  const retried = thrown
  await new Promise((resolve) => setTimeout(resolve, 1000))
  t.is(thrown, retried, 'the timed retries stop')
  t.ok(tracker.present() <= tomb, 'the length still stops before the unread tombstone')
  t.absent(tracker.deleted().has(target), 'fixture: its deletion is not known yet')

  // Any later event runs a step, which reads the block again.
  failing = false
  reader.emit('append')
  t.ok(await until(() => tracker.deleted().has(target), 5000), 'the tombstone is learned once reads recover')
  t.ok(await until(async () => !(await reader.has(target)), 5000), 'its target is cleared')
  t.ok(await until(() => tracker.present() === source.length, 5000), 'the present length reaches the full length')
  t.absent(reports.some((r) => r.len > tomb && !r.deleted), 'no length covered the tombstone before it was learned')
})

test('a followed diary whose initial scan fails reports it once and opens no download', async (t) => {
  t.timeout(60000)
  await testnet(t, 1)
  const m = await member()
  const { other } = await deletedPosts(m, 1)
  const source = await store.openDiary(other.storage)
  t.teardown(() => source.close(), { force: true })
  const reader = new Hypercore(memoryStorage(), other.keyPair.publicKey, { valueEncoding: 'binary' })
  await reader.ready()
  t.teardown(() => reader.close(), { force: true })
  const a = source.replicate(true)
  const b = reader.replicate(false)
  a.pipe(b).pipe(a)
  t.teardown(() => { a.destroy(); b.destroy() }, { force: true })
  await reader.update({ wait: true })
  t.ok(reader.length > 0, 'fixture: the reader knows a length')
  reader.has = async () => { throw new Error('read failed') }
  let downloads = 0
  reader.download = () => {
    downloads++
    return { destroy () {}, done: async () => {} }
  }
  const errors = []
  const tracker = trackPresent(reader, { onError: (err) => errors.push(err) })
  t.teardown(() => tracker.destroy(), { force: true })
  let rejected = false
  await tracker.ready.catch(() => { rejected = true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.ok(rejected, 'fixture: the scan failed')
  t.is(errors.length, 1, 'onError ran once')
  t.is(downloads, 0, 'no download was opened')
  reader.emit('append')
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(tracker.steps(), 0, 'a later event runs no step')
  t.is(tracker.present(), 0, 'no length is reported')
})

test('a step that throws after a failed tombstone read still retries it on a quiet link', async (t) => {
  t.timeout(60000)
  await testnet(t, 1)
  const m = await member()
  const { other, seqs } = await deletedPosts(m, 1)
  const target = seqs[0]
  const source = await store.openDiary(other.storage)
  t.teardown(() => source.close(), { force: true })
  const tomb = source.length - 1
  const reader = new Hypercore(memoryStorage(), other.keyPair.publicKey, { valueEncoding: 'binary' })
  await reader.ready()
  t.teardown(() => reader.close(), { force: true })
  const a = source.replicate(true)
  const b = reader.replicate(false)
  a.pipe(b).pipe(a)
  t.teardown(() => { a.destroy(); b.destroy() }, { force: true })
  await reader.update({ wait: true })

  const tracker = trackPresent(reader, { download: false })
  t.teardown(() => tracker.destroy(), { force: true })
  await tracker.ready
  await reader.download({ start: 0, end: tomb }).done()
  t.ok(await until(() => tracker.present() === tomb), 'fixture: the present length stops before the tombstone')

  // The tombstone's read fails, then the same step's present-length walk throws.
  const get = reader.get.bind(reader)
  const has = reader.has.bind(reader)
  let readFailed = false
  let walkFailed = false
  reader.get = async (index, opts) => {
    if (!readFailed && index === tomb && new Error().stack.includes('tombstoneTarget')) {
      readFailed = true
      throw new Error('read failed')
    }
    return get(index, opts)
  }
  reader.has = async (...args) => {
    if (readFailed && !walkFailed && new Error().stack.includes('presentLength')) {
      walkFailed = true
      throw new Error('walk failed')
    }
    return has(...args)
  }
  await get(tomb)
  t.ok(await until(() => tracker.deleted().has(target), 5000), 'the tombstone is learned on a timed retry')
  t.ok(readFailed && walkFailed, 'fixture: the read and the walk both failed once')
  t.ok(await until(async () => !(await has(target)), 5000), 'its target is cleared')
})
