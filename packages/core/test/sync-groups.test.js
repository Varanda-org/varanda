'use strict'

// Member sync of group cores (lib/sync.js header): writer pages from
// verified seeders over 'varanda/groups/1', the gate of each foreign writer
// before the main store holds it, the --once group goal and the purge of a
// writer whose diary the association blocks.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { runSync, createRequestPacer, GROUP_REQUEST_BURST, GROUP_REQUEST_RATE } = require('../lib/sync')
const { createCert, createModeratorCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { MESSAGE_BURST, MESSAGE_RATE } = require('../lib/groups-net')
const { writerHeader, groupHeader, groupPost, MAX_GROUP_WRITERS_PER_DIARY } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, person, exchange, startSeeder, syncOnce, stored, ownWriter, texts, fakeSeeder, diaryAndWriter, copyInto, runUntil, hasBlocklist, groupMember, ownLengths, never } = require('./helpers/sync-groups')

test('two members and a seeder: each sees the other\'s posts after sync --once, a blocked diary\'s writer is purged', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  await startSeeder(t, bootstrap, kp)
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open' })
  await member.groupPost(a, { group, text: 'primeiro' })
  // B learns the root out of band; everything after this travels by sync.
  await exchange(a, b)
  await member.groupJoin(b, { group })
  await member.groupPost(b, { group, text: 'oi' })
  await member.groupPost(a, { group, text: 'segundo' })
  await member.groupPost(a, { group, text: 'terceiro' })
  const wb = ownWriter(b, group)

  const ra = await syncOnce(bootstrap, a)
  t.ok(ra.result.ok, 'A pushes its diary and root: ' + ra.result.errors.join('; '))

  const rb = await syncOnce(bootstrap, b)
  t.ok(rb.result.ok, 'B pushes its writer and gets the root: ' + rb.result.errors.join('; '))
  t.ok(rb.events.some((ev) => ev.event === 'group-downloaded' && ev.key === group), 'group-downloaded for the root')
  // The run ended only after the root reached the length the seeder holds.
  t.alike(await texts(b, group), ['oi', 'primeiro', 'segundo', 'terceiro'])

  const ra2 = await syncOnce(bootstrap, a)
  t.ok(ra2.result.ok, 'A gets B\'s writer: ' + ra2.result.errors.join('; '))
  const got = ra2.events.filter((ev) => ev.event === 'group-downloaded' && ev.key === wb)
  t.ok(got.length > 0, 'group-downloaded for B\'s writer')
  t.ok(got.every((ev) => ev.group === group), 'the event names the group')
  t.ok(await stored(a, b.key), 'the diary binding the writer is stored')
  t.alike(await texts(a, group), ['oi', 'primeiro', 'segundo', 'terceiro'])
  t.absent(ra2.events.some((ev) => ev.event === 'group-skipped'), 'nothing skipped')

  // The association blocks B: A's next run purges B's writer.
  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 1, blocked: [b.key] }, mod, cert))
  t.ok(await stored(a, wb))
  // At startup, before any peer: the stored writer goes.
  const offline = []
  const r0 = await runSync({ dataDir: a.dataDir, ...localSwarmOptions(bootstrap), signal: AbortSignal.abort(), onEvent: (ev) => offline.push(ev) })
  t.ok(r0.ok, r0.errors.join('; '))
  t.ok(offline.some((ev) => ev.event === 'group-skipped' && ev.key === wb && ev.reason === 'blocked'))
  t.absent(await stored(a, wb), 'purged at startup')
  // Listed again by the seeder, it is refused before anything is stored.
  const ra3 = await syncOnce(bootstrap, a)
  t.ok(ra3.result.ok, ra3.result.errors.join('; '))
  t.ok(ra3.events.some((ev) => ev.event === 'group-skipped' && ev.key === wb && ev.reason === 'blocked'))
  t.absent(await stored(a, wb), 'the blocked diary\'s writer is purged')
  t.ok(await stored(a, group), 'the own root stays')
  t.alike(await texts(a, group), ['primeiro', 'segundo', 'terceiro'])
})

test('more than 64 writers are fully paged; a writer whose header names another group is skipped', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const diary = hex(crypto.randomBytes(32))
  const items = []
  // One diary each: a diary counts at most MAX_GROUP_WRITERS_PER_DIARY writers.
  for (let i = 0; i < 69; i++) items.push({ key: hex(crypto.randomBytes(32)), diary: hex(crypto.randomBytes(32)), length: 1, seq: 1 })
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  // A real core the fake seeder serves: a writer header for another group.
  const bad = fake.store.get({ name: 'bad' })
  await bad.ready()
  await bad.append(b4a.from(JSON.stringify(writerHeader({ group: hex(crypto.randomBytes(32)), diary }))))
  items.push({ key: hex(bad.key), diary, length: 1, seq: 1 })
  items.sort((x, y) => x.key < y.key ? -1 : 1)

  const m = await groupMember(t, kp, group)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 1500 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(fake.requests.length >= 2)
  t.alike(fake.requests.slice(0, 2).map((r) => r.after), [null, items[63].key], 'second page after the 64th writer')
  t.ok(fake.requests.every((r) => r.group === group && r.limit === 64))
  const skipped = new Map(events.filter((ev) => ev.event === 'group-skipped').map((ev) => [ev.key, ev.reason]))
  t.is(skipped.get(hex(bad.key)), 'wrong-group')
  t.is(skipped.size, items.length, 'every listed writer was gated (absent ones time out)')
  t.absent(await stored(m, hex(bad.key)), 'a skipped writer never enters the main store')
})

test('a once run waits for a foreign writer to reach the advertised length', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  // A writer bound by a certified diary, both held by the fake seeder; the
  // page advertises more blocks than it serves at first.
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  const w = fake.store.get({ name: 'writer' })
  await w.ready()
  const wkey = hex(w.key)
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: wkey, on: true }))))
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
  items.push({ key: wkey, diary: dkey, length: 4, seq: 1 })

  const m = await groupMember(t, kp, group)
  const appended = new Promise((resolve) => {
    setTimeout(async () => {
      for (let i = 0; i < 3; i++) await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' + i }))))
      resolve(Date.now())
    }, 2500)
  })
  const { result, events } = await syncOnce(bootstrap, m)
  const at = await appended
  t.ok(result.ok, result.errors.join('; '))
  t.ok(Date.now() >= at, 'the run ended after the writer grew')
  const last = events.filter((ev) => ev.event === 'group-downloaded' && ev.key === wkey).pop()
  t.is(last && last.length, 4)
  t.ok(await stored(m, wkey))
  t.ok(await stored(m, dkey), 'the binding diary is kept')
})

test('a snapshot adopted during sync that blocks the own root and writer purges neither', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const m = await groupMember(t, kp, null, { extra: [hex(crypto.randomBytes(32))], blocks: 2 })
  const mod = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  const snap = createSnapshot({ seq: 1, blocked: m.groups.map((g) => g.writer) }, mod, modCert)
  await fakeSeeder(t, bootstrap, kp, [], { snapshot: () => snap })
  const { result } = await runUntil(m, bootstrap, () => hasBlocklist(m))
  t.ok(result.ok, result.errors.join('; '))
  t.alike(await ownLengths(m), [2, 2], 'own root and writer keep their history')
})

test('a foreign writer whose diary is followed is gated through the main store', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { d, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 2)
  items.push({ key: wkey, diary: dkey, length: 3, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d])
  store.writeFollows(m.dataDir, [dkey])
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 4000 })
  t.ok(result.ok, result.errors.join('; '))
  t.absent(events.some((ev) => ev.event === 'group-skipped'), 'nothing skipped')
  const last = events.filter((ev) => ev.event === 'group-downloaded' && ev.key === wkey).pop()
  t.alike(last, { event: 'group-downloaded', key: wkey, group, length: 3 })
  t.ok(await stored(m, wkey))
})

test('at startup a revoked issuer takes its diary\'s group writers too', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const issuerKp = crypto.keyPair()
  const issuerHex = hex(issuerKp.publicKey)
  const issuerCert = createIssuerCert({ issuer: issuerHex }, kp)
  const cs = new Corestore(tmpDir(t, 'varanda-gsrc-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  const { d, dkey, w, wkey } = await diaryAndWriter(cs, group, (key) => createIssuedCert({ member: key }, issuerKp, issuerCert), 1)
  const m = await groupMember(t, kp, group)
  await copyInto(cs, m, [d, w])
  t.ok(await stored(m, wkey))
  const mod = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(m.dataDir, createSnapshot({ seq: 1, revokedIssuers: [issuerHex] }, mod, modCert))
  const events = []
  const r = await runSync({ dataDir: m.dataDir, ...localSwarmOptions(bootstrap), signal: AbortSignal.abort(), onEvent: (ev) => events.push(ev) })
  t.ok(r.ok, r.errors.join('; '))
  t.absent(await stored(m, dkey), 'the diary goes')
  t.absent(await stored(m, wkey), 'and so does its writer')
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'revoked-issuer'))
})

test('a writer skipped for quota is still purged when its diary is blocked later', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  let snap = null
  const fake = await fakeSeeder(t, bootstrap, kp, items, { snapshot: () => snap })
  const { d, dkey, w, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 2)
  items.push({ key: wkey, diary: dkey, length: 3, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d, w])
  const mod = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  let sent = false
  const { result, events } = await runUntil(m, bootstrap, (evs) => {
    if (!sent && evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'quota')) {
      sent = true
      snap = createSnapshot({ seq: 1, blocked: [dkey] }, mod, modCert)
      fake.announce()
    }
    return sent && hasBlocklist(m)
  }, { maxLogBlocks: 2 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.reason === 'quota'))
  t.absent(await stored(m, wkey), 'the quota-skipped writer is purged by the block')
})

test('a writer admitted from page 1 keeps its goal when page 2 times out', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  let item = null
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: ({ after }) => after === null ? { items: [item], next: item.key, incomplete: false } : never()
  })
  const { w, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp))
  item = { key: wkey, diary: dkey, length: 4, seq: 1 }
  const m = await groupMember(t, kp, group)
  const grown = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    for (let i = 0; i < 3; i++) await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' + i }))))
  })()
  const { result, events } = await syncOnce(bootstrap, m, { groupRequestTimeoutMs: 1000 })
  await grown
  t.ok(result.ok, result.errors.join('; '))
  const last = events.filter((ev) => ev.event === 'group-downloaded' && ev.key === wkey).pop()
  t.is(last && last.length, 4, 'the run waited for the advertised length')
})

test('a seeder that answered incomplete and then timed out does not hold the page goal', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q, n) => n === 0 ? { items: [], next: null, incomplete: true } : never()
  })
  const m = await groupMember(t, kp, group)
  const started = Date.now()
  const { result } = await syncOnce(bootstrap, m, { timeoutMs: 20000, groupRequestTimeoutMs: 1000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(Date.now() - started < 15000, 'ended well before the deadline')
  t.ok(fake.requests.length >= 2)
})

test('the request pacer keeps a connection below the seeder\'s message rate', (t) => {
  let now = 0
  const pacer = createRequestPacer({ now: () => now })
  let tokens = MESSAGE_BURST
  let last = 0
  let sent = 0
  let dropped = false
  const end = 600000
  while (now < end) {
    now += pacer.reserve()
    tokens = Math.min(MESSAGE_BURST, tokens + (now - last) * MESSAGE_RATE / 1000)
    last = now
    if (tokens < 1) dropped = true
    tokens--
    sent++
    now += 10 // one round trip per request
  }
  t.absent(dropped, 'the seeder bucket never runs dry')
  t.ok(sent <= GROUP_REQUEST_BURST + Math.ceil(GROUP_REQUEST_RATE * end / 1000) + 1, 'at most burst + rate')
  t.ok(GROUP_REQUEST_RATE <= MESSAGE_RATE / 2)
})

test('long-running sync pages a quiet group again only after the refresh interval', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const fake = await fakeSeeder(t, bootstrap, kp, [])
  const m = await groupMember(t, kp, group)
  let firstAt = 0
  await runUntil(m, bootstrap, () => {
    if (fake.requests.length > 0 && firstAt === 0) firstAt = Date.now()
    return firstAt > 0 && Date.now() - firstAt > 1500
  }, { pageRetryMs: 100, pageRefreshMs: 60000 })
  t.is(fake.requests.length, 1, 'one request in 1.5 s with a pass every 100 ms')
})

test('on the creator\'s device a blocked own root takes every foreign writer of the group', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const m = await groupMember(t, kp, null, { blocks: 2 })
  const group = m.groups[0].group
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const cs = new Corestore(tmpDir(t, 'varanda-gsrc-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  // One writer already stored, one only listed by the seeder.
  const stale = await diaryAndWriter(cs, group, (key) => createCert({ member: key }, kp), 1)
  await copyInto(cs, m, [stale.d, stale.w])
  const fresh = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: fresh.wkey, diary: fresh.dkey, length: 2, seq: 1 })
  const mod = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(m.dataDir, createSnapshot({ seq: 1, blocked: [group] }, mod, modCert))
  const { result, events } = await syncOnce(bootstrap, m, { timeoutMs: 8000 })
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === stale.wkey && ev.reason === 'blocked'))
  t.absent(await stored(m, stale.wkey), 'the stored foreign writer is purged at startup')
  t.absent(await stored(m, fresh.wkey), 'a listed one never enters the main store')
  t.is(fake.requests.length, 0, 'the blocked group is not paged')
  t.alike(await ownLengths(m), [2], 'the own root keeps its history')
  t.ok(result.peers >= 1)
})

test('a fork of a diary kept only for a binding purges the diary and its writers', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { d, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  let forked = false
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (!forked && evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2)) {
      forked = true
      d.truncate(1, { fork: 1 }).then(() => d.append(b4a.from(JSON.stringify({ type: 'x' })))).catch(() => {})
    }
    return evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey)
  })
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'fork'))
  t.absent(await stored(m, wkey), 'its writer is purged')
  t.absent(await stored(m, dkey), 'the forked diary is purged')
})

test('a page item naming a stored core that is no writer of the group leaves it untouched', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const other = hex(crypto.randomBytes(32))
  const items = []
  await fakeSeeder(t, bootstrap, kp, items)
  const cs = new Corestore(tmpDir(t, 'varanda-gsrc-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  // A writer accepted for another group, and a followed diary.
  const { d, dkey, w, wkey } = await diaryAndWriter(cs, other, (key) => createCert({ member: key }, kp), 1)
  const f = cs.get({ name: 'followed' })
  await f.ready()
  const fkey = hex(f.key)
  await f.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: fkey }, kp)))))
  await f.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: fkey, on: true }))))
  const m = await groupMember(t, kp, group)
  await copyInto(cs, m, [d, w, f])
  store.writeFollows(m.dataDir, [fkey])
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 }, { key: fkey, diary: fkey, length: 2, seq: 1 })
  items.sort((x, y) => x.key < y.key ? -1 : 1)
  const { result, events } = await syncOnce(bootstrap, m, { timeoutMs: 15000 })
  t.ok(result.ok, result.errors.join('; '))
  const skipped = new Map(events.filter((ev) => ev.event === 'group-skipped').map((ev) => [ev.key, ev.reason]))
  t.is(skipped.get(wkey), 'wrong-group')
  t.is(skipped.get(fkey), 'header-invalid')
  t.ok(await stored(m, wkey), 'the other group\'s writer stays')
  t.ok(await stored(m, fkey), 'the followed diary stays')
  t.is(result.downloaded[fkey], 2, 'and is still synced')
})

test('a fork of a followed binding diary takes the writers it binds', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  const { d, dkey, wkey } = await diaryAndWriter(fake.store, group, (key) => createCert({ member: key }, kp), 1)
  items.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d])
  store.writeFollows(m.dataDir, [dkey])
  let forked = false
  const { events } = await runUntil(m, bootstrap, (evs) => {
    if (!forked && evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey && ev.length === 2)) {
      forked = true
      d.truncate(1, { fork: 1 }).then(() => d.append(b4a.from(JSON.stringify({ type: 'x' })))).catch(() => {})
    }
    return evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey)
  })
  t.ok(events.some((ev) => ev.event === 'skipped' && ev.key === dkey && ev.reason === 'fork'), 'the follow handles its diary')
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'fork'))
  t.absent(await stored(m, wkey), 'its writer is purged')
})

test('a block of the binding diary that arrives mid-gate takes the writer and the diary', async (t) => {
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
  // The snapshot is adopted (and enforced) while the writer is being opened.
  const openHook = async (key) => {
    if (key !== wkey) return
    snap = createSnapshot({ seq: 1, blocked: [dkey] }, mod, modCert)
    fake.announce()
    await until(() => hasBlocklist(m), { timeoutMs: 20000, name: 'snapshot adopted' })
  }
  const { events } = await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.event === 'group-skipped' && ev.key === wkey), { openHook })
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'blocked'))
  t.absent(await stored(m, wkey), 'the writer goes')
  t.absent(await stored(m, dkey), 'and so does the blocked diary the gate opened')
})

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
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: real }))))
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
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: real }))))
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
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    writers.push(w)
    real.push({ key: hex(w.key), diary: dkey, length: 2, seq: i + 1 })
  }
  for (let i = 0; i < 3; i++) forged.push({ key: hex(crypto.randomBytes(32)), diary: dkey, length: 1, seq: 1 })
  const m = await groupMember(t, kp, group)
  // The diary is held already: eight gates of one diary read it through the
  // main store, never through concurrent quarantine reads.
  await copyInto(fake.store, m, [d])
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
    w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey })))).catch(() => {})
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
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => ({ items: q.group === g ? listed : [], next: null, incomplete: false })
  })
  await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q) => new Promise((resolve) => setTimeout(() => resolve({ items: q.group === h ? listed : [], next: null, incomplete: false }), 1500))
  })
  const { dkey, wkey } = await diaryAndWriter(fake.store, h, (key) => createCert({ member: key }, kp), 1)
  listed.push({ key: wkey, diary: dkey, length: 2, seq: 1 })
  const m = await groupMember(t, kp, g, { extra: [h] })
  // Long-running: the honest listing arrives in a later pass, after the
  // wrong one was disproved.
  const { result, events } = await runUntil(m, bootstrap, (evs) => evs.some((ev) => ev.event === 'group-downloaded' && ev.key === wkey), { pageRetryMs: 100, pageRefreshMs: 100 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(events.some((ev) => ev.event === 'group-skipped' && ev.key === wkey && ev.reason === 'wrong-group'), 'the listing under the other group failed')
  const got = events.filter((ev) => ev.event === 'group-downloaded' && ev.key === wkey).pop()
  t.ok(got && got.group === h && got.length === 2, 'admitted under its own group')
})

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
  setTimeout(async () => {
    for (let i = 0; i < 2; i++) await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' + i }))))
  }, 3500)
  const m = await groupMember(t, kp, group)
  const { result, events } = await syncOnce(bootstrap, m, { pageRetryMs: 100, gateTimeoutMs: 500 })
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
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
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
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: (q, n) => {
      const items = n === 0 ? all.slice(1) : all.slice()
      items.sort((x, y) => x.key < y.key ? -1 : 1)
      return { items, next: null, incomplete: false }
    }
  })
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  for (let i = 0; i <= MAX_GROUP_WRITERS_PER_DIARY; i++) {
    const w = fake.store.get({ name: 'w' + i })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
    all.push({ key: hex(w.key), diary: dkey, length: 1, seq: i + 1 })
  }
  const last = all[all.length - 1].key
  const m = await groupMember(t, kp, group)
  await copyInto(fake.store, m, [d])
  let forked = false
  const { events } = await runUntil(m, bootstrap, (evs) => {
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
  for (let i = 0; i < 512; i++) {
    const c = spam.store.get({ name: 'junk' + i })
    await c.ready()
    await c.append(b4a.from(JSON.stringify({ type: 'nada', i })))
    junk.push({ key: hex(c.key), diary: hex(crypto.randomBytes(32)), length: 1, seq: 1 })
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
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
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
