// The browser sync (lib/sync.js) and public groups, loopback only, through
// a real Seeder behind a WebSocket (the G1 pattern): the creator's root and
// a member's writer are pushed like own media and confirmed with
// 'group-pushed'; the seeder admits them (admitted.json `groups`); a member
// fetches a group it asked for (kv groupReplicas) through the writer pages
// and gates every core before storing it; a once run ends only with every
// page fetched and every foreign core at its advertised length;
// 'groups-changed' fires when only a group core grew; a writer whose header
// does not match its page item is never stored; more than one page of
// writers is paged in full.
const test = require('brittle')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { createModeratorCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { MAX_LOG_BLOCKS } = require('@varanda/core/lib/records')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { hex, randomKey, member, seederOverWs, admittedGroups, indexed, sync, once, named, held, joinSeq, injectWriters, moderatorSnapshot } = require('./helpers/sync-groups')

test('a browser member joins a group through the seeder: pushed, admitted, gated, read', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, dataDir, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  await ops.followAdd(a.ctx, b.ownHex)
  await ops.followAdd(b.ctx, a.ownHex)

  // The creator: the root is an own core, pushed and confirmed at its length.
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  for (let i = 0; i < 20; i++) await ops.groupPost(a.ctx, { group, text: 'p' + i })
  const { group: other } = await ops.groupCreate(a.ctx, { name: 'Outra', join: 'open' })
  const evA = []
  const resA = await once(a, url, evA)
  t.ok(resA.ok, 'creator once run ok ' + JSON.stringify(resA.errors))
  t.ok(named(evA, 'group-pushed').some((e) => e.key === group && e.length === 21), 'root confirmed pushed at 21')
  t.ok(named(evA, 'group-pushed').some((e) => e.key === other && e.length === 1), 'second root confirmed pushed')
  await until(() => admittedGroups(dataDir)[group] && admittedGroups(dataDir)[other], { name: 'roots admitted' })
  const admittedRoot = admittedGroups(dataDir)[group]
  t.alike({ diary: admittedRoot.diary, group: admittedRoot.group }, { diary: a.ownHex, group }, 'root listed under its creator')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })

  // The member asks for the group; the seeder's page also carries a core whose
  // header is another group's root (never stored).
  await store.addGroupReplica(b.storage, group)
  const badSeq = await joinSeq(a, other, other)
  injectWriters(seeder, group, [{ key: other, diary: a.ownHex, length: 1, seq: badSeq }])
  const evB = []
  const resB = await once(b, url, evB)
  t.ok(resB.ok, 'member once run ok ' + JSON.stringify(resB.errors))
  t.alike(await held(b, group), { length: 21, contiguous: 21 }, 'the once run ended with the root at its advertised length')
  t.ok(named(evB, 'group-paged').some((e) => e.group === group && e.count === 2), 'one full pass of the pages')
  t.ok(named(evB, 'group-skipped').some((e) => e.key === other && e.reason === 'wrong-group'), 'the mismatched core is skipped')
  t.is(await store.groupCoreExists(b.storage, other), false, 'a core with a wrong header is never stored')
  t.absent((await store.readGroupReplicas(b.storage)).includes(other), 'nor listed')
  t.ok(named(evB, 'groups-changed').some((e) => e.group === group), 'groups-changed for the fetched root')
  delete seeder.groupWriters

  // Join, post, push: the seeder admits the member's writer.
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  await ops.groupPost(b.ctx, { group, text: 'oi' })
  const writer = (await store.readGroupWriters(b.storage))[0].key
  const evB2 = []
  const resB2 = await once(b, url, evB2)
  t.ok(resB2.ok, 'member push run ok ' + JSON.stringify(resB2.errors))
  t.ok(named(evB2, 'group-pushed').some((e) => e.key === writer && e.length === 2), 'writer confirmed pushed')
  t.absent(evB2.some((e) => e.event === 'have' && e.key === writer), 'the writer never reaches the admission channel')
  await until(() => admittedGroups(dataDir)[writer], { name: 'writer admitted' })
  t.alike(admittedGroups(dataDir)[writer], { diary: b.ownHex, group, seq: await joinSeq(b, group, writer) }, 'admitted.json groups lists the writer')
  await until(() => indexed(seeder, group, writer), { name: 'writer indexed' })

  // The creator receives the writer and reads the post; the member reads the root.
  const evA2 = []
  const resA2 = await once(a, url, evA2)
  t.ok(resA2.ok, 'creator once run ok ' + JSON.stringify(resA2.errors))
  t.alike(await held(a, writer), { length: 2, contiguous: 2 }, 'writer held at its advertised length')
  t.ok((await store.readGroupReplicas(a.storage)).includes(writer), 'listed in kv groupReplicas')
  t.ok(named(evA2, 'group-synced').some((e) => e.key === group && e.length === 21), 'own root reported in sync for the write gate')
  const readA = await ops.groupRead(a.ctx, { group })
  t.ok(readA.items.some((p) => p.diary === b.ownHex && p.text === 'oi'), 'the creator reads the member post')
  const readB = await ops.groupRead(b.ctx, { group })
  t.ok(readB.items.some((p) => p.diary === a.ownHex && p.text === 'p19'), 'the member reads the creator posts')

  // A continuous member run: only the root grows, the diary does not.
  const evB3 = []
  const ac = new AbortController()
  const run = sync(b, url, evB3, { signal: ac.signal })
  await until(() => named(evB3, 'group-paged').length > 0, { name: 'member paged' })
  const mark = evB3.length
  await ops.groupPost(a.ctx, { group, text: 'nova' })
  const resA3 = await once(a, url, [])
  t.ok(resA3.ok, 'creator pushes the new post')
  await until(() => evB3.slice(mark).some((e) => e.event === 'groups-changed' && e.group === group), { name: 'groups-changed', timeoutMs: 30000 })
  ac.abort()
  await run
  const after = evB3.slice(mark)
  t.is(after.filter((e) => e.event === 'groups-changed' && e.group === group).length >= 1, true, 'groups-changed fired')
  t.absent(after.some((e) => e.event === 'downloaded' && e.key === a.ownHex), 'the creator diary did not grow')
  t.alike(await held(b, group), { length: 22, contiguous: 22 })
})

test('more than one page of writers is paged in full; unanswered gates keep a once run open', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  await ops.followAdd(b.ctx, a.ownHex)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Muitos', join: 'open' })
  t.ok((await once(a, url, [])).ok)
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })

  // 70 writers nobody serves, besides the real root.
  const extra = []
  for (let i = 0; i < 70; i++) extra.push({ key: randomKey(), diary: randomKey(), length: 3, seq: 1 })
  const calls = injectWriters(seeder, group, extra)
  await store.addGroupReplica(b.storage, group)

  const ev = []
  const ac = new AbortController()
  const run = sync(b, url, ev, { signal: ac.signal, gateTimeoutMs: 300 })
  await until(() => named(ev, 'group-paged').length > 0 && named(ev, 'groups-changed').some((e) => e.group === group), { name: 'paged, root fetched' })
  ac.abort()
  await run
  t.is(named(ev, 'group-paged')[0].count, 71, 'every writer of both pages')
  t.ok(calls.length >= 2 && calls[0] === null && calls[1] !== null, 'the second page asked after the first one\'s cursor')
  t.alike(await held(b, group), { length: 1, contiguous: 1 }, 'the root is gated before the writers')

  // A stored root alone is not synced: the member joins, and a once run
  // cannot be met while those writers never answer. It times out naming
  // them, bounded by its deadline.
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  const ev2 = []
  const started = Date.now()
  const res = await once(b, url, ev2, { timeoutMs: 4000, gateTimeoutMs: 500 })
  t.absent(res.ok, 'not ok')
  t.ok(/tempo esgotado/.test(res.errors[0]), 'timed out on the group goal')
  t.ok(res.errors[0].includes(extra[0].key) || extra.some((e) => res.errors[0].includes(e.key)), 'an unanswered writer is an unmet goal')
  t.ok(Date.now() - started < 15000, 'bounded by the deadline')
  t.alike(await held(b, group), { length: 1, contiguous: 1 }, 'the root is kept')
})

test('an unfollowed author: its binding diary is stored, never followed, and the posts read', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Praça', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'bom dia' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })

  await store.addGroupReplica(c.storage, group)
  const res = await once(c, url, [])
  t.ok(res.ok, 'reader once run ok ' + JSON.stringify(res.errors))
  t.alike(await store.readGroupDiaries(c.storage), [a.ownHex], 'the binding diary is listed in kv groupDiaries')
  t.absent((await store.readFollows(c.storage)).includes(a.ownHex), 'never followed')
  const read = await ops.groupRead(c.ctx, { group })
  t.ok(read.items.some((p) => p.diary === a.ownHex && p.text === 'bom dia'), 'the post of an unfollowed author reads')
  t.is(read.incomplete, false, 'with its join evidence')
})

test('gates are fair: every unanswered writer is tried, none more than the cap', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Fila', join: 'open' })
  t.ok((await once(a, url, [])).ok)
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  const extra = []
  for (let i = 0; i < 10; i++) extra.push({ key: randomKey(), diary: randomKey(), length: 1, seq: 1 })
  injectWriters(seeder, group, extra)
  await store.addGroupReplica(b.storage, group)
  const ev = []
  const res = await once(b, url, ev, { timeoutMs: 6000, gateTimeoutMs: 200 })
  t.absent(res.ok, 'unanswered writers are unmet goals')
  const counts = extra.map((e) => named(ev, 'group-unanswered').filter((u) => u.key === e.key).length)
  t.ok(counts.every((n) => n >= 1), 'every writer tried ' + JSON.stringify(counts))
  t.ok(counts.every((n) => n <= 4), 'none past the cap ' + JSON.stringify(counts))
})

test('incomplete pages never complete a pass nor confirm an own core; requests are paced', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const keys = []
  for (let i = 0; i < 3; i++) keys.push((await ops.groupCreate(a.ctx, { name: 'G' + i, join: 'open' })).group)
  const real = seeder.groupWriters.bind(seeder)
  const times = []
  seeder.groupWriters = (q) => {
    times.push(Date.now())
    return q.group === keys[0] ? { items: [], next: null, incomplete: true } : real(q)
  }
  const ev = []
  const res = await once(a, url, ev, { timeoutMs: 5000 })
  t.absent(res.ok, 'the incomplete group stays a goal')
  t.ok(res.errors[0].includes(keys[0] + ':pages'), 'its pages are unmet ' + res.errors[0])
  t.absent(named(ev, 'group-paged').some((e) => e.group === keys[0]), 'no pass completed for it')
  // An incomplete page alone never reports the own root: only the seeder's
  // replication peer can (what it reports is what it holds).
  const synced = named(ev, 'group-synced').filter((e) => e.key === keys[0])
  t.ok(synced.every((e) => e.length === 1), 'never past what the peer holds')
  const gaps = times.slice(1).map((at, i) => at - times[i])
  t.ok(times.length >= 3 && gaps.every((g) => g >= 900), 'one request a second at most ' + JSON.stringify(gaps))
})

test('a reconnect pages again before a once run can end', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, wss, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Volta', join: 'open' })
  t.ok((await once(a, url, [])).ok)
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(b.storage, group)
  const real = seeder.groupWriters.bind(seeder)
  let cut = false
  const ev = []
  const res = await once(b, url, ev, {
    timeoutMs: 5000,
    onEvent: (e) => {
      ev.push(e)
      if (e.event !== 'group-paged' || cut) return
      // The first link paged in full; the next one only gets incomplete pages.
      cut = true
      seeder.groupWriters = (q) => q.group === group ? { items: [], next: null, incomplete: true } : real(q)
      for (const client of wss.clients) client.terminate()
    }
  })
  t.ok(cut, 'the first link paged')
  t.ok(named(ev, 'peer').length >= 2, 'reconnected')
  t.absent(res.ok, 'the previous link\'s pages do not meet the goal')
  t.ok(res.errors.some((e) => e.includes(group + ':pages')), 'pages unmet on the new link ' + JSON.stringify(res.errors))
})

test('a binding diary still opening keeps a once run open until it holds the join', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Lenta', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'devagar' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })

  // The author's replica opens late: the root is complete well before.
  const openReplica = store.openReplica
  t.teardown(() => { store.openReplica = openReplica })
  store.openReplica = async (storage, key) => {
    if (key === a.ownHex) await new Promise((resolve) => setTimeout(resolve, 1500))
    return openReplica(storage, key)
  }
  await store.addGroupReplica(c.storage, group)
  const res = await once(c, url, [])
  store.openReplica = openReplica
  t.ok(res.ok, 'reader once run ok ' + JSON.stringify(res.errors))
  const read = await ops.groupRead(c.ctx, { group })
  t.ok(read.items.some((p) => p.diary === a.ownHex && p.text === 'devagar'), 'the post reads after the run')
  t.is(read.incomplete, false, 'with its join evidence')
})

test('a binding diary waits for a gate still borrowing its key on the link', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  const { group: slow } = await ops.groupCreate(a.ctx, { name: 'Presa', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Livre', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'livre' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group) && indexed(seeder, slow, slow), { name: 'roots indexed' })

  // The first group paged names a join seq the author never wrote: its gate
  // holds the author's in-memory diary core on the link for gateTimeoutMs,
  // while the second group's root is accepted and stores that diary.
  const real = seeder.groupWriters.bind(seeder)
  seeder.groupWriters = (q) => {
    const page = real(q)
    if (q.group !== slow) return page
    return { ...page, items: page.items.map((it) => ({ ...it, seq: 999 })) }
  }
  await store.addGroupReplica(c.storage, slow)
  await store.addGroupReplica(c.storage, group)
  const ev = []
  await once(c, url, ev, { timeoutMs: 12000, gateTimeoutMs: 4000 })
  t.ok(named(ev, 'group-unanswered').some((e) => e.key === slow), 'the borrowing gate got no answer')
  const read = await ops.groupRead(c.ctx, { group })
  t.ok(read.items.some((p) => p.diary === a.ownHex && p.text === 'livre'), 'the stored diary downloaded once the borrower let go')
  t.is(read.incomplete, false, 'with its join evidence')
})

test('an issuer revoked in the stored snapshot purges the group cores and binding diary of its member at start', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const issKp = crypto.keyPair()
  const issCert = createIssuerCert({ issuer: hex(issKp.publicKey) }, assocKp)
  const a = await member(assocKp, 'Ana', (key) => createIssuedCert({ member: key }, issKp, issCert))
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Revogada', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'antes' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched the group')
  t.alike(await store.readGroupDiaries(c.storage), [a.ownHex], 'binding diary stored')

  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, assocKp)
  await store.writeBlocklist(c.storage, createSnapshot({ seq: 1, blocked: [], revokedIssuers: [hex(issKp.publicKey)] }, modKp, modCert))
  const ev = []
  await once(c, url, ev, { timeoutMs: 5000 })
  t.ok(named(ev, 'group-skipped').some((e) => e.key === group && e.reason === 'revoked-issuer'), 'the root is skipped as revoked-issuer')
  t.is(await store.groupCoreExists(c.storage, group), false, 'the root is purged')
  t.is(await store.replicaExists(c.storage, a.ownHex), false, 'the binding diary is purged')
  t.alike(await store.readGroupDiaries(c.storage), [], 'and unlisted')
})

test('a group core kept after a non-purging failure still binds its diary', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Cheia', join: 'open' })
  for (let i = 0; i < 12; i++) await ops.groupPost(a.ctx, { group, text: 'q' + i })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched the group')

  // Joined, the group is synced at start. The root (13 blocks) is now over
  // the quota, the author's diary is not: the root fails 'quota' and keeps
  // its blocks, so its diary stays.
  t.alike(await ops.groupJoin(c.ctx, { group }), { state: 'member' })
  const ev = []
  await once(c, url, ev, { timeoutMs: 5000, maxLogBlocks: 10 })
  t.ok(named(ev, 'group-skipped').some((e) => e.key === group && e.reason === 'quota'), 'the root failed on quota')
  t.alike(await held(c, group), { length: 13, contiguous: 13 }, 'and kept its blocks')
  t.is(await store.replicaExists(c.storage, a.ownHex), true, 'the binding diary is kept')
  t.alike(await store.readGroupDiaries(c.storage), [a.ownHex], 'and listed')
})

test('a timed-out page request is retried on the same link', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Tarde', join: 'open' })
  t.ok((await once(a, url, [])).ok)
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  const real = seeder.groupWriters.bind(seeder)
  let calls = 0
  seeder.groupWriters = (q) => {
    calls++
    if (calls > 1) return real(q)
    return new Promise((resolve) => setTimeout(() => resolve(real(q)), 1000))
  }
  await store.addGroupReplica(b.storage, group)
  const ev = []
  const ac = new AbortController()
  const run = sync(b, url, ev, { signal: ac.signal, groupRequestTimeoutMs: 300, groupRetryMs: 1500 })
  await until(() => named(ev, 'group-paged').some((e) => e.group === group), { name: 'paged after the retry', timeoutMs: 10000 })
  t.is(named(ev, 'peer').length, 1, 'on the same link')
  t.ok(calls >= 2, 'asked again')
  ac.abort()
  await run
})

test('an advertised length past the quota is skipped as quota, never fetched block by block', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Enorme', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched the root')
  t.alike(await ops.groupJoin(c.ctx, { group }), { state: 'member' })

  // The accepted root is now advertised at Number.MAX_SAFE_INTEGER, and a
  // writer nobody gated yet at one block past the quota.
  const fake = { key: randomKey(), diary: a.ownHex, length: MAX_LOG_BLOCKS + 1, seq: 1 }
  const real = seeder.groupWriters.bind(seeder)
  seeder.groupWriters = (q) => {
    const page = real(q)
    if (q.group !== group) return page
    const items = page.items.map((it) => it.key === group ? { ...it, length: Number.MAX_SAFE_INTEGER } : it)
    return { ...page, items: [...items, fake].sort((x, y) => (x.key < y.key ? -1 : 1)) }
  }
  const ev = []
  const started = Date.now()
  await once(c, url, ev, { timeoutMs: 5000 })
  t.ok(Date.now() - started < 15000, 'the run ends within its deadline')
  const skipped = named(ev, 'group-skipped').filter((e) => e.reason === 'quota').map((e) => e.key)
  t.absent(skipped.includes(group), 'an over-quota listing never fails the held root')
  t.ok(skipped.includes(fake.key), 'the writer past the quota too')
  t.alike(await held(c, group), { length: 1, contiguous: 1 }, 'the root keeps what it verified')
  t.is(await store.groupCoreExists(c.storage, fake.key), false, 'nothing stored for the writer')
})

test('a followed author whose issuer is revoked loses its group cores although the follow purged its diary first', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const issKp = crypto.keyPair()
  const issCert = createIssuerCert({ issuer: hex(issKp.publicKey) }, assocKp)
  const a = await member(assocKp, 'Ana', (key) => createIssuedCert({ member: key }, issKp, issCert))
  const c = await member(assocKp, 'Caio')
  await ops.followAdd(c.ctx, a.ownHex)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Seguida', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'oi' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched the group and the followed diary')
  t.alike(await held(c, group), { length: 2, contiguous: 2 })

  await store.writeBlocklist(c.storage, moderatorSnapshot(assocKp, { revokedIssuers: [hex(issKp.publicKey)] }))
  const ev = []
  await once(c, url, ev, { timeoutMs: 5000 })
  t.ok(named(ev, 'skipped').some((e) => e.key === a.ownHex && e.reason === 'revoked-issuer'), 'the follow refused the diary')
  t.ok(named(ev, 'group-skipped').some((e) => e.key === group && e.reason === 'revoked-issuer'), 'the root is skipped as revoked-issuer')
  t.is(await store.groupCoreExists(c.storage, group), false, 'the root is purged')
})

test('the revocation sweep never opens a second handle on an open binding diary', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  await ops.followAdd(c.ctx, a.ownHex)
  const { group } = await ops.groupCreate(a.ctx, { name: 'Antiga', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'um' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched while following')
  t.alike(await ops.groupJoin(c.ctx, { group }), { state: 'member' })
  await ops.followRemove(c.ctx, a.ownHex)
  t.ok((await once(c, url, [])).ok, 'the unfollow is synced; the diary stays as a binding diary')

  // Only the author's diary grows, and some unrelated issuer is revoked:
  // the sweep of unfollowed replicas meets the open binding diary, which
  // must still take the new block ('groups-changed' comes from it alone).
  await ops.profileSet(a.ctx, { name: 'Ana Maria', bio: '' })
  t.ok((await once(a, url, [])).ok, 'creator pushed again')
  const own = await store.openDiary(a.storage)
  const length = own.length
  await own.close()
  await store.writeBlocklist(c.storage, moderatorSnapshot(assocKp, { revokedIssuers: [hex(crypto.keyPair().publicKey)] }))
  const ev = []
  const ac = new AbortController()
  const run = sync(c, url, ev, { signal: ac.signal })
  await until(() => named(ev, 'groups-changed').some((e) => e.group === group), { name: 'binding diary grew', timeoutMs: 10000 })
  ac.abort()
  await run
  t.absent(ev.some((e) => e.event === 'error'), 'no error')
  const replica = await store.openReplica(c.storage, a.ownHex)
  t.is(replica.contiguousLength, length, 'the binding diary holds the new block')
  await replica.close()
  t.alike(await store.readGroupDiaries(c.storage), [a.ownHex], 'still the binding diary')
})

test('a block adopted during a continuous run purges resting group cores of the author', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Parada', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched the root (not joined: at rest from now on)')

  const ev = []
  const ac = new AbortController()
  const run = sync(c, url, ev, { signal: ac.signal })
  await until(() => named(ev, 'peer').length > 0, { name: 'connected' })
  await seeder._offerBlocklist(moderatorSnapshot(assocKp, { blocked: [a.ownHex] }), null)
  await until(() => named(ev, 'group-skipped').some((e) => e.key === group && e.reason === 'blocked'), { name: 'resting root skipped', timeoutMs: 10000 })
  ac.abort()
  await run
  t.is(await store.groupCoreExists(c.storage, group), false, 'the resting root is purged')
  t.absent((await store.readGroupReplicas(c.storage)).includes(group), 'and unlisted')
})

test('an over-quota listing of an active core, then an honest one: the core stays active', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Viva', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched the root')
  t.alike(await ops.groupJoin(c.ctx, { group }), { state: 'member' })
  const real = seeder.groupWriters.bind(seeder)
  let lying = true
  seeder.groupWriters = (q) => {
    const page = real(q)
    if (q.group !== group || !lying) return page
    return { ...page, items: page.items.map((it) => it.key === group ? { ...it, length: MAX_LOG_BLOCKS + 1 } : it) }
  }
  const ev = []
  const ac = new AbortController()
  const run = sync(c, url, ev, { signal: ac.signal, groupPageMs: 300 })
  await until(() => named(ev, 'group-paged').some((e) => e.group === group), { name: 'oversized listing paged' })
  lying = false
  await ops.groupPost(a.ctx, { group, text: 'depois' })
  t.ok((await once(a, url, [])).ok, 'creator pushed the post')
  await until(async () => (await held(c, group)).contiguous === 2, { name: 'the root keeps downloading', timeoutMs: 20000 })
  ac.abort()
  await run
  t.absent(named(ev, 'group-skipped').some((e) => e.key === group), 'never skipped')
})
