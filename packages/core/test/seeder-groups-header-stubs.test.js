// Header stubs at the seeder (#350, packages/core/lib/seeder.js "Header
// stubs"): a writer K that a diary D joins to G but whose block 0 can never
// count for (G, D) is kept as block 0 alone and listed on the groups channel
// only to peers that announce CAP_HEADER_STUBS, so their reads stop waiting
// for K. Older peers get exactly the writer pages they got before.

const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { Seeder } = require('../lib/seeder')
const { CAP_HEADER_STUBS } = require('../lib/net')
const { createSnapshot } = require('../lib/blocklist')
const { writeBlocklist } = require('../lib/store')
const { tmpDir } = require('./helpers/tmp')
const { groupJoinRecord } = require('../lib/records')
const { groupPost } = require('../lib/group')
const {
  groupHeader,
  writerHeader,
  makeAssociation,
  readFile,
  readGroups,
  prepareSeederDir,
  startSeeder,
  member,
  admit,
  reader,
  admitted,
  rejected,
  stubbed,
  stored,
  downloaded,
  moderator
} = require('./helpers/seeder-groups')

const OTHER_GROUP = 'ab'.repeat(32)
const OTHER_DIARY = 'cd'.repeat(32)

const post = (text) => groupPost({ text })
const join = (group, writer) => groupJoinRecord({ group, writer, on: true })
const byKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0
const rows = (dataDir) => (readFile(dataDir).headerStubs || []).slice().sort(byKey)
const fatal = (events) => events.filter((e) => e.event === 'fatal').length

async function walk (r, group, limit) {
  const keys = []
  let after = null
  for (let i = 0; i < 32; i++) {
    const page = await r.groups.requestWriters({ group, after, limit })
    keys.push(...page.items.map((it) => it.key))
    if (page.next === null) return keys
    after = page.next
  }
  throw new Error('a caminhada não terminou')
}

async function page (r, group) {
  return (await r.groups.requestWriters({ group, after: null, limit: 64 })).items
}

test('a join refused for its header alone is a header stub, listed only to peers with the bit', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('root', groupHeader({ diary: key, name: 'Praia' }), [post('oi')])
    k.W = await make('w', writerHeader({ group: k.G, diary: key }), [post('a'), post('b')])
    k.Kb = await make('kb', post('sem cabeçalho'), [post('a'), post('b')])
    k.Kc = await make('kc', { ...writerHeader({ group: k.G, diary: key }), v: 1 }, [post('a'), post('b')])
    k.Kd = await make('kd', writerHeader({ group: OTHER_GROUP, diary: key }), [post('a'), post('b')])
    k.Ke = await make('ke', writerHeader({ group: k.G, diary: OTHER_DIARY }), [post('a'), post('b')])
    return [join(k.G, k.G), join(k.G, k.W), join(k.G, k.Kb), join(k.G, k.Kc), join(k.G, k.Kd), join(k.G, k.Ke)]
  })
  await admit(C, assoc)
  const kinds = [['Kb', 'header-invalid', 3], ['Kc', 'header-invalid', 4], ['Kd', 'wrong-group', 5], ['Ke', 'wrong-diary', 6]]
  for (const [name, reason] of kinds) await stubbed(events, k[name], reason)
  await downloaded(seeder, k.G, 2)
  await downloaded(seeder, k.W, 3)
  for (const [name] of kinds) {
    t.ok(await stored(seeder, k[name]), name + ' stored')
    t.is(seeder._stubCores.get(k[name]).core.contiguousLength, 1, name + ': block 0 alone')
  }
  t.absent(events.some((e) => e.event === 'group-rejected' && kinds.some(([name]) => k[name] === e.key)), 'no refusal')
  t.is(seeder.stats().groupCores, 2, 'stubs are no group cores')
  const expectedRows = kinds.map(([name, , seq]) => ({ key: k[name], group: k.G, diary: C.key, seq })).sort(byKey)
  await until(() => rows(dataDir).length === 4, { name: 'linhas gravadas' })
  t.alike(rows(dataDir), expectedRows)

  const real = [{ key: k.G, diary: C.key, length: 2, seq: 1 }, { key: k.W, diary: C.key, length: 3, seq: 2 }].sort(byKey)
  const plain = await reader(t, bootstrap, publicKey)
  t.alike(await page(plain, k.G), real, 'no bit: the writers only')
  const capable = await reader(t, bootstrap, publicKey, { caps: CAP_HEADER_STUBS })
  const stubItems = kinds.map(([name, , seq]) => ({ key: k[name], diary: C.key, length: 1, seq }))
  const all = [...real, ...stubItems].sort(byKey)
  t.alike(await page(capable, k.G), all, 'the bit: writers and stubs in key order')
  t.alike(await walk(capable, k.G, 2), all.map((i) => i.key), 'pages of two: every key once')
  t.alike(seeder.groupWriters({ group: k.G, after: null, limit: 64 }).items.map((i) => i.key), real.map((i) => i.key), 'in-process callers: writers only')
  t.is(fatal(events), 0)
})

test('header stubs stop at maxHeaderStubs with stub-full and never take a writer\'s place', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxHeaderStubs: 2 })
  const k = {}
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('root', groupHeader({ diary: key }), [post('oi')])
    k.W = await make('w', writerHeader({ group: k.G, diary: key }), [post('a')])
    k.K = [await make('k1', post('x')), await make('k2', post('y')), await make('k3', post('z'))]
    return [join(k.G, k.G), ...k.K.map((K) => join(k.G, K))]
  })
  await admit(C, assoc)
  await admitted(events, k.G)
  const outcome = (K) => events.find((e) => (e.event === 'group-header-stub' || (e.event === 'group-rejected' && e.reason === 'stub-full')) && e.key === K)
  await until(() => k.K.every(outcome), { name: 'três juntas julgadas', timeoutMs: 60000 })
  const full = k.K.filter((K) => outcome(K).event === 'group-rejected')
  t.is(full.length, 1, 'the third join is refused')
  t.absent(await stored(seeder, full[0]), 'and not fetched into the store')
  t.is(seeder._headerStubs.size, 2)
  await C.diary.append(join(k.G, k.W))
  await admitted(events, k.W)
  await downloaded(seeder, k.W, 2)
  t.ok(seeder._groupServed.has(k.G) && seeder._groupServed.has(k.W), 'writers stay served')
  t.is(fatal(events), 0)
})

test('one diary keeps at most 8 header stubs over all its groups', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = { K: [] }
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G1 = await make('g1', groupHeader({ diary: key, name: 'Um' }))
    k.G2 = await make('g2', groupHeader({ diary: key, name: 'Dois' }))
    const joins = [join(k.G1, k.G1), join(k.G2, k.G2)]
    for (let i = 0; i < 9; i++) {
      const K = await make('k' + i, post('bloco ' + i))
      k.K.push(K)
      joins.push(join(i < 5 ? k.G1 : k.G2, K))
    }
    return joins
  })
  await admit(C, assoc)
  const outcome = (K) => events.find((e) => (e.event === 'group-header-stub' || (e.event === 'group-rejected' && e.reason === 'stub-full')) && e.key === K)
  await until(() => k.K.every(outcome), { name: 'nove juntas julgadas', timeoutMs: 90000 })
  t.is(k.K.filter((K) => outcome(K).event === 'group-rejected').length, 1, 'the ninth is stub-full')
  t.is(seeder._headerStubs.size, 8)
  t.is(fatal(events), 0)
})

test('a header stub leaves when its join moves, when its diary is dropped and when its group is blocked', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }))
    k.G2 = await make('g2', groupHeader({ diary: key, name: 'Dois' }))
    k.Kb = await make('kb', post('sem cabeçalho'), [post('a')])
    k.Kx = await make('kx', post('outro'))
    return [join(k.G, k.G), join(k.G2, k.G2), join(k.G, k.Kb), join(k.G2, k.Kx)]
  })
  await admit(C, assoc)
  await stubbed(events, k.Kb)
  await stubbed(events, k.Kx)

  // Kb joined to G2 instead: the row under G goes, one under G2 comes.
  await C.diary.append(join(k.G2, k.Kb))
  await until(() => seeder._headerStubs.has(k.G2 + ':' + k.Kb) && !seeder._headerStubs.has(k.G + ':' + k.Kb) &&
    seeder._stubCores.get(k.Kb) && seeder._stubCores.get(k.Kb).ready, { name: 'Kb sob G2' })
  t.ok(await stored(seeder, k.Kb), 'Kb kept')
  await until(() => rows(dataDir).some((r) => r.key === k.Kb && r.group === k.G2) && !rows(dataDir).some((r) => r.group === k.G), { name: 'arquivo com Kb sob G2' })

  // G2 blocked: its rows go, purged first.
  const mod = moderator(assoc)
  const capable = await reader(t, bootstrap, publicKey, { caps: CAP_HEADER_STUBS, blocklist: createSnapshot({ seq: 1, blocked: [k.G2], revokedIssuers: [] }, mod.kp, mod.cert) })
  await until(async () => seeder._headerStubs.size === 0 && seeder._drops.size === 0 && !(await stored(seeder, k.Kb)) && !(await stored(seeder, k.Kx)), { name: 'G2 bloqueado' })
  t.ok(events.some((e) => e.event === 'group-header-stub-dropped' && e.key === k.Kb && e.reason === 'group-blocked'))
  t.absent('headerStubs' in readFile(dataDir), 'no rows left in the file')
  t.alike(await page(capable, k.G2), [], 'nothing listed for a blocked group')

  // A new join under G, then C dropped: its rows go with it.
  const K2 = await C.store.get({ name: 'k2' })
  await K2.ready()
  await K2.append(Buffer.from(JSON.stringify(post('mais um'))))
  const K2key = K2.key.toString('hex')
  await C.diary.append(join(k.G, K2key))
  await stubbed(events, K2key)
  await until(() => rows(dataDir).length === 1, { name: 'K2 gravado' })
  t.ok((await page(capable, k.G)).some((i) => i.key === K2key && i.length === 1), 'listed to the bit')
  seeder._drop(C.key, 'quota')
  await until(async () => seeder._headerStubs.size === 0 && seeder._drops.size === 0 && !(await stored(seeder, K2key)), { name: 'C removido' })
  t.absent('headerStubs' in readFile(dataDir))
  t.absent((await page(capable, k.G)).some((i) => i.key === K2key), 'no stub after the drop')
  t.is(fatal(events), 0)
})

test('a key\'s own binding wins over its stub, which stays listed in its group', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  // C2 holds G2 and Kd (a writer of G2 for C2) but has not joined them yet.
  const C2 = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G2 = await make('g2', groupHeader({ diary: key, name: 'Dois' }), [post('oi')])
    k.Kd = await make('kd', writerHeader({ group: k.G2, diary: key }), [post('a'), post('b')])
    return []
  })
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }), [post('oi')])
    return [join(k.G, k.G), join(k.G, k.Kd)]
  })
  await admit(C, assoc)
  await stubbed(events, k.Kd, 'wrong-group')
  t.ok(seeder._stubCores.get(k.Kd).ready)

  // C2's join of Kd: Kd is read from the held stub (a quarantine fetch of a
  // key open in the main store never pairs) and becomes a whole writer.
  await C2.diary.append(join(k.G2, k.G2))
  await C2.diary.append(join(k.G2, k.Kd))
  await admit(C2, assoc)
  const ev = await admitted(events, k.Kd)
  t.is(ev.diary, C2.key)
  t.is(ev.group, k.G2)
  await downloaded(seeder, k.Kd, 3)
  t.absent(seeder._stubCores.has(k.Kd), 'no stub session left')
  t.is(readGroups(dataDir)[k.Kd].diary, C2.key)
  t.is(readGroups(dataDir)[k.Kd].group, k.G2)
  t.alike(rows(dataDir), [{ key: k.Kd, group: k.G, diary: C.key, seq: 2 }], 'the row stays')
  const capable = await reader(t, bootstrap, publicKey, { caps: CAP_HEADER_STUBS })
  await downloaded(seeder, k.G2, 2)
  t.ok((await page(capable, k.G2)).some((i) => i.key === k.Kd && i.diary === C2.key && i.length === 3), 'the writer item in G2')
  t.ok((await page(capable, k.G)).some((i) => i.key === k.Kd && i.diary === C.key && i.length === 1 && i.seq === 2), 'the stub item in G')

  // X's own binding of Ke in G itself, after C's stub of it: one item.
  const X = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.Ke = await make('ke', writerHeader({ group: k.G, diary: key }), [post('a'), post('b')])
    return []
  })
  await C.diary.append(join(k.G, k.Ke))
  await stubbed(events, k.Ke, 'wrong-diary')
  await X.diary.append(join(k.G, k.Ke))
  await admit(X, assoc)
  await admitted(events, k.Ke)
  await downloaded(seeder, k.Ke, 3)
  const items = (await page(capable, k.G)).filter((i) => i.key === k.Ke)
  t.alike(items, [{ key: k.Ke, diary: X.key, length: 3, seq: 1 }], 'one item, the writer\'s')
  t.ok(seeder._headerStubs.has(k.G + ':' + k.Ke), 'the row stays behind it')
  t.is(fatal(events), 0)
})

test('a key already held in another role is a listing-only stub, with no second fetch', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  const C2 = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G2 = await make('g2', groupHeader({ diary: key, name: 'Dois' }), [post('oi')])
    k.Kd = await make('kd', writerHeader({ group: k.G2, diary: key }), [post('a'), post('b')])
    return [join(k.G2, k.G2), join(k.G2, k.Kd)]
  })
  await admit(C2, assoc)
  await downloaded(seeder, k.Kd, 3)
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }), [post('oi')])
    return [join(k.G, k.G), join(k.G, k.Kd)]
  })
  await admit(C, assoc)
  await stubbed(events, k.Kd, 'held')
  t.absent(seeder._stubCores.has(k.Kd), 'no stub session')
  t.absent(events.some((e) => e.event === 'group-rejected' && e.key === k.Kd))
  await downloaded(seeder, k.G, 2)
  const capable = await reader(t, bootstrap, publicKey, { caps: CAP_HEADER_STUBS })
  t.ok((await page(capable, k.G)).some((i) => i.key === k.Kd && i.diary === C.key && i.length === 1), 'listed under G')
  t.ok((await page(capable, k.G2)).some((i) => i.key === k.Kd && i.diary === C2.key && i.length === 3), 'still the writer of G2')
  t.is(fatal(events), 0)
})

test('header stubs come back after a restart with no author online, and seed drop removes them', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  const D2 = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G2 = await make('g2', groupHeader({ diary: key, name: 'Dois' }), [post('oi')])
    return [join(k.G2, k.G2)]
  })
  await admit(D2, assoc)
  await downloaded(first.seeder, k.G2, 2)
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }), [post('oi')])
    k.Kb = await make('kb', post('sem cabeçalho'), [post('a')])
    return [join(k.G, k.G), join(k.G, k.Kb), join(k.G, k.G2)]
  })
  await admit(C, assoc)
  await stubbed(first.events, k.Kb, 'header-invalid')
  await stubbed(first.events, k.G2, 'held')
  await downloaded(first.seeder, k.G, 2)
  await until(() => rows(dataDir).length === 2, { name: 'linhas gravadas' })
  const before = rows(dataDir)
  const r1 = await reader(t, bootstrap, publicKey, { caps: CAP_HEADER_STUBS })
  const items = await page(r1, k.G)
  t.is(items.length, 3, 'the root and two stubs')
  await r1.swarm.destroy()
  await C.swarm.destroy()
  await D2.swarm.destroy()
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.alike(rows(dataDir), before, 'same rows')
  t.is(second.seeder._stubCores.get(k.Kb).core.contiguousLength, 1, 'Kb held again, block 0 alone')
  t.absent(second.seeder._stubCores.has(k.G2), 'G2 still a listing only')
  const r2 = await reader(t, bootstrap, publicKey, { caps: CAP_HEADER_STUBS })
  t.alike(await page(r2, k.G), items, 'same items to the bit')
  t.is(fatal(second.events), 0)
  await r2.swarm.destroy()
  await second.seeder.close()

  await Seeder.drop(dataDir, assoc.hex, C.key)
  t.absent('headerStubs' in readFile(dataDir), 'seed drop removes the diary\'s rows')
  const third = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.absent(await stored(third.seeder, k.Kb), 'and purges the stub core')
  t.ok(await stored(third.seeder, k.G2), 'a core with another role stays')
  t.is(third.seeder._headerStubs.size, 0)
  t.is(fatal(third.events), 0)
})

test('a block over the size limit or a member certificate fetched for a join is never a header stub', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  // X is online but never announced: its diary is no role at the seeder.
  const X = await member(t, bootstrap, assoc, async () => [])
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }))
    k.Big = await make('big', { type: 'x', pad: 'a'.repeat(17000) })
    return [join(k.G, k.G), join(k.G, k.Big), join(k.G, X.key)]
  })
  await admit(C, assoc)
  await rejected(events, k.Big, 'header-invalid')
  await rejected(events, X.key, 'header-invalid')
  t.absent(await stored(seeder, k.Big))
  t.absent(await stored(seeder, X.key))
  t.is(seeder._headerStubs.size, 0)
  t.absent(events.some((e) => e.event === 'group-header-stub'))
  t.is(fatal(events), 0)
})

test('a row stays in the file when start drops a blocked diary before the rows are judged', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  const B = await member(t, bootstrap, assoc, async () => [])
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }), [post('oi')])
    k.Kb = await make('kb', post('sem cabeçalho'), [post('a')])
    return [join(k.G, k.G), join(k.G, k.Kb)]
  })
  await admit(B, assoc)
  await admit(C, assoc)
  await stubbed(first.events, k.Kb, 'header-invalid')
  await downloaded(first.seeder, k.G, 2)
  await until(() => rows(dataDir).length === 1, { name: 'linha gravada' })
  const before = rows(dataDir)
  await B.swarm.destroy()
  await C.swarm.destroy()
  await first.seeder.close()

  // B is blocked while the seeder is stopped: step 3a drops it and persists.
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [B.key], revokedIssuers: [] }, mod.kp, mod.cert))
  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.ok(second.events.some((e) => e.event === 'rejected' && e.key === B.key && e.reason === 'blocked'), 'B dropped at start')
  t.absent(second.seeder.admittedKeys().includes(B.key))
  t.alike(rows(dataDir), before, 'the row is still in admitted.json')
  t.ok(second.seeder._stubCores.get(k.Kb).ready, 'Kb held again')
  const r = await reader(t, bootstrap, publicKey, { caps: CAP_HEADER_STUBS })
  t.ok((await page(r, k.G)).some((i) => i.key === k.Kb && i.length === 1), 'and listed')
  t.is(fatal(second.events), 0)
})

test('a stub whose join moves to another group keeps its core with the author offline', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  // X authors Kb but never announces; it goes offline after the first fetch.
  const X = await member(t, bootstrap, assoc, async ({ make }) => {
    k.Kb = await make('kb', post('sem cabeçalho'), [post('a')])
    return []
  })
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }))
    k.G2 = await make('g2', groupHeader({ diary: key, name: 'Dois' }))
    return [join(k.G, k.G), join(k.G2, k.G2), join(k.G, k.Kb)]
  })
  await admit(C, assoc)
  await stubbed(events, k.Kb, 'header-invalid')
  await admitted(events, k.G2)
  await X.swarm.destroy()
  let admissions = 0
  const original = seeder._admitGroupReserved.bind(seeder)
  seeder._admitGroupReserved = (diary, entry, key, ...rest) => {
    if (key === k.Kb && !seeder._stubCores.has(key)) admissions++
    return original(diary, entry, key, ...rest)
  }

  await C.diary.append(join(k.G2, k.Kb))
  await until(() => seeder._headerStubs.has(k.G2 + ':' + k.Kb) && !seeder._headerStubs.has(k.G + ':' + k.Kb) && seeder._drops.size === 0, { name: 'Kb sob G2' })
  t.ok(seeder._stubCores.get(k.Kb).ready, 'the stub core is kept')
  t.ok(await stored(seeder, k.Kb))
  t.is(admissions, 0, 'Kb is never fetched again')
  t.absent(events.some((e) => e.event === 'group-rejected' && e.key === k.Kb), 'no refusal')
  await until(() => rows(dataDir).some((r) => r.key === k.Kb && r.group === k.G2) && !rows(dataDir).some((r) => r.group === k.G), { name: 'arquivo com Kb sob G2' })

  // Only C's own live row answers C's join (_groupDiaryWaiting).
  const rec = seeder._headerStubs.get(k.G2 + ':' + k.Kb)
  t.absent(seeder._groupDiaryWaiting(C.key, k.G2), 'answered by its own row')
  rec.diary = OTHER_DIARY
  t.ok(seeder._groupDiaryWaiting(C.key, k.G2), 'another diary\'s row does not answer it')
  rec.diary = C.key
  rec.dropping = true
  t.ok(seeder._groupDiaryWaiting(C.key, k.G2), 'nor a dropping row')
  rec.dropping = false
  t.is(fatal(events), 0)
})

test('two drops of one stub core and a new admission of it all settle', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const k = {}
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await member(t, bootstrap, assoc, async ({ make }) => {
    k.K = await make('k', post('sem cabeçalho'), [post('a')])
    return []
  })
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G1 = await make('g1', groupHeader({ diary: key, name: 'Um' }))
    k.G3 = await make('g3', groupHeader({ diary: key, name: 'Três' }))
    return [join(k.G1, k.G1), join(k.G3, k.G3), join(k.G1, k.K)]
  })
  const C2 = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G2 = await make('g2', groupHeader({ diary: key, name: 'Dois' }))
    return [join(k.G2, k.G2), join(k.G2, k.K)]
  })
  await admit(C, assoc)
  await stubbed(events, k.K)
  await admit(C2, assoc)
  await until(() => seeder._headerStubs.has(k.G2 + ':' + k.K), { name: 'segunda linha' })
  await admitted(events, k.G3)

  // Both rows go at once (as a fork of K does). The first drop's write
  // waits while C's new join of K starts an admission, which waits for the
  // second drop; that drop must not wait for the admission in turn.
  let open = null
  const held = new Promise((resolve) => { open = resolve })
  const persist = seeder._persist.bind(seeder)
  seeder._persist = () => held.then(() => persist())
  seeder._stubForked(k.K)
  seeder._persist = persist
  await C.diary.append(join(k.G3, k.K))
  await until(() => seeder._inflight.has(k.K), { name: 'admissão de K' })
  open()
  await until(() => seeder._drops.size === 0 && !seeder._inflight.has(k.K), { name: 'tudo resolvido', timeoutMs: 30000 })
  await until(() => seeder._headerStubs.has(k.G3 + ':' + k.K), { name: 'K sob G3' })
  t.is(seeder._headerStubs.size, 1)
  await Promise.race([seeder.close(), new Promise((resolve, reject) => setTimeout(() => reject(new Error('close() não terminou')), 20000))])
  t.pass('close() returns')
  t.is(fatal(events), 0)
})

test('a stub refused for a changed block 0 or a failed admission is not fetched again on each reconcile', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  await member(t, bootstrap, assoc, async ({ make }) => {
    k.Kf = await make('kf', post('um'), [post('a')])
    k.Ka = await make('ka', post('dois'), [post('a')])
    return []
  })
  // Kf's block 0 from the quarantine fetch differs from the stored one (as
  // when its author signs two); Ka's admission fails before its core opens.
  const admitStub = seeder._admitHeaderStub.bind(seeder)
  const persist = seeder._persist.bind(seeder)
  let failPersist = false
  seeder._persist = () => {
    if (failPersist) {
      failPersist = false
      return Promise.reject(new Error('falha simulada'))
    }
    return persist()
  }
  seeder._admitHeaderStub = (diary, entry, key, group, seq, kind, raw) => {
    if (key === k.Kf) raw = Buffer.concat([raw, Buffer.from(' ')])
    if (key === k.Ka) failPersist = true
    return admitStub(diary, entry, key, group, seq, kind, raw)
  }
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }))
    return [join(k.G, k.G), join(k.G, k.Kf), join(k.G, k.Ka)]
  })
  await admit(C, assoc)
  await rejected(events, k.Kf, 'fork')
  await rejected(events, k.Ka, 'admission-failed')
  await until(() => !seeder._inflight.has(k.Kf) && !seeder._inflight.has(k.Ka), { name: 'admissões terminadas' })
  let tries = 0
  const admitGroup = seeder._admitGroup.bind(seeder)
  seeder._admitGroup = (diary, entry, key, ...rest) => {
    if (key === k.Kf || key === k.Ka) tries++
    return admitGroup(diary, entry, key, ...rest)
  }
  const entry = seeder._served.get(C.key)
  for (let i = 0; i < 3; i++) seeder._reconcileGroups(C.key, entry)
  t.is(tries, 0, 'neither key is fetched again')
  t.is(seeder._headerStubs.size, 0)
  t.absent(await stored(seeder, k.Kf))
  t.absent(await stored(seeder, k.Ka))
  t.is(fatal(events), 0)
})

test('maxHeaderStubs never exceeds the rows admitted.json keeps', (t) => {
  const dataDir = tmpDir(t, 'varanda-seed-')
  t.is(new Seeder({ dataDir, maxHeaderStubs: 100000 }).maxHeaderStubs, 8192)
  t.is(new Seeder({ dataDir, maxHeaderStubs: 3 }).maxHeaderStubs, 3)
})

test('a stub moved at both caps keeps its core, and its old row is not listed while the move settles', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxHeaderStubs: 8 })
  const k = { K: [] }
  // X authors every stub key and goes offline after the first fetch.
  const X = await member(t, bootstrap, assoc, async ({ make }) => {
    for (let i = 0; i < 8; i++) k.K.push(await make('k' + i, post('bloco ' + i), [post('a')]))
    return []
  })
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G1 = await make('g1', groupHeader({ diary: key, name: 'Um' }))
    k.G2 = await make('g2', groupHeader({ diary: key, name: 'Dois' }))
    return [join(k.G1, k.G1), join(k.G2, k.G2), ...k.K.map((K, i) => join(i < 5 ? k.G1 : k.G2, K))]
  })
  await admit(C, assoc)
  for (const K of k.K) await stubbed(events, K)
  await admitted(events, k.G1)
  await admitted(events, k.G2)
  await until(() => k.K.every((K) => seeder._stubCores.get(K) && seeder._stubCores.get(K).ready), { name: 'oito núcleos' })
  t.is(seeder._headerStubs.size, 8, 'both caps reached')
  await X.swarm.destroy()
  const capable = await reader(t, bootstrap, publicKey, { caps: CAP_HEADER_STUBS })
  const K = k.K[0]
  t.ok((await page(capable, k.G1)).some((i) => i.key === K), 'listed under G1 before the move')

  // The new join's read of the held core waits until released.
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const stubBlock = seeder._stubBlock.bind(seeder)
  seeder._stubBlock = async (stub) => {
    if (stub === seeder._stubCores.get(K)) await gate
    return stubBlock(stub)
  }
  let admissions = 0
  const original = seeder._admitGroupReserved.bind(seeder)
  seeder._admitGroupReserved = (diary, entry, key, ...rest) => {
    if (key === K && !seeder._stubCores.has(key)) admissions++
    return original(diary, entry, key, ...rest)
  }
  await C.diary.append(join(k.G2, K))
  await until(() => seeder._inflight.has(K), { name: 'admissão de K' })
  t.ok(seeder._headerStubs.has(k.G1 + ':' + K) && !seeder._headerStubs.get(k.G1 + ':' + K).dropping, 'the old row is kept while the join is in flight')
  t.absent((await page(capable, k.G1)).some((i) => i.key === K), 'but not listed under G1')
  release()

  await until(() => seeder._headerStubs.has(k.G2 + ':' + K) && !seeder._headerStubs.has(k.G1 + ':' + K) && seeder._drops.size === 0, { name: 'K sob G2' })
  t.is(seeder._headerStubs.size, 8, 'still 8 rows')
  t.ok(seeder._stubCores.get(K).ready, 'the stub core is kept')
  t.ok(await stored(seeder, K))
  t.is(admissions, 0, 'K is never fetched again')
  t.absent(events.some((e) => e.event === 'group-rejected' && e.key === K), 'no stub-full')
  t.ok((await page(capable, k.G2)).some((i) => i.key === K && i.length === 1), 'listed under G2')
  t.is(fatal(events), 0)
})

test('a stub row kept for a moved join leaves when that join is refused or its admission ends', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  const X = await member(t, bootstrap, assoc, async ({ make }) => {
    k.Ka = await make('ka', post('um'), [post('a')])
    k.Kb = await make('kb', post('dois'), [post('a')])
    return []
  })
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }))
    k.G2 = await make('g2', groupHeader({ diary: key, name: 'Dois' }))
    k.G3 = await make('g3', groupHeader({ diary: key, name: 'Três' }))
    return [join(k.G, k.G), join(k.G2, k.G2), join(k.G3, k.G3), join(k.G, k.Ka), join(k.G, k.Kb)]
  })
  await admit(C, assoc)
  await stubbed(events, k.Ka)
  await stubbed(events, k.Kb)
  await admitted(events, k.G2)
  await admitted(events, k.G3)
  await X.swarm.destroy()

  // Kb's new join reads no block 0 from the held core once: the admission
  // ends with a wait, and the old row leaves as it settles.
  const stubBlock = seeder._stubBlock.bind(seeder)
  let fail = true
  seeder._stubBlock = async (stub) => {
    if (fail && stub === seeder._stubCores.get(k.Kb)) {
      fail = false
      return { raw: null, error: new Error('falha simulada'), length: 0, byteLength: 0 }
    }
    return stubBlock(stub)
  }
  await C.diary.append(join(k.G3, k.Kb))
  await rejected(events, k.Kb, 'timeout')
  await until(async () => !seeder._headerStubs.has(k.G + ':' + k.Kb) && seeder._drops.size === 0 && !(await stored(seeder, k.Kb)), { name: 'Kb fora', timeoutMs: 10000 })
  t.absent(seeder._headerStubs.has(k.G3 + ':' + k.Kb), 'not moved with the held core')
  t.absent(seeder._stubCores.has(k.Kb))

  // Ka's new join names a blocked group: refused with no wait, so its old
  // row leaves in the same pass.
  const mod = moderator(assoc)
  const capable = await reader(t, bootstrap, publicKey, { caps: CAP_HEADER_STUBS, blocklist: createSnapshot({ seq: 1, blocked: [k.G2], revokedIssuers: [] }, mod.kp, mod.cert) })
  await until(() => !seeder._groupServed.has(k.G2) && seeder._drops.size === 0, { name: 'G2 bloqueado' })
  t.ok(seeder._headerStubs.has(k.G + ':' + k.Ka), 'the row under G stays until the move')
  await C.diary.append(join(k.G2, k.Ka))
  await rejected(events, k.Ka, 'group-blocked')
  await until(async () => !seeder._headerStubs.has(k.G + ':' + k.Ka) && seeder._drops.size === 0 && !(await stored(seeder, k.Ka)), { name: 'Ka fora', timeoutMs: 10000 })
  t.absent((await page(capable, k.G)).some((i) => i.key === k.Ka || i.key === k.Kb), 'nothing listed under G')
  t.absent('headerStubs' in readFile(dataDir))
  t.is(fatal(events), 0)
})

test('a root purged for its creator is not kept again as a stub of another group', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  const E = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.R = await make('r', groupHeader({ diary: key, name: 'Raiz' }), [post('oi')])
    // R2 is a root E never joins: a stub of G holds its block 0.
    k.R2 = await make('r2', groupHeader({ diary: key, name: 'Outra' }), [post('oi')])
    return [join(k.R, k.R)]
  })
  await admit(E, assoc)
  await downloaded(seeder, k.R, 2)
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }), [post('oi')])
    return [join(k.G, k.G), join(k.G, k.R), join(k.G, k.R2)]
  })
  await admit(C, assoc)
  await stubbed(events, k.R, 'held')
  await stubbed(events, k.R2, 'header-invalid')
  await downloaded(seeder, k.G, 2)

  // E blocked: R is purged with it, and C's join of R is tried again.
  const mod = moderator(assoc)
  const capable = await reader(t, bootstrap, publicKey, { caps: CAP_HEADER_STUBS, blocklist: createSnapshot({ seq: 1, blocked: [E.key], revokedIssuers: [] }, mod.kp, mod.cert) })
  await until(async () => !seeder._groupServed.has(k.R) && seeder._drops.size === 0 && !(await stored(seeder, k.R)), { name: 'R removido' })
  const from = events.findIndex((e) => e.event === 'group-header-stub-dropped' && e.key === k.R)
  t.ok(from >= 0, 'the listing-only row left with R')
  const after = (e) => events.indexOf(e) > from && e.key === k.R && e.diary === C.key
  const outcome = await until(() => events.find((e) => after(e) && (e.event === 'group-header-stub' || e.event === 'group-rejected')), { name: 'nova junta de R julgada', timeoutMs: 30000 })
  t.is(outcome.event, 'group-rejected', 'refused, not stubbed')
  t.is(outcome.reason, 'blocked')
  t.absent(seeder._stubCores.has(k.R))
  t.absent(await stored(seeder, k.R), 'R not stored again')
  t.absent(seeder._headerStubs.has(k.G + ':' + k.R))
  t.absent((await page(capable, k.G)).some((i) => i.key === k.R), 'not listed under G')

  // R2's held stub goes with its creator, purged, and is not taken again.
  t.ok(events.some((e) => e.event === 'group-header-stub-dropped' && e.key === k.R2 && e.reason === 'blocked'), 'R2 dropped for its creator')
  await until(async () => !seeder._headerStubs.has(k.G + ':' + k.R2) && seeder._drops.size === 0 && !(await stored(seeder, k.R2)), { name: 'R2 removido' })
  await rejected(events, k.R2, 'blocked')
  t.absent(seeder._stubCores.has(k.R2))
  t.absent('headerStubs' in readFile(dataDir))
  t.is(fatal(events), 0)
})

test('a held stub core that forked during the read gives no block 0', async (t) => {
  const seeder = new Seeder({ dataDir: tmpDir(t, 'varanda-seed-') })
  const raw = Buffer.from('bloco')
  const core = { fork: 0, length: 2, byteLength: 9, get: async () => { core.fork = 1; return raw } }
  const forked = await seeder._stubBlock({ core })
  t.is(forked.raw, null)
  t.ok(forked.error)
  core.get = async () => raw
  core.fork = 0
  const ok = await seeder._stubBlock({ core })
  t.is(ok.raw, raw)
  t.is(ok.error, null)
})

test('the storage budget drops a diary with its held stub, and a role a listing-only row rested on', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const k = {}
  await member(t, bootstrap, assoc, async ({ make }) => {
    k.Kb = await make('kb', post('sem cabeçalho'), [post('a')])
    return []
  })
  const C2 = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G2 = await make('g2', groupHeader({ diary: key, name: 'Dois' }), [post('oi')])
    k.Kd = await make('kd', writerHeader({ group: k.G2, diary: key }), [post('a'), post('b')])
    return [join(k.G2, k.G2), join(k.G2, k.Kd)]
  })
  await admit(C2, assoc)
  await downloaded(seeder, k.Kd, 3)
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.G = await make('g', groupHeader({ diary: key, name: 'Um' }), [post('oi')])
    return [join(k.G, k.G), join(k.G, k.Kb), join(k.G, k.Kd)]
  })
  await admit(C, assoc)
  await stubbed(events, k.Kb, 'header-invalid')
  await stubbed(events, k.Kd, 'held')
  await until(() => rows(dataDir).length === 2, { name: 'duas linhas gravadas' })

  // C2 out by the budget (the drop _storagePass makes): Kd's role is
  // purged, its row leaves and C's join of Kd is fetched and stubbed again.
  seeder._dropOwner(C2.key)
  await until(() => events.some((e) => e.event === 'group-header-stub-dropped' && e.key === k.Kd && e.reason === 'unbound'), { name: 'linha de Kd fora' })
  await until(() => seeder._stubCores.get(k.Kd) && seeder._stubCores.get(k.Kd).ready, { name: 'Kd guardado de novo', timeoutMs: 30000 })
  t.ok(events.some((e) => e.event === 'group-header-stub' && e.key === k.Kd && e.reason === 'wrong-group'), 'the join was retried')
  t.ok(seeder._headerStubs.has(k.G + ':' + k.Kd))

  // C out by the budget: both rows go, the stub cores are purged first.
  seeder._dropOwner(C.key)
  await until(async () => seeder._headerStubs.size === 0 && seeder._drops.size === 0 && !(await stored(seeder, k.Kb)) && !(await stored(seeder, k.Kd)), { name: 'C removido' })
  t.is(seeder._stubCores.size, 0)
  t.absent('headerStubs' in readFile(dataDir), 'no rows left in the file')
  t.is(fatal(events), 0)
})
