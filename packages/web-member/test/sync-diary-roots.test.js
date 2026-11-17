'use strict'

// The browser sync and a second device of the same identity: every root the
// own diary binds now (diaryGroupKeys) is paged as a replica, from a fresh
// storage, with nothing appended and no writer created. A root whose only
// join was turned off is not, nor a blocked one. A once run ends only after
// the roots of the diary it fetched were paged, and a catalogue child paged
// root only is paged in full once the diary joins it.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { groupJoinRecord, groupCutRecord } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { member, seederOverWs, indexed, sync, once, named, held, lender, moderatorSnapshot } = require('./helpers/sync-groups')

// Another device of `a`: the same key pair and group key derivation, a
// fresh storage, nothing appended (certAdd and profileSet would fork the
// diary).
async function device (a) {
  const storage = memoryNodeStorage()
  const ctx = { ...a.ctx, storage }
  await ops.idCreate(ctx)
  return { storage, ownHex: a.ownHex, ctx }
}

async function diaryLength (m) {
  return (await ops.logRead(m.ctx)).entries.length
}

async function groupJoins (m) {
  return (await ops.logRead(m.ctx)).entries.filter((e) => e.record.type === 'group-join').length
}

async function rootHeld (m, key) {
  const h = await held(m, key)
  return h !== null && h.contiguous > 0
}

// A public group root of `m` whose header names `community` (any key) as
// its parent, listed and bound as group.create would, past the member-ops
// checks (as community-sync.test.js crafts it): -> its key.
async function craftRoot (m, community, name) {
  const nonce = crypto.randomBytes(32)
  const kp = await m.ctx.groupKeyPair(new Uint8Array(nonce))
  const key = b4a.toString(kp.publicKey, 'hex')
  const core = await store.openGroupWriter(m.storage, kp)
  try {
    await store.appendGroupRecord(core, grp.groupHeader({ kind: 'group', diary: m.ownHex, community, member: community, join: 'open', name }), { root: true })
  } finally {
    await core.close()
  }
  const hexNonce = b4a.toString(nonce, 'hex')
  await store.putGroupWriter(m.storage, { group: key, key, nonce: hexNonce, rootNonce: hexNonce })
  const diary = await store.openDiary(m.storage, m.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupJoinRecord({ group: key, writer: key, on: true }))
  } finally {
    await diary.close()
  }
  return key
}

// An `until` that fails the test instead of rejecting: a rejection out of a
// test body is unhandled and ends the whole file.
async function waitFor (t, predicate, opts) {
  try {
    await until(predicate, opts)
    return true
  } catch (err) {
    t.fail(err.message)
    return false
  }
}

test('a second device of the same identity fetches the roots its diary binds', async (t) => {
  t.timeout(110000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const e = await member(assocKp, 'Edu')

  // B, another device of A, holds A's diary (its certificate) before any
  // join: no group is stored, no certificate recovery holds its next run.
  t.ok((await once(a, url, [])).ok, 'A pushed its diary')
  const b = await device(a)
  t.ok((await once(b, url, [])).ok, 'B fetched the diary')
  t.alike(await store.readGroupReplicas(b.storage), [], 'B holds no group')

  // E's community, whose root A binds and unbinds: not bound now.
  const { community: L } = await ops.communityCreate(e.ctx, { name: 'Largo', join: 'open' })
  t.ok((await once(e, url, [])).ok, 'E pushed its community')
  const { community: C, group: G } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupJoinRecord({ group: L, writer: L, on: true }))
    await store.appendRecord(diary, groupJoinRecord({ group: L, writer: L, on: false }))
  } finally {
    await diary.close()
  }
  t.ok((await once(a, url, [])).ok, 'A pushed C and Geral')
  await until(() => indexed(seeder, C, C) && indexed(seeder, G, G) && indexed(seeder, L, L), { name: 'roots indexed' })
  const aLength = await diaryLength(a)
  const aJoins = await groupJoins(a)

  // One once run: it ends only after the diary it fetched was scanned and
  // the roots it binds were paged.
  const events = []
  const first = await once(b, url, events)
  t.ok(first.ok, 'B run after the joins ok ' + JSON.stringify(first.errors))
  t.ok(await rootHeld(b, C), 'B holds the community root')
  t.ok(await rootHeld(b, G), 'B holds the Geral root')
  t.absent(await rootHeld(b, L), 'B never fetched a root no join binds now')
  t.alike(await store.readGroupWriters(b.storage), [], 'B created no writer')
  t.is(await diaryLength(b), aLength, 'B holds A\'s diary')
  t.is(await groupJoins(b), aJoins, 'B appended no group-join')
  t.absent(named(events, 'group-skipped').some((x) => x.group === C || x.group === G), 'neither root skipped')

  // A posts to Geral; B's next run keeps both roots live and takes it.
  const before = await held(b, G)
  await ops.groupPost(a.ctx, { group: G, text: 'oi do bairro' })
  t.ok((await once(a, url, [])).ok, 'A pushed the post')
  const third = []
  const res = await once(b, url, third)
  t.ok(res.ok, 'B second run ok ' + JSON.stringify(res.errors))
  t.ok((await held(b, G)).contiguous > before.contiguous, 'the post reached B')
  t.absent(named(third, 'group-skipped').some((x) => x.group === C || x.group === G), 'both roots stay live')
  t.alike(await store.readGroupWriters(b.storage), [], 'still no writer')

  // A third device whose blocklist names Geral: Geral is never fetched.
  const c = await device(a)
  await store.writeBlocklist(c.storage, moderatorSnapshot(assocKp, { blocked: [G] }))
  const blocked = []
  t.ok((await once(c, url, blocked)).ok, 'C first run ok')
  t.ok(await rootHeld(c, C), 'the community root is fetched')
  t.is(await store.groupCoreExists(c.storage, G), false, 'the blocked root is never stored')
  t.absent(named(blocked, 'group-paged').some((x) => x.group === G), 'the blocked root is never paged')
})

test('a catalogue child paged root only is paged in full once the diary joins it', async (t) => {
  t.timeout(110000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const e = await member(assocKp, 'Edu')
  const a = await member(assocKp, 'Ana')

  // E's community CE with a group H; A joins CE, not H.
  const { community: CE } = await ops.communityCreate(e.ctx, { name: 'Praça', join: 'open' })
  const { group: H } = await ops.groupCreate(e.ctx, { name: 'Horta', join: 'open', community: CE })
  t.ok((await once(e, url, [])).ok, 'E pushed CE and H')
  await until(() => indexed(seeder, CE, CE) && indexed(seeder, H, H), { name: 'roots indexed' })
  await store.addGroupReplica(a.storage, CE)
  t.ok((await once(a, url, [])).ok, 'A fetched CE')
  t.is((await ops.communityJoin(a.ctx, { community: CE })).state, 'member', 'A joined CE')
  t.ok((await once(a, url, [])).ok, 'A pushed its join')

  // B, a device of A, holds CE; its catalogue names H, paged root only.
  const b = await device(a)
  t.ok((await once(b, url, [])).ok, 'B first run ok')
  t.ok(await rootHeld(b, CE), 'B holds CE')
  t.ok(await rootHeld(b, H), 'B holds H\'s root')

  // A continuous run of B pages H root only; no timed pass follows within
  // the test, so only the diary's join pages H again. Whether that page
  // lists W depends on when the seeder indexes it, so the page itself is
  // what the run is checked for.
  const ev = []
  const ac = new AbortController()
  const run = sync(b, url, ev, { signal: ac.signal, groupPageMs: 600000 })
  let W = null
  try {
    if (!await waitFor(t, () => named(ev, 'group-paged').some((x) => x.group === H && x.count === 1), { name: 'H paged root only', timeoutMs: 30000 })) return
    const mark = ev.length

    // A joins H and posts there with a new writer W; B's diary takes the join.
    await ops.groupJoin(a.ctx, { group: H, community: CE })
    await ops.groupPost(a.ctx, { group: H, text: 'oi da horta' })
    W = (await ops.logRead(a.ctx)).entries.find((x) => x.record.type === 'group-join' && x.record.group === H && x.record.on).record.writer
    t.not(W, H, 'W is not H\'s root')
    t.ok((await once(a, url, [])).ok, 'A pushed W')
    if (!await waitFor(t, () => ev.slice(mark).some((x) => x.event === 'group-paged' && x.group === H), { name: 'H paged again after the join', timeoutMs: 30000 })) return
    t.pass('the join paged H again within the run')
  } finally {
    ac.abort()
    await run
  }

  // Delivery, once the seeder lists W: a once run adopts H as a replica
  // from the start and pages it in full.
  if (!await waitFor(t, () => indexed(seeder, H, W), { name: 'W indexed' })) return
  const res = await once(b, url, [])
  t.ok(res.ok, 'B once run ok ' + JSON.stringify(res.errors))
  t.ok(((await held(b, W)) || { contiguous: 0 }).contiguous >= 2, 'B fetched W and its post')
  t.alike(await store.readGroupWriters(b.storage), [], 'B created no writer')
})

test('a root the diary binds through a writer joined after released slots is fetched (#350)', async (t) => {
  t.timeout(110000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const e = await member(assocKp, 'Edu')
  t.ok((await once(a, url, [])).ok, 'A pushed its diary')
  const b = await device(a)
  t.ok((await once(b, url, [])).ok, 'B fetched the diary')
  const { community: L } = await ops.communityCreate(e.ctx, { name: 'Largo', join: 'open' })
  t.ok((await once(e, url, [])).ok, 'E pushed its community')
  await until(() => indexed(seeder, L, L), { name: 'root indexed' })
  // Every live slot of A's diary in L taken once, left and released by a
  // cut 0, then one more writer: only the slot walk read with the cuts
  // binds L now.
  const ghost = () => b4a.toString(crypto.keyPair().publicKey, 'hex')
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  try {
    for (let i = 0; i < grp.MAX_GROUP_WRITERS_PER_DIARY; i++) {
      const w = ghost()
      await store.appendRecord(diary, groupJoinRecord({ group: L, writer: w, on: true }))
      await store.appendRecord(diary, groupJoinRecord({ group: L, writer: w, on: false }))
      await store.appendRecord(diary, groupCutRecord({ group: L, writer: w, cut: 0 }))
    }
    await store.appendRecord(diary, groupJoinRecord({ group: L, writer: ghost(), on: true }))
  } finally {
    await diary.close()
  }
  // The writers never reach the seeder, so L's pages stay incomplete and
  // a once run cannot end: a continuous run, read through its lender.
  t.ok((await once(a, url, [])).ok, 'A pushed the joins and cuts')
  const ev = []
  const ac = new AbortController()
  const lent = lender()
  const run = sync(b, url, ev, { signal: ac.signal, reader: lent.reader, groupPageMs: 600000 })
  try {
    if (!await waitFor(t, () => (lent.held(L) || { contiguous: 0 }).contiguous > 0, { name: 'B adopted L', timeoutMs: 40000 })) return
    t.pass('B holds the root its diary binds now')
  } finally {
    ac.abort()
    await run
  }
  t.alike(await store.readGroupWriters(b.storage), [], 'B created no writer')
})

test('a diary-bound group another bound root names as its community is still held', async (t) => {
  t.timeout(110000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')

  // A's community C with its Geral G1, and G2 whose header names G1 (a
  // group) as its community: the diary binds all three.
  const { community: C, group: G1 } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const G2 = await craftRoot(a, G1, 'Horta')
  t.ok((await once(a, url, [])).ok, 'A pushed C, G1 and G2')
  await until(() => indexed(seeder, C, C) && indexed(seeder, G1, G1) && indexed(seeder, G2, G2), { name: 'roots indexed' })

  // B, another device of A: the first run fetches every root, the second
  // starts with G2 stored, its header read before any page.
  const b = await device(a)
  for (const run of ['first', 'second']) {
    const ev = []
    const res = await once(b, url, ev)
    t.ok(res.ok, 'B ' + run + ' run ok ' + JSON.stringify(res.errors))
    t.ok(await rootHeld(b, G1), 'B holds G1 after the ' + run + ' run')
    t.ok(await rootHeld(b, G2), 'B holds G2 after the ' + run + ' run')
    t.absent(named(ev, 'group-skipped').some((x) => x.group === G1), 'G1 never refused in the ' + run + ' run')
  }
})

test('a writer the diary newly binds to a root already held as a replica is fetched at once', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const e = await member(assocKp, 'Edu')
  const a = await member(assocKp, 'Ana')

  // E's community CE; A joins it with a writer W1 and pushes.
  const { community: CE } = await ops.communityCreate(e.ctx, { name: 'Praça', join: 'open' })
  t.ok((await once(e, url, [])).ok, 'E pushed CE')
  await until(() => indexed(seeder, CE, CE), { name: 'CE indexed' })
  await store.addGroupReplica(a.storage, CE)
  t.ok((await once(a, url, [])).ok, 'A fetched CE')
  t.is((await ops.communityJoin(a.ctx, { community: CE }, { general: false })).state, 'member', 'A joined CE')
  t.ok((await once(a, url, [])).ok, 'A pushed W1')
  const joined = async () => (await ops.logRead(a.ctx)).entries.filter((x) => x.record.type === 'group-join' && x.record.group === CE && x.record.on).map((x) => x.record.writer)
  const [W1] = await joined()
  await until(() => indexed(seeder, CE, W1), { name: 'W1 indexed' })

  // B, another device of A, adopts CE as a replica and holds W1.
  const b = await device(a)
  t.ok((await once(b, url, [])).ok, 'B first run ok')
  t.ok(await rootHeld(b, W1), 'B holds W1')

  // A continuous run of B with no timed pass within the test: only the
  // diary's new join can page CE again.
  const ev = []
  const ac = new AbortController()
  const run = sync(b, url, ev, { signal: ac.signal, groupPageMs: 600000 })
  let W2 = null
  try {
    if (!await waitFor(t, () => named(ev, 'group-paged').some((x) => x.group === CE), { name: 'CE paged', timeoutMs: 30000 })) return

    // A leaves and joins again: a new writer W2 on the same root.
    const start = Date.now()
    t.is((await ops.communityLeave(a.ctx, { community: CE })).state, 'left', 'A left CE')
    t.is((await ops.communityJoin(a.ctx, { community: CE }, { general: false })).state, 'member', 'A joined CE again')
    W2 = (await joined()).find((w) => w !== W1)
    t.ok(W2, 'the diary binds a new writer')
    t.ok((await once(a, url, [])).ok, 'A pushed W2')
    if (!await waitFor(t, () => named(ev, 'group-writer').some((x) => x.writer === W2), { name: 'W2 accepted by B', timeoutMs: 40000 })) return
    t.pass('B took W2 ' + (Date.now() - start) + ' ms after A joined again, long before the 600 s pass')

    // Held: the chase ends, no more page of CE follows its waits.
    const after = named(ev, 'group-paged').filter((x) => x.group === CE).length
    await new Promise((resolve) => setTimeout(resolve, 20000))
    t.is(named(ev, 'group-paged').filter((x) => x.group === CE).length, after, 'no page of CE once W2 is held')
  } finally {
    ac.abort()
    await run
  }
})

// Test seam: a block of the own diary that is not there yet, or whose read
// fails, only for the group-join scan. A real network cannot make the scan
// meet that block deterministically (the tracker's present length stops at a
// plain hole), so the hypercore reads made under adoptDiaryGroups /
// readDiaryJoin (found by their stack frames) answer `mode.kind` for the seq
// `mode.seq`: 'hole' (has() false) or 'throw'. Everything else is untouched.
function scanSeam (mode) {
  const { get, has } = Hypercore.prototype
  const fromScan = () => /adoptDiaryGroups|readDiaryJoin/.test(new Error().stack)
  Hypercore.prototype.has = function (start, ...rest) {
    if (mode.kind === 'hole' && start === mode.seq && fromScan()) {
      mode.hits++
      mode.core = this // the run's own diary session, to emit its events
      return Promise.resolve(false)
    }
    return has.call(this, start, ...rest)
  }
  Hypercore.prototype.get = function (index, ...rest) {
    if (mode.kind === 'throw' && index === mode.seq && fromScan()) {
      mode.hits++
      return Promise.reject(new Error('injected read failure'))
    }
    return get.call(this, index, ...rest)
  }
  return () => {
    Hypercore.prototype.get = get
    Hypercore.prototype.has = has
  }
}

// B holds only the diary's early blocks; A then binds a root R that nothing
// else leads to (a crafted group whose header names Geral of its community:
// no catalogue lists it, and it is no parent), its group-join at `seq` in
// the diary, and pushes. -> what a run of B needs, R named C below.
async function diaryJoinSetup (t) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  t.ok((await once(a, url, [])).ok, 'A pushed its diary')
  const b = await device(a)
  t.ok((await once(b, url, [])).ok, 'B fetched the diary')
  const { group: G } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const C = await craftRoot(a, G, 'Horta')
  t.ok((await once(a, url, [])).ok, 'A pushed its roots')
  await until(() => indexed(seeder, G, G) && indexed(seeder, C, C), { name: 'roots indexed' })
  const entries = (await ops.logRead(a.ctx)).entries
  const seq = entries.findIndex((x) => x.record.type === 'group-join' && x.record.group === C && x.record.on)
  return { a, b, url, C, seq }
}

test('a diary block the join scan could not read is read again and its root adopted in the same run', async (t) => {
  t.timeout(140000)
  const { b, url, C, seq } = await diaryJoinSetup(t)
  t.ok(seq > 0, 'the join is at seq ' + seq)
  const mode = { kind: 'throw', seq, hits: 0 }
  t.teardown(scanSeam(mode))
  const ev = []
  const ac = new AbortController()
  const run = sync(b, url, ev, { signal: ac.signal, groupPageMs: 600000 })
  try {
    if (!await waitFor(t, () => mode.hits > 0, { name: 'the scan met the failing block', timeoutMs: 40000 })) return
    t.absent(named(ev, 'group-paged').some((x) => x.group === C), 'C is not adopted while the block cannot be read')
    mode.kind = null
    // The length does not change: only the retry timer can read it again.
    if (!await waitFor(t, () => named(ev, 'group-paged').some((x) => x.group === C), { name: 'C adopted after the retry', timeoutMs: 40000 })) return
    t.pass('the failed read was retried and C adopted')
  } finally {
    ac.abort()
    await run
  }
})

test('a diary block missing at a scan does not hide its group-join from the next scan', async (t) => {
  t.timeout(140000)
  const { a, b, url, C, seq } = await diaryJoinSetup(t)
  const mode = { kind: 'hole', seq, hits: 0 }
  t.teardown(scanSeam(mode))
  const ev = []
  const ac = new AbortController()
  const run = sync(b, url, ev, { signal: ac.signal, groupPageMs: 600000 })
  try {
    if (!await waitFor(t, () => mode.hits > 0, { name: 'the scan met the missing block', timeoutMs: 40000 })) return
    t.absent(named(ev, 'group-paged').some((x) => x.group === C), 'C is not adopted while the block is missing')
    mode.kind = null
    // A later block: the next scan must read the one it skipped.
    await ops.profileSet(a.ctx, { name: 'Ana Maria', bio: '' })
    t.ok((await once(a, url, [])).ok, 'A pushed a later block')
    if (!await waitFor(t, () => named(ev, 'group-paged').some((x) => x.group === C), { name: 'C adopted by a later scan', timeoutMs: 40000 })) return
    t.pass('the skipped block was read by a later scan')
  } finally {
    ac.abort()
    await run
  }
})

test('a diary block that downloads after the scan skipped it is read at once, the length unchanged', async (t) => {
  t.timeout(140000)
  const { b, url, C, seq } = await diaryJoinSetup(t)
  const mode = { kind: 'hole', seq, hits: 0, core: null }
  t.teardown(scanSeam(mode))
  const ev = []
  const ac = new AbortController()
  const run = sync(b, url, ev, { signal: ac.signal, groupPageMs: 600000 })
  try {
    if (!await waitFor(t, () => mode.hits > 0, { name: 'the scan met the missing block', timeoutMs: 40000 })) return
    t.absent(named(ev, 'group-paged').some((x) => x.group === C), 'C is not adopted while the block is missing')
    mode.kind = null
    // The diary's own event for that block: nothing else changes.
    mode.core.emit('download', seq, 0, null)
    if (!await waitFor(t, () => named(ev, 'group-paged').some((x) => x.group === C), { name: 'C adopted by the download', timeoutMs: 30000 })) return
    t.pass('the download scanned the diary again')
  } finally {
    ac.abort()
    await run
  }
})

test('a new writer pages only its own group, and a run start chases no writer it already knew', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const { community: C, group: G } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'A pushed C and Geral')
  await until(() => indexed(seeder, C, C) && indexed(seeder, G, G), { name: 'roots indexed' })
  const b = await device(a)
  t.ok((await once(b, url, [])).ok, 'B holds both roots')
  const paged = (ev, key) => named(ev, 'group-paged').filter((x) => x.group === key).length
  // The writer page requests the seeder answers, per group (the events of a
  // complete page do not count an incomplete one).
  const asks = new Map()
  const answer = seeder.groupWriters.bind(seeder)
  seeder.groupWriters = (q) => {
    asks.set(q.group, (asks.get(q.group) || 0) + 1)
    return answer(q)
  }
  const asked = (key) => asks.get(key) || 0

  // A binds a writer of C that the seeder will never list: the chase asks
  // for C at once and after each wait, and never for Geral.
  const ev = []
  const ac = new AbortController()
  const run = sync(b, url, ev, { signal: ac.signal, groupPageMs: 600000 })
  try {
    if (!await waitFor(t, () => paged(ev, C) > 0 && paged(ev, G) > 0, { name: 'first pass', timeoutMs: 30000 })) return
    const ghost = crypto.keyPair().publicKey
    const diary = await store.openDiary(a.storage, a.ctx.keyPair)
    try {
      await store.appendRecord(diary, groupJoinRecord({ group: C, writer: b4a.toString(ghost, 'hex'), on: true }))
    } finally {
      await diary.close()
    }
    t.ok((await once(a, url, [])).ok, 'A pushed the join of an unlisted writer')
    // A's own run asked too: count from here, the chase being still on.
    const c0 = asked(C)
    const g0 = asked(G)
    await new Promise((resolve) => setTimeout(resolve, 22000))
    t.ok(asked(C) - c0 >= 2 && asked(C) - c0 <= 3, 'C asked again after the waits: ' + (asked(C) - c0))
    t.is(asked(G), g0, 'Geral was not asked by the chase')
  } finally {
    ac.abort()
    await run
  }

  // A new run of B starts with that writer already in its diary: the
  // regular pass is the only one to ask, none of the three chase pages.
  const ev2 = []
  const ac2 = new AbortController()
  const c1 = asked(C)
  const g1 = asked(G)
  const run2 = sync(b, url, ev2, { signal: ac2.signal, groupPageMs: 600000 })
  try {
    if (!await waitFor(t, () => asked(C) > c1 && asked(G) > g1, { name: 'second run first pass', timeoutMs: 30000 })) return
    await new Promise((resolve) => setTimeout(resolve, 20000))
    t.is(asked(C), c1 + 1, 'no chase for a writer the run started with')
  } finally {
    ac2.abort()
    await run2
  }
})
