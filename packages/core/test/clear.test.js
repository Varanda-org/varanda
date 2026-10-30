'use strict'

// Engine gate for byte deletion: what clear() of one middle block does on the
// pinned hypercore / corestore, over local in-memory replication streams.
// Purge relies on every outcome asserted here; a failure means the engine
// changed, not that a workaround is due.
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { until } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')

const LENGTH = 8
const GONE = 3
const block = (i) => b4a.from('block-' + i + '-' + 'x'.repeat(40 + i))

async function openStore (t, dir) {
  const store = new Corestore(dir)
  let closed = false
  const close = async () => { if (!closed) { closed = true; await store.close() } }
  t.teardown(close, { force: true })
  store.closeOnce = close
  await store.ready()
  return store
}

async function writer (t, dir = tmpDir(t)) {
  const store = await openStore(t, dir)
  const core = store.get({ name: 'diary' })
  await core.ready()
  for (let i = 0; i < LENGTH; i++) await core.append(block(i))
  return { store, core, dir }
}

async function replica (t, key, dir = tmpDir(t)) {
  const store = await openStore(t, dir)
  const core = store.get({ key })
  await core.ready()
  return { store, core, dir }
}

// Links two corestores; the b -> a direction (answers to a's requests) can
// be held and released, like a slow peer whose reply is already on the wire.
function link (t, storeA, storeB) {
  const a = new NoiseSecretStream(true)
  const b = new NoiseSecretStream(false)
  let held = null
  a.rawStream.on('data', (d) => b.rawStream.write(d))
  b.rawStream.on('data', (d) => {
    if (held !== null) held.push(d)
    else a.rawStream.write(d)
  })
  storeA.replicate(a)
  storeB.replicate(b)
  const destroy = () => {
    a.destroy()
    b.destroy()
  }
  t.teardown(destroy, { force: true })
  return {
    destroy,
    hold: () => { held = [] },
    release: () => {
      const q = held
      held = null
      for (const d of q) a.rawStream.write(d)
    }
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function watch (core) {
  const seen = { truncate: 0, conflict: 0, upload: [], download: [] }
  core.on('truncate', () => seen.truncate++)
  core.on('conflict', () => seen.conflict++)
  core.on('upload', (index) => seen.upload.push(index))
  core.on('download', (index) => seen.download.push(index))
  return seen
}

async function fullCopy (t, source) {
  const r = await replica(t, source.core.key)
  const l = link(t, r.store, source.store)
  await r.core.download({ start: 0, end: LENGTH }).done()
  l.destroy()
  return r
}

test('clear of a middle block on a writable diary: hole, neighbours, length, fork, contiguousLength, reopen, append', async (t) => {
  const w = await writer(t)
  const { core } = w
  const seen = watch(core)
  const treeHash = b4a.toString(await core.treeHash(), 'hex')
  const byteLength = core.byteLength
  t.is(core.contiguousLength, LENGTH)

  await core.clear(GONE, GONE + 1)

  t.absent(await core.has(GONE), 'the cleared block is gone')
  t.is(await core.get(GONE, { wait: false }), null, 'and cannot be read locally')
  t.alike(await core.get(GONE - 1), block(GONE - 1), 'left neighbour intact')
  t.alike(await core.get(GONE + 1), block(GONE + 1), 'right neighbour intact')
  t.is(core.length, LENGTH, 'length unchanged')
  t.is(core.byteLength, byteLength, 'byteLength unchanged')
  t.is(core.fork, 0, 'fork stays 0')
  t.is(b4a.toString(await core.treeHash(), 'hex'), treeHash, 'the tree is untouched')
  t.is(core.contiguousLength, GONE, 'contiguousLength pinned at the cleared seq')
  t.is(seen.truncate, 0, 'no truncate event')
  t.is(seen.conflict, 0, 'no conflict event')

  await core.append(block(LENGTH))
  t.is(core.length, LENGTH + 1, 'a later append works')
  t.is(core.contiguousLength, GONE, 'and the pin holds')
  t.absent(await core.has(GONE))

  await w.store.closeOnce()
  const store = await openStore(t, w.dir)
  const again = store.get({ name: 'diary' })
  await again.ready()
  t.is(again.length, LENGTH + 1, 'length survives the reopen')
  t.is(again.fork, 0, 'fork survives the reopen')
  t.absent(await again.has(GONE), 'the hole survives the reopen')
  t.is(again.contiguousLength, GONE, 'contiguousLength still pinned after the reopen')
  t.alike(await again.get(GONE - 1), block(GONE - 1))
  t.alike(await again.get(GONE + 1), block(GONE + 1))
  t.alike(await again.get(LENGTH), block(LENGTH))
  await again.append(block(LENGTH + 1))
  t.is(again.length, LENGTH + 2, 'appending after the reopen works')
  t.absent(await again.has(GONE))
})

test('a peer gets the neighbours of a cleared block verified, and never the block', async (t) => {
  const w = await writer(t)
  await w.core.clear(GONE)
  const seen = watch(w.core)
  const r = await replica(t, w.core.key)
  link(t, r.store, w.store)

  t.alike(await r.core.get(GONE - 1), block(GONE - 1), 'left neighbour verified by the replica')
  t.alike(await r.core.get(GONE + 1), block(GONE + 1), 'right neighbour verified by the replica')
  await t.exception(r.core.get(GONE, { timeout: 1500 }), /REQUEST_TIMEOUT/, 'the request for the cleared block gets no data')
  t.absent(await r.core.has(GONE))
  t.absent(seen.upload.includes(GONE), 'the writer never uploaded it')
})

test('stale peer: per-gap ranges never fetch the deleted seq, a {start:0,end:-1} range refills it', async (t) => {
  const w = await writer(t)
  const stale = await fullCopy(t, w)
  await w.store.closeOnce()
  const staleSeen = watch(stale.core)

  const fresh = await replica(t, stale.core.key)
  const freshSeen = watch(fresh.core)
  link(t, fresh.store, stale.store)
  await Promise.all([
    fresh.core.download({ start: 0, end: GONE }).done(),
    fresh.core.download({ start: GONE + 1, end: LENGTH }).done()
  ])
  await pause(500)
  t.absent(await fresh.core.has(GONE), 'per-gap ranges leave the deleted seq out')
  t.ok(await fresh.core.has(GONE - 1) && await fresh.core.has(GONE + 1), 'and fetch the rest')
  t.absent(freshSeen.download.includes(GONE), 'it was never downloaded')
  t.absent(staleSeen.upload.includes(GONE), 'the stale peer never sent it')
  t.is(fresh.core.contiguousLength, GONE)

  const cleared = await fullCopy(t, stale)
  await cleared.core.clear(GONE)
  t.absent(await cleared.core.has(GONE))
  link(t, cleared.store, stale.store)
  const range = cleared.core.download({ start: 0, end: -1 })
  await until(() => cleared.core.has(GONE), { timeoutMs: 5000, name: 'refill' })
  t.pass('a {start:0,end:-1} range refills the cleared seq from the stale peer (negative control)')
  range.destroy()
})

test('a block requested before the clear is written when it arrives, and a download listener clears it again', async (t) => {
  const w = await writer(t)
  const stale = await fullCopy(t, w)
  await w.store.closeOnce()

  const r = await replica(t, stale.core.key)
  const l = link(t, r.store, stale.store)
  await r.core.download({ start: 0, end: GONE }).done()
  l.hold()
  const late = r.core.get(GONE)
  await pause(200)
  await r.core.clear(GONE)
  t.absent(await r.core.has(GONE), 'nothing to clear yet')
  l.release()
  t.alike(await late, block(GONE), 'the late answer resolves the request')
  t.ok(await r.core.has(GONE), 'and the block is written after the clear')

  const deleted = new Set([GONE])
  const cleaning = []
  r.core.on('download', (index) => {
    if (deleted.has(index)) cleaning.push(r.core.clear(index))
  })
  await r.core.clear(GONE)
  t.absent(await r.core.has(GONE), 'clearing again works')

  l.hold()
  const lateAgain = r.core.get(GONE)
  await pause(200)
  l.release()
  await lateAgain
  await until(() => cleaning.length > 0, { name: 'download listener' })
  await Promise.all(cleaning)
  t.absent(await r.core.has(GONE), 'the download listener makes a late block absent again')
  t.is(r.core.contiguousLength, GONE)
})

// The late block's commit runs updateContiguousLength and replicator.onhave
// before the 'download' listener can clear it, so a request already waiting
// from a third peer may be served from storage in that window (the approved
// fresh replica window). What purge relies on is the clearing replica's own
// state once things settle, so that is asserted; the third peer's outcome is
// only recorded.
test('a third peer asking for the deleted seq during a late write and a reconcile: the clearing replica settles and stays without the block', async (t) => {
  const w = await writer(t)
  const stale = await fullCopy(t, w)
  const clearing = await fullCopy(t, w)
  await w.store.closeOnce()

  const deleted = new Set([GONE])
  const cleaning = []
  clearing.core.on('download', (index) => {
    if (deleted.has(index)) cleaning.push(clearing.core.clear(index))
  })
  const clearingSeen = watch(clearing.core)
  await clearing.core.clear(GONE)

  const third = await replica(t, clearing.core.key)
  link(t, third.store, clearing.store)
  const asked = third.core.get(GONE, { timeout: 3000 }).then(() => 'got', (err) => err.code)

  const l = link(t, clearing.store, stale.store)
  l.hold()
  const late = clearing.core.get(GONE)
  await pause(100)
  const reconcile = clearing.core.clear(GONE)
  l.release()
  await reconcile
  t.alike(await late, block(GONE), 'the late block did land on the clearing replica')
  await until(() => cleaning.length > 0, { name: 'late write seen' })
  await Promise.all(cleaning)
  await clearing.core.clear(GONE)
  t.absent(await clearing.core.has(GONE), 'the clearing replica settles without the block')

  const outcome = await asked
  t.comment('third peer during the window: ' + outcome + ', clearing replica uploaded it: ' + clearingSeen.upload.includes(GONE))
  l.destroy()

  const again = link(t, clearing.store, stale.store)
  await Promise.all([
    clearing.core.download({ start: 0, end: GONE }).done(),
    clearing.core.download({ start: GONE + 1, end: LENGTH }).done()
  ])
  await pause(300)
  await Promise.all(cleaning)
  t.absent(await clearing.core.has(GONE), 'and stays without it after a further sync with the stale peer')
  again.destroy()
})
