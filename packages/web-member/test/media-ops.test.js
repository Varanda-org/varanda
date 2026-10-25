// The browser node's media cores and local-first follows (lib/node-store.js,
// lib/member-ops.js): a media core never stores its secret (IndexedDB
// stand-in), block 0 is the header naming the diary, items append and read
// back after a reopen (lazy 'data'), the block and core limits, mediaPrepare
// (`declared` only once the diary lists the core) and mediaCommit (SHA-256
// check, append only), descriptor
// verification before a post, a post with media read back through logRead;
// follows changed unlocked (kv follows + followsPending), drained into
// `follow` records in order, the legacy follows (from before `follow`
// records existed) published only for the keys the person confirms, the
// fold with pending ops on top, and the unchanged own-key / blocked rules.
// Follow changes need the identity key: every pending op is signed by it
// and the drain drops any op that does not verify (planted in the storage).
require('fake-indexeddb/auto')
/* global indexedDB, IDBKeyRange */
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createHash } = require('node:crypto')
const { testnet } = require('./helpers/net')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { MEDIA_BLOCK_BYTES, MAX_MEDIA_BLOCKS, followRecord } = require('@varanda/core/lib/records')
const { validateMediaHeader } = require('@varanda/core/lib/media')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { idbNodeStorage, memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

const CORE_FILES = ['oplog', 'tree', 'bitfield', 'data', 'header']

let dbCount = 0
function dbName () {
  return 'varanda-media-test-' + process.pid + '-' + (++dbCount)
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function call (file, method, ...args) {
  return new Promise((resolve, reject) => {
    file[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
  })
}

function randomKey () {
  return hex(crypto.keyPair().publicKey)
}

// An item of n bytes split in MEDIA_BLOCK_BYTES blocks, with its SHA-256.
function item (n, seed = 1) {
  const bytes = b4a.alloc(n)
  for (let i = 0; i < n; i++) bytes[i] = (i * 7 + seed) & 0xff
  const blocks = []
  for (let at = 0; at < n; at += MEDIA_BLOCK_BYTES) blocks.push(bytes.subarray(at, Math.min(n, at + MEDIA_BLOCK_BYTES)))
  return { blocks, bytes: n, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function holds (buffers, needle) {
  return buffers.some((buf) => b4a.indexOf(buf, needle) !== -1)
}

// Every byte of every file of a core as the storage holds it.
async function coreFiles (storage, name) {
  const out = []
  for (const file of CORE_FILES) {
    const f = storage.core(name)(file)
    const { size } = await call(f, 'stat')
    if (size > 0) out.push(await call(f, 'read', 0, size))
    await call(f, 'close')
  }
  return out
}

// The raw 'pages' rows of a core straight from IndexedDB.
function corePages (db, name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(db)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const conn = req.result
      const tx = conn.transaction(['pages'], 'readonly')
      const all = tx.objectStore('pages').getAll(IDBKeyRange.bound([name], [name, []]))
      all.onsuccess = () => {
        conn.close()
        resolve(all.result.map((p) => new Uint8Array(p)))
      }
      all.onerror = () => reject(all.error)
    }
  })
}

// A member with block 0 on `storage`: ctx unlocked (identity + media key
// pairs) and the same ctx locked.
async function member (storage = memoryNodeStorage()) {
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const keyPair = crypto.keyPair()
  const mediaKeyPair = crypto.keyPair()
  const ctx = { storage, association, keyPair, mediaKeyPair }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
  const locked = { storage, association, keyPair: null, mediaKeyPair: null }
  return { storage, assocKp, association, keyPair, mediaKeyPair, ownHex, ctx, locked }
}

async function commit (ctx, it, extra = {}) {
  return ops.mediaCommit(ctx, { blocks: it.blocks, mime: 'image/jpeg', width: 640, height: 480, sha256: it.sha256, ...extra })
}

// A declared and committed item -> its descriptor (the session's order:
// prepare, declare when needed, then commit).
async function ready (m, it) {
  const { core, declared } = await ops.mediaPrepare(m.ctx)
  if (!declared) await ops.declareMediaCore(m.ctx, core)
  return commit(m.ctx, it)
}

test('media core on IndexedDB: no secret stored, header names the diary, items survive a reopen', async (t) => {
  await testnet(t, 1)
  const name = dbName()
  const storage = await idbNodeStorage(name)
  const diaryHex = randomKey()
  const kp = crypto.keyPair()
  const coreHex = hex(kp.publicKey)
  const coreName = store.MEDIA_PREFIX + coreHex
  t.is(store.mediaName(coreHex), coreName)
  t.is(await store.openMediaCoreReadOnly(storage, coreHex), null, 'nothing stored yet')
  t.absent(await storage.hasCore(coreName), 'the read-only open created nothing')

  const core = await store.openMediaCore(storage, kp)
  t.is(hex(core.key), coreHex, 'compat mode: key === public key')
  t.is(await store.writeMediaHeader(core, diaryHex), 0)
  await t.exception(() => store.writeMediaHeader(core, diaryHex), /cabeçalho de mídia já gravado/)
  const a = item(MEDIA_BLOCK_BYTES * 2 + 100, 3)
  const b = item(500, 9)
  t.is(await store.appendMediaBlocks(core, a.blocks), 1, 'first item at block 1')
  t.is(await store.appendMediaBlocks(core, b.blocks), 4, 'second item right after')
  t.is(core.length, 5)
  await core.close()

  const files = await coreFiles(storage, coreName)
  t.absent(holds(files, kp.secretKey), 'no file of the media core holds the secret')
  t.absent(holds(files, kp.secretKey.subarray(0, 32)), 'nor its seed half')
  await storage.close()
  const pages = await corePages(name, coreName)
  t.ok(pages.length > 0, 'the core is in IndexedDB')
  t.absent(holds(pages, kp.secretKey.subarray(0, 32)), 'no IndexedDB page holds the secret')

  const again = await idbNodeStorage(name)
  const ro = await store.openMediaCoreReadOnly(again, coreHex)
  t.ok(ro, 'stored core opens read-only')
  t.absent(ro.writable)
  t.is(ro.length, 5, 'length survives the reopen')
  const header = JSON.parse(b4a.toString(await ro.get(0)))
  t.is(validateMediaHeader(header), null, 'block 0 is a valid media header')
  t.is(header.diary, diaryHex, 'naming the diary')
  const read = []
  for (let i = 1; i <= 3; i++) read.push(await ro.get(i))
  t.alike(b4a.concat(read), b4a.concat(a.blocks), 'item bytes read back (lazy data)')
  t.alike(await ro.get(4), b.blocks[0])
  await ro.close()

  const relocked = await store.openMediaCore(again, { publicKey: kp.publicKey })
  await t.exception(() => store.appendMediaBlocks(relocked, b.blocks), /identidade bloqueada/, 'no secret: read-only')
  await relocked.close()
  await again.close()
})

test('appendMediaBlocks: header first, block sizes, core limits', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  const kp = crypto.keyPair()
  const core = await store.openMediaCore(storage, kp)
  t.teardown(() => core.close(), { force: true })
  await t.exception(() => store.appendMediaBlocks(core, [b4a.alloc(10)]), /cabeçalho de mídia ausente/, 'no header yet')
  await store.writeMediaHeader(core, randomKey())
  await t.exception(() => store.appendMediaBlocks(core, [b4a.alloc(MEDIA_BLOCK_BYTES + 1)]), /mídia inválida/, 'oversized block')
  await t.exception(() => store.appendMediaBlocks(core, [b4a.alloc(0)]), /mídia inválida/, 'empty block')
  await t.exception(() => store.appendMediaBlocks(core, []), /mídia inválida/, 'no blocks')
  await t.exception(() => store.appendMediaBlocks(core, ['texto']), /mídia inválida/, 'not bytes')
  t.is(core.length, 1, 'nothing appended')

  const many = Array.from({ length: MAX_MEDIA_BLOCKS - 2 }, () => b4a.alloc(1))
  t.is(await store.appendMediaBlocks(core, many), 1)
  t.is(core.length, MAX_MEDIA_BLOCKS - 1)
  await t.exception(() => store.appendMediaBlocks(core, [b4a.alloc(1), b4a.alloc(1)]), /espaço de fotos deste aparelho esgotado/, 'over MAX_MEDIA_BLOCKS')
  t.is(await store.appendMediaBlocks(core, [b4a.alloc(1)]), MAX_MEDIA_BLOCKS - 1, 'the last block fits')
})

test('media kv helpers', async (t) => {
  await testnet(t, 1)
  const storage = memoryNodeStorage()
  t.is(await store.readMediaDevice(storage), null)
  const nonce = randomKey()
  await store.writeMediaDevice(storage, nonce)
  t.alike(await store.readMediaDevice(storage), { v: 1, nonce })
  t.exception.all(() => store.writeMediaDevice(storage, 'xyz'), /nonce inválido/)

  t.alike(await store.readMediaCores(storage), [])
  const keys = Array.from({ length: 10 }, () => randomKey())
  for (const k of keys) await store.addMediaCore(storage, k)
  await store.addMediaCore(storage, keys[3])
  const list = await store.readMediaCores(storage)
  t.is(list.length, 8, 'at most 8 kept')
  t.is(list[list.length - 1], keys[3], 'a re-added key moves to the end')
  t.alike(list.slice(0, 7), [keys[2], ...keys.slice(4, 10)], 'deduplicated, oldest dropped, newest last')

  const kp = crypto.keyPair()
  const core = await store.openMediaCore(storage, kp)
  await store.writeMediaHeader(core, randomKey())
  await core.close()
  await store.addMediaCore(storage, hex(kp.publicKey))
  t.ok(await storage.hasCore(store.mediaName(hex(kp.publicKey))))
  await store.deleteMediaCores(storage)
  t.absent(await storage.hasCore(store.mediaName(hex(kp.publicKey))), 'media cores deleted')
  t.alike(await store.readMediaCores(storage), [])
  t.is(await store.readMediaDevice(storage), null)

  t.alike(await store.readFollowsPending(storage), [])
  const op = { key: randomKey(), on: true, at: new Date().toISOString() }
  await store.writeFollowsPending(storage, [op, { key: 'bad', on: true, at: op.at }])
  t.alike(await store.readFollowsPending(storage), [op], 'invalid ops dropped')
})

test('mediaPrepare and mediaCommit: locked, SHA mismatch, descriptor, declared only once the diary lists the core', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const it = item(MEDIA_BLOCK_BYTES + 10)
  await t.exception(() => ops.mediaPrepare(m.locked), /identidade bloqueada/, 'prepare locked')
  await t.exception(() => ops.mediaPrepare({ ...m.ctx, mediaKeyPair: null }), /identidade bloqueada/, 'prepare without a media key pair')
  await t.exception(() => commit(m.locked, it), /identidade bloqueada/, 'locked')
  await t.exception(() => commit({ ...m.ctx, mediaKeyPair: null }, it), /identidade bloqueada/, 'no media key pair')
  await t.exception(() => commit(m.ctx, it, { sha256: item(MEDIA_BLOCK_BYTES + 10, 2).sha256 }), /mídia inválida/, 'SHA mismatch')
  await t.exception(() => commit(m.ctx, it, { mime: 'video/mp4' }), /mídia inválida/, 'unknown mime')
  await t.exception(() => ops.mediaCommit(m.ctx, { blocks: [b4a.alloc(10), b4a.alloc(10)], mime: 'image/png', width: 1, height: 1, sha256: item(20).sha256 }), /mídia inválida/, 'short block before the last')
  const coreHex = hex(m.mediaKeyPair.publicKey)
  t.absent(await m.storage.hasCore(store.mediaName(coreHex)), 'nothing stored by refused commits')

  t.alike(await ops.mediaPrepare(m.ctx), { core: coreHex, declared: false }, 'prepare: the core is not declared yet')
  t.alike(await store.readMediaCores(m.storage), [coreHex], 'recorded in kv mediaCores')
  const ro = await store.openMediaCoreReadOnly(m.storage, coreHex)
  t.is(ro.length, 1, 'prepare wrote the header and nothing else')
  await ro.close()
  t.alike(await ops.mediaPrepare(m.ctx), { core: coreHex, declared: false }, 'prepare again: idempotent')

  const first = await commit(m.ctx, it)
  t.alike(first, { core: coreHex, mime: 'image/jpeg', start: 1, blocks: 2, bytes: it.bytes, sha256: it.sha256, width: 640, height: 480 })
  const again = await commit(m.ctx, item(100, 5))
  t.is(again.start, 3)

  const { seq } = await ops.declareMediaCore(m.ctx, coreHex)
  t.is(seq, 1)
  t.alike(await ops.mediaPrepare(m.ctx), { core: coreHex, declared: true }, 'declared: no new declaration needed')
  const third = await commit(m.ctx, item(100, 6))
  t.is(third.start, 4)
  await t.exception(() => ops.declareMediaCore(m.ctx, m.ownHex), /chave inválida/, 'the diary key is never a media core')
  await t.exception(() => ops.declareMediaCore(m.locked, coreHex), /identidade bloqueada/)

  const core = await store.openMediaCoreReadOnly(m.storage, coreHex)
  const header = JSON.parse(b4a.toString(await core.get(0)))
  t.is(header.diary, m.ownHex, 'the header names the own diary')
  await core.close()
})

test('verifyMedia refuses foreign, undeclared, missing, wrong-sha and wrong-bytes descriptors', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const it = item(MEDIA_BLOCK_BYTES + 50)
  const descriptor = await commit(m.ctx, it)
  await t.exception(() => ops.verifyMedia(m.ctx, [descriptor]), /mídia inválida/, 'undeclared core')
  await ops.declareMediaCore(m.ctx, descriptor.core)
  await ops.verifyMedia(m.ctx, [descriptor])
  t.pass('a declared, local, matching descriptor verifies')

  const bad = (patch) => ops.verifyMedia(m.ctx, [{ ...descriptor, ...patch }])
  await t.exception(() => bad({ core: randomKey() }), /mídia inválida/, 'foreign core')
  await t.exception(() => bad({ core: m.ownHex }), /mídia inválida/, 'the diary key')
  await t.exception(() => bad({ start: 2 }), /mídia inválida/, 'blocks past the end')
  await t.exception(() => bad({ sha256: item(10).sha256 }), /mídia inválida/, 'wrong sha')
  await t.exception(() => bad({ bytes: descriptor.bytes - 1 }), /mídia inválida/, 'wrong byte count')
  await t.exception(() => bad({ width: 0 }), /mídia inválida/, 'invalid descriptor')
  await t.exception(() => ops.verifyMedia(m.ctx, []), /mídia inválida/, 'empty list')

  // Declared by the diary but not this device's (absent from kv mediaCores).
  const other = randomKey()
  await ops.declareMediaCore(m.ctx, other)
  await t.exception(() => bad({ core: other }), /mídia inválida/, 'declared but not an own core')
})

test('a post with media is appended and reads back through logRead', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const d1 = await ready(m, item(MEDIA_BLOCK_BYTES * 3, 1))
  const d2 = await ready(m, item(1234, 2))
  const { seq } = await ops.postCreate(m.ctx, { text: '', media: [d1, d2] })
  const reply = await ops.postReply(m.ctx, { to: { author: m.ownHex, seq }, text: 'olha', media: [d2] })
  await t.exception(() => ops.postCreate(m.ctx, { text: '', media: [{ ...d1, sha256: item(5).sha256 }] }), /mídia inválida/)
  const plain = await ops.postCreate(m.ctx, { text: 'sem foto' })

  const { entries } = await ops.logRead(m.locked, {})
  const post = entries[seq].record
  t.is(post.type, 'post')
  t.is(post.text, '')
  t.alike(post.media, [d1, d2], 'media intact')
  t.alike(entries[reply.seq].record.media, [d2])
  t.alike(entries[reply.seq].record.replyTo, { author: m.ownHex, seq })
  t.absent('media' in entries[plain.seq].record, 'no media key without media')
  t.is(entries.length, plain.seq + 1, 'the refused post appended nothing')
})

test('follows: changes need the key, update kv and a signed, coalesced pending queue; drain appends them in order', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const [a, b] = [randomKey(), randomKey()].sort()
  await t.exception(() => ops.followAdd(m.locked, a), /identidade bloqueada/, 'locked: refused')
  await t.exception(() => ops.followRemove(m.locked, a), /identidade bloqueada/, 'locked: refused')
  t.alike(await store.readFollowsPending(m.storage), [], 'nothing queued while locked')
  t.alike(await store.readFollows(m.storage), [])

  t.alike((await ops.followAdd(m.ctx, a)).follows, [a], 'unlocked: kv follows changes at once')
  await ops.followAdd(m.ctx, b)
  const removed = await ops.followRemove(m.ctx, a)
  t.alike(removed, { follows: [b], changed: true }, 'result shape unchanged')
  t.alike(await ops.followAdd(m.ctx, b), { follows: [b], changed: false }, 'no change: not queued')
  const pending = await store.readFollowsPending(m.storage)
  // One op per key: the unfollow of `a` replaced its follow, at the end.
  t.alike(pending.map(({ key, on }) => ({ key, on })), [{ key: b, on: true }, { key: a, on: false }], 'coalesced, last change last')
  for (const op of pending) {
    t.ok(/^[0-9a-f]{128}$/.test(op.sig), 'signed')
    t.ok(ops.verifyFollowOp(op, m.ownHex), 'verifies for the own key')
    t.absent(ops.verifyFollowOp(op, randomKey()), 'not for another key')
    t.absent(ops.verifyFollowOp({ ...op, on: !op.on }, m.ownHex), 'a changed field breaks it')
    t.absent(ops.verifyFollowOp({ ...op, sig: undefined }, m.ownHex), 'no sig')
  }
  const { entries: before } = await ops.ownEntries(m.locked)
  t.is(before.length, 1, 'the diary is never touched by a follow change')

  t.alike(await ops.drainFollows(m.locked), { appended: 0, seq: null }, 'locked: nothing drained')
  // kv follows [b] is covered by a pending op: no migration record for it.
  const drained = await ops.drainFollows(m.ctx)
  const { entries } = await ops.ownEntries(m.locked)
  const records = entries.slice(1).map((e) => e.record)
  t.alike(records.map(({ type, key, on }) => ({ type, key, on })), [
    { type: 'follow', key: b, on: true },
    { type: 'follow', key: a, on: false }
  ], 'the ops in order, no duplicate migration record')
  t.is(records[0].at, pending[0].at, 'the op time is kept')
  t.alike(drained, { appended: 2, seq: entries.length - 1 })
  t.absent(await store.readFollowsMigrated(m.storage), 'the drain decides nothing about legacy follows')
  t.alike(await ops.foldFollows(m.locked), { follows: [b], changed: false })
  t.alike(await store.readFollowsPending(m.storage), [], 'pending cleared')
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null }, 'nothing left')

  const c = randomKey()
  await ops.followAdd(m.ctx, c)
  const next = await ops.drainFollows(m.ctx)
  t.is(next.appended, 1, 'with follow records present, only the pending ops go')
  const last = (await ops.ownEntries(m.locked)).entries.at(-1)
  t.is(next.seq, last.seq)
  t.alike({ key: last.record.key, on: last.record.on }, { key: c, on: true })

  // Alternating changes for one key while nothing drains: one op, one record.
  await ops.followRemove(m.ctx, c)
  await ops.followAdd(m.ctx, c)
  await ops.followRemove(m.ctx, c)
  t.alike((await store.readFollowsPending(m.storage)).map(({ key, on }) => ({ key, on })), [{ key: c, on: false }], 'one pending op for the key')
  const alt = await ops.drainFollows(m.ctx)
  t.is(alt.appended, 1, 'one record')
  t.alike(await ops.foldFollows(m.locked), { follows: [b], changed: false })
})

test('follows: replayed signed ops are no-ops (copies, consumed ops, older ops, an inflated queue)', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const [a, b] = [randomKey(), randomKey()].sort()
  const before = (await ops.ownEntries(m.locked)).entries.length

  // 4097 copies of one genuine op: exactly one record.
  const at1 = '2020-01-01T10:00:00.000Z'
  const genuine = ops.signFollowOp({ key: a, on: true, at: at1 }, m.ownHex, m.keyPair)
  await m.storage.writeJson('followsPending', { v: 1, ops: Array.from({ length: MAX_INVENTORY + 1 }, () => genuine) })
  t.is((await store.readFollowsPending(m.storage)).length, MAX_INVENTORY - 1, 'the queue read is capped')
  t.alike(await ops.drainFollows(m.ctx), { appended: 1, seq: before }, 'one record for every copy together')
  let entries = (await ops.ownEntries(m.locked)).entries
  t.alike([entries.at(-1).record.key, entries.at(-1).record.on, entries.at(-1).record.at], [a, true, at1])
  t.alike(await store.readFollowsPending(m.storage), [], 'the copies left the queue')

  // A later unfollow (kv follows holds a: the planted op never touched it),
  // then the consumed follow op re-inserted: nothing is appended, the
  // unfollow stands.
  await store.writeFollows(m.storage, [a])
  t.alike(await ops.followRemove(m.ctx, a), { follows: [], changed: true })
  await ops.drainFollows(m.ctx)
  entries = (await ops.ownEntries(m.locked)).entries
  t.is(entries.length, before + 2)
  t.alike([entries.at(-1).record.key, entries.at(-1).record.on], [a, false])
  await store.writeFollowsPending(m.storage, [genuine, genuine])
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null }, 'the consumed op is a no-op')
  t.is((await ops.ownEntries(m.locked)).entries.length, before + 2, 'nothing appended')
  t.alike(await store.readFollowsPending(m.storage), [], 'and it left the queue')
  t.alike(await store.writeFoldedFollows(m.storage, [], m.ownHex), { follows: [], changed: false }, 'the unfollow stands')

  // An op older than the diary's latest record for its key is skipped; a
  // newer one for another key goes through; among several ops for one key
  // only the newest counts.
  const older = ops.signFollowOp({ key: a, on: true, at: '2020-01-01T09:00:00.000Z' }, m.ownHex, m.keyPair)
  const newerB = ops.signFollowOp({ key: b, on: true, at: '2020-01-01T12:00:00.000Z' }, m.ownHex, m.keyPair)
  const olderB = ops.signFollowOp({ key: b, on: false, at: '2020-01-01T11:00:00.000Z' }, m.ownHex, m.keyPair)
  await store.writeFollowsPending(m.storage, [older, olderB, newerB])
  t.alike(await ops.drainFollows(m.ctx), { appended: 1, seq: before + 2 }, 'only the newest op of b')
  entries = (await ops.ownEntries(m.locked)).entries
  t.alike([entries.at(-1).record.key, entries.at(-1).record.on, entries.at(-1).record.at], [b, true, '2020-01-01T12:00:00.000Z'])
  t.alike(await store.readFollowsPending(m.storage), [], 'every op left the queue')
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null })

  // Same instant as the key's latest record (b on at 12:00): the exact
  // copy is consumed, the other `on` is a real change and goes through;
  // one millisecond earlier is older and skipped whatever its `on`.
  const sameCopy = ops.signFollowOp({ key: b, on: true, at: '2020-01-01T12:00:00.000Z' }, m.ownHex, m.keyPair)
  const sameFlip = ops.signFollowOp({ key: b, on: false, at: '2020-01-01T12:00:00.000Z' }, m.ownHex, m.keyPair)
  const msEarlier = ops.signFollowOp({ key: b, on: false, at: '2020-01-01T11:59:59.999Z' }, m.ownHex, m.keyPair)
  await store.writeFollowsPending(m.storage, [sameCopy])
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null }, 'the same-instant copy is consumed')
  await store.writeFollowsPending(m.storage, [msEarlier])
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null }, 'a millisecond earlier is older: skipped')
  await store.writeFollowsPending(m.storage, [sameFlip])
  t.alike(await ops.drainFollows(m.ctx), { appended: 1, seq: before + 3 }, 'the same-instant unfollow is a real change')
  entries = (await ops.ownEntries(m.locked)).entries
  t.alike([entries.at(-1).record.key, entries.at(-1).record.on, entries.at(-1).record.at], [b, false, '2020-01-01T12:00:00.000Z'])
  await store.writeFollowsPending(m.storage, [sameFlip, sameCopy])
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null }, 'one op per key (the first of two same-instant ops), and it is the consumed unfollow')
  t.is((await ops.ownEntries(m.locked)).entries.length, before + 4)
})

test('follows: pending ops planted in the storage are dropped at drain, never appended', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const [a, b, c, d] = [randomKey(), randomKey(), randomKey(), randomKey()].sort()
  await ops.followAdd(m.ctx, a)
  await ops.drainFollows(m.ctx)
  const at = new Date().toISOString()
  const other = crypto.keyPair()
  const genuine = ops.signFollowOp({ key: d, on: true, at }, m.ownHex, m.keyPair)
  const planted = [
    { key: b, on: true, at }, // no signature (an older build, or DevTools)
    { key: c, on: true, at, sig: 'ab'.repeat(64) }, // a bad signature
    ops.signFollowOp({ key: a, on: false, at }, m.ownHex, other), // signed by another key
    { ...ops.signFollowOp({ key: b, on: false, at }, hex(other.publicKey), other) }, // for another diary
    genuine
  ]
  await store.writeFollowsPending(m.storage, planted)
  t.is((await store.readFollowsPending(m.storage)).length, 5, 'the shapes pass the kv helper')
  const before = (await ops.ownEntries(m.locked)).entries.length

  const r = await ops.drainFollows(m.ctx)
  t.alike(r, { appended: 1, seq: before }, 'only the genuine op was appended')
  const { entries } = await ops.ownEntries(m.locked)
  const last = entries.at(-1).record
  t.alike([last.type, last.key, last.on, last.at], ['follow', d, true, at])
  t.alike(await store.readFollowsPending(m.storage), [], 'every planted op left the queue')
  t.alike(await ops.foldFollows(m.locked), { follows: [a], changed: false }, 'kv follows kept (no legacy decision yet): a still followed, the planted unfollow never happened')
  await ops.confirmLegacyFollows(m.ctx, [])
  t.alike(await ops.foldFollows(m.locked), { follows: [a, d], changed: true }, 'decided: the diary replays to a and d')
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null }, 'nothing left')
})

test('follows: legacy kv follows are published only for the keys the person confirms', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const [a, b, c, d] = [randomKey(), randomKey(), randomKey(), randomKey()].sort()
  // The device kept a, b, c, d from before `follow` records existed.
  await store.writeFollows(m.storage, [a, b, c, d])
  await t.exception(() => ops.legacyFollows(m.locked), /identidade bloqueada/, 'locked')
  await t.exception(() => ops.confirmLegacyFollows(m.locked, [a]), /identidade bloqueada/, 'locked')
  t.alike(await ops.legacyFollows(m.ctx), { keys: [a, b, c, d] }, 'every unmentioned key, sorted')

  // The drain publishes nothing of it on its own.
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null }, 'no automatic migration')
  t.is((await ops.ownEntries(m.locked)).entries.length, 1)
  t.absent(await store.readFollowsMigrated(m.storage), 'no marker from the drain')

  // Confirming a and c (plus an unknown key, ignored): signed ops queued,
  // b and d leave kv follows, the marker is set.
  t.alike(await ops.confirmLegacyFollows(m.ctx, [c, a, randomKey()]), { published: 2 })
  const pending = await store.readFollowsPending(m.storage)
  t.alike(pending.map(({ key, on }) => ({ key, on })), [{ key: a, on: true }, { key: c, on: true }], 'one signed op per confirmed key')
  t.ok(pending.every((op) => ops.verifyFollowOp(op, m.ownHex)), 'signed for the own key')
  t.alike(await store.readFollows(m.storage), [a, c], 'the unconfirmed keys are gone')
  t.ok(await store.readFollowsMigrated(m.storage), 'marker set')
  t.alike(await ops.legacyFollows(m.ctx), { keys: [] }, 'nothing left to confirm')
  t.alike(await ops.confirmLegacyFollows(m.ctx, [b]), { published: 0 }, 'a second confirmation publishes nothing')

  const r = await ops.drainFollows(m.ctx)
  t.is(r.appended, 2)
  const { entries } = await ops.ownEntries(m.locked)
  t.alike(entries.slice(1).map((e) => [e.record.key, e.record.on]), [[a, true], [c, true]], 'exactly the confirmed keys reach the diary')
  t.alike(await ops.foldFollows(m.locked), { follows: [a, c], changed: false }, 'folds apply afterwards')

  // Deleting the marker republishes nothing by itself: a and c are in the
  // diary, so the legacy set is empty; a planted key shows up for the
  // person to decide, never in the diary.
  await store.clearFollowsMigrated(m.storage)
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null }, 'nothing appended without a confirmation')
  const planted = randomKey()
  await store.writeFollows(m.storage, [a, c, planted])
  t.alike(await ops.legacyFollows(m.ctx), { keys: [planted] }, 'the planted key awaits a decision')
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null })
  t.alike(await ops.confirmLegacyFollows(m.ctx, []), { published: 0 }, 'declined')
  t.alike(await store.readFollows(m.storage), [a, c], 'and dropped from kv follows')
  t.is((await ops.ownEntries(m.locked)).entries.length, 3, 'the diary never saw it')

  // No block 0: refused, nothing done.
  const fresh = memoryNodeStorage()
  const ctx = { storage: fresh, association: m.association, keyPair: crypto.keyPair(), mediaKeyPair: null }
  await ops.idCreate(ctx)
  await store.writeFollows(fresh, [randomKey()])
  await t.exception(() => ops.legacyFollows(ctx), /grave o certificado de membro antes de publicar/, 'block 0 required')
  await t.exception(() => ops.confirmLegacyFollows(ctx, []), /grave o certificado de membro antes de publicar/)
  t.absent(await store.readFollowsMigrated(fresh))
  t.alike(await ops.drainFollows(ctx), { appended: 0, seq: null }, 'the drain does nothing without block 0')
})

test('follows: fold derives the set and keeps pending ops on top', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const [a, b, c] = [randomKey(), randomKey(), randomKey()].sort()
  t.alike(await ops.foldFollows(m.locked), { follows: [], changed: false }, 'no follow records: kv kept')

  // Follow records written elsewhere (another device): a on, b on.
  const diary = await store.openDiary(m.storage, m.keyPair)
  await store.appendRecord(diary, followRecord({ key: a, on: true, at: '2020-01-01T00:00:00.000Z' }))
  await store.appendRecord(diary, followRecord({ key: b, on: true, at: '2020-01-01T00:00:00.000Z' }))
  await store.appendRecord(diary, followRecord({ key: m.ownHex, on: true, at: '2020-01-01T00:00:00.000Z' }))
  await diary.close()

  t.absent(await store.readFollowsMigrated(m.storage))
  t.alike(await ops.foldFollows(m.locked), { follows: [a, b], changed: true }, 'fresh device (empty kv) folds at once, own key dropped')
  t.alike(await store.readFollows(m.storage), [a, b])
  t.alike(await ops.foldFollows(m.locked), { follows: [a, b], changed: false }, 'unchanged: not rewritten')

  await ops.followRemove(m.ctx, a)
  await ops.followAdd(m.ctx, c)
  t.alike(await ops.foldFollows(m.locked), { follows: [b, c], changed: false }, 'migrated by the first fold: the pending ops on top of the records')
  await ops.drainFollows(m.ctx)
  t.ok(await store.readFollowsMigrated(m.storage), 'migrated')
  await ops.followRemove(m.ctx, b)
  t.alike(await store.writeFoldedFollows(m.storage, [b, c], m.ownHex), { follows: [c], changed: false }, 'pending ops win over the records')
  await ops.drainFollows(m.ctx)
  t.alike(await ops.foldFollows(m.locked), { follows: [c], changed: false }, 'same set once drained')

  t.alike(await store.writeFoldedFollows(m.storage, [a, m.ownHex, 'zz'], m.ownHex), { follows: [a], changed: true }, 'own and invalid keys dropped')
  await store.clearFollowsMigrated(m.storage)
  t.absent(await store.readFollowsMigrated(m.storage), 'marker cleared')
})

test('follows: a second device lists only the legacy keys the diary never mentioned and no pending op covers', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const [w, x, y, z] = [randomKey(), randomKey(), randomKey(), randomKey()].sort()
  // Device A already published: X on, Y off.
  const diary = await store.openDiary(m.storage, m.keyPair)
  await store.appendRecord(diary, followRecord({ key: x, on: true, at: '2020-01-01T00:00:00.000Z' }))
  await store.appendRecord(diary, followRecord({ key: y, on: false, at: '2020-01-01T00:00:00.000Z' }))
  await diary.close()
  // Device B (this storage) had W, X, Y, Z locally before the upgrade, and
  // follows W now (a signed pending op covers it).
  await store.writeFollows(m.storage, [x, y, z])
  await ops.followAdd(m.ctx, w)
  t.alike(await ops.foldFollows(m.locked), { follows: [w, x, y, z], changed: false }, 'fold blocked before the decision')
  t.alike(await store.writeFoldedFollows(m.storage, [x], m.ownHex), { follows: [w, x, y, z], changed: false }, 'the sync fold too')
  t.alike(await ops.legacyFollows(m.ctx), { keys: [z] }, 'only Z: X and Y are the diary\'s, W is pending')

  t.alike(await ops.confirmLegacyFollows(m.ctx, [z, x, y]), { published: 1 }, 'X and Y are not legacy: ignored')
  const r = await ops.drainFollows(m.ctx)
  t.is(r.appended, 2, 'W (the change) and Z (confirmed)')
  const records = (await ops.ownEntries(m.locked)).entries.slice(3).map((e) => [e.record.key, e.record.on])
  t.alike(records, [[w, true], [z, true]])
  t.ok(await store.readFollowsMigrated(m.storage), 'marker set')
  t.alike(await ops.foldFollows(m.locked), { follows: [w, x, z], changed: true }, 'fold allowed after: Y stays off')
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null })
})

test('follows: a drain cut short keeps the rest pending', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const keys = [randomKey(), randomKey(), randomKey(), randomKey()].sort()
  await store.writeFollows(m.storage, keys)
  t.alike(await ops.confirmLegacyFollows(m.ctx, keys), { published: 4 })
  t.is((await store.readFollowsPending(m.storage)).length, 4)
  // Block 0 + 2 records fit, the third append fails.
  await t.exception(() => ops.drainFollows({ ...m.ctx, limits: { maxLogBlocks: 3 } }), /limite do diário atingido/)
  t.is((await store.readFollowsPending(m.storage)).length, 4, 'nothing removed from the queue after a part-way failure')
  t.is((await ops.ownEntries(m.locked)).entries.length, 3, 'two records made it')
})

test('follows: a fresh device keeps applying the diary after its first fold', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const [a, b] = [randomKey(), randomKey()].sort()
  t.absent(await store.readFollowsMigrated(m.storage))
  t.alike(await store.writeFoldedFollows(m.storage, [a], m.ownHex), { follows: [a], changed: true }, 'fresh device imports A')
  t.ok(await store.readFollowsMigrated(m.storage), 'and counts as migrated')
  t.alike(await store.writeFoldedFollows(m.storage, [b], m.ownHex), { follows: [b], changed: true }, 'A unfollowed, B followed elsewhere: applied')
  t.alike(await store.readFollows(m.storage), [b])

  // Empty kv but a pending op: folds, but the drain sets the marker.
  const p = await member()
  await ops.followAdd(p.ctx, a)
  await ops.followRemove(p.ctx, a)
  t.alike(await store.writeFoldedFollows(p.storage, [b], p.ownHex), { follows: [b], changed: true })
  t.absent(await store.readFollowsMigrated(p.storage), 'pending ops: no marker from the fold')

  // Local follows and no marker: blocked until the person decides.
  const l = await member()
  await store.writeFollows(l.storage, [a])
  t.alike(await store.writeFoldedFollows(l.storage, [b], l.ownHex), { follows: [a], changed: false }, 'blocked')
  t.absent(await store.readFollowsMigrated(l.storage))
  await ops.drainFollows(l.ctx)
  t.absent(await store.readFollowsMigrated(l.storage), 'the drain decides nothing')
  await ops.confirmLegacyFollows(l.ctx, [a])
  await ops.drainFollows(l.ctx)
  t.alike(await store.writeFoldedFollows(l.storage, [a, b], l.ownHex), { follows: [a, b], changed: true }, 'allowed after the confirmation')
})

test('follows: nothing legacy to confirm sets the marker without publishing', async (t) => {
  await testnet(t, 1)
  const m = await member()
  t.alike(await ops.drainFollows(m.ctx), { appended: 0, seq: null })
  t.absent(await store.readFollowsMigrated(m.storage), 'the drain never sets the marker')
  t.alike(await ops.legacyFollows(m.ctx), { keys: [] })
  t.ok(await store.readFollowsMigrated(m.storage), 'an empty legacy set: the listing itself sets the marker (nothing to decide)')
  t.alike(await ops.confirmLegacyFollows(m.ctx, []), { published: 0 })
  t.is((await ops.ownEntries(m.locked)).entries.length, 1, 'nothing appended')

  // Device B of the two-device case: kv follows [X] and the diary already
  // holds `follow X on` (folded from device A), marker unset. Nothing to
  // decide: legacyFollows marks the device, and a later fold applies (X
  // turned off on device A drops X here).
  const b = await member()
  const x = randomKey()
  const diary = await store.openDiary(b.storage, b.keyPair)
  await store.appendRecord(diary, followRecord({ key: x, on: true, at: '2020-01-01T00:00:00.000Z' }))
  await diary.close()
  await store.writeFollows(b.storage, [x])
  t.alike(await store.writeFoldedFollows(b.storage, [], b.ownHex), { follows: [x], changed: false }, 'fold blocked while undecided')
  t.alike(await ops.legacyFollows(b.ctx), { keys: [] }, 'X is the diary\'s: nothing legacy')
  t.ok(await store.readFollowsMigrated(b.storage), 'marker set by the empty listing')
  t.is((await ops.ownEntries(b.locked)).entries.length, 2, 'nothing published')
  t.alike(await store.writeFoldedFollows(b.storage, [], b.ownHex), { follows: [], changed: true }, 'the fold applies now: X off elsewhere drops X')
  t.alike(await store.readFollows(b.storage), [])
  await t.exception(() => ops.legacyFollows(b.locked), /identidade bloqueada/, 'still needs the key')
})

// A storage whose kv writes of `key` fail while `fail.on` is set.
function failingKv (storage, key) {
  const fail = { on: false }
  const writeJson = storage.writeJson
  storage.writeJson = async (k, v) => {
    if (fail.on && k === key) throw new Error('armazenamento do navegador (IndexedDB) falhou ao gravar ' + k)
    return writeJson.call(storage, k, v)
  }
  return fail
}

test('follows: a failed pending write loses no change, the retry queues it', async (t) => {
  await testnet(t, 1)
  const m = await member()
  const a = randomKey()
  await ops.followAdd(m.ctx, a)
  await ops.drainFollows(m.ctx)
  t.alike(await store.readFollowsPending(m.storage), [])

  const pendingFails = failingKv(m.storage, 'followsPending')
  pendingFails.on = true
  await t.exception(() => ops.followRemove(m.ctx, a), /falhou ao gravar followsPending/)
  t.alike(await store.readFollows(m.storage), [a], 'nothing changed')
  pendingFails.on = false
  t.alike(await ops.followRemove(m.ctx, a), { follows: [], changed: true }, 'the retry makes the change')
  t.alike((await store.readFollowsPending(m.storage)).map(({ key, on }) => ({ key, on })), [{ key: a, on: false }], 'and queues it')
  t.alike(await ops.foldFollows(m.locked), { follows: [], changed: false }, 'the fold keeps the unfollow')

  // The follows write fails after the op was queued: the op stays queued.
  const followsFails = failingKv(m.storage, 'follows')
  followsFails.on = true
  await t.exception(() => ops.followAdd(m.ctx, a), /falhou ao gravar follows/)
  followsFails.on = false
  t.alike(await store.readFollows(m.storage), [], 'kv follows unchanged')
  t.alike((await store.readFollowsPending(m.storage)).at(-1).on, true, 'the op is queued')
  t.alike(await ops.foldFollows(m.locked), { follows: [a], changed: true }, 'the fold makes kv right')
  await ops.drainFollows(m.ctx)
  t.alike(await ops.foldFollows(m.locked), { follows: [a], changed: false }, 'and the diary agrees once drained')
})

test('follows: own key and blocked author rules unchanged', async (t) => {
  await testnet(t, 1)
  const m = await member()
  await t.exception(() => ops.followAdd(m.ctx, m.ownHex), /não é possível seguir a própria chave/)
  const blocked = randomKey()
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, m.assocKp)
  await store.writeBlocklist(m.storage, createSnapshot({ seq: 1, blocked: [blocked] }, modKp, modCert))
  await t.exception(() => ops.followAdd(m.ctx, blocked), /autor bloqueado/)
  t.alike(await store.readFollowsPending(m.storage), [], 'refused changes are not queued')
  t.alike(await store.readFollows(m.storage), [])
})
