'use strict'

// community.invitePolicy (rpc.md 5.72) from a second device of the creator:
// with no root nonce here it writes on its own live community writer, which
// the fold counts while the root has authority. Cores move between storages
// by direct replication; no seeder or sockets are involved.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')
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

// Copies `from`'s diary and the group cores `keys` (held by `from`) to `to`,
// listed as the sync would list them.
async function share (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to.storage, from.key))
  for (const key of keys) await copyCore(from, to, key)
  await store.addGroupDiary(to.storage, from.key)
}

async function copyCore (from, to, key) {
  await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to.storage, key))
  await store.addGroupReplica(to.storage, key)
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

async function lastRecord (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try { return (await store.readAll(core)).map((e) => e.record).pop() } finally { await core.close() }
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

// A creator `a` with an open community and members who joined it; each
// member's diary and CW go back to `a`.
async function world (t, n) {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const members = []
  for (let i = 0; i < n; i++) {
    const s = await setup(t, { assoc: a.assoc, name: 'M' + i })
    await share(a, s, [community, general])
    await ops.communityJoin(s.ctx, { community })
    await share(s, a, [await ownWriter(s, community), await ownWriter(s, general)])
    members.push(s)
  }
  return { a, members, community, general }
}

test('the creator\'s second device sets the invite policy on its own CW after it joins', async (t) => {
  const { a, community, general } = await world(t, 0)
  const rootBefore = await coreLength(a, community)
  const d = await secondDevice(a, [community, general])

  await t.exception(() => ops.communityInvitePolicy(d.ctx, { community, members: true }), FORBIDDEN, 'refused before the join')
  t.is(await ownWriter(d, community), null, 'no CW made')

  await ops.communityJoin(d.ctx, { community })
  const cw = await ownWriter(d, community)
  t.alike(await ops.communityInvitePolicy(d.ctx, { community, members: true }), { ok: true })
  const on = await lastRecord(d, cw)
  t.alike([on.type, on.group, on.on], ['group-invites', null, true], 'on the own CW, group null')
  t.is((await ops.communityInfo(d.ctx, { community })).memberInvite, true, 'device 2 folds it')
  t.is(await coreLength(d, community), rootBefore, 'device 2 appends nothing to its root copy')

  // Device 1 receives device 2's diary entries (the join) and its CW.
  await pipe(await store.openDiary(d.storage), await store.openDiary(a.storage))
  await copyCore(d, a, cw)
  t.is((await ops.communityInfo(a.ctx, { community })).memberInvite, true, 'device 1 reads memberInvite')
  t.is(await coreLength(a, community), rootBefore, 'device 1\'s root length is unchanged')

  t.alike(await ops.communityInvitePolicy(d.ctx, { community, members: false }), { ok: true })
  await copyCore(d, a, cw)
  t.is((await ops.communityInfo(a.ctx, { community })).memberInvite, false, 'device 1 reads it off again')
})

test('device 1 holding the root still writes the invite policy on the root', async (t) => {
  const { a, community } = await world(t, 0)
  const before = await coreLength(a, community)
  t.alike(await ops.communityInvitePolicy(a.ctx, { community, members: true }), { ok: true })
  t.is(await coreLength(a, community), before + 1)
  const on = await lastRecord(a, community)
  t.alike([on.type, on.group, on.on], ['group-invites', null, true], 'on the root')
})

test('a member is still refused and an admin still writes on its own CW', async (t) => {
  const { a, members: [b, c], community } = await world(t, 2)
  await share(a, b, [community])
  const bcw = await ownWriter(b, community)
  const length = await coreLength(b, bcw)
  await t.exception(() => ops.communityInvitePolicy(b.ctx, { community, members: true }), FORBIDDEN)
  t.is(await coreLength(b, bcw), length, 'nothing appended')

  await ops.communitySetAdmin(a.ctx, { community, member: c.key, on: true })
  await share(a, c, [community])
  const ccw = await ownWriter(c, community)
  t.alike(await ops.communityInvitePolicy(c.ctx, { community, members: true }), { ok: true })
  const on = await lastRecord(c, ccw)
  t.alike([on.type, on.group, on.on], ['group-invites', null, true], 'an admin on its own CW')
  t.is((await ops.communityInfo(c.ctx, { community })).memberInvite, true)
})
