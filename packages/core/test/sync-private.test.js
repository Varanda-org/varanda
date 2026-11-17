'use strict'

// Member sync of private groups (lib/sync.js): a private root syncs like a
// public one, and a writer whose `box` does not match its root's verified
// visibility is refused as 'header-invalid' (docs/protocol.md section 10,
// "Private groups"), also when the root is learned after the writer.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { createCert, generateAssociationKeyPair } = require('../lib/cert')
const { writerHeader, groupHeader, groupPost, validateGroupRecord } = require('../lib/group')
const { memberCertRecord, groupJoinRecord, groupCutRecord } = require('../lib/records')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, PARENT, person, exchange, startSeeder, syncOnce, stored, ownWriter, fakeSeeder, groupMember, runUntil } = require('./helpers/sync-groups')

const enc = (record) => b4a.from(JSON.stringify(record))
const box = () => hex(crypto.randomBytes(32))

// A diary bound to `group` by a join and its writer (or the root itself
// when `root` is a header), under unique names in `cs`.
async function bound (cs, kp, group, name, { writerBox = null, root = null } = {}) {
  const d = cs.get({ name: 'diary-' + name })
  await d.ready()
  const dkey = hex(d.key)
  const w = root || cs.get({ name: 'writer-' + name })
  await w.ready()
  const wkey = hex(w.key)
  const g = group || wkey
  await d.append(enc(memberCertRecord(createCert({ member: dkey }, kp))))
  await d.append(enc(groupJoinRecord({ group: g, writer: wkey, on: true })))
  return { d, dkey, w, wkey, group: g }
}

// A root R (`visibility`) and two writers of R, one with a box and one
// without, in the fake seeder's store.
async function fixture (fake, kp, visibility) {
  const root = fake.store.get({ name: 'root' })
  await root.ready()
  const group = hex(root.key)
  const r = await bound(fake.store, kp, group, 'root', { root })
  const header = visibility === 'private'
    ? groupHeader({ community: PARENT, member: PARENT, diary: r.dkey, visibility: 'private', join: 'approval', name: null, box: box() })
    : groupHeader({ community: PARENT, member: PARENT, diary: r.dkey, name: 'Praça', join: 'open' })
  await root.append(enc(header))
  const boxed = await bound(fake.store, kp, group, 'boxed')
  await boxed.w.append(enc(writerHeader({ group, diary: boxed.dkey, box: box(), member: PARENT })))
  const bare = await bound(fake.store, kp, group, 'bare')
  await bare.w.append(enc(writerHeader({ group, diary: bare.dkey, member: PARENT })))
  await bare.w.append(enc(groupPost({ text: 'p' })))
  return {
    group,
    root: { key: group, diary: r.dkey, length: 1, seq: 1 },
    boxed: { key: boxed.wkey, diary: boxed.dkey, length: 1, seq: 1 },
    bare: { key: bare.wkey, diary: bare.dkey, length: 2, seq: 1 }
  }
}

const sorted = (items) => items.sort((x, y) => x.key < y.key ? -1 : 1)
const skipped = (events, key) => events.filter((ev) => ev.event === 'group-skipped' && ev.key === key).map((ev) => ev.reason)

test('a private group\'s writer without a box is refused and never stored', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const f = await fixture(fake, kp, 'private')
  items.push(...sorted([f.root, f.boxed, f.bare]))
  const m = await groupMember(t, kp, f.group)
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.alike(skipped(events, f.bare.key), ['header-invalid'], 'the boxless writer is header-invalid')
  t.absent(await stored(m, f.bare.key), 'and is not stored')
  t.ok(await stored(m, f.group), 'the private root is stored')
  t.ok(await stored(m, f.boxed.key), 'the boxed writer is stored')
})

test('a public group\'s writer with a box is refused and never stored', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const f = await fixture(fake, kp, 'public')
  items.push(...sorted([f.root, f.boxed, f.bare]))
  const m = await groupMember(t, kp, f.group)
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.alike(skipped(events, f.boxed.key), ['header-invalid'], 'the boxed writer is header-invalid')
  t.absent(await stored(m, f.boxed.key), 'and is not stored')
  t.ok(await stored(m, f.bare.key), 'the boxless writer is stored')
})

test('a boxless writer admitted before its private root is learned is dropped once it is', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  let withRoot = false
  let f = null
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: () => ({ items: sorted(withRoot ? [f.root, f.bare] : [f.bare]), next: null, incomplete: false })
  })
  f = await fixture(fake, kp, 'private')
  const m = await groupMember(t, kp, f.group)
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (evs.some((ev) => ev.event === 'group-downloaded' && ev.key === f.bare.key)) withRoot = true
    return evs.some((ev) => ev.event === 'group-skipped' && ev.key === f.bare.key)
  }, { pageRefreshMs: 500 })
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === f.bare.key), 'admitted while the root was unknown')
  t.alike(skipped(events, f.bare.key), ['header-invalid'], 'dropped once the root is learned')
  t.absent(await stored(m, f.bare.key), 'and purged')
})

test('a private group syncs end to end through a seeder', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  await startSeeder(t, bootstrap, kp)
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private', community })
  await member.groupPost(a, { group, text: 'antes' })
  // B learns the roots out of band; everything after this travels by sync.
  await exchange(a, b)
  await member.communityJoin(b, { community })
  await member.groupJoin(b, { group })
  const wb = ownWriter(b, group)
  await syncOnce(bootstrap, b)
  await syncOnce(bootstrap, a)
  t.ok(await stored(a, wb), 'A holds B\'s boxed writer')
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await member.groupPost(a, { group, text: 'depois' })
  await syncOnce(bootstrap, a)
  const rb = await syncOnce(bootstrap, b)
  t.ok(rb.result.ok, rb.result.errors.join('; '))
  t.ok(await stored(b, group), 'B holds the root')
  const lengths = []
  for (const ctx of [a, b]) {
    const s = await store.openStore(ctx.dataDir)
    try {
      const core = s.get({ key: b4a.from(group, 'hex'), writable: false })
      await core.ready()
      lengths.push(core.length)
      if (ctx === b) t.ok(!JSON.stringify(await store.readAll(core)).includes('antes'), 'the replicated root holds sealed blocks only')
      await core.close()
    } finally {
      await s.close()
    }
  }
  t.is(lengths[1], lengths[0], 'B has every block of the root')
  const read = await member.groupRead(b, { group })
  t.alike(read.items.map((p) => p.text).sort(), ['antes', 'depois'], 'B reads the history after admission')
})

// Copies cores `keys` from Corestore `from` into Corestore `to`, block by
// block, over an in-process replication stream.
async function replicateKeys (from, to, keys) {
  const left = from.replicate(true)
  const right = to.replicate(false)
  left.pipe(right).pipe(left)
  try {
    for (const key of keys) {
      const source = from.get({ key: b4a.from(key, 'hex'), writable: false })
      await source.ready()
      const target = to.get({ key: b4a.from(key, 'hex'), writable: false })
      await target.ready()
      for (let seq = 0; seq < source.length; seq++) await target.get(seq, { raw: true, timeout: 10000 })
    }
  } finally {
    left.destroy()
    right.destroy()
  }
}

async function copyCores (from, to, keys) {
  const a = await store.openStore(from.dataDir)
  const b = await store.openStore(to.dataDir)
  try {
    await replicateKeys(a, b, keys)
  } finally {
    await b.close()
    await a.close()
  }
}

async function copyToSeeder (from, fake, keys) {
  const s = await store.openStore(from.dataDir)
  try {
    await replicateKeys(s, fake.store, keys)
  } finally {
    await s.close()
  }
}

// The blocks ctx holds of core `key`.
async function heldCopy (ctx, key) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = s.get({ key: b4a.from(key, 'hex'), writable: false })
    await core.ready()
    const held = []
    for (let i = 0; i < core.length; i++) if (await core.has(i)) held.push(i)
    const out = { contiguous: core.contiguousLength, held }
    await core.close()
    return out
  } finally {
    await s.close()
  }
}

// A private group G of A's community, B a member through its boxed writer
// W1, and W0: a boxless writer of B's diary (made before the private root
// arrived) with a post, replaced: B's diary cuts it at 0, so its walk
// releases it (#350). R, fresh, holds A's cores and joined C and G; it never
// held W0, and A never held anything of B. With `noMember`, W0's header also
// names no member, which a writer of a group must. With `live`, W0 has a box
// and B's diary never cuts it.
async function releasedBoxless (t, kp, { noMember = false, live = false } = {}) {
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const r = await person(t, kp, 'Rui')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private', community })
  await exchange(a, b)
  await exchange(a, r)
  for (const m of [b, r]) {
    await member.communityJoin(m, { community })
    await member.groupJoin(m, { group })
  }
  const cw = store.readGroups(b.dataDir).find((g) => g.kind === 'community' && g.group === community).writer
  const w1 = ownWriter(b, group)
  const s = await store.openStore(b.dataDir)
  let w0
  let joins
  try {
    const core = await store.openGroupWriter(s, hex(crypto.randomBytes(16)))
    const validator = (rec, seq) => validateGroupRecord(rec, seq)
    await store.appendRecord(core, writerHeader({ group, diary: b.key, member: noMember ? null : cw, ...(live ? { box: box() } : {}) }), { validator })
    await store.appendRecord(core, groupPost({ text: 'sem caixa' }), { validator })
    w0 = hex(core.key)
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: w0, on: true }))
    if (!live) await store.appendRecord(diary, groupCutRecord({ group, writer: w0, cut: 0 }))
    joins = (await store.readAll(diary)).filter((e) => e.record && e.record.type === 'group-join')
  } finally {
    await s.close()
  }
  const seqOf = (writer) => joins.find((e) => e.record.writer === writer && e.record.on).seq
  return {
    b,
    r,
    community,
    group,
    w0: { key: w0, diary: b.key, length: 2, seq: seqOf(w0) },
    cw: { key: cw, diary: b.key, length: 1, seq: seqOf(cw) },
    w1
  }
}

const page = (items) => ({ items, next: null, incomplete: false })

test('a fresh reader holding the diary that released a boxless writer keeps its block 0 alone and folds complete (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  let f = null
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === f.group ? [f.w0] : [])
  })
  f = await releasedBoxless(t, kp)
  await copyToSeeder(f.b, fake, [f.w0.key])
  await copyCores(f.b, f.r, [f.b.key, f.cw.key, f.w1])
  t.is((await member.groupRead(f.r, { group: f.group })).incomplete, true, 'control: B\'s walk releases W0, so the fold awaits it')
  // The fake seeder never holds R's diary, so the run ends at its deadline
  // and names every goal still open.
  const { result, events } = await syncOnce(bootstrap, f.r, { timeoutMs: 12000 })
  t.alike(skipped(events, f.w0.key), [], 'W0 is not refused')
  t.alike(await heldCopy(f.r, f.w0.key), { contiguous: 1, held: [0] }, 'R holds W0\'s block 0 alone')
  t.absent(result.errors.join(' ').includes(f.w0.key), 'and counts it held: no goal on W0 is left open')
  t.is((await member.groupRead(f.r, { group: f.group })).incomplete, false, 'and the fold is complete')
})

test('a boxless writer refused before its diary is held is gated again as a stub once the diary releases it (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  let f = null
  // W0 is listed at once; B's diary is held only through B's CW, listed
  // later, so W0's gate finds no diary to read.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => {
      if (q.group === f.group) return page([f.w0])
      if (q.group === f.community) return new Promise((resolve) => setTimeout(() => resolve(page([f.cw])), 2000))
      return page([])
    }
  })
  f = await releasedBoxless(t, kp)
  await copyToSeeder(f.b, fake, [f.b.key, f.cw.key, f.w0.key])
  await copyCores(f.b, f.r, [f.w1])
  const { result, events } = await syncOnce(bootstrap, f.r, { timeoutMs: 15000 })
  t.alike(skipped(events, f.w0.key), ['header-invalid'], 'W0 is refused while B\'s diary is not held')
  t.ok(await stored(f.r, f.b.key), 'B\'s diary arrives through its CW')
  t.alike(await heldCopy(f.r, f.w0.key), { contiguous: 1, held: [0] }, 'then W0 is held, block 0 alone')
  t.absent(result.errors.join(' ').includes(f.w0.key), 'and counted held')
  t.is((await member.groupRead(f.r, { group: f.group })).incomplete, false, 'and the fold is complete')
})

test('a writer refused for its member is held as a stub, block 0 alone, once its diary\'s join is proven (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  let f = null
  // As above, but W0's header names no member: the fold rejects it at any
  // cut, so R holds it as a stub as soon as B's diary proves the join, read
  // through the seeder before B's CW is listed.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => {
      if (q.group === f.group) return page([f.w0])
      if (q.group === f.community) return new Promise((resolve) => setTimeout(() => resolve(page([f.cw])), 2000))
      return page([])
    }
  })
  f = await releasedBoxless(t, kp, { noMember: true })
  await copyToSeeder(f.b, fake, [f.b.key, f.cw.key, f.w0.key])
  await copyCores(f.b, f.r, [f.w1])
  const { result, events } = await syncOnce(bootstrap, f.r, { timeoutMs: 15000 })
  t.alike(skipped(events, f.w0.key), [], 'W0 is not refused')
  t.ok(await stored(f.r, f.b.key), 'B\'s diary arrives')
  t.alike(await heldCopy(f.r, f.w0.key), { contiguous: 1, held: [0] }, 'W0 is held, block 0 alone')
  t.absent(result.errors.join(' ').includes(f.w0.key), 'and counted held')
  t.is((await member.groupRead(f.r, { group: f.group })).incomplete, false, 'and the fold is complete')
})

test('a live writer whose header names no member is fetched to block 0 alone, and its posts never count (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  let f = null
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === f.group ? [f.w0] : q.group === f.community ? [f.cw] : [])
  })
  f = await releasedBoxless(t, kp, { noMember: true, live: true })
  await copyToSeeder(f.b, fake, [f.b.key, f.cw.key, f.w0.key])
  await copyCores(f.b, f.r, [f.b.key, f.cw.key, f.w1])
  t.is((await member.groupRead(f.r, { group: f.group })).incomplete, true, 'control: without W0 the fold awaits it')
  const { result, events } = await syncOnce(bootstrap, f.r, { timeoutMs: 12000 })
  t.alike(skipped(events, f.w0.key), [], 'W0 is not refused')
  t.alike(await heldCopy(f.r, f.w0.key), { contiguous: 1, held: [0] }, 'R fetches W0\'s block 0 alone, though the seeder holds its post')
  t.absent(result.errors.join(' ').includes(f.w0.key), 'and counts it held')
  const read = await member.groupRead(f.r, { group: f.group })
  t.is(read.incomplete, false, 'the fold is complete')
  t.absent(read.items.some((p) => p.text === 'sem caixa'), 'and W0\'s post never counts')
})

// A private root, and one diary D binding a boxed writer and `count` boxless
// writers its walk keeps live (never released), in the fake seeder's store.
async function oneDiary (fake, kp, count) {
  const root = fake.store.get({ name: 'root' })
  await root.ready()
  const group = hex(root.key)
  const r = await bound(fake.store, kp, group, 'root', { root })
  await root.append(enc(groupHeader({ community: PARENT, member: PARENT, diary: r.dkey, visibility: 'private', join: 'approval', name: null, box: box() })))
  const d = fake.store.get({ name: 'diary-shared' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(enc(memberCertRecord(createCert({ member: dkey }, kp))))
  const writers = []
  for (let i = 0; i <= count; i++) {
    const w = fake.store.get({ name: 'writer-shared-' + i })
    await w.ready()
    await w.append(enc(writerHeader({ group, diary: dkey, member: PARENT, ...(i === 0 ? { box: box() } : {}) })))
    await d.append(enc(groupJoinRecord({ group, writer: hex(w.key), on: true })))
    writers.push({ key: hex(w.key), diary: dkey, length: 1, seq: d.length - 1 })
  }
  return { group, diary: dkey, root: { key: group, diary: r.dkey, length: 1, seq: 1 }, boxed: writers[0], bare: writers.slice(1) }
}

test('writers refused for their box read their held diary\'s walk once, and no lift follows while it stays current (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  let f = null
  let all = false
  let armed = false
  // The boxless writers are listed once the boxed one is held, and with it
  // D, so each of their gates reads D as this node holds it.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === f.group ? sorted(all ? [f.root, f.boxed, ...f.bare] : [f.root, f.boxed]) : [])
  })
  f = await oneDiary(fake, kp, 4)
  const m = await groupMember(t, kp, f.group)
  let inspect = null
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (!armed && evs.some((ev) => ev.event === 'group-downloaded' && ev.key === f.boxed.key)) {
      armed = true
      setTimeout(() => { all = true }, 1500)
    }
    return f.bare.every((w) => skipped(evs, w.key).length > 0)
  }, { pageRefreshMs: 500, inspectHook: (h) => { inspect = h } })
  for (const w of f.bare) t.alike(skipped(events, w.key), ['header-invalid'], 'a boxless writer is refused once')
  t.ok(await stored(m, f.boxed.key), 'the boxed writer is held')
  t.is(inspect.walkReadCount(), 1, 'four refusals read D\'s walk once')
  t.is(inspect.boxLiftCount(), 0, 'and no lift reads it again')
})
