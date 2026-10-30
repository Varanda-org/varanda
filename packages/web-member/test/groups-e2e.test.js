// Public groups end to end, loopback only: a real Seeder behind a WebSocket
// (the G1 pattern) and on the local DHT, a core node (the creator, synced
// with @varanda/core runSync) and a browser node (lib/member-ops.js, synced
// with lib/sync.js). The creator makes an approval group; the browser joins
// by key before holding the root, is admitted, posts, is banned and unbanned,
// sees a hide, leaves; the seeder restarts and rebuilds its group index; a
// moderator snapshot blocking the root reaches the seeder and both nodes.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const coreSync = require('@varanda/core/lib/sync')
const coreMember = require('@varanda/core/lib/member')
const coreStore = require('@varanda/core/lib/store')
const { runSync } = require('../lib/sync')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function browserMember (assocKp, name) {
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
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
  await ops.profileSet(ctx, { name, bio: '' })
  return { storage, ownHex, ctx }
}

async function coreNode (t, assocKp, name) {
  const ctx = { dataDir: tmpDir(t, 'varanda-ge2e-core-'), association: hex(assocKp.publicKey) }
  const { publicKey } = await coreMember.idCreate(ctx)
  await coreMember.certAdd(ctx, createCert({ member: publicKey }, assocKp))
  await coreMember.profileSet(ctx, { name })
  return { ...ctx, key: publicKey }
}

// A seeder on the local DHT and behind a WebSocket entry. restart() closes it
// and starts a new one on the same data dir; the entry hands new streams to
// whichever seeder is current.
async function seederOverWs (t, assocKp, bootstrap) {
  const dataDir = tmpDir(t, 'varanda-ge2e-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-ge2e-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp), null, 2) + '\n')
  Seeder.addCert(dataDir, certFile, association)
  const s = { seeder: null, events: [], dataDir }
  const start = async () => {
    const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: association, log: (e) => s.events.push(e) })
    t.teardown(() => seeder.close(), { force: true })
    await seeder.start()
    s.seeder = seeder
  }
  await start()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const client of wss.clients) client.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    if (s.seeder === null) return ws.terminate()
    s.seeder.acceptStream(raw)
  })
  s.url = 'ws://127.0.0.1:' + wss.address().port + '/seeder'
  s.restart = async () => {
    const old = s.seeder
    s.seeder = null
    for (const client of wss.clients) client.terminate()
    await old.close()
    s.events = []
    await start()
  }
  return s
}

function indexed (seeder, group, key) {
  return seeder.groupWriters({ group, after: null, limit: 64 }).items.some((it) => it.key === key)
}

function named (events, name) {
  return events.filter((e) => e.event === name)
}

async function onceB (b, url) {
  const events = []
  const res = await runSync({
    storage: b.storage,
    seederUrl: url,
    createSocket: (u) => new WebSocket(u),
    retryMinMs: 100,
    retryMaxMs: 200,
    mediaPollMs: 50,
    groupsChangedMs: 20,
    once: true,
    timeoutMs: 30000,
    onEvent: (ev) => events.push(ev)
  })
  return { res, events }
}

async function onceC (bootstrap, c) {
  const events = []
  const res = await coreSync.runSync({
    dataDir: c.dataDir,
    ...localSwarmOptions(bootstrap),
    once: true,
    timeoutMs: 30000,
    onEvent: (ev) => events.push(ev)
  })
  return { res, events }
}

async function rejectsNotFound (t, promise, label) {
  try {
    await promise
    t.fail(label + ': expected grupo não encontrado')
  } catch (err) {
    t.is(err.message, 'grupo não encontrado', label)
  }
}

async function coreHolds (c, key) {
  const s = await coreStore.openStore(c.dataDir)
  try {
    return await coreStore.replicaStored(s, key)
  } finally {
    await s.close()
  }
}

const view = (read) => read.items.map((p) => [p.diary, p.text, p.hidden])

test('public groups end to end: core creator, browser member, real seeder', async (t) => {
  t.timeout(180000)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const c = await coreNode(t, assocKp, 'Caio')
  const b = await browserMember(assocKp, 'Bia')

  // 1. The creator makes an approval group and posts; a once run pushes it.
  const { group } = await coreMember.groupCreate(c, { name: 'Horta', join: 'approval' })
  await coreMember.groupPost(c, { group, text: 'c1' })
  const r1 = await onceC(bootstrap, c)
  t.ok(r1.res.ok, 'creator push ok ' + r1.res.errors.join('; '))
  await until(() => indexed(sd.seeder, group, group), { name: 'root indexed' })

  // 2. The browser joins by key without the root: pending, then requested.
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'pending' }, 'join before the root is pending')
  const r2 = await onceB(b, sd.url)
  t.ok(r2.res.ok, 'browser fetch ok ' + JSON.stringify(r2.res.errors))
  t.ok(await store.groupCoreExists(b.storage, group), 'the root is stored')
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'requested', 'B reads requested')
  const bWriter = (await store.readGroupWriters(b.storage)).find((w) => w.group === group).key
  await until(() => indexed(sd.seeder, group, bWriter), { name: 'B writer indexed' })

  // 3. C sees the request and admits; B posts; both read each other.
  const r3 = await onceC(bootstrap, c)
  t.ok(r3.res.ok, 'creator fetch ok ' + r3.res.errors.join('; '))
  const reqs = await coreMember.groupRequests(c, { group })
  t.alike(reqs.requests.map((r) => [r.member, r.name]), [[b.ownHex, 'Bia']], 'C sees B request with name')
  t.alike(await coreMember.groupAdmit(c, { group, member: b.ownHex, on: true }), { ok: true })
  t.ok((await onceC(bootstrap, c)).res.ok, 'creator pushes the admission')
  t.ok((await onceB(b, sd.url)).res.ok, 'B fetches the admission')
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'member', 'B is a member')
  const p1 = await ops.groupPost(b.ctx, { group, text: 'b1' })
  t.ok((await onceB(b, sd.url)).res.ok, 'B pushes b1')
  await until(() => sd.seeder.groupWriters({ group, after: null, limit: 64 }).items.some((it) => it.key === bWriter && it.length > p1.seq), { name: 'b1 on the seeder' })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C fetches b1')
  const readC = await coreMember.groupRead(c, { group })
  t.ok(readC.items.some((p) => p.diary === b.ownHex && p.text === 'b1' && p.name === 'Bia'), 'C reads b1 with its author name')
  const readB = await ops.groupRead(b.ctx, { group })
  t.ok(readB.items.some((p) => p.diary === c.key && p.text === 'c1'), 'B reads C post')

  // 4. Ban: B's later post is hidden for C; B reads banned. Unban lifts it.
  t.alike(await coreMember.groupBan(c, { group, member: b.ownHex, on: true }), { ok: true })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C pushes the ban')
  const p2 = await ops.groupPost(b.ctx, { group, text: 'b2 sem ver o ban' })
  t.ok((await onceB(b, sd.url)).res.ok, 'B pushes b2 and fetches the ban')
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'banned', 'B reads banned')
  await until(() => sd.seeder.groupWriters({ group, after: null, limit: 64 }).items.some((it) => it.key === bWriter && it.length > p2.seq), { name: 'b2 on the seeder' })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C fetches b2')
  const banned = await coreMember.groupRead(c, { group })
  t.absent(banned.items.some((p) => p.text === 'b2 sem ver o ban'), 'b2 hidden for C')
  t.ok(banned.items.some((p) => p.text === 'b1'), 'b1 kept')
  t.alike(await coreMember.groupBan(c, { group, member: b.ownHex, on: false }), { ok: true })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C pushes the unban')
  t.ok((await onceB(b, sd.url)).res.ok, 'B fetches the unban')
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'member', 'B is a member again')
  const p3 = await ops.groupPost(b.ctx, { group, text: 'b3 de volta' })
  t.ok((await onceB(b, sd.url)).res.ok, 'B pushes b3')
  await until(() => sd.seeder.groupWriters({ group, after: null, limit: 64 }).items.some((it) => it.key === bWriter && it.length > p3.seq), { name: 'b3 on the seeder' })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C fetches b3')
  const unbanned = await coreMember.groupRead(c, { group })
  t.ok(unbanned.items.some((p) => p.diary === b.ownHex && p.text === 'b3 de volta' && !p.hidden), 'b3 visible for C')

  // 5. C hides b1; B sees it hidden.
  t.alike(await coreMember.groupHide(c, { group, target: { writer: bWriter, seq: p1.seq }, on: true }), { ok: true })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C pushes the hide')
  t.ok((await onceB(b, sd.url)).res.ok, 'B fetches the hide')
  const hiddenB = await ops.groupRead(b.ctx, { group })
  t.ok(hiddenB.items.some((p) => p.diary === b.ownHex && p.hidden && p.text === ''), 'B sees b1 hidden ' + JSON.stringify(view(hiddenB)))
  t.absent(hiddenB.items.some((p) => p.text === 'b1'), 'b1 text gone for B')

  // 6. B leaves: C no longer lists B as a member; earlier posts stay.
  t.alike(await ops.groupLeave(b.ctx, { group }), { state: 'left' })
  t.is((await ops.groupInfo(b.ctx, { group })).role, 'left', 'B reads left')
  t.ok((await onceB(b, sd.url)).res.ok, 'B pushes the leave')
  await until(() => {
    const idx = sd.seeder.indexGroup(group)
    return idx && idx.writers.some((w) => w.key === bWriter && w.left === true)
  }, { name: 'seeder lists B as left' })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C fetches the leave')
  const membersC = await coreMember.groupMembers(c, { group })
  t.absent(membersC.members.some((m) => m.member === b.ownHex), 'C no longer lists B as a member')
  const afterLeave = await coreMember.groupRead(c, { group })
  t.ok(afterLeave.items.some((p) => p.diary === b.ownHex && p.text === 'b3 de volta'), 'B earlier post stays visible for C')

  // 8. Seeder restart: the group index is rebuilt with the root and B's writer.
  await sd.restart()
  await until(() => indexed(sd.seeder, group, group) && indexed(sd.seeder, group, bWriter), { name: 'index rebuilt', timeoutMs: 30000 })
  const idx = sd.seeder.indexGroup(group)
  t.ok(idx && idx.writers.some((w) => w.key === group), 'indexGroup lists the root after restart')
  t.ok(idx && idx.writers.some((w) => w.key === bWriter), 'indexGroup lists B writer after restart')

  // 7. A moderator snapshot blocking the root, stored by C and offered by
  // its sync, is adopted by the seeder and then by B.
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, assocKp)
  const snap = createSnapshot({ seq: 1, blocked: [group], revokedIssuers: [] }, modKp, modCert)
  coreStore.writeBlocklist(c.dataDir, snap)
  await onceC(bootstrap, c)
  await until(() => named(sd.events, 'blocklist').some((e) => e.seq === 1), { name: 'seeder adopted the snapshot' })
  await until(() => !sd.seeder._groupServed.has(group) && !sd.seeder._groupServed.has(bWriter), { name: 'seeder dropped the group cores' })
  t.alike(sd.seeder.groupWriters({ group, after: null, limit: 64 }), { items: [], next: null, incomplete: false }, 'blocked root pages empty')
  t.is(sd.seeder.indexGroup(group), null, 'indexGroup null for the blocked root')
  await onceB(b, sd.url)
  t.alike((await store.readBlocklist(b.storage)).snapshot, snap, 'B adopted the snapshot')
  await rejectsNotFound(t, coreMember.groupInfo(c, { group }), 'C groupInfo')
  await rejectsNotFound(t, coreMember.groupRead(c, { group }), 'C groupRead')
  await rejectsNotFound(t, ops.groupInfo(b.ctx, { group }), 'B groupInfo')
  await rejectsNotFound(t, ops.groupRead(b.ctx, { group }), 'B groupRead')
  t.ok(await coreHolds(c, group), 'the creator root core is still stored on C')

  t.comment('runtime ' + (Date.now() - started) + ' ms')
})

function writerLength (seeder, group, key) {
  const item = seeder.groupWriters({ group, after: null, limit: 64 }).items.find((it) => it.key === key)
  return item ? item.length : 0
}

// A community admin acting in a linked group, then demoted while acting: the
// hide written before the demotion's cuts stays for both nodes, the one
// written after them (the admin's node had not seen the demotion) is void.
test('communities end to end: community admin hides, then is demoted while acting', async (t) => {
  t.timeout(180000)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const c = await coreNode(t, assocKp, 'Caio')
  const a = await coreNode(t, assocKp, 'Ana')
  const b = await browserMember(assocKp, 'Bia')

  // 1. C creates an open group and a community and links both sides.
  const { group } = await coreMember.groupCreate(c, { name: 'Horta', join: 'open' })
  const { community } = await coreMember.communityCreate(c, { name: 'Bairro' })
  const link = await coreMember.communityLink(c, { community, group, on: true })
  t.alike(link.sides, ['community', 'group'], 'C writes both sides')
  t.ok((await onceC(bootstrap, c)).res.ok, 'C pushes the roots')
  await until(() => indexed(sd.seeder, group, group) && sd.seeder._groupServed.has(community), { name: 'roots served' })

  // 2. A (core) and B (browser) join; B posts twice.
  t.alike(await coreMember.groupJoin(a, { group }), { state: 'pending' }, 'A joins before the root')
  const ra = await onceC(bootstrap, a)
  t.ok(ra.res.ok, 'A fetch ok ' + ra.res.errors.join('; '))
  t.is((await coreMember.groupInfo(a, { group })).state, 'member', 'A is a member')
  const aWriter = coreStore.readGroups(a.dataDir).find((g) => g.group === group).writer
  await until(() => indexed(sd.seeder, group, aWriter), { name: 'A writer indexed' })
  await ops.groupJoin(b.ctx, { group })
  t.ok((await onceB(b, sd.url)).res.ok, 'B fetches the root')
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'member', 'B is a member')
  const p1 = await ops.groupPost(b.ctx, { group, text: 'b1' })
  const p2 = await ops.groupPost(b.ctx, { group, text: 'b2' })
  t.ok((await onceB(b, sd.url)).res.ok, 'B pushes b1 and b2')
  const bWriter = (await store.readGroupWriters(b.storage)).find((w) => w.group === group).key
  await until(() => writerLength(sd.seeder, group, bWriter) > p2.seq, { name: 'b2 on the seeder' })

  // 3. C, holding A's writer, appoints A as community admin.
  t.ok((await onceC(bootstrap, c)).res.ok, 'C fetches A and B')
  t.alike(await coreMember.communityAdmin(c, { community, member: a.key, on: true }), { community, member: a.key, on: true })
  const infoC = await coreMember.communityInfo(c, { community })
  t.alike([infoC.groups.map((g) => g.group), infoC.admins, infoC.state], [[group], 2, 'ready'], 'community info on C')
  t.ok((await onceC(bootstrap, c)).res.ok, 'C pushes the grant')

  // 4. A acts in the group through the community: hides b1.
  const aBefore = writerLength(sd.seeder, group, aWriter)
  t.ok((await onceC(bootstrap, a)).res.ok, 'A fetches the community root and the grant')
  t.alike((await coreMember.groupInfo(a, { group })).communities, [community], 'A sees the two-way link')
  t.alike(await coreMember.groupHide(a, { group, target: { writer: bWriter, seq: p1.seq }, on: true }), { ok: true })
  t.ok((await onceC(bootstrap, a)).res.ok, 'A pushes the first hide')
  await until(() => writerLength(sd.seeder, group, aWriter) > aBefore, { name: 'A hide on the seeder' })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C fetches the hide')
  t.ok((await onceB(b, sd.url)).res.ok, 'B fetches the community root and the hide')
  const hiddenC = await coreMember.groupRead(c, { group })
  t.ok(hiddenC.items.some((p) => p.diary === b.ownHex && p.hidden), 'C sees b1 hidden ' + JSON.stringify(view(hiddenC)))
  const hiddenB = await ops.groupRead(b.ctx, { group })
  t.ok(hiddenB.items.some((p) => p.diary === b.ownHex && p.hidden && p.text === ''), 'B sees b1 hidden ' + JSON.stringify(view(hiddenB)))
  t.absent(hiddenB.items.some((p) => p.text === 'b1'), 'b1 text gone for B')
  t.alike((await ops.groupInfo(b.ctx, { group })).communities, [community], 'B sees the two-way link')

  // 5. C demotes A at the writer length it holds; A, not synced, hides b2.
  const aCut = writerLength(sd.seeder, group, aWriter)
  t.alike(await coreMember.communityAdmin(c, { community, member: a.key, on: false }), { community, member: a.key, on: false })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C pushes the demotion')
  t.alike(await coreMember.groupHide(a, { group, target: { writer: bWriter, seq: p2.seq }, on: true }), { ok: true }, 'A, unaware, hides b2')
  t.ok((await onceC(bootstrap, a)).res.ok, 'A pushes the late hide')
  await until(() => writerLength(sd.seeder, group, aWriter) > aCut, { name: 'late hide on the seeder' })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C fetches the late hide')
  t.ok((await onceB(b, sd.url)).res.ok, 'B fetches the demotion and the late hide')

  // The hide before the demotion's cut stays; the later one is void.
  const finalC = await coreMember.groupRead(c, { group })
  const finalB = await ops.groupRead(b.ctx, { group })
  for (const [label, read] of [['C', finalC], ['B', finalB]]) {
    t.ok(read.items.some((p) => p.diary === b.ownHex && p.text === 'b2' && !p.hidden), label + ' sees b2 visible ' + JSON.stringify(view(read)))
    t.absent(read.items.some((p) => p.text === 'b1'), label + ' keeps b1 hidden')
  }
  t.is((await coreMember.communityInfo(c, { community })).admins, 1, 'only the creator administers now')

  t.comment('runtime ' + (Date.now() - started) + ' ms')
})
