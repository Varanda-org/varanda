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
const { testnet } = require('./helpers/net')
const { CAP_HEADER_STUBS } = require('../lib/net')
const { createCert, generateAssociationKeyPair } = require('../lib/cert')
const { writerHeader, groupPost } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, PARENT, person, exchange, syncOnce, stored, fakeSeeder, groupMember, copyInto, runUntil } = require('./helpers/sync-groups')

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

// The blocks of `key` ctx holds: { contiguous, held }.
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

// header-stubs.json as key -> the diary that proved the stub.
function recorded (ctx) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'header-stubs.json'), 'utf8'))
    return Object.fromEntries(data.stubs.map((x) => [x.key, x.diary]))
  } catch {
    return {}
  }
}

// A diary in `cs` (its certificate at seq 0) under `name`.
async function diaryIn (cs, kp, name) {
  const d = cs.get({ name })
  await d.ready()
  const key = hex(d.key)
  await d.append(enc(memberCertRecord(createCert({ member: key }, kp))))
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
