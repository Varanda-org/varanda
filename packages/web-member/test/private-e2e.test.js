// Private groups end to end, loopback only: a real Seeder behind a WebSocket
// and on the local DHT, a core node (the creator, synced with @varanda/core
// runSync), a browser member (lib/member-ops.js with its in-memory key
// holder, synced with lib/sync.js) and a third core node that asks to join
// and is never admitted. The browser is admitted and reads the history, posts
// sealed and is read by the creator; a ban rotates the epoch and the banned
// member cannot read the next post; the seeder never holds a post's text.
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

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function browserMember (t, assocKp, name) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = new Uint8Array(32)
  globalThis.crypto.getRandomValues(prf)
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
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
  await ops.profileSet(ctx, { name, bio: '' })
  await groupKeys.unlock(storage, prf)
  return { storage, ownHex, ctx }
}

async function coreNode (t, assocKp, name) {
  const ctx = { dataDir: tmpDir(t, 'varanda-pe2e-core-'), association: hex(assocKp.publicKey) }
  const { publicKey } = await coreMember.idCreate(ctx)
  await coreMember.certAdd(ctx, createCert({ member: publicKey }, assocKp))
  await coreMember.profileSet(ctx, { name })
  return { ...ctx, key: publicKey }
}

async function seederOverWs (t, assocKp, bootstrap) {
  const dataDir = tmpDir(t, 'varanda-pe2e-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-pe2e-sc-'), 'seeder-cert.json')
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
  return { seeder, dataDir, url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

function writerLength (seeder, group, key) {
  const item = seeder.groupWriters({ group, after: null, limit: 64 }).items.find((it) => it.key === key)
  return item ? item.length : 0
}

async function onceB (b, url) {
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
    onEvent: () => {}
  })
  return { res }
}

async function onceC (bootstrap, c) {
  const res = await coreSync.runSync({
    dataDir: c.dataDir,
    ...localSwarmOptions(bootstrap),
    once: true,
    timeoutMs: 30000,
    onEvent: () => {}
  })
  return { res }
}

// Every byte the seeder wrote under its data dir.
function filesUnder (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else if (entry.isFile()) out.push(fs.readFileSync(full))
  }
  return out
}

function holds (buffers, text) {
  const needle = b4a.from(text)
  return buffers.some((buf) => b4a.indexOf(buf, needle) !== -1)
}

const texts = (read) => read.items.filter((p) => !p.hidden).map((p) => p.text)

test('private groups end to end: core creator, browser member, non-member, real seeder', async (t) => {
  t.timeout(180000)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const sd = await seederOverWs(t, assocKp, bootstrap)
  const c = await coreNode(t, assocKp, 'Caio')
  const b = await browserMember(t, assocKp, 'Bia')
  const n = await coreNode(t, assocKp, 'Nina')

  // 1. The creator makes a private group (approval forced) and posts sealed.
  const { group } = await coreMember.groupCreate(c, { name: 'Conselho', join: 'open', visibility: 'private' })
  const info = await coreMember.groupInfo(c, { group })
  t.is(info.visibility, 'private', 'private, never public')
  t.is(info.join, 'approval', 'approval forced')
  t.is(info.name, 'Conselho', 'the creator opens the sealed name')
  await coreMember.groupPost(c, { group, text: 'segredo-c1 antes da entrada' })
  t.ok((await onceC(bootstrap, c)).res.ok, 'creator pushes')
  await until(() => writerLength(sd.seeder, group, group) >= 4, { name: 'root blocks on the seeder' })
  const idx = sd.seeder.indexGroup(group)
  t.is(idx.header.visibility, 'private', 'the index says private')
  t.is(idx.header.name, null, 'and never names it')

  // 2. The browser joins by key before the root arrives: its pending writer
  // has no box, so the seeder never takes it; once the run holds the private
  // root, that writer's push is no goal, so the run ends ok. Joining again
  // binds a boxed writer (the boxless one is unbound) and requests entry.
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'pending' }, 'join before the root is pending')
  const boxless = (await store.readGroupWriters(b.storage)).find((w) => w.group === group).key
  const first = await onceB(b, sd.url)
  t.ok(first.res.ok, 'the boxless writer is no push goal once the root arrives: ' + JSON.stringify(first.res.errors))
  t.ok(await store.groupCoreExists(b.storage, group), 'the root is stored')
  t.is(writerLength(sd.seeder, group, boxless), 0, 'the seeder never took the boxless writer')
  t.is((await ops.groupJoin(b.ctx, { group })).state, 'requested', 'boxed rejoin requests entry')
  const bWriter = (await store.readGroupWriters(b.storage)).filter((w) => w.group === group).pop().key
  t.not(bWriter, boxless, 'a new boxed writer')
  t.ok((await onceB(b, sd.url)).res.ok, 'browser pushes its boxed writer')
  await until(() => writerLength(sd.seeder, group, bWriter) >= 1, { name: 'B writer on the seeder' })
  const beforeAdmit = await ops.groupRead(b.ctx, { group })
  t.is(beforeAdmit.items.length, 0, 'nothing readable before the admission')
  t.ok(beforeAdmit.sealed >= 1, 'only a sealed count')

  // 3. The third node asks to join and is never admitted.
  t.alike(await coreMember.groupJoin(n, { group }), { state: 'pending' })
  // Its first writer has no box (the root was unknown) and the seeder never
  // takes it, so this run reports that writer's push timing out, nothing else.
  const nBoxless = coreStore.readGroups(n.dataDir).find((g) => g.group === group).writer
  const nFirst = await onceC(bootstrap, n)
  t.ok(nFirst.res.errors.length > 0 && nFirst.res.errors.every((e) => e.startsWith('tempo esgotado: ' + nBoxless)), 'only the boxless writer fails: ' + JSON.stringify(nFirst.res.errors))
  t.is((await coreMember.groupJoin(n, { group })).state, 'requested')

  // 4. The creator admits B: the history keys travel to B's box.
  t.ok((await onceC(bootstrap, c)).res.ok, 'creator fetches the request')
  t.alike((await coreMember.groupRequests(c, { group })).requests.map((r) => r.member).sort(), [b.ownHex], 'C sees B request')
  t.alike(await coreMember.groupAdmit(c, { group, member: b.ownHex, on: true }), { ok: true })
  t.ok((await onceC(bootstrap, c)).res.ok, 'creator pushes the admission and keys')
  t.ok((await onceB(b, sd.url)).res.ok, 'B fetches the keys')
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'member', 'B is a member')
  const readB = await ops.groupRead(b.ctx, { group })
  t.alike(texts(readB), ['segredo-c1 antes da entrada'], 'B reads the history')
  t.is(readB.sealed, 0, 'nothing left sealed for B')
  t.is(readB.state, 'ok')
  t.is((await ops.groupInfo(b.ctx, { group })).name, 'Conselho', 'B opens the sealed name')

  // 5. B posts sealed; the creator opens it.
  const p1 = await ops.groupPost(b.ctx, { group, text: 'segredo-b1 da Bia' })
  t.ok((await onceB(b, sd.url)).res.ok, 'B pushes b1')
  await until(() => writerLength(sd.seeder, group, bWriter) > p1.seq, { name: 'b1 on the seeder' })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C fetches b1')
  const readC = await coreMember.groupRead(c, { group })
  t.ok(readC.items.some((p) => p.diary === b.ownHex && p.text === 'segredo-b1 da Bia' && p.name === 'Bia'), 'C reads the browser sealed post')

  // 6. A ban rotates: the next post is not readable by B.
  const epochBefore = readC.epoch
  t.alike(await coreMember.groupBan(c, { group, member: b.ownHex, on: true }), { ok: true })
  const afterBan = await coreMember.groupRead(c, { group })
  t.ok(afterBan.epoch !== null && (afterBan.epoch.writer !== epochBefore.writer || afterBan.epoch.seq !== epochBefore.seq), 'the ban started a new epoch')
  await coreMember.groupPost(c, { group, text: 'segredo-c2 depois do ban' })
  t.ok((await onceC(bootstrap, c)).res.ok, 'C pushes the ban, the rotation and c2')
  t.ok((await onceB(b, sd.url)).res.ok, 'B fetches them')
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'banned', 'B reads banned')
  const bannedRead = await ops.groupRead(b.ctx, { group })
  t.absent(bannedRead.items.some((p) => p.text === 'segredo-c2 depois do ban'), 'the banned member cannot read the next post')
  t.ok(bannedRead.sealed >= 1, 'it only counts it sealed')
  t.ok((await coreMember.groupRead(c, { group })).items.some((p) => p.text === 'segredo-c2 depois do ban'), 'the creator reads it')

  // 7. The never-admitted third node reads only sealed counts.
  t.ok((await onceC(bootstrap, n)).res.ok, 'third node fetches everything')
  const readN = await coreMember.groupRead(n, { group })
  t.is(readN.items.length, 0, 'the non-member reads nothing')
  t.ok(readN.sealed >= 3, 'only sealed counts: ' + readN.sealed)
  t.is((await coreMember.groupInfo(n, { group })).name, null, 'nor the name')

  // 8. The seeder holds ciphertext only: no post text and no group name in
  // its storage or index; the creator's plaintext profile is the control.
  const bytes = filesUnder(sd.dataDir)
  t.ok(holds(bytes, 'Caio'), 'control: a plaintext diary record is found as is')
  for (const secret of ['segredo-c1', 'segredo-b1', 'segredo-c2', 'Conselho']) {
    t.absent(holds(bytes, secret), 'seeder storage never holds ' + secret)
  }
  t.absent(JSON.stringify(sd.seeder.indexGroup(group)).includes('Conselho'), 'nor its index')

  t.comment('runtime ' + (Date.now() - started) + ' ms')
})
