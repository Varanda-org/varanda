'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, createModeratorCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const store = require('../lib/store')
const member = require('../lib/member')
const { tmpDir } = require('./helpers/tmp')

const hex = (key) => b4a.toString(key, 'hex')

async function person (t, kp, name = 'Ana', certified = true) {
  const ctx = { dataDir: tmpDir(t), association: hex(kp.publicKey) }
  const { publicKey } = await member.idCreate(ctx)
  if (certified) {
    await member.certAdd(ctx, createCert({ member: publicKey }, kp))
    await member.profileSet(ctx, { name })
  }
  return { ...ctx, key: publicKey }
}

// Corestore replication stays entirely in process, without sockets or a DHT.
async function exchange (from, to) {
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
      for (let seq = 0; seq < source.contiguousLength; seq++) {
        await target.get(seq, { raw: true, timeout: 10000 })
      }
    }
  } finally {
    if (left) left.destroy()
    if (right) right.destroy()
    await b.close()
    await a.close()
  }
}

async function rootEntries (ctx, key) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = s.get({ key: b4a.from(key, 'hex'), writable: false })
    await core.ready()
    return await store.readAll(core)
  } finally {
    await s.close()
  }
}

async function rejects (t, promise, message, code = 'USAGE') {
  try {
    await promise
    t.fail('expected rejection')
  } catch (err) {
    t.is(err.message, message)
    t.is(err.code, code)
  }
}

test('create binds a community root, info reads it, and the group list leaves it out', async (t) => {
  const kp = crypto.keyPair()
  const bare = await person(t, kp, 'Ana', false)
  await t.exception(member.communityCreate(bare, { name: 'Bairro' }), new RegExp(member.GENESIS_REQUIRED))
  t.alike(store.readGroups(bare.dataDir), [], 'nothing recorded before the genesis')
  const a = await person(t, kp)
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  t.ok(/^[0-9a-f]{64}$/.test(community))
  const root = await rootEntries(a, community)
  t.is(root.length, 1)
  t.is(root[0].record.kind, 'community')
  t.is(root[0].record.diary, a.key)
  const local = store.readGroups(a.dataDir)
  t.is(local.length, 1)
  t.is(local[0].group, community)
  t.is(local[0].writer, community)
  t.alike(await member.communityInfo(a, { community }), {
    community, name: 'Bairro', creator: a.key, groups: [], admins: 1, state: 'ready', incomplete: false
  })
  t.alike(await member.groupList(a), { groups: [], total: 0 })
  const unknown = 'ab'.repeat(32)
  t.alike(await member.communityInfo(a, { community: unknown }), {
    community: unknown, name: null, creator: null, groups: [], admins: 0, state: 'pending', incomplete: true
  })
  const { group } = await member.groupCreate(a, { name: 'Horta' })
  await rejects(t, member.communityInfo(a, { community: group }), 'comunidade não encontrada', 'NOT_FOUND')
  await rejects(t, member.communityInfo(a, { community: 'x' }), 'comunidade não encontrada', 'NOT_FOUND')
  // A community root is no group: leaving it keeps the created root's entry.
  await rejects(t, member.groupLeave(a, { group: community }), 'grupo não encontrado', 'NOT_FOUND')
  t.is(store.readGroups(a.dataDir).length, 2)
})

test('community list: created, linked through a group, once when both, blocklisted left out', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  t.alike(await member.communityList(a), { communities: [] })
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  t.alike(await member.communityList(a), { communities: [{ community, name: 'Bairro', state: 'ready', creator: true, linked: false }] })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open' })
  await member.communityLink(a, { community, group, on: true })
  t.alike((await member.communityList(a)).communities, [{ community, name: 'Bairro', state: 'ready', creator: true, linked: true }], 'created and linked: one entry')

  const { community: vila } = await member.communityCreate(b, { name: 'Vila' })
  const { group: praca } = await member.groupCreate(b, { name: 'Praça', join: 'open' })
  await member.communityLink(b, { community: vila, group: praca, on: true })
  await exchange(b, a)
  await member.groupJoin(a, { group: praca })
  t.alike((await member.communityList(a)).communities, [
    { community, name: 'Bairro', state: 'ready', creator: true, linked: true },
    { community: vila, name: 'Vila', state: 'ready', creator: false, linked: true }
  ])
  t.alike((await member.groupList(a)).groups.map((g) => g.group).sort(), [group, praca].sort(), 'group.list never lists a community')

  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 1, blocked: [vila] }, mod, cert))
  t.alike((await member.communityList(a)).communities.map((c) => c.community), [community], 'a blocklisted root is left out')
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 2, blocked: [vila, community] }, mod, cert))
  t.alike(await member.communityList(a), { communities: [] })
})

test('one caller owning both roots links both sides, idempotently, one community per group', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  const { group } = await member.groupCreate(a, { name: 'Horta' })
  t.alike((await member.groupInfo(a, { group })).communities, [])
  const affected = new Set()
  t.alike(await member.communityLink(a, { community, group, on: true }, { affected }), { community, group, on: true, sides: ['community', 'group'] })
  t.alike([...affected].sort(), [community, group].sort())
  const links = (await rootEntries(a, group)).filter((e) => e.record.type === 'community-link')
  t.is(links.length, 1)
  t.alike(links[0].record.cuts.map((c) => c.writer), [group], 'the creator root writer is listed')
  t.alike((await member.groupInfo(a, { group })).communities, [community])
  t.alike((await member.communityInfo(a, { community })).groups, [{ group, name: 'Horta' }])
  // Again: nothing new to list, nothing written on either side.
  const lengths = [(await rootEntries(a, community)).length, (await rootEntries(a, group)).length]
  await member.communityLink(a, { community, group, on: true })
  t.alike([(await rootEntries(a, community)).length, (await rootEntries(a, group)).length], lengths)
  const other = (await member.communityCreate(a, { name: 'Outro' })).community
  await rejects(t, member.communityLink(a, { community: other, group, on: true }), 'o grupo já está em outra comunidade')
  await rejects(t, member.communityLink(a, { community, group: other, on: true }), 'sem permissão na comunidade')
  // An ordinary group named as the community never takes the group's slot.
  const plain = (await member.groupCreate(a, { name: 'Praça' })).group
  await rejects(t, member.communityLink(a, { community: plain, group, on: true }), 'sem permissão na comunidade')
  await rejects(t, member.communityLink(a, { community: group, group, on: true }), 'sem permissão na comunidade')
  t.absent((await rootEntries(a, group)).some((e) => e.record.type === 'community-link' && e.record.community !== community))
  t.alike(await member.communityLink(a, { community, group, on: false }), { community, group, on: false, sides: ['community', 'group'] })
  t.alike((await member.groupInfo(a, { group })).communities, [])
  t.alike((await member.communityInfo(a, { community })).groups, [])
  const off = [(await rootEntries(a, community)).length, (await rootEntries(a, group)).length]
  await member.communityLink(a, { community, group, on: false })
  t.alike([(await rootEntries(a, community)).length, (await rootEntries(a, group)).length], off, 'an unlink already off writes nothing')
  t.alike((await member.communityLink(a, { community: other, group, on: true })).sides, ['community', 'group'])
  t.alike((await member.groupInfo(a, { group })).communities, [other])
})

test('two callers each link their own side; info reports pending, incomplete and ready', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const c = await person(t, kp, 'Caio')
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  const { group } = await member.groupCreate(b, { name: 'Horta' })
  t.alike((await member.communityInfo(b, { community })).state, 'pending')
  await rejects(t, member.communityLink(c, { community, group, on: true }), 'sem permissão na comunidade')
  t.alike(await member.communityLink(a, { community, group, on: true }), { community, group, on: true, sides: ['community'] })
  t.alike(await member.communityInfo(a, { community }), {
    community, name: 'Bairro', creator: a.key, groups: [], admins: 1, state: 'ready', incomplete: true
  }, 'a group root not held cannot be confirmed two-way')
  await exchange(b, a)
  const half = await member.communityInfo(a, { community })
  t.alike([half.groups, half.incomplete], [[], false], 'the group side is not on yet')
  t.alike((await member.groupInfo(a, { group })).communities, [])
  t.alike(await member.communityLink(b, { community, group, on: true }), { community, group, on: true, sides: ['group'] })
  await exchange(b, a)
  await exchange(a, b)
  t.alike((await member.communityInfo(a, { community })).groups, [{ group, name: 'Horta' }])
  t.alike((await member.groupInfo(a, { group })).communities, [community])
  t.alike((await member.groupInfo(b, { group })).communities, [community])
  // A group joined before its root arrived has no communities yet.
  const pending = 'cd'.repeat(32)
  t.alike(await member.groupJoin(c, { group: pending }), { state: 'pending' })
  t.alike((await member.groupInfo(c, { group: pending })).communities, [])
})

test('a community admin bans in a linked group; a new writer acts only after a new grant', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const c = await person(t, kp, 'Caio')
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  const { group } = await member.groupCreate(a, { name: 'Horta' })
  await member.communityLink(a, { community, group, on: true })
  await exchange(a, b)
  await exchange(a, c)
  await member.groupJoin(b, { group })
  await member.groupJoin(c, { group })
  await member.groupPost(b, { group, text: 'antes' })
  await exchange(c, a)
  await rejects(t, member.communityAdmin(a, { community, member: a.key, on: true }), 'o criador da comunidade já administra')
  await rejects(t, member.communityAdmin(c, { community, member: c.key, on: true }), 'sem permissão na comunidade')
  const affected = new Set()
  t.alike(await member.communityAdmin(a, { community, member: c.key, on: true }, { affected }), { community, member: c.key, on: true })
  t.alike([...affected].sort(), [community, group].sort())
  const grant = (await rootEntries(a, community)).pop().record
  t.is(grant.type, 'group-admin')
  t.is(grant.cuts.length, 1, 'the admin writer in the linked group is listed')
  t.absent(grant.cuts.some((x) => x.seq === 0))
  await exchange(a, c)
  await exchange(b, c)
  t.is((await member.groupInfo(c, { group })).role, 'admin')
  t.alike(await member.groupBan(c, { group, member: b.key, on: true }), { ok: true })
  await exchange(c, a)
  await exchange(c, b)
  t.is((await member.groupInfo(b, { group })).state, 'banned')
  t.ok((await member.groupMembers(a, { group })).members.find((m) => m.member === b.key).banned)
  await member.groupBan(a, { group, member: b.key, on: false })
  await exchange(a, b)
  await exchange(a, c)
  t.is((await member.groupInfo(b, { group })).state, 'member')
  // A writer created after the grant (leave and rejoin) holds no authority.
  await member.groupLeave(c, { group })
  t.alike(await member.groupJoin(c, { group }), { state: 'member' })
  t.alike(await member.groupBan(c, { group, member: b.key, on: true }), { ok: true })
  await exchange(c, a)
  t.is((await member.groupInfo(b, { group })).state, 'member')
  await exchange(c, b)
  t.is((await member.groupInfo(b, { group })).state, 'member', 'the ban from the ungranted writer does not count')
  // A new grant alone: no group creator act, no relink.
  await member.communityAdmin(a, { community, member: c.key, on: true })
  await exchange(a, c)
  await member.groupBan(c, { group, member: b.key, on: true })
  await exchange(c, b)
  t.is((await member.groupInfo(b, { group })).state, 'banned')
})

test('a 33rd group on is refused with nothing written; after an unlink it links', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  // Groups whose roots are not held: only the community side is written.
  const keys = Array.from({ length: 33 }, () => hex(crypto.randomBytes(32)))
  for (const group of keys.slice(0, 32)) await member.communityLink(a, { community, group, on: true })
  const length = async () => (await rootEntries(a, community)).length
  t.is(await length(), 33)
  await rejects(t, member.communityLink(a, { community, group: keys[32], on: true }), 'limite da comunidade atingido')
  t.is(await length(), 33, 'the refused link wrote nothing')
  await member.communityLink(a, { community, group: keys[0], on: true })
  t.is(await length(), 33, 'a group already on is not refused')
  await member.communityLink(a, { community, group: keys[0], on: false })
  await member.communityLink(a, { community, group: keys[32], on: true })
  t.is(await length(), 35, 'the link is written once room is made')
  await member.communityLink(a, { community, group: keys[32], on: true })
  t.is(await length(), 35, 'and is on now')
})

test('a community admin hide made while linked stays after an unlink and a link to another community', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const c = await person(t, kp, 'Caio')
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  const { group } = await member.groupCreate(a, { name: 'Horta' })
  await member.communityLink(a, { community, group, on: true })
  await exchange(a, b)
  await exchange(a, c)
  await member.groupJoin(b, { group })
  await member.groupJoin(c, { group })
  const { seq } = await member.groupPost(b, { group, text: 'hortelã' })
  const target = { writer: store.readGroups(b.dataDir).find((g) => g.group === group).writer, seq }
  await exchange(b, a)
  await exchange(c, a)
  await member.communityAdmin(a, { community, member: c.key, on: true })
  await exchange(a, c)
  t.is((await member.groupInfo(c, { group })).role, 'admin')
  await member.groupHide(c, { group, target, on: true })
  await exchange(c, a)
  const hidden = async () => (await member.groupRead(a, { group })).items.find((p) => p.seq === seq).hidden
  t.ok(await hidden(), 'hidden while linked')
  await member.communityLink(a, { community, group, on: false })
  const other = (await member.communityCreate(a, { name: 'Outro' })).community
  await member.communityLink(a, { community: other, group, on: true })
  t.alike((await member.groupInfo(a, { group })).communities, [other])
  t.ok(await hidden(), 'still hidden after the unlink')
  t.absent((await member.groupRead(a, { group })).incomplete)
})

// Joins `s` to the group and leaves and joins again until it holds `n`
// writers there.
async function writers (s, group, n) {
  await member.groupJoin(s, { group })
  for (let i = 1; i < n; i++) {
    await member.groupLeave(s, { group })
    await member.groupJoin(s, { group })
  }
}

test('an unlink past MAX_GROUP_CUTS community writers is written and the community powers stop', async (t) => {
  t.timeout(300000)
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const x = await person(t, kp, 'Xis')
  const p = await person(t, kp, 'Pia')
  const q = await person(t, kp, 'Quim')
  const { group } = await member.groupCreate(a, { name: 'Horta' })
  await member.groupPost(a, { group, text: 'um' })
  await member.groupPost(a, { group, text: 'dois' })
  const { community } = await member.communityCreate(x, { name: 'Bairro' })
  await exchange(a, x)
  await member.groupJoin(x, { group })
  await member.communityLink(x, { community, group, on: true })
  await exchange(x, a)
  await member.communityLink(a, { community, group, on: true })
  t.alike((await member.groupInfo(a, { group })).communities, [community])
  // 17 writers of the community creator and admins in the group.
  for (const s of [p, q]) {
    await exchange(a, s)
    await writers(s, group, 8)
    await exchange(s, x)
  }
  await member.communityAdmin(x, { community, member: p.key, on: true })
  await member.communityAdmin(x, { community, member: q.key, on: true })
  await exchange(x, a)
  await exchange(x, p)
  const items = (await member.groupRead(a, { group })).items
  const [one, two] = ['um', 'dois'].map((text) => items.find((i) => i.text === text)).map((i) => ({ writer: i.writer, seq: i.seq }))
  const hidden = async (ref) => (await member.groupRead(a, { group })).items.find((i) => i.writer === ref.writer && i.seq === ref.seq).hidden
  await member.groupHide(p, { group, target: one, on: true })
  await exchange(p, a)
  t.ok(await hidden(one), 'the community admin hides while linked')
  const before = (await rootEntries(a, group)).length
  t.alike(await member.communityLink(a, { community, group, on: false }), { community, group, on: false, sides: ['group'] })
  const entries = await rootEntries(a, group)
  t.is(entries.length, before + 1)
  const unlink = entries.pop().record
  t.is(unlink.type, 'community-link')
  t.is(unlink.on, false)
  t.is(unlink.cuts.length, 16, 'the first MAX_GROUP_CUTS writers are listed')
  t.alike(unlink.cuts.map((c) => c.writer), unlink.cuts.map((c) => c.writer).sort(), 'in writer key order')
  t.alike((await member.groupInfo(a, { group })).communities, [])
  await member.groupHide(p, { group, target: two, on: true })
  await exchange(p, a)
  t.absent(await hidden(two), 'a hide after the unlink has no effect')
})

test('a demotion past MAX_COMMUNITY_CUTS writers is written', async (t) => {
  t.timeout(300000)
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const m = await person(t, kp, 'Mia')
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  const keys = []
  for (let i = 0; i < 9; i++) {
    const { group } = await member.groupCreate(a, { name: 'Horta ' + i })
    await member.communityLink(a, { community, group, on: true })
    keys.push(group)
  }
  await exchange(a, m)
  for (const group of keys) await writers(m, group, 8)
  await exchange(m, a)
  await rejects(t, member.communityAdmin(a, { community, member: m.key, on: true }), 'limite da comunidade atingido')
  t.alike(await member.communityAdmin(a, { community, member: m.key, on: false }), { community, member: m.key, on: false })
  const demotion = (await rootEntries(a, community)).pop().record
  t.is(demotion.type, 'group-admin')
  t.is(demotion.on, false)
  t.is(demotion.cuts.length, 64, 'the first MAX_COMMUNITY_CUTS writers are listed')
  t.alike(demotion.cuts.map((c) => c.writer), demotion.cuts.map((c) => c.writer).sort())
  t.is((await member.communityInfo(a, { community })).admins, 1)
})

test('community info loads only the groups the community side has on', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  const keys = []
  for (let i = 0; i < 4; i++) {
    const { group } = await member.groupCreate(a, { name: 'Horta ' + i })
    await member.communityLink(a, { community, group, on: true })
    keys.push(group)
  }
  for (const group of keys.slice(1)) await member.communityLink(a, { community, group, on: false })
  const seen = new Set()
  const open = store.openStore
  store.openStore = async (...args) => {
    const s = await open(...args)
    const get = s.get.bind(s)
    s.get = (opts) => {
      if (opts && opts.key) seen.add(hex(opts.key))
      return get(opts)
    }
    return s
  }
  try {
    const info = await member.communityInfo(a, { community })
    t.alike(info.groups.map((g) => g.group), [keys[0]])
  } finally {
    store.openStore = open
  }
  t.ok(seen.has(keys[0]), 'the group on is loaded')
  t.absent(keys.slice(1).some((k) => seen.has(k)), 'groups unlinked on the community side are not')
})
