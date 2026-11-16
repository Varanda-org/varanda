'use strict'

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createModeratorCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { groupJoinRecord } = require('../lib/records')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, person, exchange, pair, writerEntries, offlineAppend, rejects, communityOfGroup, FILL, cwOf, communityFor, createGroup, joinGroup } = require('./helpers/group-member')

test('a joined group left through another device gives way and leaving it again writes nothing', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group: joined } = await createGroup(b, { name: 'de Bia', join: 'open' })
  await exchange(b, a)
  await joinGroup(a, { group: joined })
  await communityFor(a)
  const s = await store.openStore(a.dataDir)
  try {
    const diary = await store.openDiary(s)
    const locals = store.readGroups(a.dataDir)
    const fill = 64 - locals.length
    for (let i = 1; i <= fill; i++) {
      const nonce = i.toString(16).padStart(32, '0')
      const writer = await store.openGroupWriter(s, nonce)
      const key = hex(writer.key)
      await store.appendRecord(writer, groupLib.groupHeader({ community: FILL, member: FILL, diary: a.key, name: 'Grupo ' + i }), {
        validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { root: true })
      })
      await store.appendRecord(diary, groupJoinRecord({ group: key, writer: key, on: true }))
      locals.push({ group: key, writer: key, nonce })
    }
    store.writeGroups(a.dataDir, locals)
    // Another device of Ana leaves the joined group.
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    const other = await store.openGroupWriter(s, 'cd'.repeat(16))
    await store.appendRecord(other, groupLib.writerHeader({ group: joined, member: cwOf(a, joined), diary: a.key }), { validator })
    await store.appendRecord(other, groupLib.groupLeave(), { validator })
    await store.appendRecord(diary, groupJoinRecord({ group: joined, writer: hex(other.key), on: true }))
  } finally {
    await s.close()
  }
  t.is((await member.groupInfo(a, { group: joined })).state, 'left')
  const kept = { writer: await writerEntries(a, joined), log: (await member.logRead(a)).entries.length }
  t.alike(await member.groupLeave(a, { group: joined }), { state: 'left' })
  t.alike({ writer: await writerEntries(a, joined), log: (await member.logRead(a)).entries.length }, kept, 'nothing written')
  const { group } = await createGroup(a, { name: 'cabe', join: 'open' })
  const groups = store.readGroups(a.dataDir)
  t.is(groups.length, 64)
  t.absent(groups.some((g) => g.group === joined), 'the group left elsewhere gave way')
  t.ok(groups.some((g) => g.group === group))
})

test('moderation orders after another device rejoin whose clock is ahead', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await exchange(a, b)
  const s = await store.openStore(b.dataDir)
  try {
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    const diary = await store.openDiary(s)
    const o1 = await store.openGroupWriter(s, 'c1'.repeat(16))
    await store.appendRecord(o1, groupLib.writerHeader({ group, member: cwOf(b, group), diary: b.key }), { validator })
    await store.appendRecord(o1, groupLib.groupLeave(), { validator })
    await store.appendRecord(diary, groupJoinRecord({ group, writer: hex(o1.key), on: true }))
    const ahead = new Date(Date.now() + 3600000).toISOString()
    const o2 = await store.openGroupWriter(s, 'c2'.repeat(16))
    await store.appendRecord(o2, groupLib.writerHeader({ group, member: cwOf(b, group), diary: b.key, rejoin: { writer: hex(o1.key), seq: 1 }, at: ahead }), { validator })
    await store.appendRecord(diary, groupJoinRecord({ group, writer: hex(o2.key), on: true }))
  } finally {
    await s.close()
  }
  t.is((await member.groupInfo(b, { group })).role, 'admin', 'the other device rejoined')
  const stranger = 'ab'.repeat(32)
  // The other device's leave retired this device's writer (its cuts omit
  // it): a new writer, and a new grant listing it, come first.
  await rejects(t, member.groupBan(b, { group, member: stranger, on: true }), 'sem permissão no grupo')
  t.alike(await joinGroup(b, { group }), { state: 'member' })
  await exchange(b, a)
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await exchange(a, b)
  t.alike(await member.groupBan(b, { group, member: stranger, on: true }), { ok: true })
  t.alike(await member.groupBan(b, { group, member: stranger, on: false }), { ok: true }, 'the ban took effect')
  const { entries } = await writerEntries(b, group)
  t.ok(entries[1].record.seen !== null, 'the ban names the fold last node')
})

test('a left joined group gives way and a created group never does', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group: joined } = await createGroup(b, { name: 'de Bia', join: 'open' })
  await exchange(b, a)
  await joinGroup(a, { group: joined })
  await communityFor(a)
  const joinedEntry = store.readGroups(a.dataDir).find((g) => g.group === joined)
  const s = await store.openStore(a.dataDir)
  const created = []
  try {
    const diary = await store.openDiary(s)
    const locals = store.readGroups(a.dataDir)
    const fill = 64 - locals.length
    for (let i = 1; i <= fill; i++) {
      const nonce = i.toString(16).padStart(32, '0')
      const writer = await store.openGroupWriter(s, nonce)
      const key = hex(writer.key)
      await store.appendRecord(writer, groupLib.groupHeader({ community: FILL, member: FILL, diary: a.key, name: 'Grupo ' + i }), {
        validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { root: true })
      })
      await store.appendRecord(diary, groupJoinRecord({ group: key, writer: key, on: true }))
      locals.push({ group: key, writer: key, nonce })
      created.push(key)
    }
    store.writeGroups(a.dataDir, locals)
  } finally {
    await s.close()
  }
  await rejects(t, createGroup(a, { name: 'demais', join: 'open' }), 'limite de grupos atingido')
  await member.groupLeave(a, { group: created[0] })
  await rejects(t, createGroup(a, { name: 'ainda não', join: 'open' }), 'limite de grupos atingido')
  t.ok(store.readGroups(a.dataDir).some((g) => g.group === created[0]))
  await member.groupLeave(a, { group: joined })
  const { group } = await createGroup(a, { name: 'cabe', join: 'open' })
  const groups = store.readGroups(a.dataDir)
  t.is(groups.length, 64)
  t.absent(groups.some((g) => g.group === joined))
  t.ok(groups.some((g) => g.group === created[0]))
  t.ok(groups.some((g) => g.group === group))
  const kept = await store.openStore(a.dataDir)
  try {
    const core = await store.openGroupWriter(kept, joinedEntry.nonce)
    t.is(hex(core.key), joinedEntry.writer)
    const entries = await store.readAll(core)
    t.is(entries[entries.length - 1].record.type, 'group-leave')
  } finally {
    await kept.close()
  }
})

test('a leave names the fold last node as seen', async (t) => {
  const { a, b, group } = await pair(t)
  const first = await member.groupPost(a, { group, text: 'oi' })
  await exchange(a, b)
  await member.groupLeave(b, { group })
  const left = await writerEntries(b, group)
  const leave = left.entries[left.length - 1].record
  t.is(leave.type, 'group-leave')
  t.alike(leave.seen, { writer: group, seq: first.seq })
})

test('a missing cursor pages by order key over the causal order, never by a count', async (t) => {
  const ctx = await person(t, crypto.keyPair())
  const { group } = await createGroup(ctx, { name: 'Horta', join: 'open' })
  // Same writer, so seq order: causal [cem, dez] while the clocks say dez < cem.
  await offlineAppend(ctx, group, groupLib.groupPost({ text: 'cem', at: '2026-01-03T00:00:00.000Z' }))
  await offlineAppend(ctx, group, groupLib.groupPost({ text: 'dez', at: '2026-01-01T00:00:00.000Z' }))
  const before = { at: '2026-01-02T00:00:00.000Z', writer: 'ab'.repeat(32), seq: 1 }
  const page = await member.groupRead(ctx, { group, before })
  t.alike(page.items.map((p) => p.text), ['dez'], 'only the post older than the cursor')
  t.is(page.next, null)
})

test('a diary banned before it had a writer cannot join and gets no writer', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Horta', join: 'open' })
  await member.groupBan(a, { group, member: b.key, on: true })
  await exchange(a, b)
  await rejects(t, joinGroup(b, { group }), 'sem permissão no grupo')
  t.absent(store.readGroups(b.dataDir).some((g) => g.group === group), 'no writer in the group')
  const { entries } = await member.logRead(b)
  t.absent(entries.some((e) => e.record && e.record.type === 'group-join' && e.record.group === group))
})

test('a banned diary cannot leave', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupBan(a, { group, member: b.key, on: true })
  await exchange(a, b)
  const before = await writerEntries(b, group)
  await rejects(t, member.groupLeave(b, { group }), 'sem permissão no grupo')
  t.alike(await writerEntries(b, group), before)
})

test('enforcing a group block makes the group unknown and keeps its cores', async (t) => {
  const { a, b, group, kp } = await pair(t)
  const { group: other } = await createGroup(a, { name: 'Outro', join: 'open' })
  const target = { writer: group, seq: (await member.groupPost(a, { group, text: 'oi' })).seq }
  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 1, blocked: [group] }, mod, cert))
  const ops = [
    () => member.groupRead(a, { group }),
    () => member.groupRead(a, { group: group.toUpperCase() }),
    () => member.groupInfo(a, { group }),
    () => member.groupMembers(a, { group }),
    () => member.groupRequests(a, { group }),
    () => joinGroup(a, { group }),
    () => member.groupLeave(a, { group }),
    () => member.groupPost(a, { group, text: 'não' }),
    () => member.groupHide(a, { group, target, on: true }),
    () => member.groupAdmit(a, { group, member: b.key, on: true }),
    () => member.groupBan(a, { group, member: b.key, on: true }),
    () => member.groupAdmin(a, { group, member: b.key, on: true }),
    () => member.groupMeta(a, { group, name: 'Outra' })
  ]
  for (const run of ops) await rejects(t, run(), 'grupo não encontrado', 'NOT_FOUND')
  const list = await member.groupList(a)
  t.alike(list.groups.map((g) => g.group).filter((g) => g === group || g === other), [other])
  t.is(list.total, 2, 'Geral and the other group')
  t.ok(store.readGroups(a.dataDir).some((g) => g.group === group), 'the local entry is kept')
  const s = await store.openStore(a.dataDir)
  try {
    t.ok(await store.replicaStored(s, group), 'the root core is kept')
  } finally {
    await s.close()
  }
})

test('join evidence comes from every followed diary held locally', async (t) => {
  const { a, group, kp } = await pair(t)
  const c = await person(t, kp, 'Caio')
  await member.groupPost(a, { group, text: 'disponível' })
  const s = await store.openStore(c.dataDir)
  try {
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: 'e'.repeat(64), on: true }))
  } finally {
    await s.close()
  }
  store.writeFollows(a.dataDir, [c.key])
  await exchange(c, a)
  const result = await member.groupRead(a, { group })
  t.ok(result.incomplete, 'a known join whose writer core has not arrived')
  t.alike(result.items.map((p) => p.text), ['disponível'])
})

test('an own writer beyond the writer cap refuses to post, hide, moderate or leave', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Cheia', join: 'open' })
  await exchange(a, b)
  await member.communityJoin(b, { community: communityOfGroup.get(group) })
  await exchange(b, a)
  // Other devices of Bia hold the lowest keys, so the cap counts them and
  // leaves out the writer this device lists.
  const s = await store.openStore(b.dataDir)
  let local
  let target
  try {
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    const cores = []
    for (let i = 0; i < groupLib.MAX_GROUP_WRITERS; i++) {
      const nonce = i.toString(16).padStart(32, '0')
      const writer = await store.openGroupWriter(s, nonce)
      await store.appendRecord(writer, groupLib.writerHeader({ group, member: cwOf(b, group), diary: b.key }), { validator })
      cores.push({ key: hex(writer.key), nonce, writer })
    }
    cores.sort((x, y) => x.key.localeCompare(y.key))
    target = { writer: cores[0].key, seq: await store.appendRecord(cores[0].writer, groupLib.groupPost({ text: 'meu' }), { validator }) }
    const diary = await store.openDiary(s)
    for (const c of cores) await store.appendRecord(diary, groupJoinRecord({ group, writer: c.key, on: true }))
    local = cores[cores.length - 1]
    store.writeGroups(b.dataDir, [...store.readGroups(b.dataDir), { group, writer: local.key, nonce: local.nonce }])
  } finally {
    await s.close()
  }
  // The grant lists Bia's bound counted writers, so the admin title holds.
  await exchange(b, a)
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await exchange(a, b)
  const info = await member.groupInfo(b, { group })
  t.is(info.state, 'member', 'the counted writers keep the diary a member')
  t.is(info.role, 'admin')
  const before = await writerEntries(b, group)
  t.is(before.key, local.key)
  await rejects(t, member.groupPost(b, { group, text: 'perdida' }), 'limite do grupo atingido')
  await rejects(t, member.groupHide(b, { group, target, on: true }), 'limite do grupo atingido')
  await rejects(t, member.groupBan(b, { group, member: 'ab'.repeat(32), on: true }), 'limite do grupo atingido')
  await rejects(t, member.groupLeave(b, { group }), 'limite do grupo atingido')
  t.alike(await writerEntries(b, group), before, 'nothing written to the uncounted writer')
  t.is((await member.groupInfo(b, { group })).state, 'member')
  const joins = (await member.logRead(b)).entries.length
  await rejects(t, joinGroup(b, { group }), 'limite do grupo atingido')
  t.alike(await writerEntries(b, group), before, 'a join never reports an uncounted writer as a member')
  t.is((await member.logRead(b)).entries.length, joins)
})
