'use strict'

// Member sync of group cores, continued from sync-groups-2.test.js (split
// to keep each file under the runner's per-file time limit): the
// per-diary cap by earliest join, gate timeouts, the group-wide cap and the
// release of binding diaries.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { testnet, until } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { runSync } = require('../lib/sync')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writerHeader, groupHeader, groupPost, MAX_GROUP_WRITERS_PER_DIARY } = require('../lib/group')
const { memberCertRecord, groupJoinRecord, postRecord, deleteRecord } = require('../lib/records')
const store = require('../lib/store')
const { hex, syncOnce, stored, fakeSeeder, diaryAndWriter, copyInto, runUntil, groupMember } = require('./helpers/sync-groups')

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
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' }))))
  }
  if (cleared) await d.clear(1)
  items.push(...ws.map((w, i) => ({ key: hex(w.key), diary: dkey, length: 2, seq: 3 + i })).sort((a, b) => a.key < b.key ? -1 : 1))
  return { dkey, wkeys: ws.map((w) => hex(w.key)) }
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

test('a writer whose join its author deleted is withdrawn without stalling the run; a writer bound by another join stays', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  // A stale peer: it still serves the deleted join block.
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
  // The writer of the deleted join is listed first, so its gate reads the
  // join through the quarantine before the fold clears it.
  ws.sort((a, b) => b4a.compare(a.key, b.key))
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  for (const w of ws) await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
  await d.append(b4a.from(JSON.stringify(deleteRecord({ seq: 1 }))))
  for (const w of ws) {
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' }))))
  }
  items.push(...ws.map((w, i) => ({ key: hex(w.key), diary: dkey, length: 2, seq: 1 + i })).sort((a, b) => a.key < b.key ? -1 : 1))
  const withdrawn = hex(ws[0].key)
  const kept = hex(ws[1].key)
  const m = await groupMember(t, kp, group)
  const started = Date.now()
  const { result, events } = await syncOnce(bootstrap, m, { timeoutMs: 20000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(Date.now() - started < 20000, 'the run completes before its deadline')
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === withdrawn && ev.reason === 'withdrawn'), 'the writer of the deleted join is withdrawn')
  const last = events.filter((ev) => ev.key === withdrawn && (ev.event === 'group-skipped' || ev.event === 'group-downloaded')).pop()
  t.is(last && last.event, 'group-skipped', 'the withdrawn writer is not active at the end')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === kept && ev.length === 2), 'the writer bound by the other join is downloaded')
  t.absent(events.some((ev) => ev.event === 'group-skipped' && ev.key === kept), 'the writer bound by the other join stays')
  t.absent(await holdsBlock(m, dkey, 1), 'the deleted join block is not held')
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
    await writer.append(writerHeader({ group, diary: hex(mine.key) }))
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
