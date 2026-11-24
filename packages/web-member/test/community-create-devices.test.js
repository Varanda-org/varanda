'use strict'

// The community creator creates a group from any of its devices whose
// community writer the fold counts (rpc.md 5.36): the root where this device
// holds it, else its live CW. Admins and members never create, and after a
// confirmed leave of the creator no device does. Cores move between storages
// by direct replication; no seeder or sockets are involved.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const grp = require('@varanda/core/lib/group')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')
const DEVICE = /este aparelho ainda não pode criar grupos nesta comunidade; aguarde a sincronização/
const CREATOR_ONLY = /só quem criou a comunidade cria grupos/
const FORBIDDEN = /sem permissão na comunidade/

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

async function copyCore (from, to, key) {
  await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to.storage, key))
  await store.addGroupReplica(to.storage, key)
}

// Copies `from`'s diary and the group cores `keys` (held by `from`) to `to`,
// listed as the sync would list them.
async function share (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to.storage, from.key))
  for (const key of keys) await copyCore(from, to, key)
  await store.addGroupDiary(to.storage, from.key)
}

// Another device of the same account receives the own diary and `keys`.
async function syncOwn (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openDiary(to.storage))
  for (const key of keys) await copyCore(from, to, key)
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

async function coreLength (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  if (core === null) return 0
  try { return core.length } finally { await core.close() }
}

async function records (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try { return (await store.readAll(core)).map((e) => e.record) } finally { await core.close() }
}

// What a refusal must leave untouched on `s`.
async function written (s) {
  return [await store.readGroupWriters(s.storage), await store.readGroupCoreKeys(s.storage), (await ops.logRead(s.ctx)).entries.length]
}

// The fold of C as `s` holds it, over the CWs `writerKeys` and `diaries`.
async function foldC (s, community, writerKeys, diaries) {
  const read = async (key) => {
    const core = await store.openGroupCoreReadOnly(s.storage, key)
    try { return await store.readAll(core) } finally { await core.close() }
  }
  const root = await read(community)
  const writers = []
  for (const key of writerKeys) {
    const entries = await read(key)
    writers.push({ key, entries, diary: entries[0].record.diary })
  }
  const joins = new Map()
  const confirms = new Map()
  for (const d of diaries) {
    const core = d === s.key ? await store.openDiary(s.storage, s.ctx.keyPair) : await store.openReplica(s.storage, d)
    let entries
    try { entries = await store.readAll(core) } finally { await core.close() }
    joins.set(d, grp.groupJoinHistory(entries, community))
    confirms.set(d, grp.groupConfirmHistory(entries, community))
  }
  return grp.buildCommunity({ root: { key: community, entries: root }, writers, joins, confirms })
}

// Copied from community-devices.test.js: what `s` holds that a second device
// would hold after a sync: its own diary (same keyPair, same group key
// function, fresh storage), the roots `keys` (held by `s`) and the diaries of
// `others` (replicas held by `s`).
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

test('the creator\'s second device creates a group on its CW once it joined; device 1 lists it', async (t) => {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const d = await secondDevice(a, [community, general])
  t.alike(await ops.communityJoin(d.ctx, { community }), { state: 'member', group: general })
  const cw = await ownWriter(d, community)
  t.not(cw, community, 'device 2 writes on a CW')
  const rootBefore = await coreLength(a, community)

  const { group } = await ops.groupCreate(d.ctx, { name: 'Feira', join: 'open', community })
  const create = (await records(d, cw)).at(-1)
  t.alike([create.type, create.group], ['group-create', group], 'the group-create sits on device 2\'s CW')
  t.is(await coreLength(d, community), rootBefore, 'device 2 appends nothing to its root copy')
  const header = (await records(d, group))[0]
  t.alike([header.community, header.member, header.diary], [community, cw, a.key], 'the header names the CW as its member')
  t.ok((await ops.communityInfo(d.ctx, { community })).groups.some((g) => g.group === group && g.name === 'Feira'), 'device 2 lists it')
  t.ok(await ops.groupPost(d.ctx, { group, text: 'de 2' }), 'device 2 posts in it')

  await syncOwn(d, a, [cw, group])
  const info = await ops.communityInfo(a.ctx, { community })
  t.ok(info.groups.some((g) => g.group === group && g.name === 'Feira'), 'device 1 lists it in community.info')
  const fold = await foldC(a, community, [await ownWriter(a, community), cw].filter((k) => k !== community), [a.key])
  t.ok(fold.created.has(group), 'the fold of device 1 counts the create')
  t.is(await coreLength(a, community), rootBefore, 'device 1\'s root length is unchanged')

  t.alike(await ops.groupJoin(a.ctx, { group }), { state: 'member' }, 'device 1 joins the group')
  t.ok(await ops.groupPost(a.ctx, { group, text: 'de 1' }), 'device 1 posts in it')
  const items = (await ops.groupRead(a.ctx, { group })).items.map((p) => p.text).sort()
  t.alike(items, ['de 1', 'de 2'], 'device 1 reads both posts')
})

test('the creator\'s second device is refused before it joins and writes nothing', async (t) => {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const d = await secondDevice(a, [community, general])
  const before = await written(d)
  await t.exception(() => ops.groupCreate(d.ctx, { name: 'Feira', join: 'open', community }), DEVICE)
  t.alike(await written(d), before, 'nothing written by the refusal')
  t.is((await ops.communityInfo(d.ctx, { community })).groups.length, 1, 'only Geral')
})

test('a community admin and its second device are still refused and write nothing', async (t) => {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  await share(a, b, [community, general])
  await ops.communityJoin(b.ctx, { community })
  await share(b, a, [await ownWriter(b, community), await ownWriter(b, general)])
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  await share(a, b, [community])
  const bd = await secondDevice(b, [community, general, await ownWriter(b, community), await ownWriter(b, general)], [a])
  await ops.communityJoin(bd.ctx, { community })
  t.is((await ops.communityInfo(bd.ctx, { community })).role, 'admin')
  for (const s of [b, bd]) {
    const before = await written(s)
    await t.exception(() => ops.groupCreate(s.ctx, { name: 'Feira', join: 'open', community }), CREATOR_ONLY)
    t.alike(await written(s), before, 'nothing written by the refusal')
  }
})

test('after a confirmed leave of the creator neither device creates', async (t) => {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  await share(a, b, [community, general])
  await ops.communityJoin(b.ctx, { community })
  const bcw = await ownWriter(b, community)
  await share(b, a, [bcw, await ownWriter(b, general)])
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  t.is((await ops.communityJoin(a.ctx, { community })).state, 'member', 'the creator is back')
  t.is((await ops.communityInfo(a.ctx, { community })).rootAuthority, false, 'the confirmed leave ended root authority')
  const d = await secondDevice(a, [community, general, await ownWriter(a, community), bcw], [b])
  t.is((await ops.communityJoin(d.ctx, { community })).state, 'member', 'device 2 joins')
  for (const s of [a, d]) {
    const before = await written(s)
    await t.exception(() => ops.groupCreate(s.ctx, { name: 'Feira', join: 'open', community }), FORBIDDEN)
    t.alike(await written(s), before, 'nothing written by the refusal')
  }
})
