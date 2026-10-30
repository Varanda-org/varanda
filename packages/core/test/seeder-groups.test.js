// Group cores at the seeder (packages/core/lib/seeder.js header): a writer
// W is kept only while an admitted diary D holds a live group-join naming W
// AND W's block 0 is a group-writer header naming the group and D; a root G
// once its header is valid and some admitted diary joins G. Listed in
// admitted.json (`groups`), purged like media, and leaving never purges.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { discoveryKey, keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { Seeder } = require('../lib/seeder')
const { createIssuedCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writeBlocklist } = require('../lib/store')
const { groupJoinRecord } = require('../lib/records')
const { groupHeader, writerHeader, groupPost } = require('../lib/group')
const {
  hex,
  makeAssociation,
  readFile,
  readGroups,
  prepareSeederDir,
  startSeeder,
  encode,
  member,
  admit,
  reader,
  admitted,
  rejected,
  stored,
  downloaded,
  moderator,
  creatorAndMember,
  gate,
  scansDone,
  issuedCreatorAndMember,
  makeIssuer,
  fakePeer
} = require('./helpers/seeder-groups')

test('root and writer need both bindings, are listed before open, served over the swarm and paged on the channel', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const listedAt = {}
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    onlog: (e) => {
      if (e.event === 'group-admitted') listedAt[e.key] = e.key in readGroups(dataDir)
    }
  })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  // C joins R with a writer naming another diary and a writer naming
  // another group: one side of the binding alone admits nothing.
  let wrongDiary = null
  let wrongGroup = null
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    wrongDiary = await make('wd', writerHeader({ group: R, diary: B.key }))
    wrongGroup = await make('wg', writerHeader({ group: 'ab'.repeat(32), diary: key }))
    return [groupJoinRecord({ group: R, writer: wrongDiary, on: true }), groupJoinRecord({ group: R, writer: wrongGroup, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admit(C, assoc)
  const evR = await admitted(events, R)
  const evW = await admitted(events, W)
  t.is(evR.diary, A.key)
  t.is(evR.group, R)
  t.is(evW.diary, B.key)
  await rejected(events, wrongDiary, 'wrong-diary')
  await rejected(events, wrongGroup, 'wrong-group')
  t.is(listedAt[R], true, 'R listed before it is served')
  t.is(listedAt[W], true, 'W listed before it is served')
  const listed = readGroups(dataDir)
  // R is charged to whichever join admitted it: A's own or B's.
  t.ok([A.key, B.key].includes(listed[R].by), 'R charged to a joining diary')
  delete listed[R].by
  t.is(listed[R].bound, true, 'A bound R with its own join')
  delete listed[R].bound
  t.alike(listed, { [R]: { diary: A.key, group: R, seq: 1 }, [W]: { diary: B.key, group: R, seq: 1 } })
  t.is(await stored(seeder, wrongDiary), false)
  t.is(await stored(seeder, wrongGroup), false)
  t.is(seeder.stats().groupCores, 2)
  t.ok(!A.messages.some((x) => x.key === R) && !B.messages.some((x) => x.key === W), 'group keys never reach the admission channel')
  await downloaded(seeder, R, 2)
  await downloaded(seeder, W, 3)

  // The creators go offline; a reader that only dials the seeder gets the
  // writer pages and the blocks.
  await A.swarm.destroy()
  await B.swarm.destroy()
  await C.swarm.destroy()
  const r = await reader(t, bootstrap, publicKey)
  t.ok(await r.groups.supported)
  const page = await r.groups.requestWriters({ group: R, after: null, limit: 64 })
  const expected = [{ key: R, diary: A.key, length: 2, seq: 1 }, { key: W, diary: B.key, length: 3, seq: 1 }].sort((a, b) => a.key < b.key ? -1 : 1)
  t.alike(page.items, expected)
  t.is(page.next, null)
  t.is(page.incomplete, false)
  const core = r.store.get({ key: b4a.from(W, 'hex') })
  await core.ready()
  const block = await core.get(2, { timeout: 20000 })
  t.alike(JSON.parse(b4a.toString(block)).text, 'tudo bem?', 'served over the swarm by the seeder')

  // Index answers.
  const group = seeder.indexGroup(R)
  t.is(group.header.diary, A.key)
  t.is(group.header.visibility, 'public')
  t.is(group.header.name, 'Cadeiras da praia', 'the public root\'s display name')
  t.alike(group.writers.map((w) => w.key), expected.map((w) => w.key))
  t.alike(seeder.indexGroups(B.key).groups, [{ group: R, writer: W, seq: 1, left: false }])
  t.alike(seeder.indexGroupSearch('cadeiras').groups, [{ group: R, name: 'Cadeiras da praia', members: 2 }])
  t.is(seeder.indexGroup('zz'), null)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a diary with several writers in one group is one row naming its newest live join', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Roda' }))
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  // B joined R from two devices: W1 at diary seq 1, W2 at seq 2.
  let W1 = null
  let W2 = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W1 = await make('w1', writerHeader({ group: R, diary: key }))
    W2 = await make('w2', writerHeader({ group: R, diary: key }))
    return [groupJoinRecord({ group: R, writer: W1, on: true }), groupJoinRecord({ group: R, writer: W2, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W1)
  await admitted(events, W2)
  await downloaded(seeder, R, 1)
  await downloaded(seeder, W1, 1)
  await downloaded(seeder, W2, 1)
  await until(() => seeder.indexGroups(B.key).complete, { name: 'grupos de B completos' })
  t.alike(seeder.indexGroups(B.key).groups, [{ group: R, writer: W2, seq: 2, left: false }])
  t.is(seeder.indexGroup(R).writers.filter((w) => w.diary === B.key).length, 2, 'both writers stay paged on the group')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('leaving keeps the writer core admitted and served; a blocked root drops its whole group', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await downloaded(seeder, W, 3)

  await B.diary.append(groupJoinRecord({ group: R, writer: W, on: false }))
  await until(() => {
    const g = seeder.indexGroups(B.key)
    return g && g.groups.length === 1 && g.groups[0].left === true
  }, { name: 'B listado como saiu' })
  t.ok(seeder._groupServed.has(W), 'W still served')
  t.ok(W in readGroups(dataDir), 'W still listed')
  t.ok(await stored(seeder, W), 'W still stored')
  t.absent(events.some((e) => e.event === 'group-rejected' && e.key === W), 'never dropped for leaving')
  await B.store.get({ name: 'w' }).append(encode(groupPost({ text: 'depois' })))
  await downloaded(seeder, W, 4)
  const page = seeder.groupWriters({ group: R, after: null, limit: 64 })
  t.ok(page.items.some((i) => i.key === W && i.length === 4), 'a writer that left is still paged')

  const mod = moderator(assoc)
  const snapshot = createSnapshot({ seq: 1, blocked: [R], revokedIssuers: [] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist: snapshot })
  await rejected(events, R, 'group-blocked')
  await rejected(events, W, 'group-blocked')
  await until(async () => seeder._drops.size === 0 && Object.keys(readGroups(dataDir)).length === 0 &&
    !(await stored(seeder, R)) && !(await stored(seeder, W)), { name: 'grupo purgado' })
  t.is(seeder.stats().groupCores, 0)
  t.alike(seeder.groupWriters({ group: R, after: null, limit: 64 }), { items: [], next: null, incomplete: false })
  t.is(seeder.indexGroup(R), null)
  t.alike(seeder.admittedKeys().sort(), [A.key, B.key].sort(), 'the diaries stay')
  // A new join to the blocked root admits nothing.
  const refusals = () => events.filter((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'group-blocked').length
  const before = refusals()
  await A.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await until(() => refusals() > before, { name: 'nova recusa de R' })
  t.is(await stored(seeder, R), false)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a blocked diary drops its writers; the root stays while its creator keeps it', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)

  const mod = moderator(assoc)
  const snapshot = createSnapshot({ seq: 1, blocked: [B.key], revokedIssuers: [] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist: snapshot })
  await rejected(events, W, 'blocked')
  await until(async () => seeder._drops.size === 0 && !(W in readGroups(dataDir)) && !(await stored(seeder, W)), { name: 'W purgado' })
  t.ok(seeder._groupServed.has(R), 'R kept')
  t.alike(Object.keys(readGroups(dataDir)), [R])
  t.alike(seeder.groupWriters({ group: R, after: null, limit: 64 }).items.map((i) => i.key), [R])
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a held blocklist holds new group admissions until a verified snapshot arrives', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Roda' }))
    return []
  })
  await admit(A, assoc)
  // As after a start whose list was lost (seeder.js _blocklistHeld).
  seeder._blocklistHeld = true
  await A.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await rejected(events, R, 'blocklist-pending')
  t.is(await stored(seeder, R), false)

  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [], revokedIssuers: [] }, mod.kp, mod.cert) })
  await admitted(events, R)
  t.is(seeder._blocklistHeld, false)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root admitted through a member join is indexed for its creator whose scan saw it in flight', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const hold = gate()
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    admitHook: (key, step) => step === 'persist' ? hold.hook(key) : undefined
  })

  const { A, B, R } = await creatorAndMember(t, bootstrap, assoc)
  hold.key = R
  // B's join starts admitting R; A's scan then finds R in flight and skips it.
  await admit(B, assoc)
  await until(() => hold.entered, { name: 'admissão de R parada' })
  await admit(A, assoc)
  await until(() => {
    const e = seeder._served.get(A.key)
    return e && e.groupLive.has(R) && scansDone(seeder)
  }, { name: 'A varrido' })
  hold.open()
  await admitted(events, R)
  await downloaded(seeder, R, 2)
  t.ok(seeder.groupWriters({ group: R, after: null, limit: 64 }).items.some((i) => i.key === R && i.diary === A.key), 'R paged as A\'s writer')
  t.alike(seeder.indexGroups(A.key).groups, [{ group: R, writer: R, seq: 1, left: false }])
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a page is incomplete while an admitted writer waits for its local header check', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const hold = gate()
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, regateHook: (key) => hold.hook(key) })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  hold.key = W
  await admit(A, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 2)
  await admit(B, assoc)
  await admitted(events, W)
  await until(() => hold.entered && !seeder._groupReserved.has(W) && !seeder._inflight.has(W) && scansDone(seeder), { name: 'cabeçalho de W em verificação' })
  const pending = seeder.groupWriters({ group: R, after: null, limit: 64 })
  t.absent(pending.items.some((i) => i.key === W), 'W hidden until its header is checked')
  t.is(pending.incomplete, true, 'and the page says so')
  t.is(seeder.indexGroup(R).complete, false)
  t.is(seeder.indexGroups(B.key).complete, false, 'B\'s groups are not complete either')
  hold.open()
  await downloaded(seeder, W, 3)
  const page = seeder.groupWriters({ group: R, after: null, limit: 64 })
  t.ok(page.items.some((i) => i.key === W))
  t.is(page.incomplete, false)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root admitted through a member join is indexed with its creator\'s own join seq, even after the creator withdrew it', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Roda' }))
    return [groupJoinRecord({ group: R, writer: R, on: true }), groupJoinRecord({ group: R, writer: R, on: false })]
  })
  // B's join for W sits at seq 3, never a join of A's diary for R.
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: R, diary: key }))
    return [
      groupJoinRecord({ group: R, writer: 'ab'.repeat(32), on: false }),
      groupJoinRecord({ group: R, writer: 'cd'.repeat(32), on: false }),
      groupJoinRecord({ group: R, writer: W, on: true })
    ]
  })
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await admit(A, assoc)
  await downloaded(seeder, R, 1)
  await until(() => {
    const g = seeder.indexGroups(A.key)
    return g && g.groups.length === 1 && scansDone(seeder)
  }, { name: 'R indexado para A' })
  t.alike(seeder.indexGroups(A.key).groups, [{ group: R, writer: R, seq: 1, left: true }], 'A\'s own on:true join')
  await until(() => readGroups(dataDir)[R].seq === 1, { name: 'seq de R corrigido no arquivo' })
  t.alike(readGroups(dataDir)[R], { diary: A.key, group: R, seq: 1, by: B.key, bound: true }, 'charged to B, whose join admitted it; bound by A')
  await A.swarm.destroy()
  await B.swarm.destroy()
  const r = await reader(t, bootstrap, publicKey)
  const page = await r.groups.requestWriters({ group: R, after: null, limit: 64 })
  t.alike(page.items.find((i) => i.key === R), { key: R, diary: A.key, length: 1, seq: 1 })
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('the per-group writer cap counts an admission in flight once', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const hold = gate()
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    maxGroupCores: 3,
    maxGroupWriters: 3,
    admitHook: (key, step) => step === 'open' ? hold.hook(key) : undefined
  })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Roda' }))
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  let W1 = null
  let W2 = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W1 = await make('w1', writerHeader({ group: R, diary: key }))
    W2 = await make('w2', writerHeader({ group: R, diary: key }))
    return [groupJoinRecord({ group: R, writer: W1, on: true })]
  })
  await admit(A, assoc)
  await admitted(events, R)
  hold.key = W1
  await admit(B, assoc)
  // W1 is listed (persisted) and still reserved: R + W1 = 2 of 3.
  await until(() => hold.entered, { name: 'admissão de W1 parada' })
  t.ok(seeder._groups.has(W1) && seeder._groupReserved.has(W1))
  await B.diary.append(groupJoinRecord({ group: R, writer: W2, on: true }))
  const outcome = await until(() => events.find((e) => e.key === W2 && (e.event === 'group-admitted' || e.event === 'group-rejected')), { name: 'W2 decidido', timeoutMs: 30000 })
  t.is(outcome.event, 'group-admitted', 'the third core fits the cap of 3')
  hold.open()
  await admitted(events, W1)
  t.alike(Object.keys(readGroups(dataDir)).sort(), [R, W1, W2].sort())
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('pages are incomplete while a diary\'s signed length is ahead of its scan', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await downloaded(seeder, R, 2)
  await downloaded(seeder, W, 3)
  await until(() => scansDone(seeder) && !seeder.groupWriters({ group: R, after: null, limit: 64 }).incomplete, { name: 'páginas completas' })
  t.is(seeder.indexGroups(B.key).complete, true)
  // As right after B's signed length grew by a join block not yet local.
  const core = seeder._served.get(B.key).core
  Object.defineProperty(core, 'length', { value: core.contiguousLength + 1, configurable: true })
  let page
  let groups
  try {
    page = seeder.groupWriters({ group: R, after: null, limit: 64 })
    groups = seeder.indexGroups(B.key)
  } finally {
    delete core.length
  }
  t.is(page.incomplete, true, 'the writer page says incomplete')
  t.is(groups.complete, false, 'and so does B\'s group list')
  t.is(seeder.groupWriters({ group: R, after: null, limit: 64 }).incomplete, false)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a diary\'s group list is not complete while one of its writers is being admitted', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const hold = gate()
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    admitHook: (key, step) => step === 'persist' ? hold.hook(key) : undefined
  })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 2)
  hold.key = W
  await admit(B, assoc)
  await until(() => hold.entered && scansDone(seeder), { name: 'admissão de W parada' })
  const pending = seeder.indexGroups(B.key)
  t.alike(pending.groups, [], 'W not listed yet')
  t.is(pending.complete, false, 'and the list says so')
  hold.open()
  await admitted(events, W)
  await downloaded(seeder, W, 3)
  const done = seeder.indexGroups(B.key)
  t.alike(done.groups, [{ group: R, writer: W, seq: 1, left: false }])
  t.is(done.complete, true)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('group search is not complete while a matching root awaits its header check', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const hold = gate()
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, regateHook: (key) => hold.hook(key) })

  const { A, R } = await creatorAndMember(t, bootstrap, assoc)
  hold.key = R
  await admit(A, assoc)
  await admitted(events, R)
  await until(() => hold.entered && !seeder._groupReserved.has(R) && scansDone(seeder), { name: 'cabeçalho de R em verificação' })
  const pending = seeder.indexGroupSearch('cadeiras')
  t.alike(pending.groups, [], 'R hidden until its header is checked')
  t.is(pending.complete, false, 'and the search says so')
  hold.open()
  await downloaded(seeder, R, 2)
  const done = seeder.indexGroupSearch('cadeiras')
  t.alike(done.groups, [{ group: R, name: 'Cadeiras da praia', members: 1 }])
  t.is(done.complete, true)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('restart keeps a root a member\'s live join keeps, with its creator absent and the member\'s writer never admitted', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // Only B is admitted: its joins bring in R and R2, whose creator A never
  // is. B then withdraws from R2: nothing keeps R2 after that.
  let R = null
  let R2 = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Roda' }))
    R2 = await make('root2', groupHeader({ diary: key, name: 'Outra roda' }))
    return []
  })
  let W = null
  let W2 = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: R, diary: key }))
    W2 = await make('w2', writerHeader({ group: R2, diary: key }))
    return [groupJoinRecord({ group: R, writer: W, on: true }), groupJoinRecord({ group: R2, writer: W2, on: true })]
  })
  await admit(B, assoc)
  for (const k of [R, W, R2, W2]) await admitted(first.events, k)
  await downloaded(first.seeder, R, 1)
  await downloaded(first.seeder, R2, 1)
  await B.diary.append(groupJoinRecord({ group: R2, writer: W2, on: false }))
  await until(() => {
    const g = first.seeder.indexGroups(B.key)
    return g && g.groups.some((x) => x.writer === W2 && x.left)
  }, { name: 'B saiu de R2' })
  await first.seeder.close()
  // As if W's and W2's admissions had timed out: the roots listed, the
  // writers not.
  const file = readFile(dataDir)
  delete file.groups[W]
  delete file.groups[W2]
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify(file))
  await A.swarm.destroy()
  await B.swarm.destroy()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await until(() => second.seeder._groupRootStartup === null && scansDone(second.seeder), { name: 'varreduras de início' })
  t.absent(second.events.some((e) => e.event === 'group-rejected' && e.key === R), 'R never dropped')
  t.ok(second.seeder._groupServed.has(R), 'R served')
  t.ok(R in readGroups(dataDir), 'R still listed')
  t.ok(await stored(second.seeder, R), 'R still stored')
  const gone = await rejected(second.events, R2, 'unbound')
  t.ok(second.events.indexOf(gone) > second.events.findIndex((e) => e.event === 'ready'), 'R2 judged only after the start scans')
  await until(async () => second.seeder._drops.size === 0 && !(R2 in readGroups(dataDir)) && !(await stored(second.seeder, R2)), { name: 'R2 purgado' })
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('restart re-gates listed group cores; maxGroupCores refuses with group-full', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxGroupCores: 1 })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admitted(first.events, R)
  await downloaded(first.seeder, R, 2)
  await admit(B, assoc)
  await rejected(first.events, W, 'group-full')
  t.is(await stored(first.seeder, W), false)
  t.alike(Object.keys(readGroups(dataDir)), [R])
  await first.seeder.close()

  // A listed binding whose diary is gone is purged at start ('unbound').
  const ghost = 'cd'.repeat(32)
  const file = readFile(dataDir)
  file.groups[ghost] = { diary: 'ef'.repeat(32), group: R, seq: 1 }
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify(file))

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.ok(second.seeder._groupServed.has(R), 'R served at ready')
  t.ok(second.seeder._groupServed.get(R).headerOk, 'its stored header passed the local gate')
  t.ok(second.events.some((e) => e.event === 'group-rejected' && e.key === ghost && e.reason === 'unbound'))
  t.alike(Object.keys(readGroups(dataDir)), [R])
  // Without the cap W is admitted on the next scan of B.
  await admitted(second.events, W)
  t.alike(Object.keys(readGroups(dataDir)).sort(), [R, W].sort())
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('seed list shows group cores and seed drop purges one', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await downloaded(seeder, R, 2)
  await downloaded(seeder, W, 3)
  await seeder.close()

  const list = await Seeder.list(dataDir, assoc.hex)
  const byKey = Object.fromEntries(list.admitted.map((e) => [e.key, e]))
  t.alike(byKey[A.key].groups, [{ key: R, group: R, length: 2, byteLength: A.cores.root.byteLength }])
  t.alike(byKey[B.key].groups, [{ key: W, group: R, length: 3, byteLength: B.cores.w.byteLength }])
  t.alike(byKey[A.key].media, [])

  t.alike(await Seeder.drop(dataDir, assoc.hex, W), { key: W })
  t.alike(Object.keys(readGroups(dataDir)), [R])
  t.alike(await Seeder.drop(dataDir, assoc.hex, A.key), { key: A.key })
  t.alike(Object.keys(readGroups(dataDir)), [R], 'dropping the creator keeps the root for the next start to re-gate')
  t.alike(await Seeder.drop(dataDir, assoc.hex, R), { key: R })
  t.absent('groups' in readFile(dataDir), 'no group listed: the old file shape')
  const check = new Corestore(path.join(dataDir, 'store'))
  await check.ready()
  t.is(await check.storage.hasCore(discoveryKey(b4a.from(W, 'hex'))), false, 'W purged')
  t.is(await check.storage.hasCore(discoveryKey(b4a.from(R, 'hex'))), false, 'R purged')
  await check.close()
})

test('one diary holds at most MAX_GROUP_WRITERS_PER_DIARY writers in a group, the earliest joined, and leaving frees none', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Roda' }))
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  const W = []
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    for (let i = 0; i < 11; i++) W.push(await make('w' + i, writerHeader({ group: R, diary: key })))
    return W.slice(0, 10).map((w) => groupJoinRecord({ group: R, writer: w, on: true }))
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  for (const w of W.slice(0, 8)) await admitted(events, w)
  const settled = () => until(() => scansDone(seeder) && seeder._groupReserved.size === 0 &&
    seeder._served.get(B.key).scanned === B.diary.length, { name: 'B varrido' })
  await settled()
  for (const w of W.slice(8)) {
    t.absent(events.some((e) => e.key === w), 'a writer past the cap is never tried')
    t.absent(w in readGroups(dataDir))
  }
  t.is(seeder._groupIndex.page(R).items.filter((i) => i.diary === B.key).length, 8)

  // Leaving keeps W0's slot: a later join is still past the cap.
  await B.diary.append(groupJoinRecord({ group: R, writer: W[0], on: false }))
  await B.diary.append(groupJoinRecord({ group: R, writer: W[10], on: true }))
  await settled()
  t.absent(events.some((e) => e.key === W[10]), 'W10 never tried')
  t.absent(W[10] in readGroups(dataDir))
  t.ok(seeder._groupServed.has(W[0]), 'W0 kept after leaving')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root its header\'s diary never bound has no creator and no support from that diary', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // A is admitted and never joins R; B made R naming A and joins it.
  const A = await member(t, bootstrap, assoc, async () => [])
  let R = null
  const B = await member(t, bootstrap, assoc, async ({ make }) => {
    R = await make('root', groupHeader({ diary: A.key, name: 'Alheia' }))
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 1)
  t.is(seeder.indexGroup(R).header.diary, null, 'no creator shown')
  t.is(readGroups(dataDir)[R].diary, A.key, 'listed under the header diary for the local re-gate')

  // B goes: A, served and unblocked, does not keep R.
  const mod = moderator(assoc)
  const snapshot = createSnapshot({ seq: 1, blocked: [B.key], revokedIssuers: [] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist: snapshot })
  await rejected(events, R, 'unbound')
  t.ok(seeder._served.has(A.key), 'A still served')
  await until(async () => seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(seeder, R)), { name: 'R purgado' })
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('blocking a group\'s creator drops the root; members\' writers stay', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)

  const mod = moderator(assoc)
  const snapshot = createSnapshot({ seq: 1, blocked: [A.key], revokedIssuers: [] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist: snapshot })
  await rejected(events, R, 'blocked')
  await until(async () => seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(seeder, R)), { name: 'R purgado' })
  t.ok(seeder._groupServed.has(W), 'W kept')
  t.alike(Object.keys(readGroups(dataDir)), [W])
  // The root's verified header may stay on the page while W is served
  // (seeder-groups-waits.test.js), never as served nor with its creator.
  const page = seeder.indexGroup(R)
  t.is(page.rootServed, false, 'the root is no longer served')
  t.is(page.header && page.header.diary, null, 'and no creator is named')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('roots a diary\'s joins admitted stay charged to it after it withdraws; past the budget it gets group-full and others still admit', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let R1 = null
  let R2 = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R1 = await make('r1', groupHeader({ diary: key, name: 'Um' }))
    R2 = await make('r2', groupHeader({ diary: key, name: 'Dois' }))
    return [groupJoinRecord({ group: R1, writer: R1, on: true })]
  })
  await admit(B, assoc)
  await admitted(events, R1)
  t.is(readGroups(dataDir)[R1].by, B.key, 'charged to the diary whose join admitted it')
  await B.diary.append(groupJoinRecord({ group: R1, writer: R1, on: false }))
  await until(() => scansDone(seeder) && seeder._served.get(B.key).scanned === B.diary.length, { name: 'B saiu de R1' })
  t.ok(seeder._groups.has(R1), 'R1 kept after the withdrawal')
  t.is(seeder._diaryGroupCores(B.key, R2).roots, 1, 'still charged to B')

  // As if B had looped create/join/withdraw: its root budget is used up.
  for (let i = 1; i < 64; i++) {
    const k = (0x1000 + i).toString(16).padStart(64, '0')
    seeder._groups.set(k, { diary: B.key, group: k, seq: 1, by: B.key })
  }
  await B.diary.append(groupJoinRecord({ group: R2, writer: R2, on: true }))
  await rejected(events, R2, 'group-full')
  t.absent(seeder._groups.has(R2))

  let R3 = null
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R3 = await make('r3', groupHeader({ diary: key, name: 'Três' }))
    return [groupJoinRecord({ group: R3, writer: R3, on: true })]
  })
  await admit(C, assoc)
  await admitted(events, R3)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('one diary\'s joins never run more than two group admissions at once', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // Ten joins, each a writer and a group nobody holds: twenty fetches that
  // can only time out.
  const joins = []
  for (let i = 0; i < 10; i++) joins.push(groupJoinRecord({ group: hex(signingKeyPair().publicKey), writer: hex(signingKeyPair().publicKey), on: true }))
  let peak = 0
  let calls = 0
  const original = seeder._admitGroupReserved.bind(seeder)
  seeder._admitGroupReserved = (diary, ...rest) => {
    calls++
    peak = Math.max(peak, seeder._diaryGroupInflight(diary))
    return original(diary, ...rest)
  }
  const B = await member(t, bootstrap, assoc, async () => joins)
  await admit(B, assoc)
  await until(() => events.filter((e) => e.event === 'group-rejected' && e.reason === 'timeout').length >= 3, { name: 'segunda leva', timeoutMs: 60000 })
  t.ok(calls > 2, 'the waiting joins ran once a slot freed')
  t.is(peak, 2, 'never more than two at once')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('blocking a diary purges the root it bound, never one that only names it', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // T bound R2 with its own join; R1 names T but T never joined it.
  let R2 = null
  const T = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R2 = await make('root', groupHeader({ diary: key, name: 'De T' }))
    return [groupJoinRecord({ group: R2, writer: R2, on: true })]
  })
  let R1 = null
  let W2 = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R1 = await make('alheia', groupHeader({ diary: T.key, name: 'Alheia' }))
    W2 = await make('w2', writerHeader({ group: R2, diary: key }))
    return [groupJoinRecord({ group: R1, writer: R1, on: true }), groupJoinRecord({ group: R2, writer: W2, on: true })]
  })
  await admit(T, assoc)
  await admit(B, assoc)
  for (const k of [R1, R2, W2]) await admitted(events, k)
  await until(() => readGroups(dataDir)[R2] && readGroups(dataDir)[R2].bound === true && scansDone(seeder), { name: 'R2 vinculado' })
  t.absent(readGroups(dataDir)[R1].bound, 'R1 never bound by T')

  const mod = moderator(assoc)
  const snapshot = createSnapshot({ seq: 1, blocked: [T.key], revokedIssuers: [] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist: snapshot })
  await rejected(events, R2, 'blocked')
  await until(async () => seeder._drops.size === 0 && !(R2 in readGroups(dataDir)), { name: 'R2 purgado' })
  t.ok(seeder._groupServed.has(R1), 'R1 kept: it only names T')
  t.ok(R1 in readGroups(dataDir))
  t.absent(events.some((e) => e.event === 'group-rejected' && e.key === R1), 'R1 never dropped')
  t.is(seeder.indexGroup(R1).header.diary, null, 'and has no creator')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a diary waiting for an admission slot takes its turn before diaries flooding unservable joins', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxGroupInflight: 2 })

  // Fetches end only when the test releases them, oldest first, so the
  // order slots are handed out in is visible.
  const pending = []
  seeder._admitGroupReserved = (diary) => new Promise((resolve) => pending.push({ diary, resolve }))
  // Three diaries, each with eight joins naming cores nobody holds.
  const flood = () => {
    const joins = []
    for (let i = 0; i < 8; i++) joins.push(groupJoinRecord({ group: hex(signingKeyPair().publicKey), writer: hex(signingKeyPair().publicKey), on: true }))
    return joins
  }
  for (let i = 0; i < 3; i++) {
    const F = await member(t, bootstrap, assoc, async () => flood())
    await admit(F, assoc)
  }
  await until(() => seeder._groupReserved.size === 2 && seeder._groupDeferred.size >= 2 && scansDone(seeder), { name: 'vagas cheias' })
  let R = null
  const H = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Honesta' }))
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  await admit(H, assoc)
  await until(() => seeder._groupDeferred.has(H.key) && scansDone(seeder), { name: 'H esperando' })
  let turn = false
  for (let i = 0; i < 10 && !turn; i++) {
    pending.shift().resolve()
    await new Promise((resolve) => setImmediate(resolve))
    turn = pending.some((p) => p.diary === H.key)
  }
  t.ok(turn, 'the honest diary got a slot within ten releases')
  // Real fetches again, which close() can end.
  delete seeder._admitGroupReserved
  for (const p of pending.splice(0)) p.resolve()
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a seeder at maxGroupCores answers a group with a refused writer as incomplete', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxGroupCores: 1 })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 2)
  await admit(B, assoc)
  await rejected(events, W, 'group-full')
  await until(() => scansDone(seeder), { name: 'varreduras' })
  t.is(seeder.indexGroup(R).complete, false, 'W is missing for the seeder\'s own capacity')
  t.is(seeder.indexGroups(B.key).complete, false, 'and B\'s group list says so')
  t.is(seeder.indexGroupSearch('cadeiras').complete, false, 'and so does search')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('pages are incomplete while a live join waits for an admission slot', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxGroupInflight: 1 })

  // F holds the only slot with a root nobody serves.
  const G = hex(signingKeyPair().publicKey)
  const F = await member(t, bootstrap, assoc, async () => [groupJoinRecord({ group: G, writer: G, on: true })])
  await admit(F, assoc)
  await until(() => seeder._groupReserved.has(G), { name: 'vaga ocupada' })
  let R = null
  const H = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Espera' }))
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  await admit(H, assoc)
  await until(() => seeder._groupDeferred.has(H.key) && scansDone(seeder), { name: 'H esperando' })
  t.is(seeder.indexGroup(R).complete, false, 'the group page waits for the deferred join')
  t.is(seeder.indexGroups(H.key).complete, false, 'and so does H\'s group list')
  await admitted(events, R)
  await downloaded(seeder, R, 1)
  await until(() => seeder.indexGroup(R).complete, { name: 'R completo' })
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('revoking the issuer of a group creator\'s certificate drops the root even while a member keeps the group', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { issuer, A, B, R, W } = await issuedCreatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)

  const mod = moderator(assoc)
  const snapshot = createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist: snapshot })
  await rejected(events, R, 'revoked-issuer')
  await until(async () => seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(seeder, R)), { name: 'R purgado' })
  t.ok(seeder._groupServed.has(W), 'W kept')

  // B's join for R does not bring it back while A stays revoked.
  const refusals = () => events.filter((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'revoked-issuer').length
  const before = refusals()
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await until(() => refusals() > before, { name: 'R recusado de novo' })
  t.absent(seeder._groups.has(R), 'R not admitted again')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a restart purges the root of a creator refused for a revoked issuer, even while a member keeps the group', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { issuer, A, B, R, W } = await issuedCreatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, R)
  await admitted(first.events, W)
  await downloaded(first.seeder, R, 2)
  await downloaded(first.seeder, W, 1)
  await first.seeder.close()
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert))

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.ok(second.events.some((e) => e.event === 'rejected' && e.key === A.key && e.reason === 'revoked-issuer'), 'A refused at start')
  t.ok(second.events.some((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'revoked-issuer'), 'R purged at start')
  t.absent(R in readGroups(dataDir))
  t.ok(W in readGroups(dataDir), 'W kept')
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a join refused for good after a first timeout no longer keeps answers incomplete', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const B = await member(t, bootstrap, assoc, async () => [])
  await admit(B, assoc)
  const root = B.store.get({ name: 'later' })
  await root.ready()
  const R = hex(root.key)
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await rejected(events, R, 'timeout')
  t.is(seeder.indexGroups(B.key).complete, false, 'missed once: incomplete')
  // Block 0 arrives but is no group header: the timer's retry refuses it.
  await root.append(encode({ type: 'nada' }))
  await rejected(events, R, 'header-invalid')
  await until(() => seeder._groupReserved.size === 0 && scansDone(seeder), { name: 'R julgado' })
  t.is(seeder.indexGroups(B.key).complete, true, 'B\'s group list is final again')
  t.is(seeder.indexGroupSearch('qualquer').complete, true, 'and so is search')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root purged for a revoked creator stays refused after a restart, through a surviving member\'s join', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { issuer, A, B, R, W } = await issuedCreatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, R)
  await admitted(first.events, W)
  const mod = moderator(assoc)
  const snapshot = createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist: snapshot })
  await rejected(first.events, R, 'revoked-issuer')
  await until(async () => first.seeder._drops.size === 0 && !(R in readGroups(dataDir)), { name: 'R purgado' })
  t.alike(readFile(dataDir).revokedCreators, { [A.key]: issuer.hex }, 'the revoked creator is kept with its issuer')
  t.alike(readFile(dataDir).goneRoots, { [R]: { creator: A.key, issuer: issuer.hex } }, 'and the root it lost, with the issuer that condemned it')
  await first.seeder.close()

  // A restart, then B (still a member) joins R by its own key.
  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await admit(B, assoc)
  await rejected(second.events, R, 'revoked-issuer')
  t.absent(second.seeder._groups.has(R), 'R not admitted again')
  t.absent(second.events.some((e) => e.event === 'group-admitted' && e.key === R))
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('groupPostBlock: the validated group-post of a served writer or root, null otherwise', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Praia' }), [groupPost({ text: 'oi' })])
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: R, diary: key }), [
      groupPost({ text: 'olá' }),
      groupPost({ text: 'tudo bem?', replyTo: { writer: R, seq: 1 } }),
      { type: 'group-leave', seen: null, cuts: [], at: new Date().toISOString() }
    ])
    return [groupJoinRecord({ group: R, writer: W, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await downloaded(seeder, R, 2)
  await downloaded(seeder, W, 4)

  t.alike(await seeder.groupPostBlock(W, 2), { group: R, diary: B.key, seq: 2, texto: 'tudo bem?', resposta: { writer: R, seq: 1 } })
  t.alike(await seeder.groupPostBlock(R, 1), { group: R, diary: A.key, seq: 1, texto: 'oi', resposta: null }, 'the root names its creator')
  t.is(await seeder.groupPostBlock(W, 3), null, 'not a group-post')
  t.is(await seeder.groupPostBlock(W, 0), null, 'block 0 is the header')
  t.is(await seeder.groupPostBlock(W, 9), null, 'past the length')
  t.is(await seeder.groupPostBlock('f'.repeat(64), 1), null, 'not served')
  t.is(await seeder.groupPostBlock(B.key, 1), null, 'a diary is no group core')
  t.is(await seeder.groupPostBlock('zz', 1), null, 'malformed key')

  // B blocked: its writer is dropped and answers nothing.
  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [B.key], revokedIssuers: [] }, mod.kp, mod.cert) })
  await rejected(events, W, 'blocked')
  t.is(await seeder.groupPostBlock(W, 2), null, 'a blocked member\'s writer')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('revoked-issuer announces are not recorded, and a replay from one peer counts as bad', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxBadAnnounces: 2 })
  const issuer = makeIssuer(assoc)
  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert) })
  await until(() => events.find((e) => e.event === 'blocklist'), { name: 'lista adotada' })

  const D = hex(signingKeyPair().publicKey)
  const cert = createIssuedCert({ member: D }, issuer.kp, issuer.cert)
  const peer = fakePeer()
  await seeder.admit(D, cert, peer)
  t.ok(peer.sent.some((m) => m.type === 'rejected' && m.reason === 'revoked-issuer'))
  t.is(seeder._revokedCreators.size, 0, 'and no moderation entry from an announce')
  t.absent(readFile(dataDir).revokedCreators, 'admitted.json not written for it')
  t.absent(peer.seederDropped, 'a first refusal is no misbehaviour')
  await seeder.admit(D, cert, peer)
  await seeder.admit(D, cert, peer)
  t.ok(peer.seederDropped, 'replays of the same key from one peer drop it')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('4097 minted revoked-issuer announces do not resurrect a root purged for its revoked creator', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { issuer, A, B, R, W } = await issuedCreatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert) })
  await rejected(events, R, 'revoked-issuer')
  await until(async () => seeder._drops.size === 0 && !(R in readGroups(dataDir)), { name: 'R purgado' })

  // Anyone holding the revoked issuer's key can mint certificates for keys
  // of its choosing and announce them.
  for (let i = 0; i < 4097; i++) {
    const key = hex(signingKeyPair().publicKey)
    seeder.admit(key, createIssuedCert({ member: key }, issuer.kp, issuer.cert), fakePeer())
  }
  t.alike(readFile(dataDir).goneRoots, { [R]: { creator: A.key, issuer: issuer.hex } }, 'the purge evidence is intact')
  const refusals = () => events.filter((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'revoked-issuer').length
  const before = refusals()
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await until(() => refusals() > before, { name: 'R recusado' })
  t.absent(seeder._groups.has(R), 'R not admitted again')
  t.absent(events.some((e) => e.event === 'group-admitted' && e.key === R && events.indexOf(e) > 0 && e !== events.find((x) => x.event === 'group-admitted' && x.key === R)), 'never re-admitted')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a minted revoked-issuer announce naming a bound root\'s creator neither purges the root nor refuses a fresh one', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })
  const issuer = makeIssuer(assoc)
  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert) })
  await until(() => events.find((e) => e.event === 'blocklist'), { name: 'lista adotada' })

  // Whoever holds the revoked issuer's key signs a certificate naming A.
  const peer = fakePeer()
  await seeder.admit(A.key, createIssuedCert({ member: A.key }, issuer.kp, issuer.cert), peer)
  t.ok(peer.sent.some((m) => m.type === 'rejected' && m.reason === 'revoked-issuer'))
  // A then leaves for a reason that is no revocation, and a sweep runs.
  seeder._drop(A.key, 'quota')
  await until(() => seeder._drops.size === 0, { name: 'A purgado' })
  seeder._dropUnsupportedRoots()
  t.ok(seeder._groupServed.has(R), 'R still served')
  t.ok(R in readGroups(dataDir), 'and listed')
  t.absent(readFile(dataDir).goneRoots, 'no goneRoots entry')
  t.absent(events.some((e) => e.event === 'group-rejected' && e.key === R), 'R never refused')

  // A fresh root naming A is admitted through B's join.
  const fresh = B.store.get({ name: 'fresh' })
  await fresh.ready()
  await fresh.append(encode(groupHeader({ diary: A.key, name: 'Nova' })))
  const R2 = hex(fresh.key)
  await B.diary.append(groupJoinRecord({ group: R2, writer: R2, on: true }))
  await admitted(events, R2)
  t.absent(events.some((e) => e.event === 'group-rejected' && e.key === R2), 'R2 never refused')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a restart forgets a revoked issuer of a creator whose certificate now verifies, and keeps its bound root', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // A's certificate is the association's own; an older one came from an
  // issuer that is revoked.
  const { A, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admitted(first.events, R)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })
  await downloaded(first.seeder, R, 2)
  await first.seeder.close()
  const issuer = makeIssuer(assoc)
  const file = readFile(dataDir)
  file.revokedCreators = { [A.key]: issuer.hex }
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify(file))
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert))

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.absent(second.events.some((e) => e.event === 'group-rejected' && e.key === R), 'R kept')
  t.ok(R in readGroups(dataDir))
  t.absent(readFile(dataDir).revokedCreators, 'the stale entry is gone')
  t.ok(W, 'member fixture')
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('the revoked creator recorded is the issuer of the certificate in its log, not of the one it announced: its bound root is purged and stays refused after a restart', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const IA = makeIssuer(assoc)
  const IB = makeIssuer(assoc)
  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Duas emissoras' }), [groupPost({ text: 'oi' })])
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  }, { certOf: (key) => createIssuedCert({ member: key }, IA.kp, IA.cert) })
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: R, diary: key }))
    return [groupJoinRecord({ group: R, writer: W, on: true })]
  })
  // A's log holds IA's certificate; its announce carries a valid one from IB.
  const peer = await A.seederPeer()
  peer.send({ type: 'announce', key: A.key, cert: createIssuedCert({ member: A.key }, IB.kp, IB.cert) })
  await until(() => A.messages.find((x) => x.type === 'have' && x.key === A.key && x.length === A.diary.length), { name: 'have A' })
  await admit(B, assoc)
  await admitted(first.events, R)
  await admitted(first.events, W)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })

  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [], revokedIssuers: [IA.hex] }, mod.kp, mod.cert) })
  await until(() => first.events.find((e) => e.event === 'rejected' && e.key === A.key && e.reason === 'revoked-issuer'), { name: 'A revogado' })
  await rejected(first.events, R, 'revoked-issuer')
  await until(async () => first.seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(first.seeder, R)), { name: 'R purgado' })
  t.alike(readFile(dataDir).revokedCreators, { [A.key]: IA.hex }, 'the issuer of the certificate in A\'s log is kept')
  t.ok(first.seeder._groupServed.has(W), 'W kept')
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await admit(B, assoc)
  await rejected(second.events, R, 'revoked-issuer')
  t.absent(second.seeder._groups.has(R), 'R not admitted again')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a creator both blocked and from a revoked issuer keeps its bound root refused once only the block is lifted, also after a restart', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { issuer, A, B, R, W } = await issuedCreatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, R)
  await admitted(first.events, W)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })

  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [A.key], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert) })
  await until(() => first.events.find((e) => e.event === 'rejected' && e.key === A.key && e.reason === 'blocked'), { name: 'A bloqueado' })
  await rejected(first.events, R, 'blocked')
  await until(async () => first.seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(first.seeder, R)), { name: 'R purgado' })
  await until(() => {
    const gone = readFile(dataDir).goneRoots
    return gone && gone[R] && gone[R].issuer === issuer.hex
  }, { name: 'emissora revogada de A anotada' })
  t.alike(readFile(dataDir).revokedCreators, { [A.key]: issuer.hex }, 'the revoked issuer of A\'s block-0 certificate is kept')

  // Only the block is lifted: the issuer stays revoked.
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 2, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert) })
  await until(() => first.events.find((e) => e.event === 'blocklist' && e.seq === 2), { name: 'lista 2 adotada' })
  const refusals = (events) => events.filter((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'revoked-issuer').length
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await until(() => refusals(first.events) > 0, { name: 'R recusado com o bloqueio retirado' })
  t.absent(first.seeder._groups.has(R), 'R not admitted again')
  t.ok(first.seeder._groupServed.has(W), 'W kept')
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  // B's join may already be local (the first seeder fetched it while
  // closing, so no 'have' for that length ever comes): only reconnect.
  const peer = await B.seederPeer()
  peer.send({ type: 'announce', key: B.key, cert: B.certOf(B.key) })
  await until(() => refusals(second.events) > 0, { name: 'R recusado depois de reiniciar' })
  t.absent(second.seeder._groups.has(R), 'R not admitted again after a restart')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root its dropped creator bound stays listed under that creator while a member keeps it, so a report on a root post can be confirmed, also after a restart', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, R)
  await admitted(first.events, W)
  await downloaded(first.seeder, R, 2)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })

  const confirmed = async (seeder, label) => {
    const row = seeder.indexGroup(R).writers.find((w) => w.key === R)
    t.ok(row, label + ': the page lists the root')
    t.is(row && row.diary, A.key, label + ': under the diary that bound it')
    t.ok(row && row.length > 1, label + ': with its post')
    const post = await seeder.groupPostBlock(R, 1)
    t.alike(post && { group: post.group, diary: post.diary, texto: post.texto }, { group: R, diary: A.key, texto: 'oi' }, label + ': the root post reads back')
  }
  await confirmed(first.seeder, 'served creator')

  // A leaves for a reason that is no moderation; B's live join keeps R.
  first.seeder._drop(A.key, 'quota')
  await until(() => first.seeder._drops.size === 0, { name: 'A purgado' })
  t.ok(first.seeder._groupServed.has(R), 'R still served')
  await confirmed(first.seeder, 'creator dropped')
  t.is(first.seeder.indexGroup(R).header.diary, null, 'no creator is shown for a gone diary')
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.ok(second.seeder._groupServed.has(R), 'R served after the restart')
  await confirmed(second.seeder, 'after a restart')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a full map of denials in force evicts none: the new creator\'s bound root is still purged and no root is admitted while the map stays full', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { issuer, A, B, R, W } = await issuedCreatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })
  // 4096 earlier denials, all in force once the issuer is revoked.
  const fill = []
  for (let i = 0; i < 4096; i++) {
    const d = hex(signingKeyPair().publicKey)
    seeder._revokedCreators.set(d, issuer.hex)
    fill.push(d)
  }
  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert) })
  await rejected(events, R, 'revoked-issuer')
  await until(async () => seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(seeder, R)), { name: 'R purgado' })
  t.ok(fill.every((d) => seeder._revokedCreators.get(d) === issuer.hex), 'no denial in force was evicted')
  t.is(seeder._revokedCreators.get(A.key), issuer.hex, 'and the new one is kept')
  t.ok(Object.keys(readFile(dataDir).revokedCreators).length <= 8192, 'admitted.json stays bounded')

  // R through B's own join: refused.
  const refusals = () => events.filter((e) => e.event === 'group-rejected' && e.key === R).length
  const before = refusals()
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await until(() => refusals() > before, { name: 'R recusado' })
  t.absent(seeder._groups.has(R), 'the purged root is not admitted again')

  // Any root, while the map is full of denials in force (fail closed).
  const fresh = B.store.get({ name: 'fresh' })
  await fresh.ready()
  await fresh.append(encode(groupHeader({ diary: B.key, name: 'Nova' })))
  const R2 = hex(fresh.key)
  await B.diary.append(groupJoinRecord({ group: R2, writer: R2, on: true }))
  await rejected(events, R2, 'denials-full')
  t.absent(seeder._groups.has(R2), 'a fresh root is refused')
  t.ok(events.some((e) => e.event === 'warning' && e.reason === 'denials-full'), 'logged as a warning')

  // Lifted denials go first: room again opens the gate.
  for (const d of fill) seeder._revokedCreators.set(d, hex(signingKeyPair().publicKey))
  t.is(seeder._rootsClosed(), false, 'denials no longer in force do not hold roots back')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a group core whose block 0 is withheld from the main store after the quarantine check is dropped at the gate timeout and backs off, so its group settles', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const hold = gate()
  const headerMs = 1500
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    groupHeaderTimeoutMs: headerMs,
    admitHook: (key, step) => step === 'open' ? hold.hook(key) : undefined
  })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 2)
  hold.key = W
  await admit(B, assoc)
  await until(() => hold.entered, { name: 'W passou pela quarentena' })
  // B served block 0 to the quarantine and now withholds it.
  await B.cores.w.clear(0, 1)
  hold.open()
  await admitted(events, W)
  t.absent(seeder._groupServed.get(W).headerOk, 'W waits for its block 0')
  t.is(seeder.indexGroup(R).complete, false, 'incomplete while W waits')
  const from = Date.now()
  await rejected(events, W, 'timeout')
  t.ok(Date.now() - from >= headerMs - 500, 'dropped at the deadline')
  await until(async () => !seeder._drops.has(W) && !(W in readGroups(dataDir)) && !(await stored(seeder, W)), { name: 'W purgado' })
  const id = B.key + ':' + W
  t.is(seeder._groupBackoff.get(id).reason, 'timeout', 'its join backs off')
  await until(() => seeder._groupBackoff.get(id).step >= 1, { name: 'segunda espera de W', timeoutMs: 40000 })
  await until(() => seeder.indexGroup(R).complete && scansDone(seeder), { name: 'R completo', timeoutMs: 40000 })
  t.is(seeder.indexGroupSearch('cadeiras').complete, true, 'group search settles too')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a creator\'s later join naming its root key as a writer of another group keeps the root bound: listed under the creator, confirmable, and purged when the creator is blocked', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // A binds R, then H, then names R as a writer of H (on:true).
  let R = null
  let H = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Cadeiras da praia' }), [groupPost({ text: 'oi' })])
    H = await make('outra', groupHeader({ diary: key, name: 'Outra' }))
    return [
      groupJoinRecord({ group: R, writer: R, on: true }),
      groupJoinRecord({ group: H, writer: H, on: true }),
      groupJoinRecord({ group: H, writer: R, on: true })
    ]
  })
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: R, diary: key }), [groupPost({ text: 'olá' })])
    return [groupJoinRecord({ group: R, writer: W, on: true })]
  })
  // B's join admits R first: A's join of R into H can then never admit it
  // as a writer of H.
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await downloaded(seeder, R, 2)
  await admit(A, assoc)
  await admitted(events, H)
  await until(() => scansDone(seeder) && readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado apesar da junção em H' })

  const row = seeder.indexGroup(R).writers.find((w) => w.key === R)
  t.ok(row, 'the page lists the root')
  t.is(row && row.diary, A.key, 'under the creator')
  t.is(row && row.seq, 1, 'with the creator\'s own (R, R) join')
  t.is(seeder.indexGroup(R).header.diary, A.key, 'the creator is shown')
  const post = await seeder.groupPostBlock(R, 1)
  t.alike(post && { group: post.group, diary: post.diary, texto: post.texto }, { group: R, diary: A.key, texto: 'oi' }, 'a root post is confirmable')

  const mod = moderator(assoc)
  const snapshot = createSnapshot({ seq: 1, blocked: [A.key], revokedIssuers: [] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist: snapshot })
  await rejected(events, R, 'blocked')
  await until(() => seeder._drops.size === 0 && !(R in readGroups(dataDir)), { name: 'R purgado' })
  t.absent(seeder._groupServed.has(R), 'the root is purged although B still joins it')
  t.is(seeder._goneRoots.get(R) && seeder._goneRoots.get(R).creator, A.key, 'goneRoots records the creator')
  t.is(readFile(dataDir).goneRoots && readFile(dataDir).goneRoots[R] && readFile(dataDir).goneRoots[R].creator, A.key, 'and persists it')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root creator dropped for quota while a member keeps the root is purged once its issuer is revoked, and stays refused after a restart', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { issuer, A, B, R, W } = await issuedCreatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, R)
  await admitted(first.events, W)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true && readGroups(dataDir)[R].issuer === issuer.hex, { name: 'R vinculado com o emissor' })

  // A leaves for a reason that is no moderation; B's join keeps R.
  first.seeder._drop(A.key, 'quota')
  await until(() => first.seeder._drops.size === 0, { name: 'A purgado' })
  t.ok(first.seeder._groupServed.has(R), 'R still served')

  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert) })
  await rejected(first.events, R, 'revoked-issuer')
  await until(async () => first.seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(first.seeder, R)), { name: 'R purgado' })
  t.ok(first.seeder._groupServed.has(W), 'W kept')
  t.alike(readFile(dataDir).goneRoots, { [R]: { creator: A.key, issuer: issuer.hex } }, 'the purged root is kept with its creator\'s issuer')
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await admit(B, assoc)
  await rejected(second.events, R, 'revoked-issuer')
  t.absent(second.seeder._groups.has(R), 'R not admitted again')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})
