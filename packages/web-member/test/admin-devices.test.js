'use strict'

// Replicate cores directly in memory, as in community-devices.test.js: no
// seeder or sockets are needed to exercise the browser write gates.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const grp = require('@varanda/core/lib/group')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')

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
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce), groupKeys: await holder(t, storage, prf), mediaKeyPair: crypto.keyPair() }
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

async function records (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try { return (await store.readAll(core)).map((e) => e.record) } finally { await core.close() }
}

// Copied from community-devices.test.js: what `s` holds that a second device
// would hold after a sync, with its own key holder.
async function secondDevice (t, s, keys, others = []) {
  const storage = memoryNodeStorage()
  const ctx = { storage, association: s.ctx.association, keyPair: s.ctx.keyPair, groupKeyPair: s.ctx.groupKeyPair, groupKeys: await holder(t, storage, s.prf), mediaKeyPair: crypto.keyPair() }
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
  return { ctx, storage, key: s.key, assoc: s.assoc, prf: s.prf }
}

async function world (t) {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const members = []
  for (const name of ['Bia', 'Caio']) {
    const s = await setup(t, { assoc: a.assoc, name })
    await share(a, s, [community, general])
    await ops.communityJoin(s.ctx, { community })
    await share(s, a, [await ownWriter(s, community), await ownWriter(s, general)])
    members.push(s)
  }
  return { a, b: members[0], x: members[1], community, general }
}

test('a community admin joins on device 2 and moderates without another grant', async (t) => {
  const { a, b, x, community, general } = await world(t)
  const xcw = await ownWriter(x, community)
  const xw = await ownWriter(x, general)
  const { seq } = await ops.groupPost(x.ctx, { group: general, text: 'Oi' })
  await share(x, a, [xcw, xw])
  await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true })
  await share(a, b, [community, xcw, xw])
  await share(x, b, [xcw, xw])
  const before = await records(a, community)
  const d = await secondDevice(t, b, [community, general, await ownWriter(b, community), await ownWriter(b, general), xcw, xw], [a, x])
  t.is((await ops.communityInfo(d.ctx, { community })).authorityHere, false, 'no writer here before joining')
  await ops.communityJoin(d.ctx, { community })
  const cw = await ownWriter(d, community)
  t.absent(before.filter((r) => r.type === 'group-admin').some((r) => r.cuts.some((c) => c.writer === cw)), 'the grant never listed device 2')
  t.is((await ops.communityInfo(d.ctx, { community })).authorityHere, true)
  t.is((await ops.groupInfo(d.ctx, { group: general })).role, 'admin')

  t.alike(await ops.communityBan(d.ctx, { community, member: x.key, on: true }), { ok: true })
  t.is((await ops.communityMembers(d.ctx, { community })).members.find((m) => m.member === x.key).banned, true)
  await ops.communityBan(d.ctx, { community, member: x.key, on: false })
  t.alike(await ops.communityAdmit(d.ctx, { community, member: x.key, on: true }), { ok: true })
  t.alike(await ops.groupHide(d.ctx, { group: general, target: { writer: xw, seq }, on: true }), { ok: true })
  t.is((await ops.groupRead(d.ctx, { group: general })).items.find((p) => p.writer === xw && p.seq === seq).hidden, true)
  t.alike(await ops.groupBan(d.ctx, { group: general, member: x.key, on: true }), { ok: true })
  t.is((await ops.groupMembers(d.ctx, { group: general })).members.find((m) => m.member === x.key).banned, true)
  await ops.groupBan(d.ctx, { group: general, member: x.key, on: false })
  t.alike(await ops.groupAdmit(d.ctx, { group: general, member: x.key, on: true }), { ok: true })
  t.alike(await ops.communityInvitePolicy(d.ctx, { community, members: true }), { ok: true })
  t.alike(await ops.groupInvitePolicy(d.ctx, { group: general, members: true }), { ok: true })
  t.is((await ops.communityInfo(d.ctx, { community })).memberInvite, true)
  t.is((await ops.groupInfo(d.ctx, { group: general })).memberInvite, true)

  await share(d, a, [cw, await ownWriter(d, general)])
  t.is((await ops.communityInfo(a.ctx, { community })).memberInvite, true, 'the creator folds the new CW')
  t.is((await ops.groupRead(a.ctx, { group: general })).items.find((p) => p.writer === xw && p.seq === seq).hidden, true)
  t.alike(await records(a, community), before, 'the root has no new grant or other write')
  t.absent((await records(d, cw)).some((r) => r.type === 'group-admin'), 'device 2 writes no grant')
})

test('a group admin device 2 has authority only from its cover seq', async (t) => {
  const { a, b, x, community } = await world(t)
  const { group } = await ops.groupCreate(a.ctx, { community, name: 'Feira', join: 'approval' })
  for (const s of [b, x]) {
    await share(a, s, [community, group])
    await ops.groupJoin(s.ctx, { group })
    await share(s, a, [await ownWriter(s, group)])
    await ops.groupAdmit(a.ctx, { group, member: s.key, on: true })
    await share(a, s, [group])
  }
  const xw = await ownWriter(x, group)
  const { seq } = await ops.groupPost(x.ctx, { group, text: 'Antes' })
  await share(x, a, [await ownWriter(x, community), xw])
  await share(x, b, [await ownWriter(x, community), xw])
  await share(a, b, [group])
  const d = await secondDevice(t, b, [community, group, await ownWriter(b, community), await ownWriter(b, group), await ownWriter(x, community), xw], [a, x])
  await ops.communityJoin(d.ctx, { community })
  await ops.groupJoin(d.ctx, { group })
  const w = await ownWriter(d, group)
  t.is((await ops.groupInfo(d.ctx, { group })).role, 'member')
  const target = { writer: xw, seq }
  const entry = (await store.readGroupWriters(d.storage)).find((e) => e.group === group)
  const core = await store.openGroupWriter(d.storage, await d.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.nonce, 'hex'))))
  try {
    // This device has not synced back, so the creator cannot list its cut.
    await store.appendGroupRecord(core, grp.groupHide({ target, on: true, seen: target, at: '2000-01-01T00:00:00.000Z' }))
  } finally {
    await core.close()
  }
  await ops.groupAdmin(a.ctx, { group, member: b.key, on: true })
  await share(a, d, [group])
  const before = await records(a, group)
  t.absent(before.filter((r) => r.type === 'group-admin').some((r) => r.cuts.some((c) => c.writer === w)))
  t.is((await ops.groupInfo(d.ctx, { group })).role, 'admin')
  t.is((await ops.communityInfo(d.ctx, { community })).authorityHere, false, 'only a group admin')
  t.is((await ops.groupRead(d.ctx, { group })).items.find((p) => p.writer === xw && p.seq === seq).hidden, false, 'the hide before the cover remains void')
  t.alike(await ops.groupHide(d.ctx, { group, target, on: true }), { ok: true })
  t.is((await ops.groupRead(d.ctx, { group })).items.find((p) => p.writer === xw && p.seq === seq).hidden, true, 'a later hide counts')
  t.alike(await ops.groupBan(d.ctx, { group, member: x.key, on: true }), { ok: true })
  t.is((await ops.groupMembers(d.ctx, { group })).members.find((m) => m.member === x.key).banned, true)
  await ops.groupBan(d.ctx, { group, member: x.key, on: false })
  t.alike(await ops.groupAdmit(d.ctx, { group, member: x.key, on: false }), { ok: true })
  t.ok((await ops.groupRequests(d.ctx, { group })).requests.some((r) => r.member === x.key))
  t.alike(await ops.groupAdmit(d.ctx, { group, member: x.key, on: true }), { ok: true })
  t.is((await ops.groupMembers(d.ctx, { group })).members.find((m) => m.member === x.key).banned, false)
  t.alike(await ops.groupInvitePolicy(d.ctx, { group, members: true }), { ok: true })
  t.is((await ops.groupInfo(d.ctx, { group })).memberInvite, true)
  await share(d, a, [await ownWriter(d, community), w])
  t.is((await ops.groupInfo(a.ctx, { group })).memberInvite, true)
  t.alike(await records(a, group), before, 'no new grant')
  t.absent((await records(d, w)).some((r) => r.type === 'group-admin'))
})

test('a community admin device 2 bans in a private group and rotates its key', async (t) => {
  const { a, b, x, community, general } = await world(t)
  const { group } = await ops.groupCreate(a.ctx, { community, name: 'Conselho', join: 'approval', visibility: 'private' })
  await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true })
  for (const s of [b, x]) {
    await share(a, s, [community, group])
    await ops.groupJoin(s.ctx, { group })
    await share(s, a, [await ownWriter(s, group)])
  }
  await ops.groupAdmit(a.ctx, { group, member: x.key, on: true })
  const xcw = await ownWriter(x, community)
  const xw = await ownWriter(x, group)
  await share(a, b, [group])
  await share(x, b, [xcw, xw])
  const d = await secondDevice(t, b, [community, general, group, await ownWriter(b, community), await ownWriter(b, general), await ownWriter(b, group), xcw, xw], [a, x])
  await ops.communityJoin(d.ctx, { community })
  await ops.groupJoin(d.ctx, { group })
  const cw = await ownWriter(d, community)
  const w = await ownWriter(d, group)
  await share(d, a, [cw, w])
  await ops.groupRekey(a.ctx, { group })
  await share(a, d, [group])
  await share(a, x, [group])
  const rootBefore = await records(a, community)
  const groupBefore = await records(a, group)
  t.is((await ops.communityInfo(d.ctx, { community })).authorityHere, true)
  const before = await ops.groupRead(d.ctx, { group })
  t.ok(before.epoch, 'device 2 opens the existing epoch')
  t.alike(await ops.groupBan(d.ctx, { group, member: x.key, on: true }), { ok: true })
  t.is((await ops.groupMembers(d.ctx, { group })).members.find((m) => m.member === x.key).banned, true)
  const after = await ops.groupRead(d.ctx, { group })
  t.ok(after.epoch, 'the ban leaves a usable epoch')
  t.unlike(after.epoch, before.epoch, 'the ban rotates automatically')
  t.is(after.epoch.writer, w, 'device 2 distributes the new key')
  const keyBlock = (await records(d, w))[after.epoch.seq]
  t.alike(keyBlock.auth, { writer: cw, seq: (await records(d, cw)).length }, 'the key cites the covered CW')
  const post = await ops.groupPost(d.ctx, { group, text: 'Depois do banimento' })
  await share(d, a, [cw, w])
  const read = await ops.groupRead(a.ctx, { group })
  t.ok(read.items.some((p) => p.writer === w && p.seq === post.seq && p.text === 'Depois do banimento'), 'the creator opens the new epoch')
  await share(d, x, [cw, w])
  t.absent((await ops.groupRead(x.ctx, { group })).items.some((p) => p.writer === w && p.seq === post.seq), 'the banned member cannot read the new post')
  await syncOwn(d, b, [cw, w])
  t.ok((await ops.groupRead(b.ctx, { group })).items.some((p) => p.writer === w && p.seq === post.seq && p.text === 'Depois do banimento'), 'device 1 reads device 2')
  t.alike(await records(a, community), rootBefore, 'no new community grant')
  t.alike(await records(a, group), groupBefore, 'no group grant or root rotation')
  for (const key of [cw, w]) t.absent((await records(d, key)).some((r) => r.type === 'group-admin'), 'device 2 writes no grant')
})
