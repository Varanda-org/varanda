// A purge racing a peer's replication open of the same key, and a group
// core retry moved out of seeder-groups-waits.test.js (each file stays short).

const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { joinAndFlush, topicFor } = require('../lib/net')
const { groupJoinRecord } = require('../lib/records')
const { groupHeader, groupPost } = require('../lib/group')
const {
  hex,
  makeAssociation,
  prepareSeederDir,
  startSeeder,
  member,
  admit,
  admitted,
  rejected,
  downloaded,
  scansDone,
  encode,
  creatorAndMember
} = require('./helpers/seeder-groups')

const noop = () => {}

function deferred () {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A stored core of the seeder's main store, closed again (as when a purge
// starts), and a replication stream with no remote side yet.
async function storedCoreAndStream (t, seeder) {
  const store = seeder.store
  const core = store.get({ name: 'purge-race' })
  await core.ready()
  await core.append(b4a.from('oi'))
  const key = hex(core.key)
  const dk = core.discoveryKey
  await core.close()
  const stream = store.replicate(true)
  stream.on('error', noop)
  t.teardown(() => stream.destroy())
  return { store, storage: store.storage, key, dk, stream, muxer: stream.noiseStream.userData }
}

// What protomux does with a discovery key a peer asks for: an error from
// the open is rethrown outside any handler and exits the process, so these
// tests fail by crashing.
function peerAsks (store, muxer, dk) {
  return store._attachMaybe(muxer, dk).catch((err) => muxer._safeDestroyBound(err))
}

test('the replication open the purge guard wraps still exists in corestore', async (t) => {
  t.is(typeof Corestore.prototype._attachMaybe, 'function', 'corestore keeps _attachMaybe')
  t.ok(Corestore.prototype.replicate.toString().includes('_attachMaybe'), 'and replication still opens through it')
})

test('a peer asking for a key while its purge deletes the storage is not attached and nothing throws', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const { store, storage, key, dk, stream, muxer } = await storedCoreAndStream(t, seeder)
  t.not(store._attachMaybe, Corestore.prototype._attachMaybe, 'the seeder store guards its replication opens')

  // The peer's open, if it happened, would read the core while the delete
  // commits: the open is held until the delete is done.
  const resumeCore = storage.resumeCore
  const deleteCore = storage.deleteCore
  const resumed = deferred()
  const deleted = deferred()
  let deleting = false
  let opens = 0
  storage.resumeCore = async function (d) {
    const r = await resumeCore.call(storage, d)
    if (deleting && d && b4a.equals(d, dk)) {
      opens++
      resumed.resolve()
      await deleted.promise
    }
    return r
  }
  let asked = null
  storage.deleteCore = async function (ptr) {
    deleting = true
    asked = peerAsks(store, muxer, dk)
    await Promise.race([resumed.promise, sleep(500)])
    try {
      return await deleteCore.call(storage, ptr)
    } finally {
      deleted.resolve()
    }
  }
  try {
    await seeder._purge(key)
    await asked
    await sleep(200)
  } finally {
    storage.resumeCore = resumeCore
    storage.deleteCore = deleteCore
  }
  t.is(opens, 0, 'the key was not opened during the delete')
  t.absent(store.cores.opened(hex(dk)), 'nor is it open now')
  t.absent(stream.destroyed, 'the stream stays up')
  t.absent(await storage.hasCore(dk), 'the storage reports the core gone')
  t.is(seeder._purgingKeys.size, 0, 'the purge mark is cleared')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a purge lets a peer\'s open already in flight for its key settle before deleting', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const { store, storage, key, dk, stream, muxer } = await storedCoreAndStream(t, seeder)

  // Once the store let go of the closed core, the peer's open checks the
  // storage and is held right after it found the core stored.
  await until(() => !store.cores.opened(hex(dk)), { name: 'núcleo liberado', timeoutMs: 20000 })
  const hasCore = storage.hasCore
  const deleteCore = storage.deleteCore
  const checked = deferred()
  const release = deferred()
  let held = false
  storage.hasCore = async function (d, opts) {
    const r = await hasCore.call(storage, d, opts)
    if (!held && d && b4a.equals(d, dk)) {
      held = true
      checked.resolve()
      await release.promise
    }
    return r
  }
  let deletes = 0
  storage.deleteCore = function (ptr) {
    deletes++
    return deleteCore.call(storage, ptr)
  }
  try {
    const asked = peerAsks(store, muxer, dk)
    await checked.promise
    const purged = seeder._purge(key)
    await sleep(300)
    t.is(deletes, 0, 'the delete waits for the open in flight')
    release.resolve()
    await asked
    await purged
    await sleep(200)
  } finally {
    storage.hasCore = hasCore
    storage.deleteCore = deleteCore
  }
  t.is(deletes, 1, 'then the purge deletes the core')
  t.absent(stream.destroyed, 'the stream stays up')
  t.absent(await storage.hasCore(dk), 'the storage reports the core gone')
  t.is(seeder._attaching.size, 0, 'no open is left tracked')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a join naming a core nobody serves holds its group\'s pages back until its retry also times out', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Praça' }))
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  await admit(A, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 1)
  // F joins A's group with a writer nobody holds.
  const X = hex(signingKeyPair().publicKey)
  const F = await member(t, bootstrap, assoc, async () => [groupJoinRecord({ group: R, writer: X, on: true })])
  await admit(F, assoc)
  await rejected(events, X, 'timeout')
  t.is(seeder.indexGroup(R).complete, false, 'missed once: incomplete until retried')
  // The timer retries X past its first wait; that retry times out too.
  await until(() => seeder._groupBackoff.get(F.key + ':' + X).step === 1, { name: 'segunda espera de X', timeoutMs: 40000 })
  await until(() => seeder.indexGroup(R).complete && scansDone(seeder), { name: 'R completo' })

  // Retried past its wait: the page stays complete during the new fetch.
  seeder._groupBackoff.get(F.key + ':' + X).until = 0
  seeder._retryGroups(null)
  t.ok(seeder._groupReserved.has(X), 'X fetched again')
  t.is(seeder.indexGroup(R).complete, true, 'the group page does not wait for X')
  t.is(seeder.indexGroupSearch('praca').complete, true, 'nor does group search')
  t.is(seeder.indexGroups(F.key).complete, true, 'nor F\'s group list')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a group core whose header keeps missing the main store after every quarantine pass advances its wait, so its group stops waiting for it', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, groupHeaderTimeoutMs: 1500 })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  // The quarantine gets W's block 0 every time; the main store's check of it
  // never passes (a peer withholding block 0 from the main store only).
  const gateGroup = seeder._gateGroup.bind(seeder)
  seeder._gateGroup = (key, entry) => key === W ? undefined : gateGroup(key, entry)
  await admit(A, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 2)
  await admit(B, assoc)
  const id = B.key + ':' + W
  const passes = () => events.filter((e) => e.event === 'group-admitted' && e.key === W).length
  await until(() => passes() >= 2 && seeder._groupBackoff.has(id) && seeder._groupBackoff.get(id).step >= 1, { name: 'segunda espera de W depois de duas quarentenas', timeoutMs: 30000 })
  t.ok(passes() >= 2, 'the quarantine passed again')
  t.is(seeder._groupBackoff.get(id).reason, 'timeout', 'the header deadline grows the wait')
  await until(() => seeder.indexGroup(R).complete && scansDone(seeder), { name: 'R completo', timeoutMs: 20000 })
  // Admitted again and awaiting its header: the page no longer waits for it.
  await until(() => {
    const e = seeder._groupServed.get(W)
    return e && !e.dropped && !e.headerOk
  }, { name: 'W servido de novo sem cabeçalho', timeoutMs: 30000 })
  t.ok(seeder._groupBackoff.has(id), 'the wait stays while W awaits its header')
  t.is(seeder.indexGroup(R).complete, true, 'the group page does not wait for W')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a writer row carries its signed length next to its contiguous one, and a hole in that writer does not hold the group page incomplete', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await downloaded(seeder, R, 2)
  await downloaded(seeder, W, 3)
  await until(() => scansDone(seeder) && seeder.indexGroup(R).complete, { name: 'R completo' })

  // B signs two posts offline and drops the first before it is back on the
  // swarm: the seeder can fetch the second, never the first.
  await B.swarm.leave(topicFor(assoc.hex))
  for (const c of [...B.swarm.connections]) c.destroy()
  await until(() => B.swarm.connections.size === 0, { name: 'B desconectado' })
  await B.cores.w.append(encode(groupPost({ text: 'retido' })))
  await B.cores.w.append(encode(groupPost({ text: 'depois' })))
  await B.cores.w.clear(3, 4)
  await joinAndFlush(B.swarm, [topicFor(assoc.hex)])
  const entry = seeder._groupServed.get(W)
  await until(async () => entry.core.length === 5 && await entry.core.has(4), { name: 'bloco depois do buraco', timeoutMs: 30000 })
  t.is(entry.core.contiguousLength, 3, 'a hole at 3')

  const page = seeder.indexGroup(R)
  const row = page.writers.find((w) => w.key === W)
  t.is(row.length, 3, 'length is the contiguous prefix')
  t.is(row.signed, 5, 'signed is the signed length')
  const root = page.writers.find((w) => w.key === R)
  t.is(root.signed, root.length, 'a writer without a hole has both equal')
  t.is(page.complete, true, 'a withheld block never holds the page incomplete')
  const item = seeder.groupWriters({ group: R, limit: 64 }).items.find((w) => w.key === W)
  t.alike({ length: item.length, signed: item.signed }, { length: 3, signed: 5 }, 'the writers page carries both')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
