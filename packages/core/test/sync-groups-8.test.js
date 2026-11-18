'use strict'

// Member sync of header stubs (#350, docs/protocol.md section 10, "Bad
// hints"): a listed writer whose block 0 can never count for the hinted
// diary (undecodable, invalid, a legacy header, or one naming another group
// or another diary) is held as a stub, block 0 alone and never charged,
// once that diary proves the join; unproven, it keeps its verdict and its
// charge. A stub naming another group or diary gives way to the listing of
// that pair, and a restart keeps it only while the stored replica of the
// diary that proved it still holds the join.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { CAP_HEADER_STUBS } = require('../lib/net')
const { createCert, generateAssociationKeyPair } = require('../lib/cert')
const { writerHeader, groupHeader, groupPost } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, PARENT, person, exchange, syncOnce, stored, heldCopy, recorded, fakeSeeder, groupMember, copyInto, runUntil } = require('./helpers/sync-groups')

const enc = (record) => b4a.from(JSON.stringify(record))
const AT = '2026-01-01T00:00:00.000Z'
const page = (items) => ({ items, next: null, incomplete: false })
const sorted = (items) => items.slice().sort((x, y) => x.key < y.key ? -1 : 1)
const skipped = (events, key) => events.filter((ev) => ev.event === 'group-skipped' && ev.key === key).map((ev) => ev.reason)
const downloaded = (events, key, length) => events.some((ev) => ev.event === 'group-downloaded' && ev.key === key && ev.length >= length)

// Block 0 of each kind of header stub, for a core `diary` joins to `group`,
// and the verdict a listing whose join is not proven keeps.
const HEADS = {
  undecodable: { raw: () => b4a.from('{ nada'), verdict: 'header-invalid' },
  invalid: { raw: (group) => enc({ type: 'group-writer', v: 2, group }), verdict: 'header-invalid' },
  legacy: { raw: (group, diary) => enc({ type: 'group-writer', v: 1, group, diary, box: null, rejoin: null, at: AT }), verdict: 'header-invalid' },
  'another group': { raw: (group, diary) => enc(writerHeader({ group: hex(crypto.randomBytes(32)), diary, member: PARENT })), verdict: 'wrong-group' },
  'another diary': { raw: (group) => enc(writerHeader({ group, diary: hex(crypto.randomBytes(32)), member: PARENT })), verdict: 'wrong-diary' }
}

// A diary in `cs` (its certificate at seq 0, `certFor` its key) under `name`.
async function diaryIn (cs, kp, name, certFor = (member) => createCert({ member }, kp)) {
  const d = cs.get({ name })
  await d.ready()
  const key = hex(d.key)
  await d.append(enc(memberCertRecord(certFor(key))))
  return { d, key }
}

// A core in `cs` whose block 0 is `raw`, then `posts` posts, joined to
// `group` by diary `d`: its page item.
async function joinedCore (cs, name, raw, d, group, posts = 0) {
  const core = cs.get({ name })
  await core.ready()
  await core.append(raw)
  for (let i = 0; i < posts; i++) await core.append(enc(groupPost({ text: name + ' ' + i })))
  const key = hex(core.key)
  await d.d.append(enc(groupJoinRecord({ group, writer: key, on: true })))
  return { key, diary: d.key, length: core.length, seq: d.d.length - 1 }
}

// A public group G of A's community with members B and R, and one core per
// kind of header stub in the fake seeder's store, each with a post past
// block 0, joined to G by B's diary. R holds A's and B's cores, no stub.
async function stubWorld (t, kp, fake) {
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const r = await person(t, kp, 'Rui')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await exchange(a, b)
  await exchange(a, r)
  for (const m of [b, r]) {
    await member.communityJoin(m, { community })
    await member.groupJoin(m, { group })
  }
  const stubs = {}
  const s = await store.openStore(b.dataDir)
  try {
    const diary = await store.openDiary(s)
    for (const [name, { raw }] of Object.entries(HEADS)) {
      const core = fake.store.get({ name: 'stub-' + name })
      await core.ready()
      await core.append(raw(group, b.key))
      await core.append(enc(groupPost({ text: name })))
      const key = hex(core.key)
      const seq = await store.appendRecord(diary, groupJoinRecord({ group, writer: key, on: true }))
      stubs[name] = { key, diary: b.key, length: 2, seq }
    }
  } finally {
    await s.close()
  }
  await exchange(b, r)
  return { r, group, stubs }
}

test('a listed writer whose block 0 can never count for the diary that joined it is held as a stub once the join is proven, and the fold no longer waits for it (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  let f = null
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === f.group ? sorted(Object.values(f.stubs)) : [])
  })
  f = await stubWorld(t, kp, fake)
  t.is((await member.groupRead(f.r, { group: f.group })).incomplete, true, 'control: the fold waits for every one of them')
  const { result, events } = await syncOnce(bootstrap, f.r, { timeoutMs: 15000 })
  for (const [name, x] of Object.entries(f.stubs)) {
    t.alike(skipped(events, x.key), [], name + ': never refused nor charged')
    t.alike(await heldCopy(f.r, x.key), { contiguous: 1, held: [0] }, name + ': block 0 alone, though the seeder holds a post')
    t.is(recorded(f.r)[x.key], x.diary, name + ': recorded with the diary that proved it')
    t.absent(result.errors.join(' ').includes(x.key), name + ': counted held, no goal on it left open')
  }
  const read = await member.groupRead(f.r, { group: f.group })
  t.is(read.incomplete, false, 'the fold no longer waits for them')
  t.absent(read.items.some((p) => p.text in f.stubs), 'and nothing past their block 0 counts')
})

test('a header stub listed with a diary that does not prove its join keeps its verdict and is charged to the seeder (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = await diaryIn(fake.store, kp, 'diary')
  // Seq 1 joins a writer of G, never the stubs: each listing names it.
  const real = fake.store.get({ name: 'real' })
  await real.ready()
  await real.append(enc(writerHeader({ group, diary: d.key, member: PARENT })))
  await d.d.append(enc(groupJoinRecord({ group, writer: hex(real.key), on: true })))
  const verdicts = new Map()
  for (const [name, { raw, verdict }] of Object.entries(HEADS)) {
    for (let i = 0; i < 7; i++) {
      const core = fake.store.get({ name: name + i })
      await core.ready()
      await core.append(raw(group, d.key))
      items.push({ key: hex(core.key), diary: d.key, length: 1, seq: 1 })
      verdicts.set(hex(core.key), verdict)
    }
  }
  items.splice(0, items.length, ...sorted(items))
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d])
  const logs = []
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 30000, log: (line) => logs.push(line) })
  let refused = 0
  for (const [key, verdict] of verdicts) {
    const reasons = skipped(events, key)
    if (reasons.length > 0) refused++
    if (reasons.some((r) => r !== verdict)) t.fail('verdict ' + reasons.join(',') + ' instead of ' + verdict)
    if (await stored(m, key)) t.fail('an unproven stub is stored')
  }
  t.ok(refused >= 32, refused + ' listings refused, each with its header\'s verdict')
  t.ok(logs.some((l) => l.includes('listou escritores errados demais')), 'and each one charged: the seeder is cut off')
})

test('one unstored listing of a writer of another group, its join not proven, is charged to the seeder (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = await diaryIn(fake.store, kp, 'diary')
  const real = fake.store.get({ name: 'real' })
  await real.ready()
  await real.append(enc(writerHeader({ group, diary: d.key, member: PARENT })))
  await d.d.append(enc(groupJoinRecord({ group, writer: hex(real.key), on: true })))
  // MAX_BAD_HINTS - 1 listings charged as another diary's, and one writer of
  // another group: the seeder is cut off only when that one is charged too.
  const wrong = []
  for (let i = 0; i < 31; i++) {
    const core = fake.store.get({ name: 'other-diary' + i })
    await core.ready()
    await core.append(HEADS['another diary'].raw(group, d.key))
    items.push({ key: hex(core.key), diary: d.key, length: 1, seq: 1 })
  }
  const one = fake.store.get({ name: 'other-group' })
  await one.ready()
  await one.append(HEADS['another group'].raw(group, d.key))
  items.push({ key: hex(one.key), diary: d.key, length: 1, seq: 1 })
  wrong.push(hex(one.key))
  items.splice(0, items.length, ...sorted(items))
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d])
  const logs = []
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 30000, log: (line) => logs.push(line) })
  t.alike(skipped(events, wrong[0]), ['wrong-group'], 'refused with its header\'s verdict')
  t.absent(await stored(m, wrong[0]), 'never stored')
  t.ok(logs.some((l) => l.includes('listou escritores errados demais')), 'and charged: the seeder is cut off')
})

test('cores already stored here in another role, listed as writers of a group whose block 0 can never count for them, are skipped and never charged to the seeder (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = await diaryIn(fake.store, kp, 'diary')
  // Past MAX_BAD_HINTS: roots of other groups, followed diaries and writers
  // of other groups, each joined to G by D (a seeder lists them as D's
  // header stubs).
  const kinds = {
    root: { raw: () => enc(groupHeader({ community: PARENT, member: PARENT, diary: d.key, name: 'Outra', join: 'open' })), verdict: 'header-invalid' },
    diary: { raw: (key) => enc(memberCertRecord(createCert({ member: key }, kp))), verdict: 'header-invalid' },
    writer: { raw: () => enc(writerHeader({ group: hex(crypto.randomBytes(32)), diary: d.key, member: PARENT })), verdict: 'wrong-group' }
  }
  const cores = [d.d]
  const followed = []
  const verdicts = new Map()
  for (const [name, { raw, verdict }] of Object.entries(kinds)) {
    for (let i = 0; i < 11; i++) {
      const core = fake.store.get({ name: name + i })
      await core.ready()
      await core.append(raw(hex(core.key)))
      cores.push(core)
      if (name === 'diary') followed.push(hex(core.key))
      await d.d.append(enc(groupJoinRecord({ group, writer: hex(core.key), on: true })))
      items.push({ key: hex(core.key), diary: d.key, length: 1, seq: d.d.length - 1 })
      verdicts.set(hex(core.key), verdict)
    }
  }
  items.splice(0, items.length, ...sorted(items))
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, cores)
  for (const key of followed) await member.followAdd(m, key)
  const logs = []
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 30000, log: (line) => logs.push(line) })
  for (const [key, verdict] of verdicts) {
    t.alike(skipped(events, key), [verdict], 'skipped with its header\'s verdict')
    t.ok(await stored(m, key), 'and kept in its own role')
    t.absent(recorded(m)[key], 'never recorded as a stub')
  }
  t.absent(logs.some((l) => l.includes('listou escritores errados demais')), 'none is charged: the seeder is not cut off')
})

test('a header stub whose first listing did not prove its join is held once another listing does (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let proven = false
  let k = null
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === group && k !== null ? [{ ...k, seq: proven ? k.seq : 1 }] : [])
  })
  const d = await diaryIn(fake.store, kp, 'diary')
  const real = fake.store.get({ name: 'real' })
  await real.ready()
  await real.append(enc(writerHeader({ group, diary: d.key, member: PARENT })))
  await d.d.append(enc(groupJoinRecord({ group, writer: hex(real.key), on: true }))) // seq 1
  k = await joinedCore(fake.store, 'stub', HEADS.legacy.raw(group, d.key), d, group) // seq 2
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d])
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (skipped(evs, k.key).length > 0) proven = true
    return downloaded(evs, k.key, 1)
  }, { pageRefreshMs: 300 })
  t.alike(skipped(events, k.key), ['header-invalid'], 'the listing that names another join is refused')
  t.alike(await heldCopy(m, k.key), { contiguous: 1, held: [0] }, 'yet the one its diary proves makes it a stub')
})

// The cores `cores` of Corestore `from`, copied whole into `to`.
async function copyCores (from, to, cores) {
  const left = from.replicate(true)
  const right = to.replicate(false)
  left.pipe(right).pipe(left)
  try {
    for (const source of cores) {
      const target = to.get({ key: source.key })
      await target.ready()
      for (let i = 0; i < source.length; i++) await target.get(i, { timeout: 10000 })
      await target.close()
    }
  } finally {
    left.destroy()
    right.destroy()
  }
}

test('in a --once run, a header stub refused on one seeder\'s unproven listing is held from another seeder\'s listing that proves it (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let k = null
  // Incomplete: the run waits for the second seeder's pass.
  const first = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => ({ items: q.group === group && k !== null ? [{ ...k, seq: 1 }] : [], next: null, incomplete: q.group === group })
  })
  // Late, so its listing comes once the first one was refused.
  const second = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => new Promise((resolve) => setTimeout(() => resolve(page(q.group === group && k !== null ? [k] : [])), 2000))
  })
  const d = await diaryIn(first.store, kp, 'diary')
  const real = first.store.get({ name: 'real' })
  await real.ready()
  await real.append(enc(writerHeader({ group, diary: d.key, member: PARENT })))
  await d.d.append(enc(groupJoinRecord({ group, writer: hex(real.key), on: true }))) // seq 1
  k = await joinedCore(first.store, 'stub', HEADS.legacy.raw(group, d.key), d, group) // seq 2
  const core = first.store.get({ name: 'stub' })
  await core.ready()
  await copyCores(first.store, second.store, [d.d, core])
  const m = await groupMember(t, kp, group)
  await copyInto(first.store, m, [d.d])
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(skipped(events, k.key), ['header-invalid'], 'the first seeder\'s listing is refused')
  t.alike(await heldCopy(m, k.key), { contiguous: 1, held: [0] }, 'the second one\'s makes it a stub: the refusal judged that listing, never the key')
})

test('a stub of another group gives way to its listing there, and is then fetched in full (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const other = hex(crypto.randomBytes(32))
  let asStub = null
  let asWriter = null
  // Its listing under its own group comes once the stub is held.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => {
      if (q.group === group && asStub !== null) return page([asStub])
      if (q.group === other && asWriter !== null) return new Promise((resolve) => setTimeout(() => resolve(page([asWriter])), 2000))
      return page([])
    }
  })
  const d = await diaryIn(fake.store, kp, 'diary')
  asStub = await joinedCore(fake.store, 'k', enc(writerHeader({ group: other, diary: d.key, member: PARENT })), d, group, 2)
  await d.d.append(enc(groupJoinRecord({ group: other, writer: asStub.key, on: true })))
  asWriter = { ...asStub, seq: d.d.length - 1 }
  const m = await groupMember(t, kp, group, { extra: [other] })
  await copyInto(fake.store, m, [d.d])
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.ok(downloaded(events, asStub.key, 1), 'held as a stub of G first')
  t.alike(skipped(events, asStub.key), [], 'never refused')
  t.alike(await heldCopy(m, asStub.key), { contiguous: 3, held: [0, 1, 2] }, 'then fetched in full as a writer of its own group')
  t.absent(asStub.key in recorded(m), 'and no longer recorded as a stub')
})

test('a stub naming another diary of the group gives way to that diary\'s listing (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listing = null
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === group && listing !== null ? [listing] : [])
  })
  const d = await diaryIn(fake.store, kp, 'diary')
  const named = await diaryIn(fake.store, kp, 'named')
  const k = await joinedCore(fake.store, 'k', enc(writerHeader({ group, diary: named.key, member: PARENT })), d, group, 2)
  await named.d.append(enc(groupJoinRecord({ group, writer: k.key, on: true })))
  const own = { key: k.key, diary: named.key, length: 3, seq: named.d.length - 1 }
  listing = k
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d, named.d])
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (downloaded(evs, k.key, 1)) listing = own
    return downloaded(evs, k.key, 3)
  }, { pageRefreshMs: 300 })
  t.alike(skipped(events, k.key), [], 'never refused')
  t.alike(await heldCopy(m, k.key), { contiguous: 3, held: [0, 1, 2] }, 'held as a stub of D, then fetched in full for the diary it names')
  t.absent(k.key in recorded(m), 'and no longer recorded as a stub')
})

test('a listing of the diary a stub\'s header names, paged while the stub was gated, takes its place once it is held (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listings = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === group ? listings : [])
  })
  const d = await diaryIn(fake.store, kp, 'diary')
  const named = await diaryIn(fake.store, kp, 'named')
  const k = await joinedCore(fake.store, 'k', enc(writerHeader({ group, diary: named.key, member: PARENT })), d, group, 2)
  await named.d.append(enc(groupJoinRecord({ group, writer: k.key, on: true })))
  // One page lists the key twice: D's listing is gated first, and the named
  // diary's comes while that gate runs.
  listings = [k, { key: k.key, diary: named.key, length: 3, seq: named.d.length - 1 }]
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d, named.d])
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.alike(skipped(events, k.key), [], 'never refused')
  t.alike(await heldCopy(m, k.key), { contiguous: 3, held: [0, 1, 2] }, 'fetched in full for the diary it names')
  t.absent(k.key in recorded(m), 'and no longer recorded as a stub')
})

test('a restart keeps a stub its diary still proves and purges one it no longer does (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === group ? listed : [])
  })
  const d1 = await diaryIn(fake.store, kp, 'diary-1')
  const d2 = await diaryIn(fake.store, kp, 'diary-2')
  const k1 = await joinedCore(fake.store, 'k1', HEADS.legacy.raw(group, d1.key), d1, group)
  const k2 = await joinedCore(fake.store, 'k2', HEADS['another group'].raw(group, d2.key), d2, group)
  const k3 = await joinedCore(fake.store, 'k3', HEADS['another diary'].raw(group), d1, group)
  listed = sorted([k1, k2, k3])
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d1.d, d2.d])
  const first = await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.ok(first.result.ok, first.result.errors.join('; '))
  t.alike(recorded(m), { [k1.key]: d1.key, [k2.key]: d2.key, [k3.key]: d1.key }, 'all three held as stubs')
  // D2 goes from this node's store; only K3 is listed again, as before.
  const s = await store.openStore(m.dataDir)
  try {
    await store.purgeReplica(s, d2.key)
  } finally {
    await s.close()
  }
  listed = [k3]
  const second = await syncOnce(bootstrap, m, { timeoutMs: 8000 })
  t.alike(await heldCopy(m, k1.key), { contiguous: 1, held: [0] }, 'a stub D1 still proves is kept, though its header is legacy')
  t.absent(await stored(m, k2.key), 'the one no diary held here proves is purged')
  t.alike(skipped(second.events, k3.key), [], 'a kept stub listed again is never judged as a writer of the diary its header names')
  t.alike(await heldCopy(m, k3.key), { contiguous: 1, held: [0] })
  t.alike(recorded(m), { [k1.key]: d1.key, [k3.key]: d1.key }, 'and only the purged one leaves the record')
})

test('a stub that has since become the binding diary of a writer held here stays when its record goes (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === group ? listed : [])
  })
  const dx = await diaryIn(fake.store, kp, 'diary-x')
  const d2 = await diaryIn(fake.store, kp, 'diary-2')
  // DX joins D2 itself as a writer of G: block 0 a certificate, a header
  // stub of (G, DX). D2 then binds its own writer W.
  await dx.d.append(enc(groupJoinRecord({ group, writer: d2.key, on: true })))
  const asStub = { key: d2.key, diary: dx.key, length: 1, seq: dx.d.length - 1 }
  const w = await joinedCore(fake.store, 'w', enc(writerHeader({ group, diary: d2.key, member: PARENT })), d2, group, 1)
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [dx.d])
  listed = [asStub]
  const first = await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.ok(first.result.ok, first.result.errors.join('; '))
  t.alike(recorded(m), { [d2.key]: dx.key }, 'D2 held as a stub of DX')
  listed = [w]
  await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(await heldCopy(m, w.key), { contiguous: 2, held: [0, 1] }, 'then W is fetched in full, D2 its binding diary')
  // DX goes from this node's store: nothing proves the stub any more.
  const s = await store.openStore(m.dataDir)
  try {
    await store.purgeReplica(s, dx.key)
  } finally {
    await s.close()
  }
  listed = []
  await syncOnce(bootstrap, m, { timeoutMs: 8000 })
  t.absent(d2.key in recorded(m), 'the record goes')
  t.ok(await stored(m, d2.key), 'but D2 stays, the binding diary of a writer held here')
})

test('stubs held across a restart never take the cap of the diary their header names (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === group ? listed : [])
  })
  const d = await diaryIn(fake.store, kp, 'diary')
  const named = await diaryIn(fake.store, kp, 'named')
  // D fills its cap (32 held per diary) with stubs whose header names N.
  const stubs = []
  for (let i = 0; i < 32; i++) stubs.push(await joinedCore(fake.store, 'k' + i, enc(writerHeader({ group, diary: named.key, member: PARENT })), d, group))
  const w = await joinedCore(fake.store, 'w', enc(writerHeader({ group, diary: named.key, member: PARENT })), named, group, 1)
  listed = sorted(stubs)
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d, named.d])
  await syncOnce(bootstrap, m, { timeoutMs: 30000 })
  t.is(Object.keys(recorded(m)).length, 32, 'every stub is held')
  listed = [w]
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(skipped(events, w.key), [], 'N\'s writer is not refused for the cap')
  t.alike(await heldCopy(m, w.key), { contiguous: 2, held: [0, 1] }, 'and is fetched in full')
})

test('a member announces that it holds header stubs (#350)', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const peers = []
  await fakeSeeder(t, bootstrap, kp, [], { onPeer: (p) => peers.push(p) })
  const m = await groupMember(t, kp, hex(crypto.randomBytes(32)))
  await syncOnce(bootstrap, m, { timeoutMs: 8000 })
  t.ok(peers.some((p) => p.remoteCaps === CAP_HEADER_STUBS), 'its admission open carries the header stubs bit alone')
})

// header-stubs.json written as an earlier run would leave it.
function writeRecord (ctx, stubs) {
  fs.writeFileSync(path.join(ctx.dataDir, 'header-stubs.json'), JSON.stringify({ v: 1, stubs }))
}

test('a group root first held as a stub of another group leaves the record once its own listing gates it, and a record alone never purges it at start (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let asStub = null
  let asRoot = null
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => {
      if (q.group === group && asStub !== null) return page([asStub])
      if (asRoot !== null && q.group === asRoot.key) return page([asRoot])
      return page([])
    }
  })
  const d0 = await diaryIn(fake.store, kp, 'creator')
  const d1 = await diaryIn(fake.store, kp, 'diary')
  // K, the root of another group this node joined, which D1 also joins to G.
  const root = fake.store.get({ name: 'root' })
  await root.ready()
  const k = hex(root.key)
  await root.append(enc(groupHeader({ kind: 'group', diary: d0.key, community: PARENT, member: PARENT, name: 'Outro' })))
  for (const text of ['um', 'dois']) await root.append(enc(groupPost({ text })))
  await d0.d.append(enc(groupJoinRecord({ group: k, writer: k, on: true })))
  const rootListing = { key: k, diary: d0.key, length: 3, seq: d0.d.length - 1 }
  await d1.d.append(enc(groupJoinRecord({ group, writer: k, on: true })))
  asStub = { key: k, diary: d1.key, length: 3, seq: d1.d.length - 1 }
  const m = await groupMember(t, kp, group, { extra: [k] })
  await copyInto(fake.store, m, [d1.d])
  // One run: the next start would take K out of the record by itself, a
  // root of groups.json.
  let asHeld = null
  await runUntil(m, bootstrap, (evs) => {
    if (asRoot === null && downloaded(evs, k, 1)) {
      asHeld = recorded(m)
      asRoot = rootListing
    }
    return downloaded(evs, k, 3)
  }, { pageRefreshMs: 300 })
  t.alike(asHeld, { [k]: d1.key }, 'held as a stub of (G, D1) while its own group lists nothing')
  t.alike(await heldCopy(m, k), { contiguous: 3, held: [0, 1, 2] }, 'then gated as its group\'s root and fetched in full')
  t.alike(recorded(m), {}, 'and it leaves the record')
  // A record left by an earlier run, and D1 gone: nothing proves the stub.
  writeRecord(m, [{ key: k, group, diary: d1.key }])
  const s = await store.openStore(m.dataDir)
  try {
    await store.purgeReplica(s, d1.key)
  } finally {
    await s.close()
  }
  asStub = null
  asRoot = null
  const { result } = await syncOnce(bootstrap, m, { timeoutMs: 8000 })
  t.ok(result.ok, result.errors.join('; '))
  t.alike(await heldCopy(m, k), { contiguous: 3, held: [0, 1, 2] }, 'the root of a group of groups.json is kept in full')
  t.alike(recorded(m), {}, 'only its record goes')
})

test('at start a record alone never purges the root of a listed group or a writer its header\'s diary joined: the core only leaves the record (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const fake = await fakeSeeder(t, bootstrap, kp, [], { answer: () => page([]) })
  const d = await diaryIn(fake.store, kp, 'diary')
  // R, the root of a group this node joined.
  const root = fake.store.get({ name: 'root' })
  await root.ready()
  await root.append(enc(groupHeader({ kind: 'group', diary: d.key, community: PARENT, member: PARENT, name: 'Outro' })))
  const rkey = hex(root.key)
  // W, a writer of G whose header's own diary, stored here, joined it.
  const w = await joinedCore(fake.store, 'w', enc(writerHeader({ group, diary: d.key, member: PARENT })), d, group)
  const m = await groupMember(t, kp, group, { extra: [rkey] })
  const cores = [root, fake.store.get({ name: 'w' })]
  for (const c of cores) await c.ready()
  await copyInto(fake.store, m, [d.d, ...cores])
  const nobody = hex(crypto.randomBytes(32))
  writeRecord(m, [rkey, w.key].map((key) => ({ key, group, diary: nobody })))
  const { result } = await syncOnce(bootstrap, m, { timeoutMs: 8000 })
  t.ok(result.ok, result.errors.join('; '))
  t.alike(await heldCopy(m, rkey), { contiguous: 1, held: [0] }, 'the root of a group of groups.json is kept')
  t.alike(await heldCopy(m, w.key), { contiguous: 1, held: [0] }, 'a writer its header\'s own diary joined is kept')
  t.alike(recorded(m), {}, 'and each one only leaves the record')
})

// The (group, diary) whose cap a stored key's slot takes, or null.
function slotOf (inspect, key) {
  const slot = inspect.diskSlotOf(key)
  return slot === null ? null : [slot.group, slot.diary]
}

test('at start a recorded stub holding a block past 0 is not purged while the diary that proved it is stored, and keeps its record and the slot of the pair that proved it (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const fake = await fakeSeeder(t, bootstrap, kp, [], { answer: () => page([]) })
  const d = await diaryIn(fake.store, kp, 'diary')
  const named = await diaryIn(fake.store, kp, 'named')
  // O, the diary the record names, stored here: it never joined F.
  const other = await diaryIn(fake.store, kp, 'other')
  // F, a writer of (G, N) by its header that N never joined, held past
  // block 0: a peer's listing can make this node store such a block.
  const full = await joinedCore(fake.store, 'full', enc(writerHeader({ group, diary: named.key, member: PARENT })), d, group, 1)
  const m = await groupMember(t, kp, group)
  const core = fake.store.get({ name: 'full' })
  await core.ready()
  await copyInto(fake.store, m, [named.d, other.d, core])
  writeRecord(m, [{ key: full.key, group, diary: other.key }])
  for (const run of ['first', 'second']) {
    let inspect = null
    const { result } = await syncOnce(bootstrap, m, { timeoutMs: 8000, inspectHook: (h) => { inspect = h } })
    t.ok(result.ok, result.errors.join('; '))
    t.alike(await heldCopy(m, full.key), { contiguous: 2, held: [0, 1] }, run + ' start: not purged')
    t.alike(recorded(m), { [full.key]: other.key }, run + ' start: its record stays')
    t.alike(slotOf(inspect, full.key), [group, other.key], run + ' start: its slot is the pair that proved it, never the pair its header names')
  }
})

test('at start a recorded stub holding a block past 0 is purged with its record once the diary that proved it is not stored (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const fake = await fakeSeeder(t, bootstrap, kp, [], { answer: () => page([]) })
  const d = await diaryIn(fake.store, kp, 'diary')
  const named = await diaryIn(fake.store, kp, 'named')
  const full = await joinedCore(fake.store, 'full', enc(writerHeader({ group, diary: named.key, member: PARENT })), d, group, 1)
  const m = await groupMember(t, kp, group)
  const core = fake.store.get({ name: 'full' })
  await core.ready()
  await copyInto(fake.store, m, [named.d, core])
  writeRecord(m, [{ key: full.key, group, diary: hex(crypto.randomBytes(32)) }])
  const { result } = await syncOnce(bootstrap, m, { timeoutMs: 8000 })
  t.ok(result.ok, result.errors.join('; '))
  t.absent(await stored(m, full.key), 'nothing here proves it: purged')
  t.alike(recorded(m), {}, 'and its record goes')
})

test('a key whose block 0 can never count is read once a run, however many hints list it (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const diaries = []
  let k = null
  let n = 0
  // A new hint per page, each naming a diary that never joined K.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === group && k !== null ? [{ key: k, diary: diaries[n++ % diaries.length].key, length: 1, seq: 1 }] : [])
  })
  for (let i = 0; i < 4; i++) {
    const d = await diaryIn(fake.store, kp, 'diary-' + i)
    await d.d.append(enc(groupJoinRecord({ group, writer: hex(crypto.randomBytes(32)), on: true })))
    diaries.push(d)
  }
  const core = fake.store.get({ name: 'k' })
  await core.ready()
  await core.append(HEADS.undecodable.raw())
  k = hex(core.key)
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, diaries.map((d) => d.d))
  let reads = 0
  const { events } = await runUntil(m, bootstrap, (evs) => skipped(evs, k).length >= 4, {
    pageRefreshMs: 300,
    quarantineHook: async (key) => { if (key === k) reads++ }
  })
  t.ok(skipped(events, k).every((r) => r === 'header-invalid'), 'every listing keeps its verdict')
  t.is(reads, 1, 'block 0 is read once; each later hint proves only its diary')
})

test('a gate that fails for its listing lets the key\'s listing under another group proceed in the same run (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const other = hex(crypto.randomBytes(32))
  let asStub = null
  let asWriter = null
  let first = true
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => {
      if (q.group === group && asStub !== null) return page([asStub])
      if (q.group !== other || asWriter === null) return page([])
      if (!first) return page([asWriter])
      // The first page comes while G's gate of K waits for a diary no one
      // serves.
      first = false
      return new Promise((resolve) => setTimeout(() => resolve(page([asWriter])), 1000))
    }
  })
  const d = await diaryIn(fake.store, kp, 'diary')
  asWriter = await joinedCore(fake.store, 'k', enc(writerHeader({ group: other, diary: d.key, member: PARENT })), d, other, 2)
  asStub = { key: asWriter.key, diary: hex(crypto.randomBytes(32)), length: 3, seq: 1 }
  const m = await groupMember(t, kp, group, { extra: [other] })
  await copyInto(fake.store, m, [d.d])
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 15000, gateTimeoutMs: 3000 })
  t.ok(downloaded(events, asWriter.key, 3), 'gated under its own group once G\'s gate failed')
  t.alike(await heldCopy(m, asWriter.key), { contiguous: 3, held: [0, 1, 2] }, 'and fetched in full within the run')
})

test('gates in flight never record header stubs past the cap (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], { answer: (q) => page(q.group === group ? listed : []) })
  const d = await diaryIn(fake.store, kp, 'diary')
  const k1 = await joinedCore(fake.store, 'k1', HEADS.legacy.raw(group, d.key), d, group)
  const k2 = await joinedCore(fake.store, 'k2', HEADS.legacy.raw(group, d.key), d, group)
  listed = sorted([k1, k2])
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d])
  // Each accepted gate waits at its open until both are there, or 3 s.
  const opened = new Set()
  const openHook = async (key) => {
    if (key !== k1.key && key !== k2.key) return
    opened.add(key)
    await until(() => opened.size === 2, { timeoutMs: 3000, name: 'both gates' }).catch(() => {})
  }
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 15000, maxHeaderStubs: 1, openHook })
  t.is(Object.keys(recorded(m)).length, 1, 'one stub recorded')
  t.alike([...skipped(events, k1.key), ...skipped(events, k2.key)], ['quota'], 'the other refused as quota, once')
})
