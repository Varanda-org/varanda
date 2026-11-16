'use strict'

// The history copy's filing and import rules (lib/dm-copy.js) that need no
// network: the shown time against the receiver's clock, an import cut short,
// one import job at a time and one counted failure per pull, the late
// refusal of a copy that outgrew the reader's limits, and the stamps the text
// needs. A stub engine stands in for the node's pieces.

const test = require('brittle')
const b4a = require('b4a')
const dmFold = require('@varanda/core/lib/dm-fold')
const blobCore = require('@varanda/core/lib/blob')
const { UsageError } = require('@varanda/core/lib/errors')
const { createDmCopy, fileRows, stampsNeeded, LIMITS, TOO_BIG } = require('../lib/dm-copy')
const { createDmStore } = require('../lib/dm-store')
const { memoryNodeStorage } = require('../lib/node-storage')
const { sealBlob } = require('../lib/blob')
const store = require('../lib/node-store')

const SELF = 'a'.repeat(64)
const PEER = 'b'.repeat(64)
const AT = '2026-11-03T12:00:00.000Z'
const NO_BLOCKS = new Set()
const NOW = Date.UTC(2026, 10, 16, 12)
const YEAR = 365 * 86400000

const id = (c) => c.repeat(32)

function msg (c, n, extra = {}) {
  return { t: 'msg', id: id(c), peer: PEER, from: PEER, text: 'texto ' + c, replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: false, n, ...extra }
}

function op (c, n, kind) {
  return { t: 'ctl', id: id(c), op: kind, peer: PEER, at: AT, n }
}

async function openStore (t) {
  const s = createDmStore({ storage: memoryNodeStorage() })
  await s.unlock(new Uint8Array(32).fill(7))
  await s.loaded()
  t.teardown(() => s.close(), { force: true })
  return s
}

// What the fold shows of a store: the ids of the visible messages, and the
// time of each.
function shown (s) {
  const { messages, ops } = s.snapshot()
  const out = dmFold.fold({
    self: SELF,
    followSet: [PEER],
    messages: messages.map((m) => ({ id: m.id, from: m.from, to: m.mine ? m.peer : SELF, text: m.text, at: m.at, filedAt: m.filedAt, shownAt: m.shownAt })),
    ops,
    seen: [],
    reactions: []
  })
  const rows = [...out.inbox, ...out.requests].flatMap((c) => c.messages)
  return rows.map((m) => ({ id: m.id, at: m.at })).sort((x, y) => (x.id < y.id ? -1 : 1))
}

// A receiver that already holds a message pulled since the copy was made.
async function withLocalRow (t) {
  const s = await openStore(t)
  await s.append([{ ...msg('9', 0), filedAt: s.nextFiled() }].map(({ n, ...r }) => r))
  return s
}

function memoryPin () {
  const pin = { value: null, sets: 0, get: () => pin.value, set: async (h) => { pin.value = h; pin.sets++ } }
  return pin
}

test('a copied row is shown no later than the receiver\'s clock, whatever the maker\'s said', async (t) => {
  const s = await openStore(t)
  const rows = [
    msg('1', 0, { at: '2999-01-01T00:00:00.000Z', shownAt: NOW + YEAR }),
    msg('2', 1, { shownAt: NOW - 5000 }),
    msg('3', 2, { shownAt: 8e15 })
  ]
  await fileRows({ local: s, prefix: '' }, memoryNodeStorage(), SELF, rows, NO_BLOCKS, { now: NOW })
  const filed = s.snapshot().messages
  t.is(filed.length, 3)
  for (const m of filed) t.ok(m.shownAt <= NOW, 'filed with a shown time no later than now')
  t.is(filed.find((m) => m.id === id('2')).shownAt, NOW - 5000, 'an earlier shown time is kept')
  for (const m of shown(s)) t.ok(Date.parse(m.at) <= NOW, 'the fold shows it at or before now')
})

// An append that fails the n-th time it is called, as a lock or a kill
// between two chunks does.
function breakAppend (s, nth) {
  const real = s.append
  let calls = 0
  s.append = (list) => {
    if (++calls === nth) return Promise.reject(new Error('interrompido'))
    return real(list)
  }
  return () => { s.append = real }
}

async function interrupted (t, rows, { chunkRows, keepPin }) {
  const s = await withLocalRow(t)
  const ctx = { local: s, prefix: '' }
  const storage = memoryNodeStorage()
  const pin = memoryPin()
  const heal = breakAppend(s, 2)
  let failed = null
  try {
    await fileRows(ctx, storage, SELF, rows, NO_BLOCKS, { pin, chunkRows, now: NOW })
  } catch (err) {
    failed = err
  }
  heal()
  t.ok(failed && failed.message === 'interrompido', 'the first run stopped between two chunks')
  t.is(pin.sets, 1, 'the horizon was kept before the first chunk')
  await fileRows(ctx, storage, SELF, rows, NO_BLOCKS, { pin: keepPin ? pin : memoryPin(), chunkRows, now: NOW })
  return s
}

async function whole (t, rows) {
  const s = await withLocalRow(t)
  await fileRows({ local: s, prefix: '' }, memoryNodeStorage(), SELF, rows, NO_BLOCKS, { pin: memoryPin(), now: NOW })
  return s
}

test('an import cut between two chunks files the rest where an uninterrupted one would have', async (t) => {
  // A delete in the middle: what comes after it stays visible.
  const afterDelete = [msg('1', 0), op('4', 1, 'deleted'), msg('2', 2), msg('3', 3)]
  const done = await whole(t, afterDelete)
  const cut = await interrupted(t, afterDelete, { chunkRows: 2, keepPin: true })
  t.alike(shown(cut).map((m) => m.id), [id('2'), id('3'), id('9')], 'the messages after the delete show, the one before does not')
  t.alike(shown(cut).map((m) => m.id), shown(done).map((m) => m.id), 'the same as an uninterrupted import')

  // A block and an unblock: the later one wins.
  const unblocked = [msg('1', 0), op('5', 1, 'blocked'), op('6', 2, 'unblocked'), msg('2', 3)]
  const doneB = await whole(t, unblocked)
  const cutB = await interrupted(t, unblocked, { chunkRows: 2, keepPin: true })
  t.alike(shown(cutB).map((m) => m.id), shown(doneB).map((m) => m.id), 'a block and its unblock resolve the same way')
  t.alike(shown(cutB).map((m) => m.id), [id('2'), id('9')], 'the block cut off the one before it; after the unblock the rest shows')
  t.alike(cutB.snapshot().ops.map((o) => o.op), ['blocked', 'unblocked'], 'the ops keep their order')
  t.ok(cutB.snapshot().ops[0].filedAt < cutB.snapshot().ops[1].filedAt)
})

// The stub engine of a node: the pieces importAll and historyCopy use.
async function engine (t, over = {}) {
  const s = await openStore(t)
  const storage = memoryNodeStorage()
  const noop = () => {}
  const env = {
    storage,
    local: s,
    personal: { local: s, prefix: '', page: null },
    pages: { pages: () => [], get: () => null },
    blobOrigin: 'http://127.0.0.1:9',
    fetchLimits: { getBurst: 1000, getPaceMs: 0, getRetries: 0, getTimeoutMs: 5000 },
    generation: () => 1,
    unlocked: () => true,
    requireUnlocked: noop,
    emit: noop,
    log: noop,
    moderation: async () => ({ blocked: new Set(), association: new Set() }),
    ...over
  }
  return { s, storage, env, copy: createDmCopy(env) }
}

function pointer (c) {
  return { id: id(c), copy: sealBlob(b4a.from('manifest ' + c)).descriptor }
}

async function todoOf (e) {
  const sealed = await store.readDmCopy(e.storage)
  return e.s.open(sealed).todo
}

// A seeder that sends a body that is no blob frame (a proxy rewriting it),
// held until `gate.open()`.
function junkSeeder () {
  const gate = { open: null, fetches: 0 }
  const opened = new Promise((resolve) => { gate.open = resolve })
  const fetchImpl = async () => {
    gate.fetches++
    await opened
    return new Response(new Uint8Array(blobCore.BLOB_FRAME_BYTES), { status: 200 })
  }
  return { gate, fetchImpl }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a call while an import runs joins it: one job, one read of the record', async (t) => {
  let reads = 0
  let release = null
  const hold = new Promise((resolve) => { release = resolve })
  const storage = memoryNodeStorage()
  const readJson = storage.readJson.bind(storage)
  storage.readJson = async (key) => {
    if (key === 'dmCopy') {
      reads++
      await hold
    }
    return readJson(key)
  }
  const { fetchImpl } = junkSeeder()
  const e = await engine(t, { storage, fetchImpl })
  const p1 = e.copy.importAll(SELF)
  const p2 = e.copy.importAll(SELF)
  await sleep(50)
  t.is(p1, p2, 'the second call gets the running job')
  t.is(reads, 1, 'one read of the record while it runs')
  release()
  await p1
})

test('overlapping pulls count one failure against a todo, not one per pass', async (t) => {
  const { gate, fetchImpl } = junkSeeder()
  const e = await engine(t, { fetchImpl })
  await e.copy.note([pointer('c')])
  const calls = [e.copy.importAll(SELF), e.copy.importAll(SELF), e.copy.importAll(SELF)]
  await sleep(50)
  gate.open()
  await Promise.all(calls)
  const [todo] = await todoOf(e)
  t.is(todo.fails, 1, 'three overlapping pulls, one failure')
  // A later pull is a new chance: it counts.
  await e.copy.importAll(SELF)
  t.is((await todoOf(e))[0].fails, 2, 'the next pull that fails counts')
  await e.copy.importAll(SELF)
  t.is((await todoOf(e)).length, 0, 'the third ends it')
})

test('a copy refused late for its size does not upload everything again on a retry', async (t) => {
  // The rows fill one part to within a few bytes; a photo's new descriptor
  // (and c: 1) tips them into a second, past a limit of one part.
  const PART = 1048576
  const media = (c) => [{ id: c.repeat(64), key: c.repeat(64), nonce: c.repeat(48), chunks: 1, bytes: 1016, sha256: c.repeat(64), mime: 'image/png', w: 64, h: 48 }]
  const FILED = 1700000000000
  const row = (i, text, extra = {}) => ({ t: 'msg', id: String(i).padStart(32, '0'), peer: PEER, from: SELF, text, replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: true, filedAt: FILED + i, ...extra })
  const sizeOf = (r, n) => {
    const item = { ...r }
    delete item.filedAt
    return b4a.byteLength(JSON.stringify({ ...item, n, shownAt: r.filedAt })) + 1
  }
  const photo = row(1, 'foto', { media: media('1') })
  const rows = [photo]
  let size = sizeOf(photo, 0)
  while (size + sizeOf(row(2 + rows.length, 'x'.repeat(3000)), rows.length) < PART - 4000) {
    const r = row(2 + rows.length, 'x'.repeat(3000))
    size += sizeOf(r, rows.length)
    rows.push(r)
  }
  // The last row takes the part to PART - 3.
  const last = row(2 + rows.length, '')
  const room = PART - 3 - size - sizeOf(last, rows.length)
  rows.push({ ...last, text: 'y'.repeat(room) })

  const local = {
    snapshot: () => ({ messages: rows, ops: [], reactions: [] }),
    seenToken: () => 'f'.repeat(64),
    hasMedia: () => true,
    getMedia: async () => [new Uint8Array(1000).fill(1)],
    seal: (v) => v,
    open: (v) => v
  }
  const counts = { stamps: 0, puts: 0 }
  const blobs = {
    copySource: () => ({ chunk: 256, reserve: async () => [], take: async () => { throw new UsageError('sem selo') } }),
    stamp: async () => { counts.stamps++ },
    put: async () => { counts.puts++ }
  }
  const small = { ...LIMITS, parts: 1 }
  const e = await engine(t, { local, personal: { local, prefix: '', page: null }, blobs, limits: small, mediaItem: (d) => d })

  const first = await e.copy.historyCopy(SELF, {}).catch((err) => err)
  t.ok(first instanceof UsageError && first.message === TOO_BIG, 'refused for its size once the photo is swapped in')
  t.is(counts.puts, 1, 'only the photo was put')
  const again = await e.copy.historyCopy(SELF, {}).catch((err) => err)
  t.ok(again instanceof UsageError && again.message === TOO_BIG, 'the retry is refused the same way, not a crash')
  t.is(counts.puts, 1, 'and put nothing more')
})

test('the text needs a stamp per chunk of every part and of the manifest, and one more per part', (t) => {
  const row = { n: 0, t: 'msg', text: 'x' }
  t.is(stampsNeeded([[row, row, row]]), 3, 'one small part: its chunk, the slack, the manifest')
  t.is(stampsNeeded([[], [row]]), 3, 'an empty store counts for nothing')
  t.is(stampsNeeded([[row], [row]]), 5, 'a second store adds its part')
  const big = Array.from({ length: 4 }, () => ({ n: 0, t: 'msg', text: 'y'.repeat(300000) }))
  // 1.2 MB cut into two parts of 3 and 1 rows: 28 and 10 chunks, one slack each, the manifest.
  t.is(stampsNeeded([big]), 28 + 10 + 2 + 1, 'parts of several chunks')
})

test('the stamps of a part count its MAC: a part that lands within 16 bytes of a chunk edge needs the next chunk', (t) => {
  const CHUNK = blobCore.BLOB_CHUNK_BYTES
  // The part's estimated plain size is its rows' JSON plus a 128 byte
  // envelope; the sealed blob adds BLOB_MAC_BYTES (16) to it.
  const rowsOf = (plain) => {
    const base = b4a.byteLength(JSON.stringify([{ n: 0, t: 'msg', text: '' }]))
    return [{ n: 0, t: 'msg', text: 'x'.repeat(plain - 128 - base) }]
  }
  const partChunks = (plain) => stampsNeeded([rowsOf(plain)]) - 1 - 1
  t.is(partChunks(CHUNK - 16), 1, 'plain + MAC fills one chunk exactly')
  t.is(partChunks(CHUNK - 15), 2, 'one byte over once the MAC is counted')
  t.is(partChunks(CHUNK - 8), 2, 'inside the MAC: without it this would be one chunk')
  t.is(partChunks(2 * CHUNK - 16), 2)
  t.is(partChunks(2 * CHUNK - 8), 3)
  // The estimate never undercounts what sealBlob really makes of the same rows.
  for (const plain of [CHUNK - 16, CHUNK - 8, 2 * CHUNK - 8]) {
    const rows = rowsOf(plain)
    const real = sealBlob(b4a.from(JSON.stringify({ v: 1, page: null, rows }), 'utf8')).descriptor.chunks
    t.ok(partChunks(plain) >= real, 'at least the chunks the real part has')
  }
})

// A stub blob client: the copy source holds three stamps in reserve and
// buys 'fresh' ones; put refuses the failAt-th frame as invalid ("the
// seeder's key rotated"), and the call after it stops at its put.
async function staleHeldRun (t, failAt) {
  const row = { t: 'msg', id: id('1'), peer: PEER, from: SELF, text: 'oi', replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: true, filedAt: 1700000000001 }
  const local = {
    snapshot: () => ({ messages: [row], ops: [], reactions: [] }),
    seenToken: () => 'f'.repeat(64),
    hasMedia: () => false,
    seal: (v) => v,
    open: (v) => v
  }
  const stamped = []
  let puts = 0
  const blobs = {
    copySource: () => ({
      chunk: 256,
      reserve: async () => [{ token: 'held-0' }, { token: 'held-1' }, { token: 'held-2' }],
      take: async (n) => Array.from({ length: n }, (_, i) => ({ token: 'fresh-' + i }))
    }),
    stamp: async (sealed, keyPair, source) => {
      for (const s of await source.take(1)) stamped.push(s.token)
    },
    put: async () => {
      puts++
      if (puts === failAt) throw Object.assign(new UsageError('mídia recusada pelo semeador'), { reason: 'invalido' })
      if (puts > failAt) throw new UsageError('parou aqui')
    }
  }
  const e = await engine(t, { local, personal: { local, prefix: '', page: null }, blobs })
  const first = await e.copy.historyCopy(SELF, {}).catch((err) => err)
  t.ok(first instanceof UsageError && first.message === 'mídia recusada pelo semeador', 'the refused frame fails the copy')
  const second = await e.copy.historyCopy(SELF, {}).catch((err) => err)
  t.ok(second instanceof UsageError && second.message === 'parou aqui', 'the retry got as far as its put')
  return stamped
}

test('between the batches of the reservation the copy shows progress and stops at a lock', async (t) => {
  const row = { t: 'msg', id: id('1'), peer: PEER, from: SELF, text: 'oi', replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: true, filedAt: 1700000000001 }
  const local = {
    snapshot: () => ({ messages: [row], ops: [], reactions: [] }),
    seenToken: () => 'f'.repeat(64),
    hasMedia: () => false,
    seal: (v) => v,
    open: (v) => v
  }
  let unlocked = true
  const answers = []
  const stops = []
  const events = []
  const blobs = {
    // The text needs 3 stamps: with a chunk of 1, three batches.
    copySource: () => ({
      chunk: 1,
      reserve: async (n, between, stop) => {
        stops.push(stop())
        answers.push(await between(1))
        answers.push(await between(2))
        unlocked = false
        stops.push(stop())
        answers.push(await between(3))
        return []
      }
    }),
    stamp: async () => { throw new Error('nothing is stamped after a lock') },
    put: async () => { throw new Error('nothing is put after a lock') }
  }
  const e = await engine(t, { local, personal: { local, prefix: '', page: null }, blobs, unlocked: () => unlocked, emit: (name, data) => events.push([name, data]) })
  const err = await e.copy.historyCopy(SELF, {}).catch((x) => x)
  t.ok(err instanceof UsageError, 'the lock ends the copy')
  t.alike(answers, [true, true, false], 'the reservation goes on while unlocked and stops after a lock')
  t.alike(stops, [false, true], 'the stop predicate is the lock, so a purchase in progress ends at once')
  t.alike(events, [
    ['dm.copyProgress', { done: 0, total: 5 }],
    ['dm.copyProgress', { done: 1, total: 5 }],
    ['dm.copyProgress', { done: 2, total: 5 }]
  ], 'one step per batch: total is the 2 fixed steps plus the 3 batches, and done moves after each')
})

test('the reservation batches are steps of the progress, and the unbought ones count as done when it ends early', async (t) => {
  const row = { t: 'msg', id: id('1'), peer: PEER, from: SELF, text: 'oi', replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: true, filedAt: 1700000000001 }
  const local = {
    snapshot: () => ({ messages: [row], ops: [], reactions: [] }),
    seenToken: () => 'f'.repeat(64),
    hasMedia: () => false,
    seal: (v) => v,
    open: (v) => v
  }
  const events = []
  const blobs = {
    // 3 stamps in batches of 2: two batches, but the allowance ends after one.
    copySource: () => ({
      chunk: 2,
      reserve: async (n, between) => {
        await between(2)
        return [{ token: 'held-0' }, { token: 'held-1' }]
      },
      take: async () => { throw new UsageError('sem selo') }
    }),
    stamp: async (sealed, keyPair, source) => { await source.take(1) },
    put: async () => { throw new Error('parou aqui') }
  }
  const e = await engine(t, { local, personal: { local, prefix: '', page: null }, blobs, emit: (name, data) => events.push(data) })
  await e.copy.historyCopy(SELF, {}).catch(() => null)
  t.alike(events, [{ done: 0, total: 4 }, { done: 1, total: 4 }, { done: 2, total: 4 }], 'one step per batch, then done = the batches')
})

test('a retry that holds the stamps has no batch to count', async (t) => {
  const media = [{ id: '1'.repeat(64), key: '1'.repeat(64), nonce: '1'.repeat(48), chunks: 1, bytes: 1016, sha256: '1'.repeat(64), mime: 'image/png', w: 64, h: 48 }]
  const row = { t: 'msg', id: id('1'), peer: PEER, from: SELF, text: 'foto', replyTo: null, fwd: 0, media, card: null, at: AT, mine: true, filedAt: 1700000000001 }
  const local = {
    snapshot: () => ({ messages: [row], ops: [], reactions: [] }),
    seenToken: () => 'f'.repeat(64),
    hasMedia: () => true,
    getMedia: async () => [new Uint8Array(1000).fill(1)],
    seal: (v) => v,
    open: (v) => v
  }
  const events = []
  let puts = 0
  let reserves = 0
  const blobs = {
    copySource: () => ({
      chunk: 2,
      reserve: async (n, between) => {
        reserves++
        await between(2)
        await between(3)
        return [{ token: 'held-0' }, { token: 'held-1' }, { token: 'held-2' }]
      },
      take: async () => { throw new UsageError('sem selo') }
    }),
    stamp: async () => {},
    put: async () => {
      puts++
      // The photo fails the first time, then goes; the part stops the run.
      if (puts === 1) throw new Error('rede caiu')
      if (puts === 3) throw new Error('parou aqui')
    }
  }
  const e = await engine(t, { local, personal: { local, prefix: '', page: null }, blobs, mediaItem: (d) => d, emit: (name, data) => events.push(data) })
  const first = await e.copy.historyCopy(SELF, {}).catch((x) => x)
  t.ok(first instanceof Error && first.message === 'rede caiu', 'the photo failed the first call')
  t.alike(events, [{ done: 0, total: 5 }, { done: 1, total: 5 }, { done: 2, total: 5 }, { done: 2, total: 5 }], 'the photo, the 2 fixed steps and 2 batches')
  events.length = 0
  const second = await e.copy.historyCopy(SELF, {}).catch((x) => x)
  t.ok(second instanceof Error && second.message === 'parou aqui', 'the retry got as far as the part')
  t.is(reserves, 1, 'the held stamps are reused, not bought again')
  t.alike(events, [{ done: 0, total: 3 }, { done: 1, total: 3 }], 'no batch: the photo and the 2 fixed steps')
})

test('a part refused as invalid drops the held stamps: the retry buys fresh ones', async (t) => {
  t.alike(await staleHeldRun(t, 1), ['held-0', 'fresh-0'], 'the retry does not stamp from the stale ones')
})

test('a manifest refused as invalid drops the held stamps too', async (t) => {
  t.alike(await staleHeldRun(t, 2), ['held-0', 'held-1', 'fresh-0'], 'the manifest retry does not stamp from the stale ones')
})

test('unblocking a sender between an interrupted import and its retry keeps every filing time unique and in order', async (t) => {
  await unblockCase(t, 1)
})

test('the same when the blocked sender\'s row has the largest n', async (t) => {
  await unblockCase(t, 3)
})

// The row at index `blockedAt` is the blocked sender's.
async function unblockCase (t, blockedAt) {
  const OTHER = 'c'.repeat(64)
  const H = 1700000000000
  const rows = ['1', '2', '3', '4'].map((c, i) => (i === blockedAt ? msg(c, i, { peer: OTHER, from: OTHER }) : msg(c, i)))
  const fresh = async () => {
    const s = await openStore(t)
    const { n, ...local } = msg('9', 0)
    await s.append([{ ...local, filedAt: H }])
    return s
  }
  const times = (s) => Object.fromEntries(s.snapshot().messages.map((m) => [m.id, m.filedAt]))

  // The reference: nobody blocked, nothing interrupted.
  const done = await fresh()
  await fileRows({ local: done, prefix: '' }, memoryNodeStorage(), SELF, rows, NO_BLOCKS, { pin: memoryPin(), now: NOW })

  // The first run drops the blocked sender's row and stops after its first
  // chunk; the retry runs with the sender unblocked.
  const s = await fresh()
  const ctx = { local: s, prefix: '' }
  const pin = memoryPin()
  const heal = breakAppend(s, 2)
  const failed = await fileRows(ctx, memoryNodeStorage(), SELF, rows, new Set([OTHER]), { pin, chunkRows: 2, now: NOW }).catch((err) => err)
  heal()
  t.ok(failed instanceof Error && failed.message === 'interrompido', 'the first run stopped between two chunks')
  t.is(s.snapshot().messages.length, 3, 'its first chunk is filed')
  await fileRows(ctx, memoryNodeStorage(), SELF, rows, NO_BLOCKS, { pin, chunkRows: 2, now: NOW })

  const got = times(s)
  t.is(Object.keys(got).length, 5, 'every row is filed once')
  t.is(new Set(Object.values(got)).size, 5, 'no two rows share a filing time')
  t.alike(got, times(done), 'each row sits where the uninterrupted import put it')
  t.ok(got[id('1')] < got[id('2')] && got[id('2')] < got[id('3')] && got[id('3')] < got[id('4')], 'the bundle order is kept')
}

test('a row at n = rows is not valid and files nowhere; the row at rows - 1 is', async (t) => {
  const s = await withLocalRow(t)
  const edge = msg('1', LIMITS.rows - 1)
  const over = msg('2', LIMITS.rows)
  const first = msg('3', 0)
  const horizon = Math.min(...s.snapshot().messages.map((m) => m.filedAt))
  const res = await fileRows({ local: s, prefix: '' }, memoryNodeStorage(), SELF, [first, over, edge], NO_BLOCKS, { pin: memoryPin(), now: NOW })
  t.is(res.skipped, 1, 'the row at n = rows is skipped')
  const got = timesOf(s)
  t.absent(id('2') in got, 'the row at n = rows is not filed')
  t.ok(id('1') in got && id('3') in got, 'the rows below it are')
  for (const [k, v] of Object.entries(got)) if (k !== id('9')) t.ok(v < horizon, 'filed below everything the store held')
  t.ok(got[id('3')] < got[id('1')], 'in n order')
})

test('two rows sharing an n: the first owns the slot even when a block drops it, so an unblock hands nothing over', async (t) => {
  const OTHER = 'c'.repeat(64)
  const s = await withLocalRow(t)
  const ctx = { local: s, prefix: '' }
  const pin = memoryPin()
  // A (blocked sender) and B (valid) both claim n = 0.
  const rows = [msg('1', 0, { peer: OTHER, from: OTHER }), msg('2', 0), msg('3', 1)]
  await fileRows(ctx, memoryNodeStorage(), SELF, rows, new Set([OTHER]), { pin, now: NOW })
  t.alike(Object.keys(timesOf(s)).sort(), [id('3'), id('9')], 'blocked: neither row with the shared n is filed')
  await fileRows(ctx, memoryNodeStorage(), SELF, rows, NO_BLOCKS, { pin, now: NOW })
  const got = timesOf(s)
  t.alike(Object.keys(got).sort(), [id('1'), id('3'), id('9')], 'unblocked: the first row takes its slot, the second stays out')
  t.is(new Set(Object.values(got)).size, 3, 'no two rows share a filing time')
  t.ok(got[id('1')] < got[id('3')], 'the bundle order is kept')
})

// An in-memory blob host: what a seeder serves of the blobs a copy made.
function blobHost () {
  const frames = new Map()
  const publish = (json) => {
    const sealed = sealBlob(b4a.from(JSON.stringify(json), 'utf8'))
    const { chunks, id: blobId } = sealed.descriptor
    for (let i = 0; i < chunks; i++) {
      frames.set(blobId + '/' + i, blobCore.encodeChunk({
        id: sealed.id,
        index: i,
        count: chunks,
        kid: b4a.alloc(8),
        sig: b4a.alloc(256),
        token: b4a.alloc(32),
        bytes: sealed.cipher.subarray(i * blobCore.BLOB_CHUNK_BYTES, (i + 1) * blobCore.BLOB_CHUNK_BYTES)
      }))
    }
    return sealed.descriptor
  }
  const fetchImpl = async (url) => {
    const m = /\/blob\/([0-9a-f]+)\/(\d+)$/.exec(String(url))
    const frame = m === null ? undefined : frames.get(m[1] + '/' + m[2])
    return frame === undefined ? new Response('', { status: 404 }) : new Response(frame, { status: 200 })
  }
  return { publish, fetchImpl }
}

// More rows than one filing chunk (500), so an interruption can fall between.
function bigRows () {
  return Array.from({ length: 501 }, (_, i) => msg('0', i, { id: String(i + 1).padStart(32, '0') }))
}

const H0 = 1700000000000

async function seedLocal (s) {
  const { n, ...local } = msg('9', 0)
  await s.append([{ ...local, filedAt: H0 }])
}

const timesOf = (s) => Object.fromEntries(s.snapshot().messages.map((m) => [m.id, m.filedAt]))

// The own store of a copy, imported once, or cut after its first chunk and
// finished by a new instance over the same storage (a restart).
async function ownImport (t, interrupt) {
  const host = blobHost()
  const part = host.publish({ v: 1, page: null, rows: bigRows() })
  const manifest = host.publish({ v: 1, id: id('c'), at: AT, stores: [{ page: null, parts: [part], rows: 501, ops: 0 }] })
  const e = await engine(t, { fetchImpl: host.fetchImpl })
  await seedLocal(e.s)
  await e.copy.note([{ id: id('c'), copy: manifest }])
  if (interrupt) {
    const heal = breakAppend(e.s, 2)
    await e.copy.importAll(SELF)
    heal()
    const [todo] = await todoOf(e)
    t.ok(todo && Number.isSafeInteger(todo.horizons.own), 'the horizon was kept with the todo before the first chunk')
    t.is(e.s.snapshot().messages.length, 501, 'only the first chunk was filed')
    await createDmCopy(e.env).importAll(SELF)
  } else {
    await e.copy.importAll(SELF)
  }
  t.is((await todoOf(e)).length, 0, 'the todo is done')
  t.is(e.s.snapshot().messages.length, 502, 'every row is filed')
  return timesOf(e.s)
}

test('an import cut after its first chunk and resumed by a new instance reads the horizon back from the record', async (t) => {
  const whole = await ownImport(t, false)
  const resumed = await ownImport(t, true)
  t.alike(resumed, whole, 'every row sits where the uninterrupted import put it')
})

// The store of a Página held back until its secrets arrive, then filed:
// the same, with the horizon kept in the pend entry's meta.
async function pageImport (t, interrupt) {
  const PAGE = 'd'.repeat(64)
  const host = blobHost()
  const part = host.publish({ v: 1, page: PAGE, rows: bigRows() })
  const manifest = host.publish({ v: 1, id: id('c'), at: AT, stores: [{ page: PAGE, parts: [part], rows: 501, ops: 0 }] })
  const pageStore = await openStore(t)
  await seedLocal(pageStore)
  let held = false
  const e = await engine(t, {
    fetchImpl: host.fetchImpl,
    pages: { pages: () => [], get: () => (held ? {} : null) },
    pageCtx: async () => ({ local: pageStore, prefix: 'p' })
  })
  await e.copy.note([{ id: id('c'), copy: manifest }])
  await e.copy.importAll(SELF)
  t.is((await store.readCopyPend(e.storage)).length, 1, 'the Página store waits sealed')
  held = true
  if (interrupt) {
    const heal = breakAppend(pageStore, 2)
    await e.copy.importAll(SELF)
    heal()
    t.is(pageStore.snapshot().messages.length, 501, 'only the first chunk was filed')
    t.is((await store.readCopyPend(e.storage)).length, 1, 'the entry waits for the rest')
    await createDmCopy(e.env).importAll(SELF)
  } else {
    await e.copy.importAll(SELF)
  }
  t.is((await store.readCopyPend(e.storage)).length, 0, 'the entry is done')
  t.is(pageStore.snapshot().messages.length, 502, 'every row is filed')
  return timesOf(pageStore)
}

test('a held-back Página store cut after its first chunk keeps its horizon in the pend entry', async (t) => {
  const whole = await pageImport(t, false)
  const resumed = await pageImport(t, true)
  t.alike(resumed, whole, 'every row sits where the uninterrupted filing put it')
})
