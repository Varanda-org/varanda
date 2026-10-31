'use strict'

// Communities through connectClient on browser nodes; cores move between
// devices by direct replication, so no seeder or sockets are involved.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { createBrowserNode } = require('../lib/node')
const { createBrowserSession } = require('../lib/session')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const grp = require('@varanda/core/lib/group')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')
const { connectClient, errorOf } = require('./helpers/session')

const hex = (buf) => b4a.toString(buf, 'hex')
const KEY = 'ab'.repeat(32)
const FORBIDDEN = 'sem permissão na comunidade'

async function setup (t, { assoc = generateAssociationKeyPair() } = {}) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const key = hex(keyPair.publicKey)
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  const node = createBrowserNode({
    storage,
    association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node)
  return { node, web, ctx, key, assoc, storage }
}

// Copies `from`'s diary and the group cores `keys` (held by `from`) to `to`,
// listed as the sync would list them.
async function share (from, to, keys) {
  for (const key of [from.key, ...keys]) {
    const diary = key === from.key
    const source = diary ? await store.openDiary(from.storage) : await store.openGroupCoreReadOnly(from.storage, key)
    const target = diary ? await store.openReplica(to.storage, key) : await store.openGroupReplica(to.storage, key)
    const a = source.replicate(true, { keepAlive: false })
    const b = target.replicate(false, { keepAlive: false })
    a.pipe(b).pipe(a)
    try {
      await target.download({ start: 0, end: source.length }).done()
    } finally {
      a.destroy()
      b.destroy()
      await source.close()
      await target.close()
    }
    if (!diary) await store.addGroupReplica(to.storage, key)
  }
  await store.addGroupDiary(to.storage, from.key)
}

async function coreLength (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try { return core.length } finally { await core.close() }
}

async function ownWriter (s, group) {
  return (await store.readGroupWriters(s.storage)).find((e) => e.group === group).key
}

test('community RPC handler names are registered', async (t) => {
  const browser = createBrowserSession({ storage: memoryNodeStorage(), association: KEY, seederUrl: 'ws://127.0.0.1:9/seeder', createSocket: () => null })
  t.teardown(() => browser.close(), { force: true })
  const names = Object.keys(browser.handlers).filter((key) => key.startsWith('community.')).sort()
  t.alike(names, ['community.admin', 'community.create', 'community.info', 'community.link', 'community.list'])
})

test('community create, link both sides, info shapes and refusals', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { community } = await a.web.request('community.create', { name: 'Bairro' })
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === community)
  t.alike({ key: entry.key, kind: entry.kind, root: entry.rootNonce === entry.nonce }, { key: community, kind: 'community', root: true }, 'stored as an own root of kind community')
  t.alike(await a.web.request('community.info', { community }), { community, name: 'Bairro', creator: a.key, groups: [], admins: 1, state: 'ready', incomplete: false })
  const { group } = await a.web.request('group.create', { name: 'Horta', join: 'approval' })
  t.is((await a.web.request('group.list')).total, 1, 'a community is not listed as a group')
  t.alike((await a.web.request('group.info', { group })).communities, [])

  a.web.events.length = 0
  t.alike(await a.web.request('community.link', { community, group, on: true }), { community, group, on: true, sides: ['community', 'group'] })
  t.alike(a.web.events.filter((e) => e.name === 'groups.changed').map((e) => e.data.group).sort(), [community, group].sort())
  t.alike((await a.web.request('group.info', { group })).communities, [community])
  t.alike(await a.web.request('community.info', { community }), { community, name: 'Bairro', creator: a.key, groups: [{ group, name: 'Horta' }], admins: 1, state: 'ready', incomplete: false })

  const lengths = [await coreLength(a, community), await coreLength(a, group)]
  t.alike((await a.web.request('community.link', { community, group, on: true })).sides, ['community', 'group'], 'already on: answered without writing')
  t.alike([await coreLength(a, community), await coreLength(a, group)], lengths)

  const { community: other } = await a.web.request('community.create', { name: 'Vila' })
  const taken = await errorOf(a.web.request('community.link', { community: other, group, on: true }))
  t.alike([taken.code, taken.message], ['USAGE', 'o grupo já está em outra comunidade'])
  const nested = await errorOf(a.web.request('community.link', { community, group: other, on: true }))
  t.alike([nested.code, nested.message], ['USAGE', FORBIDDEN], 'a community is never a group')
  const creator = await errorOf(a.web.request('community.admin', { community, member: a.key, on: true }))
  t.alike([creator.code, creator.message], ['USAGE', 'o criador da comunidade já administra'])

  await share(a, b, [community, group])
  t.alike(await b.web.request('community.info', { community }), { community, name: 'Bairro', creator: a.key, groups: [{ group, name: 'Horta' }], admins: 1, state: 'ready', incomplete: false })
  t.alike((await b.web.request('group.info', { group })).communities, [community], 'the linked community folds from replicas')
  for (const [method, params] of [
    ['community.link', { community, group, on: false }],
    ['community.admin', { community, member: b.key, on: true }]
  ]) {
    const err = await errorOf(b.web.request(method, params))
    t.alike([err.code, err.message], ['USAGE', FORBIDDEN], method)
  }
  const pending = 'cd'.repeat(32)
  t.alike(await b.web.request('community.info', { community: pending }), { community: pending, name: null, creator: null, groups: [], admins: 0, state: 'pending', incomplete: true })
  const notCommunity = await errorOf(b.web.request('community.info', { community: group }))
  t.alike([notCommunity.code, notCommunity.message], ['NOT_FOUND', 'comunidade não encontrada'])

  t.alike(await a.web.request('community.link', { community, group, on: false }), { community, group, on: false, sides: ['community', 'group'] })
  t.alike((await a.web.request('group.info', { group })).communities, [])
  t.alike((await a.web.request('community.info', { community })).groups, [])
  const off = [await coreLength(a, community), await coreLength(a, group)]
  t.alike((await a.web.request('community.link', { community, group, on: false })).sides, ['community', 'group'], 'already off: answered without writing')
  t.alike([await coreLength(a, community), await coreLength(a, group)], off)
})

test('community.list: created, linked through a group, once when both, blocklisted left out', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  t.alike(await a.web.request('community.list', {}), { communities: [] })
  const bad = await errorOf(a.web.request('community.list', { limit: 1 }))
  t.is(bad.code, 'USAGE', 'a field is refused')
  const { community } = await a.web.request('community.create', { name: 'Bairro' })
  t.alike(await a.web.request('community.list'), { communities: [{ community, name: 'Bairro', state: 'ready', creator: true, linked: false }] })
  const { group } = await a.web.request('group.create', { name: 'Horta', join: 'open' })
  await a.web.request('community.link', { community, group, on: true })
  t.alike((await a.web.request('community.list')).communities, [{ community, name: 'Bairro', state: 'ready', creator: true, linked: true }], 'created and linked: one entry')

  const { community: vila } = await b.web.request('community.create', { name: 'Vila' })
  const { group: praca } = await b.web.request('group.create', { name: 'Praça', join: 'open' })
  await b.web.request('community.link', { community: vila, group: praca, on: true })
  await share(b, a, [vila, praca])
  t.alike(await a.web.request('group.join', { group: praca }), { state: 'member' })
  t.alike((await a.web.request('community.list')).communities, [
    { community, name: 'Bairro', state: 'ready', creator: true, linked: true },
    { community: vila, name: 'Vila', state: 'ready', creator: false, linked: true }
  ])
  t.alike((await a.web.request('group.list')).groups.map((g) => g.group).sort(), [group, praca].sort(), 'group.list never lists a community')

  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, a.assoc)
  await store.writeBlocklist(a.storage, createSnapshot({ seq: 1, blocked: [vila] }, modKp, modCert))
  t.alike((await a.web.request('community.list')).communities.map((c) => c.community), [community], 'a blocklisted root is left out')
  await store.writeBlocklist(a.storage, createSnapshot({ seq: 2, blocked: [vila, community] }, modKp, modCert))
  t.alike(await a.web.request('community.list'), { communities: [] })
})

test('one side per owner: a link counts once both owners wrote it', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { community } = await a.web.request('community.create', { name: 'Bairro' })
  const { group } = await b.web.request('group.create', { name: 'Horta', join: 'open' })
  t.alike(await a.web.request('community.link', { community, group, on: true }), { community, group, on: true, sides: ['community'] })
  await share(a, b, [community])
  t.alike((await b.web.request('group.info', { group })).communities, [], 'one side only')
  t.alike(await b.web.request('community.link', { community, group, on: true }), { community, group, on: true, sides: ['group'] })
  t.alike((await b.web.request('group.info', { group })).communities, [community], 'two-way')
  t.alike((await b.web.request('community.info', { community })).groups, [{ group, name: 'Horta' }])
})

test('a community admin acts in a linked group, a new writer only after a new grant', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const c = await setup(t, { assoc: a.assoc })
  const { community } = await a.web.request('community.create', { name: 'Bairro' })
  const { group } = await a.web.request('group.create', { name: 'Horta', join: 'open' })
  await a.web.request('community.link', { community, group, on: true })
  for (const s of [b, c]) {
    await share(a, s, [community, group])
    t.alike(await s.web.request('group.join', { group }), { state: 'member' })
  }
  const cWriter = await ownWriter(c, group)
  const bWriter = await ownWriter(b, group)
  await share(c, a, [cWriter])
  await share(b, c, [bWriter])
  await share(b, a, [bWriter])

  a.web.events.length = 0
  t.alike(await a.web.request('community.admin', { community, member: c.key, on: true }), { community, member: c.key, on: true })
  t.alike(a.web.events.filter((e) => e.name === 'groups.changed').map((e) => e.data.group).sort(), [community, group].sort(), 'the community and every linked group')
  t.is((await a.web.request('community.info', { community })).admins, 2)
  await share(a, c, [community, group])
  t.is((await c.web.request('group.info', { group })).role, 'admin', 'a community admin is an admin of the linked group')
  t.alike(await c.web.request('group.ban', { group, member: b.key, on: true }), { ok: true })
  const members = async (s) => (await s.web.request('group.members', { group })).members.filter((m) => m.member === b.key).map((m) => m.banned)
  t.alike(await members(c), [true])
  await share(c, a, [cWriter])
  t.alike(await members(a), [true], 'the creator folds the community admin ban')
  const groupOp = await errorOf(c.web.request('group.admin', { group, member: b.key, on: true }))
  t.alike([groupOp.code, groupOp.message], ['USAGE', 'sem permissão no grupo'], 'a community admin never appoints group admins')

  // The admin leaves and joins again: its new writer is not in the grant, so
  // its moderation does not count until the creator grants again.
  t.alike(await c.web.request('group.leave', { group }), { state: 'left' })
  t.alike(await c.web.request('group.join', { group }), { state: 'member' })
  const cNew = await ownWriter(c, group)
  t.not(cNew, cWriter)
  t.alike(await c.web.request('group.ban', { group, member: b.key, on: false }), { ok: true })
  await share(c, a, [cWriter, cNew])
  t.alike(await members(a), [true], 'an unban from a writer no grant lists is ignored')
  await a.web.request('community.admin', { community, member: c.key, on: true })
  await share(a, c, [community])
  t.alike(await c.web.request('group.ban', { group, member: b.key, on: false }), { ok: true })
  await share(c, a, [cNew])
  t.alike(await members(a), [false], 'the new grant lists the new writer')
})

test('a hide made while an earlier community was linked holds after nine more links', async (t) => {
  t.timeout(120000)
  const a = await setup(t)
  const c = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Horta', join: 'open' })
  await a.web.request('group.post', { group, text: 'apagar' })
  const { community } = await a.web.request('community.create', { name: 'Bairro' })
  await a.web.request('community.link', { community, group, on: true })
  await share(a, c, [community, group])
  t.alike(await c.web.request('group.join', { group }), { state: 'member' })
  const cWriter = await ownWriter(c, group)
  await share(c, a, [cWriter])
  await a.web.request('community.admin', { community, member: c.key, on: true })
  await share(a, c, [community])
  t.alike(await c.web.request('group.hide', { group, target: { writer: group, seq: 1 }, on: true }), { ok: true })
  await share(c, a, [cWriter])
  const hidden = async () => (await a.web.request('group.read', { group })).items.find((p) => p.writer === group && p.seq === 1).hidden
  t.ok(await hidden(), 'hidden by the community admin')

  await a.web.request('community.link', { community, group, on: false })
  for (let i = 0; i < 9; i++) {
    const { community: next } = await a.web.request('community.create', { name: 'Vila ' + i })
    await a.web.request('community.link', { community: next, group, on: true })
    await a.web.request('community.link', { community: next, group, on: false })
  }
  t.ok(await hidden(), 'the first community still counts after nine more distinct links')
})

test('community.link refuses an ordinary group root named as the community', async (t) => {
  const a = await setup(t)
  const { group } = await a.web.request('group.create', { name: 'Horta', join: 'open' })
  const { group: other } = await a.web.request('group.create', { name: 'Feira', join: 'open' })
  const lengths = [await coreLength(a, group), await coreLength(a, other)]
  const err = await errorOf(a.web.request('community.link', { community: other, group, on: true }))
  t.alike(err && [err.code, err.message], ['USAGE', FORBIDDEN])
  t.alike([await coreLength(a, group), await coreLength(a, other)], lengths, 'nothing written')
  t.alike((await a.web.request('group.info', { group })).communities, [])
})

test('sync: a community root replicates for a member of a linked group', async (t) => {
  t.timeout(180000)
  const { testnet, until } = require('./helpers/net')
  const { member, seederOverWs, indexed, once, named } = require('./helpers/sync-groups')
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const { community } = await ops.communityCreate(a.ctx, { name: 'Bairro' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await ops.communityLink(a.ctx, { community, group, on: true })
  t.ok((await once(a, url, [])).ok, 'creator pushed the group and community roots')
  await until(() => indexed(seeder, group, group) && indexed(seeder, community, community), { name: 'roots indexed' })

  await store.addGroupReplica(b.storage, group)
  const ev = []
  t.ok((await once(b, url, ev)).ok, 'member once run ok')
  t.ok(named(ev, 'group-paged').some((e) => e.group === community), 'the linked community is paged')
  t.ok(await store.groupCoreExists(b.storage, community), 'the community root is stored')
  t.ok(named(ev, 'groups-changed').some((e) => e.group === community), 'groups-changed for the community root')
  t.alike((await ops.groupInfo(b.ctx, { group })).communities, [community], 'the member folds the link')
  t.alike((await ops.communityInfo(b.ctx, { community })).groups, [{ group, name: 'Horta' }])
})

test('community.link refuses a 33rd group on with nothing written; after an unlink it links', async (t) => {
  t.timeout(120000)
  const a = await setup(t)
  const { community } = await a.web.request('community.create', { name: 'Bairro' })
  // Groups whose roots are not held: only the community side is written.
  const keys = Array.from({ length: 33 }, () => hex(crypto.randomBytes(32)))
  for (const group of keys.slice(0, 32)) await a.web.request('community.link', { community, group, on: true })
  const length = await coreLength(a, community)
  const err = await errorOf(a.web.request('community.link', { community, group: keys[32], on: true }))
  t.alike(err && [err.code, err.message], ['USAGE', 'limite da comunidade atingido'])
  t.is(await coreLength(a, community), length, 'nothing written')
  await a.web.request('community.link', { community, group: keys[0], on: true })
  t.is(await coreLength(a, community), length, 'a group already on is not refused')
  await a.web.request('community.link', { community, group: keys[0], on: false })
  await a.web.request('community.link', { community, group: keys[32], on: true })
  t.is(await coreLength(a, community), length + 2, 'the link is written once room is made')
})

async function lastRecord (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try { return (await store.readAll(core)).pop().record } finally { await core.close() }
}

// Joins `s` to the group, then leaves and joins again until it holds `n`
// writers there -> every writer key it held.
async function writers (s, group, n) {
  const keys = new Set()
  for (let i = 0; i < n; i++) {
    if (i > 0) await s.web.request('group.leave', { group })
    await s.web.request('group.join', { group })
    keys.add(await ownWriter(s, group))
  }
  return [...keys]
}

test('an unlink past MAX_GROUP_CUTS community writers is written and the community powers stop', async (t) => {
  t.timeout(300000)
  const a = await setup(t)
  const x = await setup(t, { assoc: a.assoc })
  const p = await setup(t, { assoc: a.assoc })
  const q = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Horta', join: 'open' })
  await a.web.request('group.post', { group, text: 'um' })
  await a.web.request('group.post', { group, text: 'dois' })
  const { community } = await x.web.request('community.create', { name: 'Bairro' })
  await share(a, x, [group])
  await x.web.request('group.join', { group })
  const xWriter = await ownWriter(x, group)
  await x.web.request('community.link', { community, group, on: true })
  await share(x, a, [community, xWriter])
  await a.web.request('community.link', { community, group, on: true })
  t.alike((await a.web.request('group.info', { group })).communities, [community])
  // 17 writers of the community creator and admins in the group.
  for (const s of [p, q]) {
    await share(a, s, [group])
    const keys = await writers(s, group, 8)
    await share(s, x, keys)
    await share(s, a, keys)
  }
  // The grant lists writers only in groups x sees linked two-way.
  await share(a, x, [group])
  await x.web.request('community.admin', { community, member: p.key, on: true })
  await x.web.request('community.admin', { community, member: q.key, on: true })
  await share(x, a, [community])
  await share(x, p, [community])
  const pWriter = await ownWriter(p, group)
  const hidden = async (seq) => (await a.web.request('group.read', { group })).items.find((i) => i.writer === group && i.seq === seq).hidden
  t.alike(await p.web.request('group.hide', { group, target: { writer: group, seq: 1 }, on: true }), { ok: true })
  await share(p, a, [pWriter])
  t.ok(await hidden(1), 'the community admin hides while linked')
  const length = await coreLength(a, group)
  t.alike(await a.web.request('community.link', { community, group, on: false }), { community, group, on: false, sides: ['group'] })
  t.is(await coreLength(a, group), length + 1)
  const unlink = await lastRecord(a, group)
  t.alike([unlink.type, unlink.on, unlink.cuts.length], ['community-link', false, 16], 'the first MAX_GROUP_CUTS writers are listed')
  t.alike(unlink.cuts.map((c) => c.writer), unlink.cuts.map((c) => c.writer).sort(), 'in writer key order')
  t.alike((await a.web.request('group.info', { group })).communities, [])
  t.alike(await p.web.request('group.hide', { group, target: { writer: group, seq: 2 }, on: true }), { ok: true })
  await share(p, a, [pWriter])
  t.absent(await hidden(2), 'a hide after the unlink has no effect')
})

test('a demotion past MAX_COMMUNITY_CUTS writers is written', async (t) => {
  t.timeout(300000)
  const a = await setup(t)
  const m = await setup(t, { assoc: a.assoc })
  const { community } = await a.web.request('community.create', { name: 'Bairro' })
  const keys = []
  for (let i = 0; i < 9; i++) {
    const { group } = await a.web.request('group.create', { name: 'Horta ' + i, join: 'open' })
    await a.web.request('community.link', { community, group, on: true })
    keys.push(group)
  }
  await share(a, m, [community, ...keys])
  const all = []
  for (const group of keys) all.push(...await writers(m, group, 8))
  await share(m, a, all)
  t.alike(await a.web.request('community.admin', { community, member: m.key, on: false }), { community, member: m.key, on: false })
  const demotion = await lastRecord(a, community)
  t.alike([demotion.type, demotion.on, demotion.cuts.length], ['group-admin', false, 64], 'the first MAX_COMMUNITY_CUTS writers are listed')
  t.alike(demotion.cuts.map((c) => c.writer), demotion.cuts.map((c) => c.writer).sort())
})

test('community.link answers every owned side when only one needs a write', async (t) => {
  const a = await setup(t)
  const { community } = await a.web.request('community.create', { name: 'Bairro' })
  const { group } = await a.web.request('group.create', { name: 'Horta', join: 'open' })
  await a.web.request('community.link', { community, group, on: true })
  // The community side alone turns off, as an earlier device of the owner
  // could have left it.
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === community)
  const core = await store.openGroupWriter(a.storage, await a.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.rootNonce, 'hex'))))
  try {
    await store.appendGroupRecord(core, grp.groupLink({ group, on: false, cuts: [] }), { root: true, community: true })
  } finally {
    await core.close()
  }
  const lengths = async () => [await coreLength(a, community), await coreLength(a, group)]
  const [c0, g0] = await lengths()
  t.alike(await a.web.request('community.link', { community, group, on: true }), { community, group, on: true, sides: ['community', 'group'] })
  t.alike(await lengths(), [c0 + 1, g0], 'only the community side is written')
})
