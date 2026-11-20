'use strict'

// The groups a held page is in stay synced (sync.js pageRoots), loopback
// only: a real Seeder behind a WebSocket on the local DHT. A creates a
// private group, the page's diary P joins it and is admitted; B never joins
// anything, and its once runs keep fetching the group's new blocks only
// while its roots are handed in as pageRoots.
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const test = require('brittle')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { runSync } = require('../lib/sync')
const { peekPageRoots } = require('../lib/page-groups')
const { createGroupKeys } = require('../lib/group-keys')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

const hex = (buf) => b4a.toString(buf, 'hex')

async function browserMember (t, assocKp, name) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const groupKeys = createGroupKeys()
  t.teardown(() => groupKeys.close())
  const ctx = { storage, association: hex(assocKp.publicKey), keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce), groupKeys }
  await ops.idCreate(ctx)
  const key = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: key }, assocKp))
  await ops.profileSet(ctx, { name, bio: '' })
  await groupKeys.unlock(storage, prf)
  return { storage, key, ctx }
}

async function seederOverWs (t, assocKp, bootstrap) {
  const dataDir = tmpDir(t, 'varanda-pgsync-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-pgsync-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp), null, 2) + '\n')
  Seeder.addCert(dataDir, certFile, association)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: association, log: () => {} })
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
  return { seeder, url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

function once (m, url, extra = {}) {
  return runSync({
    storage: m.storage,
    seederUrl: url,
    createSocket: (u) => new WebSocket(u),
    retryMinMs: 100,
    retryMaxMs: 200,
    mediaPollMs: 50,
    groupsChangedMs: 20,
    once: true,
    timeoutMs: 30000,
    onEvent: () => {},
    ...extra
  })
}

async function pipe (source, target) {
  const a = source.replicate(true, { keepAlive: false })
  const b = target.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await target.download({ start: 0, end: source.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await source.close()
    await target.close()
  }
}

async function share (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to.storage, from.key))
  for (const key of keys) {
    await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to.storage, key))
    await store.addGroupReplica(to.storage, key)
  }
  await store.addGroupDiary(to.storage, from.key)
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

async function lengthOf (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  if (core === null) return 0
  try { return core.contiguousLength } finally { await core.close() }
}

test('a group only a held page is in keeps syncing on later runs through pageRoots', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const a = await browserMember(t, assocKp, 'Ana')
  const p = await browserMember(t, assocKp, 'Padaria')
  const b = await browserMember(t, assocKp, 'Bia')

  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Conselho', join: 'approval', visibility: 'private', community })
  await share(a, p, [community, general, group])
  await ops.communityJoin(p.ctx, { community })
  t.is((await ops.groupJoin(p.ctx, { group })).state, 'requested')
  await share(p, a, [await ownWriter(p, community), await ownWriter(p, general), await ownWriter(p, group)])
  await ops.groupAdmit(a.ctx, { group, member: p.key, on: true })
  await ops.groupPost(a.ctx, { group, text: 'um' })
  t.ok((await once(a, sd.url)).ok)
  t.ok((await once(p, sd.url)).ok)

  // B holds P's diary (its follow or a page read), never joins anything.
  await pipe(await store.openDiary(p.storage), await store.openReplica(b.storage, p.key))
  const roots = await ops.pageGroupRoots(b.ctx, [p.key])
  t.ok(roots.includes(group) && roots.includes(community), 'the page diary\'s live joins')
  t.ok((await once(b, sd.url, { pageRoots: roots })).ok)
  t.is(await lengthOf(b, group), await lengthOf(a, group), 'fetched')
  t.alike(await store.readGroupWriters(b.storage), [], 'never an own writer')

  await ops.groupPost(a.ctx, { group, text: 'dois' })
  t.ok((await once(a, sd.url)).ok)
  const before = await lengthOf(b, group)
  t.ok((await once(b, sd.url, { pageRoots: roots })).ok)
  t.is(await lengthOf(b, group), await lengthOf(a, group), 'a later run keeps it synced')
  t.ok(await lengthOf(b, group) > before)
  t.alike(await store.readGroupWriters(b.storage), [], 'still never an own writer')
})

test('a device holding the page secrets but not the page diary finds its roots by peek and keeps the group synced', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const a = await browserMember(t, assocKp, 'Ana')
  const p = await browserMember(t, assocKp, 'Padaria')
  const b = await browserMember(t, assocKp, 'Bia')
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Conselho', join: 'approval', visibility: 'private', community })
  await share(a, p, [community, general, group])
  await ops.communityJoin(p.ctx, { community })
  await ops.groupJoin(p.ctx, { group })
  await share(p, a, [await ownWriter(p, community), await ownWriter(p, general), await ownWriter(p, group)])
  await ops.groupAdmit(a.ctx, { group, member: p.key, on: true })
  await ops.groupPost(a.ctx, { group, text: 'um' })
  t.ok((await once(a, sd.url)).ok)
  t.ok((await once(p, sd.url)).ok)

  t.is(await store.replicaExists(b.storage, p.key), false, 'B does not store the page diary')
  t.alike(await ops.pageGroupRoots(b.ctx, [p.key]), [], 'so no local roots')
  // The peek a continuous run publishes, as the session's diaryPeekWithin.
  let peekFn = null
  const ac = new AbortController()
  const running = runSync({
    storage: b.storage,
    seederUrl: sd.url,
    createSocket: (u) => new WebSocket(u),
    retryMinMs: 100,
    retryMaxMs: 200,
    signal: ac.signal,
    peeker: { set (fn) { peekFn = fn }, clear (fn) { if (peekFn === fn) peekFn = null } },
    onEvent: () => {}
  })
  await until(() => peekFn !== null, { name: 'peek published', timeoutMs: 20000 })
  const peek = ({ author, seqs }, ms) => peekFn(author, seqs, null, null, Date.now() + ms, null)
  const roots = await peekPageRoots(peek, p.key, Date.now() + 10000)
  ac.abort()
  await running
  t.ok(roots.includes(group) && roots.includes(community), 'the live joins, read by peek')
  await t.exception(peekPageRoots(peek, p.key, Date.now() - 1), 'past the deadline it fails')

  t.ok((await once(b, sd.url, { pageRoots: roots })).ok)
  t.is(await lengthOf(b, group), await lengthOf(a, group), 'fetched')
  await ops.groupPost(a.ctx, { group, text: 'dois' })
  t.ok((await once(a, sd.url)).ok)
  t.ok((await once(b, sd.url, { pageRoots: roots })).ok)
  t.is(await lengthOf(b, group), await lengthOf(a, group), 'a later run keeps it synced')
  t.alike(await store.readGroupWriters(b.storage), [], 'never an own writer')
})

test('pageRoots is capped and filtered', async (t) => {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const b = await browserMember(t, assocKp, 'Bia')
  const junk = ['x', 'AB'.repeat(32), null, ...Array.from({ length: 70 }, () => hex(crypto.randomBytes(32)))]
  const r = await once(b, sd.url, { pageRoots: junk, timeoutMs: 8000 })
  t.ok(r !== null && typeof r === 'object')
  t.alike(await store.readGroupWriters(b.storage), [])
})
