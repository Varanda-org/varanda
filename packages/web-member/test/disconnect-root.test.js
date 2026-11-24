'use strict'

// device.disconnect (rpc.md 5.154) also marks the group roots the lost
// device's records map (protocol.md section 10, "Creator marks on group
// roots"): a group created on the lost device keeps no charter there, so
// what that device writes on the root after the mark does not count on the
// account's other devices. Cores move between storages by direct
// replication; no seeder or sockets are involved.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')
const FORBIDDEN_G = /sem permissão no grupo/

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

// Another device of the same account receives the own diary and `keys`.
async function syncOwn (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openDiary(to.storage))
  for (const key of keys) await copyCore(from, to, key)
}

// A second device of `s`'s account: same keys, its own storage, a copy of
// the own diary.
async function secondDevice (t, s) {
  const storage = memoryNodeStorage()
  const ctx = { storage, association: s.ctx.association, keyPair: s.ctx.keyPair, groupKeyPair: s.ctx.groupKeyPair, groupKeys: await holder(t, storage, s.prf) }
  await ops.idCreate(ctx)
  await pipe(await store.openDiary(s.storage), await store.openDiary(storage))
  await store.addGroupDiary(storage, s.key)
  return { ctx, storage, key: s.key, assoc: s.assoc, prf: s.prf }
}

async function coreLength (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  if (core === null) return 0
  try { return core.length } finally { await core.close() }
}

async function cutsOf (s) {
  const core = await store.openDiary(s.storage)
  try {
    return (await store.readAll(core)).map((e) => e.record).filter((r) => r.type === 'group-cut').map((r) => ({ group: r.group, writer: r.writer, cut: r.cut }))
  } finally {
    await core.close()
  }
}

// Device 1 `a`, and device 2 `d` of the same account, which creates the
// standalone group `group` (its root lives on `d`) and says hello before or
// after the create. `a` then holds the own diary and, with `root`, the root.
async function lostCreator (t, { helloFirst = true, root = true } = {}) {
  const a = await setup(t)
  const d = await secondDevice(t, a)
  if (helloFirst) await ops.deviceHello(d.ctx, { name: 'Tablet' })
  const { group } = await ops.groupCreate(d.ctx, { name: 'Feira', join: 'open' })
  if (!helloFirst) await ops.deviceHello(d.ctx, { name: 'Tablet' })
  await syncOwn(d, a, root ? [group] : [])
  return { a, d, group, id: await store.readDeviceId(d.storage, d.key) }
}

async function rootCharterEnds (t, opts) {
  const { a, d, group, id } = await lostCreator(t, opts)
  await ops.groupMeta(d.ctx, { group, name: 'Mercado' })
  await copyCore(d, a, group)
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Mercado', 'before the disconnect the root\'s rename counts on device 1')

  const held = await coreLength(a, group)
  const out = await ops.deviceDisconnect(a.ctx, { id })
  t.alike([out.cut, out.empty, out.groups], [1, 0, [group]], 'one mark, on the root')
  t.alike(await cutsOf(a), [{ group, writer: group, cut: held }], 'the root marked at the length held here')

  // The lost device has not seen the mark and renames again on its root.
  await ops.groupMeta(d.ctx, { group, name: 'Outro nome' })
  await copyCore(d, a, group)
  t.is(await coreLength(a, group), held + 1, 'device 1 holds the later rename')
  const info = await ops.groupInfo(a.ctx, { group })
  t.is(info.name, 'Mercado', 'the rename past the mark does not count')
  t.is(info.rootAuthority, false, 'the root keeps no authority')
}

test('a disconnect marks the root of a group the lost device created: its later charter does not count', async (t) => {
  await rootCharterEnds(t, { helloFirst: true })
})

test('a root created before the device had an id is mapped by its next hello and marked', async (t) => {
  await rootCharterEnds(t, { helloFirst: false })
})

test('the mark ends the charter from device 1 too: the group charter is frozen', async (t) => {
  const { a, group, id } = await lostCreator(t)
  await ops.groupJoin(a.ctx, { group })
  t.is((await ops.groupInfo(a.ctx, { group })).charterHere, true, 'device 1 writes the charter before the disconnect')
  await ops.deviceDisconnect(a.ctx, { id })
  const info = await ops.groupInfo(a.ctx, { group })
  t.alike([info.charterHere, info.rootAuthority], [false, false])
  await t.exception(() => ops.groupMeta(a.ctx, { group, name: 'Outra' }), FORBIDDEN_G, 'a rename from device 1 is refused')
})

test('a root not held here is not marked', async (t) => {
  const { a, id } = await lostCreator(t, { root: false })
  t.alike(await ops.deviceDisconnect(a.ctx, { id }, { write: false }), { pairs: 1 }, 'the plan names the root')
  const out = await ops.deviceDisconnect(a.ctx, { id })
  t.alike([out.cut, out.empty, out.groups], [0, 0, []], 'no mark at 0 on a root')
  t.alike(await cutsOf(a), [])
  t.ok((await ops.deviceList(a.ctx)).devices.some((x) => x.id === id && !x.on), 'the device is off')
})

test('a community root is never marked; the root of its Geral is', async (t) => {
  const a = await setup(t)
  const d = await secondDevice(t, a)
  await ops.deviceHello(d.ctx, { name: 'Tablet' })
  const { community, group: general } = await ops.communityCreate(d.ctx, { name: 'Bairro', join: 'open' })
  await ops.deviceHello(d.ctx, { name: 'Tablet' })
  await syncOwn(d, a, [community, general])
  const id = await store.readDeviceId(d.storage, d.key)
  const held = await coreLength(a, general)
  const out = await ops.deviceDisconnect(a.ctx, { id })
  t.alike(out.groups, [general])
  t.alike(await cutsOf(a), [{ group: general, writer: general, cut: held }])
})

test('a private group created on the lost device: device 1 still reads and posts after the mark', async (t) => {
  const a = await setup(t)
  const d = await secondDevice(t, a)
  await ops.deviceHello(d.ctx, { name: 'Tablet' })
  const { group } = await ops.groupCreate(d.ctx, { name: 'Segredo', join: 'approval', visibility: 'private' })
  await syncOwn(d, a, [group])
  t.alike((await ops.deviceUpkeep(a.ctx, await ops.deviceUpkeepPlan(a.ctx))).failed, [])
  const w1 = (await store.readGroupWriters(a.storage)).find((e) => e.group === group && e.key !== group).key
  await syncOwn(a, d, [w1])
  t.alike((await ops.deviceUpkeep(d.ctx, await ops.deviceUpkeepPlan(d.ctx))).shared, [group], 'device 2 hands device 1 the key')
  await copyCore(d, a, group)
  t.is((await ops.groupRead(a.ctx, { group })).state, 'ok')

  const out = await ops.deviceDisconnect(a.ctx, { id: await store.readDeviceId(d.storage, d.key) })
  t.alike(out.groups, [group])
  t.alike(await cutsOf(a), [{ group, writer: group, cut: await coreLength(a, group) }])
  t.is((await ops.groupRead(a.ctx, { group })).state, 'ok', 'the rotation leaves device 1 a key')
  t.ok((await ops.groupPost(a.ctx, { group, text: 'oi' })).seq >= 1, 'device 1 still posts')
})

test('Aparelhos anteriores never marks a root', async (t) => {
  const a = await setup(t)
  const d = await secondDevice(t, a)
  const { group } = await ops.groupCreate(d.ctx, { name: 'Feira', join: 'open' })
  await syncOwn(d, a, [group])
  const out = await ops.deviceDisconnect(a.ctx, { previous: true })
  t.is(out.cut, 0)
  t.alike(await cutsOf(a), [])
})
