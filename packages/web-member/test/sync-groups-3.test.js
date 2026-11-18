// A writer whose member left the group before the seeder admitted it
// (docs/protocol.md section 10, "Scan"): the seeder lists it left, by its
// newest on:true join, and a browser node fetches it from that listing.
// A boxless writer of a private group its diary replaced and released (cut
// 0) is held as a stub, block 0 alone, so the fold never waits for it.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const grp = require('@varanda/core/lib/group')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { member, seederOverWs, indexed, sync, once, named, held, lender } = require('./helpers/sync-groups')

// The diary seqs of m's joins of `writer` to `group`, by `on`.
async function joinSeqs (m, group, writer) {
  const { entries } = await ops.logRead(m.ctx)
  const joins = entries.filter((e) => e.record.type === 'group-join' && e.record.group === group && e.record.writer === writer)
  return { on: joins.filter((e) => e.record.on).map((e) => e.seq), off: joins.filter((e) => !e.record.on).map((e) => e.seq) }
}

test('a writer that left online is fetched from the seeder listing, no hint disproved (#350)', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const c = await member(assocKp, 'Caio')
  const { community } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(b.storage, group)
  t.ok((await once(b, url, [])).ok, 'member fetched the roots')
  t.is((await ops.communityJoin(b.ctx, { community })).state, 'member', 'joined the community')
  t.is((await ops.groupJoin(b.ctx, { group })).state, 'member', 'joined the group')
  await ops.groupPost(b.ctx, { group, text: 'oi' })
  const w = (await store.readGroupWriters(b.storage)).find((e) => e.group === group).key
  // B leaves with the group folded, before any seeder saw its writer: a
  // leave in the writer and the diary's join turned off.
  t.is((await ops.groupLeave(b.ctx, { group })).state, 'left')
  const seqs = await joinSeqs(b, group, w)
  t.is(seqs.on.length, 1)
  t.is(seqs.off.length, 1, 'the leave turned the join off')
  t.ok((await once(b, url, [])).ok, 'member pushed its diary')
  await until(() => indexed(seeder, group, w) && seeder._groupServed.get(w) && seeder._groupServed.get(w).headerOk, { name: 'writer indexed', timeoutMs: 30000 })
  const item = seeder.groupWriters({ group, after: null, limit: 64 }).items.find((it) => it.key === w)
  t.is(seeder._groupIndex.writer(w).left, true, 'listed left')
  t.is(item.seq, seqs.on[0], 'by its on join, never the off one')

  await store.addGroupReplica(c.storage, group)
  const ev = []
  t.ok((await once(c, url, ev)).ok, 'the reader synced')
  const skips = named(ev, 'group-skipped').filter((e) => e.key === w).map((e) => e.reason)
  t.alike(skips, [], 'the listing of B\'s writer is not disproved (no unbound hint charged to the seeder)')
  t.ok(await held(c, w), 'the reader holds B\'s writer')
  t.ok((await ops.groupRead(c.ctx, { group })).items.some((p) => p.text === 'oi'), 'B\'s post from before the leave is read')
})

// A member of the sync-groups helper with this device's box keys, which a
// private group needs.
async function boxedMember (t, assocKp, name) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const groupKeys = createGroupKeys()
  await groupKeys.unlock(storage, prf)
  t.teardown(() => groupKeys.close())
  const ownHex = b4a.toString(keyPair.publicKey, 'hex')
  const ctx = { storage, association: b4a.toString(assocKp.publicKey, 'hex'), keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce), groupKeys }
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
  await ops.profileSet(ctx, { name, bio: '' })
  return { storage, ownHex, ctx }
}

async function pipe (source, target) {
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
}

async function copyCore (from, to, key) {
  await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to.storage, key))
  await store.addGroupReplica(to.storage, key)
}

// `from`'s diary and the group cores `keys`, copied to `to` as a sync
// would store them.
async function share (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to.storage, from.ownHex))
  for (const key of keys) await copyCore(from, to, key)
  await store.addGroupDiary(to.storage, from.ownHex)
}

async function ownWriter (m, group) {
  const e = (await store.readGroupWriters(m.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

async function blocksHeld (core, from, to) {
  const out = []
  for (let i = from; i < to; i++) if (await core.has(i)) out.push(i)
  return out
}

// -> { length, contiguous, held } of a stored group core. Only with no run
// of m live.
async function heldCopy (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  if (core === null) return null
  try {
    return { length: core.length, contiguous: core.contiguousLength, held: await blocksHeld(core, 0, core.length) }
  } finally {
    await core.close()
  }
}

// B joins A's private group G by key before holding its root: a boxless
// writer W0, with a block past its header. Once the root arrives B's join
// replaces it by a boxed writer W1, cutting W0 at 0 (released). B's run
// keeps W0 and serves it until the seeder holds it as a stub (#350).
async function releasedBoxless (t) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await boxedMember(t, assocKp, 'Ana')
  const b = await boxedMember(t, assocKp, 'Bia')
  const r = await boxedMember(t, assocKp, 'Rui')
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'open', visibility: 'private', community })
  await share(a, b, [community, general])
  t.is((await ops.communityJoin(b.ctx, { community })).state, 'member', 'B joined the community')
  const cw = await ownWriter(b, community)
  t.is((await ops.groupJoin(b.ctx, { group, community })).state, 'pending', 'B joined G before holding its root')
  const w0 = await ownWriter(b, group)
  const entry = (await store.readGroupWriters(b.storage)).find((x) => x.group === group)
  const core = await store.openGroupWriter(b.storage, await b.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.nonce, 'hex'))))
  try {
    t.is((await store.readAll(core))[0].record.box, null, 'W0 has no box')
    await store.appendGroupRecord(core, grp.groupPost({ text: 'antes' }), {})
  } finally {
    await core.close()
  }
  await copyCore(a, b, group)
  t.is((await ops.groupJoin(b.ctx, { group, community })).state, 'requested', 'the root arrived: B joins again')
  const w1 = await ownWriter(b, group)
  t.not(w1, w0, 'with a new writer')
  const { entries } = await ops.logRead(b.ctx)
  const walk = grp.slotWalk(grp.groupJoinHistory(entries, group), grp.groupCutHistory(entries, group), group)
  t.ok(walk.released.has(w0) && walk.live.has(w1), 'B\'s diary released W0 (cut 0) and counts W1')
  t.ok((await once(a, url, [])).ok, 'A pushed')

  const ac = new AbortController()
  const run = sync(b, url, [], { signal: ac.signal })
  try {
    await until(async () => {
      const e = seeder._groupServed.get(w0)
      const s = seeder._groups.get(w0)
      if (!e || !s || e.cutting || s.cut !== 0 || s.clearedTo !== 2) return false
      if (!indexed(seeder, group, w0) || !indexed(seeder, group, w1) || !indexed(seeder, community, cw)) return false
      return (await blocksHeld(e.core, 0, 2)).length === 1
    }, { name: 'the seeder holds W0 as a stub', timeoutMs: 60000 })
  } finally {
    ac.abort()
    await run
  }
  t.alike(await heldCopy(b, w0), { length: 2, contiguous: 2, held: [0, 1] }, 'B keeps the W0 it wrote')
  t.is((await ops.groupRead(b.ctx, { group })).incomplete, false, 'and B\'s fold of G is complete')
  return { seeder, url, r, community, group, w0, w1, cw }
}

test('a fresh reader holds a released boxless writer as a stub, block 0 alone, and folds complete (#350)', async (t) => {
  t.timeout(240000)
  const { url, r, group, w0 } = await releasedBoxless(t)
  await store.addGroupReplica(r.storage, group)
  const ev = []
  const rr = await once(r, url, ev)
  t.ok(rr.ok, 'R\'s run ends ok: ' + JSON.stringify(rr.errors))
  t.alike(await heldCopy(r, w0), { length: 2, contiguous: 1, held: [0] }, 'R holds W0\'s block 0 alone')
  t.is((await ops.groupRead(r.ctx, { group })).incomplete, false, 'R\'s fold of G is complete')
})

test('a boxless writer refused before its diary is held is gated again as a stub once the diary is (#350)', async (t) => {
  t.timeout(240000)
  const { seeder, url, r, community, group, w0, w1, cw } = await releasedBoxless(t)
  // R first sees W0 alone: no writer of B's, so not B's diary either.
  const hidden = new Set([w1, cw])
  const real = seeder.groupWriters.bind(seeder)
  seeder.groupWriters = (q) => {
    const page = real(q)
    return hidden.size === 0 ? page : { ...page, items: page.items.filter((it) => !hidden.has(it.key)) }
  }
  await store.addGroupReplica(r.storage, group)
  const ev = []
  const lent = lender()
  const ac = new AbortController()
  const run = sync(r, url, ev, { signal: ac.signal, groupPageMs: 300, reader: lent.reader })
  try {
    await until(() => named(ev, 'group-skipped').some((e) => e.key === w0 && e.reason === 'header-invalid'), { name: 'W0 refused', timeoutMs: 30000 })
    t.absent(lent.held(w0), 'W0 is refused while B\'s diary is not held')
    hidden.clear()
    await until(() => {
      const h = lent.held(w0)
      const c = lent.held(community)
      const settled = named(ev, 'settled')
      return h !== null && h.contiguous === 1 && c !== null && c.contiguous > 0 && settled.length > 0 && settled[settled.length - 1].settled
    }, { name: 'W0 held as a stub, the run settled', timeoutMs: 60000 })
  } finally {
    ac.abort()
    await run
  }
  t.alike(await heldCopy(r, w0), { length: 2, contiguous: 1, held: [0] }, 'then W0 is held, block 0 alone')
  t.ok(await held(r, community), 'R holds G\'s community')
  t.is((await ops.groupRead(r.ctx, { group })).incomplete, false, 'and R\'s fold of G is complete')
  // A later run keeps the stored stub (its diary, as stored, releases it).
  const again = []
  const rr = await once(r, url, again)
  t.ok(rr.ok, 'R\'s next run ends ok: ' + JSON.stringify(rr.errors))
  t.absent(named(again, 'group-skipped').some((e) => e.key === w0), 'without refusing W0')
  t.alike(await heldCopy(r, w0), { length: 2, contiguous: 1, held: [0] }, 'still block 0 alone')
  t.is((await ops.groupRead(r.ctx, { group })).incomplete, false, 'and the fold still complete')
})
