// Second half of the sync-groups tests (split from sync-groups.test.js to
// keep each file well under the runner limit): hostile listings and caps,
// revocation and purge paths, stale-length and binding-diary cases.
const test = require('brittle')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const { MAX_GROUP_WRITERS, MAX_GROUP_WRITERS_PER_DIARY } = require('@varanda/core/lib/group')
const { addJoins, earliestJoin, groupPushHeld, ownGroupVerdict, bindingRecheck, forgetListed, evictionPurges, capVictim, capExcess, storedJoinProof, refineJoinSeq } = require('../lib/sync')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { hex, randomKey, member, seederOverWs, indexed, sync, once, named, held, injectWriters, moderatorSnapshot } = require('./helpers/sync-groups')

test('a key listed with many distinct hostile hints is gated at most the cap', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Dicas', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(b.storage, group)
  t.ok((await once(b, url, [])).ok, 'member fetched the root')
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  const w = (await store.readGroupWriters(b.storage))[0].key
  t.ok((await once(b, url, [])).ok, 'member pushed its writer')
  await until(() => indexed(seeder, group, w), { name: 'writer indexed' })
  const real = seeder.groupWriters.bind(seeder)
  let calls = 0
  seeder.groupWriters = (q) => {
    const page = real(q)
    if (q.group !== group) return page
    calls++
    return { ...page, items: page.items.map((it) => it.key === w ? { ...it, diary: randomKey() } : it) }
  }
  await store.addGroupReplica(c.storage, group)
  const ev = []
  const ac = new AbortController()
  const run = sync(c, url, ev, { signal: ac.signal, groupPageMs: 200, groupRequestMs: 100 })
  await until(() => calls >= 12, { name: 'ten more hostile listings', timeoutMs: 30000 })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  ac.abort()
  await run
  const gated = named(ev, 'group-skipped').filter((e) => e.key === w && e.reason === 'wrong-diary').length
  t.ok(gated >= 1, 'the hostile listing is refused')
  t.ok(gated <= 5, 'never gated past the cap (' + gated + ')')
})

test('the root is never refused for the writer cap, and a pass keeps at most MAX_GROUP_WRITERS items', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Cheia', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  const fakes = []
  // Unprovable listings of the creator's diary sorted before the root.
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY + 1; i++) fakes.push({ key: '0' + randomKey().slice(1), diary: a.ownHex, length: 1, seq: 1 })
  injectWriters(seeder, group, fakes)
  const c = await member(assocKp, 'Caio')
  await store.addGroupReplica(c.storage, group)
  const ev = []
  await once(c, url, ev, { timeoutMs: 6000 })
  t.absent(named(ev, 'group-skipped').some((e) => e.key === group), 'the root is not refused')
  t.ok(await held(c, group), 'the root is stored')

  const many = []
  for (let i = 0; i < MAX_GROUP_WRITERS + 8; i++) many.push({ key: randomKey(), diary: randomKey(), length: 1, seq: 1 })
  injectWriters(seeder, group, many)
  // A fresh reader: the first one now holds the root at rest (not joined).
  const d = await member(assocKp, 'Davi')
  await store.addGroupReplica(d.storage, group)
  const ev2 = []
  await once(d, url, ev2, { timeoutMs: 20000 })
  const paged = named(ev2, 'group-paged').filter((e) => e.group === group)
  t.ok(paged.length > 0, 'paged')
  for (const e of paged) t.ok(e.count <= MAX_GROUP_WRITERS, 'never more than MAX_GROUP_WRITERS cores')
})

test('a gate refused on a hostile listing is tried again for another listing of the key', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Dica', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(b.storage, group)
  t.ok((await once(b, url, [])).ok, 'member fetched the root')
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  const w = (await store.readGroupWriters(b.storage))[0].key
  t.ok((await once(b, url, [])).ok, 'member pushed its writer')
  await until(() => indexed(seeder, group, w), { name: 'writer indexed' })
  const real = seeder.groupWriters.bind(seeder)
  let calls = 0
  seeder.groupWriters = (q) => {
    const page = real(q)
    if (q.group !== group || ++calls > 1) return page
    return { ...page, items: page.items.map((it) => it.key === w ? { ...it, diary: c.ownHex } : it) }
  }
  await store.addGroupReplica(c.storage, group)
  const ev = []
  const ac = new AbortController()
  const run = sync(c, url, ev, { signal: ac.signal, groupPageMs: 500 })
  await until(() => named(ev, 'group-skipped').some((e) => e.key === w && e.reason === 'wrong-diary'), { name: 'hostile hint refused', timeoutMs: 20000 })
  await until(async () => (await held(c, w)) !== null, { name: 'the true listing gated', timeoutMs: 20000 })
  ac.abort()
  await run
  t.pass('the writer is stored after the true listing')
})

test('a blocked group root purges every accepted foreign core of the group', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Barrada', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(b.storage, group)
  t.ok((await once(b, url, [])).ok, 'member fetched the root')
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  const w = (await store.readGroupWriters(b.storage))[0].key
  t.ok((await once(b, url, [])).ok, 'member pushed its writer')
  await until(() => indexed(seeder, group, w), { name: 'writer indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched the group')
  t.alike(await ops.groupJoin(c.ctx, { group }), { state: 'member' })
  const own = (await store.readGroupWriters(c.storage))[0].key
  const ev = []
  const ac = new AbortController()
  const run = sync(c, url, ev, { signal: ac.signal })
  await until(async () => (await held(c, w)) !== null, { name: 'writer held' })
  await seeder._offerBlocklist(moderatorSnapshot(assocKp, { blocked: [group] }), null)
  await until(() => named(ev, 'group-skipped').some((e) => e.key === w && e.reason === 'blocked'), { name: 'writer skipped', timeoutMs: 10000 })
  await until(async () => !(await store.groupCoreExists(c.storage, w)), { name: 'writer purged', timeoutMs: 10000 })
  ac.abort()
  await run
  t.is(await store.groupCoreExists(c.storage, group), false, 'the foreign root is purged')
  t.ok(await store.groupCoreExists(c.storage, own), 'the own writer stays')
})

// A Seeder class whose connections never open 'varanda/groups/1', as one
// from before groups.
function seederWithoutGroups () {
  const groupsNet = require('@varanda/core/lib/groups-net')
  const id = require.resolve('@varanda/core/lib/seeder')
  const cached = require.cache[id]
  const original = groupsNet.attachGroups
  delete require.cache[id]
  groupsNet.attachGroups = () => ({ close () {} })
  try {
    return require('@varanda/core/lib/seeder').Seeder
  } finally {
    groupsNet.attachGroups = original
    require.cache[id] = cached
  }
}

test('a once run against a seeder without groups ends without waiting for own group pushes', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { url } = await seederOverWs(t, assocKp, bootstrap, seederWithoutGroups())
  const a = await member(assocKp, 'Ana')
  await ops.groupCreate(a.ctx, { name: 'Antiga', join: 'open' })
  const started = Date.now()
  const result = await once(a, url, [], { timeoutMs: 8000 })
  t.ok(result.ok, 'the run settles')
  t.ok(Date.now() - started < 8000, 'before its deadline')
})

test('writers stored in an earlier run prove their join seq from the binding diary, so an earlier writer listed later takes a slot', (t) => {
  // Unit test of the run-start derivation plus capVictim (the end-to-end
  // harness needs 9 real writers of one diary through a seeder).
  const g = 'aa'.repeat(32)
  const at = '2026-01-01T00:00:00.000Z'
  const earliest = randomKey()
  const later = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) later.push(randomKey())
  const entries = [{ seq: 0, record: { type: 'genesis' } }]
  entries.push({ seq: 1, record: groupJoinRecord({ group: g, writer: earliest, on: true, at }) })
  for (const w of later) entries.push({ seq: entries.length, record: groupJoinRecord({ group: g, writer: w, on: true, at }) })
  entries.push({ seq: entries.length, record: groupJoinRecord({ group: g, writer: later[0], on: true, at }) })
  const held = later.map((key) => ({ key, group: g, ...storedJoinProof(entries, g, key) }))
  t.alike(storedJoinProof(entries, g, later[0]), { seq: 2, proven: true }, 'the earliest join of the writer')
  t.alike(storedJoinProof(entries, 'bb'.repeat(32), later[0]), { seq: 0, proven: false }, 'another group proves nothing')
  t.alike(storedJoinProof(null, g, later[0]), { seq: 0, proven: false }, 'a diary not stored proves nothing')
  const { full, victim } = capVictim(held, storedJoinProof(entries, g, earliest).seq)
  t.ok(full)
  t.is(victim && victim.key, later[later.length - 1], 'the latest stored writer gives up its slot')
})

test('stored cores beyond the per-diary cap stay at rest, the earliest proven joins live', (t) => {
  // Unit test of the run-start selection (openGroups uses capExcess).
  const g = 'aa'.repeat(32)
  const d = 'bb'.repeat(32)
  const live = [{ key: g, group: g, diary: d, seq: 0, proven: false }]
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY + 1; i++) live.push({ key: randomKey(), group: g, diary: d, seq: 10 + i, proven: true })
  live.push({ key: randomKey(), group: g, diary: d, seq: 1, proven: false })
  const excess = capExcess(live)
  t.is(excess.size, 3, 'root + 7 writers stay live')
  t.ok(excess.has(live[live.length - 1]), 'an unproven core goes to rest first')
  t.ok(excess.has(live[live.length - 2]) && excess.has(live[live.length - 3]), 'then the latest proven joins')
  t.absent(excess.has(live[0]), 'never the root')
})

test('a later duplicate join never makes an earlier writer lose its slot', (t) => {
  // Unit test of refineJoinSeq (the gate refines every held writer with it).
  const g = 'aa'.repeat(32)
  const at = '2026-01-01T00:00:00.000Z'
  const held = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) held.push({ key: randomKey(), group: g, seq: 10 + i, proven: true })
  const early = held[held.length - 1]
  // The seeder named early's duplicate join at 17; its first join is seq 3.
  const entries = [{ seq: 3, record: groupJoinRecord({ group: g, writer: early.key, on: true, at }) }]
  for (const x of held) x.seq = refineJoinSeq(x.seq, entries, g, x.key)
  t.is(early.seq, 3)
  t.is(capVictim(held, 5).victim, held[held.length - 2], 'the latest real join gives up its slot')
})

test('the binding certificate is checked again against the current blocklist before storing', async (t) => {
  // Unit test of the re-check the gate runs before opening storage and
  // before activation (a delayed join with a revocation in between).
  const assocKp = generateAssociationKeyPair()
  const issKp = crypto.keyPair()
  const issCert = createIssuerCert({ issuer: hex(issKp.publicKey) }, assocKp)
  const a = await member(assocKp, 'Ana', (key) => createIssuedCert({ member: key }, issKp, issCert))
  const d = await store.openDiary(a.storage)
  const raw0 = await d.get(0, { raw: true })
  await d.close()
  const association = hex(assocKp.publicKey)
  const none = () => false
  t.is(bindingRecheck(raw0, a.ownHex, 'ff'.repeat(32), association, { revokedIssuers: new Set() }, none), null, 'still valid')
  t.is(bindingRecheck(raw0, a.ownHex, 'ff'.repeat(32), association, { revokedIssuers: new Set([hex(issKp.publicKey)]) }, none), 'revoked-issuer', 'a revocation that arrived meanwhile')
  t.is(bindingRecheck(raw0, a.ownHex, 'ff'.repeat(32), association, { revokedIssuers: new Set() }, (k) => k === a.ownHex), 'blocked', 'a block that arrived meanwhile')
})

test('an un-listed key no longer counts as listed when the run started', (t) => {
  // Unit test of the bookkeeping every un-listing goes through.
  const key = randomKey()
  const listed = new Set([key])
  t.is(forgetListed(listed, key), key)
  t.absent(listed.has(key))
})

test('a stored root whose header names a blocked diary that never bound it stays', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { url } = await seederOverWs(t, assocKp, bootstrap)
  const c = await member(assocKp, 'Caio')
  const stranger = randomKey()
  const rootKp = crypto.keyPair()
  const root = await store.openGroupWriter(c.storage, rootKp)
  await root.append({ type: 'group-header', v: 1, kind: 'group', diary: stranger, visibility: 'public', join: 'open', name: null, box: null, at: new Date().toISOString() })
  await root.close()
  const group = hex(rootKp.publicKey)
  await store.addGroupReplica(c.storage, group)
  await store.writeBlocklist(c.storage, moderatorSnapshot(assocKp, { blocked: [stranger] }))
  await once(c, url, [], { timeoutMs: 5000 })
  t.ok(await store.groupCoreExists(c.storage, group), 'the unbound root stays')
})

test('a root its gate bound goes with its blocked creator after a restart before the join block was stored', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(b.storage, group)
  t.ok((await once(b, url, [])).ok, 'member fetched the root')
  t.ok(await store.groupCoreExists(b.storage, group), 'root stored')
  t.alike(await store.readBoundRoots(b.storage), [group], 'the gate recorded the root as bound')
  // The run ended before the creator's join block was stored here.
  await store.purgeReplica(b.storage, a.ownHex)
  await store.writeBlocklist(b.storage, moderatorSnapshot(assocKp, { blocked: [a.ownHex] }))
  await once(b, 'ws://127.0.0.1:9/seeder', [], { timeoutMs: 3000 })
  t.absent(await store.groupCoreExists(b.storage, group), 'the bound root of a blocked creator is purged')
  t.alike(await store.readBoundRoots(b.storage), [], 'its bound record goes with it')
})

test('a resting core of a revoked member goes although its stored binding replica lost block 0', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const issKp = crypto.keyPair()
  const issCert = createIssuerCert({ issuer: hex(issKp.publicKey) }, assocKp)
  const a = await member(assocKp, 'Ana', (key) => createIssuedCert({ member: key }, issKp, issCert))
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Revogada', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched the root (not joined: at rest from now on)')
  t.alike(await store.readGroupDiaries(c.storage), [a.ownHex], 'binding diary stored')
  // Not joined, the root rests; the binding replica holds no block 0 any
  // more: only the certificate kept at the gate can judge it.
  await store.purgeReplica(c.storage, a.ownHex)
  await (await store.openReplica(c.storage, a.ownHex)).close()
  t.ok(await store.replicaExists(c.storage, a.ownHex), 'an empty binding replica is stored')
  await store.writeBlocklist(c.storage, moderatorSnapshot(assocKp, { revokedIssuers: [hex(issKp.publicKey)] }))
  await once(c, 'ws://127.0.0.1:9/seeder', [], { timeoutMs: 3000 })
  t.absent(await store.groupCoreExists(c.storage, group), 'the resting root of the revoked creator is purged')
})

test('an active core of a member revoked later goes, also with its binding diary gone', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const issKp = crypto.keyPair()
  const issCert = createIssuerCert({ issuer: hex(issKp.publicKey) }, assocKp)
  const a = await member(assocKp, 'Ana', (key) => createIssuedCert({ member: key }, issKp, issCert))
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Ativa', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched the group')
  t.alike(await ops.groupJoin(c.ctx, { group }), { state: 'member' })
  t.ok((await store.readGroupCerts(c.storage)).has(a.ownHex), 'the binding certificate is kept')
  await store.purgeReplica(c.storage, a.ownHex)
  await store.removeGroupDiary(c.storage, a.ownHex)
  await store.writeBlocklist(c.storage, moderatorSnapshot(assocKp, { revokedIssuers: [hex(issKp.publicKey)] }))
  const ev = []
  await once(c, url, ev, { timeoutMs: 5000 })
  t.ok(named(ev, 'group-skipped').some((e) => e.key === group && e.reason === 'revoked-issuer'), 'the active root is skipped')
  t.is(await store.groupCoreExists(c.storage, group), false, 'and purged')
})

// Copies blocks 0..length-1 of group core `key` between two storages.
async function copyGroupCore (from, to, key, length) {
  const source = await store.openGroupCoreReadOnly(from, key)
  const target = await store.openGroupReplica(to, key)
  const a = source.replicate(true, { keepAlive: false })
  const b = target.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await target.download({ start: 0, end: length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await source.close()
    await target.close()
  }
}

// A creator whose seeder holds its root at length 2 while this device holds
// only block 0, unforked (another device with the same passkey wrote the
// second block). A truncate would sign a fork, which the seeder rejects
// (group-rejected 'fork') and stops serving, racing its first sync.
async function staleCreator (t, page) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Atrasada', join: 'open' })
  const saved = memoryNodeStorage()
  await copyGroupCore(a.storage, saved, group, 1)
  await ops.groupPost(a.ctx, { group, text: 'segunda' })
  t.ok((await once(a, url, [])).ok, 'creator pushed 2 blocks')
  await until(() => seeder.groupWriters({ group, after: null, limit: 64 }).items.some((it) => it.key === group && it.length === 2), { name: 'root indexed at 2' })
  await store.purgeGroupCore(a.storage, group)
  await copyGroupCore(saved, a.storage, group, 1)
  t.alike(await held(a, group), { length: 1, contiguous: 1 }, 'this device holds only block 0')
  const real = seeder.groupWriters.bind(seeder)
  seeder.groupWriters = (q) => {
    const answer = real(q)
    return q.group === group ? { ...answer, items: page(answer.items, group) } : answer
  }
  return { a, url, group }
}

async function behindRun (t, a, url, group) {
  const ev = []
  const ac = new AbortController()
  const run = sync(a, url, ev, { signal: ac.signal })
  const behind = () => named(ev, 'group-behind').some((e) => e.key === group && e.theirs >= 2)
  // The own core's active session may also take the seeder's signed length
  // 2 from the peer (an upgrade, no block): synced there is no fork.
  const caughtUp = () => named(ev, 'group-synced').some((e) => e.key === group && e.length >= 2)
  await until(() => behind() || caughtUp(), { name: 'behind reported', timeoutMs: 20000 }).catch(() => {})
  ac.abort()
  await run
  const trace = ev.filter((e) => e.key === group).map((e) => e.event + ':' + e.length + (e.theirs === undefined ? '' : '/' + e.theirs)).join(' ')
  t.ok(named(ev, 'group-paged').length > 0, 'the page arrived')
  t.absent(named(ev, 'group-synced').some((e) => e.key === group && e.length < 2), 'never synced at the stale length: ' + trace)
  t.ok(behind() || caughtUp(), 'behind the seeder peer, or caught up with its length: ' + trace)
}

test('a device behind the seeder is never reported in sync when the page omits its core', async (t) => {
  t.timeout(120000)
  const { a, url, group } = await staleCreator(t, (items, group) => items.filter((it) => it.key !== group))
  await behindRun(t, a, url, group)
})

test('a page listing an own core at a stale length never reports it in sync before the peer has synced', async (t) => {
  t.timeout(120000)
  const { a, url, group } = await staleCreator(t, (items, group) => items.map((it) => it.key === group ? { ...it, length: 1 } : it))
  await behindRun(t, a, url, group)
})

test('the own core write gate waits for the replication peer, whatever the page says', (t) => {
  t.is(ownGroupVerdict(1, 1, null), null, 'a page at the local length alone is no confirmation')
  t.is(ownGroupVerdict(1, 5, null), null)
  t.is(ownGroupVerdict(1, null, null), null)
  t.alike(ownGroupVerdict(1, 1, 2), { theirs: 2, behind: true }, 'the peer ahead wins over a stale page')
  t.alike(ownGroupVerdict(2, 3, 2), { theirs: 3, behind: true }, 'a page ahead wins over the peer')
  t.alike(ownGroupVerdict(2, null, 2), { theirs: 2, behind: false }, 'a seeder without groups confirms through its peer')
  t.alike(ownGroupVerdict(2, 1, 0), { theirs: 1, behind: false })
})

test('the join cache keeps only group-join records and scans each block once', (t) => {
  // Unit test of the accumulator diaryJoins feeds block ranges into.
  const g = 'aa'.repeat(32)
  const at = '2026-01-01T00:00:00.000Z'
  const w = randomKey()
  const joins = []
  addJoins(joins, [{ seq: 0, record: { type: 'genesis' } }, { seq: 1, record: groupJoinRecord({ group: g, writer: w, on: true, at }) }])
  addJoins(joins, [{ seq: 2, record: groupJoinRecord({ group: g, writer: w, on: false, at }) }, { seq: 3, record: groupJoinRecord({ group: g, writer: w, on: true, at }) }])
  t.alike(joins, [{ group: g, writer: w, seq: 1 }, { group: g, writer: w, seq: 3 }], 'on:true joins only, in order')
  t.is(earliestJoin(9, joins, g, w), 1, 'the earliest join')
  t.is(earliestJoin(9, null, g, w), 9, 'nothing known keeps the proven seq')
})

test('a push is confirmed only with the replication peer evidence', (t) => {
  // Unit test of the confirmation rule seederHoldsGroup applies.
  t.is(groupPushHeld(false, 5, 1), false, 'a page alone never confirms')
  t.is(groupPushHeld(true, 0, 1), false, 'nor peer evidence the page contradicts')
  t.is(groupPushHeld(true, 1, 1), true)
  t.is(groupPushHeld(true, null, 1), true, 'a seeder without groups: the peer alone')
})

test('a cap eviction purges a victim still in regate and keeps a listed one', (t) => {
  // Unit test of the eviction rule the gate applies to its victim.
  t.is(evictionPurges('regate'), true, 'unlisted: purged')
  t.is(evictionPurges('active'), false, 'listed: kept')
  t.is(evictionPurges('regate', true), false, 'a core stored before this run is never purged')
})

test('the writer cap keeps the earliest proven joins, never evicting on an unproven seq or a root', (t) => {
  const g = 'aa'.repeat(32)
  const held = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) held.push({ key: randomKey(), group: g, seq: 10 + i, proven: true })
  t.alike(capVictim(held.slice(1), 5), { full: false, victim: null }, 'room left')
  t.is(capVictim(held, 5).victim, held[held.length - 1], 'an earlier join takes the latest one\'s slot')
  t.is(capVictim(held, 99).victim, null, 'a later join is refused')
  const unproven = held.map((x, i) => i === held.length - 1 ? { ...x, proven: false } : x)
  t.is(capVictim(unproven, 5).victim, unproven[held.length - 2], 'never on an unproven seq')
  const root = held.map((x, i) => i === held.length - 1 ? { ...x, key: g } : x)
  t.is(capVictim(root, 5).victim, root[held.length - 2], 'never the root')
})

test('a stored private root is never kept: only public group roots are accepted', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { url } = await seederOverWs(t, assocKp, bootstrap)
  const c = await member(assocKp, 'Caio')
  const rootKp = crypto.keyPair()
  const root = await store.openGroupWriter(c.storage, rootKp)
  await root.append({ type: 'group-header', v: 1, kind: 'group', diary: 'ef'.repeat(32), visibility: 'private', join: 'approval', name: null, box: 'ab'.repeat(32), at: new Date().toISOString() })
  await root.close()
  const group = hex(rootKp.publicKey)
  await store.addGroupReplica(c.storage, group)
  await once(c, url, [], { timeoutMs: 5000 })
  t.is(await store.groupCoreExists(c.storage, group), false, 'purged')
})

test('a listed key with no core and no root on the seeder is unlisted after one pass', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { url } = await seederOverWs(t, assocKp, bootstrap)
  const c = await member(assocKp, 'Caio')
  const stray = randomKey()
  await store.addGroupReplica(c.storage, stray)
  t.ok((await once(c, url, [], { timeoutMs: 8000 })).ok, 'the run settles')
  t.absent((await store.readGroupReplicas(c.storage)).includes(stray), 'unlisted')
  const ev = []
  await once(c, url, ev, { timeoutMs: 8000 })
  t.absent(named(ev, 'group-paged').some((e) => e.group === stray), 'never paged again')
})

test('a binding diary with a deleted post settles a once run, never keeps the post, and a join after the hole binds', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Antes', join: 'open' })
  const gone = (await ops.postCreate(a.ctx, { text: 'apagar' })).seq
  t.alike((await ops.postDelete(a.ctx, { to: { author: a.ownHex, seq: gone } })).deleted, [gone])
  const { group: later } = await ops.groupCreate(a.ctx, { name: 'Depois', join: 'open' })
  await ops.groupPost(a.ctx, { group: later, text: 'depois do buraco' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group) && indexed(seeder, later, later), { name: 'roots indexed' })

  await store.addGroupReplica(c.storage, group)
  await store.addGroupReplica(c.storage, later)
  const res = await once(c, url, [], { timeoutMs: 15000 })
  t.ok(res.ok, 'the once run settles before its deadline ' + JSON.stringify(res.errors))
  t.alike(await store.readGroupDiaries(c.storage), [a.ownHex], 'the binding diary is listed')
  const core = await store.openReplica(c.storage, a.ownHex)
  try {
    t.ok(core.length > gone + 1, 'the diary goes past the hole')
    t.absent(await core.has(gone), 'the deleted post is not kept')
  } finally {
    await core.close()
  }
  const read = await ops.groupRead(c.ctx, { group: later })
  t.ok(read.items.some((p) => p.diary === a.ownHex && p.text === 'depois do buraco'), 'the group joined after the hole reads')
  t.is(read.incomplete, false, 'with its join evidence')
})

test('an unfollowed replica that binds a stored group core survives the run start and its join still reads', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Varal', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'roupa' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })

  await ops.followAdd(c.ctx, a.ownHex)
  await store.addGroupReplica(c.storage, group)
  const first = await once(c, url, [], { timeoutMs: 15000 })
  t.ok(first.ok, 'followed run ok ' + JSON.stringify(first.errors))
  // A member: the stored root stays active at the next run start.
  t.alike(await ops.groupJoin(c.ctx, { group }), { state: 'member' })
  const joined = await once(c, url, [], { timeoutMs: 15000 })
  t.ok(joined.ok, 'member run ok ' + JSON.stringify(joined.errors))
  t.alike(await store.readGroupDiaries(c.storage), [], 'a followed diary is never listed as a binding diary')

  await ops.followRemove(c.ctx, a.ownHex)
  const res = await once(c, url, [], { timeoutMs: 15000 })
  t.ok(res.ok, 'unfollowed run ok ' + JSON.stringify(res.errors))
  t.ok(await store.replicaExists(c.storage, a.ownHex), 'the replica is kept')
  t.alike(await store.readGroupDiaries(c.storage), [a.ownHex], 'now listed as a binding diary')
  const read = await ops.groupRead(c.ctx, { group })
  t.ok(read.items.some((p) => p.diary === a.ownHex && p.text === 'roupa'), 'the post reads')
  t.is(read.incomplete, false, 'with its join evidence')
  const again = await once(c, url, [], { timeoutMs: 15000 })
  t.ok(again.ok, 'a later run ok ' + JSON.stringify(again.errors))
  t.ok(await store.replicaExists(c.storage, a.ownHex), 'still kept')
  t.is((await ops.groupRead(c.ctx, { group })).incomplete, false, 'still with its join evidence')
})

test('a peek never fetches a seq the binding diary knows deleted, on a diary held only as a binding diary', async (t) => {
  t.timeout(120000)
  const Hypercore = require('hypercore')
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const c = await member(assocKp, 'Caio')
  const { group } = await ops.groupCreate(a.ctx, { name: 'Praça', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'bom dia' })
  const { seq: gone } = await ops.postCreate(a.ctx, { text: 'apagar depois' })
  await ops.postDelete(a.ctx, { to: { author: a.ownHex, seq: gone } })
  t.ok((await once(a, url, [])).ok, 'author pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })

  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader stored the binding diary')
  // A joined group stays synced, so the next run opens its binding diary.
  t.alike(await ops.groupJoin(c.ctx, { group }), { state: 'member' })
  t.alike(await store.readGroupDiaries(c.storage), [a.ownHex], 'held as a binding diary')
  t.absent((await store.readFollows(c.storage)).includes(a.ownHex), 'never followed')

  let peekFn = null
  const ev = []
  const ac = new AbortController()
  const run = sync(c, url, ev, { signal: ac.signal, peeker: { set: (fn) => { peekFn = fn }, clear: () => { peekFn = null } } })
  // The stored group core opens the binding diary before the link; settled
  // waits for its tracker, so the tombstone is folded by then.
  await until(() => peekFn !== null && ev.some((e) => e.event === 'settled' && e.settled), { name: 'settled with a peek' })

  const asked = []
  const get = Hypercore.prototype.get
  Hypercore.prototype.get = function (seq, opts) {
    if (this.key && hex(this.key) === a.ownHex) asked.push(seq)
    return get.call(this, seq, opts)
  }
  let res
  try {
    res = await peekFn(a.ownHex, [gone], null, null, Date.now() + 3000)
  } finally {
    Hypercore.prototype.get = get
  }
  ac.abort()
  await run
  t.absent(asked.includes(gone), 'the deleted seq is never asked for')
  t.alike(res.missing, [gone], 'the deleted seq is missing')
  t.is(res.entries.length, 0, 'and never returned')
  const replica = await store.openReplica(c.storage, a.ownHex)
  try {
    t.absent(await replica.has(gone), 'the block is not stored again')
  } finally {
    await replica.close()
  }
})
