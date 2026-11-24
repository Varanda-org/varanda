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
const { runSync, recordBoundRoot, heldCatalogue, MAX_GROUP_HELD_PER_DIARY: CAP } = require('../lib/sync')
const { createCert, createModeratorCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writerHeader, groupHeader, groupPost, groupCreateRecord, groupLeave, leaveDigest, MAX_GROUP_WRITERS_PER_DIARY } = require('../lib/group')
const { memberCertRecord, groupJoinRecord, groupCutRecord, groupConfirmRecord } = require('../lib/records')
const store = require('../lib/store')
const { hex, PARENT, syncOnce, stored, fakeSeeder, diaryAndWriter, copyInto, runUntil, hasBlocklist, groupMember, never, inBackground, joinedRoot, blockDiary, readCerts, revokeIssuer } = require('./helpers/sync-groups')

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
  await w2.append(b4a.from(JSON.stringify(writerHeader({ group, diary: okey, member: PARENT }))))
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
  for (let i = 0; i < CAP + 2; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
  t.ok(active.size <= CAP, 'at most the cap stays active: ' + active.size)
  t.ok(events.some((ev) => ev.event === 'group-skipped' && keys.includes(ev.key) && ev.reason === 'quota'), 'the rest are refused for quota')
})

test('writers a diary cut froze or released are still fetched past its live slots (#350)', async (t) => {
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
  // Two writers more than the live slots, one released and one frozen by
  // the diary's cuts: each may hold a leave the fold reads.
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY + 2; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    keys.push(hex(w.key))
    items.push({ key: hex(w.key), diary: dkey, length: 1, seq: i + 1 })
  }
  await d.append(b4a.from(JSON.stringify(groupCutRecord({ group, writer: keys[0], cut: 0 }))))
  await d.append(b4a.from(JSON.stringify(groupCutRecord({ group, writer: keys[1], cut: 1 }))))
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, cores)
  const { events } = await syncOnce(bootstrap, m)
  t.absent(events.some((ev) => ev.event === 'group-skipped' && keys.includes(ev.key) && ev.reason === 'quota'), 'none refused for the cap')
  for (const k of keys) t.ok(await stored(m, k), 'stored ' + k.slice(0, 8))
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
  for (let i = 0; i <= CAP; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key))
  const late = keys[CAP]
  for (let i = 0; i < CAP; i++) items.push({ key: keys[i], diary: dkey, length: 1, seq: i + 1 })
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  const m = await groupMember(t, kp, group)
  // The quota leaves room for the diary (its cert and CAP + 1 joins).
  const quota = CAP + 4
  const opts = { maxLogBlocks: quota, pageRetryMs: 100, pageRefreshMs: 300 }
  const decided = (evs) => evs.some((ev) => ev.key === late && (ev.event === 'group-skipped' || ev.event === 'group-downloaded'))
  let phase = 0
  const { events } = await runUntil(m, bootstrap, (evs) => {
    const has = (ev, k) => ev.key === k
    if (phase === 0 && keys.slice(0, CAP).every((k) => evs.some((ev) => ev.event === 'group-downloaded' && has(ev, k)))) {
      phase = 1
      // Every held writer grows past the log quota and stops (blocks kept).
      inBackground(async () => {
        for (const w of writers.slice(0, CAP)) {
          for (let i = 0; i < quota; i++) await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' + i }))))
        }
      })
    }
    if (phase === 1 && keys.slice(0, CAP).every((k) => evs.some((ev) => ev.event === 'group-skipped' && ev.reason === 'quota' && has(ev, k)))) {
      phase = 2
      items.push({ key: late, diary: dkey, length: 1, seq: CAP + 1 })
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
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
  const n = CAP + 2
  for (let i = 0; i < n; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
  t.is(await storedCount(), CAP, 'stored writers of the diary stay at the cap')
  // After a restart every stored writer counts the others on disk, and the
  // later joiners are refused against their proven joins.
  const r2 = await runUntil(m, bootstrap, (evs) => skipped(evs, keys[n - 1]) && skipped(evs, keys[n - 2]), { pageRetryMs: 100, pageRefreshMs: 300 })
  t.absent(downloaded(r2.events, keys[n - 1]) || downloaded(r2.events, keys[n - 2]), 'no later joiner comes back after a restart')
  t.is(await storedCount(), CAP, 'still at the cap: ' + (await storedCount()))
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
  const n = CAP + 1
  for (let i = 0; i < n; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
  t.is(await storedCount(), CAP, 'run 1 stores the cap')
  t.absent(await stored(m, keys[0]), 'without the earliest joiner')
  // Run 2: the earliest joiner is listed too.
  list(0)
  const r2 = await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.key === keys[0] && (ev.event === 'group-downloaded' || ev.event === 'group-skipped')), opts)
  t.ok(downloaded(r2.events, keys[0]), 'the earliest joiner is admitted')
  t.ok(r2.events.some((ev) => ev.event === 'group-skipped' && ev.key === keys[n - 1] && ev.reason === 'quota'), 'the latest joiner gives way')
  t.ok(await stored(m, keys[0]), 'the earliest joiner is stored')
  t.absent(await stored(m, keys[n - 1]), 'the latest joiner is purged')
  t.is(await storedCount(), CAP, 'the stored count stays at the cap')
})

test('a writer still opening on the last slot gives it to an earlier proven join, not the next latest holder', async (t) => {
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
  const n = CAP + 1
  for (let i = 0; i < n; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key)) // keys[i] joined at seq i + 1
  const list = (i) => {
    items.push({ key: keys[i], diary: dkey, length: 1, seq: i + 1 })
    items.sort((x, y) => x.key < y.key ? -1 : 1)
  }
  const m = await groupMember(t, kp, group)
  const downloaded = (evs, k) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === k)
  const skipped = (evs, k) => evs.some((ev) => ev.event === 'group-skipped' && ev.key === k && ev.reason === 'quota')
  const storedCount = async () => {
    let count = 0
    for (const k of keys) if (await stored(m, k)) count++
    return count
  }
  const opts = { pageRetryMs: 100, pageRefreshMs: 300 }
  // Run 1 stores every writer but the earliest and the latest joiner.
  for (let i = 1; i < n - 1; i++) list(i)
  await runUntil(m, bootstrap, (evs) => keys.slice(1, n - 1).every((k) => downloaded(evs, k)), opts)
  t.is(await storedCount(), CAP - 1, 'run 1 leaves one slot')
  // Run 2: the latest joiner takes the last slot and is held while its core
  // opens; the earliest joiner is listed only then.
  let opening = false
  let release = null
  const released = new Promise((resolve) => { release = resolve })
  t.teardown(() => release())
  const openHook = async (key) => {
    if (key !== keys[n - 1] || opening) return
    opening = true
    list(0)
    await released
  }
  list(n - 1)
  const r2 = await runUntil(m, bootstrap, (evs) => {
    if (downloaded(evs, keys[0])) release()
    return downloaded(evs, keys[n - 1]) || skipped(evs, keys[n - 1])
  }, { ...opts, openHook })
  t.ok(opening, 'the latest joiner was held while it opened')
  t.ok(downloaded(r2.events, keys[0]), 'the earliest joiner is admitted')
  t.ok(skipped(r2.events, keys[n - 1]), 'the latest joiner gives way once opened')
  t.absent(downloaded(r2.events, keys[n - 1]), 'and never activates')
  t.ok(await stored(m, keys[n - 2]), 'the next latest joiner keeps its slot')
  t.absent(await stored(m, keys[n - 1]), 'the latest joiner holds nothing')
  t.is(await storedCount(), CAP, 'the stored count stays at the cap')
})

test('a gate whose join read another gate overtook still sees every join before the cap evicts', async (t) => {
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
  const n = CAP + 1
  for (let i = 0; i < n; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key)) // keys[i] joined at seq i + 1
  const list = (i) => {
    items.push({ key: keys[i], diary: dkey, length: 1, seq: i + 1 })
    items.sort((x, y) => x.key < y.key ? -1 : 1)
  }
  const m = await groupMember(t, kp, group)
  const downloaded = (evs, k) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === k)
  const skipped = (evs, k) => evs.some((ev) => ev.event === 'group-skipped' && ev.key === k)
  const storedCount = async () => {
    let count = 0
    for (const k of keys) if (await stored(m, k)) count++
    return count
  }
  const opts = { pageRetryMs: 100, pageRefreshMs: 300 }
  // Run 1 stores every writer but the earliest joiner.
  for (let i = 1; i < n; i++) list(i)
  await runUntil(m, bootstrap, (evs) => keys.slice(1).every((k) => downloaded(evs, k)), opts)
  t.is(await storedCount(), CAP, 'run 1 stores the cap')
  // Run 2 lists only the earliest and the latest joiner, so only their gates
  // read the binding diary's joins, from one core: the diary is followed.
  // The earliest joiner's read stops at its first block until the latest
  // joiner's read is three blocks past it, and the latest joiner's read then
  // stops until the earliest joiner is decided. Reads that take turns never
  // meet here: each wait gives up.
  await copyInto(fake.store, m, [d])
  store.writeFollows(m.dataDir, [dkey])
  items.length = 0
  list(0)
  list(n - 1)
  const within = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))])
  let aSeq = null
  let aHeld = null
  const aHolding = new Promise((resolve) => { aHeld = resolve })
  let bAhead = null
  const bPast = new Promise((resolve) => { bAhead = resolve })
  let release = null
  const released = new Promise((resolve) => { release = resolve })
  t.teardown(() => release())
  let bWaited = false
  let bHeld = false
  const joinsHook = async (key, seq) => {
    if (key === keys[0] && aSeq === null) {
      aSeq = seq
      aHeld()
      await within(bPast, 5000)
    } else if (key === keys[n - 1]) {
      if (!bWaited) {
        bWaited = true
        if (aSeq === null) await within(aHolding, 5000)
      } else if (aSeq !== null && !bHeld && seq >= aSeq + 3) {
        bHeld = true
        bAhead()
        await within(released, 5000)
      }
    }
  }
  // Once the earliest joiner is decided, the latest one has 3 s to give way.
  let decided = null
  const r2 = await runUntil(m, bootstrap, (evs) => {
    if (decided === null && (downloaded(evs, keys[0]) || skipped(evs, keys[0]))) {
      decided = Date.now()
      release()
    }
    return decided !== null && (skipped(evs, keys[n - 1]) || Date.now() - decided > 3000)
  }, { ...opts, joinsHook })
  t.ok(bWaited || aSeq !== null, 'a gate read the joins')
  t.ok(downloaded(r2.events, keys[0]), 'the earliest joiner is admitted')
  t.ok(r2.events.some((ev) => ev.event === 'group-skipped' && ev.key === keys[n - 1] && ev.reason === 'quota'), 'the latest joiner gives way')
  t.ok(await stored(m, keys[1]), 'the next earliest joiner keeps its slot')
  t.absent(await stored(m, keys[n - 1]), 'the latest joiner is purged')
  t.is(await storedCount(), CAP, 'the stored count stays at the cap')
})

test('a gate about to evict waits for the joins its stored binding diary still lacks', async (t) => {
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
  const n = CAP + 1
  for (let i = 0; i < n; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key)) // keys[i] joined at seq i + 1
  const m = await groupMember(t, kp, group)
  // Every writer but the earliest joiner is stored before the run, with a
  // replica of the binding diary an earlier run cut short: block 0 and the
  // earliest join only.
  await copyInto(fake.store, m, [d, ...writers.slice(1)], { only: (core) => core === d ? [0, 1] : null })
  items.push({ key: keys[0], diary: dkey, length: 1, seq: 1 })
  const downloaded = (evs, k) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === k)
  const skipped = (evs, k) => evs.some((ev) => ev.event === 'group-skipped' && ev.key === k && ev.reason === 'quota')
  const storedCount = async () => {
    let count = 0
    for (const k of keys) if (await stored(m, k)) count++
    return count
  }
  t.is(await storedCount(), CAP, 'the cap is stored before the run')
  let decided = null
  const r = await runUntil(m, bootstrap, (evs) => {
    if (decided === null && (downloaded(evs, keys[0]) || skipped(evs, keys[0]))) decided = Date.now()
    return decided !== null && (skipped(evs, keys[n - 1]) || Date.now() - decided > 3000)
  }, { pageRetryMs: 100, pageRefreshMs: 300 })
  // Without the wait, the joins stop at block 2 and no holder's join is
  // proven: the earliest joiner is refused instead.
  t.ok(downloaded(r.events, keys[0]), 'the earliest joiner is admitted')
  t.ok(skipped(r.events, keys[n - 1]), 'the latest joiner gives way')
  t.ok(await stored(m, keys[n - 2]), 'the next latest joiner keeps its slot')
  t.absent(await stored(m, keys[n - 1]), 'the latest joiner is purged')
  t.is(await storedCount(), CAP, 'the stored count stays at the cap')
})

test('a gate about to evict reads the joins another gate fetched after its first read', async (t) => {
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
  const n = CAP + 1
  for (let i = 0; i < n; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key)) // keys[i] joined at seq i + 1
  const m = await groupMember(t, kp, group)
  // Every writer but the earliest joiner is stored, with a replica of the
  // binding diary that lacks only the latest join. The run lists the
  // earliest and the latest joiner.
  await copyInto(fake.store, m, [d, ...writers.slice(1)], { only: (core) => core === d ? Array.from({ length: n }, (_, i) => i) : null })
  for (const i of [0, n - 1]) items.push({ key: keys[i], diary: dkey, length: 1, seq: i + 1 })
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  const downloaded = (evs, k) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === k)
  const skipped = (evs, k) => evs.some((ev) => ev.event === 'group-skipped' && ev.key === k && ev.reason === 'quota')
  const storedCount = async () => {
    let count = 0
    for (const k of keys) if (await stored(m, k)) count++
    return count
  }
  t.is(await storedCount(), CAP, 'the cap is stored before the run')
  // The latest joiner's gate fetches its join only once the earliest
  // joiner's read of the joins began, and that read ends only once the join
  // is fetched: the join arrives after the read stopped short of it. The
  // latest joiner then waits, still gating, until the earliest is decided.
  const within = (p, ms) => Promise.race([p.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))])
  let aReading = null
  const aRead = new Promise((resolve) => { aReading = resolve })
  let bFetching = null
  const bFetched = new Promise((resolve) => { bFetching = resolve })
  let release = null
  const released = new Promise((resolve) => { release = resolve })
  t.teardown(() => release())
  let bWaited = null
  let aWaited = null
  const openHook = async (key) => {
    if (key === dkey && bWaited === null) bWaited = await within(aRead, 10000)
  }
  const joinsHook = async (key, seq) => {
    if (key === keys[0]) {
      aReading()
      if (seq === n - 1 && aWaited === null) aWaited = await within(bFetched, 10000)
    } else if (key === keys[n - 1]) {
      bFetching()
      await within(released, 10000)
    }
  }
  let decided = null
  const r = await runUntil(m, bootstrap, (evs) => {
    if (decided === null && (downloaded(evs, keys[0]) || skipped(evs, keys[0]))) {
      decided = Date.now()
      release()
    }
    return decided !== null && (skipped(evs, keys[n - 1]) || Date.now() - decided > 3000)
  }, { pageRetryMs: 100, pageRefreshMs: 300, openHook, joinsHook })
  t.ok(bWaited && aWaited, 'the latest join arrived while the earliest joiner read the joins before it')
  t.ok(downloaded(r.events, keys[0]), 'the earliest joiner is admitted')
  t.ok(skipped(r.events, keys[n - 1]), 'the latest joiner gives way')
  t.ok(await stored(m, keys[n - 2]), 'the next latest joiner keeps its slot')
  t.absent(await stored(m, keys[n - 1]), 'the latest joiner is purged')
  t.is(await storedCount(), CAP, 'the stored count stays at the cap')
})

test('an evicted active holder still purging no longer holds its slot on disk', async (t) => {
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
  const n = CAP + 2
  for (let i = 0; i < n; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    writers.push(w)
  }
  const keys = writers.map((w) => hex(w.key)) // keys[i] joined at seq i + 1
  const list = (i) => {
    items.push({ key: keys[i], diary: dkey, length: 1, seq: i + 1 })
    items.sort((x, y) => x.key < y.key ? -1 : 1)
  }
  const m = await groupMember(t, kp, group)
  const downloaded = (evs, k) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === k)
  const skipped = (evs, k) => evs.some((ev) => ev.event === 'group-skipped' && ev.key === k && ev.reason === 'quota')
  const storedCount = async () => {
    let count = 0
    for (const k of keys) if (await stored(m, k)) count++
    return count
  }
  const opts = { pageRetryMs: 100, pageRefreshMs: 300 }
  // Run 1 stores the cap of latest joiners.
  for (let i = 2; i < n; i++) list(i)
  await runUntil(m, bootstrap, (evs) => keys.slice(2).every((k) => downloaded(evs, k)), opts)
  t.is(await storedCount(), CAP, 'run 1 stores the cap')
  // Run 2: the latest joiner is active, the earliest evicts it and its purge
  // is held while the second earliest is gated.
  items.length = 0
  list(n - 1)
  let release = null
  const released = new Promise((resolve) => { release = resolve })
  t.teardown(() => release())
  let purging = false
  const purgeHook = async (key, s) => {
    if (key === keys[n - 1] && !purging) {
      purging = true
      await released
    }
    await store.purgeReplica(s, key)
  }
  let step = 0
  let at = 0
  const r2 = await runUntil(m, bootstrap, (evs) => {
    if (step === 0 && downloaded(evs, keys[n - 1])) {
      step = 1
      list(0)
    }
    if (step === 1 && downloaded(evs, keys[0]) && purging) {
      step = 2
      list(1)
    }
    if (step === 2 && (downloaded(evs, keys[1]) || skipped(evs, keys[1]))) {
      step = 3
      at = Date.now()
      release()
    }
    return step === 3 && Date.now() - at > 3000
  }, { ...opts, purgeHook })
  // Without the fix the purging holder counts again as held: the second
  // earliest takes its slot a second time and nobody else gives way.
  t.ok(skipped(r2.events, keys[n - 1]), 'the latest joiner gives way')
  t.ok(downloaded(r2.events, keys[1]), 'the second earliest joiner is admitted')
  t.ok(skipped(r2.events, keys[n - 2]), 'the next latest joiner gives way to it')
  t.is(await storedCount(), CAP, 'the stored count stays at the cap')
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
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, at: '2026-01-02T00:00:00.000Z', member: PARENT }))))
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
  await quiet.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
  await root.append(b4a.from(JSON.stringify(groupHeader({ community: PARENT, member: PARENT, diary: blockedDiary, name: 'Alheio', join: 'open' }))))
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
        await w2.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
  await root.append(b4a.from(JSON.stringify(groupHeader({ community: PARENT, member: PARENT, diary: ckey, name: 'Bloqueado', join: 'open' }))))
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
  await root.append(b4a.from(JSON.stringify(groupHeader({ community: PARENT, member: PARENT, diary: dkey, name: 'Bifurcado', join: 'open' }))))
  await w.append(b4a.from(JSON.stringify(writerHeader({ group: rkey, diary: dkey, member: PARENT }))))
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
  await root.append(b4a.from(JSON.stringify(groupHeader({ community: PARENT, member: PARENT, diary: ckey, name: 'Parcial', join: 'open' }))))
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

test('the catalogue fold reads the diaries\' cuts, like the group fold: a creator CW a cut let in bounds the root\'s creates (#350)', (t) => {
  const kp = generateAssociationKeyPair()
  const key = () => hex(crypto.randomBytes(32))
  const community = key()
  const creator = key()
  const geral = key()
  const later = key()
  const log = (k, header) => ({ key: k, diary: creator, entries: [{ seq: 0, record: header }] })
  const push = (l, record) => l.entries.push({ seq: l.entries.length, record })
  const root = log(community, groupHeader({ kind: 'community', diary: creator, join: 'open', name: 'Bairro' }))
  push(root, groupCreateRecord({ group: geral }))
  const geralLength = root.entries.length
  push(root, groupCreateRecord({ group: later }))
  // The root takes one of the creator's live slots: seven CWs fill the rest,
  // a cut at 0 releases the first and the eighth takes its place. The eighth
  // leaves, listing the root before the second create, and the diary
  // confirms it.
  const cws = Array.from({ length: MAX_GROUP_WRITERS_PER_DIARY }, () => log(key(), writerHeader({ group: community, diary: creator })))
  const eighth = cws[cws.length - 1]
  const leave = groupLeave({ cuts: [{ writer: community, seq: geralLength }, { writer: eighth.key, seq: 1 }] })
  push(eighth, leave)
  const diary = (cut) => {
    const d = { key: creator, entries: [{ seq: 0, record: memberCertRecord(createCert({ member: creator }, kp)) }] }
    push(d, groupJoinRecord({ group: community, writer: community, on: true }))
    for (const cw of cws.slice(0, -1)) push(d, groupJoinRecord({ group: community, writer: cw.key, on: true }))
    if (cut) push(d, groupCutRecord({ group: community, writer: cws[0].key, cut: 0 }))
    push(d, groupJoinRecord({ group: community, writer: eighth.key, on: true }))
    push(d, groupConfirmRecord({ group: community, writer: eighth.key, seq: 1, digest: leaveDigest(leave) }))
    push(d, groupJoinRecord({ group: community, writer: eighth.key, on: false }))
    return new Map([[creator, d.entries]])
  }
  t.alike(heldCatalogue(community, root, cws, diary(true)), [geral], 'the cut lets the eighth in: its confirmed leave bounds the root, so the later create does not count')
  // The fold lists the groups sorted by key, and the keys are random.
  t.alike([...heldCatalogue(community, root, cws, diary(false))].sort(), [geral, later].sort(), 'with no cut the eighth is over the cap and bounds nothing')
})
