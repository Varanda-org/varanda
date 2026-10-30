'use strict'

// Member sync of group cores, continued from sync-groups.test.js (split
// to keep each file under the runner's per-file time limit): the
// per-diary cap across runs, stored writers and roots at a cold start,
// and the bound-roots and group-certs records.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { testnet, until } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { runSync, recordBoundRoot } = require('../lib/sync')
const { createCert, createModeratorCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writerHeader, groupHeader, groupPost, MAX_GROUP_WRITERS_PER_DIARY } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const store = require('../lib/store')
const { hex, syncOnce, stored, fakeSeeder, diaryAndWriter, copyInto, runUntil, hasBlocklist, groupMember, never, inBackground, joinedRoot, blockDiary, readCerts, revokeIssuer } = require('./helpers/sync-groups')

test('--once: two unservable hints from one seeder do not exclude a writer another seeder lists', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let item = null
  let keep = null
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q, n) => ({ items: [{ ...item, seq: 10 + n }, keep].sort((x, y) => x.key < y.key ? -1 : 1), next: null, incomplete: false })
  })
  const good = []
  await fakeSeeder(t, bootstrap, kp, [], {
    answer: () => new Promise((resolve) => setTimeout(() => resolve({ items: good, next: null, incomplete: false }), 2000))
  })
  const { dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  item = { key: wkey, diary: dkey, length: 2, seq: 1 }
  good.push(item)
  // A second writer advertised past what is served keeps the run alive.
  const other = fake.store.get({ name: 'other-diary' })
  await other.ready()
  const okey = hex(other.key)
  const w2 = fake.store.get({ name: 'other-writer' })
  await w2.ready()
  const w2key = hex(w2.key)
  await other.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: okey }, kp)))))
  await other.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: w2key, on: true }))))
  await w2.append(b4a.from(JSON.stringify(writerHeader({ group, diary: okey }))))
  keep = { key: w2key, diary: okey, length: 2, seq: 1 }
  setTimeout(() => { w2.append(b4a.from(JSON.stringify(groupPost({ text: 'tarde' })))).catch(() => {}) }, 4000)
  const m = await groupMember(t, kp, group)
  const { result, events } = await syncOnce(bootstrap, m, { pageRetryMs: 100, gateTimeoutMs: 500 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(events.filter((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'timeout').length >= 2, 'two hints timed out')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), 'the other seeder listing was gated')
})

test('a disproved hint never hands the writer back to the same seeder in the rescan', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let first = null
  let later2 = null
  // The first seeder lists a seq whose block joins another writer, then a
  // seq the diary never wrote; the second lists the writer correctly once.
  const good = []
  await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q, n) => n === 0
      ? new Promise((resolve) => setTimeout(() => resolve({ items: good, next: null, incomplete: false }), 300))
      : never()
  })
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q, n) => ({ items: [n === 0 ? first : later2], next: null, incomplete: false })
  })
  const { d, dkey, w, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(crypto.randomBytes(32)), on: true }))))
  first = { key: wkey, diary: dkey, length: 2, seq: 2 }
  later2 = { key: wkey, diary: dkey, length: 2, seq: 9 }
  good.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d, w])
  let held = false
  const openHook = async (key) => {
    if (key !== dkey || held) return
    held = true
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  // Shorter than the gate timeout: the never-written seq would hold the
  // writer past the deadline.
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 8000, pageRetryMs: 100, openHook })
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'unbound'), 'the first hint was disproved')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), 'the other seeder listing was gated')
})

test('stored writers of one diary listed under other diaries never exceed the per-diary cap', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  const cores = [d]
  const keys = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY + 2; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    cores.push(w)
    keys.push(hex(w.key))
    // Each listed under a diary of its own, so no hinted diary looks full.
    items.push({ key: hex(w.key), diary: hex(crypto.randomBytes(32)), length: 1, seq: i + 1 })
  }
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, cores)
  const { events } = await syncOnce(bootstrap, m)
  // A writer evicted by a later, earlier-joined one was active for a while:
  // what counts is what stays active, not who was ever downloaded.
  const gone = new Set(events.filter((ev) => ev.event === 'group-skipped' && ev.reason === 'quota').map((ev) => ev.key))
  const active = new Set(events.filter((ev) => ev.event === 'group-downloaded' && keys.includes(ev.key) && !gone.has(ev.key)).map((ev) => ev.key))
  t.ok(active.size <= MAX_GROUP_WRITERS_PER_DIARY, 'at most the cap stays active: ' + active.size)
  t.ok(events.some((ev) => ev.event === 'group-skipped' && keys.includes(ev.key) && ev.reason === 'quota'), 'the rest are refused for quota')
})

test('writers kept on disk after a quota stop hold their per-diary slots, in the run and after a restart', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  const writers = []
  for (let i = 0; i <= MAX_GROUP_WRITERS_PER_DIARY; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key))
  const late = keys[MAX_GROUP_WRITERS_PER_DIARY]
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) items.push({ key: keys[i], diary: dkey, length: 1, seq: i + 1 })
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  const m = await groupMember(t, kp, group)
  // The quota leaves room for the diary (cert and nine joins).
  const quota = MAX_GROUP_WRITERS_PER_DIARY + 4
  const opts = { maxLogBlocks: quota, pageRetryMs: 100, pageRefreshMs: 300 }
  const decided = (evs) => evs.some((ev) => ev.key === late && (ev.event === 'group-skipped' || ev.event === 'group-downloaded'))
  let phase = 0
  const { events } = await runUntil(m, bootstrap, (evs) => {
    const has = (ev, k) => ev.key === k
    if (phase === 0 && keys.slice(0, MAX_GROUP_WRITERS_PER_DIARY).every((k) => evs.some((ev) => ev.event === 'group-downloaded' && has(ev, k)))) {
      phase = 1
      // Every held writer grows past the log quota and stops (blocks kept).
      inBackground(async () => {
        for (const w of writers.slice(0, MAX_GROUP_WRITERS_PER_DIARY)) {
          for (let i = 0; i < quota; i++) await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' + i }))))
        }
      })
    }
    if (phase === 1 && keys.slice(0, MAX_GROUP_WRITERS_PER_DIARY).every((k) => evs.some((ev) => ev.event === 'group-skipped' && ev.reason === 'quota' && has(ev, k)))) {
      phase = 2
      items.push({ key: late, diary: dkey, length: 1, seq: MAX_GROUP_WRITERS_PER_DIARY + 1 })
      items.sort((x, y) => x.key < y.key ? -1 : 1)
    }
    return phase === 2 && decided(evs)
  }, opts)
  t.absent(events.some((ev) => ev.event === 'group-downloaded' && ev.key === late), 'no writer past the cap in the same run')
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === late && ev.reason === 'quota'), 'refused for the cap')
  t.absent(await stored(m, late), 'nothing of it is stored')
  const again = await runUntil(m, bootstrap, decided, opts)
  t.absent(again.events.some((ev) => ev.event === 'group-downloaded' && ev.key === late), 'nor after a restart')
  t.absent(await stored(m, late), 'still nothing of it is stored')
})

test('a later writer of a binding diary first gated through the quarantine is gated in the same continuous run', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  const writers = []
  const n = MAX_GROUP_WRITERS_PER_DIARY
  for (let i = 0; i < n; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key))
  const late = keys[n - 1]
  for (let i = 0; i < n - 1; i++) items.push({ key: keys[i], diary: dkey, length: 1, seq: i + 1 })
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  // Nothing of the diary is stored: the first gates read it through the
  // quarantine on the same sockets the main store replicates.
  const m = await groupMember(t, kp, group)
  const downloaded = (evs, k) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === k)
  let listed = false
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (!listed && keys.slice(0, n - 1).every((k) => downloaded(evs, k))) {
      listed = true
      items.push({ key: late, diary: dkey, length: 1, seq: n })
      items.sort((x, y) => x.key < y.key ? -1 : 1)
    }
    return listed && downloaded(evs, late)
  }, { pageRetryMs: 100, pageRefreshMs: 300 })
  t.ok(downloaded(events, late), 'the later writer is gated and downloaded')
  t.ok(await stored(m, dkey), 'the binding diary is stored through the main store')
})

test('writers listed latest join first converge on the earliest joins within the cap, across a restart; a holder stored before the run gives way too', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  const writers = []
  const n = MAX_GROUP_WRITERS_PER_DIARY + 2
  for (let i = 0; i < n; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key)) // keys[i] joined at seq i + 1
  const list = (i) => {
    items.push({ key: keys[i], diary: dkey, length: 1, seq: i + 1 })
    items.sort((x, y) => x.key < y.key ? -1 : 1)
  }
  const m = await groupMember(t, kp, group)
  // The latest joiner is stored before the run.
  await copyInto(fake.store, m, [d, writers[n - 1]])
  for (let i = 2; i < n; i++) list(i)
  const skipped = (evs, k) => evs.some((ev) => ev.event === 'group-skipped' && ev.key === k && ev.reason === 'quota')
  const downloaded = (evs, k) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === k)
  const storedCount = async () => {
    let count = 0
    for (const k of keys) if (await stored(m, k)) count++
    return count
  }
  let step = 0
  const r1 = await runUntil(m, bootstrap, (evs) => {
    if (step === 0 && keys.slice(2).every((k) => downloaded(evs, k))) {
      step = 1
      list(1)
    }
    if (step === 1 && downloaded(evs, keys[1])) {
      step = 2
      list(0)
    }
    return step === 2 && downloaded(evs, keys[0])
  }, { pageRetryMs: 100, pageRefreshMs: 300 })
  // Each earlier proven join takes the slot of the latest one, even from
  // the holder stored before the run, whose blocks go.
  t.ok(skipped(r1.events, keys[n - 1]), 'the holder stored before the run gives way')
  t.ok(skipped(r1.events, keys[n - 2]), 'and so does the next latest joiner')
  t.absent(await stored(m, keys[n - 1]), 'its blocks are purged')
  t.absent(await stored(m, keys[n - 2]), 'and so are the other evicted holder\'s')
  t.is(await storedCount(), MAX_GROUP_WRITERS_PER_DIARY, 'stored writers of the diary stay at the cap')
  // After a restart every stored writer counts the others on disk, and the
  // later joiners are refused against their proven joins.
  const r2 = await runUntil(m, bootstrap, (evs) => skipped(evs, keys[n - 1]) && skipped(evs, keys[n - 2]), { pageRetryMs: 100, pageRefreshMs: 300 })
  t.absent(downloaded(r2.events, keys[n - 1]) || downloaded(r2.events, keys[n - 2]), 'no later joiner comes back after a restart')
  t.is(await storedCount(), MAX_GROUP_WRITERS_PER_DIARY, 'still at the cap: ' + (await storedCount()))
})

test('a writer stored in an earlier run gives its slot to an earlier proven join listed later', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  const writers = []
  const n = MAX_GROUP_WRITERS_PER_DIARY + 1
  for (let i = 0; i < n; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key)) // keys[i] joined at seq i + 1
  const list = (i) => {
    items.push({ key: keys[i], diary: dkey, length: 1, seq: i + 1 })
    items.sort((x, y) => x.key < y.key ? -1 : 1)
  }
  const m = await groupMember(t, kp, group)
  const downloaded = (evs, k) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === k)
  const storedCount = async () => {
    let count = 0
    for (const k of keys) if (await stored(m, k)) count++
    return count
  }
  const opts = { pageRetryMs: 100, pageRefreshMs: 300 }
  // Run 1: the seeder lists every writer but the earliest joiner.
  for (let i = 1; i < n; i++) list(i)
  await runUntil(m, bootstrap, (evs) => keys.slice(1).every((k) => downloaded(evs, k)), opts)
  t.is(await storedCount(), MAX_GROUP_WRITERS_PER_DIARY, 'run 1 stores the cap')
  t.absent(await stored(m, keys[0]), 'without the earliest joiner')
  // Run 2: the earliest joiner is listed too.
  list(0)
  const r2 = await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.key === keys[0] && (ev.event === 'group-downloaded' || ev.event === 'group-skipped')), opts)
  t.ok(downloaded(r2.events, keys[0]), 'the earliest joiner is admitted')
  t.ok(r2.events.some((ev) => ev.event === 'group-skipped' && ev.key === keys[n - 1] && ev.reason === 'quota'), 'the latest joiner gives way')
  t.ok(await stored(m, keys[0]), 'the earliest joiner is stored')
  t.absent(await stored(m, keys[n - 1]), 'the latest joiner is purged')
  t.is(await storedCount(), MAX_GROUP_WRITERS_PER_DIARY, 'the stored count stays at the cap')
})

test('a stored writer listed under the wrong group leaves the table so its own group admits it', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const g = hex(crypto.randomBytes(32))
  const h = hex(crypto.randomBytes(32))
  const listed = []
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => ({ items: q.group === g ? listed : [], next: null, incomplete: false })
  })
  await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => new Promise((resolve) => setTimeout(() => resolve({ items: q.group === h ? listed : [], next: null, incomplete: false }), 1500))
  })
  const { d, dkey, w, wkey } = await diaryAndWriter(fake.store, h, (key) => createCert({ member: key }, kp), 1)
  listed.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, g, { extra: [h] })
  await copyInto(fake.store, m, [d, w])
  const { events } = await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), { pageRetryMs: 100, pageRefreshMs: 100 })
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'wrong-group'), 'refused under the wrong group')
  const got = events.filter((ev) => ev.event === 'group-downloaded' && ev.key === wkey).pop()
  t.is(got && got.group, h, 'admitted under its own group')
  t.ok(await stored(m, wkey), 'its blocks stayed')
})

test('a full gate memory still records a new entry, and entries expire in long-running mode', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const m = await groupMember(t, kp, hex(crypto.randomBytes(32)))
  let inspect = null
  await runUntil(m, bootstrap, () => inspect !== null, { pageRefreshMs: 200, inspectHook: (i) => { inspect = i } })
  const memo = inspect.createMemo(3)
  for (const k of ['a', 'b', 'c']) memo.add(k)
  memo.add('d')
  t.ok(memo.has('d'), 'the newest is recorded')
  t.absent(memo.has('a'), 'the oldest went')
  t.is(memo.size, 3)
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.absent(memo.has('d'), 'expired after pageRefreshMs')
  t.is(memo.size, 0)
})

test('a writer that serves another, over-quota block 0 after its gate is purged as divergent', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { dkey, w, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 0)
  items.push({ key: wkey, diary: dkey, length: 1, seq: 1 })
  const m = await groupMember(t, kp, group)
  // After the quarantine judged a one-block writer, it forks to another
  // block 0 and a history past the quota.
  const openHook = async (key) => {
    if (key !== wkey) return
    await w.truncate(0, { fork: 1 })
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, at: '2026-01-02T00:00:00.000Z' }))))
    for (let i = 0; i < 5; i++) await w.append(b4a.from(JSON.stringify(groupPost({ text: 'x' + i }))))
  }
  const { events } = await syncOnce(bootstrap, m, { maxLogBlocks: 3, openHook, timeoutMs: 15000 })
  t.absent(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'quota'), 'never kept for quota')
  t.absent(await stored(m, wkey), 'the divergent writer is purged')
})

test('hard errors are capped and group writer divergences count as one line', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const m = await groupMember(t, kp, hex(crypto.randomBytes(32)))
  let inspect = null
  const { result } = await runUntil(m, bootstrap, () => {
    if (inspect === null) return false
    for (let i = 0; i < 100; i++) {
      inspect.hardError('erro ' + i)
      inspect.groupDiverged(hex(crypto.randomBytes(32)))
    }
    return true
  }, { inspectHook: (i) => { inspect = i } })
  t.absent(result.ok)
  const counted = result.errors.filter((e) => e.startsWith('bloco 0 divergente em escritores de grupo: 100 ('))
  t.is(counted.length, 1, 'one counted divergence line')
  t.is((counted[0] || '').split(', ').length, 3, 'naming a few keys')
  t.is(result.errors.filter((e) => e.startsWith('erro ')).length, 31, 'the other hard errors are capped')
  t.ok(result.errors.length <= 64, 'bounded: ' + result.errors.length)
})

test('a fork of a binding diary purges a stored writer of that diary that has no entry', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { d, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  // A second writer of the same diary, stored here but never listed.
  const quiet = fake.store.get({ name: 'quiet' })
  await quiet.ready()
  const qkey = hex(quiet.key)
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: qkey, on: true }))))
  await quiet.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [quiet])
  let forked = false
  await runUntil(m, bootstrap, (evs) => {
    if (!forked && evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2)) {
      forked = true
      d.truncate(1, { fork: 1 }).then(() => d.append(b4a.from(JSON.stringify({ type: 'x' })))).catch(() => {})
    }
    return evs.some((ev) => ev.event === 'group-skipped' && ev.key === qkey && ev.reason === 'fork')
  })
  t.absent(await stored(m, qkey), 'the unlisted writer of the forked diary is purged')
})

test('a writer that fails after activation releases its DHT session and leaves the table', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { d, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  let inspect = null
  let before = -1
  await runUntil(m, bootstrap, (evs) => {
    if (before < 0 && evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2)) {
      before = inspect.swarmTopicCount()
      d.truncate(1, { fork: 1 }).then(() => d.append(b4a.from(JSON.stringify({ type: 'x' })))).catch(() => {})
    }
    return before >= 0 && evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey) &&
      inspect.swarmTopicCount() < before && inspect.groupCoreCount() === 0
  }, { inspectHook: (i) => { inspect = i } })
  t.ok(inspect.swarmTopicCount() < before, 'the writer topic was left')
  t.is(inspect.groupCoreCount(), 0, 'the failed writer left the table')
})

test('a stored root whose header names a blocked diary that never bound it stays', async (t) => {
  t.timeout(60000)
  const kp = generateAssociationKeyPair()
  const m = await groupMember(t, kp, hex(crypto.randomBytes(32)))
  const cs = new Corestore(tmpDir(t, 'varanda-groot-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  const other = cs.get({ name: 'other' })
  await other.ready()
  const blockedDiary = hex(other.key)
  await other.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: blockedDiary }, kp)))))
  const root = cs.get({ name: 'root' })
  await root.ready()
  const rkey = hex(root.key)
  await root.append(b4a.from(JSON.stringify(groupHeader({ diary: blockedDiary, name: 'Alheio', join: 'open' }))))
  await copyInto(cs, m, [other, root])
  const mod = crypto.keyPair()
  store.writeBlocklist(m.dataDir, createSnapshot({ seq: 1, blocked: [blockedDiary] }, mod, createModeratorCert({ moderator: hex(mod.publicKey) }, kp)))
  const r = await runSync({ dataDir: m.dataDir, bootstrap: [], signal: AbortSignal.abort(), onEvent: () => {} })
  t.ok(r.ok, r.errors.join('; '))
  t.ok(await stored(m, rkey), 'the root its named diary never bound is kept')
})

test('a binding diary that serves other blocks to the main store than the gate saw is purged with its writers', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { d, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  // After the quarantine judged the diary, it rewrites its history: the
  // join moves and block 1 is something else.
  const openHook = async (key) => {
    if (key !== wkey) return
    await d.truncate(1, { fork: 1 })
    await d.append(b4a.from(JSON.stringify({ type: 'outro' })))
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: wkey, on: true }))))
  }
  const { events } = await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey), { openHook })
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey), 'the writer goes')
  t.absent(await stored(m, wkey), 'the writer is purged')
  t.absent(await stored(m, dkey), 'the diary is purged')
})

test('a writer listed after its binding diary rewrote its history is refused for the rest of the run', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { d, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const w2 = fake.store.get({ name: 'writer2' })
  await w2.ready()
  const w2key = hex(w2.key)
  const m = await groupMember(t, kp, group)
  const openHook = async (key) => {
    if (key !== wkey) return
    await d.truncate(1, { fork: 1 })
    await d.append(b4a.from(JSON.stringify({ type: 'outro' })))
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: wkey, on: true }))))
  }
  let listed = false
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (!listed && evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey)) {
      listed = true
      // The diverged history binds a second writer, listed now.
      inBackground(async () => {
        await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: w2key, on: true }))))
        await w2.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
        await w2.append(b4a.from(JSON.stringify(groupPost({ text: 'depois' }))))
        items.push({ key: w2key, diary: dkey, length: 2, seq: 3 })
        items.sort((x, y) => x.key < y.key ? -1 : 1)
      })
    }
    return evs.some((ev) => ev.key === w2key && (ev.event === 'group-skipped' || ev.event === 'group-downloaded'))
  }, { openHook, pageRefreshMs: 300 })
  t.absent(events.some((ev) => ev.event === 'group-downloaded' && ev.key === w2key), 'the later writer never activates')
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === w2key), 'the later writer is refused')
  t.absent(await stored(m, w2key), 'nothing of it is kept')
})

test('a cold start purges the bound root of a blocked creator before the diary goes', async (t) => {
  t.timeout(60000)
  const kp = generateAssociationKeyPair()
  const cs = new Corestore(tmpDir(t, 'varanda-groot-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  const creator = cs.get({ name: 'creator' })
  await creator.ready()
  const ckey = hex(creator.key)
  const root = cs.get({ name: 'root' })
  await root.ready()
  const rkey = hex(root.key)
  await creator.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: ckey }, kp)))))
  await creator.append(b4a.from(JSON.stringify(groupJoinRecord({ group: rkey, writer: rkey, on: true }))))
  await root.append(b4a.from(JSON.stringify(groupHeader({ diary: ckey, name: 'Bloqueado', join: 'open' }))))
  const m = await groupMember(t, kp, hex(crypto.randomBytes(32)))
  await copyInto(cs, m, [creator, root])
  const mod = crypto.keyPair()
  store.writeBlocklist(m.dataDir, createSnapshot({ seq: 1, blocked: [ckey] }, mod, createModeratorCert({ moderator: hex(mod.publicKey) }, kp)))
  const r = await runSync({ dataDir: m.dataDir, bootstrap: [], signal: AbortSignal.abort(), onEvent: () => {} })
  t.ok(r.ok, r.errors.join('; '))
  t.absent(await stored(m, rkey), 'the root its blocked creator bound is purged')
  t.absent(await stored(m, ckey), 'and so is the blocked diary')
})

test('a cold start with a forked stored diary purges the writer and the root it binds', async (t) => {
  t.timeout(60000)
  const kp = generateAssociationKeyPair()
  const cs = new Corestore(tmpDir(t, 'varanda-gfork-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  const dcore = cs.get({ name: 'diary' })
  await dcore.ready()
  const dkey = hex(dcore.key)
  const root = cs.get({ name: 'root' })
  await root.ready()
  const rkey = hex(root.key)
  const w = cs.get({ name: 'writer' })
  await w.ready()
  const wkey = hex(w.key)
  await dcore.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  await dcore.append(b4a.from(JSON.stringify({ type: 'x' })))
  await dcore.truncate(1, { fork: 1 })
  await dcore.append(b4a.from(JSON.stringify(groupJoinRecord({ group: rkey, writer: rkey, on: true }))))
  await dcore.append(b4a.from(JSON.stringify(groupJoinRecord({ group: rkey, writer: wkey, on: true }))))
  await root.append(b4a.from(JSON.stringify(groupHeader({ diary: dkey, name: 'Bifurcado', join: 'open' }))))
  await w.append(b4a.from(JSON.stringify(writerHeader({ group: rkey, diary: dkey }))))
  const m = await groupMember(t, kp, hex(crypto.randomBytes(32)))
  await copyInto(cs, m, [dcore, root, w])
  const r = await runSync({ dataDir: m.dataDir, bootstrap: [], signal: AbortSignal.abort(), onEvent: () => {} })
  t.ok(r.ok, r.errors.join('; '))
  t.absent(await stored(m, wkey), 'the writer of the forked diary is purged')
  t.absent(await stored(m, rkey), 'the root it bound is purged')
})

test('a writer failed before activation leaves the table', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  let snap = null
  const fake = await fakeSeeder(t, bootstrap, kp, items, { snapshot: () => snap })
  const { dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  const mod = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  const openHook = async (key) => {
    if (key !== wkey) return
    snap = createSnapshot({ seq: 1, blocked: [dkey] }, mod, modCert)
    fake.announce()
    await until(() => hasBlocklist(m), { timeoutMs: 20000, name: 'snapshot adopted' })
  }
  let inspect = null
  await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey) && inspect.groupCoreCount() === 0,
    { openHook, inspectHook: (i) => { inspect = i } })
  t.is(inspect.groupCoreCount(), 0, 'no failed entry stays')
})

test('a joined root naming a blocked diary never seen bound stays when that diary is not held', async (t) => {
  t.timeout(60000)
  const kp = generateAssociationKeyPair()
  const named = hex(crypto.randomBytes(32))
  const { m, rkey } = await joinedRoot(t, kp, named)
  blockDiary(m, kp, named)
  const r = await runSync({ dataDir: m.dataDir, bootstrap: [], signal: AbortSignal.abort(), onEvent: () => {} })
  t.ok(r.ok, r.errors.join('; '))
  t.ok(await stored(m, rkey), 'the community root is kept')
})

test('a joined root recorded as bound goes when its creator is blocked and the creator replica is gone', async (t) => {
  t.timeout(60000)
  const kp = generateAssociationKeyPair()
  const creator = hex(crypto.randomBytes(32))
  const { m, rkey } = await joinedRoot(t, kp, creator)
  recordBoundRoot(m.dataDir, rkey)
  blockDiary(m, kp, creator)
  const r = await runSync({ dataDir: m.dataDir, bootstrap: [], signal: AbortSignal.abort(), onEvent: () => {} })
  t.ok(r.ok, r.errors.join('; '))
  t.absent(await stored(m, rkey), 'the root its blocked creator bound is purged')
})

test('a recorded bound root goes when its blocked creator is stored without the join', async (t) => {
  t.timeout(60000)
  const kp = generateAssociationKeyPair()
  const cs = new Corestore(tmpDir(t, 'varanda-groot-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  // A partial replica of the creator: block 0 only, the join not stored.
  const creator = cs.get({ name: 'creator' })
  await creator.ready()
  const ckey = hex(creator.key)
  await creator.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: ckey }, kp)))))
  const root = cs.get({ name: 'root' })
  await root.ready()
  const rkey = hex(root.key)
  await root.append(b4a.from(JSON.stringify(groupHeader({ diary: ckey, name: 'Parcial', join: 'open' }))))
  const m = await groupMember(t, kp, hex(crypto.randomBytes(32)))
  await copyInto(cs, m, [creator, root])
  recordBoundRoot(m.dataDir, rkey)
  blockDiary(m, kp, ckey)
  const r = await runSync({ dataDir: m.dataDir, bootstrap: [], signal: AbortSignal.abort(), onEvent: () => {} })
  t.ok(r.ok, r.errors.join('; '))
  t.absent(await stored(m, rkey), 'the record still binds the root')
})

test('a corrupt bound-roots record reads as no record and never fails the run', async (t) => {
  t.timeout(60000)
  const kp = generateAssociationKeyPair()
  const named = hex(crypto.randomBytes(32))
  const { m, rkey } = await joinedRoot(t, kp, named)
  fs.writeFileSync(path.join(m.dataDir, 'bound-roots.json'), '{"v":1,"roots":[')
  blockDiary(m, kp, named)
  const r = await runSync({ dataDir: m.dataDir, bootstrap: [], signal: AbortSignal.abort(), onEvent: () => {} })
  t.ok(r.ok, r.errors.join('; '))
  t.ok(await stored(m, rkey), 'the root never seen bound is kept')
})

test('a writer whose binding diary never reached the main store is purged after a restart once its issuer is revoked', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const issuerKp = crypto.keyPair()
  const issuerHex = hex(issuerKp.publicKey)
  const issuerCert = createIssuerCert({ issuer: issuerHex }, kp)
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createIssuedCert({ member: key }, issuerKp, issuerCert), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  const { result } = await syncOnce(bootstrap, m)
  t.ok(result.ok, result.errors.join('; '))
  t.ok(await stored(m, wkey), 'the writer is stored')
  const certs = readCerts(m)
  t.ok(certs && certs.certs.some(([d]) => d === dkey), 'the binding certificate is recorded')
  t.is(fs.statSync(path.join(m.dataDir, 'group-certs.json')).mode & 0o777, 0o600)
  // The seeder withheld the diary from the main store: nothing of it stays.
  const s = await store.openStore(m.dataDir)
  try {
    await store.purgeReplica(s, dkey)
  } finally {
    await s.close()
  }
  t.absent(await stored(m, dkey))
  revokeIssuer(m, kp, issuerHex)
  const events = []
  const r = await runSync({ dataDir: m.dataDir, bootstrap: [], signal: AbortSignal.abort(), onEvent: (ev) => events.push(ev) })
  t.ok(r.ok, r.errors.join('; '))
  t.absent(await stored(m, wkey), 'the writer of the revoked issuer is purged')
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'revoked-issuer'))
  t.absent((readCerts(m) || { certs: [] }).certs.some(([d]) => d === dkey), 'the record goes once no stored writer names the diary')
})

test('a corrupt group-certs record reads as none: a writer without binding evidence stays until an issuer is revoked', async (t) => {
  t.timeout(60000)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const cs = new Corestore(tmpDir(t, 'varanda-gcert-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  const { w, wkey } = await diaryAndWriter(cs, group, (key) => createCert({ member: key }, kp), 1)
  const m = await groupMember(t, kp, group)
  await copyInto(cs, m, [w])
  fs.writeFileSync(path.join(m.dataDir, 'group-certs.json'), '{"v":1,"certs":[')
  const r1 = await runSync({ dataDir: m.dataDir, bootstrap: [], signal: AbortSignal.abort(), onEvent: () => {} })
  t.ok(r1.ok, r1.errors.join('; '))
  t.ok(await stored(m, wkey), 'nothing is revoked: the writer stays')
  // Any revoked issuer, even one unrelated to the writer, makes missing
  // evidence fail closed.
  revokeIssuer(m, kp, hex(crypto.randomBytes(32)))
  const events = []
  const r2 = await runSync({ dataDir: m.dataDir, bootstrap: [], signal: AbortSignal.abort(), onEvent: (ev) => events.push(ev) })
  t.ok(r2.ok, r2.errors.join('; '))
  t.absent(await stored(m, wkey), 'a writer with no binding evidence goes while an issuer is revoked')
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'not-in-log'))
})

// A divergence without a fork id needs two histories signed with one key
// served to the quarantine and the main store: the verdict is called
// through the test hook instead.
test('a diverged binding diary also purges a stored writer it binds that has no entry', async (t) => {
  t.timeout(60000)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const cs = new Corestore(tmpDir(t, 'varanda-gdiv-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  const { d, dkey, w, wkey } = await diaryAndWriter(cs, group, (key) => createCert({ member: key }, kp), 1)
  const m = await groupMember(t, kp, group)
  await copyInto(cs, m, [d, w])
  const events = []
  const ac = new AbortController()
  let inspect = null
  const p = runSync({ dataDir: m.dataDir, bootstrap: [], signal: ac.signal, onEvent: (ev) => events.push(ev), inspectHook: (i) => { inspect = i } })
  await until(() => inspect !== null, { name: 'run started' })
  inspect.divergeDiary(dkey)
  await until(() => events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey), { timeoutMs: 10000, name: 'writer condemned' }).catch(() => {})
  ac.abort()
  const r = await p
  t.absent(await stored(m, wkey), 'the stored writer of the diverged diary is purged')
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'not-in-log'))
  t.absent(await stored(m, dkey), 'and so is the diary')
  t.ok(r, 'the run ends')
})

test('the per-diary cap compares the earliest proven join, not the latest one a seeder lists', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  const early = fake.store.get({ name: 'early' })
  await early.ready()
  const ekey = hex(early.key)
  await early.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: ekey, on: true })))) // seq 1
  const writers = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true })))) // seq i + 2
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key))
  // A later join again: the seeder lists this one, the fold keeps seq 1.
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: ekey, on: true }))))
  const lastSeq = d.length - 1
  keys.forEach((k, i) => items.push({ key: k, diary: dkey, length: 1, seq: i + 2 }))
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d])
  const downloaded = (evs, k) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === k)
  let listed = false
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (!listed && keys.every((k) => downloaded(evs, k))) {
      listed = true
      items.push({ key: ekey, diary: dkey, length: 1, seq: lastSeq })
      items.sort((x, y) => x.key < y.key ? -1 : 1)
    }
    return listed && evs.some((ev) => ev.key === ekey && (ev.event === 'group-downloaded' || ev.event === 'group-skipped'))
  }, { pageRetryMs: 100, pageRefreshMs: 300 })
  t.ok(downloaded(events, ekey), 'the earliest joined writer takes its slot')
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === keys[keys.length - 1] && ev.reason === 'quota'), 'the latest joined holder gives way')
})

test('listings refused for this node\'s own blocklist never cut off the seeder that sent them', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const blockedDiary = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  for (let i = 0; i < 40; i++) items.push({ key: hex(crypto.randomBytes(32)), diary: blockedDiary, length: 1, seq: 1 })
  // A real writer advertised past what is served keeps the --once run
  // paging for a few seconds.
  const { w, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 0)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  setTimeout(() => { w.append(b4a.from(JSON.stringify(groupPost({ text: 'tarde' })))).catch(() => {}) }, 3500)
  const m = await groupMember(t, kp, group)
  const mod = crypto.keyPair()
  store.writeBlocklist(m.dataDir, createSnapshot({ seq: 1, blocked: [blockedDiary] }, mod, createModeratorCert({ moderator: hex(mod.publicKey) }, kp)))
  const logs = []
  const started = Date.now()
  const { result, events } = await syncOnce(bootstrap, m, { pageRetryMs: 100, log: (line) => logs.push(line) })
  // Refused listings are not gated again on every page: the run ends once
  // the honest writer is held, long before the 40 s deadline.
  t.ok(Date.now() - started < 20000, 'the run ends early: ' + (Date.now() - started) + ' ms')
  t.ok(events.filter((ev) => ev.event === 'group-skipped' && ev.reason === 'blocked').length >= 32, 'every listing under the blocked diary is refused')
  t.absent(logs.some((l) => l.includes('listou escritores errados demais')), 'the seeder is never cut off')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), 'its honest listing is admitted')
  t.ok(result.ok, result.errors.join('; '))
})

test('group writer gate timeouts aggregate into one counted soft error naming a few keys', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const junk = []
  for (let i = 0; i < 8; i++) junk.push({ key: hex(crypto.randomBytes(32)), diary: hex(crypto.randomBytes(32)), length: 1, seq: 1 })
  junk.sort((x, y) => x.key < y.key ? -1 : 1)
  await fakeSeeder(t, bootstrap, kp, junk)
  const m = await groupMember(t, kp, group)
  const { result, events } = await syncOnce(bootstrap, m, { pageRetryMs: 100, gateTimeoutMs: 500, timeoutMs: 8000 })
  const timeouts = events.filter((ev) => ev.event === 'group-skipped' && ev.reason === 'timeout').length
  t.ok(timeouts > 3, 'several writers timed out: ' + timeouts)
  t.absent(result.errorsSoft.some((s) => s.startsWith('núcleo de grupo indisponível: ')), 'no line per writer: ' + JSON.stringify(result.errorsSoft))
  const lines = result.errorsSoft.filter((s) => s.startsWith('núcleos de grupo indisponíveis: '))
  t.is(lines.length, 1, JSON.stringify(result.errorsSoft))
  const m1 = /^núcleos de grupo indisponíveis: (\d+) \(([0-9a-f, ]*)\)$/.exec(lines[0] || '')
  t.ok(m1, lines[0])
  t.is(Number(m1 && m1[1]), timeouts, 'the line counts every timeout')
  const sample = m1 ? m1[2].split(', ') : []
  t.is(sample.length, 3, 'at most three keys are named')
  t.ok(sample.every((k) => junk.some((it) => it.key.slice(0, 8) === k)), 'the named keys are listed writers')
  t.ok(result.errorsSoft.length <= 32)
})

test('a join seq past the own diary\'s stored blocks is a timeout, never a disproved hint', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const m = await groupMember(t, kp, group)
  const s = await store.openStore(m.dataDir)
  let own
  try {
    const d = await store.openDiary(s)
    own = hex(d.key)
    await d.append(memberCertRecord(createCert({ member: own }, kp)))
  } finally {
    await s.close()
  }
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const w = fake.store.get({ name: 'writer' })
  await w.ready()
  const wkey = hex(w.key)
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: own }))))
  items.push({ key: wkey, diary: own, length: 1, seq: 1 })
  const { events } = await syncOnce(bootstrap, m, { pageRetryMs: 100, gateTimeoutMs: 1500, timeoutMs: 8000 })
  const skips = events.filter((ev) => ev.event === 'group-skipped' && ev.key === wkey).map((ev) => ev.reason)
  t.ok(skips.length > 0, 'the writer was gated')
  t.ok(skips.every((r) => r === 'timeout'), 'only timeouts: ' + skips.join(', '))
})

test('writer cores of a group stored on disk count toward the group-wide cap: a new key is refused, a stored one is still served', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  const writers = []
  for (let i = 0; i < 3; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key))
  const m = await groupMember(t, kp, group)
  // Two writers kept on disk (as after a quota stop), not listed now.
  await copyInto(fake.store, m, [d, writers[0], writers[1]])
  items.push({ key: keys[2], diary: dkey, length: 1, seq: 3 })
  const opts = { maxGroupWriters: 2, timeoutMs: 15000 }
  const first = await syncOnce(bootstrap, m, opts)
  t.absent(first.events.some((ev) => ev.event === 'group-downloaded' && ev.key === keys[2]), 'the new key is not downloaded')
  t.ok(first.events.some((ev) => ev.event === 'group-skipped' && ev.key === keys[2] && ev.reason === 'quota'), 'refused for the group cap')
  t.absent(await stored(m, keys[2]), 'nothing of it is stored')
  items.push({ key: keys[0], diary: dkey, length: 1, seq: 1 })
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  const again = await syncOnce(bootstrap, m, opts)
  t.ok(again.events.some((ev) => ev.event === 'group-downloaded' && ev.key === keys[0]), 'a stored writer keeps its place')
  t.absent(again.events.some((ev) => ev.event === 'group-downloaded' && ev.key === keys[2]), 'the new key is still refused')
  t.absent(await stored(m, keys[2]), 'still nothing of it is stored')
})

test('the group root is fetched even when stored writers fill the group-wide cap', async (t) => {
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
  await root.append(b4a.from(JSON.stringify(groupHeader({ diary: dkey, name: 'Comunidade', join: 'open' }))))
  const writers = []
  for (let i = 0; i < 2; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    writers.push(w)
  }
  const m = await groupMember(t, kp, group)
  // Both writers kept on disk (as after a quota stop), not listed now.
  await copyInto(fake.store, m, [d, ...writers])
  items.push({ key: group, diary: dkey, length: 1, seq: 1 })
  const { events } = await syncOnce(bootstrap, m, { maxGroupWriters: 2, timeoutMs: 15000 })
  t.absent(events.some((ev) => ev.event === 'group-skipped' && ev.key === group), 'the root is not refused for the group cap')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === group), 'the root is downloaded')
  t.ok(await stored(m, group), 'and stored')
})

test('a writer purged after admission releases a binding diary nothing else names', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { w, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  let inspect = null
  let forked = false
  let held = false
  await runUntil(m, bootstrap, (evs) => {
    if (!forked && evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2)) {
      forked = true
      held = inspect.groupDiaryKeys().includes(dkey)
      w.truncate(1, { fork: 1 }).then(() => w.append(b4a.from(JSON.stringify({ type: 'x' })))).catch(() => {})
    }
    return forked && evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey) &&
      inspect.groupCoreCount() === 0 && !inspect.groupDiaryKeys().includes(dkey)
  }, { inspectHook: (i) => { inspect = i } })
  t.ok(held, 'the binding diary was held while its writer was admitted')
  t.absent(inspect.groupDiaryKeys().includes(dkey), 'the run no longer holds the binding diary')
  t.absent(await stored(m, wkey), 'the forked writer is purged')
  t.absent(await stored(m, dkey), 'the binding diary is purged')
})

test('a binding diary another stored writer names stays after a writer it binds is purged', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { d, w, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  // A second writer of the same diary, stored here but never listed.
  const quiet = fake.store.get({ name: 'quiet' })
  await quiet.ready()
  const qkey = hex(quiet.key)
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: qkey, on: true }))))
  await quiet.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [quiet])
  let inspect = null
  let forked = false
  let settled = 0
  await runUntil(m, bootstrap, (evs) => {
    if (!forked && evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2)) {
      forked = true
      w.truncate(1, { fork: 1 }).then(() => w.append(b4a.from(JSON.stringify({ type: 'x' })))).catch(() => {})
    }
    if (forked && settled === 0 && evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey) && inspect.groupCoreCount() === 0) settled = Date.now()
    // The release check runs after the writer leaves the table.
    return settled > 0 && Date.now() - settled > 1500
  }, { inspectHook: (i) => { inspect = i } })
  t.ok(inspect.groupDiaryKeys().includes(dkey), 'the run still holds the binding diary')
  t.absent(await stored(m, wkey), 'the forked writer is purged')
  t.ok(await stored(m, dkey), 'the binding diary the stored writer names stays')
  t.ok(await stored(m, qkey), 'the stored writer stays')
})

test('a writer gated while its binding diary is released reads the diary after the purge, never a closed session', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { d, w, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  const later = []
  for (const name of ['second', 'third']) {
    const c = fake.store.get({ name })
    await c.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(c.key), on: true }))))
    await c.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    later.push({ key: hex(c.key), diary: dkey, length: 1, seq: d.length - 1 })
  }
  const [second, third] = later
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  let inspect = null
  let forked = false
  let releases = 0
  let releasedAt = 0
  let purgedAt = 0
  let secondGatedAt = 0
  // The release of the diary is held open while the second writer is
  // listed and gated, so its gate starts inside the release window.
  const releaseHook = async (key) => {
    if (key !== dkey || releases++ > 0) return
    items.push(second)
    releasedAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }
  const purgeHook = async (key, s) => {
    await store.purgeReplica(s, key)
    if (key === dkey) purgedAt = Date.now()
  }
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (!forked && evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2)) {
      forked = true
      w.truncate(1, { fork: 1 }).then(() => w.append(b4a.from(JSON.stringify({ type: 'x' })))).catch(() => {})
    }
    if (secondGatedAt === 0 && evs.some((ev) => ev.event === 'group-downloaded' && ev.key === second.key)) {
      secondGatedAt = Date.now()
      items.push(third)
    }
    return evs.some((ev) => (ev.event === 'group-downloaded' || ev.event === 'group-skipped') && ev.key === third.key)
  }, { inspectHook: (i) => { inspect = i }, releaseHook, purgeHook, pageRefreshMs: 300, pageRetryMs: 100 })
  t.ok(releasedAt > 0 && purgedAt > releasedAt, 'the diary was released and purged')
  t.ok(secondGatedAt > purgedAt, 'the writer listed during the release is gated after the purge settled')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === third.key), 'a later writer of the diary is gated')
  t.absent(events.some((ev) => ev.event === 'group-skipped' && (ev.key === second.key || ev.key === third.key)), 'neither later writer is skipped')
  t.ok(inspect.groupDiaryKeys().includes(dkey), 'the run holds the diary again')
  t.ok(await stored(m, dkey), 'the diary is stored again')
})
