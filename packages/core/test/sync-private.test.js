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
const { writerHeader, groupHeader, groupPost } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, person, exchange, startSeeder, syncOnce, stored, ownWriter, fakeSeeder, groupMember, runUntil } = require('./helpers/sync-groups')

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
    ? groupHeader({ diary: r.dkey, visibility: 'private', join: 'approval', name: null, box: box() })
    : groupHeader({ diary: r.dkey, name: 'Praça', join: 'open' })
  await root.append(enc(header))
  const boxed = await bound(fake.store, kp, group, 'boxed')
  await boxed.w.append(enc(writerHeader({ group, diary: boxed.dkey, box: box() })))
  const bare = await bound(fake.store, kp, group, 'bare')
  await bare.w.append(enc(writerHeader({ group, diary: bare.dkey })))
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
  const { group } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  await member.groupPost(a, { group, text: 'antes' })
  // B learns the root out of band; everything after this travels by sync.
  await exchange(a, b)
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
