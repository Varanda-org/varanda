'use strict'

// Direct messages end to end: the real Seeder with the dm option (its pool
// on disk, the stamp channel with a test postage key generated here) behind
// a WebSocket server, and real browser nodes (lib/node.js over in-memory
// storage) with fixed PRFs. Local DHT and tmp dirs only.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { generateNoiseKeyPair, attachAdmission } = require('@varanda/core/lib/net')
const { attachDm } = require('@varanda/core/lib/dm-net')
const dmCore = require('@varanda/core/lib/dm')
const postage = require('@varanda/core/lib/dm-postage')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { dmBoxKeyPairFromPrf, dmLocalKeyFromPrf } = require('../lib/passkey')
const gc = require('@varanda/core/lib/group-crypto')
const { wsStream } = require('../lib/ws-stream')
const store = require('../lib/node-store')

const HEX64 = /[0-9a-f]{64}/

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

// The postage key as the operator's file holds it (decimal strings).
function rsaKey () {
  const { privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  const n = fromBase64url(jwk.n)
  return { kid: postage.kidOf(n), n: n.toString(10), e: '65537', d: fromBase64url(jwk.d).toString(10) }
}

// One WebSocket entry whose connections go to the seeder of the moment, so
// the nodes keep their seederUrl across a restart.
async function seederHost (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-dm-e2e-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-dm-e2e-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const key = rsaKey()
  const host = { dataDir, events: [], current: null }
  host.start = async () => {
    const seeder = new Seeder({
      dataDir,
      associationKey: assoc.hex,
      ...localSwarmOptions(bootstrap),
      log: (e) => host.events.push(e),
      dm: { postage: { get: async () => ({ keys: [key] }) } }
    })
    t.teardown(() => seeder.close(), { force: true })
    await seeder.start()
    host.current = seeder
    return seeder
  }
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const s of wss.clients) s.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', noop)
    if (host.current === null) raw.destroy()
    else host.current.acceptStream(raw)
  })
  host.url = 'ws://127.0.0.1:' + wss.address().port + '/seeder'
  await host.start()
  return host
}

async function wallet (storage) {
  const w = await storage.readJson('dmStamps')
  return w && Array.isArray(w.items) ? w.items.length : 0
}

// A confirmed push: the seeder admits and serves the diary, which is what
// its stamp channel asks before issuing (an unknown diary gets 'teto').
async function push (t, n, host) {
  let stopped = null
  for (let i = 0; i < 5; i++) {
    const { runId } = await n.web.request('sync.start', { once: true, timeoutMs: 30000 })
    stopped = await stoppedOf(n.web.events, runId)
    if (stopped.reason === 'done' && stopped.result && stopped.result.ok === true && stopped.result.seederConfirmed === true) break
    t.comment('push attempt ' + (i + 1) + ' not confirmed: ' + JSON.stringify(stopped))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  t.is(stopped.result && stopped.result.seederConfirmed, true, 'the seeder holds the diary')
  await until(() => host.current._served.has(n.key) || host.current._admitted.has(n.key), { name: 'served', timeoutMs: 30000 })
}

async function memberNode (t, assoc, host, { keyPair = crypto.keyPair(), prf = crypto.randomBytes(32), enable = true } = {}) {
  const url = host.url
  const storage = memoryNodeStorage()
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, dm: { topUpRetryMs: 100 } },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  const cert = createCert({ member: publicKey }, assoc.kp)
  await web.request('cert.add', { cert })
  const n = { node, web, storage, key: publicKey, keyPair, prf, cert, enabled: null }
  if (enable) {
    await push(t, n, host)
    n.enabled = await web.request('dm.enable')
    await until(async () => (await wallet(storage)) >= dmCore.DM_STAMP_WALLET, { name: 'wallet', timeoutMs: 60000 })
  }
  return n
}

// Copies `from`'s diary into `to`'s storage as a stored replica (what a
// follow or a peek would have read), in process.
async function copyDiary (from, to) {
  const src = await store.openDiary(from.storage)
  const dst = await store.openReplica(to.storage, from.key)
  const a = src.replicate(true)
  const b = dst.replicate(false)
  a.pipe(b).pipe(a)
  await dst.update({ wait: true })
  await dst.download({ start: 0, end: src.length }).done()
  a.destroy()
  b.destroy()
  await src.close()
  await dst.close()
}

// An anonymous dm link as a member opens one: fresh Noise key, empty
// inventory, the drop channel.
async function rawDm (t, url) {
  const ws = new WebSocket(url)
  ws.on('error', noop)
  const noise = new NoiseSecretStream(true, wsStream(ws), { keyPair: generateNoiseKeyPair() })
  noise.on('error', noop)
  t.teardown(() => noise.destroy(), { force: true })
  await new Promise((resolve, reject) => {
    noise.once('connect', resolve)
    noise.once('close', () => reject(new Error('link fechado')))
  })
  Hypercore.createProtocolStream(noise)
  const ch = attachDm(noise, { role: 'member' })
  attachAdmission(noise, { role: 'member', have: [] })
  t.is(await ch.supported, true, 'the seeder serves the dm channel')
  return ch
}

// Takes `n` stamps out of a node's wallet (spent here, never by the node).
// The wallet is sealed under the local key of the node's PRF.
async function takeStamps (node, n) {
  const storage = node.storage
  const key = await dmLocalKeyFromPrf(node.prf)
  const w = await store.readDmStamps(storage)
  const taken = w.items.slice(0, n).map((s) => ({ kid: s.kid, ...gc.openRecord({ nonce: s.nonce, box: s.box }, key) }))
  await store.writeDmStamps(storage, { items: w.items.slice(n), kids: w.kids })
  return taken
}

function dropOf (sealed, stamp) {
  return dmCore.encodeDrop({
    dropId: dmCore.newDropId(),
    kid: b4a.from(stamp.kid, 'hex'),
    rsaSig: b4a.from(stamp.sig, 'base64'),
    token: b4a.from(stamp.token, 'hex'),
    sealed
  })
}

function filesUnder (dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

// Neither the pool on disk nor the seeder log names a member: the raw key
// bytes and the hex form are both searched for.
function assertNoMemberKey (t, host, members, label) {
  const poolDir = path.join(host.dataDir, 'dm-pool')
  t.ok(fs.existsSync(poolDir), label + ': pool dir exists')
  const files = filesUnder(poolDir)
  t.ok(files.length > 0, label + ': pool has files')
  for (const f of files) {
    const bytes = fs.readFileSync(f)
    for (const m of members) {
      t.is(b4a.indexOf(bytes, b4a.from(m.key, 'hex')), -1, label + ': no raw member key in ' + path.basename(f))
      t.is(b4a.indexOf(bytes, b4a.from(m.key)), -1, label + ': no hex member key in ' + path.basename(f))
    }
  }
  const dmLines = host.events.filter((e) => e && typeof e.event === 'string' && e.event.startsWith('dm'))
  t.ok(dmLines.length > 0, label + ': the dm channel logged')
  for (const e of dmLines) t.absent(HEX64.test(JSON.stringify(e)), label + ': no hex64 on a dm log line')
  const log = JSON.stringify(dmLines)
  for (const m of members) t.absent(log.includes(m.key), label + ': no member key on the dm channel log')
}

test('dm end to end against the real seeder', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc)

  // Enable: the box published comes from the PRF; stamps from the top-up.
  const A = await memberNode(t, assoc, host)
  const B = await memberNode(t, assoc, host)
  const boxB = await dmBoxKeyPairFromPrf(B.prf, 1)
  t.alike(B.enabled, { box: hex(boxB.publicKey), gen: 1, seq: 1 }, 'dm.enable publishes the PRF box')
  const budget = JSON.parse(fs.readFileSync(path.join(host.dataDir, 'dm-stamps.json'), 'utf8'))
  // v2 file: { days: { diary: { 'YYYY-MM-DD': count } } } (protocol section 11).
  for (const n of [A, B]) {
    const days = budget.days[n.key] || {}
    const issued = Object.values(days).reduce((sum, count) => sum + count, 0)
    t.ok(issued >= dmCore.DM_STAMP_WALLET, 'the seeder issued the wallet top-up')
  }

  // Lookup: A reads B's dm-key from B's diary.
  await copyDiary(B, A)
  await copyDiary(A, B)
  t.alike(await A.web.request('dm.lookup', { member: B.key }), { box: hex(boxB.publicKey), gen: 1 }, 'lookup answers the box')

  // Send and pull as a request (B follows nobody).
  const sent = await A.web.request('dm.send', { to: B.key, text: 'oi' })
  t.ok(/^[0-9a-f]{32}$/.test(sent.id))
  const p1 = await B.web.request('dm.pull')
  t.is(p1.added, 1, 'B files one message')
  t.is((await B.web.request('dm.list', {})).conversations.length, 0, 'not in the inbox')
  const req = await B.web.request('dm.list', { folder: 'request' })
  t.is(req.conversations.length, 1)
  t.is(req.conversations[0].peer, A.key)
  t.is(req.conversations[0].preview, 'oi')
  t.is((await B.web.request('dm.thread', { peer: A.key })).folder, 'request')

  // Accept, then reply with replyTo.
  await B.web.request('dm.set', { peer: A.key, state: 'accepted' })
  const inbox = await B.web.request('dm.list', {})
  t.is(inbox.conversations.length, 1, 'accepted: in the inbox')
  t.is(inbox.conversations[0].peer, A.key)
  const reply = await B.web.request('dm.send', { to: A.key, text: 'olá', replyTo: sent.id })
  t.is((await A.web.request('dm.pull')).added, 1, 'A files the reply')
  const ta = await A.web.request('dm.thread', { peer: B.key })
  const got = ta.messages.find((m) => m.id === reply.id)
  t.ok(got, 'the reply is in A\'s thread')
  t.is(got.text, 'olá')
  t.is(got.replyTo, sent.id, 'replyTo crossed')
  t.is(got.from, B.key)
  t.ok(typeof got.at === 'string' && got.at <= new Date().toISOString(), 'at is the effective time')

  // A third identity reads the same pool and opens nothing.
  const C = await memberNode(t, assoc, host)
  t.is((await C.web.request('dm.pull')).added, 0, 'C adds nothing')
  t.is((await C.web.request('dm.list', { folder: 'request' })).conversations.length, 0)

  // A put without a valid stamp is refused; a stamp from the wallet is kept.
  const ch = await rawDm(t, host.url)
  const forged = dropOf(crypto.randomBytes(dmCore.DM_SEALED_BYTES), { kid: (await store.readDmStamps(C.storage)).kids[0], sig: b4a.toString(crypto.randomBytes(256), 'base64'), token: hex(crypto.randomBytes(32)) })
  t.alike(await ch.put(forged), { ok: false, reason: 'invalido' }, 'no valid stamp: invalido')

  // A throwaway key, without a certificate or with one of another
  // association, stamps and puts a message to B: the seeder stores it (it
  // never sees the sender), B opens and files nothing.
  const throwaway = crypto.keyPair()
  const otherAssoc = generateAssociationKeyPair()
  for (const cert of [undefined, createCert({ member: hex(throwaway.publicKey) }, otherAssoc)]) {
    const junk = dmCore.sealInner(dmCore.buildInner({ kind: 'msg', to: B.key, text: 'descartável', cert }, throwaway), hex(boxB.publicKey))
    const [s] = await takeStamps(C, 1)
    t.alike(await ch.put(dropOf(junk, s)), { ok: true, reason: null }, 'the pool takes the drop')
  }
  t.is((await B.web.request('dm.pull')).added, 0, 'a throwaway key without a valid certificate adds 0')

  // A future-dated message from C, filed before B declines, stays hidden:
  // the decline cuts on filedAt, not on the sender's at.
  await copyDiary(B, C)
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
  const inner = dmCore.buildInner({ kind: 'msg', id: dmCore.newMessageId(), at: future, to: B.key, text: 'do futuro', replyTo: null, cert: C.cert }, C.keyPair)
  const sealed = dmCore.sealInner(inner, hex(boxB.publicKey))
  const [stamp] = await takeStamps(C, 1)
  t.alike(await ch.put(dropOf(sealed, stamp)), { ok: true, reason: null }, 'a wallet stamp is accepted')
  t.is((await B.web.request('dm.pull')).added, 1, 'B files the request from C')
  const cRow = (await B.web.request('dm.list', { folder: 'request' })).conversations.find((c) => c.peer === C.key)
  t.ok(cRow, 'C is a request')
  t.ok(cRow.at < future, 'the listed time is the effective time, not the future at')
  await B.web.request('dm.set', { peer: C.key, state: 'declined' })
  t.absent((await B.web.request('dm.list', { folder: 'request' })).conversations.some((c) => c.peer === C.key), 'declined: the future-dated request is hidden')
  t.is((await B.web.request('dm.thread', { peer: C.key })).messages.length, 0, 'and its thread is empty')

  assertNoMemberKey(t, host, [A, B, C], 'before restart')

  // Restart: the pool and B's cursor survive.
  await host.current.close()
  host.current = null
  await host.start()
  t.is((await B.web.request('dm.pull')).added, 0, 'after restart the cursor holds: nothing new')

  // A fresh device of B (same passkey PRF) reads everything again.
  const B2 = await memberNode(t, assoc, host, { keyPair: B.keyPair, prf: B.prf, enable: false })
  // C's future-dated message files too; the decline after it in the pool
  // hides it again.
  t.is((await B2.web.request('dm.pull')).added, 3, 'A\'s message, B\'s sent copy and C\'s request')
  const t2 = await B2.web.request('dm.thread', { peer: A.key })
  t.alike(t2.messages.map((m) => [m.text, m.mine]).sort(), [['oi', false], ['olá', true]], 'the sent copy is mine under peer A')
  t.is(t2.folder, 'inbox', 'the accepted ctl reached the new device')
  t.is((await B2.web.request('dm.thread', { peer: C.key })).messages.length, 0, 'the decline reached it too')

  // Delete on B propagates to B2 after a pull; A keeps its copy.
  await B.web.request('dm.set', { peer: A.key, state: 'deleted' })
  t.is((await B.web.request('dm.list', {})).conversations.length, 0, 'deleted on this device')
  await B2.web.request('dm.pull')
  t.is((await B2.web.request('dm.list', {})).conversations.length, 0, 'deleted on the other device')
  t.is((await B2.web.request('dm.thread', { peer: A.key })).messages.length, 0)
  t.is((await A.web.request('dm.thread', { peer: B.key })).messages.length, 2, 'A keeps the thread')

  // Block: the seeder takes A's next message, B files nothing.
  await B.web.request('dm.set', { peer: A.key, state: 'blocked' })
  const kept = host.events.filter((e) => e.event === 'dm' && e.reason === 'guardada').length
  await A.web.request('dm.send', { to: B.key, text: 'de novo' })
  t.is(host.events.filter((e) => e.event === 'dm' && e.reason === 'guardada').length, kept + 2, 'the seeder stored both drops')
  t.is((await B.web.request('dm.pull')).added, 0, 'blocked: nothing added')
  await B2.web.request('dm.pull')
  t.is((await B2.web.request('dm.thread', { peer: A.key })).messages.length, 0, 'nor shown on the other device')
  t.is((await B2.web.request('dm.list', {})).conversations.length, 0)
  t.is((await B2.web.request('dm.list', { folder: 'request' })).conversations.length, 0)

  assertNoMemberKey(t, host, [A, B, C], 'after restart')
})
