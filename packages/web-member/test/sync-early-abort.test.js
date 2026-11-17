'use strict'

// A stop during the local startup (a read or write preempting the run,
// sync.stop, the lease going idle) is honoured as soon as the own diary is
// open: the later startup steps are skipped, no socket is dialled, and the
// run settles with a valid result instead of waiting the startup out. The
// run is held at the 'groups' step with the test-only startupGate, or in the
// own tracker's first scan with a storage whose diary reads can be held.
const test = require('brittle')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { runSync } = require('../lib/sync')
const ops = require('../lib/member-ops')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const { member } = require('./helpers/sync-groups')

const GUARD_MS = 5000
// The startup steps after 'grupos' (startupWatchdog names).
const LATER_STEPS = ['leitura do próprio diário', 'seguidos (abertura)', 'conexão']
const RESULT_KEYS = ['ok', 'peers', 'seeders', 'admitted', 'rejected', 'downloaded', 'unadvertised', 'skipped', 'errors', 'errorsSoft', 'seederConfirmed']

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// A loopback port with nothing listening (bound, then released).
async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// A member's storage: the diary holds block 0 (with the cert) and `posts`
// posts after it.
async function memberStorage ({ posts = 0, assocKp = generateAssociationKeyPair() } = {}) {
  const storage = memoryNodeStorage()
  const ctx = { storage, association: hex(assocKp.publicKey), keyPair: crypto.keyPair() }
  const { publicKey } = await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: publicKey }, assocKp))
  for (let i = 0; i < posts; i++) await ops.postCreate(ctx, { text: 'post ' + i })
  return storage
}

// Copies the stored blocks of group core `key` from one storage to another
// and lists it as a group replica there (the core a follower of the group
// keeps from an earlier run).
async function storeGroupReplica (from, to, key) {
  const source = await store.openGroupCoreReadOnly(from, key)
  const target = await store.openGroupReplica(to, key)
  const a = source.replicate(true, { keepAlive: false })
  const b = target.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await target.download({ start: 0, end: source.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await source.close()
    await target.close()
  }
  await store.addGroupReplica(to, key)
}

// Rejects when p has not settled within GUARD_MS (a generous bound: the
// assertions are about order, not speed).
function within (p, label) {
  let timer
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ': not within ' + GUARD_MS + ' ms')), GUARD_MS)
  })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}

// The own diary is named 'diary' in the node storage (lib/node-store.js).
const DIARY = 'diary'

// Wraps a node storage so that the reads of the block file of the cores
// `match(name)` accepts (the own diary by default) can be held: once arm() is
// called, every read of such a core's 'data' file waits until release();
// reached resolves at the first held read, and touched lists the name of
// each core a read was attempted on since arm() (held or, after release(),
// let through), in order, once each. match(name, index) also gets the index
// of the open: how many times the core was opened since arm() (-1 before).
// random-access-storage queues a close behind the reads in flight, so a
// held read would keep the diary's close (the run's finally block) waiting
// whatever the run does: a close fails the held reads first, as a slow read
// in flight would answer before the close goes on. A held read failed by
// the close never runs, released or not. The wrapper is one object for the
// whole test (node-store keys shared cores by the storage object).
function latchedStorage (inner, { match = (name) => name === DIARY } = {}) {
  const touched = []
  const opens = new Map()
  const held = new Set()
  const patched = new WeakSet()
  const rams = new Set() // the patched files not yet released
  let armed = false
  let everArmed = false
  let released = false
  let reach
  const reached = new Promise((resolve) => { reach = resolve })
  const patch = (ram, name) => {
    if (patched.has(ram)) return ram
    patched.add(ram)
    const read = ram._read
    const close = ram.close
    ram._read = function (req) {
      if (everArmed && !touched.includes(name)) touched.push(name)
      if (!armed) return read.call(this, req)
      held.add(req)
      reach()
    }
    ram.close = function (cb) {
      for (const req of held) req.callback(new Error('Closed'))
      held.clear()
      return close.call(this, cb)
    }
    ram.release = () => {
      for (const req of held) read.call(ram, req)
      held.clear()
    }
    rams.add(ram)
    return ram
  }
  return {
    ...inner,
    core (name, opts) {
      const factory = inner.core(name, opts)
      let index = -1
      if (everArmed) {
        index = opens.get(name) || 0
        opens.set(name, index + 1)
      }
      if (!match(name, index)) return factory
      return (file) => file === 'data' ? patch(factory(file), name) : factory(file)
    },
    arm () { armed = true; everArmed = true },
    reached,
    touched,
    released: () => released,
    release () {
      armed = false
      released = true
      for (const ram of rams) ram.release()
      rams.clear()
    }
  }
}

// hold(point) arms a point; reached(point) resolves when the run waits
// there; release(point) lets it go on. calls lists every point the run
// passed, held or not.
function startupGate () {
  const points = {}
  const calls = []
  const point = (name) => {
    if (!points[name]) {
      let reach
      let release
      points[name] = {
        armed: false,
        reached: new Promise((resolve) => { reach = resolve }),
        gate: new Promise((resolve) => { release = resolve }),
        reach: () => reach(),
        release: () => release()
      }
    }
    return points[name]
  }
  return {
    calls,
    hold (name) { point(name).armed = true },
    reached: (name) => point(name).reached,
    release: (name) => point(name).release(),
    releaseAll () { for (const p of Object.values(points)) p.release() },
    async fn (name) {
      calls.push(name)
      const p = point(name)
      if (!p.armed) return
      p.armed = false
      p.reach()
      await p.gate
    }
  }
}

// Starts a run on storage (continuous unless once); every socket the run
// asks for is counted, onStep(name) sees each startup step after it is
// recorded. done resolves with { result } or { error }, never rejects.
async function start (t, storage, { ac = new AbortController(), gate = startupGate(), once = false, onStep = () => {} } = {}) {
  const port = await deadPort()
  const run = { ac, gate, sockets: 0, steps: [], lines: [], done: null }
  t.teardown(() => {
    gate.releaseAll()
    if (typeof storage.release === 'function') storage.release()
    ac.abort()
    return run.done
  }, { force: true })
  run.done = runSync({
    storage,
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      run.sockets++
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    signal: ac.signal,
    once,
    retryMinMs: 100,
    retryMaxMs: 200,
    startupGate: gate.fn,
    onStep: (name) => {
      run.steps.push(name)
      onStep(name)
    },
    log: (line) => { run.lines.push(line) }
  }).then((result) => ({ result }), (error) => ({ error }))
  return run
}

// A stopped continuous run ends ok with no errors; a stopped once run is
// judged as at its deadline with no seeder (sync.js timeoutOutcome).
function assertResult (t, outcome, { ok = true, errors = [] } = {}) {
  t.is(outcome.error, undefined, 'the run did not throw')
  const result = outcome.result
  t.ok(result !== null && typeof result === 'object', 'a result')
  t.alike(Object.keys(result).sort(), RESULT_KEYS.slice().sort(), 'the result keeps its shape')
  t.is(result.ok, ok, 'ok is ' + ok)
  t.alike(result.errors, errors, 'errors ' + JSON.stringify(errors))
  t.is(result.peers, 0, 'no peer')
}

// Several turns of the event loop: a rejection left unhandled by what just
// ran is reported ('unhandledRejection') before this resolves.
async function drainTurns () {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

// The unhandled rejections raised while fn runs and a few turns after. Only
// around code that cannot reject itself: the listener replaces the process
// crash that brittle relies on to fail a test whose function rejects.
async function unhandledDuring (fn) {
  const seen = []
  const onUnhandled = (reason) => { seen.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await fn()
    await drainTurns()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return seen
}

// A new run on storage gets through the whole local startup (diary, media,
// groups, own tracker) to the follow pass, then is stopped there: nothing
// an earlier run left open or locked is in its way.
async function runToFollows (t, storage) {
  const gate = startupGate()
  gate.hold('follows')
  const run = await start(t, storage, { gate })
  const reached = await within(Promise.race([
    gate.reached('follows').then(() => 'follows'),
    run.done.then((outcome) => outcome)
  ]), 'the new run reaches the follow pass')
  t.is(reached, 'follows', 'the new run reached the follow pass')
  t.ok(run.steps.includes('leitura do próprio diário'), 'the new run read its own diary')
  run.ac.abort()
  gate.release('follows')
  const outcome = await within(run.done, 'the new run settles')
  assertResult(t, outcome)
  t.absent(run.lines.some((line) => line.startsWith('erro')), 'no error logged')
}

// Holds a run at 'groups', aborts it there, then releases the gate: the run
// settles without any later startup step and without dialling.
async function abortAtGroups (t, storage) {
  const gate = startupGate()
  gate.hold('groups')
  const run = await start(t, storage, { gate })
  await within(gate.reached('groups'), 'the run reaches groups')
  run.ac.abort()
  gate.release('groups')
  const outcome = await within(run.done, 'the aborted run settles')
  assertResult(t, outcome)
  t.absent(gate.calls.includes('follows'), 'the follow pass is never reached')
  t.absent(gate.calls.includes('sweeps'), 'the sweeps are never reached')
  for (const step of LATER_STEPS) t.absent(run.steps.includes(step), 'no step ' + step)
  t.is(run.sockets, 0, 'no socket dialled')
  return run
}

test('abort at the groups step: the run settles without the rest of the startup', async (t) => {
  const storage = await memberStorage()
  await abortAtGroups(t, storage)
})

test('a signal aborted before the run: it settles without any startup step past the diary', async (t) => {
  const storage = await memberStorage()
  const ac = new AbortController()
  ac.abort()
  const run = await start(t, storage, { ac })
  const outcome = await within(run.done, 'the run settles')
  assertResult(t, outcome)
  t.alike(run.gate.calls, [], 'no startup gate point reached')
  for (const step of ['mídia própria', 'grupos', ...LATER_STEPS]) t.absent(run.steps.includes(step), 'no step ' + step)
  t.is(run.sockets, 0, 'no socket dialled')
})

test('after a run aborted at groups, a new run on the same storage opens cleanly', async (t) => {
  const storage = await memberStorage()
  await abortAtGroups(t, storage)
  await runToFollows(t, storage)
})

test('a once run aborted at the groups step: it settles as without a seeder, no socket dialled', async (t) => {
  const storage = await memberStorage()
  const gate = startupGate()
  gate.hold('groups')
  const run = await start(t, storage, { gate, once: true })
  await within(gate.reached('groups'), 'the run reaches groups')
  run.ac.abort()
  gate.release('groups')
  const outcome = await within(run.done, 'the aborted once run settles')
  assertResult(t, outcome, { ok: false, errors: ['sem pares'] })
  t.absent(gate.calls.includes('follows'), 'the follow pass is never reached')
  for (const step of LATER_STEPS) t.absent(run.steps.includes(step), 'no step ' + step)
  t.is(run.sockets, 0, 'no socket dialled')
})

test('abort fired at the own media step: the run settles and no later step runs', async (t) => {
  const storage = await memberStorage()
  const ac = new AbortController()
  const run = await start(t, storage, {
    ac,
    onStep: (name) => { if (name === 'mídia própria') ac.abort() }
  })
  const outcome = await within(run.done, 'the aborted run settles')
  assertResult(t, outcome)
  t.ok(run.steps.includes('mídia própria'), 'the own media step was reached')
  for (const step of ['grupos', ...LATER_STEPS]) t.absent(run.steps.includes(step), 'no step ' + step)
  t.alike(run.gate.calls, [], 'no startup gate point reached')
  t.is(run.sockets, 0, 'no socket dialled')
})

test('abort during the own tracker first scan: the run settles while the scan is held', async (t) => {
  // Block 0 is read (and cached) before the scan: the post is the block the
  // scan reads from storage.
  const storage = latchedStorage(await memberStorage({ posts: 1 }))
  const run = await start(t, storage, {
    onStep: (name) => { if (name === 'leitura do próprio diário') storage.arm() }
  })
  await within(storage.reached, 'the own scan reads a held block')
  run.ac.abort()
  const outcome = await within(run.done, 'the aborted run settles')
  t.absent(storage.released(), 'the run settled while the scan was still held')
  assertResult(t, outcome)
  t.absent(run.gate.calls.includes('follows'), 'the follow pass is never reached')
  for (const step of LATER_STEPS.slice(1)) t.absent(run.steps.includes(step), 'no step ' + step)
  t.is(run.sockets, 0, 'no socket dialled')
  // The held read was failed by the close: releasing it settles nothing
  // late into an unhandled rejection. Elsewhere one crashes the test.
  t.alike(await unhandledDuring(() => storage.release()), [], 'no unhandled rejection once the scan is released')
  await runToFollows(t, storage)
  t.alike(await unhandledDuring(() => {}), [], 'no unhandled rejection after the second run')
})

test('abort while the stored group replicas open: the run settles without reading the own diary', async (t) => {
  // A community created elsewhere, its root stored here as a replica: the
  // run opens it at startup, and would then read the whole own diary for
  // the roots it binds. The post is the diary block read from storage.
  const assocKp = generateAssociationKeyPair()
  const creator = await member(assocKp, 'Ana')
  const { community } = await ops.communityCreate(creator.ctx, { name: 'Bairro', join: 'open' })
  const storage = latchedStorage(await memberStorage({ posts: 1, assocKp }))
  await storeGroupReplica(creator.storage, storage, community)
  let diaryRead = false
  storage.reached.then(() => { diaryRead = true })
  const gate = startupGate()
  gate.hold('group-replicas')
  const run = await start(t, storage, { gate })
  await within(gate.reached('group-replicas'), 'the run opens the stored replicas')
  storage.arm()
  run.ac.abort()
  gate.release('group-replicas')
  const outcome = await within(run.done, 'the aborted run settles')
  t.absent(storage.released(), 'the run settled while the diary reads were still held')
  t.absent(diaryRead, 'no own diary block was read after the stop')
  assertResult(t, outcome)
  t.absent(gate.calls.includes('follows'), 'the follow pass is never reached')
  for (const step of LATER_STEPS) t.absent(run.steps.includes(step), 'no step ' + step)
  t.is(run.sockets, 0, 'no socket dialled')
  t.alike(await unhandledDuring(() => storage.release()), [], 'no unhandled rejection once the reads are released')
  t.ok(await store.groupCoreExists(storage, community), 'the stored replica is kept (no purge)')
  t.ok((await store.readGroupReplicas(storage)).includes(community), 'and still listed')
  await runToFollows(t, storage)
  t.alike(await unhandledDuring(() => {}), [], 'no unhandled rejection after the second run')
})

// Copies the diary of `from` to `to` as a stored replica, listed as a group
// diary (the replica the catalogue reads a member's joins from).
async function storeDiaryReplica (from, to) {
  const source = await store.openDiary(from.storage)
  const target = await store.openReplica(to.storage, from.ownHex)
  const a = source.replicate(true, { keepAlive: false })
  const b = target.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await target.download({ start: 0, end: source.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await source.close()
    await target.close()
  }
  await store.addGroupDiary(to.storage, from.ownHex)
}

// A community stored in the run's storage, with the diaries of its members as
// replicas: the run is member Bia, who either joined it (the root is Ana's,
// stored, and so is Ana's diary) or created it (`creator`: the root is hers).
// Bia keeps the writers of the `joiners` too. The catalogue of the community
// reads the diaries of the root's member, then each joiner's, as replicas
// opened afresh (a stored group core's block 0 is cached at startup, so only
// a diary replica's reads are sure to reach the storage). The own diary is
// read before any other when it is the root's, and last otherwise, from the
// cache either way.
// -> { bia, community, diaries } with the replica names, in the reading order.
async function communityWithDiaries (assocKp, { joiners = ['Caio', 'Duda'], creator = false } = {}) {
  const bia = await member(assocKp, 'Bia')
  const root = creator ? bia : await member(assocKp, 'Ana')
  const { community } = await ops.communityCreate(root.ctx, { name: 'Bairro', join: 'open' })
  const others = []
  if (!creator) {
    await storeGroupReplica(root.storage, bia.storage, community)
    await ops.communityJoin(bia.ctx, { community })
    await storeDiaryReplica(root, bia)
    others.push(root)
  }
  for (const name of joiners) {
    const m = await member(assocKp, name)
    await storeGroupReplica(root.storage, m.storage, community)
    await ops.communityJoin(m.ctx, { community })
    const key = (await store.readGroupWriters(m.storage)).find((e) => e.group === community).key
    await storeGroupReplica(m.storage, bia.storage, key)
    await storeDiaryReplica(m, bia)
    others.push(m)
  }
  return { bia, community, diaries: others.map((m) => 'replica/' + m.ownHex) }
}

// Holds the run in the community catalogue at the read of the diary replica
// diaries[at] (the reads of the later ones, and of the root's blocks, are
// held too: any attempt is recorded), aborts there, then releases: the run
// settles without reading anything the catalogue would read next.
async function abortInCatalogue (t, at, options) {
  const assocKp = generateAssociationKeyPair()
  const { bia, community, diaries } = await communityWithDiaries(assocKp, options)
  t.ok(at < diaries.length && new Set(diaries).size === diaries.length, 'distinct diaries, the held one among them')
  const held = new Set([...diaries.slice(at), 'group/' + community])
  const storage = latchedStorage(bia.storage, { match: (name) => held.has(name) })
  const gate = startupGate()
  gate.hold('group-replicas')
  const run = await start(t, storage, { gate })
  await within(gate.reached('group-replicas'), 'the run opens the stored replicas')
  storage.arm()
  gate.release('group-replicas')
  await within(storage.reached, 'the catalogue reads a held diary')
  t.alike(storage.touched, [diaries[at]], 'the diary at ' + at + ' is the one held')
  // The catalogue opened that diary itself: the run's close does not fail the
  // read, so the run settles once it is released, and must not go on to read
  // the other diaries or the root.
  run.ac.abort()
  const unhandled = await unhandledDuring(() => storage.release())
  const outcome = await within(run.done, 'the aborted run settles')
  t.alike(storage.touched, [diaries[at]], 'no later diary and no root block was read after the stop')
  t.alike(unhandled, [], 'no unhandled rejection once the read is released')
  assertResult(t, outcome)
  t.absent(run.gate.calls.includes('follows'), 'the follow pass is never reached')
  for (const step of LATER_STEPS) t.absent(run.steps.includes(step), 'no step ' + step)
  t.is(run.sockets, 0, 'no socket dialled')
  t.ok(await store.groupCoreExists(storage, community), 'the stored root is kept')
  await runToFollows(t, storage)
  t.alike(await unhandledDuring(() => {}), [], 'no unhandled rejection after the second run')
}

test('abort while the community catalogue reads its first diary: the later diaries are never read', async (t) => {
  await abortInCatalogue(t, 0)
})

test('abort while the community catalogue reads its last diary: the fold never reads the root', async (t) => {
  // The run created the community: its own diary is the first read (from
  // the cache), so the last stored diary is the last one.
  await abortInCatalogue(t, 1, { creator: true })
})

test('abort while the activation loop reads a binding diary: that core is closed, never watched', async (t) => {
  const assocKp = generateAssociationKeyPair()
  const { bia, community, diaries } = await communityWithDiaries(assocKp, { joiners: [] })
  // The root is a bound one (an earlier run proved it), so the live pass
  // does not read its creator's diary: only the activation loop does, after
  // the catalogue (the first open of that replica after the gate) read it.
  await store.addBoundRoot(bia.storage, community)
  const storage = latchedStorage(bia.storage, { match: (name, index) => name === diaries[0] && index === 1 })
  // The cores the run opens read-only, to see what is done with them.
  const opened = new Map()
  const open = store.openGroupCoreReadOnly
  store.openGroupCoreReadOnly = async (...args) => {
    const core = await open(...args)
    if (core !== null) {
      const entry = { downloads: 0 }
      const download = core.download
      core.download = function (...a) {
        entry.downloads++
        return download.apply(this, a)
      }
      opened.set(args[1], entry)
    }
    return core
  }
  t.teardown(() => { store.openGroupCoreReadOnly = open }, { force: true })
  const gate = startupGate()
  gate.hold('group-replicas')
  const run = await start(t, storage, { gate })
  await within(gate.reached('group-replicas'), 'the run opens the stored replicas')
  storage.arm()
  gate.release('group-replicas')
  await within(storage.reached, 'the activation loop reads the creator diary')
  t.ok(opened.has(community), 'the root core was opened read-only for the run')
  run.ac.abort()
  const unhandled = await unhandledDuring(() => storage.release())
  const outcome = await within(run.done, 'the aborted run settles')
  store.openGroupCoreReadOnly = open
  t.is(opened.get(community).downloads, 0, 'the root core was never put to download')
  t.alike(unhandled, [], 'no unhandled rejection once the read is released')
  assertResult(t, outcome)
  t.absent(run.gate.calls.includes('follows'), 'the follow pass is never reached')
  for (const step of LATER_STEPS) t.absent(run.steps.includes(step), 'no step ' + step)
  t.is(run.sockets, 0, 'no socket dialled')
  t.ok(await store.groupCoreExists(storage, community), 'the stored root is kept')
  await runToFollows(t, storage)
  t.alike(await unhandledDuring(() => {}), [], 'no unhandled rejection after the second run')
})
