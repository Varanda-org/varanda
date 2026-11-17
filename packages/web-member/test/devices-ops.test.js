'use strict'

// Connected devices in the browser node (docs/rpc.md 5.152 to 5.155):
// member-ops over memory storages. A second device of the account shares
// the key pair and PRF; cores move by direct replication, no seeder.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const devices = require('@varanda/core/lib/devices')
const { groupJoinRecord, groupCutRecord } = require('@varanda/core/lib/records')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')
const rand = () => hex(crypto.randomBytes(32))

async function holder (t, storage, prf) {
  const h = createGroupKeys()
  await h.unlock(storage, prf)
  t.teardown(() => h.close())
  return h
}

async function setup (t, { assoc = generateAssociationKeyPair(), name = 'Ana' } = {}) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce), groupKeys: await holder(t, storage, prf) }
  const key = hex(keyPair.publicKey)
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  await ops.profileSet(ctx, { name, bio: '' })
  return { ctx, key, assoc, storage, prf }
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

async function syncDiary (from, to) {
  await pipe(await store.openDiary(from.storage), await store.openDiary(to.storage))
}

async function secondDevice (t, s, keys) {
  const storage = memoryNodeStorage()
  const ctx = { storage, association: s.ctx.association, keyPair: s.ctx.keyPair, groupKeyPair: s.ctx.groupKeyPair, groupKeys: await holder(t, storage, s.prf) }
  await ops.idCreate(ctx)
  await syncDiary(s, { storage })
  for (const key of keys) await copyCore(s, { storage }, key)
  await store.addGroupDiary(storage, s.key)
  return { ctx, storage, key: s.key, assoc: s.assoc, prf: s.prf }
}

async function entries (s) {
  const core = await store.openDiary(s.storage)
  try {
    return await store.readAll(core)
  } finally {
    await core.close()
  }
}

async function diaryLength (s) {
  const core = await store.openDiary(s.storage)
  try {
    return core.length
  } finally {
    await core.close()
  }
}

const cutsOf = (list) => list.filter((e) => e.record.type === 'group-cut').map((e) => ({ group: e.record.group, writer: e.record.writer, cut: e.record.cut }))

function foldOf (s, list) {
  const key = devices.deviceKey(s.ctx.keyPair.secretKey, b4a.from(s.key, 'hex'))
  try {
    return devices.foldDevices(list, key)
  } finally {
    devices.wipeKey(key)
  }
}

// The account's creator device `a` with a community, and its second device
// `d` enrolled by the upkeep (one CW and one Geral writer).
async function twoDevices (t, { helloFirst = true } = {}) {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const d = await secondDevice(t, a, [community, general])
  if (helloFirst) await ops.deviceHello(d.ctx, { name: 'Tablet' })
  const res = await ops.deviceUpkeep(d.ctx, await ops.deviceUpkeepPlan(d.ctx))
  t.is(res.enrolled.length, 2, 'd enrolled in the community and Geral')
  await syncDiary(d, a)
  const writers = (await store.readGroupWriters(d.storage)).filter((w) => w.key !== w.group)
  return { a, d, community, general, writers }
}

test('hello registers once and never renames; the id is kept per identity', async (t) => {
  const a = await setup(t)
  const first = await ops.deviceHello(a.ctx, { name: 'Celular' })
  t.alike(first, { id: first.id, registered: true, off: false })
  t.is(await store.readDeviceId(a.storage, a.key), first.id)
  t.is(await store.readDeviceId(a.storage, rand()), null, 'bound to the identity')
  t.alike(await ops.deviceHello(a.ctx, { name: 'Outro' }), { id: first.id, registered: false, off: false })
  t.alike(await ops.deviceHello(a.ctx, { name: 'Outro' }, { write: false }), { id: first.id, registered: false, off: false }, 'the read answers')
  const list = await ops.deviceList(a.ctx)
  t.alike(list.devices.map((x) => [x.name, x.self, x.on]), [['Celular', true, true]])
  await t.exception(ops.deviceHello({ ...a.ctx, keyPair: null }, { name: 'x' }))
})

test('the joins of the upkeep are mapped to the device; the other device lists them', async (t) => {
  const { a, d, writers } = await twoDevices(t)
  const fold = foldOf(d, await entries(d))
  const self = await store.readDeviceId(d.storage, d.key)
  const mapped = fold.byId.get(self).writers
  for (const w of writers) t.ok(mapped.some((p) => p.group === w.group && p.writer === w.key), 'mapped ' + w.group.slice(0, 8))
  await ops.deviceHello(a.ctx, { name: 'Celular' })
  const list = await ops.deviceList(a.ctx)
  t.alike(list.devices.map((x) => [x.name, x.self, x.writers]), [['Celular', true, 0], ['Tablet', false, writers.length]])
  t.is(list.previous, null)
})

test('disconnect: marks, off record, the lost device is off and stops its upkeep', async (t) => {
  const { a, d, writers, community } = await twoDevices(t)
  await ops.deviceHello(a.ctx, { name: 'Celular' })
  const lost = await store.readDeviceId(d.storage, d.key)
  // `a` holds d's CW (copied), not its Geral writer.
  const cw = writers.find((w) => w.kind === 'community')
  await copyCore(d, a, cw.key)
  t.alike(await ops.deviceDisconnect(a.ctx, { id: lost }, { write: false }), { pairs: writers.length })
  const r = await ops.deviceDisconnect(a.ctx, { id: lost })
  t.is(r.cut, writers.length)
  t.is(r.empty, writers.length - 1, 'the writer not held is marked at 0')
  const list = await entries(a)
  const cuts = cutsOf(list)
  t.is(cuts.length, writers.length)
  t.ok(cuts.some((c) => c.writer === cw.key && c.cut > 0), 'the held writer at its length')
  t.is(foldOf(a, list).byId.get(lost).on, false)
  await t.exception(ops.deviceDisconnect(a.ctx, { id: lost }), new RegExp(devices.NOT_FOUND))

  // A group made after the cut: an upkeep would enrol in it.
  const { group: feira } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open', community })
  await copyCore(a, d, feira)
  await syncDiary(a, d)
  t.alike(await ops.deviceOff(d.ctx), { off: true })
  t.alike(await ops.deviceHello(d.ctx, { name: 'Tablet' }), { id: lost, registered: false, off: true })
  await t.exception(ops.deviceDisconnect(d.ctx, { previous: true }), new RegExp(devices.OFF_REFUSED))
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike([plan.enrol, plan.share, plan.skipped], [[], [], []], 'an off device plans nothing')
  t.is(await ops.deviceUpkeepNeeded(d.ctx), false)
})

test('no id and a cut current writer: off until reconnect, which re-enrols the cut writers', async (t) => {
  const { a, d, community, general } = await twoDevices(t, { helloFirst: false })
  await ops.deviceHello(a.ctx, { name: 'Celular' })
  t.alike((await ops.deviceList(a.ctx)).previous, { writers: 2 })
  t.alike(await ops.deviceDisconnect(a.ctx, { previous: true }), { cut: 2, empty: 2, groups: [community, general] })
  await syncDiary(a, d)

  const before = await diaryLength(d)
  t.alike(await ops.deviceHello(d.ctx, { name: 'Tablet' }), { id: null, registered: false, off: true })
  t.is(await store.readDeviceId(d.storage, d.key), null, 'no id created')
  t.is(await diaryLength(d), before, 'nothing written')
  t.is((await ops.deviceList(d.ctx)).off, true)
  t.alike((await ops.deviceUpkeepPlan(d.ctx)).enrol, [])
  t.is(await ops.deviceUpkeepNeeded(d.ctx), false)
  // No join or create by hand either, and nothing is written.
  await t.exception(ops.communityJoin(d.ctx, { community }), new RegExp(devices.OFF_REFUSED))
  await t.exception(ops.groupJoin(d.ctx, { group: general }), new RegExp(devices.OFF_REFUSED))
  await t.exception(ops.groupJoin(d.ctx, { group: rand(), community }), new RegExp(devices.OFF_REFUSED), 'a group not held yet')
  await t.exception(ops.groupCreate(d.ctx, { name: 'Feira', join: 'open', community }), new RegExp(devices.OFF_REFUSED))
  await t.exception(ops.communityCreate(d.ctx, { name: 'Outro', join: 'open' }), new RegExp(devices.OFF_REFUSED))
  t.is(await diaryLength(d), before, 'still nothing written')

  const back = await ops.deviceReconnect(d.ctx, { name: 'Tablet' })
  t.alike(back, { id: back.id, registered: true, off: false })
  t.is((await ops.deviceList(d.ctx)).off, false)
  t.is(await ops.deviceUpkeepNeeded(d.ctx), true, 'the cut writers are re-enrolled')
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol.map((e) => e.root), [community, general])
  await t.exception(ops.deviceReconnect(d.ctx, { name: 'Tablet' }), new RegExp(devices.NOT_OFF))
})

test('a failed read of the device state refuses a join or create with its own error, and writes nothing', async (t) => {
  const { d, community, general } = await twoDevices(t, { helloFirst: false })
  const before = await diaryLength(d)
  const read = store.readDeviceId
  store.readDeviceId = async () => { throw new Error('kv quebrado') }
  try {
    await t.exception(ops.communityJoin(d.ctx, { community }), /kv quebrado/)
    await t.exception(ops.groupJoin(d.ctx, { group: general }), /kv quebrado/)
    await t.exception(ops.groupJoin(d.ctx, { group: rand(), community }), /kv quebrado/, 'a group not held yet')
    await t.exception(ops.groupCreate(d.ctx, { name: 'Feira', join: 'open', community }), /kv quebrado/)
    await t.exception(ops.communityCreate(d.ctx, { name: 'Outro', join: 'open' }), /kv quebrado/)
  } finally {
    store.readDeviceId = read
  }
  t.is(await diaryLength(d), before, 'nothing written')
  // No device state yet (no hello) is not a failure: the create goes ahead.
  t.is(await store.readDeviceId(d.storage, d.key), null)
  await t.execution(ops.communityCreate(d.ctx, { name: 'Outro', join: 'open' }))
})

test('disconnect half way: the marks written stand and the call says it is incomplete', async (t) => {
  const { a, d, writers } = await twoDevices(t)
  await ops.deviceHello(a.ctx, { name: 'Celular' })
  const lost = await store.readDeviceId(d.storage, d.key)
  const append = store.appendRecord
  let n = 0
  store.appendRecord = async (...args) => {
    if (++n === 2) throw new Error('disco cheio')
    return append(...args)
  }
  try {
    await t.exception(ops.deviceDisconnect(a.ctx, { id: lost }), new RegExp(ops.DEVICE_PARTIAL))
  } finally {
    store.appendRecord = append
  }
  t.is(cutsOf(await entries(a)).length, 1, 'the first mark stands')
  const again = await ops.deviceDisconnect(a.ctx, { id: lost })
  t.is(again.cut, writers.length - 1, 'the call made again marks the rest')
  t.is(cutsOf(await entries(a)).length, writers.length)
})

// Appends records(key) to the own diary of `s`, `key` the device key.
async function plant (s, records) {
  const diary = await store.openDiary(s.storage, s.ctx.keyPair)
  const key = devices.deviceKey(s.ctx.keyPair.secretKey, b4a.from(s.key, 'hex'))
  try {
    for (const record of records(key)) await store.appendRecord(diary, record)
  } finally {
    devices.wipeKey(key)
    await diary.close()
  }
}

test('a repeated disconnect never lowers an earlier mark', async (t) => {
  const a = await setup(t)
  await ops.deviceHello(a.ctx, { name: 'Celular' })
  const w = { group: rand(), writer: rand() }
  const kept = { group: rand(), writer: rand() }
  const later = { group: rand(), writer: rand() }
  const lost = rand()
  // Another device cut W at 100 and lost's writer at 7; none is held here.
  await plant(a, (key) => [
    groupJoinRecord({ ...w, on: true }),
    groupJoinRecord({ ...kept, on: true }),
    devices.sealedRecord({ v: 1, id: lost, name: 'Perdido', on: true, writers: [kept] }, key),
    groupCutRecord({ ...w, cut: 100 }),
    groupCutRecord({ ...kept, cut: 7 }),
    groupJoinRecord({ ...later, on: true })
  ])
  t.alike((await ops.deviceList(a.ctx)).previous, { writers: 1 })
  t.alike(await ops.deviceDisconnect(a.ctx, { previous: true }), { cut: 1, empty: 1, groups: [later.group] })
  t.alike(await ops.deviceDisconnect(a.ctx, { id: lost }), { cut: 0, empty: 0, groups: [] })
  const list = await entries(a)
  t.alike(cutsOf(list), [{ ...w, cut: 100 }, { ...kept, cut: 7 }, { ...later, cut: 0 }], 'no second mark on a marked pair')
  t.is(devices.cutMarks(list).get(devices.pairKey(w)), 100)
  t.is(foldOf(a, list).byId.get(lost).on, false)
})

test('disconnect rotates the key of a private group this device distributes in, best effort', async (t) => {
  const a = await setup(t)
  const { community } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'open', visibility: 'private', community })
  await ops.deviceHello(a.ctx, { name: 'Celular' })
  const lost = rand()
  const pair = { group, writer: rand() }
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  const key = devices.deviceKey(a.ctx.keyPair.secretKey, b4a.from(a.key, 'hex'))
  try {
    await store.appendRecord(diary, groupJoinRecord({ ...pair, on: true }))
    await store.appendRecord(diary, devices.sealedRecord({ v: 1, id: lost, name: 'Perdido', on: true, writers: [pair] }, key))
  } finally {
    devices.wipeKey(key)
    await diary.close()
  }
  const before = await ops.groupRead(a.ctx, { group })
  t.alike(await ops.deviceDisconnect(a.ctx, { id: lost }), { cut: 1, empty: 1, groups: [group] })
  const after = await ops.groupRead(a.ctx, { group })
  t.ok(after.epoch !== null)
  t.unlike(after.epoch, before.epoch, 'a new epoch after the cut')

  // Without the group key the marks are written and the rotation skipped.
  const other = rand()
  const pair2 = { group, writer: rand() }
  const diary2 = await store.openDiary(a.storage, a.ctx.keyPair)
  const key2 = devices.deviceKey(a.ctx.keyPair.secretKey, b4a.from(a.key, 'hex'))
  try {
    await store.appendRecord(diary2, groupJoinRecord({ ...pair2, on: true }))
    await store.appendRecord(diary2, devices.sealedRecord({ v: 1, id: other, name: 'Outro', on: true, writers: [pair2] }, key2))
  } finally {
    devices.wipeKey(key2)
    await diary2.close()
  }
  t.alike(await ops.deviceDisconnect({ ...a.ctx, groupKeyPair: null }, { id: other }), { cut: 1, empty: 1, groups: [group] })
  t.alike((await ops.groupRead(a.ctx, { group })).epoch, after.epoch, 'no rotation without the group key')
})
