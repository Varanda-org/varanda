'use strict'

// Browser member sync of header and member stubs (#350, docs/protocol.md
// section 10, "Header stubs"): a listed writer whose block 0 can never count
// for the hinted diary (undecodable, invalid, a legacy header, one naming
// another group or another diary, or a `member` that does not match the
// root's kind) is held as a stub, block 0 alone, once that diary proves the
// join; unproven, it keeps its verdict as a hint. A stub naming another
// diary gives way to that diary's listing, and a restart keeps a stub only
// while the stored binding diary still proves the join.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const store = require('../lib/node-store')
const { memoryNodeStorage } = require('../lib/node-storage')
const ops = require('../lib/member-ops')
const { CAP_HEADER_STUBS } = require('@varanda/core/lib/admission')
const { hex, member, seederOverWs, indexed, sync, once, named, lender, joinSeq, injectWriters, moderatorSnapshot } = require('./helpers/sync-groups')

const enc = (record) => b4a.from(JSON.stringify(record))
const AT = '2026-01-01T00:00:00.000Z'
const sorted = (items) => items.slice().sort((x, y) => x.key < y.key ? -1 : 1)
const skips = (events, key) => named(events, 'group-skipped').filter((e) => e.key === key).map((e) => e.reason)

// Block 0 of each kind of stub, for a core `diary` joins to `group` (a
// group of a community: its writers name their CW as `member`), and the
// verdict a listing whose join is not proven keeps.
const CW = hex(crypto.randomBytes(32))
const HEADS = {
  undecodable: { raw: () => b4a.from('{ nada'), verdict: 'header-invalid' },
  invalid: { raw: (group) => enc({ type: 'group-writer', v: 2, group }), verdict: 'header-invalid' },
  legacy: { raw: (group, diary) => enc({ type: 'group-writer', v: 1, group, diary, box: null, rejoin: null, at: AT }), verdict: 'header-invalid' },
  'another group': { raw: (group, diary) => enc(grp.writerHeader({ group: hex(crypto.randomBytes(32)), diary, member: CW })), verdict: 'wrong-group' },
  'another diary': { raw: (group) => enc(grp.writerHeader({ group, diary: hex(crypto.randomBytes(32)), member: CW })), verdict: 'wrong-diary' },
  member: { raw: (group, diary) => enc(grp.writerHeader({ group, diary, member: null })), verdict: 'header-invalid' }
}

async function bind (m, group, writer) {
  const diary = await store.openDiary(m.storage, m.ctx.keyPair)
  try {
    await store.appendRecord(diary, groupJoinRecord({ group, writer, on: true }))
  } finally {
    await diary.close()
  }
}

async function blocksHeld (core, from, to) {
  const out = []
  for (let i = from; i < to; i++) if (await core.has(i)) out.push(i)
  return out
}

// -> { length, contiguous, held } of a stored group core. Only with no run
// of m live.
async function heldCopy (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  if (core === null) return null
  try {
    return { length: core.length, contiguous: core.contiguousLength, held: await blocksHeld(core, 0, core.length) }
  } finally {
    await core.close()
  }
}

// kv headerStubs as key -> the diary that proved the stub.
async function recorded (m) {
  return Object.fromEntries((await store.readHeaderStubs(m.storage)).map((x) => [x.key, x.diary]))
}

// A core of the seeder's store whose block 0 is `raw`, then one post: open
// for the test, so the seeder serves it whatever its own gate thinks.
async function seederCore (t, seeder, name, raw) {
  const core = seeder.store.get({ name })
  await core.ready()
  t.teardown(() => core.close().catch(() => {}))
  await core.append(raw)
  await core.append(enc(grp.groupPost({ text: name })))
  return hex(core.key)
}

// A's community and its Geral G, with member B; one core per kind of stub
// in the seeder's store, each joined to G by B's diary and listed with it.
// R, a member of G too, has fetched none of them.
async function stubWorld (t, kinds = Object.keys(HEADS)) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  const c = await member(assocKp, 'Caio')
  const r = await member(assocKp, 'Rui')
  // The seeder's own gate refuses these joins and purges the cores (it lists
  // no header stubs yet): it leaves them alone and serves them from its store,
  // as one that lists header stubs will.
  const skip = new Set()
  const admit = seeder._admitGroup.bind(seeder)
  seeder._admitGroup = (diary, entry, key, ...rest) => skip.has(key) || skip.has(diary + ':' + key) ? Promise.resolve() : admit(diary, entry, key, ...rest)
  const { community, group } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  t.ok((await once(a, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  // R joins too, before any stub is listed: it holds the root, so the kind
  // a writer's `member` must match is known when the stubs are gated.
  for (const m of [b, c, r]) {
    await store.addGroupReplica(m.storage, group)
    t.ok((await once(m, url, [])).ok, 'member fetched the roots')
    t.is((await ops.communityJoin(m.ctx, { community })).state, 'member', 'joined the community and its Geral')
  }
  const stubs = {}
  for (const name of kinds) {
    const key = await seederCore(t, seeder, 'stub-' + name, HEADS[name].raw(group, b.ownHex))
    skip.add(key)
    await bind(b, group, key)
    stubs[name] = { key, diary: b.ownHex, length: 2, seq: await joinSeq(b, group, key) }
  }
  t.ok((await once(b, url, [])).ok, 'B pushed its diary')
  t.ok((await once(c, url, [])).ok, 'C pushed its diary')
  const wb = (await store.readGroupWriters(b.storage)).find((e) => e.group === group).key
  const wc = (await store.readGroupWriters(c.storage)).find((e) => e.group === group).key
  await until(() => indexed(seeder, group, wb) && indexed(seeder, group, wc), { name: 'writers indexed', timeoutMs: 30000 })
  return { seeder, url, assocKp, a, b, c, r, community, group, stubs, wb, wc, skip }
}

test('a listed writer whose block 0 can never count for the diary that joined it is held as a stub once the join is proven, and a restart keeps it while that diary does (#350)', async (t) => {
  t.timeout(300000)
  const { seeder, url, r, group, stubs } = await stubWorld(t)
  const listed = sorted(Object.values(stubs))
  injectWriters(seeder, group, listed)
  const ev = []
  const rr = await once(r, url, ev)
  t.ok(rr.ok, 'R\'s run ends ok: ' + JSON.stringify(rr.errors))
  const rec = await recorded(r)
  for (const [name, x] of Object.entries(stubs)) {
    t.alike(skips(ev, x.key), [], name + ': never refused')
    t.alike(await heldCopy(r, x.key), { length: 2, contiguous: 1, held: [0] }, name + ': block 0 alone, though the seeder holds a post')
    if (name !== 'member') t.is(rec[x.key], x.diary, name + ': recorded with the diary that proved it')
  }
  t.absent(stubs.member.key in rec, 'a member stub names its own pair: not recorded')
  const read = await ops.groupRead(r.ctx, { group })
  t.is(read.incomplete, false, 'the fold no longer waits for them')
  t.absent(read.items.some((p) => typeof p.text === 'string' && p.text.startsWith('stub-')), 'and nothing past their block 0 counts')

  // A restart: every stub is kept while B's stored diary proves it, but one
  // whose record names a diary R does not hold goes (no longer listed, so
  // nothing gates it again).
  const purged = stubs['another group'].key
  const kept = await store.readHeaderStubs(r.storage)
  await r.storage.writeJson('headerStubs', { v: 1, stubs: kept.map((x) => x.key === purged ? { ...x, diary: hex(crypto.randomBytes(32)) } : x) })
  listed.splice(listed.findIndex((x) => x.key === purged), 1)
  const again = []
  const rr2 = await once(r, url, again)
  t.ok(rr2.ok, 'R\'s next run ends ok: ' + JSON.stringify(rr2.errors))
  for (const [name, x] of Object.entries(stubs)) {
    if (x.key === purged) continue
    t.alike(skips(again, x.key), [], name + ': kept, never refused')
    t.alike(await heldCopy(r, x.key), { length: 2, contiguous: 1, held: [0] }, name + ': still block 0 alone')
  }
  t.is(await heldCopy(r, purged), null, 'the stub no stored diary proves goes')
  const rec2 = await recorded(r)
  t.absent(purged in rec2, 'and leaves the record')
  t.is(rec2[stubs.legacy.key], stubs.legacy.diary, 'a legacy stub survives the legacy sweep')
})

test('a header stub listed with a diary that does not prove its join keeps its verdict as a hint, and another listing that proves it makes it a stub (#350)', async (t) => {
  t.timeout(300000)
  const { seeder, url, b, r, group, stubs, wb } = await stubWorld(t, ['legacy'])
  const x = stubs.legacy
  // First listed at the seq of B's own writer's join, which names no stub.
  let current = { ...x, seq: await joinSeq(b, group, wb) }
  const real = seeder.groupWriters.bind(seeder)
  seeder.groupWriters = (q) => {
    const page = real(q)
    if (q.group !== group) return page
    return { ...page, items: sorted([...page.items, current]) }
  }
  const ev = []
  const lent = lender()
  const ac = new AbortController()
  const run = sync(r, url, ev, { signal: ac.signal, groupPageMs: 300, reader: lent.reader })
  try {
    await until(() => skips(ev, x.key).length > 0, { name: 'the unproven listing refused', timeoutMs: 60000 })
    t.alike(skips(ev, x.key), ['header-invalid'], 'with its header\'s verdict')
    t.absent(lent.held(x.key), 'and nothing held')
    current = x
    await until(() => {
      const h = lent.held(x.key)
      return h !== null && h.contiguous === 1
    }, { name: 'the proven listing makes it a stub', timeoutMs: 60000 })
  } finally {
    ac.abort()
    await run
  }
  t.alike(await heldCopy(r, x.key), { length: 2, contiguous: 1, held: [0] }, 'block 0 alone')
})

test('a stub naming another diary of the group gives way to that diary\'s listing, and is then fetched in full (#350)', async (t) => {
  t.timeout(300000)
  const { seeder, url, b, c, r, group, wb, skip } = await stubWorld(t, [])
  // C's diary joins B's writer too: listed with C, B's writer is a stub of
  // (G, C), its block 0 naming B.
  await ops.groupPost(b.ctx, { group, text: 'de B' })
  t.ok((await once(b, url, [])).ok, 'B pushed its post')
  skip.add(c.ownHex + ':' + wb)
  await bind(c, group, wb)
  t.ok((await once(c, url, [])).ok, 'C pushed the join')
  const asStub = { key: wb, diary: c.ownHex, length: 2, seq: await joinSeq(c, group, wb) }
  let hide = true
  const real = seeder.groupWriters.bind(seeder)
  seeder.groupWriters = (q) => {
    const page = real(q)
    if (q.group !== group) return page
    const items = page.items.filter((it) => !(hide && it.key === wb))
    return { ...page, items: sorted(hide ? [...items, asStub] : items) }
  }
  const ev = []
  const lent = lender()
  const ac = new AbortController()
  const run = sync(r, url, ev, { signal: ac.signal, groupPageMs: 300, reader: lent.reader })
  try {
    await until(() => {
      const h = lent.held(wb)
      return h !== null && h.contiguous === 1
    }, { name: 'B\'s writer held as a stub of C', timeoutMs: 60000 })
    t.is(lent.held(wb).contiguous, 1, 'block 0 alone while listed with C')
    hide = false
    await until(() => {
      const h = lent.held(wb)
      return h !== null && h.contiguous > 1 && h.contiguous === h.length
    }, { name: 'fetched in full once listed with B', timeoutMs: 60000 })
  } finally {
    ac.abort()
    await run
  }
  t.alike(skips(ev, wb), [], 'never refused')
  t.absent(wb in (await recorded(r)), 'and no longer recorded as a stub')
  t.ok((await ops.groupRead(r.ctx, { group })).items.some((p) => p.text === 'de B'), 'B\'s post is read')
})

test('the browser node announces that it holds header stubs (#350)', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const peers = []
  const add = seeder._peers.add.bind(seeder._peers)
  seeder._peers.add = (p) => {
    peers.push(p)
    return add(p)
  }
  const a = await member(assocKp, 'Ana')
  t.ok((await once(a, url, [])).ok, 'the run ends ok')
  t.ok(peers.some((p) => p.remoteCaps === CAP_HEADER_STUBS), 'its admission open carries the header stubs bit alone')
})

test('an identity reset clears kv headerStubs (#350)', async (t) => {
  const storage = memoryNodeStorage()
  const k = () => hex(crypto.randomBytes(32))
  await store.addHeaderStub(storage, { key: k(), group: k(), diary: k() })
  t.is((await store.readHeaderStubs(storage)).length, 1, 'recorded')
  await store.deleteGroupData(storage)
  t.is(await storage.readJson('headerStubs'), null, 'cleared, so the next person on the device inherits no stub keys')
})

test('a group root first held as a stub of another group leaves the record once gated as its root, and a record alone never purges it at start (#350)', async (t) => {
  t.timeout(300000)
  const { seeder, url, a, b, r, community, group, skip } = await stubWorld(t, [])
  // A's group G2 of the community, with a post; B's diary joins its root K
  // to G as well.
  const { group: k } = await ops.groupCreate(a.ctx, { name: 'Outro', join: 'open', community })
  await ops.groupPost(a.ctx, { group: k, text: 'de A' })
  t.ok((await once(a, url, [])).ok, 'A pushed G2')
  await until(() => indexed(seeder, k, k), { name: 'G2 root indexed' })
  skip.add(b.ownHex + ':' + k)
  await bind(b, group, k)
  t.ok((await once(b, url, [])).ok, 'B pushed the join')
  const rootCore = seeder.store.get({ key: b4a.from(k, 'hex') })
  await rootCore.ready()
  t.teardown(() => rootCore.close().catch(() => {}))
  const len = rootCore.length
  t.ok(len > 1, 'G2\'s root holds blocks past 0')
  const full = { length: len, contiguous: len, held: Array.from({ length: len }, (_, i) => i) }
  const asStub = { key: k, diary: b.ownHex, length: full.length, seq: await joinSeq(b, group, k) }
  // No page lists K but as B's writer of G until `hide` goes.
  let hide = true
  const real = seeder.groupWriters.bind(seeder)
  seeder.groupWriters = (q) => {
    const page = real(q)
    const items = hide ? page.items.filter((it) => it.key !== k) : page.items
    return { ...page, items: sorted(q.group === group ? [...items, asStub] : items) }
  }
  t.ok((await once(r, url, [])).ok, 'R\'s first run ends ok')
  t.alike(await recorded(r), { [k]: b.ownHex }, 'K held as a stub of (G, B)')
  t.is((await heldCopy(r, k)).contiguous, 1, 'block 0 alone')
  hide = false
  await store.addGroupReplica(r.storage, k)
  t.ok((await once(r, url, [])).ok, 'R\'s second run ends ok')
  t.alike(await heldCopy(r, k), full, 'then gated as G2\'s root and fetched in full')
  t.alike(await recorded(r), {}, 'and it leaves the record')
  // A record left by an earlier run, naming a diary R never held; offline,
  // so nothing purged here could be fetched again.
  await r.storage.writeJson('headerStubs', { v: 1, stubs: [{ key: k, group, diary: hex(crypto.randomBytes(32)) }] })
  await once(r, 'ws://127.0.0.1:9', [], { timeoutMs: 5000 })
  t.alike(await heldCopy(r, k), full, 'a core held past block 0 is kept in full')
  t.alike(await recorded(r), {}, 'only its record goes')
})

test('a core stored before its gate is a header stub only when kv headerStubs records it (#350)', async (t) => {
  t.timeout(300000)
  const { seeder, url, r, group, stubs } = await stubWorld(t, ['another group'])
  const x = stubs['another group']
  injectWriters(seeder, group, [x])
  t.ok((await once(r, url, [])).ok, 'R\'s first run ends ok')
  t.alike(await recorded(r), { [x.key]: x.diary }, 'held as a stub of (G, B)')
  // The record is lost: the stored core rests under the group its header
  // names, and B's listing of it is judged as before.
  await r.storage.writeJson('headerStubs', { v: 1, stubs: [] })
  const ev = []
  t.ok((await once(r, url, ev)).ok, 'R\'s second run ends ok')
  t.alike(skips(ev, x.key), ['wrong-group'], 'refused with its header\'s verdict, not made a stub')
  t.alike(await recorded(r), {}, 'and not recorded')
  t.comment('held after: ' + JSON.stringify(await heldCopy(r, x.key)))
})

test('a verdict on the diary that proved a recorded stub leaves the stub\'s core in place (#350)', async (t) => {
  t.timeout(300000)
  const { seeder, url, b, r, group, stubs, assocKp } = await stubWorld(t, ['undecodable'])
  const x = stubs.undecodable
  injectWriters(seeder, group, [x])
  t.ok((await once(r, url, [])).ok, 'R\'s first run ends ok')
  t.alike(await recorded(r), { [x.key]: x.diary }, 'held as a stub of (G, B)')
  const ev = []
  const lent = lender()
  const ac = new AbortController()
  const run = sync(r, url, ev, { signal: ac.signal, groupPageMs: 300, reader: lent.reader })
  try {
    await until(() => lent.held(x.key) !== null, { name: 'the stub held at start', timeoutMs: 60000 })
    await seeder._offerBlocklist(moderatorSnapshot(assocKp, { blocked: [b.ownHex] }), null)
    await until(() => skips(ev, x.key).length > 0, { name: 'the stub leaves the table', timeoutMs: 60000 })
  } finally {
    ac.abort()
    await run
  }
  t.alike(skips(ev, x.key), ['blocked'], 'for the blocked diary that proved it')
  t.ok(await store.groupCoreExists(r.storage, x.key), 'but its core stays')
  t.alike(await heldCopy(r, x.key), { length: 2, contiguous: 1, held: [0] }, 'block 0 and all')
})
