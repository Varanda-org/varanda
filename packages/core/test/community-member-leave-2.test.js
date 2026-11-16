'use strict'

const fs = require('node:fs')
const test = require('brittle')
const crypto = require('hypercore-crypto')
const { groupJoinRecord } = require('../lib/records')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, leaveNoteFile, person, exchange, coreEntries, entryOf, rejects, world, otherDevice, rootAppend } = require('./helpers/community-member')

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
