// Standalone groups (no community, docs/protocol.md section 10) end to end,
// loopback only: a real Seeder behind a WebSocket and on the local DHT, a
// core node (synced with @varanda/core runSync) and a browser node
// (lib/member-ops.js, synced with lib/sync.js). Public: each side creates an
// open group the other joins before holding the root, and both post. Private:
// the core node creates, the browser opens the link, asks, is admitted and
// reads the history; its second device enrols and gets the keys from the
// core distributor; after the person leaves, no key block reaches either of
// its devices and the next post stays sealed for them.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const coreSync = require('@varanda/core/lib/sync')
const coreMember = require('@varanda/core/lib/member')
const coreStore = require('@varanda/core/lib/store')
const { runSync } = require('../lib/sync')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { peekGroupRoot } = require('../lib/root-peek')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// The first device does the full setup; another device of the same passkey
// passes { keyPair, prf } and only calls idCreate (certAdd and profileSet
// append to the shared diary and would fork it).
async function browserMember (t, assocKp, name, { keyPair = null, prf = null } = {}) {
  const second = keyPair !== null
  const storage = memoryNodeStorage()
  if (!second) {
    keyPair = crypto.keyPair()
    prf = new Uint8Array(32)
    globalThis.crypto.getRandomValues(prf)
  }
  const groupKeys = createGroupKeys()
  t.teardown(() => groupKeys.close())
  const ctx = {
    storage,
    association: hex(assocKp.publicKey),
    keyPair,
    groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce),
    groupKeys
  }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  if (!second) {
    await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
    await ops.profileSet(ctx, { name, bio: '' })
  }
  await groupKeys.unlock(storage, prf)
  return { storage, ownHex, ctx, keyPair, prf }
}

async function coreNode (t, assocKp, name) {
  const ctx = { dataDir: tmpDir(t, 'varanda-se2e-core-'), association: hex(assocKp.publicKey) }
  const { publicKey } = await coreMember.idCreate(ctx)
  await coreMember.certAdd(ctx, createCert({ member: publicKey }, assocKp))
  await coreMember.profileSet(ctx, { name })
  return { ...ctx, key: publicKey }
}

async function seederOverWs (t, assocKp, bootstrap) {
  const dataDir = tmpDir(t, 'varanda-se2e-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-se2e-sc-'), 'seeder-cert.json')
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

function writerLength (seeder, group, key) {
  const item = seeder.groupWriters({ group, after: null, limit: 64 }).items.find((it) => it.key === key)
  return item ? item.length : 0
}

async function onceB (b, url) {
  return runSync({
    storage: b.storage,
    seederUrl: url,
    createSocket: (u) => new WebSocket(u),
    retryMinMs: 100,
    retryMaxMs: 200,
    mediaPollMs: 50,
    groupsChangedMs: 20,
    once: true,
    timeoutMs: 30000,
    onEvent: () => {}
  })
}

async function onceC (bootstrap, c) {
  return coreSync.runSync({
    dataDir: c.dataDir,
    ...localSwarmOptions(bootstrap),
    once: true,
    timeoutMs: 30000,
    onEvent: () => {}
  })
}

// The writer the core node `c` writes `group` through (the root for its creator).
function coreWriterOf (c, group) {
  const entry = coreStore.readGroups(c.dataDir).find((g) => g.group === group)
  return entry === undefined ? null : entry.writer
}

// The browser's own writers in `group`, the root excepted.
async function writersIn (m, group) {
  return (await store.readGroupWriters(m.storage)).filter((e) => e.group === group && e.key !== group)
}

// The group-key blocks of `key` as `m` holds them -> [{ seq, record }].
async function keyBlocks (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  try {
    return (await store.readAll(core)).filter((e) => e.record !== null && e.record.type === 'group-key')
  } finally {
    await core.close()
  }
}

// The own diary as `m` holds it -> { length, joins } (joins: the writers its
// group-join records bind).
async function diaryOf (m) {
  const core = await store.openDiary(m.storage)
  try {
    const joins = (await store.readAll(core)).map((e) => e.record).filter((r) => r !== null && r.type === 'group-join' && r.on).map((r) => r.writer)
    return { length: core.length, joins }
  } finally {
    await core.close()
  }
}

async function rootLength (m, group) {
  const core = await store.openGroupCoreReadOnly(m.storage, group)
  try { return core.length } finally { await core.close() }
}

const texts = (read) => read.items.filter((p) => !p.hidden).map((p) => p.text).sort()

test('public standalone groups end to end: each node creates one, the other joins before the root, both post', async (t) => {
  t.timeout(150000)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const c = await coreNode(t, assocKp, 'Caio')
  const b = await browserMember(t, assocKp, 'Bia')

  // 1. The core node creates an open group with no community and posts.
  const { group: horta } = await coreMember.groupCreate(c, { name: 'Horta', join: 'open' })
  t.is((await coreMember.groupInfo(c, { group: horta })).community, null, 'no community')
  const c1 = await coreMember.groupPost(c, { group: horta, text: 'c1 da horta' })
  t.ok((await onceC(bootstrap, c)).ok, 'C pushes the root')
  await until(() => writerLength(sd.seeder, horta, horta) > c1.seq, { name: 'horta root on the seeder' })

  // 2. The browser joins by key before holding the root, with the
  // standalone hint, checked against the root's block 0 read through the
  // seeder as the session reads it; its run fetches the root and the
  // writer counts.
  b.ctx.peekGroupRoot = (key) => peekGroupRoot({ seederUrl: sd.url, createSocket: (u) => new WebSocket(u), association: hex(assocKp.publicKey), key, timeoutMs: 10000 })
  t.alike(await ops.groupJoin(b.ctx, { group: horta, standalone: true }), { state: 'pending' }, 'B joins before the root')
  const bHortaWriter = (await writersIn(b, horta))[0].key
  t.ok((await onceB(b, sd.url)).ok, 'B fetches the root and pushes its writer')
  t.ok(await store.groupCoreExists(b.storage, horta), 'B holds the root')
  t.is((await ops.groupInfo(b.ctx, { group: horta })).state, 'member', 'B is a member')
  t.alike((await ops.groupStandalone(b.ctx, {})).groups.map((g) => [g.group, g.name, g.role]), [[horta, 'Horta', 'member']], 'B lists it as standalone')
  t.alike(texts(await ops.groupRead(b.ctx, { group: horta })), ['c1 da horta'], 'B reads C post')

  // 3. B posts; C reads it with the author name and counts B.
  const b1 = await ops.groupPost(b.ctx, { group: horta, text: 'b1 da Bia' })
  t.ok((await onceB(b, sd.url)).ok, 'B pushes b1')
  await until(() => writerLength(sd.seeder, horta, bHortaWriter) > b1.seq, { name: 'b1 on the seeder' })
  t.ok((await onceC(bootstrap, c)).ok, 'C fetches b1')
  const readC = await coreMember.groupRead(c, { group: horta })
  t.ok(readC.items.some((p) => p.diary === b.ownHex && p.text === 'b1 da Bia' && p.name === 'Bia'), 'C reads b1 with its author name')
  t.ok((await coreMember.groupMembers(c, { group: horta })).members.some((m) => m.member === b.ownHex), 'C counts B')
  t.alike((await coreMember.groupStandalone(c, {})).groups.map((g) => [g.group, g.role]), [[horta, 'creator']], 'C lists it as creator')

  // 4. The browser creates an open group with no community and posts.
  const { group: feira } = await ops.groupCreate(b.ctx, { name: 'Feira', join: 'open' })
  t.is((await ops.groupInfo(b.ctx, { group: feira })).community, null, 'no community on the browser either')
  const b2 = await ops.groupPost(b.ctx, { group: feira, text: 'b2 da feira' })
  t.ok((await onceB(b, sd.url)).ok, 'B pushes the root')
  await until(() => writerLength(sd.seeder, feira, feira) > b2.seq, { name: 'feira root on the seeder' })

  // 5. The core node joins before holding the root; its run fetches it.
  t.alike(await coreMember.groupJoin(c, { group: feira, standalone: true }), { state: 'pending' }, 'C joins before the root')
  const cFeiraWriter = coreWriterOf(c, feira)
  t.ok(cFeiraWriter !== null && cFeiraWriter !== feira, 'C has its own writer')
  const rc = await onceC(bootstrap, c)
  t.ok(rc.ok, 'C fetches the root ' + rc.errors.join('; '))
  t.is((await coreMember.groupInfo(c, { group: feira })).state, 'member', 'C is a member')
  t.alike(texts(await coreMember.groupRead(c, { group: feira })), ['b2 da feira'], 'C reads B post')
  const c2 = await coreMember.groupPost(c, { group: feira, text: 'c2 do Caio' })
  t.ok((await onceC(bootstrap, c)).ok, 'C pushes c2')
  await until(() => writerLength(sd.seeder, feira, cFeiraWriter) > c2.seq, { name: 'c2 on the seeder' })
  t.ok((await onceB(b, sd.url)).ok, 'B fetches c2')
  const readB = await ops.groupRead(b.ctx, { group: feira })
  t.ok(readB.items.some((p) => p.diary === c.key && p.text === 'c2 do Caio' && p.name === 'Caio'), 'B reads c2 with its author name')
  t.ok((await ops.groupMembers(b.ctx, { group: feira })).members.some((m) => m.member === c.key), 'B counts C')
  t.alike((await ops.groupStandalone(b.ctx, {})).groups.map((g) => [g.group, g.role]).sort(), [[horta, 'member'], [feira, 'creator']].sort(), 'B lists both')

  t.comment('runtime ' + (Date.now() - started) + ' ms')
})

test('private standalone group end to end: core creator, browser member and its second device, a leave stops the keys', async (t) => {
  t.timeout(170000)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const c = await coreNode(t, assocKp, 'Caio')
  const b = await browserMember(t, assocKp, 'Bia')

  // 1. The core node creates a private group with no community (approval
  // forced, the name sealed) and posts sealed.
  const { group } = await coreMember.groupCreate(c, { name: 'Conselho', join: 'open', visibility: 'private' })
  const info = await coreMember.groupInfo(c, { group })
  t.alike([info.community, info.visibility, info.join, info.name], [null, 'private', 'approval', 'Conselho'], 'private, approval, no community')
  const c1 = await coreMember.groupPost(c, { group, text: 'segredo-c1 antes' })
  t.ok((await onceC(bootstrap, c)).ok, 'C pushes')
  await until(() => writerLength(sd.seeder, group, group) > c1.seq, { name: 'root on the seeder' })

  // 2. The browser opens the link: the root comes and B asks to join.
  await store.addGroupReplica(b.storage, group)
  const first = await onceB(b, sd.url)
  t.ok(first.ok, 'B fetches the root ' + JSON.stringify(first.errors))
  t.ok(await store.groupCoreExists(b.storage, group), 'the private root is stored')
  t.is((await ops.groupJoin(b.ctx, { group })).state, 'requested', 'B asks to join')
  const bWriter = (await writersIn(b, group))[0].key
  t.ok((await onceB(b, sd.url)).ok, 'B pushes its boxed writer')
  await until(() => writerLength(sd.seeder, group, bWriter) >= 1, { name: 'B writer on the seeder' })
  const before = await ops.groupRead(b.ctx, { group })
  t.is(before.items.length, 0, 'nothing readable before the admission')

  // 3. C admits B; the history keys travel to B's box.
  t.ok((await onceC(bootstrap, c)).ok, 'C fetches the request')
  t.alike((await coreMember.groupRequests(c, { group })).requests.map((r) => r.member), [b.ownHex], 'C sees B request')
  t.alike(await coreMember.groupAdmit(c, { group, member: b.ownHex, on: true }), { ok: true })
  t.ok((await onceC(bootstrap, c)).ok, 'C pushes the admission and keys')
  t.ok((await onceB(b, sd.url)).ok, 'B fetches the keys')
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'member', 'B is a member')
  t.is((await ops.groupInfo(b.ctx, { group })).name, 'Conselho', 'B opens the sealed name')
  const readB = await ops.groupRead(b.ctx, { group })
  t.alike(texts(readB), ['segredo-c1 antes'], 'B reads the history')
  t.is(readB.sealed, 0, 'nothing left sealed for B')

  // 4. B posts sealed; C opens it.
  const b1 = await ops.groupPost(b.ctx, { group, text: 'segredo-b1 da Bia' })
  t.ok((await onceB(b, sd.url)).ok, 'B pushes b1')
  await until(() => writerLength(sd.seeder, group, bWriter) > b1.seq, { name: 'b1 on the seeder' })
  t.ok((await onceC(bootstrap, c)).ok, 'C fetches b1')
  t.ok((await coreMember.groupRead(c, { group })).items.some((p) => p.diary === b.ownHex && p.text === 'segredo-b1 da Bia'), 'C reads the browser sealed post')

  // 5. B's second device (same keys and prf, fresh storage) enrols by itself.
  const b2 = await browserMember(t, assocKp, 'Bia', { keyPair: b.keyPair, prf: b.prf })
  let plan = null
  for (let i = 0; i < 4; i++) {
    t.ok((await onceB(b2, sd.url)).ok, 'B2 run ' + i)
    plan = await ops.deviceUpkeepPlan(b2.ctx)
    if (plan.enrol.some((x) => x.root === group)) break
  }
  t.ok(plan.enrol.some((x) => x.root === group), 'B2 plans the group ' + JSON.stringify(plan.skipped))
  const up = await ops.deviceUpkeep(b2.ctx, plan)
  t.alike(up.failed, [], 'enrolment failed nothing')
  t.ok(up.enrolled.some((x) => x.root === group), 'B2 enrolled in the group')
  const b2Writer = (await writersIn(b2, group))[0].key
  t.not(b2Writer, bWriter, 'B2 writes through its own writer')
  t.is((await ops.groupInfo(b2.ctx, { group })).state, 'member', 'B2 is a member')
  t.absent((await ops.groupRead(b2.ctx, { group })).items.some((p) => p.text === 'segredo-c1 antes'), 'B2 cannot read the history yet')
  t.ok((await onceB(b2, sd.url)).ok, 'B2 pushes its writer and the diary join')
  const b2Diary = await diaryOf(b2)
  t.ok(b2Diary.joins.includes(b2Writer), 'B2 diary binds its writer')
  await until(() => writerLength(sd.seeder, group, b2Writer) >= 1, { name: 'B2 writer on the seeder' })

  // 6. C hands the held epochs to B2's writer and rotates; B2 reads it all.
  t.ok((await onceC(bootstrap, c)).ok, 'C fetches B2 writer')
  t.ok((await onceC(bootstrap, c)).ok, 'C fetches again')
  t.is((await coreMember.groupRekey(c, { group })).group, group, 'C rekeys')
  const c2 = await coreMember.groupPost(c, { group, text: 'segredo-c2 com B2' })
  t.ok((await onceC(bootstrap, c)).ok, 'C pushes the keys and c2')
  await until(() => writerLength(sd.seeder, group, group) > c2.seq, { name: 'c2 on the seeder' })
  t.ok((await onceB(b2, sd.url)).ok, 'B2 fetches the keys')
  const read2 = await ops.groupRead(b2.ctx, { group })
  t.alike(texts(read2), ['segredo-b1 da Bia', 'segredo-c1 antes', 'segredo-c2 com B2'], 'B2 reads the history and the new epoch')
  t.is(read2.sealed, 0, 'nothing left sealed for B2')
  t.ok((await keyBlocks(b2, group)).some((e) => e.record.keys.some((k) => k.writer === b2Writer)), 'control: a key block names B2 writer while B is a member')

  // 7. B leaves; after C rotates, no key block names either device's writer
  // and the next post stays sealed on both.
  // B and B2 append to one diary: B must hold B2's join before it writes
  // the leave, or both sign a different record at the same position.
  t.ok((await onceB(b, sd.url)).ok, 'B fetches B2 diary join')
  const shared = await diaryOf(b)
  t.ok(shared.length >= b2Diary.length, 'B holds the diary at least as far as B2 wrote it')
  t.ok(shared.joins.includes(b2Writer), 'B holds B2 diary join')
  t.alike(await ops.groupLeave(b.ctx, { group }), { state: 'left' }, 'B leaves')
  t.ok((await onceB(b, sd.url)).ok, 'B pushes the leave')
  t.ok((await onceC(bootstrap, c)).ok, 'C fetches the leave')
  t.absent((await coreMember.groupMembers(c, { group })).members.some((m) => m.member === b.ownHex), 'C no longer lists B')
  t.ok((await onceB(b2, sd.url)).ok, 'B2 fetches the leave')
  t.is((await ops.groupInfo(b2.ctx, { group })).state, 'left', 'B2 reads left')
  const cut = await rootLength(b2, group)
  t.is((await coreMember.groupRekey(c, { group })).group, group, 'C rotates after the leave')
  const c3 = await coreMember.groupPost(c, { group, text: 'segredo-c3 depois da saida' })
  t.ok((await onceC(bootstrap, c)).ok, 'C pushes the rotation and c3')
  await until(() => writerLength(sd.seeder, group, group) > c3.seq, { name: 'c3 on the seeder' })
  t.ok((await onceB(b2, sd.url)).ok, 'B2 fetches')
  t.ok((await onceB(b, sd.url)).ok, 'B fetches')
  const after = (await keyBlocks(b2, group)).filter((e) => e.seq >= cut)
  t.ok(after.length >= 1, 'the rotation reached B2 storage as key blocks')
  t.ok(after.every((e) => e.record.keys.every((k) => k.writer !== b2Writer && k.writer !== bWriter)), 'no key block after the leave names a writer of B')
  for (const [m, label] of [[b2, 'B2'], [b, 'B']]) {
    const r = await ops.groupRead(m.ctx, { group })
    t.absent(r.items.some((p) => p.text === 'segredo-c3 depois da saida'), label + ' cannot read the post after the leave')
  }
  t.ok((await coreMember.groupRead(c, { group })).items.some((p) => p.text === 'segredo-c3 depois da saida'), 'the creator reads it')

  t.comment('runtime ' + (Date.now() - started) + ' ms')
})
