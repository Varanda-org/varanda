'use strict'

// lib/root-peek.js over a real Seeder behind a WebSocket on the local DHT
// (loopback only): block 0 of a root the seeder holds, verified against G,
// and a fast plain failure for a root no seeder holds or an endpoint that is
// no verified seeder. Then group.join's pending branch through it: a hint
// the seeder-held root contradicts writes nothing (docs/rpc.md 5.37).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { decodeBlock } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const { runSync } = require('../lib/sync')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const { peekGroupRoot, ROOT_UNREAD } = require('../lib/root-peek')
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
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
  await ops.profileSet(ctx, { name, bio: '' })
  await groupKeys.unlock(storage, prf)
  return { storage, ownHex, ctx }
}

async function seederOverWs (t, assocKp, bootstrap) {
  const dataDir = tmpDir(t, 'varanda-rpk-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-rpk-sc-'), 'seeder-cert.json')
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

function rootLength (seeder, group) {
  const item = seeder.groupWriters({ group, after: null, limit: 64 }).items.find((it) => it.key === group)
  return item ? item.length : 0
}

async function pushOnce (m, url) {
  return runSync({ storage: m.storage, seederUrl: url, createSocket: (u) => new WebSocket(u), retryMinMs: 100, retryMaxMs: 200, mediaPollMs: 50, groupsChangedMs: 20, once: true, timeoutMs: 30000, onEvent: () => {} })
}

async function diaryLength (m) {
  const core = await store.openDiary(m.storage)
  try { return core.length } finally { await core.close() }
}

test('root-peek: block 0 of seeder-held roots, a fast refusal otherwise, and group.join refusing a contradicted hint', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const a = await browserMember(t, assocKp, 'Ana')
  const b = await browserMember(t, assocKp, 'Bia')
  const read = (key, timeoutMs = 10000, seederUrl = sd.url) => peekGroupRoot({ seederUrl, createSocket: (u) => new WebSocket(u), association, key, timeoutMs })

  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  t.ok((await pushOnce(a, sd.url)).ok, 'A pushes its roots')
  await until(() => rootLength(sd.seeder, horta) > 0 && rootLength(sd.seeder, general) > 0, { name: 'roots on the seeder' })

  const h = decodeBlock(await read(horta))
  t.ok(grp.isStandaloneHeader(h), 'the standalone root, verified against its key')
  const g = decodeBlock(await read(general))
  t.alike([g.kind, g.community], ['group', community], 'the community group root')

  let started = Date.now()
  await t.exception(read('cd'.repeat(32), 1500), new RegExp(ROOT_UNREAD), 'a root no seeder holds')
  t.ok(Date.now() - started < 10000, 'within its deadline')
  started = Date.now()
  await t.exception(read(horta, 1500, 'ws://127.0.0.1:1/seeder'), new RegExp(ROOT_UNREAD), 'no seeder to ask')
  await t.exception(read('xyz'), new RegExp(ROOT_UNREAD), 'a malformed key never dials')

  // group.join through the reader: B holds neither root.
  b.ctx.peekGroupRoot = (key) => read(key)
  const length = await diaryLength(b)
  await t.exception(() => ops.groupJoin(b.ctx, { group: general, standalone: true }), /parâmetro inválido: standalone/, 'a standalone hint on a community group')
  t.alike([await diaryLength(b), (await store.readGroupWriters(b.storage)).length], [length, 0], 'nothing written')
  b.ctx.peekGroupRoot = (key) => read(key, 1500)
  await t.exception(() => ops.groupJoin(b.ctx, { group: 'cd'.repeat(32), standalone: true }), /aguarde a sincronização do grupo para entrar/, 'an unreachable root')
  t.alike([await diaryLength(b), (await store.readGroupWriters(b.storage)).length], [length, 0], 'nothing written')
  b.ctx.peekGroupRoot = (key) => read(key)
  t.alike(await ops.groupJoin(b.ctx, { group: horta, standalone: true }), { state: 'pending' }, 'the hint the root confirms')
})
