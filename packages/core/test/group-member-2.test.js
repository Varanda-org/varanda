'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createModeratorCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { groupJoinRecord } = require('../lib/records')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, person, exchange, pair, writerEntries, offlineAppend, rejects, cwOf, communityFor, createGroup, joinGroup } = require('./helpers/group-member')

test('observed cuts and rejoin ignore writers rejected by the fold', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupPost(a, { group, text: 'not a leave' })
  await exchange(a, b)
  const before = await writerEntries(b, group)
  await member.groupLeave(b, { group })
  const left = await writerEntries(b, group)
  const s = await store.openStore(b.dataDir)
  let rejected
  try {
    const writer = await store.openGroupWriter(s, 'ef'.repeat(16))
    rejected = hex(writer.key)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    await store.appendRecord(writer, groupLib.writerHeader({ group, member: cwOf(b, group), diary: b.key, rejoin: { writer: group, seq: 1 } }), { validator })
    await store.appendRecord(writer, groupLib.groupLeave({ at: new Date(Date.now() + 60000).toISOString() }), { validator })
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: rejected, on: true }))
  } finally {
    await s.close()
  }
  t.alike(await joinGroup(b, { group }), { state: 'member' })
  const rejoined = await writerEntries(b, group)
  t.alike(rejoined.entries[0].record.rejoin, { writer: before.key, seq: left.length - 1 })
  await exchange(b, a)
  await member.groupBan(a, { group, member: b.key, on: true })
  const root = await writerEntries(a, group)
  const cuts = root.entries[root.length - 1].record.cuts
  t.alike(cuts.map((c) => c.writer), [before.key, rejoined.key].sort())
  t.absent(cuts.some((c) => c.writer === rejected))
})

test('unban ignores a later ban written beyond a demoted admin cut', async (t) => {
  const { a, b, group, kp } = await pair(t)
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await joinGroup(c, { group })
  await exchange(c, a)
  await member.groupAdmin(a, { group, member: c.key, on: true })
  await exchange(a, c)
  await member.groupBan(c, { group, member: b.key, on: true })
  const valid = await writerEntries(c, group)
  await exchange(c, a)
  await member.groupAdmin(a, { group, member: c.key, on: false })
  await member.groupBan(c, { group, member: b.key, on: true })
  await exchange(c, a)
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  const root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.lifts, { writer: valid.key, seq: valid.length - 1 })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member')
})

test('a diary that fails feed admission contributes no group posts', async (t) => {
  const a = await person(t, crypto.keyPair())
  const b = await person(t, crypto.keyPair(), 'Bia')
  const { group } = await createGroup(a, { name: 'Horta', join: 'open' })
  await exchange(a, b)
  // The community cannot bind here (its creator fails admission), so the join waits.
  await rejects(t, joinGroup(b, { group }), 'aguarde a sincronização da comunidade')
  await exchange(b, a)
  t.alike((await member.groupRead(a, { group })).items, [])
  t.alike((await member.groupMembers(a, { group })).members.map((m) => m.member), [a.key])
})

test('local join evidence flags a missing writer without blocking known posts', async (t) => {
  const { a, group, kp } = await pair(t)
  const c = await person(t, kp, 'Caio')
  await member.groupPost(a, { group, text: 'disponível' })
  const s = await store.openStore(c.dataDir)
  try {
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: 'f'.repeat(64), on: true }))
  } finally {
    await s.close()
  }
  await exchange(c, a)
  const result = await member.groupRead(a, { group })
  t.ok(result.incomplete)
  t.alike(result.items.map((p) => p.text), ['disponível'])
})

test('a post names the fold last node, including a rejoin at seq 0', async (t) => {
  const { b, group } = await pair(t)
  await member.groupLeave(b, { group })
  const left = await writerEntries(b, group)
  t.alike(await joinGroup(b, { group }), { state: 'member' })
  const again = await writerEntries(b, group)
  t.alike(again.entries[0].record.rejoin, { writer: left.key, seq: left.length - 1 })
  const posted = await member.groupPost(b, { group, text: 'voltei' })
  const after = await writerEntries(b, group)
  t.alike(after.entries[posted.seq].record.seen, { writer: again.key, seq: 0 })
})

test('an unban lifts the ban of a diary that has no local writer', async (t) => {
  const { a, group } = await pair(t)
  const stranger = 'ab'.repeat(32)
  t.alike(await member.groupBan(a, { group, member: stranger, on: true }), { ok: true })
  const banned = await writerEntries(a, group)
  const ban = banned.entries[banned.length - 1]
  t.is(ban.record.type, 'group-ban')
  t.absent((await member.groupMembers(a, { group })).members.some((m) => m.member === stranger))
  t.alike(await member.groupBan(a, { group, member: stranger, on: false }), { ok: true })
  const unban = (await writerEntries(a, group)).entries[banned.length]
  t.alike(unban.record.lifts, { writer: group, seq: ban.seq })
})

test('hiding an own post works after leaving and a non-object target is usage', async (t) => {
  const { a, b, group } = await pair(t)
  const { seq } = await member.groupPost(b, { group, text: 'meu' })
  const target = { writer: (await writerEntries(b, group)).key, seq }
  t.alike(await member.groupHide(b, { group, target, on: true }), { ok: true })
  await exchange(b, a)
  const other = await member.groupPost(a, { group, text: 'de Ana' })
  await exchange(a, b)
  await member.groupLeave(b, { group })
  t.alike(await member.groupHide(b, { group, target, on: false }), { ok: true })
  const left = await writerEntries(b, group)
  t.is(left.entries[left.length - 1].record.type, 'group-hide', 'written to the own bound writer that left')
  await rejects(t, member.groupHide(b, { group, target: { writer: group, seq: other.seq }, on: true }), 'sem permissão no grupo')
  await exchange(b, a)
  const read = await member.groupRead(a, { group })
  t.alike(read.items.map((p) => [p.text, p.hidden]), [['de Ana', false], ['meu', false]])
  await rejects(t, member.groupHide(a, { group, target: null, on: true }), 'sem permissão no grupo')
  await rejects(t, member.groupHide(a, { group, target: 'post', on: true }), 'sem permissão no grupo')
})

test('a cursor for a missing post keeps paging by causal order', async (t) => {
  const { a, b, group, kp } = await pair(t)
  const older = await offlineAppend(a, group, groupLib.groupPost({ text: 'antiga', at: '2026-01-01T00:00:00.000Z' }))
  await exchange(a, b)
  await offlineAppend(b, group, groupLib.groupPost({ text: 'nova', seen: older, at: '2026-01-02T00:00:00.000Z' }))
  await exchange(b, a)
  const page = await member.groupRead(a, { group, limit: 1 })
  t.is(page.items[0].text, 'nova')
  const shifted = { at: '2026-01-03T00:00:00.000Z', writer: page.next.writer, seq: page.next.seq }
  const anchored = await member.groupRead(a, { group, limit: 1, before: shifted })
  t.is(anchored.items[0].text, 'antiga')
  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 1, blocked: [b.key] }, mod, cert))
  const continued = await member.groupRead(a, { group, limit: 1, before: page.next })
  t.is(continued.items[0].text, 'antiga')
  t.is(continued.next, null)
})

test('a diary failure after the root append keeps the root nonce recorded', async (t) => {
  const ctx = await person(t, crypto.keyPair())
  const community = await communityFor(ctx)
  const realAppend = store.appendRecord
  store.appendRecord = async function (core, record, limits) {
    if (record && record.type === 'group-join') {
      store.appendRecord = realAppend
      throw new Error('falha de teste')
    }
    return realAppend(core, record, limits)
  }
  const memberPath = require.resolve('../lib/member')
  delete require.cache[memberPath]
  try {
    const fresh = require('../lib/member')
    await t.exception(() => fresh.groupCreate(ctx, { name: 'Horta', join: 'open', community }), /falha de teste/)
  } finally {
    store.appendRecord = realAppend
    delete require.cache[memberPath]
  }
  const data = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'groups.json'), 'utf8'))
  t.is(data.groups.length, 3)
  t.is(data.groups[2].writer, data.groups[2].group)
  t.ok(/^[0-9a-f]{32}$/.test(data.groups[2].nonce))
  const s = await store.openStore(ctx.dataDir)
  try {
    const writer = await store.openGroupWriter(s, data.groups[2].nonce)
    t.is(hex(writer.key), data.groups[2].group)
    t.ok(writer.writable)
    const seq = await store.appendRecord(writer, groupLib.groupPost({ text: 'ainda escreve' }), {
      validator: (r, n) => groupLib.validateGroupRecord(r, n, { root: true })
    })
    t.is(seq, 1)
  } finally {
    await s.close()
  }
  const { entries } = await member.logRead(ctx)
  t.is(entries.filter((e) => e.record && e.record.type === 'group-join').length, 2, 'only the community and Geral joins')
})

test('a leave from another device ends this device writer', async (t) => {
  const { b, group } = await pair(t)
  const posted = await member.groupPost(b, { group, text: 'oi' })
  const first = (await writerEntries(b, group)).key
  const target = { writer: first, seq: posted.seq }
  const s = await store.openStore(b.dataDir)
  let otherKey
  try {
    const writer = await store.openGroupWriter(s, 'cd'.repeat(16))
    otherKey = hex(writer.key)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    await store.appendRecord(writer, groupLib.writerHeader({ group, member: cwOf(b, group), diary: b.key }), { validator })
    await store.appendRecord(writer, groupLib.groupLeave(), { validator })
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: otherKey, on: true }))
  } finally {
    await s.close()
  }
  t.is((await member.groupInfo(b, { group })).state, 'left')
  await rejects(t, member.groupPost(b, { group, text: 'ainda' }), 'sem permissão no grupo')
  t.alike(await member.groupHide(b, { group, target, on: true }), { ok: true }, 'an author hide needs only a bound writer')
  const kept = { writer: await writerEntries(b, group), log: (await member.logRead(b)).entries.length }
  t.alike(await member.groupLeave(b, { group }), { state: 'left' }, 'left through another device: nothing written')
  t.alike({ writer: await writerEntries(b, group), log: (await member.logRead(b)).entries.length }, kept)
  t.alike(await joinGroup(b, { group }), { state: 'member' })
  const again = await writerEntries(b, group)
  t.not(again.key, first)
  t.alike(again.entries[0].record.rejoin, { writer: otherKey, seq: 1 })
  t.is((await member.groupPost(b, { group, text: 'voltei' })).seq, 1)
})
