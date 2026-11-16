'use strict'

// node-store readAll / readVisible / readRaw on a core the live sync run
// lends: the run can download a tombstone past the read's length snapshot and
// clear its target mid-walk. The walk then meets a hole the snapshot cannot
// explain; the read must settle on a second pass instead of cutting there.
// Fake cores, no network.
const test = require('brittle')
const b4a = require('b4a')
const { postRecord, deleteRecord } = require('@varanda/core/lib/records')
const store = require('../lib/node-store')

const enc = (record) => b4a.from(JSON.stringify(record))

// blocks: Map index -> Buffer; `walks` counts reads of block 0, one per walk
// (every walk starts at 0, which every fixture stores).
function fakeCore (blocks, length, onGet) {
  const core = {
    length,
    closing: false,
    walks: 0,
    blocks,
    has: async (i) => blocks.has(i),
    get: async (i) => {
      if (i === 0) core.walks++
      const block = blocks.get(i)
      if (onGet) onGet(core, i)
      return block === undefined ? null : block
    }
  }
  return core
}

function posts (n) {
  const blocks = new Map()
  for (let i = 0; i < n; i++) blocks.set(i, enc(postRecord({ text: 'p' + i })))
  return blocks
}

// The run lands the tombstone of `t` at the end and clears `t`, once, when
// block `k` is read.
function tombstoneArrives (t, k) {
  let done = false
  return (core, i) => {
    if (i !== k || done) return
    done = true
    core.blocks.set(core.length, enc(deleteRecord({ seq: t })))
    core.length++
    core.blocks.delete(t)
  }
}

test('readAll: a tombstone that arrives mid-walk does not hide the posts after its target', async (t) => {
  const core = fakeCore(posts(6), 6, tombstoneArrives(2, 0))
  const entries = await store.readAll(core)
  t.alike(entries.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6], 'every block, the deleted one in place')
  t.is(entries[2]?.deleted, true)
  t.is(entries[2]?.record, null)
  t.is(core.walks, 2, 'one extra pass')
})

test('readRaw: the same race settles', async (t) => {
  const core = fakeCore(posts(6), 6, tombstoneArrives(2, 0))
  const raw = await store.readRaw(core)
  t.alike(raw.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6])
})

test('readVisible: a mid-backfill replica keeps its newest run when a tombstone arrives mid-walk', async (t) => {
  const blocks = posts(10)
  for (const i of [3, 4, 5]) blocks.delete(i)
  const core = fakeCore(blocks, 10, tombstoneArrives(7, 0))
  const view = await store.readVisible(core)
  t.alike(view.entries.map((e) => e.seq), [0, 1, 2, 6, 8, 9, 10], 'prefix, then the stored blocks of the run, the target absent')
  t.is(view.present, 3)
  t.is(view.tail, 6)
})

test('a core that grows mid-read with no cut is read once', async (t) => {
  let grown = false
  const core = fakeCore(posts(4), 4, (c, i) => {
    if (i !== 0 || grown) return
    grown = true
    c.blocks.set(c.length, enc(postRecord({ text: 'late' })))
    c.length++
  })
  t.is((await store.readAll(core)).length, 4, 'the snapshot is kept')
  t.is(core.walks, 1)
  grown = false
  const visible = fakeCore(posts(4), 4, (c, i) => {
    if (i !== 0 || grown) return
    grown = true
    c.length++
  })
  await store.readVisible(visible)
  t.is(visible.walks, 1)
})

test('a core that grows by plain posts around a hole is read once', async (t) => {
  const grow = (c, i) => {
    if (i !== 0) return
    c.blocks.set(c.length, enc(postRecord({ text: 'late' })))
    c.length++
  }
  const blocks = posts(5)
  blocks.delete(2)
  const core = fakeCore(blocks, 5, grow)
  t.alike((await store.readAll(core)).map((e) => e.seq), [0, 1], 'cut at the unexplained hole')
  t.is(core.walks, 1)
  const visible = fakeCore(blocks, 5, grow)
  await store.readVisible(visible)
  t.is(visible.walks, 1)
})

test('a core that keeps growing with tombstones is re-read at most twice more', async (t) => {
  const grow = (c, i) => {
    if (i !== 0) return
    c.blocks.set(c.length, enc(deleteRecord({ seq: 1 })))
    c.length++
  }
  const core = fakeCore(posts(5), 5, grow)
  await store.readAll(core)
  t.is(core.walks, 3)
  const visible = fakeCore(posts(5), 5, grow)
  await store.readVisible(visible)
  t.is(visible.walks, 3)
})
