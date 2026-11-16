'use strict'

const fs = require('node:fs')
const test = require('brittle')
const { groupJoinRecord, groupCutRecord } = require('../lib/records')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { leaveNoteFile, sync, coreEntries, entryOf, world, foldC, leavesOn, texts, otherDevice, rootAppend } = require('./helpers/community-member')

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
