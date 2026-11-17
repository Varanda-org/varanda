'use strict'

const fs = require('node:fs')
const test = require('brittle')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { leaveNoteFile, exchange, sync, coreEntries, entryOf, rejects, world, foldC, otherDevice, rootAppend, cutsOf, leaveThenReturn, finished } = require('./helpers/community-member')

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

// Every core `from` holds, copied into `to` block by block, only the blocks
// `from` holds: a block it cleared never reaches `to`.
async function copyHeld (from, to) {
  const a = await store.openStore(from.dataDir)
  const b = await store.openStore(to.dataDir)
  let left
  let right
  try {
    const copies = []
    for await (const dk of a.list()) {
      const source = a.get({ discoveryKey: dk, writable: false })
      await source.ready()
      const target = b.get({ key: source.key, writable: false })
      await target.ready()
      copies.push({ source, target })
    }
    left = a.replicate(true)
    right = b.replicate(false)
    left.pipe(right).pipe(left)
    for (const { source, target } of copies) {
      for (let seq = 0; seq < source.length; seq++) {
        if (await source.has(seq)) await target.get(seq, { raw: true, timeout: 10000 })
      }
    }
  } finally {
    if (left) left.destroy()
    if (right) right.destroy()
    await b.close()
    await a.close()
  }
}

async function holds (ctx, key, seq) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = s.get({ key: Buffer.from(key, 'hex'), writable: false })
    await core.ready()
    return await core.has(seq)
  } finally {
    await s.close()
  }
}

// The root cut of group `group` as the fold of `ctx` computes it (null: the
// root keeps its authority).
async function rootCutOf (ctx, group) {
  const real = groupLib.buildGroup
  let cut
  groupLib.buildGroup = (input, ...rest) => {
    const view = real(input, ...rest)
    if (input && input.root && input.root.key === group) cut = view.rootCut
    return view
  }
  try {
    await member.groupInfo(ctx, { group })
  } finally {
    groupLib.buildGroup = real
  }
  return cut
}

test('a deleted post of the creator diary that one replica read and another never did leaves both with the same G root', async (t) => {
  const { a, others: [b, c], community } = await world(t)
  const { group: horta } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  const { seq } = await member.postCreate(a, { text: 'apagado' })
  await sync(a, c)
  await member.postDelete(a, { to: { author: a.key, seq } })
  t.alike(await member.communityLeave(a, { community }), { state: 'left' })
  await copyHeld(a, b)
  await copyHeld(a, c)
  t.absent(await holds(b, a.key, seq), 'fixture: B never read the deleted post')
  t.ok(await holds(b, a.key, seq + 1), 'fixture: B holds its tombstone')
  t.ok(await holds(c, a.key, seq), 'fixture: C read the deleted post')
  const cb = await rootCutOf(b, horta)
  const cc = await rootCutOf(c, horta)
  t.ok(Number.isSafeInteger(cc) && cc > 0, 'C reads the mark the leave wrote')
  t.is(cb, cc, 'B reaches the same root cut')
})
