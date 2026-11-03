'use strict'

const fs = require('node:fs')
const test = require('brittle')
const crypto = require('hypercore-crypto')
const { groupJoinRecord, groupCutRecord } = require('../lib/records')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, leaveNoteFile, person, exchange, sync, coreEntries, entryOf, rejects, world, foldC, leavesOn, texts, otherDevice, rootAppend, joinGroup, deleteOn, cutsOf, leaveThenReturn, finished } = require('./helpers/community-member')

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

test('after an unban that missed this device CW, community.leave from it still leaves', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  t.alike(await member.communityBan(a, { community, member: b.key, on: true }), { ok: true })
  const root = await coreEntries(a, community)
  const ban = { writer: community, seq: root[root.length - 1].seq }
  // An unban that lists none of Bia's CWs: her diary is a member again, her
  // CW stays banned in C's layer.
  await rootAppend(a, community, groupLib.communityBan({ member: b.key, on: false, lifts: ban, cuts: [] }), true)
  await exchange(a, b)
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  const cw = entryOf(b, community).writer
  const last = (await coreEntries(b, cw)).pop().record
  t.is(last.type, 'group-leave', 'the leave goes through that CW')
  t.alike(await member.communityLeave(b, { community }), { state: 'left' }, 'the fold reads the diary as left')
})

test('a new device with no CW in the community names the confirmed leave, not a later forged one', async (t) => {
  const { others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const cw1 = entryOf(b, community).writer
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  const own = (await coreEntries(b, cw1)).filter((e) => e.record.type === 'group-leave').pop()
  const L = { writer: cw1, seq: own.seq }
  // A stolen device appends a leave seen after the confirmed one.
  await otherDevice(b, community, 'f4'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key }), [
    () => groupLib.groupLeave({ seen: L, cuts: [], at: new Date(Date.now() - 3600000).toISOString() })
  ], true)
  // This node forgets its CW: it joins as a new device would.
  store.writeGroups(b.dataDir, store.readGroups(b.dataDir).filter((g) => g.group !== community))
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  const cw2 = entryOf(b, community).writer
  t.not(cw2, cw1)
  t.alike((await coreEntries(b, cw2))[0].record.rejoin, L, 'it names the leave its diary confirmed')
})

test('leaving a community root that never folds confirms only a leave this call writes', async (t) => {
  const kp = crypto.keyPair()
  const b = await person(t, kp, 'Bia')
  const s = await store.openStore(b.dataDir)
  let C
  let cw
  try {
    // A stored root that never folds as a community: its header is a group's.
    const root = await store.openGroupWriter(s, 'aa'.repeat(16))
    C = hex(root.key)
    await store.appendRecord(root, groupLib.groupHeader({ diary: b.key, community: 'cd'.repeat(32), member: 'cd'.repeat(32), name: 'Outra' }), { validator: (r) => groupLib.validateGroupHeader(r) })
    const w = await store.openGroupWriter(s, 'bb'.repeat(16))
    cw = hex(w.key)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq, { community: true })
    await store.appendRecord(w, groupLib.writerHeader({ group: C, diary: b.key }), { validator })
    // A leave already on the CW (it may be one a cloned key appended).
    await store.appendRecord(w, groupLib.groupLeave({ cuts: [{ writer: cw, seq: 1 }] }), { validator })
    await store.appendRecord(await store.openDiary(s), groupJoinRecord({ group: C, writer: cw, on: true }))
  } finally {
    await s.close()
  }
  store.writeGroups(b.dataDir, [...store.readGroups(b.dataDir), { group: C, writer: cw, nonce: 'bb'.repeat(16), kind: 'community' }])
  t.alike(await member.communityLeave(b, { community: C }), { state: 'left' })
  t.absent(store.readGroups(b.dataDir).some((g) => g.group === C), 'the entry is gone')
  const joins = groupLib.groupJoinHistory((await member.logRead(b)).entries, C)
  t.alike(joins.map((j) => j.on), [true], 'no off join confirms a leave this call did not write')
})

test('the creator community.leave marks each held group root at its length; a member writes no mark', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  t.alike((await member.logRead(b)).entries.filter((e) => e.record.type === 'group-cut'), [], 'a member writes none')
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  const marks = (await member.logRead(a)).entries.map((e) => e.record).filter((r) => r.type === 'group-cut')
  t.is(marks.length, 1, 'one mark per held group root')
  t.is(marks[0].group, geral)
  t.is(marks[0].writer, geral, 'on the root itself')
  const root = await coreEntries(a, geral)
  t.ok(marks[0].cut >= 1 && marks[0].cut <= root.length, 'the root length this node held')
  t.ok(root.slice(marks[0].cut).every((e) => e.record.type === 'group-leave'), 'only the root own group leave lies past the mark')
})

test('a creator back in the community demotes through its CW, names no one and writes nothing on a marked root', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  t.alike(await member.communitySetAdmin(a, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  t.alike(await member.groupAdmin(a, { group: geral, member: b.key, on: true }), { ok: true })
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  // The marks precede the group-confirm, which precedes the off join.
  const entries = (await member.logRead(a)).entries
  const cut = entries.findIndex((e) => e.record.type === 'group-cut')
  const conf = entries.findIndex((e) => e.record.type === 'group-confirm' && e.record.group === community)
  const off = entries.findIndex((e) => e.record.type === 'group-join' && e.record.group === community && e.record.on === false)
  t.ok(cut >= 0 && conf > cut && off > conf, 'marks before the group-confirm, then the off join')
  t.alike(await member.communityJoin(a, { community }), { state: 'member', group: geral })
  const cw = entryOf(a, community).writer
  t.not(cw, community, 'back on a new CW')
  await rejects(t, member.communitySetAdmin(a, { community, member: b.key, on: true }), 'sem permissão na comunidade')
  t.alike(await member.communitySetAdmin(a, { community, member: b.key, on: false }), { community, member: b.key, on: false })
  const last = (await coreEntries(a, cw)).pop().record
  t.alike([last.type, last.group, last.member, last.on], ['group-admin', null, b.key, false], 'written on the creator CW')
  t.is((await member.communityMembers(a, { community })).members.find((m) => m.member === b.key).admin, false, 'the fold demotes')
  // In the group: the root is marked, so a demotion goes through the CW too.
  await rejects(t, member.groupAdmin(a, { group: geral, member: b.key, on: true }), 'sem permissão no grupo')
  t.alike(await member.groupAdmin(a, { group: geral, member: b.key, on: false }), { ok: true })
  const glast = (await coreEntries(a, cw)).pop().record
  t.alike([glast.type, glast.group, glast.member, glast.on], ['group-admin', geral, b.key, false])
  t.is((await member.groupMembers(a, { group: geral })).members.find((m) => m.member === b.key).admin, false, 'the G fold demotes')
  await rejects(t, member.groupMeta(a, { group: geral, name: 'Outro' }), 'sem permissão no grupo')
})

test('a failing mark leaves the creator leave unconfirmed; a second community.leave writes it, then the off join', async (t) => {
  const { a, community, geral } = await world(t, { names: ['Bia'] })
  a.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => member.communityLeave(a, { community }), /falha simulada/)
  let log = (await member.logRead(a)).entries.map((e) => e.record)
  t.absent(log.some((r) => r.type === 'group-cut'), 'no mark')
  t.absent(log.some((r) => r.type === 'group-confirm'), 'no group-confirm')
  t.absent(log.some((r) => r.type === 'group-join' && r.group === community && r.on === false), 'and no off join')
  delete a.onMark
  t.ok(fs.existsSync(leaveNoteFile(a)), 'the note of the own leave stays')
  t.is((await member.communityInfo(a, { community })).leavePending, true, 'info offers to finish the leave')
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  log = (await member.logRead(a)).entries.map((e) => e.record)
  const cut = log.findIndex((r) => r.type === 'group-cut' && r.group === geral)
  const conf = log.findIndex((r) => r.type === 'group-confirm' && r.group === community)
  const off = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.on === false)
  t.ok(cut >= 0 && conf > cut && off > conf, 'the missing mark, the group-confirm, then the off join')
  t.absent(fs.existsSync(leaveNoteFile(a)), 'the note is cleared')
  t.is((await member.communityInfo(a, { community })).leavePending, false)
  t.alike(await member.communityLeave(a, { community }), { state: 'left' }, 'nothing left to write')
  t.is((await member.logRead(a)).entries.length, log.length)
})

test('the creator normal leave clears its note', async (t) => {
  const { a, community } = await world(t, { names: ['Bia'] })
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  t.absent(fs.existsSync(leaveNoteFile(a)))
})

test('a creator leave with no note of this device is never confirmed by a second community.leave', async (t) => {
  const { a, community } = await world(t, { names: ['Bia'] })
  a.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => member.communityLeave(a, { community }), /falha simulada/)
  delete a.onMark
  // As a leave a holder of a copy of the CW key got in by replication: the
  // own CW holds it, but this device noted nothing.
  fs.rmSync(leaveNoteFile(a))
  const before = (await member.logRead(a)).entries.length
  t.is((await member.communityInfo(a, { community })).leavePending, false)
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  const log = (await member.logRead(a)).entries.map((e) => e.record)
  t.is(log.length, before, 'no mark and no off join')
  t.absent(log.some((r) => r.type === 'group-confirm' || (r.type === 'group-join' && r.group === community && r.on === false)))
})

test('a note whose digest does not match the leave at its seq is ignored', async (t) => {
  const { a, community } = await world(t, { names: ['Bia'] })
  a.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => member.communityLeave(a, { community }), /falha simulada/)
  delete a.onMark
  const data = JSON.parse(fs.readFileSync(leaveNoteFile(a), 'utf8'))
  t.is(data.notes.length, 1)
  t.is(data.notes[0].community, community)
  data.notes[0].digest = 'ab'.repeat(32)
  fs.writeFileSync(leaveNoteFile(a), JSON.stringify(data))
  const before = (await member.logRead(a)).entries.length
  t.is((await member.communityInfo(a, { community })).leavePending, false)
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  t.is((await member.logRead(a)).entries.length, before, 'nothing written')
})

test('after a return whose root G leave never got written, group.join writes a new G writer', async (t) => {
  const { a, community, geral } = await world(t, { names: ['Bia'] })
  // The creator's leave as if its G leave on Geral's root had failed: the C
  // leave on the root, the mark and the off join, and no G leave.
  const rootLen = (await coreEntries(a, community)).length
  await rootAppend(a, community, groupLib.groupLeave({ cuts: [{ writer: community, seq: rootLen }] }), true)
  const geralLen = (await coreEntries(a, geral)).length
  const s = await store.openStore(a.dataDir)
  try {
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupCutRecord({ group: geral, writer: geral, cut: geralLen }))
    await store.appendRecord(diary, groupJoinRecord({ group: community, writer: community, on: false }))
  } finally {
    await s.close()
  }
  t.alike(await member.communityJoin(a, { community }), { state: 'member', group: geral })
  const w = entryOf(a, geral).writer
  t.not(w, geral, 'a new G writer, never the marked root')
  t.is((await coreEntries(a, w))[0].record.diary, a.key)
  t.ok((await member.groupPost(a, { group: geral, text: 'de volta' })).seq >= 1)
  t.ok(texts(await member.groupRead(a, { group: geral })).includes('de volta'), 'its post counts')
})

test('a member leave writes the group-confirm of exactly its leave, and the fold confirms it', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const cw = entryOf(b, community).writer
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  const [leave] = await leavesOn(b, cw)
  const log = (await member.logRead(b)).entries.map((e) => e.record)
  const confirms = log.filter((r) => r.type === 'group-confirm')
  t.is(confirms.length, 1)
  t.alike([confirms[0].group, confirms[0].writer, confirms[0].seq, confirms[0].digest], [community, cw, leave.seq, groupLib.leaveDigest(leave.record)])
  const conf = log.findIndex((r) => r.type === 'group-confirm')
  const off = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.on === false)
  t.ok(conf >= 0 && off > conf, 'the group-confirm, then the off join')
  await sync(a, b)
  t.alike((await foldC(a, community, [cw])).confirmedLeaveOf.get(b.key), { writer: cw, seq: leave.seq }, 'the fold confirms it')
})

test('a leave a key copy appended on the own CW is never confirmed: only the own leave seq is', async (t) => {
  const { others: [b, c], community } = await world(t)
  // Before: a leave already on the CW. The fold reads Caio as left and
  // community.leave writes nothing, no group-confirm at all.
  const cwc = entryOf(c, community).writer
  await rootAppend(c, community, groupLib.groupLeave({ cuts: [{ writer: cwc, seq: 1 }] }), true)
  t.alike(await member.communityLeave(c, { community }), { state: 'left' })
  t.absent((await member.logRead(c)).entries.some((e) => e.record.type === 'group-confirm'), 'nothing confirmed')
  t.absent((await foldC(c, community, [cwc])).confirmedLeaveOf.has(c.key))
  // After: Bia's own leave, then the copy's at the next seq.
  const cw = entryOf(b, community).writer
  t.alike(await member.communityLeave(b, { community }), { state: 'left' })
  await rootAppend(b, community, groupLib.groupLeave({ cuts: [{ writer: cw, seq: 1 }] }), true)
  const leaves = await leavesOn(b, cw)
  t.is(leaves.length, 2)
  const confirms = (await member.logRead(b)).entries.map((e) => e.record).filter((r) => r.type === 'group-confirm')
  t.alike(confirms.map((r) => r.seq), [leaves[0].seq], 'only the own leave seq')
  t.alike((await foldC(b, community, [cw])).confirmedLeaveOf.get(b.key), { writer: cw, seq: leaves[0].seq })
})

test('after a key-copy leave on the root, community.admin off demotes through the CW', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  t.alike(await member.communitySetAdmin(a, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  const rootLen = (await coreEntries(a, community)).length
  // A holder of a copy of the root key leaves C on the root: no note, no
  // group-confirm, still a bound on the root's authority.
  await rootAppend(a, community, groupLib.groupLeave({ cuts: [{ writer: community, seq: rootLen }] }), true)
  t.absent((await member.logRead(a)).entries.some((e) => e.record.type === 'group-confirm'))
  t.is((await member.communityJoin(a, { community })).state, 'member')
  const cw = entryOf(a, community).writer
  t.alike(await member.communitySetAdmin(a, { community, member: b.key, on: false }), { community, member: b.key, on: false })
  const last = (await coreEntries(a, cw)).pop().record
  t.alike([last.type, last.group, last.member, last.on], ['group-admin', null, b.key, false], 'the CW demotion')
  t.is((await member.communityMembers(a, { community })).members.find((m) => m.member === b.key).admin, false, 'the fold demotes')
})

test('an unconfirmed leave on a secondary CW of the creator never ends the root: back in C, the creating device still manages admins and the community', async (t) => {
  const { a, others: [b, c], community } = await world(t)
  t.alike(await member.communitySetAdmin(a, { community, member: b.key, on: true }), { community, member: b.key, on: true })
  const rootLen = (await coreEntries(a, community)).length
  // A holder of a copy of another device's CW key leaves listing the root,
  // and the creator's diary never confirms it: the root is retired by
  // generation, yet the fold keeps its authority.
  const cw2 = await otherDevice(a, community, 'e2'.repeat(16), groupLib.writerHeader({ group: community, diary: a.key }), [
    (key) => groupLib.groupLeave({ cuts: [{ writer: community, seq: rootLen }, { writer: key, seq: 1 }].sort((x, y) => x.writer.localeCompare(y.writer)) })
  ], true)
  t.is((await member.communityJoin(a, { community })).state, 'member')
  const cw = entryOf(a, community).writer
  t.not(cw, community)
  const writers = [entryOf(b, community).writer, entryOf(c, community).writer, cw2, cw]
  const fold = await foldC(a, community, writers)
  t.absent(fold.authorityWriters.has(community), 'the root is out of authorityWriters')
  t.is(fold.rootAuthority, true, 'yet a root record would carry authority')
  t.alike(await member.communitySetAdmin(a, { community, member: b.key, on: false }), { community, member: b.key, on: false })
  t.alike(await member.communitySetAdmin(a, { community, member: c.key, on: true }), { community, member: c.key, on: true })
  t.alike(await member.communityMeta(a, { community, name: 'Vila' }), { ok: true })
  const tail = (await coreEntries(a, community)).slice(-3).map((e) => e.record)
  t.alike(tail.map((r) => [r.type, r.member, r.on]), [['group-admin', b.key, false], ['group-admin', c.key, true], ['group-meta', undefined, undefined]], 'written on the root')
  const admins = (await member.communityMembers(a, { community })).members.filter((m) => m.admin).map((m) => m.member)
  t.ok(admins.includes(c.key) && !admins.includes(b.key), 'the fold counts both grants')
  t.is((await member.communityInfo(a, { community })).name, 'Vila', 'and the meta')
})

test('the creator note is written before its leave is appended; a failure right after it leaves a second leave to finish', async (t) => {
  const { a, community } = await world(t, { names: ['Bia'] })
  const len = (await coreEntries(a, community)).length
  let seen = null
  a.onLeaveNote = () => {
    seen = JSON.parse(fs.readFileSync(leaveNoteFile(a), 'utf8')).notes[0]
    throw new Error('falha simulada')
  }
  await t.exception(() => member.communityLeave(a, { community }), /falha simulada/)
  delete a.onLeaveNote
  t.ok(seen !== null, 'the note exists before the append')
  t.alike([seen.writer, seen.seq], [community, len])
  t.is((await leavesOn(a, community)).length, 0, 'no leave yet')
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  const leaves = await leavesOn(a, community)
  t.is(leaves.length, 1)
  const conf = (await member.logRead(a)).entries.map((e) => e.record).filter((r) => r.type === 'group-confirm')
  t.alike(conf.map((r) => [r.seq, r.digest]), [[leaves[0].seq, groupLib.leaveDigest(leaves[0].record)]])
  t.absent(fs.existsSync(leaveNoteFile(a)))
})

test('the retry marks each root at the cut its note recorded, even after the root grew', async (t) => {
  const { a, community, geral } = await world(t, { names: ['Bia'] })
  a.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => member.communityLeave(a, { community }), /falha simulada/)
  delete a.onMark
  const note = JSON.parse(fs.readFileSync(leaveNoteFile(a), 'utf8')).notes[0]
  t.is(note.roots.length, 1)
  t.is(note.roots[0].group, geral)
  const grown = (await coreEntries(a, geral)).length
  await rootAppend(a, geral, groupLib.groupLeave({ cuts: [{ writer: geral, seq: grown }] }), false)
  t.ok((await coreEntries(a, geral)).length > note.roots[0].cut, 'the root grew past the noted cut')
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  const marks = (await member.logRead(a)).entries.map((e) => e.record).filter((r) => r.type === 'group-cut')
  t.alike(marks.map((m) => [m.group, m.cut]), [[geral, note.roots[0].cut]], 'the noted cut')
})

test('a note over a forked own CW is never finished', async (t) => {
  const { a, community } = await world(t, { names: ['Bia'] })
  const nonce = 'e3'.repeat(16)
  const rootNonce = entryOf(a, community).nonce
  const cw2 = await otherDevice(a, community, nonce, groupLib.writerHeader({ group: community, diary: a.key }), [], true)
  // This node leaves through that device's CW, and a mark fails.
  store.writeGroups(a.dataDir, [...store.readGroups(a.dataDir).filter((g) => g.group !== community), { group: community, writer: cw2, nonce, kind: 'community' }])
  a.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => member.communityLeave(a, { community }), /falha simulada/)
  delete a.onMark
  const note = JSON.parse(fs.readFileSync(leaveNoteFile(a), 'utf8')).notes[0]
  t.is(note.writer, cw2)
  // The CW forks with the same leave block at the noted seq.
  const s = await store.openStore(a.dataDir)
  try {
    const core = await store.openGroupWriter(s, nonce)
    const raw = await core.get(note.seq, { raw: true })
    await core.truncate(note.seq)
    await core.append(raw)
    t.is(core.fork, 1)
    // The fold drops the forked CW: a leave on the root keeps the creator out.
    const root = await store.openGroupWriter(s, rootNonce)
    await store.appendRecord(root, groupLib.groupLeave({ cuts: [{ writer: community, seq: root.length }] }), { validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { root: true, community: true }) })
  } finally {
    await s.close()
  }
  const before = (await member.logRead(a)).entries.length
  t.is((await member.communityInfo(a, { community })).leavePending, false)
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  t.is((await member.logRead(a)).entries.length, before, 'nothing written')
})

test('community.join first finishes the creator own leave a failed mark interrupted, then joins', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  a.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => member.communityLeave(a, { community }), /falha simulada/)
  delete a.onMark
  const [leave] = await leavesOn(a, community)
  const before = (await member.logRead(a)).entries.length
  t.alike(await member.communityJoin(a, { community }), { state: 'member', group: geral })
  const log = (await member.logRead(a)).entries.map((e) => e.record).slice(before)
  const cw = entryOf(a, community).writer
  t.not(cw, community, 'back on a new CW')
  const cut = log.findIndex((r) => r.type === 'group-cut' && r.group === geral && r.writer === geral)
  const conf = log.findIndex((r) => r.type === 'group-confirm' && r.group === community && r.writer === community && r.seq === leave.seq)
  const off = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.writer === community && r.on === false)
  const on = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.writer === cw && r.on === true)
  t.ok(cut >= 0 && conf > cut && off > conf && on > off, 'the missing mark, the group-confirm and the off join before the new CW join')
  t.absent(fs.existsSync(leaveNoteFile(a)), 'the note is cleared')
  t.alike((await coreEntries(a, cw))[0].record.rejoin, { writer: community, seq: leave.seq }, 'the new CW names the own leave')
  const fold = await foldC(a, community, [entryOf(b, community).writer, cw])
  t.alike(fold.confirmedLeaveOf.get(a.key), { writer: community, seq: leave.seq }, 'the fold confirms the leave')
  t.is(fold.rootAuthority, false, 'the root lost its authority')
})

test('a delete record on the community root never erases the creator confirmed leave', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  const [leave] = await leavesOn(a, community)
  await deleteOn(a, entryOf(a, community).nonce, leave.seq)
  await sync(a, b)
  t.alike(await member.communityJoin(a, { community }), { state: 'member', group: (await member.communityInfo(a, { community })).general })
  await rejects(t, member.groupCreate(a, { name: 'Feira', join: 'open', community }), 'sem permissão na comunidade')
  // The powers ended: a meta goes through the CW, never the root (cycle 24).
  const rootLen = (await coreEntries(a, community)).length
  t.alike(await member.communityMeta(a, { community, name: 'Outro' }), { ok: true })
  t.is((await coreEntries(a, community)).length, rootLen, 'nothing on the root')
  t.is((await coreEntries(a, entryOf(a, community).writer)).pop().record.type, 'group-meta', 'the meta is on the CW')
  t.is((await member.communityInfo(b, { community })).name, 'Bairro', 'the root bound is unchanged for the other members')
})

test('a delete record on a group writer never hides a post', async (t) => {
  const { a, others: [b], geral } = await world(t, { names: ['Bia'] })
  const { seq } = await member.groupPost(b, { group: geral, text: 'fica' })
  await deleteOn(b, entryOf(b, geral).nonce, seq)
  await sync(a, b)
  t.ok(texts(await member.groupRead(b, { group: geral })).includes('fica'), 'the author node still shows it')
  t.ok(texts(await member.groupRead(a, { group: geral })).includes('fica'), 'and so does another member')
})

test('the creator leave waits until every group root of the catalogue is held, then marks them all', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const { group: horta } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await sync(a, b)
  const s = await store.openStore(a.dataDir)
  try {
    await store.purgeReplica(s, horta)
  } finally {
    await s.close()
  }
  const log = (await member.logRead(a)).entries.length
  const rootLen = (await coreEntries(a, community)).length
  await rejects(t, member.communityLeave(a, { community }), 'aguarde a sincronização dos grupos da comunidade para sair')
  t.is((await member.logRead(a)).entries.length, log, 'nothing in the diary')
  t.is((await coreEntries(a, community)).length, rootLen, 'nothing on the root')
  t.absent(fs.existsSync(leaveNoteFile(a)), 'no note')
  t.is((await leavesOn(a, geral)).length, 0, 'no group leave')
  await exchange(b, a)
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  const marks = (await member.logRead(a)).entries.map((e) => e.record).filter((r) => r.type === 'group-cut')
  t.alike(marks.map((m) => m.group).sort(), [geral, horta].sort(), 'every group of the catalogue is marked')
})

test('a group-create a copy of the C root key wrote, naming a root nobody serves, never blocks the creator leave', async (t) => {
  const { a, community, geral } = await world(t, { names: ['Bia'] })
  const fake = hex(crypto.keyPair().publicKey)
  await rootAppend(a, community, groupLib.groupCreateRecord({ group: fake, seen: null }), true)
  t.ok((await member.communityInfo(a, { community })).groups.some((g) => g.group === fake), 'the catalogue names it')
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  const marks = await cutsOf(a)
  t.alike(marks.map((m) => m.group), [geral], 'only the root the own diary bound is marked')
  t.absent(fs.existsSync(leaveNoteFile(a)), 'the leave finished')
})

test('a forked group root the own diary bound is skipped: no wait, no mark', async (t) => {
  const { a, community, geral } = await world(t, { names: ['Bia'] })
  const { group: horta } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  const s = await store.openStore(a.dataDir)
  try {
    const core = await store.openGroupWriter(s, entryOf(a, horta).nonce)
    const last = core.length - 1
    const raw = await core.get(last, { raw: true })
    await core.truncate(last)
    await core.append(raw)
    t.is(core.fork, 1)
  } finally {
    await s.close()
  }
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  t.alike((await cutsOf(a)).map((m) => m.group), [geral], 'the forked root is not marked')
})

test('a bound group root not held refuses the creator leave; with force it leaves, marking only the held roots', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const { group: horta } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await member.groupMeta(a, { group: horta, name: 'Hortinha' })
  await sync(a, b)
  t.is((await member.groupInfo(b, { group: horta })).name, 'Hortinha', 'the root meta counts before the leave')
  const s = await store.openStore(a.dataDir)
  try {
    await store.purgeReplica(s, horta)
  } finally {
    await s.close()
  }
  const log = (await member.logRead(a)).entries.length
  await rejects(t, member.communityLeave(a, { community }), 'aguarde a sincronização dos grupos da comunidade para sair')
  await rejects(t, member.communityLeave(a, { community, force: false }), 'aguarde a sincronização dos grupos da comunidade para sair')
  t.is((await member.logRead(a)).entries.length, log, 'nothing written without force')
  t.absent(fs.existsSync(leaveNoteFile(a)), 'no note')
  t.alike(await member.communityLeave(a, { community, force: true }), { state: 'left' })
  t.alike((await cutsOf(a)).map((m) => m.group), [geral], 'only the held root is marked')
  const log2 = (await member.logRead(a)).entries.map((e) => e.record)
  t.ok(log2.some((r) => r.type === 'group-confirm' && r.group === community), 'the leave is confirmed')
  await sync(a, b)
  t.is((await member.groupInfo(b, { group: horta })).name, 'Horta', 'the unmarked root carries no authority after the confirmed leave')
})

test('without force the creator leave waits while its copy of the C root is behind its signed length, then leaves', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  await member.communityMeta(a, { community, name: 'Vila' })
  await sync(a, b)
  const s = await store.openStore(a.dataDir)
  try {
    const root = s.get({ key: Buffer.from(community, 'hex'), writable: false })
    await root.ready()
    await root.clear(root.length - 1, root.length)
    t.ok(root.contiguousLength < root.length, 'the root copy is behind its signed length')
    await root.close()
  } finally {
    await s.close()
  }
  const log = (await member.logRead(a)).entries.length
  const rootLen = (await coreEntries(a, community)).length
  await rejects(t, member.communityLeave(a, { community }), 'este aparelho ainda não baixou tudo da comunidade: aguarde para sair')
  t.is((await member.logRead(a)).entries.length, log, 'nothing in the diary')
  t.is((await coreEntries(a, community)).length, rootLen, 'nothing on the root')
  t.absent(fs.existsSync(leaveNoteFile(a)), 'no note')
  await exchange(b, a)
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
})

test('force names the waits it skips: a root wait skips only with root, a groups wait only with groups', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const { group: horta } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await member.communityMeta(a, { community, name: 'Vila' })
  await sync(a, b)
  const s = await store.openStore(a.dataDir)
  try {
    const root = s.get({ key: Buffer.from(community, 'hex'), writable: false })
    await root.ready()
    await root.clear(root.length - 1, root.length)
    await root.close()
    await store.purgeReplica(s, horta)
  } finally {
    await s.close()
  }
  const log = (await member.logRead(a)).entries.length
  await rejects(t, member.communityLeave(a, { community, force: ['groups', 'devices'] }), 'este aparelho ainda não baixou tudo da comunidade: aguarde para sair')
  await rejects(t, member.communityLeave(a, { community, force: ['root'] }), 'aguarde a sincronização dos grupos da comunidade para sair')
  await rejects(t, member.communityLeave(a, { community, force: ['root', 'devices'] }), 'aguarde a sincronização dos grupos da comunidade para sair')
  t.is((await member.logRead(a)).entries.length, log, 'nothing written')
  t.alike(await member.communityLeave(a, { community, force: ['root', 'groups'] }), { state: 'left' })
})

test('the creator leave waits while a sibling own CW is not held or behind; only force devices skips it', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const sibling = await otherDevice(a, community, 'f7'.repeat(16), groupLib.writerHeader({ group: community, diary: a.key }), [], true)
  const s = await store.openStore(a.dataDir)
  try {
    const core = s.get({ key: Buffer.from(sibling, 'hex'), writable: false })
    await core.ready()
    await core.clear(0, 1)
    t.ok(core.contiguousLength < core.length, 'the sibling copy is behind its signed length')
    await core.close()
  } finally {
    await s.close()
  }
  const DEVICES = 'aguarde a sincronização dos seus aparelhos nesta comunidade para sair'
  const log = (await member.logRead(a)).entries.length
  const rootLen = (await coreEntries(a, community)).length
  await rejects(t, member.communityLeave(a, { community }), DEVICES)
  await rejects(t, member.communityLeave(a, { community, force: ['groups'] }), DEVICES)
  await rejects(t, member.communityLeave(a, { community, force: ['root', 'groups'] }), DEVICES)
  t.is((await member.logRead(a)).entries.length, log, 'nothing in the diary')
  t.is((await coreEntries(a, community)).length, rootLen, 'nothing on the root')
  t.absent(fs.existsSync(leaveNoteFile(a)), 'no note')
  t.alike(await member.communityLeave(a, { community, force: ['devices'] }), { state: 'left' })
  await sync(a, b)
  t.is((await member.communityInfo(b, { community })).role, 'member', 'b stays')
})

test('with force the creator leaves while its copy of the C root is behind, listing the root at its contiguous length', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  await member.communityMeta(a, { community, name: 'Vila' })
  await sync(a, b)
  const s = await store.openStore(a.dataDir)
  let contiguous = 0
  try {
    const root = s.get({ key: Buffer.from(community, 'hex'), writable: false })
    await root.ready()
    await root.clear(root.length - 1, root.length)
    contiguous = root.contiguousLength
    t.ok(contiguous < root.length, 'the root copy is behind its signed length')
    await root.close()
  } finally {
    await s.close()
  }
  t.alike(await member.communityLeave(a, { community, force: true }), { state: 'left' })
  const confirm = (await member.logRead(a)).entries.map((e) => e.record).find((r) => r.type === 'group-confirm' && r.group === community)
  t.ok(confirm, 'the leave is confirmed')
  await exchange(b, a)
  const leave = (await coreEntries(a, confirm.writer)).find((e) => e.seq === confirm.seq)
  t.is(leave.record.type, 'group-leave')
  t.alike(leave.record.cuts.find((x) => x.writer === community), { writer: community, seq: contiguous }, 'the held-back tail is not listed')
})

test('a creator back in C drops a group, sees it in dropped and puts it back with undo; undo of a group not dropped changes nothing', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const { group: horta } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  t.alike((await member.communityInfo(a, { community })).dropped, [], 'nothing dropped yet')
  await rejects(t, member.communityRemoveGroup(a, { community, group: horta, undo: true }), 'sem permissão na comunidade')
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  t.is((await member.communityJoin(a, { community })).state, 'member')
  const cw = entryOf(a, community).writer
  await rejects(t, member.communityRemoveGroup(a, { community, group: horta, undo: true }), 'nada a alterar')
  await rejects(t, member.communityRemoveGroup(a, { community, group: geral, undo: true }), 'o grupo Geral só sai com a comunidade')
  t.alike(await member.communityRemoveGroup(a, { community, group: horta }), { ok: true })
  let info = await member.communityInfo(a, { community })
  t.alike(info.dropped, [horta], 'community.info lists the dropped group')
  t.absent(info.groups.some((g) => g.group === horta))
  await exchange(a, b)
  await rejects(t, member.communityRemoveGroup(b, { community, group: horta, undo: true }), 'sem permissão na comunidade')
  const affected = new Set()
  t.alike(await member.communityRemoveGroup(a, { community, group: horta, undo: true }, { affected }), { ok: true })
  t.alike([...affected].sort(), [community, horta].sort())
  const last = (await coreEntries(a, cw)).pop().record
  t.alike([last.type, last.group, last.on], ['group-drop', horta, false], 'written on the CW')
  info = await member.communityInfo(a, { community })
  t.alike(info.dropped, [], 'no longer dropped')
  t.ok(info.groups.some((g) => g.group === horta), 'back in the catalogue')
  await rejects(t, member.communityRemoveGroup(a, { community, group: horta, undo: true }), 'nada a alterar')
})

test('community.leave finishes the noted creator leave after a return from another device', async (t) => {
  const w = await leaveThenReturn(t)
  const { a, community } = w
  const before = (await member.logRead(a)).entries.length
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  finished(t, (await member.logRead(a)).entries.map((e) => e.record).slice(before), w)
  t.absent(fs.existsSync(leaveNoteFile(a)), 'the note is cleared')
})

test('community.join finishes the noted creator leave after a return from another device', async (t) => {
  const w = await leaveThenReturn(t)
  const { a, community } = w
  const before = (await member.logRead(a)).entries.length
  await member.communityJoin(a, { community })
  finished(t, (await member.logRead(a)).entries.map((e) => e.record).slice(before), w)
  t.absent(fs.existsSync(leaveNoteFile(a)), 'the note is cleared')
})

test('after a forced leave left a root unmarked, a later leave writes no mark for it and the root stays without authority', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const { group: horta } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  // A copy of the root key appends a block this device does not hold when
  // it leaves (here the store then drops the root, which a replica held
  // later can no longer append to).
  await rootAppend(a, horta, groupLib.groupMeta({ name: 'Roubado', join: 'open' }), false)
  await sync(a, b)
  const s = await store.openStore(a.dataDir)
  try {
    await store.purgeReplica(s, horta)
  } finally {
    await s.close()
  }
  t.alike(await member.communityLeave(a, { community, force: true }), { state: 'left' })
  t.alike((await cutsOf(a)).map((m) => m.group), [geral], 'the forced leave marks only the held root')
  t.is((await member.communityJoin(a, { community })).state, 'member', 'the creator is back')
  await exchange(b, a)
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  t.absent((await cutsOf(a)).some((m) => m.group === horta), 'no mark for the root the first leave left unmarked')
  await sync(a, b)
  t.is((await member.groupInfo(b, { group: horta })).name, 'Horta', 'the root still carries no authority')
})

test('a group-create a copy of the C root key wrote, naming a group of another community, is never marked', async (t) => {
  const { a, community, geral } = await world(t, { names: ['Bia'] })
  const { community: other } = await member.communityCreate(a, { name: 'Vila', join: 'open' })
  const { group: feira } = await member.groupCreate(a, { name: 'Feira', join: 'open', community: other })
  await rootAppend(a, community, groupLib.groupCreateRecord({ group: feira, seen: null }), true)
  t.ok((await member.communityInfo(a, { community })).groups.some((g) => g.group === feira), 'the catalogue names it')
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  t.alike((await cutsOf(a)).map((m) => m.group), [geral], 'only the root of a group of this community is marked')
  await member.groupMeta(a, { group: feira, name: 'Feirinha' })
  t.is((await member.groupInfo(a, { group: feira })).name, 'Feirinha', 'the root keeps its powers in the other community')
})

test('after an unconfirmed on-root leave and a return whose own confirmed leave bounds no root, a later creator leave still marks the held roots', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const { group: horta } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  // A second CW of the creator's diary, the one this device returns from.
  const cw2 = await otherDevice(a, community, 'e3'.repeat(16), groupLib.writerHeader({ group: community, diary: a.key }), [], true)
  // A copy of the root key leaves C on the root: no group-confirm.
  const rootLen = (await coreEntries(a, community)).length
  await rootAppend(a, community, groupLib.groupLeave({ cuts: [{ writer: community, seq: rootLen }] }), true)
  store.writeGroups(a.dataDir, store.readGroups(a.dataDir).map((g) => g.group === community ? { ...g, writer: cw2, nonce: 'e3'.repeat(16) } : g))
  // The return first leaves on cw2, listing only cw2, and the diary
  // confirms that leave: a confirm for C that bounds no root.
  t.is((await member.communityJoin(a, { community })).state, 'member')
  const conf = (await member.logRead(a)).entries.map((e) => e.record).filter((r) => r.type === 'group-confirm' && r.group === community)
  t.alike(conf.map((r) => r.writer), [cw2], 'the confirmed leave is on cw2')
  const cw3 = entryOf(a, community).writer
  await exchange(a, b)
  t.is((await foldC(a, community, [entryOf(b, community).writer, cw2, cw3])).creatorConfirmSeq, Infinity, 'no confirmed leave bounds the root')
  t.alike(await cutsOf(a), [], 'no mark yet')
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  const marks = (await cutsOf(a)).map((m) => [m.group, m.writer])
  t.ok(marks.some(([g, w]) => g === horta && w === horta), 'the later leave marks Horta')
  t.ok(marks.some(([g, w]) => g === geral && w === geral), 'and Geral')
})

test('a creator back after its confirmed leave renames C and changes its entry through the CW', async (t) => {
  const { a, community } = await world(t, { names: ['Bia'] })
  t.is((await member.communityInfo(a, { community })).repair, false, 'no repair while the root has authority')
  t.alike(await member.communityMeta(a, { community, name: 'Antes' }), { ok: true })
  t.is((await coreEntries(a, community)).pop().record.type, 'group-meta', 'written on the root')
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  t.is((await member.communityJoin(a, { community })).state, 'member')
  const cw = entryOf(a, community).writer
  t.not(cw, community)
  t.is((await member.communityInfo(a, { community })).repair, true)
  const rootLen = (await coreEntries(a, community)).length
  t.alike(await member.communityMeta(a, { community, name: 'Vila', join: 'approval' }), { ok: true })
  const last = (await coreEntries(a, cw)).pop().record
  t.alike([last.type, last.group, last.name, last.join], ['group-meta', null, 'Vila', 'approval'], 'written on the CW')
  t.is((await coreEntries(a, community)).length, rootLen, 'nothing on the root')
  const info = await member.communityInfo(a, { community })
  t.alike([info.name, info.join], ['Vila', 'approval'], 'the fold shows both')
})

test('a creator back after its confirmed leave takes a group off the catalogue; Geral, a live root and a member are refused', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const { group: horta } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await rejects(t, member.communityRemoveGroup(a, { community, group: horta }), 'sem permissão na comunidade')
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  t.is((await member.communityJoin(a, { community })).state, 'member')
  const cw = entryOf(a, community).writer
  await rejects(t, member.communityRemoveGroup(a, { community, group: geral }), 'o grupo Geral só sai com a comunidade')
  await exchange(a, b)
  await rejects(t, member.communityRemoveGroup(b, { community, group: horta }), 'sem permissão na comunidade')
  t.ok((await member.communityInfo(a, { community })).groups.some((g) => g.group === horta))
  const affected = new Set()
  t.alike(await member.communityRemoveGroup(a, { community, group: horta.toUpperCase() }, { affected }), { ok: true })
  t.alike([...affected].sort(), [community, horta].sort(), 'groups.changed for C and the group')
  const last = (await coreEntries(a, cw)).pop().record
  t.alike([last.type, last.group], ['group-drop', horta], 'written on the CW')
  const info = await member.communityInfo(a, { community })
  t.absent(info.groups.some((g) => g.group === horta), 'the fold drops it')
  t.ok(info.groups.some((g) => g.group === geral), 'Geral stays')
  await rejects(t, member.communityRemoveGroup(a, { community, group: horta }), 'nada a alterar')
})
