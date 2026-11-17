'use strict'

// The automatic history copy between devices of one passkey (lib/dm-copy.js)
// over an in-memory dm pool and blob route: one claim wins when two old
// devices race, an interrupted job resumes from the record, and a photo batch
// is applied only by the device its claim names. Real stores, seals and
// signatures; no network.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const dmCore = require('@varanda/core/lib/dm')
const coreBlob = require('@varanda/core/lib/blob')
const postage = require('@varanda/core/lib/dm-postage')
const { UsageError } = require('@varanda/core/lib/errors')
const sodium = require('../lib/sodium-browser')
const { createDmCopy, batchIdOf } = require('../lib/dm-copy')
const { createDmStore } = require('../lib/dm-store')
const { memoryNodeStorage } = require('../lib/node-storage')
const { fetchBlob, sealBlob } = require('../lib/blob')
const store = require('../lib/node-store')
const { png } = require('./helpers/dm-e2e')

const PEER = 'b'.repeat(64)
const AT = '2026-11-03T12:00:00.000Z'
const ORIGIN = 'http://127.0.0.1:9'
const FETCH_LIMITS = { getBurst: 1000, getPaceMs: 0, getRetries: 0, getTimeoutMs: 5000 }
const MEDIA_KEYS = ['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms']

const hex = (b) => b4a.toString(b, 'hex')
const devId = (c) => c.repeat(64)
const noop = () => {}

function mediaItem (d) {
  const o = {}
  for (const k of MEDIA_KEYS) o[k] = d[k]
  return o
}

// The account: its identity, its box, the shared dm pool and blob route.
function account () {
  const keyPair = crypto.keyPair()
  const boxPub = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const boxSec = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_keypair(boxPub, boxSec)
  const w = { keyPair, own: hex(keyPair.publicKey), box: { publicKey: boxPub, secretKey: boxSec }, pool: [], blobs: new Map() }
  // Every own drop in the pool, opened: { seq, kind, body }.
  w.drops = () => w.pool.map((p) => {
    const inner = dmCore.openSealed(p.bytes, w.box)
    const body = inner === null ? null : dmCore.openInner(inner, w.own)
    return { seq: p.seq, body }
  }).filter((d) => d.body !== null)
  w.claims = () => w.drops().filter((d) => d.body.kind === dmCore.DM_CLAIM_KIND)
  w.pointers = () => w.drops().filter((d) => d.body.kind === 'copy')
  return w
}

// The frames of a sealed blob under made-up stamps (fetchBlob never checks
// a stamp), as the seeder's /blob route would serve them.
function framesOf (sealed) {
  const d = sealed.descriptor
  const frames = []
  for (let i = 0; i < d.chunks; i++) {
    frames.push(coreBlob.encodeChunk({
      id: sealed.id,
      index: i,
      count: d.chunks,
      kid: b4a.alloc(8, 1),
      sig: postage.bigToBytes(5n),
      token: b4a.alloc(32, 2),
      bytes: sealed.cipher.subarray(i * coreBlob.BLOB_CHUNK_BYTES, Math.min(d.bytes, (i + 1) * coreBlob.BLOB_CHUNK_BYTES))
    }))
  }
  return frames
}

function reply (status, body) {
  return {
    status,
    redirected: false,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(body.byteLength) : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  }
}

// A device of the account with its own storage and dm store.
async function device (t, w, self, { storage = memoryNodeStorage(), photoBatch } = {}) {
  const local = createDmStore({ storage })
  await local.unlock(b4a.alloc(32, self.charCodeAt(0)))
  await local.loaded()
  t.teardown(() => local.close(), { force: true })
  const d = { self, storage, local, gen: 1, unlocked: true, cursor: 0, events: [], logs: [], gets: 0, puts: 0, onPut: null, copy: null }
  const stamps = async (n) => Array.from({ length: n }, () => ({}))
  d.env = {
    storage,
    local,
    personal: { local, prefix: '', page: null },
    pages: { pages: () => [], get: () => null },
    pageCtx: async () => { throw new Error('sem página') },
    blobs: {
      copySource: () => ({ chunk: 256, reserve: stamps, take: stamps }),
      stamp: async (sealed, kp, source) => { if (source) await source.take(1) },
      put: async (sealed) => {
        d.puts++
        if (d.onPut !== null) await d.onPut(d.puts)
        w.blobs.set(sealed.descriptor.id, framesOf(sealed))
      }
    },
    blobOrigin: ORIGIN,
    fetchImpl: async (url) => {
      d.gets++
      const [id, index] = url.slice(ORIGIN.length + '/blob/'.length).split('/')
      const frames = w.blobs.get(id)
      if (frames === undefined) return reply(404, new Uint8Array(0))
      return reply(200, frames[Number(index)])
    },
    fetchLimits: FETCH_LIMITS,
    linkOpts: {},
    openDmLink: async () => ({
      put: async (bytes) => {
        w.pool.push({ seq: w.pool.length + 1, bytes })
        return { ok: true, reason: null }
      },
      close: noop
    }),
    takeStamps: stamps,
    topUpDm: async () => {},
    dropOf: (sealed) => sealed,
    boxHex: () => ({ box: hex(w.box.publicKey), gen: 1 }),
    generation: () => d.gen,
    unlocked: () => d.unlocked,
    requireUnlocked: noop,
    emit: (name, data) => d.events.push([name, data]),
    log: (m) => d.logs.push(m),
    mediaItem,
    refusal: (reason) => new UsageError(reason),
    unconfirmed: () => new UsageError('incerto'),
    folded: async () => { throw new Error('sem conversas') },
    moderation: async () => ({ blocked: new Set(), association: new Set() }),
    openMedia: async () => null,
    // As the engine's: the photo's blobs fetched and cached under (from, id).
    openCopied: async (m) => {
      const plains = []
      for (const item of m.media) {
        const { id, key, nonce, chunks, bytes, sha256 } = item
        plains.push((await fetchBlob({ id, key, nonce, chunks, bytes, sha256 }, ORIGIN, { mime: item.mime, fetch: d.env.fetchImpl, limits: FETCH_LIMITS })).bytes)
      }
      await local.putMedia(m.from, m.id, plains)
    },
    pull: () => d.pull(),
    pullComplete: () => true,
    photoBatch
  }
  // What the engine's pull hands the copy module: the claims and pointers
  // past this device's cursor, in pool order.
  d.pull = async () => {
    const pointers = []
    const claims = []
    for (const { seq, body } of w.drops()) {
      if (seq <= d.cursor) continue
      if (body.kind === 'copy') pointers.push({ id: body.id, copy: body.copy })
      if (body.kind === dmCore.DM_CLAIM_KIND) claims.push({ id: body.id, copy: body.copy, for: body.for, by: body.by, at: body.at, seq })
    }
    d.cursor = w.pool.length
    await d.copy.note(pointers, claims)
  }
  // A new app open on the same storage: a fresh module, nothing in memory.
  d.reopen = () => {
    d.gen++
    d.copy = createDmCopy(d.env)
    return d.copy
  }
  d.copy = createDmCopy(d.env)
  d.record = async () => local.open(await store.readDmAutoCopy(storage))
  return d
}

// n own messages, each with one cached photo, filed one ms apart.
function photoRows (w, n, base = 1700000000000) {
  return Array.from({ length: n }, (_, i) => {
    const plain = png(200 + i)
    const desc = sealBlob(plain).descriptor
    const row = { t: 'msg', id: String(i + 1).padStart(32, '0'), peer: PEER, from: w.own, text: 'foto ' + (i + 1), replyTo: null, fwd: 0, media: [mediaItem({ ...desc, mime: 'image/png', w: 64, h: 48, ms: 0 })], card: null, at: AT, mine: true, filedAt: base + i }
    return { row, plain }
  })
}

function textRows (w, n, base = 1700000000000) {
  return Array.from({ length: n }, (_, i) => ({
    row: { t: 'msg', id: String(i + 1).padStart(32, '0'), peer: PEER, from: w.own, text: 'oi ' + (i + 1), replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: true, filedAt: base + i },
    plain: null
  }))
}

// A device holding `rows`, with the photo of each that has one cached.
async function holding (t, w, self, rows, opts) {
  const d = await device(t, w, self, opts)
  await d.local.append(rows.map((r) => r.row))
  for (const r of rows) if (r.plain !== null) await d.local.putMedia(r.row.from, r.row.id, [r.plain])
  return d
}

const A = devId('a')
const B = devId('c')
const C = devId('d')
const D = devId('e')

// The receiver side of a pull: the pointers noted, then the import.
async function receive (w, d) {
  await d.pull()
  await d.copy.importAll(w.own)
}

test('two old devices kick at once: exactly one claim wins and one text copy goes', async (t) => {
  const w = account()
  const rows = textRows(w, 3)
  const a = await holding(t, w, A, rows)
  const b = await holding(t, w, B, rows)
  const view = (self) => ({ self, off: false, targets: [C] })
  await Promise.all([a.copy.autoCopy(w.own, w.keyPair, view(A)), b.copy.autoCopy(w.own, w.keyPair, view(B))])
  t.is(w.claims().length, 2, 'both claimed')
  const pointers = w.pointers()
  t.is(pointers.length, 1, 'one text copy for the new device')
  const first = w.claims()[0].body
  t.is(pointers[0].body.id, first.copy, 'made by the claim first in the pool')
  t.alike(a.logs.concat(b.logs), [], 'the loser stepped back without a failure')
  // A later kick claims nothing more: the winner's claim covers the target.
  await Promise.all([a.copy.autoCopy(w.own, w.keyPair, view(A)), b.copy.autoCopy(w.own, w.keyPair, view(B))])
  t.is(w.claims().length, 2, 'no claim after the copy went')
  t.is(w.pointers().length, 1, 'and no second copy')
})

test('a lock in the text stage: the next open goes on from the record, with no second claim', async (t) => {
  const w = account()
  const rows = textRows(w, 3)
  const a = await holding(t, w, A, rows)
  // The part goes, the manifest's put meets a lock.
  a.onPut = async (n) => {
    if (n === 2) {
      a.gen++
      throw new UsageError('trancado')
    }
  }
  const view = { self: A, off: false, targets: [C] }
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is(w.claims().length, 1, 'the claim went')
  t.is(w.pointers().length, 0, 'the text pointer did not')
  const rec = await a.record()
  t.is(rec.job.stage, 'text', 'the job waits in the record at its text stage')
  t.alike(a.logs, [], 'a lock is no failure to warn about')

  a.onPut = null
  a.reopen()
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is(w.claims().length, 1, 'the resumed job put no second claim')
  t.is(w.pointers().length, 1, 'and one text pointer')
  t.is(w.pointers()[0].body.id, rec.job.copy, 'carrying the claim\'s copy id')
  t.is((await a.record()).job, null, 'the job ended')

  const c = await device(t, w, C)
  c.copy.setDevice({ self: C, off: false })
  await receive(w, c)
  t.is(c.local.snapshot().messages.length, 3, 'the new device imported the messages')
  t.ok(c.events.some(([name]) => name === 'dm.copyImported'), 'with its notice')
})

test('a lock in the photo stage: the next open sends the rest from the cursor, no batch twice', async (t) => {
  const w = account()
  const rows = photoRows(w, 3)
  // One photo per batch.
  const a = await holding(t, w, A, rows, { photoBatch: { bytes: 1, total: 1048576 } })
  // Puts: the part (1), the manifest (2), photo 3 (3), its batch (4), photo 2 (5).
  a.onPut = async (n) => {
    if (n === 5) {
      a.gen++
      throw new UsageError('trancado')
    }
  }
  const view = { self: A, off: false, targets: [C] }
  await a.copy.autoCopy(w.own, w.keyPair, view)
  const rec = await a.record()
  t.is(rec.job.stage, 'photos', 'the job waits at its photo stage')
  t.is(rec.job.batches, 1, 'one batch went')
  t.is(rec.job.cursor, rows[2].row.filedAt, 'the cursor stands at the newest photo, sent first')
  t.is(w.pointers().length, 2, 'the text pointer and one batch pointer')

  a.onPut = null
  a.reopen()
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is((await a.record()).job, null, 'the job ended')
  t.is(w.claims().length, 1, 'one claim in all')
  const ids = w.pointers().map((p) => p.body.id)
  const copyId = rec.job.copy
  t.alike(ids, [copyId, batchIdOf(copyId, 0), batchIdOf(copyId, 1), batchIdOf(copyId, 2)], 'the text, then three batches, none twice')

  const c = await device(t, w, C)
  c.copy.setDevice({ self: C, off: false })
  await receive(w, c)
  t.is(c.local.snapshot().messages.length, 3, 'the new device imported the messages')
  for (const r of rows) t.ok(c.local.hasMedia(r.row.from, r.row.id), 'and every photo is cached there')
  const imported = c.events.filter(([name]) => name === 'dm.copyImported')
  t.is(imported.length, 1, 'one notice, for the text')
  t.ok(c.events.some(([name, data]) => name === 'dm.changed' && data.added === 0), 'the photos show as a change')
})

test('a photo batch is applied only by the device its claim names', async (t) => {
  const w = account()
  const rows = photoRows(w, 2)
  const a = await holding(t, w, A, rows)
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  t.is(w.pointers().length, 2, 'the text and one photo batch')

  // B already holds the messages (an old device) without their photos.
  const b = await holding(t, w, B, rows.map((r) => ({ row: r.row, plain: null })))
  b.copy.setDevice({ self: B, off: false })
  await receive(w, b)
  t.is(b.gets, 0, 'a device the claim does not name fetches nothing')
  for (const r of rows) t.absent(b.local.hasMedia(r.row.from, r.row.id), 'and caches no photo')
  t.absent(b.events.some(([name]) => name === 'dm.changed' || name === 'dm.copyImported'), 'nothing changed there')

  const c = await device(t, w, C)
  c.copy.setDevice({ self: C, off: false })
  await receive(w, c)
  t.ok(c.gets > 0, 'the target fetched the copy')
  for (const r of rows) t.ok(c.local.hasMedia(r.row.from, r.row.id), 'and cached every photo')
})

test('a disconnected device imports nothing, and one not told who it is waits', async (t) => {
  const w = account()
  const rows = textRows(w, 2)
  const a = await holding(t, w, A, rows)
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C, D] })
  t.is(w.pointers().length, 1, 'one copy for both new devices')

  const off = await device(t, w, D)
  off.copy.setDevice({ self: D, off: true })
  await receive(w, off)
  t.is(off.gets, 0, 'the device that is off fetches nothing')
  t.is(off.local.snapshot().messages.length, 0, 'and files nothing')

  const c = await device(t, w, C)
  await receive(w, c)
  t.is(c.gets, 0, 'before the session says which device it is, the claimed copy waits')
  c.copy.setDevice({ self: C, off: false })
  await c.copy.importAll(w.own)
  t.is(c.local.snapshot().messages.length, 2, 'then it imports')
})

test('an off copier claims nothing, and a target that left the view ends the job', async (t) => {
  const w = account()
  const rows = textRows(w, 2)
  const a = await holding(t, w, A, rows)
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: true, targets: [C] })
  t.is(w.claims().length, 0, 'a device that is off makes no copy')
  // The copy is cut at its manifest; meanwhile C is turned off.
  a.onPut = async (n) => {
    if (n === 2) {
      a.gen++
      throw new UsageError('trancado')
    }
  }
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  t.ok((await a.record()).job !== null, 'the job waits')
  a.onPut = null
  a.reopen()
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [] })
  t.is((await a.record()).job, null, 'the job for a device turned off is dropped')
  t.is(w.pointers().length, 0, 'and no copy goes')
})

test('a pull that brings the text pointer with many photo batches still imports the text', async (t) => {
  const w = account()
  const rows = photoRows(w, 10)
  // One photo per batch: the text pointer and ten batch pointers in the pool.
  const a = await holding(t, w, A, rows, { photoBatch: { bytes: 1, total: 1048576 } })
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  t.is(w.pointers().length, 11, 'the text pointer and ten batch pointers')

  const c = await device(t, w, C)
  c.copy.setDevice({ self: C, off: false })
  await receive(w, c)
  t.is(c.local.snapshot().messages.length, 10, 'the text came in with all its batches noted in one pull')
  for (const r of rows) t.ok(c.local.hasMedia(r.row.from, r.row.id), 'and every photo is cached')
})

test('a photo batch waits while the text of its copy has not imported yet', async (t) => {
  const w = account()
  const rows = photoRows(w, 2)
  const a = await holding(t, w, A, rows)
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  t.is(w.pointers().length, 2, 'the text and one photo batch')

  // The text part is gone for a moment (a seeder restarting): the text todo
  // fails soft and stays.
  const [partId, partFrames] = [...w.blobs.entries()][0]
  w.blobs.delete(partId)
  const c = await device(t, w, C)
  c.copy.setDevice({ self: C, off: false })
  await receive(w, c)
  t.is(c.local.snapshot().messages.length, 0, 'no text yet')
  for (const r of rows) t.absent(c.local.hasMedia(r.row.from, r.row.id), 'and no photo')
  const waiting = c.local.open(await store.readDmCopy(c.storage)).todo.map((x) => x.id)
  t.is(waiting.length, 2, 'the batch waits next to its text')

  w.blobs.set(partId, partFrames)
  await c.copy.importAll(w.own)
  t.is(c.local.snapshot().messages.length, 2, 'the text imported')
  for (const r of rows) t.ok(c.local.hasMedia(r.row.from, r.row.id), 'then the batch filled every photo')
})

test('a seeder that keeps refusing the photos ends the job after three kicks, not the weekly allowance', async (t) => {
  const w = account()
  const rows = photoRows(w, 3)
  const a = await holding(t, w, A, rows, { photoBatch: { bytes: 1, total: 1048576 } })
  // The text goes (puts 1 and 2); every photo blob after it is refused.
  a.onPut = async (n) => {
    if (n >= 3) throw new Error('recusado')
  }
  const view = { self: A, off: false, targets: [C] }
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is(w.pointers().length, 1, 'the text pointer went')
  t.is((await a.record()).job.fails, 1, 'the failed kick is counted')
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.ok((await a.record()).job !== null, 'two failures keep the job')
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is((await a.record()).job, null, 'the third ends it')
  const puts = a.puts
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is(a.puts, puts, 'a later kick seals and pays nothing more')
  t.is(w.claims().length, 1, 'and puts no claim: the text reached the target')
})

test('a target disconnected while the text is sealed: the text pointer never goes', async (t) => {
  const w = account()
  const a = await holding(t, w, A, textRows(w, 2))
  a.onPut = async (n) => {
    if (n === 1) a.copy.setDevice({ self: A, off: false, targets: [] })
  }
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  t.is(w.claims().length, 1, 'the claim went')
  t.is(w.pointers().length, 0, 'no text pointer')
  t.is((await a.record()).job, null, 'the job ended')
  t.alike(a.logs, [], 'with no failure')
})

test('this device turned off while the text is sealed: the text pointer never goes', async (t) => {
  const w = account()
  const a = await holding(t, w, A, textRows(w, 2))
  // A device view without targets, as device.hello gives it.
  a.onPut = async (n) => {
    if (n === 1) a.copy.setDevice({ self: A, off: true })
  }
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  t.is(w.claims().length, 1, 'the claim went')
  t.is(w.pointers().length, 0, 'no text pointer')
  t.is((await a.record()).job, null, 'the job ended')
  t.alike(a.logs, [], 'with no failure')
})

test('a target disconnected in the photo stage: no batch goes and nothing more is sealed', async (t) => {
  const w = account()
  const a = await holding(t, w, A, photoRows(w, 3), { photoBatch: { bytes: 1, total: 1048576 } })
  // Puts: the part (1), the manifest (2), the newest photo (3).
  a.onPut = async (n) => {
    if (n === 3) a.copy.setDevice({ self: A, off: false, targets: [] })
  }
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  t.is(w.pointers().length, 1, 'only the text pointer')
  t.is(a.puts, 3, 'no blob after the photo in flight, not even its batch manifest')
  t.is((await a.record()).job, null, 'the job ended')
  t.alike(a.logs, [], 'with no failure')
})

const stampsOf = async (n) => Array.from({ length: n }, () => ({}))

// A lock that meets put `at` of device `d`.
function lockAt (d, at) {
  d.onPut = async (n) => {
    if (n === at) {
      d.gen++
      throw new UsageError('trancado')
    }
  }
}

test('a copy stamp purchase that fails for now fails the kick, and the next kick buys with a new source', async (t) => {
  const w = account()
  const rows = photoRows(w, 3)
  const a = await holding(t, w, A, rows, { photoBatch: { bytes: 1, total: 1048576 } })
  let broken = true
  let sources = 0
  a.env.blobs.copySource = () => {
    sources++
    if (!broken) return { chunk: 256, reserve: stampsOf, take: stampsOf }
    return {
      chunk: 256,
      reserve: stampsOf,
      take: async () => { throw new UsageError('não deu para preparar o envio da mídia') },
      exhausted: false
    }
  }
  const view = { self: A, off: false, targets: [C] }
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is(w.pointers().length, 1, 'the text pointer went')
  const rec = await a.record()
  t.is(rec.job?.stage, 'photos', 'the job waits at its photo stage')
  t.is(rec.job?.fails, 1, 'the failed kick is counted')
  t.is(a.logs.length, 1, 'and warned about once')
  t.is(sources, 1, 'one source so far')

  broken = false
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is((await a.record()).job, null, 'the job ended')
  const copyId = w.claims()[0].body.copy
  t.alike(w.pointers().map((p) => p.body.id), [copyId, batchIdOf(copyId, 0), batchIdOf(copyId, 1), batchIdOf(copyId, 2)], 'every batch went')
  t.is(sources, 2, 'with a new source, not the one whose purchase failed')
  t.is(a.logs.length, 1, 'and no second warning')
})

test('the weekly allowance ending mid-photos sends the batch held so far and ends the job', async (t) => {
  const w = account()
  const rows = photoRows(w, 3)
  // All photos in one batch: the part (1), the manifest (2), photo 3 (3),
  // photo 2 (4); the stamp for photo 1 finds the allowance spent.
  const a = await holding(t, w, A, rows)
  a.env.blobs.copySource = () => {
    const src = {
      chunk: 256,
      reserve: stampsOf,
      take: async (n) => {
        if (a.puts >= 4) {
          src.exhausted = true
          throw new UsageError('o limite semanal de cópia acabou')
        }
        return stampsOf(n)
      },
      exhausted: false
    }
    return src
  }
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  t.is(w.pointers().length, 2, 'the text and one batch went')
  t.is((await a.record()).job, null, 'the job ended')
  t.alike(a.logs, [], 'with no failure')

  const c = await device(t, w, C)
  c.copy.setDevice({ self: C, off: false })
  await receive(w, c)
  t.is(c.local.snapshot().messages.length, 3, 'the new device imported the messages')
  t.ok(c.local.hasMedia(rows[2].row.from, rows[2].row.id), 'the newest photo came')
  t.ok(c.local.hasMedia(rows[1].row.from, rows[1].row.id), 'and the next one')
  t.absent(c.local.hasMedia(rows[0].row.from, rows[0].row.id), 'not the one left out')
})

test('a device whose last pull did not complete resumes nothing and counts no failure', async (t) => {
  const w = account()
  const a = await holding(t, w, A, textRows(w, 3))
  lockAt(a, 2)
  const view = { self: A, off: false, targets: [C] }
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is((await a.record()).job?.stage, 'text', 'the job waits at its text stage')

  a.onPut = null
  a.reopen()
  a.env.pullComplete = () => false
  const puts = a.puts
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is(a.puts, puts, 'nothing sealed or paid')
  t.is(w.pointers().length, 0, 'no text pointer')
  t.is((await a.record()).job?.fails, 0, 'no failure counted')
  t.alike(a.logs, [], 'and none warned about')

  a.env.pullComplete = () => true
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is(w.pointers().length, 1, 'after a complete pull the text pointer went')
  t.is((await a.record()).job, null, 'and the job ended')
})

test('a pull that fails while the claim settles keeps the job at its claim', async (t) => {
  const w = account()
  const a = await holding(t, w, A, textRows(w, 3))
  a.env.pull = async () => { throw new Error('sem rede') }
  const view = { self: A, off: false, targets: [C] }
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is(w.claims().length, 1, 'the claim went')
  const rec = await a.record()
  t.is(rec.job?.stage, 'claim', 'the job waits at its claim')
  t.is(rec.job?.fails, 1, 'the failed kick is counted')

  a.env.pull = () => a.pull()
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is(w.claims().length, 1, 'the next kick put no second claim')
  t.is(w.pointers().length, 1, 'and one text pointer')
  t.is(w.pointers()[0]?.body.id, w.claims()[0].body.copy, 'carrying that claim\'s copy id')
  t.is((await a.record()).job, null, 'the job ended')
})

test('a photo that does not open keeps its batch for the next pull', async (t) => {
  const w = account()
  const rows = photoRows(w, 2)
  const a = await holding(t, w, A, rows)
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  t.is(w.pointers().length, 2, 'the text and one photo batch')
  const copyId = w.claims()[0].body.copy

  // Blobs in put order: the part, the manifest, the newest photo, the other
  // photo, the batch manifest.
  const [photoId, photoFrames] = [...w.blobs.entries()][2]
  w.blobs.delete(photoId)
  const c = await device(t, w, C)
  c.copy.setDevice({ self: C, off: false })
  await receive(w, c)
  t.is(c.local.snapshot().messages.length, 2, 'the text imported')
  t.ok(c.local.hasMedia(rows[0].row.from, rows[0].row.id), 'the photo that opened is cached')
  t.absent(c.local.hasMedia(rows[1].row.from, rows[1].row.id), 'the other is not')
  const todo = c.local.open(await store.readDmCopy(c.storage)).todo
  t.alike(todo.map((x) => x.id), [batchIdOf(copyId, 0)], 'the batch waits')
  t.is(todo[0]?.fails, 1, 'with the failed pull counted')

  w.blobs.set(photoId, photoFrames)
  await c.copy.importAll(w.own)
  t.ok(c.local.hasMedia(rows[1].row.from, rows[1].row.id), 'the next pass cached the missing photo')
})

test('a pointer with no kept claim waits until the device is known, and only a device that is on imports it', async (t) => {
  const w = account()
  const a = await holding(t, w, A, textRows(w, 2))
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  // As a copy made by the old manual flow reaches a device: a pointer, no claim.
  const pointers = w.pointers().map((p) => ({ id: p.body.id, copy: p.body.copy }))
  t.is(pointers.length, 1, 'one copy')

  const c = await device(t, w, C)
  await c.copy.note(pointers, [])
  await c.copy.importAll(w.own)
  t.is(c.gets, 0, 'a device not told who it is fetches nothing')
  t.is(c.local.snapshot().messages.length, 0, 'and files nothing')

  const off = await device(t, w, D)
  await off.copy.note(pointers, [])
  off.copy.setDevice({ self: D, off: true })
  await off.copy.importAll(w.own)
  t.is(off.gets, 0, 'a device that is off fetches nothing')
  t.is(off.local.snapshot().messages.length, 0, 'and files nothing')
  t.is(off.local.open(await store.readDmCopy(off.storage)).todo.length, 0, 'and drops what waited')

  c.copy.setDevice({ self: C, off: false })
  await c.copy.importAll(w.own)
  t.is(c.local.snapshot().messages.length, 2, 'once told it is on, it imports')
})

// Runs fn with Date.now `ms` in the past (new Date() is left alone).
async function inThePast (ms, fn) {
  const realNow = Date.now
  Date.now = () => realNow() - ms
  try {
    return await fn()
  } finally {
    Date.now = realNow
  }
}

// A claim by another device of the account, put to the pool.
function otherClaim (w, by, targets) {
  const inner = dmCore.buildInner({ kind: dmCore.DM_CLAIM_KIND, id: dmCore.newMessageId(), copy: dmCore.newMessageId(), for: targets, by }, w.keyPair)
  w.pool.push({ seq: w.pool.length + 1, bytes: dmCore.sealInner(inner, hex(w.box.publicKey)) })
}

test('claims by other devices do not use up this device\'s claims for a target', async (t) => {
  const w = account()
  const a = await holding(t, w, A, textRows(w, 2))
  for (let i = 0; i < 3; i++) otherClaim(w, B, [C])
  // Seen two hours ago and never done: stale.
  await inThePast(2 * 3600000, () => a.pull())
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  const claims = w.claims()
  t.is(claims.length, 4, 'this device claimed the target too')
  t.is(claims[3]?.body.by, A, 'its own claim')
  t.is(w.pointers().length, 1, 'and copied')
  t.is(w.pointers()[0]?.body.id, claims[3]?.body.copy, 'under its own claim')
})

test('a stale claim by another device is taken over, a fresh one is not', async (t) => {
  const w = account()
  const a = await holding(t, w, A, textRows(w, 2))
  otherClaim(w, B, [C])
  await inThePast(2 * 3600000, () => a.pull())
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  t.is(w.claims().length, 2, 'this device claimed over the stale claim')
  t.is(w.pointers().length, 1, 'and copied')

  const w2 = account()
  const a2 = await holding(t, w2, A, textRows(w2, 2))
  otherClaim(w2, B, [C])
  await a2.pull()
  await a2.copy.autoCopy(w2.own, w2.keyPair, { self: A, off: false, targets: [C] })
  t.is(w2.claims().length, 1, 'a fresh claim by another device: no claim here')
  t.is(w2.pointers().length, 0, 'and no copy')
})

test('a job whose claim is already near stale spends nothing on its text', async (t) => {
  const w = account()
  const a = await holding(t, w, A, textRows(w, 3))
  lockAt(a, 1)
  const view = { self: A, off: false, targets: [C] }
  // Claimed 51 minutes ago: past CLAIM_TTL_MS - CLAIM_MARGIN_MS by now.
  await inThePast(51 * 60000, () => a.copy.autoCopy(w.own, w.keyPair, view))
  t.is((await a.record()).job?.stage, 'text', 'the job waits at its text stage')

  a.onPut = null
  a.reopen()
  const puts = a.puts
  await a.copy.autoCopy(w.own, w.keyPair, view)
  t.is(a.puts, puts, 'no blob sealed or paid')
  t.is(w.pointers().length, 0, 'no text pointer')
  t.is((await a.record()).job, null, 'the job ended')
})

// A copy as the old manual flow made it: one part whose message rows carry
// c: 1 (their photos travelled), its v1 manifest and the pointer row.
function legacyCopy (w, rows) {
  const descOf = (sealed) => {
    const d = sealed.descriptor
    w.blobs.set(d.id, framesOf(sealed))
    return { id: d.id, key: d.key, nonce: d.nonce, chunks: d.chunks, bytes: d.bytes, sha256: d.sha256 }
  }
  const items = rows.map(({ row }, n) => {
    const { filedAt, ...r } = row
    return { ...r, n, c: 1 }
  })
  const part = descOf(sealBlob(b4a.from(JSON.stringify({ v: 1, page: null, rows: items }), 'utf8')))
  const id = dmCore.newMessageId()
  const manifest = { v: 1, id, at: new Date().toISOString(), stores: [{ page: null, parts: [part], rows: items.length, ops: 0 }] }
  return { id, copy: descOf(sealBlob(b4a.from(JSON.stringify(manifest), 'utf8'))) }
}

test('an imported copy prefetches only the originals still inside the retention', async (t) => {
  const w = account()
  const rows = photoRows(w, 2)
  const DAY = 86400000
  rows[0].row.at = new Date(Date.now() - 20 * DAY).toISOString()
  rows[1].row.at = new Date(Date.now() - DAY).toISOString()
  const c = await device(t, w, C)
  const opened = []
  c.env.folded = async () => ({ requests: [] })
  c.env.openMedia = (m) => {
    opened.push(m.id)
    return Promise.resolve(null)
  }
  c.copy.setDevice({ self: C, off: false })
  await c.copy.note([legacyCopy(w, rows)], [])
  await c.copy.importAll(w.own)
  t.is(c.local.snapshot().messages.length, 2, 'both messages imported')
  t.alike(opened, [rows[1].row.id], 'only the fresh original was opened')
})

test('a text copy goes only to the devices its manifest names, even when its claim never reached them', async (t) => {
  const w = account()
  const a = await holding(t, w, A, textRows(w, 2))
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  const pointers = w.pointers().map((p) => ({ id: p.body.id, copy: p.body.copy }))
  t.is(pointers.length, 1, 'one copy, for C')

  // B is on and knows its id, but the claim was withheld from it: only the
  // manifest says the copy is not for B.
  const b = await device(t, w, B)
  b.copy.setDevice({ self: B, off: false })
  await b.copy.note(pointers, [])
  await b.copy.importAll(w.own)
  t.is(b.local.snapshot().messages.length, 0, 'a device the manifest does not name files nothing')
  t.is(b.local.open(await store.readDmCopy(b.storage)).todo.length, 0, 'and its pointer is handled')

  const c = await device(t, w, C)
  c.copy.setDevice({ self: C, off: false })
  await c.copy.note(pointers, [])
  await c.copy.importAll(w.own)
  t.is(c.local.snapshot().messages.length, 2, 'the device it names imports it with no claim kept')
  t.ok(b.gets < c.gets, 'B read the manifest and no part')
})

test('a device turned off while it imports a copy files nothing more and drops the copy', async (t) => {
  const w = account()
  const a = await holding(t, w, A, textRows(w, 3))
  await a.copy.autoCopy(w.own, w.keyPair, { self: A, off: false, targets: [C] })
  const c = await device(t, w, C)
  c.copy.setDevice({ self: C, off: false })
  // The manifest comes, and the device is turned off while its part is on
  // the way.
  const fetchImpl = c.env.fetchImpl
  let n = 0
  c.env.fetchImpl = async (url) => {
    if (++n === 2) c.copy.setDevice({ self: C, off: true })
    return fetchImpl(url)
  }
  await receive(w, c)
  t.is(c.local.snapshot().messages.length, 0, 'nothing filed')
  t.absent(c.events.some(([name]) => name === 'dm.copyImported'), 'and no import notice')
  await c.copy.importAll(w.own)
  t.is(c.local.open(await store.readDmCopy(c.storage)).todo.length, 0, 'the next pass drops what waited')
  t.is(c.local.snapshot().messages.length, 0, 'still nothing filed')
})
