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
const { createCert, createModeratorCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writerHeader, groupHeader, groupPost } = require('../lib/group')
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

// Offers, through `fake`, a snapshot that blocks `keys` (and revokes
// `revokedIssuers`): `holder.snap` is what its `snapshot()` returns.
function blockLive (kp, fake, holder, keys, revokedIssuers = []) {
  const mod = crypto.keyPair()
  holder.snap = createSnapshot({ seq: 1, blocked: keys, revokedIssuers }, mod, createModeratorCert({ moderator: hex(mod.publicKey) }, kp))
  fake.announce()
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

test('a header stub refused for a full record is not gated again until a stub leaves the record, and is then held (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const other = hex(crypto.randomBytes(32))
  let underGroup = []
  let underOther = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => page(q.group === group ? underGroup : q.group === other ? underOther : [])
  })
  const d = await diaryIn(fake.store, kp, 'diary')
  // K1, a writer of the other group, is a stub of G until its listing there.
  const k1 = await joinedCore(fake.store, 'k1', enc(writerHeader({ group: other, diary: d.key, member: PARENT })), d, group, 1)
  await d.d.append(enc(groupJoinRecord({ group: other, writer: k1.key, on: true })))
  const k1Own = { ...k1, seq: d.d.length - 1 }
  const k2 = await joinedCore(fake.store, 'k2', HEADS.legacy.raw(group, d.key), d, group)
  underGroup = [k1]
  const m = await groupMember(t, kp, group, { extra: [other] })
  await copyInto(fake.store, m, [d.d])
  let refusedAt = 0
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (underGroup.length === 1 && downloaded(evs, k1.key, 1)) underGroup = sorted([k1, k2])
    if (refusedAt === 0 && skipped(evs, k2.key).length > 0) refusedAt = Date.now()
    // Several pages later, K1 leaves the record for its own group.
    if (refusedAt > 0 && Date.now() - refusedAt > 2000) underOther = [k1Own]
    return downloaded(evs, k2.key, 1)
  }, { pageRefreshMs: 300, maxHeaderStubs: 1 })
  t.alike(skipped(events, k2.key), ['quota'], 'refused once for the full record, not on every page')
  t.alike(await heldCopy(m, k1.key), { contiguous: 2, held: [0, 1] }, 'K1 gave way to its own group')
  t.alike(recorded(m), { [k2.key]: d.key }, 'and K2 took its place in the record')
})

test('a stub purged for its own key leaves the record, and a restart does not bring it back (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const holder = { snap: null }
  const fake = await fakeSeeder(t, bootstrap, kp, [], { snapshot: () => holder.snap, answer: (q) => page(q.group === group ? listed : []) })
  const d = await diaryIn(fake.store, kp, 'diary')
  const k = await joinedCore(fake.store, 'k', HEADS.legacy.raw(group, d.key), d, group)
  listed = [k]
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d])
  await runUntil(m, bootstrap, (evs) => {
    if (holder.snap === null && downloaded(evs, k.key, 1)) blockLive(kp, fake, holder, [k.key])
    return skipped(evs, k.key).length > 0
  }, { pageRefreshMs: 300 })
  t.absent(await stored(m, k.key), 'the blocked stub is purged')
  t.alike(recorded(m), {}, 'and its record goes with its core')
  listed = []
  await syncOnce(bootstrap, m, { timeoutMs: 8000 })
  t.absent(await stored(m, k.key), 'a restart does not bring it back')
  t.alike(recorded(m), {})
})

test('a block of the diary that proved a stub stored in this run purges the stub with its record (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const holder = { snap: null }
  const fake = await fakeSeeder(t, bootstrap, kp, [], { snapshot: () => holder.snap, answer: (q) => page(q.group === group ? listed : []) })
  const d = await diaryIn(fake.store, kp, 'diary')
  const k = await joinedCore(fake.store, 'k', HEADS['another diary'].raw(group), d, group)
  listed = [k]
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d])
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (holder.snap === null && downloaded(evs, k.key, 1)) blockLive(kp, fake, holder, [d.key])
    return skipped(evs, k.key).length > 0
  }, { pageRefreshMs: 300 })
  t.alike(skipped(events, k.key), ['blocked'], 'the stub leaves the table for its diary')
  t.absent(await stored(m, k.key), 'held for that listing alone, it is purged')
  t.alike(recorded(m), {}, 'and its record goes with it')
})

// Whether the run has adopted a snapshot for `ctx` some time ago.
function adoptedFor (ctx, state, ms) {
  if (state.at === 0 && fs.existsSync(path.join(ctx.dataDir, 'blocklist.json'))) state.at = Date.now()
  return state.at > 0 && Date.now() - state.at > ms
}

test('a block of the diary that proved a stub stored before this run purges the stub in the same run (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const holder = { snap: null }
  const fake = await fakeSeeder(t, bootstrap, kp, [], { snapshot: () => holder.snap, answer: (q) => page(q.group === group ? listed : []) })
  const d = await diaryIn(fake.store, kp, 'diary')
  const k = await joinedCore(fake.store, 'k', HEADS['another diary'].raw(group), d, group)
  listed = [k]
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d])
  await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(recorded(m), { [k.key]: d.key }, 'held as a stub of (G, D)')
  // The next run gates it again from the same listing, then D is blocked.
  const adopted = { at: 0 }
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (holder.snap === null && downloaded(evs, k.key, 1)) blockLive(kp, fake, holder, [d.key])
    return skipped(evs, k.key).length > 0 || adoptedFor(m, adopted, 5000)
  }, { pageRefreshMs: 300 })
  t.alike(skipped(events, k.key), ['blocked'], 'the stub leaves the table for its diary, once')
  t.absent(await stored(m, k.key), 'no other diary or role holds it: it is purged in this run')
  t.alike(recorded(m), {}, 'and its record goes with it')
})

test('a block of the diary that proved a stub leaves the stub\'s core in place while it is held here in another role (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const holder = { snap: null }
  const fake = await fakeSeeder(t, bootstrap, kp, [], { snapshot: () => holder.snap, answer: (q) => page(q.group === group ? listed : []) })
  const dx = await diaryIn(fake.store, kp, 'diary-x')
  const d2 = await diaryIn(fake.store, kp, 'diary-2')
  // DX joins D2 as a writer of G: a stub of (G, DX). D2 binds its own W.
  await dx.d.append(enc(groupJoinRecord({ group, writer: d2.key, on: true })))
  const asStub = { key: d2.key, diary: dx.key, length: 1, seq: dx.d.length - 1 }
  const w = await joinedCore(fake.store, 'w', enc(writerHeader({ group, diary: d2.key, member: PARENT })), d2, group, 1)
  listed = [asStub]
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [dx.d])
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (listed.length === 1 && downloaded(evs, d2.key, 1)) listed = sorted([asStub, w])
    if (holder.snap === null && downloaded(evs, w.key, 2)) blockLive(kp, fake, holder, [dx.key])
    return skipped(evs, d2.key).length > 0
  }, { pageRefreshMs: 300 })
  t.alike(skipped(events, d2.key), ['blocked'], 'the stub leaves the table for its diary')
  t.ok(await stored(m, d2.key), 'but D2, the binding diary of W, stays')
  t.alike(await heldCopy(m, w.key), { contiguous: 2, held: [0, 1] }, 'and W stays in full')
  t.alike(recorded(m), {}, 'only the record goes')
})

test('a listing whose diary is a stub held here never makes this node store a later block of it, and the stub keeps its record and slot across a restart (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], { answer: (q) => page(q.group === group ? listed : []) })
  const da = await diaryIn(fake.store, kp, 'diary-a')
  const dv = await diaryIn(fake.store, kp, 'diary-v')
  // Ki, a writer of (G, Dv) by its header that Da alone joined, with a
  // block past 0; then 31 writers of (G, Dv) and a 32nd joined last.
  const ki = await joinedCore(fake.store, 'ki', enc(writerHeader({ group, diary: dv.key, member: PARENT })), da, group, 1)
  const vs = []
  for (let i = 0; i < 31; i++) vs.push(await joinedCore(fake.store, 'v' + i, enc(writerHeader({ group, diary: dv.key, member: PARENT })), dv, group))
  const last = await joinedCore(fake.store, 'last', enc(writerHeader({ group, diary: dv.key, member: PARENT })), dv, group, 1)
  // Z, listed with Ki as its diary and Ki's block 1 as the join.
  const z = fake.store.get({ name: 'z' })
  await z.ready()
  await z.append(enc(writerHeader({ group, diary: ki.key, member: PARENT })))
  const zItem = { key: hex(z.key), diary: ki.key, length: 1, seq: 1 }
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [da.d, dv.d])
  listed = sorted([ki, ...vs])
  const first = await syncOnce(bootstrap, m, { timeoutMs: 30000 })
  t.ok(first.result.ok, first.result.errors.join('; '))
  t.alike(recorded(m), { [ki.key]: da.key }, 'Ki held as a stub of (G, Da)')
  listed = [zItem]
  const second = await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.ok(skipped(second.events, zItem.key).length > 0, 'Z is refused: Ki\'s block 0 is no diary record')
  t.alike(await heldCopy(m, ki.key), { contiguous: 1, held: [0] }, 'and Ki\'s block 1 is never stored')
  listed = [last]
  let inspect = null
  const third = await syncOnce(bootstrap, m, { timeoutMs: 15000, inspectHook: (h) => { inspect = h } })
  t.alike(recorded(m), { [ki.key]: da.key }, 'Ki keeps its record')
  t.alike(slotOf(inspect, ki.key), [group, da.key], 'and its slot stays with (G, Da)')
  t.alike(skipped(third.events, last.key), [], 'so Dv\'s writers are not refused for the cap')
  t.alike(await heldCopy(m, last.key), { contiguous: 2, held: [0, 1] }, 'and the last one is fetched in full')
})

test('a slot a stub record held never purges a core gated here under another pair or held in another role when the cap of the pair that proved it fills (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], { answer: (q) => page(q.group === group ? listed : []) })
  const da = await diaryIn(fake.store, kp, 'diary-a')
  const d2 = await diaryIn(fake.store, kp, 'diary-2')
  const kd = await diaryIn(fake.store, kp, 'diary-k')
  // Da joins 32 writers of its own, then K (a writer of (G, D2) by its
  // header) and the diary KD: both are stubs of (G, Da).
  const ws = []
  for (let i = 0; i < 32; i++) ws.push(await joinedCore(fake.store, 'w' + i, enc(writerHeader({ group, diary: da.key, member: PARENT })), da, group))
  const k = await joinedCore(fake.store, 'k', enc(writerHeader({ group, diary: d2.key, member: PARENT })), da, group, 1)
  await da.d.append(enc(groupJoinRecord({ group, writer: kd.key, on: true })))
  const kdStub = { key: kd.key, diary: da.key, length: 1, seq: da.d.length - 1 }
  // D2 joins K (D2 is not stored here at the next start: K stays a stub
  // then), and KD binds its own writer X.
  await d2.d.append(enc(groupJoinRecord({ group, writer: k.key, on: true })))
  const kOwn = { ...k, diary: d2.key, seq: d2.d.length - 1 }
  const x = await joinedCore(fake.store, 'x', enc(writerHeader({ group, diary: kd.key, member: PARENT })), kd, group, 1)
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [da.d])
  listed = sorted([k, kdStub])
  await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(recorded(m), { [k.key]: da.key, [kd.key]: da.key }, 'K and KD held as stubs of (G, Da)')
  // Next start: K is gated in full under D2 and KD binds X, then Da's own
  // writers fill Da's cap.
  listed = sorted([kOwn, x])
  let inspect = null
  let slotThen
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (listed.length === 2 && downloaded(evs, k.key, 2) && downloaded(evs, x.key, 2)) {
      slotThen = slotOf(inspect, k.key)
      listed = sorted([kOwn, x, ...ws])
    }
    return ws.every((w) => downloaded(evs, w.key, 1) || skipped(evs, w.key).length > 0)
  }, { pageRefreshMs: 300, inspectHook: (h) => { inspect = h } })
  t.is(slotThen, null, 'K\'s slot of (G, Da) went with its record when K was gated in full')
  t.alike(skipped(events, k.key), [], 'K is never refused')
  t.alike(await heldCopy(m, k.key), { contiguous: 2, held: [0, 1] }, 'and stays in full')
  t.ok(await stored(m, kd.key), 'KD, the binding diary of X, stays')
  t.alike(await heldCopy(m, x.key), { contiguous: 2, held: [0, 1] }, 'and so does X')
  t.absent(k.key in recorded(m), 'K left the record when it was gated in full')
})

test('a recorded stub gated as a stub of another pair is never refused when the cap of the pair that proved it fills (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], { answer: (q) => page(q.group === group ? listed : []) })
  const da = await diaryIn(fake.store, kp, 'diary-a')
  const dx = await diaryIn(fake.store, kp, 'diary-x')
  // Da joins 32 writers of its own, then K, whose header names another
  // diary of G: a stub of (G, Da). Dx joins K too.
  const ws = []
  for (let i = 0; i < 32; i++) ws.push(await joinedCore(fake.store, 'w' + i, enc(writerHeader({ group, diary: da.key, member: PARENT })), da, group))
  const k = await joinedCore(fake.store, 'k', HEADS['another diary'].raw(group), da, group)
  await dx.d.append(enc(groupJoinRecord({ group, writer: k.key, on: true })))
  const kByX = { ...k, diary: dx.key, seq: dx.d.length - 1 }
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [da.d, dx.d])
  listed = [k]
  await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(recorded(m), { [k.key]: da.key }, 'K held as a stub of (G, Da)')
  // Next start: K is gated as a stub of (G, Dx), then Da's own writers fill
  // Da's cap, where K's record still holds a slot.
  listed = [kByX]
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (listed.length === 1 && downloaded(evs, k.key, 1)) listed = sorted([kByX, ...ws])
    return ws.every((w) => downloaded(evs, w.key, 1) || skipped(evs, w.key).length > 0)
  }, { pageRefreshMs: 300 })
  t.alike(skipped(events, k.key), [], 'K is never refused')
  t.alike(await heldCopy(m, k.key), { contiguous: 1, held: [0] }, 'and stays held, block 0 alone')
  t.ok(ws.every((w) => downloaded(events, w.key, 1)), 'and Da\'s writers are all held')
})

test('a stub stays held when its root\'s visibility is learned while its gate runs (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  let listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], { answer: () => page(listed) })
  // A private root R, bound by its creator's diary.
  const creator = await diaryIn(fake.store, kp, 'creator')
  const root = fake.store.get({ name: 'root' })
  await root.ready()
  const group = hex(root.key)
  await root.append(enc(groupHeader({ community: PARENT, member: PARENT, diary: creator.key, visibility: 'private', join: 'approval', name: null, box: hex(crypto.randomBytes(32)) })))
  await creator.d.append(enc(groupJoinRecord({ group, writer: group, on: true })))
  const rootItem = { key: group, diary: creator.key, length: 1, seq: creator.d.length - 1 }
  // S names another diary of R and has no box: a stub of (R, D).
  const d = await diaryIn(fake.store, kp, 'diary')
  const s = await joinedCore(fake.store, 's', HEADS['another diary'].raw(group), d, group)
  listed = sorted([rootItem, s])
  const m = await groupMember(t, kp, group)
  // S's gate reads D once R's gate has started, and R's gate waits for
  // that read; D's read then waits until R is held.
  let dStarted = null
  const dRead = new Promise((resolve) => { dStarted = resolve })
  let rootSeen = null
  const rootHeld = new Promise((resolve) => { rootSeen = resolve })
  const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const quarantineHook = async (key) => {
    if (key === group) await Promise.race([dRead, timeout(10000)])
    if (key === d.key) {
      dStarted()
      await Promise.race([rootHeld, timeout(10000)])
    }
  }
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (downloaded(evs, group, 1)) rootSeen()
    return downloaded(evs, s.key, 1) || skipped(evs, s.key).length > 0
  }, { pageRefreshMs: 300, quarantineHook })
  t.ok(downloaded(events, group, 1), 'R is held')
  t.alike(skipped(events, s.key), [], 'S is not refused for its box')
  t.alike(await heldCopy(m, s.key), { contiguous: 1, held: [0] }, 'and is held, block 0 alone')
  t.is(recorded(m)[s.key], d.key)
})

test('a stub refused for a full record is refused before its diary is read when a new hint lists it (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], { answer: (q) => page(q.group === group ? listed : []) })
  const d1 = await diaryIn(fake.store, kp, 'diary-1')
  const d2 = await diaryIn(fake.store, kp, 'diary-2')
  const d3 = await diaryIn(fake.store, kp, 'diary-3')
  const k1 = await joinedCore(fake.store, 'k1', HEADS.legacy.raw(group, d1.key), d1, group)
  const k2 = await joinedCore(fake.store, 'k2', HEADS.undecodable.raw(), d2, group)
  await d3.d.append(enc(groupJoinRecord({ group, writer: k2.key, on: true })))
  const k2Again = { ...k2, diary: d3.key, seq: d3.d.length - 1 }
  listed = [k1]
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d1.d, d2.d])
  let reads = 0
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (listed.length === 1 && downloaded(evs, k1.key, 1)) listed = sorted([k1, k2])
    if (listed.includes(k2) && skipped(evs, k2.key).length > 0) listed = sorted([k1, k2Again])
    return skipped(evs, k2.key).length >= 2
  }, { pageRefreshMs: 300, maxHeaderStubs: 1, quarantineHook: async (key) => { if (key === d3.key) reads++ } })
  t.alike(skipped(events, k2.key), ['quota', 'quota'], 'each hint refused as quota, never charged')
  t.is(reads, 0, 'the new hint\'s diary is never read')
})

test('a stub that lost the cap of the diary that proved it never keeps out the listing of the pair its header names (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let second = false
  const events = []
  let k = null
  let kOwn = null
  const ws = []
  // The second run's first page lists K alone under Da, whose 32 writers
  // are on disk; its next page, asked for once K lost Da's cap, lists K
  // under Dv. A --once run never forgets that refusal.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: async (q) => {
      if (q.group !== group) return page([])
      if (!second) return page(sorted(ws))
      if (q.after === null) return { items: [k], next: '0'.repeat(64), incomplete: false }
      const end = Date.now() + 6000
      while (skipped(events, k.key).length === 0 && Date.now() < end) await timeout(50)
      return page([kOwn])
    }
  })
  const da = await diaryIn(fake.store, kp, 'diary-a')
  const dv = await diaryIn(fake.store, kp, 'diary-v')
  // Da joins 32 writers of its own, then K, a writer of (G, Dv) by its
  // header that Dv joins too.
  for (let i = 0; i < 32; i++) ws.push(await joinedCore(fake.store, 'w' + i, enc(writerHeader({ group, diary: da.key, member: PARENT })), da, group))
  k = await joinedCore(fake.store, 'k', enc(writerHeader({ group, diary: dv.key, member: PARENT })), da, group, 1)
  await dv.d.append(enc(groupJoinRecord({ group, writer: k.key, on: true })))
  kOwn = { ...k, diary: dv.key, seq: dv.d.length - 1 }
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [da.d])
  const first = await syncOnce(bootstrap, m, { timeoutMs: 30000 })
  t.ok(first.result.ok, first.result.errors.join('; '))
  second = true
  await syncOnce(bootstrap, m, { timeoutMs: 30000, onEvent: (ev) => events.push(ev) })
  t.alike(skipped(events, k.key), ['quota'], 'K, a stub of (G, Da), loses Da\'s full cap')
  t.alike(await heldCopy(m, k.key), { contiguous: 2, held: [0, 1] }, 'and its listing under (G, Dv) is then fetched in full')
  t.absent(k.key in recorded(m), 'with no record')
})

test('a stub refused for the full cap of the diary that proved it is gated once, however many pages list it (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const events = []
  let k = null
  let served = 0
  // Three pages list K under Da; each page after the first is served once
  // K was refused, so every listing could start a gate.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: async (q) => {
      if (q.group !== group || k === null) return page([])
      if (q.after !== null) {
        const end = Date.now() + 6000
        while (skipped(events, k.key).length === 0 && Date.now() < end) await timeout(50)
        await timeout(500)
      }
      served++
      if (q.after === null) return { items: [k], next: '0'.repeat(64), incomplete: false }
      if (q.after === '0'.repeat(64)) return { items: [k], next: '1'.repeat(64), incomplete: false }
      return page([k])
    }
  })
  const da = await diaryIn(fake.store, kp, 'diary-a')
  // Da joins 32 writers of its own, stored here (Da itself is not), then K,
  // whose header names another diary of G.
  const cores = []
  for (let i = 0; i < 32; i++) {
    await joinedCore(fake.store, 'w' + i, enc(writerHeader({ group, diary: da.key, member: PARENT })), da, group)
    const core = fake.store.get({ name: 'w' + i })
    await core.ready()
    cores.push(core)
  }
  k = await joinedCore(fake.store, 'k', HEADS['another diary'].raw(group), da, group)
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, cores)
  let reads = 0
  await syncOnce(bootstrap, m, { timeoutMs: 15000, onEvent: (ev) => events.push(ev), quarantineHook: async (key) => { if (key === da.key) reads++ } })
  t.alike(skipped(events, k.key), ['quota'], 'K loses Da\'s full cap')
  t.ok(served >= 3, 'three pages list K')
  t.is(reads, 1, 'and Da is read for one gate of K, not one per page')
  t.absent(k.key in recorded(m), 'K is not held')
})

test('a stub evicted from the cap of the diary that proved it is admitted under the pair its header names in the same run (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const events = []
  const ws = []
  let k = null
  let w = null
  let kOwn = null
  // Page 1: Da's 31 writers and K fill Da's cap. Page 2, once they are
  // held: W, whose join by Da is earlier than K's, evicts K. Page 3, once K
  // is evicted: K under (G, Dv), the pair its header names.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: async (q) => {
      if (q.group !== group || kOwn === null) return page([])
      if (q.after === null) return { items: sorted([...ws, k]), next: '0'.repeat(64), incomplete: false }
      const end = Date.now() + 10000
      if (q.after === '0'.repeat(64)) {
        while (![...ws, k].every((x) => downloaded(events, x.key, 1)) && Date.now() < end) await timeout(50)
        return { items: [w], next: '1'.repeat(64), incomplete: false }
      }
      while (skipped(events, k.key).length === 0 && Date.now() < end) await timeout(50)
      return page([kOwn])
    }
  })
  const da = await diaryIn(fake.store, kp, 'diary-a')
  const dv = await diaryIn(fake.store, kp, 'diary-v')
  for (let i = 0; i < 31; i++) ws.push(await joinedCore(fake.store, 'w' + i, enc(writerHeader({ group, diary: da.key, member: PARENT })), da, group))
  w = await joinedCore(fake.store, 'w', enc(writerHeader({ group, diary: da.key, member: PARENT })), da, group)
  k = await joinedCore(fake.store, 'k', enc(writerHeader({ group, diary: dv.key, member: PARENT })), da, group, 1)
  await dv.d.append(enc(groupJoinRecord({ group, writer: k.key, on: true })))
  kOwn = { ...k, diary: dv.key, seq: dv.d.length - 1 }
  const m = await groupMember(t, kp, group)
  await syncOnce(bootstrap, m, { timeoutMs: 30000, onEvent: (ev) => events.push(ev) })
  t.alike(skipped(events, k.key), ['quota'], 'K, a stub of (G, Da), gives way to W\'s earlier join')
  t.ok(downloaded(events, w.key, 1), 'W is held')
  t.alike(await heldCopy(m, k.key), { contiguous: 2, held: [0, 1] }, 'and K\'s listing under (G, Dv) is then fetched in full')
  t.absent(k.key in recorded(m), 'with no record')
})

test('a stub held here in another role, evicted from the cap of the diary that proved it, has its listing under another pair gated in the same run (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const events = []
  const ws = []
  let kdStub = null
  let kdByX = null
  let x = null
  let w = null
  // Page 1: Da's 31 writers and KD (a diary, a stub of (G, Da)) fill Da's
  // cap. Page 2: X, which KD binds, so KD is held here as a binding diary.
  // Page 3: W, whose join by Da is earlier than KD's, evicts KD. Page 4:
  // KD under (G, Dx).
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: async (q) => {
      if (q.group !== group || kdByX === null) return page([])
      const end = Date.now() + 10000
      if (q.after === null) return { items: sorted([...ws, kdStub]), next: '0'.repeat(64), incomplete: false }
      if (q.after === '0'.repeat(64)) {
        while (![...ws, kdStub].every((y) => downloaded(events, y.key, 1)) && Date.now() < end) await timeout(50)
        return { items: [x], next: '1'.repeat(64), incomplete: false }
      }
      if (q.after === '1'.repeat(64)) {
        while (!downloaded(events, x.key, 2) && Date.now() < end) await timeout(50)
        return { items: [w], next: '2'.repeat(64), incomplete: false }
      }
      while (skipped(events, kdStub.key).length === 0 && Date.now() < end) await timeout(50)
      return page([kdByX])
    }
  })
  const da = await diaryIn(fake.store, kp, 'diary-a')
  const dx = await diaryIn(fake.store, kp, 'diary-x')
  const kd = await diaryIn(fake.store, kp, 'diary-k')
  for (let i = 0; i < 31; i++) ws.push(await joinedCore(fake.store, 'w' + i, enc(writerHeader({ group, diary: da.key, member: PARENT })), da, group))
  w = await joinedCore(fake.store, 'w', enc(writerHeader({ group, diary: da.key, member: PARENT })), da, group)
  x = await joinedCore(fake.store, 'x', enc(writerHeader({ group, diary: kd.key, member: PARENT })), kd, group, 1)
  await da.d.append(enc(groupJoinRecord({ group, writer: kd.key, on: true })))
  kdStub = { key: kd.key, diary: da.key, length: kd.d.length, seq: da.d.length - 1 }
  await dx.d.append(enc(groupJoinRecord({ group, writer: kd.key, on: true })))
  kdByX = { key: kd.key, diary: dx.key, length: kd.d.length, seq: dx.d.length - 1 }
  const m = await groupMember(t, kp, group)
  let reads = 0
  await syncOnce(bootstrap, m, { timeoutMs: 30000, onEvent: (ev) => events.push(ev), quarantineHook: async (key) => { if (key === dx.key) reads++ } })
  t.alike(skipped(events, kd.key), ['quota'], 'KD gives way to W\'s earlier join')
  t.ok(await stored(m, kd.key), 'and stays, the binding diary of X')
  t.ok(reads > 0, 'and its listing under (G, Dx) is gated in the same run')
})

test('a record whose diary is blocked moves to the pair its stub is active under, and a restart keeps the stub slot there (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const holder = { snap: null }
  const fake = await fakeSeeder(t, bootstrap, kp, [], { snapshot: () => holder.snap, answer: (q) => page(q.group === group ? listed : []) })
  const da = await diaryIn(fake.store, kp, 'diary-a')
  const dx = await diaryIn(fake.store, kp, 'diary-x')
  // K names another diary of G: a stub of (G, Da), and of (G, Dx).
  const k = await joinedCore(fake.store, 'k', HEADS['another diary'].raw(group), da, group)
  await dx.d.append(enc(groupJoinRecord({ group, writer: k.key, on: true })))
  const kByX = { ...k, diary: dx.key, seq: dx.d.length - 1 }
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [da.d, dx.d])
  listed = [k]
  await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(recorded(m), { [k.key]: da.key }, 'K held as a stub of (G, Da)')
  // Next start: K is gated as a stub of (G, Dx), then Da is blocked.
  listed = [kByX]
  const adopted = { at: 0 }
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (holder.snap === null && downloaded(evs, k.key, 1)) blockLive(kp, fake, holder, [da.key])
    return skipped(evs, k.key).length > 0 || adoptedFor(m, adopted, 5000)
  }, { pageRefreshMs: 300 })
  t.alike(skipped(events, k.key), [], 'K is never purged')
  t.alike(await heldCopy(m, k.key), { contiguous: 1, held: [0] }, 'and stays held under (G, Dx)')
  t.alike(recorded(m), { [k.key]: dx.key }, 'its record moves from (G, Da) to (G, Dx)')
  // Next start: nothing lists K; its record alone charges its slot.
  listed = []
  let inspect = null
  await syncOnce(bootstrap, m, { timeoutMs: 10000, inspectHook: (h) => { inspect = h } })
  t.alike(recorded(m), { [k.key]: dx.key }, 'a restart keeps the record of (G, Dx)')
  t.alike(inspect.diskSlotOf(k.key), { group, diary: dx.key, stub: true }, 'and K holds the stub slot of (G, Dx), never one of the pair its header names')
  t.alike(await heldCopy(m, k.key), { contiguous: 1, held: [0] }, 'and K stays held')
})

test('a record whose diary is blocked never purges its key while the key\'s gate as a writer of its own pair runs, and the key is admitted (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const holder = { snap: null }
  const fake = await fakeSeeder(t, bootstrap, kp, [], { snapshot: () => holder.snap, answer: (q) => page(q.group === group ? listed : []) })
  const da = await diaryIn(fake.store, kp, 'diary-a')
  const d2 = await diaryIn(fake.store, kp, 'diary-2')
  // K, a writer of (G, D2) by its header that Da joins too. D2 is never
  // stored here, so the next start keeps K's record.
  const k = await joinedCore(fake.store, 'k', enc(writerHeader({ group, diary: d2.key, member: PARENT })), da, group, 1)
  await d2.d.append(enc(groupJoinRecord({ group, writer: k.key, on: true })))
  const kOwn = { ...k, diary: d2.key, seq: d2.d.length - 1 }
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [da.d])
  listed = [k]
  await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(recorded(m), { [k.key]: da.key }, 'K held as a stub of (G, Da)')
  // Next start: K is gated under (G, D2); while D2 is read, Da is blocked
  // and the snapshot adopted.
  listed = [kOwn]
  const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const quarantineHook = async (key) => {
    if (key !== d2.key || holder.snap !== null) return
    blockLive(kp, fake, holder, [da.key])
    const adopted = { at: 0 }
    const end = Date.now() + 10000
    while (!adoptedFor(m, adopted, 2000) && Date.now() < end) await timeout(100)
  }
  const { events } = await runUntil(m, bootstrap, (evs) => downloaded(evs, k.key, 2) || skipped(evs, k.key).length > 0, { pageRefreshMs: 300, quarantineHook })
  t.ok(holder.snap !== null, 'Da was blocked while K\'s gate ran')
  t.alike(skipped(events, k.key), [], 'K is never purged')
  t.alike(await heldCopy(m, k.key), { contiguous: 2, held: [0, 1] }, 'and is admitted and fetched in full')
  t.alike(recorded(m), {}, 'leaving the record')
})

test('a revoked issuer of the diary that proved a stub stored before this run purges the stub in the same run (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const holder = { snap: null }
  const fake = await fakeSeeder(t, bootstrap, kp, [], { snapshot: () => holder.snap, answer: (q) => page(q.group === group ? listed : []) })
  const issuerKp = crypto.keyPair()
  const issuer = hex(issuerKp.publicKey)
  const issuerCert = createIssuerCert({ issuer }, kp)
  const d = await diaryIn(fake.store, kp, 'diary', (member) => createIssuedCert({ member }, issuerKp, issuerCert))
  const k = await joinedCore(fake.store, 'k', HEADS['another diary'].raw(group), d, group)
  listed = [k]
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d])
  await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(recorded(m), { [k.key]: d.key }, 'held as a stub of (G, D)')
  const adopted = { at: 0 }
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (holder.snap === null && downloaded(evs, k.key, 1)) blockLive(kp, fake, holder, [], [issuer])
    return skipped(evs, k.key).length > 0 || adoptedFor(m, adopted, 5000)
  }, { pageRefreshMs: 300 })
  t.alike(skipped(events, k.key), ['revoked-issuer'], 'the stub leaves the table for its diary\'s issuer')
  t.absent(await stored(m, k.key), 'and is purged in this run')
  t.alike(recorded(m), {}, 'with its record')
})

test('a block of the diary that proved a stub not listed in this run purges the stub with its record in the same run (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const holder = { snap: null }
  const fake = await fakeSeeder(t, bootstrap, kp, [], { snapshot: () => holder.snap, answer: (q) => page(q.group === group ? listed : []) })
  const d = await diaryIn(fake.store, kp, 'diary')
  const k = await joinedCore(fake.store, 'k', HEADS['another diary'].raw(group), d, group)
  listed = [k]
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d.d])
  await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(recorded(m), { [k.key]: d.key }, 'held as a stub of (G, D)')
  // Next start: nothing lists K, and the seeder's snapshot blocks D.
  listed = []
  blockLive(kp, fake, holder, [d.key])
  const adopted = { at: 0 }
  const { events } = await runUntil(m, bootstrap, (evs) => skipped(evs, k.key).length > 0 || adoptedFor(m, adopted, 5000), { pageRefreshMs: 300 })
  t.alike(skipped(events, k.key), ['blocked'], 'the stub, with no entry in the table, goes for its diary')
  t.absent(await stored(m, k.key), 'purged in this run')
  t.alike(recorded(m), {}, 'with its record')
})

test('a stored writer that lost the full cap of the diary its header names is opened for one gate under another diary, however many pages list it there (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const events = []
  let k = null
  let kByX = null
  let served = 0
  // The first page lists K under Dh; the three after it list K under Dx,
  // each served once K was refused and the page before it settled, so
  // every listing could start a gate.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: async (q) => {
      if (q.group !== group || k === null) return page([])
      if (q.after === null) return { items: [k], next: '0'.repeat(64), incomplete: false }
      const end = Date.now() + 6000
      while (skipped(events, k.key).length === 0 && Date.now() < end) await timeout(50)
      await timeout(500)
      served++
      if (q.after === '0'.repeat(64)) return { items: [kByX], next: '1'.repeat(64), incomplete: false }
      if (q.after === '1'.repeat(64)) return { items: [kByX], next: '2'.repeat(64), incomplete: false }
      return page([kByX])
    }
  })
  const dh = await diaryIn(fake.store, kp, 'diary-h')
  const dx = await diaryIn(fake.store, kp, 'diary-x')
  // 33 writers of (G, Dh), all stored here from an earlier run: K, the
  // latest Dh joined, is one past Dh's cap. Dx joins K too.
  const cores = []
  let last = null
  for (let i = 0; i < 33; i++) {
    last = await joinedCore(fake.store, 'w' + i, enc(writerHeader({ group, diary: dh.key, member: PARENT })), dh, group)
    const core = fake.store.get({ name: 'w' + i })
    await core.ready()
    cores.push(core)
  }
  await dx.d.append(enc(groupJoinRecord({ group, writer: last.key, on: true })))
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, cores)
  kByX = { ...last, diary: dx.key, seq: dx.d.length - 1 }
  k = last
  let inspect = null
  await syncOnce(bootstrap, m, { timeoutMs: 15000, onEvent: (ev) => events.push(ev), inspectHook: (h) => { inspect = h } })
  t.alike(skipped(events, k.key), ['quota'], 'K loses Dh\'s full cap')
  t.ok(served >= 3, 'three pages list K under Dx')
  t.is(inspect.storedGateCount(k.key), 2, 'and its stored core is opened for its gate under Dh and for one gate under Dx, not one per page')
  t.ok(await stored(m, k.key), 'K keeps its blocks')
})

test('a recorded stub refused for the full cap of another diary keeps the slot of the pair that proved it (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], { answer: (q) => page(q.group === group ? listed : []) })
  const da = await diaryIn(fake.store, kp, 'diary-a')
  const dx = await diaryIn(fake.store, kp, 'diary-x')
  // Dx joins 32 writers of its own, stored here; Da joins K, whose header
  // names another diary of G: a stub of (G, Da). Dx joins K last.
  const cores = []
  for (let i = 0; i < 32; i++) {
    await joinedCore(fake.store, 'w' + i, enc(writerHeader({ group, diary: dx.key, member: PARENT })), dx, group)
    const core = fake.store.get({ name: 'w' + i })
    await core.ready()
    cores.push(core)
  }
  const k = await joinedCore(fake.store, 'k', HEADS['another diary'].raw(group), da, group)
  await dx.d.append(enc(groupJoinRecord({ group, writer: k.key, on: true })))
  const kByX = { ...k, diary: dx.key, seq: dx.d.length - 1 }
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [da.d, ...cores])
  listed = [k]
  await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.alike(recorded(m), { [k.key]: da.key }, 'K held as a stub of (G, Da)')
  // Next start: K is listed under Dx, whose cap its stored writers fill.
  listed = [kByX]
  let inspect = null
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 15000, inspectHook: (h) => { inspect = h } })
  t.alike(skipped(events, k.key), ['quota'], 'K loses Dx\'s full cap')
  t.alike(slotOf(inspect, k.key), [group, da.key], 'and keeps its slot of (G, Da)')
  t.alike(recorded(m), { [k.key]: da.key }, 'and its record')
})
