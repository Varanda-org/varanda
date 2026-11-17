'use strict'

// #350, the clients part: the core node joins by its own diary's slot walk
// and cuts the writer it replaces before the new join.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { groupJoinRecord, groupCutRecord } = require('../lib/records')
const { hex, person, exchange, sync, coreEntries, entryOf, rejects, world, otherDevice, joinGroup } = require('./helpers/community-member')

const MAX = groupLib.MAX_GROUP_WRITERS_PER_DIARY

// Appends diary records of `ctx` with no other check.
async function diaryAppend (ctx, records) {
  await member.withIdentity(ctx, async ({ diary }) => {
    for (const r of records) await store.appendRecord(diary, r)
  })
}

// A writer of `group` of another device of `ctx`, bound by its diary.
let nonces = 0
function sibling (ctx, group, cw) {
  const nonce = (++nonces).toString(16).padStart(32, '0')
  return otherDevice(ctx, group, nonce, groupLib.writerHeader({ group, diary: ctx.key, member: cw }))
}

async function ownWalk (ctx, group) {
  const { entries } = await member.logRead(ctx)
  return { entries, walk: groupLib.slotWalk(groupLib.groupJoinHistory(entries, group), groupLib.groupCutHistory(entries, group), group) }
}

const indexOf = (entries, type, writer) => entries.findIndex((e) => e.record && e.record.type === type && e.record.writer === writer)

test('a rejoin after a leave cuts the retired writer at its length before the new join, so the new one counts at the cap', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await sync(a, b)
  t.is((await joinGroup(b, group)).state, 'member')
  await member.groupPost(b, { group, text: 'oi' })
  const w1 = entryOf(b, group).writer
  const cw = entryOf(b, community).writer
  for (let i = 1; i < MAX; i++) await sibling(b, group, cw)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const held = (await coreEntries(b, w1)).length
  t.is(held, 3, 'header, post and leave')
  t.is((await joinGroup(b, group)).state, 'member')
  const w2 = entryOf(b, group).writer
  t.not(w2, w1, 'a new writer')
  const { entries, walk } = await ownWalk(b, group)
  t.alike(groupLib.groupCutHistory(entries, group).map((m) => [m.writer, m.cut]), [[w1, held]], 'one cut, at the length this device holds')
  t.alike(groupLib.groupJoinHistory(entries, group).filter((j) => j.writer === w1).map((j) => j.on), [true, false], 'the leave already wrote the off join')
  t.ok(indexOf(entries, 'group-cut', w1) < indexOf(entries, 'group-join', w2), 'the cut comes before the new join')
  t.ok(walk.frozen.has(w1), 'the retired writer is frozen')
  t.ok(walk.live.has(w2), 'the new one is live')
  t.is(walk.live.size, MAX)
  await sync(a, b)
  const posts = (await member.groupRead(a, { group })).items.map((p) => p.text)
  t.ok(posts.includes('oi'), 'the post below the cut still counts')
})

test('with no frozen room left, a rejoin after a leave gets GROUP_FULL with nothing written', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await sync(a, b)
  const cw = entryOf(b, community).writer
  // Eight writers of other devices, all frozen: the frozen reserve is spent.
  const old = []
  for (let i = 0; i < groupLib.MAX_FROZEN_WRITERS_PER_DIARY; i++) old.push(await sibling(b, group, cw))
  await diaryAppend(b, old.map((writer) => groupCutRecord({ group, writer, cut: 1 })))
  t.is((await joinGroup(b, group)).state, 'member')
  const w1 = entryOf(b, group).writer
  for (let i = 1; i < MAX; i++) await sibling(b, group, cw)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const before = (await member.logRead(b)).entries.length
  await rejects(t, joinGroup(b, group), 'limite do grupo atingido')
  const { entries, walk } = await ownWalk(b, group)
  t.is(entries.length, before, 'no cut, no new join')
  t.is(entryOf(b, group).writer, w1, 'no new writer either')
  t.ok(walk.live.has(w1), 'the retired writer keeps its slot')
})

test('a group rejoin after the CW was retired cuts a header-only writer at 0, after its off join', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await sync(a, b)
  t.is((await joinGroup(b, group)).state, 'member')
  const w1 = entryOf(b, group).writer
  const cw1 = entryOf(b, community).writer
  // Another device of Bia leaves the community, listing this CW: the gate
  // retires it, and the group writer naming it.
  await otherDevice(b, community, 'f2'.repeat(16), groupLib.writerHeader({ group: community, diary: b.key }), [
    (key) => groupLib.groupLeave({ cuts: [{ writer: cw1, seq: 1 }, { writer: key, seq: 1 }].sort((x, y) => x.writer.localeCompare(y.writer)) })
  ], true)
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  t.is((await coreEntries(b, w1)).length, 1, 'the group writer holds its header only')
  await joinGroup(b, group)
  const w2 = entryOf(b, group).writer
  t.not(w2, w1, 'a new writer naming the new CW')
  const { entries, walk } = await ownWalk(b, group)
  t.alike(groupLib.groupJoinHistory(entries, group).filter((j) => j.writer === w1).map((j) => j.on), [true, false], 'the off join is still written')
  t.alike(groupLib.groupCutHistory(entries, group).map((m) => [m.writer, m.cut]), [[w1, 0]], 'a header with no rejoin is cut at 0')
  const off = entries.findIndex((e) => e.record && e.record.type === 'group-join' && e.record.writer === w1 && e.record.on === false)
  t.ok(off < indexOf(entries, 'group-cut', w1), 'off join, then the cut')
  t.ok(indexOf(entries, 'group-cut', w1) < indexOf(entries, 'group-join', w2), 'then the new join')
  t.ok(walk.released.has(w1) && walk.live.has(w2), 'the old writer is released, the new one live')
})

test('community.join counts the own diary\'s slot walk, not the CWs held: COMMUNITY_FULL with nothing written', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const c = await person(t, kp, 'Caio')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  await exchange(a, c)
  // Eight CWs of other devices this node never held take every live slot.
  await diaryAppend(c, Array.from({ length: MAX }, () => groupJoinRecord({ group: community, writer: hex(crypto.randomBytes(32)), on: true })))
  const before = (await member.logRead(c)).entries.length
  await rejects(t, member.communityJoin(c, { community }), 'limite da comunidade atingido')
  t.is((await member.logRead(c)).entries.length, before, 'no CW bound')
  t.absent(entryOf(c, community), 'no CW made')
})

test('community.join takes a slot a cut freed in the own diary\'s walk', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const c = await person(t, kp, 'Caio')
  const { community, group: geral } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  await exchange(a, c)
  const ws = Array.from({ length: MAX }, () => hex(crypto.randomBytes(32)))
  await diaryAppend(c, ws.map((writer) => groupJoinRecord({ group: community, writer, on: true })))
  await diaryAppend(c, [groupCutRecord({ group: community, writer: ws[0], cut: 0 })])
  t.alike(await member.communityJoin(c, { community }), { state: 'member', group: geral })
  const { walk } = await ownWalk(c, community)
  t.ok(walk.live.has(entryOf(c, community).writer), 'the new CW is live')
})

// A CW of another device of `ctx` in community `community`, held here and
// bound by its diary.
function siblingCw (ctx, community) {
  const nonce = (++nonces).toString(16).padStart(32, '0')
  return otherDevice(ctx, community, nonce, groupLib.writerHeader({ group: community, diary: ctx.key, member: null }), [], true)
}

test('a community rejoin after a leave cuts the retired CW at its length before the new join, and takes its slot (#350)', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const c = await person(t, kp, 'Caio')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  await exchange(a, c)
  await member.communityJoin(c, { community })
  const old = entryOf(c, community).writer
  // Seven CWs of other devices of the diary: every live slot is taken.
  for (let i = 0; i < MAX - 1; i++) await siblingCw(c, community)
  await member.communityLeave(c, { community })
  const held = (await coreEntries(c, old)).length
  t.ok(held >= 2, 'the old CW holds its header and its leave')
  t.is((await member.communityJoin(c, { community })).state, 'member')
  const now = entryOf(c, community).writer
  t.not(now, old, 'a new CW')
  const { entries, walk } = await ownWalk(c, community)
  const cuts = groupLib.groupCutHistory(entries, community).filter((m) => m.writer === old)
  t.alike(cuts.map((m) => m.cut), [held], 'the old CW is cut once, at its length')
  const join = entries.findIndex((e) => e.record && e.record.type === 'group-join' && e.record.writer === now && e.record.on)
  t.ok(indexOf(entries, 'group-cut', old) < join, 'the cut comes before the new join')
  t.ok(walk.frozen.has(old), 'the old CW is frozen')
  t.ok(walk.live.has(now), 'the new CW is live')
})

test('a community rejoin after another device left plans the cut past the leave it writes on the own CW (#350)', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const c = await person(t, kp, 'Caio')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  await exchange(a, c)
  // Every release is spent (each join released before the next, so all of
  // them count), so only a cut past 0 frees a slot: one planned at 0 for the
  // header-only CW would refuse the join.
  const released = Array.from({ length: groupLib.MAX_WRITER_RELEASES_PER_DIARY }, () => hex(crypto.randomBytes(32)))
  await diaryAppend(c, released.flatMap((writer) => [
    groupJoinRecord({ group: community, writer, on: true }),
    groupCutRecord({ group: community, writer, cut: 0 })
  ]))
  t.is((await ownWalk(c, community)).walk.released.size, groupLib.MAX_WRITER_RELEASES_PER_DIARY, 'every release spent')
  await member.communityJoin(c, { community })
  const old = entryOf(c, community).writer
  t.is((await coreEntries(c, old)).length, 1, 'the own CW holds its header only')
  const sibs = []
  for (let i = 0; i < MAX - 2; i++) sibs.push(await siblingCw(c, community))
  // The eighth CW, of another device, leaves for the diary.
  const nonce = (++nonces).toString(16).padStart(32, '0')
  await otherDevice(c, community, nonce, groupLib.writerHeader({ group: community, diary: c.key, member: null }), [
    (key) => groupLib.groupLeave({ cuts: [old, ...sibs, key].map((writer) => ({ writer, seq: 1 })).sort((x, y) => x.writer.localeCompare(y.writer)) })
  ], true)
  t.is((await member.communityJoin(c, { community })).state, 'member')
  const now = entryOf(c, community).writer
  const entries = await coreEntries(c, old)
  t.alike(entries.map((e) => e.record.type), ['group-writer', 'group-leave'], 'the join wrote a leave on the own CW first')
  const { entries: log, walk } = await ownWalk(c, community)
  t.alike(groupLib.groupCutHistory(log, community).filter((m) => m.writer === old).map((m) => m.cut), [2], 'then the cut, past that leave')
  t.ok(walk.frozen.has(old), 'the old CW is frozen')
  t.ok(walk.live.has(now), 'the new CW is live')
})

test('with no frozen room left, a community rejoin after a leave gets COMMUNITY_FULL with nothing written (#350)', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const c = await person(t, kp, 'Caio')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  await exchange(a, c)
  // Eight CWs of other devices this node never held, cut past 0: the frozen
  // reserve is spent.
  const frozen = Array.from({ length: groupLib.MAX_FROZEN_WRITERS_PER_DIARY }, () => hex(crypto.randomBytes(32)))
  await diaryAppend(c, [
    ...frozen.map((writer) => groupJoinRecord({ group: community, writer, on: true })),
    ...frozen.map((writer) => groupCutRecord({ group: community, writer, cut: 1 }))
  ])
  await member.communityJoin(c, { community })
  for (let i = 0; i < MAX - 1; i++) await siblingCw(c, community)
  await member.communityLeave(c, { community })
  const before = (await member.logRead(c)).entries.length
  const old = entryOf(c, community).writer
  await rejects(t, member.communityJoin(c, { community }), 'limite da comunidade atingido')
  t.is((await member.logRead(c)).entries.length, before, 'nothing written')
  t.is(entryOf(c, community).writer, old, 'no new CW')
})

test('a rejoin repeats the cut on a retired writer a mark left live, once the walk has room to freeze it (#350)', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await sync(a, b)
  const cw = entryOf(b, community).writer
  const old = []
  for (let i = 0; i < groupLib.MAX_FROZEN_WRITERS_PER_DIARY; i++) old.push(await sibling(b, group, cw))
  await diaryAppend(b, old.map((writer) => groupCutRecord({ group, writer, cut: 1 })))
  t.is((await joinGroup(b, group)).state, 'member')
  const w1 = entryOf(b, group).writer
  for (let i = 1; i < MAX; i++) await sibling(b, group, cw)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const held = (await coreEntries(b, w1)).length
  // With a device id, a mark on its own writer does not read as a
  // disconnect of this device.
  await member.deviceHello(b, { name: 'Celular' })
  // A mark written while the frozen reserve was spent leaves the writer
  // live; then a frozen writer is released, so the reserve has room again.
  await diaryAppend(b, [groupCutRecord({ group, writer: w1, cut: held }), groupCutRecord({ group, writer: old[0], cut: 0 })])
  t.ok((await ownWalk(b, group)).walk.live.has(w1), 'the mark alone left the retired writer live')
  t.is((await joinGroup(b, group)).state, 'member')
  const w2 = entryOf(b, group).writer
  t.not(w2, w1, 'a new writer')
  const { entries, walk } = await ownWalk(b, group)
  t.alike(groupLib.groupCutHistory(entries, group).filter((m) => m.writer === w1).map((m) => m.cut), [held, held], 'the cut is written again, at the same seq')
  t.ok(indexOf(entries, 'group-join', w2) > entries.map((e) => e.record && e.record.type === 'group-cut' && e.record.writer === w1).lastIndexOf(true), 'the new join comes after it')
  t.ok(walk.frozen.has(w1), 'the walk freezes the retired writer now')
  t.ok(walk.live.has(w2), 'the new one is live')
})
