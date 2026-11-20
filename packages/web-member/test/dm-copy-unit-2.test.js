'use strict'

// The history copy's filing and import rules (lib/dm-copy.js) that need no
// network: the shown time against the receiver's clock, an import cut short,
// one import job at a time and one counted failure per pull, a copy that
// outgrew the reader's limits, the stamps the text needs and how the text
// stage of the automatic copy keeps them across a retry. A stub engine stands
// in for the node's pieces.

const test = require('brittle')
const b4a = require('b4a')
const dmFold = require('@varanda/core/lib/dm-fold')
const blobCore = require('@varanda/core/lib/blob')
const { UsageError } = require('@varanda/core/lib/errors')
const { createDmCopy, fileRows, stampsNeeded, LIMITS } = require('../lib/dm-copy')
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

// The stub engine of a node: the pieces importAll and autoCopy use.
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
  return { s, storage, env, copy: told(env) }
}

// A copier told which device it runs on, as the session does: imports wait
// until it is.
function told (env) {
  const copy = createDmCopy(env)
  copy.setDevice({ self: 'e'.repeat(64), off: false })
  return copy
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

// The automatic copy: this device (BY) holds a text-stage job whose claim for
// TARGET already won, kept in the record as a pull would have left it.
const BY = 'c'.repeat(64)
const TARGET = 'd'.repeat(64)
const VIEW = { self: BY, off: false, targets: [TARGET] }

async function seedJob (storage, sealer) {
  const now = Date.now()
  const job = { id: id('e'), copy: id('f'), for: [TARGET], put: now, stage: 'text', top: null, cursor: null, batches: 0, bytes: 0 }
  const claim = { id: job.id, copy: job.copy, for: [TARGET], by: BY, at: new Date(now).toISOString(), seq: 1, seen: now, done: false }
  await store.writeDmAutoCopy(storage, sealer.seal({ v: 1, job, lastClaim: now, claimed: { [TARGET]: 1 }, done: [], claims: [claim] }))
  return job
}

async function autoRecord (e, sealer) {
  return sealer.open(await store.readDmAutoCopy(e.storage))
}

// A stub local store holding `rows`, whose records a real store seals.
function stubLocal (sealer, rows, over = {}) {
  return {
    snapshot: () => ({ messages: rows, ops: [], reactions: [] }),
    seenToken: () => 'f'.repeat(64),
    hasMedia: () => false,
    seal: (v) => sealer.seal(v),
    open: (v) => sealer.open(v),
    ...over
  }
}

// An engine whose record holds the seeded job; `logs` collects the warnings
// of a run that ended early.
async function autoEngine (t, sealer, local, over = {}) {
  const logs = []
  const e = await engine(t, { local, personal: { local, prefix: '', page: null }, log: (m) => logs.push(m), pullComplete: () => true, ...over })
  const job = await seedJob(e.storage, sealer)
  return { ...e, logs, job }
}

test('a copy too big for the reader uploads nothing and ends the job for its targets', async (t) => {
  const FILED = 1700000000000
  const rows = Array.from({ length: 4 }, (_, i) => ({ t: 'msg', id: String(i).padStart(32, '0'), peer: PEER, from: SELF, text: 'x'.repeat(400000), replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: true, filedAt: FILED + i }))
  const sealer = await openStore(t)
  const local = stubLocal(sealer, rows)
  const counts = { stamps: 0, puts: 0 }
  const blobs = {
    copySource: () => ({ chunk: 256, reserve: async () => [], take: async () => { throw new UsageError('sem selo') } }),
    stamp: async () => { counts.stamps++ },
    put: async () => { counts.puts++ }
  }
  const e = await autoEngine(t, sealer, local, { blobs, limits: { ...LIMITS, parts: 1 } })
  await e.copy.autoCopy(SELF, {}, VIEW)
  t.is(counts.puts, 0, 'nothing was put')
  const rec = await autoRecord(e, sealer)
  t.is(rec.job, null, 'the job ended')
  t.alike(rec.done, [TARGET], 'its target counts as done')
  await e.copy.autoCopy(SELF, {}, VIEW)
  t.is(counts.puts, 0, 'a later kick puts nothing more')
  t.is((await autoRecord(e, sealer)).lastClaim, rec.lastClaim, 'and claims nothing for that target')
  t.alike(e.logs, [], 'a copy that can never go is no failure to warn about')
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
// seeder's key rotated"), and the call after it stops at its put. The job
// stays, so the next kick retries it.
async function staleHeldRun (t, failAt) {
  const row = { t: 'msg', id: id('1'), peer: PEER, from: SELF, text: 'oi', replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: true, filedAt: 1700000000001 }
  const sealer = await openStore(t)
  const local = stubLocal(sealer, [row])
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
  const e = await autoEngine(t, sealer, local, { blobs })
  await e.copy.autoCopy(SELF, {}, VIEW)
  t.is(e.logs.length, 1, 'the refused frame ends the run')
  t.is((await autoRecord(e, sealer)).job.id, e.job.id, 'and the job stays for the next kick')
  await e.copy.autoCopy(SELF, {}, VIEW)
  t.is(puts, failAt + 1, 'the retry got as far as its put')
  return stamped
}

test('between the batches of the reservation the copy stops at a lock', async (t) => {
  const row = { t: 'msg', id: id('1'), peer: PEER, from: SELF, text: 'oi', replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: true, filedAt: 1700000000001 }
  const sealer = await openStore(t)
  const local = stubLocal(sealer, [row])
  let unlocked = true
  const answers = []
  const stops = []
  const counts = { stamps: 0, puts: 0 }
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
    stamp: async () => { counts.stamps++ },
    put: async () => { counts.puts++ }
  }
  const e = await autoEngine(t, sealer, local, { blobs, unlocked: () => unlocked })
  await e.copy.autoCopy(SELF, {}, VIEW)
  t.alike(answers, [true, true, false], 'the reservation goes on while unlocked and stops after a lock')
  t.alike(stops, [false, true], 'the stop predicate is the lock, so a purchase in progress ends at once')
  t.alike(counts, { stamps: 0, puts: 0 }, 'nothing is stamped or put after the lock')
})

test('a retry that holds the stamps does not buy them again', async (t) => {
  const row = { t: 'msg', id: id('1'), peer: PEER, from: SELF, text: 'oi', replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: true, filedAt: 1700000000001 }
  const sealer = await openStore(t)
  const local = stubLocal(sealer, [row])
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
      // The part fails the first time, then goes; the manifest stops the run.
      if (puts === 1) throw new Error('rede caiu')
      if (puts === 3) throw new Error('parou aqui')
    }
  }
  const e = await autoEngine(t, sealer, local, { blobs })
  await e.copy.autoCopy(SELF, {}, VIEW)
  t.is(puts, 1, 'the part failed the first run')
  await e.copy.autoCopy(SELF, {}, VIEW)
  t.is(puts, 3, 'the retry got as far as the manifest')
  t.is(reserves, 1, 'the held stamps are reused, not bought again')
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
    await told(e.env).importAll(SELF)
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
    await told(e.env).importAll(SELF)
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

test('the pointer is put in the bucket of the own box it is sealed to', async (t) => {
  const dmCore = require('@varanda/core/lib/dm')
  const crypto = require('hypercore-crypto')
  const sodium = require('../lib/sodium-browser')
  const boxPub = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_box_keypair(boxPub, b4a.alloc(sodium.crypto_box_SECRETKEYBYTES))
  const boxKey = b4a.toString(boxPub, 'hex')
  const keyPair = crypto.keyPair()
  const self = b4a.toString(keyPair.publicKey, 'hex')
  const row = { t: 'msg', id: id('1'), peer: PEER, from: self, text: 'oi', replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: true, filedAt: 1700000000001 }
  const sealer = await openStore(t)
  const local = stubLocal(sealer, [row])
  const blobs = {
    copySource: () => ({ chunk: 256, reserve: async () => [], take: async (n) => Array.from({ length: n }, () => ({})) }),
    stamp: async (sealed, kp, source) => { await source.take(1) },
    put: async () => {}
  }
  const puts = []
  const e = await autoEngine(t, sealer, local, {
    blobs,
    boxHex: () => ({ box: boxKey, gen: 1 }),
    takeStamps: async (n) => Array.from({ length: n }, () => ({})),
    dropOf: (sealed) => sealed,
    linkOpts: {},
    openDmLink: async () => ({
      put: async (bytes, prefix) => {
        puts.push(prefix)
        return { ok: true, reason: null }
      },
      close: () => {}
    }),
    refusal: (reason) => new UsageError(reason),
    unconfirmed: () => new UsageError('incerto')
  })
  await e.copy.autoCopy(self, keyPair, VIEW)
  t.alike(e.logs, [], 'the copy went')
  t.alike(puts, [dmCore.bucketPrefix(boxKey)], 'one put, tagged with the own bucket')
  const rec = await autoRecord(e, sealer)
  t.is(rec.job, null, 'with no photo to send the job ends after the text')
  t.ok(rec.claims[0].done, 'and its claim is done')
})
