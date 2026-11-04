// Two browser devices of the same passkey, loopback only: a real Seeder behind
// a WebSocket on the local DHT. Device A creates a community; device B (same
// key pair, same prf, fresh storage, only idCreate) lists it from the diary
// and participates after an explicit community.join.
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
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// The first device does the full setup; a second device of the same passkey
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
  const dataDir = tmpDir(t, 'varanda-dev-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-dev-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp), null, 2) + '\n')
  Seeder.addCert(dataDir, certFile, association)
  const s = { seeder: null }
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: association, log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  s.seeder = seeder
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const client of wss.clients) client.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    s.seeder.acceptStream(raw)
  })
  s.url = 'ws://127.0.0.1:' + wss.address().port + '/seeder'
  return s
}

function indexed (seeder, group, key) {
  return seeder.groupWriters({ group, after: null, limit: 64 }).items.some((it) => it.key === key)
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

test('a second browser device of the same passkey lists the community the first device created and participates after an explicit community.join', async (t) => {
  t.timeout(170000)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const a = await browserMember(assocKp, 'Ana')

  // 1. A creates an open community and pushes.
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const ra = await onceB(a, sd.url)
  t.ok(ra.res.ok, 'A pushes ' + JSON.stringify(ra.res.errors))
  await until(() => indexed(sd.seeder, community, community) && indexed(sd.seeder, general, general), { name: 'roots indexed' })

  // 2. Device B: same key pair and prf, fresh storage, idCreate only.
  const b = await browserMember(assocKp, 'Ana', { keyPair: a.keyPair, prf: a.prf })
  t.alike(await ops.communityList(b.ctx), { communities: [] }, 'B starts with no communities')

  // 3. B's first run fetches the diary; the roots are adopted in that run or the next.
  const r1 = await onceB(b, sd.url)
  t.ok(r1.res.ok, 'B first run ok ' + JSON.stringify(r1.res.errors))
  let list = await ops.communityList(b.ctx)
  if (list.communities.length === 0) {
    const r2 = await onceB(b, sd.url)
    t.ok(r2.res.ok, 'B second run ok ' + JSON.stringify(r2.res.errors))
    list = await ops.communityList(b.ctx)
  }
  t.alike(list.communities, [{ community, name: 'Bairro', join: 'open', state: 'ready', role: 'creator', general }], 'B lists the community')
  const groups = await ops.groupList(b.ctx)
  const row = groups.groups.find((g) => g.group === general)
  t.ok(row && row.role === 'creator' && row.community === community, 'B lists Geral as creator in the community ' + JSON.stringify(groups))

  // 4. B holds no writer and not the root; the diary did not fork.
  const info = await ops.communityInfo(b.ctx, { community })
  t.is(info.writerHere, false, 'no writer here yet')
  t.is(info.canWrite, false, 'cannot write yet')
  t.is(info.rootHere, false, 'root not here')
  const logA = (await ops.logRead(a.ctx, {})).entries
  const logB = (await ops.logRead(b.ctx, {})).entries
  t.is(logB.length, logA.length, 'B diary length equals A')
  const joins = (log) => log.filter((e) => e.record.type === 'group-join').length
  t.is(joins(logB), joins(logA), 'the syncs appended no group-join on B (only the ones A wrote)')

  // 5. Posting before joining is refused.
  await t.exception(() => ops.groupPost(b.ctx, { group: general, text: 'x' }), /sem permissão no grupo/, 'B cannot post before joining')

  // 6. Explicit join.
  t.alike(await ops.communityJoin(b.ctx, { community }), { state: 'member', group: general }, 'B joins explicitly')
  const info2 = await ops.communityInfo(b.ctx, { community })
  t.is(info2.writerHere, true, 'writer here after join')
  t.is(info2.canWrite, true, 'can write after join')
  t.is(info2.rootHere, false, 'root still not here')
  await ops.groupPost(b.ctx, { group: general, text: 'de B' })

  // 7. B pushes; the seeder indexes B's writers; A reads the post.
  const rb = await onceB(b, sd.url)
  t.ok(rb.res.ok, 'B pushes ' + JSON.stringify(rb.res.errors))
  const writers = await store.readGroupWriters(b.storage)
  const bCw = writers.find((w) => w.group === community).key
  const bGeral = writers.find((w) => w.group === general).key
  await until(() => indexed(sd.seeder, community, bCw) && indexed(sd.seeder, general, bGeral), { name: 'B writers indexed' })
  t.ok((await onceB(a, sd.url)).res.ok, 'A fetches')
  const readA = await ops.groupRead(a.ctx, { group: general })
  t.ok(readA.items.some((p) => p.diary === a.ownHex && p.text === 'de B' && !p.hidden), 'A reads the post from B')
  t.is((await ops.communityInfo(a.ctx, { community })).members, 1, 'one diary, two devices: 1 member')

  // 8. Creating a group is for the creating device only.
  await t.exception(() => ops.groupCreate(b.ctx, { name: 'Horta', join: 'open', community }), /crie pelo aparelho que criou a comunidade/, 'B cannot create a group')

  t.comment('runtime ' + (Date.now() - started) + ' ms')
})
