'use strict'

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
const { Seeder, GroupBindings, MAX_GROUP_NOTICE_BYTES } = require('../lib/seeder')
const { createGroupHintBudget, UNKNOWN, GROUP_HINT_BLOCK_BYTES, GROUP_HINT_ENTRY_BYTES, GROUP_HINT_REFERENCE_BYTES } = require('../lib/group-notice')
const { createIssuedCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writeBlocklist } = require('../lib/store')
const { groupJoinRecord } = require('../lib/records')
const { groupPost, groupMeta, groupImage } = require('../lib/group')
const { groupHeader, writerHeader } = require('./helpers/seeder-groups')
const {
  hex,
  makeAssociation,
  readFile,
  readGroups,
  prepareSeederDir,
  startSeeder,
  onPassesStart,
  encode,
  member,
  admit,
  reader,
  admitted,
  rejected,
  stubbed,
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

test('root image scanning and public hints use validated records and settled bindings', async (t) => {
  const seeder = new Seeder({})
  seeder._passesStarted = true
  const diary = 'aa'.repeat(32)
  const root = 'bb'.repeat(32)
  const image = { core: 'dc'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 100, sha256: 'dd'.repeat(32), width: 512, height: 512 }
  const blocked = new Set()
  seeder._blocklist = { blocked: () => blocked }
  seeder._admitted.set(diary, {})
  seeder._served.set(diary, { gated: true, scanned: 1, core: { length: 1, contiguousLength: 1 } })
  for (const kind of ['group', 'community']) {
    const records = [groupHeader({ kind, diary, name: 'Praia' }),
      groupPost({ text: 'group-image' }),
      { ...groupImage({ image }), image: { ...image, mime: 'image/png' } }]
    const core = {
      get length () { return records.length },
      get contiguousLength () { return records.length },
      async get (i) { return encode(records[i]) }
    }
    const entry = { group: root, headerOk: true, rootScanned: 0, rootDecoded: 0, core }
    seeder._groupServed.set(root, entry)
    seeder._groupIndex.setHeader(root, records[0])
    seeder._groupIndex.addWriter(root, root, diary, 1)
    const scan = async () => {
      seeder._scanRoot(root, entry)
      await until(() => !entry.rootScanning, { name: 'varredura em memória' })
    }
    await scan()
    t.is(seeder.groupImagePublic(root), null, 'a needle in a post and an invalid image never fold')
    records.push(groupImage({ image }))
    await scan()
    t.alike(seeder.groupImagePublic(root), { image, author: diary }, kind + ' image passed the byte and record filters')
    const groupAnswer = JSON.stringify(seeder.indexGroup(root))
    const communityAnswer = JSON.stringify(seeder.indexCommunity(root))
    seeder._groupIndex.resetRoot(root)
    t.is(seeder.groupImagePublic(root), null)
    t.is(JSON.stringify(seeder.indexGroup(root)), groupAnswer, 'group answer bytes unchanged')
    t.is(JSON.stringify(seeder.indexCommunity(root)), communityAnswer, 'community answer bytes unchanged')
    entry.rootScanned = 0
    await scan()
    t.alike(seeder.groupImagePublic(root), { image, author: diary }, 'rescan restores the image')
    entry.rootScanned--
    t.is(seeder.groupImagePublic(root), null, 'scan behind')
    entry.rootScanned++
    entry.headerOk = false
    t.is(seeder.groupImagePublic(root), null, 'unverified')
    entry.headerOk = true
    const unrelated = 'ac'.repeat(32)
    seeder._served.set(unrelated, { gated: true, scanned: 1, core: { length: 2, contiguousLength: 2 } })
    t.ok(seeder._groupIncomplete(root), 'an unrelated diary join scan keeps writer pages incomplete')
    const name = kind === 'group' ? seeder.indexGroup(root).header.name : seeder.indexCommunity(root).name
    t.is(name, 'Praia', 'the indexed name stays visible')
    t.alike(seeder.groupImagePublic(root), { image, author: diary }, 'the indexed image stays visible too')
    seeder._served.delete(unrelated)
    blocked.add(root)
    t.is(seeder.groupImagePublic(root), null, 'blocked root')
    blocked.delete(root)
    blocked.add(diary)
    t.is(seeder.groupImagePublic(root), null, 'blocked author')
    blocked.delete(diary)
    seeder._groupIndex.removeWriter(root)
    t.is(seeder.groupImagePublic(root), null, 'a served header diary without its own binding is not the author')
    seeder._groupIndex.addWriter(root, root, diary, 1)
    t.alike(seeder.groupImagePublic(root), { image, author: diary }, 'the settled bound root is visible again')
    records.push(groupImage({ image: null }))
    await scan()
    t.is(seeder.groupImagePublic(root), null, 'clear')
  }
  seeder._groupIndex.setHeader(root, groupHeader({ diary, visibility: 'private', join: 'approval', name: null, box: 'ee'.repeat(32) }))
  const entry = seeder._groupServed.get(root)
  entry.rootScanned = 0
  entry.core.get = () => { throw new Error('private root read') }
  seeder._scanRoot(root, entry)
  t.is(entry.rootScanned, 0, 'a private root stays unscanned')
  t.is(seeder.groupImagePublic(root), null, 'private root')
  for (const key of [null, undefined, {}, Symbol('root'), 'invalid', 'ff'.repeat(32)]) {
    t.is(seeder.groupImagePublic(key), null, 'unknown or malformed root never throws')
  }
})

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
  // Each can never count for (R, C): kept as a header stub (#350), block 0
  // alone, listed only to peers that announce CAP_HEADER_STUBS.
  await stubbed(events, wrongDiary, 'wrong-diary')
  await stubbed(events, wrongGroup, 'wrong-group')
  t.is(listedAt[R], true, 'R listed before it is served')
  t.is(listedAt[W], true, 'W listed before it is served')
  const listed = readGroups(dataDir)
  // R is charged to whichever join admitted it: A's own or B's.
  t.ok([A.key, B.key].includes(listed[R].by), 'R charged to a joining diary')
  delete listed[R].by
  t.is(listed[R].bound, true, 'A bound R with its own join')
  delete listed[R].bound
  t.alike(listed, { [R]: { diary: A.key, group: R, seq: 1, first: 1 }, [W]: { diary: B.key, group: R, seq: 1 } })
  t.is(await stored(seeder, wrongDiary), true)
  t.is(await stored(seeder, wrongGroup), true)
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
  t.alike(readGroups(dataDir)[R], { diary: A.key, group: R, seq: 1, by: B.key, bound: true, first: 1 }, 'charged to B, whose join admitted it; bound by A')
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

  let passesAt = -1
  const second = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    beforeStart: (seeder, events) => onPassesStart(seeder, () => { passesAt = events.length })
  })
  await until(() => second.seeder._groupRootStartup === null && scansDone(second.seeder), { name: 'varreduras de início' })
  t.absent(second.events.some((e) => e.event === 'group-rejected' && e.key === R), 'R never dropped')
  t.ok(second.seeder._groupServed.has(R), 'R served')
  t.ok(R in readGroups(dataDir), 'R still listed')
  t.ok(await stored(second.seeder, R), 'R still stored')
  const gone = await rejected(second.events, R2, 'unbound')
  t.ok(passesAt >= 0 && second.events.indexOf(gone) >= passesAt, 'R2 judged only after the start scans')
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
  const marked = readFile(dataDir)
  marked.denialsLost = true
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify(marked))

  const list = await Seeder.list(dataDir, assoc.hex)
  const byKey = Object.fromEntries(list.admitted.map((e) => [e.key, e]))
  t.alike(byKey[A.key].groups, [{ key: R, group: R, length: 2, byteLength: A.cores.root.byteLength }])
  t.alike(byKey[B.key].groups, [{ key: W, group: R, length: 3, byteLength: B.cores.w.byteLength }])
  t.alike(byKey[A.key].media, [])

  t.alike(await Seeder.drop(dataDir, assoc.hex, W), { key: W })
  t.alike(Object.keys(readGroups(dataDir)), [R])
  t.is(readFile(dataDir).denialsLost, true, 'the drop keeps the lost-denial mark')
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
  t.alike(readFile(dataDir).goneRoots, { [R]: { creator: A.key, issuer: issuer.hex, first: 1 } }, 'and the root it lost, with the issuer that condemned it')
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
  t.alike(readFile(dataDir).goneRoots, { [R]: { creator: A.key, issuer: issuer.hex, first: 1 } }, 'the purge evidence is intact')
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
  t.alike(readFile(dataDir).goneRoots, { [R]: { creator: A.key, issuer: issuer.hex, first: 1 } }, 'the purged root is kept with its creator\'s issuer')
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await admit(B, assoc)
  await rejected(second.events, R, 'revoked-issuer')
  t.absent(second.seeder._groups.has(R), 'R not admitted again')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a public group renamed by its root is found by the new name only', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Cadeiras da praia' }), [groupPost({ text: 'oi' }), groupMeta({ name: 'Guarda-sois', join: 'open' })])
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  await admit(A, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 3)
  await until(() => {
    const e = seeder._groupServed.get(R)
    return !e.rootScanning && e.rootScanned === 3 && seeder.indexGroupSearch('guarda').complete
  }, { name: 'raiz varrida' })
  t.alike(seeder.indexGroupSearch('guarda').groups.map((r) => [r.group, r.name]), [[R, 'Guarda-sois']], 'found by the new name')
  t.alike(seeder.indexGroupSearch('cadeiras').groups, [], 'not by the old one')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a rename appended after admission is picked up, and a null rename clears the name', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Cadeiras da praia' }), [groupPost({ text: 'oi' })])
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  await admit(A, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 2)
  await until(() => seeder.indexGroupSearch('cadeiras').complete && seeder.indexGroupSearch('cadeiras').groups.length === 1, { name: 'nome antigo' })

  await A.cores.root.append(b4a.from(JSON.stringify(groupMeta({ name: 'Guarda-sois', join: 'open' }))))
  await until(() => seeder.indexGroupSearch('guarda').groups.length === 1, { name: 'nome novo' })
  t.alike(seeder.indexGroupSearch('cadeiras').groups, [], 'the old name is gone')
  t.is(seeder.indexGroup(R).header.name, 'Guarda-sois', 'the group answer has the new name')

  await A.cores.root.append(b4a.from(JSON.stringify(groupMeta({ name: null, join: 'open' }))))
  await until(() => seeder.indexGroupSearch('guarda').groups.length === 0, { name: 'nome limpo' })
  t.alike(seeder.indexGroupSearch('cadeiras').groups, [], 'not found by the header name either')
  t.is(seeder.indexGroup(R).header.name, null)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('public group root scans run one at a time and decode only blocks that contain group-meta', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const posts = []
  for (let i = 0; i < 20; i++) posts.push(groupPost({ text: 'post ' + i }))
  // A post that merely mentions the word passes the prefilter, and the validator drops it.
  posts.push(groupPost({ text: 'group-meta' }))
  posts.push(groupMeta({ name: 'Guarda-sois', join: 'open' }))
  let R1 = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R1 = await make('root', groupHeader({ diary: key, name: 'Cadeiras da praia' }), posts)
    return [groupJoinRecord({ group: R1, writer: R1, on: true })]
  })
  let R2 = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R2 = await make('root', groupHeader({ diary: key, name: 'Barracas' }), posts)
    return [groupJoinRecord({ group: R2, writer: R2, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R1)
  await admitted(events, R2)
  for (const R of [R1, R2]) {
    await downloaded(seeder, R, 23)
    await until(() => {
      const e = seeder._groupServed.get(R)
      return !e.rootScanning && e.rootScanned === 23
    }, { name: 'raiz varrida' })
  }
  t.is(seeder._groupServed.get(R1).rootDecoded, 2, 'only the block that names group-meta and the meta itself are decoded')
  t.is(seeder.indexGroupSearch('guarda').groups.length, 2, 'both roots renamed')

  // Scan both again at once and watch the reads in flight.
  let inflight = 0
  let max = 0
  for (const R of [R1, R2]) {
    const e = seeder._groupServed.get(R)
    const get = e.core.get.bind(e.core)
    e.core.get = async (...args) => {
      inflight++
      max = Math.max(max, inflight)
      try {
        return await get(...args)
      } finally {
        inflight--
      }
    }
    e.rootScanned = 0
    e.rootDecoded = 0
  }
  seeder._scanRoot(R1, seeder._groupServed.get(R1))
  seeder._scanRoot(R2, seeder._groupServed.get(R2))
  await until(() => [R1, R2].every((R) => {
    const e = seeder._groupServed.get(R)
    return !e.rootScanning && e.rootScanned === 23
  }), { name: 'duas varreduras' })
  t.is(max, 1, 'at most one group root read at a time')
  t.is(seeder._groupServed.get(R2).rootDecoded, 2)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('group bindings count the diaries they name: _groupNames is one lookup, never a walk over every group core', (t) => {
  const seeder = Object.create(Seeder.prototype)
  const groups = new GroupBindings()
  seeder._groups = groups
  const [d1, d2, d3] = ['1', '2', '3'].map((c) => c.repeat(64))
  const [k1, k2, k3, k4] = ['a', 'b', 'c', 'd'].map((c) => c.repeat(64))
  groups.set(k1, { diary: d1, group: k1, seq: 1 })
  groups.set(k2, { diary: d1, group: k1, seq: 2 })
  groups.set(k3, { diary: d2, group: k3, seq: 1 })
  groups.set(k4, null)
  for (const name of ['values', 'entries', 'keys', 'forEach', Symbol.iterator]) {
    groups[name] = () => { throw new Error('walked every binding') }
  }
  t.ok(seeder._groupNames(d1) && seeder._groupNames(d2), 'both diaries are named')
  t.absent(seeder._groupNames(d3), 'a diary no binding names')
  groups.delete(k1)
  t.ok(seeder._groupNames(d1), 'a second binding still names it')
  groups.delete(k2)
  t.absent(seeder._groupNames(d1), 'its last binding is gone')
  groups.set(k3, { diary: d3, group: k3, seq: 1 })
  t.absent(seeder._groupNames(d2), 'a replaced binding no longer names its old diary')
  t.ok(seeder._groupNames(d3), 'and names the new one')
  t.is(groups.size, 2)
  groups.clear()
  t.absent(seeder._groupNames(d3), 'nothing after a clear')
})

test('public group images are validated, diary-bound and hidden while pending', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const image = { core: 'da'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 100, sha256: 'db'.repeat(32), width: 512, height: 512 }
  let R = null
  let P = null
  let U = null
  const unbound = await member(t, bootstrap, assoc, async () => [])
  await admit(unbound, assoc)
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Praia' }), [
      groupPost({ text: 'group-image' }),
      { ...groupImage({ image }), image: { ...image, mime: 'image/png' } }
    ])
    P = await make('private', groupHeader({ diary: key, visibility: 'private', join: 'approval', name: null, box: 'dc'.repeat(32) }), [groupImage({ image })])
    U = await make('unbound', groupHeader({ diary: unbound.key, name: 'Outra' }), [groupImage({ image })])
    return [R, P, U].map((group) => groupJoinRecord({ group, writer: group, on: true }))
  })
  await admit(A, assoc)
  for (const root of [R, P, U]) await admitted(events, root)
  await downloaded(seeder, R, 3)
  await downloaded(seeder, P, 2)
  await downloaded(seeder, U, 2)
  await until(() => [R, U].every((root) => seeder.indexGroup(root).complete), { name: 'raízes varridas' })
  t.is(seeder.groupImagePublic(R), null, 'a post mentioning the needle and an invalid image are not folded')
  t.is(seeder._groupServed.get(R).rootDecoded, 2, 'both needle hits reached the real filters')
  t.is(seeder.groupImagePublic(P), null, 'a private root has no image')
  t.is(seeder._groupServed.get(P).rootScanned, 0, 'a private root stays unscanned')
  t.is(seeder.groupImagePublic(U), null, 'the header diary never bound this root')
  t.alike(seeder._groupIndex.imageOf(U), image, 'the unbound root did fold its image')
  t.is(seeder.groupImagePublic('ff'.repeat(32)), null, 'unknown root')
  for (const key of [null, undefined, {}, Symbol('root'), 'invalid']) t.is(seeder.groupImagePublic(key), null, 'malformed input never throws')

  await A.cores.root.append(encode(groupImage({ image })))
  await downloaded(seeder, R, 4)
  await until(() => seeder.indexGroup(R).complete, { name: 'imagem varrida' })
  t.alike(seeder.groupImagePublic(R), { image, author: A.key }, 'the public root image uses its bound diary as author')
  const answer = JSON.stringify(seeder.indexGroup(R))
  const search = JSON.stringify(seeder.indexGroupSearch('praia'))
  seeder._groupIndex.resetRoot(R)
  t.is(seeder.groupImagePublic(R), null)
  t.is(JSON.stringify(seeder.indexGroup(R)), answer, 'the group answer is byte identical without the image')
  t.is(JSON.stringify(seeder.indexGroupSearch('praia')), search, 'the search answer is byte identical too')
  seeder._groupIndex.foldRoot(R, groupImage({ image }))

  const entry = seeder._groupServed.get(R)
  entry.headerOk = false
  t.is(seeder.groupImagePublic(R), null, 'unverified header')
  entry.headerOk = true
  entry.rootScanned--
  t.is(seeder.groupImagePublic(R), null, 'scan behind the contiguous prefix')
  entry.rootScanned++
  entry.rootScanning = true
  t.is(seeder.groupImagePublic(R), null, 'scan still running')
  entry.rootScanning = false
  seeder._groupReserved.set('ee'.repeat(32), R)
  t.alike(seeder.groupImagePublic(R), { image, author: A.key }, 'another writer admission does not hide the indexed image')
  seeder._groupReserved.delete('ee'.repeat(32))
  t.alike(seeder.groupImagePublic(R), { image, author: A.key }, 'settled again')

  const get = entry.core.get
  const held = gate()
  t.teardown(() => {
    held.open()
    entry.core.get = get
  }, { force: true })
  entry.core.get = async function (i, opts) {
    if (i === 4) {
      held.entered = true
      await held.promise
    }
    return get.call(this, i, opts)
  }
  await A.cores.root.append(encode(groupImage({ image: null })))
  await until(() => held.entered, { name: 'limpeza aguardando leitura' })
  t.is(seeder.groupImagePublic(R), null, 'the old image is withheld during a real pending read')
  held.open()
  await until(() => seeder.indexGroup(R).complete, { name: 'limpeza varrida' })
  t.is(seeder.groupImagePublic(R), null, 'a clear is folded')
  entry.core.get = get
  await A.cores.root.append(encode(groupImage({ image })))
  await downloaded(seeder, R, 6)
  await until(() => seeder.indexGroup(R).complete, { name: 'imagem restaurada' })
  t.alike(seeder.groupImagePublic(R), { image, author: A.key })
  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [R] }, mod.kp, mod.cert) })
  await rejected(events, R, 'group-blocked')
  t.is(seeder.groupImagePublic(R), null, 'blocked group')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

// In-memory cores exercise the notice scan's interleavings without a swarm;
// the integration test below uses the same local DHT setup as the file.
function noticeFixture ({ count = 2, private: priv = false, history = true, groups = 1 } = {}) {
  const { K, community, groupIn } = require('./helpers/groups')
  const { groupAdmit } = require('../lib/group')
  const { createGroupIndex } = require('../lib/group-index')
  const members = Array.from({ length: count }, (_, i) => ({ diary: K(100 + i), cw: K(1000 + i), status: 'member' }))
  const C = community({ creator: K(1), members })
  const scopes = Array.from({ length: groups }, (_, n) => {
    const G = groupIn(C, { key: K(2 + n), visibility: priv ? 'private' : 'public', join: priv ? 'approval' : 'open', box: priv ? K(999) : null })
    const writers = members.map((m, i) => {
      const w = K(2000 + n * 10000 + i)
      G.add(m.diary, w, { box: priv ? K(3000 + i) : null })
      if (priv) G.push(G.key, groupAdmit({ member: m.diary, on: true, cuts: [{ writer: w, seq: 1 }] }))
      return w
    })
    if (history && !priv) G.push(writers[0], groupPost({ text: 'history' }))
    return { G, writers }
  })
  const { G, writers } = scopes[0]
  const events = []
  const seeder = new Seeder({ onGroupNotice: (e) => events.push(e) })
  seeder._keyPair = signingKeyPair()
  seeder._passesStarted = true
  seeder._groupIndex = createGroupIndex()
  for (const scope of [C, ...scopes.map((s) => s.G)]) {
    for (const [key, log] of scope.logs) {
      const core = {
        fork: 0,
        get length () { return log.entries.length },
        get contiguousLength () { return log.entries.length },
        async get (seq) { return encode(log.entries[seq].record) }
      }
      const e = { core, group: scope.key, diary: log.diary, headerOk: true, dropped: false, noticeFrom: core.length, groupNotice: null, cut: null }
      seeder._groupServed.set(key, e)
      seeder._groups.set(key, { group: scope.key, diary: log.diary, seq: 1, bound: true })
      seeder._groupIndex.addWriter(scope.key, key, log.diary, 1)
      if (key === scope.key) seeder._groupIndex.setHeader(key, log.entries[0].record)
      let diary = seeder._served.get(log.diary)
      if (!diary) {
        diary = { core: { length: 1, contiguousLength: 1 }, scanned: 1, gated: true, dropped: false, groupEvents: new Map(), groupLive: new Map() }
        seeder._served.set(log.diary, diary)
      }
      diary.groupLive.set(key, { group: scope.key, seq: 1, left: false })
    }
  }
  // Real admission queues are exercised by the network test. Here the
  // fixture supplies complete diary scans and explicit missing-core cases.
  seeder._groupIncomplete = () => false
  const scan = async () => {
    seeder._queueGroupNotices()
    await until(() => scopes.every(({ G }) => {
      const state = seeder._groupServed.get(G.key).groupNotice
      return state !== null && !state.busy
    }), { name: 'group notice scan' })
  }
  const state = () => seeder._groupServed.get(G.key).groupNotice
  return { seeder, C, G, writers, scopes, members, events, scan, state }
}

test('group notices: the shared byte budget bounds growing hints without replaying history', async (t) => {
  const f = noticeFixture({ groups: 2 })
  const length = (scope) => [...scope.logs.values()].reduce((n, log) => n + log.entries.length, 0)
  const initial = (length(f.C) * 2 + f.scopes.reduce((n, { G }) => n + length(G), 0)) * GROUP_HINT_BLOCK_BYTES +
    f.members.length * 4 * GROUP_HINT_ENTRY_BYTES
  const budget = f.seeder._groupNoticeBudget = createGroupHintBudget(initial + GROUP_HINT_BLOCK_BYTES)
  await f.scan()
  t.is(budget.held(), initial, 'both hints pay for the shared community history')
  t.alike(f.events, [], 'both groups stay silent for history')
  f.G.push(f.writers[0], groupPost({ text: 'last ordinary block' }))
  await f.scan()
  t.is(budget.held(), initial + GROUP_HINT_BLOCK_BYTES)
  t.is(f.events.length, 1, 'the last ordinary block still permits a notice')
  f.G.push(f.writers[0], groupPost({ text: 'past the shared limit' }))
  await f.scan()
  t.is(f.state().hint.allowed(f.members[0].diary), UNKNOWN)
  t.is(f.state().hint.members(), null)
  t.is(f.state().hint.held().blocks, 0, 'the growing hint refunds all its bytes')
  t.is(f.events.length, 1, 'the incomplete group sends no notice')
  const other = f.scopes[1]
  const otherState = f.seeder._groupServed.get(other.G.key).groupNotice
  t.is(budget.held(), otherState.hint.held().bytes, 'the other group keeps its charges')
  other.G.push(other.writers[0], groupPost({ text: 'another group' }))
  f.G.push(f.writers[0], groupPost({ text: 'still incomplete' }))
  await f.scan()
  t.is(f.events.length, 2)
  t.is(f.events[1].group, other.G.key, 'only the complete group notifies')
  otherState.rebuild = true
  await f.scan()
  t.is(budget.held(), otherState.hint.held().bytes, 'rebuilding releases the old hint first')
  t.is(f.events.length, 2, 'rebuilding never replays history')
  const entry = f.seeder._groupServed.get(other.G.key)
  entry.stopFork = entry.stopGrow = entry.stopQuota = () => {}
  f.seeder._stopEntry(entry)
  t.is(budget.held(), 0, 'stopping a root releases the shared budget')
})

test('group notices: weighted bytes survive rebuilds and exhaust the default shared budget', async (t) => {
  const { K } = require('./helpers/groups')
  const { groupAdmit } = require('../lib/group')
  const f = noticeFixture({ groups: 2 })
  const budget = f.seeder._groupNoticeBudget
  t.is(MAX_GROUP_NOTICE_BYTES, 64 * 1024 * 1024, 'all hints share at most 64 MiB')
  await f.scan()
  const initial = budget.held()
  const other = f.seeder._groupServed.get(f.scopes[1].G.key).groupNotice
  const otherBytes = other.hint.held().bytes
  const record = groupAdmit({
    member: f.members[1].diary,
    on: true,
    cuts: Array.from({ length: 16 }, (_, i) => ({ writer: K(7000 + i), seq: 1 }))
  })
  const cost = GROUP_HINT_BLOCK_BYTES + GROUP_HINT_ENTRY_BYTES + 16 * GROUP_HINT_REFERENCE_BYTES
  f.G.push(f.writers[0], record)
  await f.scan()
  t.is(budget.held(), initial + cost, 'even an unauthorized admit retains and pays for its cuts')
  t.alike(f.events, [], 'membership records do not notify')
  const retained = budget.held()
  for (let i = 0; i < 3; i++) {
    const old = f.state().hint
    f.state().rebuild = true
    await f.scan()
    t.is(old.held().bytes, 0, 'the replaced hint frees its maps')
    t.is(budget.held(), retained, 'rebuild refunds and charges exactly the same bytes')
    old.incomplete()
    t.is(budget.held(), retained, 'a second release of the old hint cannot refund again')
  }
  // Reserve the bytes other groups could hold without allocating 64 MiB
  // just to exercise the production budget's last few bytes.
  const reserved = MAX_GROUP_NOTICE_BYTES - retained - 2 * GROUP_HINT_BLOCK_BYTES
  t.ok(budget.take(reserved))
  f.G.push(f.writers[0], groupPost({ text: 'fits before the cut-heavy record' }))
  await f.scan()
  t.is(f.events.length, 1, 'an ordinary block fits the remaining bytes')
  t.is(budget.held(), MAX_GROUP_NOTICE_BYTES - GROUP_HINT_BLOCK_BYTES)
  f.G.push(f.writers[0], record)
  f.G.push(f.writers[1], groupPost({ text: 'cannot notify with missing authority' }))
  await f.scan()
  t.is(f.state().hint.allowed(f.members[0].diary), UNKNOWN)
  t.is(f.state().hint.members(), null)
  t.is(f.state().hint.held().bytes, 0, 'failure after charging the base refunds that too')
  t.is(budget.held(), reserved + otherBytes, 'the other hint keeps exactly its charge')
  t.is(f.events.length, 1, 'the incomplete group sends nothing')
  budget.release(reserved)
  for (const { G } of f.scopes) {
    const entry = f.seeder._groupServed.get(G.key)
    entry.stopFork = entry.stopGrow = entry.stopQuota = () => {}
    f.seeder._stopEntry(entry)
    f.seeder._stopEntry(entry)
  }
  t.is(budget.held(), 0, 'closing roots refunds everything once without a negative balance')
})

test('group notices: a new hint with no shared bytes remains silent', async (t) => {
  const f = noticeFixture()
  f.seeder._groupNoticeBudget = createGroupHintBudget(0)
  await f.scan()
  t.is(f.state().hint.members(), null)
  t.is(f.state().hint.held().blocks, 0)
  t.alike(f.events, [], 'history never notifies even when the hint cannot start')
  f.G.push(f.writers[0], groupPost({ text: 'new while incomplete' }))
  await f.scan()
  t.is(f.state().hint.allowed(f.members[0].diary), UNKNOWN)
  t.alike(f.events, [], 'new messages cannot notify with an incomplete hint')
})

test('group notices: history, new posts, replay, hide and reaction', async (t) => {
  const { groupHide, groupReact } = require('../lib/group')
  const { validateGroupNotice } = require('../lib/group-notice')
  const f = noticeFixture()
  await f.scan()
  t.alike(f.events, [], 'history is only fed to the hint')
  const target = f.G.push(f.writers[0], groupPost({ text: 'new' }))
  await f.scan()
  t.is(f.events.length, 1)
  t.alike(f.events[0].recipients, [f.C.logs.get(f.C.key).diary, f.members[1].diary].sort())
  t.ok(validateGroupNotice(f.events[0]))
  t.is(f.events[0].name, 'Varanda')
  const sodium = require('sodium-universal')
  const input = Buffer.concat([Buffer.from(f.G.key, 'hex'), Buffer.from(target.writer, 'hex'), Buffer.alloc(8)])
  input.writeBigUInt64BE(BigInt(target.seq), 64)
  const expected = Buffer.alloc(16)
  sodium.crypto_generichash(expected, input, f.seeder._keyPair.secretKey)
  t.is(f.events[0].nid, expected.toString('hex'), 'keyed BLAKE2b-128 with a big-endian sequence')
  await f.scan()
  t.is(f.events.length, 1, 'replaying a scan cannot notify twice')
  f.G.push(f.writers[0], groupHide({ target, on: true }))
  f.G.push(f.writers[0], groupReact({ target, emoji: '❤️' }))
  await f.scan()
  t.is(f.events.length, 1, 'hide and reaction are not messages')
})

test('group notices: all recipients past 64 get the same opaque block id', async (t) => {
  const f = noticeFixture({ count: 70 })
  await f.scan()
  f.G.push(f.writers[0], groupPost({ text: 'new' }))
  await f.scan()
  t.alike(f.events.map((e) => e.recipients.length), [64, 6])
  t.is(f.events[0].nid, f.events[1].nid)
  t.alike(f.events.flatMap((e) => e.recipients), [f.C.logs.get(f.C.key).diary, ...f.members.slice(1).map((m) => m.diary)].sort())
  await f.scan()
  t.is(f.events.length, 2)
})

test('group notices: bans in either scope block authors and community-banned recipients', async (t) => {
  const { groupBan, communityBan } = require('../lib/group')
  for (const inCommunity of [false, true]) {
    const f = noticeFixture()
    await f.scan()
    const record = { member: f.members[0].diary, on: true, cuts: [{ writer: inCommunity ? f.members[0].cw : f.writers[0], seq: 1 }] }
    if (inCommunity) f.C.push(f.C.key, communityBan(record))
    else f.G.push(f.G.key, groupBan(record))
    const last = inCommunity ? f.C.key : f.G.key
    const binding = f.seeder._groups.get(last)
    f.seeder._groups.delete(last)
    f.seeder._groups.set(last, binding)
    // The author is scanned before the ban, so the final barrier matters.
    f.G.push(f.writers[0], groupPost({ text: 'banned author' }))
    await f.scan()
    t.is(f.events.length, 0, 'a banned author in ' + (inCommunity ? 'C' : 'G'))
    f.G.push(f.writers[1], groupPost({ text: 'allowed author' }))
    await f.scan()
    t.alike(f.events[0].recipients, [f.C.logs.get(f.C.key).diary], 'banned diary receives nothing')
  }
})

test('group notices: missing cores, read failures and writer caps fail closed', async (t) => {
  for (const problem of ['missing', 'read', 'cap', 'unknown']) {
    const f = noticeFixture()
    await f.scan()
    if (problem === 'missing') f.seeder._groupServed.delete(f.members[1].cw)
    if (problem === 'read') f.seeder._groupServed.get(f.C.key).core.get = async () => { throw new Error('unreadable') }
    if (problem === 'cap') f.seeder.maxGroupWriters = 3
    if (problem === 'unknown') f.state().hint.incomplete()
    f.C.push(f.C.key, groupMeta({ name: 'Bairro', join: 'open' }))
    f.G.push(f.writers[0], groupPost({ text: 'new' }))
    await f.scan()
    t.alike(f.events, [], problem)
    t.is(f.state().hint.members(), null, problem + ' taints the hint')
  }
})

test('group notices: private envelopes carry no name', async (t) => {
  const { groupSealed } = require('../lib/group')
  const f = noticeFixture({ private: true })
  await f.scan()
  f.G.push(f.writers[0], groupSealed({ kid: { writer: f.G.key, seq: 1 }, nonce: 'ab'.repeat(24), box: Buffer.alloc(40, 7).toString('base64') }))
  await f.scan()
  t.is(f.events.length, 1)
  t.is(f.events[0].visibility, 'private')
  t.is(f.events[0].name, null)
})

test('group notices: group and writer buckets drop without queuing and refill', async (t) => {
  const f = noticeFixture()
  await f.scan()
  for (let i = 0; i < 5; i++) {
    f.G.push(f.writers[i % 2], groupPost({ text: 'new ' + i }))
    await f.scan()
  }
  t.is(f.events.length, 4, 'the group bucket spans writers')
  await f.scan()
  t.is(f.events.length, 4, 'the fifth post was dropped')
  const state = f.state()
  const cursor = state.cursors.get(f.writers[0])
  state.at -= 30000
  f.G.push(f.writers[0], groupPost({ text: 'refilled group' }))
  await f.scan()
  t.is(f.events.length, 5)
  state.tokens = 4
  cursor.tokens = 0
  f.G.push(f.writers[0], groupPost({ text: 'exhausted writer' }))
  await f.scan()
  t.is(f.events.length, 5, 'the writer has its own bucket')
  cursor.at -= 30000
  f.G.push(f.writers[0], groupPost({ text: 'refilled writer' }))
  await f.scan()
  t.is(f.events.length, 6)
})

test('group notices: group and community cut marks are fed before sending', async (t) => {
  const { communityBan } = require('../lib/group')
  const f = noticeFixture()
  await f.scan()
  f.seeder._served.get(f.members[0].diary).groupEvents.set(f.G.key, [{ kind: 'cut', writer: f.writers[0], cut: 1 }])
  f.G.push(f.writers[0], groupPost({ text: 'retired device' }))
  await f.scan()
  t.alike(f.events, [], 'cut device cannot notify while its diary is a member')
  const creator = f.C.logs.get(f.C.key).diary
  f.seeder._served.get(creator).groupEvents.set(f.C.key, [{ kind: 'cut', writer: f.C.key, cut: 1 }])
  f.C.push(f.C.key, communityBan({ member: f.members[1].diary, on: true, cuts: [{ writer: f.members[1].cw, seq: 1 }] }))
  f.G.push(f.writers[1], groupPost({ text: 'banned through the community' }))
  await f.scan()
  t.alike(f.events, [], 'a cut on the community root leaves its ban in force, as buildGroup does')
})

test('group notices: signed admission floor and startup length suppress delayed history', async (t) => {
  const f = noticeFixture({ history: false })
  const e = f.seeder._groupServed.get(f.writers[0])
  e.noticeFrom = 3
  await f.scan()
  f.G.push(f.writers[0], groupPost({ text: 'history not downloaded at admission' }))
  f.G.push(f.writers[0], groupPost({ text: 'more history' }))
  await f.scan()
  t.alike(f.events, [])
  f.G.push(f.writers[0], groupPost({ text: 'new after signed floor' }))
  await f.scan()
  t.is(f.events.length, 1)
  const root = f.seeder._groupServed.get(f.G.key)
  root.groupNotice.hint.incomplete()
  root.groupNotice = null
  for (const core of f.seeder._groupServed.values()) core.noticeFrom = core.core.length
  await f.scan()
  t.is(f.events.length, 1, 'rebuilding at startup cannot replay history')
})

test('group notices: cut writers with permanent holes do not stop other members', async (t) => {
  const { groupLeave } = require('../lib/group')
  for (const inCommunity of [false, true]) {
    const f = noticeFixture()
    const scope = inCommunity ? f.C : f.G
    const writer = inCommunity ? f.members[0].cw : f.writers[0]
    const e = f.seeder._groupServed.get(writer)
    scope.push(writer, groupPost({ text: 'cleared after retirement' }))
    const leave = scope.push(writer, groupLeave())
    e.cut = 1
    e.cutting = true
    f.seeder._groups.get(writer).cut = 1
    const get = e.core.get
    Object.defineProperty(e.core, 'contiguousLength', { get: () => 1 })
    e.core.has = async (seq) => seq === 0 || seq >= leave.seq
    e.core.get = async (seq) => seq > 0 && seq < leave.seq ? null : get(seq)
    f.seeder._served.get(e.diary).groupEvents.set(scope.key, [{ kind: 'cut', writer, cut: 1 }])
    await f.scan()
    t.alike(f.events, [], 'startup history stays silent with a cut in ' + (inCommunity ? 'C' : 'G'))
    f.G.push(f.writers[1], groupPost({ text: 'after retirement' }))
    await f.scan()
    t.is(f.events.length, 1, 'another member still notifies')
    t.alike(f.events[0]?.recipients, [f.C.logs.get(f.C.key).diary], 'the retained leave excludes the retired member')
    await f.scan()
    t.is(f.events.length, 1, 'neither history nor the new post replays')
    f.state().hint.incomplete()
    f.seeder._groupServed.get(f.G.key).groupNotice = null
    for (const entry of f.seeder._groupServed.values()) entry.noticeFrom = entry.core.length
    await f.scan()
    t.is(f.events.length, 1, 'restart with the same hole stays silent')
    f.G.push(f.writers[1], groupPost({ text: 'after restart' }))
    await f.scan()
    t.is(f.events.length, 2, 'the first scan after restart does not disable later notices')
  }
})

test('group notices: a withholding diary exhausts the shared stall budget', async (t) => {
  const { groupBan } = require('../lib/group')
  const f = noticeFixture()
  delete f.seeder._groupIncomplete
  const diary = f.seeder._served.get(f.members[0].diary)
  await f.scan()
  diary.core.length = 2
  f.G.push(f.writers[0], groupPost({ text: 'withholding author' }))
  f.G.push(f.writers[1], groupPost({ text: 'during the wait' }))
  await f.scan()
  t.alike(f.events, [], 'the diary still holds the group pending within its budget')
  const stall = f.seeder._groupStalls.get(f.members[0].diary)
  t.ok(stall, 'the same diary budget as group pages is used')
  stall.spent = f.seeder.groupScanStallMs
  await f.scan()
  t.alike(f.events, [], 'expiring the budget never replays posts from the wait')
  f.G.push(f.writers[0], groupPost({ text: 'still withholding' }))
  f.G.push(f.writers[1], groupPost({ text: 'after the budget' }))
  await f.scan()
  t.is(f.events.length, 1, 'only the caught-up author notifies')
  t.alike(f.events[0]?.recipients, [f.C.logs.get(f.C.key).diary], 'the uncertain diary receives nothing')
  await f.scan()
  t.is(f.events.length, 1, 'rebuilding while excluded does not replay')
  diary.scanned = diary.core.contiguousLength = diary.core.length
  await f.scan()
  t.is(f.events.length, 1, 'catching up cannot replay the excluded author')
  f.G.push(f.writers[0], groupPost({ text: 'caught up' }))
  await f.scan()
  t.is(f.events.length, 2, 'a later post from the recovered diary can notify')
  diary.core.length++
  f.G.push(f.writers[0], groupBan({ member: f.members[1].diary, on: true, cuts: [{ writer: f.writers[1], seq: 1 }] }))
  f.G.push(f.writers[1], groupPost({ text: 'uncertain authority' }))
  await f.scan()
  t.is(f.state().hint.members(), null, 'an unread cut that could void authority keeps the hint unknown')
  t.is(f.events.length, 2, 'budget exhaustion never discards uncertain authority to allow a notice')
})

test('group notices: transient null and thrown reads rebuild without replaying history', async (t) => {
  for (const throws of [false, true]) {
    const f = noticeFixture()
    await f.scan()
    f.G.push(f.writers[0], groupPost({ text: 'already notified' }))
    await f.scan()
    t.is(f.events.length, 1)
    const e = f.seeder._groupServed.get(f.writers[0])
    const get = e.core.get
    e.core.get = async () => {
      if (throws) throw new Error('transient read failure')
      return null
    }
    f.G.push(f.writers[0], groupPost({ text: 'cleared during get' }))
    f.G.push(f.writers[1], groupPost({ text: 'arrived before the read failed' }))
    await f.scan()
    const poisoned = f.state().hint
    t.is(poisoned.members(), null, 'a failed read leaves membership unknown')
    t.is(f.events.length, 1)
    const reads = new Map()
    for (const [writer, entry] of f.seeder._groupServed) {
      const read = entry === e ? get : entry.core.get
      entry.core.get = async (seq) => {
        if (seq === 0) reads.set(writer, true)
        return read(seq)
      }
    }
    await f.scan()
    t.not(f.state().hint, poisoned, 'recovery creates a fresh hint')
    t.is(reads.size, f.seeder._groupServed.size, 'every bound core is read again from block zero')
    t.is(f.events.length, 1, 'recovery replays neither history nor the failed post')
    f.G.push(f.writers[0], groupPost({ text: 'after recovery' }))
    await f.scan()
    t.is(f.events.length, 2, 'the next new post notifies')
    await f.scan()
    t.is(f.events.length, 2, 'the recovered post notifies once')
  }
})

test('group notices: a community ban arriving during the scan drops the pending post', async (t) => {
  const { communityBan } = require('../lib/group')
  const f = noticeFixture()
  await f.scan()
  const e = f.seeder._groupServed.get(f.writers[0])
  const get = e.core.get
  let changed = false
  e.core.get = async (seq) => {
    if (!changed) {
      changed = true
      f.C.push(f.C.key, communityBan({ member: f.members[0].diary, on: true, cuts: [{ writer: f.members[0].cw, seq: 1 }] }))
    }
    return get(seq)
  }
  f.G.push(f.writers[0], groupPost({ text: 'racing ban' }))
  await f.scan()
  t.alike(f.events, [], 'C is no longer scanned to its contiguous length')
  await f.scan()
  t.alike(f.events, [], 'the dropped candidate never queues for later')
})

test('group notices: a join left flag cannot decide recipients and missing history cannot notify', async (t) => {
  const f = noticeFixture()
  await f.scan()
  f.seeder._groupIndex.setLeft(f.writers[1], true)
  f.G.push(f.writers[0], groupPost({ text: 'binding flag' }))
  await f.scan()
  t.ok(f.events[0].recipients.includes(f.members[1].diary), 'only the hint decides membership')
  const e = f.seeder._groupServed.get(f.members[1].cw)
  Object.defineProperty(e.core, 'length', { get: () => e.core.contiguousLength + 1, configurable: true })
  f.G.push(f.writers[0], groupPost({ text: 'while missing a block' }))
  await f.scan()
  t.is(f.events.length, 1, 'an unread C block could be a ban')
  t.is(e.noticeFrom, e.core.contiguousLength, 'pending never advances the floor over unread signed blocks')
  Object.defineProperty(e.core, 'length', { get: () => e.core.contiguousLength })
  await f.scan()
  t.is(f.events.length, 1, 'catching up does not replay the missed notice')
  f.G.push(f.writers[0], groupPost({ text: 'after catching up' }))
  await f.scan()
  t.is(f.events.length, 2, 'later posts notify once the condition clears')
})

test('group notice integration: admitted public history stays silent and growth notifies once', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const notices = []
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, onGroupNotice: (e) => notices.push(e) })
  let C
  let G
  let W
  let CW
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    C = await make('community', groupHeader({ kind: 'community', diary: key, name: 'Bairro' }))
    G = await make('group', groupHeader({ diary: key, community: C, member: C, name: 'Praia' }), [groupPost({ text: 'history' })])
    return [groupJoinRecord({ group: C, writer: C, on: true }), groupJoinRecord({ group: G, writer: G, on: true })]
  })
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    CW = await make('community', writerHeader({ group: C, diary: key, member: null }))
    W = await make('group', writerHeader({ group: G, diary: key, member: CW }), [groupPost({ text: 'writer history' })])
    return [groupJoinRecord({ group: C, writer: CW, on: true }), groupJoinRecord({ group: G, writer: W, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  for (const key of [C, G, CW, W]) await admitted(events, key)
  await until(() => {
    // Queueing starts a scan at once, so only an idle state that is not done yet asks for another.
    const state = seeder._groupServed.get(G).groupNotice
    const done = Boolean(state) && !state.busy && state.hint.allowed(B.key) === true
    if (!done && !(state && state.busy)) seeder._queueGroupNotices()
    return done
  }, { name: 'complete notice hint' })
  t.alike(notices, [], 'admission history never notifies')
  await B.cores.group.append(encode(groupPost({ text: 'new' })))
  await until(() => notices.length === 1, { name: 'group notice' })
  t.alike(notices[0].recipients, [A.key])
  t.is(notices[0].name, 'Praia')
  await seeder.close()
  const restarted = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, onGroupNotice: (e) => notices.push(e) })
  await until(() => scansDone(restarted.seeder), { name: 'restart scans' })
  restarted.seeder._queueGroupNotices()
  await until(() => {
    const state = restarted.seeder._groupServed.get(G).groupNotice
    return state && !state.busy && state.cursors.size === 4
  }, { name: 'restart notice scan' })
  t.is(notices.length, 1, 'startup never notifies on stored history')
})

test('group notices: a banned writer burst cannot consume an allowed writer slot', async (t) => {
  const { groupBan } = require('../lib/group')
  const f = noticeFixture()
  await f.scan()
  f.G.push(f.G.key, groupBan({ member: f.members[0].diary, on: true, cuts: [{ writer: f.writers[0], seq: 1 }] }))
  for (let i = 0; i < 5; i++) f.G.push(f.writers[0], groupPost({ text: 'banned ' + i }))
  f.G.push(f.writers[1], groupPost({ text: 'allowed' }))
  await f.scan()
  t.is(f.events.length, 1)
  t.alike(f.events[0].recipients, [f.C.logs.get(f.C.key).diary])
})

test('group notices: one membership evaluation per pass despite blocks and recipient chunks', async (t) => {
  const f = noticeFixture({ count: 70, groups: 2 })
  await f.scan()
  const calls = new Map()
  for (const { G, writers } of f.scopes) {
    const hint = f.seeder._groupServed.get(G.key).groupNotice.hint
    const members = hint.members
    calls.set(G.key, 0)
    hint.members = () => {
      calls.set(G.key, calls.get(G.key) + 1)
      return members()
    }
    hint.allowed = () => t.fail('the pass must reuse the member set for authors')
    for (let i = 0; i < 3; i++) G.push(writers[i], groupPost({ text: 'new message' }))
  }
  await f.scan()
  t.alike([...calls.values()], [1, 1], 'one query after all blocks have been fed')
  t.is(f.events.length, 12, 'three posts per group, two recipient chunks per post')
  await f.scan()
  t.alike([...calls.values()], [1, 1], 'a pass with no new posts does not evaluate membership')
})

test('group notices: cached reads yield to the event loop between groups and queued passes', async (t) => {
  const f = noticeFixture({ groups: 2 })
  const order = []
  const scan = f.seeder._scanGroupNotices.bind(f.seeder)
  let queued = false
  f.seeder._scanGroupNotices = async (group, ...args) => {
    order.push('scan:' + group)
    if (!queued) {
      queued = true
      f.seeder._queueGroupNotices(group)
    }
    await scan(group, ...args)
    setImmediate(() => order.push('yield:' + group))
  }
  await f.scan()
  await new Promise((resolve) => setImmediate(resolve))
  const [first, second] = f.scopes.map(({ G }) => G.key)
  t.alike(order, [
    'scan:' + first, 'yield:' + first,
    'scan:' + second, 'yield:' + second,
    'scan:' + first, 'yield:' + first
  ], 'each pass gives the event loop a turn before the next group starts')
})
