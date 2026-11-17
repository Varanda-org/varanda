// A seeder keeps a writer its diary cut sparse (#350, docs/protocol.md
// "Sparse copies"): below the cut, then only its leaves and key blocks. The
// owner's --once counts that writer pushed at its cut, and a fresh browser
// member fed by that seeder alone ends its --once holding the sparse copy.
const test = require('brittle')
const b4a = require('b4a')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { groupCutRecord } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { member, seederOverWs, indexed, sync, once, held } = require('./helpers/sync-groups')

async function blocksHeld (core, from, to) {
  const out = []
  for (let i = from; i < to; i++) if (await core.has(i)) out.push(i)
  return out
}

// -> { length, contiguous, held } of a stored group core. Only with no run
// of m live (helpers/sync-groups.js held()).
async function heldCopy (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  try {
    return { length: core.length, contiguous: core.contiguousLength, held: await blocksHeld(core, 0, core.length) }
  } finally {
    await core.close()
  }
}

async function ownWriter (m, group) {
  const e = (await store.readGroupWriters(m.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

// A leave on m's own writer in group, written past the member ops as an
// offline device would: group.leave also unbinds the writer in the diary,
// and a seeder lists a writer its diary unbound with that record, which a
// reader's gate refuses (it proves an on: true join).
async function offlineLeave (m, group) {
  const entry = (await store.readGroupWriters(m.storage)).find((x) => x.group === group)
  const core = await store.openGroupWriter(m.storage, await m.ctx.groupKeyPair(new Uint8Array(b4a.from(entry.nonce, 'hex'))))
  try {
    await store.appendGroupRecord(core, grp.groupLeave({ seen: null, cuts: [{ writer: entry.key, seq: core.length }] }), {})
    return core.length
  } finally {
    await core.close()
  }
}

test('a sparse cut writer: the owner\'s and a fresh reader\'s --once end ok (#350)', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const r = await member(assocKp, 'Rui')
  const { community } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  await ops.groupPost(a.ctx, { group, text: 'oi' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })

  await store.addGroupReplica(b.storage, group)
  t.ok((await once(b, url, [])).ok, 'B fetched the group and its community')
  t.is((await ops.communityJoin(b.ctx, { community })).state, 'member', 'B joined the community')
  t.is((await ops.groupJoin(b.ctx, { group })).state, 'member', 'and the group')
  await ops.groupPost(b.ctx, { group, text: 'antes' })
  const w = await ownWriter(b, group)
  const cut = (await held(b, w)).length
  await ops.groupPost(b.ctx, { group, text: 'depois' })
  const length = await offlineLeave(b, group)
  const diary = await store.openDiary(b.storage, b.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupCutRecord({ group, writer: w, cut }))
  } finally {
    await diary.close()
  }

  // B's run pushes its diary and writers; it stops once the seeder holds W
  // sparse.
  const ac = new AbortController()
  const run = sync(b, url, [], { signal: ac.signal })
  try {
    await until(async () => {
      const e = seeder._groupServed.get(w)
      const s = seeder._groups.get(w)
      if (!e || !s || e.cutting || s.cut !== cut || s.clearedTo !== length) return false
      return (await blocksHeld(e.core, 0, length)).length === cut + 1
    }, { name: 'the seeder holds W sparse', timeoutMs: 60000 })
  } finally {
    ac.abort()
    await run
  }
  t.alike(await blocksHeld(seeder._groupServed.get(w).core, 0, length), [...Array(cut).keys(), length - 1], 'the seeder keeps W below its cut and its leave')

  // The owner's --once counts W pushed at its cut.
  const rb = await once(b, url, [])
  t.ok(rb.ok, 'B\'s run ends ok before its deadline: ' + JSON.stringify(rb.errors))

  // R, fresh, syncs with the seeder alone; its --once ends once it holds
  // every block the seeder advertises.
  await store.addGroupReplica(r.storage, group)
  const rr = await once(r, url, [])
  t.ok(rr.ok, 'R\'s run ends ok before its deadline: ' + JSON.stringify(rr.errors))
  t.alike(await heldCopy(r, w), { length, contiguous: cut, held: [...Array(cut).keys(), length - 1] }, 'R holds W sparse')
  const members = (await ops.groupMembers(r.ctx, { group })).members.map((m) => m.member)
  t.absent(members.includes(b.ownHex), 'the leave past the hole counts')
  const texts = (await ops.groupRead(r.ctx, { group })).items.map((p) => p.text)
  t.ok(texts.includes('antes'), 'the post below the cut counts')
  t.absent(texts.includes('depois'), 'the post past the cut does not')
})

test('the owner confirms a cut writer only once the seeder holds its leave past the cut (#350)', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const { community } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  await ops.groupPost(a.ctx, { group, text: 'oi' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(b.storage, group)
  t.ok((await once(b, url, [])).ok, 'B fetched the group and its community')
  await ops.communityJoin(b.ctx, { community })
  await ops.groupJoin(b.ctx, { group })
  await ops.groupPost(b.ctx, { group, text: 'antes' })
  const w = await ownWriter(b, group)
  const cut = (await held(b, w)).length
  await ops.groupPost(b.ctx, { group, text: 'depois' })
  const length = await offlineLeave(b, group)
  const diary = await store.openDiary(b.storage, b.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupCutRecord({ group, writer: w, cut }))
  } finally {
    await diary.close()
  }

  // The seeder holds W below the cut but has not read past it yet.
  const read = seeder._groupPastRange
  let resume = null
  const stalled = new Promise((resolve) => { resume = resolve })
  seeder._groupPastRange = async function (...args) {
    await stalled
    return read.apply(this, args)
  }
  const events = []
  const first = await once(b, url, events, { timeoutMs: 15000 })
  t.absent(first.ok, 'B\'s run does not confirm W at its cut alone')
  t.ok(first.errors.join('; ').includes(w + ':push ' + length), 'it waits for W: ' + JSON.stringify(first.errors))
  t.absent(events.some((e) => e.event === 'group-pushed' && e.key === w), 'and never reports it pushed')
  t.absent(await seeder._groupServed.get(w).core.has(length - 1), 'control: the seeder lacks the leave')

  resume()
  const again = []
  const second = await once(b, url, again)
  t.ok(second.ok, 'once the seeder reads past the cut the run ends ok: ' + JSON.stringify(second.errors))
  t.ok(again.some((e) => e.event === 'group-pushed' && e.key === w && e.length === length), 'W reported pushed at its length')
  t.ok(await seeder._groupServed.get(w).core.has(length - 1), 'with the leave at the seeder')
})
