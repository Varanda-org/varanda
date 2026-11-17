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
