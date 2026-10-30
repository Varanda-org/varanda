// Group cores at the seeder that time out and are retried (backoff waits,
// header deadlines, a purge outlasting a wait) and the diary scan stall
// budget; the rest of the group-core tests are in seeder-groups.test.js and
// seeder-groups-3.test.js.

const test = require('brittle')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { joinAndFlush, topicFor } = require('../lib/net')
const { groupJoinRecord, postRecord } = require('../lib/records')
const { groupHeader, writerHeader, groupPost } = require('../lib/group')
const { createSnapshot } = require('../lib/blocklist')
const clock = require('../lib/clock')
const {
  hex,
  makeAssociation,
  readFile,
  prepareSeederDir,
  startSeeder,
  encode,
  member,
  admit,
  reader,
  admitted,
  rejected,
  downloaded,
  moderator,
  creatorAndMember,
  gate,
  scansDone
} = require('./helpers/seeder-groups')

test('a group core that timed out waits before the next try and is logged once', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // X is a writer key nobody holds: its fetch can only time out.
  const X = hex(signingKeyPair().publicKey)
  const R = 'cd'.repeat(32)
  const B = await member(t, bootstrap, assoc, async () => [groupJoinRecord({ group: R, writer: X, on: true })])
  await admit(B, assoc)
  await rejected(events, X, 'timeout')
  const timeouts = () => events.filter((e) => e.event === 'group-rejected' && e.key === X && e.reason === 'timeout').length
  for (let i = 0; i < 5; i++) seeder._retryGroups(null)
  t.absent(seeder._groupReserved.has(X), 'no new fetch inside the wait')
  const id = B.key + ':' + X
  t.is(seeder._groupBackoff.get(id).step, 0)

  // Past the wait the next trigger fetches again; the same refusal is not
  // logged twice, and the wait grows.
  seeder._groupBackoff.get(id).until = 0
  seeder._retryGroups(null)
  t.ok(seeder._groupReserved.has(X), 'fetched again past the wait')
  await until(() => seeder._groupBackoff.get(id).step === 1, { name: 'segunda espera', timeoutMs: 40000 })
  t.is(timeouts(), 1, 'one log line for the same refusal')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a core that timed out once is retried by timer when its wait ends, without any new hello', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const B = await member(t, bootstrap, assoc, async () => [])
  await admit(B, assoc)
  // B joins a root it holds but has not written yet: the first fetch of
  // block 0 can only time out.
  const root = B.store.get({ name: 'later' })
  await root.ready()
  const R = hex(root.key)
  let hellos = 0
  const original = seeder._retryGroupTimeouts.bind(seeder)
  seeder._retryGroupTimeouts = () => {
    hellos++
    return original()
  }
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await rejected(events, R, 'timeout')
  await root.append(encode(groupHeader({ diary: B.key, name: 'Depois' })))
  // Each retry is the timer's; a slow replication may need a second one.
  await until(() => events.find((e) => e.event === 'group-admitted' && e.key === R), { name: 'R admitido pelo temporizador', timeoutMs: 60000 })
  t.is(hellos, 0, 'no hello was involved')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a diary whose signed length runs ahead of withheld blocks stops holding other groups\' pages incomplete after the stall bound', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const stallMs = 1500
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, groupScanStallMs: stallMs })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  const S = await member(t, bootstrap, assoc, async () => [])
  await admit(A, assoc)
  await admit(B, assoc)
  await admit(S, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await downloaded(seeder, R, 2)
  await downloaded(seeder, W, 3)
  await until(() => scansDone(seeder) && seeder.indexGroup(R).complete, { name: 'R completo' })

  // S signs a new length offline and drops the block before it is back on
  // the swarm (a member that withholds it forever).
  const entry = seeder._served.get(S.key)
  await S.swarm.leave(topicFor(assoc.hex))
  for (const c of [...S.swarm.connections]) c.destroy()
  await until(() => S.swarm.connections.size === 0, { name: 'S desconectado' })
  await S.diary.append(postRecord({ text: 'retido' }))
  await S.diary.clear(S.diary.length - 1, S.diary.length)
  await joinAndFlush(S.swarm, [topicFor(assoc.hex)])
  await until(() => entry.core.length === S.diary.length, { name: 'tamanho assinado de S', timeoutMs: 30000 })
  t.ok(entry.core.contiguousLength < entry.core.length, 'the seeder sees a signed length ahead of its blocks')
  await until(() => scansDone(seeder), { name: 'varredura parada no prefixo' })
  const from = Date.now()
  t.is(seeder.indexGroup(R).complete, false, 'incomplete while S may still progress')
  await until(() => seeder.indexGroup(R).complete, { name: 'R completo apesar de S', timeoutMs: 15000 })
  t.ok(Date.now() - from >= stallMs - 50, 'only after the stall bound')
  t.is(seeder.indexGroupSearch('qualquer').complete, true, 'search is settled too')
  t.is(seeder.indexGroups(S.key).complete, false, 'S\'s own group list stays incomplete')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a diary scan catching up with blocks it holds keeps counting; the stall budget is spent only while caught up inside a gap and the gap closing does not refill it', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const stallMs = 300
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, groupScanStallMs: stallMs })
  const K = 'a'.repeat(64)
  const entry = { gated: true, scanQueued: false, scanned: 1, core: { contiguousLength: 3, length: 3 } }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  t.is(seeder._groupScanCounts(K, entry), true, 'scanning blocks it holds: counts')
  await wait(stallMs + 50)
  t.is(seeder._groupScanCounts(K, entry), true, 'no gap: still counts past the bound')
  entry.core.length = 5
  t.is(seeder._groupScanCounts(K, entry), true, 'gap open, scan behind its prefix: counts')
  await wait(stallMs + 50)
  t.is(seeder._groupScanCounts(K, entry), true, 'the clock waits for the scan to catch up')
  entry.scanned = 3
  t.is(seeder._groupScanCounts(K, entry), true, 'caught up inside the gap: the clock starts')
  await wait(stallMs + 50)
  t.is(seeder._groupScanCounts(K, entry), false, 'gap still open past the bound: no longer counts')
  entry.core.contiguousLength = 5
  t.is(seeder._groupScanCounts(K, entry), false, 'the gap closed: the spent budget still holds while the scan catches up')
  t.ok(seeder._groupStalls.get(K).out !== null, 'until the window passes')
  entry.scanned = 5
  t.is(seeder._groupScanCounts(K, entry), false, 'caught up')
})

test('a diary closing and reopening its gap stops counting once its time caught up inside gaps adds up to the stall bound', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const stallMs = 600
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, groupScanStallMs: stallMs })
  const K = 'a'.repeat(64)
  const entry = { gated: true, scanQueued: false, scanned: 1, core: { contiguousLength: 1, length: 2 } }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const from = Date.now()
  let early = true
  let late = null
  while (Date.now() - from < stallMs * 4) {
    const open = seeder._groupScanCounts(K, entry)
    await wait(stallMs / 4)
    const still = seeder._groupScanCounts(K, entry)
    // The block arrives: the gap closes, the scan catches up, a new length opens the next gap.
    entry.core.contiguousLength = entry.core.length
    seeder._groupScanCounts(K, entry)
    entry.scanned = entry.core.contiguousLength
    seeder._groupScanCounts(K, entry)
    entry.core.length++
    const elapsed = Date.now() - from
    if (elapsed < stallMs / 2 && (!open || !still)) early = false
    if (elapsed > stallMs * 2 && late === null) late = open || still
  }
  t.ok(early, 'counts while the budget lasts')
  t.is(late, false, 'gaps closing and reopening do not refill the budget')
})

test('a diary releasing one block per interval shorter than the stall bound stops counting after the bound', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const stallMs = 600
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, groupScanStallMs: stallMs })
  const K = 'a'.repeat(64)
  const entry = { gated: true, scanQueued: false, scanned: 1, core: { contiguousLength: 1, length: 1000 } }
  // The seeder's monotonic clock, stepped by hand: with real timers the four
  // intervals before the bound could sum just under it on a loaded runner,
  // the budget then ran out on the next interval's first call, and that call
  // (a new block, so not stalled) still counted.
  const realNow = clock.now
  let now = realNow()
  clock.now = () => now
  t.teardown(() => { clock.now = realNow })
  const step = stallMs / 4
  t.is(seeder._groupScanCounts(K, entry), true, 'caught up inside the gap: counts')
  let early = true
  let late = null
  for (let elapsed = step; elapsed <= stallMs * 3; elapsed += step) {
    now += step
    entry.core.contiguousLength++
    const a = seeder._groupScanCounts(K, entry)
    entry.scanned = entry.core.contiguousLength
    const b = seeder._groupScanCounts(K, entry)
    if (elapsed < stallMs && (!a || !b)) early = false
    if (elapsed > stallMs && late === null) late = a || b
  }
  t.ok(early, 'counts before the bound')
  t.is(late, false, 'a trickle inside the gap does not re-arm the clock')
  t.ok(entry.core.contiguousLength < entry.core.length, 'the gap stayed open throughout')
})

test('a diary dropped and served again within the stall window keeps its spent stall budget, and the budgets kept stay bounded', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const stallMs = 300
  const { seeder } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, groupScanStallMs: stallMs, maxServed: 4 })
  const K = 'b'.repeat(64)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const fresh = () => ({ gated: true, scanQueued: false, scanned: 1, core: { contiguousLength: 1, length: 2 } })
  const first = fresh()
  t.is(seeder._groupScanCounts(K, first), true, 'caught up inside a gap: counts')
  await wait(stallMs + 50)
  t.is(seeder._groupScanCounts(K, first), false, 'budget spent')
  // A fork drops the served entry; the author announces again and a new
  // entry is served for the same key.
  const again = fresh()
  t.is(seeder._groupScanCounts(K, again), false, 'the new entry of the same key does not refill the budget')

  // Keys stalling once each and never served again: the map stays bounded
  // and a served key's budget is never the one evicted.
  const served = 'c'.repeat(64)
  seeder._served.set(served, fresh())
  seeder._groupScanCounts(served, fresh())
  for (let i = 0; i < 50; i++) seeder._groupScanCounts(i.toString(16).padStart(64, '0'), fresh())
  t.ok(seeder._groupStalls.size <= 2 * seeder.maxServed, 'at most 2 * maxServed budgets kept')
  t.ok(seeder._groupStalls.has(served), 'the served diary keeps its budget')
  seeder._served.delete(served)
})

test('a header timeout whose purge outlasts the first wait still retries the join once the purge settles', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const hold = gate()
  const headerMs = 1500
  const purgeMs = 4000
  let W = null
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    groupHeaderTimeoutMs: headerMs,
    admitHook: (key, step) => step === 'open' ? hold.hook(key) : undefined,
    purgeHook: async (core) => {
      if (hex(core.key) === W) await new Promise((resolve) => setTimeout(resolve, purgeMs))
      await core.purge()
    }
  })
  // Only the backoff timer may retry: no hello-driven retry.
  seeder._retryGroupTimeouts = () => {}

  const made = await creatorAndMember(t, bootstrap, assoc)
  const { A, B, R } = made
  W = made.W
  await admit(A, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 2)
  hold.key = W
  await admit(B, assoc)
  await until(() => hold.entered, { name: 'W passou pela quarentena' })
  await B.cores.w.clear(0, 1)
  hold.open()
  await admitted(events, W)
  let retries = 0
  const original = seeder._admitGroup.bind(seeder)
  seeder._admitGroup = (diary, entry, key, ...rest) => {
    if (key === W) retries++
    return original(diary, entry, key, ...rest)
  }
  await rejected(events, W, 'timeout')
  t.ok(seeder._groupsDropping.has(W), 'W is still being purged when its first wait ends')
  await until(() => !seeder._drops.has(W), { name: 'W purgado', timeoutMs: 30000 })
  await until(() => retries > 0, { name: 'W tentado de novo depois da purga', timeoutMs: 15000 })
  t.ok(retries > 0, 'the join is retried')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root purged for its blocked creator keeps its kind on the group page while a member\'s writer is served, also after a restart, until the group itself is blocked', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, R)
  await admitted(first.events, W)
  await downloaded(first.seeder, R, 2)
  await downloaded(first.seeder, W, 3)
  t.is(first.seeder.indexGroup(R).rootServed, true, 'root served')

  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [A.key], revokedIssuers: [] }, mod.kp, mod.cert) })
  await rejected(first.events, R, 'blocked')
  await until(() => first.seeder._drops.size === 0 && scansDone(first.seeder), { name: 'R purgado' })
  const shown = (page, label) => {
    t.alike(page.header && { kind: page.header.kind, visibility: page.header.visibility, join: page.header.join, name: page.header.name, diary: page.header.diary },
      { kind: 'group', visibility: 'public', join: 'open', name: 'Cadeiras da praia', diary: null }, label + ': the verified header, no creator')
    t.is(page.rootServed, false, label + ': the root itself is not served')
    t.ok(page.writers.some((w) => w.key === W), label + ': the member\'s writer is listed')
  }
  shown(first.seeder.indexGroup(R), 'root purged')
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await until(() => second.seeder.indexGroup(R).writers.some((w) => w.key === W) && scansDone(second.seeder), { name: 'W listado' })
  shown(second.seeder.indexGroup(R), 'after a restart')

  // The group key blocked: the record goes with the group.
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 2, blocked: [A.key, R], revokedIssuers: [] }, mod.kp, mod.cert) })
  await until(() => !second.seeder._groupServed.has(W), { name: 'W derrubado' })
  t.is(second.seeder.indexGroup(R), null, 'a blocked group has no page')
  t.absent(second.seeder._groupHeaders.has(R), 'nor a header record')
  await until(() => second.seeder._drops.size === 0 && !(R in (readFile(dataDir).groupHeaders || {})), { name: 'registro removido do arquivo' })
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root withheld from the main store past its header timeout still shows the kind its quarantine check verified while a writer is served', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const hold = gate()
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    groupHeaderTimeoutMs: 1500,
    admitHook: (key, step) => step === 'open' ? hold.hook(key) : undefined
  })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  hold.key = R
  await admit(A, assoc)
  await until(() => hold.entered, { name: 'R passou pela quarentena' })
  // A served block 0 to the quarantine and now withholds it.
  await A.cores.root.clear(0, 1)
  hold.open()
  await admitted(events, R)
  await admit(B, assoc)
  await admitted(events, W)
  await downloaded(seeder, W, 3)
  await rejected(events, R, 'timeout')
  await until(() => !seeder._groupServed.has(R) && !seeder._drops.has(R), { name: 'R purgado' })
  const page = seeder.indexGroup(R)
  t.is(page.header && page.header.kind, 'group', 'kind from the quarantine header')
  t.is(page.header && page.header.name, 'Cadeiras da praia')
  t.is(page.header && page.header.diary, null, 'no creator')
  t.is(page.rootServed, false)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a group page with a served writer and no root header at all is never complete', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // R is a root key nobody holds; B's writer W names it.
  const R = hex(signingKeyPair().publicKey)
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: R, diary: key }), [groupPost({ text: 'olá' })])
    return [groupJoinRecord({ group: R, writer: W, on: true })]
  })
  await admit(B, assoc)
  await downloaded(seeder, W, 2)
  await rejected(events, R, 'timeout')
  // Its retry timed out too (a stale join no longer holds pages back).
  const wait = seeder._groupBackoff.get(B.key + ':' + R)
  wait.step = 1
  wait.until = Date.now() + 600000
  await until(() => seeder._groupReserved.size === 0 && scansDone(seeder), { name: 'R julgado' })
  const page = seeder.indexGroup(R)
  t.ok(page.writers.some((w) => w.key === W), 'the writer is listed')
  t.is(page.header, null, 'no header was ever verified')
  t.is(page.rootServed, false)
  t.is(page.complete, false, 'so the page is not complete')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a diary served before its block 0 is local spends the stall budget and is dropped at the re-gate timeout', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const hold = gate()
  const regateMs = 8000
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    groupScanStallMs: 1000,
    regateTimeoutMs: regateMs,
    admitHook: (key, step) => step === 'open' ? hold.hook(key) : undefined
  })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Praça' }))
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  await admit(A, assoc)
  await admitted(events, R)
  await downloaded(seeder, R, 1)
  await until(() => seeder.indexGroup(R).complete && scansDone(seeder), { name: 'R completo' })

  const C = await member(t, bootstrap, assoc, async () => [postRecord({ text: 'oi' })])
  hold.key = C.key
  const peer = await C.seederPeer()
  peer.send({ type: 'announce', key: C.key, cert: C.certOf(C.key) })
  await until(() => hold.entered, { name: 'C passou pela quarentena' })
  // C served block 0 to the quarantine and now withholds it.
  await C.diary.clear(0, 1)
  const from = Date.now()
  hold.open()
  await until(() => seeder._served.has(C.key), { name: 'C servido' })
  t.absent(seeder._served.get(C.key).gated, 'C waits for its block 0')
  await until(() => seeder.indexGroup(R).complete, { name: 'R completo de novo', timeoutMs: regateMs - 2000 })
  t.ok(seeder._served.has(C.key), 'R settles while C is still served: C spent its stall budget')
  await until(() => events.find((e) => e.event === 'rejected' && e.key === C.key && e.reason === 'timeout'), { name: 'C derrubado', timeoutMs: 30000 })
  t.ok(Date.now() - from >= regateMs - 1000, 'dropped at the re-gate deadline')
  t.absent(seeder._served.has(C.key))
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
