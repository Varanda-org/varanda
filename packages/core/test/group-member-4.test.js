'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { groupJoinRecord } = require('../lib/records')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, AT, person, exchange, pair, writerEntries, offlineAppend, rejects, communityOfGroup, cwOf, createGroup, joinGroup, groupJoins, heldWriters, pendingPair, otherDevice } = require('./helpers/group-member')

test('a join refuses before creating a writer when the fold already counts the writer cap', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Cheia', join: 'open' })
  await exchange(a, b)
  await member.communityJoin(b, { community: communityOfGroup.get(group) })
  // Other devices of Bia fill every counted slot; this device has none.
  const s = await store.openStore(b.dataDir)
  try {
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    const diary = await store.openDiary(s)
    for (let i = 0; i < groupLib.MAX_GROUP_WRITERS - 1; i++) {
      const writer = await store.openGroupWriter(s, i.toString(16).padStart(32, '0'))
      await store.appendRecord(writer, groupLib.writerHeader({ group, member: cwOf(b, group), diary: b.key }), { validator })
      await store.appendRecord(diary, groupJoinRecord({ group, writer: hex(writer.key), on: true }))
    }
  } finally {
    await s.close()
  }
  const length = (await member.logRead(b)).entries.length
  await rejects(t, joinGroup(b, { group }), 'limite do grupo atingido')
  t.absent(store.readGroups(b.dataDir).some((g) => g.group === group), 'no local entry')
  t.is((await member.logRead(b)).entries.length, length, 'no diary join')
})

test('a join by key before the root arrives is pending until a sync brings it', async (t) => {
  const { a, b, group } = await pendingPair(t)
  t.alike(await joinGroup(b, { group }), { state: 'pending' })
  t.is(store.readGroups(b.dataDir).length, 3, 'the CW, Geral and the group')
  t.is(await heldWriters(b, group), 1)
  const joins = await groupJoins(b, group)
  t.is(joins.length, 1)
  t.is(joins[0].on, true)
  t.is(joins[0].writer, store.readGroups(b.dataDir).find((g) => g.group === group).writer)
  t.alike(await joinGroup(b, { group }), { state: 'pending' }, 'a second join stays pending')
  t.is(await heldWriters(b, group), 1, 'no second writer')
  t.is((await groupJoins(b, group)).length, 1, 'no second diary join')
  t.alike((await member.groupList(b)).groups.find((g) => g.group === group), { group, name: null, image: null, imageAuthor: null, join: null, role: 'pending', members: 0, community: null })
  t.alike(await member.groupInfo(b, { group }), { group, name: null, image: null, imageAuthor: null, join: null, creator: null, role: 'pending', members: 0, state: 'pending', community: null, orphan: false, visibility: 'public', memberInvite: false })
  t.alike(await member.groupRead(b, { group }), { items: [], next: null, hidden: 0, incomplete: true, sealed: 0, epoch: null, state: 'ok' })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member')
  t.alike(await joinGroup(b, { group }), { state: 'member' })
  t.is(await heldWriters(b, group), 1)
  t.ok((await member.groupPost(b, { group, text: 'oi' })).seq >= 1)
})

test('a pending join of an approval group becomes a request', async (t) => {
  const { a, b, group } = await pendingPair(t, 'approval')
  t.alike(await joinGroup(b, { group }), { state: 'pending' })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'requested')
  t.is((await member.groupList(b)).groups.find((g) => g.group === group).role, 'requested')
})

test('a ban written before a pending join shows once the root arrives', async (t) => {
  const { a, b, group } = await pendingPair(t, 'open', { ban: true })
  t.alike(await joinGroup(b, { group }), { state: 'pending' })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'banned')
})

test('a pending group can be left and refuses every other write', async (t) => {
  const { a, b, group } = await pendingPair(t)
  const unknown = 'f'.repeat(64)
  await rejects(t, member.groupLeave(b, { group }), 'grupo não encontrado', 'NOT_FOUND')
  await rejects(t, member.groupInfo(b, { group: unknown }), 'grupo não encontrado', 'NOT_FOUND')
  await rejects(t, member.groupRead(b, { group: unknown }), 'grupo não encontrado', 'NOT_FOUND')
  t.alike(await joinGroup(b, { group }), { state: 'pending' })
  const ops = [
    () => member.groupMembers(b, { group }),
    () => member.groupRequests(b, { group }),
    () => member.groupPost(b, { group, text: 'não' }),
    () => member.groupHide(b, { group, target: { writer: group, seq: 1 }, on: true }),
    () => member.groupAdmit(b, { group, member: a.key, on: true }),
    () => member.groupBan(b, { group, member: a.key, on: true }),
    () => member.groupAdmin(b, { group, member: a.key, on: true }),
    () => member.groupMeta(b, { group, name: 'Outra' })
  ]
  for (const run of ops) await rejects(t, run(), 'grupo não encontrado', 'NOT_FOUND')
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const { key, entries } = await writerEntries(b, group)
  t.alike(entries[1].record, { type: 'group-leave', seen: null, cuts: [{ writer: key, seq: 1 }], at: entries[1].record.at })
  t.alike((await groupJoins(b, group)).map((j) => j.on), [true, false])
  await rejects(t, member.groupLeave(b, { group }), 'nada a alterar')
  t.is((await member.groupList(b)).groups.find((g) => g.group === group).role, 'pending')
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'left')
})

test('a leave lists every counted writer of the own diary at its local length', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupPost(b, { group, text: 'deste' })
  const other = await otherDevice(b, group, 'ab'.repeat(16), [groupLib.groupPost({ text: 'do outro' })])
  const own = await writerEntries(b, group)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const left = await writerEntries(b, group)
  const leave = left.entries[left.length - 1].record
  t.is(leave.type, 'group-leave')
  t.alike(leave.cuts, [{ writer: own.key, seq: own.length }, { writer: other.key, seq: other.length }].sort((x, y) => x.writer.localeCompare(y.writer)))
  await exchange(b, a)
  const read = await member.groupRead(a, { group })
  t.alike(read.items.map((p) => [p.text, p.hidden]).sort(), [['', true], ['deste', false]], 'a leave withdraws the other device records from seq 0')
  // The creator's leave lists the root.
  await member.groupPost(a, { group, text: 'raiz' })
  const root = await writerEntries(a, group)
  await member.groupLeave(a, { group })
  const after = await writerEntries(a, group)
  t.alike(after.entries[after.length - 1].record.cuts, [{ writer: group, seq: root.length }])
})

test('a grant lists every live writer of the promoted diary at its local length', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupPost(b, { group, text: 'antes' })
  await member.groupLeave(b, { group })
  const first = await writerEntries(b, group)
  t.alike(await joinGroup(b, { group }), { state: 'member' })
  await member.groupPost(b, { group, text: 'de novo' })
  const second = await writerEntries(b, group)
  await exchange(b, a)
  t.alike(await member.groupAdmin(a, { group, member: b.key, on: true }), { ok: true })
  const root = await writerEntries(a, group)
  const cuts = root.entries[root.length - 1].record.cuts
  // The rejoin cut the retired writer at its length, so the diary's walk
  // froze it: a grant names the live writers only (#350).
  t.alike(cuts, [{ writer: second.key, seq: second.length }])
  const { entries } = await member.logRead(b)
  t.alike(groupLib.groupCutHistory(entries, group).map((m) => [m.writer, m.cut]), [[first.key, first.length]], 'the retired writer is fixed by the diary cut')
  t.absent(cuts.some((c) => c.seq === 0))
})

test('a join refuses before creating a writer when the own diary binds the per-diary writer cap', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Cheia', join: 'open' })
  await exchange(a, b)
  await member.communityJoin(b, { community: communityOfGroup.get(group) })
  for (let i = 0; i < groupLib.MAX_GROUP_WRITERS_PER_DIARY; i++) {
    await otherDevice(b, group, (i + 1).toString(16).padStart(32, '0'), [groupLib.groupLeave()])
  }
  const length = (await member.logRead(b)).entries.length
  const held = await heldWriters(b, group)
  await rejects(t, joinGroup(b, { group }), 'limite do grupo atingido')
  t.absent(store.readGroups(b.dataDir).some((g) => g.group === group), 'no local entry')
  t.is((await member.logRead(b)).entries.length, length, 'no diary join')
  t.is(await heldWriters(b, group), held, 'no new writer')
})

test('a pending leave refuses while the own diary binds another writer of the group', async (t) => {
  const { b, group } = await pendingPair(t)
  t.alike(await joinGroup(b, { group }), { state: 'pending' })
  await otherDevice(b, group, 'ab'.repeat(16))
  const before = (await member.logRead(b)).entries.length
  await rejects(t, member.groupLeave(b, { group }), 'aguarde a sincronização do grupo para sair')
  t.is((await member.logRead(b)).entries.length, before, 'no diary leave')
  t.is((await writerEntries(b, group)).length, 1, 'no leave record')
})

test('admission and grant cuts sit at the signed length, past blocks not downloaded', async (t) => {
  const { a, b, group } = await pair(t, 'approval')
  await offlineAppend(b, group, groupLib.groupPost({ text: 'um', at: AT }))
  await offlineAppend(b, group, groupLib.groupPost({ text: 'dois', at: AT }))
  await exchange(b, a)
  const bw = await writerEntries(b, group)
  const s = await store.openStore(a.dataDir)
  try {
    const replica = s.get({ key: b4a.from(bw.key, 'hex'), writable: false })
    await replica.ready()
    await replica.clear(2, 3)
    t.is(replica.contiguousLength, 2)
    t.is(replica.length, 3)
    await replica.close()
  } finally {
    await s.close()
  }
  t.alike(await member.groupAdmit(a, { group, member: b.key, on: true }), { ok: true })
  let root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.cuts, [{ writer: bw.key, seq: 3 }], 'admit cut at the signed length')
  t.alike(await member.groupAdmin(a, { group, member: b.key, on: true }), { ok: true })
  root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.cuts, [{ writer: bw.key, seq: 3 }], 'grant cut at the signed length')
  t.alike(await member.groupAdmin(a, { group, member: b.key, on: false }), { ok: true })
  root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.cuts, [{ writer: bw.key, seq: 2 }], 'a demotion keeps the contiguous length')
})
