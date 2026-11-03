'use strict'

// The browser sync and protocol v2 communities, loopback only, through a
// real Seeder behind a WebSocket. Parent paging: the community a held group
// root names in its header is paged in full (its root and its community
// writers, CWs, each gated like a group writer with `member` null, and
// their binding diaries), 'community-parent' the first time it is not held;
// the roots its catalogue names are paged root only. A parent key whose root
// is a group header is this device's own verdict 'not-community', at the
// gate and when stored cores are restored at the start of a run, and nothing
// listed under it is ever gated. A protocol v1 core is swept at run start.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { member, seederOverWs, indexed, once, named, joinSeq, injectWriters } = require('./helpers/sync-groups')

const hex = (buf) => b4a.toString(buf, 'hex')

// Copies own group core `key` of `from` into `to`, listed as the sync would.
async function copyCore (from, to, key) {
  const source = await store.openGroupCoreReadOnly(from.storage, key)
  const target = await store.openGroupReplica(to.storage, key)
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
  await store.addGroupReplica(to.storage, key)
}

// A group core of `m` whose block 0 is `header(key)`, written past the
// member-ops checks (a header no operation would write): -> { key, nonce }.
async function craft (m, header, { root = false, raw = false } = {}) {
  const nonce = crypto.randomBytes(32)
  const kp = await m.ctx.groupKeyPair(new Uint8Array(nonce))
  const key = hex(kp.publicKey)
  const core = await store.openGroupWriter(m.storage, kp)
  try {
    if (raw) await core.append(header(key))
    else await store.appendGroupRecord(core, header(key), { root })
  } finally {
    await core.close()
  }
  return { key, nonce: hex(nonce) }
}

// The own diary's group-join binding `writer` to `group`.
async function bind (m, group, writer) {
  const diary = await store.openDiary(m.storage, m.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupJoinRecord({ group, writer, on: true }))
  } finally {
    await diary.close()
  }
}

// A public group root of `m` naming `community` (any key) as its parent,
// listed and bound as group.create would: -> its key.
async function craftRoot (m, community, name) {
  const { key, nonce } = await craft(m, () => grp.groupHeader({ kind: 'group', diary: m.ownHex, community, member: community, join: 'open', name }), { root: true })
  await store.putGroupWriter(m.storage, { group: key, key, nonce, rootNonce: nonce })
  await bind(m, key, key)
  return key
}

// A writer of `m` in `group` with header member `memberKey`, listed and
// bound: -> its key.
async function craftWriter (m, group, memberKey) {
  const { key, nonce } = await craft(m, () => grp.writerHeader({ group, diary: m.ownHex, member: memberKey }))
  await store.putGroupWriter(m.storage, { group, key, nonce, rootNonce: null })
  await bind(m, group, key)
  return key
}

async function ownWriter (m, group) {
  const e = (await store.readGroupWriters(m.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

// A creator `a` with open community C (Geral G) pushed, and `w` a member of
// C whose CW is pushed: -> { a, w, C, G, cw }.
async function world (t, assocKp, seeder, url) {
  const a = await member(assocKp, 'Ana')
  const w = await member(assocKp, 'Wal')
  const { community: C, group: G } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed C and Geral')
  await until(() => indexed(seeder, C, C) && indexed(seeder, G, G), { name: 'roots indexed' })
  await store.addGroupReplica(w.storage, C)
  t.ok((await once(w, url, [])).ok, 'w fetched C')
  t.is((await ops.communityJoin(w.ctx, { community: C })).state, 'member', 'w joined C')
  const cw = await ownWriter(w, C)
  const res = await once(w, url, [])
  t.ok(res.ok, 'w pushed its CW ' + JSON.stringify(res.errors))
  await until(() => indexed(seeder, C, cw), { name: 'CW indexed' })
  return { a, w, C, G, cw }
}

test('a group root naming an ordinary group as its community: neither its root nor its writers are taken', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const e = await member(assocKp, 'Edu')
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')

  // E's community CE with its Geral P: P is an ordinary group root.
  const { community: CE, group: P } = await ops.communityCreate(e.ctx, { name: 'Praça', join: 'open' })
  t.ok((await once(e, url, [])).ok, 'P root pushed')
  await until(() => indexed(seeder, P, P) && indexed(seeder, CE, CE), { name: 'P indexed' })
  // A listing under P the gate would take if P were paged as a community.
  injectWriters(seeder, P, [{ key: CE, diary: e.ownHex, length: 2, seq: await joinSeq(e, CE, CE) }])

  // A's group H names P as its community.
  const H = await craftRoot(a, P, 'Horta')
  t.ok((await once(a, url, [])).ok, 'H root pushed')
  await until(() => indexed(seeder, H, H), { name: 'H indexed' })

  // B asks for H: P is paged as H's parent and refused.
  await store.addGroupReplica(b.storage, H)
  const ev = []
  const res = await once(b, url, ev)
  t.ok(res.ok, 'member once run ok ' + JSON.stringify(res.errors))
  t.ok(named(ev, 'community-parent').some((x) => x.key === P && x.group === H), 'community-parent for P')
  t.ok(named(ev, 'group-skipped').some((x) => x.key === P && x.group === P && x.reason === 'not-community'), 'P root refused as not-community')
  t.absent(ev.some((x) => x.key === CE && x.group === P), 'nothing listed under P is gated')
  t.is(await store.groupCoreExists(b.storage, P), false, 'P root not stored')
  t.ok(await store.groupCoreExists(b.storage, H), 'H root stored')

  // Restored at start: H is in B's own list, and P's root is in its storage
  // (as a device that once held it would have it). P stays a parent key:
  // refused at once, never paged.
  await craftWriter(b, H, CE)
  await copyCore(e, b, P)
  const ev2 = []
  const res2 = await once(b, url, ev2)
  t.ok(res2.ok, 'second member run ok ' + JSON.stringify(res2.errors))
  t.ok(named(ev2, 'group-skipped').some((x) => x.key === P && x.reason === 'not-community'), 'stored P root refused as not-community')
  t.absent(named(ev2, 'group-paged').some((x) => x.group === P), 'P not paged')
  t.absent(named(ev2, 'community-parent').some((x) => x.key === P), 'P held: no community-parent')
  t.absent(ev2.some((x) => x.key === CE && x.group === P), 'nothing under P gated')
})

test('parent paging gates CWs: the root, a member CW and its diary are taken, foreign items are bad hints', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const { a, w, C, G, cw } = await world(t, assocKp, seeder, url)
  const x = await member(assocKp, 'Xis')
  const b = await member(assocKp, 'Bia')

  // Geral's root listed under C: a foreign item, a bad hint.
  injectWriters(seeder, C, [{ key: G, diary: a.ownHex, length: 1, seq: await joinSeq(a, G, G) }])

  // B holds Geral only: its parent C is paged in full.
  await store.addGroupReplica(b.storage, G)
  const ev = []
  const res = await once(b, url, ev)
  t.ok(res.ok, 'member once run ok ' + JSON.stringify(res.errors))
  t.ok(named(ev, 'community-parent').some((e) => e.key === C && e.group === G), 'community-parent for C')
  t.ok(named(ev, 'group-paged').some((e) => e.group === C), 'C is paged')
  t.ok(await store.groupCoreExists(b.storage, C), 'C root stored')
  t.ok(await store.groupCoreExists(b.storage, cw), 'the member CW stored')
  t.ok((await store.readGroupReplicas(b.storage)).includes(cw), 'and listed')
  t.ok((await store.readGroupDiaries(b.storage)).includes(w.ownHex), 'its binding diary kept')
  t.absent(ev.some((e) => e.key === G && e.group === C), 'the foreign item is never gated under C')
  t.ok(await store.groupCoreExists(b.storage, G), 'and Geral stays its own root')
  const info = await ops.communityInfo(b.ctx, { community: C })
  t.is(info.state, 'ready', 'B folds C')
  t.is(info.members, 2, 'with both members')

  // B joins C; a CW naming a member (as a group writer would) is in its
  // storage: restored at start, it is refused like at the gate.
  t.is((await ops.communityJoin(b.ctx, { community: C })).state, 'member', 'B joined C')
  const bad = await craftWriter(x, C, G)
  await copyCore(x, b, bad)
  const ev2 = []
  const res2 = await once(b, url, ev2)
  t.ok(res2.ok, 'second member run ok ' + JSON.stringify(res2.errors))
  t.is(await store.groupCoreExists(b.storage, bad), false, 'a CW naming a member is purged')
  t.absent((await store.readGroupReplicas(b.storage)).includes(bad), 'and unlisted')
  t.ok(await store.groupCoreExists(b.storage, cw), 'the member CW stays')
})

test('a community catalogue is paged root only; community.info names its groups', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const { a, w, C, G, cw } = await world(t, assocKp, seeder, url)
  const b = await member(assocKp, 'Bia')

  const { group: H } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community: C })
  t.ok((await once(a, url, [])).ok, 'H root and the create pushed')
  await until(() => indexed(seeder, H, H), { name: 'H indexed' })
  // A listing under H: a catalogue root is paged alone.
  injectWriters(seeder, H, [{ key: cw, diary: w.ownHex, length: 1, seq: await joinSeq(w, C, cw) }])

  await store.addGroupReplica(b.storage, G)
  const ev = []
  const res = await once(b, url, ev)
  t.ok(res.ok, 'member once run ok ' + JSON.stringify(res.errors))
  t.ok(await store.groupCoreExists(b.storage, H), 'the catalogue root stored')
  t.ok(named(ev, 'group-paged').some((e) => e.group === H && e.count === 1), 'its page holds its root only')
  t.absent(ev.some((e) => e.key === cw && e.group === H), 'nothing under it is gated')
  const info = await ops.communityInfo(b.ctx, { community: C })
  t.alike(info.groups.map((g) => [g.group, g.name, g.general]).sort(), [[G, 'Geral', true], [H, 'Horta', false]].sort(), 'community.info names both groups')
})

test('a protocol v1 group core is swept at the start of a run', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { url } = await seederOverWs(t, assocKp, bootstrap)
  const b = await member(assocKp, 'Bia')
  const { key } = await craft(b, (k) => ({ type: 'group-header', v: 1, diary: b.ownHex, name: 'Velho', join: 'open', at: new Date().toISOString() }), { raw: true })
  await store.addGroupReplica(b.storage, key)
  const ev = []
  t.ok((await once(b, url, ev)).ok, 'once run ok')
  t.ok(named(ev, 'group-skipped').some((e) => e.key === key && e.reason === 'legacy'), 'the v1 core is skipped as legacy')
  t.is(await store.groupCoreExists(b.storage, key), false, 'and purged')
  t.absent((await store.readGroupReplicas(b.storage)).includes(key), 'and unlisted')
})

// Appends `record` to own group core `key` of `m` (kv groupWriters nonce).
async function appendOwn (m, key, record, opts) {
  const e = (await store.readGroupWriters(m.storage)).find((x) => x.key === key)
  const kp = await m.ctx.groupKeyPair(new Uint8Array(b4a.from(e.nonce, 'hex')))
  const core = await store.openGroupWriter(m.storage, kp)
  try {
    await store.appendGroupRecord(core, record, opts)
  } finally {
    await core.close()
  }
}

test('a full catalogue: the 32 root creates are paged, a 33rd root create is an orphan', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const randomKey = () => hex(crypto.keyPair().publicKey)

  // Only the creator creates groups, all in C's root: Geral, 30 more, the
  // real 32nd group, then a 33rd create past the cap.
  const { community: C } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  for (let i = 0; i < 30; i++) await appendOwn(a, C, grp.groupCreateRecord({ group: randomKey() }), { root: true, community: true })
  const { group: valid } = await ops.groupCreate(a.ctx, { name: 'Vale', join: 'open', community: C })
  const orphan = randomKey()
  await appendOwn(a, C, grp.groupCreateRecord({ group: orphan }), { root: true, community: true })
  const pushed = await once(a, url, [], { groupRequestMs: 5, timeoutMs: 60000 })
  t.ok(pushed.ok, 'pushed ' + JSON.stringify(pushed.errors))
  await until(() => indexed(seeder, C, C) && indexed(seeder, valid, valid), { name: 'C and the group root indexed' })

  await store.addGroupReplica(b.storage, C)
  const res = await once(b, url, [], { groupRequestMs: 5 })
  t.ok(res.ok, 'member once run ok ' + JSON.stringify(res.errors))
  t.ok(await store.groupCoreExists(b.storage, valid), 'the 32nd group root is paged and stored')
  const info = await ops.communityInfo(b.ctx, { community: C })
  t.is(info.groups.length, 32, 'the fold counts 32 groups')
  t.ok(info.groups.some((g) => g.group === valid && g.name === 'Vale'), 'and names the 32nd')
  t.absent(info.groups.some((g) => g.group === orphan), 'the 33rd create is an orphan')
  t.is((await ops.communityInfo(a.ctx, { community: C })).groups.length, 32, 'the creator folds the same catalogue')
})
