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
const { writerHeader, groupPost } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, PARENT, person, exchange, startSeeder, syncOnce, stored, ownWriter, texts, fakeSeeder, diaryAndWriter, copyInto, runUntil, hasBlocklist, groupMember, ownLengths, never } = require('./helpers/sync-groups')

test('two members and a seeder: each sees the other\'s posts after sync --once, a blocked diary\'s writer is purged', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  await startSeeder(t, bootstrap, kp)
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await member.groupPost(a, { group, text: 'primeiro' })
  // B learns the roots out of band; everything after this travels by sync.
  await exchange(a, b)
  await member.communityJoin(b, { community })
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
  // B's CW in the community is listed first and carries the diary's skip.
  const bWriters = store.readGroups(b.dataDir).map((g) => g.writer)
  t.ok(ra3.events.some((ev) => ev.event === 'group-skipped' && bWriters.includes(ev.key) && ev.reason === 'blocked'))
  t.absent(await stored(a, wb), 'the blocked diary\'s writer is purged')
  t.ok(await stored(a, group), 'the own root stays')
  t.alike(await texts(a, group), ['primeiro', 'segundo', 'terceiro'])
})

test('more than 64 writers are fully paged; a writer whose header names another group is skipped', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  // One diary each: a diary counts at most MAX_GROUP_WRITERS_PER_DIARY writers.
  for (let i = 0; i < 69; i++) items.push({ key: hex(crypto.randomBytes(32)), diary: hex(crypto.randomBytes(32)), length: 1, seq: 1 })
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  // Listed under a diary the fake seeder serves, whose join seq names no
  // such writer: a header stub is never proven, so the header's verdict
  // stands (#350).
  const dc = fake.store.get({ name: 'diary' })
  await dc.ready()
  const diary = hex(dc.key)
  await dc.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: diary }, kp)))))
  await dc.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(crypto.randomBytes(32)), on: true }))))
  // A real core the fake seeder serves: a writer header for another group.
  const bad = fake.store.get({ name: 'bad' })
  await bad.ready()
  await bad.append(b4a.from(JSON.stringify(writerHeader({ group: hex(crypto.randomBytes(32)), diary, member: PARENT }))))
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
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
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
