'use strict'

// Member sync of a writer whose member left the group before a seeder
// admitted it (docs/protocol.md section 10, "Scan"): the seeder lists it
// left, by its newest on:true join, and a reader fetches it from that
// listing.
const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('../lib/cert')
const member = require('../lib/member')
const store = require('../lib/store')
const { groupJoinHistory } = require('../lib/group')
const { person, exchange, startSeeder, syncOnce, stored, ownWriter, texts } = require('./helpers/sync-groups')

// The diary seqs of ctx's joins of `writer` to `group`, by `on`.
async function joinSeqs (ctx, group, writer) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const joins = groupJoinHistory(await store.readAll(await store.openDiary(s)), group).filter((j) => j.writer === writer)
    return { on: joins.filter((j) => j.on).map((j) => j.seq), off: joins.filter((j) => !j.on).map((j) => j.seq) }
  } finally {
    await s.close()
  }
}

test('a writer that left online is listed by its on join: a reader fetches it, no hint is disproved (#350)', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const seeder = await startSeeder(t, bootstrap, kp)
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await member.groupPost(a, { group, text: 'primeiro' })
  await exchange(a, b)
  await member.communityJoin(b, { community })
  await member.groupJoin(b, { group })
  await member.groupPost(b, { group, text: 'oi' })
  const wb = ownWriter(b, group)
  // B leaves with the group folded: a leave in its writer and its diary's
  // join turned off, all before any seeder saw its writer.
  t.is((await member.groupLeave(b, { group })).state, 'left')
  const seqs = await joinSeqs(b, group, wb)
  t.is(seqs.on.length, 1)
  t.is(seqs.off.length, 1, 'the leave turned the join off')

  const ra = await syncOnce(bootstrap, a)
  t.ok(ra.result.ok, 'A pushes its diary and root: ' + ra.result.errors.join('; '))
  const rb = await syncOnce(bootstrap, b)
  t.ok(rb.result.ok, 'B pushes its diary: ' + rb.result.errors.join('; '))
  await until(() => {
    const e = seeder._groupServed.get(wb)
    return e && e.headerOk && seeder._groupIndex.writer(wb) !== null
  }, { name: 'escritor de B no semeador', timeoutMs: 30000 })
  const row = seeder._groupIndex.writer(wb)
  t.is(row.left, true, 'listed left')
  t.is(row.seq, seqs.on[0], 'by its on join, never the off one')

  const ra2 = await syncOnce(bootstrap, a)
  t.ok(ra2.result.ok, ra2.result.errors.join('; '))
  const skips = ra2.events.filter((ev) => ev.event === 'group-skipped' && ev.key === wb).map((ev) => ev.reason)
  t.alike(skips, [], 'the listing of B\'s writer is not disproved (no unbound hint charged to the seeder)')
  t.ok(ra2.events.some((ev) => ev.event === 'group-downloaded' && ev.key === wb), 'A fetches B\'s writer')
  t.ok(await stored(a, wb), 'and keeps it')
  t.ok((await texts(a, group)).includes('oi'), 'B\'s post from before the leave is read')
})
