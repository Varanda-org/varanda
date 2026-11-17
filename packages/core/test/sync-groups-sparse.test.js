'use strict'

// A seeder keeps a writer its diary cut sparse (#350, docs/protocol.md
// section 10): below the cut, then only its leaves and key blocks, and a
// released writer as a stub. A fresh member fed by that seeder alone folds
// the group as one holding the whole copies.
const test = require('brittle')
const b4a = require('b4a')
const { testnet } = require('./helpers/net')
const { generateAssociationKeyPair } = require('../lib/cert')
const { groupCutRecord } = require('../lib/records')
const { groupPost, groupLeave } = require('../lib/group')
const store = require('../lib/store')
const member = require('../lib/member')
const { person, exchange, startSeeder, syncOnce, ownWriter, runUntil } = require('./helpers/sync-groups')
const { offlineAppend, writerEntries } = require('./helpers/group-member')

async function blocksHeld (core, from, to) {
  const out = []
  for (let i = from; i < to; i++) if (await core.has(i)) out.push(i)
  return out
}

// The blocks of each writer `ctx` holds, by key.
async function heldCopies (ctx, keys) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const out = {}
    for (const key of keys) {
      const core = s.get({ key: b4a.from(key, 'hex'), writable: false })
      await core.ready()
      out[key] = { length: core.length, contiguous: core.contiguousLength, held: await blocksHeld(core, 0, core.length) }
      await core.close()
    }
    return out
  } finally {
    await s.close()
  }
}

async function view (ctx, community, groups) {
  const out = {
    community: {
      info: await member.communityInfo(ctx, { community }),
      members: await member.communityMembers(ctx, { community }),
      groups: await member.communityGroups(ctx, { community })
    }
  }
  for (const group of groups) {
    const info = await member.groupInfo(ctx, { group })
    const members = await member.groupMembers(ctx, { group })
    const page = await member.groupRead(ctx, { group })
    out[group] = { info, members, posts: page.items.map((p) => [p.writer, p.seq, p.text]) }
  }
  return out
}

test('a fresh member fed only by a seeder folds a sparse frozen writer and a released stub like the whole copies (#350)', async (t) => {
  t.timeout(400000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const seeder = await startSeeder(t, bootstrap, kp)
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const r = await person(t, kp, 'Rui')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group: g1 } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  const { group: g2 } = await member.groupCreate(a, { name: 'Feira', join: 'open', community })
  await member.groupPost(a, { group: g1, text: 'primeiro' })
  await member.groupPost(a, { group: g2, text: 'bem-vindos' })
  // B and R learn the roots out of band; everything else travels by sync.
  await exchange(a, b)
  await exchange(a, r)
  for (const m of [b, r]) {
    await member.communityJoin(m, { community })
    await member.groupJoin(m, { group: g1 })
    await member.groupJoin(m, { group: g2 })
  }
  await member.groupPost(b, { group: g1, text: 'antes' })
  await member.groupPost(b, { group: g2, text: 'oi' })

  // W1, B's writer in G1, is frozen at its length: two posts and a leave
  // past the cut. W2, its writer in G2, is released: a post and a leave.
  const w1 = ownWriter(b, g1)
  const w2 = ownWriter(b, g2)
  const cut1 = (await writerEntries(b, g1)).length
  await offlineAppend(b, g1, groupPost({ text: 'depois' }))
  await offlineAppend(b, g1, groupPost({ text: 'depois 2' }))
  const leave1 = await offlineAppend(b, g1, groupLeave({ seen: null, cuts: [{ writer: w1, seq: cut1 + 2 }] }))
  const len2 = (await writerEntries(b, g2)).length
  await offlineAppend(b, g2, groupPost({ text: 'tchau' }))
  const leave2 = await offlineAppend(b, g2, groupLeave({ seen: null, cuts: [{ writer: w2, seq: len2 + 1 }] }))
  const s = await store.openStore(b.dataDir)
  try {
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupCutRecord({ group: g1, writer: w1, cut: cut1 }))
    await store.appendRecord(diary, groupCutRecord({ group: g2, writer: w2, cut: 0 }))
  } finally {
    await s.close()
  }

  const ra = await syncOnce(bootstrap, a)
  t.ok(ra.result.ok, 'A pushes its diary and roots: ' + ra.result.errors.join('; '))
  // B's run pushes its diary and writers; it stops once the seeder holds
  // both writers sparse.
  const sparse = async () => {
    const e1 = seeder._groupServed.get(w1)
    const e2 = seeder._groupServed.get(w2)
    const b1 = seeder._groups.get(w1)
    const b2 = seeder._groups.get(w2)
    if (!e1 || !e2 || !b1 || !b2 || e1.cutting || e2.cutting) return false
    if (b1.cut !== cut1 || b1.clearedTo !== leave1.seq + 1 || b2.cut !== 0 || b2.clearedTo !== leave2.seq + 1) return false
    const h1 = await blocksHeld(e1.core, 0, leave1.seq + 1)
    const h2 = await blocksHeld(e2.core, 0, leave2.seq + 1)
    return h1.length === cut1 + 1 && h2.length === 2
  }
  await runUntil(b, bootstrap, sparse)
  t.alike(await blocksHeld(seeder._groupServed.get(w1).core, 0, leave1.seq + 1), [...Array(cut1).keys(), leave1.seq], 'the seeder keeps W1 below its cut and its leave')
  t.alike(await blocksHeld(seeder._groupServed.get(w2).core, 0, leave2.seq + 1), [0, leave2.seq], 'and W2 as a stub')

  // R, fresh, syncs with the seeder alone (B is offline).
  await syncOnce(bootstrap, r, { timeoutMs: 30000 })
  const copies = await heldCopies(r, [w1, w2])
  t.alike(copies[w1], { length: leave1.seq + 1, contiguous: cut1, held: [...Array(cut1).keys(), leave1.seq] }, 'R holds W1 sparse')
  t.alike(copies[w2], { length: leave2.seq + 1, contiguous: 1, held: [0, leave2.seq] }, 'and W2 as a stub')
  const fromSeeder = await view(r, community, [g1, g2])

  // The whole copies, straight from B.
  await exchange(b, r)
  const whole = await heldCopies(r, [w1, w2])
  t.is(whole[w1].contiguous, leave1.seq + 1, 'control: R now holds W1 whole')
  t.is(whole[w2].contiguous, leave2.seq + 1, 'and W2')
  const full = await view(r, community, [g1, g2])
  const texts = (g) => full[g].posts.map((p) => p[2])
  t.ok(texts(g1).includes('antes'), 'control: the post below the cut counts')
  t.absent(texts(g1).includes('depois'), 'control: a post past the cut does not')
  t.absent(texts(g2).includes('oi'), 'control: a released writer counts no post')
  t.absent(full[g1].members.members.some((m) => m.member === b.key), 'control: the leave past the cut counts')
  t.alike(fromSeeder, full, 'the sparse copies fold like the whole ones')
})
