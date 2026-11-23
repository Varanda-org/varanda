'use strict'

// A core member node creates, joins and lists groups without a community
// (docs/rpc.md 5.36, 5.37, 5.176; protocol section 10, "Standalone groups").
const test = require('brittle')
const crypto = require('hypercore-crypto')
const { groupJoinRecord } = require('../lib/records')
const groupLib = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { createModeratorCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { testnet } = require('./helpers/net')
const { hex, person, exchange, sync, coreEntries, entryOf, rejects, rootAppend, otherDevice } = require('./helpers/community-member')
const syncGroups = require('./helpers/sync-groups')
const { offlineAppend } = require('./helpers/group-member')

const texts = (read) => read.items.filter((i) => !i.hidden).map((i) => i.text).sort()
const localKeys = (ctx) => store.readGroups(ctx.dataDir).map((g) => g.group)
const memberKeys = async (ctx, group) => (await member.groupMembers(ctx, { group })).members.filter((m) => !m.banned).map((m) => m.member).sort()

test('a member with no community creates a standalone group: its header names neither, no community record is written', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const before = (await coreEntries(a, community)).length
  const { group } = await member.groupCreate(a, { name: 'Solta', join: 'open' })
  const root = await coreEntries(a, group)
  t.alike([root[0].record.kind, root[0].record.community, root[0].record.member, root[0].record.diary], ['group', null, null, a.key])
  t.ok(groupLib.isStandaloneHeader(root[0].record))
  t.is((await coreEntries(a, community)).length, before, 'the community root gains nothing')
  t.alike(entryOf(a, group), { group, writer: group, nonce: entryOf(a, group).nonce }, 'the creator writer is the root')
  const info = await member.groupInfo(a, { group })
  t.alike([info.community, info.orphan, info.state, info.role], [null, false, 'member', 'creator'])
  t.ok((await member.groupList(a)).groups.some((g) => g.group === group && g.community === null))
  t.alike(await member.groupStandalone(a, {}), {
    groups: [{ group, name: 'Solta', image: null, imageAuthor: null, visibility: 'public', join: 'open', role: 'creator', general: false, last: null, unread: 0 }],
    total: 1
  })
  await member.groupPost(a, { group, text: 'oi' })
  const row = (await member.groupStandalone(a, {})).groups[0]
  t.is(row.last.preview, 'oi', 'last as a community.info row')
  t.is(row.unread, 0, 'the own post is never unread')
})

test('a held standalone root is joined directly with member = G; a community hint is refused before any write', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Solta', join: 'open' })
  await member.groupPost(a, { group, text: 'da Ana' })
  await exchange(a, b)
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const log = await coreEntries(b, b.key)
  await rejects(t, member.groupJoin(b, { group, community }), 'parâmetro inválido: community')
  await rejects(t, member.groupJoin(b, { group, community, standalone: true }), 'parâmetro inválido: standalone', 'USAGE')
  t.absent(localKeys(b).includes(group), 'no local entry')
  t.is((await coreEntries(b, b.key)).length, log.length, 'nothing in the diary')
  t.alike(await member.groupJoin(b, { group }), { state: 'member' })
  t.alike(await member.groupJoin(b, { group, standalone: true }), { state: 'member' }, 'standalone: true agrees with the held header')
  const header = (await coreEntries(b, entryOf(b, group).writer))[0].record
  t.alike([header.type, header.group, header.member], ['group-writer', group, group])
  await member.groupPost(b, { group, text: 'da Bia' })
  await sync(a, b)
  t.alike(texts(await member.groupRead(a, { group })), ['da Ana', 'da Bia'])
  t.alike(texts(await member.groupRead(b, { group })), ['da Ana', 'da Bia'])
  t.alike(await memberKeys(a, group), [a.key, b.key].sort())
  t.is((await member.groupStandalone(b, {})).groups[0].role, 'member')
})

test('an unheld root: no hint asks for the community, standalone: true writes a pending writer naming G that counts once the root arrives', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Solta', join: 'open' })
  await rejects(t, member.groupJoin(b, { group }), 'informe a comunidade do grupo')
  await rejects(t, member.groupJoin(b, { group, standalone: true, community: 'ab'.repeat(32) }), 'parâmetro inválido: standalone')
  t.alike(localKeys(b), [], 'nothing written')
  t.alike(await member.groupJoin(b, { group, standalone: true }), { state: 'pending' })
  t.is((await coreEntries(b, entryOf(b, group).writer))[0].record.member, group, 'the pending writer names member = G')
  t.alike(await member.groupStandalone(b, {}), { groups: [], total: 0 }, 'a pending root is not listed')
  await sync(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member')
  await member.groupPost(b, { group, text: 'cheguei' })
  await exchange(b, a)
  t.alike(texts(await member.groupRead(a, { group })), ['cheguei'])
  t.alike((await member.groupStandalone(b, {})).groups.map((g) => [g.group, g.role]), [[group, 'member']])
})

test('approval mode: requests, admission and moderation by G admins alone', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const c = await person(t, kp, 'Caio')
  const { group } = await member.groupCreate(a, { name: 'Clube', join: 'approval' })
  await sync(a, b, c)
  t.alike(await member.groupJoin(b, { group }), { state: 'requested' })
  t.alike(await member.groupJoin(c, { group }), { state: 'requested' })
  await sync(a, b, c)
  t.alike((await member.groupRequests(a, { group })).requests.map((r) => r.member).sort(), [b.key, c.key].sort())
  await rejects(t, member.groupAdmit(b, { group, member: c.key, on: true }), 'sem permissão no grupo')
  t.alike(await member.groupAdmit(a, { group, member: b.key, on: true }), { ok: true })
  t.alike(await member.groupAdmin(a, { group, member: b.key, on: true }), { ok: true })
  await sync(a, b, c)
  t.alike(await member.groupAdmit(b, { group, member: c.key, on: true }), { ok: true }, 'a G admin admits')
  await sync(a, b, c)
  t.is((await member.groupInfo(c, { group })).state, 'member')
  await member.groupPost(c, { group, text: 'do Caio' })
  t.alike(await member.groupBan(b, { group, member: c.key, on: true }), { ok: true }, 'a G admin bans')
  await sync(a, b, c)
  await rejects(t, member.groupPost(c, { group, text: 'de novo' }), 'sem permissão no grupo')
  t.alike(await memberKeys(a, group), [a.key, b.key].sort())
})

test('private: admission hands the key, a ban rotates it, the sweep checks the group, and a leave drops it from the list', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const c = await person(t, kp, 'Caio')
  const { group } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  t.is((await coreEntries(a, group))[0].record.name, null, 'the name is sealed')
  await member.groupPost(a, { group, text: 'antes' })
  await sync(a, b, c)
  t.alike(await member.groupJoin(b, { group }), { state: 'requested' }, 'a private group is approval')
  t.alike(await member.groupJoin(c, { group }), { state: 'requested' })
  await sync(a, b, c)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await member.groupAdmit(a, { group, member: c.key, on: true })
  await sync(a, b, c)
  t.alike(texts(await member.groupRead(b, { group })), ['antes'], 'B reads the history')
  t.alike(texts(await member.groupRead(c, { group })), ['antes'], 'C reads the history')
  const epoch = (await member.groupRead(a, { group })).epoch
  await member.groupBan(a, { group, member: c.key, on: true })
  const next = (await member.groupRead(a, { group })).epoch
  t.not(JSON.stringify(next), JSON.stringify(epoch), 'the ban rotated the epoch')
  await member.groupPost(a, { group, text: 'depois' })
  await sync(a, b, c)
  t.alike(texts(await member.groupRead(b, { group })), ['antes', 'depois'])
  t.absent(texts(await member.groupRead(c, { group })).includes('depois'), 'the banned member cannot open the new epoch')
  const swept = await member.periodicRekey(a, { groups: [group] })
  t.alike([swept.checked, swept.failed, swept.public], [[group], [], []])
  t.ok(swept.rotated.length === 1 || swept.next !== null, 'the sweep reaches the distributor decision')
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  t.alike(await member.groupStandalone(b, {}), { groups: [], total: 0 }, 'a group the caller left is not listed')
})

test('community groups keep their rules: a non-member enters the community first and standalone: true is refused', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community, group: geral } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await exchange(a, b)
  await rejects(t, member.groupJoin(b, { group }), 'entre na comunidade primeiro')
  await rejects(t, member.groupJoin(b, { group, standalone: true }), 'parâmetro inválido: standalone')
  t.alike(localKeys(b), [], 'nothing written')
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  await rejects(t, member.groupJoin(b, { group, standalone: true }), 'parâmetro inválido: standalone')
  t.alike(await member.groupJoin(b, { group }), { state: 'member' })
  t.alike(await member.groupStandalone(b, {}), { groups: [], total: 0 }, 'community groups are not standalone')
})

test('a hint the arriving root contradicts grants nothing', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  const { group: solta } = await member.groupCreate(a, { name: 'Solta', join: 'open' })
  // B is a community member, but holds neither group root yet.
  await exchange(a, b)
  await member.communityJoin(b, { community })
  const s = await store.openStore(b.dataDir)
  try {
    for (const key of [group, solta]) await s.get({ key: Buffer.from(key, 'hex'), writable: false }).purge()
  } finally {
    await s.close()
  }
  t.alike(await member.groupJoin(b, { group, standalone: true }), { state: 'pending' }, 'a community group called standalone')
  t.alike(await member.groupJoin(b, { group: solta, community }), { state: 'pending' }, 'a standalone group called a community one')
  t.is((await coreEntries(b, entryOf(b, group).writer))[0].record.member, group)
  await sync(a, b)
  for (const g of [group, solta]) {
    t.is((await member.groupInfo(b, { group: g })).state, 'left', 'the writer never counts')
    t.alike(await memberKeys(a, g), [a.key], 'nobody new in the fold')
    await rejects(t, member.groupPost(b, { group: g, text: 'x' }), 'sem permissão no grupo')
  }
  t.alike(await member.groupJoin(b, { group: solta }), { state: 'member' }, 'a later join follows the held header')
})

test('a contradicted pending writer of a diary that is a member through another device: group.join retires it and names the right member', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  const { group: solta } = await member.groupCreate(a, { name: 'Solta', join: 'open' })
  await exchange(a, b)
  await member.communityJoin(b, { community })
  const s = await store.openStore(b.dataDir)
  try {
    for (const key of [group, solta]) await s.get({ key: Buffer.from(key, 'hex'), writable: false }).purge()
  } finally {
    await s.close()
  }
  t.alike(await member.groupJoin(b, { group, standalone: true }), { state: 'pending' })
  t.alike(await member.groupJoin(b, { group: solta, community }), { state: 'pending' })
  const cw = entryOf(b, community).writer
  const old = new Map([group, solta].map((g) => [g, entryOf(b, g).writer]))
  await sync(a, b)
  let n = 0
  for (const [g, m] of [[solta, solta], [group, cw]]) {
    // Device A of the same diary: a counted writer naming the right member.
    await otherDevice(b, g, (++n).toString(16).padStart(32, '0'), groupLib.writerHeader({ group: g, diary: b.key, member: m }))
    t.is((await member.groupInfo(b, { group: g })).state, 'member', 'a member through device A')
    t.alike(await member.groupJoin(b, { group: g }), { state: 'member' }, 'no GROUP_FULL')
    const w = entryOf(b, g).writer
    t.not(w, old.get(g), 'a new writer')
    t.is((await coreEntries(b, w))[0].record.member, m, 'naming the right member')
    const { entries } = await member.logRead(b)
    t.alike(groupLib.groupJoinHistory(entries, g).filter((j) => j.writer === old.get(g)).map((j) => j.on), [true, false], 'the old writer stays bound, off')
    t.ok(groupLib.groupCutHistory(entries, g).some((m) => m.writer === old.get(g)), 'and cut')
    await member.groupPost(b, { group: g, text: 'de B' })
    t.ok(texts(await member.groupRead(b, { group: g })).includes('de B'), 'a post through the new writer')
    t.alike(await member.groupLeave(b, { group: g }), { state: 'left' }, 'a leave works too')
  }
})

test('a member-stale writer holding a post is cut at its held length, never at 0', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group: solta } = await member.groupCreate(a, { name: 'Solta', join: 'open' })
  await exchange(a, b)
  await member.communityJoin(b, { community })
  const s = await store.openStore(b.dataDir)
  try {
    await s.get({ key: Buffer.from(solta, 'hex'), writable: false }).purge()
  } finally {
    await s.close()
  }
  t.alike(await member.groupJoin(b, { group: solta, community }), { state: 'pending' })
  const old = entryOf(b, solta).writer
  await offlineAppend(b, solta, groupLib.groupPost({ text: 'antes' }))
  t.is((await coreEntries(b, old)).length, 2, 'header and a post')
  await sync(a, b)
  await otherDevice(b, solta, 'f1'.repeat(16), groupLib.writerHeader({ group: solta, diary: b.key, member: solta }))
  t.alike(await member.groupJoin(b, { group: solta }), { state: 'member' })
  const { entries } = await member.logRead(b)
  t.alike(groupLib.groupCutHistory(entries, solta).filter((m) => m.writer === old).map((m) => m.cut), [2], 'cut at the held length')
})

// A community root of `a` whose first group-create names `geral`: the
// catalogue cannot see the header of the root it names.
async function communityNaming (a, geral) {
  return member.withIdentity(a, async ({ store: s, diary, ownHex }) => {
    const nonce = hex(crypto.randomBytes(16))
    const root = await store.openGroupWriter(s, nonce)
    const C = hex(root.key)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq, { root: true, community: true })
    await store.appendRecord(root, groupLib.groupHeader({ kind: 'community', diary: ownHex, join: 'open', name: 'Falsa' }), { validator })
    store.writeGroups(a.dataDir, [...store.readGroups(a.dataDir), { group: C, writer: C, nonce, kind: 'community' }])
    await store.appendRecord(diary, groupJoinRecord({ group: C, writer: C, on: true }))
    await store.appendRecord(root, groupLib.groupCreateRecord({ group: geral, seen: null }), { validator })
    return C
  })
}

test('a catalogue naming a standalone root: community.info leaves it out and community.join writes nothing in it, even as Geral', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group: solta } = await member.groupCreate(a, { name: 'Solta', join: 'open' })
  const { community, group: geral } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  await rootAppend(a, community, groupLib.groupCreateRecord({ group: solta, seen: null }), true)
  t.alike((await member.communityInfo(a, { community })).groups.map((g) => g.group), [geral], 'the catalogue entry is skipped')
  const falsa = await communityNaming(a, solta)
  const fake = await member.communityInfo(a, { community: falsa })
  t.alike([fake.general, fake.groups], [null, []], 'a Geral whose held root does not name C is absent')
  await exchange(a, b)
  t.alike(await member.communityJoin(b, { community: falsa }), { state: 'member', group: null }, 'Geral is treated as absent')
  t.absent(localKeys(b).includes(solta), 'no writer in the standalone root')
  const listed = async (ctx, key) => (await member.communityList(ctx)).communities.find((x) => x.community === key).general
  t.is(await listed(a, falsa), null, 'the creator\'s community.list gives no Geral')
  t.is(await listed(b, falsa), null, 'neither does a member\'s')
  t.is(await listed(a, community), geral, 'control: a Geral naming C stays')
  t.alike(await member.communityJoin(b, { community }), { state: 'member', group: geral })
  t.absent(localKeys(b).includes(solta), 'still none after joining the community that lists it')
  t.alike((await member.communityInfo(b, { community })).groups.map((g) => g.group), [geral])
})

test('a held foreign Geral takes no slot in the community.join room check', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group: solta } = await member.groupCreate(a, { name: 'Solta', join: 'open' })
  const falsa = await communityNaming(a, solta)
  await exchange(a, b)
  // MAX - 1 used slots, none of them evictable (roots this device holds).
  const fill = []
  for (let i = 0; i < groupLib.MAX_GROUPS_PER_DIARY - 1; i++) {
    const k = hex(crypto.randomBytes(32))
    fill.push({ group: k, writer: k, nonce: hex(crypto.randomBytes(16)) })
  }
  store.writeGroups(b.dataDir, fill)
  t.alike(await member.communityJoin(b, { community: falsa }), { state: 'member', group: null }, 'the join fits in the last slot')
  t.absent(localKeys(b).includes(solta), 'nothing written in the standalone root')
  t.is(store.readGroups(b.dataDir).length, groupLib.MAX_GROUPS_PER_DIARY)
})

test('a catalogue naming another community\'s root, as Geral and as a group: left out, no Geral, no slot, nothing written', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { community: outra } = await member.communityCreate(a, { name: 'Outra', join: 'open' })
  const { community: terceira } = await member.communityCreate(a, { name: 'Terceira', join: 'open' })
  const falsa = await communityNaming(a, outra)
  await rootAppend(a, falsa, groupLib.groupCreateRecord({ group: terceira, seen: null }), true)
  const info = await member.communityInfo(a, { community: falsa })
  t.alike([info.general, info.groups], [null, []], 'a held community root is no group of C')
  const listed = async (ctx) => (await member.communityList(ctx)).communities.find((x) => x.community === falsa).general
  t.is(await listed(a), null, 'community.list agrees')
  await exchange(a, b)
  // MAX - 1 used slots, none of them evictable (roots this device holds).
  const fill = []
  for (let i = 0; i < groupLib.MAX_GROUPS_PER_DIARY - 1; i++) {
    const k = hex(crypto.randomBytes(32))
    fill.push({ group: k, writer: k, nonce: hex(crypto.randomBytes(16)) })
  }
  store.writeGroups(b.dataDir, fill)
  t.alike(await member.communityJoin(b, { community: falsa }), { state: 'member', group: null }, 'the join fits in the last slot')
  t.absent(localKeys(b).includes(outra), 'nothing written in the other community\'s root')
  t.is(store.readGroups(b.dataDir).length, groupLib.MAX_GROUPS_PER_DIARY)
  const bInfo = await member.communityInfo(b, { community: falsa })
  t.alike([bInfo.general, bInfo.groups], [null, []], 'the same on the member\'s device')
  t.is(await listed(b), null)
})

test('a catalogue naming blocked held roots of another community, as Geral and as a group: left out, no Geral', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const { community: outra, group: outraGeral } = await member.communityCreate(a, { name: 'Outra', join: 'open' })
  const { group: feira } = await member.groupCreate(a, { name: 'Feira', join: 'open', community: outra })
  const falsa = await communityNaming(a, outraGeral)
  await rootAppend(a, falsa, groupLib.groupCreateRecord({ group: feira, seen: null }), true)
  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 1, blocked: [outraGeral, feira] }, mod, cert))
  const info = await member.communityInfo(a, { community: falsa })
  t.alike([info.general, info.groups], [null, []], 'a blocked held root naming another community is no group of C')
  t.is((await member.communityList(a)).communities.find((x) => x.community === falsa).general, null, 'community.list agrees')
})

test('a standalone group end to end through a seeder: create, pending join, both post', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const kp = require('../lib/cert').generateAssociationKeyPair()
  await syncGroups.startSeeder(t, bootstrap, kp)
  const a = await syncGroups.person(t, kp, 'Ana')
  const b = await syncGroups.person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Solta', join: 'open' })
  await member.groupPost(a, { group, text: 'da Ana' })
  t.ok((await syncGroups.syncOnce(bootstrap, a)).result.ok, 'A reaches the seeder')
  t.alike(await member.groupJoin(b, { group, standalone: true }), { state: 'pending' })
  const rb = await syncGroups.syncOnce(bootstrap, b)
  t.ok(rb.result.ok, rb.result.errors.join('; '))
  t.ok(await syncGroups.stored(b, group), 'B holds the root')
  t.is((await member.groupInfo(b, { group })).state, 'member')
  await member.groupPost(b, { group, text: 'da Bia' })
  t.ok((await syncGroups.syncOnce(bootstrap, b)).result.ok)
  const ra = await syncGroups.syncOnce(bootstrap, a)
  t.ok(ra.result.ok, ra.result.errors.join('; '))
  t.alike(texts(await member.groupRead(a, { group })), ['da Ana', 'da Bia'])
  t.alike(texts(await member.groupRead(b, { group })), ['da Ana', 'da Bia'])
})
