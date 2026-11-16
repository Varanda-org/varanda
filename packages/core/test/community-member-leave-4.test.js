'use strict'

const fs = require('node:fs')
const test = require('brittle')
const crypto = require('hypercore-crypto')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, leaveNoteFile, exchange, sync, coreEntries, entryOf, rejects, world, leavesOn, texts, otherDevice, rootAppend, deleteOn, cutsOf } = require('./helpers/community-member')

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
