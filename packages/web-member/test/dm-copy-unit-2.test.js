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
    copySource: () => ({ reserve: async () => [], take: async () => { throw new UsageError('sem selo') } }),
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
