'use strict'

const test = require('brittle')
const crypto = require('hypercore-crypto')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, person, exchange, sync, coreEntries, entryOf, rejects, world, otherDevice, joinGroup } = require('./helpers/community-member')

test('a pending request in an approval community can be left at once', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'approval' })
  await exchange(a, b)
  t.alike((await member.communityJoin(b, { community })).state, 'requested')
  const cw = entryOf(b, community).writer
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  const leave = (await coreEntries(b, cw)).pop().record
  t.alike([leave.type, leave.cuts], ['group-leave', [{ writer: cw, seq: 1 }]])
  const { entries } = await member.logRead(b)
  const joins = groupLib.groupJoinHistory(entries, community)
  t.alike(joins.map((j) => [j.writer, j.on]), [[cw, true], [cw, false]], 'the diary join is off')
  t.is((await member.communityInfo(b, { community })).role, 'left')
  await exchange(b, a)
  t.alike(await member.communityRequests(a, { community }), { requests: [], total: 0 })
  await rejects(t, member.communityAdmit(a, { community, member: b.key, on: true }), 'nada a alterar')
})

test('community.leave ends the own writer in every group of the community; the leaver keeps no authority there', async (t) => {
  const { a, others: [b, c], community, geral } = await world(t)
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await sync(a, b, c)
  await joinGroup(b, group)
  await joinGroup(c, group)
  await sync(a, b, c)
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await sync(a, b, c)
  t.alike(await member.groupBan(b, { group, member: c.key, on: true }), { ok: true })
  await sync(a, b, c)
  t.is((await member.groupInfo(a, { group })).members, 2, 'c is banned')
  const writers = { [group]: entryOf(b, group).writer, [geral]: entryOf(b, geral).writer }
  const cw = entryOf(b, community).writer
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  for (const g of [group, geral]) {
    const leaves = (await coreEntries(b, writers[g])).filter((e) => e.record && e.record.type === 'group-leave')
    t.is(leaves.length, 1, 'one group-leave on the own writer')
    t.alike(leaves[0].record.cuts, [{ writer: writers[g], seq: leaves[0].seq }])
  }
  const cleave = (await coreEntries(b, cw)).pop().record
  t.alike(Object.keys(cleave), ['type', 'seen', 'cuts', 'at'], 'the community leave carries no ends')
  for (const g of [group, geral]) {
    const { entries } = await member.logRead(b)
    const joins = groupLib.groupJoinHistory(entries, g).filter((j) => j.writer === writers[g])
    t.is(joins[joins.length - 1].on, false, 'the diary join is off')
  }
  await sync(a, b, c)
  const row = (await member.groupMembers(a, { group })).members.find((m) => m.member === c.key)
  t.is(row && row.banned, false, 'the departed admin ban no longer counts')
  t.is((await member.groupInfo(c, { group })).state, 'member', 'c is back to its pre-ban state')
})

test('the creator demotes an admin who left, then a ban counts and the rejoin is refused', async (t) => {
  const { a, others: [b], community } = await world(t, { join: 'approval', names: ['Bia'] })
  await member.communityAdmit(a, { community, member: b.key, on: true })
  await exchange(a, b)
  await member.communitySetAdmin(a, { community, member: b.key, on: true })
  await exchange(a, b)
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  await exchange(b, a)
  t.is((await member.communityMembers(a, { community })).members.some((m) => m.member === b.key), false, 'b left')
  t.alike(await member.communitySetAdmin(a, { community, member: b.key, on: false }), { community, member: b.key, on: false }, 'a revocation needs no membership')
  const demotion = (await coreEntries(a, community)).pop().record
  t.alike([demotion.type, demotion.member, demotion.on], ['group-admin', b.key, false])
  t.alike(await member.communityBan(a, { community, member: b.key, on: true }), { ok: true })
  t.is((await member.communityMembers(a, { community })).members.find((m) => m.member === b.key).banned, true, 'the ban counts')
  await exchange(a, b)
  await rejects(t, member.communityJoin(b, { community }), 'sem permissão na comunidade')
  await rejects(t, member.communitySetAdmin(a, { community, member: 'ab'.repeat(32), on: false }), 'nada a alterar')
})

test('a rejoin names this device own leave, never a stolen sibling leave seen after it', async (t) => {
  const { others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const cw1 = entryOf(b, community).writer
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  const own = (await coreEntries(b, cw1)).filter((e) => e.record.type === 'group-leave').pop()
  const L = { writer: cw1, seq: own.seq }
  // A stolen device of Bia appends a leave seen after the owner's, dated
  // early: it becomes the diary's causally latest leave.
  const thief = await otherDevice(b, community, 'f1'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key }), [
    () => groupLib.groupLeave({ seen: L, cuts: [], at: new Date(Date.now() - 3600000).toISOString() })
  ], true)
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  const cw2 = entryOf(b, community).writer
  t.not(cw2, cw1)
  t.not(cw2, thief)
  t.alike((await coreEntries(b, cw2))[0].record.rejoin, L, 'it names its own device leave')
})

test('a rejoin from a device whose CW holds no leave writes one first and names it', async (t) => {
  const { others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const cw1 = entryOf(b, community).writer
  // Another device of Bia leaves the community, listing this CW.
  const sibling = await otherDevice(b, community, 'f2'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key }), [
    (key) => groupLib.groupLeave({ cuts: [{ writer: cw1, seq: 1 }, { writer: key, seq: 1 }].sort((x, y) => x.writer.localeCompare(y.writer)) })
  ], true)
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  const before = await coreEntries(b, cw1)
  const mine = before[before.length - 1]
  t.is(mine.record.type, 'group-leave', 'a leave on this device CW first')
  const want = [{ writer: cw1, seq: mine.seq }, { writer: sibling, seq: 2 }].sort((x, y) => x.writer.localeCompare(y.writer))
  t.alike(mine.record.cuts, want, 'it lists every counted own CW it holds, the sibling too')
  const cw2 = entryOf(b, community).writer
  t.not(cw2, cw1)
  t.alike((await coreEntries(b, cw2))[0].record.rejoin, { writer: cw1, seq: mine.seq }, 'it names that leave')
  const joins = groupLib.groupJoinHistory((await member.logRead(b)).entries, community).filter((j) => j.writer === cw1)
  t.alike(joins.map((j) => j.on), [true, false], 'the diary confirms that leave')
  t.ok((await member.groupPost(b, { group: geral, text: 'de volta' })).seq >= 1)
})

test('a rejoin signs the header rejoin in the CW first on-join and the fold keeps its generation', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const cw1 = entryOf(b, community).writer
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  const cw2 = entryOf(b, community).writer
  t.not(cw2, cw1)
  const rejoin = (await coreEntries(b, cw2))[0].record.rejoin
  t.is(rejoin.writer, cw1, 'the header names the own leave')
  const joins = groupLib.groupJoinHistory((await member.logRead(b)).entries, community).filter((j) => j.writer === cw2)
  t.alike(joins.map((j) => [j.on, j.rejoin]), [[true, rejoin]], 'the first on-join signs the same rejoin')
  t.is((await member.communityInfo(b, { community })).role, 'member')
  await sync(b, a)
  t.is((await member.communityInfo(a, { community })).members, 2, 'the fold counts the CW as the new generation')
  t.ok((await member.groupPost(b, { group: geral, text: 'de volta' })).seq >= 1)
})

test('a rejoin CW interrupted before its diary join, completed while C root is not held, signs the header rejoin and keeps its generation', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const cw1 = entryOf(b, community).writer
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  const own = (await coreEntries(b, cw1)).filter((e) => e.record.type === 'group-leave').pop()
  const L = { writer: cw1, seq: own.seq }
  await exchange(b, a)
  // The rejoin wrote its CW and entry, then stopped before the diary join;
  // the C root is then lost here, so the next join takes the pending path.
  const nonce = 'e1'.repeat(16)
  const s = await store.openStore(b.dataDir)
  let cw2
  try {
    const core = await store.openGroupWriter(s, nonce)
    cw2 = hex(core.key)
    await store.appendRecord(core, groupLib.writerHeader({ group: community, diary: b.key, rejoin: L }), { validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { community: true }) })
    await store.purgeReplica(s, community)
  } finally {
    await s.close()
  }
  store.writeGroups(b.dataDir, [...store.readGroups(b.dataDir).filter((g) => g.group !== community), { group: community, writer: cw2, nonce, kind: 'community' }])
  t.alike(await member.communityJoin(b, { community }), { state: 'pending', group: null })
  const joins = groupLib.groupJoinHistory((await member.logRead(b)).entries, community).filter((j) => j.writer === cw2)
  t.alike(joins.map((j) => [j.on, j.rejoin]), [[true, L]], 'the on-join signs the header rejoin')
  await exchange(a, b)
  await exchange(b, a)
  t.is((await member.communityInfo(b, { community })).role, 'member', 'the CW is the new generation')
  t.is((await member.communityInfo(a, { community })).members, 2)
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  t.is((await coreEntries(b, cw2)).pop().record.type, 'group-leave', 'the leave goes through that CW')
  await exchange(b, a)
  t.is((await member.communityInfo(a, { community })).members, 1, 'the later leave counts')
})

test('the pending-path refusal of community.leave and the C root wait have different texts', async (t) => {
  const { others: [b], community } = await world(t, { names: ['Bia'] })
  const s = await store.openStore(b.dataDir)
  let cw2
  const nonce = 'e2'.repeat(16)
  try {
    const core = await store.openGroupWriter(s, nonce)
    cw2 = hex(core.key)
    await store.appendRecord(core, groupLib.writerHeader({ group: community, diary: b.key }), { validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { community: true }) })
    await store.purgeReplica(s, community)
  } finally {
    await s.close()
  }
  // The entry moved to a CW this diary never bound while another CW of it
  // is on: only the sync can tell which one leaves.
  store.writeGroups(b.dataDir, [...store.readGroups(b.dataDir).filter((g) => g.group !== community), { group: community, writer: cw2, nonce, kind: 'community' }])
  await rejects(t, member.communityLeave(b, { community }), 'aguarde a sincronização da comunidade para sair')
})

test('a creator device rejoining lists its sibling CWs in the extra leave, never C root', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  await exchange(a, b)
  await member.communityJoin(b, { community })
  const cw1 = entryOf(b, community).writer
  await exchange(b, a)
  await exchange(a, b)
  // Another device of the diary leaves, listing this CW but not the root.
  await otherDevice(b, community, 'f6'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key }), [
    (key) => groupLib.groupLeave({ cuts: [{ writer: cw1, seq: 1 }, { writer: key, seq: 1 }].sort((x, y) => x.writer.localeCompare(y.writer)) })
  ], true)
  await member.communityJoin(b, { community })
  const before = await coreEntries(b, cw1)
  const mine = before[before.length - 1]
  t.is(mine.record.type, 'group-leave', 'a leave on this device CW first')
  t.ok(mine.record.cuts.some((x) => x.writer === cw1))
  t.absent(mine.record.cuts.some((x) => x.writer === community), 'C root is never listed there')
})

test('a pending rejoin naming its own device leave keeps its CW while requested', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community, group } = await member.communityCreate(a, { name: 'Bairro', join: 'approval' })
  await exchange(a, b)
  await member.communityJoin(b, { community })
  await exchange(b, a)
  await member.communityAdmit(a, { community, member: b.key, on: true })
  await exchange(a, b)
  t.is((await member.communityInfo(b, { community })).role, 'member')
  const cw1 = entryOf(b, community).writer
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  const own = (await coreEntries(b, cw1)).filter((e) => e.record.type === 'group-leave').pop()
  const L = { writer: cw1, seq: own.seq }
  // A stolen device's leave seen after it becomes the diary's latest leave.
  await otherDevice(b, community, 'f3'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key }), [
    () => groupLib.groupLeave({ seen: L, cuts: [], at: new Date(Date.now() - 3600000).toISOString() })
  ], true)
  t.alike(await member.communityJoin(b, { community }), { state: 'requested', group })
  const cw2 = entryOf(b, community).writer
  t.not(cw2, cw1)
  t.alike((await coreEntries(b, cw2))[0].record.rejoin, L, 'it names its own, non-latest leave')
  // Joining again while requested reuses the pending CW.
  t.alike(await member.communityJoin(b, { community }), { state: 'requested', group })
  t.is(entryOf(b, community).writer, cw2, 'no other CW is opened')
})
