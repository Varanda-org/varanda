'use strict'

// Member sync of header stubs (#350, docs/protocol.md section 10, "Bad
// hints"): a listed writer whose block 0 can never count for the hinted
// diary (undecodable, invalid, a legacy header, or one naming another group
// or another diary) is held as a stub, block 0 alone and never charged,
// once that diary proves the join; unproven, it keeps its verdict and its
// charge. A stub naming another group or diary gives way to the listing of
// that pair, and a restart keeps it only while the stored replica of the
// diary that proved it still holds the join.
// The first half of these cases is in sync-groups-8.test.js: one file ran
// past the per-file test timeout.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { createCert, createModeratorCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writerHeader, groupHeader, groupPost } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const store = require('../lib/store')
const { hex, PARENT, syncOnce, stored, heldCopy, recorded, fakeSeeder, groupMember, copyInto, runUntil } = require('./helpers/sync-groups')

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

// Offers, through `fake`, a snapshot that blocks `keys` (and revokes
// `revokedIssuers`): `holder.snap` is what its `snapshot()` returns.
function blockLive (kp, fake, holder, keys, revokedIssuers = []) {
  const mod = crypto.keyPair()
  holder.snap = createSnapshot({ seq: 1, blocked: keys, revokedIssuers }, mod, createModeratorCert({ moderator: hex(mod.publicKey) }, kp))
  fake.announce()
}

// The (group, diary) whose cap a stored key's slot takes, or null.
function slotOf (inspect, key) {
  const slot = inspect.diskSlotOf(key)
  return slot === null ? null : [slot.group, slot.diary]
}

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
      if (q.after === '0'.repeat(64)) return { items: [k], next: '0'.repeat(63) + '1', incomplete: false }
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
  let servedOwn = null
  const ownServed = new Promise((resolve) => { servedOwn = resolve })
  // Page 1: Da's 31 writers and K fill Da's cap. Page 2, once they are
  // held: W, whose join by Da is earlier than K's, evicts K. Page 3, once K
  // is evicted: K under (G, Dv), the pair its header names. The eviction's
  // purge of K is held until page 3 is served, so that listing can reach the
  // node while the purge is in flight (both orders must pass). The cursors
  // sort before any random key: the node drops an item not past its cursor.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: async (q) => {
      if (q.group !== group || kOwn === null) return page([])
      if (q.after === null) return { items: sorted([...ws, k]), next: '0'.repeat(64), incomplete: false }
      const end = Date.now() + 10000
      if (q.after === '0'.repeat(64)) {
        while (![...ws, k].every((x) => downloaded(events, x.key, 1)) && Date.now() < end) await timeout(50)
        return { items: [w], next: '0'.repeat(63) + '1', incomplete: false }
      }
      while (skipped(events, k.key).length === 0 && Date.now() < end) await timeout(50)
      servedOwn()
      return page([kOwn])
    }
  })
  const purgeHook = async (key, s) => {
    if (key === k.key) await Promise.race([ownServed, timeout(10000)])
    await store.purgeReplica(s, key)
  }
  const da = await diaryIn(fake.store, kp, 'diary-a')
  const dv = await diaryIn(fake.store, kp, 'diary-v')
  for (let i = 0; i < 31; i++) ws.push(await joinedCore(fake.store, 'w' + i, enc(writerHeader({ group, diary: da.key, member: PARENT })), da, group))
  w = await joinedCore(fake.store, 'w', enc(writerHeader({ group, diary: da.key, member: PARENT })), da, group)
  k = await joinedCore(fake.store, 'k', enc(writerHeader({ group, diary: dv.key, member: PARENT })), da, group, 1)
  await dv.d.append(enc(groupJoinRecord({ group, writer: k.key, on: true })))
  kOwn = { ...k, diary: dv.key, seq: dv.d.length - 1 }
  const m = await groupMember(t, kp, group)
  await syncOnce(bootstrap, m, { timeoutMs: 30000, onEvent: (ev) => events.push(ev), purgeHook })
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
        return { items: [x], next: '0'.repeat(63) + '1', incomplete: false }
      }
      if (q.after === '0'.repeat(63) + '1') {
        while (!downloaded(events, x.key, 2) && Date.now() < end) await timeout(50)
        return { items: [w], next: '0'.repeat(63) + '2', incomplete: false }
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
      if (q.after === '0'.repeat(64)) return { items: [kByX], next: '0'.repeat(63) + '1', incomplete: false }
      if (q.after === '0'.repeat(63) + '1') return { items: [kByX], next: '0'.repeat(63) + '2', incomplete: false }
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
