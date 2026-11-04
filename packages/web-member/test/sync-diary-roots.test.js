'use strict'

// The browser sync and a second device of the same identity: every root the
// own diary binds now (diaryGroupKeys) is paged as a replica, from a fresh
// storage, with nothing appended and no writer created. A root whose only
// join was turned off is not, nor a blocked one. A once run ends only after
// the roots of the diary it fetched were paged, and a catalogue child paged
// root only is paged in full once the diary joins it.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { member, seederOverWs, indexed, sync, once, named, held, moderatorSnapshot } = require('./helpers/sync-groups')

// Another device of `a`: the same key pair and group key derivation, a
// fresh storage, nothing appended (certAdd and profileSet would fork the
// diary).
async function device (a) {
  const storage = memoryNodeStorage()
  const ctx = { ...a.ctx, storage }
  await ops.idCreate(ctx)
  return { storage, ownHex: a.ownHex, ctx }
}

async function diaryLength (m) {
  return (await ops.logRead(m.ctx)).entries.length
}

async function groupJoins (m) {
  return (await ops.logRead(m.ctx)).entries.filter((e) => e.record.type === 'group-join').length
}

async function rootHeld (m, key) {
  const h = await held(m, key)
  return h !== null && h.contiguous > 0
}

// A public group root of `m` whose header names `community` (any key) as
// its parent, listed and bound as group.create would, past the member-ops
// checks (as community-sync.test.js crafts it): -> its key.
async function craftRoot (m, community, name) {
  const nonce = crypto.randomBytes(32)
  const kp = await m.ctx.groupKeyPair(new Uint8Array(nonce))
  const key = b4a.toString(kp.publicKey, 'hex')
  const core = await store.openGroupWriter(m.storage, kp)
  try {
    await store.appendGroupRecord(core, grp.groupHeader({ kind: 'group', diary: m.ownHex, community, member: community, join: 'open', name }), { root: true })
  } finally {
    await core.close()
  }
  const hexNonce = b4a.toString(nonce, 'hex')
  await store.putGroupWriter(m.storage, { group: key, key, nonce: hexNonce, rootNonce: hexNonce })
  const diary = await store.openDiary(m.storage, m.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupJoinRecord({ group: key, writer: key, on: true }))
  } finally {
    await diary.close()
  }
  return key
}

// An `until` that fails the test instead of rejecting: a rejection out of a
// test body is unhandled and ends the whole file.
async function waitFor (t, predicate, opts) {
  try {
    await until(predicate, opts)
    return true
  } catch (err) {
    t.fail(err.message)
    return false
  }
}

test('a second device of the same identity fetches the roots its diary binds', async (t) => {
  t.timeout(110000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const e = await member(assocKp, 'Edu')

  // B, another device of A, holds A's diary (its certificate) before any
  // join: no group is stored, no certificate recovery holds its next run.
  t.ok((await once(a, url, [])).ok, 'A pushed its diary')
  const b = await device(a)
  t.ok((await once(b, url, [])).ok, 'B fetched the diary')
  t.alike(await store.readGroupReplicas(b.storage), [], 'B holds no group')

  // E's community, whose root A binds and unbinds: not bound now.
  const { community: L } = await ops.communityCreate(e.ctx, { name: 'Largo', join: 'open' })
  t.ok((await once(e, url, [])).ok, 'E pushed its community')
  const { community: C, group: G } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupJoinRecord({ group: L, writer: L, on: true }))
    await store.appendRecord(diary, groupJoinRecord({ group: L, writer: L, on: false }))
  } finally {
    await diary.close()
  }
  t.ok((await once(a, url, [])).ok, 'A pushed C and Geral')
  await until(() => indexed(seeder, C, C) && indexed(seeder, G, G) && indexed(seeder, L, L), { name: 'roots indexed' })
  const aLength = await diaryLength(a)
  const aJoins = await groupJoins(a)

  // One once run: it ends only after the diary it fetched was scanned and
  // the roots it binds were paged.
  const events = []
  const first = await once(b, url, events)
  t.ok(first.ok, 'B run after the joins ok ' + JSON.stringify(first.errors))
  t.ok(await rootHeld(b, C), 'B holds the community root')
  t.ok(await rootHeld(b, G), 'B holds the Geral root')
  t.absent(await rootHeld(b, L), 'B never fetched a root no join binds now')
  t.alike(await store.readGroupWriters(b.storage), [], 'B created no writer')
  t.is(await diaryLength(b), aLength, 'B holds A\'s diary')
  t.is(await groupJoins(b), aJoins, 'B appended no group-join')
  t.absent(named(events, 'group-skipped').some((x) => x.group === C || x.group === G), 'neither root skipped')

  // A posts to Geral; B's next run keeps both roots live and takes it.
  const before = await held(b, G)
  await ops.groupPost(a.ctx, { group: G, text: 'oi do bairro' })
  t.ok((await once(a, url, [])).ok, 'A pushed the post')
  const third = []
  const res = await once(b, url, third)
  t.ok(res.ok, 'B second run ok ' + JSON.stringify(res.errors))
  t.ok((await held(b, G)).contiguous > before.contiguous, 'the post reached B')
  t.absent(named(third, 'group-skipped').some((x) => x.group === C || x.group === G), 'both roots stay live')
  t.alike(await store.readGroupWriters(b.storage), [], 'still no writer')

  // A third device whose blocklist names Geral: Geral is never fetched.
  const c = await device(a)
  await store.writeBlocklist(c.storage, moderatorSnapshot(assocKp, { blocked: [G] }))
  const blocked = []
  t.ok((await once(c, url, blocked)).ok, 'C first run ok')
  t.ok(await rootHeld(c, C), 'the community root is fetched')
  t.is(await store.groupCoreExists(c.storage, G), false, 'the blocked root is never stored')
  t.absent(named(blocked, 'group-paged').some((x) => x.group === G), 'the blocked root is never paged')
})

test('a catalogue child paged root only is paged in full once the diary joins it', async (t) => {
  t.timeout(110000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const e = await member(assocKp, 'Edu')
  const a = await member(assocKp, 'Ana')

  // E's community CE with a group H; A joins CE, not H.
  const { community: CE } = await ops.communityCreate(e.ctx, { name: 'Praça', join: 'open' })
  const { group: H } = await ops.groupCreate(e.ctx, { name: 'Horta', join: 'open', community: CE })
  t.ok((await once(e, url, [])).ok, 'E pushed CE and H')
  await until(() => indexed(seeder, CE, CE) && indexed(seeder, H, H), { name: 'roots indexed' })
  await store.addGroupReplica(a.storage, CE)
  t.ok((await once(a, url, [])).ok, 'A fetched CE')
  t.is((await ops.communityJoin(a.ctx, { community: CE })).state, 'member', 'A joined CE')
  t.ok((await once(a, url, [])).ok, 'A pushed its join')

  // B, a device of A, holds CE; its catalogue names H, paged root only.
  const b = await device(a)
  t.ok((await once(b, url, [])).ok, 'B first run ok')
  t.ok(await rootHeld(b, CE), 'B holds CE')
  t.ok(await rootHeld(b, H), 'B holds H\'s root')

  // A continuous run of B pages H root only; no timed pass follows within
  // the test, so only the diary's join pages H again. Whether that page
  // lists W depends on when the seeder indexes it, so the page itself is
  // what the run is checked for.
  const ev = []
  const ac = new AbortController()
  const run = sync(b, url, ev, { signal: ac.signal, groupPageMs: 600000 })
  let W = null
  try {
    if (!await waitFor(t, () => named(ev, 'group-paged').some((x) => x.group === H && x.count === 1), { name: 'H paged root only', timeoutMs: 30000 })) return
    const mark = ev.length

    // A joins H and posts there with a new writer W; B's diary takes the join.
    await ops.groupJoin(a.ctx, { group: H, community: CE })
    await ops.groupPost(a.ctx, { group: H, text: 'oi da horta' })
    W = (await ops.logRead(a.ctx)).entries.find((x) => x.record.type === 'group-join' && x.record.group === H && x.record.on).record.writer
    t.not(W, H, 'W is not H\'s root')
    t.ok((await once(a, url, [])).ok, 'A pushed W')
    if (!await waitFor(t, () => ev.slice(mark).some((x) => x.event === 'group-paged' && x.group === H), { name: 'H paged again after the join', timeoutMs: 30000 })) return
    t.pass('the join paged H again within the run')
  } finally {
    ac.abort()
    await run
  }

  // Delivery, once the seeder lists W: a once run adopts H as a replica
  // from the start and pages it in full.
  if (!await waitFor(t, () => indexed(seeder, H, W), { name: 'W indexed' })) return
  const res = await once(b, url, [])
  t.ok(res.ok, 'B once run ok ' + JSON.stringify(res.errors))
  t.ok(((await held(b, W)) || { contiguous: 0 }).contiguous >= 2, 'B fetched W and its post')
  t.alike(await store.readGroupWriters(b.storage), [], 'B created no writer')
})

test('a diary-bound group another bound root names as its community is still held', async (t) => {
  t.timeout(110000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')

  // A's community C with its Geral G1, and G2 whose header names G1 (a
  // group) as its community: the diary binds all three.
  const { community: C, group: G1 } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const G2 = await craftRoot(a, G1, 'Horta')
  t.ok((await once(a, url, [])).ok, 'A pushed C, G1 and G2')
  await until(() => indexed(seeder, C, C) && indexed(seeder, G1, G1) && indexed(seeder, G2, G2), { name: 'roots indexed' })

  // B, another device of A: the first run fetches every root, the second
  // starts with G2 stored, its header read before any page.
  const b = await device(a)
  for (const run of ['first', 'second']) {
    const ev = []
    const res = await once(b, url, ev)
    t.ok(res.ok, 'B ' + run + ' run ok ' + JSON.stringify(res.errors))
    t.ok(await rootHeld(b, G1), 'B holds G1 after the ' + run + ' run')
    t.ok(await rootHeld(b, G2), 'B holds G2 after the ' + run + ' run')
    t.absent(named(ev, 'group-skipped').some((x) => x.group === G1), 'G1 never refused in the ' + run + ' run')
  }
})
