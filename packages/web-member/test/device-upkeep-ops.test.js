'use strict'

// A second device of the same account enrols by itself in the roots its
// diary already binds (deviceUpkeepPlan, deviceUpkeep), keeps the last two
// writer slots for an explicit tap, and a distributor hands the epoch keys
// it holds to the account's new writers without a rotation. Cores move
// between storages by direct replication; no seeder or sockets.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { groupJoinRecord, groupCutRecord } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')
const { rootReader } = require('./helpers/root-reader')

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

// Copies `from`'s diary and the group cores `keys` (held by `from`) to `to`.
async function share (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to.storage, from.key))
  for (const key of keys) await copyCore(from, to, key)
  await store.addGroupDiary(to.storage, from.key)
}

// The own diary of a sibling device brought up to date, as the sync does.
async function syncDiary (from, to) {
  await pipe(await store.openDiary(from.storage), await store.openDiary(to.storage))
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
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

// A second device of `s`: same keyPair, group key function and PRF (its own
// box, from its own device nonce), fresh storage holding `s`'s diary, the
// roots `keys` and the diaries of `others`.
async function secondDevice (t, s, keys, others = []) {
  const storage = memoryNodeStorage()
  const ctx = { storage, association: s.ctx.association, keyPair: s.ctx.keyPair, groupKeyPair: s.ctx.groupKeyPair, groupKeys: await holder(t, storage, s.prf) }
  await ops.idCreate(ctx)
  await pipe(await store.openDiary(s.storage), await store.openDiary(storage))
  for (const key of keys) await copyCore(s, { storage }, key)
  await store.addGroupDiary(storage, s.key)
  for (const o of others) {
    await pipe(await store.openReplica(s.storage, o.key), await store.openReplica(storage, o.key))
    await store.addGroupDiary(storage, o.key)
  }
  return { ctx, storage, key: s.key, assoc: s.assoc, prf: s.prf }
}

async function diaryLength (s) {
  const core = await store.openDiary(s.storage)
  try {
    return core.length
  } finally {
    await core.close()
  }
}

async function diaryJoins (s) {
  const core = await store.openDiary(s.storage)
  try {
    return (await store.readAll(core)).map((e) => e.record).filter((r) => r.type === 'group-join')
  } finally {
    await core.close()
  }
}

async function diaryRecords (s) {
  const core = await store.openDiary(s.storage)
  try {
    return (await store.readAll(core)).map((e) => e.record)
  } finally {
    await core.close()
  }
}

async function coreRecords (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try {
    return (await store.readAll(core)).map((e) => e.record)
  } finally {
    await core.close()
  }
}

// What a device wrote: its diary length and its kv groupWriters.
async function footprint (s) {
  return { length: await diaryLength(s), writers: await store.readGroupWriters(s.storage) }
}

// A writer core of `s`'s diary in `group`, bound by an on-join in the diary.
async function rawDevice (s, group, list, community = false) {
  const kp = await s.ctx.groupKeyPair(new Uint8Array(crypto.randomBytes(32)))
  const core = await store.openGroupWriter(s.storage, kp)
  try {
    for (const record of list) await store.appendGroupRecord(core, record, { root: false, community })
  } finally { await core.close() }
  const key = hex(kp.publicKey)
  await store.addGroupReplica(s.storage, key)
  const diary = await store.openDiary(s.storage, s.ctx.keyPair)
  try { await store.appendRecord(diary, groupJoinRecord({ group, writer: key, on: true })) } finally { await diary.close() }
  return key
}

const reasons = (plan) => plan.skipped.map((x) => [x.root, x.reason])

test('member-ops exports the device upkeep and its reserve', async (t) => {
  t.is(typeof ops.deviceUpkeepPlan, 'function')
  t.is(typeof ops.deviceUpkeep, 'function')
  t.is(typeof ops.AUTO_ENROL_RESERVE, 'number')
})

test('the creator\'s second device enrols by itself in the community, Geral and its groups, once', async (t) => {
  const { a, community, general } = await world(t)
  const { group: feira } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open', community })
  const d = await secondDevice(t, a, [community, general, feira])

  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol, [{ root: community, kind: 'community', community: null }, { root: general, kind: 'group', community }, { root: feira, kind: 'group', community }])
  t.alike(reasons(plan), [], 'Geral is planned as a group')
  t.alike(plan.share, [])

  const before = await diaryLength(d)
  const res = await ops.deviceUpkeep(d.ctx, plan)
  t.alike(res.enrolled, [
    { root: community, kind: 'community', state: 'member', group: null },
    { root: general, kind: 'group', state: 'member', group: null },
    { root: feira, kind: 'group', state: 'member', group: null }
  ])
  t.alike(res.failed, [])
  t.alike(res.shared, [])
  t.alike([...res.changed].sort(), [community, general, feira].sort())

  const entries = await store.readGroupWriters(d.storage)
  const cw = entries.find((e) => e.group === community)
  t.alike([cw.kind, cw.rootNonce], ['community', null], 'a non-root community writer')
  t.ok(entries.find((e) => e.group === general), 'a Geral writer')
  t.ok(entries.find((e) => e.group === feira), 'a Feira writer')
  const added = (await diaryJoins(d)).slice(-3)
  t.is(await diaryLength(d), before + 3, 'three joins, nothing else')
  t.ok(added.every((j) => j.on === true), 'on-joins')
  t.alike(added.map((j) => j.group), [community, general, feira])

  const info = await ops.communityInfo(d.ctx, { community })
  t.alike([info.writerHere, info.canWrite, info.writersBound], [true, true, 2])
  const gi = await ops.groupInfo(d.ctx, { group: feira })
  t.alike([gi.writerHere, gi.canWrite, gi.writersBound], [true, true, 2])
  t.is(info.generalWritersBound, (await ops.groupInfo(d.ctx, { group: general })).writersBound, 'Geral count')

  const again = await ops.deviceUpkeepPlan(d.ctx)
  t.alike([again.enrol, again.share, again.skipped], [[], [], []], 'nothing left to plan')
  const still = await footprint(d)
  t.alike(await ops.deviceUpkeep(d.ctx, plan), { enrolled: [], shared: [], failed: [], changed: [] }, 'an old plan writes nothing')
  t.alike(await footprint(d), still)
})

test('only the keys both the caller and a fresh plan name are acted on', async (t) => {
  const { a, community, general } = await world(t)
  const d = await secondDevice(t, a, [community, general])
  const stranger = hex(crypto.randomBytes(32))
  const before = await footprint(d)
  const res = await ops.deviceUpkeep(d.ctx, { enrol: [{ root: stranger, kind: 'community' }], share: [{ group: stranger }] })
  t.alike(res, { enrolled: [], shared: [], failed: [], changed: [] })
  t.alike(await footprint(d), before, 'a key no plan names writes nothing')
  t.alike((await ops.deviceUpkeep(d.ctx, {})).enrolled, [], 'no keys, no writes')
  t.alike(await footprint(d), before)
})

test('reserve: the diary binding 6 of the 8 writers skips the automatic path, an explicit join still works', async (t) => {
  const { a, community, general } = await world(t)
  // The creator's root writer is one; five more devices make six.
  const extra = []
  for (let i = 0; i < 5; i++) {
    extra.push(await rawDevice(a, community, [grp.writerHeader({ group: community, diary: a.key, member: null })], true))
  }
  const d = await secondDevice(t, a, [community, general, ...extra])
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol, [])
  t.alike(reasons(plan), [[community, 'reserve'], [general, 'community-first']])
  t.is((await ops.communityInfo(d.ctx, { community })).writersBound, 6)

  const before = await footprint(d)
  const res = await ops.deviceUpkeep(d.ctx, { enrol: [{ root: community }] })
  t.alike(res.enrolled, [])
  t.alike(await footprint(d), before, 'nothing written')

  t.alike(await ops.communityJoin(d.ctx, { community }), { state: 'member', group: general }, 'the explicit tap spends the 7th')
  t.is((await ops.communityInfo(d.ctx, { community })).writersBound, 7)
})

test('a cut that freezes a writer gives its live slot back to the automatic enrolment (#350)', async (t) => {
  const { a, community, general } = await world(t)
  // The creator's root writer and five more devices: six bound, one frozen.
  const extra = []
  for (let i = 0; i < 5; i++) {
    extra.push(await rawDevice(a, community, [grp.writerHeader({ group: community, diary: a.key, member: null })], true))
  }
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  try { await store.appendRecord(diary, groupCutRecord({ group: community, writer: extra[0], cut: 1 })) } finally { await diary.close() }
  const d = await secondDevice(t, a, [community, general, ...extra])
  const info = await ops.communityInfo(d.ctx, { community })
  t.alike([info.writersBound, info.writersFrozen], [5, 1], 'five live slots, one frozen')
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol.map((x) => x.root), [community, general], 'below the reserve')
  t.alike(reasons(plan), [])
})

test('a left, blocklisted or unheld root is never enrolled', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await ops.communityJoin(b.ctx, { community })
  // Device 2 joins and leaves: that ends every device's writer while device
  // 1's join stays on, so the diary still binds the root.
  const d2 = await secondDevice(t, b, [community, general], [a])
  await ops.communityJoin(d2.ctx, { community })
  await ops.communityLeave(d2.ctx, { community })
  const d = await secondDevice(t, d2, [community, general, await ownWriter(d2, community), await ownWriter(d2, general)], [a])
  const left = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(left.enrol, [])
  t.alike(reasons(left).find((r) => r[0] === community), [community, 'status'])
  const before = await footprint(d)
  t.alike((await ops.deviceUpkeep(d.ctx, { enrol: [{ root: community }, { root: general }] })).enrolled, [])
  t.alike(await footprint(d), before, 'nothing written')

  const blocked = await secondDevice(t, a, [community, general])
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, a.assoc)
  await store.writeBlocklist(blocked.storage, createSnapshot({ seq: 1, blocked: [community] }, modKp, modCert))
  const bp = await ops.deviceUpkeepPlan(blocked.ctx)
  t.absent(bp.enrol.some((x) => x.root === community), 'a blocked root is no candidate')
  t.absent(bp.skipped.some((x) => x.root === community))

  const unheld = await secondDevice(t, a, [])
  const up = await ops.deviceUpkeepPlan(unheld.ctx)
  t.alike(up.enrol, [])
  t.alike(reasons(up), [[community, 'unheld'], [general, 'unheld']])
})

test('a held root the diary never joined (an opened link) is no candidate', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { community, group: general } = await ops.communityCreate(b.ctx, { name: 'Vila', join: 'open' })
  const d = await secondDevice(t, a, [])
  await share(b, d, [community, general])
  t.alike(await ops.deviceUpkeepPlan(d.ctx), { enrol: [], share: [], skipped: [] })
})

// Owner decision (#350): the diary's admission covers its new devices.
test('approval community: a plain member\'s second device writes one CW, then enters its groups without an admin', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1, { join: 'approval' })
  const { group: feira } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open', community })
  await ops.communityJoin(b.ctx, { community })
  await share(b, a, [await ownWriter(b, community), await ownWriter(b, general)])
  await ops.communityAdmit(a.ctx, { community, member: b.key, on: true })
  await share(a, b, [community, feira])
  await ops.groupJoin(b.ctx, { group: feira })
  await share(b, a, [await ownWriter(b, feira)])

  const d = await secondDevice(t, b, [community, general, feira, await ownWriter(b, community), await ownWriter(b, general), await ownWriter(b, feira)], [a])
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol, [{ root: community, kind: 'community', community: null }])
  t.alike(reasons(plan), [[general, 'community-first'], [feira, 'community-first']], 'the groups wait for the new CW to be written')
  const res = await ops.deviceUpkeep(d.ctx, plan)
  t.alike(res.enrolled.map((x) => [x.root, x.kind]), [[community, 'community']])
  t.alike(res.failed, [])
  const ci = await ops.communityInfo(d.ctx, { community })
  t.alike([ci.writerHere, ci.canWrite], [true, true])
  const cw = await ownWriter(d, community)

  const next = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(next.enrol, [{ root: general, kind: 'group', community }, { root: feira, kind: 'group', community }], 'the admission covers the new CW: Geral and Feira follow')
  t.alike(reasons(next), [])
  const res2 = await ops.deviceUpkeep(d.ctx, next)
  t.alike(res2.failed, [])
  t.is(await ownWriter(d, community), cw, 'never a second CW')
  const fw = await ownWriter(d, feira)
  t.ok((await ops.groupInfo(d.ctx, { group: feira })).canWrite)
  await ops.groupPost(d.ctx, { group: feira, text: 'do segundo aparelho' })

  // The admin sees the post without admitting anything again.
  await share(d, a, [cw, fw])
  const read = await ops.groupRead(a.ctx, { group: feira })
  t.ok(read.items.some((p) => p.text === 'do segundo aparelho' && !p.hidden), 'the post shows to the others')
  t.alike((await ops.communityRequests(a.ctx, { community })).requests, [], 'no request reappears')
})

test('the creator\'s second device of an approval community enrols in its groups at once', async (t) => {
  const { a, community, general } = await world(t, 0, { join: 'approval' })
  const { group: feira } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open', community })
  const d = await secondDevice(t, a, [community, general, feira])
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol.map((x) => x.root), [community, general, feira])
  const res = await ops.deviceUpkeep(d.ctx, plan)
  t.alike(res.failed, [])
  t.is((await ops.communityInfo(d.ctx, { community })).canWrite, true)
  t.is((await ops.groupInfo(d.ctx, { group: feira })).canWrite, true)
})

test('private group: the creator\'s first device hands its epochs to the second device\'s writer, no rotation', async (t) => {
  const { a, community, general } = await world(t)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private', community })
  await ops.groupPost(a.ctx, { group, text: 'antes do aparelho' })

  const d = await secondDevice(t, a, [community, general, group])
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol, [{ root: community, kind: 'community', community: null }, { root: general, kind: 'group', community }, { root: group, kind: 'group', community }])
  const res = await ops.deviceUpkeep(d.ctx, plan)
  t.alike(res.failed, [])
  const dw = await ownWriter(d, group)
  t.is((await coreRecords(d, dw))[0].box, hex(d.ctx.groupKeys.boxPublicKey()), 'a boxed writer')
  t.alike((await ops.groupRead(d.ctx, { group })).items, [], 'no key yet')

  // The first device syncs the diary and the new writers.
  await syncDiary(d, a)
  for (const key of [await ownWriter(d, community), await ownWriter(d, general), dw]) await copyCore(d, a, key)
  const firstKeys = (await coreRecords(a, group)).filter((r) => r.type === 'group-key' && r.kid === null).length
  const ap = await ops.deviceUpkeepPlan(a.ctx)
  t.alike(ap.enrol, [])
  t.alike(ap.share, [{ group, writer: group }])
  const sr = await ops.deviceUpkeep(a.ctx, ap)
  t.alike([sr.shared, sr.changed, sr.failed], [[group], [group], []])
  const recs = await coreRecords(a, group)
  t.is(recs.filter((r) => r.type === 'group-key' && r.kid === null).length, firstKeys, 'no rotation')
  const handed = recs.filter((r) => r.type === 'group-key' && r.kid !== null && r.keys.some((k) => k.writer === dw))
  t.ok(handed.length > 0, 'continuation blocks name the new writer')

  await copyCore(a, d, group)
  const page = await ops.groupRead(d.ctx, { group })
  t.alike(page.items.map((p) => p.text), ['antes do aparelho'], 'the second device reads the history')
  t.is(page.state, 'ok')
  t.is((await ops.groupInfo(d.ctx, { group })).canWrite, true)
  t.alike((await ops.deviceUpkeepPlan(a.ctx)).share, [], 'nothing handed twice')
})

test('a plain member never hands keys; a requested writer is never a target', async (t) => {
  const { a, members: [b, c], community, general } = await world(t, 2)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private', community })
  await ops.groupPost(a.ctx, { group, text: 'oi' })
  for (const m of [b, c]) {
    await ops.communityJoin(m.ctx, { community })
    await share(a, m, [community, group])
    t.is((await ops.groupJoin(m.ctx, { group })).state, 'requested')
    await share(m, a, [await ownWriter(m, community), await ownWriter(m, general), await ownWriter(m, group)])
  }
  await ops.groupAdmit(a.ctx, { group, member: b.key, on: true })
  await share(a, b, [group])
  t.alike((await ops.deviceUpkeepPlan(b.ctx)).share, [], 'a plain member distributes nothing')
  t.alike((await ops.deviceUpkeepPlan(a.ctx)).share, [], 'the admit already handed the history; the requested writer is no target')
  const cw = await ownWriter(c, group)
  const recs = await coreRecords(a, group)
  t.absent(recs.some((r) => r.type === 'group-key' && r.keys.some((k) => k.writer === cw)), 'never sealed to a requested writer')
})

test('a diary that left Geral is not put back in it by the automatic path', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await ops.communityJoin(b.ctx, { community })
  t.is((await ops.groupLeave(b.ctx, { group: general })).state, 'left')
  const d = await secondDevice(t, b, [community, general, await ownWriter(b, community), await ownWriter(b, general)], [a])
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol, [{ root: community, kind: 'community', community: null }])
  t.absent(plan.skipped.some((x) => x.root === general), 'the diary binds Geral no more')
  const before = await diaryLength(d)
  const res = await ops.deviceUpkeep(d.ctx, plan)
  t.alike(res.enrolled.map((x) => x.root), [community])
  t.alike(res.changed, [community])
  t.is(await ownWriter(d, general), null, 'no Geral writer')
  t.is(await diaryLength(d), before + 1, 'only the community join')
  t.is((await ops.groupInfo(d.ctx, { group: general })).state, 'left')
})

test('Geral binding 6 writers is skipped while its community enrols', async (t) => {
  const { a, community, general } = await world(t)
  const extra = []
  for (let i = 0; i < 5; i++) extra.push(await rawDevice(a, general, [grp.writerHeader({ group: general, diary: a.key, member: community })]))
  const d = await secondDevice(t, a, [community, general, ...extra])
  t.is((await ops.groupInfo(d.ctx, { group: general })).writersBound, 6)
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol, [{ root: community, kind: 'community', community: null }])
  t.alike(reasons(plan), [[general, 'reserve']])
  const before = await diaryLength(d)
  const res = await ops.deviceUpkeep(d.ctx, plan)
  t.alike(res.enrolled.map((x) => x.root), [community])
  t.alike(res.failed, [])
  t.is(await ownWriter(d, general), null, 'Geral\'s 7th slot is left for a tap')
  t.is(await diaryLength(d), before + 1)
  t.is((await ops.groupInfo(d.ctx, { group: general })).writersBound, 6)
})

// store.appendRecord throws `err` for the next group-join, once.
function failNextJoin (t, err) {
  const original = store.appendRecord
  const restore = () => { store.appendRecord = original }
  t.teardown(restore)
  store.appendRecord = async (core, record, ...rest) => {
    if (record && record.type === 'group-join') {
      restore()
      throw err
    }
    return original(core, record, ...rest)
  }
}

test('a join cut after its kv writer is changed, and the next pass binds that same writer', async (t) => {
  const { a, community, general } = await world(t)
  const d = await secondDevice(t, a, [community, general])
  const before = await diaryLength(d)
  failNextJoin(t, new Error('falha simulada'))
  const cut = await ops.deviceUpkeep(d.ctx, await ops.deviceUpkeepPlan(d.ctx))
  t.alike(cut.enrolled, [])
  t.alike(cut.failed, [{ root: community, message: 'falha simulada' }], 'one failure: Geral is not tried after its community failed')
  t.alike(cut.changed, [community], 'the kv writer was written')
  const listed = await ownWriter(d, community)
  t.ok(listed !== null, 'the CW is listed')
  t.is(await diaryLength(d), before, 'but not bound')

  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol, [{ root: community, kind: 'community', community: null, repair: true }, { root: general, kind: 'group', community }])
  const res = await ops.deviceUpkeep(d.ctx, plan)
  t.alike(res.failed, [])
  t.alike(res.enrolled.map((x) => x.root), [community, general])
  t.is(await ownWriter(d, community), listed, 'the listed writer is reused')
  const entries = await store.readGroupWriters(d.storage)
  t.is(entries.filter((e) => e.group === community).length, 1)
  t.is(entries.length, 2, 'the CW and the Geral writer, nothing more')
  const joins = (await diaryJoins(d)).filter((j) => j.group === community)
  t.alike(joins.map((j) => [j.writer, j.on]), [[community, true], [listed, true]], 'no second writer bound')
  const info = await ops.communityInfo(d.ctx, { community })
  t.alike([info.writerHere, info.canWrite, info.writersBound], [true, true, 2])
  t.alike(await ops.deviceUpkeepPlan(d.ctx), { enrol: [], share: [], skipped: [] }, 'nothing left')
})

test('a locked identity inside a step throws instead of failing the root', async (t) => {
  const { a, community, general } = await world(t)
  const d = await secondDevice(t, a, [community, general])
  failNextJoin(t, new Error(store.LOCKED))
  await t.exception(() => ops.deviceUpkeep(d.ctx, { enrol: [{ root: community }, { root: general }] }), /identidade bloqueada/)
})

// `n` kv entries this device "created" (a root nonce): never evicted, so a
// room check that needs one slot more than is left fails.
async function fillWriters (s, n) {
  for (let i = 0; i < n; i++) {
    const nonce = hex(crypto.randomBytes(32))
    await store.putGroupWriter(s.storage, { group: hex(crypto.randomBytes(32)), key: hex(crypto.randomBytes(32)), nonce, rootNonce: nonce })
  }
}

test('a community enrol needs one kv slot, not Geral\'s too', async (t) => {
  const { a, community, general } = await world(t)
  const d = await secondDevice(t, a, [community, general])
  await fillWriters(d, grp.MAX_GROUPS_PER_DIARY - 1)
  const before = await store.readGroupWriters(d.storage)
  const res = await ops.deviceUpkeep(d.ctx, { enrol: [{ root: community }] })
  t.alike(res.failed, [], 'no "limite de grupos atingido"')
  t.alike(res.enrolled.map((x) => x.root), [community])
  const after = await store.readGroupWriters(d.storage)
  t.is(after.length, grp.MAX_GROUPS_PER_DIARY)
  t.ok(before.every((e) => after.some((x) => x.group === e.group)), 'nothing evicted')
  t.is(await ownWriter(d, general), null, 'no Geral writer')
})

test('a repair of a listed writer needs no new kv slot', async (t) => {
  const { a, community } = await world(t)
  const d = await secondDevice(t, a, [community])
  failNextJoin(t, new Error('falha simulada'))
  await ops.deviceUpkeep(d.ctx, { enrol: [{ root: community }] })
  const listed = await ownWriter(d, community)
  t.ok(listed !== null, 'listed, not bound')
  await fillWriters(d, grp.MAX_GROUPS_PER_DIARY - 1)
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol[0], { root: community, kind: 'community', community: null, repair: true })
  const res = await ops.deviceUpkeep(d.ctx, { enrol: [{ root: community }] })
  t.alike(res.failed, [], 'the full list does not refuse the repair')
  t.alike(res.enrolled.map((x) => x.root), [community])
  t.is(await ownWriter(d, community), listed, 'the same writer')
  t.is((await store.readGroupWriters(d.storage)).length, grp.MAX_GROUPS_PER_DIARY)
  t.ok((await diaryJoins(d)).some((j) => j.group === community && j.writer === listed && j.on === true), 'bound now')
})

// The first device after the second enrolled in private group P: P's
// hand-off is due on `a`.
async function handOffDue (t) {
  const { a, community, general } = await world(t)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private', community })
  await ops.groupPost(a.ctx, { group, text: 'antes do aparelho' })
  const d = await secondDevice(t, a, [community, general, group])
  t.alike((await ops.deviceUpkeep(d.ctx, await ops.deviceUpkeepPlan(d.ctx))).failed, [])
  await syncDiary(d, a)
  for (const key of [await ownWriter(d, community), await ownWriter(d, general), await ownWriter(d, group)]) await copyCore(d, a, key)
  t.alike((await ops.deviceUpkeepPlan(a.ctx)).share, [{ group, writer: group }], 'due')
  return { a, community, group }
}

// The fold entitles no new writer without its parent, so the plan's
// community-first skip only backs that up: nothing planned, nothing failed.
test('a hand-off whose parent is blocked is never planned nor failed', async (t) => {
  const { a, community, group } = await handOffDue(t)
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, a.assoc)
  await store.writeBlocklist(a.storage, createSnapshot({ seq: 1, blocked: [community] }, modKp, modCert))
  const plan = await ops.deviceUpkeepPlan(a.ctx)
  t.alike(plan.share, [], 'not planned')
  t.ok(plan.skipped.every((x) => x.root !== group || x.reason === 'community-first'))
  const before = (await coreRecords(a, group)).length
  const res = await ops.deviceUpkeep(a.ctx, { share: [{ group }] })
  t.alike([res.shared, res.failed, res.changed], [[], [], []], 'no failed entry')
  t.is((await coreRecords(a, group)).length, before, 'nothing written')
})

test('a hand-off that would not fit the log is skipped for good', async (t) => {
  const { a, group } = await handOffDue(t)
  const length = (await coreRecords(a, group)).length
  const ctx = { ...a.ctx, limits: { ...a.ctx.limits, maxLogBlocks: length } }
  const plan = await ops.deviceUpkeepPlan(ctx)
  t.alike(plan.share, [])
  t.alike(plan.skipped, [{ root: group, reason: 'full', transient: false }])
  const res = await ops.deviceUpkeep(ctx, { share: [{ group }] })
  t.alike([res.shared, res.failed], [[], []])
})

test('skipped entries say whether a later sync can resolve them', async (t) => {
  const { a, community, general } = await world(t)
  const extra = []
  for (let i = 0; i < 5; i++) extra.push(await rawDevice(a, general, [grp.writerHeader({ group: general, diary: a.key, member: community })]))
  const unheld = await secondDevice(t, a, [])
  t.alike((await ops.deviceUpkeepPlan(unheld.ctx)).skipped.map((x) => [x.reason, x.transient]), [['unheld', true], ['unheld', true]])
  const d = await secondDevice(t, a, [community, general, ...extra])
  t.alike((await ops.deviceUpkeepPlan(d.ctx)).skipped, [{ root: general, reason: 'reserve', transient: false }])
})

// A writer core of `group` in `d`'s storage whose key pair does not come
// from d's groupKeyPair, listed in kv groupWriters with some nonce.
async function plantWriter (d, group, header, community) {
  const kp = crypto.keyPair()
  const core = await store.openGroupWriter(d.storage, kp)
  try {
    await store.appendGroupRecord(core, header, { root: false, community })
  } finally { await core.close() }
  const key = hex(kp.publicKey)
  await store.addGroupReplica(d.storage, key)
  await store.putGroupWriter(d.storage, { group, key, nonce: hex(crypto.randomBytes(32)), rootNonce: null, ...(community ? { kind: 'community' } : {}) })
  return key
}

test('a listed writer this device did not derive is never bound, by the upkeep nor by a tap', async (t) => {
  const { a, community, general } = await world(t)
  const { group: feira } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open', community })
  const d = await secondDevice(t, a, [community, general, feira])
  const planted = await plantWriter(d, community, grp.writerHeader({ group: community, diary: a.key, member: null }), true)

  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.absent(plan.enrol.some((x) => x.root === community), 'not a repair candidate')
  t.alike(plan.skipped.find((x) => x.root === community), { root: community, reason: 'foreign', transient: false })
  const before = await footprint(d)
  const res = await ops.deviceUpkeep(d.ctx, { enrol: [{ root: community }, { root: general }, { root: feira }] })
  t.absent(res.enrolled.some((x) => x.root === community))
  t.absent((await diaryJoins(d)).some((j) => j.writer === planted), 'no join names the planted key')
  t.is(await diaryLength(d), before.length, 'nothing written')

  t.is((await ops.communityJoin(d.ctx, { community })).state, 'member')
  const joins = await diaryJoins(d)
  t.absent(joins.some((j) => j.writer === planted), 'the tap does not bind it either')
  const cw = await ownWriter(d, community)
  t.not(cw, planted, 'a new writer takes its place')
  t.ok(joins.some((j) => j.group === community && j.writer === cw && j.on === true), 'the new writer is bound')
  const entry = (await store.readGroupWriters(d.storage)).find((e) => e.group === community)
  t.is(hex((await d.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.nonce, 'hex')))).publicKey), cw, 'derived here')

  // A group join (joinLoaded) with a planted writer naming the live CW.
  const plantedFeira = await plantWriter(d, feira, grp.writerHeader({ group: feira, diary: a.key, member: cw }), false)
  t.is((await ops.groupJoin(d.ctx, { group: feira })).state, 'member')
  t.absent((await diaryJoins(d)).some((j) => j.writer === plantedFeira), 'the group join does not bind it')
  t.not(await ownWriter(d, feira), plantedFeira)
})

// Group-core opens on `storage` while later code runs. member-ops opens one
// through the store (openGroupCoreReadOnly and the other openers) or, when
// the storage has those methods, through the storage; either way the open
// names a core file under group/. A second Hypercore on files the live sync
// holds corrupts them, so the precheck must stay at zero.
function groupCoreOpens (t, storage) {
  let calls = 0
  const originals = []
  const wrap = (target, name, hit) => {
    if (typeof target[name] !== 'function') return
    const original = target[name]
    originals.push([target, name, original])
    target[name] = function (...args) {
      if (hit(args)) calls++
      return original.apply(this, args)
    }
  }
  const names = ['openGroupCoreReadOnly', 'readGroupCore', 'openGroupReplica', 'openGroupWriter']
  for (const name of names) {
    wrap(store, name, (args) => args[0] === storage)
    wrap(storage, name, () => true)
  }
  const groupFile = (args) => typeof args[0] === 'string' && args[0].startsWith(store.GROUP_PREFIX)
  wrap(storage, 'core', groupFile)
  wrap(storage, 'hasCore', groupFile)
  t.teardown(() => {
    for (let i = originals.length - 1; i >= 0; i--) {
      const [target, name, original] = originals[i]
      target[name] = original
    }
  }, { force: true })
  return () => calls
}

test('deviceUpkeepNeeded is true until this device\'s writer is diary-bound, and true again for a repair', async (t) => {
  t.is(typeof ops.deviceUpkeepNeeded, 'function')
  const { a, community, general } = await world(t)
  const d = await secondDevice(t, a, [community, general])
  t.is(await ownWriter(d, community), null, 'no kv writer yet')
  t.is(await ops.deviceUpkeepNeeded(d.ctx), true)

  const res = await ops.deviceUpkeep(d.ctx, await ops.deviceUpkeepPlan(d.ctx))
  t.alike(res.failed, [])
  const cw = await ownWriter(d, community)
  const gw = await ownWriter(d, general)
  const joins = await diaryJoins(d)
  t.ok(joins.some((j) => j.group === community && j.writer === cw && j.on === true), 'the diary binds the community writer')
  t.ok(joins.some((j) => j.group === general && j.writer === gw && j.on === true), 'the diary binds the Geral writer')
  t.is(await ops.deviceUpkeepNeeded(d.ctx), false)

  const entry = (await store.readGroupWriters(d.storage)).find((e) => e.group === community)
  const unbound = hex(crypto.randomBytes(32))
  await store.putGroupWriter(d.storage, { ...entry, key: unbound })
  t.is(await ownWriter(d, community), unbound, 'a kv writer the diary does not bind')
  t.absent((await diaryJoins(d)).some((j) => j.writer === unbound))
  t.is(await ops.deviceUpkeepNeeded(d.ctx), true, 'repair')
})

test('deviceUpkeepNeeded is false when the diary binds no group root', async (t) => {
  const plain = await setup(t)
  t.alike(await diaryJoins(plain), [])
  t.is(await ops.deviceUpkeepNeeded(plain.ctx), false)
})

test('deviceUpkeepNeeded opens no group core', async (t) => {
  const { a, community, general } = await world(t)
  const d = await secondDevice(t, a, [community, general])
  const opens = groupCoreOpens(t, d.storage)
  t.is(await ops.deviceUpkeepNeeded(d.ctx), true)
  t.is(opens(), 0)
})

// Member `b` of a's community joined private group P by key before holding
// its root: a boxless writer the diary binds. The root is still on `a` only.
async function boxlessJoin (t) {
  const { a, members: [b], community, general } = await world(t, 1)
  await ops.communityJoin(b.ctx, { community })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private', community })
  // The creator's diary too: it binds the new root.
  await share(a, b, [community])
  b.ctx.peekGroupRoot = rootReader(a)
  t.is((await ops.groupJoin(b.ctx, { group, community })).state, 'pending')
  const boxless = await ownWriter(b, group)
  t.is((await coreRecords(b, boxless))[0].box, null, 'a boxless writer')
  return { a, b, community, general, group, boxless }
}

test('a boxless private writer is reboxed once the root arrives, then nothing is left to plan', async (t) => {
  const { a, b, group, boxless } = await boxlessJoin(t)
  t.alike(await ops.deviceUpkeepPlan(b.ctx), { enrol: [], share: [], skipped: [{ root: group, reason: 'unheld', transient: true }] }, 'the root is awaited')
  await copyCore(a, b, group)

  const plan = await ops.deviceUpkeepPlan(b.ctx)
  t.alike(plan.enrol.map((x) => [x.root, x.kind, x.rebox]), [[group, 'group', true]])
  t.alike(plan.skipped, [])
  const before = await diaryLength(b)
  const res = await ops.deviceUpkeep(b.ctx, plan)
  t.alike([res.failed, res.enrolled.map((x) => [x.root, x.state])], [[], [[group, 'requested']]], 'an approval group ends as a request')
  t.alike(res.changed, [group])

  const boxed = await ownWriter(b, group)
  t.not(boxed, boxless, 'a new writer takes its place')
  t.is((await coreRecords(b, boxed))[0].box, hex(b.ctx.groupKeys.boxPublicKey()), 'this device\'s box')
  const joins = (await diaryJoins(b)).filter((j) => j.group === group)
  t.alike(joins.slice(-2).map((j) => [j.writer, j.on]), [[boxless, false], [boxed, true]], 'the old writer is unbound, the new one bound')
  // The join off keeps the slot in the slot walk: one cut on the header-only
  // boxless writer, between the two joins, gives it back (#350).
  const own = await diaryRecords(b)
  const at = (type, writer) => own.findIndex((r) => r.type === type && r.group === group && r.writer === writer && (type !== 'group-join' || r.on === (writer === boxed)))
  t.alike(own.filter((r) => r.type === 'group-cut' && r.group === group).map((r) => [r.writer, r.cut]), [[boxless, 0]], 'one cut at 0 on the boxless writer')
  t.ok(at('group-join', boxless) < at('group-cut', boxless) && at('group-cut', boxless) < at('group-join', boxed), 'after the join off, before the new join')
  t.is(await diaryLength(b), before + 3)
  const entries = own.map((record, seq) => ({ seq, record }))
  const walk = grp.slotWalk(grp.groupJoinHistory(entries, group), grp.groupCutHistory(entries, group), group)
  t.ok(walk.released.has(boxless) && walk.live.has(boxed), 'the slot walk releases the boxless writer and counts the new one')

  t.alike(await ops.deviceUpkeepPlan(b.ctx), { enrol: [], share: [], skipped: [] }, 'nothing left: no loop')
  const still = await footprint(b)
  t.alike(await ops.deviceUpkeep(b.ctx, plan), { enrolled: [], shared: [], failed: [], changed: [] }, 'an old plan writes nothing')
  t.alike(await footprint(b), still)
})

test('a boxless private writer is never reboxed after a leave written on another device', async (t) => {
  const { a, b, community, general, group } = await boxlessJoin(t)
  await copyCore(a, b, group)
  // Another device of b joins with a boxed writer and leaves.
  const keys = [community, general, group, await ownWriter(b, community), await ownWriter(b, general), await ownWriter(b, group)]
  const x = await secondDevice(t, b, keys, [a])
  t.alike((await ops.deviceUpkeep(x.ctx, { enrol: [{ root: community }, { root: general }] })).failed, [])
  t.is((await ops.groupJoin(x.ctx, { group })).state, 'requested')
  t.is((await ops.groupLeave(x.ctx, { group })).state, 'left')
  await syncDiary(x, b)
  for (const key of [await ownWriter(x, community), await ownWriter(x, general), await ownWriter(x, group)]) await copyCore(x, b, key)
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'left')

  const plan = await ops.deviceUpkeepPlan(b.ctx)
  t.absent(plan.enrol.some((e) => e.root === group), 'a leave from another device is respected')
  t.alike(reasons(plan).filter((r) => r[0] === group), [[group, 'status']])
  const before = await footprint(b)
  t.alike((await ops.deviceUpkeep(b.ctx, { enrol: [{ root: group }] })).enrolled, [])
  t.alike(await footprint(b), before, 'nothing written')
})

test('a banned diary\'s boxless private writer is not reboxed', async (t) => {
  const { a, b, group, boxless } = await boxlessJoin(t)
  await copyCore(a, b, group)
  // The creator holds b's diary and boxless writer, so the ban names a diary it knows.
  await share(b, a, [boxless])
  await ops.groupBan(a.ctx, { group, member: b.key, on: true })
  await copyCore(a, b, group)
  const plan = await ops.deviceUpkeepPlan(b.ctx)
  t.absent(plan.enrol.some((e) => e.root === group), 'a ban is not worked around')
  t.alike(reasons(plan).filter((r) => r[0] === group), [[group, 'status']])
})

test('a leave on another device whose writer core has not arrived yet is respected too', async (t) => {
  const { a, b, community, general, group } = await boxlessJoin(t)
  await copyCore(a, b, group)
  const keys = [community, general, group, await ownWriter(b, community), await ownWriter(b, general), await ownWriter(b, group)]
  const x = await secondDevice(t, b, keys, [a])
  t.alike((await ops.deviceUpkeep(x.ctx, { enrol: [{ root: community }, { root: general }] })).failed, [])
  t.is((await ops.groupJoin(x.ctx, { group })).state, 'requested')
  t.is((await ops.groupLeave(x.ctx, { group })).state, 'left')
  // Only the diary reaches b: its off join is there, x's writer core is not.
  await syncDiary(x, b)
  const plan = await ops.deviceUpkeepPlan(b.ctx)
  t.absent(plan.enrol.some((e) => e.root === group), 'no rebox on the local evidence of the leave')
  t.alike(reasons(plan).filter((r) => r[0] === group), [[group, 'status']])
  const before = await footprint(b)
  t.alike((await ops.deviceUpkeep(b.ctx, { enrol: [{ root: group }] })).enrolled, [])
  t.alike(await footprint(b), before, 'nothing written, no slot spent')
})

test('a public group\'s boxless writer is never reboxed once its root is held', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await ops.communityJoin(b.ctx, { community })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Praia', join: 'open', community })
  await share(a, b, [community])
  b.ctx.peekGroupRoot = rootReader(a)
  t.is((await ops.groupJoin(b.ctx, { group, community })).state, 'pending')
  t.alike(reasons(await ops.deviceUpkeepPlan(b.ctx)), [[group, 'unheld']], 'waited for while the root is unknown')
  await copyCore(a, b, group)
  t.alike(await ops.deviceUpkeepPlan(b.ctx), { enrol: [], share: [], skipped: [] }, 'public writers carry no box: nothing to replace')
})

// The rebox needs the community writer admitted; one the own diary cut
// (a disconnected device's CW) admits nothing. Five more CWs of b's diary
// put the community at its reserve, so the plan does not enrol it again
// first and the rebox is judged on the cut CW alone.
test('a boxless private writer is not reboxed under a community writer the own diary cut', async (t) => {
  const { a, b, community, group } = await boxlessJoin(t)
  await copyCore(a, b, group)
  await ops.deviceHello(b.ctx, { name: 'Celular' })
  // Six more CWs: once the cut freezes this one, six live slots are still
  // taken, so the reserve keeps the automatic path from a new CW (#350).
  for (let i = 0; i < 6; i++) await rawDevice(b, community, [grp.writerHeader({ group: community, diary: b.key, member: null })], true)
  const before = await ops.deviceUpkeepPlan(b.ctx)
  t.alike(before.enrol.map((x) => [x.root, x.rebox]), [[group, true]], 'reboxed while the CW is uncut')

  const cw = await ownWriter(b, community)
  const core = await store.openGroupCoreReadOnly(b.storage, cw)
  const cut = core.length
  await core.close()
  const diary = await store.openDiary(b.storage, b.ctx.keyPair)
  try { await store.appendRecord(diary, groupCutRecord({ group: community, writer: cw, cut })) } finally { await diary.close() }

  const plan = await ops.deviceUpkeepPlan(b.ctx)
  t.alike(plan.enrol, [], 'no rebox under the cut CW')
  t.alike(reasons(plan), [[community, 'reserve'], [group, 'community-first']])
})

test('a boxless private writer is skipped as locked without this device\'s box', async (t) => {
  const { a, b, group } = await boxlessJoin(t)
  await copyCore(a, b, group)
  const locked = { ...b.ctx, groupKeys: createGroupKeys() }
  t.teardown(() => locked.groupKeys.close())
  const plan = await ops.deviceUpkeepPlan(locked)
  t.alike(plan.enrol, [])
  t.alike(plan.skipped, [{ root: group, reason: 'locked', transient: true }])
})
