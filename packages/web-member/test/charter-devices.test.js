'use strict'

// The charter (name, join, image, about, admins) written from the creator's
// second device (protocol.md, "Charter from the creator's other devices";
// rpc.md 5.42, 5.59): with no root here, a creator device writes on its own
// live writer once the fold counts it, and device 1 reads the edit with its
// root untouched. Cores move between storages by direct replication; no
// seeder or sockets are involved.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { groupCutRecord } = require('@varanda/core/lib/records')
const { sealMedia } = require('@varanda/core/lib/group-media')
const grp = require('@varanda/core/lib/group')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')
const FORBIDDEN_C = /sem permissão na comunidade/
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

async function coreLength (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  if (core === null) return 0
  try { return core.length } finally { await core.close() }
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

async function photo (m) {
  const bytes = b4a.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 2, 0, 2, 0, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0, 2, 0xff, 0xd9])
  const { core, declared } = await ops.mediaPrepare(m.ctx)
  if (!declared) await ops.declareMediaCore(m.ctx, core)
  const sha256 = hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)))
  return ops.mediaCommit(m.ctx, { blocks: [bytes], sha256, mime: 'image/jpeg', width: 512, height: 512 })
}

async function sealedPhoto (m) {
  const jpeg = b4a.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 2, 0, 2, 0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9])
  const { core, declared } = await ops.mediaPrepare(m.ctx)
  if (!declared) await ops.declareMediaCore(m.ctx, core)
  return ops.mediaCommitSealed(m.ctx, sealMedia(jpeg, { plainMime: 'image/jpeg', w: 512, h: 512 }))
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

test('community: the creator\'s second device writes the charter on its own CW after it joins', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  const bcw = await ownWriter(b, community)
  const rootBefore = await coreLength(a, community)
  const d = await secondDevice(t, a, [community, general, bcw], [b])

  t.is((await ops.communityInfo(d.ctx, { community })).charterHere, false, 'false before the join')
  await t.exception(() => ops.communityMeta(d.ctx, { community, name: 'Vila' }), FORBIDDEN_C, 'refused before the join')

  await ops.communityJoin(d.ctx, { community })
  const cw = await ownWriter(d, community)
  t.is((await ops.communityInfo(d.ctx, { community })).charterHere, true, 'device 2 writes the charter')
  t.is((await ops.communityInfo(d.ctx, { community })).rootHere, false, 'without the root')
  t.is((await ops.communityInfo(a.ctx, { community })).charterHere, true, 'device 1 too')
  const { group: feira } = await ops.groupCreate(d.ctx, { name: 'Feira', join: 'open', community })
  const create = (await records(d, cw)).at(-1)
  t.alike([create.type, create.group], ['group-create', feira], 'device 2 creates a group on its CW')

  t.alike(await ops.communityMeta(d.ctx, { community, name: 'Vila' }), { ok: true })
  const meta = (await records(d, cw)).at(-1)
  t.alike([meta.type, meta.group, meta.name, meta.join], ['group-meta', null, 'Vila', 'open'], 'the CW meta shape')
  t.alike(meta.seen, { writer: community, seq: rootBefore - 1 }, 'it names the root\'s latest record, not the fold\'s last')
  t.alike(await ops.communityAbout(d.ctx, { community, about: 'Sobre a vila' }), { ok: true })
  const image = await photo(d)
  t.alike(await ops.communityImage(d.ctx, { community, image }), { ok: true })
  t.alike(await ops.communitySetAdmin(d.ctx, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  const grant = (await records(d, cw)).at(-1)
  t.alike([grant.type, grant.group, grant.member, grant.on], ['group-admin', null, b.key, true], 'communityGrant on the CW')

  const here = await ops.communityInfo(d.ctx, { community })
  t.alike([here.name, here.join, here.about, here.image, here.admins], ['Vila', 'open', 'Sobre a vila', image, 2], 'device 2 folds each')

  await syncOwn(d, a, [cw])
  const one = await ops.communityInfo(a.ctx, { community })
  t.alike([one.name, one.join, one.about, one.image, one.imageAuthor, one.admins], ['Vila', 'open', 'Sobre a vila', image, a.key, 2], 'device 1 folds each')
  t.ok(one.groups.some((g) => g.group === feira), 'device 1 lists the group device 2 created')
  t.is(await coreLength(a, community), rootBefore, 'device 1\'s root length is unchanged')
  t.is(await coreLength(d, community), rootBefore, 'device 2 appends nothing to its root copy')

  t.alike(await ops.communitySetAdmin(d.ctx, { community, member: b.key, on: false }), { community, member: b.key, on: false })
  const demote = (await records(d, cw)).at(-1)
  t.alike([demote.type, demote.group, demote.member, demote.on], ['group-admin', null, b.key, false], 'communityDemote on the CW')
  t.alike(demote.seen, { writer: grant.seen.writer, seq: grant.seen.seq }, 'the own grant ranks nothing: it names what the grant named')
  await syncOwn(d, a, [cw])
  t.is((await ops.communityInfo(a.ctx, { community })).admins, 1, 'device 1 sees the demotion')

  t.alike(await ops.communityMeta(d.ctx, { community, join: 'approval' }), { ok: true })
  await syncOwn(d, a, [cw])
  const last = await ops.communityInfo(a.ctx, { community })
  t.alike([last.name, last.join], ['Vila', 'approval'], 'device 1 reads the join change')
  t.is(await coreLength(a, community), rootBefore)
})

test('community: a non-creator admin\'s second device stays refused', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true })
  await share(a, b, [community])
  const bd = await secondDevice(t, b, [community, general, await ownWriter(b, community), await ownWriter(b, general)], [a])
  await ops.communityJoin(bd.ctx, { community })
  const info = await ops.communityInfo(bd.ctx, { community })
  t.alike([info.role, info.charterHere], ['admin', false])
  await t.exception(() => ops.communityMeta(bd.ctx, { community, name: 'Outra' }), FORBIDDEN_C)
  await t.exception(() => ops.communitySetAdmin(bd.ctx, { community, member: a.key, on: false }), FORBIDDEN_C)
  await t.exception(() => ops.groupMeta(bd.ctx, { group: general, name: 'Outra' }), FORBIDDEN_G)
  t.is((await ops.groupInfo(bd.ctx, { group: general })).charterHere, false)
})

// A standalone group (no community) or a group of a community: `a` creates
// it, member `b` joins, `d` is a's second device.
async function groupWorld (t, { community = false, visibility = 'public' } = {}) {
  if (community) {
    const { a, members: [b], community: C, general } = await world(t, 1)
    const { group } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open', community: C })
    await share(a, b, [C, group])
    await ops.groupJoin(b.ctx, { group })
    const bcw = await ownWriter(b, C)
    const bw = await ownWriter(b, group)
    await share(b, a, [bw])
    const d = await secondDevice(t, a, [C, general, group, bcw, bw], [b])
    return { a, b, d, group, C }
  }
  const a = await setup(t)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open' })
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  await share(a, b, [group])
  await ops.groupJoin(b.ctx, { group })
  const bw = await ownWriter(b, group)
  await share(b, a, [bw])
  const d = await secondDevice(t, a, [group, bw], [b])
  return { a, b, d, group, C: null }
}

async function groupCharterFromSecondDevice (t, { community }) {
  const { a, b, d, group, C } = await groupWorld(t, { community })
  const rootBefore = await coreLength(a, group)
  if (C !== null) await ops.communityJoin(d.ctx, { community: C })
  t.is((await ops.groupInfo(d.ctx, { group })).charterHere, false, 'false before the join')
  await t.exception(() => ops.groupMeta(d.ctx, { group, name: 'Outra' }), FORBIDDEN_G, 'refused before the join')
  await ops.groupJoin(d.ctx, { group })
  const w = await ownWriter(d, group)
  const info = await ops.groupInfo(d.ctx, { group })
  t.alike([info.charterHere, info.rootHere, info.rootAuthority], [true, false, true], 'device 2 writes the charter without the root')
  t.is((await ops.groupInfo(a.ctx, { group })).charterHere, true, 'device 1 too')

  t.alike(await ops.groupMeta(d.ctx, { group, name: 'Mercado' }), { ok: true })
  const meta = (await records(d, w)).at(-1)
  t.alike([meta.type, meta.name, meta.seen], ['group-meta', 'Mercado', { writer: group, seq: rootBefore - 1 }], 'root shape, naming the root\'s latest record')
  await ops.groupAbout(d.ctx, { group, about: 'Sobre' })
  const image = await photo(d)
  t.alike(await ops.groupImage(d.ctx, { group, image }), { ok: true })
  t.is((await records(d, w)).at(-1).type, 'group-image', 'the image on the own writer')
  await ops.groupAdmin(d.ctx, { group, member: b.key, on: true })
  const grant = (await records(d, w)).at(-1)
  t.alike([grant.type, grant.member, grant.on], ['group-admin', b.key, true])
  const keys = C === null ? [w] : [w, await ownWriter(d, C)]
  await syncOwn(d, a, keys)
  const one = await ops.groupInfo(a.ctx, { group })
  t.alike([one.name, one.about, one.image], ['Mercado', 'Sobre', image], 'device 1 folds name, about and image')
  t.ok((await ops.groupMembers(a.ctx, { group })).members.find((m) => m.member === b.key).admin, 'device 1 sees the admin')
  await ops.groupAdmin(d.ctx, { group, member: b.key, on: false })
  await ops.groupMeta(d.ctx, { group, join: 'approval' })
  await syncOwn(d, a, keys)
  const two = await ops.groupInfo(a.ctx, { group })
  t.is(two.join, 'approval', 'device 1 reads the join change')
  t.absent((await ops.groupMembers(a.ctx, { group })).members.find((m) => m.member === b.key && m.admin), 'device 1 sees the demotion')
  t.is(await coreLength(a, group), rootBefore, 'device 1\'s root length is unchanged')
  return { a, b, d, group, w }
}

test('standalone public group: the creator\'s second device writes the charter', async (t) => {
  await groupCharterFromSecondDevice(t, { community: false })
})

test('group of a community: the creator\'s second device writes the charter', async (t) => {
  await groupCharterFromSecondDevice(t, { community: true })
})

test('a second device\'s rename survives a member post naming a future seq; a later root rename wins', async (t) => {
  const { a, b, d, group } = await groupWorld(t)
  await ops.groupMeta(a.ctx, { group, name: 'Um' })
  await copyCore(a, d, group)
  await ops.groupJoin(d.ctx, { group })
  const w = await ownWriter(d, group)
  await ops.groupMeta(d.ctx, { group, name: 'Dois' })
  // b's post names a root seq nobody holds yet: as the fold's `last` it would
  // rank a rename naming it below every root record.
  const bw = await ownWriter(b, group)
  const entry = (await store.readGroupWriters(b.storage)).find((e) => e.group === group)
  const core = await store.openGroupWriter(b.storage, await b.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.nonce, 'hex'))))
  try {
    await store.appendGroupRecord(core, grp.groupPost({ text: 'adiante', seen: { writer: group, seq: 999 } }))
  } finally {
    await core.close()
  }
  await copyCore(b, a, bw)
  await copyCore(b, d, bw)
  await syncOwn(d, a, [w])
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Dois', 'device 1 reads device 2\'s rename')
  t.is((await ops.groupInfo(d.ctx, { group })).name, 'Dois')
  await ops.groupMeta(a.ctx, { group, name: 'Tres' })
  await copyCore(a, d, group)
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Tres', 'the later root rename wins on device 1')
  t.is((await ops.groupInfo(d.ctx, { group })).name, 'Tres', 'and on device 2')
})

test('a third device names the second device\'s winning rename in seen', async (t) => {
  const { a, d, group } = await groupWorld(t)
  await ops.groupJoin(d.ctx, { group })
  const w2 = await ownWriter(d, group)
  const d3 = await secondDevice(t, d, [group, w2])
  await ops.groupJoin(d3.ctx, { group })
  const w3 = await ownWriter(d3, group)
  await syncOwn(d3, d, [w3])
  await ops.groupMeta(d.ctx, { group, name: 'Dois' })
  await copyCore(d, d3, w2)
  await ops.groupMeta(d3.ctx, { group, name: 'Tres' })
  const r2 = (await records(d, w2)).length - 1
  t.alike((await records(d3, w3)).at(-1).seen, { writer: w2, seq: r2 }, 'it names the sibling record that wins')
  await syncOwn(d3, a, [w2, w3])
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Tres', 'device 1 reads the third device\'s rename')
})

test('a charter record carries an at past every own group-cut mark, so a cut writer\'s planted record never outranks it', async (t) => {
  const { a, d, group } = await groupWorld(t)
  await ops.groupMeta(a.ctx, { group, name: 'Um' })
  await copyCore(a, d, group)
  await ops.groupJoin(d.ctx, { group })
  const w2 = await ownWriter(d, group)
  const d3 = await secondDevice(t, d, [group, w2])
  await ops.groupJoin(d3.ctx, { group })
  const w3 = await ownWriter(d3, group)
  // A record on device 3 naming the seq device 2 writes next.
  const entry = (await store.readGroupWriters(d3.storage)).find((e) => e.group === group)
  const core = await store.openGroupWriter(d3.storage, await d3.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.nonce, 'hex'))))
  try {
    await store.appendGroupRecord(core, grp.groupMeta({ name: 'Ladrao', join: 'open', seen: { writer: w2, seq: await coreLength(d, w2) } }))
  } finally {
    await core.close()
  }
  await syncOwn(d3, d, [w3])
  // The creator cuts device 3 with a mark dated ahead of this device's clock.
  const future = new Date(Date.now() + 3600 * 1000).toISOString()
  const diary = await store.openDiary(d.storage, d.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupCutRecord({ group, writer: w3, cut: await coreLength(d, w3), at: future }))
  } finally {
    await diary.close()
  }
  await ops.groupMeta(d.ctx, { group, name: 'Dono' })
  const r = (await records(d, w2)).at(-1)
  t.ok(Date.parse(r.at) > Date.parse(future), 'at past the mark')
  t.is((await ops.groupInfo(d.ctx, { group })).name, 'Dono', 'the rename takes effect after the cut')
})

test('private group: the creator\'s second device writes the sealed charter', async (t) => {
  const a = await setup(t)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private' })
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  await share(a, b, [group])
  await ops.groupJoin(b.ctx, { group })
  const bw = await ownWriter(b, group)
  await share(b, a, [bw])
  await ops.groupAdmit(a.ctx, { group, member: b.key, on: true })
  const d = await secondDevice(t, a, [group, bw], [b])
  t.is((await ops.groupInfo(d.ctx, { group })).charterHere, false, 'false before the join')
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike((await ops.deviceUpkeep(d.ctx, plan)).failed, [])
  const w = await ownWriter(d, group)
  await syncOwn(d, a, [w])
  await ops.deviceUpkeep(a.ctx, await ops.deviceUpkeepPlan(a.ctx))
  await copyCore(a, d, group)
  t.is((await ops.groupInfo(d.ctx, { group })).charterHere, true, 'device 2 writes the charter')
  const rootHere = await coreLength(d, group)
  t.alike(await ops.groupMeta(d.ctx, { group, name: 'Cofre' }), { ok: true })
  await ops.groupAbout(d.ctx, { group, about: 'Sobre' })
  const image = await sealedPhoto(d)
  t.alike(await ops.groupImage(d.ctx, { group, image }), { ok: true })
  t.ok((await records(d, w)).slice(-3).every((r) => r.type === 'group-sealed'), 'sealed on the own writer')
  await syncOwn(d, a, [w])
  const one = await ops.groupInfo(a.ctx, { group })
  t.alike([one.name, one.about, one.image], ['Cofre', 'Sobre', image], 'device 1 opens and folds each')
  t.is(await coreLength(d, group), rootHere, 'device 2 appends nothing to its root copy')
  t.is((await ops.groupInfo(a.ctx, { group })).charterHere, true, 'device 1 still writes the charter')
  const rootOne = await coreLength(a, group)
  await ops.groupAdmin(d.ctx, { group, member: b.key, on: true })
  const grant = (await records(d, w)).at(-1)
  t.alike([grant.type, grant.member, grant.on], ['group-admin', b.key, true], 'the grant on device 2\'s own writer')
  await syncOwn(d, a, [w])
  t.ok((await ops.groupMembers(a.ctx, { group })).members.find((m) => m.member === b.key).admin, 'device 1 sees the admin')
  await ops.groupAdmin(d.ctx, { group, member: b.key, on: false })
  t.alike((await records(d, w)).filter((r) => r.type === 'group-admin').at(-1).on, false, 'the demotion on device 2\'s own writer')
  await syncOwn(d, a, [w])
  t.absent((await ops.groupMembers(a.ctx, { group })).members.find((m) => m.member === b.key && m.admin), 'device 1 sees the demotion')
  t.is(await coreLength(a, group), rootOne, 'device 1\'s root length is unchanged')
})

// A private group whose creator has two non-root devices, d2 and d3, both
// enrolled and holding the current epoch.
async function privateThreeDevices (t) {
  const a = await setup(t)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private' })
  const d2 = await secondDevice(t, a, [group])
  await ops.deviceUpkeep(d2.ctx, await ops.deviceUpkeepPlan(d2.ctx))
  const w2 = await ownWriter(d2, group)
  await syncOwn(d2, a, [w2])
  const d3 = await secondDevice(t, a, [group, w2])
  await ops.deviceUpkeep(d3.ctx, await ops.deviceUpkeepPlan(d3.ctx))
  const w3 = await ownWriter(d3, group)
  await syncOwn(d3, a, [w3])
  await ops.deviceUpkeep(a.ctx, await ops.deviceUpkeepPlan(a.ctx))
  await syncOwn(a, d2, [group, w3])
  await syncOwn(a, d3, [group, w2])
  return { a, d2, d3, group, w2, w3 }
}

test('private group: two non-root devices take turns renaming and each latest rename wins', async (t) => {
  const { a, d2, d3, group, w2, w3 } = await privateThreeDevices(t)
  t.is((await ops.groupInfo(d2.ctx, { group })).charterHere, true)
  t.is((await ops.groupInfo(d3.ctx, { group })).charterHere, true)
  await ops.groupMeta(d2.ctx, { group, name: 'Dois' })
  await copyCore(d2, d3, w2)
  await ops.groupMeta(d3.ctx, { group, name: 'Tres' })
  await copyCore(d3, d2, w3)
  await copyCore(d2, a, w2)
  await copyCore(d3, a, w3)
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Tres', 'device 3\'s rename after device 2\'s wins on device 1')
  await ops.groupMeta(d2.ctx, { group, name: 'Quatro' })
  await copyCore(d2, a, w2)
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Quatro', 'device 2\'s later rename wins on device 1')
  t.is((await ops.groupInfo(d2.ctx, { group })).name, 'Quatro', 'and on device 2')
  // Device 2's own sealed rename wins now; its next one names what that names.
  await ops.groupMeta(d2.ctx, { group, name: 'Cinco' })
  await copyCore(d2, a, w2)
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Cinco', 'device 2\'s second rename in a row wins on device 1')
})

test('a sibling rename past its writer\'s diary cut is never named in seen; a live device\'s rename wins', async (t) => {
  const { a, d, group } = await groupWorld(t)
  await ops.groupMeta(a.ctx, { group, name: 'Um' })
  await copyCore(a, d, group)
  await ops.groupJoin(d.ctx, { group })
  const w2 = await ownWriter(d, group)
  const d3 = await secondDevice(t, d, [group, w2])
  await ops.groupJoin(d3.ctx, { group })
  const w3 = await ownWriter(d3, group)
  await syncOwn(d3, d, [w3])
  t.is(await coreLength(d, w3), 1, 'device 3\'s writer holds only its header')
  // The creator cuts device 3 at seq 1; device 3, not holding the mark, renames.
  const diary = await store.openDiary(d.storage, d.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupCutRecord({ group, writer: w3, cut: 1, at: new Date().toISOString() }))
  } finally {
    await diary.close()
  }
  await ops.groupMeta(d3.ctx, { group, name: 'Ladrao' })
  await copyCore(d3, d, w3)
  t.is((await ops.groupInfo(d.ctx, { group })).name, 'Um', 'the cut rename counts nothing')
  await ops.groupMeta(d.ctx, { group, name: 'Dono' })
  t.alike((await records(d, w2)).at(-1).seen, { writer: group, seq: (await coreLength(d, group)) - 1 }, 'it names the root')
  await syncOwn(d, a, [w2, w3])
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Dono', 'device 1 reads the live device\'s rename')
  t.is((await ops.groupInfo(d.ctx, { group })).name, 'Dono', 'and device 2')
})

test('one sibling device renames twice in a row and both renames take effect', async (t) => {
  const { a, d, group } = await groupWorld(t)
  await ops.groupJoin(d.ctx, { group })
  const w2 = await ownWriter(d, group)
  await ops.groupMeta(d.ctx, { group, name: 'Dois' })
  await syncOwn(d, a, [w2])
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Dois', 'the first rename on device 1')
  await ops.groupMeta(d.ctx, { group, name: 'Tres' })
  await copyCore(d, a, w2)
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Tres', 'the second rename on device 1')
  t.is((await ops.groupInfo(d.ctx, { group })).name, 'Tres', 'and on device 2')
})

test('a sibling device whose rename named another sibling renames again and wins', async (t) => {
  const { a, d, group } = await groupWorld(t)
  await ops.groupJoin(d.ctx, { group })
  const w2 = await ownWriter(d, group)
  const d3 = await secondDevice(t, d, [group, w2])
  await ops.groupJoin(d3.ctx, { group })
  const w3 = await ownWriter(d3, group)
  await syncOwn(d3, d, [w3])
  await ops.groupMeta(d3.ctx, { group, name: 'Tres' })
  await copyCore(d3, d, w3)
  await ops.groupMeta(d.ctx, { group, name: 'Dois' })
  await ops.groupMeta(d.ctx, { group, name: 'Quatro' })
  await syncOwn(d, a, [w2, w3])
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Quatro', 'the second rename wins on device 1')
  t.is((await ops.groupInfo(d.ctx, { group })).name, 'Quatro', 'and on device 2')
})

test('group of a community: after the creator\'s leave cut G\'s root, its second device demotes through its CW', async (t) => {
  const { a, members: [b], community: C, general } = await world(t, 1)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open', community: C })
  await share(a, b, [C, group])
  await ops.groupJoin(b.ctx, { group })
  const bcw = await ownWriter(b, C)
  const bw = await ownWriter(b, group)
  await share(b, a, [bw])
  await ops.groupAdmin(a.ctx, { group, member: b.key, on: true })
  t.alike(await ops.communityLeave(a.ctx, { community: C }), { state: 'left' })
  const d = await secondDevice(t, a, [C, general, group, bcw, bw], [b])
  t.is((await ops.communityJoin(d.ctx, { community: C })).state, 'member')
  await ops.groupJoin(d.ctx, { group })
  const cw = await ownWriter(d, C)
  const w = await ownWriter(d, group)
  const info = await ops.groupInfo(d.ctx, { group })
  t.alike([info.charterHere, info.rootAuthority], [false, false], 'no charter writer once the root is cut')
  await t.exception(() => ops.groupMeta(d.ctx, { group, name: 'Outra' }), FORBIDDEN_G, 'a rename is refused')
  await ops.groupAdmin(d.ctx, { group, member: b.key, on: false })
  const demote = (await records(d, cw)).at(-1)
  t.alike([demote.type, demote.group, demote.member, demote.on], ['group-admin', group, b.key, false], 'the demotion on the CW')
  t.absent((await ops.groupMembers(d.ctx, { group })).members.find((m) => m.member === b.key && m.admin), 'device 2 sees the demotion')
  await syncOwn(d, a, [cw, w])
  t.absent((await ops.groupMembers(a.ctx, { group })).members.find((m) => m.member === b.key && m.admin), 'device 1 sees the demotion')
})

test('standalone group: after the creator leaves, its second device has no charter writer', async (t) => {
  const { d, group } = await groupWorld(t)
  await ops.groupJoin(d.ctx, { group })
  t.is((await ops.groupInfo(d.ctx, { group })).charterHere, true)
  await ops.groupLeave(d.ctx, { group })
  t.is((await ops.groupInfo(d.ctx, { group })).charterHere, false, 'false after the leave')
  await t.exception(() => ops.groupMeta(d.ctx, { group, name: 'Outra' }), FORBIDDEN_G, 'a rename is refused')
})

test('community: after the creator leaves, its second device has no charter writer', async (t) => {
  const { a, community } = await world(t, 1)
  const d = await secondDevice(t, a, [community])
  await ops.communityJoin(d.ctx, { community })
  t.is((await ops.communityInfo(d.ctx, { community })).charterHere, true)
  await ops.communityLeave(d.ctx, { community, force: true })
  t.is((await ops.communityInfo(d.ctx, { community })).charterHere, false, 'false after the leave')
  await t.exception(() => ops.communityMeta(d.ctx, { community, name: 'Outra' }), FORBIDDEN_C, 'a rename is refused')
})

// A holder that never hands out the epoch `kid`, as for an epoch the fold
// keeps only for reading (a departed or demoted distributor's), which no
// fold reports to the holder.
function withoutEpoch (h, kid) {
  const hidden = (k) => k !== null && typeof k === 'object' && k.writer === kid.writer && k.seq === kid.seq
  return {
    unlock: (...x) => h.unlock(...x),
    lock: () => h.lock(),
    signOut: () => h.signOut(),
    close: () => h.close(),
    token: () => h.token(),
    boxKeyPair: () => h.boxKeyPair(),
    boxPublicKey: () => h.boxPublicKey(),
    put: (tok, k, key) => hidden(k) ? true : h.put(tok, k, key),
    get: (k) => hidden(k) ? null : h.get(k),
    has: (k) => hidden(k) ? false : h.has(k),
    get size () { return h.size },
    get unlocked () { return h.unlocked },
    get closed () { return h.closed }
  }
}

test('private group: a device reopens its own winning rename sealed under an epoch its holder lacks', async (t) => {
  const { a, d2, d3, group, w2, w3 } = await privateThreeDevices(t)
  await ops.groupMeta(d3.ctx, { group, name: 'Tres' })
  await copyCore(d3, d2, w3)
  await ops.groupMeta(d2.ctx, { group, name: 'Dois' })
  const old = (await records(d2, w2)).at(-1).kid
  // Device 3 rotates on its own writer, so the root does not move on.
  const rootLen = await coreLength(a, group)
  await ops.groupRekey(d3.ctx, { group })
  await copyCore(d3, d2, w3)
  // A restart whose folds no longer hand on the epoch the rename was sealed under.
  d2.ctx.groupKeys = withoutEpoch(await holder(t, d2.storage, d2.prf), old)
  await ops.groupMeta(d2.ctx, { group, name: 'Quatro' })
  const env = (await records(d2, w2)).at(-1)
  t.not(env.kid.seq === old.seq && env.kid.writer === old.writer, true, 'sealed under the new epoch')
  await copyCore(d2, a, w2)
  await copyCore(d3, a, w3)
  t.is(await coreLength(a, group), rootLen, 'the root did not move')
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Quatro', 'the rename after the rekey wins on device 1')
})

test('group of a community: a CW demotion on a marked G root waits for C\'s gate, then counts', async (t) => {
  const { a, members: [b], community: C, general } = await world(t, 1)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open', community: C })
  await share(a, b, [C, group])
  await ops.groupJoin(b.ctx, { group })
  const bcw = await ownWriter(b, C)
  const bw = await ownWriter(b, group)
  await share(b, a, [bw])
  await ops.groupAdmin(a.ctx, { group, member: b.key, on: true })
  const d = await secondDevice(t, a, [C, general, group, bcw, bw], [b])
  await ops.communityJoin(d.ctx, { community: C })
  await ops.groupJoin(d.ctx, { group })
  const cw1 = await ownWriter(d, C)
  const w1 = await ownWriter(d, group)
  // A mark on G's root while C's root keeps its powers: C's gate is closed.
  const diary = await store.openDiary(d.storage, d.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupCutRecord({ group, writer: group, cut: await coreLength(d, group) }))
  } finally {
    await diary.close()
  }
  t.is((await ops.communityInfo(d.ctx, { community: C })).rootAuthority, true)
  const before = await coreLength(d, cw1)
  await t.exception(() => ops.groupAdmin(d.ctx, { group, member: b.key, on: false }), /a saída anterior ainda não foi confirmada/, 'refused before the gate')
  t.is(await coreLength(d, cw1), before, 'nothing written')
  // The creator leaves C from the root's device and comes back on device 2.
  await syncOwn(d, a, [cw1, w1])
  t.alike(await ops.communityLeave(a.ctx, { community: C }), { state: 'left' })
  await syncOwn(a, d, [C, general, group])
  t.is((await ops.communityJoin(d.ctx, { community: C })).state, 'member')
  await ops.groupJoin(d.ctx, { group })
  const cw2 = await ownWriter(d, C)
  const w2 = await ownWriter(d, group)
  t.alike(await ops.groupAdmin(d.ctx, { group, member: b.key, on: false }), { ok: true })
  t.alike((await records(d, cw2)).at(-1).type, 'group-admin', 'the demotion on the new CW')
  t.absent((await ops.groupMembers(d.ctx, { group })).members.find((m) => m.member === b.key && m.admin), 'device 2 sees the demotion')
  await syncOwn(d, a, [cw2, w2])
  t.absent((await ops.groupMembers(a.ctx, { group })).members.find((m) => m.member === b.key && m.admin), 'device 1 sees the demotion')
})
