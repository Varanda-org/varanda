'use strict'

// The browser sync and the communities a group root names, loopback only,
// through a real Seeder behind a WebSocket: a key named by a community-link
// is paged as a community, never as a group. Its root must be a community
// header (an ordinary group root there is this device's own verdict
// 'not-community'), and no writer listed under it is ever gated or stored,
// at the gate or when stored cores are restored at the start of a run.
const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { member, seederOverWs, indexed, once, named, joinSeq, injectWriters } = require('./helpers/sync-groups')

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

// `w` fetches the root of open group `group`, joins, posts and pushes: -> its writer key.
async function joinAndPush (t, w, group, url) {
  await store.addGroupReplica(w.storage, group)
  t.ok((await once(w, url, [])).ok, 'root fetched')
  t.alike(await ops.groupJoin(w.ctx, { group }), { state: 'member' })
  await ops.groupPost(w.ctx, { group, text: 'oi' })
  const writer = (await store.readGroupWriters(w.storage)).find((e) => e.group === group).key
  const res = await once(w, url, [])
  t.ok(res.ok, 'writer pushed ' + JSON.stringify(res.errors))
  return writer
}

test('a group root naming an ordinary group as its community: neither its root nor its writers are taken', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const e = await member(assocKp, 'Edu')
  const w = await member(assocKp, 'Wal')
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')

  // An ordinary public group P with a writer.
  const { group: P } = await ops.groupCreate(e.ctx, { name: 'Praça', join: 'open' })
  t.ok((await once(e, url, [])).ok, 'P root pushed')
  await until(() => indexed(seeder, P, P), { name: 'P indexed' })
  const W = await joinAndPush(t, w, P, url)
  await until(() => indexed(seeder, P, W), { name: 'P writer indexed' })

  // A's group H names P as its community (only the group side is A's).
  const { group: H } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const link = await ops.communityLink(a.ctx, { community: P, group: H, on: true })
  t.alike(link.sides, ['group'], 'A writes the group side only')
  t.ok((await once(a, url, [])).ok, 'H root pushed')
  await until(() => indexed(seeder, H, H), { name: 'H indexed' })

  // B asks for H: P is paged as a linked community and refused.
  await store.addGroupReplica(b.storage, H)
  const ev = []
  const res = await once(b, url, ev)
  t.ok(res.ok, 'member once run ok ' + JSON.stringify(res.errors))
  t.ok(named(ev, 'group-skipped').some((x) => x.key === P && x.group === P && x.reason === 'not-community'), 'P root refused as not-community')
  t.absent(ev.some((x) => x.key === W), 'P writer never gated')
  t.is(await store.groupCoreExists(b.storage, P), false, 'P root not stored')
  t.is(await store.groupCoreExists(b.storage, W), false, 'P writer not stored')
  t.absent((await store.readGroupReplicas(b.storage)).includes(W), 'nor listed')
  t.ok(await store.groupCoreExists(b.storage, H), 'H root stored')

  // Restored at start: B joins H, and P's root is in its storage (as a
  // device that once held it would have it). P stays a linked-only key:
  // refused at once, never paged, its writer never gated.
  t.alike(await ops.groupJoin(b.ctx, { group: H }), { state: 'member' })
  await copyCore(e, b, P)
  const ev2 = []
  const res2 = await once(b, url, ev2)
  t.ok(res2.ok, 'second member run ok ' + JSON.stringify(res2.errors))
  t.ok(named(ev2, 'group-skipped').some((x) => x.key === P && x.reason === 'not-community'), 'stored P root refused as not-community')
  t.absent(named(ev2, 'group-paged').some((x) => x.group === P), 'P not paged')
  t.absent(ev2.some((x) => x.key === W), 'P writer never gated')
  t.is(await store.groupCoreExists(b.storage, W), false, 'P writer still not stored')
})

test('a real community page with an intruder writer item: only its root is gated', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const w = await member(assocKp, 'Wal')
  const b = await member(assocKp, 'Bia')

  const { group: G } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const { group: Q } = await ops.groupCreate(a.ctx, { name: 'Quadra', join: 'open' })
  const { community: C } = await ops.communityCreate(a.ctx, { name: 'Bairro' })
  const link = await ops.communityLink(a.ctx, { community: C, group: G, on: true })
  t.alike(link.sides, ['community', 'group'], 'A writes both sides')
  t.ok((await once(a, url, [])).ok, 'roots pushed')
  await until(() => indexed(seeder, G, G) && indexed(seeder, Q, Q) && indexed(seeder, C, C), { name: 'roots indexed' })

  // A writer of another group, listed by the seeder under the community.
  const W = await joinAndPush(t, w, Q, url)
  injectWriters(seeder, C, [{ key: W, diary: w.ownHex, length: 2, seq: await joinSeq(w, Q, W) }])

  await store.addGroupReplica(b.storage, G)
  const ev = []
  const res = await once(b, url, ev)
  t.ok(res.ok, 'member once run ok ' + JSON.stringify(res.errors))
  t.ok(named(ev, 'group-paged').some((x) => x.group === C && x.count === 1), 'the community page holds its root only')
  t.absent(named(ev, 'group-skipped').some((x) => x.key === C), 'the community root is accepted')
  t.ok(await store.groupCoreExists(b.storage, C), 'community root stored')
  t.absent(ev.some((x) => x.key === W), 'the intruder is never gated')
  t.is(await store.groupCoreExists(b.storage, W), false, 'nor stored')
})
