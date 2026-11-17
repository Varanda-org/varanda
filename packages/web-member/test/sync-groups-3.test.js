// A writer whose member left the group before the seeder admitted it
// (docs/protocol.md section 10, "Scan"): the seeder lists it left, by its
// newest on:true join, and a browser node fetches it from that listing.
const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { member, seederOverWs, indexed, once, named, held } = require('./helpers/sync-groups')

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
