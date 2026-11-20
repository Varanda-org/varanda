'use strict'

// Browser member sync of header stubs (#350, docs/protocol.md section 10,
// "Header stubs"), continued from sync-groups-5.test.js: a blocked proving
// diary purges a stub no entry of the run holds, and a revoked issuer of the
// proving diary and a blocked group purge the stubs with their records.
// Split from sync-groups-4 so each file stays under the CI per-file timeout.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
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
// R, a member of G too, has fetched none of them. With `issuer` (a key
// pair), B's certificate comes from that issuer.
async function stubWorld (t, kinds = Object.keys(HEADS), { issuer = null } = {}) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const issCert = issuer === null ? null : createIssuerCert({ issuer: hex(issuer.publicKey) }, assocKp)
  const b = await member(assocKp, 'Bia', issuer === null ? null : (key) => createIssuedCert({ member: key }, issuer, issCert))
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

// Every writer page of `group` with `extra.items` added, which a test
// changes between runs.
function extraWriters (seeder, group) {
  const extra = { items: [] }
  const real = seeder.groupWriters.bind(seeder)
  seeder.groupWriters = (q) => {
    const page = real(q)
    if (q.group !== group) return page
    return { ...page, items: sorted([...page.items, ...extra.items]) }
  }
  return extra
}

test('a recorded stub no entry of the run holds is purged in the run when the diary that proved it is blocked (#350)', async (t) => {
  t.timeout(300000)
  const { seeder, url, b, r, group, stubs, assocKp, wb } = await stubWorld(t, ['undecodable'])
  const x = stubs.undecodable
  const extra = extraWriters(seeder, group)
  extra.items = [x]
  t.ok((await once(r, url, [])).ok, 'R\'s first run ends ok')
  t.alike(await recorded(r), { [x.key]: x.diary }, 'held as a stub of (G, B)')
  // Unlisted and no longer paged: the next run opens no entry for it, and
  // only its record names it.
  await store.removeGroupReplica(r.storage, x.key)
  extra.items = []
  const ev = []
  const lent = lender()
  const ac = new AbortController()
  const run = sync(r, url, ev, { signal: ac.signal, groupPageMs: 300, reader: lent.reader })
  try {
    await until(() => lent.held(wb) !== null, { name: 'the run under way', timeoutMs: 60000 })
    t.is(lent.held(x.key), null, 'the stub is not opened')
    await seeder._offerBlocklist(moderatorSnapshot(assocKp, { blocked: [b.ownHex] }), null)
    await until(() => skips(ev, x.key).length > 0, { name: 'the stub purged', timeoutMs: 30000 })
  } finally {
    ac.abort()
    await run
  }
  t.alike(skips(ev, x.key), ['blocked'], 'for the blocked diary that proved it')
  t.absent(await store.groupCoreExists(r.storage, x.key), 'purged in this run')
  t.alike(await recorded(r), {}, 'with its record')
})

test('a revoked issuer of the diary that proved a stub stored in this run purges the stub with its record (#350)', async (t) => {
  t.timeout(300000)
  const issuer = crypto.keyPair()
  const { seeder, url, r, group, stubs, assocKp } = await stubWorld(t, ['undecodable'], { issuer })
  const x = stubs.undecodable
  injectWriters(seeder, group, [x])
  const ev = []
  const lent = lender()
  const ac = new AbortController()
  const run = sync(r, url, ev, { signal: ac.signal, groupPageMs: 300, reader: lent.reader })
  try {
    await until(() => lent.held(x.key) !== null, { name: 'the stub held', timeoutMs: 60000 })
    await seeder._offerBlocklist(moderatorSnapshot(assocKp, { revokedIssuers: [hex(issuer.publicKey)] }), null)
    await until(() => skips(ev, x.key).length > 0, { name: 'the stub leaves the table', timeoutMs: 60000 })
  } finally {
    ac.abort()
    await run
  }
  t.alike(skips(ev, x.key), ['revoked-issuer'], 'once, for the revoked diary that proved it')
  t.absent(await store.groupCoreExists(r.storage, x.key), 'held for that listing alone, it is purged')
  t.alike(await recorded(r), {}, 'and its record goes with it')
})

test('a blocked group purges its header stubs, stored before this run or in it, with their records (#350)', async (t) => {
  t.timeout(300000)
  const { seeder, url, r, group, stubs, assocKp } = await stubWorld(t, ['undecodable', 'invalid'])
  const before = stubs.undecodable
  const now = stubs.invalid
  const extra = extraWriters(seeder, group)
  extra.items = [before]
  t.ok((await once(r, url, [])).ok, 'R\'s first run ends ok')
  t.alike(await recorded(r), { [before.key]: before.diary }, 'one held as a stub of (G, B)')
  extra.items = [before, now]
  const ev = []
  const lent = lender()
  const ac = new AbortController()
  const run = sync(r, url, ev, { signal: ac.signal, groupPageMs: 300, reader: lent.reader })
  try {
    await until(() => lent.held(before.key) !== null && lent.held(now.key) !== null, { name: 'both stubs held', timeoutMs: 60000 })
    await seeder._offerBlocklist(moderatorSnapshot(assocKp, { blocked: [group] }), null)
    await until(() => skips(ev, before.key).length > 0 && skips(ev, now.key).length > 0, { name: 'both stubs leave the table', timeoutMs: 60000 })
  } finally {
    ac.abort()
    await run
  }
  for (const [name, x] of [['stored before this run', before], ['stored in this run', now]]) {
    t.alike(skips(ev, x.key), ['blocked'], name + ': refused for the blocked group')
    t.absent(await store.groupCoreExists(r.storage, x.key), name + ': purged')
  }
  t.alike(await recorded(r), {}, 'and their records go with them')
})
