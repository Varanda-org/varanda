'use strict'

const test = require('brittle')
const crypto = require('hypercore-crypto')
const store = require('../lib/store')
const member = require('../lib/member')
const groupLib = require('../lib/group')
const { hex, person, communityOfGroup, createGroup, joinGroup, exchange, rootEntries, plantWriter, ownWriter, texts, privateGroup } = require('./helpers/private-member')

test('private: a recipient box sodium refuses is skipped, never failing rotation or history', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await plantWriter(c, group, '00'.repeat(32), true)
  await exchange(c, a)
  // The fold refuses a low-order box as an invalid header, so that writer
  // is never held or entitled; the per-recipient skip stays as a guard.
  await t.exception(member.groupAdmit(a, { group, member: c.key, on: true }), /aguarde a sincronização/)
  await member.groupPost(a, { group, text: 'antes' })
  const r = await member.groupRekey(a, { group })
  t.ok(r.epoch, 'group.rekey succeeds')
  await member.groupPost(a, { group, text: 'depois' })
  await exchange(a, b)
  const read = await member.groupRead(b, { group })
  t.alike(texts(read), ['antes', 'depois'], 'the other recipients still get the keys')
  t.is((await member.groupRead(a, { group })).state, 'ok')
})

test('private: fake bans from an unadmitted writer never inflate a rotation', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await joinGroup(c, { group })
  const s = await store.openStore(c.dataDir)
  try {
    const local = store.readGroups(c.dataDir).find((g) => g.group === group)
    const writer = await store.openGroupWriter(s, local.nonce)
    const target = hex(crypto.randomBytes(32))
    for (let i = 0; i < 5000; i++) {
      await store.appendRecord(writer, groupLib.groupBan({ member: target, on: true, cuts: [] }), { validator: () => null })
    }
  } finally {
    await s.close()
  }
  await exchange(c, a)
  const firsts = async () => (await rootEntries(a, group)).filter((e) => e.seq >= 1 && e.record.type === 'group-key' && e.record.kid === null)
  const before = (await firsts()).length
  await member.groupBan(a, { group, member: b.key, on: true })
  const after = await firsts()
  t.is(after.length, before + 1, 'exactly one new epoch')
  t.ok(after[after.length - 1].record.basis.length <= 2, 'basis from the fold removals only')
  t.is((await member.groupRead(a, { group })).state, 'ok')
})

test('private: an own writer created but never bound is rebound, not replaced', async (t) => {
  const { kp, a, group } = await privateGroup(t)
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await member.communityJoin(c, { community: communityOfGroup.get(group) })
  const box = hex(store.ensureBoxKeyPair(c.dataDir).publicKey)
  const writer = await plantWriter(c, group, box, false)
  t.alike(await joinGroup(c, { group }), { state: 'requested' })
  t.is(ownWriter(c, group), writer, 'same writer kept in groups.json')
  const { entries } = await member.logRead(c)
  t.alike(groupLib.groupJoinHistory(entries, group).map((j) => [j.writer, j.on]), [[writer, true]], 'bound once')
})

test('private: a join by key before the root arrives is replaced by a writer with a box', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  // b holds the community, not the group root.
  await exchange(a, b)
  const s = await store.openStore(b.dataDir)
  await store.purgeReplica(s, group)
  await s.close()
  t.alike(await joinGroup(b, { group }), { state: 'pending' })
  const boxless = ownWriter(b, group)
  await exchange(a, b)
  t.alike(await joinGroup(b, { group }), { state: 'requested' })
  t.not(ownWriter(b, group), boxless, 'a new writer')
  const { entries } = await member.logRead(b)
  t.alike(groupLib.groupJoinHistory(entries, group).filter((j) => j.writer === boxless).map((j) => j.on), [true, false], 'boxless writer unbound')
  // Seeders and sync never carry a boxless writer of a private group.
  await exchange(b, a, new Set([boxless]))
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await member.groupPost(a, { group, text: 'bem-vinda' })
  await exchange(a, b)
  t.alike(texts(await member.groupRead(b, { group })), ['bem-vinda'])
})

test('private: at the writer cap a boxed rejoin cuts the boxless writer, so the new one counts (#350)', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  await exchange(a, b)
  const s = await store.openStore(b.dataDir)
  await store.purgeReplica(s, group)
  await s.close()
  t.alike(await joinGroup(b, { group }), { state: 'pending' })
  const local = store.readGroups(b.dataDir).find((g) => g.group === group)
  const boxless = local.writer
  for (let i = 1; i < groupLib.MAX_GROUP_WRITERS_PER_DIARY; i++) await plantWriter(b, group, hex(crypto.randomBytes(32)), true)
  store.writeGroups(b.dataDir, [...store.readGroups(b.dataDir).filter((g) => g.group !== group), local])
  await exchange(a, b)
  t.alike(await joinGroup(b, { group }), { state: 'requested' })
  const fresh = ownWriter(b, group)
  t.not(fresh, boxless, 'a new writer')
  const { entries } = await member.logRead(b)
  t.alike(groupLib.groupCutHistory(entries, group).filter((m) => m.writer === boxless).map((m) => m.cut), [0], 'the header-only boxless writer is cut at 0')
  const cutAt = entries.findIndex((e) => e.record && e.record.type === 'group-cut' && e.record.writer === boxless)
  const joinAt = entries.findIndex((e) => e.record && e.record.type === 'group-join' && e.record.writer === fresh)
  t.ok(cutAt !== -1 && cutAt < joinAt, 'the cut comes before the new join')
  t.alike(await joinGroup(b, { group }), { state: 'requested' }, 'joining again writes no other cut')
  const again = await member.logRead(b)
  t.is(groupLib.groupCutHistory(again.entries, group).filter((m) => m.writer === boxless).length, 1)
  const walk = groupLib.slotWalk(groupLib.groupJoinHistory(again.entries, group), groupLib.groupCutHistory(again.entries, group), group)
  t.ok(walk.released.has(boxless) && walk.live.has(fresh), 'the slot walk releases the boxless writer and counts the new one')
})

test('private: a full diary whose boxless writer never counted gets GROUP_FULL with nothing written (#350)', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  await exchange(a, b)
  const s = await store.openStore(b.dataDir)
  await store.purgeReplica(s, group)
  await s.close()
  // Eight writers boxed to another key take every slot first.
  for (let i = 0; i < groupLib.MAX_GROUP_WRITERS_PER_DIARY; i++) await plantWriter(b, group, hex(crypto.randomBytes(32)), true)
  store.writeGroups(b.dataDir, store.readGroups(b.dataDir).filter((g) => g.group !== group))
  // The join by key binds a ninth, boxless writer the walk never counts.
  t.alike(await joinGroup(b, { group }), { state: 'pending' })
  const boxless = ownWriter(b, group)
  await exchange(a, b)
  const before = (await member.logRead(b)).entries.length
  await t.exception(joinGroup(b, { group }), /limite do grupo atingido/, 'no slot even after cutting the boxless writer')
  const { entries } = await member.logRead(b)
  t.is(entries.length, before, 'nothing written: no off join, no cut, no new join')
  t.alike(groupLib.groupCutHistory(entries, group), [])
  t.is(ownWriter(b, group), boxless, 'the boxless writer is still the local one')
})

test('private: a multi-chunk rotation seals earlier epochs to the distributor only, the last to every entitled writer', async (t) => {
  // MAX_KEY_BASIS + 1 people each join the community, Geral and the group:
  // about 15 s alone, more under the parallel suite.
  t.timeout(120000)
  const { kp, a, b, group } = await privateGroup(t)
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await joinGroup(c, { group })
  await exchange(c, a)
  const leavers = []
  for (let i = 0; i <= groupLib.MAX_KEY_BASIS; i++) {
    const x = await person(t, kp, 'Pessoa ' + i)
    await exchange(a, x)
    await joinGroup(x, { group })
    await exchange(x, a)
    leavers.push(x)
  }
  for (const x of [b, c, ...leavers]) await member.groupAdmit(a, { group, member: x.key, on: true })
  // One leave per writer core: more uncovered removals than one basis holds.
  for (const x of leavers) {
    await exchange(a, x)
    await member.groupLeave(x, { group })
    await exchange(x, a)
  }
  t.is((await member.groupRead(a, { group })).state, 'rekey-pending')
  const from = (await rootEntries(a, group)).length
  const { epoch } = await member.groupRekey(a, { group })
  t.is(epoch.writer, group, 'the creator rotates on the root')
  const firsts = (await rootEntries(a, group)).filter((e) => e.seq >= from && e.record.type === 'group-key' && e.record.kid === null)
  t.is(firsts.length, 2, 'two basis chunks, two epochs')
  t.alike(firsts[0].record.keys.map((k) => k.writer), [group], 'the earlier epoch only to the distributor')
  t.alike(firsts[1].record.keys.map((k) => k.writer).sort(), [group, ownWriter(b, group), ownWriter(c, group)].sort(), 'the last epoch to every entitled writer')
  t.is(firsts[1].seq, epoch.seq)
  await exchange(a, b)
  await member.groupPost(b, { group, text: 'sob a última chave' })
  await exchange(b, a)
  await exchange(a, c)
  t.ok(texts(await member.groupRead(a, { group })).includes('sob a última chave'), 'the creator reads')
  t.ok(texts(await member.groupRead(c, { group })).includes('sob a última chave'), 'another member reads')
  t.is((await member.groupRead(c, { group })).state, 'ok')
})
