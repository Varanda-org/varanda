// Automatic enrolment of a second and a third browser device of the same
// passkey, loopback only: a real Seeder behind a WebSocket on the local DHT.
// Device A creates an open community. Device B (same key pair and prf, fresh
// storage, idCreate only) enrols by itself through the ops (deviceUpkeepPlan /
// deviceUpkeep). Device C does it through the browser session's upkeep pass
// on a continuous sync, with no explicit community.join.
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const test = require('brittle')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { runSync } = require('../lib/sync')
const { createBrowserNode } = require('../lib/node')
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
async function browserMember (assocKp, name, { keyPair = null, prf = null } = {}) {
  const second = keyPair !== null
  const storage = memoryNodeStorage()
  if (!second) {
    keyPair = crypto.keyPair()
    prf = new Uint8Array(32)
    globalThis.crypto.getRandomValues(prf)
  }
  const ctx = {
    storage,
    association: hex(assocKp.publicKey),
    keyPair,
    groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce)
  }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  if (!second) {
    await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
    await ops.profileSet(ctx, { name, bio: '' })
  }
  return { storage, ownHex, ctx, keyPair, prf }
}

async function seederOverWs (t, assocKp, bootstrap) {
  const dataDir = tmpDir(t, 'varanda-dauto-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-dauto-sc-'), 'seeder-cert.json')
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

test('a second browser device of the same passkey enrols by itself in the community and its Geral', async (t) => {
  t.timeout(110000)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const a = await browserMember(assocKp, 'Ana')

  // 1. A creates an open community and pushes.
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const ra = await once(a, sd.url)
  t.ok(ra.ok, 'A pushes ' + JSON.stringify(ra.errors))
  await until(() => indexed(sd.seeder, community, community) && indexed(sd.seeder, general, general), { name: 'roots indexed' })

  // 2. Device B: same keys, fresh storage, idCreate only; runs until it lists the community.
  const b = await browserMember(assocKp, 'Ana', { keyPair: a.keyPair, prf: a.prf })
  let listed = false
  for (let i = 0; i < 3 && !listed; i++) {
    const r = await once(b, sd.url)
    t.ok(r.ok, 'B run ' + i + ' ok ' + JSON.stringify(r.errors))
    listed = (await ops.communityList(b.ctx)).communities.some((c) => c.community === community)
  }
  t.ok(listed, 'B lists the community')
  t.is((await ops.communityInfo(b.ctx, { community })).writerHere, false, 'no writer here before the upkeep')

  // 3. The plan enrols the community and Geral, as its own group.
  const plan = await ops.deviceUpkeepPlan(b.ctx)
  t.alike(plan.enrol.map((x) => [x.root, x.kind]), [[community, 'community'], [general, 'group']], 'plan: community then Geral')
  t.is(plan.share.length, 0, 'nothing to share')
  const done = await ops.deviceUpkeep(b.ctx, plan)
  t.alike(done.failed, [], 'nothing failed ' + JSON.stringify(done.failed))
  t.alike(done.enrolled.map((x) => x.root), [community, general], 'both enrolled')
  const writers = await store.readGroupWriters(b.storage)
  const bCw = (writers.find((w) => w.group === community) || {}).key
  const bGeral = (writers.find((w) => w.group === general) || {}).key
  t.ok(bCw && bGeral, 'the community writer and the Geral writer are listed')
  const info = await ops.communityInfo(b.ctx, { community })
  t.is(info.writerHere, true, 'writerHere')
  t.is(info.canWrite, true, 'canWrite')
  t.is(info.rootHere, false, 'rootHere false')
  const again = await ops.deviceUpkeepPlan(b.ctx)
  t.alike([again.enrol, again.share], [[], []], 'a second plan is empty')

  // 4. B posts in Geral, pushes; A reads it.
  await ops.groupPost(b.ctx, { group: general, text: 'de B' })
  const rb = await once(b, sd.url)
  t.ok(rb.ok, 'B pushes ' + JSON.stringify(rb.errors))
  await until(() => indexed(sd.seeder, community, bCw) && indexed(sd.seeder, general, bGeral), { name: 'B writers indexed' })
  t.ok((await once(a, sd.url)).ok, 'A fetches')
  const readA = await ops.groupRead(a.ctx, { group: general })
  t.ok(readA.items.some((p) => p.diary === a.ownHex && p.text === 'de B' && !p.hidden), 'A reads the post from B')
  t.is((await ops.communityInfo(a.ctx, { community })).members, 1, 'one diary: 1 member')
  await t.exception(() => ops.groupCreate(b.ctx, { name: 'Horta', join: 'open', community }), /crie pelo aparelho que criou a comunidade/, 'B cannot create a group')

  // 5. Device C through the session: continuous sync, no join RPC.
  const c = await browserMember(assocKp, 'Ana', { keyPair: a.keyPair, prf: a.prf })
  const internal = []
  const node = createBrowserNode({
    storage: c.storage,
    association: hex(assocKp.publicKey),
    seederUrl: sd.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    writeGate: false,
    upkeepDelayMs: 50,
    onInternalError: (err) => internal.push(err)
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(a.keyPair, { prf: a.prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { runId } = await web.request('sync.start', {})
  t.ok(runId, 'continuous run')
  await until(async () => {
    const w = await store.readGroupWriters(c.storage)
    return w.some((e) => e.group === community && e.key !== community) && w.some((e) => e.group === general && e.key !== general)
  }, { name: 'C enrolled by the session upkeep', timeoutMs: 60000 })
  const infoC = await web.request('community.info', { community })
  t.is(infoC.writerHere, true, 'C: community.info writerHere')
  t.is(infoC.canWrite, true, 'C: canWrite')
  t.alike(internal, [], 'no internal error')
  await web.request('sync.stop', { runId }).catch(() => {})
  const stp = await stoppedOf(web.events, runId).catch((e) => e.message)
  t.comment('C stopped: ' + JSON.stringify(stp).slice(0, 200))
  await node.close()

  // 6. A binds 3 writers after its next run.
  const cWriters = (await store.readGroupWriters(c.storage)).filter((e) => e.group === community && e.key !== community)
  await until(() => indexed(sd.seeder, community, cWriters[0].key), { name: 'C CW indexed', timeoutMs: 30000 })
  let rA = await once(a, sd.url)
  // The first run after C's occasionally times out on a push (seeder still busy with C's writers); one retry.
  if (!rA.ok) t.comment('A first run: ' + JSON.stringify(rA.errors))
  if (!rA.ok) rA = await once(a, sd.url)
  t.ok(rA.ok, 'A runs again ' + JSON.stringify(rA.errors))
  t.is((await ops.communityInfo(a.ctx, { community })).writersBound, 3, 'writersBound is 3')

  t.comment('runtime ' + (Date.now() - started) + ' ms')
})
