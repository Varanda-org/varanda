'use strict'

// Standalone groups in the browser node (lib/member-ops.js, protocol section
// 10 "Standalone groups", docs/rpc.md 5.36, 5.37 and 5.176): a group created
// without a community, joined with a writer naming the group root itself,
// listed by group.standalone, enrolled by a second device and handed its
// keys with no community to wait for; a catalogue that names a root not of
// its community (a standalone one or another community's group) never
// lists it nor joins it as Geral. Cores move between storages by direct
// replication; no seeder or sockets.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const devices = require('@varanda/core/lib/devices')
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

async function syncDiary (from, to) {
  await pipe(await store.openDiary(from.storage), await store.openDiary(to.storage))
}

async function secondDevice (t, s, keys) {
  const storage = memoryNodeStorage()
  const ctx = { storage, association: s.ctx.association, keyPair: s.ctx.keyPair, groupKeyPair: s.ctx.groupKeyPair, groupKeys: await holder(t, storage, s.prf) }
  await ops.idCreate(ctx)
  await pipe(await store.openDiary(s.storage), await store.openDiary(storage))
  for (const key of keys) await copyCore(s, { storage }, key)
  await store.addGroupDiary(storage, s.key)
  return { ctx, storage, key: s.key, assoc: s.assoc, prf: s.prf }
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

async function records (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  if (core === null) return []
  try { return (await store.readAll(core)).map((e) => e.record) } finally { await core.close() }
}

async function diaryLength (s) {
  const core = await store.openDiary(s.storage)
  try { return core.length } finally { await core.close() }
}

async function writerCount (s) {
  return (await store.readGroupWriters(s.storage)).length
}

// A community root of `s` whose catalogue's first group-create (Geral)
// names `first`, bound and listed as community.create would: -> its key.
async function craftCommunity (s, first) {
  const nonce = crypto.randomBytes(32)
  const kp = await s.ctx.groupKeyPair(new Uint8Array(nonce))
  const C = hex(kp.publicKey)
  const core = await store.openGroupWriter(s.storage, kp)
  try {
    await store.appendGroupRecord(core, grp.groupHeader({ kind: 'community', diary: s.key, name: 'Vila', join: 'open' }), { root: true, community: true })
    await store.appendGroupRecord(core, grp.groupCreateRecord({ group: first, seen: null }), { root: true, community: true })
  } finally {
    await core.close()
  }
  await store.putGroupWriter(s.storage, { group: C, key: C, nonce: hex(nonce), rootNonce: hex(nonce), kind: 'community' })
  const d = await store.openDiary(s.storage, s.ctx.keyPair)
  try {
    await store.appendRecord(d, groupJoinRecord({ group: C, writer: C, on: true }))
  } finally {
    await d.close()
  }
  return C
}

// A group-create appended to `s`'s own community root C.
async function appendCreate (s, C, group) {
  const entry = (await store.readGroupWriters(s.storage)).find((e) => e.group === C)
  const core = await store.openGroupWriter(s.storage, await s.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.rootNonce, 'hex'))))
  try {
    await store.appendGroupRecord(core, grp.groupCreateRecord({ group, seen: null }), { root: true, community: true })
  } finally {
    await core.close()
  }
}

test('member-ops exports groupStandalone', (t) => {
  t.is(typeof ops.groupStandalone, 'function')
})

test('group.create without a community writes a standalone root and nothing else', async (t) => {
  const a = await setup(t)
  const before = await writerCount(a)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const recs = await records(a, group)
  t.alike(recs.map((r) => r.type), ['group-header'], 'only the header, no community record anywhere')
  t.ok(grp.isStandaloneHeader(recs[0]), 'community and member both null')
  t.alike([recs[0].community, recs[0].member, recs[0].diary], [null, null, a.key])
  t.is(await writerCount(a), before + 1, 'one kv entry: the root')
  const info = await ops.groupInfo(a.ctx, { group })
  t.alike([info.community, info.orphan, info.role, info.state, info.canWrite, info.rootHere], [null, false, 'creator', 'member', true, true])
  t.alike((await ops.groupList(a.ctx)).groups.map((g) => [g.group, g.community, g.role]), [[group, null, 'creator']])
  await ops.groupPost(a.ctx, { group, text: 'oi' })
  t.alike((await ops.groupRead(a.ctx, { group })).items.map((p) => p.text), ['oi'], 'a post goes through with no parent')
  t.alike(await ops.groupMeta(a.ctx, { group, name: 'Horta nova' }), { ok: true }, 'root writes need no parent either')
})

test('group.join of a held standalone root names G; a community hint is refused before any write', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await share(a, b, [group])
  const length = await diaryLength(b)
  await t.exception(() => ops.groupJoin(b.ctx, { group, community: 'ab'.repeat(32) }), /parâmetro inválido: community/)
  await t.exception(() => ops.groupJoin(b.ctx, { group, standalone: true, community: 'ab'.repeat(32) }), /parâmetro inválido: standalone/)
  t.alike([await diaryLength(b), await ownWriter(b, group)], [length, null], 'nothing written')
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' }, 'no community needed')
  const w = await ownWriter(b, group)
  const h = (await records(b, w))[0]
  t.alike([h.type, h.group, h.member], ['group-writer', group, group], 'the writer names the group root')
  t.alike(await ops.groupJoin(b.ctx, { group, standalone: true }), { state: 'member' }, 'idempotent, the hint agrees')
  await share(b, a, [w])
  t.is((await ops.groupInfo(a.ctx, { group })).members, 2, 'the creator folds the new member')
  t.is((await ops.groupInfo(b.ctx, { group })).canWrite, true)
})

test('group.join with standalone: true on a community group is refused before any write', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  await share(a, b, [community, general])
  const length = await diaryLength(b)
  await t.exception(() => ops.groupJoin(b.ctx, { group: general, standalone: true }), /parâmetro inválido: standalone/)
  t.alike([await diaryLength(b), await ownWriter(b, general)], [length, null], 'nothing written')
  await t.exception(() => ops.groupJoin(b.ctx, { group: general }), /entre na comunidade primeiro/, 'an outsider stays refused')
  t.alike([await diaryLength(b), await ownWriter(b, general)], [length, null])
})

test('an unheld root: standalone: true writes a pending writer naming G, which counts once the root arrives', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await t.exception(() => ops.groupJoin(b.ctx, { group }), /informe a comunidade do grupo/, 'no hint')
  t.is(await ownWriter(b, group), null)
  t.alike(await ops.groupJoin(b.ctx, { group, standalone: true }), { state: 'pending' })
  const w = await ownWriter(b, group)
  t.is((await records(b, w))[0].member, group, 'the pending writer names G')
  t.alike((await ops.groupStandalone(b.ctx)).groups, [], 'a pending root is not listed')
  await share(a, b, [group])
  await share(b, a, [w])
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'member')
  t.is((await ops.groupInfo(a.ctx, { group })).members, 2)
})

test('an unheld root hinted standalone that arrives as a community group grants nothing', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  t.alike(await ops.groupJoin(b.ctx, { group: general, standalone: true }), { state: 'pending' })
  const w = await ownWriter(b, general)
  t.is((await records(b, w))[0].member, general)
  await share(a, b, [community, general])
  await share(b, a, [w])
  t.is((await ops.groupInfo(a.ctx, { group: general })).members, 1, 'the creator never counts the writer')
  t.not((await ops.groupInfo(b.ctx, { group: general })).state, 'member', 'nor does the joiner')
  t.is((await ops.groupInfo(b.ctx, { group: general })).canWrite, false)
  await t.exception(() => ops.groupPost(b.ctx, { group: general, text: 'x' }))
})

test('group.standalone: held standalone groups in key order, community, left and pending ones out', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const s1 = (await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })).group
  const s2 = (await ops.groupCreate(a.ctx, { name: 'Feira', join: 'approval' })).group
  const s3 = (await ops.groupCreate(b.ctx, { name: 'Coral', join: 'open' })).group
  await share(b, a, [s3])
  t.alike(await ops.groupJoin(a.ctx, { group: s3 }), { state: 'member' })
  await ops.groupPost(a.ctx, { group: s1, text: 'primeira' })
  const r = await ops.groupStandalone(a.ctx)
  t.is(r.total, 3)
  t.alike(r.groups.map((g) => g.group), [s1, s2, s3].sort(), 'key order')
  const row = r.groups.find((g) => g.group === s1)
  t.alike({ ...row, last: row.last && row.last.preview }, { group: s1, name: 'Horta', image: null, imageAuthor: null, visibility: 'public', join: 'open', role: 'creator', general: false, last: 'primeira', unread: 0 })
  t.alike(r.groups.find((g) => g.group === s3).role, 'member')
  t.absent(r.groups.some((g) => g.group === general || g.group === community), 'no community group')
  t.alike(await ops.groupLeave(a.ctx, { group: s3 }), { state: 'left' })
  const after = await ops.groupStandalone(a.ctx)
  t.alike([after.total, after.groups.map((g) => g.group)], [2, [s1, s2].sort()], 'a left group is out')
  const paged = await ops.groupStandalone(a.ctx, { offset: 1, limit: 1 })
  t.alike([paged.total, paged.groups.length], [2, 1], 'total counts before paging')

  const storage = memoryNodeStorage()
  await t.exception(() => ops.groupStandalone({ storage, association: a.ctx.association, keyPair: null }), /identidade não encontrada/)
})

test('a catalogue naming a standalone root as Geral and as a group: no writer there, never listed', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const c = await setup(t, { assoc: a.assoc, name: 'Cid' })
  const { group: S } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const C = await craftCommunity(a, S)
  // Another community's group, named in C's catalogue too.
  const { community: D, group: dGeneral } = await ops.communityCreate(c.ctx, { name: 'Outro', join: 'open' })
  await appendCreate(a, C, dGeneral)
  await share(c, a, [D, dGeneral])
  const own = await ops.communityInfo(a.ctx, { community: C })
  t.is(own.general, null, 'a held foreign Geral is no Geral of C')
  t.alike(own.groups, [], 'neither foreign root is listed')
  t.is((await ops.communityList(a.ctx)).communities.find((x) => x.community === C).general, null, 'community.list agrees')

  // S held: the Geral step writes nothing.
  await share(a, b, [C, S])
  await share(c, b, [D, dGeneral])
  const res = await ops.communityJoin(b.ctx, { community: C })
  t.alike(res, { state: 'member', group: null }, 'the community join stands, Geral treated as absent')
  t.is(await ownWriter(b, S), null, 'no writer in S')
  const bInfo = await ops.communityInfo(b.ctx, { community: C })
  t.absent(bInfo.groups.some((g) => g.group === S || g.group === dGeneral))
  t.alike([bInfo.general, bInfo.generalWritersBound], [null, 0], 'no Geral, nothing bound there')
  t.is((await ops.communityList(b.ctx)).communities.find((x) => x.community === C).general, null)
  t.alike((await ops.groupStandalone(b.ctx)).groups, [])

  // S not held: today's pending path, useless once S arrives; a later join
  // checks the header and writes nothing more.
  const e = await setup(t, { assoc: a.assoc, name: 'Edu' })
  await share(a, e, [C])
  t.alike(await ops.communityJoin(e.ctx, { community: C }), { state: 'member', group: S }, 'pending Geral step')
  const pw = await ownWriter(e, S)
  t.not((await records(e, pw))[0].member, S, 'the pending writer names the CW')
  t.alike([(await ops.communityInfo(e.ctx, { community: C })).general, (await ops.communityList(e.ctx)).communities.find((x) => x.community === C).general], [S, S], 'an unheld Geral still reads as Geral')
  await copyCore(a, e, S)
  const eInfo = await ops.communityInfo(e.ctx, { community: C })
  t.alike([eInfo.general, eInfo.generalWritersBound], [null, 0], 'once held, it is no Geral of C')
  t.alike(await ops.communityJoin(e.ctx, { community: C }), { state: 'member', group: null }, 're-checked once the root arrived')
  t.is(await ownWriter(e, S), pw, 'no new writer')
  await share(e, a, [await ownWriter(e, C), pw])
  t.is((await ops.groupInfo(a.ctx, { group: S })).members, 1, 'S never counts the writer')
  t.not((await ops.groupInfo(e.ctx, { group: S })).state, 'member')
  // A second device of e enrols nowhere in S.
  const d = await secondDevice(t, e, [C, S])
  t.absent((await ops.deviceUpkeepPlan(d.ctx)).enrol.some((x) => x.root === S), 'no enrolment in S')
})

test('a second device enrols in a standalone group with no community wait', async (t) => {
  const a = await setup(t)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'antes' })
  const d = await secondDevice(t, a, [group])
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol, [{ root: group, kind: 'group', community: null }])
  t.alike(plan.skipped, [])
  const res = await ops.deviceUpkeep(d.ctx, plan)
  t.alike(res.failed, [])
  t.alike(res.enrolled, [{ root: group, kind: 'group', state: 'member', group: null }])
  const dw = await ownWriter(d, group)
  t.is((await records(d, dw))[0].member, group, 'the new writer names G')
  t.is((await ops.groupInfo(d.ctx, { group })).canWrite, true)
})

test('private standalone group: the second device enrols, the first hands it the history', async (t) => {
  const a = await setup(t)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private' })
  await ops.groupPost(a.ctx, { group, text: 'antes do aparelho' })
  const d = await secondDevice(t, a, [group])
  const plan = await ops.deviceUpkeepPlan(d.ctx)
  t.alike(plan.enrol, [{ root: group, kind: 'group', community: null }])
  t.alike((await ops.deviceUpkeep(d.ctx, plan)).failed, [])
  const dw = await ownWriter(d, group)
  t.alike([(await records(d, dw))[0].member, (await records(d, dw))[0].box], [group, hex(d.ctx.groupKeys.boxPublicKey())])

  await syncDiary(d, a)
  await copyCore(d, a, dw)
  const ap = await ops.deviceUpkeepPlan(a.ctx)
  t.alike(ap.share, [{ group, writer: group }], 'the history share is planned, no community-first skip')
  t.alike(ap.skipped, [])
  const sr = await ops.deviceUpkeep(a.ctx, ap)
  t.alike([sr.shared, sr.failed], [[group], []])
  await copyCore(a, d, group)
  const page = await ops.groupRead(d.ctx, { group })
  t.alike(page.items.map((p) => p.text), ['antes do aparelho'], 'the second device reads the history')
  t.is((await ops.groupInfo(d.ctx, { group })).canWrite, true)
})

test('a pending Geral writer in a private standalone root is never reboxed into a request', async (t) => {
  const a = await setup(t)
  const e = await setup(t, { assoc: a.assoc, name: 'Edu' })
  const { group: S } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private' })
  const C = await craftCommunity(a, S)
  await share(a, e, [C])
  t.alike(await ops.communityJoin(e.ctx, { community: C }), { state: 'member', group: S }, 'pending Geral step')
  const pw = await ownWriter(e, S)
  const h = (await records(e, pw))[0]
  t.alike([h.member === S, h.box], [false, null], 'a boxless writer naming the CW')
  await copyCore(a, e, S)
  const plan = await ops.deviceUpkeepPlan(e.ctx)
  t.absent(plan.enrol.some((x) => x.root === S), 'no rebox planned')
  t.ok(plan.skipped.some((x) => x.root === S && x.reason === 'status'), 'skipped for good')
  t.is(await ownWriter(e, S), pw)
})

test('private standalone group: the periodic rekey plan checks it', async (t) => {
  const a = await setup(t)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private' })
  const plan = await ops.periodicRekeyPlan(a.ctx, { now: Date.now() + 365 * 24 * 3600 * 1000 })
  t.ok(plan.checked.includes(group), 'checked')
  t.ok(plan.rekey.some((x) => x.group === group), 'due a year later')
})

test('a held foreign Geral takes no slot in the community.join room check', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const { group: S } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const C = await craftCommunity(a, S)
  await share(a, b, [C, S])
  // MAX - 1 used slots, none of them evictable (each holds a root nonce).
  for (let i = 0; i < grp.MAX_GROUPS_PER_DIARY - 1; i++) {
    const k = hex(crypto.randomBytes(32))
    const nonce = hex(crypto.randomBytes(32))
    await store.putGroupWriter(b.storage, { group: k, key: k, nonce, rootNonce: nonce })
  }
  t.alike(await ops.communityJoin(b.ctx, { community: C }), { state: 'member', group: null }, 'the join fits in the last slot')
  t.is(await ownWriter(b, S), null, 'nothing written in the standalone root')
  t.is(await writerCount(b), grp.MAX_GROUPS_PER_DIARY)
})

test('a standalone hint on an unheld root that arrives as a private community group is never reboxed into a request', async (t) => {
  const a = await setup(t)
  const e = await setup(t, { assoc: a.assoc, name: 'Edu' })
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group: P } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private', community })
  await share(a, e, [community, general])
  t.is((await ops.communityJoin(e.ctx, { community })).state, 'member', 'a member of the community')
  t.alike(await ops.groupJoin(e.ctx, { group: P, standalone: true }), { state: 'pending' })
  const pw = await ownWriter(e, P)
  const h = (await records(e, pw))[0]
  t.alike([h.member, h.box], [P, null], 'a boxless writer naming G')
  await copyCore(a, e, P)
  const plan = await ops.deviceUpkeepPlan(e.ctx)
  t.absent(plan.enrol.some((x) => x.root === P), 'no rebox planned')
  t.ok(plan.skipped.some((x) => x.root === P && x.reason === 'status'), 'skipped for good')
  await ops.deviceUpkeep(e.ctx, plan)
  t.is(await ownWriter(e, P), pw, 'no new writer')
  t.not((await ops.groupInfo(e.ctx, { group: P })).state, 'requested', 'no request filed')
})

test('a catalogue naming another community\'s root, as Geral and as a group: left out, no Geral, no slot, nothing written', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const c = await setup(t, { assoc: a.assoc, name: 'Cid' })
  const { community: D } = await ops.communityCreate(c.ctx, { name: 'Outra', join: 'open' })
  const { community: E } = await ops.communityCreate(c.ctx, { name: 'Terceira', join: 'open' })
  const C = await craftCommunity(a, D)
  await appendCreate(a, C, E)
  await share(c, a, [D, E])
  const info = await ops.communityInfo(a.ctx, { community: C })
  t.alike([info.general, info.groups], [null, []], 'a held community root is no group of C')
  t.is((await ops.communityList(a.ctx)).communities.find((x) => x.community === C).general, null, 'community.list agrees')
  await share(a, b, [C])
  await share(c, b, [D, E])
  for (let i = 0; i < grp.MAX_GROUPS_PER_DIARY - 1; i++) {
    const k = hex(crypto.randomBytes(32))
    const nonce = hex(crypto.randomBytes(32))
    await store.putGroupWriter(b.storage, { group: k, key: k, nonce, rootNonce: nonce })
  }
  t.alike(await ops.communityJoin(b.ctx, { community: C }), { state: 'member', group: null }, 'the join fits in the last slot')
  t.is(await ownWriter(b, D), null, 'nothing written in the other community\'s root')
  t.is(await writerCount(b), grp.MAX_GROUPS_PER_DIARY)
  const bInfo = await ops.communityInfo(b.ctx, { community: C })
  t.alike([bInfo.general, bInfo.groups], [null, []], 'the same on the member\'s device')
})

test('group.standalone: a held standalone root bound only by a writer naming a CW is not listed as pending', async (t) => {
  const a = await setup(t)
  const e = await setup(t, { assoc: a.assoc, name: 'Edu' })
  const { group: S } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const C = await craftCommunity(a, S)
  await share(a, e, [C])
  t.alike(await ops.communityJoin(e.ctx, { community: C }), { state: 'member', group: S }, 'pending Geral step')
  const pw = await ownWriter(e, S)
  t.not((await records(e, pw))[0].member, S, 'the pending writer names the CW')
  await copyCore(a, e, S)
  // A second device: no local entry for S, the writer naming the CW held.
  const d = await secondDevice(t, e, [C, S, pw])
  t.is(await ownWriter(d, S), null, 'no local entry')
  t.absent((await ops.groupStandalone(d.ctx)).groups.some((g) => g.group === S), 'not listed as pending')
  t.absent((await ops.groupStandalone(e.ctx)).groups.some((g) => g.group === S), 'nor on the first device')
})

test('group.join of a held standalone root on a disconnected device: the off-device refusal first, as the core node', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const { group: S } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await share(a, b, [S])
  // b's second device d enrols in b's community, then b disconnects it.
  const { community, group: general } = await ops.communityCreate(b.ctx, { name: 'Bairro', join: 'open' })
  const d = await secondDevice(t, b, [community, general, S])
  t.is((await ops.deviceUpkeep(d.ctx, await ops.deviceUpkeepPlan(d.ctx))).enrolled.length, 2)
  await syncDiary(d, b)
  await ops.deviceHello(b.ctx, { name: 'Celular' })
  await ops.deviceDisconnect(b.ctx, { previous: true })
  await syncDiary(b, d)
  t.alike(await ops.deviceOff(d.ctx), { off: true })
  const before = await diaryLength(d)
  await t.exception(ops.groupJoin(d.ctx, { group: S, community }), new RegExp(devices.OFF_REFUSED))
  await t.exception(ops.groupJoin(d.ctx, { group: S, community, standalone: true }), new RegExp(devices.OFF_REFUSED))
  t.is(await ownWriter(d, S), null, 'nothing written')
  t.is(await diaryLength(d), before)
})

test('a contradicted pending writer of a diary that is a member through another device: group.join retires it and names the right member', async (t) => {
  const a = await setup(t)
  const e = await setup(t, { assoc: a.assoc, name: 'Edu' })
  const { group: S } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const { community: C, group: general } = await ops.communityCreate(e.ctx, { name: 'Bairro', join: 'open' })
  const { group: P } = await ops.groupCreate(e.ctx, { name: 'Feira', join: 'open', community: C })
  // Device B (d) of e enrols in C, then joins S and P before holding either
  // root, each with the hint the arriving root contradicts.
  const d = await secondDevice(t, e, [C, general])
  t.is((await ops.deviceUpkeep(d.ctx, await ops.deviceUpkeepPlan(d.ctx))).enrolled.length, 2)
  t.alike(await ops.groupJoin(d.ctx, { group: S, community: C }), { state: 'pending' })
  t.alike(await ops.groupJoin(d.ctx, { group: P, standalone: true }), { state: 'pending' })
  await syncDiary(d, e)
  // Device A (e) joins S; e created P, so the diary is a member of both.
  await share(a, e, [S])
  t.alike(await ops.groupJoin(e.ctx, { group: S }), { state: 'member' })
  await syncDiary(e, d)
  await copyCore(a, d, S)
  await copyCore(e, d, P)
  await copyCore(e, d, await ownWriter(e, S))
  const cw = await ownWriter(d, C)
  for (const [g, m] of [[S, S], [P, cw]]) {
    const old = await ownWriter(d, g)
    t.not((await records(d, old))[0].member, m, 'the pending writer names the wrong member')
    t.is((await ops.groupInfo(d.ctx, { group: g })).state, 'member', 'a member through device A')
    t.alike(await ops.groupJoin(d.ctx, { group: g }), { state: 'member' }, 'no GROUP_FULL')
    const w = await ownWriter(d, g)
    t.not(w, old, 'a new writer')
    t.is((await records(d, w))[0].member, m, 'naming the right member')
    const core = await store.openDiary(d.storage)
    let own
    try { own = await store.readAll(core) } finally { await core.close() }
    t.alike(grp.groupJoinHistory(own, g).filter((j) => j.writer === old).map((j) => j.on), [true, false], 'the old writer stays bound, off')
    t.ok(grp.groupCutHistory(own, g).some((x) => x.writer === old), 'and cut')
    await ops.groupPost(d.ctx, { group: g, text: 'de B' })
    t.ok((await ops.groupRead(d.ctx, { group: g })).items.some((p) => p.text === 'de B'), 'a post through the new writer')
    t.alike(await ops.groupLeave(d.ctx, { group: g }), { state: 'left' }, 'a leave works too')
  }
})

test('a member-stale writer holding a post is cut at its held length, never at 0', async (t) => {
  const a = await setup(t)
  const e = await setup(t, { assoc: a.assoc, name: 'Edu' })
  const { group: S } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const { community: C, group: general } = await ops.communityCreate(e.ctx, { name: 'Bairro', join: 'open' })
  const d = await secondDevice(t, e, [C, general])
  t.is((await ops.deviceUpkeep(d.ctx, await ops.deviceUpkeepPlan(d.ctx))).enrolled.length, 2)
  t.alike(await ops.groupJoin(d.ctx, { group: S, community: C }), { state: 'pending' })
  const entry = (await store.readGroupWriters(d.storage)).find((x) => x.group === S)
  const core = await store.openGroupWriter(d.storage, await d.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.nonce, 'hex'))))
  try {
    await store.appendGroupRecord(core, grp.groupPost({ text: 'antes' }), { root: false })
  } finally {
    await core.close()
  }
  const old = entry.key
  t.is((await records(d, old)).length, 2, 'header and a post')
  await syncDiary(d, e)
  await share(a, e, [S])
  t.alike(await ops.groupJoin(e.ctx, { group: S }), { state: 'member' })
  await syncDiary(e, d)
  await copyCore(a, d, S)
  await copyCore(e, d, await ownWriter(e, S))
  t.alike(await ops.groupJoin(d.ctx, { group: S }), { state: 'member' })
  const diary = await store.openDiary(d.storage)
  let own
  try { own = await store.readAll(diary) } finally { await diary.close() }
  t.alike(grp.groupCutHistory(own, S).filter((m) => m.writer === old).map((m) => m.cut), [2], 'cut at the held length')
})
