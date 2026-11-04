'use strict'

// A second device of the same account (same keyPair and group key function,
// its own storage) lists and reads the communities and groups the own diary
// binds once it holds their roots, and says whether THIS device writes there
// (writerHere, canWrite, rootHere). Cores move between storages by direct
// replication; no seeder or sockets are involved.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')

async function setup (t, { assoc = generateAssociationKeyPair(), name = 'Ana' } = {}) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
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

// Copies `from`'s diary and the group cores `keys` (held by `from`) to `to`,
// listed as the sync would list them.
async function share (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to.storage, from.key))
  for (const key of keys) {
    await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to.storage, key))
    await store.addGroupReplica(to.storage, key)
  }
  await store.addGroupDiary(to.storage, from.key)
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

// The writers the own diary binds in any group, sorted.
async function boundWriters (storage) {
  const core = await store.openDiary(storage)
  try {
    const all = await store.readAll(core)
    return [...new Set(all.map((e) => e.record).filter((r) => r.type === 'group-join' && r.on).map((r) => r.writer))].sort()
  } finally {
    await core.close()
  }
}

async function world (t, n = 0, { join = 'open' } = {}) {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join })
  const members = []
  for (let i = 0; i < n; i++) {
    const s = await setup(t, { assoc: a.assoc, name: 'M' + i })
    await share(a, s, [community, general])
    members.push(s)
  }
  return { a, members, community, general }
}

// What `s` holds that a second device would hold after a sync: its own diary
// (same keyPair, same group key function, fresh storage), the roots `keys`
// (held by `s`) and the diaries of `others` (replicas held by `s`).
async function secondDevice (s, keys, others = []) {
  const storage = memoryNodeStorage()
  const ctx = { storage, association: s.ctx.association, keyPair: s.ctx.keyPair, groupKeyPair: s.ctx.groupKeyPair }
  await ops.idCreate(ctx)
  await pipe(await store.openDiary(s.storage), await store.openDiary(storage))
  for (const key of keys) {
    await pipe(await store.openGroupCoreReadOnly(s.storage, key), await store.openGroupReplica(storage, key))
    await store.addGroupReplica(storage, key)
  }
  await store.addGroupDiary(storage, s.key)
  for (const o of others) {
    await pipe(await store.openReplica(s.storage, o.key), await store.openReplica(storage, o.key))
    await store.addGroupDiary(storage, o.key)
  }
  return { ctx, storage, key: s.key, assoc: s.assoc }
}

test('a second device lists the community, reads it and writes nothing until it joins', async (t) => {
  const { a, community, general } = await world(t)
  const d = await secondDevice(a, [community, general])

  const list = (await ops.communityList(d.ctx)).communities
  t.alike(list.map((c) => [c.community, c.state, c.role, c.general]), [[community, 'ready', 'creator', general]], 'listed ready')
  const groups = await ops.groupList(d.ctx)
  t.alike(groups.groups.map((g) => [g.group, g.role, g.community]), [[general, 'creator', community]], 'Geral listed, the community is no group')
  t.is(groups.total, 1)

  const info = await ops.communityInfo(d.ctx, { community })
  t.alike([info.writerHere, info.canWrite, info.rootHere], [false, false, false])
  const gi = await ops.groupInfo(d.ctx, { group: general })
  t.alike([gi.writerHere, gi.canWrite], [false, false])
  await t.exception(() => ops.groupPost(d.ctx, { group: general, text: 'oi' }), /sem permissão no grupo/)
  await t.exception(() => ops.communityLeave(d.ctx, { community }), /nada a alterar/)

  t.alike(await ops.communityJoin(d.ctx, { community }), { state: 'member', group: general })
  const after = await ops.communityInfo(d.ctx, { community })
  t.alike([after.writerHere, after.canWrite, after.rootHere], [true, true, false])
  const gj = await ops.groupInfo(d.ctx, { group: general })
  t.alike([gj.writerHere, gj.canWrite], [true, true])
  t.ok(await ops.groupPost(d.ctx, { group: general, text: 'oi' }), 'the post succeeds')
  const entry = (await store.readGroupWriters(d.storage)).find((e) => e.group === community)
  t.alike([entry.kind, entry.rootNonce], ['community', null], 'a non-root community writer')
  await t.exception(() => ops.groupCreate(d.ctx, { name: 'Feira', join: 'open', community }), /crie pelo aparelho que criou a comunidade/)
})

test('a second device whose diary copy has no joins lists nothing', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { community, group: general } = await ops.communityCreate(b.ctx, { name: 'Vila', join: 'open' })
  const d = await secondDevice(a, [])
  await share(b, d, [community, general])
  t.alike((await ops.communityList(d.ctx)).communities, [])
  t.alike(await ops.groupList(d.ctx), { groups: [], total: 0 })
})

test('a blocklisted diary-bound root is left out', async (t) => {
  const { a, community, general } = await world(t)
  const d = await secondDevice(a, [community, general])
  t.is((await ops.communityList(d.ctx)).communities.length, 1, 'listed before')
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, a.assoc)
  await store.writeBlocklist(d.storage, createSnapshot({ seq: 1, blocked: [community] }, modKp, modCert))
  t.alike((await ops.communityList(d.ctx)).communities, [], 'left out')
})

test('approval community: a second device of an admitted member writes in the community, not yet in Geral', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1, { join: 'approval' })
  await ops.communityJoin(b.ctx, { community })
  await share(b, a, [await ownWriter(b, community), await ownWriter(b, general)])
  await ops.communityAdmit(a.ctx, { community, member: b.key, on: true })
  await share(a, b, [community])

  const d = await secondDevice(b, [community, general, await ownWriter(b, community), await ownWriter(b, general)], [a])
  t.alike((await ops.communityList(d.ctx)).communities.map((c) => [c.community, c.role]), [[community, 'member']])
  t.alike(await ops.communityJoin(d.ctx, { community }), { state: 'member', group: general })
  const ci = await ops.communityInfo(d.ctx, { community })
  t.alike([ci.writerHere, ci.canWrite], [true, true], 'a community writer is live when the diary is a member')
  const gi = await ops.groupInfo(d.ctx, { group: general })
  t.alike([gi.writerHere, gi.canWrite], [true, false], 'the new community writer is not admitted yet')

  const cw = (await store.readGroupWriters(d.storage)).find((e) => e.group === community).key
  const writers = (await store.readGroupWriters(d.storage)).length
  await ops.communityJoin(d.ctx, { community })
  t.is((await store.readGroupWriters(d.storage)).find((e) => e.group === community).key, cw, 'no second community writer')
  t.is((await store.readGroupWriters(d.storage)).length, writers, 'no second groupWriters entry')
  const bound = (await boundWriters(d.storage)).filter((w) => w === cw)
  t.alike(bound, [cw], 'the community writer stays the one bound')
})

async function copyCore (from, to, key) {
  await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to.storage, key))
  await store.addGroupReplica(to.storage, key)
}

test('a member\'s second device waits for the account writers, then shows the device card', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await ops.communityJoin(b.ctx, { community })
  // a's diary, so the root binds; the member's own writer cores stay behind.
  const d = await secondDevice(b, [community, general], [a])

  const row = (await ops.communityList(d.ctx)).communities.find((c) => c.community === community)
  // A held root keeps state 'ready' (its name shows); the role says the
  // account's writers are still arriving.
  t.alike([row.state, row.role, row.name, row.join, row.general], ['ready', 'pending', 'Bairro', 'open', general])
  const info = await ops.communityInfo(d.ctx, { community })
  t.is(info.role, 'pending')
  t.alike([info.name, info.join, info.state], ['Bairro', 'open', 'ready'])
  t.is(info.groups.find((g) => g.group === general).role, 'pending', 'the catalogue row agrees with group.info')
  const geral = (await ops.groupList(d.ctx)).groups.find((g) => g.group === general)
  t.alike([geral.role, geral.name, geral.join, geral.community], ['pending', 'Geral', 'open', community])
  const gi = await ops.groupInfo(d.ctx, { group: general })
  t.alike([gi.role, gi.state, gi.name, gi.writerHere, gi.canWrite], ['pending', 'left', 'Geral', false, false])

  await copyCore(b, d, await ownWriter(b, community))
  await copyCore(b, d, await ownWriter(b, general))
  const ready = (await ops.communityList(d.ctx)).communities.find((c) => c.community === community)
  t.alike([ready.state, ready.role], ['ready', 'member'])
  const after = await ops.communityInfo(d.ctx, { community })
  t.alike([after.role, after.writerHere, after.canWrite], ['member', false, false])
  const gj = await ops.groupInfo(d.ctx, { group: general })
  t.alike([gj.role, gj.writerHere, gj.canWrite], ['member', false, false])
})

test('canWrite is false while the group\'s community root is not held here', async (t) => {
  const { members: [b], community, general } = await world(t, 1)
  await ops.communityJoin(b.ctx, { community })
  const d = await secondDevice(b, [general])
  await copyCore(b, d, await ownWriter(b, general))
  const gi = await ops.groupInfo(d.ctx, { group: general })
  t.alike([gi.role, gi.writerHere, gi.canWrite], ['member', false, false])
  await t.exception(() => ops.groupPost(d.ctx, { group: general, text: 'oi' }), /aguarde a sincroniza/)
})

test('a leave written on another device stays left, not pending', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await ops.communityJoin(b.ctx, { community })
  // Device 2 binds its own writer, then leaves: that ends every device's
  // writer, but device 1's join stays on, so the diary still binds the root.
  const d2 = await secondDevice(b, [community, general], [a])
  await ops.communityJoin(d2.ctx, { community })
  await ops.communityLeave(d2.ctx, { community })
  const d = await secondDevice(d2, [community, general], [a])
  await copyCore(d2, d, await ownWriter(d2, community))
  const row = (await ops.communityList(d.ctx)).communities.find((c) => c.community === community)
  t.alike([row.state, row.role], ['ready', 'left'])
  const info = await ops.communityInfo(d.ctx, { community })
  t.is(info.role, 'left')
})

// A private group in rekey-pending needs the box holder and a rotation.
// A writer past the group cap needs MAX_GROUP_WRITERS (512) cores. Neither
// is cheap in this file. An orphan is: one extra root the catalogue never lists.
test('canWrite is false for an orphan group', async (t) => {
  const a = await setup(t)
  const { community } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const nonce = crypto.randomBytes(32)
  const kp = await a.ctx.groupKeyPair(new Uint8Array(nonce))
  const key = hex(kp.publicKey)
  const core = await store.openGroupWriter(a.storage, kp)
  try {
    await store.appendGroupRecord(core, grp.groupHeader({ kind: 'group', diary: a.key, community, member: community, join: 'open', name: 'Solto' }), { root: true })
  } finally {
    await core.close()
  }
  await store.putGroupWriter(a.storage, { group: key, key, nonce: hex(nonce), rootNonce: hex(nonce) })
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupJoinRecord({ group: key, writer: key, on: true }))
  } finally {
    await diary.close()
  }
  const info = await ops.groupInfo(a.ctx, { group: key })
  t.alike([info.orphan, info.role, info.state, info.writerHere, info.canWrite], [true, 'creator', 'member', true, false])
  await t.exception(() => ops.groupPost(a.ctx, { group: key, text: 'oi' }), /grupo sem comunidade/)
})

function failingAt (ctx, n) {
  let calls = 0
  return { ...ctx, groupKeyPair: (nonce) => { if (++calls === n) throw new Error('falha injetada'); return ctx.groupKeyPair(nonce) } }
}

test('an interrupted community.create reports the stored root writer', async (t) => {
  const a = await setup(t)
  // The 4th derivation is Geral's header, after the community writer is stored.
  await t.exception(() => ops.communityCreate(failingAt(a.ctx, 4), { name: 'Bairro', join: 'open' }), /falha injetada/)
  const plan = await store.readCommunityCreate(a.storage)
  t.ok(plan)
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === plan.community)
  t.ok(entry && entry.rootNonce)
  const info = await ops.communityInfo(a.ctx, { community: plan.community })
  t.alike([info.writerHere, info.canWrite, info.rootHere, info.role, info.state], [true, false, true, 'pending', 'pending'])
})

test('authorityHere: the creator\'s root device has it, its second device has it after community.join (the creator\'s CW carries authority), a device with no entry does not', async (t) => {
  const { a, community, general } = await world(t)
  t.is((await ops.communityInfo(a.ctx, { community })).authorityHere, true, 'creator device')
  const d = await secondDevice(a, [community, general])
  t.is((await ops.communityInfo(d.ctx, { community })).authorityHere, false, 'second device with no writer entry')
  await ops.communityJoin(d.ctx, { community })
  const after = await ops.communityInfo(d.ctx, { community })
  t.is(after.authorityHere, true, 'the creator\'s new CW carries authority')
  t.is(after.rootHere, false, 'still no root here')
})
