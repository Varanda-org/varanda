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
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { MAX_LOG_BLOCKS, groupJoinRecord } = require('@varanda/core/lib/records')
const { MAX_GROUP_WRITERS, MAX_GROUP_WRITERS_PER_DIARY } = require('@varanda/core/lib/group')
const { runSync, addJoins, earliestJoin, groupPushHeld, ownGroupVerdict, bindingRecheck, forgetListed, evictionPurges, capVictim, capExcess, storedJoinProof, refineJoinSeq } = require('../lib/sync')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function randomKey () {
  return hex(crypto.keyPair().publicKey)
}

// A browser member with block 0 and a profile; group key pairs derive from
// a random PRF (lib/passkey.js).
async function member (assocKp, name, makeCert = null) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = new Uint8Array(32)
  globalThis.crypto.getRandomValues(prf)
  const ctx = {
    storage,
    association: hex(assocKp.publicKey),
    keyPair,
    groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce)
  }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, makeCert ? makeCert(ownHex) : createCert({ member: ownHex }, assocKp))
  await ops.profileSet(ctx, { name, bio: '' })
  return { storage, ownHex, ctx }
}

// An in-process seeder with a WebSocket entry handing streams to acceptStream.
async function seederOverWs (t, assocKp, bootstrap, SeederClass = Seeder) {
  const dataDir = tmpDir(t, 'varanda-sg-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sg-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp), null, 2) + '\n')
  Seeder.addCert(dataDir, certFile, association)
  const seeder = new SeederClass({ dataDir, ...localSwarmOptions(bootstrap), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const client of wss.clients) client.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  return { seeder, dataDir, wss, url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

function admittedGroups (dataDir) {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'admitted.json'), 'utf8'))
    return file.groups || {}
  } catch {
    return {}
  }
}

// The seeder's writer pages list `key` for `group` (admitted.json is
// written before the core opens; the index follows).
function indexed (seeder, group, key) {
  return seeder.groupWriters({ group, after: null, limit: 64 }).items.some((it) => it.key === key)
}

function sync (m, url, events, opts = {}) {
  return runSync({
    storage: m.storage,
    seederUrl: url,
    createSocket: (u) => new WebSocket(u),
    retryMinMs: 100,
    retryMaxMs: 200,
    mediaPollMs: 50,
    groupsChangedMs: 20,
    onEvent: (ev) => events.push(ev),
    ...opts
  })
}

function once (m, url, events, opts = {}) {
  return sync(m, url, events, { once: true, timeoutMs: 30000, ...opts })
}

function named (events, name) {
  return events.filter((e) => e.event === name)
}

// -> { length, contiguous } of a stored group core, or null.
async function held (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  if (core === null) return null
  try {
    return { length: core.length, contiguous: core.contiguousLength }
  } finally {
    await core.close()
  }
}

async function joinSeq (m, group, writer) {
  const { entries } = await ops.logRead(m.ctx)
  const found = entries.filter((e) => e.record.type === 'group-join' && e.record.group === group && e.record.writer === writer)
  return found[found.length - 1].seq
}

// Every writer page of `group` served from `extra` items merged into the
// seeder's own (sorted by key, GROUPS_LIMIT_MAX per page).
function injectWriters (seeder, group, extra) {
  const real = seeder.groupWriters.bind(seeder)
  const calls = []
  seeder.groupWriters = (q) => {
    if (q.group !== group) return real(q)
    calls.push(q.after)
    const base = real({ group, after: null, limit: 64 })
    const all = [...base.items, ...extra].sort((a, b) => (a.key < b.key ? -1 : 1))
    const rest = all.filter((it) => q.after === null || it.key > q.after)
    const items = rest.slice(0, q.limit)
    const next = rest.length > q.limit ? items[items.length - 1].key : null
    return { items, next, incomplete: false }
  }
  return calls
}

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

function moderatorSnapshot (assocKp, { seq = 1, blocked = [], revokedIssuers = [] }) {
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, assocKp)
  return createSnapshot({ seq, blocked, revokedIssuers }, modKp, modCert)
}

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
