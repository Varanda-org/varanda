'use strict'

// sync.start `groups: false` (docs/rpc.md 5.14) on a real browser node
// against a loopback seeder: a once run with stored groups opens no group
// core and asks no group page, yet syncs the own diary and a followed one;
// without `once` it is refused; a default run still pages its groups.
const test = require('brittle')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { validateParams } = require('@varanda/rpc')
const { createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { testnet, until } = require('./helpers/net')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { hex, member, seederOverWs, once, indexed, held, moderatorSnapshot } = require('./helpers/sync-groups')

const NO_GROUPS = 'groups: false só com once'

// Counts the group core opens of `storage` (node-store is one module object,
// read by lib/sync.js at call time).
function spyGroupOpens (t, storage) {
  const counts = { opens: 0 }
  const names = ['openGroupCoreReadOnly', 'openGroupReplica']
  const originals = names.map((n) => store[n])
  names.forEach((n, i) => {
    store[n] = (s, ...rest) => {
      if (s === storage) counts.opens++
      return originals[i](s, ...rest)
    }
  })
  t.teardown(() => { names.forEach((n, i) => { store[n] = originals[i] }) })
  return counts
}

function spyGroupPages (t, seeder) {
  const calls = []
  const real = seeder.groupWriters.bind(seeder)
  seeder.groupWriters = (q) => {
    calls.push(q.group)
    return real(q)
  }
  t.teardown(() => { delete seeder.groupWriters })
  return calls
}

async function nodeOf (t, m, url) {
  const node = createBrowserNode({
    storage: m.storage,
    association: m.ctx.association,
    seederUrl: url,
    createSocket: (u) => new WebSocket(u),
    // No internal catch-up or push run: every run here is the test's own.
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(m.ctx.keyPair, { prf: crypto.randomBytes(32) })
  return { node, web: await connectClient(node) }
}

async function onceRun (web, params) {
  const { runId } = await web.request('sync.start', { once: true, timeoutMs: 60000, ...params })
  const stopped = await stoppedOf(web.events, runId, { timeoutMs: 90000 })
  return { ...stopped, runId }
}

const startedRuns = (web) => web.events.filter((e) => e.name === 'sync.started').map((e) => e.data.runId)

test('groups: false is valid only with once', async (t) => {
  t.is(validateParams('sync.start', { groups: false }).ok, false, 'no once')
  t.is(validateParams('sync.start', { once: false, groups: false }).message, NO_GROUPS)
  t.alike(validateParams('sync.start', { once: true, groups: false }).value, { once: true, timeoutMs: 30000, groups: false })
  t.alike(validateParams('sync.start', { groups: true }).value, { once: false, groups: true })
  t.alike(validateParams('sync.start', {}).value, { once: false }, 'absent stays absent')

  const assocKp = generateAssociationKeyPair()
  const a = await member(assocKp, 'Ana')
  const { web } = await nodeOf(t, a, 'ws://127.0.0.1:9/seeder')
  const err = await errorOf(web.request('sync.start', { groups: false }))
  t.is(err && err.code, 'USAGE')
  t.is(err && err.message, NO_GROUPS)
  t.absent(web.events.some((e) => e.name === 'sync.started'), 'no run started')
})

test('a groups: false once run skips every group and still syncs the diaries', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')
  for (let i = 0; i < 3; i++) await ops.communityCreate(a.ctx, { name: 'Grupo ' + i, join: 'open' })
  t.ok((await store.readGroupWriters(a.storage)).length >= 3, 'three stored groups')
  // Bia's diary reaches the seeder first; Ana follows her afterwards.
  for (let i = 0; i < 4; i++) await ops.postCreate(b.ctx, { text: 'b' + i })
  const resB = await once(b, url, [])
  t.ok(resB.ok, 'followed diary pushed ' + JSON.stringify(resB.errors))
  await ops.followAdd(a.ctx, b.ownHex)
  const bLength = (await ops.logRead(b.ctx)).entries.length

  const opens = spyGroupOpens(t, a.storage)
  const pages = spyGroupPages(t, seeder)
  const { web } = await nodeOf(t, a, url)

  const off = await onceRun(web, { groups: false })
  t.alike(startedRuns(web), [off.runId], 'the only run is the test\'s')
  t.is(off.reason, 'done', 'run done ' + JSON.stringify(off.result && off.result.errors))
  t.ok(off.result.ok, 'once run ok')
  t.is(opens.opens, 0, 'no group core opened')
  t.alike(pages, [], 'no group page asked')
  t.ok(off.result.seederConfirmed, 'own diary held by the seeder')
  t.ok(off.result.downloaded[b.ownHex] >= bLength, 'followed diary synced')
  const lines = web.events.filter((e) => e.name === 'sync.event').map((e) => e.data.line)
  t.ok(lines.some((l) => l.startsWith('diário próprio sincronizado')), 'own diary synced')
  t.ok((await store.readGroupWriters(a.storage)).length >= 3, 'stored groups left as they were')

  // A default once run is unchanged: it opens its groups and pages them.
  const on = await onceRun(web, {})
  t.is(on.reason, 'done')
  t.ok(on.result.ok, 'default once run ok ' + JSON.stringify(on.result.errors))
  t.ok(opens.opens > 0, 'default run opens the group cores')
  t.ok(pages.length > 0, 'default run asks group pages')
})

// Caio held Dani's group while following her, then unfollowed her: her
// replica binds a stored group core though kv groupDiaries may not list it.
async function boundAfterUnfollow (t, { makeCert = null } = {}) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, url } = await seederOverWs(t, assocKp, bootstrap)
  const d = await member(assocKp, 'Dani', makeCert && ((key) => makeCert(assocKp, key)))
  const c = await member(assocKp, 'Caio')
  await ops.followAdd(c.ctx, d.ownHex)
  const { group } = await ops.communityCreate(d.ctx, { name: 'Horta', join: 'open' })
  await ops.groupPost(d.ctx, { group, text: 'oi' })
  t.ok((await once(d, url, [])).ok, 'creator pushed')
  await until(() => indexed(seeder, group, group), { name: 'root indexed' })
  await store.addGroupReplica(c.storage, group)
  t.ok((await once(c, url, [])).ok, 'reader fetched the group and the followed diary')
  t.ok(await held(c, group), 'group core stored')
  await ops.followRemove(c.ctx, d.ownHex)
  t.absent((await store.readGroupDiaries(c.storage)).includes(d.ownHex), 'not listed in kv groupDiaries')
  return { assocKp, url, c, d, group }
}

test('a groups: false run keeps an unfollowed replica that binds a stored group core', async (t) => {
  t.timeout(180000)
  const { url, c, d, group } = await boundAfterUnfollow(t)
  await once(c, url, [], { groups: false })
  t.ok(await store.replicaExists(c.storage, d.ownHex), 'binding replica kept')
  t.ok(await held(c, group), 'group core kept')
})

test('a groups: false run leaves a revoked binding diary to the next run with groups', async (t) => {
  t.timeout(180000)
  const issKp = crypto.keyPair()
  let issued = null
  const makeCert = (assocKp, key) => {
    issued = issued || createIssuerCert({ issuer: hex(issKp.publicKey) }, assocKp)
    return createIssuedCert({ member: key }, issKp, issued)
  }
  const { assocKp, url, c, d, group } = await boundAfterUnfollow(t, { makeCert })
  t.ok((await store.readGroupCerts(c.storage)).has(d.ownHex), 'her certificate is in kv groupCerts')
  await store.writeBlocklist(c.storage, moderatorSnapshot(assocKp, { revokedIssuers: [hex(issKp.publicKey)] }))
  await once(c, url, [], { groups: false, timeoutMs: 5000 })
  t.ok(await store.replicaExists(c.storage, d.ownHex), 'binding replica kept')
  t.ok((await store.readGroupCerts(c.storage)).has(d.ownHex), 'still in kv groupCerts')
  t.ok(await held(c, group), 'group core kept')
  // The run with groups sweeps the diary and its cores together.
  await once(c, url, [], { timeoutMs: 5000 })
  t.is(await store.groupCoreExists(c.storage, group), false, 'group core purged')
  t.absent(await store.replicaExists(c.storage, d.ownHex), 'binding replica purged')
})
