'use strict'

// Member sync of group cores, continued from sync-groups-4.test.js (split to keep each
// file under the runner's per-file time limit): unservable listings, join seq hints and listings under blocked diaries.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { MAX_GROUP_HELD_PER_DIARY: CAP } = require('../lib/sync')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writerHeader, groupHeader, groupPost } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const { hex, PARENT, syncOnce, stored, fakeSeeder, diaryAndWriter, copyInto, runUntil, groupMember, never } = require('./helpers/sync-groups')

test('a seeder listing many unservable writers stops being paged and an honest writer is still admitted', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const junk = []
  for (let i = 0; i < 20; i++) junk.push({ key: hex(crypto.randomBytes(32)), diary: hex(crypto.randomBytes(32)), length: 1, seq: 1 })
  junk.sort((x, y) => x.key < y.key ? -1 : 1)
  const spam = await fakeSeeder(t, bootstrap, kp, junk)
  const items = []
  const honest = await fakeSeeder(t, bootstrap, kp, items)
  const { w, dkey, wkey } = await diaryAndWriter(honest.store, group, (key) => createCert({ member: key }, kp), 0)
  items.push({ key: wkey, diary: dkey, length: 3, seq: 1 })
  const m = await groupMember(t, kp, group)
  // The honest writer is advertised at length 3 and grows only once every
  // junk listing has been given up on (gate timeout), so the run is still
  // open while the spamming seeder is judged. Triggered by that state, not
  // by a guess of how long the gates take.
  const events = []
  const junkKeys = new Set(junk.map((j) => j.key))
  let grown = false
  const onEvent = (ev) => {
    events.push(ev)
    if (grown) return
    const skipped = new Set(events.filter((e) => e.event === 'group-skipped' && junkKeys.has(e.key)).map((e) => e.key))
    if (skipped.size < junk.length) return
    grown = true
    ;(async () => {
      for (let i = 0; i < 2; i++) await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' + i }))))
    })().catch(() => {})
  }
  const { result } = await syncOnce(bootstrap, m, { pageRetryMs: 100, gateTimeoutMs: 500, onEvent })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(spam.requests.length < 12, 'the spamming seeder is no longer paged: ' + spam.requests.length + ' requests')
  const last = events.filter((ev) => ev.event === 'group-downloaded' && ev.key === wkey).pop()
  t.is(last && last.length, 3, 'the honest writer was admitted')
})

test('a community root is refused as header-invalid and never stored', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const root = fake.store.get({ name: 'root' })
  await root.ready()
  const group = hex(root.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: group, on: true }))))
  await root.append(b4a.from(JSON.stringify(groupHeader({ kind: 'community', diary: dkey, name: 'Comunidade', join: 'open' }))))
  items.push({ key: group, diary: dkey, length: 1, seq: 1 })
  const m = await groupMember(t, kp, group)
  const { events } = await syncOnce(bootstrap, m)
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === group && ev.reason === 'header-invalid'))
  t.absent(await stored(m, group), 'the root is not stored')
})

test('a held binding diary that learns the join after the gate starts admits the writer', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const w = fake.store.get({ name: 'writer' })
  await w.ready()
  const wkey = hex(w.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
  items.push({ key: wkey, diary: dkey, length: 1, seq: 1 })
  const m = await groupMember(t, kp, group)
  // The member holds the diary at its certificate only.
  await copyInto(fake.store, m, [d])
  setTimeout(() => {
    d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: wkey, on: true })))).catch(() => {})
  }, 1500)
  const { result, events } = await syncOnce(bootstrap, m)
  t.ok(result.ok, result.errors.join('; '))
  t.absent(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey), 'not judged on the stale length')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey))
})

test('a writer evicted by an earlier proven join is still purged when its diary forks', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const all = []
  // The page that lists the earlier join (and so evicts the last writer) is
  // held back until the last writer was downloaded, so the eviction can
  // never overtake that download however slow the member is.
  let lastHeld = false
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q, n) => {
      const items = n === 0 || !lastHeld ? all.slice(1) : all.slice()
      items.sort((x, y) => x.key < y.key ? -1 : 1)
      return { items, next: null, incomplete: false }
    }
  })
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  for (let i = 0; i <= CAP; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    all.push({ key: hex(w.key), diary: dkey, length: 1, seq: i + 1 })
  }
  const last = all[all.length - 1].key
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d])
  let forked = false
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (!lastHeld) lastHeld = evs.some((ev) => ev.event === 'group-downloaded' && ev.key === last)
    if (!forked && evs.some((ev) => ev.event === 'group-skipped' && ev.key === last && ev.reason === 'quota')) {
      forked = true
      d.truncate(1, { fork: 1 }).then(() => d.append(b4a.from(JSON.stringify({ type: 'x' })))).catch(() => {})
    }
    return evs.some((ev) => ev.event === 'group-skipped' && ev.key === last && ev.reason === 'fork')
  }, { pageRetryMs: 100, pageRefreshMs: 100 })
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === last), 'it was held before the eviction')
  t.absent(await stored(m, last), 'the evicted writer is purged')
})

test('listings of cores that are no writers never fill the table: an honest writer is still admitted', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const junk = []
  const spam = await fakeSeeder(t, bootstrap, kp, junk)
  // Listed under a diary the spammer serves, whose join seq names none of
  // them: a header stub is never proven, so each is refused at once (#350).
  const sd = spam.store.get({ name: 'junk-diary' })
  await sd.ready()
  const sdkey = hex(sd.key)
  await sd.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: sdkey }, kp)))))
  await sd.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(crypto.randomBytes(32)), on: true }))))
  for (let i = 0; i < 512; i++) {
    const c = spam.store.get({ name: 'junk' + i })
    await c.ready()
    await c.append(b4a.from(JSON.stringify({ type: 'nada', i })))
    junk.push({ key: hex(c.key), diary: sdkey, length: 1, seq: 1 })
  }
  junk.sort((x, y) => x.key < y.key ? -1 : 1)
  const items = []
  await fakeSeeder(t, bootstrap, kp, [], {
    answer: () => new Promise((resolve) => setTimeout(() => resolve({ items, next: null, incomplete: false }), 5000))
  })
  const { dkey, wkey } = await diaryAndWriter(spam.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  // Long-running: the honest listing comes after the junk had its chance to
  // fill the table, and again on every refresh.
  const { result, events } = await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), { pageRetryMs: 100, pageRefreshMs: 100 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.reason === 'header-invalid'), 'the junk was refused')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), 'the honest writer was admitted')
})

test('a join seq past the length learned with block 0 is waited for, not judged', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const w = fake.store.get({ name: 'writer' })
  await w.ready()
  const wkey = hex(w.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
  items.push({ key: wkey, diary: dkey, length: 1, seq: 1 })
  setTimeout(() => {
    d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: wkey, on: true })))).catch(() => {})
  }, 1500)
  const m = await groupMember(t, kp, group)
  const { result, events } = await syncOnce(bootstrap, m)
  t.ok(result.ok, result.errors.join('; '))
  t.absent(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey), 'not judged on the early length')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey))
})

test('a writer listed under a blocked diary is still admitted from an honest listing', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const blockedDiary = hex(crypto.randomBytes(32))
  const mod = crypto.keyPair()
  const snap = createSnapshot({ seq: 1, blocked: [blockedDiary] }, mod, createModeratorCert({ moderator: hex(mod.publicKey) }, kp))
  const bad = []
  const good = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    snapshot: () => snap,
    answer: () => new Promise((resolve) => setTimeout(() => resolve({ items: bad, next: null, incomplete: false }), 1000))
  })
  await fakeSeeder(t, bootstrap, kp, [], {
    answer: () => new Promise((resolve) => setTimeout(() => resolve({ items: good, next: null, incomplete: false }), 2500))
  })
  const { dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  bad.push({ key: wkey, diary: blockedDiary, length: 2, seq: 1 })
  good.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  const { events } = await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), { pageRetryMs: 100, pageRefreshMs: 100 })
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'blocked'), 'the listing under the blocked diary was refused')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), 'the honest listing was admitted')
})

test('long-running: a writer relisted with unservable seqs is gated from another seeder listing once', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let item = null
  // One seeder relists the writer with a fresh seq the diary never wrote on
  // every pass; the other lists it correctly once, then never answers again.
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q, n) => ({ items: [{ ...item, seq: 10 + n }], next: null, incomplete: false })
  })
  await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q, n) => n === 0
      ? new Promise((resolve) => setTimeout(() => resolve({ items: [item], next: null, incomplete: false }), 500))
      : never()
  })
  const { dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  item = { key: wkey, diary: dkey, length: 2, seq: 1 }
  const m = await groupMember(t, kp, group)
  const { events } = await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), { pageRetryMs: 100, pageRefreshMs: 100, gateTimeoutMs: 1000 })
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), 'the honest listing was gated')
})
