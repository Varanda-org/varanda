// The creator's second browser device and a private group, loopback only: a
// real Seeder behind a WebSocket on the local DHT. Device A creates a community
// and a private group; its second device A2 (same keys and prf, fresh storage,
// its own box key holder) enrols by itself, A re-shares the held epoch keys to
// A2's writer without rotating, and A2 reads the history.
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
const { createGroupKeys } = require('../lib/group-keys')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

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

async function seederOverWs (t, assocKp, bootstrap) {
  const dataDir = tmpDir(t, 'varanda-dpriv-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-dpriv-sc-'), 'seeder-cert.json')
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

function indexed (seeder, group, key) {
  return seeder.groupWriters({ group, after: null, limit: 64 }).items.some((it) => it.key === key)
}

async function once (m, url) {
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
    onEvent: () => {}
  })
}

function writerLength (seeder, group, key) {
  const item = seeder.groupWriters({ group, after: null, limit: 64 }).items.find((it) => it.key === key)
  return item ? item.length : 0
}

// The writers of `m` in `group` other than the root, as listed.
async function writersIn (m, group) {
  return (await store.readGroupWriters(m.storage)).filter((e) => e.group === group && e.key !== group)
}

// The group-key blocks of the writer `key`, as stored.
async function keyBlocks (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  try {
    return (await store.readAll(core)).filter((e) => e.record !== null && e.record.type === 'group-key')
  } finally {
    await core.close()
  }
}

test('the creator\'s second browser device reads a private group\'s history after the automatic re-share', async (t) => {
  t.timeout(110000)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const a = await browserMember(t, assocKp, 'Ana')
  const m = await browserMember(t, assocKp, 'Mel')

  // 1. A creates a community and a private group, posts and pushes.
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Conselho', join: 'open', visibility: 'private', community })
  await ops.groupPost(a.ctx, { group, text: 'segredo-1' })
  t.ok((await once(a, sd.url)).ok, 'A pushes')
  await until(() => indexed(sd.seeder, community, community) && indexed(sd.seeder, general, general) && writerLength(sd.seeder, group, group) >= 4, { name: 'roots on the seeder' })
  const aWriter = group // the creator's distributing writer is the root itself
  const blocksBefore = await keyBlocks(a, aWriter)
  const firstBefore = blocksBefore.length

  // 2. M, a member of another account that only requests the group.
  await store.addGroupReplica(m.storage, community)
  t.ok((await once(m, sd.url)).ok, 'M fetches the community')
  t.is((await ops.communityJoin(m.ctx, { community })).state, 'member', 'M joins the community')
  t.is((await ops.groupJoin(m.ctx, { group })).state, 'requested', 'M requests the group')
  t.ok((await once(m, sd.url)).ok, 'M pushes the request')
  const mWriter = (await writersIn(m, group))[0].key

  // 3. A2: same keys and prf, fresh storage, its own holder.
  const a2 = await browserMember(t, assocKp, 'Ana', { keyPair: a.keyPair, prf: a.prf })
  let plan = null
  for (let i = 0; i < 4; i++) {
    t.ok((await once(a2, sd.url)).ok, 'A2 run ' + i)
    plan = await ops.deviceUpkeepPlan(a2.ctx)
    if (plan.enrol.some((x) => x.root === community)) break
  }
  t.ok(plan.enrol.some((x) => x.root === community), 'A2 plans the community')
  const enrolled = new Set()
  for (let i = 0; i < 3 && !enrolled.has(group); i++) {
    const r = await ops.deviceUpkeep(a2.ctx, plan)
    t.alike(r.failed, [], 'pass ' + i + ' failed nothing ' + JSON.stringify(r.failed))
    for (const x of r.enrolled) enrolled.add(x.root)
    if (enrolled.has(group)) break
    t.ok((await once(a2, sd.url)).ok, 'A2 runs between passes')
    plan = await ops.deviceUpkeepPlan(a2.ctx)
  }
  t.ok(enrolled.has(community) && enrolled.has(general) && enrolled.has(group), 'A2 enrolled in the community, Geral and the private group')
  const a2Writer = (await writersIn(a2, group))[0].key
  t.is((await ops.groupInfo(a2.ctx, { group })).state, 'member', 'A2 is a member of the group')
  const before = await ops.groupRead(a2.ctx, { group })
  t.ok(before.sealed >= 1, 'A2 only counts the history sealed')
  t.is((await ops.groupInfo(a2.ctx, { group })).canWrite, false, 'A2 cannot write yet (no key for the epoch)')
  t.absent(before.items.some((p) => p.text === 'segredo-1'), 'A2 cannot read the history yet')

  // 4. A2 pushes; A syncs until it holds A2's writer and plans to share.
  t.ok((await once(a2, sd.url)).ok, 'A2 pushes')
  await until(() => writerLength(sd.seeder, group, a2Writer) >= 1, { name: 'A2 writer on the seeder' })
  let planA = null
  for (let i = 0; i < 4; i++) {
    t.ok((await once(a, sd.url)).ok, 'A run ' + i)
    planA = await ops.deviceUpkeepPlan(a.ctx)
    if (planA.share.some((x) => x.group === group)) break
  }
  t.ok(planA.share.some((x) => x.group === group), 'A plans to share the group')
  const shared = await ops.deviceUpkeep(a.ctx, planA)
  t.alike(shared.failed, [], 'share failed nothing ' + JSON.stringify(shared.failed))
  t.ok(shared.shared.includes(group), 'A shared the group keys')
  const after = await keyBlocks(a, aWriter)
  t.ok(after.length > firstBefore, 'A wrote continuation group-key blocks')
  const newBlocks = after.slice(firstBefore).map((e) => e.record)
  t.ok(newBlocks.every((r) => r.keys.some((k) => k.writer === a2Writer)), 'the new blocks list A2\'s writer')
  t.ok(newBlocks.every((r) => r.keys.every((k) => k.writer !== mWriter)), 'and not the requester M')
  const firstSeq = blocksBefore[0].seq
  t.ok(blocksBefore[0].record.kid === null && newBlocks.every((r) => r.kid !== null && r.kid.seq === firstSeq), 'no rotation: every new block continues the one first block')
  t.is(after.filter((e) => e.record.kid === null).length, 1, 'no new first block')
  t.alike((await ops.deviceUpkeepPlan(a.ctx)).share, [], 'a second plan shares nothing')

  // 5. A pushes; A2 reads the history in clear and is no longer rekey-pending.
  t.ok((await once(a, sd.url)).ok, 'A pushes the key blocks')
  await until(() => writerLength(sd.seeder, group, aWriter) >= after.length + 2, { name: 'key blocks on the seeder' })
  t.ok((await once(a2, sd.url)).ok, 'A2 fetches')
  const read2 = await ops.groupRead(a2.ctx, { group })
  t.ok(read2.items.some((p) => p.text === 'segredo-1' && !p.hidden), 'A2 reads segredo-1 in clear')
  t.is(read2.state, 'ok', 'A2 is not rekey-pending')
  t.is(read2.sealed, 0, 'nothing left sealed for A2')
  t.is((await ops.groupInfo(a2.ctx, { group })).canWrite, true, 'A2 can write after the share')

  // 6. A post by A2 is read by A.
  await ops.groupPost(a2.ctx, { group, text: 'segredo-2' })
  t.ok((await once(a2, sd.url)).ok, 'A2 pushes segredo-2')
  await until(() => writerLength(sd.seeder, group, a2Writer) >= 2, { name: 'segredo-2 on the seeder' })
  t.ok((await once(a, sd.url)).ok, 'A fetches')
  t.ok((await ops.groupRead(a.ctx, { group })).items.some((p) => p.text === 'segredo-2' && !p.hidden), 'A reads the post by A2')

  // 7. M, never admitted, got no key and reads nothing in clear.
  t.ok((await once(m, sd.url)).ok, 'M fetches')
  const readM = await ops.groupRead(m.ctx, { group })
  t.absent(readM.items.some((p) => p.text === 'segredo-1' || p.text === 'segredo-2'), 'M reads no text')

  t.comment('runtime ' + (Date.now() - started) + ' ms')
})
