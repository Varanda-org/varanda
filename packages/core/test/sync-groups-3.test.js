'use strict'

// Member sync of group cores, continued from sync-groups-2.test.js (split
// to keep each file under the runner's per-file time limit): the
// per-diary cap by earliest join, gate timeouts, the group-wide cap and the
// release of binding diaries.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { runSync, MAX_GROUP_HELD_PER_DIARY: CAP } = require('../lib/sync')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writerHeader, groupHeader, groupPost, groupCutHistory } = require('../lib/group')
const { memberCertRecord, groupJoinRecord, groupConfirmRecord, groupCutRecord, postRecord, deleteRecord } = require('../lib/records')
const store = require('../lib/store')
const { hex, PARENT, syncOnce, stored, fakeSeeder, diaryAndWriter, copyInto, runUntil, groupMember } = require('./helpers/sync-groups')

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
  await early.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: ekey, on: true })))) // seq 1
  const writers = []
  for (let i = 0; i < CAP; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true })))) // seq i + 2
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: own, member: PARENT }))))
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
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
  await root.append(b4a.from(JSON.stringify(groupHeader({ community: PARENT, member: PARENT, diary: dkey, name: 'Comunidade', join: 'open' }))))
  const writers = []
  for (let i = 0; i < 2; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
  await quiet.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
    await c.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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

// A diary whose author deleted its post at seq 1 (tombstone at seq 2)
// before joining the group with two writers (joins at seq 3 and 4), both
// listed. `cleared` makes the fake seeder drop block 1 as an honest peer
// does; otherwise it is a stale peer still serving it.
async function deletedBinding (t, bootstrap, kp, group, { cleared }) {
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const ws = []
  for (const name of ['w1', 'w2']) {
    const w = fake.store.get({ name })
    await w.ready()
    ws.push(w)
  }
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  await d.append(b4a.from(JSON.stringify(postRecord({ text: 'apagado' }))))
  await d.append(b4a.from(JSON.stringify(deleteRecord({ seq: 1 }))))
  for (const w of ws) await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
  for (const w of ws) {
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' }))))
  }
  if (cleared) await d.clear(1)
  items.push(...ws.map((w, i) => ({ key: hex(w.key), diary: dkey, length: 2, seq: 3 + i })).sort((a, b) => a.key < b.key ? -1 : 1))
  return { dkey, wkeys: ws.map((w) => hex(w.key)), fake, d, ws }
}

async function holdsBlock (ctx, key, seq) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = s.get({ key: b4a.from(key, 'hex'), writable: false })
    await core.ready()
    return await core.has(seq)
  } finally {
    await s.close()
  }
}

async function storedLength (ctx, key) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = s.get({ key: b4a.from(key, 'hex'), writable: false })
    await core.ready()
    return core.contiguousLength
  } finally {
    await s.close()
  }
}

test('a binding diary with a deleted post nobody serves completes its goal and its later joins are seen', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const { dkey, wkeys } = await deletedBinding(t, bootstrap, kp, group, { cleared: true })
  const m = await groupMember(t, kp, group)
  const { result, events } = await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.ok(result.ok, result.errors.join('; '))
  for (const wkey of wkeys) {
    t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2), 'writer joined after the hole is downloaded')
  }
  t.ok(await stored(m, dkey), 'the binding diary is kept')
  t.absent(await holdsBlock(m, dkey, 1), 'the deleted block is not held')
  t.ok(await holdsBlock(m, dkey, 4), 'the join after the hole is held')
})

test('a binding diary served by a stale peer keeps no block its author deleted', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const { dkey, wkeys } = await deletedBinding(t, bootstrap, kp, group, { cleared: false })
  const m = await groupMember(t, kp, group)
  const { result, events } = await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.ok(result.ok, result.errors.join('; '))
  for (const wkey of wkeys) {
    t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2), 'writer downloaded')
  }
  t.absent(await holdsBlock(m, dkey, 1), 'the deleted block is cleared, not kept')
  t.ok(await holdsBlock(m, dkey, 3), 'the join block is held')
})

test('at start a member of a group purges an unfollowed diary no group needs and keeps one a stored writer names', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const cs = new Corestore(tmpDir(t, 'varanda-gcs-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  // A diary once followed and then unfollowed: nothing names it.
  const loose = cs.get({ name: 'loose' })
  await loose.ready()
  const lkey = hex(loose.key)
  await loose.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: lkey }, kp)))))
  await loose.append(b4a.from(JSON.stringify(postRecord({ text: 'p' }))))
  const { d, w, dkey, wkey } = await diaryAndWriter(cs, group, (key) => createCert({ member: key }, kp))
  const m = await groupMember(t, kp, group)
  await copyInto(cs, m, [loose, d, w])
  await syncOnce(bootstrap, m, { timeoutMs: 3000 })
  t.absent(await stored(m, lkey), 'the unfollowed diary no group needs is purged')
  t.ok(await stored(m, dkey), 'the binding diary a stored writer names stays')
  t.ok(await stored(m, wkey), 'the stored writer stays')
})

// A diary that binds two listed writers (joins at seq 1 and 2) and deletes
// the first join (tombstone at seq 3), on a peer that still serves the
// deleted block. -> the writer of the deleted join (`first`) and the other.
async function deletedJoin (t, bootstrap, kp, group) {
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const ws = []
  for (const name of ['w1', 'w2']) {
    const w = fake.store.get({ name })
    await w.ready()
    ws.push(w)
  }
  ws.sort((a, b) => b4a.compare(a.key, b.key))
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  for (const w of ws) await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
  await d.append(b4a.from(JSON.stringify(deleteRecord({ seq: 1 }))))
  for (const w of ws) {
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' }))))
  }
  items.push(...ws.map((w, i) => ({ key: hex(w.key), diary: dkey, length: 2, seq: 1 + i })).sort((a, b) => a.key < b.key ? -1 : 1))
  return { fake, d, dkey, first: hex(ws[0].key), other: hex(ws[1].key) }
}

// No group-downloaded event repeats a core and length (the growth reported
// at run end is not reported again by the growth listener).
function growthOnce (events) {
  const seen = new Set()
  for (const ev of events) {
    if (ev.event !== 'group-downloaded') continue
    const id = ev.key + ':' + ev.length
    if (seen.has(id)) return false
    seen.add(id)
  }
  return true
}

async function boundAndDownloaded (t, m, events, first, other) {
  t.ok(growthOnce(events), 'no growth is reported twice')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === first && ev.length === 2), 'the writer of the deleted join is downloaded')
  t.absent(events.some((ev) => ev.event === 'group-skipped' && ev.key === first), 'the writer of the deleted join is never withdrawn')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === other && ev.length === 2), 'the writer bound by the other join is downloaded')
  t.absent(events.some((ev) => ev.event === 'group-skipped' && ev.key === other), 'the writer bound by the other join stays')
  t.is(await storedLength(m, first), 2, 'both blocks of the writer of the deleted join are stored')
  t.is(await storedLength(m, other), 2, 'both blocks of the other writer are stored')
}

test('a writer whose join its author deleted stays bound and downloaded without stalling the run, and the join block is kept', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const { dkey, first, other } = await deletedJoin(t, bootstrap, kp, group)
  const m = await groupMember(t, kp, group)
  const started = Date.now()
  const { result, events } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(Date.now() - started < 20000, 'the run completes before its deadline')
  await boundAndDownloaded(t, m, events, first, other)
  t.ok(await holdsBlock(m, dkey, 1), 'the deleted join block is kept')
})

test('a writer whose deleted join arrives after its tombstone still ends up bound, and the join block is kept', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const { fake, d, dkey, first, other } = await deletedJoin(t, bootstrap, kp, group)
  const m = await groupMember(t, kp, group)
  // The member holds block 0 and the tombstone, not the join it deletes.
  await copyInto(fake.store, m, [d], { only: () => [0, 3] })
  t.absent(await holdsBlock(m, dkey, 1), 'the join is not held before the run')
  t.ok(await holdsBlock(m, dkey, 3), 'the tombstone is')
  const { result, events } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.ok(result.ok, result.errors.join('; '))
  await boundAndDownloaded(t, m, events, first, other)
  t.ok(await holdsBlock(m, dkey, 1), 'the deleted join block is fetched and kept')
})

test('a join whose tombstone the binding diary learns while the gate runs keeps its writer bound', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const { fake, d, dkey, first, other } = await deletedJoin(t, bootstrap, kp, group)
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d], { only: () => [0, 3] })
  // The writer of the deleted join opens only after the other writer's
  // binding diary (the same diary, holding the tombstone) is active: its
  // activation then finds the join deleted.
  const events = []
  let otherFirst = false
  const openHook = async (key) => {
    if (key !== first) return
    try {
      await until(() => events.some((ev) => ev.event === 'group-downloaded' && ev.key === other), { timeoutMs: 10000, name: 'other writer' })
      otherFirst = true
    } catch {}
  }
  const result = await runSync({ dataDir: m.dataDir, ...localSwarmOptions(bootstrap), once: true, timeoutMs: 25000, onEvent: (ev) => events.push(ev), openHook })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(otherFirst, 'the other writer was active first')
  await boundAndDownloaded(t, m, events, first, other)
  t.ok(await holdsBlock(m, dkey, 1), 'the deleted join block is fetched and kept')
})

// One writer listed; its diary also holds a deleted post, a deleted
// group-confirm, a deleted group-cut and a deleted off join, all stored on
// the member before the run.
test('a binding diary keeps the group-confirm, group-cut and off join blocks its author deleted, and clears the deleted post', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const w = fake.store.get({ name: 'w' })
  await w.ready()
  const wkey = hex(w.key)
  const records = [
    memberCertRecord(createCert({ member: dkey }, kp)),
    postRecord({ text: 'apagado' }),
    groupJoinRecord({ group, writer: wkey, on: true }),
    groupConfirmRecord({ group, writer: wkey, seq: 1, digest: 'ab'.repeat(32) }),
    groupCutRecord({ group, writer: wkey, cut: 1 }),
    groupJoinRecord({ group, writer: wkey, on: false }),
    deleteRecord({ seq: 1 }),
    deleteRecord({ seq: 3 }),
    deleteRecord({ seq: 4 }),
    deleteRecord({ seq: 5 })
  ]
  for (const r of records) await d.append(b4a.from(JSON.stringify(r)))
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
  await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' }))))
  items.push({ key: wkey, diary: dkey, length: 2, seq: 2 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d])
  const { result, events } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2), 'the writer is downloaded')
  t.is(await storedLength(m, wkey), 2, 'both writer blocks are stored')
  t.absent(await holdsBlock(m, dkey, 1), 'the deleted post is cleared')
  t.ok(await holdsBlock(m, dkey, 3), 'the deleted group-confirm is kept')
  t.ok(await holdsBlock(m, dkey, 4), 'the deleted group-cut is kept')
  t.ok(await holdsBlock(m, dkey, 5), 'the deleted off join is kept')
})

// A diary that binds a listed writer (join at seq 1) and a second one
// (join at seq 2), then writes `target` (seq 3) and deletes it (seq 4). The
// member holds every block but the target; the fake seeder still serves it
// and counts each upload of it.
async function unheldTarget (t, bootstrap, kp, group, target) {
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const w = fake.store.get({ name: 'w' })
  await w.ready()
  const wkey = hex(w.key)
  const other = hex(crypto.randomBytes(32))
  const records = [
    memberCertRecord(createCert({ member: dkey }, kp)),
    groupJoinRecord({ group, writer: wkey, on: true }),
    groupJoinRecord({ group, writer: other, on: true }),
    target(other),
    deleteRecord({ seq: 3 })
  ]
  for (const r of records) await d.append(b4a.from(JSON.stringify(r)))
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
  await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' }))))
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d], { only: () => [0, 1, 2, 4] })
  const uploads = []
  d.on('upload', (index) => { if (index === 3) uploads.push(index) })
  return { m, dkey, wkey, uploads }
}

async function storedEntries (ctx, key) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = s.get({ key: b4a.from(key, 'hex'), writable: false })
    await core.ready()
    return await store.readAll(core)
  } finally {
    await s.close()
  }
}

test('a group diary fetches an unheld deleted off join once and keeps it, so the leave still counts', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const { m, dkey, wkey, uploads } = await unheldTarget(t, bootstrap, kp, group, (writer) => groupJoinRecord({ group, writer, on: false }))
  t.absent(await holdsBlock(m, dkey, 3), 'the off join is not held before the run')
  const { result, events } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2), 'the listed writer is downloaded')
  t.ok(growthOnce(events), 'no growth is reported twice')
  t.is(await storedLength(m, wkey), 2, 'both writer blocks are stored')
  t.ok(uploads.length >= 1, 'the peer served the deleted off join')
  t.ok(await holdsBlock(m, dkey, 3), 'the deleted off join is kept')
  const entries = await storedEntries(m, dkey)
  t.is(entries[3].record.on, false, 'block 3 reads as the off join')
  t.absent(entries[3].deleted, 'the readers still count the leave')
})

test('a group diary fetches an unheld deleted post once, clears it and does not fetch it again in the run', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const { m, dkey, uploads } = await unheldTarget(t, bootstrap, kp, group, () => postRecord({ text: 'apagado' }))
  const ac = new AbortController()
  const run = runSync({ dataDir: m.dataDir, ...localSwarmOptions(bootstrap), signal: ac.signal })
  t.teardown(() => { ac.abort(); return run.catch(() => {}) }, { force: true })
  let served = true
  try {
    await until(() => uploads.length >= 1, { timeoutMs: 20000, name: 'the deleted post served' })
  } catch {
    served = false
  }
  // The run goes on a while: a second request would show here.
  await new Promise((resolve) => setTimeout(resolve, 2000))
  ac.abort()
  await run
  t.ok(served, 'the peer served the deleted post')
  t.is(uploads.length, 1, 'once')
  t.absent(await holdsBlock(m, dkey, 3), 'the deleted post is cleared')
  t.ok((await storedEntries(m, dkey))[3].deleted, 'the readers hide it')
})

// The binding diary and its writer are both stored before the run, so only
// the diary's own range can fetch the deleted group-cut (seq 3) the member
// never held.
test('a stored group diary fetches an unheld deleted group-cut a peer still serves, keeps it, and the cut counts', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const w = fake.store.get({ name: 'w' })
  await w.ready()
  const wkey = hex(w.key)
  const other = hex(crypto.randomBytes(32))
  const records = [
    memberCertRecord(createCert({ member: dkey }, kp)),
    groupJoinRecord({ group, writer: wkey, on: true }),
    groupJoinRecord({ group, writer: other, on: true }),
    groupCutRecord({ group, writer: other, cut: 1 }),
    deleteRecord({ seq: 3 })
  ]
  for (const r of records) await d.append(b4a.from(JSON.stringify(r)))
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
  await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' }))))
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d, w], { only: (core) => core === d ? [0, 1, 2, 4] : null })
  t.absent(await holdsBlock(m, dkey, 3), 'the deleted cut is not held before the run')
  let uploads = 0
  d.on('upload', (index) => { if (index === 3) uploads++ })
  let servedAt = 0
  const { result } = await runUntil(m, bootstrap, () => {
    if (servedAt === 0 && uploads > 0) servedAt = Date.now()
    return servedAt > 0 && Date.now() > servedAt + 3000
  })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(uploads >= 1, 'the peer served the deleted cut')
  t.ok(await holdsBlock(m, dkey, 3), 'the deleted cut is kept')
  const entries = await storedEntries(m, dkey)
  t.absent(entries[3].deleted, 'its tombstone has no effect')
  t.alike(groupCutHistory(entries, group), [{ writer: other, cut: 1, seq: 3 }], 'the cut counts, with no gap')
})

// The binding diary and its writer are both stored before the run, so the
// writer's join (seq 1, not deleted) is held and the gate reads nothing
// else. The diary deletes an off join (seq 3) and a post (seq 4), and the
// member holds neither: only the diary's own range can fetch them.
test('a stored group diary whose writer is active fetches an unheld deleted off join and keeps it, and fetches an unheld deleted post once and clears it', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const w = fake.store.get({ name: 'w' })
  await w.ready()
  const wkey = hex(w.key)
  const other = hex(crypto.randomBytes(32))
  const records = [
    memberCertRecord(createCert({ member: dkey }, kp)),
    groupJoinRecord({ group, writer: wkey, on: true }),
    groupJoinRecord({ group, writer: other, on: true }),
    groupJoinRecord({ group, writer: other, on: false }),
    postRecord({ text: 'apagado' }),
    deleteRecord({ seq: 3 }),
    deleteRecord({ seq: 4 })
  ]
  for (const r of records) await d.append(b4a.from(JSON.stringify(r)))
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
  await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' }))))
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d, w], { only: (core) => core === d ? [0, 1, 2, 5, 6] : null })
  t.absent(await holdsBlock(m, dkey, 3), 'the off join is not held before the run')
  t.absent(await holdsBlock(m, dkey, 4), 'nor the post')
  const uploads = { 3: 0, 4: 0 }
  d.on('upload', (index) => { if (index in uploads) uploads[index]++ })
  let servedAt = 0
  // A once run could end before the range asks for the targets: run until
  // both were served, then a quiet spell for the clear and any second ask.
  const { result } = await runUntil(m, bootstrap, () => {
    if (servedAt === 0 && uploads[3] > 0 && uploads[4] > 0) servedAt = Date.now()
    return servedAt > 0 && Date.now() > servedAt + 3000
  })
  t.ok(result.ok, result.errors.join('; '))
  t.is(await storedLength(m, wkey), 2, 'both writer blocks are stored')
  t.ok(uploads[3] >= 1, 'the peer served the deleted off join')
  t.ok(await holdsBlock(m, dkey, 3), 'the deleted off join is kept')
  const entries = await storedEntries(m, dkey)
  t.is(entries[3].record.on, false, 'block 3 reads as the off join')
  t.absent(entries[3].deleted, 'the readers still count the leave')
  t.is(uploads[4], 1, 'the deleted post is served once')
  t.absent(await holdsBlock(m, dkey, 4), 'the deleted post is cleared')
  t.ok(entries[4].deleted, 'the readers hide it')
})

test('a followed diary that holds a group record fetches an unheld deleted post once and clears it', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const fake = await fakeSeeder(t, bootstrap, kp, [])
  const p = fake.store.get({ name: 'grouped' })
  await p.ready()
  const pkey = hex(p.key)
  const records = [
    memberCertRecord(createCert({ member: pkey }, kp)),
    groupJoinRecord({ group: hex(crypto.randomBytes(32)), writer: hex(crypto.randomBytes(32)), on: true }),
    postRecord({ text: 'fica' }),
    postRecord({ text: 'apagado' }),
    deleteRecord({ seq: 3 })
  ]
  for (const r of records) await p.append(b4a.from(JSON.stringify(r)))
  const m = await groupMember(t, kp, group)
  store.writeFollows(m.dataDir, [pkey])
  // Block 2 is held: the roster probe (docs/protocol.md section 12) has
  // nothing to ask, so only the group-bound rule can fetch block 3.
  await copyInto(fake.store, m, [p], { only: () => [0, 1, 2, 4] })
  const uploads = []
  p.on('upload', (index) => { if (index === 3) uploads.push(index) })
  const ac = new AbortController()
  const run = runSync({ dataDir: m.dataDir, ...localSwarmOptions(bootstrap), signal: ac.signal })
  t.teardown(() => { ac.abort(); return run.catch(() => {}) }, { force: true })
  let served = true
  try {
    await until(() => uploads.length >= 1, { timeoutMs: 20000, name: 'the deleted post served' })
  } catch {
    served = false
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
  ac.abort()
  await run
  t.ok(served, 'the peer served the deleted post')
  t.is(uploads.length, 1, 'once')
  t.absent(await holdsBlock(m, pkey, 3), 'the deleted post is cleared')
  t.ok((await storedEntries(m, pkey))[3].deleted, 'the readers hide it')
})

test('a followed diary with no group record never fetches an unheld deleted post', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const fake = await fakeSeeder(t, bootstrap, kp, [])
  const p = fake.store.get({ name: 'plain' })
  await p.ready()
  const pkey = hex(p.key)
  for (const r of [memberCertRecord(createCert({ member: pkey }, kp)), postRecord({ text: 'apagado' }), deleteRecord({ seq: 1 })]) {
    await p.append(b4a.from(JSON.stringify(r)))
  }
  const m = await groupMember(t, kp, group)
  store.writeFollows(m.dataDir, [pkey])
  await copyInto(fake.store, m, [p], { only: () => [0, 2] })
  const uploads = []
  p.on('upload', (index) => { if (index === 1) uploads.push(index) })
  const { result } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.ok(result.ok, result.errors.join('; '))
  t.is(result.downloaded[pkey], 3, 'the diary is synced')
  t.is(uploads.length, 0, 'the deleted post is never asked for')
  t.absent(await holdsBlock(m, pkey, 1), 'nor held')
})

test('a listing whose join seq names a deleted post of a plain followed diary leaves that post cleared', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const p = fake.store.get({ name: 'plain' })
  await p.ready()
  const pkey = hex(p.key)
  for (const r of [memberCertRecord(createCert({ member: pkey }, kp)), postRecord({ text: 'apagado' }), deleteRecord({ seq: 1 })]) {
    await p.append(b4a.from(JSON.stringify(r)))
  }
  const w = fake.store.get({ name: 'w' })
  await w.ready()
  const wkey = hex(w.key)
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: pkey, member: PARENT }))))
  // The seeder names the deleted post as the writer's join.
  items.push({ key: wkey, diary: pkey, length: 1, seq: 1 })
  const m = await groupMember(t, kp, group)
  store.writeFollows(m.dataDir, [pkey])
  await copyInto(fake.store, m, [p], { only: () => [0, 2] })
  const uploads = []
  p.on('upload', (index) => { if (index === 1) uploads.push(index) })
  const { events } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey), 'the writer is refused')
  t.ok(uploads.length >= 1, 'the gate read the hinted block')
  t.absent(await holdsBlock(m, pkey, 1), 'the deleted post is not held after the run')
})

test('a member that left its last group keeps its former own writer and the stored group cores at run start', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const cs = new Corestore(tmpDir(t, 'varanda-gcs-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  const { d, w, dkey, wkey } = await diaryAndWriter(cs, group, (key) => createCert({ member: key }, kp))
  const m = await groupMember(t, kp, group)
  const own = m.groups[0].writer
  const s = await store.openStore(m.dataDir)
  try {
    const mine = await store.openDiary(s)
    const writer = await store.openGroupWriter(s, m.groups[0].nonce)
    await writer.append(writerHeader({ group, diary: hex(mine.key), member: PARENT }))
  } finally {
    await s.close()
  }
  store.writeGroups(m.dataDir, [])
  await copyInto(cs, m, [d, w])
  await syncOnce(bootstrap, m, { timeoutMs: 3000 })
  t.ok(await stored(m, own), 'the former own writer stays')
  t.ok(await stored(m, wkey), 'the stored group writer stays')
  t.ok(await stored(m, dkey), 'the binding diary it names stays')
})

// The member holds every block of the stale copy, and the run start clears
// block 1. The fold's walk misses the tombstone at seq 2, which "lands"
// with its 'download' event while the walk runs, as a late answer to an
// earlier read would. The range then fetches block 1 again from the stale
// peer, and nothing grows the diary afterwards to rescan seq 2.
test('a tombstone that lands while the binding diary is folded still clears its target', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const { dkey, fake, d, ws } = await deletedBinding(t, bootstrap, kp, group, { cleared: false })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d, ...ws])
  const { has, clear } = Hypercore.prototype
  const ours = (core) => !!core.key && hex(core.key) === dkey
  let landedAt = 0
  let cleared = false
  Hypercore.prototype.has = function (index, ...rest) {
    if (landedAt === 0 && index === 2 && ours(this) && /presentState[^]*watchGroupDiary/.test(new Error().stack)) {
      landedAt = Date.now()
      this.emit('download', 2, 0, null)
      return Promise.resolve(false)
    }
    return has.call(this, index, ...rest)
  }
  Hypercore.prototype.clear = function (start, ...rest) {
    if (landedAt > 0 && start === 1 && ours(this)) cleared = true
    return clear.call(this, start, ...rest)
  }
  const restore = () => Object.assign(Hypercore.prototype, { has, clear })
  t.teardown(restore)
  // A once run ends as soon as the goals are met, before a refold could
  // clear anything. The fix may clear block 1 before the range fetches it
  // again (no clear call then), so a quiet spell also ends the run.
  const deadline = Date.now() + 30000
  await runUntil(m, bootstrap, () => cleared || (landedAt > 0 && Date.now() > landedAt + 3000) || Date.now() > deadline)
  restore()
  t.ok(landedAt > 0, 'the fold walked past the tombstone')
  t.absent(await holdsBlock(m, dkey, 1), 'the deleted block is not held')
  t.ok(await holdsBlock(m, dkey, 3), 'the join block is held')
})
