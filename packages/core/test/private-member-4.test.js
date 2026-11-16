'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const store = require('../lib/store')
const member = require('../lib/member')
const groupCrypto = require('../lib/group-crypto')
const { hex, person, communityOfGroup, createGroup, joinGroup, exchange, rootEntries, ownWriter, texts, privateGroup } = require('./helpers/private-member')

test('private: a community ref in an earlier own basis is listed again in the next rotation', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  const community = communityOfGroup.get(group)
  await exchange(a, b)
  await member.communityJoin(b, { community })
  await exchange(b, a)
  await member.communitySetAdmin(a, { community, member: b.key, on: true })
  await member.communitySetAdmin(a, { community, member: b.key, on: false })
  const lastBasis = async () => (await rootEntries(a, group)).filter((e) => e.seq >= 1 && e.record.type === 'group-key' && e.record.kid === null).pop().record.basis
  await member.groupRekey(a, { group })
  const first = (await lastBasis()).filter((r) => r.writer === community)
  t.is(first.length, 1, 'the community removal is in the basis')
  await member.groupRekey(a, { group })
  t.alike((await lastBasis()).filter((r) => r.writer === community), first, 'listed again, never subtracted')
  t.is((await member.groupRead(a, { group })).state, 'ok')
})

test('private: a history hand-off that does not fit the log appends nothing', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await member.groupRekey(a, { group })
  await member.groupRekey(a, { group })
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await joinGroup(c, { group })
  await exchange(c, a)
  const before = (await rootEntries(a, group)).length
  // Room for the admit and one more block; three epochs to hand.
  t.alike(await member.groupAdmit({ ...a, limits: { maxLogBlocks: before + 2 } }, { group, member: c.key, on: true }), { ok: true })
  t.is((await rootEntries(a, group)).length, before + 1, 'only the admit was written')
  await member.groupRekey(a, { group })
  await exchange(a, c)
  t.is((await member.groupRead(c, { group })).state, 'ok', 'group.rekey with room hands it later')
})

test('private: every first key block commits to the key its members open', async (t) => {
  const { a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  const { epoch } = await member.groupRekey(a, { group })
  await exchange(a, b)
  const entries = await rootEntries(a, group)
  const firsts = entries.filter((e) => e.seq >= 1 && e.record.type === 'group-key' && e.record.kid === null)
  t.ok(firsts.length >= 2, 'the create epoch and the rotation')
  for (const e of entries) {
    if (e.record.type === 'group-key' && e.record.kid !== null) t.absent('commit' in e.record, 'no commit on a continuation')
  }
  const kid = { writer: epoch.writer, seq: epoch.seq }
  const first = firsts.find((e) => e.seq === epoch.seq)
  const entry = first.record.keys.find((k) => k.writer === ownWriter(b, group))
  const key = groupCrypto.openEpochKey(b4a.from(entry.sealed, 'base64'), store.ensureBoxKeyPair(b.dataDir), group, kid)
  t.ok(key !== null, 'the member opens the key')
  t.is(first.record.commit, hex(groupCrypto.keyCommit(key, group, kid)), 'the commit matches that key')
  const created = firsts[0]
  const own = created.record.keys[0]
  const createdKid = { writer: group, seq: created.seq }
  const createdKey = groupCrypto.openEpochKey(b4a.from(own.sealed, 'base64'), store.ensureBoxKeyPair(a.dataDir), group, createdKid)
  t.is(created.record.commit, hex(groupCrypto.keyCommit(createdKey, group, createdKid)), 'the create epoch commits too')
  groupCrypto.wipe(key)
  groupCrypto.wipe(createdKey)
  await member.groupPost(b, { group, text: 'sob a chave comprometida' })
  await exchange(b, a)
  t.ok(texts(await member.groupRead(a, { group })).includes('sob a chave comprometida'), 'members still read and send')
})

test('private: an admin promoted again after a demotion leaves no rekey-pending', async (t) => {
  const { a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  const community = communityOfGroup.get(group)
  await member.communitySetAdmin(a, { community, member: b.key, on: true })
  await member.communitySetAdmin(a, { community, member: b.key, on: false })
  await member.communitySetAdmin(a, { community, member: b.key, on: true })
  t.is((await member.groupRead(a, { group })).state, 'ok', 'not rekey-pending after the new grant')
  await exchange(a, b)
  await member.groupPost(b, { group, text: 'depois da nova promoção' })
  await exchange(b, a)
  t.ok(texts(await member.groupRead(a, { group })).includes('depois da nova promoção'), 'a member sends')
})

test('private: a creator who left and rejoined sets the invite policy on its rejoin writer', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const { group } = await createGroup(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  await member.groupLeave(a, { group })
  t.alike(await joinGroup(a, { group }), { state: 'member' })
  const writer = ownWriter(a, group)
  t.not(writer, group, 'the rejoin is on a new writer')
  t.is((await member.groupInfo(a, { group })).memberInvite, false)
  const rootBefore = (await rootEntries(a, group)).length
  t.alike(await member.groupInvitePolicy(a, { group, members: true }), { ok: true })
  t.is((await member.groupInfo(a, { group })).memberInvite, true, 'the fold counts the change')
  t.is((await rootEntries(a, group)).length, rootBefore, 'nothing appended to the root')
  const last = (await rootEntries(a, writer)).pop()
  t.is(last.record.type, 'group-invites', 'a plaintext group-invites on the rejoin writer')
  t.is(last.record.on, true)
})
