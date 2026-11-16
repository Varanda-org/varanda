'use strict'

// Member sync of group cores, continued from sync-groups.test.js (split to keep each
// file under the runner's per-file time limit): goals, per-diary caps and wrong hints.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, localSwarmOptions } = require('./helpers/net')
const { runSync } = require('../lib/sync')
const { createCert, generateAssociationKeyPair } = require('../lib/cert')
const { writerHeader, groupPost, MAX_GROUP_WRITERS_PER_DIARY } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const { hex, PARENT, syncOnce, stored, fakeSeeder, diaryAndWriter, copyInto, runUntil, groupMember } = require('./helpers/sync-groups')

test('an admitted writer keeps its goal after the seeder that listed it leaves', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  // Advertised at 4, but only block 0 is ever served.
  const { dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 0)
  items.push({ key: wkey, diary: dkey, length: 4, seq: 1 })
  const m = await groupMember(t, kp, group)
  let left = false
  const result = await runSync({
    dataDir: m.dataDir,
    ...localSwarmOptions(bootstrap),
    once: true,
    timeoutMs: 12000,
    onEvent: (ev) => {
      if (!left && ev.event === 'group-downloaded' && ev.key === wkey) {
        left = true
        // Another seeder that lists nothing and holds nothing takes over.
        fake.swarm.destroy().then(() => fakeSeeder(t, bootstrap, kp, [])).catch(() => {})
      }
    }
  })
  t.ok(left, 'the listing seeder left after the writer was admitted')
  t.absent(result.ok, 'not done while the writer is below its advertised length')
  t.ok(result.errors.join(' ').includes(wkey + ':1/4'), result.errors.join('; '))
})

test('a writer that got no blocks by the deadline keeps the once run from succeeding', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  // The gate passed through the quarantine; the only seeder holding the
  // writer leaves before the main store gets a block, and an empty one
  // takes over.
  const openHook = async (key) => {
    if (key !== wkey) return
    await fake.swarm.destroy()
    await fakeSeeder(t, bootstrap, kp, [])
  }
  const { result } = await syncOnce(bootstrap, m, { timeoutMs: 8000, openHook })
  t.absent(result.ok, 'not ok while the writer holds nothing')
  t.ok(result.errors.join(' ').includes(wkey + ':0/2'), result.errors.join('; '))
  t.absent(await stored(m, wkey), 'the empty replica is discarded')
})

test('a stored writer that forks while its binding diary is read is not activated', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { w, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [w])
  const openHook = async (key) => {
    if (key !== dkey) return
    await w.truncate(1, { fork: 1 })
    await w.append(b4a.from(JSON.stringify(groupPost({ text: 'reescrito' }))))
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  const { events } = await runUntil(m, bootstrap, (evs) => evs.some((ev) => (ev.event === 'group-skipped' || ev.event === 'group-downloaded') && ev.key === wkey), { openHook })
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'fork'), 'skipped as forked')
  t.absent(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), 'never activated')
  t.absent(await stored(m, wkey), 'the forked replica is purged')
})

test('a stored writer whose binding diary diverges while it is gated is purged, never taken as a wrong hint', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { w, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [w])
  let inspect = null
  // The divergence lands while the entry is gating, so divergeDiary and its
  // sweep of stored writers both leave it to the gate.
  const openHook = async (key) => {
    if (key !== dkey) return
    inspect.divergeDiary(dkey)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const { events } = await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey), { openHook, inspectHook: (i) => { inspect = i } })
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'not-in-log'), 'skipped for the divergence')
  t.absent(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), 'never activated')
  t.absent(await stored(m, wkey), 'the stored writer is purged')
})

test('one diary listed with many writers: targets and gates stay within the per-diary cap', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const diary = hex(crypto.randomBytes(32))
  const items = []
  for (let i = 0; i < 30; i++) items.push({ key: hex(crypto.randomBytes(32)), diary, length: 1, seq: i + 1 })
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  await fakeSeeder(t, bootstrap, kp, items)
  const m = await groupMember(t, kp, group)
  let inspect = null
  let most = 0
  const events = []
  const { result } = await syncOnce(bootstrap, m, {
    gateTimeoutMs: 1500,
    inspectHook: (i) => { inspect = i },
    onEvent: (ev) => {
      if (inspect) most = Math.max(most, inspect.groupTargetCount())
      events.push(ev)
    }
  })
  t.ok(result.ok, result.errors.join('; '))
  // The held writers plus at most two contenders gated without a slot.
  t.ok(most <= MAX_GROUP_WRITERS_PER_DIARY + 2, 'targets only for admitted writers: ' + most)
})

test('a wrong join seq hint does not hide a writer another seeder lists correctly', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const bad = []
  const good = []
  // One seeder lists a join seq whose block joins another writer; while
  // that gate is held up, another seeder lists the writer correctly.
  const fake = await fakeSeeder(t, bootstrap, kp, bad)
  await fakeSeeder(t, bootstrap, kp, [], {
    answer: () => new Promise((resolve) => setTimeout(() => resolve({ items: good, next: null, incomplete: false }), 300))
  })
  const { d, dkey, w, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 2)
  good.push({ key: wkey, diary: dkey, length: 3, seq: 1 })
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(crypto.randomBytes(32)), on: true }))))
  bad.push({ key: wkey, diary: dkey, length: 3, seq: 2 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d, w])
  let held = false
  const openHook = async (key) => {
    if (key !== dkey || held) return
    held = true
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  const { result, events } = await syncOnce(bootstrap, m, { openHook })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'unbound'), 'the wrong seq disproved the hint')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), 'the correct listing was gated')
})

test('a stored writer takes its diary from its own block 0, not from the hint', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { d, dkey, w, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: hex(crypto.randomBytes(32)), length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d, w])
  const { result, events } = await syncOnce(bootstrap, m)
  t.ok(result.ok, result.errors.join('; '))
  t.absent(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey), 'not skipped')
  t.ok(await stored(m, dkey))
  t.ok(await stored(m, wkey))
})

test('a seeder listing too many wrong hints is no longer paged', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const real = hex(crypto.randomBytes(32))
  for (let i = 0; i < 40; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: real, member: PARENT }))))
    items.push({ key: hex(w.key), diary: hex(crypto.randomBytes(32)), length: 1, seq: 1 })
  }
  // A real writer advertised past what is served keeps the --once run
  // paging for a few seconds.
  const { w, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 0)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  setTimeout(() => { w.append(b4a.from(JSON.stringify(groupPost({ text: 'tarde' })))).catch(() => {}) }, 3500)
  const m = await groupMember(t, kp, group)
  const { events } = await syncOnce(bootstrap, m, { pageRetryMs: 100 })
  t.ok(events.filter((ev) => ev.event === 'group-skipped' && ev.reason === 'wrong-diary').length >= 32)
  t.ok(fake.requests.length < 10, 'paging stopped: ' + fake.requests.length + ' requests')
})

test('long-running: a seeder cut off for wrong hints is paged again after the refresh interval', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const real = hex(crypto.randomBytes(32))
  for (let i = 0; i < 40; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: real, member: PARENT }))))
    items.push({ key: hex(w.key), diary: hex(crypto.randomBytes(32)), length: 1, seq: 1 })
  }
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  const m = await groupMember(t, kp, group)
  let cutAt = 0
  await runUntil(m, bootstrap, (evs) => {
    if (cutAt === 0 && evs.filter((ev) => ev.event === 'group-skipped').length >= 32) cutAt = fake.requests.length
    return cutAt > 0 && fake.requests.length >= cutAt + 2
  }, { pageRetryMs: 100, pageRefreshMs: 1000 })
  t.ok(fake.requests.length >= cutAt + 2, 'paged again after the suspension')
})

test('an advertised length above the log quota fails the item and fetches nothing', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 11, seq: 1 })
  const m = await groupMember(t, kp, group)
  const { result, events } = await syncOnce(bootstrap, m, { maxLogBlocks: 10, timeoutMs: 15000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'quota'))
  t.absent(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey))
  t.absent(await stored(m, wkey), 'nothing fetched')
})

test('an over-quota listing of an active writer leaves it downloading', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let item = null
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q, n) => ({ items: [n === 1 ? { ...item, length: 11 } : item], next: null, incomplete: false })
  })
  const { w, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 0)
  item = { key: wkey, diary: dkey, length: 3, seq: 1 }
  const m = await groupMember(t, kp, group)
  setTimeout(async () => {
    for (let i = 0; i < 2; i++) await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' + i }))))
  }, 2500)
  const { result, events } = await syncOnce(bootstrap, m, { maxLogBlocks: 10, pageRetryMs: 200 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(fake.requests.length >= 2, 'the oversized listing was paged')
  t.absent(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey), 'the held writer is never skipped')
  const last = events.filter((ev) => ev.event === 'group-downloaded' && ev.key === wkey).pop()
  t.is(last && last.length, 3, 'it kept downloading')
})

test('fabricated low-seq writers of a full diary never stop its held writers', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const real = []
  const forged = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q, n) => {
      const items = n === 0 ? real.slice() : real.concat(forged)
      items.sort((x, y) => x.key < y.key ? -1 : 1)
      return { items, next: null, incomplete: false }
    }
  })
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  const writers = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    writers.push(w)
    real.push({ key: hex(w.key), diary: dkey, length: 2, seq: i + 1 })
  }
  for (let i = 0; i < 3; i++) forged.push({ key: hex(crypto.randomBytes(32)), diary: dkey, length: 1, seq: 1 })
  const m = await groupMember(t, kp, group)
  // The diary is held already: eight gates of one diary read it through the
  // main store, never through concurrent quarantine reads. A stored writer
  // naming it is what keeps it at start (an unnamed diary is purged).
  await copyInto(fake.store, m, [d, writers[0]])
  setTimeout(async () => {
    for (const w of writers) await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' }))))
  }, 3000)
  const { result, events } = await syncOnce(bootstrap, m, { pageRetryMs: 200, gateTimeoutMs: 1500 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(fake.requests.length >= 2, 'the forged writers were listed')
  const keys = new Set(real.map((it) => it.key))
  t.absent(events.some((ev) => ev.event === 'group-skipped' && keys.has(ev.key)), 'no held writer was skipped')
  for (const it of real) {
    const last = events.filter((ev) => ev.event === 'group-downloaded' && ev.key === it.key).pop()
    t.is(last && last.length, 2)
  }
})

test('a listing nobody can serve yet does not hide the writer another seeder lists', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  await fakeSeeder(t, bootstrap, kp, [], {
    answer: () => new Promise((resolve) => setTimeout(() => resolve({ items, next: null, incomplete: false }), 300))
  })
  // The writer's block 0 exists only after the first gate timed out.
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const w = fake.store.get({ name: 'writer' })
  await w.ready()
  const wkey = hex(w.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: wkey, on: true }))))
  items.push({ key: wkey, diary: dkey, length: 1, seq: 1 })
  const m = await groupMember(t, kp, group)
  const events = []
  let appended = false
  const onEvent = (ev) => {
    events.push(ev)
    if (appended || ev.event !== 'group-skipped' || ev.key !== wkey || ev.reason !== 'timeout') return
    appended = true
    w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT })))).catch(() => {})
  }
  const { result } = await syncOnce(bootstrap, m, { gateTimeoutMs: 1500, onEvent })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'timeout'), 'the first gate timed out')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), 'the other listing was gated')
})

test('a wrong-group listing under one group never judges the honest listing under another', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const g = hex(crypto.randomBytes(32))
  const h = hex(crypto.randomBytes(32))
  const listed = []
  // The honest seeder lists nothing under h until the member has disproved
  // the wrong listing under g (flagged by the stop condition below), so the
  // order never depends on how fast the member runs.
  let disproved = false
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => ({ items: q.group === g ? listed : [], next: null, incomplete: false })
  })
  await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => ({ items: q.group === h && disproved ? listed : [], next: null, incomplete: false })
  })
  const { dkey, wkey } = await diaryAndWriter(fake.store, h, (key) => createCert({ member: key }, kp), 1)
  listed.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, g, { extra: [h] })
  // Long-running: the honest listing arrives in a later pass, after the
  // wrong one was disproved.
  const { result, events } = await runUntil(m, bootstrap, (evs) => {
    if (!disproved) disproved = evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'wrong-group')
    // The event repeats as the writer grows (block 0, then its post).
    return evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2)
  }, { pageRetryMs: 100, pageRefreshMs: 100 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'wrong-group'), 'the listing under the other group failed')
  const got = events.filter((ev) => ev.event === 'group-downloaded' && ev.key === wkey).pop()
  t.ok(got && got.group === h && got.length === 2, 'admitted under its own group')
})
