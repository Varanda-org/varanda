'use strict'

// Communities of the browser node (lib/member-ops.js community*, protocol
// v2: a community contains its groups): create with Geral, join and leave,
// moderation through community writers, community authority inside groups,
// the resume of an interrupted create and the legacy sweep
// (lib/node-store.js purgeLegacyGroupCores). Operations are called on the
// member-ops context; cores move between storages by direct replication, so
// no seeder or sockets are involved.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')
const grp = require('@varanda/core/lib/group')
const { groupJoinRecord, groupCutRecord, groupConfirmRecord, deleteRecord } = require('@varanda/core/lib/records')

const hex = (buf) => b4a.toString(buf, 'hex')
const FORBIDDEN = 'sem permissão na comunidade'

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

// Copies `from`'s diary and the group cores `keys` (held by `from`) to `to`,
// listed as the sync would list them.
async function share (from, to, keys, { diary: withDiary = true } = {}) {
  for (const key of [...(withDiary ? [from.key] : []), ...keys]) {
    const diary = key === from.key
    const source = diary ? await store.openDiary(from.storage) : await store.openGroupCoreReadOnly(from.storage, key)
    const target = diary ? await store.openReplica(to.storage, key) : await store.openGroupReplica(to.storage, key)
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
    if (!diary) await store.addGroupReplica(to.storage, key)
  }
  await store.addGroupDiary(to.storage, from.key)
}

async function coreLength (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  if (core === null) return 0
  try { return core.length } finally { await core.close() }
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

async function records (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try { return (await store.readAll(core)).map((e) => e.record) } finally { await core.close() }
}

async function lastRecord (s, key) {
  return (await records(s, key)).pop()
}

async function diaryJoins (s, group) {
  return (await ops.logRead(s.ctx)).entries.map((e) => e.record).filter((r) => r.type === 'group-join' && r.group === group)
}

// A creator `a` with an open community and members who joined it (each
// shares its diary and CW back to `a`, and holds C root, a's diary and Geral).
async function world (t, n = 2, { join = 'open' } = {}) {
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

// `s` joins the community and Geral; its CW and Geral writer go to `to`.
async function enter (s, community, ...to) {
  const res = await ops.communityJoin(s.ctx, { community })
  for (const x of to) await share(s, x, [await ownWriter(s, community), ...(res.group ? [await ownWriter(s, res.group)] : [])])
  return res
}

const COMMUNITY_OPS = ['communityAdmit', 'communityBan', 'communityCreate', 'communityGroups', 'communityInfo', 'communityInvitePolicy', 'communityJoin', 'communityLeave', 'communityList', 'communityMembers', 'communityMeta', 'communityRemoveGroup', 'communityRequests', 'communitySetAdmin']

test('member-ops exports every community operation and no link', async (t) => {
  t.alike(Object.keys(ops).filter((k) => k.startsWith('community')).sort(), COMMUNITY_OPS)
  t.absent(ops.communityLink, 'community.link was removed in protocol v2')
})

test('community create writes the root and Geral; info shapes and refusals', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const entries = await store.readGroupWriters(a.storage)
  const cEntry = entries.find((e) => e.group === community)
  const gEntry = entries.find((e) => e.group === general)
  t.alike({ key: cEntry.key, kind: cEntry.kind, root: cEntry.rootNonce === cEntry.nonce }, { key: community, kind: 'community', root: true }, 'stored as an own root of kind community')
  t.alike({ key: gEntry.key, kind: gEntry.kind, root: gEntry.rootNonce === gEntry.nonce }, { key: general, kind: undefined, root: true }, 'Geral is an own group root')
  const cRecords = await records(a, community)
  t.alike(cRecords.map((r) => r.type), ['group-header', 'group-create'])
  t.alike([cRecords[0].kind, cRecords[1].group, cRecords[1].seen], ['community', general, null])
  const gHeader = (await records(a, general))[0]
  t.alike([gHeader.kind, gHeader.community, gHeader.member, gHeader.name, gHeader.join], ['group', community, community, 'Geral', 'open'])
  t.alike((await diaryJoins(a, community)).map((j) => [j.writer, j.on]), [[community, true]])
  t.alike((await diaryJoins(a, general)).map((j) => [j.writer, j.on]), [[general, true]])
  t.is(await store.readCommunityCreate(a.storage), null, 'the plan is dropped')

  const geralRow = { group: general, name: 'Geral', visibility: 'public', join: 'open', role: 'creator', general: true }
  t.alike(await ops.communityInfo(a.ctx, { community }), {
    community, name: 'Bairro', join: 'open', creator: a.key, role: 'creator', state: 'ready', members: 1, admins: 1, groups: [geralRow], general, incomplete: false, leavePending: false, repair: false, dropped: [], memberInvite: false, writerHere: true, canWrite: true, rootHere: true, authorityHere: true
  })
  t.alike(await ops.groupInfo(a.ctx, { group: general }), { group: general, name: 'Geral', join: 'open', creator: a.key, role: 'creator', members: 1, state: 'member', community, orphan: false, visibility: 'public', memberInvite: false, writerHere: true, canWrite: true })
  t.alike(await ops.groupList(a.ctx), { groups: [{ group: general, name: 'Geral', join: 'open', role: 'creator', members: 1, community }], total: 1 }, 'a community is not listed as a group')

  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'approval', community })
  t.alike(await lastRecord(a, community), { ...await lastRecord(a, community), type: 'group-create', group: horta }, 'the group-create goes to the community root')
  t.alike((await ops.communityInfo(a.ctx, { community })).groups.map((g) => g.group), [general, horta].sort())
  await t.exception(() => ops.communitySetAdmin(a.ctx, { community, member: a.key, on: true }), /o criador da comunidade já administra/)
  await t.exception(() => ops.communityMeta(a.ctx, { community }), /nada a alterar/)
  t.alike(await ops.communityMeta(a.ctx, { community, name: 'Bairro novo', join: 'approval' }), { ok: true })
  t.alike([(await ops.communityInfo(a.ctx, { community })).name, (await ops.communityInfo(a.ctx, { community })).join], ['Bairro novo', 'approval'])

  await share(a, b, [community, general])
  const seen = await ops.communityInfo(b.ctx, { community })
  t.alike([seen.role, seen.creator, seen.members, seen.groups.find((g) => g.general).name], ['left', a.key, 1, 'Geral'], 'a non-member reads the community from replicas')
  t.alike(seen.groups.find((g) => g.group === horta), { group: horta, name: null, visibility: null, join: null, role: null, general: false }, 'a group root not held is named by key only')
  for (const [method, params] of [
    ['communityMeta', { community, name: 'Outro' }],
    ['communitySetAdmin', { community, member: b.key, on: true }],
    ['communityRequests', { community }],
    ['communityBan', { community, member: a.key, on: true }]
  ]) {
    await t.exception(() => ops[method](b.ctx, params), new RegExp(FORBIDDEN), method)
  }
  await t.exception(() => ops.groupCreate(b.ctx, { name: 'Feira', join: 'open', community }), /só quem criou a comunidade cria grupos/)
  await t.exception(() => ops.groupJoin(b.ctx, { group: general }), /entre na comunidade primeiro/)
  const pending = 'cd'.repeat(32)
  t.alike(await ops.communityInfo(b.ctx, { community: pending }), { community: pending, name: null, join: null, creator: null, role: 'pending', state: 'pending', members: 0, admins: 0, groups: [], general: null, incomplete: true, leavePending: false, repair: false, dropped: [], memberInvite: false, writerHere: false, canWrite: false, rootHere: false, authorityHere: false })
  await t.exception(() => ops.communityInfo(b.ctx, { community: general }), /comunidade não encontrada/, 'a group root is no community')
})

test('community.list: created and joined, by role then name, blocklisted left out', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  t.alike(await ops.communityList(b.ctx), { communities: [] })
  await enter(b, community, a)
  const { community: vila, group: vilaGeral } = await ops.communityCreate(b.ctx, { name: 'Vila', join: 'open' })
  const row = (c, name, role, g) => ({ community: c, name, join: 'open', state: 'ready', role, general: g })
  t.alike(await ops.communityList(b.ctx), { communities: [row(vila, 'Vila', 'creator', vilaGeral), row(community, 'Bairro', 'member', general)] })
  const pending = 'cd'.repeat(32)
  await ops.communityJoin(b.ctx, { community: pending })
  t.alike((await ops.communityList(b.ctx)).communities.pop(), { community: pending, name: null, join: null, state: 'pending', role: 'pending', general: null })
  t.alike((await ops.groupList(b.ctx)).groups.map((g) => g.group).sort(), [general, vilaGeral].sort(), 'group.list never lists a community')

  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, a.assoc)
  await store.writeBlocklist(b.storage, createSnapshot({ seq: 1, blocked: [vila] }, modKp, modCert))
  t.alike((await ops.communityList(b.ctx)).communities.map((c) => c.community), [community, pending], 'a blocklisted root is left out')
})

test('community.join: open member with Geral at once, idempotent, the creator folds both', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const cw = await ownWriter(b, community)
  const gw = await ownWriter(b, general)
  const header = (await records(b, cw))[0]
  t.alike([header.type, header.group, header.member, header.rejoin], ['group-writer', community, null, null], 'a CW names no member')
  t.is((await records(b, gw))[0].member, cw, 'the Geral writer names the CW')
  const kv = await store.readGroupWriters(b.storage)
  t.is(kv.find((e) => e.group === community).kind, 'community')
  const lengths = [await coreLength(b, cw), await coreLength(b, gw), (await diaryJoins(b, community)).length, (await diaryJoins(b, general)).length]
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general }, 'a repeated join answers the same')
  t.alike([await coreLength(b, cw), await coreLength(b, gw), (await diaryJoins(b, community)).length, (await diaryJoins(b, general)).length], lengths, 'nothing new written')
  t.alike(await store.readGroupWriters(b.storage), kv)
  t.is((await ops.groupInfo(b.ctx, { group: general })).role, 'member')
  await share(b, a, [cw, gw])
  t.is((await ops.communityInfo(a.ctx, { community })).members, 2)
  t.alike((await ops.communityMembers(a.ctx, { community })).members.map((m) => [m.member, m.admin, m.banned]).sort(), [[a.key, true, false], [b.key, false, false]].sort())
  t.is((await ops.groupInfo(a.ctx, { group: general })).members, 2)

  const c = await setup(t, { assoc: a.assoc })
  t.alike(await ops.communityJoin(c.ctx, { community }), { state: 'pending', group: null }, 'root not held: pending')
  t.is((await store.readGroupWriters(c.storage)).find((e) => e.group === community).kind, 'community', 'the pending CW is listed as a community entry')
})

test('approval community: requests, admit, ban and unban by the creator', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1, { join: 'approval' })
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'requested', group: general }, 'the Geral writer is written at join time')
  await t.exception(() => ops.communityRequests(b.ctx, { community }), new RegExp(FORBIDDEN))
  const cw = await ownWriter(b, community)
  await share(b, a, [cw, await ownWriter(b, general)])
  const req = await ops.communityRequests(a.ctx, { community })
  t.alike([req.total, req.requests[0].member, req.requests[0].name], [1, b.key, 'M0'])
  t.is((await ops.groupInfo(a.ctx, { group: general })).members, 1, 'a requested diary is no member of Geral')
  t.alike(await ops.communityAdmit(a.ctx, { community, member: b.key, on: true }), { ok: true })
  const admit = await lastRecord(a, community)
  t.alike([admit.type, admit.group, admit.member, admit.cuts], ['group-admit', null, b.key, [{ writer: cw, seq: 1 }]], 'cuts over the CW')
  t.is((await ops.groupInfo(a.ctx, { group: general })).members, 2, 'admitted in C: a member of Geral')
  await share(a, b, [community])
  t.is((await ops.communityInfo(b.ctx, { community })).role, 'member')
  t.is((await ops.groupInfo(b.ctx, { group: general })).state, 'member')

  await t.exception(() => ops.communityBan(a.ctx, { community, member: b.key, on: false }), /nada a alterar/, 'no ban to lift')
  await t.exception(() => ops.communityBan(a.ctx, { community, member: a.key, on: true }), new RegExp(FORBIDDEN), 'never the creator')
  t.alike(await ops.communityBan(a.ctx, { community, member: b.key, on: true }), { ok: true })
  t.is((await ops.communityMembers(a.ctx, { community })).members.find((m) => m.member === b.key).banned, true)
  await share(a, b, [community])
  await t.exception(() => ops.communityJoin(b.ctx, { community }), new RegExp(FORBIDDEN))
  await t.exception(() => ops.communityLeave(b.ctx, { community }), new RegExp(FORBIDDEN))
  t.alike(await ops.communityBan(a.ctx, { community, member: b.key, on: false }), { ok: true })
  t.is((await ops.communityInfo(a.ctx, { community })).members, 2, 'the unban lifted the ban')
})

test('only the community creator creates groups, from its root device; admins, members and non-members are refused', async (t) => {
  const { a, members: [b, c], community } = await world(t, 2)
  await enter(b, community, a)
  await enter(c, community, a)
  const bcw = await ownWriter(b, community)
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  const grant = await lastRecord(a, community)
  t.alike([grant.type, grant.member, grant.on, grant.cuts], ['group-admin', b.key, true, [{ writer: bcw, seq: 1 }]], 'cuts over the member\'s CWs')
  await share(a, b, [community])
  const kv = await store.readGroupWriters(b.storage)
  const cores = await store.readGroupCoreKeys(b.storage)
  await t.exception(() => ops.groupCreate(b.ctx, { name: 'Horta', join: 'open', community }), /só quem criou a comunidade cria grupos/, 'an admin is refused')
  await t.exception(() => ops.groupCreate(c.ctx, { name: 'Feira', join: 'open', community }), /só quem criou a comunidade cria grupos/, 'a member is refused')
  t.alike([await store.readGroupWriters(b.storage), await store.readGroupCoreKeys(b.storage)], [kv, cores], 'nothing written by a refusal')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  const create = await lastRecord(a, community)
  t.alike([create.type, create.group], ['group-create', group], 'the group-create goes to the community root')
  const header = (await records(a, group))[0]
  t.alike([header.community, header.member, header.diary], [community, community, a.key])
  await share(a, c, [community, group])
  t.alike(await ops.groupJoin(c.ctx, { group }), { state: 'member' }, 'a member joins the creator\'s group')

  const d = await setup(t, { assoc: a.assoc })
  await share(a, d, [community, group])
  await t.exception(() => ops.groupCreate(d.ctx, { name: 'Praça', join: 'open', community }), /só quem criou a comunidade cria grupos/, 'a non-member is refused')
  await t.exception(() => ops.groupJoin(d.ctx, { group }), /entre na comunidade primeiro/, 'group.join needs the community first')
  await t.exception(() => ops.groupJoin(d.ctx, { group, community: 'ef'.repeat(32) }), /o grupo não é dessa comunidade/)
  await t.exception(() => ops.communitySetAdmin(a.ctx, { community, member: d.key, on: true }), /a pessoa precisa ser membro da comunidade/)

  // The creator on a device without the root's nonce (its entry is a CW).
  const entries = (await store.readGroupWriters(a.storage)).map((e) => e.group === community ? { group: community, key: hex(crypto.randomBytes(32)), nonce: hex(crypto.randomBytes(32)), rootNonce: null, kind: 'community' } : e)
  await a.storage.writeJson('groupWriters', { v: 1, entries })
  await t.exception(() => ops.groupCreate(a.ctx, { name: 'Feira', join: 'open', community }), /crie pelo aparelho que criou a comunidade/)
})

test('a community admin bans in a group through its CW; a new CW needs a new grant', async (t) => {
  const { a, members: [b, c], community } = await world(t, 2)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  for (const s of [b, c]) {
    await enter(s, community, a)
    await share(a, s, [community, group])
    t.alike(await ops.groupJoin(s.ctx, { group }), { state: 'member' })
    await share(s, a, [await ownWriter(s, group)])
  }
  await share(b, c, [await ownWriter(b, community), await ownWriter(b, group)])
  const ccw = await ownWriter(c, community)
  await ops.communitySetAdmin(a.ctx, { community, member: c.key, on: true })
  await share(a, c, [community])
  t.is((await ops.groupInfo(c.ctx, { group })).role, 'admin', 'a community admin is an admin of its groups')
  t.alike(await ops.groupBan(c.ctx, { group, member: b.key, on: true }), { ok: true })
  const ban = await lastRecord(c, ccw)
  t.alike([ban.type, ban.group, ban.member, ban.on], ['group-ban', group, b.key, true], 'written in the CW naming the group')
  const banned = async (s) => (await ops.groupMembers(s.ctx, { group })).members.filter((m) => m.member === b.key).map((m) => m.banned)
  t.alike(await banned(c), [true])
  await share(c, a, [ccw])
  t.alike(await banned(a), [true], 'the creator folds the community admin ban')
  await t.exception(() => ops.groupAdmin(c.ctx, { group, member: b.key, on: true }), /sem permissão no grupo/, 'a community admin never appoints group admins')

  // Another device of the admin, with a CW the grant does not list, writes
  // an unban: it is ignored until a new grant lists that CW.
  const lifts = { writer: ccw, seq: (await coreLength(c, ccw)) - 1 }
  const bw = await ownWriter(b, group)
  const unban = () => grp.communityBan({ group, member: b.key, on: false, cuts: [{ writer: bw, seq: 1 }], lifts })
  const kp = await c.ctx.groupKeyPair(new Uint8Array(crypto.randomBytes(32)))
  const cw2 = hex(kp.publicKey)
  const append = async (record) => {
    const core = await store.openGroupWriter(c.storage, kp)
    try { await store.appendGroupRecord(core, record, { root: false, community: true }) } finally { await core.close() }
  }
  await append(grp.writerHeader({ group: community, diary: c.key, member: null }))
  await store.addGroupReplica(c.storage, cw2)
  const diary = await store.openDiary(c.storage, c.ctx.keyPair)
  try { await store.appendRecord(diary, groupJoinRecord({ group: community, writer: cw2, on: true })) } finally { await diary.close() }
  await append(unban())
  await share(c, a, [ccw, cw2])
  t.alike(await banned(a), [true], 'an unban from a CW no grant lists is ignored')
  await ops.communitySetAdmin(a.ctx, { community, member: c.key, on: true })
  t.ok((await lastRecord(a, community)).cuts.some((x) => x.writer === cw2), 'the new grant lists the second CW')
  t.alike(await banned(a), [true], 'records written before the new grant stay ignored')
  await append(unban())
  await share(c, a, [cw2])
  t.alike(await banned(a), [false], 'an unban written after the new grant counts')
})

test('a hide by a community admin stays after its demotion; later hides are refused', async (t) => {
  const { a, members: [c], community, general } = await world(t, 1)
  await ops.groupPost(a.ctx, { group: general, text: 'apagar' })
  await ops.groupPost(a.ctx, { group: general, text: 'fica' })
  await enter(c, community, a)
  const ccw = await ownWriter(c, community)
  await ops.communitySetAdmin(a.ctx, { community, member: c.key, on: true })
  await share(a, c, [community, general])
  t.alike(await ops.groupHide(c.ctx, { group: general, target: { writer: general, seq: 1 }, on: true }), { ok: true })
  const hide = await lastRecord(c, ccw)
  t.alike([hide.type, hide.group, hide.target], ['group-hide', general, { writer: general, seq: 1 }])
  await share(c, a, [ccw])
  const hidden = async (seq) => (await ops.groupRead(a.ctx, { group: general })).items.find((p) => p.writer === general && p.seq === seq).hidden
  t.ok(await hidden(1), 'hidden by the community admin')
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: c.key, on: false }), { community, member: c.key, on: false })
  t.ok(await hidden(1), 'the hide stays below the demotion cut')
  await share(a, c, [community])
  await t.exception(() => ops.groupHide(c.ctx, { group: general, target: { writer: general, seq: 2 }, on: true }), /sem permissão no grupo/)
  t.absent(await hidden(2))
})

test('group.create refuses a group root named as the community, nothing written', async (t) => {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const lengths = [await coreLength(a, community), await coreLength(a, general)]
  const kv = await store.readGroupWriters(a.storage)
  await t.exception(() => ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community: general }), /comunidade não encontrada/)
  await t.exception(() => ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community: 'cd'.repeat(32) }), /aguarde a sincronização da comunidade/)
  t.alike([await coreLength(a, community), await coreLength(a, general)], lengths, 'nothing written')
  t.alike(await store.readGroupWriters(a.storage), kv, 'no new root listed')
})

// Parent paging (lib/sync.js): a held group root's community is paged.
test('sync: a community root replicates for a member of one of its groups', async (t) => {
  t.timeout(180000)
  const { testnet, until } = require('./helpers/net')
  const { member, seederOverWs, indexed, once, named } = require('./helpers/sync-groups')
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const { community, group } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed the group and community roots')
  await until(() => indexed(seeder, group, group) && indexed(seeder, community, community), { name: 'roots indexed' })
  await store.addGroupReplica(b.storage, group)
  const ev = []
  t.ok((await once(b, url, ev)).ok, 'member once run ok')
  t.ok(named(ev, 'group-paged').some((e) => e.group === community), 'the community is paged')
  t.ok(await store.groupCoreExists(b.storage, community), 'the community root is stored')
  t.is((await ops.groupInfo(b.ctx, { group })).community, community, 'the member folds the parent')
})

test('group.create refuses a 33rd group in a community with nothing written', async (t) => {
  t.timeout(300000)
  const a = await setup(t)
  const { community } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  for (let i = 0; i < 31; i++) await ops.groupCreate(a.ctx, { name: 'G' + i, join: 'open', community })
  t.is((await ops.communityInfo(a.ctx, { community })).groups.length, 32, 'Geral and 31 more')
  const length = await coreLength(a, community)
  const kv = (await store.readGroupWriters(a.storage)).length
  await t.exception(() => ops.groupCreate(a.ctx, { name: 'G31', join: 'open', community }), /a comunidade chegou ao limite de grupos/)
  t.is(await coreLength(a, community), length, 'nothing written in the community')
  t.is((await store.readGroupWriters(a.storage)).length, kv, 'no root made')
})

test('community.admin: on cuts the member\'s CWs at their signed length, the target must be a member', async (t) => {
  const { a, members: [b, x], community } = await world(t, 2)
  await enter(b, community, a)
  const bcw = await ownWriter(b, community)
  await t.exception(() => ops.communitySetAdmin(a.ctx, { community, member: x.key, on: true }), /a pessoa precisa ser membro da comunidade/, 'a non-member')
  await t.exception(() => ops.communitySetAdmin(b.ctx, { community, member: b.key, on: true }), new RegExp(FORBIDDEN), 'creator only')
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  t.alike((await lastRecord(a, community)).cuts, [{ writer: bcw, seq: await coreLength(b, bcw) }])
  t.is((await ops.communityInfo(a.ctx, { community })).admins, 2)
  t.is((await ops.communityMembers(a.ctx, { community })).members.find((m) => m.member === b.key).admin, true)
  await t.exception(() => ops.communityBan(a.ctx, { community, member: b.key, on: true }), new RegExp(FORBIDDEN), 'an admin is never a target')
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: false }), { community, member: b.key, on: false })
  t.is((await ops.communityInfo(a.ctx, { community })).admins, 1)
})

test('a demotion lists every counted CW of the member, in key order', async (t) => {
  t.timeout(300000)
  const { a, members: [m], community } = await world(t, 1)
  const keys = new Set()
  for (let i = 0; i < 4; i++) {
    if (i > 0) await ops.communityLeave(m.ctx, { community })
    await ops.communityJoin(m.ctx, { community })
    keys.add(await ownWriter(m, community))
  }
  t.is(keys.size, 4, 'a new CW on each rejoin')
  await share(m, a, [...keys])
  t.is((await ops.communityInfo(a.ctx, { community })).members, 2)
  // A demotion needs an earlier grant.
  await ops.communitySetAdmin(a.ctx, { community, member: m.key, on: true })
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: m.key, on: false }), { community, member: m.key, on: false })
  const demotion = await lastRecord(a, community)
  t.alike([demotion.type, demotion.on], ['group-admin', false])
  t.alike(demotion.cuts.map((c) => c.writer), [...keys].sort(), 'every CW, in key order')
})

test('community.leave gates every group of the community; a rejoin writes a new group writer', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  await ops.groupPost(b.ctx, { group: general, text: 'antes' })
  const gw1 = await ownWriter(b, general)
  const cw1 = await ownWriter(b, community)
  const glen = await coreLength(b, gw1)
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' }, 'a second leave writes nothing')
  t.is(await coreLength(b, gw1), glen + 1, 'one group-leave in the group writer, none from the second leave')
  t.is((await lastRecord(b, gw1)).type, 'group-leave')
  const leave = await lastRecord(b, cw1)
  t.alike([leave.type, leave.cuts], ['group-leave', [{ writer: cw1, seq: 1 }]])
  t.alike((await diaryJoins(b, community)).map((j) => j.on), [true, false])
  t.is((await ops.groupInfo(b.ctx, { group: general })).role, 'left', 'the gate reads the diary as left in Geral')
  await t.exception(() => ops.groupPost(b.ctx, { group: general, text: 'depois' }), /sem permissão no grupo/)
  await t.exception(() => ops.groupJoin(b.ctx, { group: general }), /entre na comunidade primeiro/)
  await share(b, a, [cw1, gw1])
  t.is((await ops.groupInfo(a.ctx, { group: general })).members, 1)
  t.alike((await ops.groupRead(a.ctx, { group: general })).items.map((p) => p.text), ['antes'], 'earlier messages stay visible')

  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const cw2 = await ownWriter(b, community)
  const gw2 = await ownWriter(b, general)
  t.not(cw2, cw1)
  t.not(gw2, gw1, 'the old group writer named the retired CW')
  t.alike((await records(b, cw2))[0].rejoin, { writer: cw1, seq: 1 }, 'the new CW names the leave')
  t.is((await ops.groupPost(b.ctx, { group: general, text: 'de volta' })).seq, 1)
  await share(b, a, [cw2, gw2])
  t.alike((await ops.groupRead(a.ctx, { group: general })).items.map((p) => p.text), ['de volta', 'antes'])

  await t.exception(() => ops.communityLeave(a.ctx, { community: 'cd'.repeat(32) }), /nada a alterar/, 'a pending community with no own writer: nothing to end')
})

test('community.ban hides a member\'s posts in its groups; the unban restores them', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  await ops.groupPost(b.ctx, { group: general, text: 'oi' })
  await share(b, a, [await ownWriter(b, general)])
  const texts = async () => (await ops.groupRead(a.ctx, { group: general })).items.filter((p) => !p.hidden).map((p) => p.text)
  t.alike(await texts(), ['oi'])
  await ops.communityBan(a.ctx, { community, member: b.key, on: true })
  t.alike(await texts(), [], 'hidden from seq 0 by the community ban')
  t.is((await ops.groupMembers(a.ctx, { group: general })).members.find((m) => m.member === b.key).banned, true, 'banned in Geral too')
  await share(a, b, [community])
  await t.exception(() => ops.groupPost(b.ctx, { group: general, text: 'de novo' }), /sem permissão no grupo/)
  await ops.communityBan(a.ctx, { community, member: b.key, on: false })
  t.alike(await texts(), ['oi'], 'the unban restores them')
})

// Fails the nth key derivation: an interrupted create at a chosen step.
function failingAt (ctx, n) {
  let calls = 0
  return { ...ctx, groupKeyPair: (nonce) => { if (++calls === n) throw new Error('falha injetada'); return ctx.groupKeyPair(nonce) } }
}

test('community.create resumes after injected failures with the same keys', async (t) => {
  const a = await setup(t)
  // Derivations: 1 and 2 plan the two cores, 3 writes the community header
  // (step 4), 4 the Geral header (step 6), 5 the group-create (step 8).
  await t.exception(() => ops.communityCreate(failingAt(a.ctx, 4), { name: 'Bairro', join: 'open' }), /falha injetada/)
  const plan = await store.readCommunityCreate(a.storage)
  t.alike([plan.name, plan.join], ['Bairro', 'open'])
  t.alike((await store.readGroupWriters(a.storage)).map((e) => e.group), [plan.community], 'stopped after step 5')
  t.alike(await ops.communityCreate(a.ctx, { name: 'Outro', join: 'approval' }), { community: plan.community, group: plan.group }, 'the started plan answers its own keys')
  t.alike((await records(a, plan.community)).map((r) => r.type), ['group-header', 'group-create'])
  t.is((await records(a, plan.community))[0].name, 'Bairro')
  t.alike((await store.readGroupWriters(a.storage)).map((e) => e.group), [plan.community, plan.group])
  t.is((await diaryJoins(a, plan.community)).length, 1, 'one join each')
  t.is((await diaryJoins(a, plan.group)).length, 1)
  t.is(await store.readCommunityCreate(a.storage), null)

  await t.exception(() => ops.communityCreate(failingAt(a.ctx, 5), { name: 'Vila', join: 'open' }), /falha injetada/)
  const second = await store.readCommunityCreate(a.storage)
  t.is(await coreLength(a, second.group), 1, 'stopped after step 7')
  const diaryLength = (await ops.logRead(a.ctx)).entries.length
  const info = await ops.communityInfo(a.ctx, { community: second.community })
  t.alike([info.state, info.role, info.general], ['pending', 'pending', null], 'community.info reads the half-created community as pending')
  t.is((await ops.logRead(a.ctx)).entries.length, diaryLength, 'community.info appends nothing to the diary')
  t.is(await coreLength(a, second.community), 1, 'nor to the community root')
  t.ok(await store.readCommunityCreate(a.storage), 'the plan stays for community.create')
  t.alike(await ops.communityCreate(a.ctx, { name: 'Vila', join: 'open' }), { community: second.community, group: second.group }, 'community.create resumes with the same keys')
  t.is(await store.readCommunityCreate(a.storage), null)
  t.alike((await records(a, second.community)).map((r) => r.type), ['group-header', 'group-create'])

  await t.exception(() => ops.communityCreate(failingAt(a.ctx, 3), { name: 'Praça', join: 'open' }), /falha injetada/)
  const third = await store.readCommunityCreate(a.storage)
  const other = await ops.communityCreate(a.ctx, { name: 'Feira', join: 'open' })
  t.not(other.community, third.community, 'a plan whose root was never written gives way to other params')
  t.is((await ops.communityInfo(a.ctx, { community: other.community })).name, 'Feira')
  t.is((await store.readGroupWriters(a.storage)).length, 6)
})

test('purgeLegacyGroupCores purges protocol v1 cores and their entries, keeps v2', async (t) => {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const raw = async (record) => {
    const nonce = crypto.randomBytes(32)
    const kp = await a.ctx.groupKeyPair(new Uint8Array(nonce))
    const core = await store.openGroupWriter(a.storage, kp)
    try { await core.append(record) } finally { await core.close() }
    return { key: hex(kp.publicKey), nonce: hex(nonce) }
  }
  const at = new Date().toISOString()
  const root = await raw({ type: 'group-header', v: 1, kind: 'group', diary: a.key, visibility: 'public', join: 'open', name: 'Velho', box: null, at })
  const writer = await raw({ type: 'group-writer', v: 1, group: 'ab'.repeat(32), diary: a.key, box: null, rejoin: null, at })
  await store.putGroupWriter(a.storage, { group: root.key, key: root.key, nonce: root.nonce, rootNonce: root.nonce })
  await store.addGroupReplica(a.storage, writer.key)
  const events = await store.purgeLegacyGroupCores(a.storage)
  t.alike(events, [root.key, writer.key].sort().map((key) => ({ event: 'group-skipped', key, reason: 'legacy' })))
  t.alike((await store.readGroupWriters(a.storage)).map((e) => e.group), [community, general], 'the legacy entry is dropped, created or not')
  t.absent(await store.groupCoreExists(a.storage, root.key))
  t.absent(await store.groupCoreExists(a.storage, writer.key))
  t.absent((await store.readGroupReplicas(a.storage)).includes(writer.key))
  t.absent((await store.readGroupCoreKeys(a.storage)).includes(root.key))
  t.alike(await store.purgeLegacyGroupCores(a.storage), [], 'nothing left to purge')
  t.is((await ops.groupInfo(a.ctx, { group: general })).role, 'creator', 'v2 cores untouched')
})

// Another device of `s`: a raw core in `group` holding `list` (its header
// first), bound by a join on in s's diary -> its key.
test('community.admin off for a diary never granted is nothing to change, nothing written', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  const before = await coreLength(a, community)
  await t.exception(() => ops.communitySetAdmin(a.ctx, { community, member: b.key, on: false }), /nada a alterar/, 'a member never granted')
  t.is(await coreLength(a, community), before, 'no demotion written')
})

test('a creator back after a confirmed leave no longer creates groups, edits the community or names admins', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  const rootLength = await coreLength(a, community)
  // A second device of the creator leaves C listing the root, and the diary
  // confirms that leave and turns that CW off.
  const kp = await a.ctx.groupKeyPair(new Uint8Array(crypto.randomBytes(32)))
  const cw2 = hex(kp.publicKey)
  const leave = grp.groupLeave({ cuts: [{ writer: community, seq: rootLength }, { writer: cw2, seq: 1 }].sort((x, y) => x.writer.localeCompare(y.writer)) })
  const core = await store.openGroupWriter(a.storage, kp)
  try {
    await store.appendGroupRecord(core, grp.writerHeader({ group: community, diary: a.key, member: null }), { root: false, community: true })
    await store.appendGroupRecord(core, leave, { root: false, community: true })
  } finally { await core.close() }
  await store.addGroupReplica(a.storage, cw2)
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupJoinRecord({ group: community, writer: cw2, on: true }))
    await store.appendRecord(diary, groupConfirmRecord({ group: community, writer: cw2, seq: 1, digest: grp.leaveDigest(leave) }))
    await store.appendRecord(diary, groupJoinRecord({ group: community, writer: cw2, on: false }))
  } finally { await diary.close() }
  t.is((await ops.communityJoin(a.ctx, { community })).state, 'member', 'the creator is back')
  const before = await coreLength(a, community)
  const cores = await store.readGroupCoreKeys(a.storage)
  await t.exception(() => ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community }), new RegExp(FORBIDDEN), 'group.create')
  await t.exception(() => ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true }), new RegExp(FORBIDDEN), 'community.admin')
  t.is(await coreLength(a, community), before, 'nothing written on the root')
  t.alike(await store.readGroupCoreKeys(a.storage), cores, 'no group root written')
  t.is((await ops.communityInfo(a.ctx, { community })).name, 'Bairro')
  // The powers ended: community.meta goes through the CW (cycle 24).
  const cw = await ownWriter(a, community)
  t.alike(await ops.communityMeta(a.ctx, { community, name: 'Outro' }), { ok: true })
  t.is(await coreLength(a, community), before, 'still nothing on the root')
  const last = await lastRecord(a, cw)
  t.alike([last.type, last.group, last.name], ['group-meta', null, 'Outro'], 'the meta is on the CW')
})

async function rawDevice (s, group, list, community = false) {
  const kp = await s.ctx.groupKeyPair(new Uint8Array(crypto.randomBytes(32)))
  const core = await store.openGroupWriter(s.storage, kp)
  try {
    for (const record of list) await store.appendGroupRecord(core, record, { root: false, community })
  } finally { await core.close() }
  const key = hex(kp.publicKey)
  await store.addGroupReplica(s.storage, key)
  // A device's first on-join of a CW signs its header's rejoin, as the node
  // does: without it the fold takes the CW as generation 0.
  const rejoin = community && list[0] && list[0].rejoin ? { rejoin: list[0].rejoin } : {}
  const diary = await store.openDiary(s.storage, s.ctx.keyPair)
  try { await store.appendRecord(diary, groupJoinRecord({ group, writer: key, on: true, ...rejoin })) } finally { await diary.close() }
  return key
}

test('a group writer naming a retired CW is replaced on rejoin while another device keeps the diary a member', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const cw1 = await ownWriter(b, community)
  const w1 = await ownWriter(b, general)
  await ops.communityLeave(b.ctx, { community })
  // Another device of the same diary rejoins the community and Geral.
  const cw2 = await rawDevice(b, community, [grp.writerHeader({ group: community, diary: b.key, member: null, rejoin: { writer: cw1, seq: 1 } })], true)
  const w2 = await rawDevice(b, general, [grp.writerHeader({ group: general, diary: b.key, member: cw2, rejoin: { writer: w1, seq: 1 } })])
  t.is((await ops.groupInfo(b.ctx, { group: general })).state, 'member', 'the other device keeps the diary a member')
  await t.exception(() => ops.groupPost(b.ctx, { group: general, text: 'perdida' }), /sem permissão no grupo/, 'the writer naming the retired CW no longer writes')
  // This device rejoins the community with a new CW: Geral gets a new writer.
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const cw3 = await ownWriter(b, community)
  const w3 = await ownWriter(b, general)
  t.not(cw3, cw1)
  t.not(w3, w1, 'a new group writer replaces the one naming the retired CW')
  t.is((await records(b, w3))[0].member, cw3)
  t.alike(await ops.groupJoin(b.ctx, { group: general }), { state: 'member' })
  t.is(await ownWriter(b, general), w3, 'group.join is idempotent on the new writer')
  await ops.groupPost(b.ctx, { group: general, text: 'visível' })
  const own = (await ops.groupRead(b.ctx, { group: general })).items.find((p) => p.writer === w3)
  t.alike([own.text, own.hidden], ['visível', false], 'the author reads the post')
  await share(b, a, [cw1, cw2, cw3, w1, w2, w3])
  const peer = (await ops.groupRead(a.ctx, { group: general })).items.find((p) => p.writer === w3)
  t.alike([peer.text, peer.hidden], ['visível', false], 'a peer reads it too')
})

test('a CW another device\'s leave cut is retired: the join writes a new CW and a Geral writer naming it', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const cw1 = await ownWriter(b, community)
  const w1 = await ownWriter(b, general)
  // Another device of the diary leaves (its leave lists this device's CW)
  // and rejoins; this device's own CW core holds no leave.
  const cw2 = await rawDevice(b, community, [grp.writerHeader({ group: community, diary: b.key, member: null }), grp.groupLeave({ cuts: [{ writer: cw1, seq: 1 }] })], true)
  const leave = { writer: cw2, seq: 1 }
  const cw4 = await rawDevice(b, community, [grp.writerHeader({ group: community, diary: b.key, member: null, rejoin: leave })], true)
  const w4 = await rawDevice(b, general, [grp.writerHeader({ group: general, diary: b.key, member: cw4 })])
  t.is((await ops.communityInfo(b.ctx, { community })).role, 'member', 'the other device keeps the diary a member')
  await t.exception(() => ops.groupPost(b.ctx, { group: general, text: 'perdida' }), /sem permissão no grupo/, 'the writer naming the cut CW no longer writes')
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const cw3 = await ownWriter(b, community)
  const w3 = await ownWriter(b, general)
  t.not(cw3, cw1, 'a new CW replaces the cut one')
  t.alike((await records(b, cw3))[0].rejoin, leave, 'naming the leave that cut it')
  t.not(w3, w1)
  t.is((await records(b, w3))[0].member, cw3, 'the Geral writer names the new CW')
  await ops.groupPost(b.ctx, { group: general, text: 'visível' })
  await share(b, a, [cw1, cw2, cw4, cw3, w1, w4, w3])
  const peer = (await ops.groupRead(a.ctx, { group: general })).items.find((p) => p.writer === w3)
  t.alike([peer.text, peer.hidden], ['visível', false], 'a peer reads the post')
})

test('community.join before the creator\'s diary binds the root is pending, then proceeds after sync', async (t) => {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const d = await setup(t, { assoc: a.assoc })
  await share(a, d, [community, general], { diary: false })
  t.is((await ops.communityInfo(d.ctx, { community })).creator, null, 'the root folds unbound here')
  t.alike(await ops.communityJoin(d.ctx, { community }), { state: 'pending', group: null }, 'no cap is claimed')
  const cw = await ownWriter(d, community)
  t.ok(cw !== null, 'the CW and the diary join are written')
  t.alike(await ops.communityJoin(d.ctx, { community }), { state: 'pending', group: null }, 'a retry answers the same')
  t.is(await ownWriter(d, community), cw)
  await share(a, d, [community, general])
  t.alike(await ops.communityJoin(d.ctx, { community }), { state: 'member', group: general }, 'after the sync the join proceeds')
  t.is(await ownWriter(d, community), cw, 'the CW is reused')
  t.is((await records(d, await ownWriter(d, general)))[0].member, cw, 'the Geral step ran')
})

// A stored v1 root (never foldable in protocol v2) and this device's CW in
// it, listed as a joined community -> { root, cw }.
async function legacyCommunity (s) {
  const rk = await s.ctx.groupKeyPair(new Uint8Array(crypto.randomBytes(32)))
  const rootCore = await store.openGroupWriter(s.storage, rk)
  const root = hex(rk.publicKey)
  try { await rootCore.append({ type: 'group-header', v: 1, kind: 'community', diary: 'ab'.repeat(32), visibility: 'public', join: 'open', name: 'Velho', box: null, at: new Date().toISOString() }) } finally { await rootCore.close() }
  const nonce = crypto.randomBytes(32)
  const kp = await s.ctx.groupKeyPair(new Uint8Array(nonce))
  const core = await store.openGroupWriter(s.storage, kp)
  try { await store.appendGroupRecord(core, grp.writerHeader({ group: root, diary: s.key, member: null }), { root: false, community: true }) } finally { await core.close() }
  const cw = hex(kp.publicKey)
  await store.putGroupWriter(s.storage, { group: root, key: cw, nonce: hex(nonce), rootNonce: null, kind: 'community' })
  const diary = await store.openDiary(s.storage, s.ctx.keyPair)
  try { await store.appendRecord(diary, groupJoinRecord({ group: root, writer: cw, on: true })) } finally { await diary.close() }
  return { root, cw }
}

test('a joined community whose stored root never folds gives way in a full list', async (t) => {
  const a = await setup(t)
  const { root } = await legacyCommunity(a)
  // Every other slot holds an entry that keeps it (a root nonce).
  const kv = await store.readGroupWriters(a.storage)
  const planted = Array.from({ length: grp.MAX_GROUPS_PER_DIARY - 1 }, () => {
    const k = hex(crypto.randomBytes(32))
    return { group: k, key: k, nonce: hex(crypto.randomBytes(32)), rootNonce: hex(crypto.randomBytes(32)) }
  })
  await a.storage.writeJson('groupWriters', { v: 1, entries: [...kv, ...planted] })
  const other = 'cd'.repeat(32)
  t.alike(await ops.communityJoin(a.ctx, { community: other }), { state: 'pending', group: null }, 'room was made')
  const groups = (await store.readGroupWriters(a.storage)).map((e) => e.group)
  t.absent(groups.includes(root), 'the unfoldable community entry gave way')
  t.ok(groups.includes(other))
})

test('community.leave on a stored root that never folds takes the pending-leave path', async (t) => {
  const a = await setup(t)
  const { root, cw } = await legacyCommunity(a)
  await t.exception(() => ops.communityInfo(a.ctx, { community: root }), /comunidade não encontrada/)
  t.alike(await ops.communityLeave(a.ctx, { community: root }), { state: 'left' })
  t.alike([(await lastRecord(a, cw)).type, (await lastRecord(a, cw)).cuts], ['group-leave', [{ writer: cw, seq: 1 }]])
  t.alike((await diaryJoins(a, root)).map((j) => j.on), [true, false])
  await t.exception(() => ops.communityLeave(a.ctx, { community: root }), /nada a alterar/, 'nothing left to end')
})

test('a new CW names the causally latest leave even when a device clock behind wrote it', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const cw1 = await ownWriter(b, community)
  const w1 = await ownWriter(b, general)
  await ops.communityLeave(b.ctx, { community })
  const l1 = { writer: cw1, seq: 1 }
  const hour = 3600000
  const iso = (ms) => new Date(Date.now() + ms).toISOString()
  // Two more cycles on other devices: the newer leave carries the older
  // `at`, and the device that rejoined after it has a clock behind too.
  const cwa = await rawDevice(b, community, [
    grp.writerHeader({ group: community, diary: b.key, member: null, rejoin: l1, at: iso(hour) }),
    grp.groupLeave({ seen: l1, at: iso(-hour) })
  ], true)
  const la = { writer: cwa, seq: 1 }
  const cwb = await rawDevice(b, community, [grp.writerHeader({ group: community, diary: b.key, member: null, rejoin: la, at: iso(-2 * hour) })], true)
  t.is((await ops.communityInfo(b.ctx, { community })).role, 'member', 'the last device keeps the diary a member')
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const cw3 = await ownWriter(b, community)
  t.alike((await records(b, cw3))[0].rejoin, la, 'the causally latest leave, not the newest by time')
  t.ok((await ops.groupPost(b.ctx, { group: general, text: 'depois' })).seq >= 1)
  await share(b, a, [cw1, cwa, cwb, cw3, w1, await ownWriter(b, general)])
  const post = (await ops.groupRead(a.ctx, { group: general })).items.find((p) => p.text === 'depois')
  t.ok(post && !post.hidden, 'a peer reads the post')
})

test('a leave whose cuts omit this device\'s CW retires it: the join writes a new CW and Geral writer', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const cw1 = await ownWriter(b, community)
  const w1 = await ownWriter(b, general)
  // Another device leaves without having downloaded this device's CW (its
  // cuts list only itself), then rejoins.
  const cwa = await rawDevice(b, community, [grp.writerHeader({ group: community, diary: b.key, member: null }), grp.groupLeave({ cuts: [] })], true)
  const la = { writer: cwa, seq: 1 }
  const cwb = await rawDevice(b, community, [grp.writerHeader({ group: community, diary: b.key, member: null, rejoin: la })], true)
  t.is((await ops.communityInfo(b.ctx, { community })).role, 'member')
  await t.exception(() => ops.groupPost(b.ctx, { group: general, text: 'perdida' }), /sem permissão no grupo/, 'the retired CW\'s Geral writer no longer writes')
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const cw3 = await ownWriter(b, community)
  const w3 = await ownWriter(b, general)
  t.not(cw3, cw1, 'a new CW')
  t.alike((await records(b, cw3))[0].rejoin, la, 'naming the community\'s latest leave')
  t.not(w3, w1, 'a new Geral writer')
  t.is((await records(b, w3))[0].member, cw3)
  await ops.groupPost(b.ctx, { group: general, text: 'visível' })
  await share(b, a, [cw1, cwa, cwb, cw3, w1, w3])
  const post = (await ops.groupRead(a.ctx, { group: general })).items.find((p) => p.text === 'visível')
  t.ok(post && !post.hidden, 'a peer reads the post')
})

test('a grant listing only another device\'s CW gives this device no authority to moderate the community', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  const cwx = await rawDevice(b, community, [grp.writerHeader({ group: community, diary: b.key, member: null })], true)
  await share(b, a, [cwx])
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === community)
  const root = await store.openGroupWriter(a.storage, await a.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.rootNonce, 'hex'))))
  try {
    await store.appendGroupRecord(root, grp.groupAdmin({ member: b.key, on: true, cuts: [{ writer: cwx, seq: 1 }] }), { root: true, community: true })
  } finally {
    await root.close()
  }
  await share(a, b, [community])
  t.is((await ops.communityInfo(b.ctx, { community })).role, 'admin', 'the diary is an admin')
  const cw = await ownWriter(b, community)
  const length = await coreLength(b, cw)
  await t.exception(() => ops.communityBan(b.ctx, { community, member: 'cd'.repeat(32), on: true }), new RegExp(FORBIDDEN), 'this device\'s CW has no authority')
  t.is(await coreLength(b, cw), length, 'nothing written in its CW')
})

test('the Geral step replaces a Geral writer another device\'s leave cut', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const cw1 = await ownWriter(b, community)
  const w1 = await ownWriter(b, general)
  // Another device of the diary leaves Geral, listing this device's writer.
  await rawDevice(b, general, [grp.writerHeader({ group: general, diary: b.key, member: cw1 }), grp.groupLeave({ cuts: [{ writer: w1, seq: 1 }] })])
  t.is((await ops.groupInfo(b.ctx, { group: general })).state, 'left')
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const w3 = await ownWriter(b, general)
  t.not(w3, w1, 'a new Geral writer replaces the cut one')
  t.is((await ops.groupInfo(b.ctx, { group: general })).state, 'member')
  t.ok((await ops.groupPost(b.ctx, { group: general, text: 'voltei' })).seq >= 1)
})

test('a request in an approval community is withdrawn by community.leave', async (t) => {
  const { a, members: [b], community } = await world(t, 1, { join: 'approval' })
  t.is((await ops.communityJoin(b.ctx, { community })).state, 'requested')
  const cw = await ownWriter(b, community)
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  t.alike([(await lastRecord(b, cw)).type, (await lastRecord(b, cw)).cuts], ['group-leave', [{ writer: cw, seq: 1 }]], 'the leave is written on the pending CW')
  t.alike((await diaryJoins(b, community)).map((j) => j.on), [true, false])
  t.is((await ops.communityInfo(b.ctx, { community })).role, 'left')
  await share(b, a, [cw])
  t.is((await ops.communityRequests(a.ctx, { community })).total, 0, 'no request left to admit')
  const rootLength = await coreLength(a, community)
  await t.exception(() => ops.communityAdmit(a.ctx, { community, member: b.key, on: true }), /nada a alterar/, 'a diary that left cannot be admitted')
  t.is(await coreLength(a, community), rootLength, 'nothing written')
  t.absent((await ops.communityMembers(a.ctx, { community })).members.some((m) => m.member === b.key), 'an admit does not make the diary a member')
})

test('community.leave writes a group-leave on this device\'s writer in every own group of the community', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  await enter(b, community, a)
  await share(a, b, [community, group])
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  const writers = [await ownWriter(b, general), await ownWriter(b, group)]
  t.is(await ops.groupCommunityOf(b.ctx, group), community, 'groupCommunityOf names the parent')
  t.is(await ops.groupCommunityOf(b.ctx, 'cd'.repeat(32)), null)
  const cw = await ownWriter(b, community)
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  t.is((await lastRecord(b, cw)).type, 'group-leave', 'then the community leave')
  for (const [i, g] of [general, group].entries()) {
    const leaves = (await records(b, writers[i])).filter((r) => r.type === 'group-leave')
    t.is(leaves.length, 1, 'one group-leave in the group writer')
    t.alike(leaves[0].cuts, [{ writer: writers[i], seq: 1 }])
    t.alike((await diaryJoins(b, g)).map((j) => j.on), [true, false])
  }
})

test('the creator demotes an admin who left; the ban then counts and the rejoin is refused', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  const cw = await ownWriter(b, community)
  await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true })
  await share(a, b, [community])
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  await share(b, a, [cw])
  t.is((await ops.communityMembers(a.ctx, { community })).members.some((m) => m.member === b.key), false, 'the admin left')
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: false }), { community, member: b.key, on: false }, 'a demotion of a departed admin is written')
  t.alike((await lastRecord(a, community)).cuts, [{ writer: cw, seq: await coreLength(a, cw) }], 'cut over its counted CW at the contiguous length')
  await t.exception(() => ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true }), /a pessoa precisa ser membro da comunidade/, 'a grant still needs a member')
  t.alike(await ops.communityBan(a.ctx, { community, member: b.key, on: true }), { ok: true })
  t.is((await ops.communityMembers(a.ctx, { community })).members.find((m) => m.member === b.key).banned, true, 'the ban counts')
  await share(a, b, [community])
  await t.exception(() => ops.communityJoin(b.ctx, { community }), new RegExp(FORBIDDEN), 'its rejoin is refused')
  await t.exception(() => ops.communitySetAdmin(a.ctx, { community, member: 'cd'.repeat(32), on: false }), /nada a alterar/, 'a diary never granted cannot be demoted')
})

test('a rejoin names this device own leave, never a stolen sibling leave seen after it', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const cw1 = await ownWriter(b, community)
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  const own = (await records(b, cw1)).length - 1
  const L = { writer: cw1, seq: own }
  t.is((await records(b, cw1))[own].type, 'group-leave')
  // A stolen device of the same diary appends a leave seen after it, dated
  // early: it becomes the diary's causally latest leave.
  const thief = await rawDevice(b, community, [
    grp.writerHeader({ group: community, diary: b.key, member: null }),
    grp.groupLeave({ seen: L, cuts: [], at: new Date(Date.now() - 3600000).toISOString() })
  ], true)
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const cw2 = await ownWriter(b, community)
  t.not(cw2, cw1)
  t.not(cw2, thief)
  t.alike((await records(b, cw2))[0].rejoin, L, 'it names its own device leave')
})

// A CW this device wrote and listed but no diary join binds yet, while C's
// root is not held here (the next join takes the pending path).
async function unboundCw (s, community, header) {
  const nonce = crypto.randomBytes(32)
  const kp = await s.ctx.groupKeyPair(new Uint8Array(nonce))
  const core = await store.openGroupWriter(s.storage, kp)
  try { await store.appendGroupRecord(core, header, { root: false, community: true }) } finally { await core.close() }
  const cw = hex(kp.publicKey)
  // The previous own CW stays held, as communityJoin keeps it.
  await store.addGroupReplica(s.storage, await ownWriter(s, community))
  await store.putGroupWriter(s.storage, { group: community, key: cw, nonce: hex(nonce), rootNonce: null, kind: 'community' })
  await store.purgeGroupCore(s.storage, community)
  return cw
}

test('a rejoin CW interrupted before its diary join, completed while C root is not held, signs the header rejoin and keeps its generation', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  const cw1 = await ownWriter(b, community)
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  const L = { writer: cw1, seq: (await records(b, cw1)).length - 1 }
  await share(b, a, [cw1])
  const cw2 = await unboundCw(b, community, grp.writerHeader({ group: community, diary: b.key, member: null, rejoin: L }))
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'pending', group: null })
  t.alike((await diaryJoins(b, community)).filter((j) => j.writer === cw2).map((j) => [j.on, j.rejoin]), [[true, L]], 'the on-join signs the header rejoin')
  await share(a, b, [community], { diary: false })
  await share(b, a, [cw2])
  t.is((await ops.communityInfo(a.ctx, { community })).members, 2, 'the fold counts the CW as the new generation')
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  t.is((await lastRecord(b, cw2)).type, 'group-leave', 'the leave goes through that CW')
  await share(b, a, [cw2])
  t.is((await ops.communityInfo(a.ctx, { community })).members, 1, 'the later leave counts')
})

test('the pending-path refusal of community.leave keeps its own text, not the C root wait', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  // The entry moved to a CW this diary never bound while another CW of it
  // is on: only the sync can tell which one leaves.
  await unboundCw(b, community, grp.writerHeader({ group: community, diary: b.key, member: null }))
  await t.exception(() => ops.communityLeave(b.ctx, { community }), /aguarde a sincronização da comunidade para sair$/)
})

test('a rejoin from a device whose CW holds no leave writes one first and names it', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const cw1 = await ownWriter(b, community)
  // Another device of the same diary leaves the community, listing this CW.
  const sibling = await rawDevice(b, community, [
    grp.writerHeader({ group: community, diary: b.key, member: null }),
    grp.groupLeave({ cuts: [{ writer: cw1, seq: 1 }] })
  ], true)
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const mine = await records(b, cw1)
  const seq = mine.length - 1
  t.is(mine[seq].type, 'group-leave', 'a leave on this device CW first')
  const want = [{ writer: cw1, seq }, { writer: sibling, seq: 2 }].sort((x, y) => x.writer.localeCompare(y.writer))
  t.alike(mine[seq].cuts, want, 'it lists every counted own CW it holds, the sibling too')
  const cw2 = await ownWriter(b, community)
  t.not(cw2, cw1)
  t.alike((await records(b, cw2))[0].rejoin, { writer: cw1, seq }, 'it names that leave')
  t.alike((await diaryJoins(b, community)).filter((j) => j.writer === cw1).map((j) => j.on), [true, false], 'the diary confirms that leave')
})

test('after an unban that missed this device CW, community.leave from it still leaves', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  t.alike(await ops.communityBan(a.ctx, { community, member: b.key, on: true }), { ok: true })
  const ban = { writer: community, seq: (await records(a, community)).length - 1 }
  // An unban that lists none of b's CWs: the diary is a member again, its CW
  // stays banned in C's layer.
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === community)
  const root = await store.openGroupWriter(a.storage, await a.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.rootNonce, 'hex'))))
  try {
    await store.appendGroupRecord(root, grp.communityBan({ member: b.key, on: false, lifts: ban, cuts: [] }), { root: true, community: true })
  } finally {
    await root.close()
  }
  await share(a, b, [community])
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  const cw = await ownWriter(b, community)
  t.is((await lastRecord(b, cw)).type, 'group-leave', 'the leave goes through that CW')
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' }, 'the fold reads the diary as left')
})

test('a new device with no CW in the community names the confirmed leave, not a later forged one', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const cw1 = await ownWriter(b, community)
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  const L = { writer: cw1, seq: (await records(b, cw1)).length - 1 }
  // A stolen device appends a leave seen after the confirmed one.
  await rawDevice(b, community, [
    grp.writerHeader({ group: community, diary: b.key, member: null }),
    grp.groupLeave({ seen: L, cuts: [], at: new Date(Date.now() - 3600000).toISOString() })
  ], true)
  // This node forgets its CW and holds it as any other replica: it joins as
  // a new device would.
  await store.removeGroupWriter(b.storage, community)
  await store.addGroupReplica(b.storage, cw1)
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const cw2 = await ownWriter(b, community)
  t.not(cw2, cw1)
  t.alike((await records(b, cw2))[0].rejoin, L, 'it names the leave its diary confirmed')
})

test('the creator community.leave marks each held group root at its length; a member writes no mark', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const cutsOf = async (s) => (await ops.logRead(s.ctx)).entries.map((e) => e.record).filter((r) => r.type === 'group-cut')
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  t.alike(await cutsOf(b), [], 'a member writes none')
  const before = (await records(a, general)).length
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  const marks = await cutsOf(a)
  t.is(marks.length, 1, 'one mark per held group root')
  t.is(marks[0].group, general)
  t.is(marks[0].writer, general, 'on the root itself')
  t.ok(marks[0].cut >= before, 'the root length this node held when it left')
  t.is(marks[0].cut, (await records(a, general)).length)
})

test('a creator back in the community demotes through its CW, names no one and writes nothing on a marked root', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  t.alike(await ops.groupAdmin(a.ctx, { group: general, member: b.key, on: true }), { ok: true })
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  const log = (await ops.logRead(a.ctx)).entries.map((e) => e.record)
  const cut = log.findIndex((r) => r.type === 'group-cut')
  const conf = log.findIndex((r) => r.type === 'group-confirm' && r.group === community)
  const off = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.on === false)
  t.ok(cut >= 0 && conf > cut && off > conf, 'marks before the group-confirm, then the off join')
  t.alike(await ops.communityJoin(a.ctx, { community }), { state: 'member', group: general })
  const cw = await ownWriter(a, community)
  t.not(cw, community, 'back on a new CW')
  await t.exception(() => ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true }), new RegExp(FORBIDDEN), 'naming stays refused')
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: false }), { community, member: b.key, on: false })
  const last = await lastRecord(a, cw)
  t.alike([last.type, last.group, last.member, last.on], ['group-admin', null, b.key, false], 'written on the creator CW')
  t.is((await ops.communityMembers(a.ctx, { community })).members.find((m) => m.member === b.key).admin, false, 'the fold demotes')
  await t.exception(() => ops.groupAdmin(a.ctx, { group: general, member: b.key, on: true }), /sem permissão no grupo/)
  t.alike(await ops.groupAdmin(a.ctx, { group: general, member: b.key, on: false }), { ok: true })
  const glast = await lastRecord(a, cw)
  t.alike([glast.type, glast.group, glast.member, glast.on], ['group-admin', general, b.key, false])
  t.is((await ops.groupMembers(a.ctx, { group: general })).members.find((m) => m.member === b.key).admin, false, 'the G fold demotes')
  await t.exception(() => ops.groupMeta(a.ctx, { group: general, name: 'Outro' }), /sem permissão no grupo/)
})

test('a failing mark leaves the creator leave unconfirmed; a second community.leave writes it, then the off join', async (t) => {
  const { a, community, general } = await world(t, 1)
  a.ctx.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => ops.communityLeave(a.ctx, { community }), /falha simulada/)
  let log = (await ops.logRead(a.ctx)).entries.map((e) => e.record)
  t.absent(log.some((r) => r.type === 'group-cut'), 'no mark')
  t.absent(log.some((r) => r.type === 'group-confirm'), 'no group-confirm')
  t.absent(log.some((r) => r.type === 'group-join' && r.group === community && r.on === false), 'and no off join')
  delete a.ctx.onMark
  t.is((await store.readLeaveNotes(a.storage)).length, 1, 'the note of the own leave stays')
  t.is((await ops.communityInfo(a.ctx, { community })).leavePending, true, 'info offers to finish the leave')
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  log = (await ops.logRead(a.ctx)).entries.map((e) => e.record)
  const cut = log.findIndex((r) => r.type === 'group-cut' && r.group === general)
  const conf = log.findIndex((r) => r.type === 'group-confirm' && r.group === community)
  const off = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.on === false)
  t.ok(cut >= 0 && conf > cut && off > conf, 'the missing mark, the group-confirm, then the off join')
  t.alike(await store.readLeaveNotes(a.storage), [], 'the note is cleared')
  t.is((await ops.communityInfo(a.ctx, { community })).leavePending, false)
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' }, 'nothing left to write')
  t.is((await ops.logRead(a.ctx)).entries.length, log.length)
})

test('the creator normal leave clears its note', async (t) => {
  const { a, community } = await world(t, 1)
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  t.alike(await store.readLeaveNotes(a.storage), [])
})

test('a leave on the creator own CW with no note of this device is never confirmed by community.leave', async (t) => {
  const { a, community } = await world(t, 1)
  // As a holder of a copy of the CW key would get it in by replication.
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === community)
  const root = await store.openGroupWriter(a.storage, await a.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.rootNonce, 'hex'))))
  try {
    await store.appendGroupRecord(root, grp.groupLeave({ cuts: [{ writer: community, seq: 0 }] }), { root: true, community: true })
  } finally {
    await root.close()
  }
  const before = (await ops.logRead(a.ctx)).entries.length
  t.is((await ops.communityInfo(a.ctx, { community })).leavePending, false)
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  const log = (await ops.logRead(a.ctx)).entries.map((e) => e.record)
  t.is(log.length, before, 'no mark and no off join')
  t.absent(log.some((r) => r.type === 'group-confirm' || (r.type === 'group-join' && r.group === community && r.on === false)))
})

test('a note whose digest does not match the leave at its seq is ignored', async (t) => {
  const { a, community } = await world(t, 1)
  a.ctx.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => ops.communityLeave(a.ctx, { community }), /falha simulada/)
  delete a.ctx.onMark
  const notes = await store.readLeaveNotes(a.storage)
  t.is(notes.length, 1)
  t.is(notes[0].community, community)
  await store.writeLeaveNotes(a.storage, [{ ...notes[0], digest: 'ab'.repeat(32) }])
  const before = (await ops.logRead(a.ctx)).entries.length
  t.is((await ops.communityInfo(a.ctx, { community })).leavePending, false)
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  t.is((await ops.logRead(a.ctx)).entries.length, before, 'nothing written')
})

test('after a return whose root G leave never got written, group.join writes a new G writer', async (t) => {
  const { a, community, general } = await world(t, 1)
  // The creator's leave as if its G leave on Geral's root had failed: the C
  // leave on the root, the mark and the off join, and no G leave.
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === community)
  const root = await store.openGroupWriter(a.storage, await a.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.rootNonce, 'hex'))))
  try {
    await store.appendGroupRecord(root, grp.groupLeave({ cuts: [{ writer: community, seq: root.length }] }), { root: true, community: true })
  } finally {
    await root.close()
  }
  const geralLen = (await records(a, general)).length
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupCutRecord({ group: general, writer: general, cut: geralLen }))
    await store.appendRecord(diary, groupJoinRecord({ group: community, writer: community, on: false }))
  } finally {
    await diary.close()
  }
  t.alike(await ops.communityJoin(a.ctx, { community }), { state: 'member', group: general })
  const w = await ownWriter(a, general)
  t.not(w, general, 'a new G writer, never the marked root')
  t.ok((await ops.groupPost(a.ctx, { group: general, text: 'de volta' })).seq >= 1)
  const post = (await ops.groupRead(a.ctx, { group: general })).items.find((p) => p.text === 'de volta')
  t.ok(post && !post.hidden, 'its post counts')
})

// Appends `record` on the own core of `s` in `group` (the CW, or the root
// for its creator), as a holder of a copy of its key would.
async function keyCopyAppend (s, group, record, nonceField = 'nonce') {
  const entry = (await store.readGroupWriters(s.storage)).find((e) => e.group === group)
  const core = await store.openGroupWriter(s.storage, await s.ctx.groupKeyPair(new Uint8Array(b4a.from(entry[nonceField], 'hex'))))
  try {
    await store.appendGroupRecord(core, typeof record === 'function' ? record(core.length) : record, { root: hex(core.key) === group, community: true })
  } finally {
    await core.close()
  }
}

// C's fold over the root and the CWs `writerKeys` that `s` holds, with the
// diaries `diaries` (`s`'s own read from its log).
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

async function leavesOn (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try { return (await store.readAll(core)).filter((e) => e.seq >= 1 && e.record.type === 'group-leave') } finally { await core.close() }
}

const confirmsOf = async (s) => (await ops.logRead(s.ctx)).entries.map((e) => e.record).filter((r) => r.type === 'group-confirm')

test('a member leave writes the group-confirm of exactly its leave, and the fold confirms it', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  const cw = await ownWriter(b, community)
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  const [leave] = await leavesOn(b, cw)
  const log = (await ops.logRead(b.ctx)).entries.map((e) => e.record)
  const confirms = log.filter((r) => r.type === 'group-confirm')
  t.is(confirms.length, 1)
  t.alike([confirms[0].group, confirms[0].writer, confirms[0].seq, confirms[0].digest], [community, cw, leave.seq, grp.leaveDigest(leave.record)])
  const conf = log.findIndex((r) => r.type === 'group-confirm')
  const off = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.on === false)
  t.ok(conf >= 0 && off > conf, 'the group-confirm, then the off join')
  t.alike((await foldC(b, community, [cw], [a.key, b.key])).confirmedLeaveOf.get(b.key), { writer: cw, seq: leave.seq }, 'the fold confirms it')
})

test('a leave a key copy appended on the own CW is never confirmed: only the own leave seq is', async (t) => {
  const { a, members: [b, c], community } = await world(t, 2)
  await enter(b, community, a)
  await enter(c, community, a)
  // Before: a leave already on the CW. community.leave writes nothing.
  const cwc = await ownWriter(c, community)
  await keyCopyAppend(c, community, grp.groupLeave({ cuts: [{ writer: cwc, seq: 1 }] }))
  t.alike(await ops.communityLeave(c.ctx, { community }), { state: 'left' })
  t.alike(await confirmsOf(c), [], 'nothing confirmed')
  // After: the own leave, then the copy's at the next seq.
  const cw = await ownWriter(b, community)
  t.alike(await ops.communityLeave(b.ctx, { community }), { state: 'left' })
  await keyCopyAppend(b, community, grp.groupLeave({ cuts: [{ writer: cw, seq: 1 }] }))
  const leaves = await leavesOn(b, cw)
  t.is(leaves.length, 2)
  t.alike((await confirmsOf(b)).map((r) => r.seq), [leaves[0].seq], 'only the own leave seq')
  t.alike((await foldC(b, community, [cw], [a.key, b.key])).confirmedLeaveOf.get(b.key), { writer: cw, seq: leaves[0].seq })
})

test('after a key-copy leave on the root, community.admin off demotes through the CW', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  await keyCopyAppend(a, community, (len) => grp.groupLeave({ cuts: [{ writer: community, seq: len }] }), 'rootNonce')
  t.alike(await confirmsOf(a), [])
  t.is((await ops.communityJoin(a.ctx, { community })).state, 'member')
  const cw = await ownWriter(a, community)
  t.not(cw, community)
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: false }), { community, member: b.key, on: false })
  const last = await lastRecord(a, cw)
  t.alike([last.type, last.group, last.member, last.on], ['group-admin', null, b.key, false], 'the CW demotion')
  t.is((await ops.communityMembers(a.ctx, { community })).members.find((m) => m.member === b.key).admin, false, 'the fold demotes')
})

test('an unconfirmed leave on a secondary CW of the creator never ends the root: back in C, the creating device still manages admins and the community', async (t) => {
  const { a, members: [b, c], community } = await world(t, 2)
  await enter(b, community, a)
  await enter(c, community, a)
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  const rootLen = await coreLength(a, community)
  // A holder of a copy of another device's CW key leaves listing the root,
  // and the creator's diary never confirms it: the root is retired by
  // generation, yet the fold keeps its authority.
  const kp = await a.ctx.groupKeyPair(new Uint8Array(crypto.randomBytes(32)))
  const other = hex(kp.publicKey)
  const core = await store.openGroupWriter(a.storage, kp)
  try {
    await store.appendGroupRecord(core, grp.writerHeader({ group: community, diary: a.key, member: null }), { root: false, community: true })
    await store.appendGroupRecord(core, grp.groupLeave({ cuts: [{ writer: community, seq: rootLen }, { writer: other, seq: 1 }].sort((x, y) => x.writer.localeCompare(y.writer)) }), { root: false, community: true })
  } finally { await core.close() }
  await store.addGroupReplica(a.storage, other)
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  try { await store.appendRecord(diary, groupJoinRecord({ group: community, writer: other, on: true })) } finally { await diary.close() }
  t.is((await ops.communityJoin(a.ctx, { community })).state, 'member')
  const cw = await ownWriter(a, community)
  t.not(cw, community)
  const fold = await foldC(a, community, [await ownWriter(b, community), await ownWriter(c, community), other, cw], [a.key, b.key, c.key])
  t.absent(fold.authorityWriters.has(community), 'the root is out of authorityWriters')
  t.is(fold.rootAuthority, true, 'yet a root record would carry authority')
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: b.key, on: false }), { community, member: b.key, on: false })
  t.alike(await ops.communitySetAdmin(a.ctx, { community, member: c.key, on: true }), { community, member: c.key, on: true })
  t.alike(await ops.communityMeta(a.ctx, { community, name: 'Vila' }), { ok: true })
  const tail = (await records(a, community)).slice(-3)
  t.alike(tail.map((r) => [r.type, r.member, r.on]), [['group-admin', b.key, false], ['group-admin', c.key, true], ['group-meta', undefined, undefined]], 'written on the root')
  const admins = (await ops.communityMembers(a.ctx, { community })).members.filter((m) => m.admin).map((m) => m.member)
  t.ok(admins.includes(c.key) && !admins.includes(b.key), 'the fold counts both grants')
  t.is((await ops.communityInfo(a.ctx, { community })).name, 'Vila', 'and the meta')
})

test('the creator note is written before its leave is appended; a failure right after it leaves a second leave to finish', async (t) => {
  const { a, community } = await world(t, 1)
  const len = await coreLength(a, community)
  let seen = null
  a.ctx.onLeaveNote = async () => {
    seen = (await store.readLeaveNotes(a.storage))[0]
    throw new Error('falha simulada')
  }
  await t.exception(() => ops.communityLeave(a.ctx, { community }), /falha simulada/)
  delete a.ctx.onLeaveNote
  t.ok(seen !== undefined && seen !== null, 'the note exists before the append')
  t.alike([seen.writer, seen.seq], [community, len])
  t.is((await leavesOn(a, community)).length, 0, 'no leave yet')
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  const leaves = await leavesOn(a, community)
  t.is(leaves.length, 1)
  t.alike((await confirmsOf(a)).map((r) => [r.seq, r.digest]), [[leaves[0].seq, grp.leaveDigest(leaves[0].record)]])
  t.alike(await store.readLeaveNotes(a.storage), [])
})

test('the retry marks each root at the cut its note recorded, even after the root grew', async (t) => {
  const { a, community, general } = await world(t, 1)
  a.ctx.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => ops.communityLeave(a.ctx, { community }), /falha simulada/)
  delete a.ctx.onMark
  const [note] = await store.readLeaveNotes(a.storage)
  t.alike(note.roots.map((r) => r.group), [general])
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === general)
  const root = await store.openGroupWriter(a.storage, await a.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.rootNonce, 'hex'))))
  try {
    await store.appendGroupRecord(root, grp.groupLeave({ cuts: [{ writer: general, seq: root.length }] }), { root: true })
  } finally { await root.close() }
  t.ok(await coreLength(a, general) > note.roots[0].cut, 'the root grew past the noted cut')
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  const marks = (await ops.logRead(a.ctx)).entries.map((e) => e.record).filter((r) => r.type === 'group-cut')
  t.alike(marks.map((m) => [m.group, m.cut]), [[general, note.roots[0].cut]], 'the noted cut')
})

test('community.join first finishes the creator own leave a failed mark interrupted, then joins', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  a.ctx.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => ops.communityLeave(a.ctx, { community }), /falha simulada/)
  delete a.ctx.onMark
  const [leave] = await leavesOn(a, community)
  const before = (await ops.logRead(a.ctx)).entries.length
  t.alike(await ops.communityJoin(a.ctx, { community }), { state: 'member', group: general })
  const log = (await ops.logRead(a.ctx)).entries.map((e) => e.record).slice(before)
  const cw = await ownWriter(a, community)
  t.not(cw, community, 'back on a new CW')
  const cut = log.findIndex((r) => r.type === 'group-cut' && r.group === general && r.writer === general)
  const conf = log.findIndex((r) => r.type === 'group-confirm' && r.group === community && r.writer === community && r.seq === leave.seq)
  const off = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.writer === community && r.on === false)
  const on = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.writer === cw && r.on === true)
  t.ok(cut >= 0 && conf > cut && off > conf && on > off, 'the missing mark, the group-confirm and the off join before the new CW join')
  t.alike(await store.readLeaveNotes(a.storage), [], 'the note is cleared')
  t.alike((await records(a, cw))[0].rejoin, { writer: community, seq: leave.seq }, 'the new CW names the own leave')
  const fold = await foldC(a, community, [await ownWriter(b, community), cw], [a.key, b.key])
  t.alike(fold.confirmedLeaveOf.get(a.key), { writer: community, seq: leave.seq }, 'the fold confirms the leave')
  t.is(fold.rootAuthority, false, 'the root lost its authority')
})

// Appends a `delete` record (a diary record) on the own core of `group`, as a
// holder of a copy of that device key could.
async function deleteOn (s, group, seq, nonceField = 'nonce') {
  const entry = (await store.readGroupWriters(s.storage)).find((e) => e.group === group)
  const core = await store.openGroupWriter(s.storage, await s.ctx.groupKeyPair(new Uint8Array(b4a.from(entry[nonceField], 'hex'))))
  try {
    await core.append(deleteRecord({ seq }))
  } finally {
    await core.close()
  }
}

const postTexts = async (s, group) => (await ops.groupRead(s.ctx, { group })).items.filter((p) => !p.hidden).map((p) => p.text)

test('a delete record on the community root never erases the creator confirmed leave', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  const [leave] = await leavesOn(a, community)
  await deleteOn(a, community, leave.seq, 'rootNonce')
  await share(a, b, [community])
  t.is((await ops.communityJoin(a.ctx, { community })).state, 'member', 'the creator is back')
  await t.exception(() => ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community }), new RegExp(FORBIDDEN), 'the root keeps no authority')
  // The powers ended: a meta goes through the CW, never the root (cycle 24).
  const rootLen = await coreLength(a, community)
  t.alike(await ops.communityMeta(a.ctx, { community, name: 'Outro' }), { ok: true })
  t.is(await coreLength(a, community), rootLen, 'nothing on the root')
  t.is((await ops.communityInfo(b.ctx, { community })).name, 'Bairro')
})

test('a delete record on a group writer never hides a post', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const { seq } = await ops.groupPost(b.ctx, { group: general, text: 'fica' })
  await deleteOn(b, general, seq)
  await share(b, a, [await ownWriter(b, general)])
  t.ok((await postTexts(b, general)).includes('fica'), 'the author node still shows it')
  t.ok((await postTexts(a, general)).includes('fica'), 'and so does another member')
})

test('the creator leave waits until every group root of the catalogue is held, then marks them all', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  await share(a, b, [community, horta])
  await store.purgeGroupCore(a.storage, horta)
  const log = (await ops.logRead(a.ctx)).entries.length
  const rootLen = await coreLength(a, community)
  const generalLen = await coreLength(a, general)
  await t.exception(() => ops.communityLeave(a.ctx, { community }), /aguarde a sincronização dos grupos da comunidade para sair/)
  t.is((await ops.logRead(a.ctx)).entries.length, log, 'nothing in the diary')
  t.is(await coreLength(a, community), rootLen, 'nothing on the root')
  t.is(await coreLength(a, general), generalLen, 'no group leave')
  t.alike(await store.readLeaveNotes(a.storage), [], 'no note')
  await share(b, a, [horta], { diary: false })
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  const marks = (await ops.logRead(a.ctx)).entries.map((e) => e.record).filter((r) => r.type === 'group-cut')
  t.alike(marks.map((m) => m.group).sort(), [general, horta].sort(), 'every group of the catalogue is marked')
})

const cutsOf = async (s) => (await ops.logRead(s.ctx)).entries.map((e) => e.record).filter((r) => r.type === 'group-cut')

test('a group-create a copy of the C root key wrote, naming a root nobody serves, never blocks the creator leave', async (t) => {
  const { a, community, general } = await world(t, 1)
  const fake = hex(crypto.keyPair().publicKey)
  await keyCopyAppend(a, community, grp.groupCreateRecord({ group: fake, seen: null }), 'rootNonce')
  t.ok((await ops.communityInfo(a.ctx, { community })).groups.some((g) => g.group === fake), 'the catalogue names it')
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  t.alike((await cutsOf(a)).map((m) => m.group), [general], 'only the root the own diary bound is marked')
  t.alike(await store.readLeaveNotes(a.storage), [], 'the leave finished')
})

test('a forked group root the own diary bound is skipped: no wait, no mark', async (t) => {
  const { a, community, general } = await world(t, 1)
  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === horta)
  const core = await store.openGroupWriter(a.storage, await a.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.rootNonce, 'hex'))))
  try {
    const last = core.length - 1
    const raw = await core.get(last, { raw: true })
    await core.truncate(last)
    await core.append(raw)
    t.is(core.fork, 1)
  } finally {
    await core.close()
  }
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  t.alike((await cutsOf(a)).map((m) => m.group), [general], 'the forked root is not marked')
})

test('a bound group root not held refuses the creator leave; with force it leaves, marking only the held roots', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  await ops.groupMeta(a.ctx, { group: horta, name: 'Hortinha' })
  await share(a, b, [community, horta])
  t.is((await ops.groupInfo(b.ctx, { group: horta })).name, 'Hortinha', 'the root meta counts before the leave')
  await store.purgeGroupCore(a.storage, horta)
  const log = (await ops.logRead(a.ctx)).entries.length
  const WAIT = /aguarde a sincronização dos grupos da comunidade para sair/
  await t.exception(() => ops.communityLeave(a.ctx, { community }), WAIT)
  await t.exception(() => ops.communityLeave(a.ctx, { community, force: false }), WAIT)
  t.is((await ops.logRead(a.ctx)).entries.length, log, 'nothing written without force')
  t.alike(await store.readLeaveNotes(a.storage), [], 'no note')
  t.alike(await ops.communityLeave(a.ctx, { community, force: true }), { state: 'left' })
  t.alike((await cutsOf(a)).map((m) => m.group), [general], 'only the held root is marked')
  t.ok((await ops.logRead(a.ctx)).entries.some((e) => e.record.type === 'group-confirm' && e.record.group === community), 'the leave is confirmed')
  await share(a, b, [community])
  t.is((await ops.groupInfo(b.ctx, { group: horta })).name, 'Horta', 'the unmarked root carries no authority after the confirmed leave')
})

test('without force the creator leave waits while its copy of the C root is behind its signed length, then leaves', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  await ops.communityMeta(a.ctx, { community, name: 'Vila' })
  await share(a, b, [community])
  const root = await store.openGroupCoreReadOnly(a.storage, community)
  try {
    await root.clear(root.length - 1, root.length)
    t.ok(root.contiguousLength < root.length, 'the root copy is behind its signed length')
  } finally {
    await root.close()
  }
  const log = (await ops.logRead(a.ctx)).entries.length
  const WAIT = /este aparelho ainda não baixou tudo da comunidade: aguarde para sair/
  await t.exception(() => ops.communityLeave(a.ctx, { community }), WAIT)
  t.is((await ops.logRead(a.ctx)).entries.length, log, 'nothing in the diary')
  t.alike(await store.readLeaveNotes(a.storage), [], 'no note')
  await share(b, a, [community], { diary: false })
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
})

test('force names the waits it skips: a root wait skips only with root, a groups wait only with groups', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  await ops.communityMeta(a.ctx, { community, name: 'Vila' })
  await share(a, b, [community, horta])
  await store.purgeGroupCore(a.storage, horta)
  const root = await store.openGroupCoreReadOnly(a.storage, community)
  try {
    await root.clear(root.length - 1, root.length)
  } finally {
    await root.close()
  }
  const log = (await ops.logRead(a.ctx)).entries.length
  await t.exception(() => ops.communityLeave(a.ctx, { community, force: ['groups', 'devices'] }), /este aparelho ainda não baixou tudo da comunidade: aguarde para sair/)
  await t.exception(() => ops.communityLeave(a.ctx, { community, force: ['root'] }), /aguarde a sincronização dos grupos da comunidade para sair/)
  await t.exception(() => ops.communityLeave(a.ctx, { community, force: ['root', 'devices'] }), /aguarde a sincronização dos grupos da comunidade para sair/)
  t.is((await ops.logRead(a.ctx)).entries.length, log, 'nothing written')
  t.alike(await ops.communityLeave(a.ctx, { community, force: ['root', 'groups'] }), { state: 'left' })
})

test('the creator leave waits while a sibling own CW is not held or behind; only force devices skips it', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  const sibling = await rawDevice(a, community, [grp.writerHeader({ group: community, diary: a.key, member: null })], true)
  const core = await store.openGroupCoreReadOnly(a.storage, sibling)
  try {
    await core.clear(0, 1)
    t.ok(core.contiguousLength < core.length, 'the sibling copy is behind its signed length')
  } finally {
    await core.close()
  }
  const DEVICES = /aguarde a sincronização dos seus aparelhos nesta comunidade para sair/
  const log = (await ops.logRead(a.ctx)).entries.length
  await t.exception(() => ops.communityLeave(a.ctx, { community }), DEVICES)
  await t.exception(() => ops.communityLeave(a.ctx, { community, force: ['groups'] }), DEVICES)
  await t.exception(() => ops.communityLeave(a.ctx, { community, force: ['root', 'groups'] }), DEVICES)
  t.is((await ops.logRead(a.ctx)).entries.length, log, 'nothing in the diary')
  t.alike(await store.readLeaveNotes(a.storage), [], 'no note')
  t.alike(await ops.communityLeave(a.ctx, { community, force: ['devices'] }), { state: 'left' })
})

test('a creator device returning after a forged root leave lists its CW in the extra leave, never C root', async (t) => {
  const { a, community } = await world(t, 1)
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === community)
  // A second CW of the creator's diary, the one this device returns from.
  const nonce = crypto.randomBytes(32)
  const kp = await a.ctx.groupKeyPair(new Uint8Array(nonce))
  const core = await store.openGroupWriter(a.storage, kp)
  try { await store.appendGroupRecord(core, grp.writerHeader({ group: community, diary: a.key, member: null }), { root: false, community: true }) } finally { await core.close() }
  const cw2 = hex(kp.publicKey)
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  try { await store.appendRecord(diary, groupJoinRecord({ group: community, writer: cw2, on: true })) } finally { await diary.close() }
  // A copy of the root key leaves C on the root: no group-confirm.
  const root = await store.openGroupWriter(a.storage, await a.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.rootNonce, 'hex'))))
  try {
    await store.appendGroupRecord(root, grp.groupLeave({ cuts: [{ writer: community, seq: root.length }] }), { root: true, community: true })
  } finally {
    await root.close()
  }
  await store.putGroupWriter(a.storage, { group: community, key: cw2, nonce: hex(nonce), rootNonce: entry.rootNonce, kind: 'community' })
  t.is((await ops.communityJoin(a.ctx, { community })).state, 'member')
  const mine = await records(a, cw2)
  const last = mine[mine.length - 1]
  t.is(last.type, 'group-leave', 'a leave on cw2 first')
  t.alike(last.cuts, [{ writer: cw2, seq: mine.length - 1 }], 'C root is never listed there')
})

test('a rejoin signs the header rejoin in the CW first on-join and the fold keeps its generation', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const cw1 = await ownWriter(b, community)
  await ops.communityLeave(b.ctx, { community })
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general })
  const cw2 = await ownWriter(b, community)
  t.not(cw2, cw1)
  const rejoin = (await records(b, cw2))[0].rejoin
  t.is(rejoin.writer, cw1, 'the header names the own leave')
  t.alike((await diaryJoins(b, community)).filter((j) => j.writer === cw2).map((j) => [j.on, j.rejoin]), [[true, rejoin]], 'the first on-join signs the same rejoin')
  t.is((await ops.communityInfo(b.ctx, { community })).role, 'member', 'the fold keeps the CW generation')
  t.ok((await ops.groupPost(b.ctx, { group: general, text: 'de volta' })).seq >= 1)
})

test('with force the creator leaves while its copy of the C root is behind, listing the root at its contiguous length', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  await ops.communityMeta(a.ctx, { community, name: 'Vila' })
  await share(a, b, [community])
  const root = await store.openGroupCoreReadOnly(a.storage, community)
  let contiguous = 0
  try {
    await root.clear(root.length - 1, root.length)
    contiguous = root.contiguousLength
    t.ok(contiguous < root.length, 'the root copy is behind its signed length')
  } finally {
    await root.close()
  }
  t.alike(await ops.communityLeave(a.ctx, { community, force: true }), { state: 'left' })
  const confirm = (await ops.logRead(a.ctx)).entries.map((e) => e.record).find((r) => r.type === 'group-confirm' && r.group === community)
  t.ok(confirm, 'the leave is confirmed')
  await share(b, a, [community], { diary: false })
  const leave = (await records(a, confirm.writer))[confirm.seq]
  t.is(leave.type, 'group-leave')
  t.alike(leave.cuts.find((x) => x.writer === community), { writer: community, seq: contiguous }, 'the held-back tail is not listed')
})

// The creator's leave stops after its note and append (a mark fails), and
// another device of the diary comes back: the diary is a member again.
async function leaveThenReturn (t) {
  const w = await world(t, 1)
  const { a, members: [b], community } = w
  await enter(b, community, a)
  a.ctx.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => ops.communityLeave(a.ctx, { community }), /falha simulada/)
  delete a.ctx.onMark
  const [leave] = await leavesOn(a, community)
  await rawDevice(a, community, [grp.writerHeader({ group: community, diary: a.key, member: null, rejoin: { writer: community, seq: leave.seq } })], true)
  t.is((await ops.communityInfo(a.ctx, { community })).leavePending, true, 'info offers to finish the leave')
  return { ...w, leave }
}

function finished (t, log, { community, general, leave }) {
  const cut = log.findIndex((r) => r.type === 'group-cut' && r.group === general && r.writer === general)
  const conf = log.findIndex((r) => r.type === 'group-confirm' && r.group === community && r.writer === community && r.seq === leave.seq)
  const off = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.writer === community && r.on === false)
  t.ok(cut >= 0 && conf > cut && off > conf, 'the mark, the group-confirm, then the off join')
}

test('community.leave finishes the noted creator leave after a return from another device', async (t) => {
  const w = await leaveThenReturn(t)
  const { a, community } = w
  const before = (await ops.logRead(a.ctx)).entries.length
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  finished(t, (await ops.logRead(a.ctx)).entries.map((e) => e.record).slice(before), w)
  t.alike(await store.readLeaveNotes(a.storage), [], 'the note is cleared')
})

test('community.join finishes the noted creator leave after a return from another device', async (t) => {
  const w = await leaveThenReturn(t)
  const { a, community } = w
  const before = (await ops.logRead(a.ctx)).entries.length
  await ops.communityJoin(a.ctx, { community })
  finished(t, (await ops.logRead(a.ctx)).entries.map((e) => e.record).slice(before), w)
  t.alike(await store.readLeaveNotes(a.storage), [], 'the note is cleared')
})

test('after a forced leave left a root unmarked, a later leave writes no mark for it and the root stays without authority', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  await share(a, b, [community, horta])
  await store.purgeGroupCore(a.storage, horta)
  t.alike(await ops.communityLeave(a.ctx, { community, force: true }), { state: 'left' })
  t.alike((await cutsOf(a)).map((m) => m.group), [general], 'the forced leave marks only the held root')
  t.is((await ops.communityJoin(a.ctx, { community })).state, 'member', 'the creator is back')
  await share(b, a, [horta], { diary: false })
  // A copy of the root key appends between the two leaves.
  await keyCopyAppend(a, horta, grp.groupMeta({ name: 'Roubado', join: 'open' }), 'rootNonce')
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  t.absent((await cutsOf(a)).some((m) => m.group === horta), 'no mark for the root the first leave left unmarked')
  await share(a, b, [community, horta])
  t.is((await ops.groupInfo(b.ctx, { group: horta })).name, 'Horta', 'the root still carries no authority')
})

test('a group-create a copy of the C root key wrote, naming a group of another community, is never marked', async (t) => {
  const { a, community, general } = await world(t, 1)
  const { community: other } = await ops.communityCreate(a.ctx, { name: 'Vila', join: 'open' })
  const { group: feira } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open', community: other })
  await keyCopyAppend(a, community, grp.groupCreateRecord({ group: feira, seen: null }), 'rootNonce')
  t.ok((await ops.communityInfo(a.ctx, { community })).groups.some((g) => g.group === feira), 'the catalogue names it')
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  t.alike((await cutsOf(a)).map((m) => m.group), [general], 'only the root of a group of this community is marked')
  await ops.groupMeta(a.ctx, { group: feira, name: 'Feirinha' })
  t.is((await ops.groupInfo(a.ctx, { group: feira })).name, 'Feirinha', 'the root keeps its powers in the other community')
})

test('a creator back after its confirmed leave renames C and changes its entry through the CW', async (t) => {
  const { a, members: [b], community } = await world(t, 1)
  await enter(b, community, a)
  t.is((await ops.communityInfo(a.ctx, { community })).repair, false, 'no repair while the root has authority')
  t.alike(await ops.communityMeta(a.ctx, { community, name: 'Antes' }), { ok: true })
  t.is((await lastRecord(a, community)).type, 'group-meta', 'written on the root')
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  t.is((await ops.communityJoin(a.ctx, { community })).state, 'member')
  const cw = await ownWriter(a, community)
  t.not(cw, community)
  t.is((await ops.communityInfo(a.ctx, { community })).repair, true)
  const rootLen = await coreLength(a, community)
  t.alike(await ops.communityMeta(a.ctx, { community, name: 'Vila', join: 'approval' }), { ok: true })
  const last = await lastRecord(a, cw)
  t.alike([last.type, last.group, last.name, last.join], ['group-meta', null, 'Vila', 'approval'], 'written on the CW')
  t.is(await coreLength(a, community), rootLen, 'nothing on the root')
  const info = await ops.communityInfo(a.ctx, { community })
  t.alike([info.name, info.join], ['Vila', 'approval'], 'the fold shows both')
})

test('a creator back after its confirmed leave takes a group off the catalogue; Geral, a live root and a member are refused', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  await t.exception(() => ops.communityRemoveGroup(a.ctx, { community, group: horta }), new RegExp(FORBIDDEN), 'refused while the root has authority')
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  t.is((await ops.communityJoin(a.ctx, { community })).state, 'member')
  const cw = await ownWriter(a, community)
  await t.exception(() => ops.communityRemoveGroup(a.ctx, { community, group: general }), /o grupo Geral só sai com a comunidade/)
  await share(a, b, [community, cw])
  await t.exception(() => ops.communityRemoveGroup(b.ctx, { community, group: horta }), new RegExp(FORBIDDEN), 'a member is refused')
  t.ok((await ops.communityInfo(a.ctx, { community })).groups.some((g) => g.group === horta))
  t.alike(await ops.communityRemoveGroup(a.ctx, { community, group: horta.toUpperCase() }), { ok: true })
  const last = await lastRecord(a, cw)
  t.alike([last.type, last.group], ['group-drop', horta], 'written on the CW')
  const info = await ops.communityInfo(a.ctx, { community })
  t.absent(info.groups.some((g) => g.group === horta), 'the fold drops it')
  t.ok(info.groups.some((g) => g.group === general), 'Geral stays')
  await t.exception(() => ops.communityRemoveGroup(a.ctx, { community, group: horta }), /nada a alterar/)
})

test('a creator back in C drops a group, sees it in dropped and puts it back with undo; undo of a group not dropped changes nothing', async (t) => {
  const { a, members: [b], community, general } = await world(t, 1)
  await enter(b, community, a)
  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  t.alike((await ops.communityInfo(a.ctx, { community })).dropped, [], 'nothing dropped yet')
  await t.exception(() => ops.communityRemoveGroup(a.ctx, { community, group: horta, undo: true }), new RegExp(FORBIDDEN), 'refused while the root has authority')
  t.alike(await ops.communityLeave(a.ctx, { community }), { state: 'left' })
  t.is((await ops.communityJoin(a.ctx, { community })).state, 'member')
  const cw = await ownWriter(a, community)
  await t.exception(() => ops.communityRemoveGroup(a.ctx, { community, group: horta, undo: true }), /nada a alterar/)
  await t.exception(() => ops.communityRemoveGroup(a.ctx, { community, group: general, undo: true }), /o grupo Geral só sai com a comunidade/)
  t.alike(await ops.communityRemoveGroup(a.ctx, { community, group: horta }), { ok: true })
  let info = await ops.communityInfo(a.ctx, { community })
  t.alike(info.dropped, [horta], 'community.info lists the dropped group')
  t.absent(info.groups.some((g) => g.group === horta))
  await share(a, b, [community, cw])
  await t.exception(() => ops.communityRemoveGroup(b.ctx, { community, group: horta, undo: true }), new RegExp(FORBIDDEN), 'a member is refused')
  t.alike(await ops.communityRemoveGroup(a.ctx, { community, group: horta, undo: true }), { ok: true })
  const last = await lastRecord(a, cw)
  t.alike([last.type, last.group, last.on], ['group-drop', horta, false], 'written on the CW')
  info = await ops.communityInfo(a.ctx, { community })
  t.alike(info.dropped, [], 'no longer dropped')
  t.ok(info.groups.some((g) => g.group === horta), 'back in the catalogue')
  await t.exception(() => ops.communityRemoveGroup(a.ctx, { community, group: horta, undo: true }), /nada a alterar/)
})

test('invitePolicy: the creator toggles C, an admin sets C and a group through its CW, a member is refused', async (t) => {
  const { a, members: [b, c], community } = await world(t, 2)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  for (const s of [b, c]) await enter(s, community, a)
  t.alike(await ops.communityInvitePolicy(a.ctx, { community, members: true }), { ok: true })
  const on = await lastRecord(a, community)
  t.alike([on.type, on.group, on.on], ['group-invites', null, true], 'on the root, group null')
  t.is((await ops.communityInfo(a.ctx, { community })).memberInvite, true)
  await t.exception(() => ops.communityInvitePolicy(a.ctx, { community, members: true }), /nada a alterar/)
  t.alike(await ops.communityInvitePolicy(a.ctx, { community, members: false }), { ok: true })
  t.is((await ops.communityInfo(a.ctx, { community })).memberInvite, false)

  await share(a, b, [community])
  const bcw = await ownWriter(b, community)
  const length = await coreLength(b, bcw)
  await t.exception(() => ops.communityInvitePolicy(b.ctx, { community, members: true }), new RegExp(FORBIDDEN))
  t.is(await coreLength(b, bcw), length, 'nothing appended')

  const ccw = await ownWriter(c, community)
  await ops.communitySetAdmin(a.ctx, { community, member: c.key, on: true })
  await share(a, c, [community, group])
  t.alike(await ops.groupInvitePolicy(c.ctx, { group, members: true }), { ok: true })
  const gFlag = await lastRecord(c, ccw)
  t.alike([gFlag.type, gFlag.group, gFlag.on], ['group-invites', group, true], 'in the CW naming the group')
  t.is((await ops.groupInfo(c.ctx, { group })).memberInvite, true)
  t.is((await ops.communityInfo(c.ctx, { community })).memberInvite, false, 'a group flag leaves C alone')
  await share(c, a, [ccw])
  t.is((await ops.groupInfo(a.ctx, { group })).memberInvite, true, 'the creator folds it')

  t.alike(await ops.communityInvitePolicy(c.ctx, { community, members: true }), { ok: true })
  const cFlag = await lastRecord(c, ccw)
  t.alike([cFlag.type, cFlag.group, cFlag.on], ['group-invites', null, true], 'an admin on its own CW')
  t.is((await ops.communityInfo(c.ctx, { community })).memberInvite, true)
})
