'use strict'

// The session's device upkeep pass: a second device of the same account
// enrols by itself in the roots its diary binds, the creator's device hands
// its epoch keys to the new writers, and the pass stays bounded. RPC and
// storage are real; the sync boundary is replaced so each run's events are
// driven by hand. Cores move between storages by direct replication.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { createBrowserSession } = require('../lib/session')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')
const grp = require('@varanda/core/lib/group')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const { connectClient } = require('./helpers/session')
const { until } = require('./helpers/net')

const hex = (buf) => b4a.toString(buf, 'hex')
const KEY = 'ab'.repeat(32)
const UPKEEP_WARNING = 'aviso: participação automática neste aparelho não concluída'
const MAX_UPKEEP_PASSES = 3
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A device of the account `keyPair` / `prf`. `storage` already holding a
// diary (a second device's copy) gets no certificate: one would fork it.
async function setup (t, { assoc = generateAssociationKeyPair(), factory = createBrowserNode, writeGate = false, storage = memoryNodeStorage(), keyPair = crypto.keyPair(), prf = crypto.randomBytes(32), upkeepDelayMs } = {}) {
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const key = hex(keyPair.publicKey)
  if (!(await store.diaryStatus(storage)).exists) {
    await ops.idCreate(ctx)
    await ops.certAdd(ctx, createCert({ member: key }, assoc))
  }
  const internal = []
  const node = factory({
    storage,
    association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate,
    upkeepDelayMs,
    onInternalError: (err) => internal.push(err)
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node)
  return { node, web, ctx, key, keyPair, prf, assoc, association, storage, internal }
}

async function pipe (source, target) {
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
}

async function copyCore (from, to, key) {
  await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to.storage, key))
  await store.addGroupReplica(to.storage, key)
}

// The own diary of a sibling device brought up to date, as the sync does.
async function syncDiary (from, to) {
  await pipe(await store.openDiary(from.storage), await store.openDiary(to.storage))
}

// A fresh storage for a second device of `s`: idCreate only, then `s`'s
// diary and the cores `keys`.
async function secondStorage (s, keys) {
  const storage = memoryNodeStorage()
  await ops.idCreate({ storage, association: s.association, keyPair: s.keyPair })
  await syncDiary(s, { storage })
  for (const key of keys) await copyCore(s, { storage }, key)
  await store.addGroupDiary(storage, s.key)
  return storage
}

// Reload only the transport and session while substituting the sync boundary.
// Restoring the cache keeps all other tests on the production modules.
function nodeWithSync (runSync) {
  const sync = require('../lib/sync')
  const original = sync.runSync
  const ids = [require.resolve('../lib/node'), require.resolve('../lib/session')]
  const cached = ids.map((id) => require.cache[id])
  try {
    sync.runSync = runSync
    for (const id of ids) delete require.cache[id]
    return require('../lib/node').createBrowserNode
  } finally {
    sync.runSync = original
    ids.forEach((id, i) => { require.cache[id] = cached[i] })
  }
}

// failOnAbort(index): run `index` ends with an error when stopped (the
// session then drops the continuous intent).
function controlledSync ({ failOnAbort = () => false } = {}) {
  const runs = []
  const factory = nodeWithSync(async ({ storage, onEvent, signal, once }) => {
    let finish
    const done = new Promise((resolve) => { finish = resolve })
    const result = { ok: true, errors: [], peers: 1, seederConfirmed: true }
    const fails = failOnAbort(runs.length)
    const stop = () => finish(fails ? null : result)
    signal.addEventListener('abort', stop)
    if (signal.aborted) stop()
    const writers = new Map()
    for (const entry of await store.readGroupWriters(storage)) {
      for (const key of new Set([entry.key, ...(entry.rootNonce === null ? [] : [entry.group])])) {
        const core = await store.openGroupCoreReadOnly(storage, key)
        if (core === null) continue
        try { writers.set(key, core.length) } finally { await core.close() }
      }
    }
    const r = { once, writers, emit: onEvent, finish: stop, get aborted () { return signal.aborted } }
    runs.push(r)
    let out
    try { out = await done } finally { signal.removeEventListener('abort', stop) }
    if (out === null) throw new Error('falha simulada da sincronização')
    return out
  })
  return {
    runs,
    factory,
    async next (index) {
      await until(() => runs[index], { name: 'sync run ' + index, timeoutMs: 5000 })
      return runs[index]
    }
  }
}

async function diaryLength (s) {
  const core = await store.openDiary(s.storage)
  try { return core.length } finally { await core.close() }
}

async function diaryRecords (s) {
  const core = await store.openDiary(s.storage)
  try { return (await store.readAll(core)).map((e) => e.record) } finally { await core.close() }
}

async function coreRecords (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try { return (await store.readAll(core)).map((e) => e.record) } finally { await core.close() }
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

const changedOf = (s) => s.web.events.filter((e) => e.name === 'groups.changed').map((e) => e.data.group)
const warningsOf = (s) => s.web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)

// A's community through its RPC, and a second device B of A holding A's
// diary and `roots` (both roots unless told otherwise), on a controlled sync.
async function account (t, { roots = true, upkeepDelayMs = 20 } = {}) {
  const a = await setup(t)
  const { community, group } = await a.web.request('community.create', { name: 'Bairro', join: 'open' })
  const sync = controlledSync()
  const storage = await secondStorage(a, roots ? [community, group] : [])
  const b = await setup(t, { assoc: a.assoc, keyPair: a.keyPair, prf: a.prf, storage, factory: sync.factory, upkeepDelayMs })
  return { a, b, sync, community, group }
}

test('the upkeep adds no RPC method', async (t) => {
  const browser = createBrowserSession({ storage: memoryNodeStorage(), association: KEY, seederUrl: 'ws://127.0.0.1:9/seeder', createSocket: () => null })
  t.teardown(() => browser.close(), { force: true })
  t.absent(Object.keys(browser.handlers).some((name) => /upkeep/i.test(name)))
})

test('a second device enrols by itself after its diary is synced', async (t) => {
  const { b, sync, community, group } = await account(t)
  const before = await diaryLength(b)
  t.alike(await store.readGroupWriters(b.storage), [], 'nothing here yet')

  await b.web.request('sync.start')
  const live = await sync.next(0)
  live.emit({ event: 'own-synced', length: before })
  await until(() => live.aborted, { name: 'the pass preempts the run', timeoutMs: 5000 })
  await until(async () => (await store.readGroupWriters(b.storage)).length === 2, { name: 'CW and Geral writer', timeoutMs: 5000 })
  const kv = await store.readGroupWriters(b.storage)
  const cw = kv.find((e) => e.group === community)
  t.is(cw.kind, 'community', 'a community writer')
  t.is(cw.rootNonce, null, 'not a root')
  t.ok(kv.find((e) => e.group === group), 'a Geral writer')

  const restarted = await sync.next(1)
  t.is(restarted.once, false, 'the continuous run restarts after the pass')
  t.ok(changedOf(b).includes(community) && changedOf(b).includes(group), 'groups.changed for the community and Geral')
  const records = await diaryRecords(b)
  t.is(records.length, before + 2, 'the diary grew by exactly two')
  const joins = records.slice(-2)
  t.alike(joins.map((r) => [r.type, r.group, r.on]), [['group-join', community, true], ['group-join', group, true]])

  // The echo of the pass's own write and the groups it changed: nothing to do.
  restarted.emit({ event: 'own-synced', length: before + 2 })
  restarted.emit({ event: 'groups-changed', group: community })
  restarted.emit({ event: 'groups-changed', group })
  await pause(200)
  t.is(sync.runs.length, 2, 'no further pass stops the run')
  t.absent(restarted.aborted)
  t.alike(await store.readGroupWriters(b.storage), kv, 'kv unchanged: no second CW')

  const info = await b.web.request('community.info', { community })
  t.alike([info.writerHere, info.canWrite, info.rootHere], [true, true, false])
  t.alike(warningsOf(b).filter((l) => l === UPKEEP_WARNING), [])
  await b.web.request('sync.stop')
  t.alike(b.internal, [])
})

test('the pass is bounded and never loops', async (t) => {
  const { b, sync } = await account(t, { roots: false })
  const length = await diaryLength(b)
  await b.web.request('sync.start')
  const first = await sync.next(0)
  first.emit({ event: 'own-synced', length })
  let current = await sync.next(1)
  t.ok(first.aborted, 'pass 1 planned under the store')
  // A burst coalesces into one pass.
  for (let i = 0; i < 3; i++) current.emit({ event: 'groups-changed', group: KEY })
  current = await sync.next(2)
  current.emit({ event: 'groups-changed', group: KEY })
  current = await sync.next(3)
  current.emit({ event: 'groups-changed', group: KEY })
  current.emit({ event: 'own-synced', length })
  await pause(150)
  t.is(sync.runs.length, 1 + MAX_UPKEEP_PASSES, 'at most MAX_UPKEEP_PASSES preemptions')
  t.absent(current.aborted)

  // A settled run re-arms once.
  current.emit({ event: 'settled', settled: true, mediaPending: false })
  current = await sync.next(4)
  current.emit({ event: 'settled', settled: true, mediaPending: false })
  current.emit({ event: 'groups-changed', group: KEY })
  current = await sync.next(5)
  current.emit({ event: 'groups-changed', group: KEY })
  current = await sync.next(6)
  current.emit({ event: 'settled', settled: true, mediaPending: false })
  current.emit({ event: 'groups-changed', group: KEY })
  await pause(150)
  t.is(sync.runs.length, 7, 'one re-arming per arming')
  t.absent(current.aborted)
  t.alike(await store.readGroupWriters(b.storage), [], 'nothing written')
  t.is(await diaryLength(b), length)
  t.alike(warningsOf(b).filter((l) => l === UPKEEP_WARNING), [], 'a plan with nothing to do is no failure')
  await b.web.request('sync.stop')
  t.alike(b.internal, [])
})

test('a user\'s once run defers the pass', async (t) => {
  const { b, sync, community } = await account(t, { upkeepDelayMs: 150 })
  await b.web.request('sync.start')
  const live = await sync.next(0)
  live.emit({ event: 'own-synced', length: await diaryLength(b) })
  await b.web.request('sync.stop')
  await b.web.request('sync.start', { once: true })
  const once = await sync.next(1)
  t.is(once.once, true)
  await pause(400)
  t.absent(once.aborted, 'the recovery run is not preempted')
  t.is(await ownWriter(b, community), null, 'nothing written while it runs')
  once.finish()
  await until(async () => (await ownWriter(b, community)) !== null, { name: 'the deferred pass', timeoutMs: 5000 })
  t.is(sync.runs.length, 2, 'no run started for it')
  t.alike(b.internal, [])
})

test('locked: no pass, and the unlock lets the next own-synced arm', async (t) => {
  const { b, sync, community } = await account(t)
  await b.node.clearKeyPair()
  await b.web.request('sync.start')
  const live = await sync.next(0)
  const length = await diaryLength(b)
  live.emit({ event: 'own-synced', length })
  await pause(150)
  t.absent(live.aborted, 'no pass while locked')
  t.is(sync.runs.length, 1)
  t.alike(await store.readGroupWriters(b.storage), [])

  await b.node.setKeyPair(b.keyPair, { prf: b.prf })
  live.emit({ event: 'own-synced', length })
  await until(async () => (await ownWriter(b, community)) !== null, { name: 'the pass after the unlock', timeoutMs: 5000 })
  t.ok(live.aborted)
  await b.web.request('sync.stop')
  t.alike(b.internal, [])
})

test('automatic re-share on the creator\'s device after its diary grows', async (t) => {
  // Built through the RPC without the gate, then reopened with it.
  const a0 = await setup(t)
  const { community, group: general } = await a0.web.request('community.create', { name: 'Bairro', join: 'open' })
  const { group: P } = await a0.web.request('group.create', { name: 'Segredo', join: 'approval', visibility: 'private', community })
  await a0.web.request('group.post', { group: P, text: 'antes do aparelho' })
  await a0.node.close()

  const sync = controlledSync()
  const a = await setup(t, { assoc: a0.assoc, storage: a0.storage, keyPair: a0.keyPair, prf: a0.prf, factory: sync.factory, writeGate: true, upkeepDelayMs: 20 })
  await a.web.request('sync.start')
  const first = await sync.next(0)
  first.emit({ event: 'own-synced', length: await diaryLength(a) })
  const live = await sync.next(1)
  t.ok(first.aborted, 'one pass with nothing to do')

  // A second device enrols (member-ops, tested on its own) and its diary
  // and writers reach the first device, as the sync brings them.
  const storage = await secondStorage(a, [community, general, P])
  const keys = createGroupKeys()
  await keys.unlock(storage, a.prf)
  t.teardown(() => keys.close())
  const d = { storage, ctx: { storage, association: a.association, keyPair: a.keyPair, groupKeyPair: a.ctx.groupKeyPair, groupKeys: keys } }
  const res = await ops.deviceUpkeep(d.ctx, await ops.deviceUpkeepPlan(d.ctx))
  t.alike(res.failed, [])
  const dw = await ownWriter(d, P)
  t.ok(dw !== null, 'the second device holds a writer in P')
  await syncDiary(d, a)
  for (const key of [await ownWriter(d, community), await ownWriter(d, general), dw]) await copyCore(d, a, key)
  const firstKeys = (await coreRecords(a, P)).filter((r) => r.type === 'group-key' && r.kid === null).length
  const before = (await coreRecords(a, P)).length
  const grown = await diaryLength(a)

  live.emit({ event: 'own-synced', length: grown })
  const gate = await sync.next(2)
  t.is(gate.once, true, 'the write gate')
  gate.emit({ event: 'own-synced', length: grown })
  gate.emit({ event: 'group-synced', key: P, length: gate.writers.get(P) })
  const restarted = await sync.next(3)
  t.is(restarted.once, false, 'the continuous run restarts to push')
  t.ok(restarted.writers.get(P) > before, 'the push carries the root\'s new length')

  const recs = await coreRecords(a, P)
  t.is(recs.filter((r) => r.type === 'group-key' && r.kid === null).length, firstKeys, 'no rotation')
  t.ok(recs.some((r) => r.type === 'group-key' && r.kid !== null && r.keys.some((k) => k.writer === dw)), 'continuation blocks name the second device\'s writer')
  t.ok(changedOf(a).includes(P), 'groups.changed for P')
  t.is(await diaryLength(a), grown, 'a re-share writes no diary record')

  restarted.emit({ event: 'own-synced', length: grown })
  await pause(150)
  t.is(sync.runs.length, 4, 'the same length starts no pass')
  t.absent(restarted.aborted)
  await a.web.request('sync.stop')
  t.alike(a.internal, [])
})

test('an unlock during a live run arms from its last own length, with no new own-synced', async (t) => {
  const { b, sync, community, group } = await account(t)
  await b.node.clearKeyPair()
  await b.web.request('sync.start')
  const live = await sync.next(0)
  live.emit({ event: 'own-synced', length: await diaryLength(b) })
  await pause(150)
  t.absent(live.aborted, 'no pass while locked')

  // The link reports each length once: nothing is emitted after the unlock.
  await b.node.setKeyPair(b.keyPair, { prf: b.prf })
  await until(async () => (await ownWriter(b, group)) !== null, { name: 'the pass after the unlock', timeoutMs: 5000 })
  t.ok(live.aborted, 'the pass preempted the live run')
  t.ok((await ownWriter(b, community)) !== null)
  await b.web.request('sync.stop')
  t.alike(b.internal, [])
})

test('a failed pass queues another one, bounded', async (t) => {
  const { b, sync } = await account(t)
  const original = ops.deviceUpkeepPlan
  let calls = 0
  ops.deviceUpkeepPlan = async () => {
    calls++
    throw new Error('falha simulada')
  }
  t.teardown(() => { ops.deviceUpkeepPlan = original })
  await b.web.request('sync.start')
  const live = await sync.next(0)
  live.emit({ event: 'own-synced', length: await diaryLength(b) })
  await until(() => calls === MAX_UPKEEP_PASSES, { name: 'the retries', timeoutMs: 5000 })
  await pause(200)
  t.is(calls, MAX_UPKEEP_PASSES, 'no pass beyond the bound')
  t.is(warningsOf(b).filter((l) => l === UPKEEP_WARNING).length, MAX_UPKEEP_PASSES, 'one warning per failed pass')
  t.alike(await store.readGroupWriters(b.storage), [], 'nothing written')
  ops.deviceUpkeepPlan = original
  await b.web.request('sync.stop')
  t.alike(b.internal, [])
})

test('a root the write gate brings in is enrolled by a further pass', async (t) => {
  const a = await setup(t)
  const { community, group: general } = await a.web.request('community.create', { name: 'Bairro', join: 'open' })
  const sync = controlledSync()
  const storage = await secondStorage(a, [community, general])
  const b = await setup(t, { assoc: a.assoc, keyPair: a.keyPair, prf: a.prf, storage, factory: sync.factory, writeGate: true, upkeepDelayMs: 20 })
  await b.web.request('sync.start')
  const first = await sync.next(0)
  first.emit({ event: 'own-synced', length: await diaryLength(b) })

  // Planned: the community and Geral. While the gate runs, the first device
  // creates Feira and its diary join reaches this device.
  const gate = await sync.next(1)
  t.is(gate.once, true, 'the write gate')
  const { group: feira } = await a.web.request('group.create', { name: 'Feira', join: 'open', community })
  await syncDiary(a, b)
  await copyCore(a, b, community)
  await copyCore(a, b, feira)
  gate.emit({ event: 'own-synced', length: await diaryLength(b) })

  const restarted = await sync.next(2)
  t.is(restarted.once, false)
  t.ok((await ownWriter(b, community)) !== null && (await ownWriter(b, general)) !== null, 'the planned roots')
  t.is(await ownWriter(b, feira), null, 'Feira was not in the plan')
  restarted.emit({ event: 'own-synced', length: await diaryLength(b) })

  const gate2 = await sync.next(3)
  t.is(gate2.once, true, 'a further pass')
  gate2.emit({ event: 'own-synced', length: await diaryLength(b) })
  await until(async () => (await ownWriter(b, feira)) !== null, { name: 'Feira enrolled', timeoutMs: 5000 })
  await sync.next(4)
  await b.web.request('sync.stop')
  t.alike(b.internal, [])
})

test('a reconnected client\'s first own-synced arms afresh at the same length', async (t) => {
  const { b, sync, community } = await account(t)
  await b.web.request('sync.start')
  const live = await sync.next(0)
  live.emit({ event: 'own-synced', length: await diaryLength(b) })
  const restarted = await sync.next(1)
  await until(async () => (await ownWriter(b, community)) !== null, { name: 'the first pass', timeoutMs: 5000 })
  const length = await diaryLength(b)
  restarted.emit({ event: 'own-synced', length })
  await pause(150)
  t.absent(restarted.aborted, 'the echo is no new length')

  b.web = await connectClient(b.node)
  await until(() => restarted.aborted, { name: 'the detach stops the run', timeoutMs: 5000 })
  await b.web.request('sync.start')
  const again = await sync.next(2)
  again.emit({ event: 'own-synced', length })
  await until(() => again.aborted, { name: 'a pass after the reconnect', timeoutMs: 5000 })
  t.pass('the same length armed again')
  await sync.next(3)
  await b.web.request('sync.stop')
  t.alike(b.internal, [])
})

// Counts deviceUpkeepPlan calls (each is one pass).
function countPlans (t) {
  const original = ops.deviceUpkeepPlan
  const counter = { calls: 0 }
  ops.deviceUpkeepPlan = async (...args) => {
    counter.calls++
    return original(...args)
  }
  t.teardown(() => { ops.deviceUpkeepPlan = original })
  return counter
}

test('a per-root failure queues another pass, bounded', async (t) => {
  const { b, sync, community } = await account(t)
  const original = ops.deviceUpkeep
  let calls = 0
  ops.deviceUpkeep = async () => {
    calls++
    return { enrolled: [], shared: [], failed: [{ root: community, message: 'falha simulada' }], changed: [] }
  }
  t.teardown(() => { ops.deviceUpkeep = original })
  await b.web.request('sync.start')
  const live = await sync.next(0)
  live.emit({ event: 'own-synced', length: await diaryLength(b) })
  await until(() => calls === MAX_UPKEEP_PASSES, { name: 'the retries', timeoutMs: 5000 })
  await pause(200)
  t.is(calls, MAX_UPKEEP_PASSES, 'no pass beyond the bound')
  t.is(warningsOf(b).filter((l) => l === UPKEEP_WARNING).length, MAX_UPKEEP_PASSES)
  ops.deviceUpkeep = original
  await b.web.request('sync.stop')
  t.alike(b.internal, [])
})

test('a group-writer event arms the pass afresh, once per writer key', async (t) => {
  const { b, sync, community, group } = await account(t)
  await b.web.request('sync.start')
  const live = await sync.next(0)
  live.emit({ event: 'own-synced', length: await diaryLength(b) })
  const restarted = await sync.next(1)
  await until(async () => (await ownWriter(b, group)) !== null, { name: 'the first pass', timeoutMs: 5000 })
  restarted.emit({ event: 'own-synced', length: await diaryLength(b) })
  await pause(150)
  t.absent(restarted.aborted, 'disarmed: nothing left to do')

  const plans = countPlans(t)
  const writer = hex(crypto.randomBytes(32))
  restarted.emit({ event: 'group-writer', group: community, writer })
  const next = await sync.next(2)
  t.ok(restarted.aborted, 'the new writer armed a pass')
  t.is(plans.calls, 1)
  next.emit({ event: 'group-writer', group: community, writer })
  await pause(150)
  t.absent(next.aborted, 'the same writer key arms nothing')
  t.is(plans.calls, 1)
  next.emit({ event: 'group-writer', group: community, writer: hex(crypto.randomBytes(32)) })
  await sync.next(3)
  t.is(plans.calls, 2, 'another writer arms again')
  await b.web.request('sync.stop')
  t.alike(b.internal, [])
})

test('a step that throws after writing still sends groups.changed and pushes', async (t) => {
  const a = await setup(t)
  const { community, group } = await a.web.request('community.create', { name: 'Bairro', join: 'open' })
  // The continuous run fails when the pass stops it: no continuous run
  // will push afterwards.
  const sync = controlledSync({ failOnAbort: (i) => i === 0 })
  const storage = await secondStorage(a, [community, group])
  const b = await setup(t, { assoc: a.assoc, keyPair: a.keyPair, prf: a.prf, storage, factory: sync.factory, writeGate: true, upkeepDelayMs: 20 })
  const original = ops.deviceUpkeep
  ops.deviceUpkeep = async (...args) => {
    await original(...args)
    throw new Error('falha depois da escrita')
  }
  t.teardown(() => { ops.deviceUpkeep = original })
  const before = await diaryLength(b)
  await b.web.request('sync.start')
  const live = await sync.next(0)
  live.emit({ event: 'own-synced', length: before })
  const gate = await sync.next(1)
  t.is(gate.once, true, 'the write gate')
  gate.emit({ event: 'own-synced', length: before })
  const push = await sync.next(2)
  t.is(push.once, true, 'a push run after the throw')
  t.ok(push.writers.has(await ownWriter(b, community)), 'it carries the new writer')
  push.finish()
  t.ok(await diaryLength(b) > before, 'the step wrote')
  t.ok(changedOf(b).includes(community) && changedOf(b).includes(group), 'groups.changed for the planned roots')
  await until(() => warningsOf(b).includes(UPKEEP_WARNING), { name: 'the warning', timeoutMs: 5000 })
  ops.deviceUpkeep = original
  t.alike(b.internal.map((e) => e.message), ['falha simulada da sincronização'], 'only the simulated run failure')
})

test('roots skipped for good disarm the upkeep', async (t) => {
  const a0 = await setup(t)
  const { community, group } = await a0.web.request('community.create', { name: 'Bairro', join: 'open' })
  await a0.node.close()
  // Five more bound writers in each root: six of eight, the reserve.
  const extra = []
  for (const [root, member, kind] of [[community, null, true], [group, community, false]]) {
    for (let i = 0; i < 5; i++) {
      const kp = await a0.ctx.groupKeyPair(new Uint8Array(crypto.randomBytes(32)))
      const core = await store.openGroupWriter(a0.storage, kp)
      try { await store.appendGroupRecord(core, grp.writerHeader({ group: root, diary: a0.key, member }), { root: false, community: kind }) } finally { await core.close() }
      const key = hex(kp.publicKey)
      await store.addGroupReplica(a0.storage, key)
      const diary = await store.openDiary(a0.storage, a0.keyPair)
      try { await store.appendRecord(diary, groupJoinRecord({ group: root, writer: key, on: true })) } finally { await diary.close() }
      extra.push(key)
    }
  }
  const sync = controlledSync()
  const storage = await secondStorage(a0, [community, group, ...extra])
  const b = await setup(t, { assoc: a0.assoc, keyPair: a0.keyPair, prf: a0.prf, storage, factory: sync.factory, upkeepDelayMs: 20 })
  const plans = countPlans(t)
  await b.web.request('sync.start')
  const live = await sync.next(0)
  live.emit({ event: 'own-synced', length: await diaryLength(b) })
  const restarted = await sync.next(1)
  t.is(plans.calls, 1, 'one pass')
  restarted.emit({ event: 'groups-changed', group: community })
  restarted.emit({ event: 'groups-changed', group })
  await pause(200)
  t.absent(restarted.aborted, 'disarmed: reserve skips never resolve by a sync')
  t.is(plans.calls, 1)
  t.alike(await store.readGroupWriters(b.storage), [])
  await b.web.request('sync.stop')
  t.alike(b.internal, [])
})
