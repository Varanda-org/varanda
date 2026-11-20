'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { groupJoinRecord } = require('../lib/records')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, AT, person, exchange, pair, writerEntries, offlineAppend, rejects, communityFor, createGroup, joinGroup, groupJoins, bindElsewhere, otherWriter } = require('./helpers/group-member')

test('an unban cuts a writer at its signed length, past blocks not downloaded', async (t) => {
  const { a, b, group } = await pair(t, 'approval')
  await offlineAppend(b, group, groupLib.groupPost({ text: 'um', at: AT }))
  await offlineAppend(b, group, groupLib.groupPost({ text: 'dois', at: AT }))
  await exchange(b, a)
  const bw = await writerEntries(b, group)
  t.alike(await member.groupAdmit(a, { group, member: b.key, on: true }), { ok: true })
  t.alike(await member.groupBan(a, { group, member: b.key, on: true }), { ok: true })
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
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  const root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.cuts, [{ writer: bw.key, seq: 3 }], 'unban cut at the signed length')
})

test('a member leaves at once while another device of the diary bound a writer not held here', async (t) => {
  const { b, group } = await pair(t)
  await bindElsewhere(b, group, 'cd'.repeat(32))
  const own = await writerEntries(b, group)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const left = await writerEntries(b, group)
  const leave = left.entries[left.length - 1].record
  t.is(leave.type, 'group-leave')
  t.alike(leave.cuts, [{ writer: own.key, seq: own.length }], 'cuts name the held counted writers')
})

test('a creator leaves from a device that holds the root without its key, and the leave lists the root', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  // A root written elsewhere naming Bia as creator: her diary binds it, but
  // this device cannot write it.
  const bc = await communityFor(b)
  const s = await store.openStore(a.dataDir)
  let group
  try {
    const root = await store.openGroupWriter(s, 'ef'.repeat(16))
    group = hex(root.key)
    await store.appendRecord(root, groupLib.groupHeader({ community: bc, member: bc, diary: b.key, name: 'Horta', join: 'open' }), { validator: (r) => groupLib.validateGroupHeader(r) })
  } finally {
    await s.close()
  }
  await exchange(a, b)
  await bindElsewhere(b, group, group)
  // Bia's community lists the group (the create sits in its root, her CW).
  const bs = await store.openStore(b.dataDir)
  try {
    const croot = await store.openGroupWriter(bs, store.readGroups(b.dataDir).find((g) => g.group === bc).nonce)
    await store.appendRecord(croot, groupLib.groupCreateRecord({ group }), { validator: (r, n) => groupLib.validateGroupRecord(r, n, { root: true, community: true }) })
  } finally {
    await bs.close()
  }
  t.alike(await joinGroup(b, { group }), { state: 'member' })
  t.is((await member.groupInfo(b, { group })).role, 'creator')
  const own = await writerEntries(b, group)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const left = await writerEntries(b, group)
  t.alike(left.entries[left.length - 1].record.cuts, [{ writer: group, seq: 1 }, { writer: own.key, seq: own.length }].sort((x, y) => x.writer.localeCompare(y.writer)))
})

test('an admit refuses while the member diary binds a writer not held here', async (t) => {
  const { a, b, group } = await pair(t, 'approval')
  await bindElsewhere(b, group, 'cd'.repeat(32))
  await exchange(b, a)
  const before = (await writerEntries(a, group)).length
  await rejects(t, member.groupAdmit(a, { group, member: b.key, on: true }), 'aguarde a sincronização do grupo para admitir')
  t.is((await writerEntries(a, group)).length, before, 'nothing written')
})

test('an admitted member\'s writer the admit did not list is covered by it, and a new admit lists it', async (t) => {
  const { a, b, group } = await pair(t, 'approval')
  const first = (await writerEntries(b, group)).key
  t.alike(await member.groupAdmit(a, { group, member: b.key, on: true }), { ok: true })
  const second = await otherWriter(b, group, 'ab'.repeat(16), 1)
  await exchange(b, a)
  t.is((await member.groupRead(a, { group })).items.filter((p) => !p.hidden).length, 1, 'the new device posts under the admission')
  t.is((await member.groupRequests(a, { group })).total, 0, 'no request for the new device')
  t.alike(await member.groupAdmit(a, { group, member: b.key, on: true }), { ok: true })
  const root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.cuts.map((c) => c.writer), [first, second].sort())
  t.is((await member.groupRequests(a, { group })).total, 0)
})

test('an unban that missed a writer can be repeated citing the same ban', async (t) => {
  const { a, b, group } = await pair(t)
  t.alike(await member.groupBan(a, { group, member: b.key, on: true }), { ok: true })
  const ban = (await writerEntries(a, group)).length - 1
  const second = await otherWriter(b, group, 'ab'.repeat(16), 1)
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true }, 'an unban before the second writer arrives')
  await exchange(b, a)
  t.alike((await member.groupRead(a, { group })).items.map((p) => p.hidden), [true], 'the unlisted writer stays banned')
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  const root = await writerEntries(a, group)
  const unban = root.entries[root.length - 1].record
  t.alike(unban.lifts, { writer: group, seq: ban })
  t.ok(unban.cuts.some((c) => c.writer === second), 'the new unban lists the writer')
  await rejects(t, member.groupBan(a, { group, member: b.key, on: false }), 'nada a alterar')
})

test('a member whose unban missed another writer leaves from a writer that is not banned, and still cannot join', async (t) => {
  const { a, b, group } = await pair(t)
  t.alike(await member.groupBan(a, { group, member: b.key, on: true }), { ok: true })
  await otherWriter(b, group, 'ab'.repeat(16), 1)
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  await exchange(b, a)
  await exchange(a, b)
  const view = await member.groupInfo(b, { group })
  t.is(view.state, 'member')
  await rejects(t, joinGroup(b, { group }), 'sem permissão no grupo')
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  t.is((await member.groupInfo(b, { group })).state, 'left')
})

test('a member whose own writer an unban missed can still leave', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Horta', join: 'open' })
  await exchange(a, b)
  await joinGroup(b, { group })
  // Ban and unban before Bia's writer arrives: the unban lists none of hers.
  t.alike(await member.groupBan(a, { group, member: b.key, on: true }), { ok: true })
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member')
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  t.is((await member.groupInfo(b, { group })).state, 'left')
})

test('a joined root this node never folds keeps no slot: leaving drops its entry', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const s = await store.openStore(a.dataDir)
  let group
  try {
    const root = await store.openGroupWriter(s, 'ef'.repeat(16))
    group = hex(root.key)
    await store.appendRecord(root, groupLib.groupHeader({ kind: 'community', diary: a.key, name: 'Comunidade', join: 'open' }), { validator: (r) => groupLib.validateGroupHeader(r) })
    await store.appendRecord(await store.openDiary(s), groupJoinRecord({ group, writer: group, on: true }))
  } finally {
    await s.close()
  }
  const bc = await communityFor(b)
  t.alike(await member.groupJoin(b, { group, community: bc }), { state: 'pending' })
  await exchange(a, b)
  const writer = await writerEntries(b, group)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  t.absent(store.readGroups(b.dataDir).some((g) => g.group === group), 'the entry is gone')
  const s2 = await store.openStore(b.dataDir)
  try {
    const core = s2.get({ key: b4a.from(writer.key, 'hex'), valueEncoding: 'json' })
    await core.ready()
    const entries = await store.readAll(core)
    t.is(entries[entries.length - 1].record.type, 'group-leave', 'the writer holds a leave')
    await core.close()
  } finally {
    await s2.close()
  }
  t.alike((await groupJoins(b, group)).map((j) => j.on), [true, false], 'the diary turns the writer off')
})
