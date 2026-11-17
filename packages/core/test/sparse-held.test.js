'use strict'

// Sparse copies against bare Hypercores (#350, lib/sparse-held.js): a peer
// that holds a few blocks of a long log answers for all of it, and a held
// block past a hole is found without asking has() for every block.

const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { advertisedHeld, nextHeld, peerHolds } = require('../lib/sparse-held')
const { readHeldBlocks } = require('../lib/store')

function link (a, b) {
  const left = a.replicate(true)
  const right = b.replicate(false)
  left.pipe(right).pipe(left)
  return () => {
    left.destroy()
    right.destroy()
  }
}

async function open (t, dir, name, key) {
  const core = new Hypercore(path.join(dir, name), key)
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  return core
}

// W: a log of `length` blocks, `leaveAt` a group-leave, the rest posts.
// S holds [0, 10) and the leave, fetched from W, which then goes.
async function sparseSource (t, length, leaveAt) {
  const dir = tmpDir(t)
  const w = await open(t, dir, 'w')
  const blocks = []
  for (let i = 0; i < length; i++) {
    blocks.push(b4a.from(JSON.stringify(i === leaveAt ? { type: 'group-leave' } : { type: 'group-post', text: 'p' + i })))
  }
  for (let i = 0; i < length; i += 5000) await w.append(blocks.slice(i, i + 5000))
  const s = await open(t, dir, 's', w.key)
  const unlink = link(w, s)
  await s.update({ wait: true })
  await s.download({ start: 0, end: 10 }).done()
  await s.download({ start: leaveAt, end: leaveAt + 1 }).done()
  unlink()
  return { dir, key: w.key, s }
}

test('a peer holding a prefix and one block of a long log answers for all of it (#350)', async (t) => {
  t.timeout(60000)
  // The leave sits in the first bitfield page; the signed length reaches a
  // second page the peer holds nothing in, so it never sends that page.
  const { dir, key, s } = await sparseSource(t, 40000, 500)
  const r = await open(t, dir, 'r', key)
  link(s, r)
  await r.update({ wait: true })
  r.download({ start: 0, end: r.length })
  const deadline = Date.now() + 8000
  let held = false
  while (!held && Date.now() < deadline) {
    held = await advertisedHeld(r, r.length)
    if (!held) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  t.ok(held, 'every advertised block is held well before the deadline')
  t.is(r.contiguousLength, 10)
  t.ok(await r.has(500), 'the leave came')
  t.absent(await r.has(10), 'nothing the peer does not hold')
})

test('a held block past a hole is found without asking has() for every block (#350)', async (t) => {
  t.timeout(60000)
  const { s } = await sparseSource(t, 40000, 35000)
  const real = s.has.bind(s)
  let calls = 0
  s.has = (...args) => {
    calls++
    return real(...args)
  }
  t.is(await nextHeld(s, 10, s.length), 35000, 'the next held block')
  t.is(await nextHeld(s, 35001, s.length), -1, 'none after it')
  calls = 0
  const entries = await readHeldBlocks(s)
  t.alike(entries.map((e) => e.seq), [...Array(10).keys(), 35000], 'the prefix and the leave past the hole')
  t.ok(calls < 100, 'has() asked ' + calls + ' times, not once per block')
})

// The owner of a cut writer counts a block past the cut as at the seeder
// once the seeder's peer advertises it or this core served it to that peer:
// a peer never announces a block it gets to one that holds it already.
test('a peer holds a block it advertises or was served (#350)', (t) => {
  const peer = { remoteContiguousLength: 3, remoteBitfield: { get: (i) => i === 5 } }
  t.ok(peerHolds(peer, [0, 2, 5]), 'its contiguous range and a block it advertises')
  t.absent(peerHolds(peer, [5, 7]), 'not a block it neither advertises nor was served')
  t.absent(peerHolds(peer, [5, 7], new Set()), 'nor with nothing served')
  t.ok(peerHolds(peer, [5, 7], new Set([7])), 'a block served to it counts')
  t.absent(peerHolds(peer, [5, 7, 9], new Set([7])), 'only that one')
})
