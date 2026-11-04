'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createModeratorCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { groupJoinRecord, groupConfirmRecord } = require('../lib/records')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, person, exchange, sync, coreEntries, entryOf, rejects, world, leavesOn, texts, otherDevice, rootAppend } = require('./helpers/community-member')

test('create writes the community and Geral, info reads them, the group list shows Geral only', async (t) => {
  const kp = crypto.keyPair()
  const bare = await person(t, kp, 'Ana', false)
  await t.exception(member.communityCreate(bare, { name: 'Bairro', join: 'open' }), new RegExp(member.GENESIS_REQUIRED))
  t.alike(store.readGroups(bare.dataDir), [], 'nothing recorded before the genesis')
  const a = await person(t, kp)
  const { community, group } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  t.ok(/^[0-9a-f]{64}$/.test(community) && /^[0-9a-f]{64}$/.test(group))
  t.absent(fs.existsSync(path.join(a.dataDir, 'community-create.json')), 'the resume record is gone')
  const root = await coreEntries(a, community)
  t.is(root.length, 2)
  t.is(root[0].record.kind, 'community')
  t.is(root[0].record.v, 2)
  t.is(root[0].record.diary, a.key)
  t.alike(root[1].record, groupLib.groupCreateRecord({ group, seen: null, at: root[1].record.at }), 'Geral is the first create of the root')
  const geral = await coreEntries(a, group)
  t.alike([geral[0].record.kind, geral[0].record.community, geral[0].record.member, geral[0].record.name, geral[0].record.join],
    ['group', community, community, 'Geral', 'open'])
  t.alike(store.readGroups(a.dataDir).map((g) => [g.group, g.writer, g.kind]), [[community, community, 'community'], [group, group, undefined]])
  t.alike(await member.communityInfo(a, { community }), {
    community,
    name: 'Bairro',
    join: 'open',
    creator: a.key,
    role: 'creator',
    state: 'ready',
    members: 1,
    admins: 1,
    groups: [{ group, name: 'Geral', visibility: 'public', join: 'open', role: 'creator', general: true, last: null, unread: 0 }],
    general: group,
    incomplete: false,
    leavePending: false,
    repair: false,
    dropped: [],
    memberInvite: false
  })
  t.alike(await member.groupList(a), { groups: [{ group, name: 'Geral', join: 'open', role: 'creator', members: 1, community }], total: 1 })
  const info = await member.groupInfo(a, { group })
  t.is(info.community, community)
  t.is(info.orphan, false)
  const unknown = 'ab'.repeat(32)
  t.alike(await member.communityInfo(a, { community: unknown }), {
    community: unknown, name: null, join: null, creator: null, role: 'pending', state: 'pending', members: 0, admins: 0, groups: [], general: null, incomplete: true, leavePending: false, repair: false, dropped: [], memberInvite: false
  })
  await rejects(t, member.communityInfo(a, { community: group }), 'comunidade não encontrada', 'NOT_FOUND')
  await rejects(t, member.communityInfo(a, { community: 'x' }), 'comunidade não encontrada', 'NOT_FOUND')
  // A community root is no group: leaving it keeps the created root's entry.
  await rejects(t, member.groupLeave(a, { group: community }), 'grupo não encontrado', 'NOT_FOUND')
  t.is(store.readGroups(a.dataDir).length, 2)
})

test('community list: created and joined, roles first, blocklisted left out', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  t.alike(await member.communityList(a), { communities: [] })
  const { community, group } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  t.alike(await member.communityList(a), { communities: [{ community, name: 'Bairro', join: 'open', state: 'ready', role: 'creator', general: group }] })
  const { community: vila, group: praca } = await member.communityCreate(b, { name: 'Vila', join: 'approval' })
  await exchange(b, a)
  const joined = await member.communityJoin(a, { community: vila })
  t.alike(joined, { state: 'requested', group: praca }, 'an approval community files a request and Geral gets a writer')
  const pending = 'cd'.repeat(32)
  t.alike(await member.communityJoin(a, { community: pending }), { state: 'pending', group: null })
  t.alike((await member.communityList(a)).communities, [
    { community, name: 'Bairro', join: 'open', state: 'ready', role: 'creator', general: group },
    { community: pending, name: null, join: null, state: 'pending', role: 'pending', general: null },
    { community: vila, name: 'Vila', join: 'approval', state: 'ready', role: 'requested', general: praca }
  ].sort((x, y) => x.role === 'creator' ? -1 : y.role === 'creator' ? 1 : x.name === null ? 1 : y.name === null ? -1 : 0))
  t.ok((await member.groupList(a)).groups.every((g) => g.group !== community && g.group !== vila), 'group.list never lists a community')

  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 1, blocked: [vila] }, mod, cert))
  t.alike((await member.communityList(a)).communities.map((c) => c.community), [community, pending], 'a blocklisted root is left out')
})

test('an open community: join writes a CW and Geral, is idempotent, and members list it', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community, group } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  await exchange(a, b)
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group })
  const cw = entryOf(b, community)
  t.is(cw.kind, 'community')
  t.not(cw.writer, community)
  const header = (await coreEntries(b, cw.writer))[0].record
  t.alike([header.type, header.group, header.diary, header.member, header.rejoin], ['group-writer', community, b.key, null, null])
  const gw = entryOf(b, group)
  t.is((await coreEntries(b, gw.writer))[0].record.member, cw.writer, 'the Geral writer names the CW')
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group }, 'a second join writes nothing new')
  t.is(store.readGroups(b.dataDir).length, 2)
  await exchange(b, a)
  const members = await member.communityMembers(a, { community })
  t.is(members.total, 2)
  t.alike(members.members.map((m) => [m.member, m.admin, m.banned]).sort(), [[a.key, true, false], [b.key, false, false]].sort())
  t.is((await member.groupInfo(a, { group })).members, 2, 'b is a member of Geral')
  await rejects(t, member.communityRequests(b, { community }), 'sem permissão na comunidade')
  t.alike(await member.communityRequests(a, { community }), { requests: [], total: 0 })
})

test('an approval community: request, admission with CW cuts, and Geral counts after it', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community, group } = await member.communityCreate(a, { name: 'Bairro', join: 'approval' })
  await exchange(a, b)
  t.alike(await member.communityJoin(b, { community }), { state: 'requested', group })
  await exchange(b, a)
  const requests = await member.communityRequests(a, { community })
  t.alike(requests.requests.map((r) => r.member), [b.key])
  t.is(requests.total, 1)
  t.not((await member.groupInfo(a, { group })).role, 'member')
  t.is((await member.groupInfo(a, { group })).members, 1, 'the Geral writer of a request does not count')
  await rejects(t, member.communityAdmit(b, { community, member: b.key, on: true }), 'sem permissão na comunidade')
  t.alike(await member.communityAdmit(a, { community, member: b.key, on: true }), { ok: true })
  const root = await coreEntries(a, community)
  const cwEntries = await coreEntries(a, entryOf(a, community).writer)
  t.alike(cwEntries, root, 'the creator writes through the root, its CW')
  const admit = root[root.length - 1].record
  t.is(admit.type, 'group-admit')
  t.is(admit.group, null)
  const cw = entryOf(b, community).writer
  t.alike(admit.cuts, [{ writer: cw, seq: 1 }])
  await exchange(a, b)
  t.is((await member.communityInfo(b, { community })).role, 'member')
  t.is((await member.groupInfo(b, { group })).state, 'member', 'Geral counts once the community admits')
  t.alike(await member.communityRequests(a, { community }), { requests: [], total: 0 })
})

test('a community admin bans in a group through its CW; a demoted admin no longer can', async (t) => {
  const { a, others: [b, c], community } = await world(t)
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await sync(a, b, c)
  await member.groupJoin(c, { group })
  const post = await member.groupPost(c, { group, text: 'oi' })
  await sync(a, b, c)
  await rejects(t, member.groupBan(b, { group, member: c.key, on: true }), 'sem permissão no grupo')
  t.alike(await member.communitySetAdmin(a, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  await sync(a, b, c)
  t.is((await member.communityInfo(b, { community })).role, 'admin')
  t.alike(await member.groupBan(b, { group, member: c.key, on: true }), { ok: true })
  const cw = entryOf(b, community).writer
  const last = (await coreEntries(b, cw)).pop().record
  t.alike([last.type, last.group, last.member, last.on], ['group-ban', group, c.key, true], 'written in the CW naming the group')
  await sync(a, b, c)
  t.is((await member.groupInfo(a, { group })).members, 1, 'c is banned in the group')
  t.is((await member.groupRead(a, { group })).items.find((i) => i.seq === post.seq).hidden, false, 'history before the ban cut stays')
  await rejects(t, member.groupPost(c, { group, text: 'banido' }), 'sem permissão no grupo')
  t.alike(await member.groupBan(b, { group, member: c.key, on: false }), { ok: true })
  await sync(a, b, c)
  t.ok((await member.groupPost(c, { group, text: 'de volta' })).seq > post.seq, 'the unban restores posting')
  await member.communitySetAdmin(a, { community, member: b.key, on: false })
  await sync(a, b, c)
  await rejects(t, member.groupBan(b, { group, member: c.key, on: true }), 'sem permissão no grupo')
})

test('a 33rd group is refused with nothing written', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  for (let i = 1; i < groupLib.MAX_GROUPS_PER_COMMUNITY; i++) await member.groupCreate(a, { name: 'G' + i, join: 'open', community })
  t.is((await member.communityInfo(a, { community })).groups.length, groupLib.MAX_GROUPS_PER_COMMUNITY)
  const before = store.readGroups(a.dataDir).length
  const rootLength = (await coreEntries(a, community)).length
  await rejects(t, member.groupCreate(a, { name: 'Mais um', join: 'open', community }), 'a comunidade chegou ao limite de grupos')
  t.is(store.readGroups(a.dataDir).length, before)
  t.is((await coreEntries(a, community)).length, rootLength)
})

test('a community admin hide through the CW stays after the admin is demoted', async (t) => {
  const { a, others: [b, c], community } = await world(t)
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await sync(a, b, c)
  await member.groupJoin(c, { group })
  const post = await member.groupPost(c, { group, text: 'spam' })
  const target = { writer: entryOf(c, group).writer, seq: post.seq }
  await member.communitySetAdmin(a, { community, member: b.key, on: true })
  await sync(a, b, c)
  await rejects(t, member.groupHide(c, { group, target: { writer: entryOf(a, group).writer, seq: 1 }, on: true }), 'sem permissão no grupo')
  t.alike(await member.groupHide(b, { group, target, on: true }), { ok: true })
  const last = (await coreEntries(b, entryOf(b, community).writer)).pop().record
  t.alike([last.type, last.group, last.target], ['group-hide', group, target])
  await sync(a, b, c)
  t.alike(texts(await member.groupRead(a, { group })), ['[hidden]'])
  await member.communitySetAdmin(a, { community, member: b.key, on: false })
  await sync(a, b, c)
  t.alike(texts(await member.groupRead(a, { group })), ['[hidden]'], 'a hide below the demotion cut stays')
})

test('community.admin cuts over the member CWs; the target must be a member', async (t) => {
  const { kp, a, others: [b], community } = await world(t, { names: ['Bia'] })
  const outsider = await person(t, kp, 'Davi')
  await rejects(t, member.communitySetAdmin(a, { community, member: outsider.key, on: true }), 'a pessoa precisa ser membro da comunidade')
  await rejects(t, member.communitySetAdmin(a, { community, member: a.key, on: true }), 'o criador da comunidade já administra')
  await rejects(t, member.communitySetAdmin(b, { community, member: b.key, on: true }), 'sem permissão na comunidade')
  await member.communitySetAdmin(a, { community, member: b.key, on: true })
  const grant = (await coreEntries(a, community)).pop().record
  const cw = entryOf(b, community).writer
  t.alike([grant.type, grant.member, grant.on], ['group-admin', b.key, true])
  t.alike(grant.cuts, [{ writer: cw, seq: 1 }], 'the grant lists the CW at its length')
  t.ok(grant.cuts.length <= groupLib.MAX_GROUP_CUTS)
  t.is((await member.communityInfo(a, { community })).admins, 2)
})

test('only the creator creates groups; a demotion lists the CWs at their length', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  await member.communitySetAdmin(a, { community, member: b.key, on: true })
  await exchange(a, b)
  await rejects(t, member.groupCreate(b, { name: 'Feira', join: 'open', community }), 'só quem criou a comunidade cria grupos')
  const { group } = await member.groupCreate(a, { name: 'Feira', join: 'open', community })
  t.ok((await member.communityInfo(a, { community })).groups.some((g) => g.group === group), 'the creator create is in the catalogue')
  await exchange(b, a)
  const cw = entryOf(b, community).writer
  const length = (await coreEntries(a, cw)).length
  await member.communitySetAdmin(a, { community, member: b.key, on: false })
  const demotion = (await coreEntries(a, community)).pop().record
  t.alike(demotion.cuts, [{ writer: cw, seq: length }])
  await exchange(a, b)
  await rejects(t, member.groupCreate(b, { name: 'Outra', join: 'open', community }), 'só quem criou a comunidade cria grupos')
  t.ok((await member.communityInfo(a, { community })).groups.some((g) => g.group === group), 'the group stays')
})

test('community info lists the catalogue, with null rows for roots not held', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community, group: geral } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'approval', community, visibility: 'public' })
  // Only the community cores reach b.
  const s = await store.openStore(b.dataDir)
  await s.close()
  await exchange(a, b)
  const s2 = await store.openStore(b.dataDir)
  await store.purgeReplica(s2, group)
  await s2.close()
  const info = await member.communityInfo(b, { community })
  t.is(info.role, 'left')
  t.alike(info.groups.map((g) => g.group), [geral, group].sort())
  t.alike(info.groups.find((g) => g.group === group), { group, name: null, visibility: null, join: null, role: null, general: false, last: null, unread: 0 })
  t.is(info.groups.find((g) => g.group === geral).general, true)
})

test('members and requests page like a group', async (t) => {
  const { a, others, community } = await world(t, { join: 'approval', names: ['Bia', 'Caio', 'Davi'] })
  const all = await member.communityRequests(a, { community })
  t.is(all.total, 3)
  t.is((await member.communityRequests(a, { community, offset: 1, limit: 1 })).requests.length, 1)
  for (const o of others) await member.communityAdmit(a, { community, member: o.key, on: true })
  t.is((await member.communityMembers(a, { community })).total, 4)
  t.is((await member.communityMembers(a, { community, offset: 3, limit: 5 })).members.length, 1)
  await rejects(t, member.communityMembers(a, { community: 'ee'.repeat(32) }), 'aguarde a sincronização da comunidade')
})

test('an admin is refused creating a group; the creator creates on the root device and the admin sees it', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  await member.communitySetAdmin(a, { community, member: b.key, on: true })
  await exchange(a, b)
  const before = store.readGroups(b.dataDir).length
  await rejects(t, member.groupCreate(b, { name: 'Feira', join: 'open', community }), 'só quem criou a comunidade cria grupos')
  t.is(store.readGroups(b.dataDir).length, before, 'no root written, no slot used')
  // The creator from a device without the community root's entry.
  const entries = store.readGroups(a.dataDir)
  store.writeGroups(a.dataDir, entries.filter((g) => g.group !== community))
  await rejects(t, member.groupCreate(a, { name: 'Feira', join: 'open', community }), 'crie pelo aparelho que criou a comunidade')
  store.writeGroups(a.dataDir, entries)
  const { group } = await member.groupCreate(a, { name: 'Feira', join: 'open', community })
  const header = (await coreEntries(a, group))[0].record
  t.alike([header.community, header.member], [community, community], 'the root is the creator CW')
  const create = (await coreEntries(a, community)).pop().record
  t.alike([create.type, create.group], ['group-create', group], 'the create goes to the community root')
  await exchange(a, b)
  const row = (await member.communityInfo(b, { community })).groups.find((g) => g.group === group)
  t.alike(row, { group, name: 'Feira', visibility: 'public', join: 'open', role: 'left', general: false, last: null, unread: 0 })
  t.is((await member.groupInfo(b, { group })).orphan, false)
})

test('group.create refuses members, outsiders, pending and unknown communities', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const outsider = await person(t, crypto.keyPair(), 'Davi')
  await rejects(t, member.groupCreate(b, { name: 'Feira', join: 'open', community }), 'só quem criou a comunidade cria grupos')
  await exchange(a, outsider)
  await rejects(t, member.groupCreate(outsider, { name: 'Feira', join: 'open', community }), 'só quem criou a comunidade cria grupos')
  await rejects(t, member.groupCreate(b, { name: 'Feira', join: 'open', community: 'ef'.repeat(32) }), 'aguarde a sincronização da comunidade')
  await rejects(t, member.groupCreate(b, { name: 'Feira', join: 'open', community: 'x' }), 'comunidade não encontrada', 'NOT_FOUND')
  const geral = (await member.communityInfo(a, { community })).general
  await rejects(t, member.groupCreate(a, { name: 'Feira', join: 'open', community: geral }), 'comunidade não encontrada', 'NOT_FOUND')
})

test('a creator back after a confirmed leave no longer creates groups, edits the community or names admins', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const rootLength = (await coreEntries(a, community)).length
  // A second device of the creator leaves C listing the root, and the diary
  // confirms that leave and turns that CW off.
  const cw2 = await otherDevice(a, community, 'a2'.repeat(16), groupLib.writerHeader({ group: community, diary: a.key }), [
    (key) => groupLib.groupLeave({ cuts: [{ writer: community, seq: rootLength }, { writer: key, seq: 1 }].sort((x, y) => x.writer.localeCompare(y.writer)) })
  ], true)
  const [leave] = await leavesOn(a, cw2)
  const s = await store.openStore(a.dataDir)
  try {
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupConfirmRecord({ group: community, writer: cw2, seq: leave.seq, digest: groupLib.leaveDigest(leave.record) }))
    await store.appendRecord(diary, groupJoinRecord({ group: community, writer: cw2, on: false }))
  } finally {
    await s.close()
  }
  t.is((await member.communityJoin(a, { community })).state, 'member', 'the creator is back')
  const before = (await coreEntries(a, community)).length
  const slots = store.readGroups(a.dataDir).length
  await rejects(t, member.groupCreate(a, { name: 'Feira', join: 'open', community }), 'sem permissão na comunidade')
  await rejects(t, member.communitySetAdmin(a, { community, member: b.key, on: true }), 'sem permissão na comunidade')
  t.is((await coreEntries(a, community)).length, before, 'nothing written on the root')
  t.is(store.readGroups(a.dataDir).length, slots, 'no group root written')
  t.is((await member.communityInfo(a, { community })).name, 'Bairro')
  // The powers ended: community.meta goes through the CW (cycle 24).
  t.alike(await member.communityMeta(a, { community, name: 'Outro' }), { ok: true })
  t.is((await coreEntries(a, community)).length, before, 'still nothing on the root')
  const last = (await coreEntries(a, entryOf(a, community).writer)).pop().record
  t.alike([last.type, last.group, last.name], ['group-meta', null, 'Outro'], 'the meta is on the CW')
})

test('group.join needs community membership and the right community', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community, group: geral } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { community: other } = await member.communityCreate(a, { name: 'Vila', join: 'open' })
  await exchange(a, b)
  await rejects(t, member.groupJoin(b, { group: geral }), 'entre na comunidade primeiro')
  t.absent(entryOf(b, geral), 'no writer before the community')
  await member.communityJoin(b, { community })
  await rejects(t, member.groupJoin(b, { group: geral, community: other }), 'o grupo não é dessa comunidade')
  t.alike(await member.groupJoin(b, { group: geral, community }), { state: 'member' })
})

test('a pending join names the community and writes the own CW in the header', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await exchange(a, b)
  await member.communityJoin(b, { community })
  const s = await store.openStore(b.dataDir)
  await store.purgeReplica(s, group)
  await s.close()
  await rejects(t, member.groupJoin(b, { group }), 'informe a comunidade do grupo')
  await rejects(t, member.groupJoin(b, { group, community: 'ab'.repeat(32) }), 'aguarde a sincronização da comunidade')
  t.alike(await member.groupJoin(b, { group, community }), { state: 'pending' })
  const header = (await coreEntries(b, entryOf(b, group).writer))[0].record
  t.alike([header.group, header.member], [group, entryOf(b, community).writer])
  t.alike(await member.groupInfo(b, { group }), {
    group, name: null, join: null, creator: null, role: 'pending', members: 0, state: 'pending', community: null, orphan: false, visibility: 'public', memberInvite: false
  })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member', 'the root arrives and the join counts')
})

test('community.leave makes the diary leave every group; earlier posts stay', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const before = await member.groupPost(b, { group: geral, text: 'antes' })
  t.ok(before.seq >= 1)
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  const cw = entryOf(b, community).writer
  const leave = (await coreEntries(b, cw)).pop().record
  t.alike([leave.type, leave.cuts], ['group-leave', [{ writer: cw, seq: 1 }]])
  t.alike(await member.communityLeave(b, { community }), { state: 'left' }, 'a repeated leave writes nothing')
  t.is((await member.groupInfo(b, { group: geral })).state, 'left', 'the gate ends the group membership')
  await rejects(t, member.groupPost(b, { group: geral, text: 'depois' }), 'sem permissão no grupo')
  await exchange(b, a)
  t.alike(texts(await member.groupRead(a, { group: geral })), ['antes'])
  t.is((await member.communityInfo(a, { community })).members, 1)
  await rejects(t, member.communityLeave(a, { community: 'ab'.repeat(32) }), 'nada a alterar')
  // Rejoining writes a new CW naming the leave, and a new Geral writer.
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  const next = entryOf(b, community).writer
  t.not(next, cw)
  t.alike((await coreEntries(b, next))[0].record.rejoin, { writer: cw, seq: 1 })
  t.is((await member.groupInfo(b, { group: geral })).state, 'member')
  const gw = entryOf(b, geral).writer
  t.is((await coreEntries(b, gw))[0].record.member, next, 'the Geral writer names the live CW, never the retired one')
  t.alike(await member.groupJoin(b, { group: geral }), { state: 'member' })
  t.is(entryOf(b, geral).writer, gw, 'no further writer')
  await member.groupPost(b, { group: geral, text: 'voltei' })
  await exchange(b, a)
  t.alike(texts(await member.groupRead(a, { group: geral })), ['voltei', 'antes'], 'the new post is visible')
})

test('a community ban hides the member posts in its groups and an unban restores them', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  await member.groupPost(b, { group: geral, text: 'oi' })
  await exchange(b, a)
  await rejects(t, member.communityBan(b, { community, member: a.key, on: true }), 'sem permissão na comunidade')
  await rejects(t, member.communityBan(a, { community, member: b.key, on: false }), 'nada a alterar')
  t.alike(await member.communityBan(a, { community, member: b.key, on: true }), { ok: true })
  t.alike(texts(await member.groupRead(a, { group: geral })), ['[hidden]'])
  t.is((await member.communityMembers(a, { community })).members.find((m) => m.member === b.key).banned, true)
  await exchange(a, b)
  await rejects(t, member.communityJoin(b, { community }), 'sem permissão na comunidade')
  await rejects(t, member.communityLeave(b, { community }), 'sem permissão na comunidade')
  t.alike(await member.communityBan(a, { community, member: b.key, on: false }), { ok: true })
  t.alike(texts(await member.groupRead(a, { group: geral })), ['oi'], 'the unban restores')
})

// Injected failures: the next appendRecord matching `when` throws once.
async function crashOnce (t, ctx, when, run) {
  const realAppend = store.appendRecord
  store.appendRecord = async function (core, record, limits) {
    if (when(record)) {
      store.appendRecord = realAppend
      throw new Error('falha de teste')
    }
    return realAppend(core, record, limits)
  }
  const memberPath = require.resolve('../lib/member')
  delete require.cache[memberPath]
  try {
    const fresh = require('../lib/member')
    await t.exception(() => run(fresh), /falha de teste/)
  } finally {
    store.appendRecord = realAppend
    delete require.cache[memberPath]
  }
}

test('community.create resumes after a crash past step 5 and past step 7 with the same keys; community.info never writes', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  await crashOnce(t, a, (r) => r && r.type === 'group-header' && r.kind === 'group', (m) => m.communityCreate(a, { name: 'Bairro', join: 'open' }))
  const rec = JSON.parse(fs.readFileSync(path.join(a.dataDir, 'community-create.json'), 'utf8'))
  t.alike(Object.keys(rec), ['v', 'community', 'communityNonce', 'group', 'groupNonce', 'name', 'join', 'at'])
  t.is(fs.statSync(path.join(a.dataDir, 'community-create.json')).mode & 0o777, 0o600)
  t.alike(store.readGroups(a.dataDir).map((g) => g.group), [rec.community], 'step 5 ran, Geral not yet')
  const done = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  t.alike(done, { community: rec.community, group: rec.group }, 'no new identities')
  t.absent(fs.existsSync(path.join(a.dataDir, 'community-create.json')))
  t.is((await member.communityInfo(a, { community: done.community })).general, done.group)

  const b = await person(t, kp, 'Bia')
  await crashOnce(t, b, (r) => r && r.type === 'group-create', (m) => m.communityCreate(b, { name: 'Vila', join: 'approval' }))
  const rec2 = JSON.parse(fs.readFileSync(path.join(b.dataDir, 'community-create.json'), 'utf8'))
  t.is(store.readGroups(b.dataDir).length, 2, 'step 7 ran')
  const before = { log: (await member.logRead(b)).entries.length, root: (await coreEntries(b, rec2.community)).length }
  const pendingInfo = await member.communityInfo(b, { community: rec2.community })
  t.is(pendingInfo.state, 'pending', 'a read reports the half-created community as pending')
  t.alike({ log: (await member.logRead(b)).entries.length, root: (await coreEntries(b, rec2.community)).length }, before, 'community.info writes nothing')
  t.ok(fs.existsSync(path.join(b.dataDir, 'community-create.json')), 'the resume record stays for community.create')
  t.alike(await member.communityCreate(b, { name: 'Vila', join: 'approval' }), { community: rec2.community, group: rec2.group }, 'community.create resumes with the same keys')
  const info = await member.communityInfo(b, { community: rec2.community })
  t.is(info.general, rec2.group)
  t.is(info.join, 'approval')
  t.absent(fs.existsSync(path.join(b.dataDir, 'community-create.json')))
  const { entries } = await member.logRead(b)
  t.is(entries.filter((e) => e.record && e.record.type === 'group-join').length, 2, 'each join once')
  // A record of a create that wrote nothing gives way to other params.
  const c = await person(t, kp, 'Caio')
  await crashOnce(t, c, (r) => r && r.type === 'group-header', (m) => m.communityCreate(c, { name: 'Praça', join: 'open' }))
  const rec3 = JSON.parse(fs.readFileSync(path.join(c.dataDir, 'community-create.json'), 'utf8'))
  const other = await member.communityCreate(c, { name: 'Outra', join: 'open' })
  t.not(other.community, rec3.community)
  t.is((await member.communityInfo(c, { community: other.community })).name, 'Outra')
})

test('the legacy sweep purges v1 group cores and drops their entries', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const { community, group } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const nonce = 'ab'.repeat(16)
  const s = await store.openStore(a.dataDir)
  let legacy
  try {
    const core = await store.openGroupWriter(s, nonce)
    legacy = hex(core.key)
    await core.append(b4a.from(JSON.stringify({ type: 'group-header', v: 1, kind: 'group', diary: a.key, visibility: 'public', join: 'open', name: 'Velho', box: null, at: '2026-01-01T00:00:00.000Z' })))
  } finally {
    await s.close()
  }
  store.writeGroups(a.dataDir, [...store.readGroups(a.dataDir), { group: legacy, writer: legacy, nonce }])
  const events = []
  const s2 = await store.openStore(a.dataDir)
  try {
    t.alike(await store.sweepLegacyGroups(a.dataDir, s2, (e) => events.push(e)), [legacy])
    t.alike(await store.sweepLegacyGroups(a.dataDir, s2, (e) => events.push(e)), [], 'a second sweep finds nothing')
  } finally {
    await s2.close()
  }
  t.alike(events, [{ event: 'group-skipped', key: legacy, reason: 'legacy' }])
  t.alike(store.readGroups(a.dataDir).map((g) => g.group), [community, group], 'v2 entries stay')
  t.is((await member.communityInfo(a, { community })).general, group)
})

test('a CW another device retired is replaced on join, naming the latest leave, and Geral follows', async (t) => {
  const { others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const cw1 = entryOf(b, community).writer
  const geral1 = entryOf(b, geral).writer
  // Another device of Bia leaves the community (its cuts list both CWs) and
  // a third rejoins: the diary is a member, this device's CW is retired.
  const cw2 = await otherDevice(b, community, 'c2'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key }), [
    (key) => groupLib.groupLeave({ cuts: [{ writer: cw1, seq: 1 }, { writer: key, seq: 1 }].sort((x, y) => x.writer.localeCompare(y.writer)) })
  ], true)
  await otherDevice(b, community, 'c3'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key, rejoin: { writer: cw2, seq: 1 } }), [], true)
  t.is((await member.communityInfo(b, { community })).role, 'member', 'the diary stays a member')
  await rejects(t, member.groupPost(b, { group: geral, text: 'velho' }), 'sem permissão no grupo')
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  const cw4 = entryOf(b, community).writer
  t.not(cw4, cw1, 'a new CW, never the retired one')
  t.alike((await coreEntries(b, cw4))[0].record.rejoin, { writer: cw2, seq: 1 }, 'it names the fold latest leave')
  const geral2 = entryOf(b, geral).writer
  t.not(geral2, geral1, 'the Geral writer bound to the retired CW is replaced')
  t.is((await coreEntries(b, geral2))[0].record.member, cw4)
  t.ok((await member.groupPost(b, { group: geral, text: 'novo' })).seq >= 1)
})

test('a Geral writer another device cut is replaced by the Geral step, naming the group latest leave', async (t) => {
  const { others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const cw = entryOf(b, community).writer
  const w1 = entryOf(b, geral).writer
  // Another device of Bia leaves Geral (cuts list both writers) and a third
  // rejoins it: Bia is a member of Geral, this device's writer is cut.
  const w2 = await otherDevice(b, geral, 'd2'.repeat(16), groupLib.writerHeader({ group: geral, diary: b.key, member: cw }), [
    (key) => groupLib.groupLeave({ cuts: [{ writer: w1, seq: 1 }, { writer: key, seq: 1 }].sort((x, y) => x.writer.localeCompare(y.writer)) })
  ])
  await otherDevice(b, geral, 'd3'.repeat(16), groupLib.writerHeader({ group: geral, diary: b.key, member: cw, rejoin: { writer: w2, seq: 1 } }))
  t.is((await member.groupInfo(b, { group: geral })).state, 'member')
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  const next = entryOf(b, geral).writer
  t.not(next, w1, 'a new Geral writer')
  t.alike((await coreEntries(b, next))[0].record.rejoin, { writer: w2, seq: 1 })
  t.ok((await member.groupPost(b, { group: geral, text: 'oi' })).seq >= 1)
})

test('a leave from another device whose cuts omit this CW still retires it: join writes a new CW and Geral writer', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const cw1 = entryOf(b, community).writer
  const geral1 = entryOf(b, geral).writer
  // The other device never downloaded this CW: its leave lists only itself.
  const cw2 = await otherDevice(b, community, 'e2'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key }), [
    (key) => groupLib.groupLeave({ cuts: [{ writer: key, seq: 1 }] })
  ], true)
  await otherDevice(b, community, 'e3'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key, rejoin: { writer: cw2, seq: 1 } }), [], true)
  t.is((await member.communityInfo(b, { community })).role, 'member')
  await rejects(t, member.groupPost(b, { group: geral, text: 'velho' }), 'sem permissão no grupo')
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  const cw4 = entryOf(b, community).writer
  t.not(cw4, cw1)
  t.alike((await coreEntries(b, cw4))[0].record.rejoin, { writer: cw2, seq: 1 }, 'names C lastLeave')
  const geral2 = entryOf(b, geral).writer
  t.not(geral2, geral1, 'a new Geral writer')
  await member.groupPost(b, { group: geral, text: 'visível' })
  await exchange(b, a)
  t.ok(texts(await member.groupRead(a, { group: geral })).includes('visível'), 'the post is visible')
})

test('authority comes from the writer: a grant listing only another device refuses this one', async (t) => {
  const { a, others: [b, c], community, geral } = await world(t)
  const cw1 = entryOf(b, community).writer
  const cw2 = await otherDevice(b, community, 'f2'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key }), [], true)
  await sync(a, b, c)
  // A community grant whose cuts list only the other device's CW.
  await rootAppend(a, community, groupLib.groupAdmin({ member: b.key, on: true, cuts: [{ writer: cw2, seq: 1 }] }), true)
  await sync(a, b, c)
  t.is((await member.communityInfo(b, { community })).role, 'admin', 'the diary is an admin')
  t.not(cw1, cw2)
  const entries = store.readGroups(b.dataDir).length
  await rejects(t, member.groupCreate(b, { name: 'Feira', join: 'open', community }), 'só quem criou a comunidade cria grupos')
  t.is(store.readGroups(b.dataDir).length, entries, 'no orphan root, no slot used')
  await rejects(t, member.communityBan(b, { community, member: c.key, on: true }), 'sem permissão na comunidade')
  await rejects(t, member.groupBan(b, { group: geral, member: c.key, on: true }), 'sem permissão no grupo')
  // A G grant whose cuts list only another device's writer in Geral.
  const other = await otherDevice(b, geral, 'f3'.repeat(16), groupLib.writerHeader({ group: geral, diary: b.key, member: cw2 }))
  await sync(a, b, c)
  await rootAppend(a, geral, groupLib.groupAdmin({ member: b.key, on: true, cuts: [{ writer: other, seq: 1 }] }), false)
  await sync(a, b, c)
  t.is((await member.groupInfo(b, { group: geral })).role, 'admin')
  await rejects(t, member.groupBan(b, { group: geral, member: c.key, on: true }), 'sem permissão no grupo')
})

test('the members invite flag: the creator on the root, an admin through its CW, a group flag through the CW', async (t) => {
  const { a, others: [b, c], community } = await world(t)
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  t.is((await member.communityInfo(a, { community })).memberInvite, false)
  t.alike(await member.communityInvitePolicy(a, { community, members: true }), { ok: true })
  t.is((await member.communityInfo(a, { community })).memberInvite, true)
  await rejects(t, member.communityInvitePolicy(a, { community, members: true }), 'nada a alterar')
  await sync(a, b, c)
  await rejects(t, member.communityInvitePolicy(c, { community, members: false }), 'sem permissão na comunidade')
  await rejects(t, member.groupInvitePolicy(c, { group, members: true }), 'sem permissão no grupo')
  await member.communitySetAdmin(a, { community, member: b.key, on: true })
  await sync(a, b, c)
  t.alike(await member.communityInvitePolicy(b, { community, members: false }), { ok: true })
  const cw = entryOf(b, community).writer
  const flag = (await coreEntries(b, cw)).pop().record
  t.alike([flag.type, flag.group, flag.on], ['group-invites', null, false], 'written in the CW for the community')
  t.is((await member.communityInfo(b, { community })).memberInvite, false)
  t.alike(await member.groupInvitePolicy(b, { group, members: true }), { ok: true })
  const gflag = (await coreEntries(b, cw)).pop().record
  t.alike([gflag.type, gflag.group, gflag.on], ['group-invites', group, true], 'written in the CW naming the group')
  t.is((await member.groupInfo(b, { group })).memberInvite, true)
  await sync(a, b, c)
  t.is((await member.groupInfo(a, { group })).memberInvite, true)
  t.is((await member.communityInfo(a, { community })).memberInvite, false, 'the community flag is unchanged')
})
